// src/core/session-manager.ts
//
// Dono dos sockets Baileys: um socket por sessao, N sessoes no mesmo processo.
// Responsavel por criar/parar/apagar sessoes, restaurar no boot e reconectar.
//
// Regras de resiliencia (as que mais custaram em producao com Evolution/WAHA):
//
//  1. LOGOUT vs QUEDA TRANSIENTE. Em logout (401/403/411) as creds viraram lixo:
//     limpamos o auth state, zeramos me_id e vamos para SCAN_QR_CODE. Em queda
//     transiente reconectamos com backoff PRESERVANDO me_id — e assim que o backend
//     (waha-reconnect.js) distingue "reconecta sozinho" de "chama um humano".
//
//  2. restartRequired (515) e reconexao IMEDIATA, sem backoff e sem contar tentativa.
//     Acontece sempre depois do primeiro QR; tratar como falha impede o pareamento.
//
//  3. session.status com THROTTLE. O WAHA real emite um evento a cada refresh de QR
//     (~20s) e isso virou tempestade no backend. Suprimimos repeticao do MESMO status
//     dentro da janela; mudanca de status passa sempre.

import { Boom } from '@hapi/boom';
import {
  BufferJSON,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  makeWASocket,
  type WASocket,
  type ConnectionState,
  type WAMessage,
} from 'baileys';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { clearAuthState, forgetAuthQueue, usePostgresAuthState } from './auth-state.js';
import { events } from './events.js';
import { extractLidPairs, isLid, phoneFromJid, senderPhoneOf } from './lid.js';
import { MediaStore } from './media.js';
import { buildAckPayload, buildMessagePayload, buildSessionStatusPayload } from './payload.js';
import {
  baileysStatusToWahaAck,
  extractBody,
  isImmediateRestart,
  isLogoutReason,
  serializeMsgId,
  toBaileysJid,
  toWahaChatId,
  wahaTypeFromMessage,
  type WahaSessionStatus,
} from './waha-compat.js';
import type { WebhookConfig, WebhookEmitter } from './webhook.js';

export interface SessionConfig {
  webhooks?: WebhookConfig[];
  /**
   * Quais tipos de chat NAO devem gerar evento. Default de cada um em
   * shouldIgnoreChat — `status` ja nascia ignorado, os outros nascem recebidos.
   */
  ignore?: {
    groups?: boolean;
    /** Stories/status (status@broadcast). */
    status?: boolean;
    /** Canais / newsletters (@newsletter). */
    channels?: boolean;
    /** Listas de transmissao (@broadcast, exceto status@broadcast). */
    broadcast?: boolean;
  };
  [k: string]: unknown;
}

/** Placeholder que describe() coloca no lugar dos segredos. */
const MASK = '••••••••';

/**
 * Escolhe a chave a gravar: a nova, senao a anterior, senao undefined.
 *
 * Existe para NUNCA deixar o placeholder de mascara virar valor real. O painel
 * recebe a chave como '••••••••'; devolve-la num salvamento gravaria a mascara
 * como chave, e todo webhook passaria a tomar 401 no destino — com a tela
 * dizendo "salvo com sucesso".
 */
function pickKey(next: string | undefined, prev: string | undefined): string | undefined {
  if (next && next !== MASK) return next;
  if (prev && prev !== MASK) return prev;
  return undefined;
}

/**
 * Decide se uma mensagem deve ser descartada pelo tipo de chat.
 *
 * Os quatro tipos existem porque o WhatsApp entrega tudo pelo mesmo evento, e o
 * consumidor raramente quer tudo: story de contato e canal de marketing viram
 * ruido no CRM.
 *
 * DEFAULTS: `status` (stories) e ignorado por padrao — era hard-coded antes deste
 * filtro e continua sendo o comportamento esperado. Grupos, canais e transmissoes
 * sao RECEBIDOS por padrao, para nao mudar em silencio o que os canais ativos ja
 * entregam hoje.
 */
export function shouldIgnoreChat(remoteJid: string, config?: SessionConfig): boolean {
  const ig = config?.ignore ?? {};
  if (remoteJid === 'status@broadcast') return ig.status !== false;
  if (remoteJid.endsWith('@g.us')) return !!ig.groups;
  if (remoteJid.endsWith('@newsletter')) return !!ig.channels;
  // Transmissao: qualquer @broadcast que nao seja o status (tratado acima).
  if (remoteJid.endsWith('@broadcast')) return !!ig.broadcast;
  return false;
}

export interface SessionRow {
  name: string;
  /** Nome como o humano escreveu (livre). `name` e o slug tecnico. */
  label?: string | null;
  status: WahaSessionStatus;
  me_id: string | null;
  me_push_name: string | null;
  config: SessionConfig;
  should_start: boolean;
  created_at?: string;
  updated_at?: string;
}

/**
 * Copia o config com os segredos substituidos por um placeholder.
 *
 * `customHeaders` do webhook carrega a chave de autenticacao em texto puro. Como o
 * GET /api/sessions alimenta o painel, devolver o config cru exporia a chave no
 * DevTools de quem abrisse a tela. Mascaramos na saida; o valor real continua no
 * banco, que e de onde o emissor de webhook le.
 */
function maskSecrets(config: SessionConfig): SessionConfig {
  const webhooks = config.webhooks;
  if (!Array.isArray(webhooks)) return config;
  return {
    ...config,
    webhooks: webhooks.map((w) => ({
      ...w,
      customHeaders: w.customHeaders?.map((h) => ({
        name: h.name,
        value: h.value ? MASK : '',
      })),
    })),
  };
}

/**
 * Inverso de `maskSecrets`: troca todo valor mascarado pelo REAL que está no
 * banco. Aplicado na entrada de qualquer escrita de config.
 *
 * Existe porque mascarar na saída sem desmascarar na entrada é uma armadilha:
 * quem faz read-modify-write (GET → editar → gravar) devolve o placeholder de
 * boa-fé e grava a máscara como se fosse a chave. Se o valor real não existir
 * mais, o header é REMOVIDO em vez de gravado como '••••••••' — sem header, o
 * backend responde 401 de forma visível; com a máscara, o 401 vem disfarçado de
 * configuração correta.
 */
function unmaskConfig(entrada: SessionConfig, atual?: SessionConfig): SessionConfig {
  const webhooks = entrada.webhooks;
  if (!Array.isArray(webhooks)) return entrada;
  return {
    ...entrada,
    webhooks: webhooks.map((w, i) => {
      if (!w?.customHeaders?.length) return w;
      const antes = atual?.webhooks?.[i]?.customHeaders;
      const headers = w.customHeaders
        .map((h) => {
          if (h?.value !== MASK) return h;
          const real = antes?.find((p) => p.name === h.name)?.value;
          return real && real !== MASK ? { name: h.name, value: real } : null;
        })
        .filter((h): h is { name: string; value: string } => h !== null);
      return { ...w, customHeaders: headers };
    }),
  };
}

interface LiveSession {
  name: string;
  sock: WASocket | null;
  status: WahaSessionStatus;
  /** QR atual como data URL de PNG (o driver do backend espera base64 de imagem). */
  qr: string | null;
  /** Quando o QR atual foi emitido (epoch ms) — o painel usa para a idade real. */
  qrAt: number | null;
  meId: string | null;
  mePushName: string | null;
  config: SessionConfig;
  reconnectAttempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  /** Ultimo status emitido + quando, para o throttle de session.status. */
  lastEmittedStatus: WahaSessionStatus | null;
  lastEmittedAt: number;
  /** Marca desligamento intencional para o handler de close nao reconectar. */
  stopping: boolean;
  /**
   * Geracao do socket ATUAL. Incrementa a cada openSocket.
   *
   * ★ Resolve a classe "dois sockets na mesma sessao", que derruba o pareamento.
   *
   * O `end()` do Baileys e ASSINCRONO: ele faz `await ws.close()` e
   * `await handler(error)` ANTES de emitir `connection.update {close}`
   * (lib/Socket/socket.js:472-506). Como o nosso stop() nao esperava, a sequencia
   * era: stop() -> start() reseta stopping=false -> openSocket cria o socket B ->
   * so ENTAO chega o close do socket A, agora com stopping=false, caindo no ramo
   * transiente: apagava `live.sock` (a referencia do B, que segue VIVO recebendo
   * mensagens) e agendava um socket C.
   *
   * Com a geracao, cada handler sabe de qual socket ele e e ignora eventos de
   * geracao antiga — o close do A nao mexe mais no estado do B.
   */
  generation: number;
}

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_RECONNECT_ATTEMPTS = 10;

