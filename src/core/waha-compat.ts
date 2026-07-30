// src/core/waha-compat.ts
//
// Traducao PURA (sem rede/DB) Baileys -> shapes da API do WAHA.
//
// Este modulo e a especificacao de compatibilidade do gateway. O backend do Sysled
// consome estes shapes em backend/lib/wa-provider/waha-translate.js e
// backend/lib/wa-provider/waha-reconnect.js. Qualquer divergencia aqui quebra o
// consumidor em producao, entao cada decisao abaixo referencia o consumidor.
//
// Sem I/O de proposito: tudo aqui e testavel isolado (tests/waha-compat.test.ts).

import { DisconnectReason, getContentType, getDevice } from 'baileys';
import type { proto, WAMessage } from 'baileys';

// ── Status de sessao ────────────────────────────────────────────────────────
// O backend le `status` em connectionState() (waha.js:109) e a maquina de
// reconexao (waha-reconnect.js) faz decisoes por string exata. Estes 5 valores
// sao o vocabulario COMPLETO que ela entende:
//   WORKING       -> conectado (action: recovered)
//   STARTING      -> transiente, nunca alerta (action: idle)
//   SCAN_QR_CODE  -> logout, so humano resolve com QR (action: alert_qr)
//   FAILED        -> queda; com hasMe=true reconecta, com false vira alert_qr
//   STOPPED       -> parado manualmente; mesma logica de FAILED
export type WahaSessionStatus =
  | 'STOPPED'
  | 'STARTING'
  | 'SCAN_QR_CODE'
  | 'WORKING'
  | 'FAILED';

// ── ACK ────────────────────────────────────────────────────────────────────
// waha-translate.js:4 mapeia ACK_MAP = {0,1:'sent', 2:'delivered', 3,4:'read', -1:'failed'}.
// O Baileys entrega proto.WebMessageInfo.Status como enum:
//   ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5
// Precisamos converter para a ESCALA DO WAHA (nao repassar o numero do Baileys),
// senao PENDING(1) do Baileys viraria 'sent' por acidente e READ(4) viraria 'read'
// por coincidencia, mas SERVER_ACK(2) -> 'delivered' estaria ERRADO (server ack e
// apenas 'sent': o servidor recebeu, o destinatario nao).
const BAILEYS_STATUS_TO_WAHA_ACK: Record<number, number> = {
  0: -1, // ERROR        -> failed
  1: 0, //  PENDING      -> sent   (WAHA ack 0/1 = sent)
  2: 1, //  SERVER_ACK   -> sent   (servidor recebeu; NAO e delivered)
  3: 2, //  DELIVERY_ACK -> delivered
  4: 3, //  READ         -> read
  5: 3, //  PLAYED       -> read   (audio ouvido; backend nao tem estado 'played')
};

const WAHA_ACK_NAME: Record<number, string> = {
  [-1]: 'ERROR',
  0: 'PENDING',
  1: 'SERVER',
  2: 'DEVICE',
  3: 'READ',
  4: 'PLAYED',
};

/** Converte o status do Baileys para o ack numerico do WAHA (-1..4). */
export function baileysStatusToWahaAck(status: number | null | undefined): number {
  if (status === null || status === undefined) return 0;
  const mapped = BAILEYS_STATUS_TO_WAHA_ACK[status];
  return mapped === undefined ? 0 : mapped;
}

export function wahaAckName(ack: number): string {
  return WAHA_ACK_NAME[ack] ?? 'PENDING';
}

// ── Ids de mensagem ────────────────────────────────────────────────────────
// Ponto critico de integracao. Dois caminhos no backend precisam CASAR:
//
//  1. Envio: waha.js:extractMsgId() le a resposta do send. Ele aceita `id` string
//     direto (caminho GOWS), entao devolvemos o id SERIALIZADO como string.
//  2. ACK: applyAck() (webhooks/waha.js:166) recebe o id do evento e normaliza
//     fazendo split('_').pop() para tambem casar o id CRU.
//
// Logo, o formato serializado "<fromMe>_<chatId>_<rawId>" satisfaz os dois: o envio
// grava o serializado, o ack chega serializado e o split casa o cru como bonus.
// Emitir o id CRU no envio e o SERIALIZADO no ack tambem funcionaria (e o que o
// WAHA real faz), mas serializar nos dois e mais consistente e igualmente compativel.
export function serializeMsgId(key: {
  remoteJid?: string | null;
  id?: string | null;
  fromMe?: boolean | null;
}): string {
  const fromMe = key.fromMe ? 'true' : 'false';
  const chat = toWahaChatId(key.remoteJid ?? '');
  return `${fromMe}_${chat}_${key.id ?? ''}`;
}

