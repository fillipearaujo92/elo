# Guia de integração

Este guia é para quem vai plugar o ELO num sistema de atendimento próprio. Cobre o
caminho completo — subir, receber, enviar, monitorar — e termina com uma tabela dos
erros que você vai encontrar, com a causa de cada um.

Se você só quer conectar um número e usar o painel, o [README](../README.pt-BR.md)
basta. Volte aqui quando for escrever código contra a API.

**Antes de começar:** o ELO fala WhatsApp por uma biblioteca não-oficial. Não existe
garantia de estabilidade, e o número pode ser banido. Não use em número que você não
pode perder. Ver [SECURITY.md](../SECURITY.md).

---

## 1. Subir

Com Docker, são duas variáveis e um comando:

```bash
git clone https://github.com/fillipearaujo92/elo.git && cd elo
cp .env.example .env

# API_KEY: gere uma aleatória. É a credencial de tudo.
openssl rand -hex 32
# Preencha API_KEY e POSTGRES_PASSWORD no .env, depois:

docker compose up -d
```

O Postgres sobe junto, num volume próprio. O schema é aplicado no boot — não há passo
de migração manual.

Confira que está no ar:

```bash
curl localhost:3000/health
# {"status":"ok","engine":"BAILEYS","version":"0.1.0","commit":"..."}
```

`/health` valida o banco, não só o processo: um gateway que perdeu o Postgres não
consegue restaurar sessão nem gravar credenciais, e não está saudável mesmo que o
processo responda.

**A chave vai no header `X-Api-Key`, em todas as rotas.** Só `/health`, `/healthz`, o
painel, `/docs` e o download de mídia dispensam.

```bash
curl -H "X-Api-Key: SUA_CHAVE" localhost:3000/api/sessions
```

### Fixe a versão em produção

O `docker-compose.yml` usa `ELO_TAG` (padrão `latest`). Em produção, fixe:

```bash
# no .env
ELO_TAG=0.1.0
```

