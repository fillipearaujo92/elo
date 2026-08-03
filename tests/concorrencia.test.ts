// tests/concorrencia.test.ts
//
// Limites de concorrencia: SSE e resolucao de midia.
//
// ── Por que estes testes existem ───────────────────────────────────────────
// Havia dois tetos protegendo UM request (64MB por arquivo, 128MB agregados por
// chamada) e NADA limitando quantos requests concorrentes existem. 128MB x N requests
// autenticados = OOM, e o dano nao fica no envio que estourou: o container morre e leva
// TODAS as sessoes WhatsApp com ele. Um envio que espera na fila e incomodo; o gateway
// inteiro cair e incidente.
//
// O SSE tinha o mesmo problema por outra porta: cada stream e uma closure inscrita no
// barramento, ITERADA a cada mensagem e a cada ack de todas as sessoes. O painel
// reconecta a cada 3s, entao um cliente com problema de rede acumulava rapido.
//
// O semaforo e a parte com risco de BUG PROPRIO: uma fila mal feita trava envio
// legitimo para sempre, o que seria pior que o problema original. Daí os testes de
// FIFO, de liberacao em caso de erro, e de timeout de espera.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Replica do semaforo de src/routes/send.ts. Testado como logica pura porque o original
 * vive dentro do closure de registerSendRoutes e depende de Fastify + SessionManager.
 * Se a implementacao divergir daqui, o comportamento medido abaixo deixa de valer —
 * mantê-los alinhados e responsabilidade de quem editar o send.ts.
 */
function criarSemaforo(max: number, esperaMs: number) {
  let emVoo = 0;
  const fila: Array<() => void> = [];
  const esperou: number[] = [];

  async function com<T>(fn: () => Promise<T>): Promise<T> {
    if (emVoo >= max) {
      esperou.push(1);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          const i = fila.indexOf(liberar);
          if (i >= 0) fila.splice(i, 1);
          reject(new Error('gateway ocupado processando midia; tente novamente'));
        }, esperaMs);
        function liberar(): void { clearTimeout(t); resolve(); }
        fila.push(liberar);
      });
    }
    emVoo += 1;
    try { return await fn(); } finally { emVoo -= 1; fila.shift()?.(); }
  }
  return { com, esperas: () => esperou.length, emVoo: () => emVoo, fila: () => fila.length };
}

const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('semaforo de midia', () => {
  it('★ nunca passa do teto de concorrencia', async () => {
    const s = criarSemaforo(4, 5_000);
    let pico = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        s.com(async () => {
          pico = Math.max(pico, s.emVoo());
          await dorme(15);
        }),
      ),
    );
    assert.ok(pico <= 4, `pico foi ${pico}, o teto e 4`);
    assert.equal(s.emVoo(), 0, 'tudo liberado no fim');
  });

  it('★ libera a vaga mesmo quando a resolucao FALHA', async () => {
    // Sem o `finally`, um download que estoura o teto de bytes (caso comum) vazaria a
    // vaga — e depois de 4 falhas o gateway pararia de aceitar midia para sempre. Este
    // e o bug mais provavel nesta classe de codigo.
    const s = criarSemaforo(2, 5_000);
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => s.com(async () => { throw new Error('413'); }));
    }
    assert.equal(s.emVoo(), 0, 'as vagas voltaram');
    // E ainda aceita trabalho depois das falhas.
    assert.equal(await s.com(async () => 'ok'), 'ok');
  });

  it('processa a fila em FIFO (quem esperou mais entra primeiro)', async () => {
    // LIFO deixaria o primeiro da fila esperando indefinidamente sob carga constante.
    const s = criarSemaforo(1, 5_000);
    const ordem: number[] = [];
    const trabalho = (n: number) => s.com(async () => { ordem.push(n); await dorme(10); });
    await Promise.all([trabalho(1), trabalho(2), trabalho(3), trabalho(4)]);
    assert.deepEqual(ordem, [1, 2, 3, 4]);
  });

  it('★ quem espera demais recebe erro, nao fica pendurado', async () => {
    // Sem timeout na espera, um pico deixaria clientes presos ate o timeout DELES (ou
    // para sempre), e o operador veria "lentidao" sem causa visivel.
    const s = criarSemaforo(1, 40);
    const longo = s.com(async () => { await dorme(300); });
    await assert.rejects(() => s.com(async () => 'nunca'), /ocupado/);
    await longo;
  });

  it('quem desiste por timeout SAI da fila (nao segura a vaga do proximo)', async () => {
    const s = criarSemaforo(1, 30);
    const longo = s.com(async () => { await dorme(200); });
    await assert.rejects(() => s.com(async () => 'x'), /ocupado/);
    assert.equal(s.fila(), 0, 'a entrada do desistente foi removida');
    await longo;
    // A vaga liberada nao foi consumida por um fantasma.
    assert.equal(await s.com(async () => 'ok'), 'ok');
  });

  it('nao enfileira quando ha vaga (sem custo no caminho comum)', async () => {
    const s = criarSemaforo(4, 5_000);
    await Promise.all([s.com(async () => 1), s.com(async () => 2)]);
    assert.equal(s.esperas(), 0, 'dois requests com teto 4 nao devem esperar');
  });
});

describe('teto de streams SSE', () => {
  // A contagem vive no server.ts, que nao e importavel isolado (roda o boot). Aqui
  // verificamos a REGRA no fonte, como no teste de CSP.
  it('★ o decremento esta no encerrar() idempotente, nao no close do request', () => {
    // Decrementar no 'close' repetiria o bug que o `encerrar()` existe para corrigir:
    // conexao que morre sem emitir 'close' (TCP half-open — o heartbeat existe porque
    // isso acontece) vazaria a vaga, e o teto se esgotaria sozinho com o tempo.
    const src = readFileSync(join(raiz, 'src', 'server.ts'), 'utf8');
    const encerrar = src.match(/const encerrar = \(\) => \{[\s\S]*?\n {2}\};/)?.[0] ?? '';
    assert.match(encerrar, /streamsAbertos -= 1/,
      'o decremento tem de estar dentro do encerrar() idempotente');
  });

  it('rejeita com 503 e Retry-After (nao 429: o limite e de recurso, nao de taxa)', () => {
    const src = readFileSync(join(raiz, 'src', 'server.ts'), 'utf8');
    assert.match(src, /streamsAbertos >= MAX_STREAMS_SSE/);
    assert.match(src, /code\(503\)\.header\('Retry-After'/);
    assert.match(src, /inc\('sse_rejected_total'/, 'limite sem metrica e limite invisivel');
  });
});
