// src/core/net-guard.ts
//
// Guarda contra SSRF: o gateway baixa URLs que o CLIENTE escolhe.
//
// ── Por que este modulo existe ─────────────────────────────────────────────
// Dois caminhos da API aceitam uma URL arbitraria e fazem `fetch` nela:
//
//   1. `POST /api/sendMedia` (e as rotas de envio com `file.url`) — o conteudo
//      baixado vira MENSAGEM DE WHATSAPP para o chatId que o cliente escolheu.
//      Isso e exfiltracao completa, nao SSRF cego: o atacante le a rede interna e
//      recebe o resultado no proprio WhatsApp.
//   2. `POST /api/sessions/:s/test-webhook` — pior, porque devolve
//      `body.slice(0,200)` na RESPOSTA HTTP. E um leitor de rede interna sincrono.
//
// A validacao que existia cobria so o protocolo (http/https). MEDIDO no beta antes
// da correcao: `test-webhook` com `http://127.0.0.1:3000/health` devolveu o corpo da
// resposta interna do proprio container. O buraco era real, nao teorico.
//
// Alvos que isso alcanca numa instalacao tipica: metadata da instancia de cloud
// (169.254.169.254 → credenciais IAM), servicos que so escutam em loopback, e toda
// a rede privada do datacenter ou da rede Docker.
//
// ── Duas decisoes que importam ─────────────────────────────────────────────
// **Resolver o DNS ANTES do fetch.** Validar so a string da URL nao serve: um nome
// publico pode resolver para 127.0.0.1 (o ataque classico de "DNS rebinding" na sua
// forma mais simples). Aqui resolvemos e checamos os IPs de verdade.
//
// **`redirect: 'error'`.** Sem isso qualquer validacao de host e contornavel: o
// atacante aponta para um host publico que responde 302 para 169.254.169.254, e o
// `fetch` do Node segue por padrao. A checagem valeria para o primeiro salto e o
// segundo passaria livre.
//
// Resta uma janela TOCTOU (o IP pode mudar entre a resolucao e a conexao). Fechar
// isso exigiria conectar pelo IP validado com o Host header original, o que quebra
// TLS/SNI. Para o modelo de ameaca daqui — a chave da API ja e necessaria, entao o
// que se impede e ESCALADA de "posso enviar mensagem" para "posso ler a rede
// interna" — a resolucao previa cobre o caso pratico. Registrado, nao esquecido.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Boom } from '@hapi/boom';
import { config } from '../config.js';

/** Motivo da rejeicao, para mensagem de erro acionavel e para teste. */
export type BloqueioMotivo =
  | 'protocolo'
  | 'sem_host'
  | 'loopback'
  | 'link_local'
  | 'privado'
  | 'cgnat'
  | 'reservado'
  | 'dns_falhou';

export interface Veredito {
  ok: boolean;
  motivo?: BloqueioMotivo;
  detalhe?: string;
}

/**
 * Classifica um IP literal. Puro — nao toca rede, entao da para testar cada faixa.
 *
 * As faixas seguem a RFC 1918 (privado), RFC 3927 (link-local), RFC 6598 (CGNAT) e
 * RFC 5735 (reservado). Link-local e o mais importante na pratica: e onde vivem os
 * servicos de metadata da AWS, GCP, Azure, DigitalOcean e Oracle Cloud, todos em
 * 169.254.169.254.
 */
export function classificarIp(ip: string): BloqueioMotivo | null {
  const v = isIP(ip);
  if (v === 4) return classificarIpv4(ip);
  if (v === 6) return classificarIpv6(ip);
  return 'reservado';
}

function classificarIpv4(ip: string): BloqueioMotivo | null {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return 'reservado';
  }
  const [a, b] = p as [number, number, number, number];
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link_local';
  if (a === 10) return 'privado';
  if (a === 172 && b >= 16 && b <= 31) return 'privado';
  if (a === 192 && b === 168) return 'privado';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  // 0.0.0.0/8 (este host), 224/4 (multicast), 240/4 (reservado) e o broadcast.
  if (a === 0 || a >= 224) return 'reservado';
  return null;
}

function classificarIpv6(ip: string): BloqueioMotivo | null {
  const x = ip.toLowerCase();
  if (x === '::' || x === '::1') return 'loopback';
  // ★ IPv4 mapeado (::ffff:127.0.0.1) — sem isto o bloqueio de IPv4 seria
  // contornavel escrevendo o mesmo endereco em forma IPv6.
  const mapeado = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapeado) return classificarIpv4(mapeado[1]!);
  if (x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb')) {
    return 'link_local';
  }
  // fc00::/7 (unique local) — o equivalente IPv6 do RFC 1918.
  if (x.startsWith('fc') || x.startsWith('fd')) return 'privado';
  return null;
}

