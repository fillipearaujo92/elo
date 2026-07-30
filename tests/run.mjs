// tests/run.mjs
// Runner dos testes. Existe para definir as variaveis de ambiente de forma
// multiplataforma (Windows e Linux/CI): `VAR=x cmd` nao funciona no PowerShell, e o
// config do gateway e fail-closed — sem API_KEY/DATABASE_URL nada carrega.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(here, f));

if (!files.length) {
  console.error('nenhum arquivo de teste encontrado');
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ['--experimental-strip-types', '--test', ...files],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      // Valores de teste: o banco nunca e realmente contatado (pool stubado nos
      // testes de rota; os demais nao tocam banco).
      API_KEY: process.env.API_KEY ?? 'chave-de-teste',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://fake:fake@127.0.0.1:1/fake',
      MEDIA_DIR: process.env.MEDIA_DIR ?? join(here, '.test-media'),
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
    },
  },
);

child.on('exit', (code) => process.exit(code ?? 1));
