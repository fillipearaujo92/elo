// tests/chamadas-execucao.test.ts
//
// Chamadas: comportamento do `onCall` EXECUTANDO, não lendo o arquivo.
//
// ── Por que este arquivo existe, separado do chamadas.test.ts ──────────────
// O outro arquivo verifica o código-fonte (que o limite do protocolo está documentado,
// que nenhuma rota promete atender). Isso tem um teto, e uma MUTAÇÃO mostrou onde:
// remover o `return` do anel de idempotência passou 100% verde, porque `callsVistas`
// continuava MENCIONADO no método. Ler o arquivo prova que a linha existe; só executar
// prova que ela faz efeito.
//
// Aqui o `onCall` roda de verdade, com pool/webhook/socket falsos, e o que se afirma é
// o efeito observável: quantos eventos saíram, com que conteúdo, e se recusou.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Assinatura mínima do que exercitamos (o método é privado na classe). */
type ComOnCall = { onCall: (live: unknown, ev: unknown) => Promise<void> };

const silent = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  child() { return silent; },
} as never;

/** SessionManager com dependências falsas, e a lista de eventos emitidos. */
async function manager() {
  const { SessionManager } = await import('../dist/core/session-manager.js');
  const { MediaStore } = await import('../dist/core/media.js');
  const emitidos: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const pool = {
    async query() { return { rows: [], rowCount: 0 }; },
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; },
  };
  const webhooks = {
    async emit(_w: unknown, ev: { event: string; payload: Record<string, unknown> }) {
      emitidos.push(ev);
    },
  };
  const sm = new SessionManager(pool as never, silent, webhooks as never, new MediaStore(silent));
  return { call: sm as unknown as ComOnCall, emitidos };
}

/** Sessão viva mínima, com os campos que o onCall lê. */
function sessao(over: Record<string, unknown> = {}) {
  return {
    name: 'canal',
    status: 'WORKING',
    generation: 1,
    config: { webhooks: [{ url: 'https://exemplo.test/hook' }] },
    sock: { rejectCall: async () => {}, sendMessage: async () => {} },
    ...over,
  };
}

const DE = '5585999998888@s.whatsapp.net';

describe('onCall: idempotência', () => {
  it('★ o MESMO (chamada, status) é emitido UMA vez', async () => {
    // O WhatsApp reenvia atualização da mesma chamada, e após reconexão vem o lote
    // represado (`offline: true`). Sem corte, quem consome grava várias entradas para
    // uma ligação só, e o operador lê como várias tentativas do cliente.
    const { call, emitidos } = await manager();
    const ev = { id: 'CALL-1', from: DE, status: 'offer', date: new Date(0) };
    await call.onCall(sessao(), ev);
    await call.onCall(sessao(), ev);
    await call.onCall(sessao(), ev);
    assert.equal(emitidos.length, 1, `esperado 1 evento, saíram ${emitidos.length}`);
  });

  it('status DIFERENTE da mesma chamada emite — o ciclo interessa', async () => {
    // "Ligaram" é menos útil que "ligaram, ninguém atendeu, desligou": os três
    // eventos juntos é que contam a história no histórico de atendimento.
    const { call, emitidos } = await manager();
    for (const status of ['offer', 'ringing', 'timeout']) {
      await call.onCall(sessao(), { id: 'CALL-2', from: DE, status, date: new Date(0) });
    }
    assert.equal(emitidos.length, 3);
    assert.deepEqual(emitidos.map((e) => e.payload.status), ['offer', 'ringing', 'timeout']);
  });

  it('chamadas distintas não se cancelam', async () => {
    const { call, emitidos } = await manager();
    await call.onCall(sessao(), { id: 'A', from: DE, status: 'offer', date: new Date(0) });
    await call.onCall(sessao(), { id: 'B', from: DE, status: 'offer', date: new Date(0) });
    assert.equal(emitidos.length, 2);
  });
});

describe('onCall: o que vai no payload', () => {
  it('tipo é rótulo, não booleano; e diz se o gateway recusou', async () => {
    const { call, emitidos } = await manager();
    await call.onCall(sessao(), { id: 'C3', from: DE, status: 'offer', isVideo: true, date: new Date(0) });
    const p = emitidos[0]!.payload;
    assert.equal(emitidos[0]!.event, 'call');
    // `isVideo: false` exigiria que o consumidor soubesse que o oposto é voz.
    assert.equal(p.type, 'video');
    assert.equal(p.rejectedByGateway, false, 'sem rejectAll, o gateway não recusou');
    assert.match(String(p.from), /5585999998888/);

    await call.onCall(sessao(), { id: 'C4', from: DE, status: 'offer', date: new Date(0) });
    assert.equal(emitidos[1]!.payload.type, 'voice', 'sem isVideo, é voz');
  });

  it('★ callerPn vence o LID: a ligação não chega com id oculto', async () => {
    // Sem esta preferência a chamada apareceria identificada por um id que ninguém
    // reconhece — o mesmo problema que o mapa de LID resolve para mensagem.
    const { call, emitidos } = await manager();
    await call.onCall(sessao(), {
      id: 'C5', from: '80131355848789@lid', callerPn: DE, status: 'offer', date: new Date(0),
    });
    const p = emitidos[0]!.payload;
    assert.match(String(p.from), /5585999998888/, 'o telefone tem de vencer o LID');
    assert.equal(p.fromLid, '80131355848789@lid', 'e o LID fica EXPOSTO, não escondido');
  });

  it('`offline` viaja no payload (evento represado ≠ ligando agora)', async () => {
    // Sem isso, um restart geraria "estão ligando" para chamadas de horas atrás.
    const { call, emitidos } = await manager();
    await call.onCall(sessao(), { id: 'C6', from: DE, status: 'offer', offline: true, date: new Date(0) });
    assert.equal(emitidos[0]!.payload.offline, true);
  });

  it('grupo é identificado como tal', async () => {
    const { call, emitidos } = await manager();
    await call.onCall(sessao(), {
      id: 'C7', from: DE, status: 'offer', isGroup: true,
      groupJid: '120363111@g.us', date: new Date(0),
    });
    const p = emitidos[0]!.payload;
    assert.equal(p.isGroup, true);
    assert.match(String(p.groupId), /120363111/);
  });

  it('evento sem id ou sem origem é ignorado (não emite lixo)', async () => {
    const { call, emitidos } = await manager();
    await call.onCall(sessao(), { from: DE, status: 'offer' });
    await call.onCall(sessao(), { id: 'C8', status: 'offer' });
    assert.equal(emitidos.length, 0);
  });
});

