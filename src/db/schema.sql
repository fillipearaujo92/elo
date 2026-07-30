-- src/db/schema.sql
-- Schema do gateway. Roda no boot (idempotente) — ver src/db/pool.ts:migrate().
--
-- Vive em schema DEDICADO (wa_gateway) e NAO no schema de tenant do Sysled: o
-- gateway e um servico externo, como a Evolution/WAHA hoje. Isso tambem evita o
-- vazamento de search_path do PgBouncer em transaction-mode que ja mordeu o projeto.

CREATE SCHEMA IF NOT EXISTS wa_gateway;

-- Sessoes: uma linha por canal do Sysled. `name` e o identificador tecnico que o
-- backend manda em todo request (channels.identifier — ver wa-provider/index.js:29).
CREATE TABLE IF NOT EXISTS wa_gateway.sessions (
  -- `name` e o IDENTIFICADOR TECNICO (slug): entra em URL, caminho de midia e
  -- chaves do auth state. Sempre [a-z0-9-]. Continua sendo a PK e o valor que o
  -- backend do Sysled manda em todo request (channels.identifier).
  name          TEXT PRIMARY KEY,
  -- Ultimo status conhecido, no vocabulario do WAHA (WORKING|STARTING|SCAN_QR_CODE|FAILED|STOPPED).
  status        TEXT NOT NULL DEFAULT 'STOPPED',
  -- Telefone pareado ("558591218605"). connectionState() do driver expoe como me.id.
  me_id         TEXT,
  me_push_name  TEXT,
  -- config JSONB guarda os webhooks (url, events, customHeaders) e ignore.groups,
  -- exatamente como o WAHA aceita em POST/PUT /api/sessions. O driver do backend
  -- faz PUT preservando o resto do config (waha.js:173-183), entao guardamos o
  -- objeto inteiro em vez de colunas separadas.
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- start=true significa "esta sessao deve estar no ar": usado para restaurar no boot.
  should_start  BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Credenciais do Baileys (o objeto de initAuthCreds, serializado com BufferJSON).
-- Uma linha por sessao. Separado de `sessions` porque e escrito com frequencia
-- diferente (creds.update) e nunca precisa ser lido em listagens.
CREATE TABLE IF NOT EXISTS wa_gateway.auth_creds (
  session_name TEXT PRIMARY KEY
    REFERENCES wa_gateway.sessions(name) ON DELETE CASCADE,
  creds        JSONB NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Signal key store: pre-keys, sessions, sender-keys, app-state-sync.
-- Chave composta (sessao, tipo, id) — o Baileys pede em lote por tipo+ids
-- (SignalKeyStore.get(type, ids)), por isso o PK nessa ordem serve o acesso.
-- Volume: centenas a milhares de linhas por sessao (pre-keys sao consumidas).
CREATE TABLE IF NOT EXISTS wa_gateway.auth_keys (
  session_name TEXT NOT NULL
    REFERENCES wa_gateway.sessions(name) ON DELETE CASCADE,
  key_type     TEXT NOT NULL,
  key_id       TEXT NOT NULL,
  key_data     JSONB NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_name, key_type, key_id)
);

-- Idempotencia de ACK e reconciliacao: guarda o ultimo ack visto por mensagem
-- enviada, para nao reemitir webhook de ack repetido (o WhatsApp reenvia acks).
--
-- ★ `content` guarda o proto da mensagem enviada, e NAO e opcional: quando o
-- dispositivo do destinatario nao consegue decifrar (sessao Signal inconsistente,
-- "Bad MAC"), ele envia um RETRY RECEIPT pedindo a mensagem de novo. O Baileys
-- responde a esse pedido chamando `getMessage(key)` — se nao tivermos o conteudo,
-- o retry fica sem resposta e o app do contato mostra
-- "Aguardando mensagem / Essa acao pode levar alguns instantes" PARA SEMPRE.
-- (A doc do Baileys chama isso de "solves the this message can take a while issue".)
CREATE TABLE IF NOT EXISTS wa_gateway.sent_messages (
  session_name TEXT NOT NULL
    REFERENCES wa_gateway.sessions(name) ON DELETE CASCADE,
  msg_id       TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  last_ack     SMALLINT NOT NULL DEFAULT 0,
  -- proto.IMessage serializado (BufferJSON) para responder retry receipts.
  content      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_name, msg_id)
);

-- Migração para bancos que já tinham a tabela sem a coluna.
ALTER TABLE wa_gateway.sent_messages ADD COLUMN IF NOT EXISTS content JSONB;

-- `label`: o nome COMO O HUMANO ESCREVEU — espaços, acento, emoji, o que quiser.
-- Só rótulo de exibição; nunca entra em URL, caminho ou chave. O par
-- (name = slug técnico, label = texto livre) é o que permite ao operador digitar
-- "Atacadão Léd — Centro 🏬" sem que nada quebre. Ver src/core/slug.ts.
ALTER TABLE wa_gateway.sessions ADD COLUMN IF NOT EXISTS label TEXT;

-- Sessões criadas antes desta coluna: o label passa a ser o próprio name.
UPDATE wa_gateway.sessions SET label = name WHERE label IS NULL;

CREATE INDEX IF NOT EXISTS sent_messages_created_idx
  ON wa_gateway.sent_messages (created_at);

-- Mapa LID -> telefone. GOWS/WAHA expoem GET /api/{session}/lids/{lid} e o backend
-- DEPENDE disso (webhooks/waha.js:63): sem resolver o LID, o contato nasce com o id
-- oculto no lugar do numero e o consultor nao consegue responder. O Baileys entrega
-- o par (lid, pn) nos eventos de contato/mensagem; persistimos para servir o endpoint.
CREATE TABLE IF NOT EXISTS wa_gateway.lid_map (
  session_name TEXT NOT NULL
    REFERENCES wa_gateway.sessions(name) ON DELETE CASCADE,
  lid          TEXT NOT NULL,
  phone        TEXT NOT NULL,
  push_name    TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_name, lid)
);

CREATE INDEX IF NOT EXISTS lid_map_phone_idx
  ON wa_gateway.lid_map (session_name, phone);
