# syntax=docker/dockerfile:1
#
# AgentCore — imagem de produção.
# Node 22 (Alpine) + pnpm via Corepack. O app roda via `tsx` (sem etapa de
# build/dist), então esta imagem apenas instala dependências e copia o
# código-fonte. As duas camadas ficam separadas para aproveitar o cache do
# Docker: a reinstalação de deps só acontece quando package.json ou
# pnpm-lock.yaml mudam.

FROM node:22-alpine

# Habilita o pnpm (empacotado com o Node via Corepack). Versão alinhada ao
# lockfileVersion 9.0 do pnpm-lock.yaml deste projeto.
RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# --- Camada de dependências ---
# Copia só os manifests primeiro. O `pnpm-lock.yaml*` (com *) torna o arquivo
# opcional no COPY: se não existir no contexto de build, não quebra.
COPY package.json pnpm-lock.yaml* ./

RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm install --frozen-lockfile; \
    else \
      echo "[Dockerfile] pnpm-lock.yaml não encontrado — rodando install sem lockfile." && \
      pnpm install; \
    fi

# --- Código-fonte ---
# Sem `pnpm build`: o runtime é o próprio `tsx` executando os .ts direto.
COPY --chown=node:node . .

# Usuário não-root (já existe na imagem oficial node:*-alpine, uid 1000)
USER node

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0

EXPOSE 8787

# Sem curl/wget no Alpine por padrão — usa o fetch nativo do Node 22.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "start"]
