-- agent_artifacts: artefatos HTML/Markdown editáveis por conversa
-- Projeto: jtvscxbwralvzpfhtqcs (agentcore)

create table if not exists public.agent_artifacts (
  id           uuid primary key default gen_random_uuid(),
  chat_id      uuid not null references public.agent_chats(id) on delete cascade,
  message_id   uuid,
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('html', 'markdown')),
  title        text,
  content      text not null,
  version      integer not null default 1 check (version >= 1),
  source_key   text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint agent_artifacts_source_key_len check (char_length(trim(source_key)) between 1 and 200),
  constraint agent_artifacts_chat_source_unique unique (chat_id, source_key)
);

create index if not exists agent_artifacts_chat_idx
  on public.agent_artifacts (chat_id, updated_at desc);
create index if not exists agent_artifacts_user_idx
  on public.agent_artifacts (user_id);
create index if not exists agent_artifacts_message_idx
  on public.agent_artifacts (message_id);

drop trigger if exists trg_agent_artifacts_updated on public.agent_artifacts;
create trigger trg_agent_artifacts_updated
  before update on public.agent_artifacts
  for each row execute function public.set_updated_at();

alter table public.agent_artifacts enable row level security;

drop policy if exists "own artifacts - select" on public.agent_artifacts;
create policy "own artifacts - select" on public.agent_artifacts
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "own artifacts - insert" on public.agent_artifacts;
create policy "own artifacts - insert" on public.agent_artifacts
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.agent_chats c
      where c.id = chat_id and c.user_id = (select auth.uid())
    )
  );

drop policy if exists "own artifacts - update" on public.agent_artifacts;
create policy "own artifacts - update" on public.agent_artifacts
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own artifacts - delete" on public.agent_artifacts;
create policy "own artifacts - delete" on public.agent_artifacts
  for delete to authenticated
  using (user_id = (select auth.uid()));

grant select, insert, update, delete on public.agent_artifacts to authenticated;

comment on table public.agent_artifacts is
  'Artefatos HTML/Markdown editáveis (estilo Claude) associados a conversas do AgentCore.';
