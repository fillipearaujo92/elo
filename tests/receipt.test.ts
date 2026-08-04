// tests/receipt.test.ts
//
// REGRESSÃO: "todas as mensagens ficaram com falha mesmo depois de enviadas".
//
// Causa: o ACK de mensagem OUTBOUND chega no Baileys por `message-receipt.update`,
// não por `messages.update`. Escutando só o segundo, nenhum ack era emitido — a
// mensagem ficava presa em 'sent' (confirmado no banco do beta: 3 de 3 em 'sent')
// e a UI do consumidor mostrava ícone de falha mesmo com a mensagem entregue.

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { MediaStore } from '../dist/core/media.js';
import { SessionManager } from '../dist/core/session-manager.js';
import type { WebhookEmitter } from '../dist/core/webhook.js';

const silentLog = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  child() { return silentLog; },
} as never;

/** Pool que replica a semântica do UPSERT de sent_messages. */
function makePool() {
  const store = new Map<string, number>();
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.replace(/\s+/g, ' ').includes('INSERT INTO elo.sent_messages')) {
        const [, msgId, , ack] = params as [string, string, string, number];
        const prev = store.get(msgId);
        if (prev === undefined) {
          store.set(msgId, ack);
          return { rows: [{ last_ack: ack }], rowCount: 1 };
        }
        const allow = ack < 0 ? prev >= 0 : ack > prev;
        if (!allow) return { rows: [], rowCount: 0 };
        store.set(msgId, ack);
        return { rows: [{ last_ack: ack }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return { query: pool.query, release() {} };
    },
  };
  return pool;
}

let emitted: Array<{ event: string; payload: Record<string, unknown> }>;
let manager: SessionManager;

beforeEach(() => {
  emitted = [];
  const webhooks = {
    async emit(_w: unknown, ev: { event: string; payload: Record<string, unknown> }) {
      emitted.push({ event: ev.event, payload: ev.payload });
    },
  } as unknown as WebhookEmitter;
  manager = new SessionManager(
    makePool() as never,
    silentLog,
    webhooks,
    new MediaStore(silentLog),
  );
});

const live = {
  name: 'canal-teste',
  config: { webhooks: [{ url: 'http://app/w' }] },
} as never;

const key = { id: 'MSG-1', remoteJid: '5516997355492@s.whatsapp.net', fromMe: true };

/** Dispara o handler de recibo pelo caminho real (método privado). */
function feedReceipt(receipt: Record<string, unknown>, msgKey = key) {
  return (manager as unknown as {
    onReceiptUpdate(l: unknown, u: unknown): Promise<void>;
  }).onReceiptUpdate(live, { key: msgKey, receipt });
}

function acks() {
  return emitted.filter((e) => e.event === 'message.ack').map((e) => e.payload.ack);
}

describe('message-receipt.update (ACK de mensagem enviada)', () => {
  it('REGRESSAO: receiptTimestamp emite ack delivered', () => {
    // Sem este handler, NENHUM ack era emitido e a msg ficava presa em 'sent'.
    return feedReceipt({ receiptTimestamp: 1785331000 }).then(() => {
      assert.deepEqual(acks(), [2], 'delivered = ack 2 na escala do WAHA');
    });
  });

  it('readTimestamp emite ack read', async () => {
    await feedReceipt({ readTimestamp: 1785331100 });
    assert.deepEqual(acks(), [3]);
  });

  it('playedTimestamp (audio ouvido) tambem e read', async () => {
    await feedReceipt({ playedTimestamp: 1785331200 });
    assert.deepEqual(acks(), [3]);
  });

  it('recibo com varios timestamps usa o MAIS avancado', async () => {
    // Um recibo pode trazer entrega e leitura juntos; deve valer 'read'.
    await feedReceipt({ receiptTimestamp: 1785331000, readTimestamp: 1785331100 });
    assert.deepEqual(acks(), [3]);
  });

  it('progressao delivered -> read emite os dois, na ordem', async () => {
    await feedReceipt({ receiptTimestamp: 1785331000 });
    await feedReceipt({ receiptTimestamp: 1785331000, readTimestamp: 1785331100 });
    assert.deepEqual(acks(), [2, 3]);
  });

  it('recibo repetido nao reemite', async () => {
    await feedReceipt({ receiptTimestamp: 1785331000 });
    await feedReceipt({ receiptTimestamp: 1785331000 });
    assert.deepEqual(acks(), [2], 'idempotencia mantida');
  });

  it('recibo regressivo (delivered depois de read) e suprimido', async () => {
    await feedReceipt({ readTimestamp: 1785331100 });
    await feedReceipt({ receiptTimestamp: 1785331000 });
    assert.deepEqual(acks(), [3], 'read nao pode voltar para delivered');
  });

  it('recibo vazio nao emite nada', async () => {
    await feedReceipt({});
    assert.equal(acks().length, 0);
  });

  it('recibo ausente nao quebra', async () => {
    await (manager as unknown as {
      onReceiptUpdate(l: unknown, u: unknown): Promise<void>;
    }).onReceiptUpdate(live, { key });
    assert.equal(acks().length, 0);
  });

  it('sem id de mensagem nao emite', async () => {
    await feedReceipt({ receiptTimestamp: 1 }, { remoteJid: 'x@s.whatsapp.net', fromMe: true } as never);
    assert.equal(acks().length, 0);
  });

  it('o id do ack sai serializado (o backend casa os dois formatos)', async () => {
    await feedReceipt({ receiptTimestamp: 1785331000 });
    const p = emitted.find((e) => e.event === 'message.ack')?.payload;
    assert.equal(p?.id, 'true_5516997355492@c.us_MSG-1');
    assert.equal(String(p?.id).split('_').pop(), 'MSG-1');
  });

  it('mensagens diferentes tem progressao independente', async () => {
    await feedReceipt({ readTimestamp: 1 }, { ...key, id: 'MSG-A' });
    await feedReceipt({ receiptTimestamp: 1 }, { ...key, id: 'MSG-B' });
    assert.deepEqual(acks(), [3, 2]);
  });
});
