# Dockerfile — build multi-stage.
#
# Alpine + Node 22 (LTS). O Baileys nao precisa de Chromium (diferente do WAHA com
# engine WEBJS, que carrega um navegador inteiro) — a imagem fica na casa das
# centenas de MB em vez de mais de 1 GB.

FROM node:22-alpine AS build
WORKDIR /app

# Camada de dependencias separada: package*.json muda menos que o codigo, entao o
# npm ci fica em cache entre builds.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# O tsc nao copia arquivos nao-TS: schema.sql (lido no boot) e o HTML do painel.
RUN cp src/db/schema.sql dist/db/schema.sql \
 && mkdir -p dist/ui && cp src/ui/dashboard.html dist/ui/dashboard.html

# Reinstala so as dependencias de producao para copiar um node_modules enxuto.
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

# ffmpeg: o backend transcoda audio antes de enviar, mas manter aqui permite
# normalizar audio no gateway se precisarmos (fase 2). tini: reaping de zumbis e
# repasse correto de SIGTERM, para o shutdown gracioso fechar os sockets.
RUN apk add --no-cache tini ffmpeg

ENV NODE_ENV=production
# Diretorio de midia: montar volume aqui (cache de transito, ver src/core/media.ts).
ENV MEDIA_DIR=/data/media

# Commit da imagem, exposto em GET /health e no painel. O deploy passa
# --build-arg COMMIT_SHA=...; sem o ARG/ENV abaixo o argumento era ACEITO e
# descartado em silencio, e o painel nao tinha como dizer qual codigo esta no ar.
ARG COMMIT_SHA=""
ENV COMMIT_SHA=$COMMIT_SHA

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Roda sem privilegio. O usuario `node` ja existe na imagem oficial.
RUN mkdir -p /data/media && chown -R node:node /data
USER node

EXPOSE 3000

# Health check do proprio container: valida app + banco (GET /health faz SELECT 1).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
