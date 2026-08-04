// src/core/auth-state.ts
//
// Adapter de AuthenticationState do Baileys sobre Postgres, no lugar do
// useMultiFileAuthState (que grava arquivos soltos em disco).
//
// Por que Postgres e nao disco:
//   1. O deploy e Docker no Swarm; container sem volume perde o pareamento e exige
//      QR novo a cada deploy. Requisito 6 da verificacao do plano: `docker restart`
//      deve restaurar a sessao SEM novo QR.
//   2. Multiplas replicas nao podem compartilhar arquivos de sessao com seguranca.
//      (Uma sessao WhatsApp aceita UM socket; a coordenacao de qual replica roda
//      qual sessao esta em session-manager.ts.)
//
// Serializacao: as creds do Baileys contem Buffer/Uint8Array (chaves de cripto).
// JSON.stringify comum os destroi. O Baileys expoe BufferJSON.replacer/reviver
// exatamente para isso, e e o que o useMultiFileAuthState usa internamente.

import { BufferJSON, initAuthCreds, proto } from 'baileys';
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
} from 'baileys';
import type { Pool } from 'pg';

export interface AuthStateHandle {
  state: AuthenticationState;
  /** Persiste as creds. Ligar no evento `creds.update` do socket. */
  saveCreds: () => Promise<void>;
}

/**
 * Fila de gravacao POR SESSAO.
 *
 * O Baileys chama `keys.set()` uma vez por TIPO de chave, em paralelo
 * (auth-utils.js:206, `// Write all data in parallel`). Sem serializar, duas
 * transacoes concorrentes podem comitar pela metade uma da outra e deixar o
 * estado Signal inconsistente — a causa do "Bad MAC" que derrubou o inbound.
 *
 * Uma promessa por sessao, encadeada. `.catch` no elo evita que uma falha
 * envenene a cadeia (a rejeicao ainda chega a QUEM chamou, via `p`).
 */
const writeQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(sessionName: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(sessionName) ?? Promise.resolve();
  const p = prev.then(fn, fn);
  writeQueues.set(
    sessionName,
    p.catch(() => {}),
  );
  return p;
}

/** Libera a fila de uma sessao removida (evita vazamento no mapa). */
export function forgetAuthQueue(sessionName: string): void {
  writeQueues.delete(sessionName);
}

