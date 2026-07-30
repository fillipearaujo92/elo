# Contribuindo

Obrigado pelo interesse. Este é um projeto pequeno, mantido por uma pessoa — então
algumas expectativas antes de investir seu tempo.

## Antes de abrir um PR

**Abra uma issue primeiro** para mudanças que não sejam correção óbvia. Evita você
escrever código que não será integrado por não caber no escopo.

Escopo do ELO: ser um gateway WhatsApp confiável com API REST e painel de operação.
Coisas que provavelmente **não** entram: chatbot/fluxos de conversa, integrações com
CRMs específicos, e qualquer facilitador de disparo em massa.

## Rodando o projeto

```bash
npm ci
cp .env.example .env     # preencha API_KEY e DATABASE_URL
npm run dev              # watch
npm test
npm run typecheck
```

Precisa de um Postgres. O jeito rápido:

```bash
docker compose up -d db
```

## O que espero de um PR

**Testes para o comportamento que você mudou.** A suíte é a rede de proteção deste
projeto: ela pegou a migração da Baileys 6→7 inteira sem quebrar o contrato. Se o
seu PR corrige um bug, o teste deve **falhar antes** e passar depois.

**Comentários que explicam o *porquê*, não o *o quê*.** O código do repo segue esse
padrão: quando há uma decisão não-óbvia, o comentário diz qual armadilha ela evita —
frequentemente citando o arquivo e a linha da biblioteca que justificam a escolha.
Comentário que narra o código (`// incrementa o contador`) é ruído.

**Escopo enxuto.** Um assunto por PR. Refatoração e correção juntas são difíceis de
revisar.

**Sem quebrar a compatibilidade da API** sem discussão prévia — há gente com
integração em produção.

## Checklist

```bash
npm run typecheck   # zero erros
npm test            # tudo verde
```

Se mexeu no painel (`src/ui/dashboard.html`), abra no navegador e confira nos dois
temas (claro e escuro) — ele é HTML/CSS/JS inline, sem build, então nada valida isso
automaticamente.

## Relatando bugs

O que realmente ajuda:

- versão do ELO (aparece no painel e em `GET /health`)
- o que você esperava e o que aconteceu
- logs relevantes (`docker compose logs elo`) — **mascare a `API_KEY` e telefones**
- se envolve mensagem: o tipo (texto/imagem/áudio), 1:1 ou grupo

## Sobre a Baileys

O protocolo do WhatsApp muda sem aviso e a [Baileys](https://github.com/WhiskeySockets/Baileys)
corre atrás. Se algo parou de funcionar de um dia para o outro sem você mudar nada,
verifique se há release nova da Baileys antes de abrir issue aqui — pode ser upstream.
