// tests/segredo-em-log.test.ts
//
// Segredo nao vai para o log.
//
// ── Por que estes testes existem ───────────────────────────────────────────
// O logger subia sem `redact` e core/webhook.ts logava a URL CRUA do webhook em
// quatro pontos. Os dois padroes comuns de webhook autenticado — token na query
// (`?token=abc`) e credencial embutida (`https://user:senha@host/hook`) — iam para o
// log em texto puro. Log e o lugar menos protegido de uma instalacao: vai para
// arquivo, para o journald e para qualquer coletor que o operador tenha.
//
// A correcao sanitiza na ORIGEM (`urlSegura`) em vez de confiar no `redact` do pino.
// Motivo medido: censurar `url` generico no pino apagaria tambem `req.url` do log de
// acesso, cegando o diagnostico de "qual rota deu erro?". Protecao que apaga
// evidencia legitima acaba desligada pelo operador.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { urlSegura } from '../dist/core/webhook.js';

describe('urlSegura: o que pode aparecer no log', () => {
  it('★ token na query string NAO aparece', () => {
    const s = urlSegura('https://meu-sistema.com/hook?token=abc123secreto&x=1');
    assert.ok(!s.includes('abc123secreto'), `vazou: ${s}`);
    assert.ok(!s.includes('token='), `vazou o nome do parametro tambem: ${s}`);
    assert.equal(s, 'https://meu-sistema.com/hook?[oculto]');
  });

  it('★ credencial embutida (user:senha@host) NAO aparece', () => {
    const s = urlSegura('https://admin:senha-forte@meu-sistema.com/hook');
    assert.ok(!s.includes('senha-forte'), `vazou a senha: ${s}`);
    assert.ok(!s.includes('admin'), `vazou o usuario: ${s}`);
    assert.equal(s, 'https://[credencial]@meu-sistema.com/hook');
  });

  it('mantem origem e caminho (e o que o operador precisa)', () => {
    // Esconder a URL inteira tornaria o log inutil: "algum webhook falhou" nao ajuda
    // quem tem cinco sessoes configuradas.
    assert.equal(urlSegura('https://sistema.com/webhook/zap'), 'https://sistema.com/webhook/zap');
    assert.equal(urlSegura('http://host:8080/a/b'), 'http://host:8080/a/b');
  });

  it('URL invalida nao passa nada adiante', () => {
    // Se nao consigo parsear, nao consigo garantir que nao ha segredo dentro.
    assert.equal(urlSegura('nao e url'), '[url invalida]');
    assert.equal(urlSegura(''), '[url invalida]');
  });

  it('query vazia nao vira "?[oculto]" a esmo', () => {
    assert.equal(urlSegura('https://sistema.com/hook?'), 'https://sistema.com/hook');
  });
});
