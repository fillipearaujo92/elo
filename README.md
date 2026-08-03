# ELO

[![CI](https://github.com/fillipearaujo92/elo/actions/workflows/ci.yml/badge.svg)](https://github.com/fillipearaujo92/elo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

**English** · [Português](README.pt-BR.md)

Self-hosted WhatsApp gateway. Connect a number by scanning a QR code, then use a
**REST API** to send and receive messages. Comes with a **web panel** to operate
the sessions.

Runs on your server. The pairing lives in your Postgres — no data passes through a
third-party service.

```
your system  ──HTTP──▶  ELO  ──▶  WhatsApp
             ◀─webhook──
```

> ### ⚠️ Read this first
>
> ELO uses [Baileys](https://github.com/WhiskeySockets/Baileys), an **unofficial**
> library that speaks the WhatsApp Web protocol. It is **not** approved, endorsed
> or supported by WhatsApp/Meta.
>
> - **Your number can be banned.** WhatsApp restricts and bans accounts it detects
>   as automation — especially new numbers, or high volume to contacts who never
>   interacted with you.
> - **Do not use it for bulk messaging, spam or unsolicited messages.** Besides
>   being the fastest route to a ban, it violates WhatsApp's Terms of Service.
> - For commercial use at scale, the official path is the
>   [WhatsApp Business Platform (Cloud API)](https://developers.facebook.com/docs/whatsapp/cloud-api).
> - Provided **without warranty** (see [LICENSE](LICENSE)). The risk is yours.
>
> Reasonable uses: human-assisted support, notifications for people who opted in,
> integration with your own CRM, personal automation.

## Features

| | |
|---|---|
| **Messages** | text, image, video, voice note (PTT), document, sticker |
| **Multiple files** | several in one call, per-item caption, order preserved |
| **Albums** | images/videos grouped into a single bubble |
| **Receiving** | webhook with media downloaded and served from your own URL |
| **Delivery receipts** | sent → delivered → read, and failure (ack `-1`) |
| **Reactions** | send and receive, as a dedicated event |
| **Reply** | quote a previous message |
| **Edit** | fix the text of a message already sent |
| **Delete** | delete for everyone (revoke) |
| **Forward** | share a message with another chat |
| **Resend** | resend in the same chat after a delivery failure |
| **Multi-session** | several numbers in one process |
| **Web panel** | QR with countdown, status, live diagnostics (SSE), configuration |
| **Test a channel** | sends a message and shows delivery happening, without leaving the panel |
| **Survives restarts** | the pairing lives in Postgres — restarting does not ask for a new QR |
| **Chat filters** | ignore groups, status/stories, channels, broadcast lists |
| **Contact identity** | resolves the hidden id (LID) to the real phone number |
| **Presence** | typing, recording, online/offline, last seen |
| **Mark as read** | blue ticks, several messages in one call |
| **Metrics** | Prometheus: message loss, failed ACKs, sessions down |

## Install

### Docker (recommended)

```bash
git clone https://github.com/fillipearaujo92/elo.git
cd elo
cp .env.example .env
```

> The compose file uses the **published image** (`ghcr.io/fillipearaujo92/elo`),
> so nothing is compiled. To build from local source, comment `image:` and
> uncomment `build: .` in `docker-compose.yml`.

Fill in **two** lines in `.env`:

```bash
API_KEY=<generate with: openssl rand -hex 32>
POSTGRES_PASSWORD=<any password>
```

That is it. With Docker, `DATABASE_URL` is assembled by compose — leave it alone.

Bring it up:

```bash
docker compose up -d
```

Open <http://localhost:3000>, enter the `API_KEY` and create your first session.
Scan the QR code from WhatsApp (**Linked devices → Link a device**).

Once connected, use **test channel** in the session detail: it sends a message and
shows delivery progressing (accepted → sent → delivered → read). That is the
difference between knowing the socket came up and knowing messages *arrive*.

> **The port binds to `127.0.0.1` by default** — the gateway is not reachable from
> other machines until you say so. The API key grants the power to send messages as
> the paired number, so exposing it is a decision, not a default.
>
> To reach it from another machine, set both in `.env`:
>
> ```bash
> BIND_ADDR=0.0.0.0
> PUBLIC_URL=http://192.168.1.50:3000
> ```
>
> `PUBLIC_URL` goes into the media links sent on webhooks — with the default
> (`localhost`), your system would try to download from itself.
>
> Put a reverse proxy with TLS in front of it before exposing it to the internet.
> Check [SECURITY.md](SECURITY.md) first.

### Without Docker

Requirements: **Node 22+** and **Postgres 14+**.

```bash
npm ci
cp .env.example .env      # fill in API_KEY and DATABASE_URL
npm run build
npm start                 # the schema is created on first boot
```

## API documentation

With the gateway running, open **<http://localhost:3000/docs>**: Swagger UI with
every endpoint, its fields, and a button to try each one from the browser. Enter
your key under **Authorize** and the calls go out authenticated.

The raw spec lives at `/openapi.json` (OpenAPI 3.1) — generate a client in any
language, or import it into Insomnia/Postman.

Both are **public**: they describe the shape of the API and expose no data.
Whoever wants to *test* supplies the key in Swagger itself.

> The spec lives in code, and a test compares its declared paths against the
> routes actually registered. A new endpoint without documentation breaks CI —
> that is what keeps the docs from rotting.

## Usage

Every route requires the `X-Api-Key` header.

**Create a session and get the QR code**

```bash
curl -X POST http://localhost:3000/api/sessions \
  -H 'X-Api-Key: YOUR_KEY' -H 'Content-Type: application/json' \
  -d '{"name":"Support","start":true,
       "config":{"webhooks":[{"url":"https://your-system/webhook","events":["message","message.ack","session.status"]}]}}'

# QR as PNG (base64 in JSON, or raw image without the Accept header)
curl http://localhost:3000/api/support/auth/qr \
  -H 'X-Api-Key: YOUR_KEY' -H 'Accept: application/json'
```

`name` is **free-form** (spaces, accents, uppercase, emoji). ELO derives a safe
technical id and returns both: `"Support — Downtown 🏬"` →
`name: "support-downtown"`, `label: "Support — Downtown 🏬"`. **Use `name` in the
other calls** — that is what goes in the URL. The panel shows both.

**Send**

```bash
# text
curl -X POST http://localhost:3000/api/sendText \
  -H 'X-Api-Key: YOUR_KEY' -H 'Content-Type: application/json' \
  -d '{"session":"support","chatId":"15551234567@c.us","text":"Hello!"}'

# image (base64 or url)
curl -X POST http://localhost:3000/api/sendImage \
  -H 'X-Api-Key: YOUR_KEY' -H 'Content-Type: application/json' \
  -d '{"session":"support","chatId":"15551234567@c.us",
       "caption":"Take a look","file":{"url":"https://example.com/photo.jpg"}}'
```

Send endpoints: `sendText`, `sendImage`, `sendVideo`, `sendVoice`, `sendFile`,
`sendSticker`, `sendMedia`, `sendReaction`.

For **voice notes** (showing up as a recording, not a file attachment), send
`audio/ogg; codecs=opus` through `sendVoice` — it is the only format WhatsApp
delivers as a voice note.

**Several files in one call**

`sendMedia` sends N media items at once, each with its own caption. Sends are
**serialized**, so the order you ask for is the order the contact sees — which is
not what happens when you fire requests in parallel.

```bash
curl -X POST http://localhost:3000/api/sendMedia \
  -H 'X-Api-Key: YOUR_KEY' -H 'Content-Type: application/json' \
  -d '{
    "session":"support","chatId":"15551234567@c.us",
    "album": true,
    "items":[
      {"file":{"url":"https://example.com/1.jpg"},"caption":"Front"},
      {"file":{"url":"https://example.com/2.jpg"},"caption":"Side"},
      {"file":{"url":"https://example.com/manual.pdf","filename":"manual.pdf"},
       "caption":"Specs"}
    ]}'
```

`album: true` groups images and videos into a **single bubble** (a native WhatsApp
feature). Documents and audio do not go into albums — they are sent as their own
messages, in the same call.

The response returns one id per item, in the order sent, so you can match each
ACK:

```json
{ "id": "true_...", "count": 3, "album": true,
  "messages": [{ "id": "true_..." }, { "id": "true_..." }, { "id": "true_..." }] }
```

Per item: `caption`, `asDocument` (force an attachment even for an image) and
`asVoice`. Without a per-item `caption`, the call-level `caption` applies to the
first item — that is how WhatsApp shows an album caption. The type is chosen by
`mimetype`; anything unknown becomes a document.

If **any** file is invalid, nothing is sent and the response names the failing
item — this avoids leaving half the batch delivered and the contact receiving
duplicates on retry. Maximum 30 items per call.

`sendImage`, `sendVideo` and `sendFile` also accept `files: [...]` for the same
effect, so existing integrations do not have to switch endpoints.

**Act on a message already sent**

```bash
# edit the text (WhatsApp allows ~15 min, your own messages only)
curl -X POST http://localhost:3000/api/editMessage -H 'X-Api-Key: YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"session":"support","messageId":"true_15551234567@c.us_3EB0…","text":"Fixed"}'

# delete for everyone
curl -X POST http://localhost:3000/api/deleteMessage -H 'X-Api-Key: YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"session":"support","messageId":"true_15551234567@c.us_3EB0…"}'

# forward to another chat
curl -X POST http://localhost:3000/api/forwardMessage -H 'X-Api-Key: YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"session":"support","messageId":"true_…_3EB0…","to":"15559876543@c.us"}'

# resend in the same chat (after a delivery failure)
curl -X POST http://localhost:3000/api/resendMessage -H 'X-Api-Key: YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"session":"support","messageId":"true_…_3EB0…"}'
```

`messageId` accepts the serialized id (`true_<chat>_<raw>`) or the raw id together
with `chatId`. Ids of **received** messages work too — to delete your own reply in
a chat, for instance.

Limits that are **WhatsApp's**, not ELO's:

- **edit**: your own messages only, text/caption only (media cannot be swapped),
  and roughly a 15-minute window. Past that, the server ignores the edit without
  returning an error.
- **delete for everyone**: also time-limited, and WhatsApp does not signal when it
  expires — which is why the response says the message *may* remain on the
  contact's device instead of claiming success.
- **forward/resend** need the message **content**, not just its id. ELO keeps what
  it sent (for `SENT_MESSAGES_RETENTION_DAYS`, 7 by default). To forward a message
  you **received**, pass the content in `message`:

  ```json
  {"session":"support","to":"15559876543@c.us",
   "message":{"conversation":"text to forward"}}
  ```

  Without it the response is a 404 explaining what to do — rather than failing for
  no clear reason.

**Receive**

ELO `POST`s to your webhook with `{ event, session, payload }`:

```json
{
  "event": "message",
  "session": "support",
  "payload": {
    "id": "false_15551234567@c.us_3EB0...",
    "from": "15551234567@c.us",
    "fromMe": false,
    "type": "chat",
    "body": "Hello!",
    "notifyName": "Mary",
    "timestamp": 1785358125,
    "source": "app"
  }
}
```

Events: `message` (incoming), `message.ack` (delivery/read receipt),
`session.status` (connection), `presence.update` (the contact typing). When a
message has media, `media.url` tells you where to download it. Failed deliveries
are retried (15× every 2s by default, configurable); 4xx responses are not.

`payload.id` is stable and works as an idempotency key — WhatsApp can redeliver
the same event.

Three rules that save you trouble:

**Answer 200 immediately.** Processing before responding makes ELO treat slowness
as failure and retry — you receive the same message several times.

**Use `payload.id` to deduplicate.** WhatsApp redelivers events.

**4xx is not retried.** If your endpoint answers 4xx (wrong key, missing route),
the event is **dropped** — retrying a contract error would only queue garbage.
5xx and timeouts are retried.

## Integrating with your system

If your case is plugging ELO into your own support system, the
**[integration guide](docs/INTEGRACAO.md)** (Portuguese) walks the full path:
bring it up, receive webhooks, send, monitor, and a table of common errors with
the cause of each.

## Presence: sounding human

```bash
# typing for 8s (ELO refreshes it; WhatsApp expires it in ~10s)
curl -X POST http://localhost:3000/api/typing -H 'X-Api-Key: YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"session":"support","chatId":"15551234567@c.us","duration":8000}'

# recording audio
#   -d '{"session":"…","chatId":"…","kind":"recording","duration":5000}'

# mark as read (blue ticks)
curl -X POST http://localhost:3000/api/markAsRead -H 'X-Api-Key: YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"session":"support","chatId":"15551234567@c.us",
       "messageIds":["false_15551234567@c.us_3EB0…"]}'
```

The `typing` request returns **immediately** — the refresh runs in the background,
because holding a handler open for 20s would exhaust connections on a busy support
desk.

The contact typing reaches you through the `presence.update` webhook event.

**Last seen** depends on the contact's privacy settings: if they restrict it,
WhatsApp simply does not send the data — and it is reciprocal (hiding yours also
hides theirs from you). In that case ELO returns `available: false` with the
explanation, rather than pretending the information exists.

## Observability

`GET /metrics` exposes Prometheus metrics. The four signals that matter:

```
elo_inbound_undecryptable_total  > 0   losing messages RIGHT NOW
elo_webhook_lost_total           > 0   an event never reached your system
elo_ack_failed_total             > 0   a message left and was not delivered
elo_session_up{session="…"}      = 0   session is down
```

This exists for a concrete reason: an encryption bug once took down all inbound
traffic and **was only discovered when someone sent a message and noticed it never
arrived** — the gateway was already logging the drops and telling nobody. Silent
failure is the worst failure mode for a gateway, and these counters make it
visible.

Housekeeping shows up here too, and it is routine rather than an alarm:

```
elo_sent_messages_purged_total{session="*"}   rows dropped by retention
```

ELO keeps what it sent for `SENT_MESSAGES_RETENTION_DAYS` (7 by default) so it can
answer retry receipts, and an hourly sweep drops anything older. Set it to `0` to
disable the sweep — the table then grows without bound, in the same volume that
holds your pairing.

Example Prometheus alerts:

```yaml
- alert: EloLosingMessages
  expr: increase(elo_inbound_undecryptable_total[10m]) > 0
  annotations:
    summary: "ELO is failing to decrypt messages on {{ $labels.session }}"

- alert: EloSessionDown
  expr: elo_session_up == 0
  for: 5m
```

`/metrics` requires the `X-Api-Key`: session names are labels, and a session name
usually identifies a customer.

No Prometheus? `GET /api/stats` returns the same numbers in JSON, per session. The
panel also has a live diagnostics tab.

## API reference

| Method | Route | What |
|---|---|---|
| `POST` | `/api/sessions` | create (and start) |
| `GET` | `/api/sessions` | list (secrets masked) |
| `GET` | `/api/sessions/{s}` | status, paired number |
| `PATCH` | `/api/sessions/{s}/settings` | webhook, events, filters, auto-start |
| `POST` | `/api/sessions/{s}/restart` \| `/stop` | lifecycle |
| `DELETE` | `/api/sessions/{s}` | delete session and pairing |
| `GET` | `/api/{s}/auth/qr` | QR code (PNG) |
| `POST` | `/api/sendText` … | send one item |
| `POST` | `/api/sendMedia` | several files / album |
| `POST` | `/api/editMessage` | edit the text |
| `POST` | `/api/deleteMessage` | delete for everyone |
| `POST` | `/api/forwardMessage` | forward to another chat |
| `POST` | `/api/resendMessage` | resend in the same chat |
| `POST` | `/api/typing` | typing / recording |
| `POST` | `/api/presence` | online/offline, per chat or account |
| `POST` | `/api/markAsRead` | mark as read |
| `GET` | `/api/presence/{chatId}` | contact's last seen |
| `GET` | `/api/contacts/check-exists` | does the number have WhatsApp? |
| `GET` | `/api/{s}/lids/{lid}` | resolve hidden id → phone |
| `GET` | `/api/stats` | per-session counters |
| `GET` | `/api/events` | live diagnostics (SSE) |
| `GET` | `/api/backup` | download the pairing |
| `GET` | `/api/backup/status` | is there a backup? is it current? |
| `POST` | `/api/backup/restore` | restore (destructive) |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/health` | health (validates the database), version and commit |
| `GET` | `/docs` · `/openapi.json` | API documentation |

`/health`, `/docs` and `/openapi.json` are public; everything else needs the key.
`/api/files/*` is open too — file names are random and unguessable, a deliberate
trade-off so webhook consumers can fetch media without spreading the master
credential.

## Running in production

**The Postgres volume is the pairing.** Deleting it forces a new QR scan on every
session.

ELO helps with that: the panel warns when a session is paired and has no backup,
and one click downloads what cannot be recreated.

```bash
# download
curl -OJ http://localhost:3000/api/backup -H 'X-Api-Key: YOUR_KEY'

# restore (REPLACES the current pairing — requires confirm)
jq '{confirm:true, format, data}' elo-backup-*.json | \
  curl -X POST http://localhost:3000/api/backup/restore \
    -H 'X-Api-Key: YOUR_KEY' -H 'Content-Type: application/json' -d @-
```

The file holds `sessions`, `auth_creds`, `auth_keys` and `lid_map` — what rebuilds
the connection. It does not include the sent-message history (transit cache: it is
what grows most and does not improve a restore).

> ⚠️ **The backup contains WhatsApp keys.** Anyone holding the file can
> impersonate the connected number: read and send messages. Store it like a
> password.

`GET /api/backup/status` returns the current risk (`no_backup`, `stale`, `ok`), so
you can monitor it externally.

**One instance per database.** There is no coordination between replicas; two
instances would bring up the same session and break the pairing.

**Do not expose it on the open internet** — use an internal network, a VPN, or a
reverse proxy with TLS and origin restrictions.

**Use a separate webhook key** from `API_KEY` if the destination is third-party
(`webhookKey` on `PATCH /settings`).

**New numbers are fragile.** High volume to contacts who never interacted is the
fastest route to a block. Warm up gradually.

**Pin the image version** in production (`ELO_TAG=0.1.0`) — `latest` moves under
your feet on the next release.

## Development

```bash
npm ci
npm run dev          # watch
npm test             # 278 tests
npm run typecheck
```

The test suite covers what actually broke in production: ACK progression, LID
resolution, webhook delivery, payload translation, chat filters and secret
masking. The comments are worth reading — every test marked `REGRESSÃO` documents
a real bug and why it happened.

Code comments and the integration guide are in Portuguese; the API spec and this
README are in English. Different audiences: whoever maintains the gateway, and
whoever integrates with it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: open an issue before a
non-trivial PR, include tests for the behaviour you change, and keep the scope
tight. Security issues: [SECURITY.md](SECURITY.md) — please do not open a public
issue.

## License

[MIT](LICENSE) — Fillipe Araújo.

Not affiliated with WhatsApp Inc. or Meta. "WhatsApp" is a trademark of Meta
Platforms, Inc.
