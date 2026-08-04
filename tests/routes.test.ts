// tests/routes.test.ts
// Exercita a camada HTTP de verdade: Fastify real (via inject), SessionManager real,
// Postgres e socket Baileys stubados. Pega erros de rota/auth/serializacao que o
// typecheck nao pega.

import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';

// NOTA: o config e fail-closed (nao sobe sem API_KEY/DATABASE_URL) e e carregado em
// cascata por estes imports. Como imports ESM sao hoisted, as variaveis precisam vir
// de FORA do arquivo — ver o script `test` no package.json, que as define.
import { MediaStore } from '../dist/core/media.js';
import { SessionManager } from '../dist/core/session-manager.js';
import { WebhookEmitter } from '../dist/core/webhook.js';
import { registerContactRoutes } from '../dist/routes/contacts.js';
import { registerSendRoutes } from '../dist/routes/send.js';
import { registerSessionRoutes } from '../dist/routes/sessions.js';

const API_KEY = 'chave-de-teste';

/** Postgres falso: guarda as sessoes em memoria e responde as queries usadas. */
function makeFakePool() {
  const sessions = new Map<string, Record<string, unknown>>();
  const lids = new Map<string, { phone: string; push_name: string | null }>();
  const acks = new Map<string, number>();

  const pool = {
    async query(sql: string, params: unknown[] = []) {
      const q = sql.replace(/\s+/g, ' ').trim();

      if (q.startsWith('INSERT INTO elo.sessions')) {
        const [name, cfg, shouldStart, label] = params as [string, string, boolean, string | null];
        const row = {
          name,
          label: label ?? name,
          status: 'STOPPED',
          me_id: null,
          me_push_name: null,
          config: JSON.parse(cfg),
          should_start: shouldStart,
        };
        sessions.set(name, row);
        return { rows: [row], rowCount: 1 };
      }
      if (q.startsWith('UPDATE elo.sessions SET config')) {
        const [name, cfg, label, shouldStart] = params as [
          string, string, string | null | undefined, boolean | null | undefined,
        ];
        const row = sessions.get(name);
        if (!row) return { rows: [], rowCount: 0 };
        row.config = JSON.parse(cfg);
        // COALESCE($3, label) / COALESCE($4, should_start): o PATCH manda null
        // para "nao mexer". Sem replicar isto aqui, um teste de rota passaria
        // mesmo se o endpoint deixasse de gravar as colunas.
        if (label !== null && label !== undefined) row.label = label;
        if (shouldStart !== null && shouldStart !== undefined) row.should_start = shouldStart;
        return { rows: [row], rowCount: 1 };
      }
      if (q.startsWith('SELECT name, label, status, me_id') && q.includes('WHERE name =')) {
        const row = sessions.get((params as string[])[0]!);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (q.startsWith('SELECT name, label, status, me_id') && q.includes('ORDER BY')) {
        return { rows: [...sessions.values()], rowCount: sessions.size };
      }
      if (q.startsWith('SELECT phone, push_name FROM elo.lid_map')) {
        const [, lid] = params as [string, string];
        const hit = lids.get(lid);
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      if (q.startsWith('INSERT INTO elo.lid_map')) {
        const [, lid, phone, pushName] = params as [string, string, string, string | null];
        lids.set(lid, { phone, push_name: pushName });
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith('INSERT INTO elo.sent_messages')) {
        const [, msgId, , ack] = params as [string, string, string, number];
        const prev = acks.get(msgId) ?? -99;
        if (ack <= prev) return { rows: [], rowCount: 0 };
        acks.set(msgId, ack);
        return { rows: [{ last_ack: ack }], rowCount: 1 };
      }
      // UPDATE de status, DELETE, etc.
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return { query: pool.query, release() {} };
    },
  };
  return { pool, sessions, lids, acks };
}

const silentLog = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  child() { return silentLog; },
} as never;

let app: FastifyInstance;
let manager: SessionManager;
let fake: ReturnType<typeof makeFakePool>;

before(async () => {
  fake = makeFakePool();
  const media = new MediaStore(silentLog);
  const webhooks = new WebhookEmitter(silentLog, (async () => ({ ok: true, status: 200 })) as never);
  manager = new SessionManager(fake.pool as never, silentLog, webhooks, media);

  app = Fastify({ logger: false });
  app.addHook('onRequest', async (req, reply) => {
    if ((req.url.split('?')[0] ?? '') === '/health') return;
    if (req.url.startsWith('/api/files/')) return;
    const key = req.headers['x-api-key'];
    if (key !== API_KEY) return reply.code(401).send({ message: 'unauthorized' });
  });
  app.get('/health', async () => ({ status: 'ok', engine: 'BAILEYS' }));
  registerSessionRoutes(app, { sessions: manager });
  registerSendRoutes(app, { sessions: manager });
  registerContactRoutes(app, { sessions: manager });
  app.setErrorHandler((error, _req, reply) => {
    const err = error as Error & { statusCode?: number; output?: { statusCode?: number } };
    const status = err.output?.statusCode ?? err.statusCode ?? 500;
    return reply.code(status).send({ message: err.message });
  });
  await app.ready();
});

const auth = { 'x-api-key': API_KEY };

describe('autenticacao', () => {
  it('bloqueia request sem chave', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    assert.equal(res.statusCode, 401);
  });

  it('bloqueia chave errada', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/sessions', headers: { 'x-api-key': 'errada' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('aceita a chave correta', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions', headers: auth });
    assert.equal(res.statusCode, 200);
  });

  it('health check e publico (orquestrador nao manda chave)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().engine, 'BAILEYS');
  });
});

