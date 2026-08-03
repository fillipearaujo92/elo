// src/routes/sessions.ts
//
// Endpoints de sessao no formato WAHA. Consumidos por:
//   - wa-provider/waha.js: connectionState, start, ensureSessionAndQR, deleteInstance,
//     setIgnoreGroups
//   - routes/channels.js do backend (criacao de canal e QR na UI)

import type { FastifyInstance } from 'fastify';
import { snapshot } from '../core/metrics.js';
import { fetchGuardado, verificarUrl } from '../core/net-guard.js';
import { uniqueSlug, validateName } from '../core/slug.js';
import type { SessionManager } from '../core/session-manager.js';
import type { SessionConfig } from '../core/session-manager.js';

interface Deps {
  sessions: SessionManager;
}

export function registerSessionRoutes(app: FastifyInstance, { sessions }: Deps): void {
  // POST /api/sessions — cria (e opcionalmente inicia) a sessao.
  // O driver manda { name, start: true, config: { webhooks: [...] } } e trata 422
  // "already exists" como benigno (waha.js:205), reaplicando o config via PUT.
  app.post<{ Body: { name?: string; label?: string; start?: boolean; config?: SessionConfig } }>(
    '/api/sessions',
    async (req, reply) => {
      const raw = req.body?.name;

      // ── NOME LIVRE ────────────────────────────────────────────────────────
      // O operador digita o que quiser: "Atacadão Léd — Centro 🏬". Guardamos o
      // texto como `label` e derivamos um slug seguro para uso técnico (URL,
      // caminho de mídia, chaves do auth state). Ver src/core/slug.ts.
      //
      // Compatibilidade: quando o nome JÁ é um slug válido (é o caso do backend
      // do Sysled, que envia channels.identifier slugificado), usamos como está —
      // assim nada muda para quem já integra.
      const v = validateName(raw);
      if (!v.ok) return reply.code(400).send({ message: v.error });
      const label = req.body?.label?.trim() || v.name;

      // ★ `a-z` MINÚSCULO de propósito, e não `a-zA-Z`.
      //
      // Antes, `{"name":"Atendimento"}` era considerado "já é slug" e gravado com o
      // A maiúsculo — mas a documentação e a intuição usam
      // `/api/atendimento/auth/qr`, que dava 404. Era o primeiro passo de qualquer
      // usuário novo (achado testando o README do zero).
      // Deixando só minúsculo aqui, `Atendimento` cai no slugify e vira
      // `atendimento`: uma grafia só, sem ambiguidade entre as duas.
      const isAlreadySlug = /^[a-z0-9_-]+$/.test(v.name);
      let name: string;
      if (isAlreadySlug) {
        name = v.name;
      } else {
        const taken = (await sessions.listSessions()).map((s) => s.name);
        name = uniqueSlug(v.name, taken);
      }

      const existing = await sessions.getSessionRow(name);
      if (existing) {
        // 422 e o codigo que o driver reconhece como "ja existe" — devolver 200 aqui
        // faria o driver pular a reaplicacao do config via PUT.
        return reply.code(422).send({ message: `sessao ${name} ja existe` });
      }

      const shouldStart = req.body?.start !== false;
      await sessions.upsertSession(name, req.body?.config ?? {}, shouldStart, label);
      if (shouldStart) {
        // Nao esperamos o pareamento: o QR e buscado no proximo request do driver.
        sessions.start(name).catch((err) =>
          app.log.error({ session: name, err: err.message }, 'falha ao iniciar sessao nova'),
        );
      }
      const desc = await sessions.describe(name);
      return reply.code(201).send(desc);
    },
  );

  // GET /api/sessions — lista.
  app.get('/api/sessions', async () => {
    const rows = await sessions.listSessions();
    const out = [];
    for (const r of rows) out.push(await sessions.describe(r.name));
    return out;
  });

  // GET /api/stats — contadores por sessão, para o painel de operação.
  // Não faz parte do contrato do WAHA; é endpoint próprio.
  // Contadores do banco + metricas em memoria, por sessao. O painel usa isto para
  // mostrar "esta perdendo mensagem?" sem o operador abrir o Prometheus.
  app.get('/api/stats', async () => {
    const base = await sessions.stats();
    const m = snapshot();
    const out: Record<string, Record<string, number>> = {};
    for (const [nome, v] of Object.entries(base)) {
      out[nome] = { ...v, ...(m[nome] ?? {}) };
    }
    // Sessao com metrica mas sem linha (removida agora) ainda aparece.
    for (const [nome, v] of Object.entries(m)) if (!out[nome]) out[nome] = { ...v };
    return out;
  });

  // PATCH /api/sessions/{s}/settings — edição parcial das configurações.
  //
  // Separado do PUT /config porque faz MERGE (mexer no webhook não apaga
  // ignore.groups) e porque cobre campos que não vivem no config JSONB —
  // `label` e `auto-start` são colunas.
  app.patch<{
    Params: { session: string };
    Body: {
      label?: string;
      shouldStart?: boolean;
      ignoreGroups?: boolean;
      ignoreStatus?: boolean;
      ignoreChannels?: boolean;
      ignoreBroadcast?: boolean;
      webhookUrl?: string | null;
      webhookEvents?: string[];
      webhookKey?: string;
      webhookHeaders?: Array<{ name: string; value: string }>;
      webhookRetries?: { attempts?: number; delaySeconds?: number; policy?: string };
    };
  }>('/api/sessions/:session/settings', async (req, reply) => {
    const b = req.body ?? {};

    // Validação antes de tocar no banco: uma URL inválida gravada aqui só falharia
    // depois, na hora de entregar a mensagem — e o operador não saberia por quê.
    if (b.webhookUrl) {
      try {
        const u = new URL(b.webhookUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return reply.code(400).send({ message: 'a URL do webhook deve começar com http ou https' });
        }
      } catch {
        return reply.code(400).send({ message: 'URL do webhook inválida' });
      }
    }
    if (b.label !== undefined) {
      const v = validateName(b.label);
      if (!v.ok) return reply.code(400).send({ message: v.error });
    }

    // Retries fora de faixa travariam a entrega: 0 tentativas descarta todo evento,
    // e um delay enorme com 15 tentativas prende o emissor por horas.
    if (b.webhookRetries) {
      const { attempts, delaySeconds } = b.webhookRetries;
      if (attempts !== undefined && (!Number.isInteger(attempts) || attempts < 1 || attempts > 60)) {
        return reply.code(400).send({ message: 'tentativas deve ser um inteiro entre 1 e 60' });
      }
      // Mínimo 1s, não 0: com intervalo zero as 60 tentativas viram rajada. Como
      // o emissor dispara todos os webhooks em paralelo e é chamado POR MENSAGEM,
      // um pico de inbound durante um deploy do destino saturaria os sockets de
      // saída e atrasaria o processamento das mensagens seguintes. O risco
      // operacional está nesta ponta da faixa, não no 300.
      if (
        delaySeconds !== undefined &&
        (!Number.isFinite(delaySeconds) || delaySeconds < 1 || delaySeconds > 300)
      ) {
        return reply.code(400).send({ message: 'o intervalo deve estar entre 1 e 300 segundos' });
      }
    }

    // Um header sem nome viraria entrada morta no objeto de headers.
    if (b.webhookHeaders) {
      if (!Array.isArray(b.webhookHeaders)) {
        return reply.code(400).send({ message: 'cabeçalhos deve ser uma lista' });
      }
      for (const h of b.webhookHeaders) {
        // Nome de header HTTP: token conforme RFC 7230. Um nome com espaço ou
        // dois-pontos geraria requisição inválida no destino.
        if (!h?.name || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(h.name)) {
          return reply.code(400).send({ message: `nome de cabeçalho inválido: ${h?.name ?? '(vazio)'}` });
        }
      }
    }

    const row = await sessions.patchSettings(req.params.session, b);
    if (!row) return reply.code(404).send({ message: 'sessao nao encontrada' });
    return sessions.describe(req.params.session);
  });

  // POST /api/sessions/{s}/test-webhook — dispara um evento inócuo ao destino.
  //
  // Roda NO SERVIDOR de propósito: a versão anterior fazia o fetch do navegador
  // e batia em CORS ("Failed to fetch"), que o operador leria como "o webhook
  // está quebrado" quando o problema era só a política de origem do browser.
  // Aqui a chamada sai do mesmo lugar de onde os webhooks reais saem — então o
  // resultado reflete a realidade.
  app.post<{ Params: { session: string } }>(
    '/api/sessions/:session/test-webhook',
    async (req, reply) => {
      const name = req.params.session;
      const row = await sessions.getSessionRow(name);
      if (!row) return reply.code(404).send({ message: 'sessao nao encontrada' });

      const wh = row.config?.webhooks?.[0];
      if (!wh?.url) return reply.code(422).send({ message: 'sessao sem webhook configurado' });

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // Os headers vêm do banco (valor real), não do painel (que recebe mascarado).
      for (const h of wh.customHeaders ?? []) {
        if (h?.name) headers[h.name] = h.value ?? '';
      }

      // ★ Guarda de SSRF ANTES de qualquer coisa, e com resposta PROPRIA.
      //
      // Esta rota e o pior vetor do gateway: ela devolve `body.slice(0,200)` do
      // destino, entao e um leitor de rede interna com feedback imediato. MEDIDO no
      // beta antes da correcao: com `webhookUrl=http://127.0.0.1:3000/health` ela
      // devolveu o corpo da resposta interna do proprio container.
      //
      // O veredito e checado aqui em vez de deixar o `fetchGuardado` lancar porque o
      // `catch` abaixo transforma qualquer excecao em `{ok:false, hint:'nao foi
      // possivel alcancar o destino'}` — o operador leria "rede fora do ar" quando a
      // verdade e "esta URL e proibida". Erro que mente e pior que erro cru.
      const veredito = await verificarUrl(wh.url);
      if (!veredito.ok) {
        return reply.code(422).send({
          ok: false,
          status: 0,
          url: wh.url,
          code: 'url_blocked',
          error: `URL bloqueada (${veredito.motivo}${veredito.detalhe ? `: ${veredito.detalhe}` : ''})`,
          hint: 'o gateway nao busca enderecos internos: use um host publico, ou ligue ALLOW_PRIVATE_FETCH=1 se o destino esta na sua rede interna de proposito',
        });
      }

      const started = Date.now();
      try {
        const res = await fetchGuardado(wh.url, {
          method: 'POST',
          headers,
          // session.status é inócuo: o consumidor só relê o status que já é o atual.
          body: JSON.stringify({
            event: 'session.status',
            session: name,
            payload: { name, status: row.status },
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const ms = Date.now() - started;
        const body = await res.text().catch(() => '');
        return {
          ok: res.ok,
          status: res.status,
          ms,
          url: wh.url,
          body: body.slice(0, 200),
          // Diagnóstico pronto: 401 aqui é quase sempre chave divergente.
          hint: res.status === 401
            ? 'o destino recusou a chave — confira se a chave do webhook e a do destino sao a mesma'
            : res.status === 404 ? 'a rota nao existe no destino'
            : res.status >= 500 ? 'o destino respondeu com erro interno'
            : undefined,
        };
      } catch (err) {
        const ms = Date.now() - started;
        const msg = (err as Error).message;
        return {
          ok: false,
          status: 0,
          ms,
          url: wh.url,
          error: msg,
          hint: /timeout|abort/i.test(msg)
            ? 'o destino nao respondeu em 15s'
            // `redirect: 'error'` faz parte da guarda de SSRF: sem ela, um host
            // publico que responde 302 para 169.254.169.254 contornaria a validacao.
            // O erro do undici para isso e opaco ("unexpected redirect"), entao
            // traduzimos — senao o operador procura problema de rede a esmo.
            : /redirect/i.test(msg)
            ? 'o destino respondeu com redirecionamento, que o gateway nao segue (protecao contra SSRF); aponte direto para a URL final'
            : 'nao foi possivel alcancar o destino (DNS, rede ou servico fora do ar)',
        };
      }
    },
  );

  // GET /api/sessions/{session} — status. Le por connectionState() do driver.
  app.get<{ Params: { session: string } }>('/api/sessions/:session', async (req, reply) => {
    const desc = await sessions.describe(req.params.session);
    if (!desc) return reply.code(404).send({ message: 'sessao nao encontrada' });
    return desc;
  });

  // PUT /api/sessions/{session} — atualiza config preservando o resto.
  // Usado por setIgnoreGroups e pela reaplicacao de webhook apos 422.
  app.put<{ Params: { session: string }; Body: { config?: SessionConfig } }>(
    '/api/sessions/:session',
    async (req, reply) => {
      const row = await sessions.updateConfig(req.params.session, req.body?.config ?? {});
      if (!row) return reply.code(404).send({ message: 'sessao nao encontrada' });
      return sessions.describe(req.params.session);
    },
  );

  // DELETE /api/sessions/{session} — apaga sessao e pareamento.
  app.delete<{ Params: { session: string } }>('/api/sessions/:session', async (req, reply) => {
    const row = await sessions.getSessionRow(req.params.session);
    if (!row) return reply.code(404).send({ message: 'sessao nao encontrada' });
    await sessions.remove(req.params.session);
    return reply.code(200).send({ success: true });
  });

  // POST /api/sessions/{session}/start e /restart.
  // O driver tenta /restart e cai para /start (waha.js:125-131), entao os dois existem.
  for (const path of ['/api/sessions/:session/start', '/api/sessions/:session/restart']) {
    app.post<{ Params: { session: string } }>(path, async (req, reply) => {
      const name = req.params.session;
      const row = await sessions.getSessionRow(name);
      if (!row) return reply.code(404).send({ message: 'sessao nao encontrada' });

      // Responde imediatamente: subir o socket leva segundos e o driver so quer
      // saber se o comando foi ACEITO (`accepted`, waha.js:123).
      const isRestart = path.endsWith('/restart');
      const action = isRestart ? sessions.restart(name) : sessions.start(name);
      action.catch((err) =>
        app.log.error({ session: name, err: err.message }, 'falha ao iniciar/reiniciar'),
      );
      return reply.code(200).send({ success: true });
    });
  }

  // POST /api/sessions/{session}/stop — para sem apagar o pareamento.
  app.post<{ Params: { session: string } }>('/api/sessions/:session/stop', async (req, reply) => {
    const row = await sessions.getSessionRow(req.params.session);
    if (!row) return reply.code(404).send({ message: 'sessao nao encontrada' });
    await sessions.stop(req.params.session, false);
    return reply.code(200).send({ success: true });
  });

  // GET /api/{session}/auth/qr — QR como PNG.
  // O driver manda Accept: application/json e espera { mimetype, data } com data =
  // base64 do PNG (waha.js:225-232). Com outro Accept devolvemos o PNG binario.
  app.get<{ Params: { session: string } }>('/api/:session/auth/qr', async (req, reply) => {
    const name = req.params.session;
    const live = sessions.getLive(name);
    if (!live) {
      const row = await sessions.getSessionRow(name);
      if (!row) return reply.code(404).send({ message: 'sessao nao encontrada' });
    }

    const base64 = sessions.getQrBase64(name);
    if (!base64) {
      // Sem QR disponivel: ou ja esta conectada, ou a sessao ainda esta subindo.
      const desc = await sessions.describe(name);
      return reply.code(422).send({
        message: 'QR nao disponivel',
        status: (desc as { status?: string } | null)?.status ?? 'UNKNOWN',
      });
    }

    const accept = req.headers.accept ?? '';
    if (accept.includes('application/json')) {
      // `issuedAt` / `ageMs`: o consumidor calcula a idade REAL do código em vez
      // de cronometrar por conta própria. O WhatsApp renova o QR a cada ~14s
      // (medido), num ritmo que não é previsível — quem cronometra sozinho acaba
      // reexibindo o mesmo código e parece travado.
      const issuedAt = sessions.qrIssuedAt(name);
      return reply.send({
        mimetype: 'image/png',
        data: base64,
        ...(issuedAt ? { issuedAt, ageMs: Date.now() - issuedAt } : {}),
      });
    }
    return reply.type('image/png').send(Buffer.from(base64, 'base64'));
  });
}
