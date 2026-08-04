-- =============================================================================
-- agent_user_api_keys — Chaves de API pessoais (BYOK) por usuário/provedor
-- Projeto Supabase "agentcore"
--
-- A chave é criptografada no AgentCore (AES-256-GCM com USER_API_KEYS_SECRET
-- do Infisical) ANTES de chegar aqui — o banco nunca vê o valor em claro.
-- Nunca é devolvida ao cliente: a UI só recebe last4. Acesso só service_role.
-- =============================================================================

create table if not exists public.agent_user_api_keys (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  provider   text not null,
  -- base64(iv || authTag || ciphertext) — AES-256-GCM
  ciphertext text not null,
  last4      text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_user_api_keys_provider_chk
    check (provider in ('anthropic', 'openai', 'gemini')),
  constraint agent_user_api_keys_unique unique (user_id, provider)
);

create index if not exists agent_user_api_keys_user_idx
  on public.agent_user_api_keys (user_id);

drop trigger if exists trg_agent_user_api_keys_updated on public.agent_user_api_keys;
create trigger trg_agent_user_api_keys_updated
  before update on public.agent_user_api_keys
  for each row execute function public.set_updated_at();

alter table public.agent_user_api_keys enable row level security;
-- Sem policies de propósito: nem select para authenticated — só service_role.

revoke all on public.agent_user_api_keys from anon, authenticated;
