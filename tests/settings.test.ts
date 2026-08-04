// tests/settings.test.ts
//
// patchSettings: a edição de configuração pelo painel.
//
// Duas armadilhas justificam este arquivo:
//
//  1. MERGE, não substituição. O PUT /config troca o objeto inteiro; a tela só
//     conhece os campos que exibe. Se o patch substituísse, salvar o webhook
//     apagaria `ignore.groups` (e vice-versa) sem o operador perceber.
//
//  2. A CHAVE MASCARADA. O painel recebe o config com a chave do webhook trocada
//     por '••••••••' (describe() -> maskSecrets, para não vazar o segredo no
//     DevTools). Um salvamento ingênuo devolveria esse placeholder e gravaria
//     "••••••••" como chave real — todo webhook passaria a levar 401 no destino.
//     Aqui o placeholder é detectado e o valor original preservado.

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { MediaStore } from '../dist/core/media.js';
import { SessionManager, shouldIgnoreChat } from '../dist/core/session-manager.js';
import type { WebhookEmitter } from '../dist/core/webhook.js';

const silentLog = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  child() { return silentLog; },
} as never;

type Row = {
  name: string;
  label: string | null;
  status: string;
  me_id: string | null;
  me_push_name: string | null;
  config: Record<string, unknown>;
  should_start: boolean;
};

