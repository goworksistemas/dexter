# syntax=docker/dockerfile:1
#
# Dexter web — build Vite + nginx (proxy /api → agentcore).

FROM node:22-alpine AS build

LABEL org.opencontainers.image.source="https://github.com/goworksistemas/dexter"
LABEL org.opencontainers.image.description="Dexter Web"

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm install --frozen-lockfile; \
    else \
      pnpm install; \
    fi

COPY . .

# Variáveis públicas do Vite (bake no build).
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
# Em prod o nginx faz proxy de /api — URL relativa basta.
ARG VITE_AGENTCORE_URL=
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_AGENTCORE_URL=$VITE_AGENTCORE_URL

RUN pnpm build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
