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
// Escrita à mão em vez de gerada por decorators/plugin: o projeto não usa schema
// de validação do Fastify (a validação é explícita nos handlers, com mensagens em
// português para o operador). Um gerador produziria uma spec vazia de significado.

export function buildOpenApi(version: string): Record<string, unknown> {
  // Componentes reutilizados. Declarar uma vez evita a spec divergir de si mesma.
  const chatId = {
    type: 'string',
    description:
      'Destino no formato `<telefone>@c.us` (com país, sem + nem espaços). ' +
      'Grupo: `<id>@g.us`. Canal: `<id>@newsletter`.',
    examples: ['5511999999999@c.us'],
  };
  const sessionName = {
    type: 'string',
    description: 'Id técnico da sessão (o campo `name` que a criação devolveu).',
    examples: ['atendimento'],
  };
  const file = {
    type: 'object',
    description:
      'Arquivo por URL ou base64. `url` é baixada pelo gateway (teto de 64MB); ' +
      '`data` aceita base64 puro ou data URL.',
    properties: {
      url: { type: 'string', examples: ['https://exemplo.com/foto.jpg'] },
      data: { type: 'string', description: 'base64 ou data:<mime>;base64,…' },
      mimetype: { type: 'string', examples: ['image/jpeg'] },
      filename: { type: 'string', examples: ['orcamento.pdf'] },
    },
  };
  const enviado = {
    description: 'Mensagem aceita pelo WhatsApp.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: {
              type: 'string',
              description:
                'Id serializado `<fromMe>_<chatId>_<idCru>`. **Guarde-o**: é como ' +
                'você casa o ACK que chega depois no webhook.',
              examples: ['true_5511999999999@c.us_3EB0AF79BCE4EB'],
            },
            to: { type: 'string' },
            timestamp: { type: 'integer' },
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
    'Sessão não está conectada. O corpo diz o status atual — veja GET /api/sessions.',
  );

  /** Endpoint de envio de mídia (os 5 seguem o mesmo formato). */
  const envioMidia = (nome: string, resumo: string, extras: Record<string, unknown> = {}) => ({
    post: {
      tags: ['Enviar'],
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
                    'Vários arquivos numa chamada (alternativa a `file`). Enviados em ' +
                    'série, então a ordem é preservada. Cada item aceita `caption`.',
                  items: file,
                },
                caption: { type: 'string', description: 'Legenda.' },
                album: {
                  type: 'boolean',
                  description: 'Agrupa imagens/vídeos numa bolha única.',
                },
                reply_to: {
                  type: 'string',
                  description: 'Id da mensagem citada (o `id` que um envio devolveu).',
                },
                ...extras,
              },
            },
          },
        },
      },
      responses: {
        200: enviado,
        400: erro('Entrada inválida (arquivo ausente, base64 malformado, etc.).'),
        413: erro('Arquivo acima do limite.'),
        422: naoConectada,
      },
    },
  });

  return {
    openapi: '3.1.0',
    info: {
      title: 'ELO — API',
      version,
      description:
        'Gateway WhatsApp auto-hospedado.\n\n' +
        '**Autenticação:** todas as rotas exigem o header `X-Api-Key`, exceto ' +
        '`/health`, `/docs`, `/openapi.json`, o painel e `/api/files/*`.\n\n' +
        '**Aviso:** usa uma biblioteca não-oficial do WhatsApp. Números podem ser ' +
        'banidos; não use para disparo em massa.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: '/', description: 'Este gateway' }],
    tags: [
      { name: 'Sessões', description: 'Conectar números, QR, status e configuração.' },
      { name: 'Enviar', description: 'Texto, mídia, reações.' },
      { name: 'Mensagens', description: 'Operar sobre mensagem já enviada.' },
      { name: 'Presença', description: '"digitando…", online, marcar como lida.' },
      { name: 'Contatos', description: 'Verificar número, resolver id oculto.' },
      { name: 'Operação', description: 'Saúde, métricas, backup, diagnóstico.' },
    ],
    components: {
      securitySchemes: {
        ApiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      },
      schemas: {
        Sessao: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Id técnico (use nas chamadas).' },
            label: { type: 'string', description: 'Nome livre que o operador escolheu.' },
            status: {
              type: 'string',
              enum: ['STOPPED', 'STARTING', 'SCAN_QR_CODE', 'WORKING', 'FAILED'],
            },
            me: {
              type: ['object', 'null'],
              description: 'Número pareado. `null` = precisa de QR.',
              properties: { id: { type: 'string' }, pushName: { type: ['string', 'null'] } },
            },
            engine: { type: 'object', properties: { engine: { type: 'string' } } },
            shouldStart: { type: 'boolean' },
            hasQr: { type: 'boolean' },
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
          tags: ['Sessões'],
          summary: 'Lista as sessões',
          description: 'Segredos vêm mascarados (`••••••••`).',
          operationId: 'listarSessoes',
          responses: {
            200: {
              description: 'Lista.',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/Sessao' } },
                },
              },
            },
          },
        },
        post: {
          tags: ['Sessões'],
          summary: 'Cria (e inicia) uma sessão',
          description:
            'O `name` é livre: aceita espaços, acentos, maiúsculas e emoji. O gateway ' +
            'deriva um id técnico seguro e devolve os dois — **use o `name` da resposta** ' +
            'nas outras chamadas.',
          operationId: 'criarSessao',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', examples: ['Atendimento'] },
                    start: { type: 'boolean', default: true },
                    config: {
                      type: 'object',
                      properties: {
                        webhooks: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              url: { type: 'string' },
                              events: {
                                type: 'array',
                                items: {
                                  type: 'string',
                                  enum: ['message', 'message.ack', 'session.status', 'presence.update'],
                                },
                              },
                              customHeaders: {
                                type: 'array',
                                items: {
                                  type: 'object',
                                  properties: { name: { type: 'string' }, value: { type: 'string' } },
                                },
                              },
                              retries: {
                                type: 'object',
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
                          description: 'Tipos de chat a NÃO repassar.',
                          properties: {
                            groups: { type: 'boolean' },
                            status: { type: 'boolean', default: true },
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
              description: 'Criada.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Sessao' } },
              },
            },
            400: erro('Nome inválido.'),
            422: erro('Sessão já existe (benigno: reaplique o config via PUT).'),
          },
        },
      },
      '/api/sessions/{session}': {
        parameters: [{ name: 'session', in: 'path', required: true, schema: sessionName }],
        get: {
          tags: ['Sessões'],
          summary: 'Estado da sessão',
          operationId: 'obterSessao',
          responses: {
            200: {
              description: 'Estado.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Sessao' } } },
            },
            404: erro('Não encontrada.'),
          },
        },
        put: {
          tags: ['Sessões'],
          summary: 'Substitui o config',
          description:
            'Substitui o objeto inteiro. Para edição parcial use PATCH /settings — ' +
            'é mais seguro (faz merge).',
          operationId: 'substituirConfig',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: { 200: { description: 'Atualizada.' }, 404: erro('Não encontrada.') },
        },
        delete: {
          tags: ['Sessões'],
          summary: 'Apaga a sessão e o pareamento',
          description: 'Irreversível: exigirá novo QR.',
          operationId: 'apagarSessao',
          responses: { 200: { description: 'Apagada.' }, 404: erro('Não encontrada.') },
        },
      },
      '/api/sessions/{session}/settings': {
        parameters: [{ name: 'session', in: 'path', required: true, schema: sessionName }],
        patch: {
          tags: ['Sessões'],
          summary: 'Edita a configuração (merge)',
          description:
            'Só os campos enviados mudam. A chave do webhook nunca volta em claro; ' +
            'reenviar o valor mascarado preserva a original.',
          operationId: 'editarConfig',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    shouldStart: { type: 'boolean' },
                    ignoreGroups: { type: 'boolean' },
                    ignoreStatus: { type: 'boolean' },
                    ignoreChannels: { type: 'boolean' },
                    ignoreBroadcast: { type: 'boolean' },
                    webhookUrl: {
                      type: ['string', 'null'],
                      description: 'Vazio/null remove o repasse.',
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
            200: { description: 'Atualizada.' },
            400: erro('Valor fora da faixa ou URL inválida.'),
            404: erro('Não encontrada.'),
          },
        },
      },
      '/api/sessions/{session}/start': {
        parameters: [{ name: 'session', in: 'path', required: true, schema: sessionName }],
        post: {
          tags: ['Sessões'],
          summary: 'Inicia a sessão',
          operationId: 'iniciarSessao',
          responses: { 200: { description: 'Aceito.' }, 404: erro('Não encontrada.') },
        },
      },
      '/api/sessions/{session}/restart': {
        parameters: [{ name: 'session', in: 'path', required: true, schema: sessionName }],
        post: {
          tags: ['Sessões'],
          summary: 'Reinicia (mantém o pareamento)',
          operationId: 'reiniciarSessao',
          responses: { 200: { description: 'Aceito.' }, 404: erro('Não encontrada.') },
        },
      },
      '/api/sessions/{session}/stop': {
        parameters: [{ name: 'session', in: 'path', required: true, schema: sessionName }],
        post: {
          tags: ['Sessões'],
          summary: 'Para (sem apagar o pareamento)',
          operationId: 'pararSessao',
          responses: { 200: { description: 'Parada.' }, 404: erro('Não encontrada.') },
        },
      },
      '/api/sessions/{session}/test-webhook': {
        parameters: [{ name: 'session', in: 'path', required: true, schema: sessionName }],
        post: {
          tags: ['Sessões'],
          summary: 'Testa o webhook configurado',
          description:
            'Dispara um evento inócuo ao destino e devolve o resultado real — status, ' +
            'latência e uma dica quando falha. Roda no servidor, então reflete o que ' +
            'acontece na entrega de verdade.',
          operationId: 'testarWebhook',
          responses: {
            200: {
              description: 'Resultado do teste (`ok: false` também vem com 200).',
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
            422: erro('Sessão sem webhook configurado.'),
          },
        },
      },
      '/api/{session}/auth/qr': {
        parameters: [{ name: 'session', in: 'path', required: true, schema: sessionName }],
        get: {
          tags: ['Sessões'],
          summary: 'QR code para pareamento',
          description:
            'Com `Accept: application/json` devolve `{ mimetype, data }` (base64 do PNG) ' +
            'mais `issuedAt`/`ageMs` — use-os para saber a idade real do código, que o ' +
            'WhatsApp renova em ritmo próprio. Sem o header, devolve o PNG binário.',
          operationId: 'obterQr',
          responses: {
            200: { description: 'QR disponível.' },
            404: erro('Sessão não encontrada.'),
            422: erro('QR indisponível (já conectada, ou ainda subindo).'),
          },
        },
      },

      // ── Enviar ───────────────────────────────────────────────────────────
      '/api/sendText': {
        post: {
          tags: ['Enviar'],
          summary: 'Envia texto',
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
            400: erro('Texto vazio ou campo ausente.'),
            422: naoConectada,
          },
        },
      },
      '/api/sendImage': envioMidia('sendImage', 'Envia imagem'),
      '/api/sendVideo': envioMidia('sendVideo', 'Envia vídeo'),
      '/api/sendFile': envioMidia('sendFile', 'Envia documento/anexo'),
      '/api/sendSticker': envioMidia('sendSticker', 'Envia figurinha (WEBP)'),
      '/api/sendVoice': envioMidia(
        'sendVoice',
        'Envia áudio como nota de voz (PTT)',
        {},
      ),
      '/api/sendMedia': {
        post: {
          tags: ['Enviar'],
          summary: 'Envia VÁRIOS arquivos numa chamada',
          description:
            'Enviados em série, então a ordem que você pede é a que o contato vê. ' +
            '`album: true` agrupa imagens/vídeos numa bolha única. Se qualquer arquivo ' +
            'for inválido, **nada** é enviado e a resposta diz qual item falhou — evita ' +
            'deixar metade entregue. Máximo de 30 itens.',
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
                    caption: { type: 'string', description: 'Aplicada ao primeiro item.' },
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
                            description: 'Força anexo mesmo sendo imagem.',
                          },
                          asVoice: { type: 'boolean', description: 'Força nota de voz.' },
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
              description: 'Enviados.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', description: 'Id do primeiro item.' },
                      count: { type: 'integer' },
                      album: { type: 'boolean' },
                      messages: {
                        type: 'array',
                        description: 'Um id por item, na ordem enviada.',
                        items: { type: 'object', properties: { id: { type: 'string' } } },
                      },
                    },
                  },
                },
              },
            },
            400: erro('Item inválido — nada foi enviado. A mensagem diz qual.'),
            413: erro('Arquivos somam acima do limite agregado.'),
            422: naoConectada,
          },
        },
      },
      '/api/reaction': {
        post: {
          tags: ['Enviar'],
          summary: 'Reage a uma mensagem (ou remove a reação)',
          description: '`reaction` vazio REMOVE a reação — é como o WhatsApp modela isso.',
          operationId: 'reaction',
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
                    chatId: { type: 'string', description: 'Necessário se o id for cru.' },
                    reaction: { type: 'string', examples: ['👍'] },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Aplicada.' }, 400: erro('Id inválido.') },
        },
      },

      // ── Mensagens ────────────────────────────────────────────────────────
      '/api/editMessage': {
        post: {
          tags: ['Mensagens'],
          summary: 'Edita o texto de mensagem enviada',
          description:
            'Limites do WhatsApp: só mensagem própria, apenas texto/legenda, e ~15 ' +
            'minutos. Passado o prazo o servidor ignora sem devolver erro.',
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
                    messageId: { type: 'string' },
                    chatId: { type: 'string' },
                    text: { type: 'string', minLength: 1 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Editada.' },
            400: erro('Texto vazio (para remover use /api/deleteMessage) ou id inválido.'),
          },
        },
      },
      '/api/deleteMessage': {
        post: {
          tags: ['Mensagens'],
          summary: 'Apaga para todos (revoke)',
          description:
            'Também tem prazo, e o WhatsApp NÃO sinaliza quando expira — por isso a ' +
            'resposta diz que a mensagem *pode* permanecer no aparelho do contato.',
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
          responses: { 200: { description: 'Comando aceito.' }, 400: erro('Id inválido.') },
        },
      },
      '/api/forwardMessage': {
        post: {
          tags: ['Mensagens'],
          summary: 'Encaminha para outro chat',
          description:
            'Precisa do CONTEÚDO. Passe `message` (funciona para qualquer mensagem, ' +
            'inclusive recebida) ou `messageId` de mensagem que este gateway enviou e ' +
            'ainda está na janela de retenção.',
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
                    message: { type: 'object', description: 'Conteúdo cru da mensagem.' },
                    force: { type: 'boolean', default: true, description: 'Marca "encaminhada".' },
                  },
                },
              },
            },
          },
          responses: {
            200: enviado,
            400: erro('Destino ou conteúdo ausente.'),
            404: erro('Conteúdo não encontrado — passe `message`.'),
          },
        },
      },
      '/api/resendMessage': {
        post: {
          tags: ['Mensagens'],
          summary: 'Reenvia no mesmo chat',
          description: 'Para o caso de falha de entrega (ack -1). Gera uma mensagem nova.',
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
                    to: { type: 'string', description: 'Outro destino (padrão: o original).' },
                  },
                },
              },
            },
          },
          responses: { 200: enviado, 404: erro('Conteúdo não guardado.') },
        },
      },

      // ── Presença ─────────────────────────────────────────────────────────
      '/api/typing': {
        post: {
          tags: ['Presença'],
          summary: '"digitando…" / "gravando…"',
          description:
            'O WhatsApp expira o indicador em ~10s. Com `duration`, o gateway renova ' +
            'sozinho em background e a requisição responde na hora.',
          operationId: 'typing',
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
                    typing: { type: 'boolean', default: true, description: 'false encerra.' },
                    kind: { type: 'string', enum: ['composing', 'recording'] },
                    duration: { type: 'integer', maximum: 60000, description: 'ms.' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Aplicado.' }, 422: naoConectada },
        },
      },
      '/api/presence': {
        post: {
          tags: ['Presença'],
          summary: 'Online/offline (conta) ou estado por conversa',
          description:
            '`available`/`unavailable` valem para a conta inteira. Os outros três ' +
            'exigem `chatId`. Manter `unavailable` deixa o WhatsApp continuar ' +
            'notificando o celular do operador.',
          operationId: 'presence',
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
            200: { description: 'Aplicado.' },
            400: erro('Estado inválido, ou de conversa sem chatId.'),
          },
        },
      },
      '/api/markAsRead': {
        post: {
          tags: ['Presença'],
          summary: 'Marca como lida (tiques azuis)',
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
                    messageIds: { type: 'array', maxItems: 500, items: { type: 'string' } },
                    messageId: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Marcadas.' }, 400: erro('Lista vazia ou acima de 500.') },
        },
      },
      '/api/presence/{chatId}': {
        parameters: [
          { name: 'chatId', in: 'path', required: true, schema: chatId },
          { name: 'session', in: 'query', required: true, schema: sessionName },
        ],
        get: {
          tags: ['Presença'],
          summary: 'Visto por último do contato',
          description:
            'Depende da privacidade do contato: se ele restringe, o WhatsApp não envia ' +
            'o dado (e é recíproco). Nesse caso vem `available: false` com a explicação, ' +
            'em vez de um vazio ambíguo. Também assina para os próximos eventos.',
          operationId: 'obterPresenca',
          responses: { 200: { description: 'Estado conhecido, ou explicação.' } },
        },
      },

      // ── Contatos ─────────────────────────────────────────────────────────
      '/api/contacts/check-exists': {
        parameters: [
          { name: 'phone', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'session', in: 'query', required: true, schema: sessionName },
        ],
        get: {
          tags: ['Contatos'],
          summary: 'O número tem WhatsApp?',
          description:
            'Confira ANTES de enviar para número novo: sem isso, um número errado gera ' +
            'um envio que o WhatsApp aceita e nunca entrega.',
          operationId: 'checkExists',
          responses: {
            200: {
              description: 'Resultado.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      numberExists: { type: 'boolean' },
                      chatId: { type: 'string' },
                    },
                  },
                },
              },
            },
            400: erro('phone ou session ausente.'),
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
          tags: ['Contatos'],
          summary: 'Dados do contato (nome, id)',
          operationId: 'obterContato',
          responses: { 200: { description: 'Contato.' }, 400: erro('Parâmetro ausente.') },
        },
      },
      '/api/contacts/profile-picture': {
        parameters: [
          { name: 'contactId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'session', in: 'query', required: true, schema: sessionName },
        ],
        get: {
          tags: ['Contatos'],
          summary: 'Foto de perfil',
          operationId: 'obterFoto',
          responses: { 200: { description: 'URL da foto, ou null.' } },
        },
      },
      '/api/{session}/lids/{lid}': {
        parameters: [
          { name: 'session', in: 'path', required: true, schema: sessionName },
          { name: 'lid', in: 'path', required: true, schema: { type: 'string' } },
        ],
        get: {
          tags: ['Contatos'],
          summary: 'Resolve id oculto (@lid) para telefone',
          description:
            'O WhatsApp endereça contatos por um id oculto (LID) que NÃO é o telefone. ' +
            'Se ele vazar como número, o contato nasce inválido e sem nome.',
          operationId: 'resolverLid',
          responses: { 200: { description: 'Telefone.' }, 404: erro('LID desconhecido.') },
        },
      },

      // ── Operação ─────────────────────────────────────────────────────────
      '/health': {
        get: {
          tags: ['Operação'],
          summary: 'Saúde (público)',
          description: 'Valida o banco, não só o processo. Traz versão e commit.',
          operationId: 'health',
          security: [],
          responses: { 200: { description: 'Saudável.' } },
        },
      },
      '/metrics': {
        get: {
          tags: ['Operação'],
          summary: 'Métricas Prometheus',
          description:
            'Quatro sinais que importam: `elo_inbound_undecryptable_total` (perdendo ' +
            'mensagem), `elo_webhook_lost_total` (evento não chegou ao consumidor), ' +
            '`elo_ack_failed_total` (saiu e não entregou) e `elo_session_up` (caiu). ' +
            'Exige a chave: nome de sessão costuma identificar cliente.',
          operationId: 'metrics',
          responses: { 200: { description: 'Exposição em texto.' } },
        },
      },
      '/api/stats': {
        get: {
          tags: ['Operação'],
          summary: 'Contadores por sessão (JSON)',
          description: 'O mesmo das métricas, em JSON — para quem não usa Prometheus.',
          operationId: 'stats',
          responses: { 200: { description: 'Contadores.' } },
        },
      },
      '/api/events': {
        parameters: [{ name: 'after', in: 'query', schema: { type: 'integer' } }],
        get: {
          tags: ['Operação'],
          summary: 'Diagnóstico ao vivo (SSE)',
          description:
            'Stream de eventos: mensagem entrando, ACK progredindo, LID resolvido, ' +
            'webhook rejeitado. É o que o painel consome.',
          operationId: 'events',
          responses: { 200: { description: 'text/event-stream.' } },
        },
      },
      '/api/backup': {
        get: {
          tags: ['Operação'],
          summary: 'Baixa o pareamento',
          description:
            '**Contém as chaves do WhatsApp**: quem tiver o arquivo consegue se passar ' +
            'pelo número conectado. Guarde como guarda senha.',
          operationId: 'backup',
          responses: { 200: { description: 'Arquivo JSON.' } },
        },
      },
      '/api/backup/status': {
        get: {
          tags: ['Operação'],
          summary: 'Há backup? Está em dia?',
          description:
            '`risk`: `none` (nada a perder), `no_backup`, `stale` (pareamento mudou ' +
            'depois do último backup) ou `ok`.',
          operationId: 'backupStatus',
          responses: { 200: { description: 'Risco calculado.' } },
        },
      },
      '/api/backup/restore': {
        post: {
          tags: ['Operação'],
          summary: 'Restaura um backup',
          description:
            'DESTRUTIVO: substitui o pareamento atual e reinicia as sessões. Exige ' +
            '`confirm: true` junto do dump.',
          operationId: 'backupRestore',
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
            200: { description: 'Restaurado.' },
            400: erro('Sem confirm, ou formato desconhecido.'),
          },
        },
      },
    },
  };
}
