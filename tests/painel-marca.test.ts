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

  it('★ toda animacao declarada aponta para um keyframe que existe', () => {
    // O outro jeito de uma animação nascer morta: `animation:girar` sem
    // `@keyframes girar`. Também silencioso — nenhum erro, nada se move.
    // Medido no Chrome: as 10 animações do painel rodam. Este teste guarda isso.
    const limpo = css.replace(/\/\*[\s\S]*?\*\//g, '');   // comentários confundem o match
    const definidos = new Set([...limpo.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]!));
    const usados = [...limpo.matchAll(/animation(?:-name)?:\s*([\w-]+)/g)]
      .map((m) => m[1]!).filter((n) => n !== 'none');
    const fantasmas = [...new Set(usados)].filter((u) => !definidos.has(u));
    assert.deepEqual(fantasmas, [], 'animation aponta para @keyframes inexistente');
  });

  it('nenhum @keyframes definido fica sem uso', () => {
    // Keyframe órfão é código morto — ou alguém removeu a regra e esqueceu o
    // keyframe, ou a regra foi renomeada e a animação parou de existir.
    const limpo = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const definidos = [...limpo.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]!);
    const usados = new Set([...limpo.matchAll(/animation(?:-name)?:\s*([\w-]+)/g)]
      .map((m) => m[1]!));
    assert.deepEqual(definidos.filter((k) => !usados.has(k)), [], 'keyframes sem uso');
  });
});

describe('painel: pulso da marca', () => {
  it('as duas marcas tem os elos identificados', () => {
    // ★ Aceita classes ADICIONAIS no mesmo atributo (`class="mk-lg mk-entra"`). O
    // regex antigo exigia o atributo exato e passou a nao casar quando a marca do
    // login ganhou a classe da animacao de entrada — o teste falhava dizendo
    // "cabecalho + tela de entrada", como se um SVG tivesse desaparecido.
    const svgs = html.match(/<svg class="mk(-lg)?[^"]*"[\s\S]*?<\/svg>/g) ?? [];
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

// ── Entrada da marca e glow do quadro (tela de login) ──────────────────────
//
// Estes testes travam o que foi VERIFICADO no Chrome real (headless, sob o CSP de
// producao) em 04/08: 4 animacoes rodando, `cx` interpolando de 10,19px a 14,75px, e
// `--mx/--my` mudando de -29,83%/19,76% para 89,49%/89,16% conforme o mouse.
//
// O que estes testes cobrem e o que os pre-requisitos disso continuem no arquivo —
// eles NAO substituem a medicao no navegador (nenhum teste de string executa CSS).
// Duas armadilhas desta tela ja custaram caro: o `--ease` que faltava (3 animacoes
// mortas em silencio) e o CSP do helmet matando os 37 onclick (painel 200 com botoes
// mortos). String test nao pega nenhuma das duas.

describe('painel: entrada da marca no login', () => {
  it('a marca do LOGIN tem a classe da entrada; a do cabecalho NAO', () => {
    // O cabecalho nao deve reanimar a cada render da lista de sessoes — seria um
    // piscar constante no canto da tela.
    const login = html.match(/<svg class="mk-lg[^"]*"/)?.[0] ?? '';
    assert.match(login, /mk-entra/, 'a marca do login precisa da classe de entrada');
    const cab = html.match(/<svg class="mk"[^>]*>/)?.[0] ?? '';
    assert.ok(!cab.includes('mk-entra'), 'a marca do cabecalho NAO deve reanimar');
  });

  it('★ a entrada anima `cx` (geometria), NUNCA transform', () => {
    // O serrilhado documentado neste arquivo volta se alguem trocar cx por
    // transform: escalar joga cx/r/stroke em subpixel e a logo serrilha quadro a
    // quadro. Animar o atributo redesenha o circulo em coordenada nova, sem raster.
    const ks = css.match(/@keyframes mk-entra-\d\{[^}]*\}[^}]*\}/g) ?? [];
    assert.equal(ks.length, 2, 'faltam os keyframes da entrada');
    for (const k of ks) {
      assert.match(k, /cx:/, 'a entrada tem de animar cx');
      assert.ok(!/transform/.test(k), 'transform serrilha a marca — ver comentario acima');
    }
  });

  it('os dois elos ENTRAM de lados opostos (o handshake da marca)', () => {
    // e1 vem da esquerda (cx menor que o final 15), e2 da direita (maior que 29).
    const e1 = css.match(/@keyframes mk-entra-1\{from\{cx:(\d+)\}to\{cx:(\d+)\}\}/);
    const e2 = css.match(/@keyframes mk-entra-2\{from\{cx:(\d+)\}to\{cx:(\d+)\}\}/);
    assert.ok(e1 && e2, 'keyframes da entrada com forma inesperada');
    assert.ok(Number(e1![1]) < Number(e1![2]), 'o elo 1 deve entrar pela esquerda');
    assert.ok(Number(e2![1]) > Number(e2![2]), 'o elo 2 deve entrar pela direita');
  });

  it('a entrada nao engole o pulso de repouso (as duas convivem)', () => {
    // Medido no Chrome: 4 animacoes ativas (2 de entrada + 2 de pulso). Se alguem
    // substituir em vez de somar, a marca entra e fica parada — perde o sinal de vida.
    assert.match(css, /\.mk-entra \.e1\{animation:mk-entra-1[^}]*mk-pulso /,
      'o elo 1 precisa manter o pulso apos a entrada');
    assert.match(css, /\.mk-entra \.e2\{animation:mk-entra-2[^}]*mk-pulso-2 /,
      'o elo 2 precisa manter o pulso apos a entrada');
  });

  it('★ prefers-reduced-motion desliga a entrada', () => {
    // Verificado no Chrome com a media emulada: `getAnimations()` devolveu [].
    const bloco = css.match(/@media \(prefers-reduced-motion:reduce\)\{[^}]*\.mk-entra[^}]*\}/);
    assert.ok(bloco, 'falta a guarda de movimento reduzido para a entrada');
    assert.match(bloco![0], /animation:none/);
  });
});

