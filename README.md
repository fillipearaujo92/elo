# ELO

Gateway WhatsApp auto-hospedado. Conecta um número via QR code e expõe uma **API REST** para enviar e receber mensagens, além de um **painel web** para operar as sessões.

Roda no seu servidor. O pareamento fica no seu Postgres — nenhum dado passa por serviço de terceiros.

```
seu sistema  ──HTTP──▶  ELO  ──▶  WhatsApp
             ◀─webhook──
```

> ### ⚠️ Leia antes de usar
>
> O ELO usa a [Baileys](https://github.com/WhiskeySockets/Baileys), uma biblioteca **não-oficial** que fala o protocolo do WhatsApp Web. **Não é** um produto aprovado, endossado ou suportado pelo WhatsApp/Meta.
>
> - **Seu número pode ser banido.** O WhatsApp restringe e bane contas que detecta como automação, especialmente números novos ou com alto volume de envio para contatos que não interagiram antes.
> - **Não use para disparo em massa, spam ou mensagens não solicitadas.** Além de ser o caminho mais rápido para o ban, viola os Termos de Serviço do WhatsApp.
> - Para uso comercial em escala, o caminho oficial é a [WhatsApp Business Platform (Cloud API)](https://developers.facebook.com/docs/whatsapp/cloud-api).
> - Software fornecido **sem garantia** (ver [LICENSE](LICENSE)). O risco do uso é seu.
>
> Casos de uso razoáveis: atendimento humano assistido, notificações para quem optou por recebê-las, integração com CRM próprio, automação pessoal.

## Recursos

| | |
|---|---|
| **Mensagens** | texto, imagem, vídeo, áudio/voz (PTT), documento, figurinha |
| **Múltiplos arquivos** | vários numa chamada, legenda por item, ordem preservada |
| **Álbum** | imagens/vídeos agrupados numa bolha única |
| **Recebimento** | webhook com mídia baixada e servida por URL própria |
| **Confirmações** | enviado → entregue → lido, e falha (ack `-1`) |
| **Reações** | envio e recebimento, como evento próprio |
| **Reply** | citar mensagem anterior |
| **Editar** | corrigir o texto de mensagem já enviada |
| **Apagar** | apagar para todos (revoke) |
| **Encaminhar** | compartilhar mensagem com outro chat |
| **Reenviar** | reenviar no mesmo chat após falha de entrega |
| **Multi-sessão** | vários números no mesmo processo |
| **Painel web** | QR com contagem regressiva, status, diagnóstico ao vivo (SSE), configuração |
| **Sobrevive a restart** | o pareamento fica no Postgres — reiniciar não pede QR de novo |
| **Filtros** | ignorar grupos, status/stories, canais, listas de transmissão |
| **Identidade do contato** | resolve o LID (id oculto) para o telefone real |
| **Presença** | "digitando…", "gravando…", online/offline, visto por último |
| **Marcar como lida** | tiques azuis, várias mensagens numa chamada |
| **Métricas** | Prometheus: perda de mensagem, ACK falho, sessão caída |

## Instalação

### Docker (recomendado)

```bash
git clone https://github.com/fillipearaujo92/elo.git
cd elo
cp .env.example .env
```

Edite o `.env` — no mínimo:

```bash
API_KEY=<gere com: openssl rand -hex 32>
POSTGRES_PASSWORD=<uma senha qualquer>
```

Suba:

```bash
docker compose up -d
```

Abra <http://localhost:3000>, informe a `API_KEY` e crie a primeira sessão. Escaneie o QR pelo WhatsApp (**Aparelhos conectados → Conectar aparelho**).

> Se o gateway precisa ser alcançado por outra máquina, defina `PUBLIC_URL` no `.env` com o endereço real (ex.: `http://192.168.1.50:3000`). Ele entra nos links de mídia enviados nos webhooks.

### Sem Docker

Requisitos: **Node 22+** e **Postgres 14+**.

```bash
npm ci
cp .env.example .env      # preencha API_KEY e DATABASE_URL
npm run build
npm start                 # o schema é criado no primeiro boot
```

## Uso

Toda rota exige o header `X-Api-Key`.

**Criar a sessão e obter o QR**

```bash
curl -X POST http://localhost:3000/api/sessions \
  -H 'X-Api-Key: SUA_CHAVE' -H 'Content-Type: application/json' \
  -d '{"name":"Atendimento","start":true,
       "config":{"webhooks":[{"url":"https://seu-sistema/webhook","events":["message","message.ack","session.status"]}]}}'

# QR em PNG (base64 no JSON, ou imagem binária sem o Accept)
curl http://localhost:3000/api/atendimento/auth/qr \
  -H 'X-Api-Key: SUA_CHAVE' -H 'Accept: application/json'
```

O nome é **livre** (espaços, acentos, emoji). O ELO deriva um id técnico seguro: `"Atendimento — Loja 🏬"` → `atendimento-loja`. Use esse id nas outras chamadas; o painel mostra os dois.

**Enviar**

```bash
# texto
curl -X POST http://localhost:3000/api/sendText \
  -H 'X-Api-Key: SUA_CHAVE' -H 'Content-Type: application/json' \
  -d '{"session":"atendimento","chatId":"5511999999999@c.us","text":"Olá!"}'

# imagem (base64 ou url)
curl -X POST http://localhost:3000/api/sendImage \
  -H 'X-Api-Key: SUA_CHAVE' -H 'Content-Type: application/json' \
  -d '{"session":"atendimento","chatId":"5511999999999@c.us",
       "caption":"Confira","file":{"url":"https://exemplo.com/foto.jpg"}}'
```

Endpoints de envio: `sendText`, `sendImage`, `sendVideo`, `sendVoice`, `sendFile`, `sendSticker`, `sendMedia`, `sendReaction`.

Para **áudio de voz** (aparecer como gravação, não como arquivo), envie em `audio/ogg; codecs=opus` via `sendVoice` — é o único formato que o WhatsApp entrega como voice note.

**Vários arquivos numa chamada**

`sendMedia` envia N mídias de uma vez, cada uma com sua legenda. Os envios são **serializados**, então a ordem que você pede é a ordem que o contato vê — o que não acontece disparando requisições em paralelo.

```bash
curl -X POST http://localhost:3000/api/sendMedia \
  -H 'X-Api-Key: SUA_CHAVE' -H 'Content-Type: application/json' \
  -d '{
    "session":"atendimento","chatId":"5511999999999@c.us",
    "album": true,
    "items":[
      {"file":{"url":"https://exemplo.com/1.jpg"},"caption":"Frente"},
      {"file":{"url":"https://exemplo.com/2.jpg"},"caption":"Lateral"},
      {"file":{"url":"https://exemplo.com/manual.pdf","filename":"manual.pdf"},
       "caption":"Especificações"}
    ]}'
```

`album: true` agrupa imagens e vídeos numa **bolha única** (recurso nativo do WhatsApp). Documentos e áudios não entram no álbum — vão como mensagens próprias, na mesma chamada.

A resposta traz um id por item, na ordem enviada, para você casar o ACK de cada um:

```json
{ "id": "true_...", "count": 3, "album": true,
  "messages": [{ "id": "true_..." }, { "id": "true_..." }, { "id": "true_..." }] }
```

Por item: `caption`, `asDocument` (forçar anexo mesmo sendo imagem) e `asVoice`. Sem `caption` no item, vale a `caption` da chamada — aplicada ao primeiro, que é como o WhatsApp mostra a legenda de um álbum. O tipo é escolhido pelo `mimetype`; desconhecido vira documento.

Se **qualquer** arquivo for inválido, nada é enviado e a resposta diz qual item falhou — evita deixar metade entregue e o contato receber duplicado no reenvio. Máximo de 30 itens por chamada.

Os endpoints `sendImage`, `sendVideo` e `sendFile` também aceitam `files: [...]` com o mesmo efeito, para quem já integra não precisar trocar de rota.

**Operar sobre uma mensagem já enviada**

```bash
# editar o texto (o WhatsApp permite ~15 min, só mensagem própria)
curl -X POST http://localhost:3000/api/editMessage -H 'X-Api-Key: SUA_CHAVE'   -H 'Content-Type: application/json'   -d '{"session":"atendimento","messageId":"true_5511999999999@c.us_3EB0…","text":"Corrigido"}'

# apagar para todos
curl -X POST http://localhost:3000/api/deleteMessage -H 'X-Api-Key: SUA_CHAVE'   -H 'Content-Type: application/json'   -d '{"session":"atendimento","messageId":"true_5511999999999@c.us_3EB0…"}'

# encaminhar para outro chat
curl -X POST http://localhost:3000/api/forwardMessage -H 'X-Api-Key: SUA_CHAVE'   -H 'Content-Type: application/json'   -d '{"session":"atendimento","messageId":"true_…_3EB0…","to":"5511888888888@c.us"}'

# reenviar no mesmo chat (após falha de entrega)
curl -X POST http://localhost:3000/api/resendMessage -H 'X-Api-Key: SUA_CHAVE'   -H 'Content-Type: application/json'   -d '{"session":"atendimento","messageId":"true_…_3EB0…"}'
```

`messageId` aceita o id serializado (`true_<chat>_<raw>`) ou o id cru junto com
`chatId`. Aceita também ids de mensagens **recebidas** — para apagar a sua própria
resposta num chat, por exemplo.

Limites que são **do WhatsApp**, não do ELO:

- **editar**: só mensagem própria, apenas texto/legenda (não troca a mídia), e a
  janela é de ~15 minutos. Passado o prazo, o servidor ignora sem devolver erro.
- **apagar para todos**: também tem prazo, e o WhatsApp não sinaliza quando expira —
  por isso a resposta diz que a mensagem *pode* permanecer no aparelho do contato,
  em vez de afirmar sucesso.
- **encaminhar/reenviar** precisam do **conteúdo** da mensagem, não só do id. O ELO
  guarda o que ele mesmo enviou (por `SENT_MESSAGES_RETENTION_DAYS`, 7 dias). Para
  encaminhar uma mensagem **recebida** de um contato, passe o conteúdo em `message`:

  ```json
  {"session":"atendimento","to":"5511888888888@c.us",
   "message":{"conversation":"texto a encaminhar"}}
  ```

  Sem isso, a resposta é 404 explicando o que fazer — em vez de falhar sem motivo claro.

**Receber**

O ELO faz `POST` no seu webhook com `{ event, session, payload }`:

```json
{
  "event": "message",
  "session": "atendimento",
  "payload": {
    "id": "false_5511999999999@c.us_3EB0...",
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

Eventos: `message` (recebida), `message.ack` (confirmação de entrega/leitura), `session.status` (conexão). Se a mensagem tem mídia, vem `media.url` para você baixar. Falha na entrega é retentada (padrão 15× a cada 2s, configurável); respostas 4xx não são retentadas.

`payload.id` é estável e serve como chave de idempotência — o WhatsApp pode reentregar o mesmo evento.

## API

| Método | Rota | O quê |
|---|---|---|
| `POST` | `/api/sessions` | cria (e inicia) |
| `GET` | `/api/sessions` | lista (segredos mascarados) |
| `GET` | `/api/sessions/{s}` | status, número pareado |
| `PATCH` | `/api/sessions/{s}/settings` | webhook, eventos, filtros, auto-start |
| `POST` | `/api/sessions/{s}/restart` \| `/stop` | ciclo de vida |
| `DELETE` | `/api/sessions/{s}` | apaga sessão e pareamento |
| `GET` | `/api/{s}/auth/qr` | QR (PNG) |
| `POST` | `/api/sendText` … | envio de um item |
| `POST` | `/api/sendMedia` | vários arquivos / álbum |
| `POST` | `/api/editMessage` | edita o texto |
| `POST` | `/api/deleteMessage` | apaga para todos |
| `POST` | `/api/forwardMessage` | encaminha para outro chat |
| `POST` | `/api/resendMessage` | reenvia no mesmo chat |
| `GET` | `/api/contacts/check-exists` | o número tem WhatsApp? |
| `GET` | `/api/{s}/lids/{lid}` | resolve id oculto → telefone |
| `GET` | `/api/stats` | contadores por sessão |
| `GET` | `/api/events` | diagnóstico ao vivo (SSE) |
| `POST` | `/api/typing` | "digitando…" / "gravando…" |
| `POST` | `/api/presence` | online/offline, por chat ou global |
| `POST` | `/api/markAsRead` | marca como lida |
| `GET` | `/api/presence/{chatId}` | visto por último do contato |
| `GET` | `/metrics` | métricas Prometheus |
| `GET` | `/health` | saúde (valida o banco), versão e commit |

`/health` é público; o resto exige a chave. `/api/files/*` também é aberto — os nomes de arquivo são aleatórios e não-adivinháveis, decisão consciente para o consumidor baixar a mídia sem espalhar a credencial.

## Presença: parecer humano

```bash
# "digitando…" por 8s (o ELO renova sozinho; o WhatsApp expira em ~10s)
curl -X POST http://localhost:3000/api/typing -H 'X-Api-Key: SUA_CHAVE'   -H 'Content-Type: application/json'   -d '{"session":"atendimento","chatId":"5511999999999@c.us","duration":8000}'

# "gravando áudio…"
#   -d '{"session":"…","chatId":"…","kind":"recording","duration":5000}'

# marcar como lida (tiques azuis)
curl -X POST http://localhost:3000/api/markAsRead -H 'X-Api-Key: SUA_CHAVE'   -H 'Content-Type: application/json'   -d '{"session":"atendimento","chatId":"5511999999999@c.us",
       "messageIds":["false_5511999999999@c.us_3EB0…"]}'
```

A requisição do `typing` responde **na hora** — a renovação corre em background,
porque prender o handler por 20s esgotaria conexões num atendimento movimentado.

O contato "digitando" chega a você pelo evento `presence.update` no webhook.

**Visto por último** depende da privacidade do contato: se ele restringe, o WhatsApp
simplesmente não envia o dado — e é recíproco (quem esconde o seu também não vê o dos
outros). Nesse caso o ELO devolve `available: false` com a explicação, em vez de
fingir que a informação existe.

## Observabilidade

`GET /metrics` expõe métricas no formato Prometheus. Os quatro sinais que importam:

```
elo_inbound_undecryptable_total  > 0   perdendo mensagem AGORA
elo_webhook_lost_total           > 0   evento nunca alcançou seu sistema
elo_ack_failed_total             > 0   mensagem saiu e não foi entregue
elo_session_up{session="…"}      = 0   sessão caída
```

Isto existe por um motivo concreto: um bug de criptografia derrubou todo o
recebimento e **só foi descoberto quando alguém mandou uma mensagem e notou a
ausência** — o gateway já registrava os descartes no log e não avisava ninguém.
Falha silenciosa é o pior modo de falha de um gateway, e é o que esses contadores
tornam visível.

Exemplo de alerta (Prometheus):

```yaml
- alert: EloPerdendoMensagem
  expr: increase(elo_inbound_undecryptable_total[10m]) > 0
  annotations:
    summary: "ELO nao esta decifrando mensagens em {{ $labels.session }}"

- alert: EloSessaoCaida
  expr: elo_session_up == 0
  for: 5m
```

`/metrics` exige a `X-Api-Key`: os nomes das sessões são rótulos, e nome de sessão
costuma identificar cliente.

## Notas operacionais

**O volume do Postgres é o pareamento.** Apagá-lo obriga a escanear o QR de novo em todas as sessões. Inclua-o no seu backup.

**Uma sessão aceita um socket.** O ELO roda hoje em **réplica única** — não há coordenação entre instâncias, então duas réplicas subiriam a mesma sessão e derrubariam o pareamento. Rode uma só.

**Números novos são frágeis.** Contas recém-criadas que começam enviando para muitos contatos frios são restringidas rápido. Aqueça: converse pelo aplicativo primeiro, aumente o volume gradualmente.

**Compatibilidade com a API do WAHA.** A superfície REST foi desenhada para ser compatível com a do [WAHA](https://waha.devlike.pro/), então quem já integra com ele normalmente só troca a URL base. O `engine` reportado é `BAILEYS`.

## Desenvolvimento

```bash
npm ci
npm run dev          # watch
npm test             # 240 testes
npm run typecheck
```

A suíte cobre o que quebrou em produção de verdade: progressão de ACK, resolução de LID, entrega de webhook, tradução de payload, filtros de chat e a máscara de segredos. Vale ler os comentários — cada teste marcado com `REGRESSÃO` documenta um bug real e por que ele acontecia.

Os testes em `contract.test.ts` validam a integração com um consumidor específico e são **skippados** por padrão.

## Licença

[MIT](LICENSE) — Fillipe Araújo.

Não afiliado ao WhatsApp Inc. ou Meta. "WhatsApp" é marca registrada da Meta Platforms, Inc.
