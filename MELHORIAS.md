# Dexter — Checklist completo de melhorias

> Levantado em 2026-08-05 a partir de análise do código (server + web + supabase + deploy).
> Prioridade: P0 = crítico/custo direto · P1 = importante · P2 = evolução.
> Status: ✅ = entregue (2026-08-05, levas 1–3) · `F2` = fase seguinte · `—` = backlog.

---

## 1. Contexto e custo de tokens (P0 — maior ROI do projeto)

O problema central: **cada mensagem reenvia todo o contexto**. O front manda o histórico
inteiro da thread; o server reconstrói o system prompt completo (base ~10k chars + projeto
até 48k + artefatos até 20k + KB always_load) a cada request; nada é cacheado no provider.
Numa conversa de 15 turnos o input passa de ~40k–100k tokens por mensagem.

| # | Item | Problema | Solução | Status |
|---|------|----------|---------|--------|
| 1.1 | **Server-side context assembly** | Front (`chat-runs-store` → `AgentCoreTransport`) envia `messages[]` completo; server usa `body.messages` direto (`routes/chat.ts`) | Front passa a mandar só `{threadId, message, attachments, context}`. Server carrega histórico de `agent_messages` (já persiste tudo). Manter compat com `messages[]` no schema durante transição | ✅ (A1) |
| 1.2 | **Janela deslizante de histórico** | Sem janela: turno 20 reenvia 19 respostas densas inteiras | Server monta contexto com as últimas N mensagens (`CONTEXT_WINDOW_MESSAGES`, default 12). Acima disso, corta e sinaliza no system prompt que há histórico anterior | ✅ (A1) |
| 1.3 | **Prompt caching (Anthropic)** | `system` vai como string única sem `cache_control`; tools redefinidas a cada call. 0% de cache hit | `system` vira array de blocos: base estática (DEXTER_SYSTEM_PROMPT + KB fixa) com `cache_control: {type:"ephemeral"}`; bloco dinâmico (acesso/conectores/projeto/artefatos) sem cache. `cache_control` também no último item de `tools`. ~90% de desconto nos tokens cacheados | ✅ (A1) |
| 1.4 | **Teto de tool_result** | `AGENT_TOOL_RESULT_MAX_CHARS` default 24.000; com 28 steps dá ~670k chars possíveis num turno | Reduzir default para 8.000 (truncamento já preserva agregados). Notion MCP pode precisar de mais → manter configurável por env | ✅ (A1) |
| 1.5 | **Projeto: arquivos sob demanda** | `buildProjectPromptBlock` injeta até 48.000 chars de arquivos texto no system prompt em TODA mensagem | No prompt vai só instruções + índice (nome/tamanho/tipo dos arquivos). Nova tool `project__read_file` lê conteúdo sob demanda (com cap por leitura) | ✅ (A1) |
| 1.6 | **KB: reduzir always_load** | Docs `always_load` entram inteiros no prompt de toda conversa | Cap de tamanho para `always_load` (ex.: 2.000 chars/doc, aviso no admin acima disso); resto via `kb__buscar` que já existe | ✅ (A1) |
| 1.7 | **Sumarização rolling do histórico** | Histórico antigo cortado pela janela simplesmente some | Quando o histórico exceder a janela, gerar resumo com modelo barato (Haiku) e salvar em `agent_chats.metadata.summary`; injetar o resumo no lugar dos turnos cortados. Regenerar incrementalmente | ✅ (B1) |
| 1.8 | **Memória estruturada por chat** | Fatos descobertos (entidades, números, decisões) se perdem fora da janela | Tabela `agent_chat_memory` (fatos extraídos pós-turno, job assíncrono); bloco compacto no system prompt | F2 |
| 1.9 | **RAG sobre histórico longo** | Conversas de 50+ turnos com mudança de assunto | Embeddings de mensagens antigas (pgvector já existe); buscar top-k relevantes à pergunta nova | ✅ (C1 — migration 0034 aplicada; exige chave OpenAI p/ embeddings) |
| 1.10 | **Context budget manager** | Nenhum cálculo de tokens antes de chamar o LLM; erro `context_length` só é tratado depois que estoura | Estimar tokens do payload montado (chars/4); se exceder orçamento, encolher janela/artefatos antes do call | ✅ (C1 — `context-budget.ts`, degradação artefatos→janela→RAG) |
| 1.11 | **Métricas de input por componente** | `tokens_in` gravado por mensagem, mas sem quebra (system vs histórico vs tools) | Logar no trace + expor no painel admin a decomposição estimada do input | ✅ (C1 — log estruturado por traceId; painel fica p/ depois) |

## 2. Arquitetura e escala (P1)

