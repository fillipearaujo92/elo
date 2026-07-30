// src/core/webhook.ts
//
// Emissor de webhooks no formato WAHA. O consumidor e POST /webhook/waha do backend
// (sysled-chat-typescript/backend/webhooks/waha.js), que:
//   1. exige `session` no corpo (401 sem isso);
//   2. exige o header X-Webhook-Key igual a waha.api_key (fail-closed 401);
//   3. passa o corpo inteiro por translateWahaEvent().
//
// Entrega: retry com backoff. O backend responde 200 rapido e processa async, mas
// pode estar reiniciando (deploy) — perder uma mensagem inbound e inaceitavel, e o
// WAHA real tambem faz retry (o driver configura retries: 15x/2s, ver waha.js:196).

import type { Logger } from 'pino';
import { events } from './events.js';

export interface WebhookConfig {
  url: string;
  events?: string[];
  customHeaders?: Array<{ name: string; value: string }> | null;
  retries?: { attempts?: number; delaySeconds?: number; policy?: string } | null;
}

export interface WahaEvent {
  event: 'message' | 'message.ack' | 'session.status';
  session: string;
  payload: Record<string, unknown>;
}

const DEFAULT_ATTEMPTS = 15;
const DEFAULT_DELAY_SECONDS = 2;

export class WebhookEmitter {
  constructor(
    private readonly log: Logger,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly sleepFn: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  /**
   * Envia o evento para todos os webhooks configurados que assinam esse evento.
   * Nao lanca: falha de webhook nao pode derrubar o processamento da mensagem.
   */
  async emit(webhooks: WebhookConfig[] | undefined, event: WahaEvent): Promise<void> {
    if (!webhooks?.length) return;
    await Promise.all(
      webhooks
        .filter((w) => w?.url && this.subscribes(w, event.event))
        .map((w) => this.deliver(w, event)),
    );
  }

  // events ausente/vazio = assina TODOS (comportamento do WAHA). O driver do backend
  // sempre manda ['message','message.ack','session.status'] explicitamente.
  private subscribes(w: WebhookConfig, event: string): boolean {
    if (!w.events?.length) return true;
    return w.events.includes(event) || w.events.includes('*');
  }

  private async deliver(w: WebhookConfig, event: WahaEvent): Promise<void> {
    const attempts = w.retries?.attempts ?? DEFAULT_ATTEMPTS;
    const delayMs = (w.retries?.delaySeconds ?? DEFAULT_DELAY_SECONDS) * 1000;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // customHeaders e o mecanismo pelo qual o backend recebe X-Webhook-Key. Sem
    // isso, TODA mensagem inbound toma 401 e desaparece silenciosamente — bug ja
    // vivido em producao com o WAHA (documentado em waha.js:188-191).
    for (const h of w.customHeaders ?? []) {
      if (h?.name) headers[h.name] = h.value ?? '';
    }

    const body = JSON.stringify(event);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await this.fetchFn(w.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(20_000),
        });
        if (res.ok) {
          if (attempt > 1) {
            events.emit(
              'webhook', event.session,
              `Webhook entregue na tentativa ${attempt}`,
              { evento: event.event }, 'warn',
            );
          }
          return;
        }

        // 4xx (exceto 429) e erro de contrato/auth: retentar nao resolve e so
        // enfileira lixo. 401 aqui quase sempre significa customHeaders errado.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.log.error(
            { event: event.event, session: event.session, status: res.status, url: w.url },
            'webhook rejeitado com erro de cliente; nao vou retentar',
          );
          events.emit(
            'webhook', event.session,
            `Webhook REJEITADO (HTTP ${res.status}) — evento perdido`,
            { evento: event.event, url: w.url, dica: res.status === 401 ? 'chave do webhook nao casa' : undefined },
            'error',
          );
          return;
        }
        this.log.warn(
          { event: event.event, status: res.status, attempt, attempts },
          'webhook falhou; vou retentar',
        );
      } catch (err) {
        this.log.warn(
          { event: event.event, attempt, attempts, err: (err as Error).message },
          'webhook erro de rede; vou retentar',
        );
      }

      if (attempt < attempts) await this.sleepFn(delayMs);
    }

    this.log.error(
      { event: event.event, session: event.session, url: w.url, attempts },
      'webhook esgotou tentativas; evento PERDIDO',
    );
    events.emit(
      'webhook', event.session,
      `Webhook falhou ${attempts}x — evento PERDIDO`,
      { evento: event.event, url: w.url }, 'error',
    );
  }
}
