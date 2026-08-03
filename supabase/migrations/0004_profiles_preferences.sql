-- =============================================================================
-- profiles.preferences — preferências do usuário (tema, etc.) persistidas no DB
-- Projeto: jtvscxbwralvzpfhtqcs (agentcore)
-- =============================================================================

alter table public.profiles
  add column if not exists preferences jsonb not null default '{}'::jsonb;

comment on column public.profiles.preferences is
  'Preferências do usuário (ex.: {"theme": "system"|"light"|"dark"}).';
