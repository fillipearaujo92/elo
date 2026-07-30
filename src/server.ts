// src/server.ts
// Entrypoint: monta o Fastify, autentica por X-Api-Key, registra rotas, restaura
// sessoes e trata shutdown gracioso.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { config } from './config.js';
import { events } from './core/events.js';
import { MediaStore } from './core/media.js';
import { SessionManager } from './core/session-manager.js';
import { WebhookEmitter } from './core/webhook.js';
import { migrate, pool } from './db/pool.js';
import { registerContactRoutes } from './routes/contacts.js';
import { registerSendRoutes } from './routes/send.js';
import { registerPresenceRoutes } from './routes/presence.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { renderPrometheus } from './core/metrics.js';
import { backupStatus, dumpAuth, restoreAuth, setMark } from './core/backup.js';
import { buildOpenApi } from './openapi.js';

const here = dirname(fileURLToPath(import.meta.url));

// ── Versão ─────────────────────────────────────────────────────────────────
// Lida do package.json (fonte ÚNICA — um número hard-coded no painel divergiria
// do publicado no primeiro bump esquecido). O commit vem do build da imagem
// (deploy/beta.sh passa COMMIT_SHA), e é o que permite responder "o beta está
// rodando o meu último deploy?" sem abrir SSH.
const pkg = JSON.parse(
  await readFile(join(here, '..', 'package.json'), 'utf8'),
) as { version?: string };
export const VERSION = pkg.version ?? '0.0.0';
export const COMMIT = process.env.COMMIT_SHA ?? null;

const app = Fastify({
  logger: { level: config.logLevel },
  // Midia em base64 no corpo (o driver manda `file.data`) estoura o default de 1MB.
  bodyLimit: 64 * 1024 * 1024,
  // Confia no proxy (Traefik) para logar o IP real.
  trustProxy: true,
});

// ── Autenticacao ───────────────────────────────────────────────────────────
// X-Api-Key em tudo, exceto health check e download de midia.
//
// O download de midia fica fora porque o backend baixa a URL com a chave, mas outros
// consumidores (o proprio chat servindo a imagem) podem nao ter. A URL carrega nome
// aleatorio de 12 hex, o que a torna nao-adivinhavel; ainda assim e um trade-off
// consciente e documentado: quem tiver a URL exata acessa o arquivo.
// '/' e '/dashboard' servem o painel de operação. São públicos porque a PÁGINA em
// si não expõe dado nenhum: ela pede a chave num formulário e só então consome a
// API (que segue protegida). Servir o HTML atrás de auth exigiria um segundo
// mecanismo de sessão sem ganho real de segurança.
// `/docs` e `/openapi.json` são públicos: são DOCUMENTAÇÃO, e exigir chave para
// ler a documentação é atrito sem ganho — a spec descreve a forma da API, não
// expõe dado nenhum. Quem for TESTAR pelo Swagger informa a chave lá.
const PUBLIC_PATHS = new Set([
  '/health', '/healthz', '/', '/dashboard', '/docs', '/openapi.json',
]);

app.addHook('onRequest', async (req, reply) => {
  if (PUBLIC_PATHS.has(req.url.split('?')[0] ?? '')) return;
  if (req.url.startsWith('/api/files/')) return;
  // ★ Assets do Swagger UI. Sem isto, /docs carregava e o CSS/JS tomava 401 — a
  // página abria sem estilo e sem funcionar (medido no beta). A lista de arquivos
  // servidos é fechada (SWAGGER_ASSETS), então liberar o prefixo aqui não expõe
  // node_modules.
  if (req.url.startsWith('/docs/')) return;

  const key = req.headers['x-api-key'];
  const provided = Array.isArray(key) ? key[0] : key;
  if (!provided || provided !== config.apiKey) {
    return reply.code(401).send({ message: 'unauthorized' });
  }
});

// ── Dependencias ───────────────────────────────────────────────────────────
const media = new MediaStore(app.log as never);
const webhooks = new WebhookEmitter(app.log as never);
const sessions = new SessionManager(pool, app.log as never, webhooks, media);

