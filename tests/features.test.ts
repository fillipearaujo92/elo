// tests/features.test.ts
// Reply (mensagem citada), reactions e deteccao de ORIGEM do envio
// (app / WhatsApp Web / API) — equivalente ao `data.source` de outro gateway.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMessagePayload } from '../dist/core/payload.js';
import { detectSource, wahaTypeFromMessage } from '../dist/core/waha-compat.js';

function msg(over: { id?: string; fromMe?: boolean; message?: Record<string, unknown> }) {
  return {
    key: {
      id: over.id ?? 'ABC123',
      remoteJid: '5585986479003@s.whatsapp.net',
      fromMe: over.fromMe ?? false,
    },
    pushName: 'Fulano',
    messageTimestamp: 1785330000,
    message: over.message ?? { conversation: 'oi' },
  } as never;
}

describe('origem do envio (equivalente ao source de outro gateway)', () => {
  it('id de 32 hex maiusculos = app mobile', () => {
    assert.equal(detectSource('A5C959F2371C99020F4DE9EEB25435F9', false), 'app');
  });

  it('prefixo 3EB0 em mensagem propria = enviada pela API (nosso gateway)', () => {
    // Distingue "eu respondi pelo consumidor" de "respondi pelo celular".
    assert.equal(detectSource('3EB0ABC123DEF4567890', true), 'api');
  });

  it('prefixo 3EB0 em mensagem de terceiro = WhatsApp Web', () => {
    assert.equal(detectSource('3EB0ABC123DEF4567890', false), 'web');
  });

  it('prefixo BAE5 (formato legado) tambem e web', () => {
    assert.equal(detectSource('BAE5ABC123DEF456', false), 'web');
  });

  it('id ausente ou irreconhecivel devolve unknown em vez de errar', () => {
    assert.equal(detectSource(null, false), 'unknown');
    assert.equal(detectSource('', false), 'unknown');
    assert.equal(detectSource('xyz', false), 'unknown');
  });

  it('payload carrega o campo source', () => {
    const p = buildMessagePayload(
      msg({ id: 'A5C959F2371C99020F4DE9EEB25435F9' }),
    ) as Record<string, unknown>;
    assert.equal(p.source, 'app');
  });

  it('REGRESSAO: mensagem enviada pelo celular chega identificada', () => {
    // O caso relatado: "identificar quando a mensagem e enviada pelo app do
    // WhatsApp ou WhatsApp Web". Sem isso, o operador nao sabe a origem.
    const p = buildMessagePayload(
      msg({ id: 'A5C959F2371C99020F4DE9EEB25435F9', fromMe: true }),
    ) as Record<string, unknown>;
    assert.equal(p.fromMe, true);
    assert.equal(p.source, 'app', 'eco do celular deve vir como app');
  });
});

describe('reply (mensagem citada)', () => {
  const comCitacao = msg({
    message: {
      extendedTextMessage: {
        text: 'concordo',
        contextInfo: {
          stanzaId: 'ID-DA-CITADA',
          participant: '5585991666098@s.whatsapp.net',
          quotedMessage: { conversation: 'texto original' },
        },
      },
    },
  });

  it('extrai o id da mensagem citada', () => {
    const p = buildMessagePayload(comCitacao) as Record<string, unknown>;
    assert.equal(p.quotedMsgId, 'ID-DA-CITADA');
    assert.equal(p.replyTo, 'ID-DA-CITADA');
  });

  it('extrai o autor da citada normalizado para @c.us', () => {
    const p = buildMessagePayload(comCitacao) as Record<string, unknown>;
    assert.equal(p.quotedParticipant, '5585991666098@c.us');
  });

  it('preserva o corpo da citada para o preview', () => {
    const p = buildMessagePayload(comCitacao) as Record<string, unknown>;
    assert.equal((p._data as { quotedMsg?: string }).quotedMsg, 'texto original');
  });

  it('o texto da resposta continua no body', () => {
    const p = buildMessagePayload(comCitacao) as Record<string, unknown>;
    assert.equal(p.body, 'concordo');
  });

  it('citacao em MIDIA tambem e detectada', () => {
    const p = buildMessagePayload(
      msg({
        message: {
          imageMessage: {
            caption: 'veja',
            mimetype: 'image/jpeg',
            contextInfo: { stanzaId: 'CITADA-2' },
          },
        },
      }),
    ) as Record<string, unknown>;
    assert.equal(p.quotedMsgId, 'CITADA-2');
    assert.equal(p.type, 'image');
  });

  it('mensagem sem citacao nao ganha campos de reply', () => {
    const p = buildMessagePayload(msg({})) as Record<string, unknown>;
    assert.equal(p.quotedMsgId, undefined);
    assert.equal(p.replyTo, undefined);
  });
});

describe('reactions', () => {
  it('extrai a reacao e marca type=reaction', () => {
    const p = buildMessagePayload(
      msg({
        message: {
          reactionMessage: {
            text: '👍',
            key: { id: 'MSG-ALVO', fromMe: false, remoteJid: '5585986479003@s.whatsapp.net' },
          },
        },
      }),
    ) as Record<string, unknown>;

    const r = p.reaction as { text: string; messageId: string };
    assert.equal(r.text, '👍');
    assert.equal(r.messageId, 'MSG-ALVO');
    // type=reaction sinaliza ao consumidor: aplique na mensagem alvo, NAO crie bolha.
    assert.equal(p.type, 'reaction');
  });

  it('reacao VAZIA e valida (remocao da reacao)', () => {
    // O WhatsApp modela "desreagir" como reacao com texto vazio — nao ha delete.
    const p = buildMessagePayload(
      msg({
        message: {
          reactionMessage: { text: '', key: { id: 'MSG-ALVO', fromMe: true } },
        },
      }),
    ) as Record<string, unknown>;
    const r = p.reaction as { text: string; messageId: string };
    assert.equal(r.text, '');
    assert.equal(r.messageId, 'MSG-ALVO');
  });

  it('mensagem normal nao ganha campo reaction', () => {
    const p = buildMessagePayload(msg({})) as Record<string, unknown>;
    assert.equal(p.reaction, undefined);
    assert.equal(p.type, 'chat');
  });
});

describe('reacao NAO deve virar mensagem (bug relatado)', () => {
  it('REGRESSAO: wahaTypeFromMessage classifica reactionMessage como reaction', () => {
    // Antes: reactionMessage caia em 'unknown', entao o messages.upsert emitia a
    // reacao COMO MENSAGEM — o cliente reagia e no consumidor aparecia uma bolha junto
    // com a reacao ("mostra para o cliente junto com uma mensagem").
    const tipo = wahaTypeFromMessage({
      key: { id: 'X', remoteJid: '5585999@s.whatsapp.net', fromMe: false },
      message: {
        reactionMessage: { text: '👍', key: { id: 'ALVO', fromMe: true } },
      },
    } as never);
    assert.equal(tipo, 'reaction', 'nunca pode ser unknown/chat');
  });

  it('reacao vazia (remocao) tambem e classificada como reaction', () => {
    const tipo = wahaTypeFromMessage({
      key: { id: 'X', remoteJid: '5585999@s.whatsapp.net', fromMe: false },
      message: { reactionMessage: { text: '', key: { id: 'ALVO' } } },
    } as never);
    assert.equal(tipo, 'reaction');
  });

  it('mensagem normal nao e confundida com reaction', () => {
    const tipo = wahaTypeFromMessage({
      key: { id: 'X', remoteJid: '5585999@s.whatsapp.net', fromMe: false },
      message: { conversation: 'oi' },
    } as never);
    assert.equal(tipo, 'chat');
  });
});
