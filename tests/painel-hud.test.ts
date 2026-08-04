// tests/painel-hud.test.ts
//
// Tela de entrada: HUD tecnico.
//
// ── Por que estes testes existem ───────────────────────────────────────────
// Travam o que foi VERIFICADO no Chrome real (headless, sob o CSP de producao) em
// 04/08: grade com mascara, varredura, quatro cantos com geometria exata, campo de
// terminal, botao em contorno e telemetria publica.
//
// ★ Tres itens aqui existem porque o SCREENSHOT reprovou o que os numeros aprovaram:
//   1. os cantos de visor saiam 2px fora da borda e formavam degrau (inset somado);
//   2. o glow em repouso virava uma MANCHA no topo (--my default 0%);
//   3. a varredura continua CORTAVA o cartao e disputava atencao com o formulario.
// Nenhuma das tres aparece em getComputedStyle — opacidade e valor de custom
// property nao provam que algo esta certo na tela.
//
// Estes testes NAO substituem a medicao no navegador: nenhum teste de string executa
// CSS. Eles garantem que as condicoes que permitem o efeito continuem no arquivo.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const html = readFileSync(new URL('../src/ui/dashboard.html', import.meta.url), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
/** CSS sem comentarios: verificar declaracao lendo comentario e o mesmo que nao
 *  verificar — foi uma mutacao sobrevivente que ensinou isso. */
const cssLimpo = css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('HUD: grade de coordenadas', () => {
  it('a grade tem mascara (senao a tela vira papel quadriculado)', () => {
    const regra = cssLimpo.match(/\.lg::before\{[\s\S]*?animation:hud-deriva[^}]*\}/)?.[0] ?? '';
    assert.ok(regra, 'regra da grade nao encontrada');
    assert.match(regra, /background-size:46px 46px/, 'a grade precisa de passo fixo');
    assert.match(regra, /(?<!-webkit-)mask:radial-gradient/,
      'falta a mascara SEM prefixo — sem ela a grade cobre a tela toda e o cartao perde o foco');
    assert.match(regra, /-webkit-mask:radial-gradient/, 'Safari precisa do prefixo');
  });

  it('★ a grade deriva em transform, nao em background-position', () => {
    // Animar background-position repinta a camada inteira a cada quadro; transform
    // fica na GPU. Mesmo raciocinio do pulso da marca.
    const kf = cssLimpo.match(/@keyframes hud-deriva\{[^}]*\}[^}]*\}/)?.[0] ?? '';
    assert.ok(kf, '@keyframes hud-deriva ausente');
    assert.match(kf, /translate3d/, 'a deriva tem de ser em translate3d');
    assert.ok(!/background-position/.test(kf), 'nao animar background-position');
  });
});

describe('HUD: linha de varredura', () => {
  it('★ e VAZIA no meio, para nao cortar o cartao', () => {
    // Medido em screenshot: com o traco continuo, a varredura cortava o cartao ao
    // passar por ele e competia com o formulario — parecia artefato, nao instrumento.
    // Com as pontas acesas e o meio transparente, ela passa POR TRAS do cartao.
    const regra = cssLimpo.match(/\.lg::after\{[\s\S]*?animation:hud-varre[^}]*\}/)?.[0] ?? '';
    assert.ok(regra, 'regra da varredura nao encontrada');
    assert.match(regra, /transparent 38%,transparent 62%/,
      'o meio da varredura tem de ser transparente');
  });

  it('atravessa a tela inteira e some nas pontas do ciclo', () => {
    // Sem opacidade 0 nas extremidades, a linha aparece e desaparece de estalo.
    const kf = cssLimpo.match(/@keyframes hud-varre\{[\s\S]*?\}\}/)?.[0] ?? '';
    assert.ok(kf, '@keyframes hud-varre ausente');
    assert.match(kf, /opacity:0/, 'a varredura tem de nascer e morrer invisivel');
  });
});

