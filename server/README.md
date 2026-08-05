# AgentCore — server

Backend (Fastify) do super agente de IA da GoWork (**Dexter**).
Runtime de chat síncrono com streaming (SSE), tirando o hot path de conversa
do n8n. Especificação técnica completa (arquitetura, escala, segurança,
faseamento): [`../AGENTCORE_SPEC.md`](../AGENTCORE_SPEC.md).

## Stack

- **Node 22** / **TypeScript** (ESM, `"type": "module"`)
- **Fastify 5** — servidor HTTP
- Executado direto via **`tsx`** (sem etapa de build/`dist`) — em dev e em produção
- `@fastify/cors`, `@fastify/rate-limit`, `@fastify/multipart`
- `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` — LLM e MCP
- `@supabase/supabase-js` — persistência (chats/mensagens/auditoria), acesso via service role
- `zod` — validação de config e payloads
- `pnpm` workspace (lockfile na raiz do monorepo)

## Estrutura de `src/`

| Pasta | Responsabilidade |
| ----- | ---------------- |
| `connectors/` | OAuth Notion/Outlook, preferências por usuário, bridge MCP, tokens cifrados |
| `lib/` | Utilitários transversais: SSE, STT, schedule, Supabase client, imagens, money |
| `llm/` | Router multi-provider, catálogo dinâmico de modelos, system prompt, capabilities |
| `mcp/` | Clientes MCP (stdio e HTTP remoto) |
| `routes/` | Plugins Fastify — um arquivo por domínio (chat, admin, workflows, …) |
| `services/` | Persistência e regras de negócio (chat-store, admin, workflows, keys, share, KB) |
| `systems/` | Agent loop, tools RPC read-only, manifest dos 9 sistemas, auditoria, web search |

## Variáveis de ambiente

Fonte da verdade: `src/config.ts` (schema zod). Em produção os valores vêm do
**Infisical** (projeto `agentcore`); nunca commitar segredos reais.

<!-- revisar env vars após merge do refactor de contexto -->

