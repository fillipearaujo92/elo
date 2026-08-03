// tests/chave-webhook.test.ts
//
// A chave do webhook nao pode ser a chave MESTRA do gateway.
//
// ── Por que estes testes existem ───────────────────────────────────────────
// O `X-Webhook-Key` caia para `config.apiKey` quando ninguem informava valor. A apiKey
// e a credencial de TUDO: criar e apagar sessao, ler QR, enviar mensagem em nome do
// numero, e baixar o backup com as chaves Signal.
//
// Ou seja: configurar um webhook — operacao rotineira — entregava controle total do
// gateway ao destino. E o destino nem precisa ser malicioso: basta o log dele registrar
// os headers recebidos, o que a maioria dos frameworks faz por default.
//
// A correcao gera chave propria SO em sessao nova, por decisao consciente: trocar a
// chave de uma sessao existente faria o consumidor responder 401 (ele compara com o que
// tem configurado) e derrubaria a entrega ate os dois lados serem atualizados juntos.
// Para as antigas, o painel avisa — e e `usaChaveMestraNoWebhook` que decide o aviso.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { usaChaveMestraNoWebhook } from '../dist/core/session-manager.js';

const CHAVE_MESTRA = 'a'.repeat(64);

describe('usaChaveMestraNoWebhook: quando avisar o operador', () => {
  it('★ webhook SEM X-Webhook-Key usa a mestra (cai no fallback)', () => {
    // Este e o caso silencioso: nada no config indica a apiKey, mas o emissor cai nela.
    const cfg = { webhooks: [{ url: 'https://sistema.com/hook' }] };
    assert.equal(usaChaveMestraNoWebhook(cfg, CHAVE_MESTRA), true);
  });

  it('★ header presente mas IGUAL a mestra tambem avisa', () => {
    const cfg = {
      webhooks: [{
        url: 'https://sistema.com/hook',
        customHeaders: [{ name: 'X-Webhook-Key', value: CHAVE_MESTRA }],
      }],
    };
    assert.equal(usaChaveMestraNoWebhook(cfg, CHAVE_MESTRA), true);
  });

  it('chave propria NAO avisa', () => {
    const cfg = {
      webhooks: [{
        url: 'https://sistema.com/hook',
        customHeaders: [{ name: 'X-Webhook-Key', value: 'b'.repeat(64) }],
      }],
    };
    assert.equal(usaChaveMestraNoWebhook(cfg, CHAVE_MESTRA), false);
  });

  it('o nome do header e case-insensitive (HTTP nao diferencia)', () => {
    const cfg = {
      webhooks: [{
        url: 'https://sistema.com/hook',
        customHeaders: [{ name: 'x-webhook-key', value: 'b'.repeat(64) }],
      }],
    };
    assert.equal(usaChaveMestraNoWebhook(cfg, CHAVE_MESTRA), false, 'minusculo tem de contar');
  });

  it('sem webhook configurado nao ha o que avisar', () => {
    // Aviso em sessao que nao repassa nada seria ruido — e ruido treina o operador a
    // ignorar avisos.
    assert.equal(usaChaveMestraNoWebhook({}, CHAVE_MESTRA), false);
    assert.equal(usaChaveMestraNoWebhook({ webhooks: [] }, CHAVE_MESTRA), false);
    assert.equal(usaChaveMestraNoWebhook(undefined, CHAVE_MESTRA), false);
  });

  it('webhook sem url nao conta (nao repassa nada)', () => {
    const cfg = { webhooks: [{ url: '' }] };
    assert.equal(usaChaveMestraNoWebhook(cfg as never, CHAVE_MESTRA), false);
  });

  it('avisa se QUALQUER webhook da sessao usa a mestra', () => {
    const cfg = {
      webhooks: [
        { url: 'https://a.com/h', customHeaders: [{ name: 'X-Webhook-Key', value: 'proprio' }] },
        { url: 'https://b.com/h' },   // este cai no fallback
      ],
    };
    assert.equal(usaChaveMestraNoWebhook(cfg, CHAVE_MESTRA), true);
  });
});
