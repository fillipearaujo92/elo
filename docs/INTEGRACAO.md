# Integrando o ELO no seu sistema de atendimento

Guia prático: do zero até mensagens entrando e saindo do seu sistema.

O ELO faz duas coisas — **entrega no seu webhook** o que chega do WhatsApp, e
**envia** o que você mandar pela API REST. Todo o resto é detalhe.

```
       ┌──────────── POST /api/sendText ─────────────┐
       │                                             ▼
seu sistema                                        ELO  ──▶  WhatsApp
       ▲                                             │
       └──── POST no seu webhook (message, ack) ──────┘
```

## 1. Subir

```bash
git clone https://github.com/fillipearaujo92/elo.git && cd elo
cp .env.example .env
```

Preencha **duas** linhas no `.env`:

```bash
API_KEY=<openssl rand -hex 32>
POSTGRES_PASSWORD=<qualquer senha>
```

```bash
docker compose up -d
curl http://localhost:3000/health     # {"status":"ok",…}
```

> **`PUBLIC_URL`**: se o ELO e o seu sistema estão em máquinas diferentes, defina
> `PUBLIC_URL=http://<ip-do-elo>:3000` no `.env`. Esse endereço vai nos links de
> mídia — com o default (`localhost`), seu sistema tentaria baixar de si mesmo e
> falharia.

## 2. Criar a sessão apontando para o seu sistema

```bash
curl -X POST http://localhost:3000/api/sessions \
  -H 'X-Api-Key: SUA_CHAVE' -H 'Content-Type: application/json' \
  -d '{
    "name": "atendimento",
    "start": true,
    "config": { "webhooks": [{
      "url": "http://seu-sistema:8080/webhook/whatsapp",
      "events": ["message", "message.ack", "session.status"]
    }]}
  }'
```

Use o nome em **minúsculas, sem espaço** — ele vira o id nas outras chamadas.
(Nome com acento, espaço ou emoji também funciona: o ELO deriva um id seguro e
devolve os dois campos, `name` e `label`. Use o `name` nas chamadas.)

Escaneie o QR pelo painel (`http://localhost:3000`) ou pela API:

```bash
curl 'http://localhost:3000/api/atendimento/auth/qr' \
  -H 'X-Api-Key: SUA_CHAVE' -H 'Accept: application/json'
```

**Antes de pareação:** confirme que o ELO alcança o seu sistema.

```bash
curl -X POST http://localhost:3000/api/sessions/atendimento/test-webhook \
  -H 'X-Api-Key: SUA_CHAVE'
```

Isso dispara um evento inócuo e mostra o resultado real — `status`, latência e uma
dica quando falha. Se der `"error": "fetch failed"`, o ELO não chega no seu host
(rede/DNS); se der `401`, a chave não confere. Resolver isso agora evita descobrir
depois que mensagens estão desaparecendo.

## 3. Receber

Seu endpoint recebe `POST` com `{ event, session, payload }` e o header
`X-Webhook-Key`. **Valide esse header** — é o que garante que a chamada veio do
seu gateway.

```js
app.post('/webhook/whatsapp', (req, res) => {
  if (req.headers['x-webhook-key'] !== process.env.ELO_KEY) {
    return res.sendStatus(401)
  }
  // Responda 200 RÁPIDO e processe depois: o ELO tem timeout e vai retentar.
  res.sendStatus(200)

  const { event, session, payload } = req.body
  if (event === 'message' && !payload.fromMe) {
    processar(session, payload)          // sua fila / seu handler
  }
})
```

Três regras que evitam dor de cabeça:

**Responda 200 imediatamente.** Processar antes de responder faz o ELO considerar
lentidão como falha e retentar — você recebe a mesma mensagem várias vezes.

**Use `payload.id` como chave de idempotência.** O WhatsApp reentrega eventos; sem
deduplicar, a mesma mensagem entra duas vezes. O `id` é estável.

**4xx não é retentado.** Se o seu endpoint responder 4xx (chave errada, rota
inexistente), o evento é **descartado** — retentar erro de contrato só enfileira
lixo. 5xx e timeout são retentados (padrão 15× a cada 2s).

### O que chega

```json
{
  "event": "message",
  "session": "atendimento",
  "payload": {
    "id": "false_5511999999999@c.us_3EB0…",
    "from": "5511999999999@c.us",
    "fromMe": false,
    "type": "chat",
    "body": "Olá!",
    "notifyName": "Maria",
    "timestamp": 1785358125,
    "source": "app"
  }
}
```

