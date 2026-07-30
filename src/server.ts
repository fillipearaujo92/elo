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
import { registerSessionRoutes } from './routes/sessions.js';

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
const PUBLIC_PATHS = new Set(['/health', '/healthz', '/', '/dashboard']);

app.addHook('onRequest', async (req, reply) => {
  if (PUBLIC_PATHS.has(req.url.split('?')[0] ?? '')) return;
  if (req.url.startsWith('/api/files/')) return;

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
