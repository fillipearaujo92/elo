// src/core/backup.ts
//
// Backup do que NÃO dá para recriar: o pareamento do WhatsApp.
//
// ── Por que existe ─────────────────────────────────────────────────────────
// O volume do Postgres É o pareamento. Perdê-lo obriga a escanear o QR de todas
// as sessões novamente — e num gateway com vários canais de atendimento isso
// significa parar o atendimento e ter cada aparelho em mãos.
//
// O README avisa. Mas aviso em documentação é lido DEPOIS de perder, então o
// gateway passa a: (1) oferecer um dump em um clique, e (2) dizer no painel
// quando há pareamento sem backup.
//
// ── O que entra e o que NÃO entra ──────────────────────────────────────────
// ENTRA: sessions, auth_creds, auth_keys, lid_map — o que reconstrói a conexão.
// FICA FORA: sent_messages. É cache de trânsito (retenção de 7 dias, serve para
// responder retry receipts) e é o que mais cresce. Incluí-lo faria o backup
// pesar dezenas de MB sem tornar a restauração melhor.
//
// ── Aviso de segurança, no próprio arquivo ─────────────────────────────────
// O dump contém as CHAVES DO SIGNAL: quem o obtém consegue se passar pelo número
// conectado — ler e enviar mensagens. É tão sensível quanto o banco inteiro. Por
// isso o endpoint exige a API key e o arquivo carrega esse aviso no cabeçalho.

import type { Pool } from 'pg';

/** Tabelas que compõem o pareamento, na ordem em que devem ser restauradas (FK). */
const TABELAS = ['sessions', 'auth_creds', 'auth_keys', 'lid_map'] as const;

export interface BackupStatus {
  /** Sessões com pareamento (me_id preenchido). */
  paired: number;
  /** Total de sessões. */
  sessions: number;
  /** Quando este banco nasceu. */
  dbCreatedAt: string | null;
  /** Último backup feito por este endpoint. */
  lastBackupAt: string | null;
  /**
   * Risco calculado, para o painel decidir o que mostrar:
   *   'none'      sem pareamento a perder (nada a avisar)
   *   'no_backup' há pareamento e NUNCA houve backup
   *   'stale'     último backup antes da última mudança de pareamento
   *   'ok'        backup mais recente que a última mudança
   */
  risk: 'none' | 'no_backup' | 'stale' | 'ok';
  /** Frase pronta, para o painel não reinventar o texto. */
  message: string;
}

/** Lê um marco. */
async function mark(pool: Pool, key: string): Promise<string | null> {
  const r = await pool
    .query<{ at: string }>(`SELECT at FROM wa_gateway.marks WHERE key = $1`, [key])
    .catch(() => ({ rows: [] as Array<{ at: string }> }));
  return r.rows[0]?.at ?? null;
}

/** Grava/atualiza um marco. */
export async function setMark(pool: Pool, key: string, detail?: string): Promise<void> {
  await pool
    .query(
      `INSERT INTO wa_gateway.marks (key, at, detail) VALUES ($1, NOW(), $2)
       ON CONFLICT (key) DO UPDATE SET at = NOW(), detail = EXCLUDED.detail`,
      [key, detail ?? null],
    )
    .catch(() => {});
}

/**
 * Estado do backup e o risco associado.
 *
 * O risco compara o último backup com a última MUDANÇA de pareamento
 * (`auth_creds.updated_at`), não com "agora": um backup de ontem está em dia se
 * nada mudou desde então. Comparar com o relógio geraria alarme permanente.
 */