/** Texto do motivo, para o erro dizer o que aconteceu. */
const TEXTO: Record<BloqueioMotivo, string> = {
  protocolo: 'a URL precisa usar http ou https',
  sem_host: 'a URL nao tem host',
  loopback: 'aponta para o proprio servidor (loopback)',
  link_local: 'aponta para endereco link-local, onde ficam as credenciais da instancia',
  privado: 'aponta para endereco de rede privada',
  cgnat: 'aponta para faixa CGNAT',
  reservado: 'aponta para endereco reservado',
  dns_falhou: 'o host nao pode ser resolvido',
};

/**
 * Verifica se a URL pode ser buscada pelo gateway.
 *
 * `ALLOW_PRIVATE_FETCH=1` libera as faixas privadas — caso legitimo em instalacao
 * self-hosted onde o consumidor do webhook e a origem da midia vivem na mesma rede
 * interna. Loopback e link-local seguem bloqueados MESMO assim: nao existe caso de
 * uso legitimo para o gateway buscar a propria metadata da instancia.
 */
export async function verificarUrl(bruta: string): Promise<Veredito> {
  let u: URL;
  try {
    u = new URL(bruta);
  } catch {
    return { ok: false, motivo: 'protocolo', detalhe: 'URL invalida' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, motivo: 'protocolo', detalhe: u.protocol };
  }
  const host = u.hostname.replace(/^\[|\]$/g, ''); // IPv6 vem entre colchetes
  if (!host) return { ok: false, motivo: 'sem_host' };

  // IP literal: classifica direto, sem consultar DNS.
  if (isIP(host)) {
    const m = classificarIp(host);
    return m && !permitido(m) ? { ok: false, motivo: m, detalhe: host } : { ok: true };
  }

  // Nome: resolve TODOS os enderecos. Um unico endereco ruim reprova — se o nome
  // resolve para um publico e um privado, o fetch pode escolher qualquer um.
  let enderecos: Array<{ address: string }>;
  try {
    enderecos = await lookup(host, { all: true });
  } catch (err) {
    return { ok: false, motivo: 'dns_falhou', detalhe: (err as Error).message };
  }
  if (!enderecos.length) return { ok: false, motivo: 'dns_falhou', detalhe: 'sem resposta' };

  for (const { address } of enderecos) {
    const m = classificarIp(address);
    if (m && !permitido(m)) return { ok: false, motivo: m, detalhe: `${host} -> ${address}` };
  }
  return { ok: true };
}

/**
 * Loopback e link-local NUNCA sao liberados, nem com ALLOW_PRIVATE_FETCH.
 *
 * A primeira linha e REDUNDANTE hoje — verificado por mutacao: removi-a, rodei a
 * suite com a flag ligada, e nada mudou, porque 'loopback'/'link_local' nao casam
 * `(privado|cgnat)` e ja cairiam no false final. Fica como defesa em profundidade e
 * como declaracao de intencao: se alguem ampliar a lista de motivos liberaveis, esta
 * linha impede que a metadata da instancia entre junto por descuido. Custa uma
 * comparacao. Mesma decisao (e mesma honestidade) da guarda em core/access.ts.
 */
function permitido(m: BloqueioMotivo): boolean {
  if (m === 'loopback' || m === 'link_local') return false;
  return config.allowPrivateFetch && (m === 'privado' || m === 'cgnat');
}

/**
 * `fetch` com a guarda aplicada e redirect desligado.
 *
 * Usa 422 (nao 400) para casar com o resto do projeto: a URL esta bem formada, o
 * problema e o destino. A mensagem diz o motivo e o endereco resolvido, porque
 * "falhou" sem causa e o tipo de erro que faz o integrador abrir chamado.
 */
export const fetchGuardado: typeof fetch = async (entrada, init) => {
  // Aceita as tres formas que o `fetch` aceita. Um `Request` tambem carrega URL, e
  // deixa-lo passar sem checar seria um buraco na guarda por diferenca de assinatura.
  const url = typeof entrada === 'string' ? entrada
    : entrada instanceof URL ? entrada.href
    : entrada.url;

  const v = await verificarUrl(url);
  if (!v.ok) {
    const motivo = v.motivo ?? 'reservado';
    throw new Boom(
      `URL bloqueada: ${TEXTO[motivo]}${v.detalhe ? ` (${v.detalhe})` : ''}`,
      { statusCode: 422, data: { code: 'url_blocked', motivo } },
    );
  }
  // ★ `redirect: 'error'` e parte da guarda, nao detalhe: sem isto o atacante usa
  // um host publico que responde 302 para o endereco interno.
  return fetch(entrada, { ...init, redirect: 'error' });
};
