// tests/chamadas.test.ts
//
// Chamadas de voz/video.
//
// ── Por que estes testes existem ───────────────────────────────────────────
// Antes disto, uma chamada recebida SUMIA: o gateway nao emitia nada, e o sistema
// consumidor nao tinha como registrar "o cliente ligou as 14h32 e ninguem atendeu".
// Para um chat omnichannel isso e um buraco no historico do atendimento — a interacao
// aconteceu e nao existe em lugar nenhum.
//
// ── O limite do protocolo, travado em teste ───────────────────────────────
// O ELO NAO atende e NAO origina chamada, e isso nao e falta de implementacao: a midia
// e WebRTC ponta a ponta entre os APARELHOS, e a biblioteca implementa a sinalizacao,
// nao a pilha de midia. Ha um teste abaixo que falha se alguem tentar prometer o
// contrario na documentacao — promessa que o protocolo nao cumpre e pior que ausencia.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerCallRoutes } from '../dist/routes/calls.js';

function montaApp(sock: Record<string, unknown>): FastifyInstance {
  const app = Fastify();
  app.setErrorHandler((err: never, _q, reply) => {
    const e = err as unknown as {
      output?: { statusCode?: number }; statusCode?: number; message: string; data?: object;
    };
    reply.code(e.output?.statusCode ?? e.statusCode ?? 500).send({ message: e.message, ...(e.data ?? {}) });
  });
  registerCallRoutes(app, { sessions: { requireSocket: () => sock } as never });
  return app;
}

describe('chamadas: recusar', () => {
  it('recusa passando callId e destino ao WhatsApp', async () => {
    const chamadas: unknown[][] = [];
    const app = montaApp({
      rejectCall: async (id: string, from: string) => { chamadas.push([id, from]); },
    });
    const r = await app.inject({
      method: 'POST', url: '/api/calls/reject',
      payload: { session: 's', callId: 'CALL123', from: '5585999998888' },
    });
    assert.equal(r.statusCode, 200);
    assert.equal((r.json() as { rejected: boolean }).rejected, true);
    // O telefone tem de virar JID no caminho — mesmo tratamento do envio de mensagem.
    assert.deepEqual(chamadas[0], ['CALL123', '5585999998888@s.whatsapp.net']);
    await app.close();
  });

  it('★ chamada que ja terminou devolve 404 com a CAUSA, nao 500', async () => {
    // O caso mais comum desta rota, e nao e bug: chamadas duram poucos segundos, e
    // entre o webhook chegar ao consumidor e ele decidir recusar, ela pode ter
    // acabado. Dizer "erro interno" faria o integrador procurar defeito onde nao ha.
    const app = montaApp({
      rejectCall: async () => { throw new Error('item-not-found'); },
    });
    const r = await app.inject({
      method: 'POST', url: '/api/calls/reject',
      payload: { session: 's', callId: 'X', from: '5585999998888' },
    });
    assert.equal(r.statusCode, 404);
    const b = r.json() as { code: string; message: string };
    assert.equal(b.code, 'call_not_found');
    assert.match(b.message, /ja terminou|desligou/i, 'a mensagem tem de explicar o motivo provavel');
    await app.close();
  });

  it('exige callId E from (o protocolo nao deriva um do outro)', async () => {
    const app = montaApp({ rejectCall: async () => {} });
    const semId = await app.inject({
      method: 'POST', url: '/api/calls/reject', payload: { session: 's', from: '5585999998888' },
    });
    const semFrom = await app.inject({
      method: 'POST', url: '/api/calls/reject', payload: { session: 's', callId: 'X' },
    });
    assert.equal(semId.statusCode, 400);
    assert.equal(semFrom.statusCode, 400);
    // A mensagem diz DE ONDE vem o dado — o integrador nao adivinha que sai do webhook.
    assert.match((semId.json() as { message: string }).message, /webhook/i);
    await app.close();
  });

  it('sem session e 400', async () => {
    const app = montaApp({ rejectCall: async () => {} });
    const r = await app.inject({
      method: 'POST', url: '/api/calls/reject', payload: { callId: 'X', from: '5585999998888' },
    });
    assert.equal(r.statusCode, 400);
    await app.close();
  });
});

