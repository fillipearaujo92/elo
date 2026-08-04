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

import { createHash, timingSafeEqual } from 'node:crypto';

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
  if (!provided) return false;
  return mesmaChave(provided, apiKey);
}

/**
 * Compara duas chaves em tempo constante.
 *
 * `===` em string faz short-circuit no primeiro byte divergente, entao o tempo de
 * resposta vaza quantos bytes iniciais estao certos. Sozinho isso e dificil de
 * explorar sobre HTTP (o jitter da rede afoga o sinal), mas o gateway nao tinha
 * NENHUM rate limit: o atacante tinha orcamento infinito de tentativas, e volume
 * suficiente vence ruido. O rate limit fecha o outro lado do mesmo problema.
 *
 * ★ Compara os HASHES, nao os valores. `timingSafeEqual` exige buffers do mesmo
 * tamanho — passar os valores crus vazaria o COMPRIMENTO da chave (ou lancaria, o
 * que vaza a mesma coisa pelo tipo de erro). SHA-256 normaliza tudo em 32 bytes, e
 * comparar hashes de tamanho fixo remove as duas fugas de uma vez.
 *
 * ⚠ LIMITE DE COBERTURA, registrado por honestidade: nenhum teste aqui detecta a
 * troca de `timingSafeEqual` por `===`. Verifiquei por mutacao — voltar para `===`
 * deixa a suite 100% verde. Constant-time e propriedade de TEMPO, e medir timing em
 * teste unitario e instavel por natureza (o jitter da maquina de CI afoga a
 * diferenca). O que OS TESTES cobrem e o efeito colateral: usar os valores crus no
 * lugar dos hashes quebra 5 testes. Quem mexer nesta funcao precisa saber que o
 * compilador e a suite nao vao avisar; o comentario e a unica guarda.
 */
function mesmaChave(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

// ── Politica de LOG de acesso ──────────────────────────────────────────────
//
// Aqui e nao inline no server.ts pelo MESMO motivo que `isPublicPath` mora aqui: o
// server.ts nao tem teste, e regra inline num hook e regra que ninguem verifica. A
// diferenca entre "silencia o healthcheck" e "silencia o healthcheck que esta
// FALHANDO" e um `status < 400` — exatamente o tipo de detalhe que passa por revisao
// e some no log quando importa.

/**
 * Rotas cujo acesso BEM-SUCEDIDO nao merece linha de log.
 *
 * So health: e a unica rota que um agente externo bate em intervalo fixo para sempre.
 * `/metrics` fica FORA de proposito — quem raspa metrica costuma ser um scraper cujo
 * acesso interessa auditar (a rota e protegida justamente porque nome de sessao
 * identifica cliente).
 */
export const ROTAS_SEM_LOG: ReadonlySet<string> = new Set(['/health', '/healthz']);

/**
 * Decide se a requisicao entra no log de acesso.
 *
 * ★ MEDIDO no beta antes de existir: o healthcheck do Docker batia em /health a cada
 * 30s e o Fastify emitia DUAS linhas por vez ("incoming request" + "request
 * completed"). Resultado real, contado em 200 linhas de `docker logs`: a maioria era
 * esse par. Webhook perdido e mensagem nao decifrada — os dois eventos que respondem
 * "estou perdendo mensagem?" — saiam do buffer empurrados por ruido.
 *
 * ★ A guarda que importa: `status >= 400` SEMPRE loga, inclusive em rota silenciosa.
 * Container de pe servindo 503 no health e o caso confuso de diagnosticar, e silenciar
 * justamente esse seria trocar ruido por cegueira. Health em 200 nao e informacao;
 * health em qualquer outra coisa e.
 */
export function deveLogarRequisicao(
  url: string,
  status: number,
  logHealth = false,
): boolean {
  if (logHealth) return true;
  if (status >= 400) return true;
  // Compara sem query string: `/health?x=1` e a mesma rota.
  const caminho = url.split('?')[0] ?? '';
  return !ROTAS_SEM_LOG.has(caminho);
}
