// src/routes/presence.ts
//
// Presença e leitura: "digitando…", "gravando áudio…", online/offline, marcar como
// lida e consultar o "visto por último" do contato.
//
// ── Por que isto importa ───────────────────────────────────────────────────
// É o que separa um bot óbvio de um atendimento que parece humano. Sem presença,
// a mensagem do consultor aparece do nada; com ela, o contato vê "digitando…"
// antes — e a conversa fica natural.
//
// ── O que o WhatsApp NÃO garante (documentado, não escondido) ──────────────
// "Visto por último" só chega se o contato permitir nas configurações de
// privacidade dele. Quando ele bloqueia, o WhatsApp simplesmente não envia o
// dado — não há erro. Também é recíproco: quem esconde o próprio "visto por
// último" não vê o dos outros. Por isso a consulta devolve `available: false`
// em vez de fingir que a informação existe.

import { Boom } from '@hapi/boom';
import type { FastifyInstance } from 'fastify';
import type { SessionManager } from '../core/session-manager.js';
import { toBaileysJid } from '../core/waha-compat.js';

interface Deps {
  sessions: SessionManager;
}

/** Estados aceitos, no vocabulário do WhatsApp. */
const PRESENCAS = new Set(['available', 'unavailable', 'composing', 'recording', 'paused']);