`latest` muda sob os seus pés no próximo release. As versões disponíveis estão em
[ghcr.io](https://github.com/fillipearaujo92/elo/pkgs/container/elo).

### Atualizar

```bash
# 1. faça backup do pareamento ANTES (ver seção 5)
curl -H "X-Api-Key: SUA_CHAVE" localhost:3000/api/backup -o elo-backup.json

# 2. troque ELO_TAG no .env, então:
docker compose pull && docker compose up -d
```

O schema é **aditivo**: colunas novas são criadas no boot, nenhuma é removida ou
renomeada. Isso significa que voltar para uma versão anterior do código é seguro — ele
ignora as colunas que não conhece. O contrário não vale: **não há rollback de schema**.

---

## 2. Criar a sessão e conectar o número

Uma "sessão" é um número de WhatsApp. Você pode ter várias no mesmo gateway.

```bash
curl -X POST localhost:3000/api/sessions \
  -H "X-Api-Key: SUA_CHAVE" -H 'Content-Type: application/json' \
  -d '{
    "name": "atendimento",
    "start": true,
    "config": {
      "webhooks": [{
        "url": "https://seu-sistema.com/webhook/elo",
        "events": ["message", "message.ack", "session.status"],
        "customHeaders": [{ "name": "X-Webhook-Key", "value": "UM_SEGREDO_SEU" }]
      }]
    }
  }'
```

Três coisas nesse corpo merecem atenção:

- **`events` explícito.** Lista vazia ou ausente significa "assine tudo", e versões
  futuras podem emitir eventos que o seu código não trata. Declare o que você quer.
- **`customHeaders` com uma chave própria.** É assim que o seu endpoint confirma que a
  chamada veio do ELO. **Use um segredo diferente da `API_KEY`** — quem recebe o
  webhook não precisa poder controlar o gateway.
- **`name` é o identificador técnico.** Só letras, números, `-` e `_`.

Pegue o QR e escaneie com o aparelho:

```bash
curl -H "X-Api-Key: SUA_CHAVE" localhost:3000/api/atendimento/auth/qr
# {"mimetype":"image/png","data":"iVBORw0KG..."}   ← PNG em base64
```

O QR expira em ~20 segundos e é regenerado sozinho. O painel (`/dashboard`) mostra isso
com um anel de validade e detecta o pareamento — é mais fácil que fazer polling na API.

Quando pareado, `GET /api/sessions/atendimento` traz `status: "WORKING"` e `me.id` com
o número conectado.

---

## 3. Receber mensagens

O ELO faz `POST` no seu webhook com `{ event, session, payload }`. Um receptor mínimo:

```js
// Express. Qualquer framework serve — o que importa são as três regras abaixo.
import express from 'express';

const app = express();
app.use(express.json({ limit: '10mb' }));   // payload de mídia é maior que o default

const CHAVE = process.env.ELO_WEBHOOK_KEY;
const vistos = new Set();                    // em produção: Redis, ou UNIQUE no banco

app.post('/webhook/elo', (req, res) => {
  // REGRA 1 — confira a chave e responda 200 IMEDIATAMENTE, antes de processar.
  // O ELO tem timeout de 20s; se você processar antes de responder, ele considera
  // falha e reentrega, e você processa duas vezes.
  if (req.get('X-Webhook-Key') !== CHAVE) return res.sendStatus(401);
  res.sendStatus(200);

  const { event, session, payload } = req.body;

  // REGRA 2 — deduplique por payload.id. O WhatsApp pode reentregar o MESMO evento,
  // e o ELO retenta em falha de rede. O id é estável e serve de chave de idempotência.
  if (event === 'message') {
    if (vistos.has(payload.id)) return;
    vistos.add(payload.id);
  }

  // REGRA 3 — trate cada evento e nunca deixe exceção escapar. Você já respondeu 200;
  // um erro aqui perde o evento em silêncio se não for logado.
  try {
    switch (event) {
      case 'message':
        // payload.fromMe = true significa ECO: mensagem que saiu do próprio número
        // (pelo app do celular, ou enviada por você via API). Ignore se não quiser
        // duplicar o que você mesmo mandou.
        if (payload.fromMe) return;
        console.log(`[${session}] ${payload.from}: ${payload.body}`);
        // Mídia: baixe payload.media.url e guarde no SEU storage (ver abaixo).
        break;

      case 'message.ack':
        // ack: 1=enviada 2=entregue 3/4=lida -1=FALHOU
        console.log(`[${session}] ${payload.id} -> ack ${payload.ack}`);
        break;

      case 'session.status':
        // 'WORKING' conectada; 'SCAN_QR_CODE' precisa de QR novo (ação humana);
        // 'FAILED'/'STOPPED' caiu — o ELO tenta reconectar sozinho.
        console.log(`[${session}] status ${payload.status}`);
        break;
    }
  } catch (err) {
    console.error('falha ao processar webhook', err);
  }
});

app.listen(4000);
```

### Mídia é de trânsito

Quando a mensagem tem mídia, o payload traz `media.url`. **Baixe e guarde no seu
storage.** O diretório de mídia do ELO é cache de passagem, não arquivo permanente.

A URL de mídia **não exige a `API_KEY`** — ela é feita para ser consumida por quem
exibe a imagem (o navegador do seu atendente, por exemplo) e o nome do arquivo é
aleatório. Trate-a como um link não listado: quem tiver a URL exata acessa.

### Teste o webhook antes de depender dele

```bash
curl -X POST -H "X-Api-Key: SUA_CHAVE" \
  localhost:3000/api/sessions/atendimento/test-webhook
```

Devolve `status`, tempo de resposta, o começo do corpo e um `hint` com o diagnóstico —
401 quase sempre é chave divergente, 404 é rota errada no seu lado.

---

## 4. Enviar

O destino aceita o número com ou sem `@c.us`:

```bash
# texto
curl -X POST localhost:3000/api/sendText \
  -H "X-Api-Key: SUA_CHAVE" -H 'Content-Type: application/json' \
  -d '{"session":"atendimento","chatId":"5511999999999","text":"Olá!"}'

# imagem por URL, com legenda
curl -X POST localhost:3000/api/sendImage \
  -H "X-Api-Key: SUA_CHAVE" -H 'Content-Type: application/json' \
  -d '{"session":"atendimento","chatId":"5511999999999",
       "file":{"url":"https://exemplo.com/foto.jpg"},"caption":"a planta"}'

# vários arquivos numa chamada, cada um com sua legenda
curl -X POST localhost:3000/api/sendMedia \
  -H "X-Api-Key: SUA_CHAVE" -H 'Content-Type: application/json' \
  -d '{"session":"atendimento","chatId":"5511999999999","album":true,
       "files":[{"url":"https://exemplo.com/1.jpg","caption":"frente"},
                {"url":"https://exemplo.com/2.jpg","caption":"fundos"}]}'
```

A resposta traz o `id` da mensagem — guarde-o: é por ele que os `message.ack` chegam,
e é o que você passa para editar, apagar, reagir ou encaminhar.

**`file.url` tem de ser um endereço público.** O gateway recusa rede privada, loopback
e link-local, porque essa URL vem de quem chama a API e alcançaria serviços internos e
as credenciais da instância. Se a sua origem de mídia é interna de propósito, ligue
`ALLOW_PRIVATE_FETCH=1`. Alternativa sem abrir nada: mande o arquivo em `file.data`
(base64).

### Áudio como voice note

`sendVoice` espera **ogg/opus**. Áudio gravado no navegador costuma vir em `webm`, e o
WhatsApp aceita o upload mas **não entrega** — falha silenciosa, sem erro. Transcodifique
antes:

```bash
ffmpeg -i entrada.webm -c:a libopus -b:a 32k -ar 48000 -ac 1 saida.ogg
```

---

## 5. Monitorar e fazer backup

### Os quatro sinais que importam

`GET /metrics` expõe métricas Prometheus. Alerte nestes:

```
elo_inbound_undecryptable_total  > 0   perdendo mensagem AGORA
elo_webhook_lost_total           > 0   evento nunca alcançou o seu sistema
elo_ack_failed_total             > 0   mensagem saiu e não foi entregue
elo_session_up{session="..."}    = 0   sessão caída
```

`/metrics` **exige a chave** — o nome da sessão identifica cliente.

### Backup do pareamento

```bash
curl -H "X-Api-Key: SUA_CHAVE" localhost:3000/api/backup -o elo-backup.json
```

O arquivo contém as **chaves de criptografia** das sessões. Quem o tiver consegue se
passar pelo seu número, e você não tem como perceber. Guarde como guardaria uma senha:
não mande por e-mail, não deixe em pasta compartilhada.

Faça backup antes de atualizar de versão e depois de parear um número novo.

---

## 6. Erros comuns, e a causa de cada um

Todo erro devolve `{ message }`; alguns já trazem `code` e `hint`.

| Código | `message` / situação | Causa e o que fazer |
|---|---|---|
| **401** | `falta o header X-Api-Key` | Você não mandou o header. Use o valor de `API_KEY` do `.env`. |
| **401** | `chave invalida no header X-Api-Key` | Valor divergente. Confira espaços em branco e se o `.env` foi recarregado (o container precisa reiniciar). |
| **429** | `muitas tentativas com chave invalida` | Mais de 10 respostas 401 no minuto, do mesmo IP — tratado como força bruta. Corrija a chave e espere um minuto. |
| **429** | `muitas requisicoes` | Passou de 300/min. Aumente `RATE_LIMIT_MAX` se o seu volume legítimo for maior. |
| **404** | `sessao nao encontrada` | O `session` do corpo não existe. Compare com `GET /api/sessions` — o nome é o identificador técnico, não o rótulo. |
| **422** | `sessao X nao esta conectada (status: ...)` | A sessão existe mas não está `WORKING`. `SCAN_QR_CODE` = precisa de QR novo (humano); `FAILED`/`STOPPED` = tente `POST /api/sessions/X/restart`. |
| **422** | `QR nao disponivel` (com `status`) | Leia o `status` que vem na resposta: `STOPPED` = a sessão nunca iniciou, chame `POST /api/sessions/X/start`; `STARTING` = espere alguns segundos e tente de novo; `WORKING` = já está conectada (use `restart` para trocar de número); `FAILED` = reinicie a sessão. |
| **422** | `URL bloqueada: ... (loopback / link-local / rede privada)` | A URL aponta para dentro da máquina ou para a rede interna. Use endereço público, ou `ALLOW_PRIVATE_FETCH=1` se for intencional. |
| **422** | `falha ao baixar file.url: HTTP 403` | O gateway não conseguiu buscar o arquivo. A URL precisa ser acessível **pelo servidor do ELO**, não só pelo seu navegador. |
| **422** | webhook responde com redirecionamento | O ELO não segue redirect (proteção contra SSRF). Aponte para a URL final. |
| **400** | `text e obrigatorio` | `sendText` sem texto. Para apagar uma mensagem use `/api/deleteMessage`. |
| **400** | `file.data nao e base64 valido` | Verifique se você mandou o prefixo `data:` junto por engano, ou se houve quebra de linha no base64. |
| **400** | `file precisa de url ou data` | Mande um dos dois dentro de `file`. |
| **413** | `file.url tem NMB; o limite e ...` | Arquivo maior que o teto. O WhatsApp também tem limite próprio, menor. |
| **404** | `sessao ... nao encontrada` em envio | O nome da sessão está errado ou a sessão foi removida. |
| **404** | em encaminhar/reenviar | O ELO só guarda o que **ele mesmo** enviou (7 dias). Para encaminhar uma mensagem recebida, passe o conteúdo em `message` — a resposta explica o formato. |
| **500** | `envio nao retornou id de mensagem` | O WhatsApp aceitou a conexão mas não confirmou a mensagem. Quase sempre sessão instável: veja `session.status` e o diagnóstico no painel. |

### Sintomas que não são erro HTTP

**Toda mensagem aparece duas vezes no meu sistema.** Você está processando o eco.
Mensagem que sai do próprio número volta como `message` com `fromMe: true` — inclusive
a que você enviou pela API. Filtre por `fromMe`, ou deduplique pelo `id` que a resposta
do envio devolveu.

**O webhook nunca chega.** Nessa ordem: (1) rode `test-webhook` e leia o `hint`;
(2) confira se o seu endpoint é alcançável **pela internet** — `localhost` na config do
webhook aponta para dentro do container, não para a sua máquina; (3) veja
`elo_webhook_lost_total` e a aba de diagnóstico do painel, que dizem se o ELO tentou e
foi rejeitado.

**A sessão cai e volta sozinha, repetidamente.** Normal em rede instável — o ELO
reconecta com espera crescente. Se esgotar as tentativas, ele para e emite um evento de
erro: aí precisa de `restart`. O painel distingue os dois casos.

**Áudio enviado não chega no destino.** Quase sempre formato: veja a seção de voice note.

**O número foi banido.** Não é problema do ELO nem se resolve com configuração. Número
novo disparando para contatos que nunca interagiram é o padrão que o WhatsApp pune.
Aqueça o número antes: conversas reais, volume crescendo devagar.

---

## Onde mais olhar

- **[/docs](http://localhost:3000/docs)** — Swagger UI da instalação, com "try it out".
- **[README](../README.pt-BR.md)** — visão geral, todas as rotas, notas operacionais.
- **[SECURITY.md](../SECURITY.md)** — modelo de ameaça e como reportar vulnerabilidade.
