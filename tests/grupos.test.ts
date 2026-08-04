// tests/grupos.test.ts
//
// Gestao de grupos.
//
// ── Por que estes testes existem ───────────────────────────────────────────
// O Baileys entrega 19 metodos de grupo e o ELO expunha ZERO: dava para RECEBER
// mensagem de grupo, nao para administrar nada. Para um chat omnichannel isso elimina
// o gateway numa comparacao de recursos antes de qualquer teste tecnico.
//
// O socket e FALSO de proposito: o que se verifica aqui e o CONTRATO HTTP (validacao,
// status, shape, traducao de erro), nao a conversa com o WhatsApp. Falar com o WhatsApp
// de verdade exigiria um numero pareado e um grupo real — isso e verificacao de campo,
// nao teste automatizado.
//
// ★ O caso que mais importa e o PARCIAL: o WhatsApp aceita 3 de 5 participantes na
// mesma chamada, e responder um "ok" agregado esconderia as 2 falhas — o operador veria
// o grupo sem as pessoas e sem explicacao.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerGroupRoutes } from '../dist/routes/groups.js';

/** Socket falso: registra o que foi chamado e devolve shapes do Baileys. */
function sockFake(over: Record<string, unknown> = {}) {
  const chamadas: unknown[][] = [];
  const base = {
    chamadas,
    groupFetchAllParticipating: async () => ({
      '120363111@g.us': {
        id: '120363111@g.us', subject: 'Zebra', desc: 'uma descricao',
        owner: '5585999@s.whatsapp.net', creation: 1_700_000_000,
        announce: true, restrict: false,
        participants: [
          { id: '5585999@s.whatsapp.net', admin: 'superadmin' },
          { id: '5585888@s.whatsapp.net', admin: null },
        ],
      },
      '120363222@g.us': { id: '120363222@g.us', subject: 'Alfa', participants: [] },
    }),
    groupMetadata: async (jid: string) => {
      chamadas.push(['groupMetadata', jid]);
      return { id: jid, subject: 'Grupo X', participants: [{ id: '5585999@s.whatsapp.net', admin: 'admin' }] };
    },
    groupCreate: async (s: string, p: string[]) => {
      chamadas.push(['groupCreate', s, p]);
      return { id: '120363999@g.us', subject: s, participants: p.map((x) => ({ id: x, admin: null })) };
    },
    groupParticipantsUpdate: async (jid: string, parts: string[], action: string) => {
      chamadas.push(['participants', jid, parts, action]);
      // Primeiro entra, o resto toma 403 — o caso PARCIAL.
      return parts.map((j, i) => ({ jid: j, status: i === 0 ? '200' : '403', content: {} }));
    },
    groupUpdateSubject: async (jid: string, s: string) => { chamadas.push(['subject', jid, s]); },
    groupUpdateDescription: async (jid: string, d?: string) => { chamadas.push(['desc', jid, d]); },
    groupSettingUpdate: async (jid: string, v: string) => { chamadas.push(['setting', jid, v]); },
    groupMemberAddMode: async (jid: string, m: string) => { chamadas.push(['addMode', jid, m]); },
    groupJoinApprovalMode: async (jid: string, m: string) => { chamadas.push(['approval', jid, m]); },
    groupInviteCode: async (jid: string) => { chamadas.push(['invite', jid]); return 'ABC123xyz'; },
    groupRevokeInvite: async (jid: string) => { chamadas.push(['revoke', jid]); return 'NOVO456'; },
    groupAcceptInvite: async (c: string) => { chamadas.push(['join', c]); return '120363777@g.us'; },
    groupGetInviteInfo: async () => ({ id: '120363777@g.us', subject: 'Convite', participants: [] }),
    groupLeave: async (jid: string) => { chamadas.push(['leave', jid]); },
    groupRequestParticipantsList: async () => ([{ jid: '5585777@s.whatsapp.net', request_time: '1700000000' }]),
    groupRequestParticipantsUpdate: async (_j: string, p: string[]) => p.map((j) => ({ jid: j, status: '200' })),
  };
  return { ...base, ...over };
}

