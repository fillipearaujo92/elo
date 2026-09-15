// tests/sendlocation.test.ts
//
// POST /api/sendLocation — pino nativo do WhatsApp.
//
// O socket do Baileys é falso, mas a rota é REAL (Fastify via inject): o que se
// verifica é o CONTEÚDO que o gateway monta para o Baileys. O risco desta rota
// não é o envio falhar — é ele dar certo apontando para o lugar errado, e isso
// só apareceria no aparelho do contato.

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { MediaStore } from '../dist/core/media.js';
import { SessionManager } from '../dist/core/session-manager.js';
import { registerSendRoutes } from '../dist/routes/send.js';
import type { WebhookEmitter } from '../dist/core/webhook.js';

const API_KEY = 'chave-de-teste';
const silentLog = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  child() { return silentLog; },
} as never;

let enviados: Array<{ jid: string; content: Record<string, unknown>; opts?: unknown }>;
let app: FastifyInstance;
let seq = 0;

beforeEach(async () => {
  enviados = [];
  seq = 0;

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
    async sendMessage(jid: string, content: Record<string, unknown>, opts?: unknown) {
      enviados.push({ jid, content, opts });
      seq += 1;
      return { key: { id: `MSG${seq}`, remoteJid: jid, fromMe: true }, message: {} };
    },
  };
  (manager as unknown as { requireSocket(n: string): unknown }).requireSocket = () => sock;
  (manager as unknown as {
    rememberSentMessage(s: string, k: { id?: string }, c: unknown): Promise<void>;
  }).rememberSentMessage = async () => {};

  app = Fastify({ logger: false });
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers['x-api-key'] !== API_KEY) return reply.code(401).send({ message: 'no' });
  });
  registerSendRoutes(app, { sessions: manager });
  app.setErrorHandler((error, _req, reply) => {
    const err = error as Error & { statusCode?: number; output?: { statusCode?: number } };
    return reply.code(err.output?.statusCode ?? err.statusCode ?? 500).send({ message: err.message });
  });
  await app.ready();
});

const auth = { 'x-api-key': API_KEY };
const CHAT = '5511999999999@c.us';
const post = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/sendLocation', headers: auth, payload: payload as never });

/** O bloco `location` que chegou ao Baileys na última chamada. */
const ultimaLocalizacao = () =>
  enviados.at(-1)?.content.location as Record<string, unknown> | undefined;

describe('sendLocation — envio', () => {
  it('monta o bloco location que o Baileys espera', async () => {
    const res = await post({
      session: 's', chatId: CHAT, latitude: -23.5613, longitude: -46.6565,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(enviados.length, 1);
    assert.deepEqual(ultimaLocalizacao(), {
      degreesLatitude: -23.5613,
      degreesLongitude: -46.6565,
    });
  });

  it('title e address entram quando informados', async () => {
    await post({
      session: 's', chatId: CHAT, latitude: -23.5613, longitude: -46.6565,
      title: 'Loja Centro', address: 'Av. Paulista, 1000 — São Paulo',
    });

    assert.deepEqual(ultimaLocalizacao(), {
      degreesLatitude: -23.5613,
      degreesLongitude: -46.6565,
      name: 'Loja Centro',
      address: 'Av. Paulista, 1000 — São Paulo',
    });
  });

  it('title/address vazios NAO viram campos vazios na bolha', async () => {
    await post({
      session: 's', chatId: CHAT, latitude: 1, longitude: 2,
      title: '   ', address: '',
    });

    const loc = ultimaLocalizacao()!;
    assert.ok(!('name' in loc), 'name vazio nao deve ser enviado');
    assert.ok(!('address' in loc), 'address vazio nao deve ser enviado');
  });

  it('devolve o id da mensagem enviada', async () => {
    const res = await post({ session: 's', chatId: CHAT, latitude: 1, longitude: 2 });
    assert.match(JSON.stringify(res.json()), /MSG1/);
  });

  it('reply_to cita a mensagem (quoted chega ao Baileys)', async () => {
    await post({
      session: 's', chatId: CHAT, latitude: 1, longitude: 2,
      reply_to: 'false_5511999999999@c.us_ABC123',
    });

    const opts = enviados.at(-1)?.opts as { quoted?: { key?: { id?: string } } };
    assert.equal(opts?.quoted?.key?.id, 'ABC123');
  });
});

describe('sendLocation — coordenada ausente nao pode virar zero', () => {
  // ★ O ponto central destes testes. `Number(null)` e `Number('')` são 0, e 0,0
  // é um lugar real no Golfo da Guiné. Um consumidor que perdesse o campo
  // mandaria o contato para o meio do Atlântico com 200 e id de sucesso.
  it('latitude ausente devolve 400 e NAO envia', async () => {
    const res = await post({ session: 's', chatId: CHAT, longitude: -46.6565 });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /latitude/i);
    assert.equal(enviados.length, 0);
  });

  it('longitude ausente devolve 400 e NAO envia', async () => {
    const res = await post({ session: 's', chatId: CHAT, latitude: -23.5613 });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /longitude/i);
    assert.equal(enviados.length, 0);
  });

  it('null, string vazia e texto nao viram 0,0', async () => {
    for (const valor of [null, '', '   ', 'abc', {}, []]) {
      const res = await post({
        session: 's', chatId: CHAT, latitude: valor, longitude: valor,
      });
      assert.equal(res.statusCode, 400, `valor ${JSON.stringify(valor)} deveria ser rejeitado`);
    }
    assert.equal(enviados.length, 0, 'nenhum envio para o Golfo da Guine');
  });

  it('mas zero EXPLICITO e um lugar valido e passa', async () => {
    const res = await post({ session: 's', chatId: CHAT, latitude: 0, longitude: 0 });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(ultimaLocalizacao(), {
      degreesLatitude: 0,
      degreesLongitude: 0,
    });
  });
});

