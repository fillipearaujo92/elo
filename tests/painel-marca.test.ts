// tests/painel-marca.test.ts
//
// A marca do painel: pulso e sinal de estado.
//
// ── Por que este teste existe ──────────────────────────────────────────────
// O pulso da marca não animava, e nada acusava: `var(--ease)` era usado em três
// regras — a entrada da tela de login, a transição do switch e o pulso — e nunca
// foi definido neste painel (é variável de OUTRO design system). Um var() sem
// valor invalida a declaração INTEIRA em silêncio, sem erro no console.
//
// Descobri medindo no Chrome: `getAnimations()` devolvia lista vazia. Nenhum
// teste de sintaxe pegaria — o CSS é válido, só não faz nada.
//
// A segunda armadilha foi o contraponto: com `animation-delay:-1.3s` (meio ciclo)
// os dois elos escureciam JUNTOS, porque keyframes simétricos deslocados meio
// ciclo devolvem a mesma curva. A inversão tem de estar no keyframe.
//
// Estes testes travam as duas coisas por inspeção do CSS. O comportamento em si
// (opacidade quadro a quadro, contraponto em 8/8 trechos) foi medido no Chrome
// headless — aqui garantimos que as condições que o permitem continuam de pé.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const html = readFileSync(new URL('../src/ui/dashboard.html', import.meta.url), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;

describe('painel: variaveis CSS', () => {
  it('★ nenhuma var() usada sem estar definida', () => {
    // O bug do --ease. Um var() órfão não avisa: a regra toda é descartada.
    const def = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    // Variáveis que o JS define em runtime são legítimas: --m (cor do marcador da
    // linha, via style inline) e --mk2 (cor do elo de alerta, via setProperty).
    for (const m of html.matchAll(/style="[^"]*?(--[a-z0-9-]+):/g)) def.add(m[1]!);
    for (const m of html.matchAll(/setProperty\('(--[a-z0-9-]+)'/g)) def.add(m[1]!);

    const usadas = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
    const orfas = [...usadas].filter((v) => !def.has(v));
    assert.deepEqual(orfas, [], 'var() sem definicao — a regra inteira e descartada');
  });

  it('--ease existe (tres regras dependem dela, incluindo o pulso)', () => {
    assert.match(css, /--ease:\s*cubic-bezier/);
  });
});

describe('painel: pulso da marca', () => {
  it('as duas marcas tem os elos identificados', () => {
    const svgs = html.match(/<svg class="mk(-lg)?"[\s\S]*?<\/svg>/g) ?? [];
    assert.equal(svgs.length, 2, 'cabecalho + tela de entrada');
    for (const s of svgs) {
      assert.ok(s.includes('class="e1"'), 'elo 1 sem classe — o CSS nao casa');
      assert.ok(s.includes('class="e2"'), 'elo 2 sem classe — sem pulso nem sinal');
    }
  });

  it('os keyframes existem e sao referenciados', () => {
    for (const k of ['mk-pulso', 'mk-pulso-2', 'mk-pulso-alerta']) {
      assert.ok(css.includes(`@keyframes ${k}{`), `@keyframes ${k} ausente`);
      // Aceita shorthand (`animation:mk-pulso 2.6s`) e longhand.
      assert.match(css, new RegExp(`animation(-name)?:\\s*${k}(?![\\w-])`),
        `${k} definido mas nunca usado`);
    }
  });

  it('★ o contraponto esta no KEYFRAME, nao num animation-delay', () => {
    // Com delay de meio ciclo os elos pulsavam juntos (medido). O elo 2 tem de
    // partir do valor BAIXO e subir, enquanto o elo 1 parte do alto e desce.
    const k1 = css.match(/@keyframes mk-pulso\{([\s\S]*?)\}\}/)![1]!;
    const k2 = css.match(/@keyframes mk-pulso-2\{([\s\S]*?)\}\}/)![1]!;
    const op = (k: string) => [...k.matchAll(/opacity:([\d.]+)/g)].map((m) => parseFloat(m[1]!));
    const [ini1, meio1] = op(k1);
    const [ini2, meio2] = op(k2);
    assert.ok(meio1! < ini1!, 'elo 1 deve RECOLHER no meio do ciclo');
    assert.ok(meio2! > ini2!, 'elo 2 deve ACENDER no meio do ciclo');
    assert.ok(!/\.e2\{[^}]*animation-delay/.test(css),
      'delay de meio ciclo nao inverte keyframe simetrico — nao reintroduzir');
  });

  it('nenhum keyframe da marca usa transform (era a causa do serrilhado)', () => {
    // A logo é desenhada 1:1 com o tamanho do atributo. Escalar joga cx/r/stroke
    // em subpixel e o navegador anti-aliasa a borda — animado seria pior ainda.
    const kfs = (css.match(/@keyframes mk-[\s\S]*?\}\}/g) ?? []).join('');
    assert.ok(!/transform/.test(kfs), 'transform na marca = serrilhado animado');
    assert.match(kfs, /opacity/, 'o pulso anima opacidade');
  });

  it('toda opacidade dos keyframes esta em 0..1', () => {
    const kfs = (css.match(/@keyframes mk-[\s\S]*?\}\}/g) ?? []).join('');
    const ops = [...kfs.matchAll(/opacity:([\d.]+)/g)].map((m) => parseFloat(m[1]!));
    assert.ok(ops.length > 0);
    for (const o of ops) assert.ok(o >= 0 && o <= 1, `opacity ${o} fora do dominio`);
  });

  it('prefers-reduced-motion desliga o pulso', () => {
    assert.match(css, /prefers-reduced-motion:reduce\)\{\*\{animation:none!important\}/);
  });
});

