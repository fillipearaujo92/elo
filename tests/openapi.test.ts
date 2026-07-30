// tests/openapi.test.ts
//
// A spec OpenAPI tem de descrever a API REAL.
//
// ── Por que este teste existe ──────────────────────────────────────────────
// Documentação de API apodrece do mesmo jeito sempre: alguém adiciona um endpoint,
// esquece a spec, e ela passa a MENTIR. Quem integra confia nela, não encontra o
// endpoint, e conclui que a funcionalidade não existe.
//
// Aqui a spec é comparada com as rotas REGISTRADAS no Fastify. Endpoint novo sem
// documentação quebra o CI; endpoint documentado que não existe também.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildOpenApi } from '../dist/openapi.js';
import { MediaStore } from '../dist/core/media.js';
import { SessionManager } from '../dist/core/session-manager.js';
import { registerContactRoutes } from '../dist/routes/contacts.js';
import { registerPresenceRoutes } from '../dist/routes/presence.js';
import { registerSendRoutes } from '../dist/routes/send.js';
import { registerSessionRoutes } from '../dist/routes/sessions.js';
import type { WebhookEmitter } from '../dist/core/webhook.js';

const silentLog = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  child() { return silentLog; },
} as never;

/**
 * Rotas que o Fastify realmente registrou, normalizadas para o estilo OpenAPI
 * (`:session` → `{session}`).
 */
let reais: Set<string>;
const spec = buildOpenApi('0.0.0-test') as {
  openapi: string;
  info: Record<string, unknown>;
  paths: Record<string, Record<string, unknown>>;
  components: Record<string, unknown>;
  tags: Array<{ name: string }>;
};

before(async () => {
  const pool = {
    async query() { return { rows: [], rowCount: 0 }; },
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; },
  };
  const manager = new SessionManager(
    pool as never, silentLog,
    { async emit() {} } as unknown as WebhookEmitter,
    new MediaStore(silentLog),
  );

  // ★ Coleta pelo hook `onRoute`, NÃO pelo `printRoutes`.
  //
  // O printRoutes desenha uma ÁRVORE: uma rota aninhada aparece como FRAGMENTO
  //   └── /api/sessions/:session (GET)
  //       └── /start (POST)
  // ...então parsear a saída dava falso negativo em TODAS as sub-rotas — o teste
  // acusava `/api/sessions/{session}/start` como inexistente quando ela existe.
  // O onRoute entrega `url` completo.
  reais = new Set<string>();
  const app: FastifyInstance = Fastify({ logger: false });
  app.addHook('onRoute', (r) => {
    const caminho = String(r.url).replace(/:([a-zA-Z]+)/g, '{$1}');
    const mets = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of mets) reais.add(`${m} ${caminho}`);
  });
  registerSessionRoutes(app, { sessions: manager });
  registerSendRoutes(app, { sessions: manager });
  registerContactRoutes(app, { sessions: manager });
  registerPresenceRoutes(app, { sessions: manager });
  await app.ready();
});

describe('OpenAPI: estrutura', () => {
  it('e uma spec 3.1 valida no essencial', () => {
    assert.equal(spec.openapi, '3.1.0');
    assert.ok(spec.info.title);
    assert.ok(spec.info.version);
    assert.ok(Object.keys(spec.paths).length > 20, 'a API tem mais de 20 endpoints');
  });

  it('declara o esquema de autenticacao usado em tudo', () => {
    const sec = (spec.components as { securitySchemes?: Record<string, { name?: string }> })
      .securitySchemes;
    assert.equal(sec?.ApiKey?.name, 'X-Api-Key');
  });

  it('todo endpoint tem summary e operationId (o gerador de cliente precisa)', () => {
    const semSummary: string[] = [];
    const semOpId: string[] = [];
    const opIds = new Set<string>();
    const duplicados: string[] = [];
    for (const [caminho, ops] of Object.entries(spec.paths)) {
      for (const [met, op] of Object.entries(ops)) {
        if (met === 'parameters') continue;
        const o = op as { summary?: string; operationId?: string };
        if (!o.summary) semSummary.push(`${met} ${caminho}`);
        if (!o.operationId) semOpId.push(`${met} ${caminho}`);
        else if (opIds.has(o.operationId)) duplicados.push(o.operationId);
        else opIds.add(o.operationId);
      }
    }
    assert.deepEqual(semSummary, [], 'endpoints sem summary');
    assert.deepEqual(semOpId, [], 'endpoints sem operationId');
    assert.deepEqual(duplicados, [], 'operationId duplicado quebra o gerador de cliente');
  });

  it('toda tag usada esta declarada em tags', () => {
    const declaradas = new Set(spec.tags.map((t) => t.name));
    const usadas = new Set<string>();
    for (const ops of Object.values(spec.paths)) {
      for (const [met, op] of Object.entries(ops)) {
        if (met === 'parameters') continue;
        for (const t of (op as { tags?: string[] }).tags ?? []) usadas.add(t);
      }
    }
    for (const t of usadas) assert.ok(declaradas.has(t), `tag "${t}" nao declarada`);
  });

  it('todo $ref aponta para um schema existente', () => {
    const schemas = new Set(
      Object.keys((spec.components as { schemas?: Record<string, unknown> }).schemas ?? {}),
    );
    const refs = JSON.stringify(spec).match(/"#\/components\/schemas\/(\w+)"/g) ?? [];
    for (const r of refs) {
      const nome = r.match(/schemas\/(\w+)/)![1]!;
      assert.ok(schemas.has(nome), `$ref quebrado: ${nome}`);
    }
  });
});

