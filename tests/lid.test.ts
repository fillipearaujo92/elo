// tests/lid.test.ts
//
// REGRESSÃO do bug do primeiro E2E no beta (2026-07-29): mensagens inbound criavam
// contato com o LID no lugar do telefone. Sintomas relatados:
//   - contato "+9337493823575" (13-15 dígitos, telefone inválido)
//   - nome do contato não capturado
//   - cada resposta abria conversa NOVA (o "número" nunca casava)
//
// Causa: learnLid/payload liam `remoteJidAlt`/`participantAlt`, que NÃO existem no
// Baileys 6.7.x. Os campos corretos são senderLid/senderPn e participantLid/participantPn.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractLidPairs, isLid, phoneFromJid, senderPhoneOf } from '../dist/core/lid.js';
import { buildMessagePayload } from '../dist/core/payload.js';

/** Mensagem 1:1 endereçada por LID, com o telefone real em senderPn. */
function msgWithLid(over: Record<string, unknown> = {}) {
  return {
    key: {
      id: '3A7F3',
      remoteJid: '12455438745648@lid',
      fromMe: false,
      senderLid: '12455438745648@lid',
      senderPn: '5585986479003@s.whatsapp.net',
      ...over,
    },
    pushName: 'AraujoLaurienne',
    messageTimestamp: 1785330000,
    message: { conversation: 'Esse tamanho é grande' },
  } as never;
}

describe('phoneFromJid', () => {
  it('extrai o telefone de um JID comum', () => {
    assert.equal(phoneFromJid('5585986479003@s.whatsapp.net'), '5585986479003');
  });

  it('remove o sufixo de device do multi-device', () => {
    assert.equal(phoneFromJid('5585986479003:12@s.whatsapp.net'), '5585986479003');
  });

  it('devolve null para vazio', () => {
    assert.equal(phoneFromJid(null), null);
    assert.equal(phoneFromJid(''), null);
  });
});

describe('isLid', () => {
  it('detecta @lid e rejeita os demais', () => {
    assert.equal(isLid('12455438745648@lid'), true);
    assert.equal(isLid('5585986479003@s.whatsapp.net'), false);
    assert.equal(isLid('120363@g.us'), false);
    assert.equal(isLid(null), false);
  });
});

describe('extractLidPairs (campos REAIS do Baileys)', () => {
  it('extrai o par de senderLid + senderPn', () => {
    const pairs = extractLidPairs(msgWithLid());
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]!.lid, '12455438745648@lid');
    assert.equal(pairs[0]!.phone, '5585986479003');
    assert.equal(pairs[0]!.pushName, 'AraujoLaurienne');
  });

  it('extrai o par em GRUPO via participantLid + participantPn', () => {
    const pairs = extractLidPairs({
      key: {
        id: 'X',
        remoteJid: '120363123@g.us',
        participant: '71159085330656@lid',
        participantLid: '71159085330656@lid',
        participantPn: '5585991666098@s.whatsapp.net',
        fromMe: false,
      },
      pushName: 'Fulano',
      message: { conversation: 'oi' },
    } as never);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]!.phone, '5585991666098');
  });

  it('★ Baileys 7.x: remoteJidAlt E o caminho real (com addressingMode=lid)', () => {
    // ESTE TESTE JA AFIRMOU O CONTRARIO — e cimentava um bug.
    //
    // Na 6.7.x os campos eram senderLid/senderPn; na 7.x o proto NAO os tem
    // (`grep senderPn WAProto/index.d.ts` = 0) e a key expoe remoteJidAlt/
    // participantAlt + addressingMode (lib/Types/Message.d.ts:19-26).
    // Enquanto lemos os campos antigos, o mapa nascia VAZIO e o LID vazava como
    // telefone — o incidente que este modulo existe para impedir.
    const pairs = extractLidPairs({
      key: {
        id: 'X', remoteJid: '12455438745648@lid', fromMe: false,
        remoteJidAlt: '5585986479003@s.whatsapp.net',
        addressingMode: 'lid',
      },
      message: { conversation: 'oi' },
    } as never);
    assert.equal(pairs.length, 1, 'o par TEM de sair dos campos da 7.x');
    assert.equal(pairs[0]!.lid, '12455438745648@lid');
    assert.equal(pairs[0]!.phone, '5585986479003');
  });

  it('★ modo pn: o Alt e o LID, NAO o telefone — nao pode inverter', () => {
    // decode-wa-message.js:74-88: em 'lid' o Alt e o telefone; em 'pn' o Alt e o
    // LID. Ler o Alt cegamente como telefone gravaria LID como numero em metade
    // dos casos — pior que nao ter mapa, porque o backend receberia lixo que
    // PARECE telefone.
    const pairs = extractLidPairs({
      key: {
        id: 'X', remoteJid: '5585986479003@s.whatsapp.net', fromMe: false,
        remoteJidAlt: '12455438745648@lid',
        addressingMode: 'pn',
      },
      message: { conversation: 'oi' },
    } as never);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]!.lid, '12455438745648@lid', 'o LID e o Alt aqui');
    assert.equal(pairs[0]!.phone, '5585986479003', 'o telefone e o remoteJid');
  });

  it('★ grupo na 7.x: participantAlt da o telefone de quem falou', () => {
    const pairs = extractLidPairs({
      key: {
        id: 'X', remoteJid: '120363402863588220@g.us', fromMe: false,
        participant: '71159085330656@lid',
        participantAlt: '5585991666098@s.whatsapp.net',
        addressingMode: 'lid',
      },
      message: { conversation: 'oi' },
    } as never);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]!.phone, '5585991666098');
  });

  it('★ SEGURANCA: um @lid no lado do telefone NUNCA entra como numero', () => {
    // A guarda antiga era so contar digitos (8-15). LID tem 14-15, entao PASSAVA.
    // Este e o caso que detona ao corrigir os campos sem endurecer a validacao.
    const pairs = extractLidPairs({
      key: {
        id: 'X', remoteJid: '12455438745648@lid', fromMe: false,
        remoteJidAlt: '99887766554433@lid',
        addressingMode: 'lid',
      },
      message: { conversation: 'oi' },
    } as never);
    assert.equal(pairs.length, 0, 'lid como telefone tem de ser REJEITADO');
  });

  it('ignora par onde o "telefone" é o próprio LID (campo não populado)', () => {
    const pairs = extractLidPairs({
      key: {
        id: 'X', remoteJid: '12455438745648@lid', fromMe: false,
        senderLid: '12455438745648@lid', senderPn: '12455438745648@lid',
      },
      message: { conversation: 'oi' },
    } as never);
    assert.equal(pairs.length, 0);
  });

  it('ignora "telefone" com contagem de dígitos implausível', () => {
    // LIDs têm 14-15 dígitos; E.164 vai até 15, mas um valor de 20 é claramente lixo.
    const pairs = extractLidPairs({
      key: {
        id: 'X', remoteJid: '12455438745648@lid', fromMe: false,
        senderLid: '12455438745648@lid', senderPn: '12345678901234567890@s.whatsapp.net',
      },
      message: { conversation: 'oi' },
    } as never);
    assert.equal(pairs.length, 0);
  });

  it('mensagem sem LID não produz par', () => {
    const pairs = extractLidPairs({
      key: { id: 'X', remoteJid: '5585986479003@s.whatsapp.net', fromMe: false },
      message: { conversation: 'oi' },
    } as never);
    assert.equal(pairs.length, 0);
  });
});