function montaApp(sock: Record<string, unknown>): FastifyInstance {
  const app = Fastify();
  // Mesmo tratamento de erro do server.ts: Boom carrega o status e o `data`.
  app.setErrorHandler((err: never, _q, reply) => {
    const e = err as unknown as { output?: { statusCode?: number }; statusCode?: number; message: string; data?: object };
    reply.code(e.output?.statusCode ?? e.statusCode ?? 500).send({ message: e.message, ...(e.data ?? {}) });
  });
  registerGroupRoutes(app, { sessions: { requireSocket: () => sock } as never });
  return app;
}

describe('grupos: leitura', () => {
  it('lista os grupos em ordem ESTAVEL (o WhatsApp nao garante ordem)', async () => {
    // Lista que dança a cada refresh parece bug no painel de quem consome.
    const app = montaApp(sockFake());
    const r = await app.inject({ method: 'GET', url: '/api/groups?session=s' });
    assert.equal(r.statusCode, 200);
    const lista = r.json() as Array<{ subject: string }>;
    assert.deepEqual(lista.map((g) => g.subject), ['Alfa', 'Zebra']);
    await app.close();
  });

  it('o shape nao expoe o vocabulario interno do Baileys', async () => {
    // `announce`/`restrict` nao dizem nada a quem le a API pela primeira vez; e
    // 'admin'|'superadmin'|null obrigaria o consumidor a conhecer os tres valores.
    const app = montaApp(sockFake());
    const g = (await app.inject({ method: 'GET', url: '/api/groups?session=s' })).json() as Array<Record<string, unknown>>;
    const zebra = g.find((x) => x.subject === 'Zebra')!;
    assert.equal(zebra.id, '120363111', 'id vem SEM o sufixo @g.us');
    assert.equal(zebra.jid, '120363111@g.us', 'e o jid completo tambem, para quem preferir');
    assert.equal(zebra.onlyAdminsCanPost, true, 'announce traduzido');
    assert.equal(zebra.onlyAdminsCanEdit, false, 'restrict traduzido');
    assert.equal(zebra.size, 2, 'size vem da LISTA, nao do campo (que pode faltar)');
    const parts = zebra.participants as Array<Record<string, unknown>>;
    assert.equal(parts[0]!.isAdmin, true);
    assert.equal(parts[0]!.isSuperAdmin, true, 'superadmin marca os dois');
    assert.equal(parts[1]!.isAdmin, false);
    assert.ok(!('admin' in parts[0]!), 'o campo cru do Baileys nao vaza');
    await app.close();
  });

  it('aceita groupId com e SEM o sufixo @g.us', async () => {
    // Quem consome guarda de um jeito ou de outro dependendo do provider anterior.
    const sock = sockFake();
    const app = montaApp(sock);
    for (const id of ['120363111', '120363111@g.us']) {
      const r = await app.inject({ method: 'GET', url: `/api/groups/${encodeURIComponent(id)}?session=s` });
      assert.equal(r.statusCode, 200, `falhou para ${id}`);
    }
    // As duas formas chegam ao Baileys como JID.
    const jids = (sock.chamadas as unknown[][]).filter((c) => c[0] === 'groupMetadata').map((c) => c[1]);
    assert.deepEqual(jids, ['120363111@g.us', '120363111@g.us']);
    await app.close();
  });
});

