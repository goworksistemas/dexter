# AgentCore — server

Backend (Fastify) dos super agentes de IA da GoWork (**Gabi** e **Dexter**).
Runtime de chat síncrono com streaming (SSE), tirando o hot path de conversa
do n8n. Especificação técnica completa (arquitetura, escala, segurança,
faseamento): [`../AGENTCORE_SPEC.md`](../AGENTCORE_SPEC.md).

## Stack

- **Node 22** / **TypeScript** (ESM, `"type": "module"`)
- **Fastify 5** — servidor HTTP
- Executado direto via **`tsx`** (sem etapa de build/`dist`) — em dev e em produção
- `@fastify/cors`, `@fastify/rate-limit`
- `@anthropic-ai/sdk` — LLM (Claude)
- `@supabase/supabase-js` — persistência (chats/mensagens/auditoria), acesso via service role
- `zod` — validação de config e payloads
- `pnpm` como gerenciador de pacotes

## Variáveis de ambiente

Fonte da verdade: [`.env.example`](./.env.example). Em produção os valores
vêm do **Infisical** (projeto `agentcore`); nunca commitar segredos reais.

| Variável | Obrigatória | Default | Descrição |
|---|---|---|---|
| `PORT` | não | `8787` | Porta HTTP do servidor |
| `HOST` | não | `0.0.0.0` | Host de bind |
| `LOG_LEVEL` | não | `info` | `fatal\|error\|warn\|info\|debug\|trace` |
| `CORS_ORIGINS` | não | `http://localhost:5273,http://localhost:5274` | Origens permitidas, separadas por vírgula |
| `ANTHROPIC_API_KEY` | **sim** | — | Chave da API Anthropic (chat real) |
| `ANTHROPIC_MODEL` | não | `claude-sonnet-5` | Modelo padrão (`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`, ...) |
| `SUPABASE_URL` | **sim** | — | URL do projeto Supabase `agentcore` |
| `SUPABASE_SERVICE_ROLE_KEY` | **sim** | — | Service role (bypassa RLS) — só no backend, nunca no frontend |
| `DEV_USER_ID` | não | `00000000-0000-0000-0000-000000000001` | User id usado enquanto não há login/JWT real |
| `RATE_LIMIT_MAX` | não | `60` | Requisições por janela |
| `RATE_LIMIT_WINDOW` | não | `1 minute` | Janela do rate limit |

A validação dessas variáveis é feita em `src/config.ts` (zod) — o processo
falha rápido e explica o que falta caso alguma obrigatória esteja ausente.

## Como rodar em dev

Pré-requisitos: Node 22, pnpm, deps já instaladas (`pnpm install`).

**Opção A — com Infisical (recomendado, sem `.env` local):**

```bash
infisical run -- pnpm dev
```

**Opção B — com `.env` local:**

```bash
cp .env.example .env
# preencha ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
pnpm dev
```

`pnpm dev` roda `tsx watch src/index.ts` (reload automático). `pnpm start`
(usado em produção/Docker) roda `tsx src/index.ts` sem watch.

## Endpoints

### `GET /healthz`

Health check simples (usado pelo `HEALTHCHECK` do Docker/Portainer e por
load balancers). Retorna 200 quando o processo está de pé.

### `POST /api/chat`

Envia uma mensagem e recebe a resposta do agente **em streaming**, via
Server-Sent Events (`Content-Type: text/event-stream`).

Formato dos eventos (contrato com o frontend, `web/src/lib/agentcore`) —
cada bloco é `event: <nome>\ndata: <json>\n\n`:

| Evento | `data` | Quando ocorre |
|---|---|---|
| `text-delta` | `{ "textDelta": "..." }` | A cada pedaço de texto gerado pelo modelo |
| `tool-call` | `{ "toolCallId": "...", "toolName": "...", "args": {...} }` | Quando o agente decide chamar uma tool |
| `tool-result` | `{ "toolCallId": "...", "result": {...} }` | Quando o resultado da tool volta |
| `error` | `{ "message": "..." }` | Erro durante o processamento (stream é encerrado em seguida) |
| `done` | `{}` | Fim do stream, sucesso |

### `GET /api/chats`

Lista as conversas (chats) do usuário atual.

### `GET /api/chats/:id/messages`

Lista as mensagens de uma conversa específica (histórico completo do chat `:id`).

> Auth: Dexter usa JWT do Supabase Auth; enquanto o login real não está no
> ar, os endpoints usam `DEV_USER_ID` (MVP — ver `.env.example`).

## Deploy (Portainer / DigitalOcean)

Produção (Traefik + GHCR + UI): ver [`../DEPLOY_PORTAINER.md`](../DEPLOY_PORTAINER.md)
e o compose [`../docker-compose.portainer.yml`](../docker-compose.portainer.yml).

Local / homolog com build no host: [`Dockerfile`](./Dockerfile) +
[`docker-compose.yml`](./docker-compose.yml).

```bash
docker build -t agentcore-server:latest .
docker compose up -d
```

Em produção os segredos vêm do **Infisical** (projeto `agentcore`) via
variáveis da stack no Portainer — nunca de `.env` commitado.
