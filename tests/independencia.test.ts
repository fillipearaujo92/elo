// tests/independencia.test.ts
//
// O ELO e um produto INDEPENDENTE.
//
// ── Por que estes testes existem ───────────────────────────────────────────
// O ELO nasceu dentro de um repositorio de um sistema de chat especifico, e por meses o
// codigo tratou aquele consumidor como se fosse o CONTRATO: comentarios citavam arquivos
// dele (`waha.js`, `waha-translate.js`), funcoes dele (`extractMsgId`, `applyAck`),
// tabelas dele (`channels.identifier`) e configuracao dele (`app_settings.waha.api_key`).
//
// Isso nao e cosmetico. Tem tres consequencias concretas:
//
//   1. Quem instala o ELO no proprio servidor le a documentacao interna e nao entende o
//      que e CONTRATO (precisa cumprir) e o que e detalhe de OUTRO sistema (pode ignorar).
//   2. Um mantenedor futuro "corrige" o ELO para casar com o consumidor de referencia e
//      quebra todos os outros — o acoplamento vira requisito sem nunca ter sido decidido.
//   3. O repositorio publico expunha o desenho interno de um cliente especifico.
//
// Estes testes travam a fronteira. Falham quando o nome de um consumidor especifico, ou o
// esquema interno dele, reaparece no codigo do produto.
//
// ★ O que NAO e proibido: falar do dialeto do WAHA. O ELO fala WAHA de proposito — e o
// que permite instala-lo NO LUGAR do WAHA sem trocar o driver do outro lado. WAHA e
// Evolution sao PRODUTOS que o ELO substitui, nao consumidores dele.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// ★ `fileURLToPath` e nao `URL.pathname`: no Windows o pathname vem como "/C:/Users/..."
// (com a barra inicial) e o readdirSync falha. E o mesmo motivo de o projeto usar
// `fileURLToPath` no server.ts para achar o package.json.
const raizSrc = fileURLToPath(new URL('../src/', import.meta.url));

