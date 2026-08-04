-- PKCE / DCR payload para OAuth MCP (Notion) e estados OAuth clássicos.
alter table public.dexter_connector_oauth_states
  add column if not exists payload jsonb not null default '{}'::jsonb;

comment on column public.dexter_connector_oauth_states.payload is
  'Dados transitórios do fluxo OAuth (code_verifier, client_id MCP, etc). Só service_role.';
