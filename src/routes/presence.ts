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

/**
 * Estados que o WhatsApp aceita SEM destino (aplicam-se à conta inteira).
 *
 * Os outros três são de conversa: o Baileys faz `jidDecode(toJid)` para montar o
 * nó `chatstate`, e com `toJid` undefined isso estoura
 * (`Cannot destructure property 'server' of undefined` — lib/Socket/chats.js:624),
 * devolvendo 500 em vez de dizer que falta o chatId.
 */
const PRESENCA_GLOBAL = new Set(['available', 'unavailable']);

/** Teto de ids por chamada de markAsRead. Ver o comentário na rota. */
const MAX_READ_IDS = 500;

/**
 * Laço de renovação de "digitando…" em andamento, por sessão+chat.
 *
 * ★ Sem este registro, cada chamada abria um laço NOVO. O padrão natural do
 * consumidor — chamar typing a cada poucos segundos enquanto gera uma resposta —
 * criava dezenas de laços concorrentes no mesmo chat: dezenas de closures no
 * heap, rajada de `chatstate` para o WhatsApp (risco de reputação do número), e
 * o pior: o primeiro laço a esgotar mandava `paused` e APAGAVA o indicador que
 * os outros ainda renovavam — o "digitando" morria no meio da resposta, que é
 * exatamente o que a funcionalidade existe para evitar.
 *
 * Agora uma chamada nova só ESTENDE o prazo do laço existente.
 */
const renovando = new Map<string, { fim: number }>();

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
      const chave = `${session}|${jid}`;
      const fim = Date.now() + dur;
      const emCurso = renovando.get(chave);
      if (emCurso) {
        // Já há laço para este chat: só estende o prazo. Abrir outro faria os dois
        // renovarem em paralelo e o primeiro a terminar mataria o indicador.
        emCurso.fim = Math.max(emCurso.fim, fim);
      } else {
        const estado = { fim };
        renovando.set(chave, estado);
        // Não aguardamos o fim: a resposta volta na hora e o indicador segue vivo
        // em background. Prender a requisição por 60s desperdiçaria conexão.
        void (async () => {
          try {
            while (Date.now() < estado.fim) {
              // ~4s: abaixo da expiração do WhatsApp (~10s), com margem.
              await new Promise((r) => setTimeout(r, 4_000).unref?.());
              // ★ RE-OBTÉM o socket a cada volta e usa ESTE, não o do closure.
              // Se a sessão reconectar no meio (restart, ou backoff após queda),
              // `live.sock` passa a ser outro objeto e escrever no antigo falha em
              // silêncio — a mesma classe de bug de "referência obsoleta" que já
              // custou caro neste projeto.
              const atual = sessions.requireSocket(session);
              await atual.sendPresenceUpdate(kind, jid);
            }
            const fimSock = sessions.requireSocket(session);
            await fimSock.sendPresenceUpdate('paused', jid);
          } catch {
            // Sessão caiu ou foi removida: parar em silêncio é o certo.
          } finally {
            renovando.delete(chave);
          }
        })();
      }
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
    const jid = req.body?.chatId?.trim() ? toBaileysJid(req.body.chatId.trim()) : undefined;
    // ★ 'composing'/'recording'/'paused' são de CONVERSA: sem chatId o Baileys
    // faz jidDecode(undefined) e estoura (chats.js:624), virando 500. Melhor um
    // 400 dizendo o que falta.
    if (!jid && !PRESENCA_GLOBAL.has(presence)) {
      throw new Boom(
        `presence "${presence}" exige chatId (so ${[...PRESENCA_GLOBAL].join('/')} valem para a conta inteira)`,
        { statusCode: 400 },
      );
    }
    const sock = sessions.requireSocket(session);
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
    // ★ Teto de ids. O readMessages do Baileys agrega por jid e monta UM nó
    // `receipt` com todos os itens num só frame (messages-send.js:102-116), sem
    // fatiar. Como aqui todas as keys compartilham o mesmo chat, 10 mil ids
    // gerariam um frame de centenas de KB — o WhatsApp derruba a conexão nesse
    // tamanho, e a queda afeta a SESSÃO INTEIRA, não só esta chamada.
    if (ids.length > MAX_READ_IDS) {
      throw new Boom(
        `no maximo ${MAX_READ_IDS} ids por chamada (recebidos ${ids.length})`,
        { statusCode: 400 },
      );
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