| Variável | Obrigatória | Default | Descrição |
| --- | --- | --- | --- |
| `PORT` | não | `8787` | Porta HTTP do servidor |
| `HOST` | não | `0.0.0.0` | Host de bind |
| `LOG_LEVEL` | não | `info` | `fatal\|error\|warn\|info\|debug\|trace` |
| `CORS_ORIGINS` | não | `http://localhost:5273,http://localhost:5274` | Origens CORS (CSV) |
| `LLM_PROVIDER` | não | `anthropic` | **Deprecated** — catálogo é dinâmico |
| `ANTHROPIC_API_KEY` | não* | — | Fallback legado; chaves preferencialmente no banco (admin/BYOK) |
| `ANTHROPIC_MODEL` | não | `claude-sonnet-5` | **Deprecated** — default vem do discovery + override admin |
| `OPENAI_API_KEY` | não | — | Fallback legado OpenAI |
| `GEMINI_API_KEY` | não | — | Fallback legado Gemini |
| `DEEPSEEK_API_KEY` | não | — | Fallback legado DeepSeek |
| `XAI_API_KEY` | não | — | Fallback legado xAI |
| `USER_API_KEYS_SECRET` | não | — | Segredo AES-256-GCM (≥16 chars) para chaves no banco; sem ele a UI de keys fica desabilitada |
| `OLLAMA_BASE_URL` | não | `https://ollama.gowork.com.br` | Base URL do Ollama |
| `OLLAMA_MODEL` | não | `qwen2.5:7b` | Modelo default Ollama |
| `OLLAMA_NUM_CTX` | não | `4096` | Context window Ollama |
| `STT_BASE_URL` | não | — | Base STT OpenAI-compatible; vazio → api.openai.com |
| `STT_MODEL` | não | `gpt-4o-transcribe` | Modelo de transcrição |
| `STT_API_KEY` | não | — | Chave STT; vazio usa `OPENAI_API_KEY` |
| `SUPABASE_URL` | não | `https://jtvscxbwralvzpfhtqcs.supabase.co` | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | **sim** | — | Service role (bypassa RLS) — só no backend |
| `DEV_USER_ID` | não | `00000000-0000-4000-8000-000000000001` | User id de dev (sem JWT) |
| `ALLOW_DEV_USER` | não | `false` | Aceita `DEV_USER_ID` sem Bearer token |
| `ALLOWED_EMAIL_DOMAINS` | não | `gowork.com.br` | Fallback CSV se tabela de domínios estiver vazia |
| `RATE_LIMIT_MAX` | não | `60` | Requisições por janela (global por IP) |
| `RATE_LIMIT_WINDOW` | não | `1 minute` | Janela do rate limit |
| `AGENT_MAX_STEPS` | não | `28` | Máximo de tool calls por turno |
| `AGENT_MAX_ROUNDS` | não | `14` | Máximo de rounds LLM por turno |
| `SEARXNG_BASE_URL` | não | — | SearXNG self-hosted — habilita `web__search` / `web__fetch` |
| `WEB_SEARCH_ENABLED` | não | `false` | Busca nativa Anthropic (paga); padrão é SearXNG |
| `WEB_SEARCH_MAX_USES` | não | `5` | Máx. buscas nativas por resposta |
| `AGENT_RUN_TIMEOUT_MS` | não | `480000` | Timeout total de um run de chat |
| `AGENT_CALL_TIMEOUT_MS` | não | `120000` | Timeout por chamada ao LLM |
| `AGENT_TOOL_RESULT_MAX_CHARS` | não | `24000` | Teto de `tool_result` no contexto |
| `AGENTCORE_PUBLIC_URL` | não | — | URL pública (callbacks OAuth), ex. `https://agentcore.gowork.com.br` |
| `DEXTER_APP_URL` | não | — | Redirect pós-OAuth; default: primeiro `CORS_ORIGINS` |
| `NOTION_CLIENT_ID` | não | — | OAuth Notion legado REST (produto usa MCP OAuth) |
| `NOTION_CLIENT_SECRET` | não | — | OAuth Notion legado |
| `NOTION_REDIRECT_URI` | não | — | Redirect OAuth Notion legado |
| `NOTION_TOKEN` | não | — | Token workspace admin-only (fallback) |
| `NOTION_ALLOW_WORKSPACE_TOKEN` | não | — | Permite `NOTION_TOKEN` em multi-user |
| `MCP_NOTION_COMMAND` | não | — | Debug: stdio MCP Notion |
| `MCP_NOTION_ARGS` | não | — | Args do stdio MCP Notion |
| `MICROSOFT_CLIENT_ID` | não | — | OAuth Outlook / Graph |
| `MICROSOFT_CLIENT_SECRET` | não | — | OAuth Outlook |
| `MICROSOFT_TENANT_ID` | não | — | Tenant Azure ou `organizations` |
| `MICROSOFT_REDIRECT_URI` | não | — | Redirect OAuth Outlook |
| `MCP_OUTLOOK_COMMAND` | não | — | Debug: stdio MCP Outlook |
| `MCP_OUTLOOK_ARGS` | não | — | Args do stdio MCP Outlook |
| `MCP_TOOL_TIMEOUT_MS` | não | `60000` | Timeout de tools MCP / Graph / Notion |

\* `ANTHROPIC_API_KEY` (ou chave equivalente no banco) é necessária na prática para chat com Claude; o schema zod não a torna obrigatória porque o catálogo aceita múltiplos providers.

A validação falha rápido e explica o que falta se alguma obrigatória estiver ausente.

## Como rodar em dev

Pré-requisitos: Node 22+, pnpm 10+, Infisical autenticado (ou `.env` local).

**Na raiz do monorepo (recomendado):**

```bash
pnpm install
pnpm dev:server   # libera porta 8787 + sobe só o AgentCore
# ou
pnpm dev          # server + web juntos
```

**Dentro de `server/`:**

```bash
infisical run --env=prod --path=/ -- pnpm dev
# ou, com .env local preenchido:
pnpm dev:local
```

