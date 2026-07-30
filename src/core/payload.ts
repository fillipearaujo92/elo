// src/core/payload.ts
//
// Monta os payloads dos eventos de webhook no formato WAHA.
//
// ESPECIFICACAO: backend/lib/wa-provider/waha-translate.js do sysled-chat-typescript.
// Os campos abaixo nao sao escolha estetica — cada um e lido por aquele arquivo:
//
//   payload.id          -> msgId (idempotencia da mensagem; UNIQUE evolution_msg_id)
//   payload.from        -> remetente; sufixo @g.us decide isGroup, @lid decide fromIsLid
//   payload.participant -> em grupo, quem falou (fallback: author)
//   payload.fromMe      -> mensagens proprias sao ignoradas no inbound
//   payload.body        -> texto/caption
//   payload.type        -> chat|image|video|audio|ptt|document|sticker|<system>
//   payload.notifyName  -> nome do contato (fallback: pushName)
//   payload.timestamp   -> epoch em SEGUNDOS
//   payload.media.url   -> URL de download; .mimetype e .filename
//   payload.ack         -> ack numerico (-1..4) no evento message.ack
//   payload.status      -> status da sessao no evento session.status

import type { WAMessage } from 'baileys';
import { senderPhoneOf } from './lid.js';
import {
  detectSource,
  extractBody,
  extractMediaMeta,
  serializeMsgId,
  toWahaChatId,
  wahaAckName,
  wahaTypeFromMessage,
  type WahaSessionStatus,
} from './waha-compat.js';

export interface MessagePayloadOptions {
  /** URL publica de download da midia, se houver. */
  mediaUrl?: string | null;
  /**
   * Telefone real do remetente, resolvido de um @lid pelo mapa/socket. Vence o que
   * estiver na key da mensagem — e o caminho que impede o LID de vazar como numero.
   */
  overridePhone?: string | null;
  /** Nome do contato quando a mensagem nao traz pushName (vem dos eventos de contato). */
  nameFallback?: string | null;
}

/** Payload do evento `message`. */
export function buildMessagePayload(
  msg: WAMessage,
  opts: MessagePayloadOptions = {},
): Record<string, unknown> {
  const key = msg.key ?? {};
  const remoteJid = key.remoteJid ?? '';
  const isGroup = remoteJid.endsWith('@g.us');
  const type = wahaTypeFromMessage(msg);
  const media = extractMediaMeta(msg);

  // ★ Telefone REAL do remetente, quando o Baileys o entrega em key.senderPn /
  // key.participantPn. Preferimos SEMPRE o telefone ao LID: o LID e um id oculto e,
  // se vazar como numero, o contato nasce com 14-15 digitos invalidos, sem nome, e
  // cada resposta abre conversa nova (bug do primeiro E2E no beta). Resolver aqui
  // evita depender do backend consultar /lids/{lid} depois.
  // overridePhone vence: e o telefone resolvido de um @lid pelo session-manager.
  const senderPhone = opts.overridePhone ?? senderPhoneOf(msg);

  // `from`: em grupo e o JID do GRUPO (o translate le p.from para o groupId e usa
  // p.participant para o remetente). Em 1:1 e o contato.
  const from = isGroup
    ? toWahaChatId(remoteJid)
    : senderPhone
      ? `${senderPhone}@c.us`
      : toWahaChatId(remoteJid); // sem telefone conhecido: mantem o @lid p/ o backend resolver

  // `participant`: so em grupo. Usa o telefone real quando disponivel; senao mantem
  // o @lid intacto (NUNCA normalizar um @lid para @c.us: destruiria o id oculto e o
  // backend perderia a chance de resolve-lo).
  const participant = isGroup
    ? senderPhone
      ? `${senderPhone}@c.us`
      : key.participant
        ? toWahaChatId(key.participant)
        : undefined
    : undefined;

  const payload: Record<string, unknown> = {
    id: serializeMsgId(key),
    timestamp: normalizeTimestamp(msg.messageTimestamp),
    from,
    fromMe: !!key.fromMe,
    body: extractBody(msg),
    type,
    // notifyName: o backend le este campo para o NOME do contato (waha-translate.js:55,
    // com fallback para pushName). Sem ele o contato fica so com o telefone.
    notifyName: msg.pushName ?? opts.nameFallback ?? null,
    hasMedia: !!media,
    // _data guarda o cru para depuracao; o translate le _data?.subtype em eventos
    // de sistema (waha-translate.js:30).
    _data: { subtype: null },
  };

  if (participant) payload.participant = participant;

  if (media) {
    payload.media = {
      // url null e caso previsto pelo backend (teste "media.url null (engine nao
      // baixou)"): messageType correto, mediaUrlRaw null.
      url: opts.mediaUrl ?? null,
      mimetype: media.mimetype,
      filename: media.filename,
    };
  }

  // ── ORIGEM do envio ('app' | 'web' | 'api') ───────────────────────────────
  // Equivalente ao `data.source` da Evolution. Permite ao operador distinguir uma
  // resposta dada pelo Sysled de uma dada pelo celular ou pelo WhatsApp Web.
  payload.source = detectSource(key.id, !!key.fromMe);

  // ── REPLY (mensagem citada) ───────────────────────────────────────────────
  // O contexto da citacao vive em contextInfo.stanzaId (id da mensagem citada) e
  // participant (autor dela). Expomos no formato do WAHA (quotedMsgId) e tambem
  // serializado, para o consumidor casar com o que gravou no envio.
  const quoted = extractQuoted(msg);
  if (quoted) {
    payload.quotedMsgId = quoted.stanzaId;
    payload.quotedParticipant = quoted.participant;
    payload.replyTo = quoted.stanzaId;
    payload._data = { ...(payload._data as object), quotedMsg: quoted.body };
  }

  // ── REACTION ──────────────────────────────────────────────────────────────
  // Uma reacao chega como mensagem com reactionMessage. NAO e conversa: quem
  // consome deve aplicar a reacao na mensagem alvo, nao criar bolha nova.
  const reaction = extractReaction(msg);
  if (reaction) {
    payload.reaction = reaction;
    // `type` explicito ajuda o consumidor a rotear sem inspecionar o cru.
    payload.type = 'reaction';
  }

  return payload;
}

