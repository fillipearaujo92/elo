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

  it('★ NENHUM arquivo do repositorio expoe infra de quem desenvolve', () => {
    // ★ O teste acima varre so `src/`. Isto varre o REPOSITORIO INTEIRO, e existe por
    // um caso real: o repo carregava scripts de deploy com o IP PUBLICO de uma VPS,
    // hostnames de rede Docker interna, o dominio do ambiente e o caminho de instalacao
    // no servidor. O repositorio do ELO e PUBLICO — isso ficava indexado e permanente, e
    // nao servia para ninguem que instalasse o gateway.
    //
    // ★★ E este comentario NAO repete os valores. A primeira versao dele citava o IP
    // literal para "documentar o incidente" — e a propria varredura pegou, o que estava
    // certo: um dado exposto num comentario esta igualmente exposto. Descrever a CLASSE
    // do dado ensina a mesma licao sem republica-lo.
    //
    // Os scripts foram para fora do repositorio (ver scripts/ para o que e generico).
    // Este teste impede que voltem: um `deploy/algo.sh` novo com IP passaria pelo teste
    // anterior, porque ele nao olha fora de src/.
    //
    // O que e permitido, e por que: enderecos de LOOPBACK e faixas PRIVADAS aparecem
    // legitimamente nas guardas de SSRF (o net-guard precisa nomea-las para bloquear) e
    // em exemplo de configuracao local.
    const ignorar = new Set(['node_modules', '.git', 'dist', 'coverage', '.github']);
    const suspeitos: Array<[string, number, string]> = [];
    const paraVarrer = fileURLToPath(new URL('../', import.meta.url));

    const varre = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (ignorar.has(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) { varre(p); continue; }
        if (!/\.(ts|js|mjs|cjs|sql|html|md|ya?ml|sh|json|example|Dockerfile)$/i.test(e.name)
            && e.name !== 'Dockerfile') continue;
        let texto: string;
        try { texto = readFileSync(p, 'utf8'); } catch { continue; }
        // Este proprio teste cita os padroes que proibe. E os testes da guarda de rede
        // (net-guard, link-preview) existem para CLASSIFICAR faixas de IP: eles precisam
        // nomear 8.8.8.8, 172.15.0.1, 224.0.0.1 e afins. Excluir os arquivos inteiros e
        // mais honesto que tentar adivinhar quais literais sao legitimos linha a linha.
        if (/independencia\.test|net-guard|link-preview/.test(p)) continue;
        for (const [i, linha] of texto.split('\n').entries()) {
          // Loopback, faixas privadas e metadata de nuvem: legitimos (guardas de SSRF,
          // bind local, exemplo de configuracao).
          if (/127\.0\.0\.1|0\.0\.0\.0|localhost|169\.254\.169\.254|10\.0\.0\.0|172\.16|192\.168|100\.64|255\.255/.test(linha)) continue;
          // IP publico literal, ou hostname/dominio de um ambiente especifico.
          const temIpPublico = /\b(?!0)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(linha);
          const temHostInterno = /\bbeta-db\b|sysled-beta|zap-beta|\/opt\/wa-gateway/.test(linha);
          if (temIpPublico || temHostInterno) {
            suspeitos.push([p.replace(paraVarrer, ''), i + 1, linha.trim().slice(0, 84)]);
          }
        }
      }
    };
    varre(paraVarrer);

    assert.deepEqual(
      suspeitos.map(([f, l, t]) => `${f}:${l}: ${t}`), [],
      'infra de quem desenvolve NAO pode viver no repositorio publico do ELO',
    );
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
