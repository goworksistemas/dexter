-- =============================================================================
-- agent_projects — Projetos estilo ChatGPT/Claude (instruções, chats, arquivos)
-- Projeto Supabase "agentcore"
-- =============================================================================

-- ---------------------------------------------------------------------------
-- agent_projects
-- ---------------------------------------------------------------------------
create table if not exists public.agent_projects (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  name         text not null,
  instructions text not null default '',
  color        text,
  icon         text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint agent_projects_name_len check (char_length(trim(name)) between 1 and 120)
);

create index if not exists agent_projects_user_idx
  on public.agent_projects (user_id, updated_at desc);

drop trigger if exists trg_agent_projects_updated on public.agent_projects;
create trigger trg_agent_projects_updated
  before update on public.agent_projects
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- agent_chats.project_id — conversa pode pertencer a um projeto
-- ---------------------------------------------------------------------------
alter table public.agent_chats
  add column if not exists project_id uuid
    references public.agent_projects(id) on delete set null;

create index if not exists agent_chats_project_idx
  on public.agent_chats (project_id);

-- ---------------------------------------------------------------------------
-- agent_knowledge.project_id — RAG escopado ao projeto (quando usado)
-- ---------------------------------------------------------------------------
alter table public.agent_knowledge
  add column if not exists project_id uuid
    references public.agent_projects(id) on delete cascade;

alter table public.agent_knowledge
  add column if not exists storage_path text;

create index if not exists agent_knowledge_project_idx
  on public.agent_knowledge (project_id);

-- ---------------------------------------------------------------------------
-- agent_project_files — metadados de arquivos do projeto (conteúdo no Storage)
-- ---------------------------------------------------------------------------
create table if not exists public.agent_project_files (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.agent_projects(id) on delete cascade,
  user_id      uuid not null,
  name         text not null,
  storage_path text not null,
  mime_type    text,
  size_bytes   integer not null default 0 check (size_bytes >= 0),
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  constraint agent_project_files_name_len check (char_length(trim(name)) between 1 and 260)
);

create index if not exists agent_project_files_project_idx
  on public.agent_project_files (project_id, created_at desc);
create index if not exists agent_project_files_user_idx
  on public.agent_project_files (user_id);

-- ---------------------------------------------------------------------------
-- Storage bucket (privado; backend usa service_role)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('project-files', 'project-files', false, 10485760)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.agent_projects enable row level security;
alter table public.agent_project_files enable row level security;

drop policy if exists "own projects - select" on public.agent_projects;
create policy "own projects - select" on public.agent_projects
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "own projects - insert" on public.agent_projects;
create policy "own projects - insert" on public.agent_projects
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "own projects - update" on public.agent_projects;
create policy "own projects - update" on public.agent_projects
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own projects - delete" on public.agent_projects;
create policy "own projects - delete" on public.agent_projects
  for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "own project files - select" on public.agent_project_files;
create policy "own project files - select" on public.agent_project_files
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "own project files - insert" on public.agent_project_files;
create policy "own project files - insert" on public.agent_project_files
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.agent_projects p
      where p.id = project_id and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "own project files - delete" on public.agent_project_files;
create policy "own project files - delete" on public.agent_project_files
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- Storage: sem policy para authenticated → acesso só via service_role (backend).
-- Defesa em profundidade: paths sob {user_id}/{project_id}/...

-- ---------------------------------------------------------------------------
-- Grants (mesmo padrão 0002)
-- ---------------------------------------------------------------------------
revoke all on table public.agent_projects from anon, authenticated;
revoke all on table public.agent_project_files from anon, authenticated;

grant select, insert, update, delete on table public.agent_projects to authenticated;
grant select, insert, delete on table public.agent_project_files to authenticated;

grant all on table public.agent_projects to service_role;
grant all on table public.agent_project_files to service_role;
