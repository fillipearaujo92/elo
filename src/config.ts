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

/**
 * Flag booleana. Aceita `1`, `true`, `yes`, `on` (e as maiusculas) como verdadeiro.
 *
 * Qualquer outro valor e FALSO, inclusive lixo — flag de seguranca nao deve ligar por
 * acidente de digitacao. E o contrario do `num()`, que lanca em valor invalido: aqui
 * o silencio erra para o lado fechado.
 */
function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (!v || !v.trim()) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

export const config = {
  port: num('PORT', 3000),
  host: optional('HOST', '0.0.0.0'),

  // Autenticacao das rotas: header X-Api-Key. O driver do backend manda essa chave
  // (o driver le waha.api_key de app_settings) e o gateway a devolve
  // como customHeaders X-Webhook-Key nos webhooks.
  apiKey: required('API_KEY'),

  databaseUrl: required('DATABASE_URL'),
  pgPoolMax: num('PG_POOL_MAX', 10),

  // Diretorio onde a midia inbound e gravada e servida por GET /api/files/...
  mediaDir: optional('MEDIA_DIR', '/data/media'),

  // URL publica do gateway. Usada para montar a URL de midia nos webhooks.
  // O driver do backend reescreve localhost:3000 -> baseUrl publico (o driver do consumidor),
  // entao emitir localhost funcionaria, mas emitir a URL correta e mais limpo.
  publicUrl: optional('PUBLIC_URL', ''),

  logLevel: optional('LOG_LEVEL', 'info'),

  // ★ Nivel de log do BAILEYS, separado do nivel do ELO. Existe porque os dois tem
  // volumes muito diferentes: em `info`, o Baileys narra cada upload de pre-key e cada
  // passo de handshake, e isso AFOGA o log do gateway. Medido no beta: de 200 linhas de
  // log, a maioria era ruido de terceiros e de healthcheck, empurrando o evento util
  // (webhook perdido, mensagem nao decifrada) fora do buffer do `docker logs`.
  //
  // Default `warn`: o Baileys so aparece quando ha algo errado, que e quando se olha o
  // log dele. Para depurar protocolo: BAILEYS_LOG_LEVEL=debug.
  baileysLogLevel: optional('BAILEYS_LOG_LEVEL', 'warn'),

  // ★ Silencia o par "incoming request"/"request completed" das rotas de health.
  // O healthcheck do Docker bate em /health a cada 30s -> 2 linhas x 2880/dia de log
  // que nao dizem nada (se o container esta de pe, o health passou). Medido no beta:
  // era a maior fonte isolada de linhas.
  //
  // Nao remove o log de ERRO: /health respondendo != 200 continua sendo logado, que e
  // a unica ocasiao em que a rota interessa.
  logHealthRequests: optional('LOG_HEALTH_REQUESTS', '') === '1',

  // Retencao da tabela sent_messages (idempotencia de ack). Acks chegam em minutos;
  // 7 dias e folga generosa e mantem a tabela pequena.
  sentMessagesRetentionDays: num('SENT_MESSAGES_RETENTION_DAYS', 7),

  // Throttle de session.status. O WAHA real emite um evento a cada refresh de QR
  // (~20s) e isso causava tempestade no backend (o receptor de webhook do consumidordocumenta).
  // Aqui suprimimos repeticoes do MESMO status dentro da janela.
  sessionStatusThrottleMs: num('SESSION_STATUS_THROTTLE_MS', 60_000),

  // ★ Libera o gateway a buscar URLs em REDE PRIVADA (10/8, 172.16/12, 192.168/16,
  // CGNAT). Existe porque em instalacao self-hosted e comum a origem da midia e o
  // consumidor do webhook viverem na mesma rede interna — bloquear isso quebraria o
  // caso legitimo.
  //
  // Loopback e link-local seguem bloqueados MESMO com a flag ligada: nao ha caso de
  // uso em que o gateway precise buscar a propria metadata da instancia
  // (169.254.169.254 = credenciais IAM). Ver src/core/net-guard.ts.
  allowPrivateFetch: bool('ALLOW_PRIVATE_FETCH', false),

  // Teto de requisicoes por minuto, por IP. Antes NAO havia limite nenhum: um
  // atacante tinha orcamento infinito de tentativas contra a X-Api-Key. Generoso de
  // proposito — operacao real (painel + driver) fica bem abaixo disso.
  rateLimitMax: num('RATE_LIMIT_MAX', 300),

  // Teto SEPARADO e agressivo para quem toma 401. Requisicao sem chave valida nao
  // tem motivo legitimo para repetir dezenas de vezes por minuto; e a assinatura de
  // forca bruta.
  rateLimitAuthMax: num('RATE_LIMIT_AUTH_MAX', 10),
} as const;