export async function backupStatus(pool: Pool): Promise<BackupStatus> {
  const s = await pool.query<{ total: string; paired: string; ultima: string | null }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE me_id IS NOT NULL) AS paired,
            (SELECT max(updated_at)::text FROM wa_gateway.auth_creds) AS ultima
       FROM wa_gateway.sessions`,
  );
  const paired = Number(s.rows[0]?.paired ?? 0);
  const sessions = Number(s.rows[0]?.total ?? 0);
  const ultimaMudanca = s.rows[0]?.ultima ?? null;

  const dbCreatedAt = await mark(pool, 'db_created');
  const lastBackupAt = await mark(pool, 'last_backup');

  let risk: BackupStatus['risk'] = 'none';
  let message = 'Nenhuma sessão pareada — não há pareamento a perder ainda.';

  if (paired > 0) {
    if (!lastBackupAt) {
      risk = 'no_backup';
      message =
        `${paired} ${paired === 1 ? 'sessão pareada' : 'sessões pareadas'} e nenhum backup feito. ` +
        'Se o volume do banco for perdido, será preciso escanear o QR de todas de novo.';
    } else if (ultimaMudanca && new Date(lastBackupAt) < new Date(ultimaMudanca)) {
      risk = 'stale';
      message =
        'O pareamento mudou depois do último backup. Vale baixar um novo.';
    } else {
      risk = 'ok';
      message = 'Backup em dia com o pareamento atual.';
    }
  }

  return { paired, sessions, dbCreatedAt, lastBackupAt, risk, message };
}

/**
 * Dump do pareamento como JSON.
 *
 * JSON e não `pg_dump` de propósito: não exige o cliente do Postgres instalado,
 * funciona igual em qualquer sistema, e o formato é inspecionável — quem restaura
 * consegue ver o que está restaurando. O custo é precisar do endpoint de restore
 * (não dá para `psql < arquivo`), o que é aceitável para 4 tabelas.
 */
export async function dumpAuth(pool: Pool): Promise<Record<string, unknown>> {
  const dados: Record<string, unknown[]> = {};
  for (const t of TABELAS) {
    const r = await pool.query(`SELECT * FROM wa_gateway.${t}`);
    dados[t] = r.rows;
  }
  return {
    // Versão do formato: se as tabelas mudarem, o restore sabe recusar um dump
    // que não entende, em vez de gravar pela metade.
    format: 1,
    generatedAt: new Date().toISOString(),
    aviso:
      'CONTEM AS CHAVES DO WHATSAPP. Quem tiver este arquivo consegue se passar ' +
      'pelo numero conectado: ler e enviar mensagens. Guarde como guarda senha.',
    counts: Object.fromEntries(Object.entries(dados).map(([k, v]) => [k, v.length])),
    data: dados,
  };
}

/**
 * Restaura um dump gerado por `dumpAuth`.
 *
 * Numa transação: um restore parcial deixaria o estado Signal inconsistente, que
 * é pior que não ter restaurado — o socket subiria e falharia a decifrar tudo.
 */
export async function restoreAuth(
  pool: Pool,
  dump: { format?: number; data?: Record<string, unknown[]> },
): Promise<{ restored: Record<string, number> }> {
  if (dump?.format !== 1) {
    throw new Error('formato de backup desconhecido (esperado format: 1)');
  }
  const data = dump.data ?? {};
  const restored: Record<string, number> = {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Ordem inversa para apagar (respeita as FKs), direta para inserir.
    for (const t of [...TABELAS].reverse()) {
      await client.query(`DELETE FROM wa_gateway.${t}`);
    }
    for (const t of TABELAS) {
      const linhas = data[t] ?? [];
      for (const linha of linhas) {
        const cols = Object.keys(linha as object);
        if (!cols.length) continue;
        const vals = cols.map((c) => (linha as Record<string, unknown>)[c]);
        const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
        await client.query(
          `INSERT INTO wa_gateway.${t} (${cols.map((c) => `"${c}"`).join(', ')})
           VALUES (${ph}) ON CONFLICT DO NOTHING`,
          vals.map((v) =>
            // JSONB volta do JSON como objeto; o driver precisa de string.
            v !== null && typeof v === 'object' ? JSON.stringify(v) : v,
          ),
        );
      }
      restored[t] = linhas.length;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { restored };
}