/** Serializa preservando Buffers (BufferJSON) e devolve objeto pronto para JSONB. */
function encode(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

function decode<T>(raw: unknown): T {
  // pg devolve JSONB ja parseado como objeto. Reserializamos e passamos pelo reviver
  // para reconstruir os Buffers a partir do shape {type:'Buffer',data:[...]}.
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return JSON.parse(text, BufferJSON.reviver) as T;
}

export async function usePostgresAuthState(
  pool: Pool,
  sessionName: string,
): Promise<AuthStateHandle> {
  // 1. Carrega (ou cria) as credenciais da sessao.
  const credsRes = await pool.query<{ creds: unknown }>(
    `SELECT creds FROM elo.auth_creds WHERE session_name = $1`,
    [sessionName],
  );

  const creds: AuthenticationCreds = credsRes.rows[0]
    ? decode<AuthenticationCreds>(credsRes.rows[0].creds)
    : initAuthCreds();

  const saveCreds = async (): Promise<void> => {
    await pool.query(
      `INSERT INTO elo.auth_creds (session_name, creds, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (session_name)
         DO UPDATE SET creds = EXCLUDED.creds, updated_at = NOW()`,
      [sessionName, encode(creds)],
    );
  };

  // 2. Signal key store. O contrato exige get(type, ids) em LOTE e set(dataSet).
  const state: AuthenticationState = {
    creds,
    keys: {
      async get<T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[],
      ): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        if (!ids.length) return out;

        const res = await pool.query<{ key_id: string; key_data: unknown }>(
          `SELECT key_id, key_data FROM elo.auth_keys
            WHERE session_name = $1 AND key_type = $2 AND key_id = ANY($3::text[])`,
          [sessionName, type, ids],
        );

        for (const row of res.rows) {
          let value = decode<SignalDataTypeMap[T]>(row.key_data);
          // Caso especial documentado no useMultiFileAuthState: a app-state-sync-key
          // precisa voltar como instancia do proto, nao objeto cru, senao o Baileys
          // falha ao sincronizar o estado do app (contatos/chats).
          if (type === 'app-state-sync-key' && value) {
            // O cast passa por `unknown`: AppStateSyncKeyData nao se sobrepoe ao
            // tipo generico SignalDataTypeMap[T] (o TS reclama, com razao), mas
            // dentro deste `if` o T e provadamente 'app-state-sync-key'.
            value = proto.Message.AppStateSyncKeyData.fromObject(
              value as object,
            ) as unknown as SignalDataTypeMap[T];
          }
          out[row.key_id] = value;
        }
        return out;
      },

      async set(data): Promise<void> {
        // data = { [type]: { [id]: value | null } }. null = REMOVER a chave
        // (pre-key consumida).
        //
        // ★ SERIALIZADO por sessao (fila abaixo). Motivo medido no codigo do
        // Baileys: fora de transacao, ele chama este set() UMA VEZ POR TIPO, em
        // paralelo — `// Write all data in parallel` em
        // node_modules/baileys/lib/Utils/auth-utils.js:206. Ou seja, a transacao
        // aqui cobre UM tipo, nunca o conjunto. O caso ruim e concreto: decifrar
        // mensagem de contato novo gera { session: {...}, 'pre-key': { N: null } };
        // se a transacao do `pre-key` comita (chave consumida some) e a do
        // `session` falha, o ratchet perde de onde retomar e o proximo boot da
        // "Bad MAC" — o inbound perdido que motivou este trabalho.
        //
        // Enfileirar resolve porque o gargalo nao e vazao (sao poucas chaves por
        // mensagem) e sim consistencia entre tipos.
        return enqueue(sessionName, async () => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            // ORDEM IMPORTA: gravar/atualizar ANTES de apagar. Se algo falhar no
            // meio, sobra uma pre-key ja consumida no banco (inofensivo — o
            // WhatsApp nao a reutiliza) em vez de um session record orfao.
            const ops: Array<[string, string, unknown]> = [];
            const dels: Array<[string, string]> = [];
            for (const [type, entries] of Object.entries(data)) {
              if (!entries) continue;
              for (const [id, value] of Object.entries(entries)) {
                if (value === null || value === undefined) dels.push([type, id]);
                else ops.push([type, id, value]);
              }
            }
            for (const [type, id, value] of ops) {
              await client.query(
                `INSERT INTO elo.auth_keys
                   (session_name, key_type, key_id, key_data, updated_at)
                 VALUES ($1, $2, $3, $4::jsonb, NOW())
                 ON CONFLICT (session_name, key_type, key_id)
                   DO UPDATE SET key_data = EXCLUDED.key_data, updated_at = NOW()`,
                [sessionName, type, id, encode(value)],
              );
            }
            for (const [type, id] of dels) {
              await client.query(
                `DELETE FROM elo.auth_keys
                  WHERE session_name = $1 AND key_type = $2 AND key_id = $3`,
                [sessionName, type, id],
              );
            }
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            // ★ Propaga de proposito. O makeCacheableSignalKeyStore do Baileys
            // grava no CACHE ANTES de chamar este set() (auth-utils.js:63-68),
            // entao engolir o erro deixaria cache e banco divergentes: o socket
            // em execucao continuaria funcionando e o proximo boot quebraria.
            // Falhar alto e o unico jeito de isso aparecer enquanto da para agir.
            throw err;
          } finally {
            client.release();
          }
        });
      },
    },
  };

  return { state, saveCreds };
}

/**
 * Apaga TODO o estado de autenticacao da sessao (creds + keys). Chamado em duas
 * situacoes: DELETE /api/sessions/{s} e logout detectado (401), quando as creds
 * viraram lixo e mante-las faria o socket tentar reconectar com pareamento morto.
 */
export async function clearAuthState(pool: Pool, sessionName: string): Promise<void> {
  await pool.query(`DELETE FROM elo.auth_creds WHERE session_name = $1`, [sessionName]);
  await pool.query(`DELETE FROM elo.auth_keys WHERE session_name = $1`, [sessionName]);
}
