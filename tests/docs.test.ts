// tests/docs.test.ts
//
// A documentacao nao pode apontar para arquivo que nao existe.
//
// ── Por que este teste existe ──────────────────────────────────────────────
// A fricção numero 1 do onboarding era um LINK 404. Os dois READMEs linkavam para
// `docs/INTEGRACAO.md` — o guia de integracao — e o arquivo nunca existiu. Pior: o
// texto do proprio link prometia "uma tabela de erros comuns com a causa de cada um",
// exatamente o que falta em todo o resto da documentacao.
//
// Ou seja: o desenvolvedor que seguia o caminho recomendado batia num 404 do GitHub
// no ponto em que mais precisava de ajuda. E nada avisava — link quebrado em markdown
// nao quebra build, nao quebra teste, nao aparece no CI.
//
// Este teste varre os links relativos de TODO markdown do repo. E barato e fecha a
// classe inteira, nao so o caso que doeu.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Todo .md do repo, fora de node_modules e dist. */
function markdowns(dir = raiz, achados: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', 'coverage'].includes(nome)) continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) markdowns(caminho, achados);
    else if (nome.endsWith('.md')) achados.push(caminho);
  }
  return achados;
}

describe('documentacao: links relativos', () => {
  it('★ nenhum link aponta para arquivo inexistente', () => {
    // O bug do docs/INTEGRACAO.md. Link quebrado em markdown e invisivel para o CI.
    const quebrados: string[] = [];
    for (const arquivo of markdowns()) {
      const texto = readFileSync(arquivo, 'utf8');
      for (const m of texto.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const alvo = m[1]!;
        // Ignora URL absoluta, ancora e mailto — so links de arquivo interessam aqui.
        if (/^(https?:|mailto:|#)/.test(alvo)) continue;
        const semAncora = alvo.split('#')[0]!;
        if (!semAncora) continue;
        const destino = resolve(dirname(arquivo), semAncora);
        if (!existsSync(destino)) {
          quebrados.push(`${arquivo.replace(raiz, '.')} -> ${alvo}`);
        }
      }
    }
    assert.deepEqual(quebrados, [], 'links apontando para arquivo que nao existe');
  });

  it('★ o guia de integracao existe (era o link 404 que motivou isto)', () => {
    assert.ok(existsSync(join(raiz, 'docs', 'INTEGRACAO.md')));
  });

  it('o guia entrega o que os READMEs prometem', () => {
    // Os dois READMEs anunciam o conteudo: subir, receber webhook, enviar, monitorar e
    // a tabela de erros. Se o guia existir mas nao cobrir isso, o link deixa de ser
    // 404 e passa a ser decepcao — que e pior, porque nao da erro.
    const g = readFileSync(join(raiz, 'docs', 'INTEGRACAO.md'), 'utf8');
    assert.match(g, /## 1\. Subir/, 'falta a secao de subir');
    assert.match(g, /## 3\. Receber/, 'falta a secao de receber');
    assert.match(g, /## 4\. Enviar/, 'falta a secao de enviar');
    assert.match(g, /## 5\. Monitorar/, 'falta a secao de monitorar');
    assert.match(g, /Erros comuns/, 'falta a tabela de erros prometida no README');
    // O exemplo de receptor de webhook era a lacuna concreta: o README documentava o
    // payload mas nao havia UMA linha de codigo de servidor recebendo.
    assert.match(g, /app\.post\(/, 'falta o exemplo de webhook receiver');
    assert.match(g, /X-Webhook-Key/, 'o exemplo precisa validar a chave do webhook');
  });

  it('o guia avisa sobre a biblioteca nao-oficial', () => {
    // Quem integra precisa saber do risco de ban ANTES de escrever codigo.
    const g = readFileSync(join(raiz, 'docs', 'INTEGRACAO.md'), 'utf8');
    assert.match(g, /nao-oficial|não-oficial/i);
    assert.match(g, /banido/i);
  });
});