describe('HUD: cantos de visor', () => {
  it('os quatro cantos existem, cada um com L de dois lados', () => {
    // Um pseudo-par da dois cantos; sao dois elementos para os quatro.
    for (const sel of ['\\.lg-mira', '\\.lg-mira2']) {
      for (const pe of ['::before', '::after']) {
        assert.match(cssLimpo, new RegExp(sel + pe + '\\{[^}]*border-'),
          `${sel}${pe}: canto sem borda parcial`);
      }
    }
    assert.match(html, /class="lg-mira"/, 'falta o elemento dos cantos 1 e 3');
    assert.match(html, /class="lg-mira2"/, 'falta o elemento dos cantos 2 e 4');
  });

  it('★ usam inset:0 — inset negativo somava e virava degrau', () => {
    // Medido em screenshot: `inset:-1px` no elemento MAIS `-1px` no canto somavam 2px,
    // e o L corria por fora, paralelo a borda de 1px do cartao — lia como erro de
    // render. Com inset:0 o L cobre a borda (pixel conferido: o verde cai em x+0/y+0).
    assert.match(cssLimpo, /\.lg-mira,\.lg-mira2\{position:absolute;inset:0/,
      'os cantos nao podem ter inset negativo no elemento');
  });

  it('sao decorativos (aria-hidden)', () => {
    // Leitor de tela nao deve anunciar quatro elementos vazios.
    assert.match(html, /class="lg-mira" aria-hidden="true"/);
    assert.match(html, /class="lg-mira2" aria-hidden="true"/);
  });
});

describe('HUD: campo como linha de terminal', () => {
  it('★ e uma LINHA, nao uma caixa', () => {
    const regra = cssLimpo.match(/\.lg-c \.fd input\{[\s\S]*?transition:[^}]*\}/)?.[0] ?? '';
    assert.ok(regra, 'regra do campo nao encontrada');
    assert.match(regra, /border:0/, 'a caixa completa le como formulario web');
    assert.match(regra, /border-bottom:1px solid/, 'a linha de baixo E o campo');
    assert.match(regra, /background:transparent/, 'fundo proprio recria a caixa');
    // O cursor verde e o detalhe mais barato do efeito: o navegador o anima de graca.
    assert.match(regra, /caret-color:var\(--sig\)/, 'o cursor tem de ser da cor de sinal');
  });

  it('o rotulo tem prompt, e ele vem do CSS (nao do markup)', () => {
    // Decoracao no markup faria o leitor de tela anunciar "triangulo chave de acesso".
    assert.match(cssLimpo, /\.lg-c \.fd label::before\{content:'▸ '/,
      'o prompt do rotulo tem de vir do CSS');
    assert.ok(!/>▸/.test(html), 'o caractere de prompt nao pode estar no markup');
  });

  it('focado, a linha acende com brilho para BAIXO', () => {
    // Verificado no Chrome com foco emulado: borderBottomColor rgb(74,222,128).
    // O brilho sai para baixo de proposito — emoldurar o campo recriaria a caixa.
    const regra = cssLimpo.match(/\.lg-c \.fd input:focus\{[\s\S]*?\}/)?.[0] ?? '';
    assert.ok(regra, 'regra de foco do campo nao encontrada');
    assert.match(regra, /border-bottom-color:var\(--sig\)/);
    assert.match(regra, /box-shadow:0 1px 0 0 var\(--sig\)/);
  });

  it('★ headless reporta :focus como falso sem emulacao — registrado', () => {
    // Nao e assercao de codigo, e memoria de armadilha: `matches(':focus')` deu FALSE
    // no headless mesmo com activeElement correto, porque a janela nao tem foco do
    // sistema. Foi preciso `Emulation.setFocusEmulationEnabled`. Sem saber disso, a
    // conclusao seria "o CSS de foco esta quebrado" — e nao estava.
    assert.ok(cssLimpo.includes(':focus'), 'a tela precisa ter estado de foco');
  });
});

describe('HUD: botao', () => {
  it('e contorno, nao bloco preenchido', () => {
    // Solido, era a maior area de cor da tela e brigava com o glow.
    const regra = cssLimpo.match(/\.lg-b button\{[\s\S]*?transform \.1s\}/)?.[0] ?? '';
    assert.ok(regra, 'regra do botao nao encontrada');
    assert.match(regra, /background:transparent/);
    assert.match(regra, /color:var\(--sig\)/);
  });

  it('o preenchimento aparece no hover (estado ativo inequivoco)', () => {
    assert.match(cssLimpo, /\.lg-b button:hover:not\(:disabled\)\{[\s\S]*?background:var\(--sig\)/);
  });

  it('tem colchetes de terminal, e eles SAEM enquanto carrega', () => {
    assert.match(cssLimpo, /\.lg-b button::before\{content:'\[ '/, 'falta o colchete de abertura');
    assert.match(cssLimpo, /\.lg-b button::after\{content:' \]'/, 'falta o colchete de fechamento');
    // Colchetes em volta de um spinner leem como erro de render.
    assert.match(cssLimpo, /button:disabled::before,\.lg-b button:disabled::after\{content:''\}/,
      'os colchetes tem de sair enquanto o botao carrega');
  });
});

describe('HUD: telemetria', () => {
  it('★ NAO expoe nada de sessao/canal/telefone (a tela e publica)', () => {
    // A tela de login dispensa chave (PUBLIC_PATHS em core/access.ts). Contagem de
    // canais ou nome de sessao aqui vazaria informacao de operacao para quem NAO tem
    // a credencial — por isso a telemetria mostra so o que /health devolve sem chave.
    const bloco = html.match(/<dl class="lg-tel">[\s\S]*?<\/dl>/)?.[0] ?? '';
    assert.ok(bloco, 'a telemetria nao esta no markup');
    assert.ok(!/sess|canal|canais|channel|me_id|telefone|phone/i.test(bloco),
      `a telemetria nao pode citar sessao/canal/telefone: ${bloco}`);
    assert.match(bloco, />engine</);
    assert.match(bloco, />gateway</);
  });

  it('o JS da telemetria le so campos publicos do /health', () => {
    // Se alguem passar a alimentar isto de /api/sessions, a tela publica comeca a
    // vazar. O objeto VER e a fronteira: nada alem de version/commit/engine/status.
    const decl = html.match(/const VER=\{[^}]*\}/)?.[0] ?? '';
    assert.ok(decl, 'declaracao de VER nao encontrada');
    assert.deepEqual(
      [...decl.matchAll(/(\w+):/g)].map((m) => m[1]),
      ['v', 'c', 'engine', 'status'],
      'VER so pode carregar dado publico do /health',
    );
  });

  it('e <dl> com pares termo/valor e numeros alinhados', () => {
    const bloco = html.match(/<dl class="lg-tel">[\s\S]*?<\/dl>/)?.[0] ?? '';
    assert.equal((bloco.match(/<dt>/g) ?? []).length, 2, 'dois termos');
    assert.equal((bloco.match(/<dd /g) ?? []).length, 2, 'dois valores');
    // Sem tabular-nums os valores dancam quando mudam de largura.
    assert.match(cssLimpo, /\.lg-tel\{[\s\S]*?font-variant-numeric:tabular-nums/);
  });

  it('o ponto de status e decorativo; o texto e o que se anuncia', () => {
    // Leitor de tela deve ler "gateway ok", nao "gateway marcador ok".
    assert.match(html, /<span class="st-on" aria-hidden="true"><\/span>/);
  });

  it('★ e pintada nas DUAS pontas (a ordem nao e garantida)', () => {
    // O /health pode responder antes de a tela existir (apos logout, com o painel ja
    // rodando) ou depois (a tela nasce com os campos vazios). Sem cobrir os dois
    // casos, um deles fica em "—" tendo o dado em memoria.
    assert.match(html, /function pintarTelemetria\(\)/);
    const load = html.match(/async function loadVersion\(\)\{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(load, /pintarTelemetria\(\)/, 'loadVersion tem de pintar');
    const login = html.match(/function login\(err\)\{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(login, /pintarTelemetria\(\)/, 'login tem de pintar');
  });
});

describe('HUD: movimento reduzido', () => {
  it('★ grade, varredura e batimento param', () => {
    const bloco = cssLimpo.match(
      /@media \(prefers-reduced-motion:reduce\)\{\s*\.lg::before[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(bloco, 'falta a guarda de movimento reduzido para o HUD');
    assert.match(bloco, /animation:none/);
    // A varredura precisa SAIR de vista, nao congelar no meio da tela — linha parada
    // atravessando o conteudo le como artefato de render.
    assert.match(bloco, /\.lg::after\{display:none\}/);
  });
});
