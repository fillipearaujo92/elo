// tests/net-guard.test.ts
//
// Guarda de SSRF.
//
// ── Por que estes testes existem ───────────────────────────────────────────
// O buraco era REAL, medido no beta antes da correcao: um PATCH apontando o webhook
// para `http://127.0.0.1:3000/health` e um POST em `/test-webhook` devolveram o corpo
// da resposta interna do proprio container na resposta HTTP. Dois caminhos aceitavam
// URL do cliente sem validar host: `resolveFile` (send.ts) e `test-webhook`.
//
// O que agrava em `sendMedia`: o conteudo baixado vira MENSAGEM DE WHATSAPP para o
// chatId que o atacante escolheu. E exfiltracao com canal de retorno, nao SSRF cego.
//
// Os testes cobrem cada faixa e, principalmente, os BYPASSES: IPv4 mapeado em IPv6,
// IPv6 entre colchetes, e nome publico que resolve para endereco interno.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classificarIp, verificarUrl } from '../dist/core/net-guard.js';

describe('classificarIp: faixas que nao podem ser buscadas', () => {
  it('loopback IPv4 e IPv6', () => {
    assert.equal(classificarIp('127.0.0.1'), 'loopback');
    assert.equal(classificarIp('127.1.2.3'), 'loopback', 'todo 127/8, nao so .0.1');
    assert.equal(classificarIp('::1'), 'loopback');
    assert.equal(classificarIp('::'), 'loopback');
  });

  it('★ link-local: onde vivem as credenciais da instancia', () => {
    // 169.254.169.254 e o endereco de metadata da AWS, GCP, Azure, DigitalOcean e
    // Oracle Cloud. E o alvo numero um de SSRF em servidor de cloud.
    assert.equal(classificarIp('169.254.169.254'), 'link_local');
    assert.equal(classificarIp('169.254.0.1'), 'link_local');
    assert.equal(classificarIp('fe80::1'), 'link_local');
  });

  it('redes privadas (RFC 1918) e o equivalente IPv6', () => {
    assert.equal(classificarIp('10.0.0.1'), 'privado');
    assert.equal(classificarIp('192.168.1.1'), 'privado');
    assert.equal(classificarIp('172.16.0.1'), 'privado');
    assert.equal(classificarIp('172.31.255.255'), 'privado', 'fim da faixa 172.16/12');
    assert.equal(classificarIp('fd00::1'), 'privado', 'unique local IPv6');
  });

  it('★ 172.15 e 172.32 NAO sao privados (a faixa e 172.16-31)', () => {
    // Erro classico: bloquear "172.*" inteiro, ou errar o limite da faixa.
    assert.equal(classificarIp('172.15.0.1'), null);
    assert.equal(classificarIp('172.32.0.1'), null);
  });

  it('CGNAT e reservados', () => {
    assert.equal(classificarIp('100.64.0.1'), 'cgnat');
    assert.equal(classificarIp('0.0.0.0'), 'reservado');
    assert.equal(classificarIp('224.0.0.1'), 'reservado', 'multicast');
  });

  it('★ IPv4 mapeado em IPv6 nao contorna o bloqueio', () => {
    // Sem tratar isso, `::ffff:127.0.0.1` passaria: e o MESMO endereco escrito de
    // outra forma, e a classificacao IPv6 ingenua nao reconheceria.
    assert.equal(classificarIp('::ffff:127.0.0.1'), 'loopback');
    assert.equal(classificarIp('::ffff:169.254.169.254'), 'link_local');
    assert.equal(classificarIp('::ffff:10.0.0.1'), 'privado');
  });

  it('IP publico passa', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1']) {
      assert.equal(classificarIp(ip), null, ip);
    }
  });
});

