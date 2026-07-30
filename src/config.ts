// src/config.ts
// Configuracao por ambiente. Sem default para segredo: se API_KEY faltar, o
// processo NAO sobe (fail-closed). Um gateway de WhatsApp aberto na internet sem
// chave e acesso irrestrito as contas conectadas.

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v || !v.trim()) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} deve ser numerico, recebido: ${v}`);
  return n;
}

export const config = {
  port: num('PORT', 3000),
  host: optional('HOST', '0.0.0.0'),

  // Autenticacao das rotas: header X-Api-Key. O driver do backend manda essa chave
  // (o consumidor guarda a mesma chave na sua configuracao) e o gateway a devolve
  // como customHeaders X-Webhook-Key nos webhooks.
  apiKey: required('API_KEY'),

  databaseUrl: required('DATABASE_URL'),
  pgPoolMax: num('PG_POOL_MAX', 10),

  // Diretorio onde a midia inbound e gravada e servida por GET /api/files/...
  mediaDir: optional('MEDIA_DIR', '/data/media'),

  // URL publica do gateway. Usada para montar a URL de midia nos webhooks.
  // O consumidor pode reescrever localhost:3000 -> baseUrl publico,
  // entao emitir localhost funcionaria, mas emitir a URL correta e mais limpo.
  publicUrl: optional('PUBLIC_URL', ''),

  logLevel: optional('LOG_LEVEL', 'info'),

  // Retencao da tabela sent_messages (idempotencia de ack). Acks chegam em minutos;
  // 7 dias e folga generosa e mantem a tabela pequena.
  sentMessagesRetentionDays: num('SENT_MESSAGES_RETENTION_DAYS', 7),

  // Throttle de session.status. O refresh de QR gera um evento a cada ciclo
  // (~20s) e isso causava tempestade de eventos no consumidor.
  // Aqui suprimimos repeticoes do MESMO status dentro da janela.
  sessionStatusThrottleMs: num('SESSION_STATUS_THROTTLE_MS', 60_000),
} as const;