describe('grupos: escrita', () => {
  it('cria grupo e devolve 201', async () => {
    const sock = sockFake();
    const app = montaApp(sock);
    const r = await app.inject({
      method: 'POST', url: '/api/groups',
      payload: { session: 's', subject: 'Novo', participants: ['5585999998888'] },
    });
    assert.equal(r.statusCode, 201);
    assert.equal((r.json() as { subject: string }).subject, 'Novo');
    // Telefone virou JID no caminho.
    const c = (sock.chamadas as unknown[][]).find((x) => x[0] === 'groupCreate')!;
    assert.deepEqual(c[2], ['5585999998888@s.whatsapp.net']);
    await app.close();
  });

  it('★ resultado POR PARTICIPANTE quando o WhatsApp aceita parcialmente', async () => {
    // O ponto central: 1 entrou, 1 tomou 403. Um "ok" agregado esconderia a falha.
    const app = montaApp(sockFake());
    const r = await app.inject({
      method: 'POST', url: '/api/groups/120363111/participants',
      payload: { session: 's', action: 'add', participants: ['5585999998888', '5585777776666'] },
    });
    assert.equal(r.statusCode, 200);
    const b = r.json() as { requested: number; succeeded: number; failed: number; results: Array<{ ok: boolean; status: string }> };
    assert.equal(b.requested, 2);
    assert.equal(b.succeeded, 1);
    assert.equal(b.failed, 1);
    assert.equal(b.results[0]!.ok, true);
    assert.equal(b.results[1]!.ok, false);
    assert.equal(b.results[1]!.status, '403', 'o status cru do WhatsApp fica visivel');
    await app.close();
  });

  it('as quatro acoes de participante chegam ao Baileys como estao', async () => {
    const sock = sockFake();
    const app = montaApp(sock);
    for (const action of ['add', 'remove', 'promote', 'demote']) {
      const r = await app.inject({
        method: 'POST', url: '/api/groups/120363111/participants',
        payload: { session: 's', action, participants: ['5585999998888'] },
      });
      assert.equal(r.statusCode, 200, `falhou para ${action}`);
    }
    const acoes = (sock.chamadas as unknown[][]).filter((c) => c[0] === 'participants').map((c) => c[3]);
    assert.deepEqual(acoes, ['add', 'remove', 'promote', 'demote']);
    await app.close();
  });

  it('settings traduz intencao para o vocabulario do WhatsApp', async () => {
    const sock = sockFake();
    const app = montaApp(sock);
    const r = await app.inject({
      method: 'PUT', url: '/api/groups/120363111/settings',
      payload: { session: 's', onlyAdminsCanPost: true, onlyAdminsCanEdit: false, whoCanAddMembers: 'admins', joinApproval: true },
    });
    assert.equal(r.statusCode, 200);
    const ch = sock.chamadas as unknown[][];
    assert.ok(ch.some((c) => c[0] === 'setting' && c[2] === 'announcement'), 'onlyAdminsCanPost -> announcement');
    assert.ok(ch.some((c) => c[0] === 'setting' && c[2] === 'unlocked'), 'onlyAdminsCanEdit:false -> unlocked');
    assert.ok(ch.some((c) => c[0] === 'addMode' && c[2] === 'admin_add'), 'admins -> admin_add');
    assert.ok(ch.some((c) => c[0] === 'approval' && c[2] === 'on'), 'joinApproval -> on');
    await app.close();
  });

  it('descricao vazia APAGA (passa undefined ao Baileys)', async () => {
    // Nao e obvio: o natural seria 400. Documentado no codigo e travado aqui.
    const sock = sockFake();
    const app = montaApp(sock);
    const r = await app.inject({
      method: 'PUT', url: '/api/groups/120363111/description',
      payload: { session: 's', description: '' },
    });
    assert.equal(r.statusCode, 200);
    assert.equal((r.json() as { description: unknown }).description, null);
    const c = (sock.chamadas as unknown[][]).find((x) => x[0] === 'desc')!;
    assert.equal(c[2], undefined, 'string vazia tem de virar undefined');
    await app.close();
  });

  it('revogar convite devolve o codigo NOVO', async () => {
    // Sem isso o consumidor mostraria um link morto ate fazer a segunda chamada.
    const app = montaApp(sockFake());
    const r = await app.inject({
      method: 'POST', url: '/api/groups/120363111/invite/revoke', payload: { session: 's' },
    });
    const b = r.json() as { code: string; url: string };
    assert.equal(b.code, 'NOVO456');
    assert.equal(b.url, 'https://chat.whatsapp.com/NOVO456');
    await app.close();
  });

  it('entrar por convite aceita a URL inteira, nao so o codigo', async () => {
    // Quem cola um convite tem a URL na mao.
    const sock = sockFake();
    const app = montaApp(sock);
    const r = await app.inject({
      method: 'POST', url: '/api/groups/join',
      payload: { session: 's', code: 'https://chat.whatsapp.com/ABC123xyz' },
    });
    assert.equal(r.statusCode, 201);
    const c = (sock.chamadas as unknown[][]).find((x) => x[0] === 'join')!;
    assert.equal(c[1], 'ABC123xyz', 'a URL tem de ser reduzida ao codigo');
    await app.close();
  });
});

