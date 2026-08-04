-- RPC usada pela edge function cross-login-dexter para checar se um e-mail
-- ja possui conta ANTES de gerar o magic link (generateLink com magiclink
-- criaria o usuario automaticamente). SECURITY DEFINER para ler auth.users.
create or replace function public.check_user_exists_by_email(user_email text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.users
    where lower(email) = lower(user_email)
      and deleted_at is null
  );
$$;

revoke all on function public.check_user_exists_by_email(text) from public;
revoke all on function public.check_user_exists_by_email(text) from anon, authenticated;
grant execute on function public.check_user_exists_by_email(text) to service_role;