export function registerPresenceRoutes(app: FastifyInstance, { sessions }: Deps): void {
  function alvo(body: { session?: string; chatId?: string } | undefined): {
    session: string;
    jid: string;
  } {
    const session = body?.session?.trim();
    const chatId = body?.chatId?.trim();
    if (!session) throw new Boom('session e obrigatorio', { statusCode: 400 });
    if (!chatId) throw new Boom('chatId e obrigatorio', { statusCode: 400 });
    return { session, jid: toBaileysJid(chatId) };
  }

  // POST /api/typing — atalho para "digitando…" / "gravando…".
  //
  // `duration` existe porque o WhatsApp EXPIRA o indicador sozinho depois de
  // poucos segundos: para o contato ver "digitando" durante uma resposta longa,
  // alguém tem de renovar. Fazemos isso aqui, em vez de exigir que o consumidor
  // fique chamando a rota em laço.
  app.post<{
    Body: {
      session?: string;
      chatId?: string;
      /** false encerra o indicador. Default true. */
      typing?: boolean;
      /** 'composing' (texto) ou 'recording' (áudio). Default composing. */
      kind?: 'composing' | 'recording';
      /** Manter o indicador por N ms (máx. 60s), renovando sozinho. */
      duration?: number;
    };
  }>('/api/typing', async (req) => {
    const { session, jid } = alvo(req.body);
    const sock = sessions.requireSocket(session);
    const ligado = req.body?.typing !== false;
    const kind = req.body?.kind === 'recording' ? 'recording' : 'composing';

    if (!ligado) {
      await sock.sendPresenceUpdate('paused', jid);
      return { success: true, typing: false };
    }

    await sock.sendPresenceUpdate(kind, jid);

    // Renovação: teto de 60s para uma chamada não prender um handler à toa.
    const dur = Math.min(Math.max(Number(req.body?.duration ?? 0) || 0, 0), 60_000);
    if (dur > 0) {
      // Não aguardamos o fim: a resposta volta na hora e o indicador segue vivo
      // em background. Prender a requisição por 60s desperdiçaria conexão.
      void (async () => {
        const fim = Date.now() + dur;
        while (Date.now() < fim) {
          // ~4s: abaixo da expiração do WhatsApp (~10s), com margem.
          await new Promise((r) => setTimeout(r, 4_000).unref?.());
          try {
            // A sessão pode cair no meio; parar em silêncio é o certo aqui.
            sessions.requireSocket(session);
            await sock.sendPresenceUpdate(kind, jid);
          } catch {
            return;
          }
        }
        await sock.sendPresenceUpdate('paused', jid).catch(() => {});
      })();
    }

    return { success: true, typing: true, kind, duration: dur || undefined };
  });

  // POST /api/presence — controle direto do estado, incluindo o global.
  //
  // Sem `chatId`, aplica-se à conta (aparecer online/offline). É o que permite
  // NÃO roubar as notificações do celular do operador: manter 'unavailable'
  // deixa o WhatsApp continuar notificando o aparelho dele.
  app.post<{
    Body: { session?: string; chatId?: string; presence?: string };
  }>('/api/presence', async (req) => {
    const session = req.body?.session?.trim();
    if (!session) throw new Boom('session e obrigatorio', { statusCode: 400 });
    const presence = String(req.body?.presence ?? '').trim();
    if (!PRESENCAS.has(presence)) {
      throw new Boom(
        `presence deve ser um de: ${[...PRESENCAS].join(', ')}`,
        { statusCode: 400 },
      );
    }
    const sock = sessions.requireSocket(session);
    const jid = req.body?.chatId?.trim() ? toBaileysJid(req.body.chatId.trim()) : undefined;
    await sock.sendPresenceUpdate(presence as never, jid);
    return { success: true, presence, chatId: jid ?? null };
  });

  // POST /api/markAsRead — marca como lida (os dois tiques AZUIS para o contato).
  //
  // Aceita uma lista de ids: marcar 20 mensagens de uma conversa é uma chamada,
  // não 20. Os ids podem vir serializados ou crus (com chatId).
  app.post<{
    Body: { session?: string; chatId?: string; messageIds?: string[]; messageId?: string };
  }>('/api/markAsRead', async (req) => {
    const { session, jid } = alvo(req.body);
    const sock = sessions.requireSocket(session);

    const ids = req.body?.messageIds ?? (req.body?.messageId ? [req.body.messageId] : []);
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Boom('messageIds e obrigatorio (lista de ids)', { statusCode: 400 });
    }

    // fromMe: false — só faz sentido marcar como lida a mensagem DO CONTATO.
    // Marcar a própria não produz efeito e confundiria quem lê o código.
    const keys = ids.map((id) => {
      const parts = String(id).split('_');
      const raw = parts.length >= 3 ? (parts[parts.length - 1] ?? '') : String(id);
      return { remoteJid: jid, id: raw, fromMe: false };
    });

    await sock.readMessages(keys as never);
    return { success: true, count: keys.length };
  });

  // GET /api/presence/{chatId} — "visto por último" e online do contato.
  //
  // Fluxo em dois passos, imposto pelo WhatsApp: primeiro assina-se a presença do
  // contato (`presenceSubscribe`), e o dado chega DEPOIS, num evento assíncrono.
  // Não há chamada síncrona que devolva o valor. Aqui assinamos e respondemos com
  // o último estado conhecido — o gateway acumula esses eventos.
  app.get<{
    Params: { chatId: string };
    Querystring: { session?: string };
  }>('/api/presence/:chatId', async (req, reply) => {
    const session = req.query?.session?.trim();
    if (!session) return reply.code(400).send({ message: 'session e obrigatorio' });
    const jid = toBaileysJid(req.params.chatId);
    const sock = sessions.requireSocket(session);

    // Assina para que os PRÓXIMOS eventos cheguem (e o cache se popule).
    await sock.presenceSubscribe(jid).catch(() => {});

    const conhecido = sessions.getPresence(session, jid);
    if (!conhecido) {
      return {
        chatId: jid,
        available: false,
        // Explica em vez de devolver um vazio ambíguo.
        note:
          'sem dado ainda: o WhatsApp entrega presenca de forma assincrona apos a ' +
          'assinatura, e SO se o contato permitir nas configuracoes de privacidade ' +
          '(quem esconde o proprio "visto por ultimo" tambem nao ve o dos outros). ' +
          'Consulte de novo em alguns segundos ou escute o evento presence.update.',
      };
    }
    return { chatId: jid, available: true, ...conhecido };
  });
}
