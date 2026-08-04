-- Links públicos de leitura para conversas e artefatos (estilo ChatGPT share).
-- Acesso anônimo só via AgentCore (service role); tokens UUID v4 não adivinháveis.

alter table public.agent_chats
  add column if not exists share_token uuid unique,
  add column if not exists shared_at timestamptz;

alter table public.agent_artifacts
  add column if not exists share_token uuid unique,
  add column if not exists shared_at timestamptz;

create index if not exists agent_chats_share_token_idx
  on public.agent_chats (share_token)
  where share_token is not null;

create index if not exists agent_artifacts_share_token_idx
  on public.agent_artifacts (share_token)
  where share_token is not null;

comment on column public.agent_chats.share_token is
  'Token opaco para GET /api/public/chats/:token (leitura anônima via AgentCore).';
comment on column public.agent_artifacts.share_token is
  'Token opaco para GET /api/public/artifacts/:token (preview público).';
