// src/openapi.ts
//
// Especificação OpenAPI 3.1 da API, servida em GET /openapi.json e renderizada em
// GET /docs.
//
// ── Por que a spec vive no código, e não num YAML solto ────────────────────
// Um YAML separado desatualiza em silêncio: alguém adiciona um endpoint, esquece o
// arquivo, e a documentação passa a mentir. Aqui a spec é código TypeScript, e há
// um teste que compara os caminhos declarados com as rotas REGISTRADAS no Fastify
// (tests/openapi.test.ts) — endpoint novo sem documentação quebra o CI.
//
// ── Por que o CONTEÚDO está em inglês ──────────────────────────────────────
// Os comentários deste arquivo são para quem MANTÉM o gateway (português, como o
// resto do código). As descrições dentro da spec são para quem INTEGRA — e um
// projeto open-source só é utilizável por quem lê o idioma da documentação.
// Inglês na spec amplia quem consegue usar; os comentários seguem em português
// porque o público deles é outro.

export function buildOpenApi(version: string): Record<string, unknown> {
  // Componentes reutilizados. Declarar uma vez evita a spec divergir de si mesma.
  const chatId = {
    type: 'string',
    description:
      'Recipient as `<phone>@c.us` (country code included, digits only — no `+`, no ' +
      'spaces). Group: `<id>@g.us`. Channel: `<id>@newsletter`.',
    examples: ['5511999999999@c.us'],
  };
  const sessionName = {
    type: 'string',
    description: 'Technical session id — the `name` field returned when the session was created.',
    examples: ['support'],
  };
  const file = {
    type: 'object',
    description:
      'File by URL or base64. `url` is downloaded by the gateway (64MB cap); `data` ' +
      'accepts raw base64 or a data URL.',
    properties: {
      url: { type: 'string', examples: ['https://example.com/photo.jpg'] },
      data: { type: 'string', description: 'base64, or data:<mime>;base64,…' },
      mimetype: { type: 'string', examples: ['image/jpeg'] },
      filename: { type: 'string', examples: ['quote.pdf'] },
    },
  };
  const enviado = {
    description: 'Message accepted by WhatsApp.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: {
              type: 'string',
              description:
                'Serialized id `<fromMe>_<chatId>_<rawId>`. **Keep it** — this is how you ' +
                'match the delivery ACK that arrives later on your webhook.',
              examples: ['true_5511999999999@c.us_3EB0AF79BCE4EB'],
            },
            to: { type: 'string' },
            timestamp: { type: 'integer', description: 'Unix seconds.' },
          },
        },
      },
    },
  };
  const erro = (desc: string) => ({
    description: desc,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
      },
    },
  });
  const naoConectada = erro(
    'Session is not connected. The body states the current status — see GET /api/sessions.',
  );

  /** Endpoint de envio de mídia (os 5 seguem o mesmo formato). */
  const envioMidia = (nome: string, resumo: string, extras: Record<string, unknown> = {}) => ({
    post: {
      tags: ['Send'],
      summary: resumo,
      operationId: nome,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['session', 'chatId'],
              properties: {
                session: sessionName,
                chatId,
                file,
                files: {
                  type: 'array',
                  description:
                    'Several files in one call (alternative to `file`). Sent serially, so ' +
                    'order is preserved. Each item accepts its own `caption`.',
                  items: file,
                },
                caption: { type: 'string', description: 'Caption.' },
                album: {
                  type: 'boolean',
                  description: 'Groups images/videos into a single bubble.',
                },
                reply_to: {
                  type: 'string',
                  description: 'Id of the quoted message (the `id` a previous send returned).',
                },
                ...extras,
              },
            },
          },
        },
      },
      responses: {
        200: enviado,
        400: erro('Invalid input (missing file, malformed base64, and so on).'),
        413: erro('File above the size limit.'),
        422: naoConectada,
      },
    },
  });

  return {
    openapi: '3.1.0',
    info: {
      title: 'ELO — WhatsApp Gateway API',
      version,
      description:
        'Self-hosted WhatsApp gateway.\n\n' +
        '**Authentication:** every route requires the `X-Api-Key` header, except ' +
        '`/health`, `/docs`, `/openapi.json`, the web panel and `/api/files/*`.\n\n' +
        '**Getting started:** create a session, scan the QR code, then send and receive. ' +
        'Incoming messages are delivered to the webhook URL you configure on the session.\n\n' +
        '**Warning:** this gateway uses an unofficial WhatsApp library. It is not approved ' +
        'or supported by WhatsApp/Meta, and numbers can be banned — especially new numbers ' +
        'or high volume to contacts who never interacted. Do not use it for bulk messaging ' +
        'or spam.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: '/', description: 'This gateway' }],
    tags: [
      { name: 'Sessions', description: 'Connect numbers, QR code, status and configuration.' },
      { name: 'Send', description: 'Text, media, reactions.' },
      { name: 'Messages', description: 'Act on a message already sent.' },
      { name: 'Presence', description: 'Typing indicator, online state, mark as read.' },
      { name: 'Contacts', description: 'Check a number, resolve hidden ids.' },
      {
        name: 'Groups',
        description:
          'Create groups, manage participants, subject, description, settings and invites. ' +
          'Most write operations require the connected number to be a group ADMIN — WhatsApp ' +
          'rejects them otherwise, and the gateway returns 403 with `code: group_not_admin`.',
      },
      { name: 'Operations', description: 'Health, metrics, backup, live diagnostics.' },
    ],
    components: {
      securitySchemes: {
        ApiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      },
      schemas: {
        // Shape estavel de grupo. Deliberadamente NAO espelha o objeto do Baileys:
        // `announce`/`restrict` e `admin: 'admin'|'superadmin'|null` obrigariam quem
        // consome a conhecer o vocabulario interno da biblioteca.
        Group: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Bare group id — send this back in calls.' },
            jid: { type: 'string', description: 'Full JID, for consumers that prefer it.' },
            subject: { type: 'string', nullable: true },
            description: { type: 'string', nullable: true },
            owner: { type: 'string', nullable: true },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
            size: { type: 'integer', description: 'Taken from the participant list.' },
            onlyAdminsCanPost: { type: 'boolean' },
            onlyAdminsCanEdit: { type: 'boolean' },
            isCommunity: { type: 'boolean' },
            participants: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  jid: { type: 'string' },
                  isAdmin: { type: 'boolean' },
                  isSuperAdmin: { type: 'boolean' },
                },
              },
            },
          },
        },
        Session: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Technical id — use this in API calls.' },
            label: { type: 'string', description: 'Free-form name chosen by the operator.' },
            status: {
              type: 'string',
              description:
                'WORKING = connected. SCAN_QR_CODE = needs pairing. FAILED = dropped ' +
                '(reconnects on its own when the pairing is still valid).',
              enum: ['STOPPED', 'STARTING', 'SCAN_QR_CODE', 'WORKING', 'FAILED'],
            },
            me: {
              type: ['object', 'null'],
              description: 'Paired number. `null` means a QR scan is required.',
              properties: { id: { type: 'string' }, pushName: { type: ['string', 'null'] } },
            },
            engine: { type: 'object', properties: { engine: { type: 'string' } } },
            shouldStart: {
              type: 'boolean',
              description: 'Whether the session starts automatically with the service.',
            },
            hasQr: { type: 'boolean', description: 'A QR code is available right now.' },
            reconnectAttempts: { type: 'integer' },
          },
        },
      },
    },
    security: [{ ApiKey: [] }],
    paths: {
      // ── Sessões ──────────────────────────────────────────────────────────
      '/api/sessions': {
        get: {
          tags: ['Sessions'],
          summary: 'List sessions',
          description: 'Secrets come back masked (`••••••••`).',
          operationId: 'listSessions',
          responses: {
            200: {
              description: 'The sessions.',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/Session' } },
                },
              },
            },
          },
        },
        post: {
          tags: ['Sessions'],
          summary: 'Create (and start) a session',
          description:
            '`name` is free-form: spaces, accents, uppercase and emoji are all fine. The ' +
            'gateway derives a safe technical id and returns both — **use the `name` from ' +
            'the response** in every other call.',
          operationId: 'createSession',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', examples: ['Support'] },
                    start: { type: 'boolean', default: true },
                    config: {
                      type: 'object',
                      properties: {
                        webhooks: {
                          type: 'array',
                          description: 'Where incoming events are delivered.',
                          items: {
                            type: 'object',
                            properties: {
                              url: { type: 'string' },
                              events: {
                                type: 'array',
                                items: {
                                  type: 'string',
                                  enum: [
                                    'message',
                                    'message.ack',
                                    'session.status',
                                    'presence.update',
                                  ],
                                },
                              },
                              customHeaders: {
                                type: 'array',
                                description:
                                  'Sent with every webhook call. Use it to authenticate the ' +
                                  'gateway on your side.',
                                items: {
                                  type: 'object',
                                  properties: {
                                    name: { type: 'string' },
                                    value: { type: 'string' },
                                  },
                                },
                              },
                              retries: {
                                type: 'object',
                                description:
                                  'Retry policy. 4xx responses are NOT retried — a contract ' +
                                  'error would only queue garbage.',
                                properties: {
                                  attempts: { type: 'integer', minimum: 1, maximum: 60 },
                                  delaySeconds: { type: 'integer', minimum: 1, maximum: 300 },
                                },
                              },
                            },
                          },
                        },
                        ignore: {
                          type: 'object',
                          description: 'Chat types NOT to forward to your webhook.',
                          properties: {
                            groups: { type: 'boolean' },
                            status: {
                              type: 'boolean',
                              default: true,
                              description: 'Stories. Ignored by default.',
                            },
                            channels: { type: 'boolean' },
                            broadcast: { type: 'boolean' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'Created.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Session' } },
              },
            },
            400: erro('Invalid name.'),
            422: erro('Session already exists (harmless — reapply the config via PUT).'),
          },
        },
      },
      '/api/sessions/{session}': {
        parameters: [{ name: 'session', in: 'path', required: true, schema: sessionName }],
        get: {
          tags: ['Sessions'],
          summary: 'Session state',
          operationId: 'getSession',
          responses: {
            200: {
              description: 'Current state.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' } } },
            },
            404: erro('Not found.'),
          },
        },
        put: {
          tags: ['Sessions'],
          summary: 'Replace the config',
          description:
            'Replaces the whole object. For partial edits use PATCH /settings — it merges, ' +
            'so touching the webhook will not wipe your chat filters.',
          operationId: 'replaceConfig',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: { 200: { description: 'Updated.' }, 404: erro('Not found.') },
        },
        delete: {
          tags: ['Sessions'],
          summary: 'Delete the session and its pairing',
          description: 'Irreversible: a new QR scan will be required.',
          operationId: 'deleteSession',
          responses: { 200: { description: 'Deleted.' }, 404: erro('Not found.') },
        },
      },
      '/api/sessions/{session}/settings': {
        parameters: [{ name: 'session', in: 'path', required: true, schema: sessionName }],
        patch: {
          tags: ['Sessions'],
          summary: 'Edit configuration (merge)',
          description:
            'Only the fields you send change. The webhook key never comes back in clear ' +
            'text; sending the masked value back preserves the original.',
          operationId: 'updateSettings',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'Display name (the technical id never changes).' },
                    shouldStart: { type: 'boolean' },
                    ignoreGroups: { type: 'boolean' },
                    ignoreStatus: { type: 'boolean' },
                    ignoreChannels: { type: 'boolean' },
                    ignoreBroadcast: { type: 'boolean' },
                    webhookUrl: {
                      type: ['string', 'null'],
                      description: 'Empty or null removes forwarding.',
                    },
                    webhookEvents: { type: 'array', items: { type: 'string' } },
                    webhookKey: { type: 'string' },
                    webhookHeaders: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { name: { type: 'string' }, value: { type: 'string' } },
                      },
                    },
                    webhookRetries: {
                      type: 'object',
                      properties: {
                        attempts: { type: 'integer', minimum: 1, maximum: 60 },
                        delaySeconds: { type: 'integer', minimum: 1, maximum: 300 },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Updated.' },
            400: erro('Value out of range, or invalid URL.'),
            404: erro('Not found.'),
          },
        },
      },
      '/api/sessions/{session}/start': {
        parameters: [{ name: 'session', in: 'path', required: true, schema: sessionName }],
        post: {
          tags: ['Sessions'],
          summary: 'Start the session',
          description: 'Returns as soon as the command is accepted — connecting takes seconds.',
          operationId: 'startSession',
          responses: { 200: { description: 'Accepted.' }, 404: erro('Not found.') },
        },
      },
      '/api/sessions/{session}/restart': {
        parameters: [{ name: 'session', in: 'path', required: true, schema: sessionName }],
        post: {
          tags: ['Sessions'],
          summary: 'Restart (keeps the pairing)',
          operationId: 'restartSession',
          responses: { 200: { description: 'Accepted.' }, 404: erro('Not found.') },
        },
      },
      '/api/sessions/{session}/stop': {
        parameters: [{ name: 'session', in: 'path', required: true, schema: sessionName }],
        post: {
          tags: ['Sessions'],
          summary: 'Stop (without deleting the pairing)',
          operationId: 'stopSession',
          responses: { 200: { description: 'Stopped.' }, 404: erro('Not found.') },
        },
      },
      '/api/sessions/{session}/test-webhook': {
        parameters: [{ name: 'session', in: 'path', required: true, schema: sessionName }],
        post: {
          tags: ['Sessions'],
          summary: 'Test the configured webhook',
          description:
            'Fires a harmless event at your endpoint and reports the real result — status, ' +
            'latency, and a hint when it fails. It runs server-side, so it reflects what ' +
            'actually happens during delivery. Worth doing before you rely on the channel.',
          operationId: 'testWebhook',
          responses: {
            200: {
              description: 'Test result (a failure also returns 200, with `ok: false`).',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      status: { type: 'integer' },
                      ms: { type: 'integer' },
                      hint: { type: 'string' },
                    },
                  },
                },
              },
            },
            422: erro('Session has no webhook configured.'),
          },
        },
      },
      '/api/{session}/auth/qr': {
        parameters: [{ name: 'session', in: 'path', required: true, schema: sessionName }],
        get: {
          tags: ['Sessions'],
          summary: 'QR code for pairing',
          description:
            'With `Accept: application/json` you get `{ mimetype, data }` (base64 PNG) plus ' +
            '`issuedAt`/`ageMs` — use those to know the code\'s real age, since WhatsApp ' +
            'rotates it on its own schedule. Without the header, the raw PNG is returned.',
          operationId: 'getQrCode',
          responses: {
            200: { description: 'QR code available.' },
            404: erro('Session not found.'),
            422: erro('No QR available (already connected, or still starting up).'),
          },
        },
      },

      // ── Enviar ───────────────────────────────────────────────────────────
      '/api/sendText': {
        post: {
          tags: ['Send'],
          summary: 'Send a text message',
          operationId: 'sendText',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session', 'chatId', 'text'],
                  properties: {
                    session: sessionName,
                    chatId,
                    text: { type: 'string', minLength: 1 },
                    reply_to: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            200: enviado,
            400: erro('Empty text or missing field.'),
            422: naoConectada,
          },
        },
      },
      '/api/sendImage': envioMidia('sendImage', 'Send an image'),
      '/api/sendVideo': envioMidia('sendVideo', 'Send a video'),
      '/api/sendFile': envioMidia('sendFile', 'Send a document or attachment'),
      '/api/sendSticker': envioMidia('sendSticker', 'Send a sticker (WEBP)'),
      '/api/sendVoice': envioMidia(
        'sendVoice',
        'Send audio as a voice note (PTT)',
        {},
      ),
      '/api/sendMedia': {
        post: {
          tags: ['Send'],
          summary: 'Send SEVERAL files in one call',
          description:
            'Files are sent serially, so the order you ask for is the order the contact ' +
            'sees. `album: true` groups images and videos into a single bubble.\n\n' +
            'If **any** file is invalid, nothing is sent and the response names the failing ' +
            'item — this avoids leaving half the batch delivered and the contact receiving ' +
            'duplicates on retry. Maximum 30 items.',
          operationId: 'sendMedia',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session', 'chatId', 'items'],
                  properties: {
                    session: sessionName,
                    chatId,
                    album: { type: 'boolean' },
                    caption: {
                      type: 'string',
                      description:
                        'Applied to the first item — that is how WhatsApp shows an album caption.',
                    },
                    reply_to: { type: 'string' },
                    items: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 30,
                      items: {
                        type: 'object',
                        required: ['file'],
                        properties: {
                          file,
                          caption: { type: 'string' },
                          asDocument: {
                            type: 'boolean',
                            description: 'Force an attachment even for an image.',
                          },
                          asVoice: { type: 'boolean', description: 'Force a voice note.' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Sent.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', description: 'Id of the first item.' },
                      count: { type: 'integer' },
                      album: { type: 'boolean' },
                      messages: {
                        type: 'array',
                        description: 'One id per item, in the order sent — match each ACK.',
                        items: { type: 'object', properties: { id: { type: 'string' } } },
                      },
                    },
                  },
                },
              },
            },
            400: erro('An item is invalid — nothing was sent. The message says which one.'),
            413: erro('Files exceed the aggregate size limit.'),
            422: naoConectada,
          },
        },
      },
      '/api/reaction': {
        post: {
          tags: ['Send'],
          summary: 'React to a message (or remove the reaction)',
          description: 'An empty `reaction` REMOVES it — that is how WhatsApp models un-reacting.',
          operationId: 'sendReaction',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session', 'messageId'],
                  properties: {
                    session: sessionName,
                    messageId: { type: 'string' },
                    chatId: { type: 'string', description: 'Required if the id is a raw id.' },
                    reaction: { type: 'string', examples: ['👍'] },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Applied.' }, 400: erro('Invalid id.') },
        },
      },

      // ── Mensagens ────────────────────────────────────────────────────────
      '/api/editMessage': {
        post: {
          tags: ['Messages'],
          summary: 'Edit the text of a sent message',
          description:
            'WhatsApp limits: your own messages only, text/caption only (media cannot be ' +
            'swapped), and roughly 15 minutes. Past the window the server ignores the edit ' +
            'without returning an error.',
          operationId: 'editMessage',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session', 'messageId', 'text'],
                  properties: {
                    session: sessionName,
                    messageId: {
                      type: 'string',
                      description: 'Serialized id, or a raw id together with `chatId`.',
                    },
                    chatId: { type: 'string' },
                    text: { type: 'string', minLength: 1 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Edited.' },
            400: erro('Empty text (use /api/deleteMessage to remove) or invalid id.'),
          },
        },
      },
      '/api/deleteMessage': {
        post: {
          tags: ['Messages'],
          summary: 'Delete for everyone (revoke)',
          description:
            'This also has a time window, and WhatsApp does NOT signal when it has expired — ' +
            'which is why the response says the message *may* remain on the contact\'s device ' +
            'instead of claiming success.',
          operationId: 'deleteMessage',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session', 'messageId'],
                  properties: {
                    session: sessionName,
                    messageId: { type: 'string' },
                    chatId: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Command accepted.' }, 400: erro('Invalid id.') },
        },
      },
      '/api/forwardMessage': {
        post: {
          tags: ['Messages'],
          summary: 'Forward to another chat',
          description:
            'Forwarding needs the message CONTENT, not just its id. Either pass `message` ' +
            '(works for any message, including ones you received) or a `messageId` of a ' +
            'message this gateway sent and still holds within its retention window.',
          operationId: 'forwardMessage',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session', 'to'],
                  properties: {
                    session: sessionName,
                    to: chatId,
                    messageId: { type: 'string' },
                    message: { type: 'object', description: 'Raw message content.' },
                    force: {
                      type: 'boolean',
                      default: true,
                      description: 'Show the "forwarded" label.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: enviado,
            400: erro('Missing destination or content.'),
            404: erro('Content not found — pass `message` instead.'),
          },
        },
      },
      '/api/resendMessage': {
        post: {
          tags: ['Messages'],
          summary: 'Resend in the same chat',
          description:
            'For delivery failures (ack -1). Creates a new message with a new id — WhatsApp ' +
            'has no retry for an already-emitted message.',
          operationId: 'resendMessage',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session', 'messageId'],
                  properties: {
                    session: sessionName,
                    messageId: { type: 'string' },
                    to: { type: 'string', description: 'Another chat (defaults to the original).' },
                  },
                },
              },
            },
          },
          responses: { 200: enviado, 404: erro('Content not stored.') },
        },
      },

      // ── Presença ─────────────────────────────────────────────────────────
      '/api/typing': {
        post: {
          tags: ['Presence'],
          summary: 'Typing / recording indicator',
          description:
            'WhatsApp expires the indicator after about 10 seconds. With `duration` the ' +
            'gateway refreshes it in the background and the request returns immediately — ' +
            'useful while your bot composes a long answer.',
          operationId: 'setTyping',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session', 'chatId'],
                  properties: {
                    session: sessionName,
                    chatId,
                    typing: {
                      type: 'boolean',
                      default: true,
                      description: '`false` clears the indicator.',
                    },
                    kind: {
                      type: 'string',
                      enum: ['composing', 'recording'],
                      description: '`composing` for text, `recording` for audio.',
                    },
                    duration: {
                      type: 'integer',
                      maximum: 60000,
                      description: 'Keep it alive for N milliseconds (max 60s).',
                    },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Applied.' }, 422: naoConectada },
        },
      },
      '/api/presence': {
        post: {
          tags: ['Presence'],
          summary: 'Online/offline (account) or per-chat state',
          description:
            '`available` and `unavailable` apply to the whole account. The other three are ' +
            'per-conversation and require `chatId`.\n\n' +
            'Staying `unavailable` lets WhatsApp keep notifying the operator\'s phone — ' +
            'going online steals those notifications.',
          operationId: 'setPresence',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session', 'presence'],
                  properties: {
                    session: sessionName,
                    chatId: { type: 'string' },
                    presence: {
                      type: 'string',
                      enum: ['available', 'unavailable', 'composing', 'recording', 'paused'],
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Applied.' },
            400: erro('Invalid state, or a per-chat state without chatId.'),
          },
        },
      },
      '/api/markAsRead': {
        post: {
          tags: ['Presence'],
          summary: 'Mark as read (blue ticks)',
          operationId: 'markAsRead',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session', 'chatId'],
                  properties: {
                    session: sessionName,
                    chatId,
                    messageIds: {
                      type: 'array',
                      maxItems: 500,
                      description: 'Several ids in one call.',
                      items: { type: 'string' },
                    },
                    messageId: { type: 'string', description: 'Single id (alternative).' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Marked.' },
            400: erro('Empty list, or more than 500 ids.'),
          },
        },
      },
      '/api/presence/{chatId}': {
        parameters: [
          { name: 'chatId', in: 'path', required: true, schema: chatId },
          { name: 'session', in: 'query', required: true, schema: sessionName },
        ],
        get: {
          tags: ['Presence'],
          summary: 'Contact\'s last seen / online state',
          description:
            'Depends on the contact\'s privacy settings: if they restrict last-seen, WhatsApp ' +
            'simply does not send it (and it is reciprocal — hiding yours also hides theirs ' +
            'from you). In that case you get `available: false` with an explanation, rather ' +
            'than an ambiguous empty response.\n\n' +
            'This call also subscribes to the contact, so subsequent updates arrive as ' +
            '`presence.update` webhook events.',
          operationId: 'getPresence',
          responses: { 200: { description: 'Known state, or an explanation.' } },
        },
      },

      // ── Contatos ─────────────────────────────────────────────────────────
      '/api/contacts/check-exists': {
        parameters: [
          {
            name: 'phone',
            in: 'query',
            required: true,
            schema: { type: 'string', examples: ['5511999999999'] },
          },
          { name: 'session', in: 'query', required: true, schema: sessionName },
        ],
        get: {
          tags: ['Contacts'],
          summary: 'Does this number have WhatsApp?',
          description:
            'Check this BEFORE sending to a new number. Without it, a wrong number produces ' +
            'a send that WhatsApp accepts and never delivers — and you would blame the ' +
            'channel instead of the number.',
          operationId: 'checkNumberExists',
          responses: {
            200: {
              description: 'Result.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      numberExists: { type: 'boolean' },
                      chatId: {
                        type: 'string',
                        description: 'Use this as the send destination.',
                      },
                    },
                  },
                },
              },
            },
            400: erro('Missing phone or session.'),
            422: naoConectada,
          },
        },
      },
      '/api/contacts': {
        parameters: [
          { name: 'contactId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'session', in: 'query', required: true, schema: sessionName },
        ],
        get: {
          tags: ['Contacts'],
          summary: 'Contact details (name, id)',
          operationId: 'getContact',
          responses: { 200: { description: 'The contact.' }, 400: erro('Missing parameter.') },
        },
      },
      '/api/contacts/profile-picture': {
        parameters: [
          { name: 'contactId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'session', in: 'query', required: true, schema: sessionName },
        ],
        get: {
          tags: ['Contacts'],
          summary: 'Profile picture',
          operationId: 'getProfilePicture',
          responses: { 200: { description: 'Picture URL, or null.' } },
        },
      },
      '/api/{session}/lids/{lid}': {
        parameters: [
          { name: 'session', in: 'path', required: true, schema: sessionName },
          { name: 'lid', in: 'path', required: true, schema: { type: 'string' } },
        ],
        get: {
          tags: ['Contacts'],
          summary: 'Resolve a hidden id (@lid) to a phone number',
          description:
            'WhatsApp increasingly addresses contacts by a hidden id (LID) that is NOT the ' +
            'phone number. If it leaks into your system as a number, the contact is created ' +
            'with an invalid 14-15 digit "phone", no name, and every reply opens a new ' +
            'conversation. Resolve it here.',
          operationId: 'resolveLid',
          responses: { 200: { description: 'Phone number.' }, 404: erro('Unknown LID.') },
        },
      },

      // ── Grupos ───────────────────────────────────────────────────────────
      //
      // `groupId` accepts both the bare id ("120363...") and the full JID
      // ("120363...@g.us"): consumers store one or the other depending on the provider
      // they came from, and demanding a single form is friction with no upside.
      '/api/groups': {
        get: {
          tags: ['Groups'],
          summary: 'List the groups this number belongs to',
          description:
            'One call to WhatsApp returns every group with its metadata. There is no ' +
            'pagination — the protocol delivers the whole set at once. Sorted by subject so ' +
            'the list is stable between calls (WhatsApp does not guarantee order).',
          operationId: 'listGroups',
          parameters: [{ name: 'session', in: 'query', required: true, schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'Groups.',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/Group' } },
                },
              },
            },
            422: naoConectada,
          },
        },
        post: {
          tags: ['Groups'],
          summary: 'Create a group',
          description:
            'WhatsApp requires at least one participant besides the connected number — ' +
            'there is no such thing as an empty group in the protocol.',
          operationId: 'createGroup',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session', 'subject', 'participants'],
                  properties: {
                    session: sessionName,
                    subject: { type: 'string', maxLength: 100 },
                    participants: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 100,
                      items: { type: 'string' },
                      description: 'Phone numbers or JIDs.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'Created.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Group' } },
              },
            },
            400: erro('Missing subject, or an empty participant list.'),
            422: naoConectada,
          },
        },
      },

      '/api/groups/{groupId}': {
        parameters: [{ name: 'groupId', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          tags: ['Groups'],
          summary: 'Group metadata and participants',
          operationId: 'getGroup',
          parameters: [{ name: 'session', in: 'query', required: true, schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'Group.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Group' } },
              },
            },
            400: erro('groupId points at a contact (@c.us/@lid), or is not a group id.'),
            404: erro('Group not found, or this number is not a member.'),
            422: naoConectada,
          },
        },
      },

      '/api/groups/{groupId}/participants': {
        parameters: [{ name: 'groupId', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          tags: ['Groups'],
          summary: 'Add, remove, promote or demote participants',
          description:
            'One route for the four actions because in the protocol it is the SAME ' +
            'operation with a different field.\n\n' +
            '**The response is per participant.** WhatsApp accepts partially — 3 of 5 in the ' +
            'same call — so an aggregate "ok" would hide the failures, and the operator would ' +
            'see a group missing people with no explanation.',
          operationId: 'updateGroupParticipants',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session', 'action', 'participants'],
                  properties: {
                    session: sessionName,
                    action: { type: 'string', enum: ['add', 'remove', 'promote', 'demote'] },
                    participants: {
                      type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Result per participant.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      action: { type: 'string' },
                      requested: { type: 'integer' },
                      succeeded: { type: 'integer' },
                      failed: { type: 'integer' },
                      results: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            jid: { type: 'string' },
                            status: { type: 'string', description: 'Raw WhatsApp status.' },
                            ok: { type: 'boolean' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            400: erro('Invalid action, or more than 100 participants.'),
            403: erro('The connected number must be a group ADMIN (`code: group_not_admin`).'),
            422: naoConectada,
          },
        },
      },

      '/api/groups/{groupId}/subject': {
        parameters: [{ name: 'groupId', in: 'path', required: true, schema: { type: 'string' } }],
        put: {
          tags: ['Groups'],
          summary: 'Rename the group',
          operationId: 'setGroupSubject',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session', 'subject'],
                  properties: { session: sessionName, subject: { type: 'string', maxLength: 100 } },
                },
              },
            },
          },
          responses: {
            200: { description: 'Renamed.' },
            400: erro('Missing subject, or longer than 100 characters.'),
            403: erro('Admin required (`code: group_not_admin`).'),
            422: naoConectada,
          },
        },
      },

      '/api/groups/{groupId}/description': {
        parameters: [{ name: 'groupId', in: 'path', required: true, schema: { type: 'string' } }],
        put: {
          tags: ['Groups'],
          summary: 'Set or clear the group description',
          description:
            'An empty or absent `description` CLEARS it. Documented because it is not ' +
            'obvious — the intuitive behaviour would be a 400.',
          operationId: 'setGroupDescription',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session'],
                  properties: {
                    session: sessionName,
                    description: { type: 'string', maxLength: 2048, nullable: true },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Applied.' },
            403: erro('Admin required (`code: group_not_admin`).'),
            422: naoConectada,
          },
        },
      },

      '/api/groups/{groupId}/settings': {
        parameters: [{ name: 'groupId', in: 'path', required: true, schema: { type: 'string' } }],
        put: {
          tags: ['Groups'],
          summary: 'Who can post, edit, add members; join approval',
          description:
            'Fields are named by intent instead of WhatsApp\'s internal vocabulary ' +
            '(`announcement`/`locked`), which tells a first-time reader nothing. Send only ' +
            'the switches you want to change.',
          operationId: 'setGroupSettings',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session'],
                  properties: {
                    session: sessionName,
                    onlyAdminsCanPost: { type: 'boolean' },
                    onlyAdminsCanEdit: { type: 'boolean' },
                    whoCanAddMembers: { type: 'string', enum: ['admins', 'all'] },
                    joinApproval: { type: 'boolean' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Applied settings are echoed back.' },
            400: erro('No setting provided.'),
            403: erro('Admin required (`code: group_not_admin`).'),
            422: naoConectada,
          },
        },
      },

      '/api/groups/{groupId}/invite': {
        parameters: [{ name: 'groupId', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          tags: ['Groups'],
          summary: 'Invite code and link',
          operationId: 'getGroupInvite',
          parameters: [{ name: 'session', in: 'query', required: true, schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'Code and ready-to-share URL.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      groupId: { type: 'string' },
                      code: { type: 'string' },
                      url: { type: 'string' },
                    },
                  },
                },
              },
            },
            403: erro('Admin required (`code: group_not_admin`).'),
            422: naoConectada,
          },
        },
      },

      '/api/groups/{groupId}/invite/revoke': {
        parameters: [{ name: 'groupId', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          tags: ['Groups'],
          summary: 'Invalidate the current link and get the new one',
          description:
            'Returns the NEW code. Revoking without saying what replaced it would force a ' +
            'second call, and in that window the consumer would display a dead link.',
          operationId: 'revokeGroupInvite',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session'],
                  properties: { session: sessionName },
                },
              },
            },
          },
          responses: {
            200: { description: 'New code and URL.' },
            403: erro('Admin required (`code: group_not_admin`).'),
            422: naoConectada,
          },
        },
      },

      '/api/groups/join': {
        post: {
          tags: ['Groups'],
          summary: 'Join a group by invite code',
          description: 'Accepts the bare code or the full `chat.whatsapp.com` URL.',
          operationId: 'joinGroup',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session', 'code'],
                  properties: { session: sessionName, code: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            201: { description: 'Joined; returns the group id.' },
            400: erro('Invalid invite code.'),
            422: naoConectada,
          },
        },
      },

      '/api/groups/invite-info': {
        get: {
          tags: ['Groups'],
          summary: 'Inspect an invite WITHOUT joining',
          description:
            'Lets the consumer show "you are about to join group X, with N members" before ' +
            'confirming. Joining and then leaving would leave a trace in the group.',
          operationId: 'getGroupInviteInfo',
          parameters: [
            { name: 'session', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'Group behind the invite.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Group' } },
              },
            },
            400: erro('Missing code.'),
            422: naoConectada,
          },
        },
      },

      '/api/groups/{groupId}/leave': {
        parameters: [{ name: 'groupId', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          tags: ['Groups'],
          summary: 'Leave the group',
          description:
            'Leaving does NOT delete the group or the history on the consumer side — the ' +
            'gateway simply stops participating.',
          operationId: 'leaveGroup',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session'],
                  properties: { session: sessionName },
                },
              },
            },
          },
          responses: {
            200: { description: 'Left the group.' },
            404: erro('Group not found, or already not a member.'),
            422: naoConectada,
          },
        },
      },

      '/api/groups/{groupId}/join-requests': {
        parameters: [{ name: 'groupId', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          tags: ['Groups'],
          summary: 'Pending join requests (when approval is on)',
          operationId: 'listGroupJoinRequests',
          parameters: [{ name: 'session', in: 'query', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Pending requests.' },
            403: erro('Admin required (`code: group_not_admin`).'),
            422: naoConectada,
          },
        },
        post: {
          tags: ['Groups'],
          summary: 'Approve or reject join requests',
          description: 'Like participants, the response is per requester.',
          operationId: 'updateGroupJoinRequests',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['session', 'action', 'participants'],
                  properties: {
                    session: sessionName,
                    action: { type: 'string', enum: ['approve', 'reject'] },
                    participants: { type: 'array', minItems: 1, items: { type: 'string' } },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Result per requester.' },
            400: erro('Invalid action.'),
            403: erro('Admin required (`code: group_not_admin`).'),
            422: naoConectada,
          },
        },
      },

      // ── Operação ─────────────────────────────────────────────────────────
      '/health': {
        get: {
          tags: ['Operations'],
          summary: 'Health check (public)',
          description:
            'Validates the database, not just the process — a gateway that lost Postgres ' +
            'cannot restore sessions. Also returns version and build commit.',
          operationId: 'health',
          security: [],
          responses: { 200: { description: 'Healthy.' } },
        },
      },
      '/metrics': {
        get: {
          tags: ['Operations'],
          summary: 'Prometheus metrics',
          description:
            'Four signals worth alerting on:\n\n' +
            '- `elo_inbound_undecryptable_total` > 0 — losing messages right now\n' +
            '- `elo_webhook_lost_total` > 0 — an event never reached your system\n' +
            '- `elo_ack_failed_total` > 0 — a message left and was not delivered\n' +
            '- `elo_session_up` == 0 — session is down\n\n' +
            'Requires the API key: session names usually identify customers.',
          operationId: 'metrics',
          responses: { 200: { description: 'Text exposition format.' } },
        },
      },
      '/api/stats': {
        get: {
          tags: ['Operations'],
          summary: 'Per-session counters (JSON)',
          description: 'The same numbers as /metrics, in JSON — for setups without Prometheus.',
          operationId: 'stats',
          responses: { 200: { description: 'Counters.' } },
        },
      },
      '/api/events': {
        parameters: [
          {
            name: 'after',
            in: 'query',
            schema: { type: 'integer' },
            description: 'Resume from this sequence number.',
          },
        ],
        get: {
          tags: ['Operations'],
          summary: 'Live diagnostics (Server-Sent Events)',
          description:
            'Stream of what is happening: messages arriving, ACKs progressing, hidden ids ' +
            'resolved, webhooks rejected. This is what the web panel consumes.',
          operationId: 'events',
          responses: { 200: { description: 'text/event-stream.' } },
        },
      },
      '/api/backup': {
        get: {
          tags: ['Operations'],
          summary: 'Download the pairing backup',
          description:
            'The Postgres volume IS the pairing: losing it means scanning the QR code again ' +
            'on every session. This endpoint exports what cannot be recreated.\n\n' +
            '**The file contains WhatsApp keys.** Anyone holding it can impersonate the ' +
            'connected number — read and send messages. Store it like a password.',
          operationId: 'downloadBackup',
          responses: { 200: { description: 'JSON file.' } },
        },
      },
      '/api/backup/status': {
        get: {
          tags: ['Operations'],
          summary: 'Is there a backup? Is it current?',
          description:
            '`risk`: `none` (nothing to lose yet), `no_backup`, `stale` (the pairing changed ' +
            'after the last backup) or `ok`. Suitable for external monitoring.',
          operationId: 'backupStatus',
          responses: { 200: { description: 'Computed risk.' } },
        },
      },
      '/api/backup/restore': {
        post: {
          tags: ['Operations'],
          summary: 'Restore a backup',
          description:
            'DESTRUCTIVE: replaces the current pairing and restarts the sessions. Requires ' +
            '`confirm: true` alongside the dump.',
          operationId: 'restoreBackup',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['confirm', 'format', 'data'],
                  properties: {
                    confirm: { type: 'boolean', const: true },
                    format: { type: 'integer', const: 1 },
                    data: { type: 'object' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Restored.' },
            400: erro('Missing confirm, or unknown format.'),
          },
        },
      },
    },
  };
}
