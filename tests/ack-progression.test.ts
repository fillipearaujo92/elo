// tests/ack-progression.test.ts
//
// Testa a progressao de ACK no SessionManager via o caminho real (onMessageUpdate),
// com um pool falso que implementa a semantica do UPSERT em JS.
//
// Motivo de existir: a primeira versao do UPSERT usava `EXCLUDED.last_ack >
// last_ack` para tudo. Como failed = -1 e MENOR que qualquer ack, uma mensagem que ia
// a 'sent' e depois FALHAVA tinha a falha descartada — o consultor veria a mensagem
// como enviada sem nunca ter sido entregue. Estes testes travam o comportamento.

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { MediaStore } from '../dist/core/media.js';
import { SessionManager } from '../dist/core/session-manager.js';
import { WebhookEmitter } from '../dist/core/webhook.js';

const silentLog = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  child() { return silentLog; },
} as never;

/** Pool que replica a semantica do UPSERT de sent_messages. */
function makeAckPool() {
  const store = new Map<string, number>();
  // Ordem de insercao, para o `ORDER BY created_at ASC` do originalMsgId: quem entrou
  // primeiro (o ENVIO) tem de ganhar de quem entrou depois (o ack).
  const ordem: string[] = [];

  const pool = {
    async query(sql: string, params: unknown[] = []) {
      const q = sql.replace(/\s+/g, ' ').trim();

      if (q.startsWith('INSERT INTO wa_gateway.sent_messages')) {
        const [, msgId, , ack] = params as [string, string, string, number];
        const prev = store.get(msgId);

        if (prev === undefined) {
          store.set(msgId, ack);
          ordem.push(msgId);
          return { rows: [{ last_ack: ack }], rowCount: 1 };
        }
        // Reproduz o WHERE do UPSERT real, incluindo o ramo de failed.
        const isFailed = ack < 0;
        const allow = isFailed ? prev >= 0 : ack > prev;
        if (!allow) return { rows: [], rowCount: 0 };
        store.set(msgId, ack);
        return { rows: [{ last_ack: ack }], rowCount: 1 };
      }

      // ★ O SELECT do `originalMsgId`. Faltava aqui, e a ausencia dava FALSA
      // CONFIANCA: o fake devolvia vazio, o codigo caia no fallback do endereco do
      // recibo, e o teste passava sem nunca exercitar a busca pelo id cru — que e a
      // unica defesa contra o ack sair com @lid. Agora replica a semantica real:
      // `msg_id LIKE '%' || '_<raw>'`, ordenado pela ordem de insercao.
      if (q.startsWith('SELECT msg_id FROM wa_gateway.sent_messages')) {
        const sufixo = String((params as unknown[])[1] ?? '');
        const achado = ordem.find((id) => id.endsWith(sufixo));
        // ⚠ LIMITE deste fake, registrado por honestidade: ele nao modela a coluna
        // `content`. Verifiquei por mutacao — reintroduzir `AND content IS NOT NULL` na
        // query do originalMsgId NAO quebra nenhum teste, porque aqui nao existe conteudo
        // para filtrar. O que os testes cobrem e a ancoragem do envio (mutar
        // `rememberSentMessage` para nao criar linha sem conteudo QUEBRA o teste acima).
        // A parte do `content IS NOT NULL` foi validada contra o Postgres do beta: 305
        // linhas @lid sem conteudo eram exatamente as que a condicao ignorava.
        return { rows: achado ? [{ msg_id: achado }] : [], rowCount: achado ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return { query: pool.query, release() {} };
    },
  };
  return { pool, store };
}

let emitted: Array<{ event: string; payload: Record<string, unknown> }>;
let manager: SessionManager;

beforeEach(() => {
  emitted = [];
  const { pool } = makeAckPool();
  const webhooks = {
    async emit(_w: unknown, ev: { event: string; payload: Record<string, unknown> }) {
      emitted.push({ event: ev.event, payload: ev.payload });
    },
  } as unknown as WebhookEmitter;
  manager = new SessionManager(
    pool as never,
    silentLog,
    webhooks,
    new MediaStore(silentLog),
  );
});

/** Injeta uma sessao "viva" e dispara onMessageUpdate (privado) pelo caminho real. */
async function feedAck(baileysStatus: number, msgKeyId = 'ABC', fromMe = true) {
  const live = {
    name: 'canal-teste',
    sock: null,
    status: 'WORKING',
    qr: null,
    meId: '5585999999999',
    mePushName: null,
    config: { webhooks: [{ url: 'http://app/w' }] },
    reconnectAttempts: 0,
    reconnectTimer: null,
    lastEmittedStatus: null,
    lastEmittedAt: 0,
    stopping: false,
  };
  // onMessageUpdate e privado; chamamos pelo caminho real via cast.
  await (manager as unknown as {
    onMessageUpdate(l: unknown, u: unknown): Promise<void>;
  }).onMessageUpdate(live, {
    key: { id: msgKeyId, remoteJid: '5585999999999@s.whatsapp.net', fromMe },
    update: { status: baileysStatus },
  });
}

function acks() {
  return emitted.filter((e) => e.event === 'message.ack').map((e) => e.payload.ack);
}

describe('progressao de ACK', () => {
  it('emite a sequencia normal sent -> delivered -> read', async () => {
    await feedAck(2); // SERVER_ACK  -> 1 (sent)
    await feedAck(3); // DELIVERY_ACK-> 2 (delivered)
    await feedAck(4); // READ        -> 3 (read)
    assert.deepEqual(acks(), [1, 2, 3]);
  });

  it('suprime ack repetido (o WhatsApp reenvia)', async () => {
    await feedAck(3);
    await feedAck(3);
    await feedAck(3);
    assert.deepEqual(acks(), [2], 'deve emitir uma vez so');
  });

  it('suprime ack regressivo (delivered depois de read nao volta atras)', async () => {
    await feedAck(4); // read
    await feedAck(3); // delivered chegando atrasado
    assert.deepEqual(acks(), [3], 'read nao pode regredir para delivered');
  });

  it('REGRESSAO: failed depois de sent E emitido', async () => {
    // O bug original: -1 < 1, entao o UPSERT descartava. A mensagem ficava
    // eternamente como "enviada" no chat sem nunca ter sido entregue.
    await feedAck(2); // sent
    await feedAck(0); // ERROR -> failed (-1)
    assert.deepEqual(acks(), [1, -1], 'a falha precisa chegar ao backend');
  });

  it('failed repetido e suprimido', async () => {
    await feedAck(0);
    await feedAck(0);
    assert.deepEqual(acks(), [-1], 'failed e terminal, mas nao se repete');
  });

  it('mensagens diferentes tem progressao independente', async () => {
    await feedAck(4, 'MSG-A'); // read na A
    await feedAck(2, 'MSG-B'); // sent na B: nao deve ser bloqueado pela A
    assert.deepEqual(acks(), [3, 1]);
  });

  it('ignora update sem status', async () => {
    await (manager as unknown as {
      onMessageUpdate(l: unknown, u: unknown): Promise<void>;
    }).onMessageUpdate(
      { name: 'canal-teste', config: {} },
      { key: { id: 'X', remoteJid: '5585999@s.whatsapp.net', fromMe: true }, update: {} },
    );
    assert.equal(acks().length, 0);
  });

  it('ignora update sem id de mensagem', async () => {
    await (manager as unknown as {
      onMessageUpdate(l: unknown, u: unknown): Promise<void>;
    }).onMessageUpdate(
      { name: 'canal-teste', config: {} },
      { key: { remoteJid: '5585999@s.whatsapp.net', fromMe: true }, update: { status: 3 } },
    );
    assert.equal(acks().length, 0);
  });

  it('o id do ack sai serializado (o backend casa os dois formatos)', async () => {
    await feedAck(3, 'RAW-ID-1');
    const payload = emitted.find((e) => e.event === 'message.ack')?.payload;
    assert.equal(payload?.id, 'true_5585999999999@c.us_RAW-ID-1');
    assert.equal(String(payload?.id).split('_').pop(), 'RAW-ID-1');
  });

  it('★ o ack usa o endereco do ENVIO, nao o do recibo (@c.us, nao @lid)', async () => {
    // ── O bug que o Filipe viu no beta ────────────────────────────────────────
    // O WhatsApp endereca o MESMO contato de duas formas: o envio sai pelo telefone
    // (@c.us) e o recibo volta pelo @lid do dispositivo. O consumidor gravou a mensagem
    // com o telefone, entao um ack emitido com @lid nunca casa — e a mensagem fica
    // "presa em enviada" para sempre, mesmo entregue E LIDA no celular.
    //
    // A defesa e o `originalMsgId`, que busca pelo id CRU (o unico componente estavel) e
    // reemite o ack com o endereco original. Ela existia e FALHAVA por duas razoes,
    // ambas corrigidas:
    //
    //   1. `rememberSentMessage` tinha `if (!content) return` — mensagem sem conteudo
    //      guardavel nao criava linha, e nao havia o que o originalMsgId achar.
    //   2. `originalMsgId` exigia `content IS NOT NULL`, entao ignorava justamente as
    //      linhas criadas sem conteudo.
    //
    // Medido no beta: 305 linhas `true_...@lid_...` sem conteudo (acks orfaos, travados
    // em ack 2) contra 30 linhas `@c.us` que progrediram normalmente para ack 3.
    //
    // Aqui: registramos o envio pelo TELEFONE e disparamos o recibo pelo LID. O ack tem
    // de sair com o endereco do ENVIO.
    const RAW = 'ID-CRU-LID-TESTE';
    await manager.rememberSentMessage(
      'canal-teste',
      { id: RAW, remoteJid: '5585921774022@s.whatsapp.net', fromMe: true },
      // Sem conteudo DE PROPOSITO: e o caso que antes nao criava linha nenhuma.
      null,
    );
    // O recibo chega pelo @lid — endereco diferente, mesmo id cru.
    await (manager as unknown as {
      onMessageUpdate(l: unknown, u: unknown): Promise<void>;
    }).onMessageUpdate(
      { name: 'canal-teste', config: { webhooks: [{ url: 'http://app/w' }] } },
      { key: { id: RAW, remoteJid: '80131355848789@lid', fromMe: true }, update: { status: 4 } },
    );

    const ackEmitido = emitted.filter((e) => e.event === 'message.ack').at(-1);
    assert.ok(ackEmitido, 'o ack tem de ser emitido');
    assert.equal(
      ackEmitido.payload.id,
      `true_5585921774022@c.us_${RAW}`,
      'o id do ack tem de usar o endereco do ENVIO (@c.us), nao o do recibo (@lid)',
    );
    assert.ok(
      !String(ackEmitido.payload.id).includes('@lid'),
      'nenhum @lid pode aparecer no id do ack',
    );
  });

  it('★ ACK de mensagem RECEBIDA (fromMe=false) e IGNORADO', async () => {
    // ACK existe para mensagem que NOS enviamos. O WhatsApp emite recibo tambem quando
    // somos NOS que lemos uma mensagem recebida — e o "visto" que o gateway envia.
    //
    // MEDIDO no beta antes da correcao: 4.585 linhas em `sent_messages` com msg_id
    // `false_*` e last_ack=3, contra 385 linhas `true_*`. 92% da tabela era recibo da
    // nossa propria leitura, gravado como se fosse mensagem enviada — inflando a tabela
    // 13x, emitindo webhook de ack para mensagem que o consumidor nunca enviou, e
    // tornando `elo_ack_read_total` inutil para responder "as MINHAS mensagens estao
    // sendo lidas?".
    //
    // O comentario de onReceiptUpdate ja dizia "das mensagens que NOS enviamos": a
    // intencao estava documentada, faltava a guarda.
    await feedAck(3, 'MSG-DO-CONTATO', false);
    assert.equal(acks().length, 0, 'nao deve emitir ack de mensagem recebida');
  });

  it('ACK de mensagem propria continua funcionando (a guarda nao e larga demais)', async () => {
    // `feedAck` recebe o status do BAILEYS, não o ack do WAHA: status 3 (SERVER_ACK)
    // mapeia para ack 2 (delivered). Errei isso na primeira versão do teste e a
    // asserção pegou — a escala dupla é justamente o que `baileysStatusToWahaAck`
    // existe para traduzir.
    await feedAck(3, 'MINHA-MSG', true);
    assert.deepEqual(acks(), [2], 'status 3 do Baileys = ack 2 (entregue)');
  });
});
