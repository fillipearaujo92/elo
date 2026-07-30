// tests/observability.test.ts
//
// Métricas e presença — as duas frentes que fazem o ELO ser diferente.
//
// A motivação das métricas é concreta: o bug que derrubou o inbound (Bad MAC por
// endereçamento LID) foi descoberto porque alguém mandou uma mensagem e notou a
// ausência. O gateway JÁ SABIA — havia descartes registrados no log — e não avisou
// ninguém. `inbound_undecryptable_total > 0` teria apontado a causa no primeiro
// minuto, e é o tipo de sinal que nenhum concorrente expõe.

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { get, inc, renderPrometheus, resetMetrics, snapshot } from '../dist/core/metrics.js';
import { MediaStore } from '../dist/core/media.js';
import { SessionManager } from '../dist/core/session-manager.js';
import { registerPresenceRoutes } from '../dist/routes/presence.js';
import type { WebhookEmitter } from '../dist/core/webhook.js';

const API_KEY = 'chave-de-teste';
const silentLog = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  child() { return silentLog; },
} as never;

describe('metricas: contadores', () => {
  beforeEach(() => resetMetrics());

  it('acumula por sessao e soma no total', () => {
    inc('inbound_total', 'canal-a');
    inc('inbound_total', 'canal-a');
    inc('inbound_total', 'canal-b');
    assert.equal(get('inbound_total', 'canal-a'), 2);
    assert.equal(get('inbound_total', 'canal-b'), 1);
    assert.equal(get('inbound_total'), 3, 'sem sessao = total');
  });

  it('contador nunca visto vale 0 (nao undefined)', () => {
    assert.equal(get('webhook_lost_total'), 0);
    assert.equal(get('webhook_lost_total', 'qualquer'), 0);
  });

  it('snapshot agrupa por sessao', () => {
    inc('ack_failed_total', 'canal-a', 3);
    inc('inbound_total', 'canal-a');
    const s = snapshot();
    assert.equal(s['canal-a']!.ack_failed_total, 3);
    assert.equal(s['canal-a']!.inbound_total, 1);
  });
});

describe('metricas: formato Prometheus', () => {
  beforeEach(() => resetMetrics());

  it('emite HELP, TYPE e a amostra com rotulo de sessao', () => {
    inc('inbound_undecryptable_total', 'canal-a', 4);
    const txt = renderPrometheus();
    assert.match(txt, /# HELP elo_inbound_undecryptable_total/);
    assert.match(txt, /# TYPE elo_inbound_undecryptable_total counter/);
    assert.match(txt, /elo_inbound_undecryptable_total\{session="canal-a"\} 4/);
    assert.ok(txt.endsWith('\n'), 'Prometheus exige newline final');
  });

  it('gauge de sessao permite alertar "caiu"', () => {
    const txt = renderPrometheus([
      { name: 'viva', status: 'WORKING', connected: true },
      { name: 'morta', status: 'FAILED', connected: false },
    ]);
    assert.match(txt, /elo_session_up\{session="viva",status="WORKING"\} 1/);
    assert.match(txt, /elo_session_up\{session="morta",status="FAILED"\} 0/);
  });

  it('ESCAPA o nome da sessao (nome e livre: aspas, barra, acento)', () => {
    // Sem escapar, um nome com aspas gera exposicao invalida e o Prometheus
    // descarta o scrape INTEIRO — perderia-se toda a observabilidade por um nome.
    const nome = ['com ', '"', 'aspas', '"', ' e ', '\\', 'barra'].join('');
    inc('inbound_total', nome);
    const txt = renderPrometheus();
    // Esperado na saida: session="com \"aspas\" e \\barra"
    assert.ok(txt.includes('session="com \\"aspas\\" e \\\\barra"'), txt);
  });

  it('quebra de linha no nome nao rompe o formato', () => {
    inc('inbound_total', 'linha1\nlinha2');
    const txt = renderPrometheus();
    const amostras = txt.split('\n').filter((l) => l.startsWith('elo_inbound_total{'));
    assert.equal(amostras.length, 1, 'uma amostra, nao duas');
  });

  it('sempre inclui uptime', () => {
    assert.match(renderPrometheus(), /elo_uptime_seconds \d+/);
  });
});

// ── Presença ───────────────────────────────────────────────────────────────
let app: FastifyInstance;
let chamadas: Array<{ metodo: string; args: unknown[] }>;

beforeEach(async () => {
  chamadas = [];
  const pool = {
    async query() { return { rows: [], rowCount: 0 }; },
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; },
  };
  const manager = new SessionManager(
    pool as never, silentLog,
    { async emit() {} } as unknown as WebhookEmitter,
    new MediaStore(silentLog),
  );
  const sock = {
    async sendPresenceUpdate(...args: unknown[]) { chamadas.push({ metodo: 'presence', args }); },
    async presenceSubscribe(...args: unknown[]) { chamadas.push({ metodo: 'subscribe', args }); },
    async readMessages(...args: unknown[]) { chamadas.push({ metodo: 'read', args }); },
  };
  (manager as unknown as { requireSocket(n: string): unknown }).requireSocket = () => sock;

  app = Fastify({ logger: false });
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers['x-api-key'] !== API_KEY) return reply.code(401).send({ message: 'no' });
  });
  registerPresenceRoutes(app, { sessions: manager });
  app.setErrorHandler((error, _req, reply) => {
    const err = error as Error & { statusCode?: number; output?: { statusCode?: number } };
    return reply.code(err.output?.statusCode ?? err.statusCode ?? 500).send({ message: err.message });
  });
  await app.ready();
});