/** Todo arquivo de codigo/schema/painel do produto, recursivo. */
function arquivosDoProduto(dir = raizSrc, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) arquivosDoProduto(p, acc);
    else if (/\.(ts|sql|html)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const arquivos = arquivosDoProduto().map((p) => ({
  path: p.replace(raizSrc, 'src/'),
  texto: readFileSync(p, 'utf8'),
}));

describe('independencia: nenhum consumidor especifico e nomeado', () => {
  it('★ o codigo do produto nao cita o consumidor de referencia pelo nome', () => {
    // O ELO serve qualquer chat omnichannel. Nomear um consumidor no codigo transforma
    // "exemplo de integracao" em "requisito", e e o que faz o proximo mantenedor achar
    // que precisa daquele sistema para o gateway funcionar.
    const achados: string[] = [];
    for (const { path, texto } of arquivos) {
      for (const [i, linha] of texto.split('\n').entries()) {
        if (/sysled/i.test(linha)) achados.push(`${path}:${i + 1}: ${linha.trim().slice(0, 88)}`);
      }
    }
    assert.deepEqual(achados, [], `consumidor nomeado no codigo do produto:\n${achados.join('\n')}`);
  });

  it('★ nao referencia o ESQUEMA interno de um consumidor', () => {
    // `channels.identifier` e `app_settings.waha.api_key` sao tabela e configuracao de
    // OUTRO sistema. Documentar isso aqui obriga quem instala o ELO a ter o mesmo
    // esquema — que e exatamente o oposto de ser instalavel em qualquer lugar.
    const proibidos = [/channels\.identifier/i, /app_settings/i, /waha\.api_key/i];
    const achados: string[] = [];
    for (const { path, texto } of arquivos) {
      for (const [i, linha] of texto.split('\n').entries()) {
        if (proibidos.some((r) => r.test(linha))) {
          achados.push(`${path}:${i + 1}: ${linha.trim().slice(0, 88)}`);
        }
      }
    }
    assert.deepEqual(achados, [], `esquema de consumidor no produto:\n${achados.join('\n')}`);
  });

  it('★ nao cita ARQUIVOS do consumidor como se fossem a especificacao', () => {
    // `waha.js` e `waha-translate.js` sao arquivos do driver de UM consumidor. Quando o
    // comentario diz "ver waha.js", quem instala o ELO nao tem esse arquivo — e a
    // referencia aponta para o vazio. O lugar certo e docs/INTEGRACAO.md, que vem no repo.
    const proibidos = [/\bwaha\.js\b/, /\bwaha-translate\.js\b/, /\bwaha-reconnect\.js\b/,
      /routes\/channels\.js/];
    const achados: string[] = [];
    for (const { path, texto } of arquivos) {
      for (const [i, linha] of texto.split('\n').entries()) {
        if (proibidos.some((r) => r.test(linha))) {
          achados.push(`${path}:${i + 1}: ${linha.trim().slice(0, 88)}`);
        }
      }
    }
    assert.deepEqual(achados, [], `arquivo de consumidor citado como spec:\n${achados.join('\n')}`);
  });

  it('nao sobrou frase QUEBRADA de substituicao de prosa', () => {
    // ★ Regressao vivida tres vezes nesta semana: substituir prosa em massa colou
    // palavras ("o tradutor do consumidormapeia"), engoliu comentarios (um `//` no meio
    // da linha fez o resto virar codigo comentado) e destruiu NOMES DE ARQUIVO —
    // `waha-translate.js` virou "o tradutor do consumidor", e os 27 testes de contrato
    // ficaram permanentemente skippados com a suite verde.
    const quebras = [
      /consumidor[a-df-z]/,          // colado ("consumidormapeia"); 'e' e plural legitimo
      /consumidor\/\//,              // comentario engolido
      /consumidor:\d/,               // resto de caminho de arquivo
      /do consumidor\s*$/m,          // frase terminando no vazio
    ];
    const achados: string[] = [];
    for (const { path, texto } of arquivos) {
      for (const [i, linha] of texto.split('\n').entries()) {
        if (quebras.some((r) => r.test(linha))) {
          achados.push(`${path}:${i + 1}: ${linha.trim().slice(0, 88)}`);
        }
      }
    }
    assert.deepEqual(achados, [], `frase quebrada por substituicao:\n${achados.join('\n')}`);
  });
});

describe('independencia: o dialeto WAHA CONTINUA permitido', () => {
  it('falar do formato do WAHA nao e acoplamento — e a razao de existir', () => {
    // Guarda contra excesso de zelo: um teste que proibisse "waha" em qualquer forma
    // faria o proximo mantenedor apagar justamente a documentacao do CONTRATO. O ELO
    // fala o dialeto do WAHA para ser drop-in; isso e feature, nao divida.
    const compat = readFileSync(new URL('../src/core/waha-compat.ts', import.meta.url), 'utf8');
    assert.match(compat, /WAHA/, 'a compatibilidade com o dialeto WAHA deve estar documentada');
    assert.match(compat, /WahaSessionStatus/, 'os tipos do dialeto continuam nomeados assim');
  });

  it('a variavel de ambiente do teste de contrato e neutra', () => {
    // ELO_CONSUMER_BACKEND, nao SYSLED_BACKEND_PATH: o nome da variavel tambem e
    // interface publica — aparece no README de quem for rodar os testes.
    const contrato = readFileSync(new URL('./contract.test.ts', import.meta.url), 'utf8');
    assert.match(contrato, /ELO_CONSUMER_BACKEND/, 'a variavel neutra deve ser a principal');
    const iNeutra = contrato.indexOf('ELO_CONSUMER_BACKEND');
    const iAntiga = contrato.indexOf('SYSLED_BACKEND_PATH');
    if (iAntiga > -1) {
      assert.ok(iNeutra < iAntiga, 'a variavel neutra tem de vir ANTES do fallback antigo');
    }
  });
});

describe('independencia: instalavel em qualquer servidor', () => {
  it('nao ha host, IP ou dominio de infra fixado no produto', () => {
    // Um IP de VPS ou dominio do fabricante no codigo do produto vaza a infra de quem
    // desenvolve e nao serve para quem instala. Infra fica nos scripts de deploy, que
    // NAO vao para o repositorio publico.
    const achados: string[] = [];
    const proibidos = [
      /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,   // IP literal
      /zap-beta|beta\.sysled|sysled\.io/i,
      /\bbeta-db\b/,
    ];
    for (const { path, texto } of arquivos) {
      for (const [i, linha] of texto.split('\n').entries()) {
        // Exceções legítimas: faixas de rede citadas nas guardas de SSRF, e o endereço
        // de metadata de nuvem, que o net-guard PRECISA nomear para bloquear.
        if (/net-guard|169\.254\.169\.254|10\.0\.0\.0|172\.16|192\.168|127\.0\.0\.1|0\.0\.0\.0|100\.64/.test(linha)) continue;
        if (proibidos.some((r) => r.test(linha))) {
          achados.push(`${path}:${i + 1}: ${linha.trim().slice(0, 88)}`);
        }
      }
    }
    assert.deepEqual(achados, [], `infra fixada no produto:\n${achados.join('\n')}`);
  });

  it('o schema do banco vive em schema DEDICADO (nao no do consumidor)', () => {
    // O ELO e servico externo: cravar as tabelas no schema da aplicacao que o consome
    // acoplaria as duas migrations e, com PgBouncer em transaction-mode, ainda abriria
    // vazamento de search_path.
    const schema = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
    assert.match(schema, /CREATE SCHEMA IF NOT EXISTS elo/, 'o schema proprio e obrigatorio');
    // Nenhuma tabela pode ser criada fora dele.
    const foraDoElo = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\S+)/g)]
      .map((m) => m[1]!)
      .filter((t) => !t.startsWith('elo.'));
    assert.deepEqual(foraDoElo, [], 'toda tabela do ELO vive no schema elo');
  });
});