// ── JIDs ───────────────────────────────────────────────────────────────────
// O Baileys fala @s.whatsapp.net; o WAHA (e o WhatsApp Web) fala @c.us. O backend
// espera @c.us: waha-translate.js:19 detecta @lid pelo sufixo e o resolveSendTarget
// (waha.js:35) monta `${digits}@c.us`. Grupos sao @g.us nos dois. @lid passa intacto
// porque e um id oculto que NAO pode ser reescrito (waha.js:26-27).
export function toWahaChatId(jid: string): string {
  if (!jid) return '';

  const [localRaw, domain] = splitJid(jid);
  // Remove o sufixo de device do multi-device ("5585999:12@s.whatsapp.net" e
  // "207919433941235:46@lid"). CRÍTICO para @lid também: sem isso a MESMA mensagem
  // gerava dois msgId distintos (um com :46, outro sem), quebrando a guarda de
  // idempotência do ack e o casamento do id no backend.
  const user = localRaw.split(':')[0] ?? '';

  if (KEEP_DOMAIN.has(domain)) return `${user}@${domain}`;
  return `${user}@c.us`;
}

/**
 * Domínios cujo id NÃO é telefone e portanto NÃO pode virar @c.us.
 *
 *  - `lid`        id oculto do contato; virar @c.us destruiria a identidade
 *  - `g.us`       grupo
 *  - `broadcast`  lista de transmissão (e status@broadcast)
 *  - `newsletter` canal/newsletter — id de 18 dígitos. Estava FALTANDO aqui, e o
 *                 id do canal chegava ao CRM como se fosse telefone (mesma classe
 *                 de dano do LID vazado). Canais são recebidos por padrão, então
 *                 o caminho estava aberto sem precisar de configuração nenhuma.
 */
const KEEP_DOMAIN = new Set(['lid', 'g.us', 'broadcast', 'newsletter']);

/** Divide um JID em [local, dominio]. */
function splitJid(jid: string): [string, string] {
  const at = jid.lastIndexOf('@');
  if (at < 0) return [jid, ''];
  return [jid.slice(0, at), jid.slice(at + 1)];
}

/** Converte um chatId do WAHA (@c.us) para o JID do Baileys (@s.whatsapp.net). */
export function toBaileysJid(chatId: string): string {
  if (!chatId) return '';
  const [localRaw, domain] = splitJid(chatId);
  const user = localRaw.split(':')[0] ?? '';
  // Mesma lista da ida: um @newsletter reescrito para @s.whatsapp.net seria
  // enviado para um JID inexistente.
  if (KEEP_DOMAIN.has(domain)) return `${user}@${domain}`;
  return `${user}@s.whatsapp.net`;
}

// ── Tipo de mensagem ───────────────────────────────────────────────────────
// waha-translate.js:33 mapeia payload.type para o message_type interno:
//   image|video|audio|ptt|document|sticker, e qualquer outro vira 'text'.
// 'ptt' e o que faz o audio virar voice note. As notificacoes de SISTEMA precisam
// cair na lista SYSTEM_TYPES do backend (waha-translate.js:25) para NAO virarem
// bolha em branco na conversa — por isso emitimos 'e2e_notification'/'protocol'/
// 'revoked'/'ciphertext' com esses nomes exatos.
export type WahaMessageType =
  | 'chat'
  | 'image'
  | 'video'
  | 'audio'
  | 'ptt'
  | 'document'
  | 'sticker'
  | 'location'
  | 'vcard'
  | 'e2e_notification'
  | 'notification_template'
  | 'gp2'
  | 'protocol'
  | 'revoked'
  | 'ciphertext'
  | 'reaction'
  | 'unknown';

export function wahaTypeFromMessage(msg: WAMessage): WahaMessageType {
  const content = msg.message;
  if (!content) return 'unknown';

  // Reação: NÃO é conversa. Precisa ser classificada aqui, senão cai em 'unknown'
  // e o messages.upsert a emite como MENSAGEM — o contato reagia e no Sysled
  // aparecia uma bolha junto com a reação (bug relatado). Quem trata reação é o
  // evento dedicado `messages.reaction` (ver onReaction no session-manager).
  if (content.reactionMessage) return 'reaction';

  // Mensagem apagada pelo remetente: o backend trata 'revoked' como sistema.
  if (content.protocolMessage) {
    const t = content.protocolMessage.type;
    // REVOKE = 0 no enum de protocolMessage
    if (t === 0 || String(t) === 'REVOKE') return 'revoked';
    return 'protocol';
  }
  if (content.senderKeyDistributionMessage && !hasUserContent(content)) return 'e2e_notification';

  const ct = getContentType(content);
  switch (ct) {
    case 'conversation':
    case 'extendedTextMessage':
      return 'chat';
    case 'imageMessage':
      return 'image';
    case 'videoMessage':
      // Video enviado como GIF continua sendo video para o backend.
      return 'video';
    case 'audioMessage':
      // ptt=true e voice note; senao e audio comum. Os dois viram message_type
      // 'audio' no backend, mas mantemos a distincao por fidelidade ao WAHA.
      return content.audioMessage?.ptt ? 'ptt' : 'audio';
    case 'documentMessage':
    case 'documentWithCaptionMessage':
      return 'document';
    case 'stickerMessage':
      return 'sticker';
    case 'locationMessage':
    case 'liveLocationMessage':
      return 'location';
    case 'contactMessage':
    case 'contactsArrayMessage':
      return 'vcard';
    default:
      return 'unknown';
  }
}