describe('OpenAPI: casa com as rotas REAIS', () => {
  // Rotas fora do escopo da spec de integração: painel, arquivos e o próprio
  // Swagger. Documentá-las não ajudaria quem integra.
  const IGNORAR = [
    '/', '/dashboard', '/docs', '/openapi.json',
    '/docs/swagger-ui.css', '/docs/swagger-ui-bundle.js',
    '/api/files/{session}/{filename}',
    '/health', '/healthz', '/metrics', '/api/events', '/api/backup',
    '/api/backup/status', '/api/backup/restore',
  ];

  it('★ todo endpoint REGISTRADO esta documentado', () => {
    // Este e o teste que impede a spec de apodrecer: endpoint novo sem doc falha.
    const faltando: string[] = [];
    for (const rota of reais) {
      const [met, caminho] = rota.split(' ') as [string, string];
      if (IGNORAR.includes(caminho)) continue;
      if (met === 'HEAD' || met === 'OPTIONS') continue;
      const ops = spec.paths[caminho];
      if (!ops || !(met.toLowerCase() in ops)) faltando.push(rota);
    }
    assert.deepEqual(faltando, [], 'endpoints sem documentacao na spec');
  });

  it('★ todo endpoint DOCUMENTADO existe de verdade', () => {
    // O inverso: spec que promete rota inexistente e pior que spec incompleta,
    // porque o integrador escreve codigo contra algo que devolve 404.
    const inexistentes: string[] = [];
    for (const [caminho, ops] of Object.entries(spec.paths)) {
      for (const met of Object.keys(ops)) {
        if (met === 'parameters') continue;
        const chave = `${met.toUpperCase()} ${caminho}`;
        // As rotas de operação são registradas no server.ts, fora deste harness.
        if (IGNORAR.includes(caminho)) continue;
        if (!reais.has(chave)) inexistentes.push(chave);
      }
    }
    assert.deepEqual(inexistentes, [], 'spec documenta rota que nao existe');
  });

  it('os 6 endpoints de envio estao documentados', () => {
    for (const e of ['sendText', 'sendImage', 'sendVideo', 'sendVoice', 'sendFile', 'sendMedia']) {
      assert.ok(spec.paths[`/api/${e}`]?.post, `${e} ausente`);
    }
  });

  it('parametros de path sao declarados', () => {
    // Sem isto o Swagger UI nao gera o campo, e o "try it out" nao funciona.
    for (const [caminho, ops] of Object.entries(spec.paths)) {
      const naUrl = [...caminho.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      if (!naUrl.length) continue;
      const declarados = new Set(
        ((ops.parameters as Array<{ name: string; in: string }>) ?? [])
          .filter((p) => p.in === 'path')
          .map((p) => p.name),
      );
      for (const p of naUrl) {
        assert.ok(declarados.has(p!), `${caminho}: parametro {${p}} nao declarado`);
      }
    }
  });
});

describe('OpenAPI: o conteudo ajuda quem integra', () => {
  it('avisa sobre a biblioteca nao-oficial na descricao', () => {
    // Quem lê a spec antes de integrar precisa saber do risco de ban.
    assert.match(String(spec.info.description), /n[ãa]o-oficial/i);
  });

  it('sendText documenta que text vazio e 400', () => {
    const r = (spec.paths['/api/sendText']!.post as { responses: Record<string, unknown> })
      .responses;
    assert.ok(r['400'], 'o 400 de texto vazio tem de estar documentado');
  });

  it('as rotas destrutivas avisam na descricao', () => {
    const del = spec.paths['/api/sessions/{session}']!.delete as { description?: string };
    assert.match(String(del.description), /irrevers|QR/i);
    const rest = spec.paths['/api/backup/restore']?.post as { description?: string } | undefined;
    if (rest) assert.match(String(rest.description), /DESTRUTIVO|substitui/i);
  });

  it('/health e publico na spec (security vazio)', () => {
    const h = spec.paths['/health']!.get as { security?: unknown[] };
    assert.deepEqual(h.security, [], 'health nao exige chave');
  });
});
