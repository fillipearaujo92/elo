// src/core/media.ts
//
// Midia inbound: baixa/descriptografa via Baileys e grava em disco, servindo por
// GET /api/files/{session}/{arquivo}. O consumidor baixa dessa URL e move
// para o storage dele (S3/MinIO) — o consumidor deve fazer retry no download.
//
// Guardamos em disco local (volume do container) por simplicidade: e cache de
// transito, nao storage definitivo. O backend e a fonte da verdade da midia.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { downloadMediaMessage, type WASocket, type WAMessage } from 'baileys';
import type { Logger } from 'pino';
import { config } from '../config.js';
import type { WahaMessageType } from './waha-compat.js';

const MEDIA_TYPES = new Set<WahaMessageType>([
  'image',
  'video',
  'audio',
  'ptt',
  'document',
  'sticker',
]);

// Extensao por mimetype. Fallback 'bin' quando desconhecido — o backend usa o
// mimetype do payload, nao a extensao, para decidir como exibir.
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'audio/ogg': 'oga',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
};

export class MediaStore {
  constructor(private readonly log: Logger) {}

  isMediaType(type: WahaMessageType): boolean {
    return MEDIA_TYPES.has(type);
  }

  /**
   * Baixa a midia da mensagem e devolve a URL publica, ou null em falha.
   * Nao lanca: mensagem sem midia baixada ainda deve chegar ao backend (que trata
   * media.url null — ha teste para isso no contrato).
   */
  async download(
    sock: WASocket | null,
    msg: WAMessage,
    session: string,
  ): Promise<string | null> {
    if (!sock) return null;

    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: this.log as never,
        // reuploadRequest permite recuperar midia cuja chave expirou, pedindo
        // reupload ao remetente. Sem isso, midia antiga falha o download.
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer?.length) return null;

    const mime = this.mimeOf(msg) ?? 'application/octet-stream';
    const ext = EXT_BY_MIME[mime.split(';')[0]?.trim() ?? ''] ?? 'bin';
    const filename = `${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`;

    const dir = join(config.mediaDir, this.safeSegment(session));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), buffer);

    const base = config.publicUrl.replace(/\/$/, '');
    const path = `/api/files/${encodeURIComponent(session)}/${filename}`;
    return base ? `${base}${path}` : path;
  }

  /** Le um arquivo servido por GET /api/files/... com protecao de path traversal. */
  async read(session: string, filename: string): Promise<Buffer | null> {
    // Path traversal: "../.." no nome sairia do diretorio de midia e exporia
    // arquivos do container. Normalizamos e conferimos que o resultado esta dentro.
    const root = resolve(config.mediaDir);
    const target = resolve(root, this.safeSegment(session), this.safeSegment(filename));
    // ★ Compara com `root + separador`, não só `root`.
    //
    // `startsWith(root)` sozinho aceita DIRETÓRIO IRMÃO: com MEDIA_DIR=/data/media,
    // resolve('/data/media-evil/x').startsWith('/data/media') é `true` (medido).
    // Como GET /api/files/ é rota pública (sem X-Api-Key), a guarda que existe
    // exatamente para barrar traversal não barrava esse caso.
    if (target !== root && !target.startsWith(root + sep)) {
      this.log.warn({ session, filename }, 'tentativa de path traversal barrada');
      return null;
    }
    return readFile(target).catch(() => null);
  }

  private safeSegment(s: string): string {
    // Remove separadores e sequencias de subida; mantem o resto legivel.
    return s.replace(/[/\\]/g, '_').replace(/\.\./g, '_');
  }

  private mimeOf(msg: WAMessage): string | null {
    const c = msg.message;
    if (!c) return null;
    const doc = c.documentMessage ?? c.documentWithCaptionMessage?.message?.documentMessage;
    return (
      c.imageMessage?.mimetype ??
      c.videoMessage?.mimetype ??
      c.audioMessage?.mimetype ??
      doc?.mimetype ??
      c.stickerMessage?.mimetype ??
      null
    );
  }
}
