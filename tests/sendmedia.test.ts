// tests/sendmedia.test.ts
//
// POST /api/sendMedia — várias mídias numa chamada, com legenda por item e álbum.
//
// O socket do Baileys é falso aqui, mas a rota é REAL (Fastify via inject): o que
// se verifica é o que o gateway MANDA para o Baileys — tipo de conteúdo escolhido,
// ordem, legendas e a associação de álbum. Erros nessa camada só apareceriam no
// aparelho do contato, tarde.

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

/** Tudo que foi passado para sock.sendMessage, na ordem. */
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

  // Socket falso: registra a chamada e devolve uma key plausível.
  const sock = {
    async sendMessage(jid: string, content: Record<string, unknown>, opts?: unknown) {
      enviados.push({ jid, content, opts });
      seq += 1;
      return { key: { id: `MSG${seq}`, remoteJid: jid, fromMe: true }, message: {} };
    },
  };
  // requireSocket é o ponto de acesso ao socket vivo; substituímos por um falso.
  (manager as unknown as { requireSocket(n: string): unknown }).requireSocket = () => sock;
  // rememberSentMessage grava no banco; aqui não interessa.
  (manager as unknown as { rememberSentMessage(): Promise<void> }).rememberSentMessage =
    async () => {};

  app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
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
// JPEG mínimo válido em base64 (só o cabeçalho; o socket é falso).
const JPG = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAA==';
const MP4 = 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMQ==';
const PDF = 'JVBERi0xLjQKJeLjz9MK';

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: auth, payload: payload as never });

const midia = (data: string, mimetype: string, extra: Record<string, unknown> = {}) => ({
  file: { data, mimetype }, ...extra,
});

