-- =============================================================================
-- AgentCore harden — profiles, FKs auth.users, RLS initplan, grants, indexes
-- Projeto: jtvscxbwralvzpfhtqcs (agentcore)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0) Limpa órfãos de DEV_USER / user_id sem auth.users (antes das FKs)
-- ---------------------------------------------------------------------------
delete from public.agent_tool_calls tc
where tc.user_id is not null
  and not exists (select 1 from auth.users u where u.id = tc.user_id);

delete from public.agent_feedback f
where f.user_id is not null
  and not exists (select 1 from auth.users u where u.id = f.user_id);

delete from public.agent_messages m
using public.agent_chats c
where m.chat_id = c.id
  and c.user_id is not null
  and not exists (select 1 from auth.users u where u.id = c.user_id);

delete from public.agent_chats c
where c.user_id is not null
  and not exists (select 1 from auth.users u where u.id = c.user_id);

-- ---------------------------------------------------------------------------
-- 1) profiles (padrão Supabase)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists trg_profiles_updated on public.profiles;
create trigger trg_profiles_updated
  before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

drop policy if exists "profiles select own" on public.profiles;
drop policy if exists "profiles update own" on public.profiles;
drop policy if exists "profiles insert own" on public.profiles;

create policy "profiles select own" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy "profiles update own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "profiles insert own" on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, public.profiles.full_name),
    avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill usuários já existentes
insert into public.profiles (id, email, full_name, avatar_url)
select
  u.id,
  u.email,
  coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'),
  u.raw_user_meta_data ->> 'avatar_url'
from auth.users u
on conflict (id) do nothing;

revoke all on function public.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) FKs user_id → auth.users + índice message_id
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_chats_user_id_fkey'
  ) then
    alter table public.agent_chats
      add constraint agent_chats_user_id_fkey
      foreign key (user_id) references auth.users (id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'agent_tool_calls_user_id_fkey'
  ) then
    alter table public.agent_tool_calls
      add constraint agent_tool_calls_user_id_fkey
      foreign key (user_id) references auth.users (id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'agent_feedback_user_id_fkey'
  ) then
    alter table public.agent_feedback
      add constraint agent_feedback_user_id_fkey
      foreign key (user_id) references auth.users (id) on delete set null;
  end if;
end $$;

create index if not exists agent_tool_calls_message_idx
  on public.agent_tool_calls (message_id);
create index if not exists agent_feedback_user_idx
  on public.agent_feedback (user_id);
create index if not exists agent_tool_calls_user_idx
  on public.agent_tool_calls (user_id);

-- Dexter web: user_id obrigatório (Gabi/whatsapp pode continuar null)
alter table public.agent_chats drop constraint if exists agent_chats_dexter_web_requires_user;
alter table public.agent_chats
  add constraint agent_chats_dexter_web_requires_user
  check (
    not (agent = 'dexter' and channel = 'web')
    or user_id is not null
  );

-- ---------------------------------------------------------------------------
-- 3) Recriar policies com (select auth.uid()) + WITH CHECK + DELETE
-- ---------------------------------------------------------------------------
drop policy if exists "own chats - select" on public.agent_chats;
drop policy if exists "own chats - insert" on public.agent_chats;
drop policy if exists "own chats - update" on public.agent_chats;
drop policy if exists "own chats - delete" on public.agent_chats;

create policy "own chats - select" on public.agent_chats
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "own chats - insert" on public.agent_chats
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "own chats - update" on public.agent_chats
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "own chats - delete" on public.agent_chats
  for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "own messages - select" on public.agent_messages;
create policy "own messages - select" on public.agent_messages
  for select to authenticated
  using (
    exists (
      select 1 from public.agent_chats c
      where c.id = agent_messages.chat_id
        and c.user_id = (select auth.uid())
    )
  );

drop policy if exists "own tool_calls - select" on public.agent_tool_calls;
create policy "own tool_calls - select" on public.agent_tool_calls
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "own feedback - all" on public.agent_feedback;
create policy "own feedback - all" on public.agent_feedback
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 4) Grants: tira anon; authenticated só o necessário; knowledge fechado
-- ---------------------------------------------------------------------------
revoke all on table public.agent_chats from anon, authenticated;
revoke all on table public.agent_messages from anon, authenticated;
revoke all on table public.agent_tool_calls from anon, authenticated;
revoke all on table public.agent_feedback from anon, authenticated;
revoke all on table public.agent_knowledge from anon, authenticated;
revoke all on table public.profiles from anon, authenticated;

grant select, insert, update, delete on table public.agent_chats to authenticated;
grant select on table public.agent_messages to authenticated;
grant select on table public.agent_tool_calls to authenticated;
grant select, insert, update, delete on table public.agent_feedback to authenticated;
grant select, insert, update on table public.profiles to authenticated;
-- agent_knowledge: sem grant a authenticated/anon (só service_role/postgres)

grant all on table public.agent_chats to service_role;
grant all on table public.agent_messages to service_role;
grant all on table public.agent_tool_calls to service_role;
grant all on table public.agent_feedback to service_role;
grant all on table public.agent_knowledge to service_role;
grant all on table public.profiles to service_role;

-- ---------------------------------------------------------------------------
-- 5) SECURITY DEFINER exposta: revoga EXECUTE de rls_auto_enable
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
      and pg_get_function_identity_arguments(p.oid) = ''
  ) then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6) Extensão vector → schema extensions (quando possível)
-- ---------------------------------------------------------------------------
create schema if not exists extensions;
do $$
begin
  if exists (
    select 1 from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'vector' and n.nspname = 'public'
  ) then
    alter extension vector set schema extensions;
  end if;
exception
  when others then
    raise notice 'Não foi possível mover vector para extensions: %', sqlerrm;
end $$;