/** Dados da mensagem citada (reply), quando houver. */
function extractQuoted(msg: WAMessage): {
  stanzaId: string;
  participant: string | null;
  body: string | null;
} | null {
  const c = msg.message;
  if (!c) return null;
  // contextInfo aparece dentro do tipo especifico da mensagem.
  const ctx =
    c.extendedTextMessage?.contextInfo ??
    c.imageMessage?.contextInfo ??
    c.videoMessage?.contextInfo ??
    c.audioMessage?.contextInfo ??
    c.documentMessage?.contextInfo ??
    c.stickerMessage?.contextInfo ??
    null;
  const stanzaId = ctx?.stanzaId;
  if (!stanzaId) return null;

  // Corpo da citada, quando o WhatsApp o inclui — o cliente usa para o preview.
  const q = ctx.quotedMessage;
  const body = q
    ? q.conversation ??
      q.extendedTextMessage?.text ??
      q.imageMessage?.caption ??
      q.videoMessage?.caption ??
      null
    : null;

  return {
    stanzaId,
    participant: ctx.participant ? toWahaChatId(ctx.participant) : null,
    body: body ?? null,
  };
}

/** Dados da reacao, quando a mensagem for uma reacao. */
function extractReaction(msg: WAMessage): {
  text: string;
  messageId: string;
  fromMe: boolean;
} | null {
  const r = msg.message?.reactionMessage;
  if (!r?.key?.id) return null;
  return {
    // String VAZIA e valida: significa remocao da reacao.
    text: r.text ?? '',
    messageId: r.key.id,
    fromMe: !!r.key.fromMe,
  };
}

/** Payload do evento `message.ack`. */
export function buildAckPayload(args: {
  msgId: string;
  chatId: string;
  ack: number;
  fromMe?: boolean;
}): Record<string, unknown> {
  return {
    // O id vai SERIALIZADO. applyAck() no backend (webhooks/waha.js:166) faz
    // split('_').pop() para casar tambem o id cru gravado no envio.
    id: args.msgId,
    from: toWahaChatId(args.chatId),
    fromMe: args.fromMe ?? true,
    ack: args.ack,
    ackName: wahaAckName(args.ack),
  };
}

/** Payload do evento `session.status`. */
export function buildSessionStatusPayload(
  session: string,
  status: WahaSessionStatus,
): Record<string, unknown> {
  // translateWahaEvent le p.status (com fallback para ev.status). O backend so
  // compara com 'WORKING' (webhooks/waha.js:82) para decidir connected.
  return { name: session, status };
}

/**
 * O Baileys entrega messageTimestamp como number OU Long (protobuf). O backend
 * espera epoch em segundos; um Long cru vira "[object Object]" no JSON.
 */
function normalizeTimestamp(ts: unknown): number | null {
  if (ts === null || ts === undefined) return null;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const n = Number(ts);
    return Number.isFinite(n) ? n : null;
  }
  // Long do protobufjs expoe toNumber().
  const maybeLong = ts as { toNumber?: () => number; low?: number };
  if (typeof maybeLong.toNumber === 'function') return maybeLong.toNumber();
  if (typeof maybeLong.low === 'number') return maybeLong.low;
  return null;
}