// ── Rotas ──────────────────────────────────────────────────────────────────
app.get('/health', async () => {
  // Health check real: valida o banco, nao apenas o processo. Um gateway que perdeu
  // o Postgres nao consegue restaurar sessao nem gravar creds — nao esta saudavel.
  await pool.query('SELECT 1');
  // `engine` e lido pelo driver do backend; version/commit sao do painel.
  return { status: 'ok', engine: 'BAILEYS', version: VERSION, commit: COMMIT };
});

// ── Painel de operação ─────────────────────────────────────────────────────
// HTML autocontido (CSS+JS inline, ícones SVG inline): sem CDN, sem build step.
// Lido do disco em cada request para permitir editar sem rebuild em dev; o
// arquivo tem ~30KB, então o custo é irrelevante para o volume deste endpoint.
const dashboardPath = join(here, 'ui/dashboard.html');
for (const path of ['/', '/dashboard']) {
  app.get(path, async (_req, reply) => {
    const html = await readFile(dashboardPath, 'utf8').catch(() => null);
    if (!html) return reply.code(404).send({ message: 'painel nao encontrado' });
    return reply.type('text/html; charset=utf-8').send(html);
  });
}

// GET /api/events — stream SSE dos eventos de diagnóstico.
//
// Existe para o painel mostrar em tempo real o que antes só aparecia em
// `docker logs`: mensagem entrando, ACK progredindo, LID resolvido, webhook
// rejeitado. SSE em vez de WebSocket porque o fluxo é unidirecional e o
// EventSource do navegador reconecta sozinho.
app.get<{ Querystring: { after?: string } }>('/api/events', async (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Sem isso o Traefik/nginx pode bufferizar e o stream nunca chega.
    'X-Accel-Buffering': 'no',
  });

  // ★ Encerramento em UM lugar, idempotente.
  //
  // Antes, o unsubscribe só acontecia no 'close' do request. Se a conexão morresse
  // sem emitir 'close' (idle timeout no meio, TCP half-open — exatamente o que o
  // heartbeat abaixo existe para mitigar, prova de que acontece), o listener ficava
  // para sempre. O painel reconecta a cada 3s, então a cada queda somava uma
  // closure morta iterada A CADA MENSAGEM E A CADA ACK — degradação progressiva,
  // silenciosa e sem contador que a revelasse.
  let encerrado = false;
  let unsubscribe: () => void = () => {};
  // `let` + atribuição depois: o encerrar() é referenciado por send() e pelo próprio
  // heartbeat, que só existe adiante. `const beat` não sofre hoisting.
  let beat: NodeJS.Timeout | null = null;
  const encerrar = () => {
    if (encerrado) return;
    encerrado = true;
    if (beat) clearInterval(beat);
    unsubscribe();
  };

  const send = (ev: unknown) => {
    if (encerrado) return;
    try {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    } catch {
      // Escrever num socket morto é o sinal mais confiável de que a conexão foi.
      // Engolir aqui era o que deixava o listener vazar.
      encerrar();
    }
  };

  // Backlog primeiro: quem abre o painel já vê o que aconteceu antes.
  const after = Number(req.query.after ?? 0) || 0;
  for (const ev of events.recent(after)) send(ev);

  unsubscribe = events.subscribe(send);

  // Heartbeat: comentário SSE que mantém a conexão viva através de proxies com
  // timeout de idle (o Traefik fecha silenciosamente sem isso). Também serve de
  // detector: se o write falhar, encerramos em vez de continuar inscritos.
  beat = setInterval(() => {
    if (encerrado) return;
    try {
      reply.raw.write(': ping\n\n');
    } catch {
      encerrar();
    }
  }, 25_000);
  beat.unref?.();

  for (const alvo of [req.raw, reply.raw]) {
    alvo.on('close', encerrar);
    alvo.on('error', encerrar);
  }
});

registerSessionRoutes(app, { sessions });
registerSendRoutes(app, { sessions });
registerContactRoutes(app, { sessions });
registerPresenceRoutes(app, { sessions });