describe('painel: glow do quadro seguindo o mouse', () => {
  it('o glow pinta a BORDA, nao o cartao inteiro (mascara recorta o miolo)', () => {
    // Sem a mascara, o gradiente acende o fundo do cartao e lava o texto — o efeito
    // pedido e contorno. `padding` + mask-composite:exclude e o que deixa so a moldura.
    // ★ Comentarios FORA antes de casar. A regra do glow tem um comentario que cita
    // `mask-composite:exclude` para explicar a ordem dos prefixos — e uma mutacao que
    // apagou a DECLARACAO passou verde, porque o regex casou com o texto do comentario.
    // Verificar declaracao lendo comentario e o mesmo que nao verificar.
    const cssLimpo = css.replace(/\/\*[\s\S]*?\*\//g, '');
    // ★ `.lg-glow::before`, nao `.lg-c::before`. As camadas SAIRAM do cartao para um
    // wrapper, e o motivo esta medido com screenshot: o `.lg-c` tem background OPACO
    // (pintado acima de um ::before posicionado, escondendo a moldura) e uma
    // `animation` com transform (cria stacking context, prendendo o transbordo de
    // inset negativo dentro do cartao). Os numeros nao denunciavam nada — a moldura
    // reportava opacity:1 e simplesmente nao aparecia na tela.
    const regra = cssLimpo.match(/\.lg-glow::before\{[\s\S]*?z-index:2\}/)?.[0] ?? '';
    assert.ok(regra, 'regra da moldura nao encontrada');
    assert.match(regra, /padding:3px/, 'sem padding nao ha anel recortado');
    // ★ O padrao SEM prefixo tem de existir por si. Uma mutacao que apagou
    // `mask-composite:exclude` deixando so o `-webkit-mask-composite:xor` passou por um
    // regex que casava os dois — e sem a versao padrao o Chrome atual nao recorta o
    // miolo, ou seja, o gradiente acende o cartao inteiro e lava o texto.
    assert.match(regra, /(?<!-webkit-)mask-composite:\s*exclude/,
      'falta mask-composite:exclude SEM prefixo — sem ele o miolo nao e recortado');
    assert.match(regra, /-webkit-mask-composite:\s*xor/, 'Safari precisa do prefixo');
  });

  it('a posicao vem de --mx/--my com default (a tela abre viva)', () => {
    // Sem default, o contorno so acenderia apos o primeiro movimento do mouse — quem
    // abre a tela e nao mexe o mouse veria um cartao morto.
    // As DUAS camadas precisam do default (uma sem ele nasceria no canto 0,0).
    // O default é 50%/50% (centro). Era 50%/0% (topo) e, com o fundo do HUD, isso
    // aparecia como uma MANCHA forte acima do cartão antes de o mouse mover —
    // visível só em screenshot. Centrado, o repouso lê como quadro levemente aceso.
    const usos = [...css.matchAll(/at var\(--mx,\s*50%\)\s+var\(--my,\s*50%\)/g)];
    assert.equal(usos.length, 2, 'as duas camadas de luz precisam do default de --mx/--my');
    // ★ `--gi` tambem precisa de fallback em TODO uso: dentro de um calc(), um var()
    // sem valor invalida a declaracao inteira em silencio — e a camada desaparece sem
    // erro no console. E a mesma armadilha do --ease documentada no topo deste arquivo.
    assert.ok([...css.matchAll(/var\(--gi,\s*\.?\d/g)].length >= 4,
      '--gi precisa de fallback em todo uso — calc() com var() vazio e descartado');
  });

  it('★ a intensidade sai da distancia ate a BORDA do campo, nao ao centro', () => {
    // Medido: o input tem 284px de largura, e com a distancia ao CENTRO o mouse
    // encostado na lateral do cartao — visualmente ao lado do campo — recebia
    // --gi=0,115, praticamente o mesmo que o canto oposto da tela. Com a distancia a
    // borda, o mesmo ponto da 0,700.
    const fn = html.match(/function ligarGlow\(\)\{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(fn, /Math\.max\(cr\.left-alvo\.x,0,alvo\.x-cr\.right\)/,
      'a distancia horizontal tem de ser ate a borda do campo');
    assert.match(fn, /Math\.max\(cr\.top-alvo\.y,0,alvo\.y-cr\.bottom\)/,
      'a distancia vertical tem de ser ate a borda do campo');
    assert.ok(!/cr\.left\+cr\.width\/2/.test(fn),
      'nao voltar para a distancia ao CENTRO — o campo e largo demais');
  });

  it('campo focado mantem a intensidade no maximo', () => {
    // Quem digita a chave nao tem a mao no mouse: --gi congelaria num valor baixo e o
    // quadro apagaria justamente durante o uso.
    const fn = html.match(/function ligarGlow\(\)\{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(fn, /addEventListener\('focus'/, 'falta reagir ao foco do campo');
    assert.match(fn, /setProperty\('--gi','1'\)/, 'o foco deve levar a intensidade a 1');
    assert.match(fn, /addEventListener\('blur'/, 'ao sair do campo o mouse retoma');
  });

  it('as duas camadas de luz vivem no WRAPPER, nao no cartao', () => {
    // Regressao com causa medida: no `.lg-c` o background opaco esconde a moldura e o
    // transform da animacao de entrada prende o transbordo (stacking context).
    assert.ok(!/\.lg-c::(before|after)\{/.test(css),
      'as camadas nao podem voltar para o .lg-c — ver o comentario de .lg-glow no CSS');
    assert.match(html, /<div class="lg-glow"><div class="lg-c">/,
      'o cartao precisa estar dentro do wrapper de brilho');
  });

  it('★ a transicao e na OPACIDADE, nao na posicao', () => {
    // Interpolar --mx faria o halo arrastar atras do cursor com atraso — le como
    // travado. So o acender/apagar e suave.
    // Vale para as DUAS camadas de luz, nao so para a moldura.
    const limpo = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const sel of ['::before', '::after'] as const) {
      const regra = limpo.match(new RegExp('\\.lg-glow' + sel + '\\{[\\s\\S]*?z-index:\\d\\}'))?.[0] ?? '';
      assert.ok(regra, `regra .lg-glow${sel} nao encontrada`);
      assert.match(regra, /transition:opacity/, `${sel}: a transicao deve ser de opacidade`);
      assert.ok(!/transition:[^;]*--m/.test(regra), `${sel}: nao interpolar a posicao`);
    }
  });

  it('o listener e no DOCUMENTO (a borda acende na aproximacao)', () => {
    // Preso ao cartao, o halo so reagiria com o mouse JA sobre ele — e a borda mais
    // proxima do cursor, que e o ponto do efeito, nunca acenderia.
    assert.match(html, /document\.addEventListener\('mousemove'/,
      'o mousemove precisa ser no documento');
  });

  it('★ escreve no maximo uma vez por quadro (requestAnimationFrame)', () => {
    // mousemove dispara muito mais que 60x/s e cada escrita em custom property usada
    // por gradiente forca repaint. Sem coalescing o efeito custa mais que a tela toda.
    assert.match(html, /requestAnimationFrame\(pintar\)/, 'falta o coalescing por quadro');
  });

  it('★ remove o listener quando o cartao sai do DOM', () => {
    // Cada logout() re-renderiza o login. Sem remover, o listener anterior segue vivo
    // mexendo num no orfao — vazamento que so aparece depois de varios login/logout.
    assert.match(html, /removeEventListener\('mousemove',\s*mover\)/,
      'o listener tem de ser removido — senao vaza a cada logout');
  });

  it('prefers-reduced-motion nao recebe brilho perseguindo o cursor', () => {
    // Verificado no Chrome com a media emulada: --mx/--my nunca foram escritos.
    // O guard tem de estar DENTRO de ligarGlow e antes de registrar o listener —
    // checar so a presenca da string casaria com o @media do CSS, que e outra coisa.
    const fn = html.match(/function ligarGlow\(\)\{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(fn, 'ligarGlow nao encontrada');
    const iGuard = fn.indexOf('prefers-reduced-motion');
    const iListener = fn.indexOf("addEventListener('mousemove'");
    assert.ok(iGuard > -1, 'ligarGlow precisa checar prefers-reduced-motion');
    assert.ok(iGuard < iListener, 'o guard tem de vir ANTES de registrar o mousemove');
  });
});

describe('painel: o subtitulo do login foi removido', () => {
  it('nao ha "gateway whatsapp" na tela de entrada', () => {
    // Verifica o que RENDERIZA, com os comentarios fora: o termo segue legitimo em
    // comentario (o cabecalho do arquivo descreve o que o painel e) e censurar isso
    // proibiria documentar o proprio produto. O que nao pode e voltar como TEXTO.
    const semComentarios = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/>\s*gateway whatsapp\s*</i.test(semComentarios),
      'o subtitulo voltou ao markup — repetia o que a marca e o nome ja dizem');
    assert.ok(!/class="lg-s"/.test(semComentarios), 'o elemento do subtitulo voltou');
  });

  it('a regra .lg-s nao ficou orfa no CSS', () => {
    // Regra orfa sobrevive por anos e faz a proxima pessoa procurar um elemento que
    // nao existe. (O teste de keyframes orfaos acima existe pelo mesmo motivo.)
    assert.ok(!/^\.lg-s\{/m.test(css), 'a regra do subtitulo removido continua no CSS');
  });
});