describe('verificarUrl: o que o gateway aceita buscar', () => {
  it('rejeita protocolo que nao e http/https', async () => {
    for (const u of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'data:text/plain,x']) {
      const v = await verificarUrl(u);
      assert.equal(v.ok, false, u);
      assert.equal(v.motivo, 'protocolo');
    }
  });

  it('rejeita URL malformada', async () => {
    const v = await verificarUrl('nao e url');
    assert.equal(v.ok, false);
  });

  it('★ rejeita a metadata da instancia', async () => {
    const v = await verificarUrl('http://169.254.169.254/latest/meta-data/iam/');
    assert.equal(v.ok, false);
    assert.equal(v.motivo, 'link_local');
  });

  it('★ rejeita loopback, inclusive com porta e em IPv6 com colchetes', async () => {
    // O caso MEDIDO no beta era exatamente este: http://127.0.0.1:3000/health.
    for (const u of ['http://127.0.0.1:3000/health', 'http://[::1]:5432/', 'https://127.0.0.1/']) {
      const v = await verificarUrl(u);
      assert.equal(v.ok, false, u);
      assert.equal(v.motivo, 'loopback', u);
    }
  });

  it('classifica rede privada como privada', async () => {
    // Se sera BLOQUEADA depende de ALLOW_PRIVATE_FETCH — isso e coberto no bloco do
    // escape hatch. Aqui garantimos so a classificacao, que nao depende da flag.
    // (Este teste antes assertava `ok === false` direto e quebrava com a flag ligada:
    // era o teste que estava errado, nao o codigo.)
    assert.equal(classificarIp('10.1.2.3'), 'privado');
    assert.equal(classificarIp('192.168.0.10'), 'privado');
  });

  it('★ nome que resolve para loopback e rejeitado (nao basta olhar a string)', async () => {
    // `localhost` resolve para 127.0.0.1 / ::1. Um validador que so olhasse a URL
    // como texto deixaria passar — por isso a resolucao de DNS acontece ANTES do
    // fetch. Este e o teste que prova que a resolucao esta sendo feita.
    const v = await verificarUrl('http://localhost:3000/health');
    assert.equal(v.ok, false);
    assert.equal(v.motivo, 'loopback');
  });

  it('host que nao resolve e rejeitado, nao aceito por omissao', async () => {
    const v = await verificarUrl('http://nao-existe-mesmo-12345.invalid/x');
    assert.equal(v.ok, false);
    assert.equal(v.motivo, 'dns_falhou');
  });

  it('aceita URL publica', async () => {
    const v = await verificarUrl('https://example.com/webhook');
    assert.equal(v.ok, true, `deveria aceitar, motivo: ${v.motivo} ${v.detalhe ?? ''}`);
  });
});

describe('ALLOW_PRIVATE_FETCH: o escape hatch tem limite', () => {
  // ★ Este bloco existe por causa de uma MUTACAO que passou.
  //
  // Removi a linha que protege loopback/link-local do escape hatch, rodei a suite com
  // ALLOW_PRIVATE_FETCH=1, e tudo continuou VERDE — nenhum teste exercitava o
  // comportamento com a flag ligada. Ou seja: a garantia mais importante da flag
  // ("ela libera rede privada, nunca a metadata da instancia") nao estava coberta.
  //
  // O config e lido no import, entao o valor da flag e o do ambiente do processo de
  // teste. Aqui verificamos a REGRA nos dois estados possiveis, sem depender de qual
  // deles esta ativo — o que mantem o teste valido rodando com ou sem a variavel.
  const ligada = ['1', 'true', 'yes', 'on'].includes(
    (process.env.ALLOW_PRIVATE_FETCH ?? '').trim().toLowerCase(),
  );

  it('★ loopback e link-local sao bloqueados nos DOIS estados da flag', async () => {
    // Nao existe caso de uso em que o gateway precise buscar a propria metadata da
    // instancia (169.254.169.254 = credenciais IAM) nem servico que so escuta em
    // loopback. A flag serve para rede interna do datacenter, nao para isso.
    for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:3000/x']) {
      const v = await verificarUrl(u);
      assert.equal(v.ok, false, `${u} com ALLOW_PRIVATE_FETCH=${ligada}`);
    }
  });

  it('rede privada segue a flag', async () => {
    const v = await verificarUrl('http://192.168.0.10:8080/hook');
    assert.equal(
      v.ok,
      ligada,
      ligada
        ? 'com a flag ligada, rede privada deve ser permitida'
        : 'com a flag desligada, rede privada deve ser bloqueada',
    );
  });
});