describe('ciclo de vida da sessao', () => {
  it('cria sessao com 201 e status STOPPED/STARTING', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions', headers: auth,
      payload: {
        name: 'canal-teste',
        start: false,
        config: {
          webhooks: [{
            url: 'http://app/webhook/waha',
            events: ['message', 'message.ack', 'session.status'],
            customHeaders: [{ name: 'X-Webhook-Key', value: API_KEY }],
          }],
        },
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.name, 'canal-teste');
    assert.equal(body.engine.engine, 'BAILEYS');
    assert.equal(body.me, null, 'sessao nova nao tem pareamento');
  });

  it('recriar a mesma sessao devolve 422 (o driver trata como benigno)', async () => {
    // o driver do consumidoraceita 422 e reaplica o config via PUT. Devolver 200 aqui faria o
    // driver PULAR a reaplicacao e o webhook ficaria desatualizado.
    const res = await app.inject({
      method: 'POST', url: '/api/sessions', headers: auth,
      payload: { name: 'canal-teste', start: false },
    });
    assert.equal(res.statusCode, 422);
  });

  it('ACEITA nome livre (espaco, acento, emoji) e devolve slug tecnico', async () => {
    // Requisito do operador: digitar o nome que quiser, sem regras. O nome vira
    // `label` e o sistema deriva um slug seguro para uso em URL/arquivo/chave.
    const res = await app.inject({
      method: 'POST', url: '/api/sessions', headers: auth,
      payload: { name: 'Atacadão Léd — Centro 🏬', start: false },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.label, 'Atacadão Léd — Centro 🏬', 'o label preserva o texto original');
    assert.match(body.name, /^[a-z0-9-]+$/, 'o name e um slug seguro');
    assert.equal(body.name, 'atacadao-led-centro');
  });

  it('rejeita nome VAZIO (unica regra que sobra)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions', headers: auth,
      payload: { name: '   ', start: false },
    });
    assert.equal(res.statusCode, 400);
  });

  it('GET status devolve o shape que connectionState() le', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/sessions/canal-teste', headers: auth,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    // Campos exatos lidos por o driver do consumidor.
    assert.ok('status' in body, 'status e obrigatorio');
    assert.ok('me' in body, 'me decide hasMe (gatilho de alert_qr)');
    assert.equal(body.engine.engine, 'BAILEYS');
  });

  it('GET de sessao inexistente devolve 404', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/sessions/nao-existe', headers: auth,
    });
    assert.equal(res.statusCode, 404);
  });

  it('PUT atualiza o config preservando a sessao', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/sessions/canal-teste', headers: auth,
      payload: { config: { ignore: { groups: true }, webhooks: [{ url: 'http://novo/w' }] } },
    });
    assert.equal(res.statusCode, 200);
    const stored = fake.sessions.get('canal-teste') as { config: Record<string, unknown> };
    assert.deepEqual((stored.config as { ignore: unknown }).ignore, { groups: true });
  });

  it('start e restart respondem 200 (o driver so quer saber se foi aceito)', async () => {
    for (const action of ['start', 'restart']) {
      const res = await app.inject({
        method: 'POST', url: `/api/sessions/canal-teste/${action}`, headers: auth,
      });
      assert.equal(res.statusCode, 200, `${action} deve ser aceito`);
      assert.equal(res.json().success, true);
    }
  });

  it('start em sessao inexistente devolve 404', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions/fantasma/start', headers: auth,
    });
    assert.equal(res.statusCode, 404);
  });

  it('QR indisponivel devolve 422 com o status atual', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/canal-teste/auth/qr', headers: auth,
    });
    assert.equal(res.statusCode, 422);
    assert.ok('status' in res.json());
  });
});

