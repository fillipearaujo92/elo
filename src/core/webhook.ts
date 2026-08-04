// src/core/webhook.ts
//
// Emissor de webhooks no dialeto do WAHA — o ELO fala esse formato para poder ser
// instalado NO LUGAR do WAHA, sem que o sistema consumidor precise de um driver novo.
//
// ── O contrato, do lado de quem recebe ────────────────────────────────────
// O ELO faz POST com o corpo `{ event, session, payload }` para cada URL configurada
// em `config.webhooks[]` da sessao. O receptor precisa apenas:
//   1. responder 2xx rapido (o processamento pesado deve ser assincrono);
//   2. aceitar os headers de `customHeaders`, se a sessao definir algum — e por ali que
//      passa a chave de webhook, que o receptor usa para autenticar a chamada.
//
// Nada aqui presume QUAL sistema esta do outro lado: o ELO e um servico independente,
// instalado como a Evolution ou o WAHA, e serve qualquer chat omnichannel que aceite
// esse formato.
//
// Entrega: retry com atraso fixo. O receptor pode estar reiniciando (deploy), e perder
// mensagem inbound e inaceitavel — o WAHA real tambem retenta. Defaults abaixo; a sessao
// pode sobrescrever em `retries`.

import type { Logger } from 'pino';
import { events } from './events.js';
import { inc } from './metrics.js';
import { fetchGuardado } from './net-guard.js';

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

/**
 * URL segura para log e para o painel: sem credencial, sem query string.
 *
 * ★ Vazamento CONCRETO que isto corrige: os logs deste arquivo traziam a URL CRUA da
 * config em quatro pontos. Webhook com token na query (`?token=abc`) ou com credencial
 * embutida (`https://user:senha@host/hook`) — os dois padroes comuns — iam para o log
 * em texto puro, e o log e o lugar menos protegido de uma instalacao: vai para
 * arquivo, journald e qualquer coletor.
 *
 * Sanitizar na ORIGEM em vez de confiar no `redact` do pino: o redact depende de o
 * path bater exatamente, e um `url` na raiz do objeto exigiria censurar `url`
 * generico — o que apagaria tambem `req.url` do log de acesso e cegaria o
 * diagnostico. Medido com pino real antes de decidir.
 *
 * Mantem origem e caminho, que e o que o operador precisa para saber QUAL webhook
 * falhou. `[credencial]` explicito em vez de remover, para o log dizer que havia algo
 * ali — campo que desaparece parece bug de instrumentacao.
 */
export function urlSegura(bruta: string): string {
  try {
    const u = new URL(bruta);
    const cred = u.username || u.password ? '[credencial]@' : '';
    const q = u.search ? '?[oculto]' : '';
    return `${u.protocol}//${cred}${u.host}${u.pathname}${q}`;
  } catch {
    // URL invalida nao deve aparecer no log de forma alguma: se nao consigo parsear,
    // nao consigo garantir que nao ha segredo dentro.
    return '[url invalida]';
  }
}

export class WebhookEmitter {
  constructor(
    private readonly log: Logger,
    // ★ Default `fetchGuardado`, nao `fetch`: a URL do webhook vem da config da
    // sessao, ou seja, do cliente da API. Sem a guarda, configurar um webhook para
    // `http://169.254.169.254/...` fazia o gateway bater na metadata da instancia a
    // cada mensagem recebida — e o retry (15 tentativas) transformava isso num
    // scanner persistente. Os testes injetam o proprio fake e nao passam por aqui.
    private readonly fetchFn: typeof fetch = fetchGuardado,
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

  // events ausente/vazio = assina TODOS (comportamento do WAHA). O driver de quem consome
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
    // vivido em producao com o WAHA (documentado no driver de quem consome).
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
          inc('webhook_ok_total', event.session);
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
            { event: event.event, session: event.session, status: res.status, url: urlSegura(w.url) },
            'webhook rejeitado com erro de cliente; nao vou retentar',
          );
          inc('webhook_rejected_total', event.session);
          events.emit(
            'webhook', event.session,
            `Webhook REJEITADO (HTTP ${res.status}) — evento perdido`,
            { evento: event.event, url: urlSegura(w.url), dica: res.status === 401 ? 'chave do webhook nao casa' : undefined },
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
      { event: event.event, session: event.session, url: urlSegura(w.url), attempts },
      'webhook esgotou tentativas; evento PERDIDO',
    );
    // ★ Evento PERDIDO: mensagem que chegou do WhatsApp e nunca alcancou o
    // consumidor. Junto com inbound_undecryptable_total, sao os dois contadores
    // que respondem "estou perdendo mensagem?" — a pergunta que importa.
    inc('webhook_lost_total', event.session);
    events.emit(
      'webhook', event.session,
      `Webhook falhou ${attempts}x — evento PERDIDO`,
      { evento: event.event, url: urlSegura(w.url) }, 'error',
    );
  }
}
