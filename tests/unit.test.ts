// tests/unit.test.ts
// Testes das partes que nao tem contraparte no backend (logica propria do gateway).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  baileysStatusToWahaAck,
  isImmediateRestart,
  isLogoutReason,
  serializeMsgId,
  toBaileysJid,
  toWahaChatId,
  wahaAckName,
} from '../dist/core/waha-compat.js';
import { WebhookEmitter } from '../dist/core/webhook.js';

describe('conversao de JID', () => {
  it('normaliza @s.whatsapp.net para @c.us', () => {
    assert.equal(toWahaChatId('5585999999999@s.whatsapp.net'), '5585999999999@c.us');
  });

  it('remove o sufixo de device do multi-device', () => {
    // "5585999:12@s.whatsapp.net" e o mesmo contato de "5585999@s.whatsapp.net".
    // Sem remover o :12, o backend criaria contato duplicado.
    assert.equal(toWahaChatId('5585999999999:12@s.whatsapp.net'), '5585999999999@c.us');
  });

  it('preserva @lid intacto', () => {
    // Reescrever um @lid destruiria o id oculto — o envio iria para um destino
    // invalido e tomaria 500 (bug vivido com o engine nativa).
    assert.equal(toWahaChatId('80131355848789@lid'), '80131355848789@lid');
  });

  it('REGRESSAO: remove o sufixo de device TAMBEM em @lid', () => {
    // Bug visto nos logs do beta: a MESMA mensagem gerava dois msgId distintos —
    //   true_207919433941235@lid_ABC     (ack 1)
    //   true_207919433941235:46@lid_ABC  (ack 2)
    // Isso quebra a guarda de idempotencia do ack e o casamento do id no backend.
    assert.equal(toWahaChatId('207919433941235:46@lid'), '207919433941235@lid');
    assert.equal(toBaileysJid('207919433941235:46@lid'), '207919433941235@lid');
  });

  it('remove sufixo de device em grupo tambem', () => {
    assert.equal(toWahaChatId('120363123456:9@g.us'), '120363123456@g.us');
  });

  it('preserva @g.us de grupo', () => {
    assert.equal(toWahaChatId('120363123456@g.us'), '120363123456@g.us');
  });

  it('faz o caminho de volta para o JID do Baileys', () => {
    assert.equal(toBaileysJid('5585999999999@c.us'), '5585999999999@s.whatsapp.net');
    assert.equal(toBaileysJid('80131355848789@lid'), '80131355848789@lid');
    assert.equal(toBaileysJid('120363123456@g.us'), '120363123456@g.us');
  });

  it('ida e volta e estavel para contato comum', () => {
    const original = '5585999999999@s.whatsapp.net';
    assert.equal(toBaileysJid(toWahaChatId(original)), original);
  });
});

describe('id de mensagem', () => {
  it('serializa no formato <fromMe>_<chat>_<raw>', () => {
    const id = serializeMsgId({
      remoteJid: '5585999999999@s.whatsapp.net',
      id: 'ABC123',
      fromMe: true,
    });
    assert.equal(id, 'true_5585999999999@c.us_ABC123');
  });

  it('id serializado permite recuperar o id cru por split', () => {
    // applyAck() do backend faz exatamente isso para casar o id gravado no envio.
    const id = serializeMsgId({ remoteJid: '5585999@s.whatsapp.net', id: 'XYZ', fromMe: false });
    assert.equal(id.split('_').pop(), 'XYZ');
  });

  it('marca fromMe=false quando ausente', () => {
    const id = serializeMsgId({ remoteJid: '5585999@s.whatsapp.net', id: 'A' });
    assert.ok(id.startsWith('false_'));
  });
});

describe('mapa de ACK', () => {
  it('SERVER_ACK do Baileys NAO e delivered', () => {
    // O erro mais facil de cometer: repassar o numero do Baileys como ack desta API.
    // SERVER_ACK(2) do Baileys significa "servidor recebeu" = sent. O ack 2 desta API
    // significa delivered. Confundir mostra dois ticks com a msg nao entregue.
    assert.equal(baileysStatusToWahaAck(2), 1, 'SERVER_ACK deve virar ack 1 (sent)');
    assert.notEqual(baileysStatusToWahaAck(2), 2);
  });

  it('DELIVERY_ACK vira delivered e READ vira read', () => {
    assert.equal(baileysStatusToWahaAck(3), 2);
    assert.equal(baileysStatusToWahaAck(4), 3);
  });

  it('PLAYED vira read (backend nao tem estado played)', () => {
    assert.equal(baileysStatusToWahaAck(5), 3);
  });

  it('ERROR vira -1 (failed)', () => {
    assert.equal(baileysStatusToWahaAck(0), -1);
  });

  it('status ausente cai em sent em vez de quebrar', () => {
    assert.equal(baileysStatusToWahaAck(null), 0);
    assert.equal(baileysStatusToWahaAck(undefined), 0);
  });

  it('status desconhecido nao vira ack invalido', () => {
    assert.equal(baileysStatusToWahaAck(99), 0);
  });

  it('nomes de ack acompanham a escala desta API', () => {
    assert.equal(wahaAckName(-1), 'ERROR');
    assert.equal(wahaAckName(3), 'READ');
  });
});

