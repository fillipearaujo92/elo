// tests/csp.test.ts
//
// A politica de CSP nao pode matar o painel.
//
// ── Por que este teste existe ──────────────────────────────────────────────
// Ao ligar o @fastify/helmet, o painel continuou respondendo 200 em TODAS as rotas — e
// estava com os botoes MORTOS em producao. O helmet aplica `script-src-attr 'none'` por
// default, e isso bloqueia handler de ATRIBUTO: os 37 `onclick` do painel pararam de
// executar.
//
// Nenhum teste de status HTTP pegaria: `/`, `/dashboard`, `/docs` e os assets seguiam
// 200. Foi preciso baixar o painel com o CSP real e clicar num botao dentro do Chrome
// headless para ver. Este teste verifica a INTENCAO da politica sem precisar de
// navegador, para o proximo ajuste de CSP nao repetir o erro em silencio.
//
// Tambem trava `upgrade-insecure-requests`, que o helmet inclui por default e que
// quebra instalacao self-hosted em rede interna sem TLS — omiti-la nao bastava, foi
// preciso anular com `null`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(raiz, 'src', 'server.ts'), 'utf8');
const painel = readFileSync(join(raiz, 'src', 'ui', 'dashboard.html'), 'utf8');

/** Bloco de diretivas do CSP, como escrito no server.ts. */
const diretivas = server.match(/contentSecurityPolicy:\s*\{[\s\S]*?\n {2}\},/)?.[0] ?? '';

describe('CSP: a politica declarada', () => {
  it('★ permite handler de ATRIBUTO enquanto o painel usa onclick', () => {
    // O helmet poe `script-src-attr 'none'` por default. Se o painel ainda tem onclick
    // inline, a diretiva TEM de ser declarada com unsafe-inline — senao os botoes
    // morrem e o HTTP continua 200, que foi exatamente o que aconteceu.
    const onclicks = (painel.match(/onclick=/g) ?? []).length;
    if (onclicks === 0) {
      // Se alguem removeu todos os onclick, o certo passa a ser 'none'. Este teste
      // vira o guardiao do endurecimento: falha se a politica ficar frouxa sem motivo.
      assert.match(diretivas, /scriptSrcAttr:\s*\["'none'"\]/,
        'sem onclick no painel, script-src-attr deve voltar para none');
      return;
    }
    assert.match(diretivas, /scriptSrcAttr/,
      `o painel tem ${onclicks} onclick inline: script-src-attr precisa ser declarado (o default do helmet e 'none' e mata os botoes)`);
    assert.match(diretivas, /scriptSrcAttr:\s*\["'unsafe-inline'"\]/);
  });

  it('★ nao força upgrade-insecure-requests (quebraria HTTP interno)', () => {
    // Medido no cabecalho real: a diretiva estava presente mesmo sem eu declara-la.
    // Omitir nao remove; e preciso anular.
    assert.match(diretivas, /upgradeInsecureRequests:\s*null/,
      'a diretiva tem de ser anulada explicitamente, nao apenas omitida');
  });

  it('bloqueia script de origem EXTERNA (o vetor real de exfiltracao)', () => {
    // Este e o ganho principal do CSP aqui: `<script src=evil.com>` injetado nao
    // executa, mesmo com unsafe-inline permitido para o codigo proprio.
    assert.match(diretivas, /defaultSrc:\s*\["'self'"\]/);
    assert.match(diretivas, /scriptSrc:\s*\["'self'", "'unsafe-inline'"\]/);
    assert.ok(!/scriptSrc:[^\]]*https?:/.test(diretivas), 'nenhuma origem externa em script-src');
  });

  it('impede enquadramento (clickjacking em remover sessao / restaurar backup)', () => {
    assert.match(diretivas, /frameAncestors:\s*\["'none'"\]/);
  });

  it('permite data: em img (o QR chega como PNG base64)', () => {
    // Sem isto o QR nao aparece — e o QR e o unico caminho para conectar um numero.
    assert.match(diretivas, /imgSrc:\s*\["'self'", 'data:'\]/);
  });

  it('permite SSE na propria origem (o diagnostico em tempo real)', () => {
    assert.match(diretivas, /connectSrc:\s*\["'self'"\]/);
  });

  it('HSTS so quando a instalacao e https', () => {
    // Um HSTS emitido por engano faz o navegador recusar HTTP naquele host por meses, e
    // e dificil de desfazer para o operador de uma instalacao em rede interna.
    assert.match(server, /hsts:\s*config\.publicUrl\.startsWith\('https:\/\/'\)/);
  });
});
