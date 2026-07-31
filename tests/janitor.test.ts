// tests/janitor.test.ts
//
// Limpeza da retencao de `sent_messages`.
//
// ── Por que estes testes existem ───────────────────────────────────────────
// `SENT_MESSAGES_RETENTION_DAYS` estava em config.ts e NUNCA era lido — nao havia
// nenhum DELETE na tabela em todo o projeto. A "retencao de 7 dias" citada no
// README e em tres comentarios era documentacao de comportamento inexistente, e a
// tabela guarda o proto completo de cada mensagem enviada, midia inclusive.
//
// O risco ao consertar isso e apagar demais: `sent_messages` e o que responde a
// retry receipt (aparelho que nao decifrou pede reenvio). Apagar a mensagem de
// agora deixaria o destinatario preso em "Aguardando mensagem" — e um
// `SENT_MESSAGES_RETENTION_DAYS=0` mal configurado faria exatamente isso, a cada
// hora. Daí a guarda, e daí este teste.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { purgeSentMessages, startJanitor } from '../dist/core/janitor.js';

const silentLog = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  child() { return silentLog; },
} as never;

/** Pool falso que registra as queries e devolve o rowCount combinado. */
function fakePool(rowCount = 0, erro?: Error) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  return {
    queries,
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (erro) throw erro;
      return { rows: [], rowCount };
    },
  };
}

describe('purgeSentMessages', () => {
  it('apaga por created_at usando a retencao em dias', async () => {
    const pool = fakePool(12);
    const n = await purgeSentMessages(pool as never, 7);
    assert.equal(n, 12);
    assert.equal(pool.queries.length, 1);
    assert.match(pool.queries[0]!.sql, /DELETE FROM wa_gateway\.sent_messages/);
    assert.match(pool.queries[0]!.sql, /created_at </, 'tem de filtrar por idade');
    assert.deepEqual(pool.queries[0]!.params, [7]);
  });

  it('passa os dias como PARAMETRO, nao interpolado na SQL', () => {
    // O valor vem de variavel de ambiente; interpolar como texto abriria a SQL.
    const pool = fakePool(0);
    return purgeSentMessages(pool as never, 30).then(() => {
      assert.ok(!pool.queries[0]!.sql.includes('30'), 'o 30 nao pode estar na SQL');
      assert.deepEqual(pool.queries[0]!.params, [30]);
    });
  });

  it('★ retencao 0 NAO apaga nada (apagaria a mensagem de agora)', async () => {
    // Sem esta guarda, SENT_MESSAGES_RETENTION_DAYS=0 apagaria a tabela inteira a
    // cada volta, e com ela a resposta a todo retry receipt.
    const pool = fakePool(999);
    assert.equal(await purgeSentMessages(pool as never, 0), 0);
    assert.equal(pool.queries.length, 0, 'nem deve chegar ao banco');
  });

  it('★ retencao negativa ou nao numerica NAO apaga nada', async () => {
    for (const v of [-1, NaN, Infinity]) {
      const pool = fakePool(999);
      assert.equal(await purgeSentMessages(pool as never, v), 0, `retencao ${v}`);
      assert.equal(pool.queries.length, 0);
    }
  });

  it('trunca retencao fracionaria (make_interval espera int)', async () => {
    const pool = fakePool(0);
    await purgeSentMessages(pool as never, 7.9);
    assert.deepEqual(pool.queries[0]!.params, [7]);
  });

  it('propaga o erro do banco (quem chama decide o que fazer)', async () => {
    const pool = fakePool(0, new Error('conexao caiu'));
    await assert.rejects(() => purgeSentMessages(pool as never, 7), /conexao caiu/);
  });
});

describe('startJanitor', () => {
  it('devolve uma funcao que para o timer', () => {
    const parar = startJanitor({ pool: fakePool() as never, log: silentLog });
    assert.equal(typeof parar, 'function');
    parar();  // nao deve lancar
  });

  it('★ falha no banco NAO propaga (nao pode derrubar o gateway)', async () => {
    // A limpeza e secundaria: se o DELETE falha, a proxima volta tenta de novo.
    // Mas o erro tem de ser LOGADO — purga que falha em silencio recria o
    // problema que este modulo existe para resolver.
    const erros: unknown[] = [];
    const log = { ...silentLog, info() {}, error(o: unknown) { erros.push(o); } } as never;
    const parar = startJanitor(
      { pool: fakePool(0, new Error('pool encerrado')) as never, log },
      10,
    );
    await new Promise((r) => setTimeout(r, 60));
    parar();
    // O intervalo curto garante ao menos uma volta; a primeira volta agendada tem
    // delay de 30s, então o que dispara aqui é o setInterval.
    assert.ok(erros.length > 0, 'o erro tem de ir para o log');
  });

  it('emite evento no barramento quando apaga (aparece no painel)', async () => {
    const emitidos: Array<{ kind: string; msg: string }> = [];
    const events = {
      emit(kind: string, _s: string | null, msg: string) { emitidos.push({ kind, msg }); },
    };
    const parar = startJanitor(
      { pool: fakePool(5) as never, log: silentLog, events: events as never },
      10,
    );
    await new Promise((r) => setTimeout(r, 60));
    parar();
    assert.ok(emitidos.length > 0, 'purga com linhas apagadas tem de emitir evento');
    assert.equal(emitidos[0]!.kind, 'janitor');
    assert.match(emitidos[0]!.msg, /limpeza: 5 /);
  });

  it('NAO emite evento quando nao havia nada para apagar', async () => {
    // Evento a cada hora dizendo "apaguei 0" seria ruido que esconde o resto.
    const emitidos: unknown[] = [];
    const events = { emit() { emitidos.push(1); } };
    const parar = startJanitor(
      { pool: fakePool(0) as never, log: silentLog, events: events as never },
      10,
    );
    await new Promise((r) => setTimeout(r, 60));
    parar();
    assert.deepEqual(emitidos, []);
  });
});
