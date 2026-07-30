// src/core/lid.ts
//
// Extração do par LID → telefone das mensagens do Baileys. PURO (sem I/O).
//
// ── Por que este módulo existe ─────────────────────────────────────────────
// O WhatsApp passou a endereçar contatos por LID (@lid), um id OCULTO que não é o
// telefone. Se o LID vazar para o Sysled como se fosse número:
//   - o contato nasce com "+12455438745648" (14-15 dígitos, telefone inválido)
//   - o nome não é capturado
//   - cada resposta abre conversa NOVA, porque o "número" nunca casa com o contato
// Foi exatamente o que aconteceu no primeiro teste E2E no beta.
//
// ── Os campos CORRETOS (Baileys 7.x) ───────────────────────────────────────
// `WAMessageKey` (node_modules/baileys/lib/Types/Message.d.ts:19-26) estende o
// proto com:
//     remoteJidAlt?, participantAlt?, addressingMode?
//
// ★ `addressingMode` MANDA no significado do campo `Alt`
//   (node_modules/baileys/lib/Utils/decode-wa-message.js:74-88):
//     addressingMode === 'lid' → remoteJid é o LID,      Alt é o TELEFONE
//     addressingMode === 'pn'  → remoteJid é o TELEFONE,  Alt é o LID
//
// Ler o `Alt` cegamente como telefone gravaria um LID como número em metade dos
// casos — pior que não ter mapa, porque o backend receberia lixo que PARECE
// telefone e não teria como desconfiar.
//
// Nota histórica: as versões 6.7.x usavam `senderLid`/`senderPn`/
// `participantLid`/`participantPn`. Esses campos NÃO existem no proto da 7.x
// (`grep senderPn WAProto/index.d.ts` = 0). Continuamos aceitando-os como
// fallback: se estiverem presentes são explícitos e não custam nada, mas o
// caminho real hoje é o par (remoteJid|participant, *Alt) + addressingMode.

import type { WAMessage } from 'baileys';

export interface LidPair {
  lid: string;
  phone: string;
  pushName: string | null;
}

/** Shape da key que interessa aqui, cobrindo 6.7.x e 7.x. */
interface KeyLike {
  remoteJid?: string | null;
  participant?: string | null;
  /** 7.x */
  remoteJidAlt?: string | null;
  participantAlt?: string | null;
  addressingMode?: string | null;
  /** 6.7.x (não existem na 7.x; mantidos por compatibilidade) */
  senderLid?: string | null;
  senderPn?: string | null;
  participantLid?: string | null;
  participantPn?: string | null;
}

/** Extrai só os dígitos do telefone de um JID ("5585999:12@s.whatsapp.net" → "5585999"). */
export function phoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const local = String(jid).split('@')[0] ?? '';
  // Remove o sufixo de device do multi-device (":12").
  const digits = (local.split(':')[0] ?? '').replace(/\D/g, '');
  return digits || null;
}

export function isLid(jid: string | null | undefined): boolean {
  return !!jid && String(jid).endsWith('@lid');
}

/**
 * O valor parece um telefone de verdade?
 *
 * Não basta contar dígitos: LID tem 14-15, dentro da faixa do E.164, então uma
 * checagem de tamanho sozinha ACEITA um LID como número — e foi assim que o bug
 * original passou. Aqui exigimos, além do tamanho, que a origem não seja `@lid`.
 *
 * Telefone com país tem 10-15 dígitos (BR: 55 + DDD + 8/9 = 12 ou 13). Abaixo de
 * 10 é ramal/curto, que não endereça WhatsApp.
 */
export function looksLikePhone(jid: string | null | undefined): boolean {
  if (!jid || isLid(jid)) return false;
  const d = phoneFromJid(jid);
  return !!d && d.length >= 10 && d.length <= 15 && /^[1-9]/.test(d);
}

/**
 * Todos os pares (lid, telefone) que a mensagem revela. Pode devolver dois em
 * grupo (o do remetente e o do participante), ou vazio quando não há LID.
 */
export function extractLidPairs(msg: WAMessage): LidPair[] {
  const key = (msg?.key ?? {}) as KeyLike;
  const pushName = msg?.pushName ?? null;
  const out: LidPair[] = [];

  // Em 'lid' o Alt é o telefone; em 'pn' o Alt é o LID e o jid base é o telefone.
  // Quando o modo não vem, inferimos pelo sufixo do próprio jid (é o que a lib faz).
  const mode =
    key.addressingMode ??
    (isLid(key.participant ?? key.remoteJid) ? 'lid' : 'pn');
  const lidMode = mode === 'lid';

  // Cada candidato é um par (lado LID, lado telefone) JÁ desambiguado pelo modo.
  const candidates: Array<[string | null | undefined, string | null | undefined]> = lidMode
    ? [
        // 1:1 e grupo, 7.x: o jid base é o LID, o Alt é o telefone.
        [key.remoteJid, key.remoteJidAlt],
        [key.participant, key.participantAlt],
      ]
    : [
        // Modo 'pn': invertido — o Alt é o LID.
        [key.remoteJidAlt, key.remoteJid],
        [key.participantAlt, key.participant],
      ];

  // Fallback 6.7.x: campos explícitos, sem ambiguidade de modo.
  candidates.push(
    [key.senderLid, key.senderPn],
    [key.participantLid, key.participantPn],
  );

  for (const [lidRaw, pnRaw] of candidates) {
    if (!lidRaw || !pnRaw) continue;
    const lid = String(lidRaw);
    // O lado LID precisa SER um @lid, e o lado telefone precisa parecer telefone.
    // A segunda checagem é o que impede gravar LID como número no modo 'pn'.
    if (!isLid(lid)) continue;
    if (!looksLikePhone(pnRaw)) continue;
    const phone = phoneFromJid(pnRaw);
    if (!phone) continue;
    if (out.some((p) => p.lid === lid)) continue;
    out.push({ lid, phone, pushName });
  }

  return out;
}

/**
 * Telefone REAL do remetente, quando a mensagem já o carrega — evita ter de
 * consultar o mapa. É o caminho preferido: resolve na hora, sem depender de ter
 * "aprendido" o par antes.
 *
 * Em grupo devolve o telefone do PARTICIPANTE (quem falou), não o do grupo.
 */
export function senderPhoneOf(msg: WAMessage): string | null {
  const key = (msg?.key ?? {}) as KeyLike;
  const isGroup = !!key.remoteJid?.endsWith('@g.us');

  // Candidatos em ordem de confiança; `looksLikePhone` filtra o que for LID.
  const tries = isGroup
    ? [key.participantAlt, key.participant, key.participantPn]
    : [key.remoteJidAlt, key.remoteJid, key.senderPn];

  for (const t of tries) {
    if (looksLikePhone(t)) return phoneFromJid(t);
  }
  return null;
}