| # | Item | Problema | Solução | Status |
|---|------|----------|---------|--------|
| 2.1 | Fila assíncrona (BullMQ) | Redis sobe no compose mas nada usa; workflow runner é timer in-process | Migrar runner de workflows + jobs (sumarização 1.7, embeddings 1.9, pricing-sync) para BullMQ com retry/DLQ | ✅ (C1 — filas chat-summary/embeddings/workflow-run; fallback in-process sem `REDIS_URL`) |
| 2.2 | Cache semântico | Previsto no spec, inexistente | Só depois de medir: threshold alto + escopo por usuário (risco de vazamento entre tenants) | — |
| 2.3 | Teste de carga | Meta do spec: 50 sessões simultâneas, p95 < 3s até 1º token. Nunca medido | Script k6/artillery contra `/api/chat` em homolog; documentar resultado | ✅ script (C2 — `scripts/loadtest/`); **run real em homolog pendente** |
| 2.4 | Multi-réplica | 1 réplica; claim de workflow já suporta N | Validar SSE atrás do Traefik com 2 réplicas + timeout de LB | — |

## 3. Qualidade e testes (P0)

| # | Item | Problema | Solução | Status |
|---|------|----------|---------|--------|
| 3.1 | **Zero testes automatizados** | Nenhum `*.test.ts` no repo; refactors (como o item 1) sem rede de proteção | Vitest no `server/`; testes das funções puras: `systems/progress.ts` (truncar, resumirArgs), `systems/artifacts-context.ts` (strip/select/looksTruncated), `lib/schedule.ts`, `lib/email-domain.ts`, `lib/money.ts` | ✅ (A3 — 72 testes; 2 bugs achados e corrigidos) |
| 3.2 | Testes do agent loop | `truncarToolResultContent`, `emendarContinuacao`, anti-loop fingerprint são privados e críticos | Exportar (ou extrair para módulo) e testar — **depois** do refactor A1 para não conflitar | ✅ (B1 — helpers extraídos + 43 testes) |
| 3.3 | CI com typecheck+lint+test | `publish-images.yml` só builda imagem | Job de PR: `pnpm typecheck && pnpm lint && pnpm -r test` | ✅ (B2 — `.github/workflows/ci.yml`) |
| 3.4 | Teste E2E do contrato SSE | Contrato front↔server só validado manualmente | Teste de integração: sobe Fastify com mock de LLM, valida sequência de eventos SSE | — |

## 4. Segurança (P1)

| # | Item | Problema | Solução | Status |
|---|------|----------|---------|--------|
| 4.1 | Revisão formal das RPCs `dexter_sql` | SELECT livre (gate has_access + read-only), mas é a maior superfície de risco | Revisão SQL (Galdino) de `supabase/rpcs/_generico/dexter_query.sql` por sistema; testes de injection/escape | — |
| 4.2 | Cache de auth por token | `authCache` em memória com TTL 45s; conta desabilitada continua válida até expirar | Aceitável; documentar. Invalidação ativa se virar requisito | — |
| 4.3 | Rate limit por usuário | `@fastify/rate-limit` global por IP; atrás do Traefik todos os users podem dividir IP | Keyed por `userId` após auth nas rotas de chat | ✅ (C1 — 20 req/min, Redis ou memória) |
| 4.4 | Orçamento por usuário: enforcement no meio do run | Budget checado no início do request; um run de 28 tools pode estourar o teto | Checagem também dentro do agent loop a cada N steps | ✅ (C1 — a cada 5 tool calls, encerramento gracioso) |

## 5. Observabilidade (P1)

| # | Item | Problema | Solução | Status |
|---|------|----------|---------|--------|
| 5.1 | Cache hit rate do prompt caching | Sem caching não existe; com 1.3 passa a existir | Logar `cache_creation_input_tokens` / `cache_read_input_tokens` do usage da Anthropic em `agent_messages` (colunas novas) e no painel admin; ponderar preço (read ~0,1×, write ~1,25×) no custo gravado | ✅ (B1 — migration 0033 aplicada) |
| 5.2 | Painel NOC/GoDash | Spec prevê; hoje só admin interno | Exportar métricas (latência 1º token, custo/dia, erro por provider) | — |
| 5.3 | Alertas | Nenhum alerta de erro/custo | Alerta em custo diário anômalo e taxa de erro de provider | — |

## 6. Higiene do repositório e documentação (P2, barato)

| # | Item | Problema | Solução | Status |
|---|------|----------|---------|--------|
| 6.1 | Lixo na raiz | `_dossier_extract.txt`, `_extract_dossier.py`, `_tmp_mig_0009.json`, `_tmp_orig_panel.txt`, `web/_audit/`, `dexter_app/` (untracked, duplica `c:\1github\dexter_app`) | Listar candidatos, confirmar com o dono e remover; `.gitignore` para artefatos de auditoria | ✅ (A2 + deleções aprovadas e executadas) |
| 6.2 | `AGENTCORE_SPEC.md` desatualizado | Status "Em especificação" com checklist zerado — o código está MUITO à frente | Atualizar status, marcar o que foi entregue, mover pendências reais (fila, cache, load test, Gabi) para backlog claro | ✅ (A2) |
| 6.3 | READMEs desatualizados | `server/README.md` lista só 4 endpoints (existem ~12 grupos de rotas); env vars documentadas ≠ `config.ts` | Reescrever espelhando o código atual (rotas, env vars do zod schema, arquitetura de pastas) | ✅ (A2) |
| 6.4 | `web/README.md` é template do Vite | Zero informação do projeto | README real: stack, estrutura, rotas, contrato com AgentCore | ✅ (A2) |
| 6.5 | Lockfiles duplicados | `pnpm-lock.yaml` dentro de `server/` e `web/` (ignorados pelo workspace) | Remover os dois (o da raiz é o válido) | ✅ (A2) |

