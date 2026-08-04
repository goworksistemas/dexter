-- =============================================================================
-- Catálogo de modelos Dexter (controle via admin; chaves ficam no Infisical)
-- =============================================================================

create table if not exists public.dexter_models (
  id text primary key,
  provider text not null
    check (provider in ('anthropic', 'openai', 'gemini', 'ollama')),
  api_model text not null,
  label text not null,
  description text not null default '',
  traits text[] not null default '{}',
  enabled boolean not null default true,
  is_default boolean not null default false,
  sort_order int not null default 100,
  max_output_tokens int not null default 32000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.dexter_models is
  'Modelos do seletor Dexter. enabled/is_default controlados pelo admin; API keys no Infisical.';

create unique index if not exists dexter_models_one_default_idx
  on public.dexter_models (is_default)
  where is_default = true;

alter table public.dexter_models enable row level security;

revoke all on table public.dexter_models from anon, authenticated;
grant select, insert, update, delete on table public.dexter_models to service_role;

insert into public.dexter_models (
  id, provider, api_model, label, description, traits,
  enabled, is_default, sort_order, max_output_tokens
) values
  (
    'claude-sonnet-5',
    'anthropic',
    'claude-sonnet-5',
    'Claude Sonnet 5',
    'Equilíbrio entre qualidade e velocidade — o padrão para o dia a dia no Dexter.',
    array['Equilibrado', 'Ferramentas', 'Código'],
    true, true, 10, 128000
  ),
  (
    'claude-opus-5',
    'anthropic',
    'claude-opus-5',
    'Claude Opus 5',
    'Máxima capacidade de raciocínio e análise profunda. Mais lento e caro.',
    array['Mais capaz', 'Raciocínio', 'Complexo'],
    true, false, 20, 128000
  ),
  (
    'claude-haiku-4-5',
    'anthropic',
    'claude-haiku-4-5-20251001',
    'Claude Haiku 4.5',
    'Respostas rápidas e econômicas para perguntas simples e iterações curtas.',
    array['Rápido', 'Econômico', 'Leve'],
    true, false, 30, 64000
  ),
  (
    'gpt-4.1',
    'openai',
    'gpt-4.1',
    'GPT-4.1',
    'Modelo forte da OpenAI para análise, código e uso com ferramentas.',
    array['OpenAI', 'Ferramentas', 'Versátil'],
    true, false, 40, 32768
  ),
  (
    'gpt-4o',
    'openai',
    'gpt-4o',
    'GPT-4o',
    'Bom equilíbrio da OpenAI — rápido e capaz no dia a dia.',
    array['OpenAI', 'Rápido', 'Equilibrado'],
    true, false, 50, 16384
  ),
  (
    'o4-mini',
    'openai',
    'o4-mini',
    'o4-mini',
    'Raciocínio econômico da OpenAI para tarefas que pedem mais reflexão.',
    array['OpenAI', 'Raciocínio', 'Econômico'],
    true, false, 60, 100000
  ),
  (
    'gemini-2.5-pro',
    'gemini',
    'gemini-2.5-pro',
    'Gemini 2.5 Pro',
    'Modelo avançado do Google — forte em contexto longo e análise.',
    array['Google', 'Contexto longo', 'Pro'],
    true, false, 70, 65536
  ),
  (
    'gemini-2.5-flash',
    'gemini',
    'gemini-2.5-flash',
    'Gemini 2.5 Flash',
    'Gemini rápido e barato para respostas ágeis.',
    array['Google', 'Rápido', 'Econômico'],
    true, false, 80, 65536
  ),
  (
    'ollama-default',
    'ollama',
    'qwen2.5:7b',
    'Ollama (self-hosted)',
    'Modelo local na infra GoWork — sem custo de API e dados ficam internos.',
    array['Self-hosted', 'Privado', 'Sem custo API'],
    true, false, 90, 8192
  )
on conflict (id) do update set
  provider = excluded.provider,
  api_model = excluded.api_model,
  label = excluded.label,
  description = excluded.description,
  traits = excluded.traits,
  sort_order = excluded.sort_order,
  max_output_tokens = excluded.max_output_tokens,
  updated_at = now();
