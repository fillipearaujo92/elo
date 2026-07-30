// tests/contract.test.ts
//
// CONTRACT TESTS — a validacao mais importante do repo.
//
// Em vez de reimplementar o que o backend espera (e arriscar divergir), estes testes
// importam o tradutor REAL do backend (backend/lib/wa-provider/waha-translate.js) e
// passam os payloads que o gateway produz por ele. Se o shape divergir, quebra aqui
// e nao em producao.
//
// O caminho do backend vem de SYSLED_BACKEND_PATH. Sem a variavel (o caso de quem
// so quer rodar o gateway), os testes sao SKIPPADOS com aviso — nao falham
// silenciosamente nem passam mascarando ausencia de verificacao.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
// Importa do BUILD (dist/), nao do src/: o projeto usa moduleResolution NodeNext, em
// que os imports internos carregam extensao .js. O strip-types do Node nao reescreve
// essas extensoes, entao `npm test` compila antes de rodar (ver package.json).
import { buildAckPayload, buildMessagePayload, buildSessionStatusPayload } from '../dist/core/payload.js';
import { baileysStatusToWahaAck } from '../dist/core/waha-compat.js';

// Sem default de caminho absoluto: o antigo apontava para a maquina de um dev
// especifico, o que nao faz sentido em nenhum outro clone. Sem a variavel, os
// testes de contrato sao SKIPPADOS com aviso (ver abaixo) — que e o certo para
// quem nao tem o backend do Sysled a mao.
const BACKEND = process.env.SYSLED_BACKEND_PATH ?? '';

const translatePath = BACKEND ? join(BACKEND, 'lib/wa-provider/waha-translate.js') : '';
const reconnectPath = BACKEND ? join(BACKEND, 'lib/wa-provider/waha-reconnect.js') : '';
const hasBackend = !!BACKEND && existsSync(translatePath) && existsSync(reconnectPath);

if (!hasBackend) {
  console.warn(
    '[contract] testes de contrato SKIPPADOS (integracao com o Sysled Chat).\n' +
      '  Sao opcionais: validam que os payloads casam com o tradutor do backend do\n' +
      '  Sysled. Para rodar, aponte SYSLED_BACKEND_PATH para o diretorio backend/.',
  );
}

// Import dinamico: o backend e ESM em JS puro.
const { translateWahaEvent } = hasBackend
  ? await import(`file://${translatePath}`)
  : { translateWahaEvent: null };
const { decideWahaAction, MAX_RECONNECT_ATTEMPTS } = hasBackend
  ? await import(`file://${reconnectPath}`)
  : { decideWahaAction: null, MAX_RECONNECT_ATTEMPTS: 3 };

const SESSION = 'canal-teste';

/** Envelope do webhook, igual ao que o WebhookEmitter manda. */
function envelope(event: string, payload: Record<string, unknown>) {
  return { event, session: SESSION, payload };
}

// Fabrica de WAMessage do Baileys (shape minimo que os builders leem).
function waMessage(over: {
  id?: string;
  remoteJid?: string;
  fromMe?: boolean;
  participant?: string;
  pushName?: string | null;
  timestamp?: number;
  message?: Record<string, unknown>;
}) {
  return {
    key: {
      id: over.id ?? 'ABC123',
      remoteJid: over.remoteJid ?? '5585999999999@s.whatsapp.net',
      fromMe: over.fromMe ?? false,
      ...(over.participant ? { participant: over.participant } : {}),
    },
    pushName: over.pushName === undefined ? 'Fulano' : over.pushName,
    messageTimestamp: over.timestamp ?? 1782828990,
    message: over.message ?? { conversation: 'ola' },
  } as never;
}

