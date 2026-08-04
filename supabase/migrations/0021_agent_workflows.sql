-- =============================================================================
-- agent_workflows — Workflows agendados do usuário (Dexter executa por cron)
-- Projeto Supabase "agentcore"
--
-- O usuário cria um fluxo (instruções + agendamento amigável). O runner do
-- AgentCore executa com as permissões do dono e grava o resultado como uma
-- conversa (agent_chats). Escrita via service_role (rotas do server com JWT);
-- RLS de leitura própria para futuros usos diretos.
-- =============================================================================

create table if not exists public.agent_workflows (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  description  text not null default '',
  -- Instrução executada pelo Dexter a cada disparo.
  prompt       text not null,
  -- Agendamento estruturado (sem cron string):
  -- { "freq": "daily"|"weekly"|"monthly"|"once", "time": "08:00",
  --   "weekdays": [1..7]?, "day_of_month": 1..28?, "date": "2026-08-10"? }
  schedule     jsonb not null,
  timezone     text not null default 'America/Sao_Paulo',
  enabled      boolean not null default true,
  model_id     text,
  next_run_at  timestamptz,
  last_run_at  timestamptz,
  -- Claim de execução (multi-réplica): só roda quem conseguir o lock.
  locked_until timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint agent_workflows_name_len check (char_length(trim(name)) between 1 and 120),
  constraint agent_workflows_prompt_len check (char_length(trim(prompt)) between 1 and 8000)
);

create index if not exists agent_workflows_user_idx
  on public.agent_workflows (user_id, updated_at desc);
create index if not exists agent_workflows_due_idx
  on public.agent_workflows (enabled, next_run_at);

drop trigger if exists trg_agent_workflows_updated on public.agent_workflows;
create trigger trg_agent_workflows_updated
  before update on public.agent_workflows
  for each row execute function public.set_updated_at();

create table if not exists public.agent_workflow_runs (
  id          uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.agent_workflows(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  status      text not null default 'running',
  trigger     text not null default 'schedule',
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  chat_id     uuid references public.agent_chats(id) on delete set null,
  error       text,
  constraint agent_workflow_runs_status_chk
    check (status in ('running', 'success', 'error')),
  constraint agent_workflow_runs_trigger_chk
    check (trigger in ('schedule', 'manual'))
);

create index if not exists agent_workflow_runs_wf_idx
  on public.agent_workflow_runs (workflow_id, started_at desc);
create index if not exists agent_workflow_runs_user_idx
  on public.agent_workflow_runs (user_id);
create index if not exists agent_workflow_runs_chat_idx
  on public.agent_workflow_runs (chat_id);

alter table public.agent_workflows enable row level security;
alter table public.agent_workflow_runs enable row level security;

-- Leitura própria; escrita só via service_role (rotas do AgentCore).
drop policy if exists "own workflows - select" on public.agent_workflows;
create policy "own workflows - select" on public.agent_workflows
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "own workflow runs - select" on public.agent_workflow_runs;
create policy "own workflow runs - select" on public.agent_workflow_runs
  for select to authenticated using ((select auth.uid()) = user_id);