describe('senderPhoneOf', () => {
  it('devolve o telefone real quando a mensagem vem por LID', () => {
    assert.equal(senderPhoneOf(msgWithLid()), '5585986479003');
  });

  it('devolve o telefone quando o JID já é telefone', () => {
    const msg = {
      key: { id: 'X', remoteJid: '5585986479003@s.whatsapp.net', fromMe: false },
      message: { conversation: 'oi' },
    } as never;
    assert.equal(senderPhoneOf(msg), '5585986479003');
  });

  it('em grupo devolve o telefone do PARTICIPANTE, não o do grupo', () => {
    const msg = {
      key: {
        id: 'X', remoteJid: '120363123@g.us', fromMe: false,
        participant: '71159085330656@lid',
        participantPn: '5585991666098@s.whatsapp.net',
      },
      message: { conversation: 'oi' },
    } as never;
    assert.equal(senderPhoneOf(msg), '5585991666098');
  });

  it('devolve null quando só há LID (aí o session-manager resolve)', () => {
    const msg = {
      key: { id: 'X', remoteJid: '12455438745648@lid', fromMe: false },
      message: { conversation: 'oi' },
    } as never;
    assert.equal(senderPhoneOf(msg), null);
  });
});

describe('payload: o LID nunca deve vazar como número', () => {
  it('REGRESSÃO: from usa o TELEFONE, não o LID', () => {
    // Este é o teste que trava o bug relatado. Antes: from = "12455438745648@lid",
    // e o backend criava contato "+12455438745648".
    const p = buildMessagePayload(msgWithLid()) as Record<string, unknown>;
    assert.equal(p.from, '5585986479003@c.us');
    assert.ok(!String(p.from).includes('@lid'), 'from nao pode conter @lid');
    assert.ok(
      !String(p.from).startsWith('12455438745648'),
      'from nao pode ser o LID',
    );
  });

  it('notifyName carrega o nome (senao o contato fica so com o telefone)', () => {
    const p = buildMessagePayload(msgWithLid()) as Record<string, unknown>;
    assert.equal(p.notifyName, 'AraujoLaurienne');
  });

  it('nameFallback preenche quando a mensagem nao traz pushName', () => {
    const msg = msgWithLid();
    (msg as { pushName?: string | null }).pushName = null;
    const p = buildMessagePayload(msg, { nameFallback: 'Nome Do Contato' }) as Record<string, unknown>;
    assert.equal(p.notifyName, 'Nome Do Contato');
  });

  it('overridePhone (LID resolvido pelo mapa) vence a key', () => {
    const msg = {
      key: { id: 'X', remoteJid: '99999999999999@lid', fromMe: false },
      pushName: 'Zé',
      message: { conversation: 'oi' },
    } as never;
    const p = buildMessagePayload(msg, { overridePhone: '5511988887777' }) as Record<string, unknown>;
    assert.equal(p.from, '5511988887777@c.us');
  });

  it('sem telefone conhecido, mantem o @lid (o backend tenta resolver)', () => {
    // Preferimos entregar o @lid a inventar um numero: o backend detecta o sufixo e
    // chama /lids/{lid}. Normalizar para @c.us aqui destruiria essa chance.
    const msg = {
      key: { id: 'X', remoteJid: '99999999999999@lid', fromMe: false },
      message: { conversation: 'oi' },
    } as never;
    const p = buildMessagePayload(msg) as Record<string, unknown>;
    assert.equal(p.from, '99999999999999@lid');
  });

  it('em grupo: from e o grupo e participant e o telefone do remetente', () => {
    const msg = {
      key: {
        id: 'X', remoteJid: '120363123@g.us', fromMe: false,
        participant: '71159085330656@lid',
        participantPn: '5585991666098@s.whatsapp.net',
      },
      pushName: 'Fulano',
      message: { conversation: 'oi grupo' },
    } as never;
    const p = buildMessagePayload(msg) as Record<string, unknown>;
    assert.equal(p.from, '120363123@g.us');
    assert.equal(p.participant, '5585991666098@c.us');
  });
});