describe('onCall: recusa automática', () => {
  it('★ com rejectAll, RECUSA, avisa o cliente e marca no payload', async () => {
    const { call, emitidos } = await manager();
    const recusadas: string[][] = [];
    const enviadas: string[][] = [];
    const live = sessao({
      config: {
        webhooks: [{ url: 'https://exemplo.test/hook' }],
        calls: { rejectAll: true, rejectMessage: 'Nao atendemos por chamada, escreva aqui.' },
      },
      sock: {
        rejectCall: async (id: string, from: string) => { recusadas.push([id, from]); },
        sendMessage: async (to: string, m: { text: string }) => { enviadas.push([to, m.text]); },
      },
    });
    await call.onCall(live, { id: 'C9', from: DE, status: 'offer', date: new Date(0) });

    assert.equal(recusadas.length, 1, 'tinha de recusar');
    assert.equal(recusadas[0]![0], 'C9');
    // A mensagem é o motivo de existir a recusa automática: recusar em silêncio
    // resolveria o incômodo do operador e deixaria o cliente onde estava.
    assert.equal(enviadas.length, 1, 'tinha de avisar o cliente');
    assert.match(String(enviadas[0]![1]), /escreva aqui/);
    assert.equal(emitidos[0]!.payload.rejectedByGateway, true,
      'o payload distingue "recusamos por regra" de "ninguém atendeu"');
  });

  it('sem rejectMessage, recusa em SILÊNCIO (não inventa texto)', async () => {
    const { call } = await manager();
    const enviadas: string[][] = [];
    const live = sessao({
      config: { webhooks: [{ url: 'https://x.test/h' }], calls: { rejectAll: true } },
      sock: {
        rejectCall: async () => {},
        sendMessage: async (to: string, m: { text: string }) => { enviadas.push([to, m.text]); },
      },
    });
    await call.onCall(live, { id: 'C10', from: DE, status: 'offer', date: new Date(0) });
    assert.equal(enviadas.length, 0);
  });

  it('★ falha na recusa NÃO engole o evento', async () => {
    // O registro da ligação vale mesmo quando a recusa não foi aceita: "o cliente
    // ligou" continua sendo verdade, e é o dado que faltava no histórico.
    const { call, emitidos } = await manager();
    const live = sessao({
      config: { webhooks: [{ url: 'https://x.test/h' }], calls: { rejectAll: true } },
      sock: {
        rejectCall: async () => { throw new Error('item-not-found'); },
        sendMessage: async () => {},
      },
    });
    await call.onCall(live, { id: 'C11', from: DE, status: 'offer', date: new Date(0) });
    assert.equal(emitidos.length, 1, 'o evento tem de sair mesmo com a recusa falhando');
    assert.equal(emitidos[0]!.payload.rejectedByGateway, false, 'e sem alegar que recusou');
  });

  it('★ falha ao AVISAR não engole o evento nem desfaz a recusa', async () => {
    // A recusa aconteceu; não conseguir mandar o aviso é degradação, não erro fatal.
    const { call, emitidos } = await manager();
    const live = sessao({
      config: {
        webhooks: [{ url: 'https://x.test/h' }],
        calls: { rejectAll: true, rejectMessage: 'aviso' },
      },
      sock: {
        rejectCall: async () => {},
        sendMessage: async () => { throw new Error('numero bloqueou o gateway'); },
      },
    });
    await call.onCall(live, { id: 'C12', from: DE, status: 'offer', date: new Date(0) });
    assert.equal(emitidos.length, 1);
    assert.equal(emitidos[0]!.payload.rejectedByGateway, true, 'a recusa valeu');
  });

  it('não recusa em status diferente de `offer`', async () => {
    // Recusar em `ringing`/`accept` seria tarde (a chamada já avançou) e o WhatsApp
    // responderia erro por estado inválido.
    const { call } = await manager();
    const recusadas: string[] = [];
    const live = sessao({
      config: { webhooks: [{ url: 'https://x.test/h' }], calls: { rejectAll: true } },
      sock: {
        rejectCall: async (i: string) => { recusadas.push(i); },
        sendMessage: async () => {},
      },
    });
    for (const status of ['ringing', 'accept', 'terminate']) {
      await call.onCall(live, { id: `C13-${status}`, from: DE, status, date: new Date(0) });
    }
    assert.equal(recusadas.length, 0);
  });

  it('sem rejectAll não recusa nada (o default é não interferir)', async () => {
    const { call } = await manager();
    const recusadas: string[] = [];
    const live = sessao({
      sock: {
        rejectCall: async (i: string) => { recusadas.push(i); },
        sendMessage: async () => {},
      },
    });
    await call.onCall(live, { id: 'C14', from: DE, status: 'offer', date: new Date(0) });
    assert.equal(recusadas.length, 0);
  });
});