// PATCH /settings — a tela de configuração do painel. Sessão PRÓPRIA: as suites
// deste arquivo compartilham `canal-teste` e rodam em ordem, então editar a
// configuração dele aqui quebraria os testes de envio mais abaixo.
describe('PATCH /settings (tela de configuracao)', () => {
  const S = 'canal-config';
  const url = `/api/sessions/${S}/settings`;

  before(async () => {
    await app.inject({
      method: 'POST', url: '/api/sessions', headers: auth,
      payload: {
        name: S, start: false,
        config: {
          ignore: { groups: true },
          webhooks: [{
            url: 'https://app.exemplo.io/webhook/zap',
            events: ['message', 'message.ack', 'session.status'],
            customHeaders: [{ name: 'X-Webhook-Key', value: 'chave-real' }],
          }],
        },
      },
    });
  });

  const patch = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url, headers: auth, payload });

  it('exige autenticacao', async () => {
    const res = await app.inject({ method: 'PATCH', url, payload: { label: 'x' } });
    assert.equal(res.statusCode, 401);
  });

  it('sessao inexistente devolve 404', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/sessions/fantasma/settings', headers: auth,
      payload: { label: 'x' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('rejeita URL sem protocolo http/https', async () => {
    // Gravar isto passaria e só falharia depois, na entrega da mensagem — com o
    // operador sem pista do motivo.
    for (const bad of ['ftp://app/w', 'javascript:alert(1)', 'nao-e-url']) {
      const res = await patch({ webhookUrl: bad });
      assert.equal(res.statusCode, 400, `${bad} deve ser rejeitada`);
    }
  });

  it('rejeita nome vazio', async () => {
    const res = await patch({ label: '   ' });
    assert.equal(res.statusCode, 400);
  });

  it('grava auto-start, grupos e destino de uma vez', async () => {
    const res = await patch({
      label: 'Loja Centro',
      shouldStart: false,
      ignoreGroups: false,
      webhookUrl: 'https://novo.exemplo.io/webhook/zap',
      webhookEvents: ['message'],
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.label, 'Loja Centro');
    assert.equal(body.shouldStart, false);
    const wh = body.config.webhooks[0];
    assert.equal(wh.url, 'https://novo.exemplo.io/webhook/zap');
    assert.deepEqual(wh.events, ['message']);
    assert.equal(body.config.ignore.groups, false);
  });

  it('a resposta devolve a chave MASCARADA (nao vaza segredo no painel)', async () => {
    const res = await patch({ ignoreGroups: true });
    const wh = res.json().config.webhooks[0];
    const key = wh.customHeaders.find((h: { name: string }) => h.name === 'X-Webhook-Key');
    assert.equal(key.value, '••••••••', 'a chave nao pode voltar em claro');
    // ...mas o valor REAL continua no banco, senao o webhook pararia de autenticar.
    const stored = fake.sessions.get(S) as { config: { webhooks: Array<{
      customHeaders: Array<{ name: string; value: string }> }> } };
    assert.equal(stored.config.webhooks[0]!.customHeaders[0]!.value, 'chave-real');
  });

  it('o id tecnico nao muda ao renomear', async () => {
    const res = await patch({ label: 'Outro Nome Qualquer' });
    assert.equal(res.json().name, S);
  });
});

describe('envio', () => {
  it('sendText em sessao desconectada devolve 422, nao 500', async () => {
    // O backend distingue erro de contrato de indisponibilidade; 500 aqui viraria
    // alarme falso de bug no gateway.
    const res = await app.inject({
      method: 'POST', url: '/api/sendText', headers: auth,
      payload: { session: 'canal-teste', chatId: '5585999999999@c.us', text: 'oi' },
    });
    assert.equal(res.statusCode, 422);
  });

  it('sendText sem chatId devolve 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sendText', headers: auth,
      payload: { session: 'canal-teste', text: 'oi' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('sendText sem session devolve 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sendText', headers: auth,
      payload: { chatId: '5585999999999@c.us', text: 'oi' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('sendImage sem file devolve 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sendImage', headers: auth,
      payload: { session: 'canal-teste', chatId: '5585999999999@c.us' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('sendVoice com file sem url nem data devolve 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sendVoice', headers: auth,
      payload: { session: 'canal-teste', chatId: '5585999999999@c.us', file: {} },
    });
    assert.equal(res.statusCode, 400);
  });

  it('as 5 rotas de envio existem (nenhuma 404)', async () => {
    for (const ep of ['sendText', 'sendImage', 'sendVoice', 'sendVideo', 'sendFile']) {
      const res = await app.inject({
        method: 'POST', url: `/api/${ep}`, headers: auth, payload: {},
      });
      assert.notEqual(res.statusCode, 404, `/api/${ep} deve existir`);
    }
  });
});

describe('contatos e LID', () => {
  it('check-exists exige session e phone', async () => {
    const r1 = await app.inject({
      method: 'GET', url: '/api/contacts/check-exists?phone=5585999999999', headers: auth,
    });
    assert.equal(r1.statusCode, 400);
    const r2 = await app.inject({
      method: 'GET', url: '/api/contacts/check-exists?session=canal-teste', headers: auth,
    });
    assert.equal(r2.statusCode, 400);
  });

  it('check-exists em sessao desconectada devolve 422', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/contacts/check-exists?session=canal-teste&phone=5585999999999',
      headers: auth,
    });
    assert.equal(res.statusCode, 422);
  });

  it('lids/{lid} devolve { lid, pn } quando mapeado', async () => {
    // Campo `pn` e o que resolveLidToPhone le (o driver do consumidor). Nome errado quebraria
    // a resolucao silenciosamente.
    fake.lids.set('80131355848789@lid', { phone: '5585986479003', push_name: 'Fulano' });
    const res = await app.inject({
      method: 'GET', url: '/api/canal-teste/lids/80131355848789@lid', headers: auth,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      lid: '80131355848789@lid',
      pn: '5585986479003@c.us',
    });
  });

  it('lids/{lid} nao mapeado devolve 404 (driver cai no fallback /contacts)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/canal-teste/lids/99999999999999@lid', headers: auth,
    });
    assert.equal(res.statusCode, 404);
  });

  it('contacts com LID conhecido resolve para telefone no shape do fallback', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/contacts?session=canal-teste&contactId=80131355848789@lid',
      headers: auth,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    // O driver le data?.id?._serialized e extrai o telefone com /^\d+@c\.us/.
    assert.equal(body.id._serialized, '5585986479003@c.us');
    assert.match(body.id._serialized, /^\d+@c\.us/);
  });
});

describe('remocao', () => {
  it('DELETE apaga a sessao', async () => {
    const res = await app.inject({
      method: 'DELETE', url: '/api/sessions/canal-teste', headers: auth,
    });
    assert.equal(res.statusCode, 200);
  });

  it('DELETE de sessao inexistente devolve 404', async () => {
    const res = await app.inject({
      method: 'DELETE', url: '/api/sessions/nao-existe', headers: auth,
    });
    assert.equal(res.statusCode, 404);
  });
});
