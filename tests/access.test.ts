// tests/access.test.ts
//
// Politica de acesso: o que e publico e o que exige X-Api-Key.
//
// ── Por que estes testes existem ───────────────────────────────────────────
// A regra morava inline num hook do server.ts, e o server.ts NAO TEM TESTE. Os
// testes de rota montam um Fastify novo e recriam o hook A MAO — o que eles
// exercitam nao e o que producao roda. Dois bugs reais passaram por CI verde por
// causa disso:
//
//   1. `/docs` dava 200 mas o CSS/JS tomava 401 — a lista tinha o caminho EXATO
//      '/docs' e os assets vivem em '/docs/*'. A pagina abria sem estilo e sem
//      funcionar. Descoberto abrindo no navegador.
//   2. `/api/files/*` tem de ser publico porque a URL da midia vai no webhook e
//      quem consome pode nao ter a chave — regra de PREFIXO, nao de caminho exato.
//
// Estes testes travam a distincao entre caminho exato e prefixo, que e onde a
// classe de bug vive.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAuthorized, isPublicPath, PUBLIC_PATHS, PUBLIC_PREFIXES } from '../dist/core/access.js';

describe('isPublicPath: o que dispensa a chave', () => {
  it('health check e publico (o orquestrador nao tem credencial)', () => {
    assert.equal(isPublicPath('/health'), true);
    assert.equal(isPublicPath('/healthz'), true);
  });

  it('a pagina do painel e publica (ela mesma nao expoe dado)', () => {
    assert.equal(isPublicPath('/'), true);
    assert.equal(isPublicPath('/dashboard'), true);
  });

  it('a documentacao e publica', () => {
    assert.equal(isPublicPath('/docs'), true);
    assert.equal(isPublicPath('/openapi.json'), true);
  });

  it('★ os ASSETS do Swagger tambem (o bug do /docs sem estilo)', () => {
    // /docs respondia 200 e o CSS tomava 401: a lista tinha o caminho exato e os
    // assets estao um nivel abaixo. Sem estes, a pagina abre quebrada.
    assert.equal(isPublicPath('/docs/swagger-ui.css'), true);
    assert.equal(isPublicPath('/docs/swagger-ui-bundle.js'), true);
  });

  it('★ o download de midia e publico (a URL vai no webhook)', () => {
    // Quem consome a imagem (o proprio chat) pode nao ter a chave.
    assert.equal(isPublicPath('/api/files/suporte/a1b2c3d4e5f6.jpg'), true);
  });

  it('★ query string NAO muda a decisao', () => {
    // Se a query entrasse na comparacao, /health?probe=1 passaria a exigir chave e
    // o health check do orquestrador comecaria a falhar sem motivo aparente.
    assert.equal(isPublicPath('/health?probe=1'), true);
    assert.equal(isPublicPath('/docs?x=1'), true);
    assert.equal(isPublicPath('/api/sessions?q=a'), false);
  });

  it('★ TODO o resto exige chave', () => {
    for (const u of [
      '/api/sessions',
      '/api/sessions/suporte',
      '/api/sendText',
      '/api/contacts/check-exists',
      '/api/backup',
      '/api/backup/restore',
      '/api/events',
      '/metrics',
      '/v1/sessions',
    ]) {
      assert.equal(isPublicPath(u), false, `${u} NAO pode ser publico`);
    }
  });

  it('★ /metrics exige chave (nome de sessao identifica cliente)', () => {
    // Explicito num teste proprio: e a rota que mais tenta escapar para a lista
    // publica, porque "monitoramento nao tem credencial" soa razoavel.
    assert.equal(isPublicPath('/metrics'), false);
  });

  it('nao confunde caminho que COMECA parecido com publico', () => {
    // '/healthcheck-interno' nao e '/health'. Um `startsWith` no lugar do Set
    // exato liberaria isso.
    assert.equal(isPublicPath('/healthcheck-interno'), false);
    assert.equal(isPublicPath('/dashboard-admin'), false);
    assert.equal(isPublicPath('/openapi.json.bak'), false);
  });

  it('nao vaza node_modules por um prefixo largo demais', () => {
    // O prefixo publico e '/docs/', e a lista de arquivos servidos e FECHADA no
    // server.ts. Um prefixo '/doc' ou '/' liberaria a API inteira.
    assert.equal(isPublicPath('/docsecreto'), false);
    assert.equal(isPublicPath('/api/filesystem'), false);
  });

  it('★ todo caminho publico EXISTE de verdade (nao libera rota fantasma)', () => {
    // Achado medindo o beta: `/healthz` estava nesta lista desde o inicio e a rota
    // NUNCA foi registrada — dava 404. A politica liberava um caminho inexistente, e
    // quem seguisse a convencao do Kubernetes concluiria que o gateway estava fora.
    //
    // As rotas de arquivo (`/docs/*`, `/api/files/*`) sao prefixo e ficam fora daqui.
    const servidas = new Set(['/health', '/healthz', '/', '/dashboard', '/docs', '/openapi.json']);
    for (const p of PUBLIC_PATHS) {
      assert.ok(servidas.has(p), `${p} e publico mas nao consta como rota servida`);
    }
    // E o inverso: rota servida que saiu da lista publica passaria a exigir chave
    // sem ninguem notar.
    for (const s of servidas) {
      assert.equal(isPublicPath(s), true, `${s} deveria seguir publico`);
    }
  });

  it('as listas nao se sobrepoem (cada regra tem um dono)', () => {
    // Caminho exato que tambem casa um prefixo seria regra duplicada — e regra
    // duplicada e onde uma das duas fica desatualizada.
    for (const p of PUBLIC_PATHS) {
      const casaPrefixo = PUBLIC_PREFIXES.some((pre) => p.startsWith(pre));
      assert.equal(casaPrefixo, false, `${p} esta nas duas listas`);
    }
  });
});

