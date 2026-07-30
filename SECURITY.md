# Política de segurança

## Reportar uma vulnerabilidade

**Não abra issue pública** para falhas de segurança. Use
[Security Advisories](https://github.com/fillipearaujo92/elo/security/advisories/new)
ou escreva para o e-mail no perfil do mantenedor.

Inclua o que puder: como reproduzir, versão afetada e o impacto que você enxerga.
Respondo assim que possível — é um projeto mantido por uma pessoa, sem SLA.

## O que este projeto guarda

Rodar o ELO significa custodiar dados sensíveis. Vale saber exatamente o quê:

- **O pareamento do WhatsApp** (credenciais e chaves do protocolo Signal), no
  Postgres. Quem obtém esse banco consegue **se passar pelo número conectado**:
  ler e enviar mensagens. Trate-o como trata senhas.
- **`API_KEY`**: acesso total à API e ao painel — todas as sessões.
- **Mídia recebida**, em `MEDIA_DIR`, como cache de trânsito.

## Recomendações de operação

- **Não exponha o ELO na internet aberta.** Prefira rede interna, VPN ou um proxy
  reverso com TLS e restrição de origem.
- **`API_KEY` longa e aleatória** (`openssl rand -hex 32`). Ela é o único
  mecanismo de autenticação.
- **Não publique a porta do Postgres.** O `docker-compose.yml` já não publica.
- **Chave de webhook separada da `API_KEY`.** Por padrão o gateway usa a `API_KEY`
  como `X-Webhook-Key`; se o destino do webhook for de terceiros, configure uma
  chave própria para não entregar a credencial mestra a ele.
- **Backup do volume do Postgres** — sem ele, perder o volume é perder o
  pareamento de todas as sessões.
- **Uma instância por sessão.** Não há coordenação entre réplicas: duas
  instâncias com o mesmo banco derrubam o pareamento.

## Decisões conscientes de design

Duas escolhas parecem falhas e não são — estão documentadas no código:

- **`/api/files/*` é público** (sem `X-Api-Key`). Os nomes de arquivo são
  aleatórios (timestamp + 6 bytes) e não-adivinháveis. Isso permite ao consumidor
  do webhook baixar a mídia sem espalhar a credencial mestra. Quem tiver a URL
  exata acessa o arquivo — o trade-off é intencional.
- **O painel é servido sem autenticação**, mas é HTML estático: pede a chave num
  formulário e só então consome a API (que segue protegida). Nenhum dado sensível
  está na página.

## Versões

Correções de segurança vão para a linha mais recente. O projeto está em `0.x`: a
API pode mudar entre versões menores.