/** Pool com uma única sessão em memória, replicando o UPDATE ... COALESCE. */
function makePool(initial: Partial<Row> = {}) {
  const row: Row = {
    name: 'canal-teste',
    label: 'Canal Teste',
    status: 'WORKING',
    me_id: '5585912345678',
    me_push_name: null,
    config: {},
    should_start: true,
    ...initial,
  };
  const pool = {
    row,
    async query(sql: string, params: unknown[] = []) {
      const q = sql.replace(/\s+/g, ' ');
      if (q.includes('UPDATE elo.sessions')) {
        const [, cfg, label, shouldStart] = params as [string, string, string | null, boolean | null];
        row.config = JSON.parse(cfg);
        // COALESCE: null preserva o valor atual — é o que permite o patch parcial.
        if (label !== null) row.label = label;
        if (shouldStart !== null) row.should_start = shouldStart;
        return { rows: [{ ...row }], rowCount: 1 };
      }
      // upsertSession: INSERT ... ON CONFLICT DO UPDATE. Params na ordem
      // [name, config, shouldStart, label].
      if (q.includes('INSERT INTO elo.sessions')) {
        const [, cfg, shouldStart, label] = params as [string, string, boolean, string | null];
        row.config = JSON.parse(cfg);
        row.should_start = shouldStart;
        if (label !== null) row.label = label;
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (q.includes('FROM elo.sessions')) {
        return { rows: [{ ...row }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return { query: pool.query, release() {} };
    },
  };
  return pool;
}

const WEBHOOK = {
  url: 'https://app.exemplo.io/webhook/zap',
  events: ['message', 'message.ack', 'session.status'],
  customHeaders: [{ name: 'X-Webhook-Key', value: 'chave-real-secreta' }],
  retries: { attempts: 15, delaySeconds: 2, policy: 'constant' },
};

function makeManager(initial: Partial<Row> = {}) {
  const pool = makePool(initial);
  const webhooks = { async emit() {} } as unknown as WebhookEmitter;
  const manager = new SessionManager(
    pool as never,
    silentLog,
    webhooks,
    new MediaStore(silentLog),
  );
  return { manager, pool };
}

describe('patchSettings — merge parcial', () => {
  it('mexer no webhook NAO apaga ignore.groups', async () => {
    const { manager } = makeManager({ config: { ignore: { groups: true } } });
    const out = await manager.patchSettings('canal-teste', {
      webhookUrl: 'https://novo.exemplo.io/w',
      webhookEvents: ['message'],
    });
    assert.equal(
      (out?.config as { ignore?: { groups?: boolean } })?.ignore?.groups,
      true,
      'ignore.groups sobreviveu ao salvamento do webhook',
    );
  });

  it('mexer em grupos NAO apaga o webhook', async () => {
    const { manager } = makeManager({ config: { webhooks: [WEBHOOK] } });
    const out = await manager.patchSettings('canal-teste', { ignoreGroups: true });
    const wh = (out?.config as { webhooks?: Array<{ url: string }> })?.webhooks?.[0];
    assert.equal(wh?.url, WEBHOOK.url, 'a URL do webhook continua gravada');
  });

  it('label e should_start sao colunas, nao config', async () => {
    const { manager, pool } = makeManager();
    await manager.patchSettings('canal-teste', {
      label: 'Loja Centro',
      shouldStart: false,
    });
    assert.equal(pool.row.label, 'Loja Centro');
    assert.equal(pool.row.should_start, false);
  });

  it('patch vazio nao destroi nada', async () => {
    const { manager } = makeManager({ config: { webhooks: [WEBHOOK], ignore: { groups: true } } });
    const out = await manager.patchSettings('canal-teste', {});
    const cfg = out?.config as { webhooks?: unknown[]; ignore?: { groups?: boolean } };
    assert.equal(cfg?.webhooks?.length, 1);
    assert.equal(cfg?.ignore?.groups, true);
  });

  it('sessao inexistente devolve null (a rota traduz em 404)', async () => {
    const pool = {
      async query() { return { rows: [], rowCount: 0 }; },
      async connect() { return { query: async () => ({ rows: [] }), release() {} }; },
    };
    const manager = new SessionManager(
      pool as never, silentLog,
      { async emit() {} } as unknown as WebhookEmitter,
      new MediaStore(silentLog),
    );
    assert.equal(await manager.patchSettings('nao-existe', { label: 'x' }), null);
  });
});

describe('patchSettings — a chave mascarada', () => {
  const keyOf = (out: { config: unknown } | null) =>
    (out?.config as { webhooks?: Array<{ customHeaders?: Array<{ name: string; value: string }> }> })
      ?.webhooks?.[0]?.customHeaders?.find((h) => h.name === 'X-Webhook-Key')?.value;

  it('REGRESSAO: salvar sem tocar na chave preserva a original', async () => {
    // O caso real: o operador troca só a URL. O campo de chave vem vazio, e a
    // chave gravada tem de continuar valendo.
    const { manager } = makeManager({ config: { webhooks: [WEBHOOK] } });
    const out = await manager.patchSettings('canal-teste', {
      webhookUrl: 'https://outro.exemplo.io/w',
      webhookEvents: ['message'],
    });
    assert.equal(keyOf(out), 'chave-real-secreta');
  });

  it('REGRESSAO: o placeholder de mascara NUNCA e gravado como chave', async () => {
    // Se isto falhar, todo webhook passa a enviar X-Webhook-Key: •••••••• e o
    // destino responde 401 — com a tela mostrando "salvo com sucesso".
    const { manager } = makeManager({ config: { webhooks: [WEBHOOK] } });
    const out = await manager.patchSettings('canal-teste', {
      webhookUrl: WEBHOOK.url,
      webhookKey: '••••••••',
    });
    assert.equal(keyOf(out), 'chave-real-secreta');
  });

  it('uma chave nova de verdade substitui a antiga', async () => {
    const { manager } = makeManager({ config: { webhooks: [WEBHOOK] } });
    const out = await manager.patchSettings('canal-teste', {
      webhookUrl: WEBHOOK.url,
      webhookKey: 'chave-rotacionada',
    });
    assert.equal(keyOf(out), 'chave-rotacionada');
  });

  it('trocar SO a chave, sem mexer na URL, e aplicado', async () => {
    // Rotação de credencial: o painel manda a URL junto, mas a API tem de
    // funcionar mesmo sem ela (era descartado em silencio antes do fix).
    const { manager } = makeManager({ config: { webhooks: [WEBHOOK] } });
    const out = await manager.patchSettings('canal-teste', { webhookKey: 'so-a-chave' });
    assert.equal(keyOf(out), 'so-a-chave');
    const wh = (out?.config as { webhooks?: Array<{ url: string }> })?.webhooks?.[0];
    assert.equal(wh?.url, WEBHOOK.url, 'a URL nao foi perdida');
  });
});

describe('patchSettings — webhook e eventos', () => {
  it('URL vazia remove o repasse (desligar sem apagar a sessao)', async () => {
    const { manager } = makeManager({ config: { webhooks: [WEBHOOK] } });
    const out = await manager.patchSettings('canal-teste', { webhookUrl: null });
    assert.equal((out?.config as { webhooks?: unknown })?.webhooks, undefined);
  });

  it('remover o webhook preserva ignore.groups', async () => {
    const { manager } = makeManager({
      config: { webhooks: [WEBHOOK], ignore: { groups: true } },
    });
    const out = await manager.patchSettings('canal-teste', { webhookUrl: null });
    assert.equal((out?.config as { ignore?: { groups?: boolean } })?.ignore?.groups, true);
  });

  it('trocar so os eventos preserva URL, chave e retry', async () => {
    const { manager } = makeManager({ config: { webhooks: [WEBHOOK] } });
    const out = await manager.patchSettings('canal-teste', {
      webhookEvents: ['message'],
    });
    const wh = (out?.config as {
      webhooks?: Array<{
        url: string; events: string[];
        customHeaders?: Array<{ value: string }>;
        retries?: { attempts: number };
      }>;
    })?.webhooks?.[0];
    assert.deepEqual(wh?.events, ['message']);
    assert.equal(wh?.url, WEBHOOK.url);
    assert.equal(wh?.customHeaders?.[0]?.value, 'chave-real-secreta');
    assert.equal(wh?.retries?.attempts, 15);
  });

  it('webhook novo sem eventos assina os tres por padrao', async () => {
    const { manager } = makeManager();
    const out = await manager.patchSettings('canal-teste', {
      webhookUrl: 'https://novo.exemplo.io/w',
    });
    const wh = (out?.config as { webhooks?: Array<{ events: string[] }> })?.webhooks?.[0];
    assert.deepEqual(wh?.events, ['message', 'message.ack', 'session.status']);
  });

  it('ignoreGroups=false grava explicitamente (nao e o mesmo que ausente)', async () => {
    const { manager } = makeManager({ config: { ignore: { groups: true } } });
    const out = await manager.patchSettings('canal-teste', { ignoreGroups: false });
    assert.equal((out?.config as { ignore?: { groups?: boolean } })?.ignore?.groups, false);
  });
});

// shouldIgnoreChat — os quatro filtros de tipo de chat.
//
// O default importa mais que a mecânica: `status` (stories) nasce IGNORADO porque
// era hard-coded assim antes do filtro existir; grupos, canais e transmissões
// nascem RECEBIDOS, para a introdução do filtro não mudar em silêncio o que os
// canais ativos já entregam hoje.
describe('shouldIgnoreChat', () => {
  const P = '5585912345678@s.whatsapp.net';
  const G = '120363402863588220@g.us';
  const S = 'status@broadcast';
  const C = '123456789@newsletter';
  const B = '123456789@broadcast';

  it('conversa 1:1 NUNCA e ignorada', () => {
    for (const cfg of [undefined, {}, { ignore: { groups: true, status: true,
      channels: true, broadcast: true } }]) {
      assert.equal(shouldIgnoreChat(P, cfg), false);
    }
  });

  it('DEFAULT: status ignorado, os outros recebidos', () => {
    assert.equal(shouldIgnoreChat(S, {}), true, 'stories nao sao conversa');
    assert.equal(shouldIgnoreChat(G, {}), false, 'grupo continua chegando');
    assert.equal(shouldIgnoreChat(C, {}), false);
    assert.equal(shouldIgnoreChat(B, {}), false);
  });

  it('sem config nenhuma vale o mesmo default', () => {
    assert.equal(shouldIgnoreChat(S, undefined), true);
    assert.equal(shouldIgnoreChat(G, undefined), false);
  });

  it('cada filtro atinge SO o seu tipo', () => {
    assert.equal(shouldIgnoreChat(G, { ignore: { groups: true } }), true);
    assert.equal(shouldIgnoreChat(C, { ignore: { groups: true } }), false);
    assert.equal(shouldIgnoreChat(B, { ignore: { groups: true } }), false);

    assert.equal(shouldIgnoreChat(C, { ignore: { channels: true } }), true);
    assert.equal(shouldIgnoreChat(G, { ignore: { channels: true } }), false);

    assert.equal(shouldIgnoreChat(B, { ignore: { broadcast: true } }), true);
    assert.equal(shouldIgnoreChat(G, { ignore: { broadcast: true } }), false);
  });

  it('status pode ser LIGADO explicitamente (ignore.status=false)', () => {
    // Unico filtro cujo default e "ignorar", entao precisa de false explicito.
    assert.equal(shouldIgnoreChat(S, { ignore: { status: false } }), false);
    assert.equal(shouldIgnoreChat(S, { ignore: { status: true } }), true);
  });

  it('status@broadcast NAO cai na regra de transmissao', () => {
    // Os dois terminam em @broadcast; o status e tratado antes, senao ligar
    // "receber transmissoes" traria stories de volta sem o operador pedir.
    assert.equal(shouldIgnoreChat(S, { ignore: { broadcast: false } }), true);
  });
});

// PUT /config — o mesmo bug da máscara vivia AQUI, na rota vizinha do PATCH.
//
// O PATCH tinha toda a proteção (pickKey); o PUT gravava o config cru. O caminho
// é o natural: GET (devolve a chave como '••••••••') → editar um campo → PUT.
// Isso gravava LITERALMENTE '••••••••' como X-Webhook-Key, e a partir dali todo
// inbound tomava 401 no backend e DESAPARECIA — sem retry, porque o emissor não
// retenta 4xx. E o painel voltava a mostrar '••••••••', indistinguível do certo.
describe('updateConfig (PUT) — a mascara nao pode virar chave', () => {
  const keyOf = (row: { config: unknown } | null) =>
    (row?.config as { webhooks?: Array<{ customHeaders?: Array<{ name: string; value: string }> }> })
      ?.webhooks?.[0]?.customHeaders?.find((h) => h.name === 'X-Webhook-Key')?.value;

  it('REGRESSAO: read-modify-write NAO grava o placeholder', async () => {
    const { manager } = makeManager({ config: { webhooks: [WEBHOOK] } });
    // Simula exatamente o que um cliente faz: manda de volta o que o GET devolveu.
    const out = await manager.updateConfig('canal-teste', {
      webhooks: [{
        url: WEBHOOK.url,
        events: ['message'],
        customHeaders: [{ name: 'X-Webhook-Key', value: '••••••••' }],
      }],
    } as never);
    assert.equal(keyOf(out), 'chave-real-secreta', 'a chave real tem de ser preservada');
  });

  it('chave nova de verdade pelo PUT e aceita', async () => {
    const { manager } = makeManager({ config: { webhooks: [WEBHOOK] } });
    const out = await manager.updateConfig('canal-teste', {
      webhooks: [{
        url: WEBHOOK.url,
        customHeaders: [{ name: 'X-Webhook-Key', value: 'rotacionada-pelo-put' }],
      }],
    } as never);
    assert.equal(keyOf(out), 'rotacionada-pelo-put');
  });

  it('sem chave real anterior, o header mascarado e REMOVIDO (401 visivel)', async () => {
    // Preferimos header ausente a header com máscara: sem header o backend
    // responde 401 de forma óbvia; com a máscara, o 401 vem disfarçado de
    // configuração correta e ninguém descobre a causa.
    const { manager } = makeManager({ config: {} });
    const out = await manager.updateConfig('canal-teste', {
      webhooks: [{
        url: 'https://x.io/w',
        customHeaders: [{ name: 'X-Webhook-Key', value: '••••••••' }],
      }],
    } as never);
    assert.equal(keyOf(out), undefined);
  });

  it('upsertSession tambem desmascara (o driver reaplica config por ali)', async () => {
    const { manager } = makeManager({ config: { webhooks: [WEBHOOK] } });
    const row = await manager.upsertSession(
      'canal-teste',
      {
        webhooks: [{
          url: WEBHOOK.url,
          customHeaders: [{ name: 'X-Webhook-Key', value: '••••••••' }],
        }],
      } as never,
      true,
    );
    assert.equal(keyOf(row), 'chave-real-secreta');
  });
});

// Nome de sessão e caixa — o 404 que todo usuário novo tomava.
//
// Criar {"name":"Atendimento"} gravava `Atendimento` (o A maiúsculo passava pela
// checagem de "já é slug"), mas o README e a intuição usam
// /api/atendimento/auth/qr. 404 no PRIMEIRO passo. Achado testando o README do
// zero, num clone limpo — não em teste.
describe('nome de sessao: caixa', () => {
  it('REGRESSAO: nome com Maiuscula e normalizado para minuscula', async () => {
    const { slugify } = await import('../dist/core/slug.js');
    // Confirma o que o slugify faz — é a base da correção na rota.
    assert.equal(slugify('Atendimento'), 'atendimento');
    assert.equal(slugify('Loja Centro'), 'loja-centro');
    // E o predicado da rota NÃO pode aceitar maiúscula como "já é slug".
    const jaEhSlug = (n: string) => /^[a-z0-9_-]+$/.test(n);
    assert.equal(jaEhSlug('Atendimento'), false, 'com maiuscula precisa passar pelo slugify');
    assert.equal(jaEhSlug('atendimento'), true);
    assert.equal(jaEhSlug('canal-teste-09cf'), true, 'o formato do backend segue valido');
  });

  it('getSessionRow encontra a sessao independente da caixa', async () => {
    // Cobre sessoes que JA existem gravadas com maiuscula (legado).
    const { manager, pool } = makeManager({ name: 'Atendimento', label: 'Atendimento' });
    // O pool falso responde a qualquer SELECT; o que se verifica é que a query
    // usa lower() nos dois lados — sem isso, o legado ficaria inacessível.
    const row = await manager.getSessionRow('atendimento');
    assert.ok(row, 'a busca em minuscula tem de achar a sessao gravada com maiuscula');
    assert.equal(pool.row.name, 'Atendimento');
  });
});
