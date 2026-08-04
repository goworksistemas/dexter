-- Origem do preço: sync automático vs override admin.

alter table public.dexter_model_pricing
  add column if not exists pricing_source text not null default 'sync'
    check (pricing_source in ('sync', 'admin'));

comment on column public.dexter_model_pricing.pricing_source is
  'sync = preenchido pelo pricing-sync; admin = editado no painel (não sobrescrever).';