`pnpm dev` roda `tsx watch src/index.ts`. `pnpm start` (Docker/prod) roda sem watch.

## Endpoints

Auth: JWT Supabase (`Authorization: Bearer …`). Com `ALLOW_DEV_USER=true`, aceita requests sem token usando `DEV_USER_ID`.

### Saúde

| Método | Path | Descrição |
| --- | --- | --- |
| `GET` | `/healthz` | Health check (Docker/Traefik) |

### Chat

| Método | Path | Descrição |
| --- | --- | --- |
| `POST` | `/api/chat` | Mensagem do agente em streaming SSE (`text/event-stream`) |

### Conversas

| Método | Path | Descrição |
| --- | --- | --- |
| `GET` | `/api/chats` | Lista conversas do usuário |
| `GET` | `/api/chats/:id/messages` | Histórico paginado (`limit`, `before`) |
| `GET` | `/api/chats/:id/tail` | Últimas N mensagens + `hasMore` |
| `GET` | `/api/chats/:id/steps` | Tool calls agrupados por mensagem (detalhes do agente) |
| `PATCH` | `/api/chats/:id` | Renomeia, associa projeto ou fixa modelo |
| `DELETE` | `/api/chats/:id` | Exclui conversa |
| `POST` | `/api/chats/:id/truncate` | Trunca histórico (edit/regenerate) |

### Projetos

| Método | Path | Descrição |
| --- | --- | --- |
| `GET` | `/api/projects` | Lista projetos |
| `POST` | `/api/projects` | Cria projeto |
| `GET` | `/api/projects/:id` | Detalhe do projeto |
| `PATCH` | `/api/projects/:id` | Atualiza nome/instruções/cor/ícone |
| `DELETE` | `/api/projects/:id` | Exclui projeto |
| `GET` | `/api/projects/:id/files` | Lista arquivos do projeto |
| `POST` | `/api/projects/:id/files` | Upload de arquivo (base64) |
| `DELETE` | `/api/projects/:id/files/:fileId` | Remove arquivo |

### Modelos e chaves

| Método | Path | Descrição |
| --- | --- | --- |
| `GET` | `/api/models` | Catálogo dinâmico filtrado por permissão/crédito do usuário |
| `GET` | `/api/user-keys` | Chaves BYOK do usuário (só metadados) |
| `PUT` | `/api/user-keys/:provider` | Salva chave pessoal |
| `DELETE` | `/api/user-keys/:provider` | Remove chave pessoal |

### Sistemas e conectores

| Método | Path | Descrição |
| --- | --- | --- |
| `GET` | `/api/connections` | Sistemas de negócio e status de acesso (`dexter_whoami`) |
| `GET` | `/api/connectors` | Status Notion/Outlook + preferências |
| `PATCH` | `/api/connectors` | Liga/desliga conectores no prompt |
| `GET` | `/api/connectors/:provider/connect` | Inicia OAuth (retorna URL) |
| `GET` | `/api/connectors/:provider/callback` | Callback OAuth (redirect) |
| `DELETE` | `/api/connectors/:provider` | Revoga conexão |

### Compartilhamento

| Método | Path | Descrição |
| --- | --- | --- |
| `GET` | `/api/chats/:id/share` | Status do link público da conversa |
| `POST` | `/api/chats/:id/share` | Publica link anônimo |
| `DELETE` | `/api/chats/:id/share` | Revoga link público |
| `GET` | `/api/chats/:id/share-users` | Convites colega-a-colega |
| `POST` | `/api/chats/:id/share-users` | Convida por e-mail ou userId |
| `GET` | `/api/me/colleagues` | Colegas elegíveis para share |
| `GET` | `/api/me/chat-shares` | Convites pendentes recebidos |
| `POST` | `/api/me/chat-shares/:shareId/fork` | Aceita convite e cria fork |
| `DELETE` | `/api/me/chat-shares/:shareId` | Revoga convite |
| `GET` | `/api/artifacts/:id/share` | Status do link público do artefato |
| `POST` | `/api/artifacts/:id/share` | Publica artefato |
| `DELETE` | `/api/artifacts/:id/share` | Revoga link do artefato |
| `GET` | `/api/public/chats/:token` | Conversa pública (sem auth; rate limit) |
| `GET` | `/api/public/artifacts/:token` | Artefato público (sem auth; rate limit) |

