// src/core/access.ts
//
// Politica de acesso: o que exige X-Api-Key e o que e publico.
//
// ── Por que este modulo existe ─────────────────────────────────────────────
// Esta decisao morava dentro de um `addHook('onRequest')` no server.ts, e o
// server.ts NAO TEM TESTE. Os testes de rota (tests/routes.test.ts,
// tests/openapi.test.ts) montam um Fastify novo e recriam o hook de auth A MAO —
// entao o que os testes exercitam nao e o que producao roda.
//
// Isso ja custou dois bugs reais, ambos aprovados por CI verde:
//
//   1. `/docs` respondia 200 mas o CSS/JS tomava 401: PUBLIC_PATHS tinha o caminho
//      EXATO '/docs', e os assets estao em '/docs/*'. A pagina abria sem estilo e
//      sem funcionar. Descoberto abrindo no navegador, nao por teste.
//   2. `/api/files/*` (download de midia) precisa ser publico porque a URL vai no
//      webhook e quem consome a imagem pode nao ter a chave — regra de prefixo, nao
//      de caminho exato.
//
// A licao dos dois: a politica e sobre PREFIXOS e nao so caminhos exatos, e uma
// funcao pura e a unica forma de travar isso em teste. O hook do server.ts agora
// delega para `isPublicPath` e nao repete a regra.

/**
 * Caminhos EXATOS que dispensam a chave.
 *
 * - `/health`, `/healthz`: orquestrador precisa checar sem credencial.
 * - `/`, `/dashboard`: a PAGINA do painel nao expoe dado — ela pede a chave num
 *   formulario e so entao consome a API (que segue protegida). Servir o HTML atras
 *   de auth exigiria um segundo mecanismo de sessao sem ganho real.
 * - `/docs`, `/openapi.json`: e DOCUMENTACAO. Exigir chave para ler a documentacao
 *   e atrito sem ganho — a spec descreve a FORMA da API, nao expoe dado. Quem for
 *   testar pelo Swagger informa a chave la.
 */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/health',
  '/healthz',
  '/',
  '/dashboard',
  '/docs',
  '/openapi.json',
]);

/**
 * Prefixos publicos. Distintos dos caminhos exatos de proposito — foi justamente
 * confundir os dois que deixou os assets do Swagger em 401.
 *
 * - `/api/files/`: a URL da midia vai dentro do webhook e e consumida por quem pode
 *   nao ter a chave (o proprio chat servindo a imagem). O nome do arquivo tem 12 hex
 *   aleatorios, o que o torna nao-adivinhavel; ainda assim e trade-off consciente:
 *   quem tiver a URL exata acessa o arquivo.
 * - `/docs/`: CSS e JS do Swagger UI. A lista de arquivos servidos e FECHADA no
 *   server.ts (SWAGGER_ASSETS), entao liberar o prefixo nao expoe node_modules.
 */
export const PUBLIC_PREFIXES: readonly string[] = ['/api/files/', '/docs/'];

/**
 * Decide se a requisicao dispensa a chave.
 *
 * Recebe a URL CRUA (com query string): tirar a query aqui, num lugar so, evita a
 * classe de bug em que `/health?x=1` passaria a exigir chave por nao casar o Set.
 */
export function isPublicPath(url: string): boolean {
  const caminho = url.split('?')[0] ?? '';
  if (PUBLIC_PATHS.has(caminho)) return true;
  return PUBLIC_PREFIXES.some((p) => caminho.startsWith(p));
}

/**
 * Compara a chave recebida com a configurada.
 *
 * Aceita o valor cru do header: o Fastify entrega ARRAY quando o header vem
 * repetido, e sem tratar isso a comparacao seria contra "a,b" e falharia mesmo com
 * a chave certa presente.
 *
 * O `if (!apiKey)` e redundante hoje — o `!!provided` ja barra tudo quando a chave
 * configurada e vazia (medido: nenhum valor de header autoriza com apiKey='').
 * Fica como defesa em profundidade: se alguem trocar o `!!provided` por uma
 * comparacao que aceite string vazia, esta linha ainda impede que um `API_KEY=''`
 * mal configurado abra a API inteira. Custa uma comparacao.
 */
export function isAuthorized(header: string | string[] | undefined, apiKey: string): boolean {
  if (!apiKey) return false;
  const provided = Array.isArray(header) ? header[0] : header;
  return !!provided && provided === apiKey;
}
