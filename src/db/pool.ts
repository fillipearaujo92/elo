// src/db/pool.ts
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.pgPoolMax,
  // O projeto ja se queimou com pool grande em VPS com CPU limitada (PG_POOL_MAX=25).
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // Um erro em cliente idle nao deve derrubar o processo.
  console.error('[db] erro em cliente idle:', err.message);
});

/** Aplica o schema (idempotente). Chamado uma vez no boot. */
export async function migrate(): Promise<void> {
  // O .sql fica ao lado do .ts no src e e copiado para dist no build (ver Dockerfile).
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
}
