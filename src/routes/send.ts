// src/routes/send.ts
//
// Endpoints de envio no formato WAHA: sendText, sendImage, sendVoice, sendVideo, sendFile.
//
// Contrato do retorno: wa-provider/waha.js:extractMsgId() aceita `id` como STRING
// direto (caminho GOWS) — devolvemos o id serializado como string em `id`, e o driver
// considera ok apenas quando ha id (`ok: res.ok && id`). Retornar 200 sem id faz o
// backend marcar a mensagem como falha.

import { Boom } from '@hapi/boom';
import type { AnyMessageContent } from 'baileys';
import type { FastifyInstance } from 'fastify';
import { serializeMsgId, toBaileysJid } from '../core/waha-compat.js';

import type { SessionManager } from '../core/session-manager.js';

interface Deps {
  sessions: SessionManager;
}

interface FilePayload {
  url?: string;
  data?: string; // base64
  mimetype?: string;
  filename?: string;
}

/**
 * Teto de tamanho de arquivo (64MB, alinhado ao bodyLimit do Fastify).
 *
 * O bodyLimit protege o CORPO do POST, não o `fetch` de saída de `file.url`. Sem
 * teto aqui, uma URL apontando para um arquivo de GBs alocava tudo no heap e
 * derrubava o container — junto com TODAS as sessões WhatsApp, não só o envio.
 * O AbortSignal.timeout limita tempo, não bytes.
 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Máximo de arquivos por chamada de /sendMedia.
 *
 * Cada item é um upload; os envios são serializados para preservar a ordem, então
 * uma chamada gigante seguraria o socket da sessão por minutos e atrasaria todas
 * as outras mensagens dela. 30 cobre com folga o uso real (o WhatsApp mostra no
 * máximo 10 por álbum) sem virar arma de bloqueio.
 */
const MAX_MEDIA_ITEMS = 30;

/**
 * Lê o corpo da resposta contando bytes e abortando ao passar do teto.
 *
 * `content-length` pode faltar (chunked) ou mentir, então não dá para confiar só
 * nele: aqui a contagem é real, e a leitura para no primeiro byte além do limite
 * em vez de bufferizar o arquivo inteiro para só depois reclamar.
 */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Boom(`file.url passou de ${max / 1048576}MB`, { statusCode: 413 });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

interface SendBody {
  session?: string;
  chatId?: string;
  text?: string;
  caption?: string;
  file?: FilePayload;
  /**
   * Vários arquivos na MESMA chamada (alternativa a `file`).
   *
   * Existe para quem já integra com /sendImage e /sendFile não precisar trocar de
   * rota só para mandar 3 fotos: `files: [...]` é atendido pelo mesmo caminho do
   * /sendMedia (envio em série, ordem preservada). Cada item pode ter `caption`
   * própria; sem ela, vale a `caption` da chamada no primeiro item.
   */
  files?: Array<{ url?: string; data?: string; mimetype?: string; filename?: string; caption?: string }>;
  /** Agrupa imagens/vídeos numa única bolha (recurso nativo do WhatsApp). */
  album?: boolean;
  /**
   * Id da mensagem citada (reply). Aceita o id SERIALIZADO
   * ("<fromMe>_<chat>_<raw>") ou o cru — o Baileys precisa da key completa, que
   * reconstruimos a partir dele (ver buildQuoted).
   */
  reply_to?: string;
}

/**
 * Reconstroi o `quoted` que o Baileys exige para citar uma mensagem.
 *
 * O Baileys precisa de { key, message } — a key completa da mensagem citada. Como o
 * consumidor so guarda o ID, reconstruimos a key a partir do id serializado. O corpo
 * (`message`) e opcional para o envio funcionar: o WhatsApp resolve a citacao pelo id;
 * sem o corpo o cliente do destinatario mostra a bolha citada com texto vazio, entao
 * enviamos um placeholder minimo quando nao temos o original.
 */
function buildQuoted(replyTo: string | undefined, chatJid: string): object | undefined {
  if (!replyTo) return undefined;
  const parts = String(replyTo).split('_');
  // Serializado: "<fromMe>_<chatId>_<rawId>" (3+ partes). Cru: uma parte.
  const isSerialized = parts.length >= 3;
  const rawId = isSerialized ? (parts[parts.length - 1] ?? '') : String(replyTo);
  const fromMe = isSerialized ? parts[0] === 'true' : false;
  if (!rawId) return undefined;

  return {
    key: { remoteJid: chatJid, id: rawId, fromMe },
    // Placeholder: o WhatsApp casa a citacao pelo id da key.
    message: { conversation: '' },
  };
}

