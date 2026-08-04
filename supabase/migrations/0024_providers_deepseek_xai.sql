-- =============================================================================
-- 0024 — Novos provedores: DeepSeek e Grok (xAI)
-- Relaxa os checks de provider das tabelas de chaves para aceitar os dois.
-- =============================================================================

alter table public.agent_user_api_keys
  drop constraint if exists agent_user_api_keys_provider_chk;
alter table public.agent_user_api_keys
  add constraint agent_user_api_keys_provider_chk
  check (provider in ('anthropic', 'openai', 'gemini', 'deepseek', 'xai'));

alter table public.dexter_provider_keys
  drop constraint if exists dexter_provider_keys_provider_chk;
alter table public.dexter_provider_keys
  add constraint dexter_provider_keys_provider_chk
  check (provider in ('anthropic', 'openai', 'gemini', 'deepseek', 'xai'));