describe('sendMedia — validacao de entrada', () => {
  it('items ausente ou vazio devolve 400', async () => {
    for (const body of [
      { session: 's', chatId: '5511999999999@c.us' },
      { session: 's', chatId: '5511999999999@c.us', items: [] },
    ]) {
      const res = await post('/api/sendMedia', body);
      assert.equal(res.statusCode, 400);
    }
  });

  it('acima do teto de itens devolve 400 (nao trava o socket)', async () => {
    const items = Array.from({ length: 31 }, () => midia(JPG, 'image/jpeg'));
    const res = await post('/api/sendMedia', {
      session: 's', chatId: '5511999999999@c.us', items,
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /30/);
    assert.equal(enviados.length, 0, 'nada pode ser enviado quando a entrada e invalida');
  });

  it('REGRESSAO: um item invalido NAO deixa os anteriores enviados', async () => {
    // Todos os arquivos sao resolvidos ANTES do primeiro envio. Sem isso, um
    // base64 quebrado no item 3 deixaria 2 mensagens entregues e o consumidor
    // sem saber se deve reenviar (o contato receberia duplicado).
    const res = await post('/api/sendMedia', {
      session: 's', chatId: '5511999999999@c.us',
      items: [
        midia(JPG, 'image/jpeg'),
        midia(JPG, 'image/jpeg'),
        midia('!!!lixo!!!', 'image/jpeg'),
      ],
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /item 3/, 'o erro diz QUAL item falhou');
    assert.equal(enviados.length, 0, 'nenhuma mensagem foi enviada');
  });
});

describe('sendMedia — ordem e legendas', () => {
  it('envia na ORDEM pedida (o que o contato ve)', async () => {
    const res = await post('/api/sendMedia', {
      session: 's', chatId: '5511999999999@c.us',
      items: [
        midia(JPG, 'image/jpeg', { caption: 'primeira' }),
        midia(JPG, 'image/jpeg', { caption: 'segunda' }),
        midia(JPG, 'image/jpeg', { caption: 'terceira' }),
      ],
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      enviados.map((e) => e.content.caption),
      ['primeira', 'segunda', 'terceira'],
    );
  });

  it('devolve um id por item, na mesma ordem, e a contagem', async () => {
    const res = await post('/api/sendMedia', {
      session: 's', chatId: '5511999999999@c.us',
      items: [midia(JPG, 'image/jpeg'), midia(MP4, 'video/mp4')],
    });
    const b = res.json();
    assert.equal(b.count, 2);
    assert.equal(b.messages.length, 2);
    assert.equal(b.id, b.messages[0].id, 'id do topo = primeiro item (contrato antigo)');
    assert.ok(b.messages[0].id !== b.messages[1].id);
  });

  it('caption da CHAMADA vale so para o primeiro item', async () => {
    // É como o WhatsApp mostra a legenda de um álbum: uma só, no conjunto.
    await post('/api/sendMedia', {
      session: 's', chatId: '5511999999999@c.us', caption: 'legenda do conjunto',
      items: [midia(JPG, 'image/jpeg'), midia(JPG, 'image/jpeg')],
    });
    assert.equal(enviados[0]!.content.caption, 'legenda do conjunto');
    assert.equal(enviados[1]!.content.caption, undefined);
  });

  it('caption do ITEM ganha da caption da chamada', async () => {
    await post('/api/sendMedia', {
      session: 's', chatId: '5511999999999@c.us', caption: 'generica',
      items: [midia(JPG, 'image/jpeg', { caption: 'especifica' })],
    });
    assert.equal(enviados[0]!.content.caption, 'especifica');
  });

  it('reply cita apenas o PRIMEIRO item', async () => {
    // Citar a mesma mensagem N vezes poluiria a conversa.
    await post('/api/sendMedia', {
      session: 's', chatId: '5511999999999@c.us',
      reply_to: 'false_5511999999999@c.us_ALVO123',
      items: [midia(JPG, 'image/jpeg'), midia(JPG, 'image/jpeg')],
    });
    assert.ok(enviados[0]!.opts, 'primeiro tem quoted');
    assert.equal(enviados[1]!.opts, undefined, 'segundo NAO cita');
  });
});

describe('sendMedia — tipo escolhido pelo mimetype', () => {
  it('imagem, video e documento caem no campo certo do Baileys', async () => {
    await post('/api/sendMedia', {
      session: 's', chatId: '5511999999999@c.us',
      items: [
        midia(JPG, 'image/jpeg'),
        midia(MP4, 'video/mp4'),
        midia(PDF, 'application/pdf', { file: { data: PDF, mimetype: 'application/pdf', filename: 'nota.pdf' } }),
      ],
    });
    assert.ok('image' in enviados[0]!.content);
    assert.ok('video' in enviados[1]!.content);
    assert.ok('document' in enviados[2]!.content);
    assert.equal(enviados[2]!.content.fileName, 'nota.pdf');
  });

  it('mimetype desconhecido vira documento (anexo que abre)', async () => {
    await post('/api/sendMedia', {
      session: 's', chatId: '5511999999999@c.us',
      items: [midia(PDF, 'application/x-coisa-estranha')],
    });
    assert.ok('document' in enviados[0]!.content);
  });

  it('audio vira voice note (ptt) com mimetype de opus', async () => {
    await post('/api/sendMedia', {
      session: 's', chatId: '5511999999999@c.us',
      items: [midia(PDF, 'audio/ogg; codecs=opus', { asVoice: true })],
    });
    assert.ok('audio' in enviados[0]!.content);
    assert.equal(enviados[0]!.content.ptt, true);
  });

  it('asDocument forca anexo mesmo sendo imagem', async () => {
    await post('/api/sendMedia', {
      session: 's', chatId: '5511999999999@c.us',
      items: [midia(JPG, 'image/jpeg', { asDocument: true, caption: 'em anexo' })],
    });
    assert.ok('document' in enviados[0]!.content);
    assert.equal(enviados[0]!.content.caption, 'em anexo');
  });

  it('webp SEM caption vira sticker; COM caption vira imagem', async () => {
    // Sticker nao aceita legenda; se o consumidor mandou uma, a intencao era imagem.
    await post('/api/sendMedia', {
      session: 's', chatId: '5511999999999@c.us',
      items: [midia(JPG, 'image/webp'), midia(JPG, 'image/webp', { caption: 'com legenda' })],
    });
    assert.ok('sticker' in enviados[0]!.content);
    assert.ok('image' in enviados[1]!.content);
  });
});

describe('sendMedia — album', () => {
  it('album agrupa as midias sob um parent (bolha unica)', async () => {
    const res = await post('/api/sendMedia', {
      session: 's', chatId: '5511999999999@c.us', album: true,
      items: [midia(JPG, 'image/jpeg'), midia(JPG, 'image/jpeg'), midia(MP4, 'video/mp4')],
    });
    assert.equal(res.json().album, true);
    // 1 container + 3 midias.
    assert.equal(enviados.length, 4);
    const container = enviados[0]!.content.album as { expectedImageCount: number; expectedVideoCount: number };
    assert.equal(container.expectedImageCount, 2, 'contagem de imagens declarada');
    assert.equal(container.expectedVideoCount, 1, 'contagem de videos declarada');
    // Cada midia referencia o container.
    for (const e of enviados.slice(1)) {
      assert.ok(e.content.albumParentKey, 'midia associada ao album');
    }
  });

  it('album de 1 item NAO cria container (bolha normal)', async () => {
    const res = await post('/api/sendMedia', {
      session: 's', chatId: '5511999999999@c.us', album: true,
      items: [midia(JPG, 'image/jpeg')],
    });
    assert.equal(res.json().album, false);
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0]!.content.albumParentKey, undefined);
  });

  it('documento NAO entra no album, mas ainda e enviado', async () => {
    // Regra do WhatsApp: album e so imagem/video. O PDF vai como mensagem propria.
    await post('/api/sendMedia', {
      session: 's', chatId: '5511999999999@c.us', album: true,
      items: [
        midia(JPG, 'image/jpeg'),
        midia(JPG, 'image/jpeg'),
        midia(PDF, 'application/pdf'),
      ],
    });
    const doc = enviados.find((e) => 'document' in e.content)!;
    assert.ok(doc, 'o documento foi enviado');
    assert.equal(doc.content.albumParentKey, undefined, 'sem associacao de album');
    const container = enviados[0]!.content.album as { expectedImageCount: number };
    assert.equal(container.expectedImageCount, 2, 'so as 2 imagens contam');
  });

  it('sem album:true nao ha container', async () => {
    await post('/api/sendMedia', {
      session: 's', chatId: '5511999999999@c.us',
      items: [midia(JPG, 'image/jpeg'), midia(JPG, 'image/jpeg')],
    });
    assert.equal(enviados.length, 2);
    assert.ok(!('album' in enviados[0]!.content));
  });
});

describe('files[] nos endpoints antigos (sem trocar de rota)', () => {
  it('sendImage aceita files[] com caption por item', async () => {
    const res = await post('/api/sendImage', {
      session: 's', chatId: '5511999999999@c.us',
      files: [
        { data: JPG, mimetype: 'image/jpeg', caption: 'foto 1' },
        { data: JPG, mimetype: 'image/jpeg', caption: 'foto 2' },
      ],
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().count, 2);
    assert.deepEqual(enviados.map((e) => e.content.caption), ['foto 1', 'foto 2']);
  });

  it('sendFile com files[] manda TUDO como documento', async () => {
    const res = await post('/api/sendFile', {
      session: 's', chatId: '5511999999999@c.us',
      files: [
        { data: JPG, mimetype: 'image/jpeg', filename: 'a.jpg' },
        { data: PDF, mimetype: 'application/pdf', filename: 'b.pdf' },
      ],
    });
    assert.equal(res.statusCode, 200);
    for (const e of enviados) assert.ok('document' in e.content, 'anexo, nao imagem');
  });

  it('file unico continua funcionando (compatibilidade)', async () => {
    const res = await post('/api/sendImage', {
      session: 's', chatId: '5511999999999@c.us',
      file: { data: JPG, mimetype: 'image/jpeg' }, caption: 'unica',
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().count, undefined, 'resposta antiga nao tem count');
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0]!.content.caption, 'unica');
  });
});