export function registerSendRoutes(app: FastifyInstance, { sessions }: Deps): void {
  /** Resolve os campos comuns e valida antes de tocar no socket. */
  function prepare(body: SendBody | undefined): { session: string; jid: string } {
    const session = body?.session?.trim();
    const chatId = body?.chatId?.trim();
    if (!session) throw new Boom('session e obrigatorio', { statusCode: 400 });
    if (!chatId) throw new Boom('chatId e obrigatorio', { statusCode: 400 });
    return { session, jid: toBaileysJid(chatId) };
  }

  /** Baixa/decodifica o arquivo do payload para Buffer, ou devolve a url para o Baileys. */
  async function resolveFile(file: FilePayload | undefined): Promise<{
    buffer?: Buffer;
    url?: string;
    mimetype: string | undefined;
    filename: string | undefined;
  }> {
    if (!file) throw new Boom('file e obrigatorio', { statusCode: 400 });
    if (file.data) {
      // ★ `[^,]*` e NAO `[^;]+`: o mimetype pode trazer PARAMETRO antes do
      // `;base64,` — e justamente o caso do voice note, cujo formato canonico e
      // `audio/ogg; codecs=opus` (ver sendVoice abaixo). Com `[^;]+` o data URL
      // `data:audio/ogg;codecs=opus;base64,...` NAO casava, o prefixo inteiro
      // entrava no decode e o audio saia com header corrompido — PTT nao
      // entregue, com HTTP 200 e id valido (falha invisivel).
      const b64 = file.data.replace(/^data:[^,]*;base64,/, '');

      // ★ Buffer.from(...,'base64') NUNCA lanca: descarta caracteres invalidos em
      // silencio. Base64 truncado virava upload de lixo — ou de 0 byte, que ainda
      // e truthy — e o WhatsApp aceitava, devolvendo id. O backend marcava
      // "enviada com sucesso" uma mensagem que o destinatario nunca ve.
      // Validamos ANTES: o alfabeto e o resultado nao-vazio.
      const limpo = b64.trim();
      if (!limpo || !/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(limpo)) {
        throw new Boom('file.data nao e base64 valido', { statusCode: 400 });
      }
      const buffer = Buffer.from(limpo, 'base64');
      if (buffer.length === 0) {
        throw new Boom('file.data decodificou para 0 byte', { statusCode: 400 });
      }
      return { buffer, mimetype: file.mimetype, filename: file.filename };
    }
    if (file.url) {
      // O Baileys aceita { url } e baixa sozinho, mas assim o erro de download fica
      // opaco (vira falha de envio sem causa). Baixamos aqui para reportar direito.
      const res = await fetch(file.url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) {
        throw new Boom(`falha ao baixar file.url: HTTP ${res.status}`, { statusCode: 422 });
      }

      // ★ Teto de tamanho. O bodyLimit do Fastify protege o CORPO do POST, nao
      // este fetch de saida: uma url apontando para um arquivo de GBs alocava tudo
      // no heap e derrubava o container — junto com TODAS as sessoes WhatsApp,
      // nao so o envio. O timeout limita tempo, nao bytes.
      const declarado = Number(res.headers.get('content-length') ?? 0);
      if (declarado > MAX_FILE_BYTES) {
        throw new Boom(
          `file.url tem ${Math.round(declarado / 1048576)}MB; o limite e ${MAX_FILE_BYTES / 1048576}MB`,
          { statusCode: 413 },
        );
      }
      // content-length pode faltar ou mentir (chunked): contamos de verdade.
      const buffer = await readCapped(res, MAX_FILE_BYTES);
      return {
        buffer,
        mimetype: file.mimetype ?? res.headers.get('content-type') ?? undefined,
        filename: file.filename,
      };
    }
    throw new Boom('file precisa de url ou data', { statusCode: 400 });
  }

  /** Envia e devolve o corpo no formato que extractMsgId() entende. */
  async function send(
    session: string,
    jid: string,
    content: AnyMessageContent,
    replyTo?: string,
  ): Promise<Record<string, unknown>> {
    const sock = sessions.requireSocket(session);
    const quoted = buildQuoted(replyTo, jid);
    const sent = await sock.sendMessage(
      jid,
      content,
      quoted ? ({ quoted } as never) : undefined,
    );
    if (!sent?.key?.id) {
      throw new Boom('envio nao retornou id de mensagem', { statusCode: 500 });
    }

    // ★ Guarda o conteúdo para responder RETRY RECEIPTS. Quando o celular do
    // destinatário não consegue decifrar (sessão Signal ruim), ele pede o reenvio;
    // sem o conteúdo guardado o pedido fica sem resposta e o app dele mostra
    // "Aguardando mensagem" para sempre. `sent.message` é o proto já montado.
    await sessions.rememberSentMessage(session, sent.key, sent.message);

    const id = serializeMsgId(sent.key);
    return {
      // `id` string: extractMsgId retorna direto (waha.js:18).
      id,
      // _data espelha o shape do WAHA para consumidores que leem dali.
      _data: { id: { id: sent.key.id, _serialized: id }, Info: { ID: sent.key.id } },
      to: jid,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Monta o conteúdo Baileys para UMA mídia, decidindo o tipo pelo mimetype.
   *
   * Centraliza a regra que estava repetida nos endpoints de envio, para o
   * /sendMedia não divergir deles (ex.: o PTT precisa de `ptt: true` e mimetype
   * explícito; o documento precisa de fileName).
   */
  function mediaContent(
    f: { buffer?: Buffer; url?: string; mimetype?: string; filename?: string },
    opts: { caption?: string; asVoice?: boolean; asDocument?: boolean } = {},
  ): AnyMessageContent {
    const src = f.buffer ? f.buffer : { url: f.url! };
    const mime = (f.mimetype ?? '').toLowerCase();
    const caption = opts.caption || undefined;

    // Documento explícito ganha de qualquer heurística: é o fallback de quem
    // quer enviar como anexo mesmo sendo imagem/vídeo.
    if (opts.asDocument) {
      return {
        document: src,
        mimetype: f.mimetype ?? 'application/octet-stream',
        fileName: f.filename ?? 'arquivo',
        caption,
      } as AnyMessageContent;
    }
    if (opts.asVoice || (mime.startsWith('audio/') && opts.asVoice !== false)) {
      // Voz não aceita caption no WhatsApp — ignorar em silêncio seria pior que
      // não oferecer, então o endpoint avisa antes de chegar aqui.
      return {
        audio: src,
        ptt: true,
        mimetype: f.mimetype ?? 'audio/ogg; codecs=opus',
      } as AnyMessageContent;
    }
    if (mime.startsWith('image/')) {
      // WEBP é sticker no WhatsApp, não imagem — enviar como imagem gera anexo
      // estranho. Só tratamos como sticker quando não há caption (sticker não
      // suporta), senão respeitamos a intenção de mandar imagem com legenda.
      if (mime === 'image/webp' && !caption) {
        return { sticker: src } as AnyMessageContent;
      }
      return { image: src, caption, mimetype: f.mimetype } as AnyMessageContent;
    }
    if (mime.startsWith('video/')) {
      return { video: src, caption, mimetype: f.mimetype } as AnyMessageContent;
    }
    // Desconhecido → documento. Melhor um anexo que abre do que um tipo errado.
    return {
      document: src,
      mimetype: f.mimetype ?? 'application/octet-stream',
      fileName: f.filename ?? 'arquivo',
      caption,
    } as AnyMessageContent;
  }

  // POST /api/sendMedia — VÁRIOS arquivos numa chamada, cada um com sua legenda.
  //
  // Por que existe: enviar 5 fotos exigia 5 requisições, e sem controle de ordem
  // (o WhatsApp entrega na ordem em que recebe; requisições paralelas chegam
  // embaralhadas). Aqui os itens são enviados em SÉRIE, então a ordem que o
  // consumidor pediu é a ordem que o contato vê.
  //
  // `album: true` agrupa imagens/vídeos numa ÚNICA bolha (recurso nativo do
  // WhatsApp, exposto pela Baileys 7 via albumParentKey).
  app.post<{
    Body: {
      session?: string;
      chatId?: string;
      album?: boolean;
      caption?: string;
      reply_to?: string;
      items?: Array<{
        file?: FilePayload;
        caption?: string;
        asVoice?: boolean;
        asDocument?: boolean;
      }>;
    };
  }>('/api/sendMedia', async (req) =>
    sendManyMedia(prepare(req.body), {
      items: req.body?.items,
      album: req.body?.album,
      caption: req.body?.caption,
      replyTo: req.body?.reply_to,
    }),
  );

  /**
   * Envia N mídias na mesma conversa, em série, preservando a ordem.
   *
   * Usado pelo /sendMedia e pelos endpoints antigos quando recebem `files[]`.
   */
  async function sendManyMedia(
    { session, jid }: { session: string; jid: string },
    opts: {
      items?: Array<{
        file?: FilePayload;
        caption?: string;
        asVoice?: boolean;
        asDocument?: boolean;
      }>;
      album?: boolean;
      caption?: string;
      replyTo?: string;
      /** Força o tipo (o /sendFile manda tudo como documento, por exemplo). */
      forceDocument?: boolean;
      forceVoice?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    const items = opts.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw new Boom('items e obrigatorio (lista com pelo menos 1 arquivo)', {
        statusCode: 400,
      });
    }
    // Teto: cada item vira upload. Sem limite, uma chamada com 500 arquivos
    // seguraria o socket da sessão por minutos e atrasaria todo o resto.
    if (items.length > MAX_MEDIA_ITEMS) {
      throw new Boom(
        `no maximo ${MAX_MEDIA_ITEMS} arquivos por chamada (recebidos ${items.length})`,
        { statusCode: 400 },
      );
    }

    // Resolve TODOS os arquivos antes de enviar qualquer um: um base64 inválido
    // no item 4 não deve deixar 3 mensagens já entregues e o resto falhando.
    const resolvidos = [];
    for (const [i, item] of items.entries()) {
      try {
        resolvidos.push({ f: await resolveFile(item?.file), item });
      } catch (err) {
        const msg = (err as Error).message;
        throw new Boom(`item ${i + 1}: ${msg}`, {
          statusCode: (err as { output?: { statusCode?: number } })?.output?.statusCode ?? 400,
        });
      }
    }

    const sock = sessions.requireSocket(session);

    // ── Álbum ────────────────────────────────────────────────────────────────
    // Só imagens e vídeos entram num álbum (regra do WhatsApp). O que não for
    // vai depois, como mensagem própria.
    let albumParentKey: unknown;
    if (opts.album) {
      const naAlbum = resolvidos.filter((r) => {
        const m = (r.f.mimetype ?? '').toLowerCase();
        return (
          !(r.item?.asDocument ?? opts.forceDocument) &&
          !(r.item?.asVoice ?? opts.forceVoice) &&
          (m.startsWith('image/') || m.startsWith('video/')) &&
          m !== 'image/webp'
        );
      });
      // Álbum de 1 item é uma bolha normal — não vale criar o container.
      if (naAlbum.length >= 2) {
        const imagens = naAlbum.filter((r) =>
          (r.f.mimetype ?? '').toLowerCase().startsWith('image/'),
        ).length;
        const parent = await sock.sendMessage(jid, {
          album: {
            expectedImageCount: imagens,
            expectedVideoCount: naAlbum.length - imagens,
          },
        } as never);
        albumParentKey = parent?.key;
      }
    }

    // ── Envio em SÉRIE ───────────────────────────────────────────────────────
    // Sequencial de propósito: é o que garante a ordem no aparelho do contato.
    const enviados: Array<Record<string, unknown>> = [];
    for (const [i, { f, item }] of resolvidos.entries()) {
      const content = mediaContent(f, {
        // caption do item; o caption da chamada vale para o PRIMEIRO item, que é
        // como o WhatsApp mostra a legenda de um álbum.
        caption: item?.caption ?? (i === 0 ? opts.caption : undefined),
        asVoice: item?.asVoice ?? opts.forceVoice,
        asDocument: item?.asDocument ?? opts.forceDocument,
      });

      // Reply só no primeiro: citar a mesma mensagem N vezes poluiria a conversa.
      const replyTo = i === 0 ? opts.replyTo : undefined;
      const quoted = buildQuoted(replyTo, jid);

      const podeAlbum =
        !!albumParentKey &&
        !(item?.asDocument ?? opts.forceDocument) &&
        !(item?.asVoice ?? opts.forceVoice) &&
        !('document' in content);
      const sent = await sock.sendMessage(
        jid,
        podeAlbum ? ({ ...content, albumParentKey } as never) : content,
        quoted ? ({ quoted } as never) : undefined,
      );

      if (!sent?.key?.id) {
        // Falha no meio: reportamos o que JÁ foi enviado. Sem isso o consumidor
        // reenviaria tudo e o contato receberia duplicado.
        throw new Boom(
          `item ${i + 1} nao retornou id; ${enviados.length} de ${resolvidos.length} foram enviados`,
          { statusCode: 500 },
        );
      }
      await sessions.rememberSentMessage(session, sent.key, sent.message);
      const id = serializeMsgId(sent.key);
      enviados.push({
        id,
        _data: { id: { id: sent.key.id, _serialized: id }, Info: { ID: sent.key.id } },
      });
    }

    return {
      // `id` do primeiro: mantém o contrato de quem lê um id único da resposta.
      id: enviados[0]?.id,
      _data: enviados[0]?._data,
      to: jid,
      count: enviados.length,
      album: !!albumParentKey,
      // Todos os ids, na ordem enviada — para o consumidor casar ACK por item.
      messages: enviados,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * `files[]` (dos endpoints antigos) no formato de `items[]` do sendMedia.
   *
   * Devolve null quando nao ha lista — o chamador segue no caminho de arquivo
   * unico, que continua valendo para todo consumidor existente.
   */
  function asItems(body: SendBody | undefined) {
    const fs = body?.files;
    if (!Array.isArray(fs) || fs.length === 0) return null;
    return fs.map((f) => ({
      file: { url: f?.url, data: f?.data, mimetype: f?.mimetype, filename: f?.filename },
      caption: f?.caption,
    }));
  }

  // POST /api/sendText
  app.post<{ Body: SendBody }>('/api/sendText', async (req) => {
    const { session, jid } = prepare(req.body);
    // ★ Texto vazio NAO e envio valido.
    //
    // O `?? ''` anterior transformava texto ausente numa mensagem VAZIA que era
    // realmente entregue: o WhatsApp aceitava, o gateway devolvia 200 com id, e o
    // contato recebia uma bolha em branco (confirmado no beta — dois envios
    // vazios chegaram). Um bug no consumidor que perdesse o campo `text` viraria
    // spam silencioso no cliente, com tudo parecendo bem-sucedido.
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) throw new Boom('text e obrigatorio', { statusCode: 400 });
    return send(session, jid, { text }, req.body?.reply_to);
  });

  // POST /api/sendImage
  app.post<{ Body: SendBody }>('/api/sendImage', async (req) => {
    const alvo = prepare(req.body);
    // `files: [...]` no lugar de `file: {...}`: mesma rota, N imagens.
    const items = asItems(req.body);
    if (items) {
      return sendManyMedia(alvo, {
        items, album: req.body?.album,
        caption: req.body?.caption, replyTo: req.body?.reply_to,
      });
    }
    const { session, jid } = alvo;
    const f = await resolveFile(req.body?.file);
    return send(session, jid, {
      image: f.buffer ? f.buffer : { url: f.url! },
      caption: req.body?.caption || undefined,
      mimetype: f.mimetype,
    }, req.body?.reply_to);
  });

  // POST /api/sendVoice — voice note (PTT).
  // O backend transcoda webm->ogg/opus ANTES de chamar aqui (lib/messaging.js:967),
  // porque o WhatsApp aceita webm mas nao entrega. Enviamos como ptt para virar
  // voice note de verdade em vez de anexo de audio.
  app.post<{ Body: SendBody }>('/api/sendVoice', async (req) => {
    const { session, jid } = prepare(req.body);
    const f = await resolveFile(req.body?.file);
    return send(session, jid, {
      audio: f.buffer ? f.buffer : { url: f.url! },
      ptt: true,
      // mimetype explicito: sem ele o WhatsApp as vezes trata como arquivo.
      // 'audio/ogg; codecs=opus' e o unico formato que o WhatsApp entrega como
      // voice note de verdade — foi o bug que motivou este gateway.
      mimetype: f.mimetype ?? 'audio/ogg; codecs=opus',
    }, req.body?.reply_to);
  });

  // POST /api/sendVideo
  app.post<{ Body: SendBody }>('/api/sendVideo', async (req) => {
    const alvo = prepare(req.body);
    const items = asItems(req.body);
    if (items) {
      return sendManyMedia(alvo, {
        items, album: req.body?.album,
        caption: req.body?.caption, replyTo: req.body?.reply_to,
      });
    }
    const { session, jid } = alvo;
    const f = await resolveFile(req.body?.file);
    return send(session, jid, {
      video: f.buffer ? f.buffer : { url: f.url! },
      caption: req.body?.caption || undefined,
      mimetype: f.mimetype,
    }, req.body?.reply_to);
  });

  // POST /api/sendFile — documento/anexo.
  // Tambem e o fallback do driver quando sendVideo falha (waha.js:100), entao precisa
  // aceitar qualquer mimetype.
  app.post<{ Body: SendBody }>('/api/sendFile', async (req) => {
    const alvo = prepare(req.body);
    const items = asItems(req.body);
    if (items) {
      // forceDocument: esta rota e "anexo", entao nao vira imagem por heuristica.
      return sendManyMedia(alvo, {
        items, caption: req.body?.caption,
        replyTo: req.body?.reply_to, forceDocument: true,
      });
    }
    const { session, jid } = alvo;
    const f = await resolveFile(req.body?.file);
    return send(session, jid, {
      document: f.buffer ? f.buffer : { url: f.url! },
      mimetype: f.mimetype ?? 'application/octet-stream',
      fileName: f.filename ?? 'arquivo',
      caption: req.body?.caption || undefined,
    }, req.body?.reply_to);
  });

  // POST /api/sendSticker
  app.post<{ Body: SendBody }>('/api/sendSticker', async (req) => {
    const { session, jid } = prepare(req.body);
    const f = await resolveFile(req.body?.file);
    // O WhatsApp exige WEBP para sticker. Nao convertemos aqui: se vier outro
    // formato, o proprio WhatsApp rejeita e o erro sobe claro em vez de "enviado"
    // silencioso que nunca aparece.
    return send(session, jid, {
      sticker: f.buffer ? f.buffer : { url: f.url! },
    }, req.body?.reply_to);
  });

  // POST /api/reaction — reagir a uma mensagem (ou remover a reacao).
  // Formato do WAHA: { session, messageId, reaction }. String vazia REMOVE a reacao,
  // que e como o WhatsApp modela "desreagir" (nao ha endpoint de delete).
  app.post<{ Body: { session?: string; messageId?: string; chatId?: string; reaction?: string } }>(
    '/api/reaction',
    async (req, reply) => {
      const session = req.body?.session?.trim();
      const messageId = req.body?.messageId?.trim();
      if (!session) return reply.code(400).send({ message: 'session e obrigatorio' });
      if (!messageId) return reply.code(400).send({ message: 'messageId e obrigatorio' });

      // O chat pode vir explicito ou ser extraido do id serializado
      // ("<fromMe>_<chatId>_<rawId>") — o backend manda o id serializado.
      const parts = messageId.split('_');
      const chatFromId = parts.length >= 3 ? parts.slice(1, -1).join('_') : null;
      const chatIdRaw = req.body?.chatId?.trim() || chatFromId;
      if (!chatIdRaw) {
        return reply.code(400).send({
          message: 'chatId e obrigatorio quando messageId nao e serializado',
        });
      }

      const jid = toBaileysJid(chatIdRaw);
      const rawId = parts.length >= 3 ? (parts[parts.length - 1] ?? '') : messageId;
      const fromMe = parts.length >= 3 ? parts[0] === 'true' : false;

      const sock = sessions.requireSocket(session);
      const sent = await sock.sendMessage(jid, {
        react: {
          text: req.body?.reaction ?? '', // '' remove a reacao
          key: { remoteJid: jid, id: rawId, fromMe },
        },
      });
      if (!sent?.key?.id) {
        throw new Boom('reacao nao retornou id', { statusCode: 500 });
      }
      return { id: serializeMsgId(sent.key), success: true };
    },
  );
}