describe('isAuthorized: comparacao da chave', () => {
  it('chave correta autoriza', () => {
    assert.equal(isAuthorized('segredo', 'segredo'), true);
  });

  it('chave errada, ausente ou vazia nao autoriza', () => {
    assert.equal(isAuthorized('outra', 'segredo'), false);
    assert.equal(isAuthorized(undefined, 'segredo'), false);
    assert.equal(isAuthorized('', 'segredo'), false);
  });

  it('API_KEY vazia no servidor NAO abre a API', () => {
    // Nenhum valor de header autoriza quando a chave configurada e vazia. Medido:
    // testei este caso por MUTACAO (removendo o `if (!apiKey)`) e o teste continuou
    // passando — a guarda e REDUNDANTE, o `!!provided` ja barra tudo. Mantida em
    // access.ts como defesa em profundidade, mas sem a estrela: este teste
    // documenta a propriedade, nao prova que aquela linha e o que a garante.
    for (const h of [undefined, '', 'qualquer', '0', ' ']) {
      assert.equal(isAuthorized(h, ''), false, `header ${JSON.stringify(h)}`);
    }
  });

  it('header repetido: usa o primeiro valor', () => {
    // O Fastify entrega array quando o header vem duas vezes. Sem tratar, a
    // comparacao seria contra "a,b" e falharia com a chave certa presente.
    assert.equal(isAuthorized(['segredo', 'outra'], 'segredo'), true);
    assert.equal(isAuthorized(['outra', 'segredo'], 'segredo'), false);
    assert.equal(isAuthorized([], 'segredo'), false);
  });

  it('comparacao e exata (nao aceita prefixo nem caixa diferente)', () => {
    assert.equal(isAuthorized('segred', 'segredo'), false);
    assert.equal(isAuthorized('segredoo', 'segredo'), false);
    assert.equal(isAuthorized('SEGREDO', 'segredo'), false);
  });

  it('★ chave de tamanho diferente nao lanca (comparacao por hash)', () => {
    // A comparacao passou a ser `timingSafeEqual` sobre SHA-256 dos dois valores.
    // `timingSafeEqual` LANCA se os buffers tiverem tamanhos diferentes — passar os
    // valores crus faria uma chave de tamanho errado virar erro 500 em vez de 401, e o
    // TIPO do erro vazaria o comprimento da chave correta. Hashear normaliza em 32
    // bytes e remove a fuga. Este teste garante que nao voltamos aos valores crus.
    for (const tentativa of ['x', '', 'a'.repeat(500), 'segredo-quase-certo']) {
      assert.doesNotThrow(() => isAuthorized(tentativa, 'segredo'), `tentativa: ${tentativa.length} chars`);
      if (tentativa) assert.equal(isAuthorized(tentativa, 'segredo'), false);
    }
  });

  it('chave unicode e comparada corretamente', () => {
    // Hash sobre utf8 — uma chave com acento ou emoji tem de continuar funcionando.
    assert.equal(isAuthorized('chave-com-acentuação', 'chave-com-acentuação'), true);
    assert.equal(isAuthorized('chave-com-acentuacao', 'chave-com-acentuação'), false);
  });
});
