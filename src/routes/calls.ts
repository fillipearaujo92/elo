// src/routes/calls.ts
//
// Chamadas de voz/video: recusar e gerar link.
//
// ── O QUE O PROTOCOLO PERMITE, E O QUE NAO PERMITE ─────────────────────────
// Esta e a primeira pergunta de quem integra, e a resposta nao depende de esforco
// de implementacao — depende do protocolo:
//
//   DA PARA  saber que ligaram, acompanhar o ciclo (offer/ringing/accept/reject/
//            timeout/terminate), RECUSAR, e gerar link de chamada
//   NAO DA   atender, originar ou transportar audio/video
//
// A midia de uma chamada de WhatsApp e WebRTC negociado ponta a ponta entre os dois
// APARELHOS. A biblioteca implementa a SINALIZACAO (o canal de mensagens), nao a pilha
// de midia — `acceptCall`, `offerCall` e `endCall` nao existem nela. Um gateway que
// "atendesse" nao teria por onde a voz passar.
//
// Quem precisa de voz de verdade usa telefonia (SIP/PSTN), que e outro caminho e
// funciona. O ELO cobre o lado WhatsApp: ver, registrar e recusar.
//
// ── Como o consumidor descobre que houve chamada ───────────────────────────
// Pelo webhook `call` (ver core/session-manager.ts, onCall). Estas rotas sao a AÇÃO
// sobre uma chamada que o webhook ja anunciou — por isso `callId` e `from` vem de la.

import { Boom } from '@hapi/boom';
import type { FastifyInstance } from 'fastify';
import type { SessionManager } from '../core/session-manager.js';
import { toBaileysJid } from '../core/waha-compat.js';

interface Deps {
  sessions: SessionManager;
}

/** Tipos de link que o WhatsApp gera. */
const TIPOS_LINK = new Set(['audio', 'video']);

/**
 * Traduz erro do WhatsApp para status HTTP com causa legivel.
 *
 * ★ Mesma razao do modulo de grupos: sem isto, regra do WhatsApp virava 500, e 500
 * significa "o gateway quebrou". Aqui o caso mais comum e a chamada JA TER TERMINADO
 * quando a recusa chega — o cliente desligou, ou o tempo esgotou. Isso e corrida
 * normal, nao falha: entre o webhook chegar ao consumidor e ele decidir recusar,
 * passam-se segundos, e uma chamada dura poucos.
 */
function traduzErroChamada(err: unknown): Boom {
  if (err instanceof Boom) return err;
  const msg = (err as Error)?.message ?? String(err);
  const m = msg.toLowerCase();

  if (m.includes('item-not-found') || m.includes('not-found') || m.includes('404')) {
    return new Boom(
      'chamada nao encontrada — provavelmente ja terminou (o contato desligou, ou o tempo esgotou)',
      { statusCode: 404, data: { code: 'call_not_found' } },
    );
  }
  if (m.includes('forbidden') || m.includes('not-authorized')) {
    return new Boom('o WhatsApp recusou a operacao nesta chamada', {
      statusCode: 403,
      data: { code: 'call_forbidden' },
    });
  }
  if (m.includes('timed out') || m.includes('timeout')) {
    return new Boom('o WhatsApp nao respondeu em tempo', {
      statusCode: 504,
      data: { code: 'call_timeout' },
    });
  }
  return new Boom(`falha na operacao de chamada: ${msg}`, {
    statusCode: 502,
    data: { code: 'call_failed' },
  });
}

export function registerCallRoutes(app: FastifyInstance, { sessions }: Deps): void {
  function sessaoDe(v: string | undefined): string {
    const s = (v ?? '').trim();
    if (!s) throw new Boom('informe session', { statusCode: 400 });
    return s;
  }

  // ── POST /api/calls/reject — recusa uma chamada em andamento ────────────
  //
  // `callId` e `from` vem do webhook `call`. Os dois sao obrigatorios porque o
  // protocolo exige o par: o id identifica a chamada, e o `from` diz a quem
  // responder — o WhatsApp nao resolve um pelo outro.
  app.post<{ Body: { session?: string; callId?: string; from?: string } }>(
    '/api/calls/reject',
    async (req, reply) => {
      const session = sessaoDe(req.body?.session);
      const callId = (req.body?.callId ?? '').trim();
      const from = (req.body?.from ?? '').trim();
      if (!callId) throw new Boom('informe callId (vem do webhook `call`)', { statusCode: 400 });
      if (!from) {
        throw new Boom('informe from (o numero de quem ligou, do webhook `call`)', {
          statusCode: 400,
        });
      }

      const sock = sessions.requireSocket(session);
      try {
        // O `from` do webhook pode vir como telefone ou JID; normalizamos pelo mesmo
        // caminho do envio de mensagem, para o formato aceito ser um so em toda a API.
        await sock.rejectCall(callId, toBaileysJid(from));
        return { callId, rejected: true };
      } catch (err) {
        throw traduzErroChamada(err);
      }
    },
  );

  // ── POST /api/calls/link — gera um link de chamada ──────────────────────
  //
  // ★ E o mais proximo de "fazer uma ligacao" que o protocolo permite: o gateway
  // nao origina a chamada, mas cria um link que o contato ABRE no WhatsApp dele. O
  // fluxo pratico e mandar o link por mensagem — util para agendamento ("clique aqui
  // no horario combinado") sem precisar do numero do consultor.
  app.post<{ Body: { session?: string; type?: string } }>(
    '/api/calls/link',
    async (req, reply) => {
      const session = sessaoDe(req.body?.session);
      const type = (req.body?.type ?? 'video').trim().toLowerCase();
      if (!TIPOS_LINK.has(type)) {
        throw new Boom(`type deve ser ${[...TIPOS_LINK].join(' ou ')}`, { statusCode: 400 });
      }

      const sock = sessions.requireSocket(session);
      try {
        const link = await sock.createCallLink(type as 'audio' | 'video');
        if (!link) {
          throw new Boom('o WhatsApp nao devolveu o link de chamada', {
            statusCode: 502,
            data: { code: 'call_link_empty' },
          });
        }
        // Devolvemos `url` pronta: o token sozinho obrigaria quem consome a saber
        // montar a URL, que e conhecimento do WhatsApp e nao do integrador.
        const url = /^https?:\/\//i.test(link) ? link : `https://call.whatsapp.com/${type}/${link}`;
        return { type, token: link, url };
      } catch (err) {
        throw traduzErroChamada(err);
      }
    },
  );
}
