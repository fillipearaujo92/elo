// src/core/janitor.ts
//
// Limpeza periodica das tabelas de transito.
//
// ── Por que este modulo existe ─────────────────────────────────────────────
// `SENT_MESSAGES_RETENTION_DAYS` existia em config.ts desde o inicio e NUNCA era
// lido em nenhum lugar do codigo — verificado por varredura. Nao havia nenhum
// `DELETE FROM sent_messages` no projeto, nem cron, nem setInterval. Ou seja: a
// tabela crescia para sempre, e a "retencao de 7 dias" citada no README, no
// README.pt-BR e nos comentarios de send.ts/session-manager.ts era documentacao
// de um comportamento que nao existia.
//
// Isso importa porque `sent_messages.content` guarda o proto COMPLETO da mensagem
// enviada — inclusive de midia. Um canal ativo escreve uma linha por envio, para
// sempre, no mesmo volume onde vive o pareamento. Medido no beta: 438 linhas /
// 440 kB em pouco mais de um dia de uso leve.
//
// O indice `sent_messages_created_idx ON (created_at)` (schema.sql:92) ja existia
// — aparentemente criado PARA esta limpeza, que nunca chegou.
//
// ── O que a purga custa ────────────────────────────────────────────────────
// `sent_messages` responde a retry receipts: quando o aparelho do destinatario
// nao consegue decifrar, ele pede o reenvio e o gateway responde com o conteudo
// guardado (session-manager.ts:848). Purgar significa que um retry receipt de uma
// mensagem antiga fica sem resposta — o aparelho mostra "Aguardando mensagem".
// Retry receipts chegam em minutos, entao 7 dias e folga enorme; e /forwardMessage
// e /resendMessage passam a devolver 404 para mensagem antiga, que e exatamente o
// que a documentacao SEMPRE prometeu.

import type { Pool } from 'pg';
import { config } from '../config.js';
import { inc } from './metrics.js';
import type { events as eventBus } from './events.js';

/** Sessao usada nos contadores globais: a purga nao e por sessao. */
const GLOBAL = '*';

export interface JanitorDeps {
  pool: Pool;
  log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
  events?: Pick<typeof eventBus, 'emit'>;
}

/**
 * Apaga as linhas de `sent_messages` mais velhas que a retencao configurada.
 *
 * Devolve quantas linhas sairam. Exportada separada do agendamento para ser
 * testavel sem timer — o padrao que o resto do projeto usa (core puro, borda fina).
 */
export async function purgeSentMessages(pool: Pool, retentionDays: number): Promise<number> {
  // Retencao <= 0 desliga a purga. Sem esta guarda, um `SENT_MESSAGES_RETENTION_DAYS=0`
  // mal configurado apagaria TUDO a cada volta, inclusive a mensagem enviada no
  // segundo anterior — e com ela a resposta a qualquer retry receipt.
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;

  // `make_interval` em vez de interpolar a string do intervalo: o valor vem de
  // variavel de ambiente e nao deve entrar na SQL como texto.
  const r = await pool.query(
    `DELETE FROM elo.sent_messages
      WHERE created_at < NOW() - make_interval(days => $1::int)`,
    [Math.floor(retentionDays)],
  );
  return r.rowCount ?? 0;
}

/**
 * Agenda a limpeza. Devolve uma funcao para parar (usada no shutdown).
 *
 * Roda uma vez no boot e depois a cada hora. A primeira volta e adiada em 30s
 * para nao competir com a restauracao das sessoes, que e o que importa no boot.
 */
export function startJanitor(deps: JanitorDeps, intervalMs = 3_600_000): () => void {
  const { pool, log, events } = deps;
  let rodando = false;

  const volta = async (): Promise<void> => {
    // Uma volta por vez: com retencao curta e tabela grande, um DELETE pode passar
    // da hora e duas voltas concorrentes brigariam pelas mesmas linhas.
    if (rodando) return;
    rodando = true;
    try {
      const dias = config.sentMessagesRetentionDays;
      const n = await purgeSentMessages(pool, dias);
      if (n > 0) {
        inc('sent_messages_purged_total', GLOBAL, n);
        log.info({ linhas: n, dias }, 'purga de sent_messages');
        events?.emit('janitor', null, `limpeza: ${n} mensagens enviadas com mais de ${dias} dias`, {
          linhas: n,
          dias,
        });
      }
    } catch (err) {
      // Falha de limpeza NAO pode derrubar o gateway nem interromper o agendamento:
      // a proxima volta tenta de novo. Mas tem de aparecer — purga que falha em
      // silencio recria exatamente o problema que este modulo resolve.
      const msg = (err as Error).message;
      log.error({ err: msg }, 'falha na purga de sent_messages');
      events?.emit('janitor', null, `falha na limpeza de mensagens antigas: ${msg}`, undefined, 'error');
    } finally {
      rodando = false;
    }
  };

  const primeira = setTimeout(() => void volta(), 30_000);
  primeira.unref?.();
  const timer = setInterval(() => void volta(), intervalMs);
  timer.unref?.();

  return () => {
    clearTimeout(primeira);
    clearInterval(timer);
  };
}
