# syntax=docker/dockerfile:1
#
# AgentCore — imagem de produção com Infisical CLI.
# Secrets vêm do vault em runtime (`infisical run`), não do compose.

FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/goworksistemas/dexter"
LABEL org.opencontainers.image.description="Dexter AgentCore API"

RUN corepack enable && corepack prepare pnpm@9 --activate

# Infisical CLI (Alpine)
RUN apk add --no-cache bash curl \
  && curl -1sLf 'https://dl.cloudsmith.io/public/infisical/infisical-cli/setup.alpine.sh' | bash \
  && apk add --no-cache infisical \
  && infisical --version

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./

RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm install --frozen-lockfile; \
    else \
      pnpm install; \
    fi

COPY --chown=node:node . .
RUN chmod +x /app/docker-entrypoint.sh

USER node

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