describe('painel: o elo 2 sinaliza o estado dos canais', () => {
  const js = html.match(/<script>([\s\S]*)<\/script>/)![1]!;

  it('a cor sai do mapa ST, sem duplicar valor', () => {
    // Duplicar a cor criaria dois lugares para trocar quando o tema mudar, e um
    // ficaria para trás.
    assert.match(js, /return ST\.FAILED\.c/);
    assert.match(js, /return ST\.SCAN_QR_CODE\.c/);
  });

  it('★ falha tem prioridade sobre aguardando QR', () => {
    // Um canal com falha não volta sozinho; QR expira e regenera. Quem tem os
    // dois precisa ver o vermelho. A ordem dos ifs É a regra.
    const fn = js.match(/function marcaAlerta\(\)\{[\s\S]*?\n\}/)![0];
    const iFail = fn.indexOf('FAILED');
    const iQr = fn.indexOf('SCAN_QR_CODE');
    assert.ok(iFail > -1 && iQr > -1);
    assert.ok(iFail < iQr, 'FAILED tem de ser testado ANTES de SCAN_QR_CODE');
  });

  it('estados que nao pedem acao nao acendem o alerta', () => {
    const fn = js.match(/function marcaAlerta\(\)\{[\s\S]*?\n\}/)![0];
    for (const s of ['WORKING', 'STARTING', 'STOPPED']) {
      assert.ok(!fn.includes(s), `${s} nao deve disparar alerta na marca`);
    }
  });

  it('o elo 2 usa --mk2 com fallback, para a marca voltar ao normal', () => {
    assert.match(css, /\.mk[^{]*\.e2\{stroke:var\(--mk2,currentColor\)\}/);
  });

  it('so o elo 2 muda de cor (a marca nao vira alarme)', () => {
    // Pintar os dois elos custaria a identidade: com um verde e outro âmbar a
    // leitura é "algo pede atenção", não "o produto quebrou".
    assert.ok(!/\.e1\{stroke:var\(--mk2/.test(css), 'o elo 1 mantem a cor da marca');
  });

  it('o JS aplica E remove o sinal', () => {
    // Sem o remove, a marca ficaria vermelha para sempre depois da primeira falha.
    assert.ok(js.includes("setProperty('--mk2'") && js.includes("removeProperty('--mk2')"));
    assert.ok(js.includes("classList.add('mk-alerta')") &&
              js.includes("classList.remove('mk-alerta')"));
  });

  it('★ o sinal e reaplicado no shell() e no load()', () => {
    // O shell() reescreve o innerHTML: sem reaplicar, o alerta desaparecia ao
    // trocar de aba (teclas 1/2), mudar o tema ou limpar eventos.
    assert.ok((js.match(/sinalizarMarca\(\)/g) ?? []).length >= 3,
      'declaracao + chamada no load + chamada no shell');
  });

  it('o estado tambem aparece em TEXTO, nao so na cor', () => {
    // Cor sozinha exclui quem não a distingue; os contadores nomeiam o estado.
    assert.ok(js.includes("sg('SCAN_QR_CODE','aguardando qr'"));
    assert.ok(js.includes("sg('FAILED','com falha'"));
  });
});
