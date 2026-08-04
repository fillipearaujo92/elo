// tests/logging.test.ts
//
// Formato e volume do log.
//
// ── Por que estes testes existem ───────────────────────────────────────────
// O log do ELO foi MEDIDO em produzido real no beta antes de mudar, e o que se viu:
//
//   {"level":30,"time":1785846419593,...,"url":"/health",...,"msg":"incoming request"}
//   {"level":30,"time":1785846419595,...,"res":{"statusCode":200},"msg":"request completed"}
//
// Tres problemas concretos, nenhum deles hipotetico:
//
//   1. De 200 linhas, a MAIORIA era o par acima — o healthcheck do Docker batendo em
//      /health a cada 30s. O evento que importa (webhook perdido, mensagem nao
//      decifrada) era empurrado fora do buffer do `docker logs` pelo ruido.
//   2. `"time":1785846419593` e epoch em ms: quem abre o log durante um incidente nao
//      correlaciona com o horario do relato sem converter a mao.
//   3. `"level":30` exige tabela de conversao, e impede `grep '"level":"error"'`.
//
// Estes testes usam PINO DE VERDADE e leem o que ele escreve. Testar a intencao
// (\"chamei o logger com tais opcoes\") nao pegaria nada: o erro possivel aqui e o pino
// interpretar a opcao de forma diferente da que eu suponho — foi o que aconteceu com
// `redact`, cujo path generico censurava `req.url` sem ninguem prever.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { buildLoggerOptions } from '../dist/core/log-options.js';

/**
 * Logger real com as opcoes REAIS do gateway (core/log-options.ts).
 *
 * ★ Le a configuracao de PRODUCAO em vez de copiar as opcoes a mao — e a diferenca
 * entre testar o ELO e testar o pino. A primeira versao deste helper duplicava as
 * opcoes, e uma MUTACAO provou que isso nao valia nada: reverter `formatters.level`
 * para devolver o numero deixou a suite 100% verde. Por isso as opcoes sairam de dentro
 * do server.ts (que nao e importavel em teste) para um modulo proprio.
 */
function loggerDeTeste(extra: Record<string, unknown> = {}) {
  const linhas: Array<Record<string, unknown>> = [];
  const destino = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split('\n')) {
        if (l.trim()) linhas.push(JSON.parse(l));
      }
      cb();
    },
  });
  const opcoes = buildLoggerOptions({ level: 'info', version: '0.2.0', commit: 'abc1234' });
  const log = pino({ ...opcoes, ...extra }, destino);
  return { log, linhas };
}

describe('formato da linha de log', () => {
  it('★ time e ISO-8601, nao epoch em milissegundos', () => {
    const { log, linhas } = loggerDeTeste();
    log.info('oi');
    const t = linhas[0]!.time;
    assert.equal(typeof t, 'string', `time deveria ser texto ISO, veio: ${typeof t}`);
    assert.match(
      t as string,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      `esperado ISO-8601 UTC, veio: ${t}`,
    );
    // E precisa ser uma data VALIDA, nao so casar com o padrao.
    assert.ok(!Number.isNaN(Date.parse(t as string)), `data nao parseavel: ${t}`);
  });

  it('★ level e NOME, nao numero (permite grep por "error")', () => {
    const { log, linhas } = loggerDeTeste();
    log.info('a');
    log.warn('b');
    log.error('c');
    assert.deepEqual(
      linhas.map((l) => l.level),
      ['info', 'warn', 'error'],
      'level tem de sair por nome',
    );
    // O que o operador faz de verdade: filtrar erro no log cru.
    const cru = linhas.map((l) => JSON.stringify(l)).join('\n');
    const erros = cru.split('\n').filter((l) => l.includes('"level":"error"'));
    assert.equal(erros.length, 1, 'grep por "level":"error" tem de achar exatamente 1');
  });

  it('★ versao e commit em TODA linha (a pergunta seguinte a todo erro)', () => {
    // Erro chega por print de tela; "qual versao estava rodando?" nao pode exigir
    // cruzar horario com historico de deploy.
    const { log, linhas } = loggerDeTeste();
    log.info('a');
    log.error({ falha: 'x' }, 'b');
    for (const l of linhas) {
      assert.equal(l.v, '0.2.0', 'falta a versao');
      assert.equal(l.commit, 'abc1234', 'falta o commit');
      assert.equal(l.svc, 'elo', 'falta identificar o servico');
    }
  });

  it('o campo msg continua sendo o texto (nao pode ter sido deslocado)', () => {
    const { log, linhas } = loggerDeTeste();
    log.info({ campo: 1 }, 'mensagem legivel');
    assert.equal(linhas[0]!.msg, 'mensagem legivel');
    assert.equal(linhas[0]!.campo, 1);
  });
});