| Campo | Serve para |
|---|---|
| `id` | idempotência, e citar em reply |
| `from` | quem enviou (`@c.us`). Em grupo, veja `participant` |
| `fromMe` | `true` = mensagem enviada pelo próprio número (ignore no inbound) |
| `type` | `chat`, `image`, `video`, `audio`, `ptt`, `document`, `sticker`, `reaction` |
| `body` | texto ou legenda |
| `media.url` | quando há mídia: **baixe e guarde no seu storage** |
| `source` | `app` (celular) ou `web` — útil para saber se um humano respondeu pelo aparelho |

Eventos: `message`, `message.ack`, `session.status`, `presence.update`.

**Mídia é cache de trânsito.** O `media.url` aponta para o ELO e pode ser limpo.
Baixe no recebimento e guarde no seu storage — a fonte da verdade é o seu sistema.

**ACK** (`message.ack`) traz `ack`: `-1` falhou, `1` enviada, `2` entregue, `3` lida.
`-1` é o que merece alerta: a mensagem saiu e não chegou.

## 4. Enviar

```bash
curl -X POST http://localhost:3000/api/sendText \
  -H 'X-Api-Key: SUA_CHAVE' -H 'Content-Type: application/json' \
  -d '{"session":"atendimento","chatId":"5511999999999@c.us","text":"Olá!"}'
```

O `chatId` é `<telefone>@c.us` (com código do país, sem `+` nem espaços). A
resposta traz `id` — **guarde-o** para casar com o ACK que chega depois.

Se vier 200 **sem** `id`, trate como falha.

Antes de mandar para um número novo, confirme que ele tem WhatsApp:

```bash
curl 'http://localhost:3000/api/contacts/check-exists?phone=5511999999999&session=atendimento' \
  -H 'X-Api-Key: SUA_CHAVE'
```

### Parecer humano

```bash
# "digitando…" enquanto seu bot pensa (o ELO renova sozinho)
curl -X POST http://localhost:3000/api/typing -H 'X-Api-Key: SUA_CHAVE' \
  -H 'Content-Type: application/json' \
  -d '{"session":"atendimento","chatId":"5511999999999@c.us","duration":3000}'

# marcar como lida ao abrir a conversa no seu painel
curl -X POST http://localhost:3000/api/markAsRead -H 'X-Api-Key: SUA_CHAVE' \
  -H 'Content-Type: application/json' \
  -d '{"session":"atendimento","chatId":"5511999999999@c.us","messageIds":["false_…"]}'
```

## 5. Monitorar

Quatro sinais em `GET /metrics` (Prometheus). Vale alertar nos dois primeiros:

```
elo_inbound_undecryptable_total  > 0   perdendo mensagem AGORA
elo_webhook_lost_total           > 0   evento não alcançou seu sistema
elo_ack_failed_total             > 0   saiu e não foi entregue
elo_session_up{session="…"}      = 0   sessão caída
```

Sem Prometheus? `GET /api/stats` devolve o mesmo em JSON, por sessão. E o painel
tem uma aba de diagnóstico ao vivo.

## Erros comuns

| Sintoma | Causa provável |
|---|---|
| `404` ao buscar o QR | nome errado — use o `name` que a criação devolveu |
| `422 sessao nao esta conectada` | ainda pareando, ou caiu. Veja `GET /api/sessions` |
| Mensagem sai mas não chega ao seu sistema | webhook. Rode `test-webhook` |
| Mesma mensagem várias vezes | seu endpoint demora a responder 200, ou falta deduplicar por `id` |
| Mídia não abre | não baixou no recebimento; a URL do ELO é temporária |
| Áudio vira anexo, não voz | use `sendVoice` com `audio/ogg; codecs=opus` |
| QR expira antes de escanear | normal (~20s). O painel gera outro sozinho |

## Produção

- **Backup do volume do Postgres.** Nele vive o pareamento: perder o volume =
  escanear o QR de novo em todas as sessões.
- **Uma instância por banco.** Não há coordenação entre réplicas; duas instâncias
  subiriam a mesma sessão e derrubariam o pareamento.
- **Não exponha na internet aberta** — rede interna, VPN, ou proxy com TLS.
- **Chave de webhook separada** da `API_KEY` se o destino for de terceiros
  (`webhookKey` no `PATCH /settings`).
- **Números novos são frágeis.** Volume alto para contatos que nunca interagiram é
  o caminho mais rápido para o bloqueio. Aqueça gradualmente.