describe('sendLocation — faixa e formato', () => {
  it('latitude fora de -90..90 devolve 400', async () => {
    for (const latitude of [90.1, -90.1, 1000]) {
      const res = await post({ session: 's', chatId: CHAT, latitude, longitude: 0 });
      assert.equal(res.statusCode, 400, `latitude ${latitude}`);
    }
    assert.equal(enviados.length, 0);
  });

  it('longitude fora de -180..180 devolve 400', async () => {
    for (const longitude of [180.1, -180.1, 999]) {
      const res = await post({ session: 's', chatId: CHAT, latitude: 0, longitude });
      assert.equal(res.statusCode, 400, `longitude ${longitude}`);
    }
    assert.equal(enviados.length, 0);
  });

  it('os limites exatos sao validos', async () => {
    const res = await post({ session: 's', chatId: CHAT, latitude: -90, longitude: 180 });
    assert.equal(res.statusCode, 200);
  });

  it('aceita string (JSON de formulario manda string)', async () => {
    await post({ session: 's', chatId: CHAT, latitude: '-23.5613', longitude: '-46.6565' });
    assert.deepEqual(ultimaLocalizacao(), {
      degreesLatitude: -23.5613,
      degreesLongitude: -46.6565,
    });
  });

  it('aceita virgula decimal (formato que o brasileiro digita)', async () => {
    await post({ session: 's', chatId: CHAT, latitude: '-23,5613', longitude: '-46,6565' });
    assert.deepEqual(ultimaLocalizacao(), {
      degreesLatitude: -23.5613,
      degreesLongitude: -46.6565,
    });
  });

  it('NaN e Infinity sao rejeitados', async () => {
    // JSON não carrega NaN/Infinity, mas a string "Infinity" chega — e
    // `Number('Infinity')` é finito para o `isFinite` ingênuo de quem só checa
    // `!isNaN`.
    for (const valor of ['Infinity', '-Infinity', 'NaN']) {
      const res = await post({ session: 's', chatId: CHAT, latitude: valor, longitude: 0 });
      assert.equal(res.statusCode, 400, `valor ${valor}`);
    }
    assert.equal(enviados.length, 0);
  });
});

describe('sendLocation — campos obrigatorios da rota', () => {
  it('session ausente devolve 400', async () => {
    const res = await post({ chatId: CHAT, latitude: 1, longitude: 2 });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /session/i);
  });

  it('chatId ausente devolve 400', async () => {
    const res = await post({ session: 's', latitude: 1, longitude: 2 });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /chatId/i);
  });

  it('sem api key devolve 401', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sendLocation',
      payload: { session: 's', chatId: CHAT, latitude: 1, longitude: 2 } as never,
    });
    assert.equal(res.statusCode, 401);
  });

  it('numero sem @c.us tambem funciona (como nas outras rotas)', async () => {
    const res = await post({ session: 's', chatId: '5511999999999', latitude: 1, longitude: 2 });
    assert.equal(res.statusCode, 200);
    assert.match(enviados.at(-1)!.jid, /5511999999999/);
  });
});
