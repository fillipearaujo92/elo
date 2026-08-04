// tests/mensagem-perdida.test.ts
//
// Mensagem que nao decifra: primeira falha vs PERDA definitiva.
//
// ── Por que estes testes existem ───────────────────────────────────────────
// MEDIDO no beta: 7 mensagens nao decifradas (Bad MAC), e apenas 2 chegaram ao
// consumidor depois do reenvio. **5 PERDIDAS — 71%.** Todas em GRUPO, onde o remetente
// precisa reconstruir a sender-key para cada participante.
//
// Duas causas, corrigidas juntas:
//
//   1. `retryRequestDelayMs` estava no default do Baileys: **250ms**. Quando a sessao
//      Signal dessincroniza, o remetente tem de RECEBER o retry receipt, recriar a
//      sessao e reenviar — em 250ms ele mal processou o recibo. Agora 3s.
//   2. O contador nao distinguia "vai chegar no reenvio" de "sumiu". As duas contavam
//      em `inbound_undecryptable_total`, entao o operador via "10 falhas" sem saber
//      quantas eram perdas definitivas. Agora a SEGUNDA falha do mesmo id conta em
//      `inbound_lost_total` — o numero que responde "estou perdendo mensagem AGORA?".
//
// A logica de "segunda falha" e testada aqui de forma isolada; o efeito do
// `retryRequestDelayMs` e do Baileys e foi validado por medicao no beta.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(raiz, 'src', 'core', 'session-manager.ts'), 'utf8');

/**
 * Replica da regra de "segunda falha", com o mesmo teto do original. Testada isolada
 * porque o caminho real depende de um socket Baileys vivo.
 */
function criarDetector(teto = 500) {
  const falhou = new Set<string>();
  return {
    /** Devolve 'perdida' na segunda falha do mesmo id, 'retry' na primeira. */
    registrar(id: string): 'retry' | 'perdida' {
      if (falhou.has(id)) {
        falhou.delete(id);
        return 'perdida';
      }
      if (id) {
        if (falhou.size >= teto) {
          const primeiro = falhou.values().next().value;
          if (primeiro !== undefined) falhou.delete(primeiro);
        }
        falhou.add(id);
      }
      return 'retry';
    },
    tamanho: () => falhou.size,
  };
}

describe('deteccao de mensagem PERDIDA', () => {
  it('★ primeira falha e "retry", segunda do MESMO id e "perdida"', () => {
    const d = criarDetector();
    assert.equal(d.registrar('MSG-A'), 'retry', 'a primeira falha pede reenvio');
    assert.equal(d.registrar('MSG-A'), 'perdida', 'a segunda e perda definitiva');
  });

  it('ids DIFERENTES nao se confundem', () => {
    const d = criarDetector();
    assert.equal(d.registrar('MSG-A'), 'retry');
    assert.equal(d.registrar('MSG-B'), 'retry');
    assert.equal(d.registrar('MSG-C'), 'retry');
    assert.equal(d.registrar('MSG-B'), 'perdida', 'so o B falhou duas vezes');
  });

  it('★ apos contar a perda, o id sai do Set (nao vaza memoria)', () => {
    // Sem o delete, um id que falhasse 3x contaria perda 2x — e o Set cresceria com
    // ids que nunca mais aparecem.
    const d = criarDetector();
    d.registrar('MSG-A');
    assert.equal(d.tamanho(), 1);
    d.registrar('MSG-A');
    assert.equal(d.tamanho(), 0, 'o id foi liberado depois de contar a perda');
  });

  it('★ o Set tem TETO (sessao de meses nao pode crescer sem fim)', () => {
    const d = criarDetector(10);
    for (let i = 0; i < 25; i++) d.registrar(`MSG-${i}`);
    assert.ok(d.tamanho() <= 10, `tamanho ${d.tamanho()} passou do teto`);
  });

  it('id vazio nao entra no Set', () => {
    const d = criarDetector();
    d.registrar('');
    assert.equal(d.tamanho(), 0);
  });
});

describe('configuracao do retry (o que causava a perda)', () => {
  it('★ retryRequestDelayMs esta EXPLICITO e maior que o default de 250ms', () => {
    // O default do Baileys (Defaults/index.js) e 250ms — agressivo demais: o remetente
    // ainda nao processou o retry receipt. Medido: 71% de perda com o default.
    const m = src.match(/retryRequestDelayMs:\s*([\d_]+)/);
    assert.ok(m, 'retryRequestDelayMs tem de ser declarado, nao herdado do default');
    const ms = Number(m[1]!.replace(/_/g, ''));
    assert.ok(ms >= 2000, `${ms}ms e pouco: o remetente precisa recriar a sessao Signal`);
  });

  it('maxMsgRetryCount segue permitindo varias tentativas', () => {
    const m = src.match(/maxMsgRetryCount:\s*(\d+)/);
    assert.ok(m);
    assert.ok(Number(m[1]) >= 3, 'poucas tentativas desperdicam a espera maior');
  });

  it('os dois defaults que curam Bad MAC seguem explicitos', () => {
    // Um default que mudasse entre RCs do Baileys traria o bug de volta em silencio.
    assert.match(src, /enableAutoSessionRecreation:\s*true/);
    assert.match(src, /enableRecentMessageCache:\s*true/);
  });

  it('★ a perda tem contador PROPRIO, separado da primeira falha', () => {
    assert.match(src, /inc\('inbound_lost_total'/);
    assert.match(src, /inc\('inbound_undecryptable_total'/);
  });
});
