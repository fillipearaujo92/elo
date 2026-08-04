// src/core/log-options.ts
//
// Opcoes do logger, em modulo proprio.
//
// ── Por que este modulo existe ─────────────────────────────────────────────
// As opcoes viviam inline no `Fastify({ logger: {...} })` do server.ts, e o server.ts
// NAO E IMPORTAVEL em teste: importa-lo conecta no Postgres e faz `app.listen()`.
// Consequencia pratica, MEDIDA por mutacao: um teste que monta o proprio pino com
// opcoes copiadas a mao passa igual quando a configuracao REAL e quebrada — ele testa
// o pino, nao o ELO. Reverter `formatters.level` para devolver o numero deixou a suite
// 100% verde.
//
// E a mesma licao de core/access.ts (os assets do Swagger em 401 com CI verde): regra
// que vive so no server.ts e regra que nenhum teste alcanca.

import type { LoggerOptions } from 'pino';

/**
 * Paths censurados no log.
 *
 * ★ CIRURGICOS de proposito, e isso foi medido. A primeira versao usava `url` e `*.url`
 * genericos — e o teste com pino real mostrou que isso censura tambem `req.url`, o
 * caminho da requisicao no log de acesso. Ou seja: cegava o diagnostico ("qual rota deu
 * erro?") para esconder algo que nao e segredo. Protecao que apaga evidencia legitima
 * acaba desligada pelo operador.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers["x-api-key"]',
  'req.headers["X-Api-Key"]',
  'headers["x-api-key"]',
  // URL de webhook, caso alguem volte a logar o objeto cru. A defesa PRINCIPAL e
  // `urlSegura()` em core/webhook.ts, que sanitiza na origem — ver
  // tests/segredo-em-log.test.ts. Estes paths sao a rede embaixo dela.
  'w.url',
  'webhook.url',
  // Valor de header customizado — e por padrao a chave do webhook.
  '*.customHeaders[*].value',
  'config.webhooks[*].customHeaders[*].value',
];

/**
 * Monta as opcoes do logger do gateway.
 *
 * Recebe versao e commit em vez de le-los: mantem a funcao pura e testavel, e deixa o
 * server.ts como unico lugar que sabe de onde esses valores vem.
 */
export function buildLoggerOptions(opts: {
  level: string;
  version: string;
  commit: string | null;
}): LoggerOptions {
  return {
    level: opts.level,

    // ★ `time` em epoch de MILISSEGUNDOS e o default do pino, e e ilegivel: quem abre
    // `docker logs` durante um incidente le `"time":1785846419593` e nao correlaciona
    // com o horario do relato sem converter a mao. ISO-8601 em UTC resolve, mantem
    // ordenacao lexicografica e continua parseavel por coletor.
    timestamp: () => `,"time":"${new Date().toISOString()}"`,

    // ★ `svc`/`v`/`commit` em TODA linha. Quando um erro chega por print de tela ou por
    // copia de log, a pergunta seguinte e sempre "qual versao estava rodando?" — sem
    // isso e preciso cruzar horario com historico de deploy. E `svc` separa o ELO dos
    // outros servicos quando dividem coletor (no beta, o Loki recebe os dois).
    base: { svc: 'elo', v: opts.version, commit: opts.commit },

    formatters: {
      // ★ Nivel por NOME em vez de numero. `"level":30` exige tabela de conversao e
      // impede o que o operador faz de verdade: `grep '"level":"error"'` no log cru.
      level: (label) => ({ level: label }),
    },

    // ★ Sem `redact` havia vazamento CONCRETO: core/webhook.ts logava a URL crua do
    // webhook, e os dois padroes comuns de webhook autenticado (token na query,
    // credencial embutida) iam para o log em texto puro. Log e o lugar menos protegido
    // de uma instalacao — vai para arquivo, journald e qualquer coletor.
    //
    // `censor` explicito em vez de remover a chave: ver `[oculto]` diz que o campo
    // EXISTE e foi escondido; campo ausente parece bug de instrumentacao.
    redact: { paths: [...REDACT_PATHS], censor: '[oculto]' },
  };
}
