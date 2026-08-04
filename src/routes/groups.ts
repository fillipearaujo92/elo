// src/routes/groups.ts
//
// Gestao de grupos: criar, listar, metadados, participantes, assunto/descricao,
// convite, configuracoes e sair.
//
// ── Por que este modulo existe ─────────────────────────────────────────────
// O Baileys ja entrega 19 metodos de grupo, e o ELO expunha ZERO deles: dava para
// RECEBER mensagem de grupo (e o assunto era resolvido internamente, em
// session-manager.groupSubjectOf) mas nao para administrar nada. Para um sistema de
// chat omnichannel isso e uma lacuna dura — "nao administra grupo" elimina o gateway
// numa comparacao de recursos antes de qualquer teste.
//
// ── Decisoes de contrato ───────────────────────────────────────────────────
// 1. `groupId` aceita as duas formas: o id cru ("120363...") ou o JID completo
//    ("120363...@g.us"). Quem consome guarda de um jeito ou de outro dependendo do
//    provider anterior, e exigir uma forma so seria atrito sem ganho.
//
// 2. Participante aceita telefone ("5585999998888") ou JID. Normalizamos com
//    `toBaileysJid`, o mesmo caminho do envio de mensagem — assim o formato aceito
//    aqui e o mesmo do resto da API.
//
// 3. Erro do WhatsApp NAO vira 500. Um `groupParticipantsUpdate` pode falhar por
//    regra do proprio WhatsApp (nao sou admin, o numero nao pode ser adicionado, o
//    grupo esta em modo restrito) — isso e 4xx com a causa, nao erro interno do
//    gateway. Ver `traduzErroGrupo`.
//
// 4. As acoes em lote devolvem o resultado POR PARTICIPANTE. O WhatsApp pode aceitar
//    3 de 5 numeros na mesma chamada, e responder "ok" esconderia as 2 falhas — o
//    operador veria o grupo sem as pessoas e sem explicacao.

import { Boom } from '@hapi/boom';
import type { FastifyInstance } from 'fastify';
import type { SessionManager } from '../core/session-manager.js';
import { toBaileysJid } from '../core/waha-compat.js';

interface Deps {
  sessions: SessionManager;
}

/** Acoes de participante que o WhatsApp aceita. */
const ACOES = new Set(['add', 'remove', 'promote', 'demote']);

/**
 * Teto de participantes por chamada.
 *
 * O limite do WhatsApp para grupo e da ordem de 1024 membros, mas cada participante
 * numa chamada de `groupParticipantsUpdate` e um nó no stanza: um lote gigante
 * aumenta a chance de o servidor recusar a stanza inteira (e ai NENHUM entra) e
 * prende o socket da sessao. 100 por chamada mantem o lote atomico e o socket livre.
 */
const MAX_PARTICIPANTES = 100;

/** Teto de caracteres do assunto, como o WhatsApp aceita. */
const MAX_ASSUNTO = 100;
/** Teto da descricao. */
const MAX_DESCRICAO = 2048;

/**
 * Normaliza o id do grupo para JID.
 *
 * Aceita "120363..." e "120363...@g.us". Rejeita JID de PESSOA (@c.us/@lid): passar
 * um contato onde se espera grupo faria o Baileys montar uma stanza que o WhatsApp
 * recusa com erro opaco — melhor dizer o que esta errado aqui.
 */
function jidDeGrupo(bruto: string | undefined): string {
  const v = (bruto ?? '').trim();
  if (!v) throw new Boom('informe o groupId', { statusCode: 400 });
  if (v.endsWith('@c.us') || v.endsWith('@s.whatsapp.net') || v.endsWith('@lid')) {
    throw new Boom('groupId aponta para um contato, nao para um grupo', { statusCode: 400 });
  }
  const id = v.endsWith('@g.us') ? v.slice(0, -'@g.us'.length) : v;
  // Id de grupo do WhatsApp e numerico (o de convite tem outro formato e nao entra aqui).
  if (!/^\d{5,}(-\d+)?$/.test(id)) {
    throw new Boom(`groupId invalido: ${v}`, { statusCode: 400 });
  }
  return `${id}@g.us`;
}