function hasUserContent(content: proto.IMessage): boolean {
  return !!(
    content.conversation ||
    content.extendedTextMessage ||
    content.imageMessage ||
    content.videoMessage ||
    content.audioMessage ||
    content.documentMessage ||
    content.stickerMessage
  );
}

// ── Corpo da mensagem ──────────────────────────────────────────────────────
// waha-translate.js usa `payload.body` como texto (e como caption quando ha midia).
export function extractBody(msg: WAMessage): string {
  const c = msg.message;
  if (!c) return '';
  return (
    c.conversation ||
    c.extendedTextMessage?.text ||
    c.imageMessage?.caption ||
    c.videoMessage?.caption ||
    c.documentMessage?.caption ||
    c.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    ''
  );
}

/** Metadados de midia (mimetype/filename) quando a mensagem carrega arquivo. */
export function extractMediaMeta(
  msg: WAMessage,
): { mimetype: string | null; filename: string | null } | null {
  const c = msg.message;
  if (!c) return null;
  const doc = c.documentMessage ?? c.documentWithCaptionMessage?.message?.documentMessage;
  const m =
    c.imageMessage ??
    c.videoMessage ??
    c.audioMessage ??
    doc ??
    c.stickerMessage ??
    null;
  if (!m) return null;
  return {
    mimetype: m.mimetype ?? null,
    filename: doc?.fileName ?? null,
  };
}

// ── Desconexao: logout vs transiente ───────────────────────────────────────
// A distincao mais importante para a resiliencia. waha-reconnect.js:49 decide:
//   hasMe === false  -> alert_qr (nunca auto-start; so humano com QR resolve)
//   hasMe === true   -> start com backoff (queda transiente)
// Se marcarmos logout como transiente, o gateway entra em loop gerando QR novo.
// Se marcarmos transiente como logout, o operador e incomodado sem necessidade.
export function isLogoutReason(statusCode: number | null | undefined): boolean {
  return (
    statusCode === DisconnectReason.loggedOut || // 401 — pareamento removido
    statusCode === DisconnectReason.forbidden || // 403 — conta banida/bloqueada
    statusCode === DisconnectReason.multideviceMismatch // 411 — precisa reparear
  );
}

/**
 * `restartRequired` (515) e o caso especial: acontece SEMPRE logo apos escanear o
 * QR pela primeira vez. Nao e falha — o socket precisa reabrir imediatamente, sem
 * backoff e sem contar tentativa, senao o pareamento novo nunca chega a WORKING.
 */
export function isImmediateRestart(statusCode: number | null | undefined): boolean {
  return statusCode === DisconnectReason.restartRequired;
}

// ── Origem do envio (app / WhatsApp Web / nosso gateway) ───────────────────
// A Evolution expoe isso como `data.source` ('web' | 'android' | 'ios') e o backend
// loga esse campo (webhooks/evolution.js:1173). Serve para o operador distinguir
// "eu respondi pelo Sysled" de "alguem respondeu pelo celular/WhatsApp Web" — sem
// isso, mensagens enviadas por fora aparecem sem origem identificada.
//
// O WhatsApp nao transmite a origem explicitamente; ela e DEDUZIDA do formato do id:
//   - 32 hex maiusculos           -> app mobile (android/ios), via getDevice do Baileys
//   - prefixo 3EB0 + hex          -> WhatsApp Web / Business (o Baileys tambem gera assim)
//   - 'BAE5' + hex                -> web (formato legado)
// getDevice() do Baileys cobre os casos que conhece; complementamos o resto.
export type MessageSource = 'app' | 'web' | 'api' | 'unknown';

export function detectSource(
  msgId: string | null | undefined,
  fromMe: boolean,
): MessageSource {
  if (!msgId) return 'unknown';
  const id = String(msgId);

  try {
    const device = getDevice(id);
    // 'android' | 'ios' = celular; 'web' = WhatsApp Web; 'desktop' = app desktop.
    if (device === 'android' || device === 'ios') return 'app';
    if (device === 'web' || device === 'desktop') return 'web';
  } catch {
    /* getDevice pode lancar em id malformado — cai na heuristica abaixo */
  }

  // Heuristica de formato, para o que o getDevice devolve 'unknown'.
  if (/^3EB0/i.test(id) || /^BAE5/i.test(id)) {
    // 3EB0 e o prefixo que o PROPRIO Baileys usa ao enviar. Numa mensagem nossa
    // (fromMe via API) isso significa "saiu daqui"; num eco pode ser WhatsApp Web.
    return fromMe ? 'api' : 'web';
  }
  if (/^[0-9A-F]{32}$/.test(id)) return 'app';

  return 'unknown';
}
