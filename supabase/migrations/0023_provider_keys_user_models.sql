-- =============================================================================
-- 0023 — Chaves de API globais no banco + modelos permitidos por usuário
-- Projeto Supabase "agentcore"
--
-- 1. dexter_provider_keys: chave de API global por provedor (Anthropic/OpenAI/
--    Gemini), gerenciada pelo painel admin. Substitui as chaves do Infisical —
--    o env vira só fallback. Cifrada no AgentCore (AES-256-GCM com
--    USER_API_KEYS_SECRET) antes de chegar aqui; o banco nunca vê o claro e a
--    UI só recebe last4. Acesso só service_role.
--
-- 2. profiles.allowed_models: controle por usuário de quais modelos pode usar.
--    NULL = todos os modelos habilitados; array = só estes ids (provider:modelo).
--    Admin/master nunca são restringidos (enforcement no AgentCore).
-- =============================================================================

create table if not exists public.dexter_provider_keys (
  provider   text primary key,
  -- base64(iv || authTag || ciphertext) — AES-256-GCM
  ciphertext text not null,
  last4      text not null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dexter_provider_keys_provider_chk
    check (provider in ('anthropic', 'openai', 'gemini'))
);

drop trigger if exists trg_dexter_provider_keys_updated on public.dexter_provider_keys;
create trigger trg_dexter_provider_keys_updated
  before update on public.dexter_provider_keys
  for each row execute function public.set_updated_at();

alter table public.dexter_provider_keys enable row level security;
-- Sem policies de propósito: nem select para authenticated — só service_role.

revoke all on public.dexter_provider_keys from anon, authenticated;

alter table public.profiles
  add column if not exists allowed_models text[];

comment on column public.profiles.allowed_models is
  'Modelos LLM permitidos (ids provider:modelo). NULL = todos os habilitados. '
  'Vazio = nenhum. Ignorado para admin/master.';