/** Normaliza a lista de participantes para JIDs. */
function jidsDeParticipantes(lista: unknown): string[] {
  if (!Array.isArray(lista) || lista.length === 0) {
    throw new Boom('informe participants como uma lista nao vazia', { statusCode: 400 });
  }
  if (lista.length > MAX_PARTICIPANTES) {
    throw new Boom(`no maximo ${MAX_PARTICIPANTES} participantes por chamada`, {
      statusCode: 400,
    });
  }
  return lista.map((p) => {
    const v = String(p ?? '').trim();
    if (!v) throw new Boom('participante vazio na lista', { statusCode: 400 });
    return toBaileysJid(v);
  });
}

/**
 * Traduz erro do WhatsApp/Baileys para status HTTP com causa legivel.
 *
 * ★ Sem isto, toda regra do WhatsApp virava 500 e o operador via "erro interno" para
 * situacoes perfeitamente normais: nao ser admin do grupo, tentar remover alguem que
 * ja saiu, ou mexer num grupo que so admins podem editar. 500 significa "o gateway
 * quebrou" — e nesses casos o gateway funcionou e o WhatsApp disse nao.
 */
function traduzErroGrupo(err: unknown): Boom {
  if (err instanceof Boom) return err;
  const msg = (err as Error)?.message ?? String(err);
  const m = msg.toLowerCase();

  // 403: o WhatsApp recusou por permissao.
  if (m.includes('forbidden') || m.includes('not-authorized') || m.includes('403')) {
    return new Boom(
      'o WhatsApp recusou: o numero conectado precisa ser ADMIN do grupo para esta acao',
      { statusCode: 403, data: { code: 'group_not_admin' } },
    );
  }
  // 404: grupo inexistente ou o numero nao participa mais.
  if (m.includes('item-not-found') || m.includes('not-found') || m.includes('404')) {
    return new Boom('grupo nao encontrado, ou o numero conectado nao participa dele', {
      statusCode: 404,
      data: { code: 'group_not_found' },
    });
  }
  // 409: estado que impede a acao (ja e membro, ja saiu).
  if (m.includes('conflict') || m.includes('409')) {
    return new Boom('o WhatsApp recusou por conflito de estado (ja e membro, ou ja saiu)', {
      statusCode: 409,
      data: { code: 'group_conflict' },
    });
  }
  // 408/timeout: o WhatsApp nao respondeu. Nao e erro nosso, e nao e permanente.
  if (m.includes('timed out') || m.includes('timeout')) {
    return new Boom('o WhatsApp nao respondeu em tempo; tente novamente', {
      statusCode: 504,
      data: { code: 'group_timeout' },
    });
  }
  return new Boom(`falha na operacao de grupo: ${msg}`, {
    statusCode: 502,
    data: { code: 'group_failed' },
  });
}

/** Shape de grupo devolvido pela API — estavel, independente do Baileys. */
function serializaGrupo(meta: {
  id: string;
  subject?: string;
  subjectOwner?: string;
  subjectTime?: number;
  desc?: string;
  owner?: string;
  creation?: number;
  size?: number;
  announce?: boolean;
  restrict?: boolean;
  isCommunity?: boolean;
  participants?: Array<{ id: string; admin?: string | null; lid?: string }>;
}): Record<string, unknown> {
  return {
    // `id` sem o sufixo: e a forma que o consumidor guarda e reenvia.
    id: meta.id.replace(/@g\.us$/, ''),
    jid: meta.id,
    subject: meta.subject ?? null,
    description: meta.desc ?? null,
    owner: meta.owner ? meta.owner.replace(/@s\.whatsapp\.net$/, '') : null,
    createdAt: meta.creation ? new Date(meta.creation * 1000).toISOString() : null,
    // `size` do Baileys pode vir ausente; a lista e a fonte confiavel.
    size: meta.participants?.length ?? meta.size ?? 0,
    // `announce` = so admins mandam mensagem. `restrict` = so admins editam o grupo.
    onlyAdminsCanPost: !!meta.announce,
    onlyAdminsCanEdit: !!meta.restrict,
    isCommunity: !!meta.isCommunity,
    participants: (meta.participants ?? []).map((p) => ({
      id: p.id.replace(/@s\.whatsapp\.net$/, ''),
      jid: p.id,
      // O Baileys usa 'admin' | 'superadmin' | null. Expor os dois separados evita o
      // consumidor ter de conhecer o vocabulario interno.
      isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
      isSuperAdmin: p.admin === 'superadmin',
    })),
  };
}

