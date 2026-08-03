// src/core/link-preview.ts
//
// Previa de link (Open Graph) para mensagens de texto com URL.
//
// ── Por que este modulo existe, em vez da lib do Baileys ───────────────────
// O Baileys tenta gerar a previa chamando `link-preview-js`, declarada como
// peerDependency OPCIONAL. Ela nao estava instalada, e toda mensagem com link
// registrava no log:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'link-preview-js'
//
// (medido no beta: 2 ocorrencias no teste do Filipe, uma para o link da proposta e
// outra para o link de pagamento). A mensagem ERA entregue — o WhatsApp monta a previa
// do lado dele — mas o erro poluia o log e o gateway nao entregava o thumbnail.
//
// Instalar a lib parecia a correcao obvia. NAO E: `npm audit` a reporta com
// vulnerabilidade HIGH sem correcao disponivel (GHSA-4gp8-rjrq-ch6q), e o titulo do
// aviso e literalmente "vulnerable to IPv6 and internal loopback attacks" — ou seja,
// SSRF, a MESMA classe que o net-guard acabou de fechar em tres outros caminhos.
// Instala-la reabriria o buraco pela porta do preview: a URL vem do texto da mensagem,
// escolhida por quem envia.
//
// Entao aqui: implementacao propria, minima, passando pelo `fetchGuardado`. O Baileys
// aceita `getUrlInfo` injetado por chamada (Types/Message.d.ts:286), o que evita
// depender da lib e mantem UMA nocao de "url que o gateway pode buscar".
//
// Escopo deliberadamente pequeno: titulo, descricao e a URL da imagem. Sem baixar o
// thumbnail — isso exigiria decodificar imagem de origem nao confiavel no processo que
// mantem as sessoes WhatsApp, e o ganho visual nao paga o risco. O WhatsApp gera a
// previa completa mesmo sem o thumbnail vir no proto.

import { fetchGuardado } from './net-guard.js';

/** Shape que o Baileys espera de `getUrlInfo`. */
export interface UrlInfo {
  'canonical-url': string;
  'matched-text': string;
  title?: string;
  description?: string;
  jpegThumbnail?: Buffer;
  originalThumbnailUrl?: string;
}

/** Primeira URL http(s) do texto. */
export function primeiraUrl(texto: string): string | null {
  const m = texto.match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return null;
  // Pontuacao final costuma ser da frase, nao da URL: "veja https://x.com/a."
  return m[0].replace(/[.,;:!?)\]}]+$/, '');
}

/** Extrai uma meta tag de Open Graph, ou a alternativa em HTML puro. */
function meta(html: string, ...nomes: string[]): string | undefined {
  for (const nome of nomes) {
    // Aceita property/name em qualquer ordem de atributo, com aspas simples ou duplas.
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${nome}["'][^>]+content=["']([^"']*)["']`,
      'i',
    );
    const alt = new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${nome}["']`,
      'i',
    );
    const v = html.match(re)?.[1] ?? html.match(alt)?.[1];
    if (v?.trim()) return decodeEntidades(v.trim());
  }
  return undefined;
}

/** As cinco entidades HTML que aparecem em titulo real. Sem lib: o resto e ruido. */
function decodeEntidades(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Teto do HTML lido. Previa e enfeite: nao vale segurar memoria por ela. */
const MAX_HTML_BYTES = 512 * 1024;
const TIMEOUT_MS = 8_000;

/**
 * Busca os metadados do link. Devolve `undefined` em qualquer falha.
 *
 * NUNCA lanca: a previa e opcional e uma falha aqui nao pode impedir o envio da
 * mensagem. Era esse o comportamento do Baileys tambem (ele engolia o
 * ERR_MODULE_NOT_FOUND e enviava), e preservamos — so sem o erro no log.
 */
export async function getUrlInfo(texto: string): Promise<UrlInfo | undefined> {
  const url = primeiraUrl(texto);
  if (!url) return undefined;

  try {
    const res = await fetchGuardado(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        // Alguns sites devolvem HTML sem Open Graph para user-agent desconhecido.
        'User-Agent': 'Mozilla/5.0 (compatible; ELO-Gateway/1.0; +link-preview)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return undefined;

    // So HTML interessa: um PDF ou video de 500MB nao tem Open Graph e nao deve ser
    // baixado nem parcialmente.
    const tipo = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml/i.test(tipo)) return undefined;

    const html = await lerLimitado(res, MAX_HTML_BYTES);
    // `<title>` como alternativa quando nao ha Open Graph. O `|| undefined` normaliza
    // string vazia (site sem titulo) para ausente — e precisa de parenteses: misturar
    // `??` e `||` sem eles e erro de sintaxe, nao so estilo.
    const tagTitle = decodeEntidades(
      html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1]?.trim() ?? '',
    );
    const title = meta(html, 'og:title', 'twitter:title') ?? (tagTitle || undefined);
    const description = meta(html, 'og:description', 'twitter:description', 'description');
    const imagem = meta(html, 'og:image', 'twitter:image');

    // Sem titulo a previa nao tem valor: o WhatsApp mostraria um cartao vazio.
    if (!title) return undefined;

    return {
      'canonical-url': url,
      'matched-text': url,
      title,
      ...(description ? { description } : {}),
      // A URL da imagem vai como referencia; nao baixamos o binario (ver o cabecalho).
      ...(imagem ? { originalThumbnailUrl: imagem } : {}),
    };
  } catch {
    // Inclui URL bloqueada pelo net-guard (loopback, link-local, rede privada): a
    // mensagem segue sem previa, que e o comportamento correto e silencioso.
    return undefined;
  }
}

/** Le o corpo parando no teto, sem alocar tudo se o servidor mentir no content-length. */
async function lerLimitado(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      partes.push(value);
      total += value.byteLength;
      // O Open Graph vive no <head>: parar no teto nao perde o que interessa.
      if (total >= max) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  return Buffer.concat(partes).toString('utf8');
}
