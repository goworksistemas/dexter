-- =============================================================================
-- AgentCore — schema inicial (projeto Supabase "agentcore")
-- Store do agente: conversas, mensagens, auditoria de tool calls, feedback, RAG.
-- NÃO guarda dados de negócio — esses ficam nos projetos existentes e são lidos
-- via RPC read-only SECURITY DEFINER (revisão Galdino), nunca SQL livre do LLM.
--
-- ⚠️ REVISÃO GALDINO obrigatória antes de considerar produção.
-- Baseline: RLS em tudo; service_role (backend) faz a mediação.
-- =============================================================================

-- Extensões ----------------------------------------------------------------
create extension if not exists vector;      -- pgvector (RAG)
create extension if not exists pgcrypto;    -- gen_random_uuid()

-- Helper: updated_at automático --------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- agent_chats — uma sessão de conversa
-- =============================================================================
create table if not exists public.agent_chats (
  id          uuid primary key default gen_random_uuid(),
  agent       text not null check (agent in ('gabi', 'dexter')),
  user_id     uuid,                       -- auth.users do Dexter; null p/ Gabi (canal externo)
  channel     text not null default 'web',-- 'web' | 'whatsapp' | ...
  tenant_id   text,                       -- empresa/tenant do contexto
  system      text,                       -- sistema-alvo: 'networkgo' | 'pipego' | ...
  title       text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists agent_chats_user_idx   on public.agent_chats (user_id);
create index if not exists agent_chats_agent_idx  on public.agent_chats (agent);
create index if not exists agent_chats_tenant_idx on public.agent_chats (tenant_id);

drop trigger if exists trg_agent_chats_updated on public.agent_chats;
create trigger trg_agent_chats_updated
  before update on public.agent_chats
  for each row execute function public.set_updated_at();

-- =============================================================================
-- agent_messages — mensagens da conversa (com métricas de custo/tokens)
-- =============================================================================
create table if not exists public.agent_messages (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references public.agent_chats(id) on delete cascade,
  role        text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content     text,
  model       text,
  tokens_in   integer,
  tokens_out  integer,
  cost_usd    numeric(12,6),
  trace_id    text,
  created_at  timestamptz not null default now()
);
create index if not exists agent_messages_chat_idx  on public.agent_messages (chat_id, created_at);
create index if not exists agent_messages_trace_idx on public.agent_messages (trace_id);

-- =============================================================================
-- agent_tool_calls — AUDITORIA de toda tool call (LGPD)
-- =============================================================================
create table if not exists public.agent_tool_calls (
  id           uuid primary key default gen_random_uuid(),
  chat_id      uuid references public.agent_chats(id) on delete cascade,
  message_id   uuid references public.agent_messages(id) on delete cascade,
  user_id      uuid,
  tool_name    text not null,
  input        jsonb,
  output       jsonb,
  status       text not null default 'ok' check (status in ('ok', 'error')),
  duration_ms  integer,
  trace_id     text,
  created_at   timestamptz not null default now()
);
create index if not exists agent_tool_calls_chat_idx  on public.agent_tool_calls (chat_id, created_at);
create index if not exists agent_tool_calls_tool_idx  on public.agent_tool_calls (tool_name);
create index if not exists agent_tool_calls_trace_idx on public.agent_tool_calls (trace_id);

-- =============================================================================
-- agent_feedback — 👍/👎 do usuário nas respostas
-- =============================================================================
create table if not exists public.agent_feedback (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null references public.agent_messages(id) on delete cascade,
  user_id     uuid,
  rating      smallint not null check (rating in (-1, 1)),
  comment     text,
  created_at  timestamptz not null default now()
);
create index if not exists agent_feedback_msg_idx on public.agent_feedback (message_id);

-- =============================================================================
-- agent_knowledge — base de conhecimento vetorizada (RAG)
-- ⚠️ dimensão do embedding = 1536 (OpenAI text-embedding-3-small). AJUSTAR se
-- o modelo de embedding escolhido tiver outra dimensão (ex.: Voyage-3 = 1024).
-- =============================================================================
create table if not exists public.agent_knowledge (
  id          uuid primary key default gen_random_uuid(),
  source      text,                       -- origem do chunk (doc/sistema)
  title       text,
  content     text not null,
  embedding   vector(1536),
  tenant_id   text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
-- índice ANN (HNSW) para busca por similaridade coseno
create index if not exists agent_knowledge_embedding_idx
  on public.agent_knowledge using hnsw (embedding vector_cosine_ops);
create index if not exists agent_knowledge_tenant_idx on public.agent_knowledge (tenant_id);

-- =============================================================================
-- RLS — habilitado em tudo. O backend AgentCore usa service_role (bypassa RLS);
-- as policies abaixo são defesa em profundidade para acesso autenticado direto
-- do Dexter (o usuário só enxerga as próprias conversas).
-- =============================================================================
alter table public.agent_chats      enable row level security;
alter table public.agent_messages   enable row level security;
alter table public.agent_tool_calls enable row level security;
alter table public.agent_feedback   enable row level security;
alter table public.agent_knowledge  enable row level security;

-- Dexter (authenticated): enxerga/gerencia apenas as próprias conversas.
create policy "own chats - select" on public.agent_chats
  for select to authenticated using (user_id = auth.uid());
create policy "own chats - insert" on public.agent_chats
  for insert to authenticated with check (user_id = auth.uid());
create policy "own chats - update" on public.agent_chats
  for update to authenticated using (user_id = auth.uid());

create policy "own messages - select" on public.agent_messages
  for select to authenticated using (
    exists (select 1 from public.agent_chats c
            where c.id = agent_messages.chat_id and c.user_id = auth.uid())
  );

create policy "own tool_calls - select" on public.agent_tool_calls
  for select to authenticated using (user_id = auth.uid());

create policy "own feedback - all" on public.agent_feedback
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- agent_knowledge: sem acesso a authenticated por padrão (só service_role via
-- backend). RAG é lido pelo AgentCore; o front nunca lê direto.
-- (RLS habilitado + nenhuma policy = negado para anon/authenticated.)