### Workflows

| Método | Path | Descrição |
| --- | --- | --- |
| `GET` | `/api/workflows` | Lista workflows agendados |
| `POST` | `/api/workflows` | Cria workflow |
| `PATCH` | `/api/workflows/:id` | Atualiza workflow |
| `DELETE` | `/api/workflows/:id` | Exclui workflow |
| `POST` | `/api/workflows/:id/run` | Dispara execução manual (202, background) |
| `GET` | `/api/workflows/:id/runs` | Histórico de execuções |

### Transcrição

| Método | Path | Descrição |
| --- | --- | --- |
| `GET` | `/api/transcribe/status` | STT configurado? |
| `POST` | `/api/transcribe` | Áudio → texto (multipart, campo `file`) |

### Admin (staff: role `admin` ou `master`)

| Método | Path | Descrição |
| --- | --- | --- |
| `GET` | `/api/admin/me` | Perfil e flag `isStaff` |
| `GET` | `/api/admin/overview` | Analytics geral (`?days=`) |
| `GET` | `/api/admin/cost-center` | Centro de custo por modelo/usuário |
| `GET` | `/api/admin/users` | Lista usuários |
| `GET` | `/api/admin/users/:id` | Detalhe de uso do usuário |
| `PATCH` | `/api/admin/users/:id` | Role, disable, modelos permitidos, budget |
| `GET` | `/api/admin/models` | Catálogo completo + probe (`?probe=1`) |
| `POST` | `/api/admin/models/bulk` | Habilita/desabilita modelos em lote |
| `PATCH` | `/api/admin/models/:id` | Override de modelo |
| `GET` | `/api/admin/providers` | Metadados dos providers |
| `PATCH` | `/api/admin/providers/:id` | Label, tier, crédito |
| `GET` | `/api/admin/pricing` | Tabela de preços |
| `PATCH` | `/api/admin/pricing/:id` | Preço input/output por modelo |
| `POST` | `/api/admin/pricing/sync` | Sincroniza preços + backfill de custos |
| `GET` | `/api/admin/provider-keys` | Chaves globais (metadados) |
| `PUT` | `/api/admin/provider-keys/:provider` | Salva chave global |
| `DELETE` | `/api/admin/provider-keys/:provider` | Remove chave global |
| `GET` | `/api/admin/users/:id/keys` | Chaves dedicadas ao usuário |
| `PUT` | `/api/admin/users/:id/keys/:provider` | Atribui chave ao usuário |
| `DELETE` | `/api/admin/users/:id/keys/:provider` | Remove chave do usuário |
| `GET` | `/api/admin/kb` | Base de conhecimento |
| `POST` | `/api/admin/kb` | Cria doc KB |
| `PATCH` | `/api/admin/kb/:id` | Atualiza doc KB |
| `DELETE` | `/api/admin/kb/:id` | Remove doc KB |

### Contrato SSE (`POST /api/chat`)

Cada bloco: `event: <nome>\ndata: <json>\n\n`

| Evento | `data` | Quando |
| --- | --- | --- |
| `text-delta` | `{ "textDelta": "..." }` | Pedaço de texto do modelo |
| `tool-call` | `{ "toolCallId", "toolName", "args" }` | Tool invocada |
| `tool-result` | `{ "toolCallId", "result" }` | Resultado da tool |
| `progress` | `{ "type": "tool_call_start" \| "tool_call_end" \| "status", ... }` | Progresso do agente |
| `error` | `{ "message": "..." }` | Erro — stream encerra |
| `done` | `{}` | Fim do stream |

Detalhe completo: `web/src/lib/agentcore/transport.ts` e `contract.ts`.

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