describe('chamadas: link', () => {
  it('gera link e devolve a URL PRONTA', async () => {
    // So o token obrigaria quem consome a saber montar a URL — conhecimento do
    // WhatsApp, nao do integrador.
    const app = montaApp({ createCallLink: async () => 'TOKEN123' });
    const r = await app.inject({
      method: 'POST', url: '/api/calls/link', payload: { session: 's', type: 'audio' },
    });
    assert.equal(r.statusCode, 200);
    const b = r.json() as { type: string; token: string; url: string };
    assert.equal(b.type, 'audio');
    assert.equal(b.token, 'TOKEN123');
    assert.match(b.url, /^https:\/\//, 'a URL tem de vir pronta para enviar');
    await app.close();
  });

  it('quando o WhatsApp ja devolve URL completa, nao duplica o prefixo', async () => {
    const app = montaApp({ createCallLink: async () => 'https://call.whatsapp.com/video/ABC' });
    const r = await app.inject({
      method: 'POST', url: '/api/calls/link', payload: { session: 's' },
    });
    assert.equal((r.json() as { url: string }).url, 'https://call.whatsapp.com/video/ABC');
    await app.close();
  });

  it('default e video; tipo invalido e 400', async () => {
    const app = montaApp({ createCallLink: async () => 'T' });
    const semTipo = await app.inject({
      method: 'POST', url: '/api/calls/link', payload: { session: 's' },
    });
    assert.equal((semTipo.json() as { type: string }).type, 'video');
    const ruim = await app.inject({
      method: 'POST', url: '/api/calls/link', payload: { session: 's', type: 'telepatia' },
    });
    assert.equal(ruim.statusCode, 400);
    await app.close();
  });

  it('link vazio do WhatsApp vira 502, nao 200 com url quebrada', async () => {
    // Responder 200 com uma URL invalida faria o consumidor enviar um link morto ao
    // cliente — falha silenciosa que so aparece do lado de quem recebe.
    const app = montaApp({ createCallLink: async () => undefined });
    const r = await app.inject({
      method: 'POST', url: '/api/calls/link', payload: { session: 's' },
    });
    assert.equal(r.statusCode, 502);
    assert.equal((r.json() as { code: string }).code, 'call_link_empty');
    await app.close();
  });
});

describe('chamadas: o limite do protocolo esta documentado', () => {
  const calls = readFileSync(new URL('../src/routes/calls.ts', import.meta.url), 'utf8');
  const manager = readFileSync(new URL('../src/core/session-manager.ts', import.meta.url), 'utf8');

  it('★ o codigo diz o que NAO da para fazer, e por que', () => {
    // A primeira pergunta de quem integra e "da para atender?". A resposta esta no
    // protocolo, nao no roadmap — e precisa estar escrita onde a pessoa procura.
    for (const [nome, texto] of [['routes/calls.ts', calls], ['session-manager.ts', manager]] as const) {
      assert.match(texto, /WebRTC/, `${nome}: falta explicar por que nao da para atender`);
      assert.match(texto, /sinaliza/i, `${nome}: falta a distincao sinalizacao x midia`);
    }
  });

  it('★ nenhuma rota promete atender ou originar chamada', () => {
    // Guarda contra otimismo futuro: se alguem adicionar `/api/calls/answer` porque
    // "parece que falta", este teste falha. O metodo nao existe na biblioteca —
    // verificado — e a rota so poderia mentir.
    assert.ok(!/\/api\/calls\/(answer|accept|dial|start)/.test(calls),
      'rota que promete atender/originar: o protocolo nao permite');
    // ★ Procura CHAMADA do metodo (`sock.acceptCall(`), nao mencao. O comentario do
    // arquivo cita esses nomes de proposito, para registrar que NAO existem — e a
    // primeira versao deste teste falhou no proprio texto que documenta o limite.
    // Verificar declaracao lendo prosa e o erro simetrico de verificar prosa lendo
    // declaracao; nos dois casos o teste mede a coisa errada.
    const semComentarios = calls
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\.\s*(acceptCall|offerCall|answerCall|endCall|hangupCall)\s*\(/.test(semComentarios),
      'metodo de atender/originar nao existe na biblioteca — nao pode ser chamado');
  });

  it('★ a recusa automatica so age no `offer`', () => {
    // Recusar em `ringing`/`accept` seria tarde (a chamada ja avancou) e o WhatsApp
    // responderia erro por estado invalido.
    //
    // ★ Casa a CONDICAO DO IF, nao a string solta no metodo. A primeira versao
    // procurava `status === 'offer'` em qualquer lugar do onCall — e sobreviveu a uma
    // mutacao que tirou a checagem do if, porque a mesma string aparece adiante no
    // `events.emit`. Teste que casa em lugar demais nao mede nada.
    const cond = manager.match(/if \(live\.config\?\.calls\?\.rejectAll[^)]*\)/)?.[0] ?? '';
    assert.ok(cond, 'condicao da recusa automatica nao encontrada');
    assert.match(cond, /status === 'offer'/,
      'a recusa automatica tem de checar o status NA PROPRIA condicao');
  });

  it('★ falhar a recusa NAO impede o evento de chegar ao consumidor', () => {
    // O registro da ligacao vale mesmo quando a recusa nao foi aceita: "o cliente
    // ligou" continua sendo verdade, e e o dado que falta no historico.
    //
    // ★ Verifica que o catch nao ABORTA o metodo, e nao apenas a ordem do codigo.
    // A primeira versao comparava a posicao do catch com a do emit — e sobreviveu a
    // uma mutacao que inseriu `return` DENTRO do catch: a ordem continuava a mesma e
    // o evento morria assim mesmo. Ordem no arquivo nao e fluxo de execucao.
    const onCall = manager.match(/private async onCall\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    assert.ok(onCall, 'onCall nao encontrado');
    const catchDaRecusa = onCall.match(/\} catch \(err\) \{[\s\S]*?falha ao recusar[\s\S]*?\n {6}\}/)?.[0] ?? '';
    assert.ok(catchDaRecusa, 'catch da recusa automatica nao encontrado');
    assert.ok(!/\breturn\b|\bthrow\b/.test(catchDaRecusa),
      'o catch da recusa nao pode interromper o metodo — o evento tem de sair mesmo assim');
  });

  it('o evento cobre o CICLO, nao so o inicio da chamada', () => {
    // "Ligaram" e menos util que "ligaram, ninguem atendeu, desligou em 12s".
    const onCall = manager.match(/private async onCall\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    assert.match(onCall, /status/, 'o status precisa ir no payload');
    assert.ok(!/if \(status !== 'offer'\) return/.test(onCall),
      'nao filtrar so o offer — o ciclo inteiro interessa');
  });

  it('o anel de idempotencia tem teto (Set sem limite vaza)', () => {
    // Gateway roda por meses; Set que so cresce e vazamento lento.
    const onCall = manager.match(/private async onCall\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    assert.match(onCall, /callsVistas\.size > \d+/, 'o anel precisa de teto');
    assert.match(manager, /private readonly callsVistas = new Set<string>\(\)/);
  });

  it('`offline` distingue evento represado de chamada acontecendo agora', () => {
    // Sem isto, um restart geraria "estao ligando" para chamadas de horas atras.
    const onCall = manager.match(/private async onCall\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    assert.match(onCall, /offline/, 'o payload precisa expor `offline`');
  });

  it('a mensagem de cortesia so sai quando a recusa foi AUTOMATICA', () => {
    // Explicar uma recusa que um humano fez seria mentir sobre quem decidiu.
    const cfg = manager.match(/calls\?: \{[\s\S]*?\};/)?.[0] ?? '';
    assert.match(cfg, /rejectAll/);
    assert.match(cfg, /rejectMessage/);
    const onCall = manager.match(/private async onCall\([\s\S]*?\n {2}\}/)?.[0] ?? '';
    const iRejectAll = onCall.indexOf('rejectAll');
    const iMsg = onCall.indexOf('rejectMessage');
    assert.ok(iRejectAll > -1 && iMsg > iRejectAll,
      'a mensagem tem de estar DENTRO do bloco da recusa automatica');
  });
});

describe('chamadas: a documentacao publica e honesta', () => {
  it('★ o OpenAPI declara o que o protocolo NAO permite', () => {
    // Quem le a spec decide se o ELO serve. Omitir o limite faria a pessoa integrar e
    // descobrir depois — que e o pior momento.
    const spec = readFileSync(new URL('../src/openapi.ts', import.meta.url), 'utf8');
    const tag = spec.match(/name: 'Calls',[\s\S]*?\},/)?.[0] ?? '';
    assert.ok(tag, 'a tag Calls nao esta na spec');
    assert.match(tag, /does NOT allow|answering/i, 'a spec tem de dizer que nao atende');
    assert.match(tag, /WebRTC/, 'e explicar o porque');
    // E apontar a alternativa real, em vez de deixar o integrador sem saida.
    assert.match(tag, /telephony|SIP|PSTN/i, 'a spec deve indicar o caminho para voz de verdade');
  });
});