## 7. Produto (P2)

| # | Item | Problema | Solução | Status |
|---|------|----------|---------|--------|
| 7.1 | Gabi (WhatsApp) | Só existe no README/spec; zero código | Decidir: implementar canal (token de canal + Hyperflow) ou tirar do escopo declarado | — |
| 7.2 | Migração dos embeds n8n | NetworkGo/PipeGo/GoAcademy ainda chamam n8n para chat | Apontar os fronts para o AgentCore (`/api/chat` com JWT); desativar workflows de chat no n8n | — |
| 7.3 | App mobile (`dexter_app` Flutter) | Repo separado sem README útil, cópia untracked dentro do monorepo | Definir se é oficial; se sim, integrar CI e documentar; se não, arquivar | — |

---

## Plano de execução

**Leva 1 — ✅ concluída em 2026-08-05** (typecheck/lint/72 testes verdes na verificação combinada):
- **A1 — Contexto (P0)**: itens 1.1–1.6 entregues (front manda só a mensagem nova; janela `CONTEXT_WINDOW_MESSAGES=12`; prompt caching Anthropic com blocos estático/dinâmico + tools; tool_result 24k→8k; `project__read_file`; KB always_load capada em 2k).
- **A2 — Higiene/docs**: itens 6.1–6.5 (deleções da raiz aguardam aprovação do dono).
- **A3 — Testes**: item 3.1 (72 testes) + fix dos bugs `emailDomainOf` e `roundCostUsd`.

**Leva 2 — ✅ concluída em 2026-08-05** (verificação: typecheck ok, 115 testes passando):
- **B1 — Pipeline de contexto fase 2**: 1.7 (sumarização rolling via Haiku, resumo em `agent_chats.metadata.summary`), 5.1 (colunas `tokens_cache_write/read` + preço ponderado 1,25×/0,10× + card de cache no admin) e 3.2 (helpers do agent loop extraídos e testados).
- **B2 — CI**: 3.3 (`.github/workflows/ci.yml` — PR + push em develop).

**Leva 3 — ✅ concluída em 2026-08-05** (verificação final: typecheck raiz ok, 129 testes passando):
- **C1 — Escalabilidade**: 2.1 (BullMQ: filas chat-summary/embeddings/workflow-run + `GET /api/admin/queues`), 1.9 (RAG de histórico), 1.10 (context budget manager), 4.3 (rate limit por usuário), 4.4 (orçamento no meio do run), 1.11 (métricas de input por componente).
- **C2 — Teste de carga + docs**: script k6 em `scripts/loadtest/` (run real fica p/ homolog); Gabi/Galdino removidos do spec e READMEs.
- **D1 — UX de custos** (pedido extra do dono): descrições amigáveis + "quando usar" no seletor de modelos, estimativa de custo por mensagem no composer, **R$ como moeda principal** em todo o web (cotação AwesomeAPI com cache 1h + fallback; USD entre parênteses no admin).

**Banco (aplicado via MCP em 2026-08-05)**: migrations 0033 (cache tokens) e 0034 (embeddings RAG) no projeto agentcore.

**⚠️ Para o deploy**:
1. Envs novas no Infisical: `REDIS_URL=redis://redis:6379` (sem ela tudo roda in-process, como hoje), `CHAT_RATE_LIMIT_MAX=20`, `CHAT_RATE_LIMIT_WINDOW_MS=60000`. Demais em `server/.env.example`.
2. Redeploy do server (deps novas: `bullmq`, `ioredis`).
3. Smoke test: conversa com projeto + KB ativa; acompanhar `GET /api/admin/queues` nos primeiros dias com Redis ligado.
4. Custo por mensagem vai CAIR visivelmente com cache hit (valor antigo inflado nos tokens de leitura) — não é bug.
5. RAG usa chave OpenAI para embeddings (custo baixo, `text-embedding-3-small`); sem chave, o recurso fica inerte sem quebrar nada.

**Backlog restante**: 1.8 (memória estruturada), 2.2 (cache semântico), 2.3 (rodar o load test em homolog), 2.4 (multi-réplica), 3.4 (E2E SSE), 4.1 (revisão formal `dexter_sql`), 5.2/5.3 (NOC + alertas), 7.1–7.3 (decisões de produto).