export function registerGroupRoutes(app: FastifyInstance, { sessions }: Deps): void {
  /** Sessao a partir do corpo ou da query, com a mesma mensagem em toda rota. */
  function sessaoDe(v: string | undefined): string {
    const s = (v ?? '').trim();
    if (!s) throw new Boom('informe session', { statusCode: 400 });
    return s;
  }

  // ── GET /api/groups — lista os grupos de que o numero participa ──────────
  //
  // `groupFetchAllParticipating` e uma chamada UNICA ao WhatsApp que devolve todos os
  // grupos com metadados. Nao pagina: o proprio WhatsApp entrega tudo de uma vez, e
  // fatiar aqui daria a impressao falsa de que existe paginacao no protocolo.
  app.get<{ Querystring: { session?: string } }>('/api/groups', async (req, reply) => {
    const session = sessaoDe(req.query?.session);
    const sock = sessions.requireSocket(session);
    try {
      const todos = await sock.groupFetchAllParticipating();
      const lista = Object.values(todos).map((g) => serializaGrupo(g as never));
      // Ordena por assunto para a listagem ser estavel entre chamadas (o WhatsApp nao
      // garante ordem, e uma lista que dança a cada refresh parece bug no painel).
      lista.sort((a, b) => String(a.subject ?? '').localeCompare(String(b.subject ?? '')));
      return lista;
    } catch (err) {
      throw traduzErroGrupo(err);
    }
  });

  // ── GET /api/groups/{groupId} — metadados de um grupo ────────────────────
  app.get<{ Params: { groupId: string }; Querystring: { session?: string } }>(
    '/api/groups/:groupId',
    async (req, reply) => {
      const session = sessaoDe(req.query?.session);
      const jid = jidDeGrupo(req.params.groupId);
      const sock = sessions.requireSocket(session);
      try {
        return serializaGrupo((await sock.groupMetadata(jid)) as never);
      } catch (err) {
        throw traduzErroGrupo(err);
      }
    },
  );

  // ── POST /api/groups — cria grupo ───────────────────────────────────────
  //
  // O WhatsApp exige ao menos um participante alem do proprio numero. Criar grupo
  // vazio nao existe no protocolo — devolvemos 400 em vez de deixar o Baileys falhar
  // com mensagem opaca.
  app.post<{ Body: { session?: string; subject?: string; participants?: unknown } }>(
    '/api/groups',
    async (req, reply) => {
      const session = sessaoDe(req.body?.session);
      const subject = (req.body?.subject ?? '').trim();
      if (!subject) throw new Boom('informe subject (o nome do grupo)', { statusCode: 400 });
      if (subject.length > MAX_ASSUNTO) {
        throw new Boom(`subject passa de ${MAX_ASSUNTO} caracteres`, { statusCode: 400 });
      }
      const participants = jidsDeParticipantes(req.body?.participants);
      const sock = sessions.requireSocket(session);
      try {
        const meta = await sock.groupCreate(subject, participants);
        return reply.code(201).send(serializaGrupo(meta as never));
      } catch (err) {
        throw traduzErroGrupo(err);
      }
    },
  );

  // ── POST /api/groups/{groupId}/participants — add/remove/promote/demote ──
  //
  // Uma rota para as quatro acoes, porque no protocolo e a MESMA operacao com um
  // campo diferente — separar em quatro rotas duplicaria validacao e daria a
  // impressao de que sao caminhos distintos.
  app.post<{
    Params: { groupId: string };
    Body: { session?: string; participants?: unknown; action?: string };
  }>('/api/groups/:groupId/participants', async (req, reply) => {
    const session = sessaoDe(req.body?.session);
    const jid = jidDeGrupo(req.params.groupId);
    const action = (req.body?.action ?? '').trim().toLowerCase();
    if (!ACOES.has(action)) {
      throw new Boom(`action deve ser uma de: ${[...ACOES].join(', ')}`, { statusCode: 400 });
    }
    const participants = jidsDeParticipantes(req.body?.participants);
    const sock = sessions.requireSocket(session);
    try {
      const res = await sock.groupParticipantsUpdate(
        jid,
        participants,
        action as 'add' | 'remove' | 'promote' | 'demote',
      );
      // ★ Resultado POR PARTICIPANTE. O WhatsApp aceita parcialmente (3 de 5), e
      // responder um "ok" agregado esconderia as falhas — o operador veria o grupo
      // sem as pessoas e sem explicacao do porque.
      const resultados = (res ?? []).map((r) => ({
        id: (r.jid ?? '').replace(/@s\.whatsapp\.net$/, ''),
        jid: r.jid ?? null,
        status: r.status,
        ok: String(r.status) === '200',
      }));
      const falhas = resultados.filter((r) => !r.ok);
      return {
        action,
        requested: participants.length,
        succeeded: resultados.length - falhas.length,
        failed: falhas.length,
        results: resultados,
      };
    } catch (err) {
      throw traduzErroGrupo(err);
    }
  });

  // ── PUT /api/groups/{groupId}/subject — renomeia ─────────────────────────
  app.put<{ Params: { groupId: string }; Body: { session?: string; subject?: string } }>(
    '/api/groups/:groupId/subject',
    async (req, reply) => {
      const session = sessaoDe(req.body?.session);
      const jid = jidDeGrupo(req.params.groupId);
      const subject = (req.body?.subject ?? '').trim();
      if (!subject) throw new Boom('informe subject', { statusCode: 400 });
      if (subject.length > MAX_ASSUNTO) {
        throw new Boom(`subject passa de ${MAX_ASSUNTO} caracteres`, { statusCode: 400 });
      }
      const sock = sessions.requireSocket(session);
      try {
        await sock.groupUpdateSubject(jid, subject);
        return { groupId: jid.replace(/@g\.us$/, ''), subject };
      } catch (err) {
        throw traduzErroGrupo(err);
      }
    },
  );

  // ── PUT /api/groups/{groupId}/description — muda a descricao ─────────────
  //
  // `description` ausente ou vazia APAGA a descricao (comportamento do Baileys, que
  // aceita `undefined`). Documentado porque nao e obvio: o natural seria 400.
  app.put<{ Params: { groupId: string }; Body: { session?: string; description?: string } }>(
    '/api/groups/:groupId/description',
    async (req, reply) => {
      const session = sessaoDe(req.body?.session);
      const jid = jidDeGrupo(req.params.groupId);
      const desc = req.body?.description;
      if (desc !== undefined && String(desc).length > MAX_DESCRICAO) {
        throw new Boom(`description passa de ${MAX_DESCRICAO} caracteres`, { statusCode: 400 });
      }
      const sock = sessions.requireSocket(session);
      try {
        const valor = desc === undefined || desc === '' ? undefined : String(desc);
        await sock.groupUpdateDescription(jid, valor);
        return { groupId: jid.replace(/@g\.us$/, ''), description: valor ?? null };
      } catch (err) {
        throw traduzErroGrupo(err);
      }
    },
  );

  // ── PUT /api/groups/{groupId}/settings — quem pode postar/editar ─────────
  //
  // Dois interruptores independentes, expostos com nome de intencao em vez do
  // vocabulario interno do WhatsApp ('announcement'/'locked'), que nao diz nada a
  // quem le a API pela primeira vez.
  app.put<{
    Params: { groupId: string };
    Body: {
      session?: string;
      onlyAdminsCanPost?: boolean;
      onlyAdminsCanEdit?: boolean;
      whoCanAddMembers?: 'admins' | 'all';
      joinApproval?: boolean;
    };
  }>('/api/groups/:groupId/settings', async (req, reply) => {
    const session = sessaoDe(req.body?.session);
    const jid = jidDeGrupo(req.params.groupId);
    const b = req.body ?? {};
    const sock = sessions.requireSocket(session);
    const aplicado: Record<string, unknown> = {};
    try {
      if (b.onlyAdminsCanPost !== undefined) {
        await sock.groupSettingUpdate(jid, b.onlyAdminsCanPost ? 'announcement' : 'not_announcement');
        aplicado.onlyAdminsCanPost = !!b.onlyAdminsCanPost;
      }
      if (b.onlyAdminsCanEdit !== undefined) {
        await sock.groupSettingUpdate(jid, b.onlyAdminsCanEdit ? 'locked' : 'unlocked');
        aplicado.onlyAdminsCanEdit = !!b.onlyAdminsCanEdit;
      }
      if (b.whoCanAddMembers !== undefined) {
        if (b.whoCanAddMembers !== 'admins' && b.whoCanAddMembers !== 'all') {
          throw new Boom("whoCanAddMembers deve ser 'admins' ou 'all'", { statusCode: 400 });
        }
        await sock.groupMemberAddMode(
          jid,
          b.whoCanAddMembers === 'admins' ? 'admin_add' : 'all_member_add',
        );
        aplicado.whoCanAddMembers = b.whoCanAddMembers;
      }
      if (b.joinApproval !== undefined) {
        await sock.groupJoinApprovalMode(jid, b.joinApproval ? 'on' : 'off');
        aplicado.joinApproval = !!b.joinApproval;
      }
      if (Object.keys(aplicado).length === 0) {
        throw new Boom('informe ao menos uma configuracao para alterar', { statusCode: 400 });
      }
      return { groupId: jid.replace(/@g\.us$/, ''), applied: aplicado };
    } catch (err) {
      throw traduzErroGrupo(err);
    }
  });

  // ── GET /api/groups/{groupId}/invite — link de convite ──────────────────
  app.get<{ Params: { groupId: string }; Querystring: { session?: string } }>(
    '/api/groups/:groupId/invite',
    async (req, reply) => {
      const session = sessaoDe(req.query?.session);
      const jid = jidDeGrupo(req.params.groupId);
      const sock = sessions.requireSocket(session);
      try {
        const code = await sock.groupInviteCode(jid);
        if (!code) {
          throw new Boom('o WhatsApp nao devolveu o codigo de convite', { statusCode: 502 });
        }
        return { groupId: jid.replace(/@g\.us$/, ''), code, url: `https://chat.whatsapp.com/${code}` };
      } catch (err) {
        throw traduzErroGrupo(err);
      }
    },
  );

  // ── POST /api/groups/{groupId}/invite/revoke — invalida o link atual ─────
  //
  // Devolve o codigo NOVO: revogar sem dizer qual passou a valer obrigaria uma
  // segunda chamada, e nesse intervalo o consumidor mostraria um link morto.
  app.post<{ Params: { groupId: string }; Body: { session?: string } }>(
    '/api/groups/:groupId/invite/revoke',
    async (req, reply) => {
      const session = sessaoDe(req.body?.session);
      const jid = jidDeGrupo(req.params.groupId);
      const sock = sessions.requireSocket(session);
      try {
        const code = await sock.groupRevokeInvite(jid);
        return {
          groupId: jid.replace(/@g\.us$/, ''),
          code: code ?? null,
          url: code ? `https://chat.whatsapp.com/${code}` : null,
        };
      } catch (err) {
        throw traduzErroGrupo(err);
      }
    },
  );

  // ── POST /api/groups/join — entra por codigo de convite ─────────────────
  //
  // Aceita o codigo ou a URL inteira: quem cola um convite tem a URL na mao, e
  // exigir que ele extraia o codigo e atrito sem motivo.
  app.post<{ Body: { session?: string; code?: string } }>(
    '/api/groups/join',
    async (req, reply) => {
      const session = sessaoDe(req.body?.session);
      const bruto = (req.body?.code ?? '').trim();
      if (!bruto) throw new Boom('informe code (ou a URL do convite)', { statusCode: 400 });
      const code = bruto.replace(/^https?:\/\/chat\.whatsapp\.com\//i, '').replace(/\/+$/, '');
      if (!/^[A-Za-z0-9_-]{6,}$/.test(code)) {
        throw new Boom('codigo de convite invalido', { statusCode: 400 });
      }
      const sock = sessions.requireSocket(session);
      try {
        const id = await sock.groupAcceptInvite(code);
        if (!id) throw new Boom('o WhatsApp nao confirmou a entrada no grupo', { statusCode: 502 });
        return reply.code(201).send({ groupId: String(id).replace(/@g\.us$/, ''), jid: id });
      } catch (err) {
        throw traduzErroGrupo(err);
      }
    },
  );

  // ── GET /api/groups/invite-info — inspeciona convite SEM entrar ─────────
  //
  // Serve para o consumidor mostrar "voce vai entrar no grupo X, com N membros"
  // antes de confirmar. Entrar para depois sair deixaria rastro no grupo.
  app.get<{ Querystring: { session?: string; code?: string } }>(
    '/api/groups/invite-info',
    async (req, reply) => {
      const session = sessaoDe(req.query?.session);
      const bruto = (req.query?.code ?? '').trim();
      if (!bruto) throw new Boom('informe code', { statusCode: 400 });
      const code = bruto.replace(/^https?:\/\/chat\.whatsapp\.com\//i, '').replace(/\/+$/, '');
      const sock = sessions.requireSocket(session);
      try {
        return serializaGrupo((await sock.groupGetInviteInfo(code)) as never);
      } catch (err) {
        throw traduzErroGrupo(err);
      }
    },
  );

  // ── POST /api/groups/{groupId}/leave — sai do grupo ─────────────────────
  //
  // ★ Sair NAO apaga o grupo nem o historico do lado do consumidor: o gateway so
  // deixa de participar. Documentado porque a expectativa costuma ser a oposta.
  app.post<{ Params: { groupId: string }; Body: { session?: string } }>(
    '/api/groups/:groupId/leave',
    async (req, reply) => {
      const session = sessaoDe(req.body?.session);
      const jid = jidDeGrupo(req.params.groupId);
      const sock = sessions.requireSocket(session);
      try {
        await sock.groupLeave(jid);
        return { groupId: jid.replace(/@g\.us$/, ''), left: true };
      } catch (err) {
        throw traduzErroGrupo(err);
      }
    },
  );

  // ── Pedidos de entrada (quando joinApproval esta ligado) ────────────────
  app.get<{ Params: { groupId: string }; Querystring: { session?: string } }>(
    '/api/groups/:groupId/join-requests',
    async (req, reply) => {
      const session = sessaoDe(req.query?.session);
      const jid = jidDeGrupo(req.params.groupId);
      const sock = sessions.requireSocket(session);
      try {
        const lista = await sock.groupRequestParticipantsList(jid);
        return (lista ?? []).map((r) => ({
          id: String(r.jid ?? '').replace(/@s\.whatsapp\.net$/, ''),
          jid: r.jid ?? null,
          requestedAt: r.request_time
            ? new Date(Number(r.request_time) * 1000).toISOString()
            : null,
        }));
      } catch (err) {
        throw traduzErroGrupo(err);
      }
    },
  );

  app.post<{
    Params: { groupId: string };
    Body: { session?: string; participants?: unknown; action?: string };
  }>('/api/groups/:groupId/join-requests', async (req, reply) => {
    const session = sessaoDe(req.body?.session);
    const jid = jidDeGrupo(req.params.groupId);
    const action = (req.body?.action ?? '').trim().toLowerCase();
    if (action !== 'approve' && action !== 'reject') {
      throw new Boom("action deve ser 'approve' ou 'reject'", { statusCode: 400 });
    }
    const participants = jidsDeParticipantes(req.body?.participants);
    const sock = sessions.requireSocket(session);
    try {
      const res = await sock.groupRequestParticipantsUpdate(jid, participants, action);
      const resultados = (res ?? []).map((r) => ({
        id: (r.jid ?? '').replace(/@s\.whatsapp\.net$/, ''),
        jid: r.jid ?? null,
        status: r.status,
        ok: String(r.status) === '200',
      }));
      return {
        action,
        requested: participants.length,
        succeeded: resultados.filter((r) => r.ok).length,
        failed: resultados.filter((r) => !r.ok).length,
        results: resultados,
      };
    } catch (err) {
      throw traduzErroGrupo(err);
    }
  });
}
