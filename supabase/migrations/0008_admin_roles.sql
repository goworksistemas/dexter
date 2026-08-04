-- =============================================================================
-- Admin roles no Dexter (agentcore)
-- - role: user | admin | master
-- - disabled_at: revoga acesso ao Dexter (backend bloqueia APIs)
-- - Master bootstrap: bpm@gowork.com.br
-- =============================================================================

alter table public.profiles
  add column if not exists role text not null default 'user'
    check (role in ('user', 'admin', 'master'));

alter table public.profiles
  add column if not exists disabled_at timestamptz;

comment on column public.profiles.role is
  'Papel no Dexter: user (padrão), admin (gerencia usuários), master (controle total).';
comment on column public.profiles.disabled_at is
  'Se preenchido, o usuário não pode usar o Dexter (APIs retornam 403).';

-- Bootstrap do master (só se o usuário já existir em auth/profiles)
update public.profiles
set role = 'master',
    disabled_at = null
where lower(email) = lower('bpm@gowork.com.br');

-- Garante master no signup futuro do e-mail bootstrap
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := 'user';
begin
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
