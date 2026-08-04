// tests/backup.test.ts
//
// Backup do pareamento. O que se testa aqui é o CÁLCULO DE RISCO — porque um
// aviso errado nas duas direções custa caro:
//   falso positivo → o operador aprende a ignorar a faixa, e ela não serve para nada
//   falso negativo → ele perde o pareamento de todos os canais sem ter sido avisado

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { backupStatus, dumpAuth, restoreAuth } from '../dist/core/backup.js';

/**
 * Pool falso: responde a query de contagem e a de marcos, e registra o que foi
 * escrito para os testes de restore.
 */
function makePool(opts: {
  paired?: number;
  sessions?: number;
  ultimaMudanca?: string | null;
  marks?: Record<string, string>;
  tabelas?: Record<string, unknown[]>;
} = {}) {
  const marks = { ...(opts.marks ?? {}) };
  const escritas: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    marks,
    escritas,
    async query(sql: string, params: unknown[] = []) {
      const q = sql.replace(/\s+/g, ' ').trim();
      escritas.push({ sql: q, params });

      if (q.startsWith('SELECT count(*) AS total')) {
        return {
          rows: [{
            total: String(opts.sessions ?? opts.paired ?? 0),
            paired: String(opts.paired ?? 0),
            ultima: opts.ultimaMudanca ?? null,
          }],
        };
      }
      if (q.startsWith('SELECT at FROM elo.marks')) {
        const k = params[0] as string;
        return { rows: marks[k] ? [{ at: marks[k] }] : [] };
      }
      if (q.startsWith('INSERT INTO elo.marks')) {
        marks[params[0] as string] = new Date().toISOString();
        return { rows: [] };
      }
      if (q.startsWith('SELECT * FROM elo.')) {
        const t = q.replace('SELECT * FROM elo.', '').trim();
        return { rows: opts.tabelas?.[t] ?? [] };
      }
      return { rows: [] };
    },
    async connect() {
      return { query: pool.query, release() {} };
    },
  };
  return pool;
}

describe('backupStatus: quando avisar', () => {
  it('SEM sessao pareada NAO avisa (nada a perder ainda)', async () => {
    // Instalação nova. Mostrar aviso aqui treinaria o operador a ignorá-lo — o
    // custo real de um falso positivo.
    const st = await backupStatus(makePool({ paired: 0, sessions: 2 }) as never);
    assert.equal(st.risk, 'none');
  });

  it('★ pareado e NUNCA houve backup: avisa (o caso que motiva a feature)', async () => {
    const st = await backupStatus(makePool({ paired: 3, sessions: 3 }) as never);
    assert.equal(st.risk, 'no_backup');
    assert.match(st.message, /3 sessões pareadas/);
    assert.match(st.message, /QR/, 'a mensagem diz qual e a consequencia');
  });

  it('singular no texto quando e uma sessao so', async () => {
    const st = await backupStatus(makePool({ paired: 1, sessions: 1 }) as never);
    assert.match(st.message, /1 sessão pareada/);
  });

  it('backup DEPOIS da ultima mudanca: em dia, nao avisa', async () => {
    const st = await backupStatus(makePool({
      paired: 2,
      ultimaMudanca: '2026-07-01T10:00:00Z',
      marks: { last_backup: '2026-07-02T10:00:00Z' },
    }) as never);
    assert.equal(st.risk, 'ok');
  });

  it('backup ANTES da ultima mudanca: desatualizado, avisa', async () => {
    const st = await backupStatus(makePool({
      paired: 2,
      ultimaMudanca: '2026-07-05T10:00:00Z',
      marks: { last_backup: '2026-07-01T10:00:00Z' },
    }) as never);
    assert.equal(st.risk, 'stale');
  });

  it('compara com a ULTIMA MUDANCA, nao com "agora"', async () => {
    // Um backup de meses atrás está em dia se o pareamento não mudou desde então.
    // Comparar com o relógio geraria alarme permanente — e alarme permanente é
    // alarme ignorado.
    const st = await backupStatus(makePool({
      paired: 1,
      ultimaMudanca: '2026-01-10T00:00:00Z',
      marks: { last_backup: '2026-01-11T00:00:00Z' },
    }) as never);
    assert.equal(st.risk, 'ok');
  });

  it('pareado, com backup, mas sem registro de mudanca: considera em dia', async () => {
    const st = await backupStatus(makePool({
      paired: 1, ultimaMudanca: null, marks: { last_backup: '2026-07-01T00:00:00Z' },
    }) as never);
    assert.equal(st.risk, 'ok');
  });

  it('erro ao ler marcos nao derruba o status', async () => {
    // A faixa é informativa: falhar aqui não pode impedir o painel de carregar.
    const pool = {
      async query(sql: string) {
        if (sql.includes('marks')) throw new Error('sem tabela');
        return { rows: [{ total: '1', paired: '1', ultima: null }] };
      },
      async connect() { return { query: async () => ({ rows: [] }), release() {} }; },
    };
    const st = await backupStatus(pool as never);
    assert.equal(st.paired, 1);
    assert.equal(st.risk, 'no_backup', 'sem marco = sem backup');
  });
});

