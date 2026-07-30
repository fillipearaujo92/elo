// tests/slug.test.ts
//
// Nome LIVRE para o operador: "digitar o que quiser — espaço, acento, emoji —
// sem regras e sem quebrar nada". A garantia vem de separar
//   label (texto livre, só exibição)  de  name/slug (id técnico: URL, arquivo, chave).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shortHash, slugify, uniqueSlug, validateName } from '../dist/core/slug.js';

describe('slugify: nome livre -> id tecnico seguro', () => {
  it('espacos viram hifen', () => {
    assert.equal(slugify('Atacadao Centro'), 'atacadao-centro');
  });

  it('remove acentuacao preservando a letra', () => {
    assert.equal(slugify('Atacadão Léd Ilumínação'), 'atacadao-led-iluminacao');
    assert.equal(slugify('São Paulo — São José'), 'sao-paulo-sao-jose');
    assert.equal(slugify('Çedilha Ãtil Ôtimo'), 'cedilha-atil-otimo');
  });

  it('emoji e simbolo somem sem deixar lixo', () => {
    assert.equal(slugify('Vendas 🏬 Centro'), 'vendas-centro');
    assert.equal(slugify('WhatsApp #2 (Vendas)'), 'whatsapp-2-vendas');
    assert.equal(slugify('Suporte @ 24h / 7'), 'suporte-24h-7');
  });

  it('nunca deixa separador nas pontas nem repetido', () => {
    assert.equal(slugify('  --- Vendas ---  '), 'vendas');
    assert.equal(slugify('A///B'), 'a-b');
    assert.equal(slugify('...Teste...'), 'teste');
  });

  it('SEGURANCA: caracteres perigosos em caminho/URL nao passam', () => {
    // Estes sao o motivo do slug existir: path traversal e quebra de rota.
    for (const [entrada, esperado] of [
      ['../../etc/passwd', 'etc-passwd'],
      ['a/b/c', 'a-b-c'],
      ['sessao?x=1&y=2', 'sessao-x-1-y-2'],
      ['C:\\Windows', 'c-windows'],
      ['nome#fragmento', 'nome-fragmento'],
    ]) {
      const s = slugify(entrada);
      assert.equal(s, esperado);
      assert.match(s, /^[a-z0-9-]*$/, `"${entrada}" gerou caractere inseguro: ${s}`);
      assert.ok(!s.includes('..'), 'nao pode conter ".."');
      assert.ok(!s.includes('/') && !s.includes('\\'), 'nao pode conter separador de path');
    }
  });

  it('limita o tamanho (caminho de arquivo tem teto)', () => {
    const s = slugify('a'.repeat(200));
    assert.ok(s.length <= 60, `slug longo demais: ${s.length}`);
    assert.ok(!s.endsWith('-'));
  });

  it('nome so de simbolo gera slug vazio (chamador decide o fallback)', () => {
    assert.equal(slugify('🏬🎉'), '');
    assert.equal(slugify('———'), '');
  });
});

describe('uniqueSlug: sempre utilizavel e sem colisao', () => {
  it('usa o slug simples quando esta livre', () => {
    assert.equal(uniqueSlug('Vendas SP'), 'vendas-sp');
  });

  it('nome so de emoji ainda gera id valido', () => {
    const s = uniqueSlug('🏬');
    assert.match(s, /^sessao-[a-z0-9]+$/);
    assert.ok(s.length > 7, 'precisa ter o hash');
  });

  it('resolve colisao entre nomes que slugificam igual', () => {
    const a = uniqueSlug('Vendas SP', []);
    const b = uniqueSlug('vendas-sp', [a]);
    assert.notEqual(a, b, 'dois nomes diferentes nao podem colidir');
    assert.match(b, /^[a-z0-9-]+$/);
  });

  it('nomes IDENTICOS numeram em vez de laco infinito', () => {
    const taken: string[] = [];
    for (let i = 0; i < 4; i++) taken.push(uniqueSlug('Vendas', taken));
    assert.equal(new Set(taken).size, 4, 'todos distintos');
    for (const t of taken) assert.match(t, /^[a-z0-9-]+$/);
  });

  it('o slug resultante e SEMPRE seguro, qualquer que seja a entrada', () => {
    const entradas = [
      'Atacadão Léd — Centro 🏬', '../../../etc', 'a b c d e f', '🎉', '',
      'MAIÚSCULAS', 'nome/com/barra', "aspas'e\"duplas", 'tab\tnovalinha\n',
    ];
    for (const e of entradas) {
      const s = uniqueSlug(e);
      assert.ok(s.length > 0, `"${e}" gerou slug vazio`);
      assert.match(s, /^[a-z0-9-]+$/, `"${e}" -> "${s}" tem caractere inseguro`);
      assert.equal(s, encodeURIComponent(s), 'slug deve passar intacto por URL');
    }
  });
});

describe('shortHash: determinístico', () => {
  it('o mesmo nome gera sempre o mesmo sufixo', () => {
    assert.equal(shortHash('Vendas SP'), shortHash('Vendas SP'));
  });

  it('nomes diferentes geram sufixos diferentes', () => {
    assert.notEqual(shortHash('Vendas SP'), shortHash('Vendas RJ'));
  });
});

describe('validateName: permissivo, barra só o inoperável', () => {
  it('aceita texto livre com acento, emoji e pontuacao', () => {
    for (const n of ['Atacadão Léd 🏬', 'WhatsApp #2', 'Suporte 24/7', 'a']) {
      assert.equal(validateName(n).ok, true, `deveria aceitar "${n}"`);
    }
  });

  it('rejeita vazio e só-espaço', () => {
    assert.equal(validateName('').ok, false);
    assert.equal(validateName('   ').ok, false);
    assert.equal(validateName(undefined).ok, false);
  });

  it('rejeita nome absurdamente longo', () => {
    assert.equal(validateName('a'.repeat(121)).ok, false);
  });

  it('rejeita caractere de controle (colagem acidental)', () => {
    assert.equal(validateName('nome\u0000nulo').ok, false);
  });

  it('devolve o nome com trim', () => {
    const r = validateName('  Vendas  ');
    assert.equal(r.ok && r.name, 'Vendas');
  });
});
