// src/routes/contacts.ts
//
// check-exists, contacts e lids/{lid}. Os tres existem porque um consumidor precisa
// resolver IDENTIDADE antes de enviar ou de criar o contato:
//   - check-exists  -> o numero tem WhatsApp? Devolve o chatId real do destino
//   - lids/{lid}    -> traduz LID (id oculto) para telefone; sem isso o contato nasce
//                      com o id no lugar do numero e ninguem consegue responder
//   - contacts      -> nome do contato (pushname), best-effort

import type { FastifyInstance } from 'fastify';
import type { SessionManager } from '../core/session-manager.js';
import { toWahaChatId } from '../core/waha-compat.js';

interface Deps {
  sessions: SessionManager;
}

export function registerContactRoutes(app: FastifyInstance, { sessions }: Deps): void {
  // GET /api/contacts/check-exists?phone=...&session=...
  // Resposta do WAHA: { numberExists: boolean, chatId?: string }.
  // O driver usa o chatId retornado como destino de envio — no GOWS alguns contatos
  // existem so como @lid e o JID de telefone NAO entrega (ver docs/INTEGRACAO.md).
  app.get<{ Querystring: { phone?: string; session?: string } }>(
    '/api/contacts/check-exists',
    async (req, reply) => {
      const session = req.query.session?.trim();
      const phone = (req.query.phone ?? '').replace(/\D/g, '');
      if (!session) return reply.code(400).send({ message: 'session e obrigatorio' });
      if (!phone) return reply.code(400).send({ message: 'phone e obrigatorio' });

      let sock;
      try {
        sock = sessions.requireSocket(session);
      } catch {
        return reply.code(422).send({ message: 'sessao nao conectada' });
      }

      // onWhatsApp devolve [{ exists, jid }]. O jid retornado e a fonte da
      // verdade do destino: e ele que o driver usa para enviar.
      const results = await sock.onWhatsApp(phone).catch(() => undefined);
      const hit = results?.[0];

      if (!hit?.exists) {
        return reply.send({ numberExists: false });
      }

      // O LID nao vem mais no retorno do onWhatsApp (Baileys 7.x o tirou dali);
      // agora vive no store dedicado `signalRepository.lidMapping`, que e uma
      // fonte MELHOR — ja esta persistido e resolve mesmo sem consultar a rede.
      // Informativo, so para depuracao: se falhar, o endpoint segue valido.
      const lid = await sock.signalRepository?.lidMapping
        ?.getLIDForPN(hit.jid)
        .catch(() => null);

      return reply.send({
        numberExists: true,
        chatId: toWahaChatId(hit.jid),
        ...(lid ? { lid } : {}),
      });
    },
  );

  // GET /api/contacts?contactId=...&session=...
  // O driver tenta este endpoint como fallback WEBJS de resolucao de LID e para
  // pegar o nome (ver docs/INTEGRACAO.md). Ele le id/_serialized, verifiedName, name, pushname.
  app.get<{ Querystring: { contactId?: string; session?: string } }>(
    '/api/contacts',
    async (req, reply) => {
      const session = req.query.session?.trim();
      const contactId = req.query.contactId?.trim();
      if (!session) return reply.code(400).send({ message: 'session e obrigatorio' });
      if (!contactId) return reply.code(400).send({ message: 'contactId e obrigatorio' });

      // Se for LID conhecido, resolvemos para o telefone: e o que o fallback espera.
      if (contactId.endsWith('@lid')) {
        const resolved = await sessions.resolveLid(session, contactId);
        if (resolved) {
          return reply.send({
            id: { _serialized: `${resolved.phone}@c.us`, user: resolved.phone },
            pushname: resolved.pushName,
            name: resolved.pushName,
          });
        }
        return reply.code(404).send({ message: 'contato nao encontrado' });
      }

      const phone = (contactId.split('@')[0] ?? '').replace(/\D/g, '');
      const lookup = await sessions.resolveLid(session, contactId).catch(() => null);
      return reply.send({
        id: { _serialized: `${phone}@c.us`, user: phone },
        pushname: lookup?.pushName ?? null,
        name: lookup?.pushName ?? null,
      });
    },
  );

  // GET /api/{session}/lids/{lid} -> { lid, pn: "<numero>@c.us" }
  // Shape exato lido pelo driver (ver docs/INTEGRACAO.md): campo `pn`.
  app.get<{ Params: { session: string; lid: string } }>(
    '/api/:session/lids/:lid',
    async (req, reply) => {
      const { session, lid } = req.params;
      // Mapa primeiro; se nao conhecer, tenta resolver pelo socket na hora. Sem o
      // fallback ao vivo, um LID nunca visto antes ficaria eternamente sem telefone
      // e o contato nasceria com o id oculto no lugar do numero.
      const resolved =
        (await sessions.resolveLid(session, lid)) ??
        (await sessions.resolveLidLive(session, lid));
      if (!resolved) {
        // 404 e o sinal para o driver tentar o fallback /contacts.
        return reply.code(404).send({ message: 'lid nao mapeado' });
      }
      return reply.send({ lid, pn: `${resolved.phone}@c.us` });
    },
  );

  // GET /api/contacts/profile-picture?contactId=...&session=...
  // Foto de perfil do contato. Equivalente ao chat/fetchProfilePictureUrl da
  // Evolution. Devolve { profilePictureURL } — a URL e do CDN do WhatsApp e EXPIRA,
  // entao quem consome deve baixar o arquivo, nao guardar o link.
  app.get<{ Querystring: { contactId?: string; session?: string } }>(
    '/api/contacts/profile-picture',
    async (req, reply) => {
      const session = req.query.session?.trim();
      const contactId = req.query.contactId?.trim();
      if (!session) return reply.code(400).send({ message: 'session e obrigatorio' });
      if (!contactId) return reply.code(400).send({ message: 'contactId e obrigatorio' });

      const url = await sessions.profilePictureUrl(session, contactId);
      // 200 com null (nao 404): "sem foto" e resposta normal — o contato pode nao ter
      // foto ou ter restringido por privacidade. 404 faria o consumidor tratar como erro.
      return reply.send({ profilePictureURL: url });
    },
  );
}
