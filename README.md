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
| **Recebimento** | webhook com mídia baixada e servida por URL própria |
| **Confirmações** | enviado → entregue → lido, e falha (ack `-1`) |
| **Reações** | envio e recebimento, como evento próprio |
| **Reply** | citar mensagem anterior |
| **Multi-sessão** | vários números no mesmo processo |
| **Painel web** | QR com contagem regressiva, status, diagnóstico ao vivo (SSE), configuração |
| **Sobrevive a restart** | o pareamento fica no Postgres — reiniciar não pede QR de novo |
| **Filtros** | ignorar grupos, status/stories, canais, listas de transmissão |
| **Identidade do contato** | resolve o LID (id oculto) para o telefone real |

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

Endpoints de envio: `sendText`, `sendImage`, `sendVideo`, `sendVoice`, `sendFile`, `sendReaction`.

Para **áudio de voz** (aparecer como gravação, não como arquivo), envie em `audio/ogg; codecs=opus` via `sendVoice` — é o único formato que o WhatsApp entrega como voice note.

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
| `POST` | `/api/sendText` … | envio |
| `GET` | `/api/contacts/check-exists` | o número tem WhatsApp? |
| `GET` | `/api/{s}/lids/{lid}` | resolve id oculto → telefone |
| `GET` | `/api/stats` | contadores por sessão |
| `GET` | `/api/events` | diagnóstico ao vivo (SSE) |
| `GET` | `/health` | saúde (valida o banco), versão e commit |

`/health` é público; o resto exige a chave. `/api/files/*` também é aberto — os nomes de arquivo são aleatórios e não-adivinháveis, decisão consciente para o consumidor baixar a mídia sem espalhar a credencial.

## Notas operacionais

**O volume do Postgres é o pareamento.** Apagá-lo obriga a escanear o QR de novo em todas as sessões. Inclua-o no seu backup.

**Uma sessão aceita um socket.** O ELO roda hoje em **réplica única** — não há coordenação entre instâncias, então duas réplicas subiriam a mesma sessão e derrubariam o pareamento. Rode uma só.

**Números novos são frágeis.** Contas recém-criadas que começam enviando para muitos contatos frios são restringidas rápido. Aqueça: converse pelo aplicativo primeiro, aumente o volume gradualmente.

**Compatibilidade com a API do WAHA.** A superfície REST foi desenhada para ser compatível com a do [WAHA](https://waha.devlike.pro/), então quem já integra com ele normalmente só troca a URL base. O `engine` reportado é `BAILEYS`.

## Desenvolvimento

```bash
npm ci
npm run dev          # watch
npm test             # 212 testes
npm run typecheck
```

A suíte cobre o que quebrou em produção de verdade: progressão de ACK, resolução de LID, entrega de webhook, tradução de payload, filtros de chat e a máscara de segredos. Vale ler os comentários — cada teste marcado com `REGRESSÃO` documenta um bug real e por que ele acontecia.

Os testes em `contract.test.ts` validam a integração com um consumidor específico e são **skippados** por padrão.

## Licença

[MIT](LICENSE) — Fillipe Araújo.

Não afiliado ao WhatsApp Inc. ou Meta. "WhatsApp" é marca registrada da Meta Platforms, Inc.