const auth = { 'x-api-key': API_KEY };
const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: auth, payload: payload as never });

describe('typing', () => {
  it('composing e o default', async () => {
    const res = await post('/api/typing', { session: 's', chatId: '5511999999999@c.us' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(chamadas[0]!.args, ['composing', '5511999999999@s.whatsapp.net']);
  });

  it('recording para audio', async () => {
    await post('/api/typing', { session: 's', chatId: '5511999999999@c.us', kind: 'recording' });
    assert.equal(chamadas[0]!.args[0], 'recording');
  });

  it('typing:false envia paused (encerra o indicador)', async () => {
    const res = await post('/api/typing', {
      session: 's', chatId: '5511999999999@c.us', typing: false,
    });
    assert.equal(res.json().typing, false);
    assert.equal(chamadas[0]!.args[0], 'paused');
  });

  it('duration e limitada a 60s (nao prende handler indefinidamente)', async () => {
    const res = await post('/api/typing', {
      session: 's', chatId: '5511999999999@c.us', duration: 999_999,
    });
    assert.equal(res.json().duration, 60_000);
  });

  it('responde na HORA mesmo com duration (renovacao em background)', async () => {
    // O WhatsApp expira o "digitando" em ~10s, entao alguem precisa renovar. Isso
    // NAO pode prender a requisicao: 20s de handler aberto por mensagem esgotaria
    // as conexoes num atendimento movimentado.
    const t0 = Date.now();
    await post('/api/typing', { session: 's', chatId: '5511999999999@c.us', duration: 20_000 });
    assert.ok(Date.now() - t0 < 1_000, 'nao pode aguardar os 20s');
  });

  it('exige session e chatId', async () => {
    assert.equal((await post('/api/typing', { chatId: 'x@c.us' })).statusCode, 400);
    assert.equal((await post('/api/typing', { session: 's' })).statusCode, 400);
  });
});

describe('presence', () => {
  it('aceita os estados do WhatsApp', async () => {
    for (const p of ['available', 'unavailable', 'composing', 'recording', 'paused']) {
      const res = await post('/api/presence', { session: 's', presence: p });
      assert.equal(res.statusCode, 200, p);
    }
  });

  it('rejeita estado inventado, listando os validos', async () => {
    const res = await post('/api/presence', { session: 's', presence: 'dancando' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /available/);
  });

  it('sem chatId aplica ao global (aparecer online/offline)', async () => {
    await post('/api/presence', { session: 's', presence: 'available' });
    assert.equal(chamadas[0]!.args[1], undefined, 'sem jid = global');
  });
});

describe('markAsRead', () => {
  it('marca varias de uma vez, com fromMe FALSE', async () => {
    // Marcar a propria mensagem como lida nao produz efeito; so a do contato.
    const res = await post('/api/markAsRead', {
      session: 's', chatId: '5511999999999@c.us',
      messageIds: ['false_5511999999999@c.us_A1', 'B2'],
    });
    assert.equal(res.json().count, 2);
    const keys = chamadas[0]!.args[0] as Array<{ id: string; fromMe: boolean }>;
    assert.deepEqual(keys.map((k) => k.id), ['A1', 'B2'], 'ids CRUS');
    assert.ok(keys.every((k) => k.fromMe === false));
  });

  it('aceita messageId no singular', async () => {
    const res = await post('/api/markAsRead', {
      session: 's', chatId: '5511999999999@c.us', messageId: 'A1',
    });
    assert.equal(res.json().count, 1);
  });

  it('lista vazia devolve 400', async () => {
    const res = await post('/api/markAsRead', {
      session: 's', chatId: '5511999999999@c.us', messageIds: [],
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('GET presence/{chatId} — visto por ultimo', () => {
  it('sem dado ainda, EXPLICA por que (nao devolve vazio ambiguo)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/presence/5511999999999@c.us?session=s', headers: auth,
    });
    assert.equal(res.statusCode, 200);
    const b = res.json();
    assert.equal(b.available, false);
    assert.match(b.note, /privacidade/, 'diz que depende da privacidade do contato');
    // E assina, para os proximos eventos chegarem.
    assert.ok(chamadas.some((c) => c.metodo === 'subscribe'));
  });

  it('sem session devolve 400', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/presence/5511999999999@c.us', headers: auth,
    });
    assert.equal(res.statusCode, 400);
  });
});
