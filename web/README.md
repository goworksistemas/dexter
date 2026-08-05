# Dexter — web

Frontend do **Dexter**, assistente interno da GoWork. SPA React que consome o
**AgentCore** (Fastify em `../server`) via REST e streaming SSE. Parte do
monorepo pnpm na raiz — lockfile único em `../pnpm-lock.yaml`.

## Stack

| Camada | Tecnologia |
| ------ | ---------- |
| UI | React 19, TypeScript |
| Build | Vite 8 |
| Estilo | Tailwind CSS 4 (`@tailwindcss/vite`) |
| Chat | `@assistant-ui/react` + transporte SSE custom (`lib/agentcore/`) |
| Componentes | Radix UI (`radix-ui`), Lucide, Sonner (toasts) |
| Editor | CodeMirror 6 (artefatos HTML/CSS/JSON/Markdown) |
| Auth | Supabase Auth (`@supabase/supabase-js`) |
| Roteamento | React Router 7 |

Versão atual do pacote: **1.4.0** (ver `package.json`).

## Estrutura de `src/`

| Pasta | Responsabilidade |
| ----- | ---------------- |
| `components/` | UI reutilizável — chat, layout/sidebar, artefatos, auth, share, ui (Radix) |
| `hooks/` | Hooks compartilhados (quando existem fora de `lib/`) |
| `lib/` | Lógica de domínio: `agentcore/` (SSE), `chats/`, `models/`, `projects/`, `workflows/`, `artifacts/`, `connectors/`, `admin/`, `supabase/` |
| `pages/` | Rotas lazy-loaded — auth, admin, projects, workflows, artifacts, páginas públicas de share |
| `providers/` | Contextos globais — `AuthProvider`, `ThemeProvider` |
| `types/` | Tipos compartilhados e declarações Vite (`env.d.ts`) |

## Rotas principais

Definidas em `src/App.tsx`:

| Rota | Página | Auth |
| ---- | ------ | ---- |
| `/` | Chat (home) | sim |
| `/c/:chatId` | Chat em conversa existente | sim |
| `/p/:projectId` | Chat dentro de projeto | sim |
| `/p/:projectId/c/:chatId` | Chat de projeto | sim |
| `/chats` | Lista de conversas | sim |
| `/projects` | Projetos | sim |
| `/projects/:projectId` | Detalhe do projeto | sim |
| `/workflows` | Workflows agendados | sim |
| `/artifacts` | Artefatos gerados | sim |
| `/artifacts/:artifactId` | Viewer fullscreen de artefato | sim |
| `/admin` | Painel admin | staff |
| `/admin/chaves` | Gestão de chaves (admin) | staff |
| `/settings` | Preferências do usuário | sim |
| `/login`, `/signup`, `/forgot-password` | Auth | guest |
| `/update-password`, `/auth/callback` | Fluxo Supabase | — |
| `/s/c/:token` | Share público de conversa | não |
| `/s/a/:token` | Share público de artefato | não |

O `ChatThread` permanece montado em todas as rotas de conversa (`/`, `/c/*`, `/p/*`) para não interromper gerações em background.

## Contrato com o AgentCore (SSE)

O transporte está em `src/lib/agentcore/transport.ts`. O front faz `POST /api/chat`
com JWT Supabase e consome Server-Sent Events.

Formato esperado do backend:

```
event: text-delta
data: {"textDelta":"olá"}

event: tool-call
data: {"toolCallId":"abc","toolName":"pipego__dexter_sql","args":{...}}

event: tool-result
data: {"toolCallId":"abc","result":{...}}

event: progress
data: {"type":"tool_call_start","tool":"...","step":1,...}

event: error
data: {"message":"..."}

event: done
data: {}
```

Regras:

- Cada evento termina com linha em branco (`\n\n`).
- `data` é sempre JSON válido (`{}` em `done`).
- Erros HTTP antes do stream (401, 500) viram chunk `{type:"error"}` sintético no cliente.
- Demais endpoints REST usam o mesmo prefixo `/api` (ver `server/README.md`).

## Como rodar

Na **raiz do monorepo**:

```bash
pnpm install
pnpm dev:web     # só o front (porta 5273)
# ou
pnpm dev         # server + web (recomendado)
```

Pré-requisitos: Node 22+, pnpm 10+, AgentCore rodando na porta **8787** (ou
ajuste `VITE_AGENTCORE_URL`).

### Proxy em dev

O Vite (`vite.config.ts`) faz proxy de `/api` → `http://localhost:8787` (ou
`VITE_AGENTCORE_URL`). O front chama caminhos relativos (`/api/chat`, …) — sem
CORS extra em dev.

Variáveis públicas (ver `web/.env.example`):

| Variável | Descrição |
| -------- | --------- |
| `VITE_SUPABASE_URL` | URL do projeto Supabase |
| `VITE_SUPABASE_ANON_KEY` | Anon key (só no front) |
| `VITE_AGENTCORE_URL` | Target do proxy (default `http://localhost:8787`) |

## Build e deploy

```bash
pnpm build       # na raiz: tsc + vite build → web/dist/
pnpm typecheck
pnpm lint
```

**Docker:** `web/Dockerfile` — estágio 1: `pnpm build` com args
`VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`; estágio 2: **nginx** servindo
`dist/` com proxy de `/api` e `/healthz` para o serviço `agentcore:8787`
(ver `web/nginx.conf`).

Em produção o front usa URL relativa `/api` — o nginx faz o roteamento interno.

Deploy completo (Traefik + GHCR): [`../DEPLOY_PORTAINER.md`](../DEPLOY_PORTAINER.md).
