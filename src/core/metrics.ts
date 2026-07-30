// src/core/metrics.ts
//
// Contadores em memória + exposição no formato Prometheus.
//
// ── Por que isto existe ────────────────────────────────────────────────────
// O bug que derrubou o inbound (Bad MAC por endereçamento LID) foi descoberto
// porque alguém MANDOU UMA MENSAGEM e percebeu que não chegou. O gateway sabia
// do problema — havia 4 descartes registrados no log — e não avisou ninguém.
//
// A lição não é "faltava um log", é: sem métrica agregada, falha silenciosa só
// aparece quando um humano tropeça nela. Um contador de "mensagens não
// decifradas" com valor > 0 teria apontado a causa no primeiro minuto.
//
// Escolhas deliberadas:
//
//   - EM MEMÓRIA, não no banco. Métrica é sinal operacional, não dado de
//     negócio; perder no restart é aceitável e evita escrita a cada mensagem no
//     caminho mais quente do sistema.
//   - Cardinalidade CONTROLADA: rótulo apenas por sessão. Rótulo por telefone ou
//     por id de mensagem explodiria a série temporal — é o erro clássico que
//     derruba o Prometheus de quem instrumenta pela primeira vez.
//   - Sem dependência: o formato de exposição é texto simples e estável. Puxar
//     um cliente Prometheus para 8 contadores seria peso morto.

/** Nomes dos contadores. Um enum fechado evita rótulo digitado errado virar série nova. */
export type CounterName =
  /** Mensagens recebidas e repassadas com sucesso. */
  | 'inbound_total'
  /** ★ Mensagens que o Baileys NÃO conseguiu decifrar (Bad MAC / sessão Signal). */
  | 'inbound_undecryptable_total'
  /** Mensagens descartadas por filtro de chat (grupo, status, canal, transmissão). */
  | 'inbound_filtered_total'
  /** Mensagens enviadas com sucesso (o WhatsApp devolveu id). */
  | 'outbound_total'
  /** Envios que falharam antes de sair. */
  | 'outbound_error_total'
  /** ACK de FALHA recebido (ack -1): a mensagem saiu e não foi entregue. */
  | 'ack_failed_total'
  /** ACKs de entrega e leitura. */
  | 'ack_delivered_total'
  | 'ack_read_total'
  /** Webhook entregue ao destino. */
  | 'webhook_ok_total'
  /** Webhook que esgotou as tentativas — EVENTO PERDIDO. */
  | 'webhook_lost_total'
  /** Webhook rejeitado com 4xx (contrato/auth errados). */
  | 'webhook_rejected_total'
  /** Quedas de conexão e reconexões iniciadas. */
  | 'disconnect_total'
  | 'reconnect_total'
  /** QR gerado (útil para ver sessão em loop de pareamento). */
  | 'qr_total';

const HELP: Record<CounterName, string> = {
  inbound_total: 'Mensagens recebidas e repassadas',
  inbound_undecryptable_total:
    'Mensagens NAO decifradas (Bad MAC/sessao Signal) - valor > 0 indica perda de mensagem',
  inbound_filtered_total: 'Mensagens descartadas por filtro de tipo de chat',
  outbound_total: 'Mensagens enviadas com sucesso',
  outbound_error_total: 'Falhas de envio antes de sair do gateway',
  ack_failed_total: 'ACK de falha (-1): mensagem saiu e nao foi entregue',
  ack_delivered_total: 'ACK de entrega',
  ack_read_total: 'ACK de leitura',
  webhook_ok_total: 'Webhooks entregues ao destino',
  webhook_lost_total: 'Webhooks que esgotaram as tentativas - EVENTO PERDIDO',
  webhook_rejected_total: 'Webhooks rejeitados com 4xx (contrato ou chave errados)',
  disconnect_total: 'Quedas de conexao',
  reconnect_total: 'Reconexoes iniciadas',
  qr_total: 'QR codes gerados',
};

/** contador -> sessão -> valor. */
const counters = new Map<CounterName, Map<string, number>>();

/** Início do processo, para expor uptime. */
const bootedAt = Date.now();

export function inc(name: CounterName, session: string, by = 1): void {
  let porSessao = counters.get(name);
  if (!porSessao) {
    porSessao = new Map();
    counters.set(name, porSessao);
  }
  porSessao.set(session, (porSessao.get(session) ?? 0) + by);
}

/** Zera tudo (usado nos testes). */
export function resetMetrics(): void {
  counters.clear();
}

/**
 * Esquece os contadores de uma sessão removida.
 *
 * Sem isto, cada sessão apagada deixava até 14 séries residuais para sempre: o
 * /metrics seguiria emitindo dados de canal que não existe mais, o Prometheus as
 * manteria como séries ativas, e o nome do cliente continuaria exposto depois da
 * exclusão — contrariando o motivo pelo qual o endpoint pede autenticação.
 */
export function forgetSession(session: string): void {
  for (const porSessao of counters.values()) porSessao.delete(session);
}

/** Leitura de um contador — para o painel e os testes. */
export function get(name: CounterName, session?: string): number {
  const porSessao = counters.get(name);
  if (!porSessao) return 0;
  if (session !== undefined) return porSessao.get(session) ?? 0;
  let total = 0;
  for (const v of porSessao.values()) total += v;
  return total;
}

/** Snapshot por sessão, no formato que o painel consome. */
export function snapshot(): Record<string, Partial<Record<CounterName, number>>> {
  const out: Record<string, Partial<Record<CounterName, number>>> = {};
  for (const [name, porSessao] of counters) {
    for (const [session, valor] of porSessao) {
      (out[session] ??= {})[name] = valor;
    }
  }
  return out;
}

/** Escapa o valor de um rótulo (nome de sessão é livre: pode ter aspas e acento). */
function escLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/**
 * Exposição no formato de texto do Prometheus.
 *
 * Inclui um gauge de estado por sessão (`elo_session_up`) além dos contadores:
 * é o que permite alertar "sessão caída há mais de 5 minutos" sem precisar
 * cruzar dados de outro lugar.
 */
export function renderPrometheus(
  sessoes: Array<{ name: string; status: string; connected: boolean }> = [],
): string {
  const linhas: string[] = [];

  for (const [name, porSessao] of counters) {
    const metric = `elo_${name}`;
    linhas.push(`# HELP ${metric} ${HELP[name]}`);
    linhas.push(`# TYPE ${metric} counter`);
    for (const [session, valor] of porSessao) {
      linhas.push(`${metric}{session="${escLabel(session)}"} ${valor}`);
    }
  }

  if (sessoes.length) {
    linhas.push('# HELP elo_session_up Sessao conectada (1) ou nao (0)');
    linhas.push('# TYPE elo_session_up gauge');
    for (const s of sessoes) {
      linhas.push(
        `elo_session_up{session="${escLabel(s.name)}",status="${escLabel(s.status)}"} ` +
          `${s.connected ? 1 : 0}`,
      );
    }
  }

  linhas.push('# HELP elo_uptime_seconds Tempo desde o boot do processo');
  linhas.push('# TYPE elo_uptime_seconds gauge');
  linhas.push(`elo_uptime_seconds ${Math.floor((Date.now() - bootedAt) / 1000)}`);

  // Prometheus exige newline final.
  return `${linhas.join('\n')}\n`;
}
