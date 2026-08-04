-- =============================================================================
-- Conectores OAuth por usuário (Notion / Outlook)
-- Tokens ficam no AgentCore DB; Infisical só tem Client ID/Secret da app.
-- authenticated: SELECT só de colunas de status (sem tokens).
-- AgentCore usa service_role (bypassa RLS) para ler/gravar tokens.
-- =============================================================================

create table if not exists public.dexter_user_connectors (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  provider       text not null check (provider in ('notion', 'outlook')),
  access_token   text not null,
  refresh_token  text,
  expires_at     timestamptz,
  meta           jsonb not null default '{}'::jsonb,
  status         text not null default 'connected'
                   check (status in ('connected', 'revoked', 'error')),
  connected_at   timestamptz not null default now(),
  revoked_at     timestamptz,
  updated_at     timestamptz not null default now(),
  unique (user_id, provider)
);

create index if not exists dexter_user_connectors_user_idx
  on public.dexter_user_connectors (user_id);

drop trigger if exists trg_dexter_user_connectors_updated
  on public.dexter_user_connectors;
create trigger trg_dexter_user_connectors_updated
  before update on public.dexter_user_connectors
  for each row execute function public.set_updated_at();

comment on table public.dexter_user_connectors is
  'OAuth delegated tokens Notion/Outlook por user_id. Tokens só via service_role.';

create table if not exists public.dexter_connector_oauth_states (
  state       text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  provider    text not null check (provider in ('notion', 'outlook')),
  return_to   text,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists dexter_connector_oauth_states_expires_idx
  on public.dexter_connector_oauth_states (expires_at);

create table if not exists public.dexter_connector_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  provider    text not null check (provider in ('notion', 'outlook')),
  event       text not null
                check (event in ('connect', 'disconnect', 'token_refresh', 'error')),
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists dexter_connector_events_user_idx
  on public.dexter_connector_events (user_id, created_at desc);

alter table public.dexter_user_connectors enable row level security;
alter table public.dexter_connector_oauth_states enable row level security;
alter table public.dexter_connector_events enable row level security;

revoke all on table public.dexter_user_connectors from anon, authenticated;
revoke all on table public.dexter_connector_oauth_states from anon, authenticated;
revoke all on table public.dexter_connector_events from anon, authenticated;

drop policy if exists "dexter_user_connectors select own status"
  on public.dexter_user_connectors;
create policy "dexter_user_connectors select own status"
  on public.dexter_user_connectors
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Colunas de status apenas — access_token / refresh_token sem GRANT.
grant select (
  id,
  user_id,
  provider,
  status,
  meta,
  expires_at,
  connected_at,
  revoked_at,
  updated_at
) on public.dexter_user_connectors to authenticated;

drop policy if exists "dexter_connector_events select own"
  on public.dexter_connector_events;
create policy "dexter_connector_events select own"
  on public.dexter_connector_events
  for select
  to authenticated
  using (user_id = (select auth.uid()));

grant select on public.dexter_connector_events to authenticated;

-- oauth_states: sem policy / sem grant → só service_role.

comment on column public.profiles.preferences is
  'Preferências (jsonb). Campos: theme, sidebarCollapsed, connectors.{notion,outlook} (enabled só se connected via OAuth).';