describe('contrato: evento message', { skip: !hasBackend }, () => {
  it('texto 1:1 traduz para inbound com telefone, texto e msgId', () => {
    const payload = buildMessagePayload(waMessage({ message: { conversation: 'ola' } }));
    const out = translateWahaEvent(envelope('message', payload));

    assert.equal(out.kind, 'inbound');
    assert.equal(out.session, SESSION);
    assert.equal(out.from, '5585999999999', 'telefone deve sair sem sufixo de JID');
    assert.equal(out.text, 'ola');
    assert.equal(out.fromMe, false);
    assert.equal(out.isGroup, false);
    assert.equal(out.messageType, 'text');
    assert.ok(out.msgId, 'msgId e obrigatorio: sem ele a idempotencia do backend nao funciona');
  });

  it('mensagem de grupo marca isGroup e extrai o participante', () => {
    const payload = buildMessagePayload(
      waMessage({
        remoteJid: '120363123456@g.us',
        participant: '5585991666098@s.whatsapp.net',
        message: { conversation: 'oi grupo' },
      }),
    );
    const out = translateWahaEvent(envelope('message', payload));

    assert.equal(out.isGroup, true);
    assert.equal(out.groupId, '120363123456@g.us');
    assert.equal(out.from, '5585991666098', 'em grupo, from = participante');
  });

  it('remetente @lid expoe senderLid para o backend resolver o telefone', () => {
    // Regressao do bug "no LID found": sem fromIsLid/senderLid o contato nasce com o
    // id oculto no lugar do numero e o consultor nao consegue responder.
    const payload = buildMessagePayload(
      waMessage({ remoteJid: '80131355848789@lid', message: { conversation: 'oi' } }),
    );
    const out = translateWahaEvent(envelope('message', payload));

    assert.equal(out.fromIsLid, true);
    assert.equal(out.senderLid, '80131355848789@lid');
    assert.equal(out.from, '80131355848789');
  });

  it('imagem com caption entrega mediaUrl, mimetype e caption como texto', () => {
    const payload = buildMessagePayload(
      waMessage({
        message: { imageMessage: { caption: 'olha isso', mimetype: 'image/jpeg' } },
      }),
      { mediaUrl: 'https://gateway.exemplo.local/api/files/canal-teste/ABC123.jpeg' },
    );
    const out = translateWahaEvent(envelope('message', payload));

    assert.equal(out.messageType, 'image');
    assert.equal(out.mediaUrlRaw, 'https://gateway.exemplo.local/api/files/canal-teste/ABC123.jpeg');
    assert.equal(out.mediaMime, 'image/jpeg');
    assert.equal(out.text, 'olha isso');
  });

  it('voice note (ptt) sem caption vira audio com placeholder [Audio]', () => {
    const payload = buildMessagePayload(
      waMessage({ message: { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } } }),
      { mediaUrl: 'https://gateway.exemplo.local/api/files/canal-teste/ABC123.oga' },
    );
    const out = translateWahaEvent(envelope('message', payload));

    assert.equal(out.messageType, 'audio');
    assert.equal(out.text, '[Audio]');
  });

  it('documento sem caption usa o filename como conteudo', () => {
    const payload = buildMessagePayload(
      waMessage({
        message: {
          documentMessage: { fileName: 'orcamento.pdf', mimetype: 'application/pdf' },
        },
      }),
      { mediaUrl: 'https://gateway.exemplo.local/api/files/canal-teste/ABC123.pdf' },
    );
    const out = translateWahaEvent(envelope('message', payload));

    assert.equal(out.messageType, 'file');
    assert.equal(out.mediaFilename, 'orcamento.pdf');
    assert.equal(out.text, 'orcamento.pdf');
  });

  it('sticker vira messageType sticker com placeholder', () => {
    const payload = buildMessagePayload(
      waMessage({ message: { stickerMessage: { mimetype: 'image/webp' } } }),
      { mediaUrl: 'https://gateway.exemplo.local/api/files/canal-teste/ABC123.webp' },
    );
    const out = translateWahaEvent(envelope('message', payload));

    assert.equal(out.messageType, 'sticker');
    assert.equal(out.text, '[Figurinha]');
  });

  it('mensagem apagada (revoked) cai em kind=system e NAO virou bolha em branco', () => {
    // Regressao: notificacoes de sistema viravam mensagem vazia (145 acumuladas num tenant real).
    const payload = buildMessagePayload(
      waMessage({ message: { protocolMessage: { type: 0 } } }),
    );
    const out = translateWahaEvent(envelope('message', payload));

    assert.equal(out.kind, 'system', 'revoked deve ser sistema, nao mensagem');
  });

  it('midia sem url baixada mantem o tipo e placeholder (url null e previsto)', () => {
    const payload = buildMessagePayload(
      waMessage({ message: { imageMessage: { mimetype: 'image/jpeg' } } }),
      { mediaUrl: null },
    );
    const out = translateWahaEvent(envelope('message', payload));

    assert.equal(out.messageType, 'image');
    assert.equal(out.mediaUrlRaw, null);
    assert.equal(out.text, '[Imagem]');
  });
});

