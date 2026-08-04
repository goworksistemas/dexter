-- Metadados de providers e faixa de custo por modelo — tudo editável, sem hardcode no código.

create table if not exists public.dexter_providers (
  id text primary key,
  label text not null,
  default_cost_tier text
    check (
      default_cost_tier is null
      or default_cost_tier in ('free', 'cheap', 'standard', 'premium')
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.dexter_providers is
  'Providers descobertos dinamicamente — rótulo de exibição e custo padrão (admin).';

alter table public.dexter_model_overrides
  add column if not exists cost_tier text
    check (
      cost_tier is null
      or cost_tier in ('free', 'cheap', 'standard', 'premium')
    );

comment on column public.dexter_model_overrides.cost_tier is
  'Faixa de custo deste modelo; null herda dexter_providers.default_cost_tier.';

alter table public.dexter_providers enable row level security;
revoke all on table public.dexter_providers from anon, authenticated;
grant select, insert, update, delete on table public.dexter_providers to service_role;

drop trigger if exists trg_dexter_providers_updated on public.dexter_providers;
create trigger trg_dexter_providers_updated
  before update on public.dexter_providers
  for each row execute function public.set_updated_at();