describe('grupos: validacao (recusa ANTES de falar com o WhatsApp)', () => {
  const casos: Array<[string, 'GET' | 'POST' | 'PUT', string, object | undefined]> = [
    ['sem session', 'GET', '/api/groups', undefined],
    ['groupId de PESSOA (@c.us)', 'GET', '/api/groups/5585999998888%40c.us?session=s', undefined],
    ['groupId de LID', 'GET', '/api/groups/80131355848789%40lid?session=s', undefined],
    ['groupId nao numerico', 'GET', '/api/groups/abc?session=s', undefined],
    ['criar sem subject', 'POST', '/api/groups', { session: 's', participants: ['5585999998888'] }],
    ['criar sem participante', 'POST', '/api/groups', { session: 's', subject: 'X', participants: [] }],
    ['action invalida', 'POST', '/api/groups/120363111/participants', { session: 's', action: 'kick', participants: ['5585999998888'] }],
    ['assunto acima de 100', 'PUT', '/api/groups/120363111/subject', { session: 's', subject: 'x'.repeat(101) }],
    ['settings sem nenhum campo', 'PUT', '/api/groups/120363111/settings', { session: 's' }],
    ['codigo de convite invalido', 'POST', '/api/groups/join', { session: 's', code: '!!' }],
  ];

  for (const [nome, method, url, payload] of casos) {
    it(`recusa: ${nome}`, async () => {
      const app = montaApp(sockFake());
      const r = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      assert.ok(r.statusCode >= 400 && r.statusCode < 500,
        `esperado 4xx, veio ${r.statusCode}: ${r.body.slice(0, 120)}`);
      await app.close();
    });
  }

  it('★ groupId de contato e recusado com a CAUSA, nao com erro opaco', async () => {
    // Passar um contato onde se espera grupo faria o Baileys montar stanza que o
    // WhatsApp recusa com erro ilegivel. Melhor dizer o que esta errado aqui.
    const app = montaApp(sockFake());
    const r = await app.inject({ method: 'GET', url: '/api/groups/5585999998888%40c.us?session=s' });
    assert.match((r.json() as { message: string }).message, /contato/i);
    await app.close();
  });

  it('teto de participantes por chamada', async () => {
    // Lote gigante aumenta a chance de o WhatsApp recusar a stanza INTEIRA (e ai
    // nenhum entra) e prende o socket da sessao.
    const app = montaApp(sockFake());
    const muitos = Array.from({ length: 101 }, (_, i) => `55859999${String(i).padStart(4, '0')}`);
    const r = await app.inject({
      method: 'POST', url: '/api/groups/120363111/participants',
      payload: { session: 's', action: 'add', participants: muitos },
    });
    assert.equal(r.statusCode, 400);
    assert.match((r.json() as { message: string }).message, /100/);
    await app.close();
  });
});

describe('grupos: erro do WhatsApp NAO vira 500', () => {
  // ★ Sem a traducao, toda regra do WhatsApp aparecia como "erro interno" — e 500
  // significa "o gateway quebrou". Nestes casos o gateway funcionou e o WhatsApp
  // disse nao, o que e informacao acionavel para quem opera.
  const mapa: Array<[string, number, string]> = [
    ['forbidden', 403, 'group_not_admin'],
    ['not-authorized', 403, 'group_not_admin'],
    ['item-not-found', 404, 'group_not_found'],
    ['conflict', 409, 'group_conflict'],
    ['Timed Out', 504, 'group_timeout'],
    ['algo inesperado', 502, 'group_failed'],
  ];

  for (const [erroDoWhats, status, code] of mapa) {
    it(`"${erroDoWhats}" -> HTTP ${status} (${code})`, async () => {
      const app = montaApp(sockFake({
        groupMetadata: async () => { throw new Error(erroDoWhats); },
      }));
      const r = await app.inject({ method: 'GET', url: '/api/groups/120363111?session=s' });
      assert.equal(r.statusCode, status);
      assert.equal((r.json() as { code: string }).code, code);
      await app.close();
    });
  }

  it('a mensagem de 403 diz O QUE FAZER, nao so que falhou', async () => {
    const app = montaApp(sockFake({ groupMetadata: async () => { throw new Error('forbidden'); } }));
    const r = await app.inject({ method: 'GET', url: '/api/groups/120363111?session=s' });
    assert.match((r.json() as { message: string }).message, /ADMIN/,
      'a mensagem precisa dizer que o numero tem de ser admin');
    await app.close();
  });
});
