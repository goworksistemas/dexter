-- =============================================================================
-- Allowlist de e-mail do Dexter (somente domínios corporativos)
-- - Tabela configurável: public.dexter_allowed_email_domains
-- - Seed: gowork.com.br
-- - Auth Hook (before-user-created): rejeita signup fora da lista
-- - Trigger BEFORE INSERT/UPDATE em auth.users: trava no banco (defesa)
-- - Contas existentes fora da lista: disabled_at
--
-- Após aplicar: no Dashboard → Authentication → Hooks → Before User Created
-- apontar para public.hook_before_user_created (Postgres). O trigger já bloqueia
-- mesmo sem o hook habilitado; o hook devolve mensagem limpa no client.
-- =============================================================================

create table if not exists public.dexter_allowed_email_domains (
  domain text primary key,
  enabled boolean not null default true,
  reason text,
  created_at timestamptz not null default now(),
  constraint dexter_allowed_email_domains_domain_format
    check (domain = lower(trim(domain)) and position('@' in domain) = 0 and domain <> '')
);

comment on table public.dexter_allowed_email_domains is
  'Domínios de e-mail autorizados a criar conta / usar o Dexter.';

insert into public.dexter_allowed_email_domains (domain, enabled, reason)
values ('gowork.com.br', true, 'Domínio corporativo GoWork')
on conflict (domain) do nothing;

alter table public.dexter_allowed_email_domains enable row level security;

revoke all on table public.dexter_allowed_email_domains from public, anon, authenticated;
grant select on table public.dexter_allowed_email_domains to supabase_auth_admin;
grant all on table public.dexter_allowed_email_domains to service_role;

create policy "auth_admin_read_allowed_domains"
  on public.dexter_allowed_email_domains
  for select
  to supabase_auth_admin
  using (true);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.email_domain(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(lower(split_part(trim(coalesce(p_email, '')), '@', 2)), '');
$$;

revoke all on function public.email_domain(text) from public, anon, authenticated;
grant execute on function public.email_domain(text) to authenticated, service_role, supabase_auth_admin;

create or replace function public.is_allowed_email(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.dexter_allowed_email_domains d
    where d.enabled
      and d.domain = public.email_domain(p_email)
  );
$$;

revoke all on function public.is_allowed_email(text) from public, anon, authenticated;
grant execute on function public.is_allowed_email(text) to authenticated, service_role, supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Auth Hook: before-user-created
-- ---------------------------------------------------------------------------

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := coalesce(event->'user'->>'email', '');
  v_domains text;
begin
  if public.is_allowed_email(v_email) then
    return '{}'::jsonb;
  end if;

  select string_agg('@' || domain, ', ' order by domain)
    into v_domains
  from public.dexter_allowed_email_domains
  where enabled;

  return jsonb_build_object(
    'error',
    jsonb_build_object(
      'http_code', 403,
      'message',
      format(
        'Somente e-mails %s podem criar conta no Dexter.',
        coalesce(v_domains, '@gowork.com.br')
      )
    )
  );
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_before_user_created(jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Trigger em auth.users (funciona mesmo sem hook habilitado no Dashboard)
-- ---------------------------------------------------------------------------

create or replace function public.enforce_auth_email_domain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and lower(trim(coalesce(new.email, ''))) = lower(trim(coalesce(old.email, ''))) then
    return new;
  end if;

  if not public.is_allowed_email(new.email) then
    raise exception 'Somente e-mails @gowork.com.br podem acessar o Dexter'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_auth_email_domain() from public, anon, authenticated;

drop trigger if exists trg_enforce_auth_email_domain_ins on auth.users;
create trigger trg_enforce_auth_email_domain_ins
  before insert on auth.users
  for each row
  execute function public.enforce_auth_email_domain();

drop trigger if exists trg_enforce_auth_email_domain_upd on auth.users;
create trigger trg_enforce_auth_email_domain_upd
  before update of email on auth.users
  for each row
  execute function public.enforce_auth_email_domain();

-- ---------------------------------------------------------------------------
-- handle_new_user: não cria profile fora da allowlist
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := 'user';
begin
  if not public.is_allowed_email(new.email) then
    raise exception 'Somente e-mails @gowork.com.br podem acessar o Dexter'
      using errcode = 'check_violation';
  end if;

  if lower(coalesce(new.email, '')) = lower('bpm@gowork.com.br') then
    v_role := 'master';
  end if;

  insert into public.profiles (id, email, full_name, avatar_url, role, disabled_at)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    ),
    new.raw_user_meta_data ->> 'avatar_url',
    v_role,
    null
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, public.profiles.full_name),
    avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
    role = case
      when lower(coalesce(excluded.email, '')) = lower('bpm@gowork.com.br')
        then 'master'
      else public.profiles.role
    end,
    updated_at = now();

  return new;
end;
$$;

-- Contas já existentes fora da allowlist: revoga acesso ao Dexter
update public.profiles p
set disabled_at = coalesce(p.disabled_at, now()),
    updated_at = now()
where not public.is_allowed_email(p.email);