// ── Documentação da API ────────────────────────────────────────────────────
//
// A spec vive em código (src/openapi.ts) e há um teste que compara os caminhos
// declarados com as rotas REGISTRADAS no Fastify: endpoint novo sem documentação
// quebra o CI. Um YAML solto desatualizaria em silêncio.
app.get('/openapi.json', async (_req, reply) =>
  reply.type('application/json; charset=utf-8').send(buildOpenApi(VERSION)),
);

// GET /docs — Swagger UI.
//
// ★ Servido do node_modules, NÃO de CDN. Três razões: a instalação pode não ter
// internet de saída (rede interna é o caso comum de auto-hospedado), carregar
// script de terceiro numa página que recebe a chave de API é risco desnecessário,
// e a versão fica presa ao lockfile em vez de mudar sozinha.
const SWAGGER_DIR = join(here, '..', 'node_modules', 'swagger-ui-dist');
app.get('/docs', async (_req, reply) => {
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>ELO — API</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/docs/swagger-ui.css">
<style>
  body{margin:0;background:#fafaf9}
  .topbar{display:none}
  .swagger-ui .info{margin:26px 0}
</style>
</head><body>
<div id="ui"></div>
<script src="/docs/swagger-ui-bundle.js"></script>
<script>
  window.ui = SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#ui',
    // Ordena por tag, na ordem declarada na spec (fluxo: sessão → enviar → …).
    docExpansion: 'list',
    defaultModelsExpandDepth: 0,
    tryItOutEnabled: true,
    persistAuthorization: true,
  })
</script>
</body></html>`;
  return reply.type('text/html; charset=utf-8').send(html);
});

// Assets do Swagger UI. Lista FECHADA de arquivos: servir o diretório inteiro
// abriria leitura de qualquer coisa sob node_modules.
const SWAGGER_ASSETS: Record<string, string> = {
  '/docs/swagger-ui.css': 'text/css; charset=utf-8',
  '/docs/swagger-ui-bundle.js': 'application/javascript; charset=utf-8',
};
for (const [rota, tipo] of Object.entries(SWAGGER_ASSETS)) {
  app.get(rota, async (_req, reply) => {
    const arquivo = rota.replace('/docs/', '');
    const buf = await readFile(join(SWAGGER_DIR, arquivo)).catch(() => null);
    if (!buf) {
      return reply.code(404).send({
        message: 'swagger-ui-dist nao encontrado; rode `npm ci` para instalar',
      });
    }
    // Imutável: o arquivo é da versão travada no lockfile.
    return reply.type(tipo).header('Cache-Control', 'public, max-age=604800').send(buf);
  });
}

// ── Backup do pareamento ───────────────────────────────────────────────────
// O volume do Postgres É o pareamento: perdê-lo obriga a escanear o QR de todas
// as sessões de novo. O README avisa, mas aviso em doc é lido DEPOIS de perder —
// então o gateway oferece o dump em um clique e diz no painel quando há
// pareamento sem backup.

// GET /api/backup/status — risco calculado, consumido pelo painel.
app.get('/api/backup/status', async () => backupStatus(pool));

// GET /api/backup — baixa o dump (JSON).
//
// ★ O arquivo contém as CHAVES DO SIGNAL: quem o tem consegue se passar pelo
// número conectado. Exige a API key (como todo o resto), e o próprio arquivo
// carrega o aviso — para não virar anexo esquecido num e-mail.
app.get('/api/backup', async (_req, reply) => {
  const dump = await dumpAuth(pool);
  await setMark(pool, 'last_backup', 'download via /api/backup');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return reply
    .header('Content-Disposition', `attachment; filename="elo-backup-${stamp}.json"`)
    .type('application/json; charset=utf-8')
    .send(JSON.stringify(dump, null, 2));
});

// POST /api/backup/restore — restaura um dump.
//
// DESTRUTIVO: substitui o pareamento atual. Exige `confirm: true` no corpo para
// não haver restauração acidental — o custo de errar aqui é derrubar as sessões
// que estão funcionando.
app.post<{ Body: { confirm?: boolean; format?: number; data?: Record<string, unknown[]> } }>(
  '/api/backup/restore',
  async (req, reply) => {
    if (req.body?.confirm !== true) {
      return reply.code(400).send({
        message:
          'restauracao SUBSTITUI o pareamento atual; envie "confirm": true junto do dump ' +
          'para confirmar',
      });
    }
    // Para as sessões antes de trocar o estado sob elas: um socket vivo com o
    // auth state de outro pareamento gera erro de decifração em cascata.
    await sessions.shutdown();
    try {
      const out = await restoreAuth(pool, req.body);
      await setMark(pool, 'last_restore', 'via /api/backup/restore');
      // Sobe de novo com o estado restaurado.
      await sessions.restoreAll();
      return { success: true, ...out, note: 'sessoes reiniciadas com o pareamento restaurado' };
    } catch (err) {
      return reply.code(400).send({ message: (err as Error).message });
    }
  },
);

// GET /metrics — formato Prometheus.
//
// PROTEGIDO por X-Api-Key, ao contrario do /health: os nomes das sessoes sao
// rotulos, e nome de sessao costuma identificar cliente ("Loja Centro"). Deixar
// aberto entregaria a lista de clientes a qualquer um.
//
// Existe porque a falha que mais dói aqui e SILENCIOSA: o bug que derrubou o
// inbound (Bad MAC/LID) foi descoberto por alguem mandando mensagem e notando a
// ausencia. Com `elo_inbound_undecryptable_total > 0` e
// `elo_webhook_lost_total > 0`, o alerta chega antes do cliente reclamar.
app.get('/metrics', async (_req, reply) => {
  const rows = await sessions.listSessions();
  const estado = [];
  for (const r of rows) {
    const live = sessions.getLive(r.name);
    const status = live?.status ?? r.status;
    estado.push({ name: r.name, status, connected: status === 'WORKING' });
  }
  return reply
    .type('text/plain; version=0.0.4; charset=utf-8')
    .send(renderPrometheus(estado));
});

// GET /api/files/{session}/{filename} — serve a midia inbound baixada.
app.get<{ Params: { session: string; filename: string } }>(
  '/api/files/:session/:filename',
  async (req, reply) => {
    const buf = await media.read(req.params.session, req.params.filename);
    if (!buf) return reply.code(404).send({ message: 'arquivo nao encontrado' });
    // O backend le o content-type da resposta para decidir a extensao (waha.js:260).
    return reply.type(guessType(req.params.filename)).send(buf);
  },
);

function guessType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', mp4: 'video/mp4', '3gp': 'video/3gpp', mov: 'video/quicktime',
    oga: 'audio/ogg', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4',
    amr: 'audio/amr', wav: 'audio/wav', pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

// Erros: Boom carrega o statusCode correto; o resto e 500.
app.setErrorHandler((error, req, reply) => {
  // O Fastify tipa o erro como unknown neste hook; normalizamos aqui.
  const err = error as Error & {
    statusCode?: number;
    output?: { statusCode?: number };
  };
  const status = err.output?.statusCode ?? err.statusCode ?? 500;
  if (status >= 500) {
    app.log.error({ err: err.message, url: req.url }, 'erro nao tratado');
  }
  return reply.code(status).send({ message: err.message });
});

// ── Boot ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await migrate();
  app.log.info('schema aplicado');

  await app.listen({ port: config.port, host: config.host });
  app.log.info({ port: config.port }, 'gateway ouvindo');

  // Restaura DEPOIS de comecar a ouvir: o health check responde enquanto as sessoes
  // sobem (podem levar minutos com muitas sessoes), evitando o orquestrador matar o
  // container por health check falho durante o boot.
  await sessions.restoreAll();
  app.log.info('restauracao concluida');
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'encerrando');
  // Fecha o HTTP primeiro (para de aceitar envio), depois os sockets, depois o banco.
  await app.close().catch(() => {});
  await sessions.shutdown().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  app.log.error({ err: err.message }, 'falha no boot');
  process.exit(1);
});