describe('logout vs queda transiente', () => {
  it('401/403/411 sao logout (exigem QR novo)', () => {
    assert.equal(isLogoutReason(401), true, 'loggedOut');
    assert.equal(isLogoutReason(403), true, 'forbidden');
    assert.equal(isLogoutReason(411), true, 'multideviceMismatch');
  });

  it('428/408/500/503 sao transientes (reconecta sozinho)', () => {
    for (const code of [428, 408, 500, 503]) {
      assert.equal(isLogoutReason(code), false, `codigo ${code} nao e logout`);
    }
  });

  it('515 e restart imediato, nao falha', () => {
    // Acontece sempre depois do primeiro QR. Tratar como falha impede o pareamento.
    assert.equal(isImmediateRestart(515), true);
    assert.equal(isLogoutReason(515), false);
  });

  it('codigo nulo nao e classificado como logout', () => {
    // Na duvida, tratar como transiente: reconectar sozinho e recuperavel; apagar o
    // pareamento por engano forca o operador a escanear QR sem necessidade.
    assert.equal(isLogoutReason(null), false);
    assert.equal(isLogoutReason(undefined), false);
  });
});

describe('WebhookEmitter', () => {
  const silentLog = {
    warn() {}, error() {}, info() {}, debug() {},
    child() { return this; },
  } as never;

  function makeEmitter(responses: Array<{ ok: boolean; status?: number }>) {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    let i = 0;
    const fetchFn = (async (url: string, opts: Record<string, unknown>) => {
      calls.push({
        url,
        headers: opts.headers as Record<string, string>,
        body: JSON.parse(opts.body as string),
      });
      const r = responses[Math.min(i++, responses.length - 1)]!;
      return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500) };
    }) as unknown as typeof fetch;
    const emitter = new WebhookEmitter(silentLog, fetchFn, async () => {});
    return { emitter, calls };
  }

  const event = {
    event: 'message' as const,
    session: 'canal-teste',
    payload: { id: 'X', body: 'oi' },
  };

  it('envia customHeaders (sem eles o backend rejeita com 401)', async () => {
    const { emitter, calls } = makeEmitter([{ ok: true }]);
    await emitter.emit(
      [{
        url: 'http://app/webhook/waha',
        events: ['message'],
        customHeaders: [{ name: 'X-Webhook-Key', value: 'segredo' }],
      }],
      event,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers['X-Webhook-Key'], 'segredo');
  });

  it('respeita a assinatura de eventos', async () => {
    const { emitter, calls } = makeEmitter([{ ok: true }]);
    await emitter.emit([{ url: 'http://app/w', events: ['message.ack'] }], event);
    assert.equal(calls.length, 0, 'nao deve entregar evento nao assinado');
  });

  it('events vazio assina tudo', async () => {
    const { emitter, calls } = makeEmitter([{ ok: true }]);
    await emitter.emit([{ url: 'http://app/w' }], event);
    assert.equal(calls.length, 1);
  });

  it('retenta em erro 5xx', async () => {
    const { emitter, calls } = makeEmitter([{ ok: false, status: 503 }, { ok: true }]);
    await emitter.emit(
      [{ url: 'http://app/w', retries: { attempts: 3, delaySeconds: 0 } }],
      event,
    );
    assert.equal(calls.length, 2, 'deve retentar e parar ao ter sucesso');
  });

  it('NAO retenta em 4xx (erro de contrato/auth)', async () => {
    const { emitter, calls } = makeEmitter([{ ok: false, status: 401 }]);
    await emitter.emit(
      [{ url: 'http://app/w', retries: { attempts: 5, delaySeconds: 0 } }],
      event,
    );
    assert.equal(calls.length, 1, '401 nao melhora com retry; nao enfileirar lixo');
  });

  it('retenta em 429 (rate limit e transitorio)', async () => {
    const { emitter, calls } = makeEmitter([{ ok: false, status: 429 }, { ok: true }]);
    await emitter.emit(
      [{ url: 'http://app/w', retries: { attempts: 3, delaySeconds: 0 } }],
      event,
    );
    assert.equal(calls.length, 2);
  });

  it('nao lanca quando o webhook falha de vez', async () => {
    const { emitter } = makeEmitter([{ ok: false, status: 500 }]);
    // Falha de webhook nao pode derrubar o processamento da mensagem.
    await emitter.emit(
      [{ url: 'http://app/w', retries: { attempts: 2, delaySeconds: 0 } }],
      event,
    );
  });

  it('entrega para multiplos webhooks', async () => {
    const { emitter, calls } = makeEmitter([{ ok: true }]);
    await emitter.emit(
      [{ url: 'http://a/w' }, { url: 'http://b/w' }],
      event,
    );
    assert.equal(calls.length, 2);
  });

  it('ignora lista vazia ou ausente sem erro', async () => {
    const { emitter, calls } = makeEmitter([{ ok: true }]);
    await emitter.emit([], event);
    await emitter.emit(undefined, event);
    assert.equal(calls.length, 0);
  });

  it('o corpo enviado carrega event, session e payload', async () => {
    const { emitter, calls } = makeEmitter([{ ok: true }]);
    await emitter.emit([{ url: 'http://app/w' }], event);
    // O backend exige `session` no corpo (401 sem isso) e passa tudo pelo translate.
    assert.deepEqual(calls[0]!.body, {
      event: 'message',
      session: 'canal-teste',
      payload: { id: 'X', body: 'oi' },
    });
  });
});
