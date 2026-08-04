-- =============================================================================
-- agent_kb_docs — Base de conhecimento da empresa (contexto do Dexter)
-- Projeto Supabase "agentcore"
--
-- Documentos markdown curados (empresa, sistemas, projetos, times, glossário)
-- editados no painel admin. `always_load` entra no system prompt de toda
-- conversa; o resto é lido sob demanda pela tool kb__buscar.
-- Acesso: só service_role (o server injeta/lê; admin CRUD via rotas com gate
-- de role) — mesmo modelo de agent_knowledge.
-- =============================================================================

create table if not exists public.agent_kb_docs (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  title       text not null,
  -- empresa | sistemas | projetos | pessoas | glossario | geral
  category    text not null default 'geral',
  content     text not null default '',
  enabled     boolean not null default true,
  always_load boolean not null default false,
  sort        integer not null default 100,
  updated_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint agent_kb_docs_slug_fmt
    check (slug ~ '^[a-z0-9][a-z0-9-]{1,80}$'),
  constraint agent_kb_docs_title_len
    check (char_length(trim(title)) between 1 and 160),
  constraint agent_kb_docs_category_chk
    check (category in ('empresa', 'sistemas', 'projetos', 'pessoas', 'glossario', 'geral')),
  -- ~15k tokens por doc no pior caso; always_load deve ficar bem abaixo disso
  constraint agent_kb_docs_content_len
    check (char_length(content) <= 60000)
);

create index if not exists agent_kb_docs_load_idx
  on public.agent_kb_docs (enabled, always_load, sort);

create index if not exists agent_kb_docs_updated_by_idx
  on public.agent_kb_docs (updated_by);

drop trigger if exists trg_agent_kb_docs_updated on public.agent_kb_docs;
create trigger trg_agent_kb_docs_updated
  before update on public.agent_kb_docs
  for each row execute function public.set_updated_at();

alter table public.agent_kb_docs enable row level security;
-- Sem policies para authenticated de propósito: leitura/escrita só via
-- service_role no AgentCore (rotas admin com gate admin/master).

revoke all on public.agent_kb_docs from anon, authenticated;