describe('nivel do child NAO afeta o pai (Baileys separado do gateway)', () => {
  it('★ child em warn silencia info do Baileys sem silenciar o gateway', () => {
    // Esta e a propriedade que faz a separacao funcionar: o Baileys em `warn` para de
    // narrar cada pre-key, e o gateway segue em `info`. Se o nivel do child vazasse
    // para o pai, baixar o ruido do Baileys cegaria o log do ELO — o oposto do
    // objetivo.
    const { log, linhas } = loggerDeTeste();
    const baileys = log.child({ lib: 'baileys' });
    baileys.level = 'warn';

    baileys.info('uploading pre-keys');   // deve ser DESCARTADA
    baileys.warn('conexao instavel');     // deve APARECER
    log.info('gateway segue falando');    // deve APARECER

    const msgs = linhas.map((l) => l.msg);
    assert.ok(!msgs.includes('uploading pre-keys'), `ruido do Baileys passou: ${msgs}`);
    assert.ok(msgs.includes('conexao instavel'), 'warn do Baileys tem de aparecer');
    assert.ok(msgs.includes('gateway segue falando'), 'o log do GATEWAY nao pode ser afetado');
  });

  it('linha do Baileys e distinguivel da do gateway', () => {
    // Antes os dois usavam o MESMO child e "closing stale open session" parecia
    // mensagem do ELO. Quem le nao sabia a quem atribuir o problema.
    const { log, linhas } = loggerDeTeste();
    log.child({ lib: 'baileys' }).warn('closing stale open session');
    log.warn('sessao marcada como FAILED');
    assert.equal(linhas[0]!.lib, 'baileys');
    assert.equal(linhas[1]!.lib, undefined, 'log do gateway nao deve se passar por baileys');
  });
});

describe('redact segue valendo com o formato novo', () => {
  it('★ x-api-key continua censurada (o formato nao pode ter quebrado a protecao)', () => {
    // O `redact` foi ajustado com paths cirurgicos numa rodada anterior. Trocar
    // formatters/base/timestamp nao pode ter deslocado nada — daí este teste aqui.
    const { log, linhas } = loggerDeTeste();
    log.info({ req: { headers: { 'x-api-key': 'chave-secreta-real' } } }, 'req');
    const cru = JSON.stringify(linhas[0]);
    assert.ok(!cru.includes('chave-secreta-real'), `a chave VAZOU: ${cru}`);
    assert.ok(cru.includes('[oculto]'), 'deve dizer que havia algo ali');
  });

  it('★ req.url NAO e censurada (nao cegar o diagnostico)', () => {
    // Regressao registrada: a primeira versao do redact usava `*.url` generico e
    // apagava o caminho da requisicao, deixando "alguma rota deu erro".
    const { log, linhas } = loggerDeTeste();
    log.info({ req: { url: '/api/sessions/atacadao' } }, 'req');
    assert.equal((linhas[0]!.req as Record<string, unknown>).url, '/api/sessions/atacadao');
  });
});

// ── Filtro do log de acesso ────────────────────────────────────────────────
//
// Testa a FUNCAO QUE PRODUCAO USA (core/access.ts), nao uma copia da regra. O hook do
// server.ts delega para ela — foi a licao dos assets do Swagger em 401, onde os testes
// recriavam o hook a mao e exercitavam algo diferente do que rodava.

describe('deveLogarRequisicao', () => {
  it('silencia /health e /healthz quando saudaveis', async () => {
    const { deveLogarRequisicao } = await import('../dist/core/access.js');
    assert.equal(deveLogarRequisicao('/health', 200), false);
    assert.equal(deveLogarRequisicao('/healthz', 200), false);
  });

  it('★ NAO silencia health que esta FALHANDO', async () => {
    // A guarda que da valor ao filtro. Container de pe servindo 503 no health e
    // justamente o caso difícil de diagnosticar; silenciar isso trocaria ruido por
    // cegueira. Se este teste cair, o filtro virou um apagador de evidencia.
    const { deveLogarRequisicao } = await import('../dist/core/access.js');
    for (const status of [400, 401, 429, 500, 503]) {
      assert.equal(
        deveLogarRequisicao('/health', status),
        true,
        `health com ${status} TEM de ser logado`,
      );
    }
  });

  it('loga todas as outras rotas normalmente', async () => {
    const { deveLogarRequisicao } = await import('../dist/core/access.js');
    assert.equal(deveLogarRequisicao('/api/sessions', 200), true);
    assert.equal(deveLogarRequisicao('/api/sendText', 201), true);
    // /metrics fica de FORA do silencio de proposito: quem raspa metrica e um acesso
    // que interessa auditar (a rota e protegida porque nome de sessao identifica cliente).
    assert.equal(deveLogarRequisicao('/metrics', 200), true);
  });

  it('query string nao burla o filtro nem o quebra', async () => {
    const { deveLogarRequisicao } = await import('../dist/core/access.js');
    assert.equal(deveLogarRequisicao('/health?probe=1', 200), false);
    assert.equal(deveLogarRequisicao('/api/sessions?x=1', 200), true);
  });

  it('LOG_HEALTH_REQUESTS=1 traz o health de volta ao log', async () => {
    // Escape hatch para quem esta depurando o proprio healthcheck.
    const { deveLogarRequisicao } = await import('../dist/core/access.js');
    assert.equal(deveLogarRequisicao('/health', 200, true), true);
  });

  it('prefixo parecido NAO e confundido com a rota de health', async () => {
    // `/healthcheck-interno` ou `/health/detalhe` sao OUTRAS rotas; silenciar por
    // prefixo esconderia log legitimo. A comparacao e por caminho exato.
    const { deveLogarRequisicao } = await import('../dist/core/access.js');
    assert.equal(deveLogarRequisicao('/health/detalhe', 200), true);
    assert.equal(deveLogarRequisicao('/healthcheck-interno', 200), true);
  });
});