describe('dumpAuth: o que entra no arquivo', () => {
  const tabelas = {
    sessions: [{ name: 'canal', label: 'Canal', config: { a: 1 } }],
    auth_creds: [{ session_name: 'canal', creds: { me: 'x' } }],
    auth_keys: [
      { session_name: 'canal', key_type: 'session', key_id: '1', key_data: {} },
      { session_name: 'canal', key_type: 'pre-key', key_id: '2', key_data: {} },
    ],
    lid_map: [{ session_name: 'canal', lid: '1@lid', phone: '5511999999999' }],
  };

  it('inclui as 4 tabelas do pareamento', async () => {
    const d = await dumpAuth(makePool({ tabelas }) as never) as {
      data: Record<string, unknown[]>; counts: Record<string, number>;
    };
    assert.deepEqual(Object.keys(d.data), ['sessions', 'auth_creds', 'auth_keys', 'lid_map']);
    assert.equal(d.counts.auth_keys, 2);
  });

  it('NAO inclui sent_messages (cache de transito, e o que mais cresce)', async () => {
    const d = await dumpAuth(makePool({ tabelas }) as never) as { data: Record<string, unknown[]> };
    assert.ok(!('sent_messages' in d.data));
  });

  it('carrega o AVISO de que contem as chaves do WhatsApp', async () => {
    // O arquivo circula (e-mail, Drive, pendrive). O aviso tem de viajar com ele.
    const d = await dumpAuth(makePool({ tabelas }) as never) as { aviso: string };
    assert.match(d.aviso, /CHAVES/);
    assert.match(d.aviso, /passar pelo numero/);
  });

  it('tem versao de formato (o restore recusa o que nao entende)', async () => {
    const d = await dumpAuth(makePool({ tabelas }) as never) as { format: number };
    assert.equal(d.format, 1);
  });
});

describe('restoreAuth', () => {
  it('recusa formato desconhecido em vez de gravar pela metade', async () => {
    await assert.rejects(
      () => restoreAuth(makePool() as never, { format: 99, data: {} }),
      /formato de backup desconhecido/,
    );
  });

  it('recusa dump sem format', async () => {
    await assert.rejects(
      () => restoreAuth(makePool() as never, {} as never),
      /formato/,
    );
  });

  it('apaga na ordem INVERSA das FKs e insere na direta', async () => {
    const pool = makePool();
    await restoreAuth(pool as never, {
      format: 1,
      data: { sessions: [{ name: 'canal' }], auth_creds: [], auth_keys: [], lid_map: [] },
    });
    const deletes = pool.escritas.filter((e) => e.sql.startsWith('DELETE FROM'))
      .map((e) => e.sql.replace('DELETE FROM elo.', ''));
    // lid_map depende de sessions: apagar sessions primeiro violaria a FK.
    assert.deepEqual(deletes, ['lid_map', 'auth_keys', 'auth_creds', 'sessions']);
  });

  it('serializa JSONB (o driver precisa de string, nao de objeto)', async () => {
    const pool = makePool();
    await restoreAuth(pool as never, {
      format: 1,
      data: {
        sessions: [{ name: 'canal', config: { webhooks: [{ url: 'x' }] } }],
        auth_creds: [], auth_keys: [], lid_map: [],
      },
    });
    const ins = pool.escritas.find((e) => e.sql.includes('INSERT INTO elo.sessions'))!;
    const cfg = ins.params.find((p) => typeof p === 'string' && p.startsWith('{'));
    assert.ok(cfg, 'o config tem de ir como STRING JSON');
  });

  it('devolve a contagem restaurada por tabela', async () => {
    const out = await restoreAuth(makePool() as never, {
      format: 1,
      data: {
        sessions: [{ name: 'a' }, { name: 'b' }],
        auth_creds: [{ session_name: 'a', creds: {} }],
        auth_keys: [], lid_map: [],
      },
    });
    assert.equal(out.restored.sessions, 2);
    assert.equal(out.restored.auth_creds, 1);
  });
});
