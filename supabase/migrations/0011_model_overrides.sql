-- =============================================================================
-- Overrides de modelos (admin). O catálogo em si é dinâmico via API dos
-- providers — esta tabela só guarda preferências (ligar/desligar/default/rótulo).
-- =============================================================================

create table if not exists public.dexter_model_overrides (
  id text primary key,
  enabled boolean not null default true,
  is_default boolean not null default false,
  label text,
  description text,
  sort_order int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.dexter_model_overrides is
  'Preferências admin sobre modelos descobertos dinamicamente (não é o catálogo).';

create unique index if not exists dexter_model_overrides_one_default_idx
  on public.dexter_model_overrides (is_default)
  where is_default = true;

alter table public.dexter_model_overrides enable row level security;

revoke all on table public.dexter_model_overrides from anon, authenticated;
grant select, insert, update, delete on table public.dexter_model_overrides to service_role;

-- Migra default/disabled do seed antigo, se existir
insert into public.dexter_model_overrides (id, enabled, is_default, label, description, sort_order)
select
  id,
  enabled,
  is_default,
  label,
  description,
  sort_order
from public.dexter_models
on conflict (id) do nothing;
