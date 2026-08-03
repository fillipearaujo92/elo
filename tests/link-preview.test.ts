// tests/link-preview.test.ts
//
// Previa de link: metadados Open Graph, sem abrir SSRF.
//
// ── Por que este modulo (e estes testes) existem ───────────────────────────
// Toda mensagem com link registrava `ERR_MODULE_NOT_FOUND: link-preview-js` no log —
// medido no beta, nas duas mensagens de teste do Filipe (link da proposta e link de
// pagamento). O Baileys declara essa lib como peerDependency OPCIONAL e tenta importa-la
// ao montar a previa.
//
// A correcao obvia seria `npm install link-preview-js`. NAO E, e isso e o ponto:
// `npm audit` a reporta HIGH SEM CORRECAO DISPONIVEL (GHSA-4gp8-rjrq-ch6q), e o titulo
// do aviso e "vulnerable to IPv6 and internal loopback attacks" — SSRF, a mesma classe
// que o net-guard fechou em tres outros caminhos. Instala-la reabriria o buraco pela
// porta da previa, onde a URL vem do TEXTO da mensagem, escolhido por quem envia.
//
// Daí a implementacao propria, passando pelo mesmo `fetchGuardado`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getUrlInfo, primeiraUrl } from '../dist/core/link-preview.js';

describe('primeiraUrl: qual link vira previa', () => {
  it('acha a primeira URL do texto', () => {
    assert.equal(primeiraUrl('veja https://exemplo.com/a e https://outro.com'),
      'https://exemplo.com/a');
  });

  it('aceita http e https', () => {
    assert.equal(primeiraUrl('http://x.com/a'), 'http://x.com/a');
  });

  it('★ nao engole a pontuacao da frase', () => {
    // "confira https://exemplo.com/pagina." — o ponto e da frase, e buscar
    // "pagina." daria 404 e previa vazia.
    assert.equal(primeiraUrl('confira https://exemplo.com/pagina.'), 'https://exemplo.com/pagina');
    assert.equal(primeiraUrl('(https://exemplo.com/a)'), 'https://exemplo.com/a');
    assert.equal(primeiraUrl('link: https://exemplo.com/a!'), 'https://exemplo.com/a');
  });

  it('texto sem link devolve null', () => {
    assert.equal(primeiraUrl('mensagem sem link nenhum'), null);
    assert.equal(primeiraUrl(''), null);
  });

  it('nao confunde e-mail nem dominio solto com URL', () => {
    assert.equal(primeiraUrl('fale com a@b.com'), null);
    assert.equal(primeiraUrl('acesse exemplo.com'), null);
  });
});

describe('getUrlInfo: previa sem virar SSRF', () => {
  it('★ URL para loopback NAO e buscada (passa pelo net-guard)', async () => {
    // Este e o teste central: a URL vem do texto da mensagem. Sem o guard, escrever
    // "olha isso http://127.0.0.1:3000/health" faria o gateway buscar o proprio
    // servico interno — e a lib que o Baileys queria usar tem exatamente essa falha.
    assert.equal(await getUrlInfo('veja http://127.0.0.1:3000/health'), undefined);
    assert.equal(await getUrlInfo('veja http://169.254.169.254/latest/meta-data/'), undefined);
    assert.equal(await getUrlInfo('veja http://localhost:5432/'), undefined);
  });

  it('URL de rede privada tambem nao (com a flag desligada)', async () => {
    assert.equal(await getUrlInfo('http://192.168.0.1/admin'), undefined);
    assert.equal(await getUrlInfo('http://10.0.0.1/'), undefined);
  });

  it('texto sem link nao faz requisicao nenhuma', async () => {
    assert.equal(await getUrlInfo('bom dia, tudo bem?'), undefined);
  });

  it('★ NUNCA lanca — previa e opcional e nao pode impedir o envio', async () => {
    // Era o comportamento do Baileys tambem: ele engolia o ERR_MODULE_NOT_FOUND e
    // enviava a mensagem. Se a previa passasse a lancar, uma URL fora do ar impediria
    // o envio — regressao muito pior que nao ter previa.
    for (const t of [
      'http://nao-existe-mesmo-99999.invalid/x',
      'https://',
      'texto com http:// quebrado',
      'ftp://arquivo.com/x',
    ]) {
      await assert.doesNotReject(() => getUrlInfo(t), `texto: ${t}`);
    }
  });
});