export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  /** start() em voo por sessao — evita dois sockets por chamadas concorrentes. */
  private readonly starting = new Map<string, Promise<void>>();
  private waVersion: [number, number, number] | undefined;
  /**
   * Nome do contato por "<sessao>:<telefone>", alimentado pelos eventos de contato.
   * Cache em memória (não vale persistir: o pushName da própria mensagem tem
   * prioridade, e o backend já guarda o nome no contato dele).
   */
  private readonly contactNames = new Map<string, string>();

  constructor(
    private readonly pool: Pool,
    private readonly log: Logger,
    private readonly webhooks: WebhookEmitter,
    private readonly media: MediaStore,
  ) {}

  // ── Ciclo de vida ────────────────────────────────────────────────────────

  /** Restaura no boot todas as sessoes marcadas com should_start. */
  async restoreAll(): Promise<void> {
    // Busca a versao do WhatsApp Web uma vez e reusa: cada chamada e uma request
    // externa, e o Baileys usa isso no handshake.
    try {
      const { version } = await fetchLatestBaileysVersion();
      this.waVersion = version;
      this.log.info({ version }, 'versao do WhatsApp Web obtida');
    } catch (err) {
      this.log.warn(
        { err: (err as Error).message },
        'nao consegui buscar a versao do WA Web; uso o default do Baileys',
      );
    }

    const res = await this.pool.query<SessionRow>(
      `SELECT name, status, me_id, me_push_name, config, should_start
         FROM wa_gateway.sessions WHERE should_start = true`,
    );
    this.log.info({ count: res.rows.length }, 'restaurando sessoes');
    for (const row of res.rows) {
      // Sequencial de proposito: N handshakes simultaneos no boot costumam ser
      // rejeitados pelo WhatsApp e disparam rate-limit.
      await this.start(row.name).catch((err) =>
        this.log.error({ session: row.name, err: (err as Error).message }, 'falha ao restaurar'),
      );
    }
  }

  async upsertSession(
    name: string,
    cfg: SessionConfig,
    shouldStart: boolean,
    label?: string,
  ): Promise<SessionRow> {
    // Desmascara também aqui: o ON CONFLICT torna este um caminho de ATUALIZAÇÃO,
    // e o driver reaplica o config por aqui depois de receber 422 "já existe".
    const atual = await this.getSessionRow(name);
    const cfgLimpo = unmaskConfig(cfg ?? {}, atual?.config);
    const res = await this.pool.query<SessionRow>(
      // COALESCE no label: um upsert sem label (o caso do backend do Sysled, que
      // só manda o identifier) não apaga o rótulo que o operador já escolheu.
      `INSERT INTO wa_gateway.sessions (name, label, config, should_start, status)
       VALUES ($1, COALESCE($4, $1), $2::jsonb, $3, 'STOPPED')
       ON CONFLICT (name) DO UPDATE
         SET config = EXCLUDED.config, should_start = EXCLUDED.should_start,
             label = COALESCE($4, wa_gateway.sessions.label, EXCLUDED.name),
             updated_at = NOW()
       RETURNING name, label, status, me_id, me_push_name, config, should_start`,
      [name, JSON.stringify(cfgLimpo), shouldStart, label ?? null],
    );
    const row = res.rows[0]!;
    const live = this.sessions.get(name);
    if (live) live.config = row.config;
    return row;
  }

  /** Atualiza apenas o config (PUT /api/sessions/{s}), preservando o resto. */
  async updateConfig(name: string, cfg: SessionConfig): Promise<SessionRow | null> {
    // ★ Desmascara ANTES de gravar.
    //
    // O PATCH /settings tem essa proteção (pickKey), mas o PUT não tinha — e o
    // mesmo bug sobrevivia na rota vizinha. O caminho é o natural: GET (devolve a
    // chave como '••••••••', por maskSecrets) → editar um campo → PUT. Isso
    // gravava LITERALMENTE '••••••••' como X-Webhook-Key, e a partir dali todo
    // inbound tomava 401 no backend e desaparecia — sem retry, porque o emissor
    // não retenta 4xx. O painel voltava a mostrar '••••••••', indistinguível do
    // estado correto.
    const atual = await this.getSessionRow(name);
    const limpo = unmaskConfig(cfg ?? {}, atual?.config);

    const res = await this.pool.query<SessionRow>(
      `UPDATE wa_gateway.sessions SET config = $2::jsonb, updated_at = NOW()
        WHERE name = $1
        RETURNING name, label, status, me_id, me_push_name, config, should_start`,
      [name, JSON.stringify(limpo)],
    );
    const row = res.rows[0];
    if (!row) return null;
    const live = this.sessions.get(name);
    if (live) live.config = row.config;
    return row;
  }

  async getSessionRow(name: string): Promise<SessionRow | null> {
    const res = await this.pool.query<SessionRow>(
      `SELECT name, label, status, me_id, me_push_name, config, should_start,
              created_at, updated_at
         FROM wa_gateway.sessions WHERE name = $1`,
      [name],
    );
    return res.rows[0] ?? null;
  }

  async listSessions(): Promise<SessionRow[]> {
    const res = await this.pool.query<SessionRow>(
      `SELECT name, label, status, me_id, me_push_name, config, should_start,
              created_at, updated_at
         FROM wa_gateway.sessions ORDER BY COALESCE(label, name)`,
    );
    return res.rows;
  }

  /**
   * Edição PARCIAL das configurações de uma sessão, para o painel.
   *
   * Existe separado do PUT /config porque:
   *   - `auto-start` e `label` são COLUNAS, não parte do config JSONB
   *   - o PUT substitui o config inteiro; aqui fazemos merge, então mexer no
   *     webhook não apaga `ignore.groups` (e vice-versa)
   *   - a chave do webhook nunca chega ao painel em claro (vem mascarada), então
   *     um PUT ingênuo a partir da tela gravaria "••••••••" como chave real.
   *     Aqui o valor mascarado é detectado e o original preservado.
   */
  async patchSettings(
    name: string,
    patch: {
      label?: string;
      shouldStart?: boolean;
      ignoreGroups?: boolean;
      ignoreStatus?: boolean;
      ignoreChannels?: boolean;
      ignoreBroadcast?: boolean;
      webhookUrl?: string | null;
      webhookEvents?: string[];
      webhookKey?: string;
      /** Cabecalhos extras ALEM do X-Webhook-Key (substitui a lista anterior). */
      webhookHeaders?: Array<{ name: string; value: string }>;
      webhookRetries?: { attempts?: number; delaySeconds?: number; policy?: string };
    },
  ): Promise<SessionRow | null> {
    const row = await this.getSessionRow(name);
    if (!row) return null;

    const cfg: SessionConfig = { ...(row.config ?? {}) };

    // Filtros de chat: cada um so e tocado se veio no patch (merge, nao replace).
    const IG = [
      ['ignoreGroups', 'groups'],
      ['ignoreStatus', 'status'],
      ['ignoreChannels', 'channels'],
      ['ignoreBroadcast', 'broadcast'],
    ] as const;
    for (const [from, to] of IG) {
      if (patch[from] !== undefined) {
        cfg.ignore = { ...(cfg.ignore ?? {}), [to]: !!patch[from] };
      }
    }

    // ── Webhook ───────────────────────────────────────────────────────────
    // URL vazia EXPLICITA remove o repasse (desligar sem apagar a sessão).
    if (patch.webhookUrl === null || patch.webhookUrl === '') {
      delete cfg.webhooks;
    } else if (
      patch.webhookUrl !== undefined ||
      patch.webhookEvents ||
      patch.webhookKey ||
      patch.webhookHeaders ||
      patch.webhookRetries
    ) {
      const prev = cfg.webhooks?.[0];
      const url = patch.webhookUrl ?? prev?.url;
      // Sem URL não há webhook a configurar (nem prévia, nem nova).
      if (url) {
        const prevKey = prev?.customHeaders?.find((h) => h.name === 'X-Webhook-Key')?.value;
        // A chave nova vale; senão preserva a existente; senão cai na chave do
        // gateway. O placeholder de máscara NUNCA é aceito como valor real —
        // gravá-lo faria todo webhook tomar 401 no destino.
        const key = pickKey(patch.webhookKey, prevKey) ?? config.apiKey;

        // Cabeçalhos extras: a lista do patch substitui a anterior, mas o
        // X-Webhook-Key é gerenciado à parte (vem do campo de chave) para o
        // operador não conseguir removê-lo por acidente e derrubar o repasse.
        const extras = (patch.webhookHeaders ?? prev?.customHeaders ?? [])
          .filter((h) => h?.name && h.name !== 'X-Webhook-Key')
          .map((h) => ({
            name: h.name,
            // Um header extra também volta mascarado ao painel; mesmo cuidado.
            value: h.value === '••••••••'
              ? (prev?.customHeaders?.find((p) => p.name === h.name)?.value ?? '')
              : (h.value ?? ''),
          }));

        cfg.webhooks = [
          {
            ...prev,
            url,
            events: patch.webhookEvents?.length
              ? patch.webhookEvents
              : (prev?.events ?? ['message', 'message.ack', 'session.status']),
            customHeaders: [{ name: 'X-Webhook-Key', value: key }, ...extras],
            retries: patch.webhookRetries
              ? {
                  attempts: patch.webhookRetries.attempts ?? 15,
                  delaySeconds: patch.webhookRetries.delaySeconds ?? 2,
                  policy: patch.webhookRetries.policy ?? 'constant',
                }
              : (prev?.retries ?? { attempts: 15, delaySeconds: 2, policy: 'constant' }),
          },
        ];
      }
    }

    const res = await this.pool.query<SessionRow>(
      `UPDATE wa_gateway.sessions
          SET config = $2::jsonb,
              label = COALESCE($3, label),
              should_start = COALESCE($4, should_start),
              updated_at = NOW()
        WHERE name = $1
        RETURNING name, label, status, me_id, me_push_name, config, should_start,
                  created_at, updated_at`,
      [name, JSON.stringify(cfg), patch.label ?? null, patch.shouldStart ?? null],
    );
    const updated = res.rows[0];
    if (!updated) return null;

    // Reflete no socket vivo: sem isto, o webhook novo só valeria no próximo boot.
    const live = this.sessions.get(name);
    if (live) live.config = updated.config;

    // `ignore.groups` também vale para o socket em execução (o filtro é lido a
    // cada mensagem, então a mudança passa a valer na hora).
    const ignored = [
      cfg.ignore?.groups && 'grupos',
      cfg.ignore?.status !== false && 'status',
      cfg.ignore?.channels && 'canais',
      cfg.ignore?.broadcast && 'transmissões',
    ].filter(Boolean);
    events.emit('session', name, 'Configuração atualizada', {
      auto_start: updated.should_start,
      webhook: cfg.webhooks?.[0]?.url ?? '(nenhum)',
      ignorando: ignored.length ? ignored.join(', ') : 'nada',
    });

    return updated;
  }

  /** Metricas por sessao para o painel (contadores do proprio schema). */
  async stats(): Promise<Record<string, { sent: number; lids: number }>> {
    const res = await this.pool.query<{ session_name: string; sent: string; lids: string }>(
      `SELECT s.name AS session_name,
              (SELECT count(*) FROM wa_gateway.sent_messages m WHERE m.session_name = s.name) AS sent,
              (SELECT count(*) FROM wa_gateway.lid_map l WHERE l.session_name = s.name) AS lids
         FROM wa_gateway.sessions s`,
    );
    const out: Record<string, { sent: number; lids: number }> = {};
    for (const r of res.rows) {
      out[r.session_name] = { sent: Number(r.sent), lids: Number(r.lids) };
    }
    return out;
  }

  /** Sobe o socket da sessao. Idempotente: nao duplica socket ja ativo. */
  async start(name: string): Promise<void> {
    // ★ Serializado por sessao. A guarda de status abaixo nao bastava: duas
    // chamadas simultaneas de POST /start numa sessao em FAILED passavam AMBAS
    // (status==='FAILED' escapa da guarda) e criavam dois sockets. As rotas
    // disparam sem await, entao isso era acionavel por HTTP.
    const anterior = this.starting.get(name);
    if (anterior) return anterior;
    const p = this.doStart(name).finally(() => {
      if (this.starting.get(name) === p) this.starting.delete(name);
    });
    this.starting.set(name, p);
    return p;
  }

  private async doStart(name: string): Promise<void> {
    const existing = this.sessions.get(name);
    if (existing?.sock && (existing.status === 'WORKING' || existing.status === 'STARTING')) {
      this.log.debug({ session: name }, 'start ignorado: sessao ja ativa');
      return;
    }

    const row = await this.getSessionRow(name);
    if (!row) throw new Error(`sessao nao encontrada: ${name}`);

    await this.pool.query(
      `UPDATE wa_gateway.sessions SET should_start = true, updated_at = NOW() WHERE name = $1`,
      [name],
    );

    const live: LiveSession = existing ?? {
      name,
      sock: null,
      status: 'STOPPED',
      qr: null,
      qrAt: null,
      meId: row.me_id,
      mePushName: row.me_push_name,
      config: row.config ?? {},
      reconnectAttempts: 0,
      reconnectTimer: null,
      lastEmittedStatus: null,
      lastEmittedAt: 0,
      stopping: false,
      generation: 0,
    };
    live.config = row.config ?? {};
    live.stopping = false;
    this.sessions.set(name, live);

    await this.openSocket(live);
  }

  /** Para o socket sem apagar o pareamento (auth state preservado). */
  async stop(name: string, markShouldStart = false): Promise<void> {
    const live = this.sessions.get(name);
    if (live) {
      live.stopping = true;
      // ★ Invalida a geracao ANTES de fechar: o close chega assincrono (o end() do
      // Baileys emite connection.update depois de fechar o websocket), e sem isto
      // esse close era processado com stopping ja resetado por um start()
      // subsequente — o caminho que deixava dois sockets vivos.
      live.generation += 1;
      if (live.reconnectTimer) {
        clearTimeout(live.reconnectTimer);
        live.reconnectTimer = null;
      }
      const sock = live.sock;
      live.sock = null;
      if (sock) {
        try {
          // end() encerra sem deslogar. logout() removeria o pareamento — nao e o
          // que stop significa. Aguardamos para nao deixar escrita em voo.
          await sock.end(undefined);
        } catch {
          /* socket ja morto */
        }
      }
      await this.setStatus(live, 'STOPPED');
    }
    await this.pool.query(
      `UPDATE wa_gateway.sessions SET status='STOPPED', should_start=$2, updated_at=NOW()
        WHERE name = $1`,
      [name, markShouldStart],
    );
  }

  /** Reinicia o socket (mantendo o pareamento). Serve /restart e /start do driver. */
  async restart(name: string): Promise<void> {
    await this.stop(name, true);
    await this.start(name);
  }

  /** Apaga a sessao: socket, auth state e linha. DELETE /api/sessions/{s}. */
  async remove(name: string): Promise<void> {
    await this.stop(name, false);
    this.sessions.delete(name);
    // Libera a fila de escrita da sessao (evita crescer o mapa sem limite).
    forgetAuthQueue(name);
    await clearAuthState(this.pool, name);
    // ON DELETE CASCADE limpa auth_keys/auth_creds/sent_messages/lid_map.
    await this.pool.query(`DELETE FROM wa_gateway.sessions WHERE name = $1`, [name]);
    this.log.info({ session: name }, 'sessao removida');
  }

  // ── Estado observavel (o que o driver do backend le) ─────────────────────

  /**
   * Shape consumido por connectionState() em wa-provider/waha.js:106-119:
   *   status, me.id, engine.engine, e a presenca de me decide hasMe.
   */
  async describe(name: string): Promise<Record<string, unknown> | null> {
    const row = await this.getSessionRow(name);
    if (!row) return null;
    const live = this.sessions.get(name);
    const status = live?.status ?? row.status;
    const meId = live?.meId ?? row.me_id;

    return {
      name: row.name,
      // label = nome livre do operador; name = slug tecnico. O painel mostra o
      // label, a API continua sendo enderecada pelo name.
      label: row.label ?? row.name,
      status,
      // config com os SEGREDOS MASCARADOS: o customHeaders carrega a chave do
      // webhook em texto puro, e este endpoint alimenta o painel — a chave ficaria
      // visível no DevTools de qualquer um com a tela aberta. Quem precisa do valor
      // real é o emissor de webhook, que lê do banco, não daqui.
      config: maskSecrets(row.config ?? {}),
      // me = null quando nao ha pareamento. hasMe=false e o gatilho de alert_qr no
      // backend, entao este campo carrega a semantica de "precisa de QR".
      me: meId
        ? { id: `${meId}@c.us`, pushName: live?.mePushName ?? row.me_push_name ?? null }
        : null,
      // O driver le engine.engine apenas para exibir/monitorar. Reportamos o nome
      // do nosso engine em vez de fingir ser WEBJS/GOWS.
      engine: { engine: 'BAILEYS' },

      // ── Campos extras para o painel de operacao ──────────────────────────
      // Nao fazem parte do contrato do WAHA; o driver os ignora. Servem para o
      // operador diagnosticar sem abrir terminal.
      shouldStart: row.should_start,
      // Quantas tentativas internas de reconexao ja houve nesta queda.
      reconnectAttempts: live?.reconnectAttempts ?? 0,
      // Ha QR disponivel agora? (evita o painel chamar /auth/qr para descobrir)
      hasQr: !!live?.qr,
      createdAt: (row as { created_at?: string }).created_at ?? null,
      updatedAt: (row as { updated_at?: string }).updated_at ?? null,
    };
  }

  getLive(name: string): LiveSession | undefined {
    return this.sessions.get(name);
  }

  requireSocket(name: string): WASocket {
    const live = this.sessions.get(name);
    if (!live?.sock || live.status !== 'WORKING') {
      throw new Boom(`sessao ${name} nao esta conectada (status: ${live?.status ?? 'STOPPED'})`, {
        statusCode: 422,
      });
    }
    return live.sock;
  }

  /** QR atual como PNG base64 puro (sem prefixo data:), formato que o driver espera. */
  getQrBase64(name: string): string | null {
    const qr = this.sessions.get(name)?.qr;
    if (!qr) return null;
    return qr.replace(/^data:image\/png;base64,/, '');
  }

  /**
   * Quando o QR atual foi emitido (epoch ms), ou null se não há QR.
   *
   * O painel usa isto para saber a IDADE real do código em vez de supor um
   * intervalo fixo. O WhatsApp renova o QR a cada ~14s (medido), não num período
   * previsível — cronometrar por conta própria fazia o painel buscar antes da
   * renovação e reexibir o mesmo código, parecendo travado.
   */
  qrIssuedAt(name: string): number | null {
    return this.sessions.get(name)?.qrAt ?? null;
  }

  // ── Socket ───────────────────────────────────────────────────────────────

  private async openSocket(live: LiveSession): Promise<void> {
    // ★ Encerra o socket ANTERIOR antes de abrir o novo.
    //
    // Os ramos de 515 e de logout chamavam openSocket() de dentro do handler do
    // socket que acabou de fechar, sem encerrar nada: cada volta registrava mais
    // ~10 listeners e criava um `creds` independente. Dois `creds` distintos
    // gravando na MESMA linha auth_creds = o ultimo sobrescreve, e um
    // nextPreKeyId velho por cima do atual reintroduz o Bad MAC.
    if (live.sock) {
      const velho = live.sock;
      live.sock = null;
      try {
        velho.ev.removeAllListeners('connection.update');
        velho.end(undefined);
      } catch {
        /* socket ja morto */
      }
    }

    // Geracao deste socket. Os handlers abaixo comparam com live.generation e
    // ignoram o que vier de um socket que ja foi substituido.
    const gen = ++live.generation;
    const atual = () => live.generation === gen;

    const { state, saveCreds } = await usePostgresAuthState(this.pool, live.name);
    const childLog = this.log.child({ session: live.name, gen });

    await this.setStatus(live, 'STARTING');

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        // Cache das signal keys: sem isso cada operacao de cripto vira query no
        // Postgres e o throughput despenca.
        keys: makeCacheableSignalKeyStore(state.keys, childLog as never),
      },
      version: this.waVersion,
      // printQRInTerminal esta deprecado; tratamos o QR no connection.update.
      logger: childLog as never,

      // ★ RESOLVE o "Aguardando mensagem / Essa acao pode levar alguns instantes"
      // que aparece no app do destinatario.
      //
      // Quando o dispositivo do contato nao consegue decifrar a mensagem (sessao
      // Signal inconsistente — os "Bad MAC" que aparecem no log), ele envia um RETRY
      // RECEIPT pedindo o reenvio. O Baileys atende esse pedido chamando getMessage()
      // para recuperar o conteudo e recifrar. SEM esta funcao o retry fica sem
      // resposta e o placeholder NUNCA resolve — a mensagem chega no WhatsApp Web
      // (sessao boa) mas fica eternamente "aguardando" no celular.
      getMessage: async (key) => {
        const raw = key?.id;
        if (!raw) return undefined;
        try {
          // ★ Busca pelo ID CRU (sufixo do msg_id), NÃO pela chave completa.
          //
          // O mesmo id de mensagem é gravado com chatIds DIFERENTES: no envio o
          // destino é o telefone (@c.us), mas o retry receipt chega endereçado pelo
          // @lid do dispositivo. Casar a chave inteira falhava sempre —
          // confirmado no beta, duas linhas para a mesma mensagem:
          //   true_5516997355492@c.us_3EB0B16E...  (com conteúdo, do envio)
          //   true_207919433941235@lid_3EB0B16E... (sem conteúdo, do retry)
          // O id cru é o único componente estável entre os dois formatos.
          const res = await this.pool.query<{ content: unknown }>(
            `SELECT content FROM wa_gateway.sent_messages
              WHERE session_name = $1
                AND msg_id LIKE '%' || $2
                AND content IS NOT NULL
              ORDER BY updated_at DESC LIMIT 1`,
            [live.name, `_${raw}`],
          );
          const stored = res.rows[0]?.content;
          if (!stored) {
            childLog.warn(
              { rawId: raw },
              'retry receipt sem conteudo guardado; o contato pode ficar em "aguardando mensagem"',
            );
            return undefined;
          }
          childLog.info({ rawId: raw }, 'reenviando mensagem a pedido do dispositivo (retry receipt)');
          // BufferJSON.reviver reconstroi os Buffers (chaves de midia etc).
          return JSON.parse(JSON.stringify(stored), BufferJSON.reviver);
        } catch (err) {
          childLog.error({ rawId: raw, err: (err as Error).message }, 'falha no getMessage');
          return undefined;
        }
      },

      // Retry de envio: o default do Baileys e baixo. Aumentamos para dar mais
      // chances a um dispositivo com sessao ruim antes de desistir.
      maxMsgRetryCount: 5,

      // ★ Ciclo do QR. Sem isto o Baileys usa 60s no PRIMEIRO codigo e 20s nos
      // seguintes (lib/Socket/socket.js:464,478) — dois ritmos diferentes, o que
      // dessincroniza qualquer contagem do lado do painel e faz o mesmo codigo
      // aparecer em ciclos consecutivos. Fixando em 20s o intervalo fica uniforme
      // e o painel (que agora usa o `qrAt` real) acompanha sem adivinhar.
      qrTimeout: 20_000,
      // Sem sincronizar historico completo: o Sysled nao usa e o payload e enorme.
      syncFullHistory: false,
      // markOnlineOnConnect=false evita roubar as notificacoes do celular do cliente.
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,

      // ★ Baileys 7.x — os dois defaults que curam o "Bad MAC" (inbound perdido).
      // Deixados EXPLICITOS de propósito: são o motivo da migração da 6.7.23, e um
      // default que mudasse entre RCs traria o bug de volta em silêncio.
      //
      // enableAutoSessionRecreation: quando a sessão Signal de um contato
      // dessincroniza (o "Bad MAC"), a lib recria em vez de falhar para sempre.
      enableAutoSessionRecreation: true,
      // enableRecentMessageCache: guarda as mensagens recentes para responder aos
      // retry receipts. Trabalha junto com o nosso getMessage (que lê do Postgres):
      // o cache atende o caso rápido, o getMessage cobre reinício do container.
      enableRecentMessageCache: true,
    });

    live.sock = sock;

    sock.ev.on('creds.update', () => {
      // Geracao velha gravando creds sobrescreveria as do socket atual com estado
      // defasado — caminho conhecido para reintroduzir o Bad MAC.
      if (!atual()) return;
      saveCreds().catch((err) =>
        childLog.error({ err: (err as Error).message }, 'falha ao salvar creds'),
      );
    });

    sock.ev.on('connection.update', (update) => {
      // ★ A guarda mais importante: o close de um socket JA SUBSTITUIDO nao pode
      // mexer no estado (era o que apagava `live.sock` do socket novo e agendava
      // uma reconexao paralela, deixando dois sockets vivos).
      if (!atual()) {
        childLog.debug({ update }, 'connection.update de geracao antiga; ignorado');
        return;
      }
      this.onConnectionUpdate(live, update).catch((err) =>
        childLog.error({ err: (err as Error).message }, 'erro no connection.update'),
      );
    });

    sock.ev.on('messages.upsert', (ev) => {
      if (!atual()) return;
      // Somente 'notify' e mensagem nova de verdade; 'append' e sincronizacao.
      if (ev.type !== 'notify') return;
      for (const msg of ev.messages) {
        this.onInboundMessage(live, msg).catch((err) =>
          childLog.error({ err: (err as Error).message }, 'erro ao processar mensagem'),
        );
      }
    });

    sock.ev.on('messages.update', (updates) => {
      if (!atual()) return;
      for (const u of updates) {
        this.onMessageUpdate(live, u).catch((err) =>
          childLog.error({ err: (err as Error).message }, 'erro ao processar ack'),
        );
      }
    });

    // ★ ACK das mensagens que NÓS enviamos vem por AQUI, não por messages.update.
    // `messages.update` cobre alterações de conteúdo/estado da mensagem; o recibo de
    // entrega/leitura de uma mensagem outbound chega em `message-receipt.update`,
    // com { key, receipt: { receiptTimestamp, readTimestamp, playedTimestamp } }.
    // Sem escutar este evento, toda mensagem enviada ficava eternamente em 'sent'
    // (um tique) e a UI mostrava ícone de falha mesmo após a entrega.
    sock.ev.on('message-receipt.update', (updates) => {
      if (!atual()) return;
      for (const u of updates) {
        this.onReceiptUpdate(live, u as never).catch((err) =>
          childLog.error({ err: (err as Error).message }, 'erro ao processar recibo'),
        );
      }
    });

    // ★ REAÇÕES RECEBIDAS vêm num evento DEDICADO, não em messages.upsert.
    // Doc do Baileys: "message was reacted to. If reaction was removed — then
    // reaction.text will be falsey". Sem escutar isto, a reação do cliente nunca
    // chegava ao Sysled (o consultor não via nada).
    sock.ev.on('messages.reaction', (reactions) => {
      if (!atual()) return;
      for (const r of reactions) {
        this.onReaction(live, r as never).catch((err) =>
          childLog.error({ err: (err as Error).message }, 'erro ao processar reacao'),
        );
      }
    });

    // ★ Fonte ADICIONAL do par LID→telefone.
    //
    // Na Baileys 7.x isto virou `lid-mapping.update` com shape { pn, lid } — a
    // biblioteca passou a manter o mapeamento como cidadão de primeira classe
    // (Signal/lid-mapping.js) em vez do antigo `chats.phoneNumberShare`.
    // Continuamos populando NOSSO mapa também porque é ele que serve o
    // GET /api/{s}/lids/{lid} de que o backend depende.
    sock.ev.on('lid-mapping.update', (ev) => {
      const map = ev as unknown as { pn?: string; lid?: string };
      const phone = phoneFromJid(map?.pn);
      if (map?.lid && phone) {
        this.rememberLid(live.name, map.lid, phone).catch(() => {});
      }
    });

    // Contatos: fonte do NOME (pushname/verifiedName) e do par lid↔telefone quando o
    // Baileys expoe os dois no mesmo registro de contato.
    const onContacts = (contacts: Array<Record<string, unknown>>) => {
      for (const c of contacts) {
        const id = typeof c.id === 'string' ? c.id : null;
        const lid = typeof c.lid === 'string' ? c.lid : null;
        const name = (c.name ?? c.notify ?? c.verifiedName ?? null) as string | null;
        // Par (lid, telefone) — quando o contato traz os dois lados.
        if (lid && id && !isLid(id)) {
          const phone = phoneFromJid(id);
          if (phone) this.rememberLid(live.name, lid, phone, name).catch(() => {});
        }
        // Nome por telefone — usado para preencher o contato mesmo sem LID.
        if (id && !isLid(id) && name) {
          const phone = phoneFromJid(id);
          if (phone) this.contactNames.set(`${live.name}:${phone}`, name);
        }
      }
    };
    sock.ev.on('contacts.upsert', onContacts as never);
    sock.ev.on('contacts.update', onContacts as never);
  }

  private async onConnectionUpdate(
    live: LiveSession,
    update: Partial<ConnectionState>,
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // O driver do backend busca GET /api/{s}/auth/qr esperando PNG base64
      // (waha.js:225-232 documenta que `?format=raw` quebrava o <img src>).
      live.qr = await QRCode.toDataURL(qr, { margin: 1, width: 512 });
      // Instante de emissão: o painel calcula a idade real a partir daqui, em vez
      // de cronometrar por conta própria e dessincronizar do WhatsApp.
      live.qrAt = Date.now();
      await this.setStatus(live, 'SCAN_QR_CODE');
      return;
    }

    if (connection === 'open') {
      live.qr = null;
      live.qrAt = null;
      live.reconnectAttempts = 0;
      const rawMe = live.sock?.user?.id ?? null;
      if (rawMe) {
        const normalized = jidNormalizedUser(rawMe);
        live.meId = (normalized.split('@')[0] ?? '').split(':')[0] ?? null;
        live.mePushName = live.sock?.user?.name ?? null;
        await this.pool.query(
          `UPDATE wa_gateway.sessions
              SET me_id=$2, me_push_name=$3, updated_at=NOW() WHERE name=$1`,
          [live.name, live.meId, live.mePushName],
        );
      }
      await this.setStatus(live, 'WORKING');
      this.log.info({ session: live.name, me: live.meId }, 'sessao conectada');
      return;
    }

    if (connection === 'close') {
      const statusCode =
        (lastDisconnect?.error as Boom | undefined)?.output?.statusCode ?? null;

      if (live.stopping) {
        await this.setStatus(live, 'STOPPED');
        return;
      }

      // 515: reabrir JA. E o passo normal apos o primeiro pareamento.
      if (isImmediateRestart(statusCode)) {
        this.log.info({ session: live.name }, 'restart exigido pelo protocolo; reabrindo socket');
        await this.openSocket(live).catch((err) =>
          this.log.error({ session: live.name, err: (err as Error).message }, 'falha no restart'),
        );
        return;
      }

      // Logout: as creds morreram. Reconectar com pareamento invalido gera loop de
      // falha, entao zeramos me_id (o backend pede QR) e reabrimos para gerar codigo.
      if (isLogoutReason(statusCode)) {
        // ★ APAGAR o auth state so no 401 (loggedOut).
        //
        // `isLogoutReason` tambem cobre 403 e 411 — e ele alimenta a maquina de
        // reconexao do backend, entao continua igual. Mas APAGAR e irreversivel: o
        // 403 aparece em rejeicao temporaria de handshake (rate-limit no boot, que
        // restaura N sessoes em sequencia), e um 403 espurio apagava as creds de um
        // canal de PRODUCAO pareado — sem volta, so com o celular na mao.
        // Zerar me_id + pedir QR ja produz o comportamento correto; apagar as
        // chaves e o passo que nao da para desfazer.
        const apagarChaves = statusCode === DisconnectReason.loggedOut;
        this.log.warn(
          { session: live.name, statusCode, apagarChaves },
          'logout detectado; pareamento invalidado',
        );
        live.sock = null;
        live.meId = null;
        live.mePushName = null;
        live.qr = null;
        live.qrAt = null;
        if (apagarChaves) {
          await clearAuthState(this.pool, live.name);
        } else {
          events.emit(
            'session', live.name,
            `Desconectado com HTTP ${statusCode} — QR necessario, chaves preservadas`,
            { statusCode }, 'warn',
          );
        }
        await this.pool.query(
          `UPDATE wa_gateway.sessions SET me_id=NULL, me_push_name=NULL, updated_at=NOW()
            WHERE name=$1`,
          [live.name],
        );
        // SCAN_QR_CODE (nao FAILED): e o vocabulario que leva o backend a alert_qr.
        await this.setStatus(live, 'SCAN_QR_CODE');
        // Reabre o socket para gerar QR novo: assim o operador escaneia quando quiser
        // sem precisar de comando manual. Erro aqui NAO pode ser engolido: sem socket
        // e sem timer, a sessao ficaria morta anunciando SCAN_QR_CODE sem gerar QR.
        await this.openSocket(live).catch((err) => {
          this.log.error(
            { session: live.name, err: (err as Error).message },
            'falha ao reabrir socket apos logout; agendando nova tentativa',
          );
          this.scheduleReconnect(live, statusCode);
        });
        return;
      }

      live.sock = null;

      // ★ QR expirado numa sessao NUNCA PAREADA nao e "queda".
      //
      // Sem ninguem para escanear, o Baileys esgota os refs e fecha com 408. O
      // codigo tratava isso como queda transiente: FAILED + backoff exponencial.
      // Depois de 10 ciclos o intervalo chegava a 300s e as tentativas esgotavam,
      // deixando a sessao FAILED *muda* — e o QR guardado era o de 5 minutos
      // atras, ja morto. Quando o operador abria o painel, encontrava um codigo
      // que nao funcionava. (Foi o estado da sessao `teste-canal`.)
      //
      // Aqui: reabre sem consumir tentativa nem backoff, mantendo SCAN_QR_CODE e
      // invalidando o codigo velho.
      if (!live.meId && statusCode === DisconnectReason.timedOut) {
        live.qr = null;
        live.qrAt = null;
        await this.setStatus(live, 'SCAN_QR_CODE');
        this.log.info(
          { session: live.name },
          'QR expirou sem pareamento; gerando codigo novo',
        );
        await this.openSocket(live).catch((err) => {
          this.log.error(
            { session: live.name, err: (err as Error).message },
            'falha ao regerar QR',
          );
          this.scheduleReconnect(live, statusCode);
        });
        return;
      }

      // Queda transiente: reconectar com backoff, PRESERVANDO me_id.
      await this.setStatus(live, 'FAILED');
      this.scheduleReconnect(live, statusCode);
    }
  }

  private scheduleReconnect(live: LiveSession, statusCode: number | null): void {
    if (live.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      // Paramos de tentar sozinhos, mas mantemos FAILED com me_id preservado: o
      // channel-monitor do backend ainda pode chamar /restart (ele tem o proprio
      // backoff e o lock entre replicas).
      this.log.error(
        { session: live.name, attempts: live.reconnectAttempts },
        'tentativas internas esgotadas; aguardando comando externo',
      );
      // ★ Estado terminal AUDIVEL. Antes era um `return` puro: nenhum evento,
      // nenhum webhook — a sessao morria em silencio e so um humano abrindo o
      // painel descobriria. Agora aparece como erro no diagnostico.
      live.qr = null;
      live.qrAt = null;
      events.emit(
        'error', live.name,
        `Desistiu de reconectar apos ${live.reconnectAttempts} tentativas — precisa de /restart`,
        { statusCode }, 'error',
      );
      return;
    }

    live.reconnectAttempts += 1;
    const delay = Math.min(
      BASE_BACKOFF_MS * 2 ** (live.reconnectAttempts - 1),
      MAX_BACKOFF_MS,
    );
    this.log.warn(
      { session: live.name, statusCode, attempt: live.reconnectAttempts, delayMs: delay },
      'queda transiente; reconectando com backoff',
    );

    if (live.reconnectTimer) clearTimeout(live.reconnectTimer);
    live.reconnectTimer = setTimeout(() => {
      live.reconnectTimer = null;
      if (live.stopping) return;
      this.openSocket(live).catch((err) =>
        this.log.error(
          { session: live.name, err: (err as Error).message },
          'falha ao reconectar',
        ),
      );
    }, delay);
    live.reconnectTimer.unref?.();
  }

  // ── Eventos -> webhooks ──────────────────────────────────────────────────

  private async onInboundMessage(live: LiveSession, msg: WAMessage): Promise<void> {
    const remoteJid = msg.key?.remoteJid ?? '';
    // Filtros por tipo de chat (config.ignore). Ver shouldIgnoreChat.
    if (shouldIgnoreChat(remoteJid, live.config)) return;

    // Mensagens proprias (enviadas pelo celular) sao repassadas: o backend decide o
    // que fazer com fromMe (hoje ignora no inbound, mas o evento e informacao real).
    const type = wahaTypeFromMessage(msg);

    // ★ Mensagem que o Baileys NAO conseguiu decifrar chega sem conteudo algum.
    // Emiti-la assim gera bolha VAZIA no chat (bug relatado: "mensagem enviada para
    // o cliente mas nao mostra a mensagem recebida" — o texto estava cifrado com uma
    // chave de sessao que nao tinhamos).
    //
    // O Baileys pede retry automaticamente (envia retry receipt) e a mensagem
    // costuma chegar DE NOVO, decifrada, em outro evento. Portanto: descartamos a
    // versao indecifravel em vez de persistir vazio — se o retry funcionar, a
    // mensagem boa aparece; se nao, e melhor nao ter bolha do que ter uma em branco.
    const semConteudo =
      type === 'unknown' && !extractBody(msg) && !this.media.isMediaType(type);
    if (semConteudo) {
      // ★ NAO e mais descarte silencioso.
      //
      // A versao anterior descartava apostando que "o retry chega decifrado". Os
      // logs do beta desmentiram: cada msgId aparecia DUAS vezes (original +
      // retry), ambas indecifraveis — a mensagem era PERDIDA e o operador nao
      // tinha como saber. Causa real: Bad MAC por sessao Signal dessincronizada,
      // que a Baileys 6.7.23 nao sabia recriar (sem suporte a LID).
      //
      // Agora: a 7.x recria a sessao sozinha (enableAutoSessionRecreation), e o
      // evento vai para o painel como ERRO — visivel, contavel, diagnosticavel.
      // Continuamos sem emitir a bolha vazia (nao ha conteudo a mostrar), mas a
      // perda deixou de ser invisivel.
      const fromLid = isLid(remoteJid);
      this.log.error(
        { session: live.name, msgId: msg.key?.id, remoteJid, fromLid },
        'mensagem NAO decifrada (Bad MAC / sessao Signal); perdida se o retry falhar',
      );
      events.emit(
        'error', live.name,
        'Mensagem não decifrada — o WhatsApp deve reenviar; se repetir, a sessão precisa ser repareada',
        { msgId: msg.key?.id, de: remoteJid }, 'error',
      );
      return;
    }

    // Reacao NAO e conversa: quem a trata e o evento dedicado `messages.reaction`
    // (onReaction). Se emitissemos aqui tambem, o Sysled receberia a reacao DUAS
    // vezes — uma como reacao e outra como bolha de mensagem (bug relatado:
    // "o reaction do consultor mostra para o cliente junto com uma mensagem").
    if (type === 'reaction') {
      this.log.debug(
        { session: live.name, msgId: msg.key?.id },
        'reacao ignorada no upsert (tratada em messages.reaction)',
      );
      return;
    }

    // Midia: baixar e servir por URL propria. O backend faz o download dessa URL
    // (com retry) e persiste no storage dele.
    let mediaUrl: string | null = null;
    if (this.media.isMediaType(type)) {
      mediaUrl = await this.media
        .download(live.sock, msg, live.name)
        .catch((err) => {
          this.log.warn(
            { session: live.name, err: (err as Error).message },
            'falha ao baixar midia; sigo com url null',
          );
          return null;
        });
    }

    // Aprende o par LID -> telefone quando o WhatsApp expoe os dois. E isso que
    // permite servir GET /api/{s}/lids/{lid}, de que o backend depende.
    await this.learnLid(live, msg);

    // ★ Telefone do remetente: o payload prefere key.senderPn. Quando a mensagem NAO
    // o traz (so o @lid), tentamos resolver AQUI — pelo mapa e, em ultimo caso, pelo
    // socket. Sem isso o contato nasce com o LID como numero.
    const isGroup = remoteJid.endsWith('@g.us');
    const lidToResolve = isGroup ? msg.key?.participant : remoteJid;
    let resolvedPhone: string | null = null;
    let resolvedName: string | null = null;
    if (!senderPhoneOf(msg) && isLid(lidToResolve)) {
      const lid = String(lidToResolve);
      const hit =
        (await this.resolveLid(live.name, lid)) ??
        (await this.resolveLidLive(live.name, lid));
      if (hit) {
        resolvedPhone = hit.phone;
        resolvedName = hit.pushName;
        this.log.info(
          { session: live.name, lid, phone: hit.phone },
          'LID resolvido para telefone',
        );
        events.emit('lid', live.name, `LID resolvido: ${hit.phone}`, { lid, phone: hit.phone });
      } else {
        // Vale um aviso: o contato vai nascer com o LID e o operador vera um
        // "numero" invalido. Melhor deixar rastro do que falhar em silencio.
        this.log.warn(
          { session: live.name, lid },
          'LID sem telefone conhecido — contato vai usar o LID',
        );
        events.emit(
          'error', live.name,
          'LID sem telefone: o contato vai aparecer com o id oculto',
          { lid }, 'warn',
        );
      }
    }

    // Nome: pushName da mensagem tem prioridade; senao o que aprendemos dos eventos
    // de contato (para o telefone efetivo).
    const effectivePhone = resolvedPhone ?? senderPhoneOf(msg);
    const nameFallback =
      resolvedName ??
      (effectivePhone ? this.contactName(live.name, effectivePhone) : null);

    const payload = buildMessagePayload(msg, {
      mediaUrl,
      overridePhone: resolvedPhone,
      nameFallback,
    });

    events.emit(
      msg.key?.fromMe ? 'outbound' : 'inbound',
      live.name,
      `${msg.key?.fromMe ? 'Enviada' : 'Recebida'}${isGroup ? ' (grupo)' : ''}: ${
        String(payload.body || `[${type}]`).slice(0, 60)
      }`,
      {
        de: payload.from,
        tipo: type,
        nome: payload.notifyName,
        ...(mediaUrl ? { midia: mediaUrl } : {}),
      },
    );

    await this.webhooks.emit(live.config?.webhooks, {
      event: 'message',
      session: live.name,
      payload,
    });
  }

  /**
   * Reação RECEBIDA (evento `messages.reaction` do Baileys).
   *
   * `key` é a mensagem que FOI reagida (o alvo); `reaction.key` identifica quem
   * reagiu. Texto vazio/ausente = a pessoa REMOVEU a reação.
   *
   * Emitimos como evento `message` com payload.reaction — o shape que o
   * waha-translate do backend converte em kind='reaction' para aplicar na
   * mensagem alvo em vez de criar bolha nova.
   */
  private async onReaction(
    live: LiveSession,
    ev: {
      key: WAMessage['key'];
      reaction?: { text?: string | null; key?: WAMessage['key'] | null };
    },
  ): Promise<void> {
    const targetId = ev.key?.id;
    if (!targetId) return;

    const emoji = ev.reaction?.text ?? '';
    // Quem reagiu: a key da reação (em grupo, o participante). Se ausente, assume
    // o mesmo chat da mensagem alvo.
    const authorKey = ev.reaction?.key ?? ev.key;
    const remoteJid = authorKey?.remoteJid ?? ev.key?.remoteJid ?? '';
    const isGroup = remoteJid.endsWith('@g.us');

    // Telefone real de quem reagiu, resolvendo @lid quando possível — senão o
    // backend não casa o contato e a reação viraria "external".
    const fake = { key: authorKey ?? {}, message: {} } as unknown as WAMessage;
    let phone = senderPhoneOf(fake);
    const lid = isGroup ? authorKey?.participant : remoteJid;
    if (!phone && isLid(lid)) {
      const hit =
        (await this.resolveLid(live.name, String(lid))) ??
        (await this.resolveLidLive(live.name, String(lid)));
      phone = hit?.phone ?? null;
    }

    const from = phone ? `${phone}@c.us` : toWahaChatId(remoteJid);

    this.log.info(
      { session: live.name, targetId, emoji: emoji || '(removida)', from },
      'reacao recebida',
    );
    events.emit(
      'reaction', live.name,
      emoji ? `Reagiu ${emoji}` : 'Removeu a reacao',
      { de: from, msgAlvo: targetId },
    );

    await this.webhooks.emit(live.config?.webhooks, {
      event: 'message',
      session: live.name,
      payload: {
        // ★ id da PRÓPRIA reação, não do alvo.
        //
        // No Baileys, `reaction.key` é a mensagem DA REAÇÃO e `ev.key` é o ALVO
        // (process-message.js:411-421). Usar o do alvo fazia o id colidir com a
        // mensagem original — e entre reações sucessivas do mesmo contato, porque
        // trocar 👍 por ❤ mantém o mesmo alvo. Como o consumidor trata esse campo
        // como chave de idempotência (evolution_msg_id é UNIQUE), a troca de
        // reação era descartada ou sobrescrevia a mensagem.
        id: serializeMsgId(authorKey ?? ev.key),
        from: isGroup ? toWahaChatId(remoteJid) : from,
        // Em grupo, quem reagiu. Quando o telefone não é conhecido mandamos o
        // @lid mesmo (preservado por toWahaChatId) em vez de OMITIR o campo:
        // omitir fazia a reação chegar sem autor, e o backend não tinha como
        // saber quem reagiu — pior que receber um id que ele sabe resolver.
        ...(isGroup && (phone || authorKey?.participant)
          ? {
              participant: phone
                ? `${phone}@c.us`
                : toWahaChatId(String(authorKey?.participant)),
            }
          : {}),
        fromMe: !!authorKey?.fromMe,
        type: 'reaction',
        body: emoji,
        reaction: {
          text: emoji, // vazio = remoção
          messageId: targetId,
          fromMe: !!ev.key?.fromMe, // fromMe do ALVO: a msg reagida é nossa?
        },
      },
    });
  }

  private async onMessageUpdate(
    live: LiveSession,
    u: { key: WAMessage['key']; update: Partial<WAMessage> },
  ): Promise<void> {
    const status = u.update?.status;
    if (status === null || status === undefined) return;
    await this.emitAck(live, u.key, baileysStatusToWahaAck(Number(status)));
  }

  /**
   * Recibo de entrega/leitura das mensagens que NÓS enviamos.
   *
   * O Baileys entrega isso em `message-receipt.update` — NÃO em `messages.update`.
   * Escutar só o segundo era o bug: toda mensagem enviada ficava presa em 'sent'
   * (um tique) e a UI do Sysled mostrava ícone de falha mesmo após a entrega.
   *
   * Mapeamento dos timestamps para a escala de ack do WAHA:
   *   playedTimestamp  -> 3 (read)      áudio ouvido
   *   readTimestamp    -> 3 (read)      dois tiques azuis
   *   receiptTimestamp -> 2 (delivered) dois tiques
   */
  private async onReceiptUpdate(
    live: LiveSession,
    u: {
      key: WAMessage['key'];
      // Os timestamps podem vir como number ou Long (protobuf). Só checamos
      // presença/verdade, então `unknown` basta e evita depender do tipo Long.
      receipt?: {
        receiptTimestamp?: unknown;
        readTimestamp?: unknown;
        playedTimestamp?: unknown;
      };
    },
  ): Promise<void> {
    const r = u.receipt;
    if (!r) return;

    // Do mais avançado para o menos: um recibo pode trazer vários timestamps.
    const ack = r.playedTimestamp ? 3 : r.readTimestamp ? 3 : r.receiptTimestamp ? 2 : null;
    if (ack === null) return;

    await this.emitAck(live, u.key, ack);
  }

  /**
   * msgId como foi devolvido no ENVIO, buscado pelo id cru.
   *
   * Existe porque o endereçamento divergе entre envio (@c.us) e recibo (@lid): sem
   * isso o ack sai com um id que o backend não reconhece. Só considera linhas com
   * `content` (gravadas pelo caminho de envio), para não devolver o próprio id do
   * ack que uma emissão anterior tenha inserido.
   */
  private async originalMsgId(session: string, rawId: string): Promise<string | null> {
    const res = await this.pool
      .query<{ msg_id: string }>(
        `SELECT msg_id FROM wa_gateway.sent_messages
          WHERE session_name = $1 AND msg_id LIKE '%' || $2 AND content IS NOT NULL
          ORDER BY created_at ASC LIMIT 1`,
        [session, `_${rawId}`],
      )
      .catch(() => ({ rows: [] as { msg_id: string }[] }));
    return res.rows[0]?.msg_id ?? null;
  }

  /**
   * Emite `message.ack` com guarda de idempotência. Compartilhado por
   * messages.update e message-receipt.update.
   */
  private async emitAck(
    live: LiveSession,
    key: WAMessage['key'] | undefined,
    ack: number,
  ): Promise<void> {
    const chatId = key?.remoteJid ?? '';
    const rawId = key?.id ?? '';
    if (!rawId) return;

    // ★ O msgId do ACK precisa ser IDÊNTICO ao devolvido no envio, senão o backend
    // não casa a mensagem e ela fica presa em 'sent' (um tique) para sempre.
    //
    // O WhatsApp endereça o MESMO contato de duas formas: o envio vai pelo telefone
    // (@c.us) mas o recibo volta pelo @lid do dispositivo. O applyAck do backend
    // compara por IGUALDADE (evolution_msg_id = ANY(...)), então
    //   gravado:  true_5516997355492@c.us_3EB06441...
    //   ack:      true_207919433941235@lid_3EB06441...
    // nunca casavam — confirmado no banco do beta.
    //
    // Solução: recuperar o msgId REAL do envio pelo id cru (único componente estável)
    // e emitir o ack com ele. Fallback para o formato local quando não conhecemos a
    // mensagem (ex.: enviada antes deste fix, ou ack de mensagem recebida).
    const localMsgId = `${key?.fromMe ? 'true' : 'false'}_${toWahaChatId(chatId)}_${rawId}`;
    const msgId = (await this.originalMsgId(live.name, rawId)) ?? localMsgId;

    // Idempotencia: o WhatsApp reenvia acks, e um ack ANTIGO chegando depois de um
    // novo faria o status regredir no backend. So emitimos quando AVANCA.
    //
    // ATENCAO ao ack -1 (failed): ele e MENOR que todos os outros na escala, entao um
    // "> last_ack" ingenuo o descartaria — a mensagem tinha ido a 'sent' e a falha
    // posterior nunca chegaria ao backend (consultor veria msg como enviada sem ter
    // sido). Failed e um ESTADO TERMINAL, nao um retrocesso: passa sempre, exceto
    // repeticao do proprio failed. O backend tem a guarda simetrica: delivered/read
    // vencem failed, e failed so sobrescreve sent/NULL (webhooks/waha.js:172-174).
    const isFailed = ack < 0;
    const res = await this.pool.query<{ last_ack: number }>(
      `INSERT INTO wa_gateway.sent_messages (session_name, msg_id, chat_id, last_ack)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_name, msg_id) DO UPDATE
         SET last_ack = EXCLUDED.last_ack, updated_at = NOW()
         WHERE ${isFailed
           ? 'wa_gateway.sent_messages.last_ack >= 0'
           : 'EXCLUDED.last_ack > wa_gateway.sent_messages.last_ack'}
       RETURNING last_ack`,
      [live.name, msgId, toWahaChatId(chatId), ack],
    );
    // Zero linhas = ack repetido ou regressivo; nao emite.
    if (!res.rows.length) return;

    this.log.debug({ session: live.name, msgId, ack }, 'emitindo message.ack');
    const ackLabel = { [-1]:'falhou', 0:'pendente', 1:'enviada', 2:'entregue', 3:'lida' }[ack] ?? String(ack);
    events.emit('ack', live.name, `ACK: ${ackLabel}`, { msgId, ack }, ack < 0 ? 'warn' : 'info');
    await this.webhooks.emit(live.config?.webhooks, {
      event: 'message.ack',
      session: live.name,
      payload: buildAckPayload({ msgId, chatId, ack, fromMe: !!key?.fromMe }),
    });
  }

  /**
   * Guarda o par (lid, telefone) visto em mensagem, para servir /lids/{lid}.
   *
   * ★ CAMPOS CORRETOS DO BAILEYS (6.7.x): o `WAMessageKey` expõe
   *     senderLid / senderPn            (1:1  — Pn = phone number)
   *     participantLid / participantPn  (grupo)
   *   A primeira versão deste método leu `remoteJidAlt`/`participantAlt`, que NÃO
   *   existem — o mapa ficava vazio, o /lids/{lid} devolvia 404 e o contato nascia
   *   com o LID no lugar do telefone (nome errado + conversa duplicada a cada
   *   resposta). Ver src/core/lid.ts para a extração e os testes.
   */
  private async learnLid(live: LiveSession, msg: WAMessage): Promise<void> {
    for (const pair of extractLidPairs(msg)) {
      await this.rememberLid(live.name, pair.lid, pair.phone, pair.pushName);
    }
  }

  /** Persiste um par LID→telefone (idempotente). */
  async rememberLid(
    session: string,
    lid: string,
    phone: string,
    pushName?: string | null,
  ): Promise<void> {
    if (!lid || !phone) return;
    await this.pool
      .query(
        `INSERT INTO wa_gateway.lid_map (session_name, lid, phone, push_name, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (session_name, lid) DO UPDATE
           SET phone = EXCLUDED.phone,
               push_name = COALESCE(EXCLUDED.push_name, wa_gateway.lid_map.push_name),
               updated_at = NOW()`,
        [session, lid, phone, pushName ?? null],
      )
      .catch((err) => {
        // Aprendizado best-effort: não pode derrubar a mensagem. Mas LOGAMOS —
        // falha silenciosa aqui foi o que escondeu o bug original.
        this.log.warn(
          { session, lid, err: (err as Error).message },
          'falha ao gravar lid_map',
        );
      });
  }

  /** Resolve LID -> telefone para GET /api/{s}/lids/{lid}. */
  async resolveLid(session: string, lid: string): Promise<{ phone: string; pushName: string | null } | null> {
    const res = await this.pool.query<{ phone: string; push_name: string | null }>(
      `SELECT phone, push_name FROM wa_gateway.lid_map
        WHERE session_name = $1 AND lid = $2`,
      [session, lid],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { phone: row.phone, pushName: row.push_name };
  }

  /**
   * Resolve LID pelo socket, quando o mapa ainda não o conhece. `onWhatsApp` devolve
   * `{ jid, lid }`, então dá para casar os dois lados sob demanda — sem isso, um LID
   * nunca visto antes ficaria eternamente sem telefone.
   */
  async resolveLidLive(session: string, lid: string): Promise<{ phone: string; pushName: string | null } | null> {
    const live = this.sessions.get(session);
    if (!live?.sock || live.status !== 'WORKING') return null;
    try {
      // O WhatsApp aceita consultar pelo próprio LID; a resposta traz o jid real.
      const res = await live.sock.onWhatsApp(lid);
      const hit = res?.[0] as { jid?: string; lid?: string; exists?: boolean } | undefined;
      const phone = phoneFromJid(hit?.jid);
      if (!phone) return null;
      const pushName = this.contactNames.get(`${session}:${phone}`) ?? null;
      await this.rememberLid(session, lid, phone, pushName);
      return { phone, pushName };
    } catch (err) {
      this.log.debug(
        { session, lid, err: (err as Error).message },
        'resolveLidLive falhou',
      );
      return null;
    }
  }

  /** Nome conhecido do contato (dos eventos de contato), por telefone. */
  contactName(session: string, phone: string): string | null {
    return this.contactNames.get(`${session}:${phone}`) ?? null;
  }

  /**
   * Guarda o conteúdo de uma mensagem ENVIADA, para poder reenviá-la quando o
   * dispositivo do destinatário pedir retry (ver getMessage no openSocket).
   *
   * Sem isso, um contato cujo celular não conseguiu decifrar fica preso em
   * "Aguardando mensagem" — a mensagem aparece no WhatsApp Web dele mas nunca no app.
   */
  async rememberSentMessage(
    session: string,
    key: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null },
    content: unknown,
  ): Promise<void> {
    const raw = key?.id;
    if (!raw || !content) return;
    const chatId = toWahaChatId(key.remoteJid ?? '');
    const msgId = `${key.fromMe ? 'true' : 'false'}_${chatId}_${raw}`;
    await this.pool
      .query(
        `INSERT INTO wa_gateway.sent_messages (session_name, msg_id, chat_id, last_ack, content)
         VALUES ($1, $2, $3, 0, $4::jsonb)
         ON CONFLICT (session_name, msg_id) DO UPDATE
           SET content = EXCLUDED.content, updated_at = NOW()`,
        [session, msgId, chatId, JSON.stringify(content, BufferJSON.replacer)],
      )
      .catch((err) => {
        // Não pode derrubar o envio — a mensagem já foi. Mas logamos: sem o
        // conteúdo guardado, um retry receipt não terá resposta.
        this.log.warn(
          { session, msgId, err: (err as Error).message },
          'falha ao guardar conteudo da mensagem enviada (retry ficara sem resposta)',
        );
      });
  }

  /**
   * Recupera o conteúdo (proto.IMessage) de uma mensagem que NÓS enviamos.
   *
   * Usado por encaminhar e reenviar. Busca pelo ID CRU, pelo mesmo motivo do
   * getMessage: o mesmo id é gravado com chatIds diferentes (@c.us no envio,
   * @lid no recibo), e o id cru é o único componente estável entre os dois.
   *
   * LIMITE HONESTO: só existe para mensagens ENVIADAS por este gateway, e apenas
   * dentro da janela de retenção (SENT_MESSAGES_RETENTION_DAYS, 7 por padrão).
   * Mensagem recebida de um contato nunca esteve aqui — para encaminhá-la, quem
   * chama precisa fornecer o conteúdo.
   */
  async getStoredMessage(
    session: string,
    msgIdOrRaw: string,
  ): Promise<{ content: unknown; chatId: string; rawId: string } | null> {
    const raw = String(msgIdOrRaw).split('_').pop() ?? '';
    if (!raw) return null;
    const res = await this.pool.query<{ content: unknown; chat_id: string }>(
      `SELECT content, chat_id FROM wa_gateway.sent_messages
        WHERE session_name = $1
          AND msg_id LIKE '%' || $2
          AND content IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1`,
      [session, `_${raw}`],
    );
    const row = res.rows[0];
    if (!row?.content) return null;
    // BufferJSON.reviver reconstrói os Buffers (chaves de mídia etc.) — sem isso
    // o proto vai com objetos {type:'Buffer'} e o WhatsApp rejeita.
    return {
      content: JSON.parse(JSON.stringify(row.content), BufferJSON.reviver),
      chatId: row.chat_id,
      rawId: raw,
    };
  }

  /**
   * URL da foto de perfil do contato. Equivale ao
   * `chat/fetchProfilePictureUrl` da Evolution e ao `/contacts/profile-picture`
   * do WAHA — o Sysled usa isso para o avatar do contato (jobs/avatar-sync.js).
   *
   * A URL é do CDN do WhatsApp e expira; quem consome deve baixar, não guardar.
   * `null` quando o contato não tem foto ou restringiu por privacidade.
   */
  async profilePictureUrl(session: string, jidOrPhone: string): Promise<string | null> {
    const live = this.sessions.get(session);
    if (!live?.sock || live.status !== 'WORKING') return null;
    // Aceita telefone cru, @c.us, @lid ou @g.us.
    const target = jidOrPhone.includes('@')
      ? toBaileysJid(jidOrPhone)
      : `${jidOrPhone.replace(/\D/g, '')}@s.whatsapp.net`;
    try {
      // 'image' = foto em alta; 'preview' seria o thumbnail.
      const url = await live.sock.profilePictureUrl(target, 'image');
      return url ?? null;
    } catch (err) {
      // 404/403 do WhatsApp = sem foto ou privacidade. Não é erro operacional.
      this.log.debug(
        { session, target, err: (err as Error).message },
        'sem foto de perfil',
      );
      return null;
    }
  }

  // ── Status + throttle ────────────────────────────────────────────────────

  private async setStatus(live: LiveSession, status: WahaSessionStatus): Promise<void> {
    const changed = live.status !== status;
    live.status = status;

    await this.pool
      .query(`UPDATE wa_gateway.sessions SET status=$2, updated_at=NOW() WHERE name=$1`, [
        live.name,
        status,
      ])
      .catch(() => {});

    // Throttle: status IGUAL ao ultimo emitido dentro da janela e suprimido. Isso
    // mata a tempestade de SCAN_QR_CODE a cada refresh de QR (~20s) que o backend
    // documenta como problema real do WAHA.
    const now = Date.now();
    const withinWindow = now - live.lastEmittedAt < config.sessionStatusThrottleMs;
    if (!changed && withinWindow) return;

    live.lastEmittedStatus = status;
    live.lastEmittedAt = now;

    events.emit(
      'session',
      live.name,
      `Status: ${status}`,
      { status, me: live.meId },
      status === 'WORKING' ? 'info' : status === 'STARTING' ? 'info' : 'warn',
    );

    await this.webhooks.emit(live.config?.webhooks, {
      event: 'session.status',
      session: live.name,
      payload: buildSessionStatusPayload(live.name, status),
    });
  }

  /** Encerra todos os sockets (shutdown gracioso). */
  async shutdown(): Promise<void> {
    // ★ ESPERA os sockets fecharem antes de devolver.
    //
    // `end()` do Baileys e async. A versao anterior descartava o retorno e limpava
    // o mapa na hora, entao o server.ts seguia para `pool.end()` com gravacoes de
    // creds/chaves Signal ainda em voo — que tomavam erro de pool encerrado. Uma
    // escrita de chave interrompida no meio deixa exatamente o estado parcial que
    // o proximo boot descobre como "Bad MAC".
    const nomes = [...this.sessions.keys()];
    const fechamentos: Array<Promise<unknown>> = [];
    for (const live of this.sessions.values()) {
      live.stopping = true;
      // Invalida a geracao: qualquer handler pendente para de mexer no estado.
      live.generation += 1;
      if (live.reconnectTimer) clearTimeout(live.reconnectTimer);
      const sock = live.sock;
      live.sock = null;
      if (!sock) continue;
      fechamentos.push(
        (async () => {
          try {
            await sock.end(undefined);
          } catch {
            /* socket ja morto */
          }
        })(),
      );
    }

    // Teto de tempo: um socket travado nao pode impedir o encerramento (o
    // orquestrador manda SIGKILL depois do periodo de graca).
    await Promise.race([
      Promise.allSettled(fechamentos),
      new Promise((r) => setTimeout(r, 5_000).unref?.()),
    ]);

    // Status honesto no banco: sem isto o processo morre e as linhas ficam
    // WORKING, fazendo o painel e o backend mentirem ate o proximo boot.
    if (nomes.length) {
      await this.pool
        .query(
          `UPDATE wa_gateway.sessions SET status='STOPPED', updated_at=NOW()
            WHERE name = ANY($1::text[]) AND status <> 'STOPPED'`,
          [nomes],
        )
        .catch((err) =>
          this.log.warn({ err: (err as Error).message }, 'falha ao marcar sessoes como STOPPED'),
        );
    }
    this.sessions.clear();
  }
}
