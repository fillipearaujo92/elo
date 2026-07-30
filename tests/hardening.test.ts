// tests/hardening.test.ts
//
// Correções vindas da varredura de falhas pré-produção. Cada bloco aqui é um
// defeito que EXISTIA e causaria falha real — os comentários dizem qual.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractLidPairs, looksLikePhone, senderPhoneOf } from '../dist/core/lid.js';
import { toBaileysJid, toWahaChatId } from '../dist/core/waha-compat.js';

describe('@newsletter: id de canal NAO e telefone', () => {
  // Defeito: `newsletter` faltava na lista de domínios preservados, então um id
  // de canal (18 dígitos) era reescrito para @c.us e chegava ao CRM como
  // telefone — mesma classe de dano do LID vazado. E canais são RECEBIDOS por
  // padrão, então o caminho estava aberto sem configuração nenhuma.
  const CH = '120363401234567890@newsletter';

  it('toWahaChatId preserva @newsletter', () => {
    assert.equal(toWahaChatId(CH), CH);
  });

  it('toBaileysJid preserva @newsletter (senao enviaria a um JID inexistente)', () => {
    assert.equal(toBaileysJid(CH), CH);
  });

  it('os outros dominios nao-telefone seguem preservados', () => {
    assert.equal(toWahaChatId('12455438745648@lid'), '12455438745648@lid');
    assert.equal(toWahaChatId('120363402863588220@g.us'), '120363402863588220@g.us');
    assert.equal(toWahaChatId('123@broadcast'), '123@broadcast');
    // ...e telefone continua virando @c.us.
    assert.equal(toWahaChatId('5585912345678@s.whatsapp.net'), '5585912345678@c.us');
  });
});

describe('looksLikePhone: a guarda que impede LID virar numero', () => {
  it('aceita telefone BR com pais (12 e 13 digitos)', () => {
    assert.equal(looksLikePhone('5585912345678@s.whatsapp.net'), true);
    assert.equal(looksLikePhone('558533334444@s.whatsapp.net'), true);
  });

  it('REJEITA qualquer @lid, independente do tamanho', () => {
    assert.equal(looksLikePhone('12455438745648@lid'), false);
    assert.equal(looksLikePhone('5585912345678@lid'), false, 'nem se parecer telefone');
  });

  it('rejeita curto demais (ramal) e longo demais', () => {
    assert.equal(looksLikePhone('123456789@s.whatsapp.net'), false);
    assert.equal(looksLikePhone('1234567890123456@s.whatsapp.net'), false);
  });

  it('remove sufixo de dispositivo antes de medir', () => {
    assert.equal(looksLikePhone('5585912345678:24@s.whatsapp.net'), true);
  });
});

describe('senderPhoneOf na 7.x', () => {
  it('1:1 com addressingMode lid: telefone vem do remoteJidAlt', () => {
    const phone = senderPhoneOf({
      key: {
        id: 'X', remoteJid: '12455438745648@lid', fromMe: false,
        remoteJidAlt: '5585986479003@s.whatsapp.net', addressingMode: 'lid',
      },
    } as never);
    assert.equal(phone, '5585986479003');
  });

  it('grupo: devolve o telefone de QUEM FALOU, nao o do grupo', () => {
    const phone = senderPhoneOf({
      key: {
        id: 'X', remoteJid: '120363402863588220@g.us', fromMe: false,
        participant: '71159085330656@lid',
        participantAlt: '5585991666098@s.whatsapp.net', addressingMode: 'lid',
      },
    } as never);
    assert.equal(phone, '5585991666098');
  });

  it('sem telefone conhecido devolve null (NUNCA o LID)', () => {
    const phone = senderPhoneOf({
      key: { id: 'X', remoteJid: '12455438745648@lid', fromMe: false },
    } as never);
    assert.equal(phone, null);
  });

  it('nao confunde os lados quando o modo e pn', () => {
    const phone = senderPhoneOf({
      key: {
        id: 'X', remoteJid: '5585986479003@s.whatsapp.net', fromMe: false,
        remoteJidAlt: '12455438745648@lid', addressingMode: 'pn',
      },
    } as never);
    assert.equal(phone, '5585986479003', 'o Alt aqui e LID; nao pode ser lido como telefone');
  });
});

describe('extractLidPairs: sem LID, sem par', () => {
  it('conversa 1:1 comum nao gera par', () => {
    const pairs = extractLidPairs({
      key: { id: 'X', remoteJid: '5585912345678@s.whatsapp.net', fromMe: false },
      message: { conversation: 'oi' },
    } as never);
    assert.equal(pairs.length, 0);
  });

  it('nao duplica o mesmo lid', () => {
    const pairs = extractLidPairs({
      key: {
        id: 'X', remoteJid: '12455438745648@lid', fromMe: false,
        remoteJidAlt: '5585986479003@s.whatsapp.net',
        addressingMode: 'lid',
        senderLid: '12455438745648@lid',
        senderPn: '5585986479003@s.whatsapp.net',
      },
      message: { conversation: 'oi' },
    } as never);
    assert.equal(pairs.length, 1);
  });
});