describe('contrato: evento message.ack', { skip: !hasBackend }, () => {
  // A escala do WAHA e a do Baileys NAO coincidem. Este teste trava a conversao:
  // SERVER_ACK do Baileys e apenas 'sent' — trata-lo como 'delivered' mostraria
  // dois ticks para o consultor com a mensagem ainda nao entregue.
  const cases: Array<[string, number, string]> = [
    ['PENDING -> sent', 1, 'sent'],
    ['SERVER_ACK -> sent', 2, 'sent'],
    ['DELIVERY_ACK -> delivered', 3, 'delivered'],
    ['READ -> read', 4, 'read'],
    ['PLAYED -> read', 5, 'read'],
    ['ERROR -> failed', 0, 'failed'],
  ];

  for (const [label, baileysStatus, expected] of cases) {
    it(`${label}`, () => {
      const ack = baileysStatusToWahaAck(baileysStatus);
      const payload = buildAckPayload({
        msgId: 'true_5585999999999@c.us_ABC123',
        chatId: '5585999999999@s.whatsapp.net',
        ack,
      });
      const out = translateWahaEvent(envelope('message.ack', payload));

      assert.equal(out.kind, 'ack');
      assert.equal(out.status, expected);
    });
  }

  it('id serializado permite o backend casar tambem o id cru', () => {
    // applyAck faz split('_').pop(). O caminho de envio grava o id que o gateway
    // devolve no send; o formato serializado satisfaz os dois lados.
    const payload = buildAckPayload({
      msgId: 'true_5585999999999@c.us_ABC123',
      chatId: '5585999999999@s.whatsapp.net',
      ack: 3,
    });
    const out = translateWahaEvent(envelope('message.ack', payload));

    assert.equal(out.msgId, 'true_5585999999999@c.us_ABC123');
    assert.equal(String(out.msgId).split('_').pop(), 'ABC123');
  });
});

describe('contrato: evento session.status', { skip: !hasBackend }, () => {
  it('WORKING traduz para session com status WORKING (backend marca connected)', () => {
    const out = translateWahaEvent(
      envelope('session.status', buildSessionStatusPayload(SESSION, 'WORKING')),
    );
    assert.equal(out.kind, 'session');
    assert.equal(out.status, 'WORKING');
  });

  for (const status of ['STARTING', 'SCAN_QR_CODE', 'FAILED', 'STOPPED'] as const) {
    it(`${status} traduz para session sem marcar connected`, () => {
      const out = translateWahaEvent(
        envelope('session.status', buildSessionStatusPayload(SESSION, status)),
      );
      assert.equal(out.kind, 'session');
      assert.equal(out.status, status);
      assert.notEqual(out.status, 'WORKING');
    });
  }
});

describe('contrato: maquina de reconexao do backend', { skip: !hasBackend }, () => {
  // O gateway precisa reportar status/hasMe de forma que decideWahaAction() faca a
  // coisa certa. Estes testes provam que o vocabulario do gateway aciona as acoes
  // esperadas na maquina REAL do backend, sem alteracao nela.
  const channel = { reconnect_attempts: 0, reconnect_next_at: null, disconnected_at: null };
  const now = 1_800_000_000_000;

  it('WORKING -> recovered', () => {
    assert.equal(decideWahaAction({ status: 'WORKING', hasMe: true }, channel, now).action, 'recovered');
  });

  it('STARTING -> idle (nunca alerta durante o boot da sessao)', () => {
    assert.equal(decideWahaAction({ status: 'STARTING', hasMe: true }, channel, now).action, 'idle');
  });

  it('SCAN_QR_CODE -> alert_qr (so humano resolve)', () => {
    assert.equal(decideWahaAction({ status: 'SCAN_QR_CODE', hasMe: false }, channel, now).action, 'alert_qr');
  });

  it('FAILED com hasMe=true -> start (queda transiente, reconecta sozinho)', () => {
    const d = decideWahaAction({ status: 'FAILED', hasMe: true }, channel, now);
    assert.equal(d.action, 'start');
    assert.equal(d.attempts, 1);
  });

  it('FAILED com hasMe=false -> alert_qr (logout, nao insiste)', () => {
    // Se o gateway reportasse hasMe=true no logout, o backend entraria em loop de
    // reconexao inutil; se reportasse false numa queda transiente, incomodaria o
    // operador sem motivo. Por isso me_id e limpo APENAS no logout real (401/403/411).
    assert.equal(decideWahaAction({ status: 'FAILED', hasMe: false }, channel, now).action, 'alert_qr');
  });

  it('esgotou tentativas -> alert_exhausted', () => {
    const exhausted = { ...channel, reconnect_attempts: MAX_RECONNECT_ATTEMPTS };
    assert.equal(
      decideWahaAction({ status: 'FAILED', hasMe: true }, exhausted, now).action,
      'alert_exhausted',
    );
  });
});
