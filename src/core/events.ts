// src/core/events.ts
//
// Barramento de eventos em memória para o painel de diagnóstico.
//
// Existe para tirar do SSH o trabalho de "ler o log para descobrir por que a
// mensagem não chegou". Tudo que hoje aparece em `docker logs` — mensagem
// entrando, ACK progredindo, LID resolvido, falha de decrypt — passa por aqui e
// fica visível no painel em tempo real.
//
// Deliberadamente EM MEMÓRIA (ring buffer), não no Postgres:
//   - é dado de diagnóstico, não de negócio: perder no restart é aceitável
//   - gravar cada evento no banco somaria uma escrita por mensagem, no caminho
//     mais quente do sistema
//   - o buffer limitado impede crescimento infinito sem precisar de limpeza

export type EventKind =
  | 'inbound'      // mensagem recebida
  | 'outbound'     // mensagem enviada pela API
  | 'ack'          // recibo de entrega/leitura
  | 'reaction'
  | 'session'      // mudança de status da sessão
  | 'lid'          // LID resolvido para telefone
  | 'webhook'      // entrega de webhook (sucesso/falha)
  | 'error'        // falha relevante (decrypt, envio, etc)
  | 'media';       // download de mídia

export interface GatewayEvent {
  /** Sequencial monotônico: o cliente usa para não reprocessar o que já viu. */
  seq: number;
  ts: number;
  kind: EventKind;
  session: string | null;
  /** Resumo em uma linha, pronto para exibir. */
  message: string;
  /** Campos extras (telefone, msgId, ack…) — exibidos como detalhe. */
  detail?: Record<string, unknown>;
  level: 'info' | 'warn' | 'error';
}

type Listener = (ev: GatewayEvent) => void;

const MAX_BUFFER = 500;

class EventBus {
  private buffer: GatewayEvent[] = [];
  private listeners = new Set<Listener>();
  private seq = 0;

  emit(
    kind: EventKind,
    session: string | null,
    message: string,
    detail?: Record<string, unknown>,
    level: GatewayEvent['level'] = 'info',
  ): void {
    // O timestamp vem de Date.now() aqui de propósito: é dado de observação, não
    // entra em nenhuma decisão de negócio nem em teste determinístico.
    const ev: GatewayEvent = {
      seq: ++this.seq,
      ts: Date.now(),
      kind,
      session,
      message,
      level,
      ...(detail ? { detail } : {}),
    };

    this.buffer.push(ev);
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();

    for (const l of this.listeners) {
      // Um listener lento/quebrado (cliente SSE caindo) não pode derrubar o
      // caminho de mensagem — daí o try isolado por listener.
      try {
        l(ev);
      } catch {
        /* ignorado */
      }
    }
  }

  /** Eventos já acumulados, opcionalmente só os posteriores a `afterSeq`. */
  recent(afterSeq = 0, limit = MAX_BUFFER): GatewayEvent[] {
    return this.buffer.filter((e) => e.seq > afterSeq).slice(-limit);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

export const events = new EventBus();
