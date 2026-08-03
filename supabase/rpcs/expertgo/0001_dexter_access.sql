-- ============================================================================
-- Dexter read-only access layer for ExpertGo (Supabase project jiktluoucdaaugvlyrfn)
--
-- Domain: ExpertGo is a multi-tenant CRM. Every business table (deals,
-- contacts, activities, forms, ...) hangs off public.accounts (the tenant).
-- Membership/permission model:
--   - public.profiles(user_id, account_id, role, is_active) is the per-tenant
--     membership row. role is an enum: owner | manager | sales. A single
--     auth.users row (and therefore a single email) can have MULTIPLE profile
--     rows, one per account, since ExpertGo supports users belonging to
--     several tenants (observed for bpm@gowork.com.br: owner of "Gowork" and
--     owner of "Mock Tenant 01").
--   - public.user_active_account(user_id, account_id) records which of the
--     user's accounts is currently "active" in the app UI; used here as the
--     default tenant when the caller does not disambiguate.
--   - public.platform_admins(user_id) is a small global superuser list
--     (bypasses per-tenant membership checks entirely). bpm@gowork.com.br is
--     currently the only platform admin.
--
-- All functions below are SECURITY DEFINER with search_path = '' and fully
-- schema-qualified identifiers, and have EXECUTE revoked from public, anon
-- and authenticated (Dexter's backend is expected to call them with a role
-- that still has EXECUTE, e.g. the service role / postgres owner).
--
-- Access gate: every public-facing RPC's first parameter is p_email text.
-- Internally this resolves to an auth.users row, then to a tenant
-- (public.accounts) the caller is an active member of (or, for platform
-- admins, any tenant). Callers with no resolvable, active membership get:
--   raise exception 'sem_acesso' using errcode = '42501';
-- ============================================================================

set search_path = '';

-- ----------------------------------------------------------------------------
-- Internal helper: resolve an email to auth.users.id + platform-admin flag.
-- Not part of the public contract, but still locked down like everything else.
-- ----------------------------------------------------------------------------
create or replace function public.dexter_resolve_user(p_email text)
returns table (user_id uuid, is_platform_admin boolean)
language sql
security definer
set search_path = ''
as $$
  select u.id,
         exists (
           select 1
           from public.platform_admins pa
           where pa.user_id = u.id
         )
  from auth.users u
  where lower(u.email) = lower(p_email)
    and u.deleted_at is null
  limit 1;
$$;

revoke all on function public.dexter_resolve_user(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Internal helper: resolve the tenant (account) a caller may read from.
--   - Unknown email, or no active membership anywhere -> sem_acesso (42501).
--   - platform_admins: may pass any p_account_id; if omitted, falls back to
--     their user_active_account row.
--   - Regular users: p_account_id (if given) must match an active
--     public.profiles row for that user; if omitted, falls back to their
--     user_active_account row, then to their oldest active profile.
-- ----------------------------------------------------------------------------
create or replace function public.dexter_resolve_account(p_email text, p_account_id uuid default null)
returns table (account_id uuid, role text, is_platform_admin boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_is_admin boolean;
  v_account_id uuid;
  v_role text;
begin
  select r.user_id, r.is_platform_admin
    into v_user_id, v_is_admin
  from public.dexter_resolve_user(p_email) r;

  if v_user_id is null then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;

  if v_is_admin then
    v_account_id := p_account_id;

    if v_account_id is null then
      select uaa.account_id into v_account_id
      from public.user_active_account uaa
      where uaa.user_id = v_user_id;
    end if;

    if v_account_id is null then
      raise exception 'sem_acesso' using errcode = '42501';
    end if;

    return query select v_account_id, 'platform_admin'::text, true;
    return;
  end if;

  if p_account_id is not null then
    select p.account_id, p.role::text
      into v_account_id, v_role
    from public.profiles p
    where p.user_id = v_user_id
      and p.account_id = p_account_id
      and p.is_active = true;
  else
    select p.account_id, p.role::text
      into v_account_id, v_role
    from public.profiles p
    join public.user_active_account uaa
      on uaa.account_id = p.account_id
     and uaa.user_id = p.user_id
    where p.user_id = v_user_id
      and p.is_active = true;

    if v_account_id is null then
      select p.account_id, p.role::text
        into v_account_id, v_role
      from public.profiles p
      where p.user_id = v_user_id
        and p.is_active = true
      order by p.created_at asc
      limit 1;
    end if;
  end if;

  if v_account_id is null then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;

  return query select v_account_id, v_role, false;
end;
$$;

revoke all on function public.dexter_resolve_account(text, uuid) from public, anon, authenticated;

-- ============================================================================
-- 1) dexter_whoami(p_email text) returns jsonb
--    Identity + access shape: which auth user, platform-admin flag, every
--    tenant membership (account/role/is_active) and the currently active
--    tenant. Does NOT itself require an active membership to answer (a
--    disabled/former member should still be able to see "has_access: false"
--    rather than get an opaque error) -- but an unknown email still raises
--    sem_acesso, since there is nothing to report.
-- ============================================================================
create or replace function public.dexter_whoami(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_is_admin boolean;
  v_active_account_id uuid;
  v_accounts jsonb;
  v_has_access boolean;
begin
  select r.user_id, r.is_platform_admin
    into v_user_id, v_is_admin
  from public.dexter_resolve_user(p_email) r;

  if v_user_id is null then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;

  select uaa.account_id into v_active_account_id
  from public.user_active_account uaa
  where uaa.user_id = v_user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'account_id', p.account_id,
           'account_name', a.name,
           'role', p.role,
           'is_active', p.is_active
         ) order by a.name), '[]'::jsonb)
    into v_accounts
  from public.profiles p
  join public.accounts a on a.id = p.account_id
  where p.user_id = v_user_id;

  v_has_access := v_is_admin or exists (
    select 1 from public.profiles p
    where p.user_id = v_user_id and p.is_active = true
  );

  return jsonb_build_object(
    'email', p_email,
    'user_id', v_user_id,
    'is_platform_admin', v_is_admin,
    'has_access', v_has_access,
    'active_account_id', v_active_account_id,
    'accounts', v_accounts
  );
end;
$$;

revoke all on function public.dexter_whoami(text) from public, anon, authenticated;

-- ============================================================================
-- 2) dexter_pipeline_summary(p_email text, p_account_id uuid default null)
--    Aggregated deal counts/value per pipeline stage for the resolved tenant.
--    Naturally small (one row per stage), still capped at 50 for safety.
--    Gate: public.dexter_resolve_account (sem_acesso / 42501 on failure).
-- ============================================================================
create or replace function public.dexter_pipeline_summary(p_email text, p_account_id uuid default null)
returns table (
  pipeline_name text,
  stage_name text,
  stage_type text,
  deal_count bigint,
  total_value numeric
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account_id uuid;
begin
  select ra.account_id into v_account_id
  from public.dexter_resolve_account(p_email, p_account_id) ra;

  return query
  select pl.name,
         s.name,
         s.type::text,
         count(d.id),
         coalesce(sum(d.value), 0)
  from public.stages s
  join public.pipelines pl on pl.id = s.pipeline_id
  left join public.deals d on d.stage_id = s.id and d.account_id = v_account_id
  where s.account_id = v_account_id
  group by pl.name, pl.position, s.name, s.type, s.position
  order by pl.position, s.position
  limit 50;
end;
$$;

revoke all on function public.dexter_pipeline_summary(text, uuid) from public, anon, authenticated;

-- ============================================================================
-- 3) dexter_recent_deals(p_email text, p_account_id uuid default null, p_limit int default 20)
--    Most recently updated deals for the resolved tenant, with stage/pipeline/
--    contact/owner context. p_limit is clamped to [1, 50].
--    Gate: public.dexter_resolve_account (sem_acesso / 42501 on failure).
-- ============================================================================
create or replace function public.dexter_recent_deals(p_email text, p_account_id uuid default null, p_limit int default 20)
returns table (
  deal_id uuid,
  title text,
  value numeric,
  currency text,
  status text,
  stage_name text,
  pipeline_name text,
  contact_name text,
  owner_name text,
  expected_close date,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account_id uuid;
  v_limit int;
begin
  select ra.account_id into v_account_id
  from public.dexter_resolve_account(p_email, p_account_id) ra;

  v_limit := least(greatest(coalesce(p_limit, 20), 1), 50);

  return query
  select d.id,
         d.title,
         d.value,
         d.currency,
         d.status::text,
         s.name,
         pl.name,
         c.name,
         pr.full_name,
         d.expected_close,
         d.updated_at
  from public.deals d
  join public.stages s on s.id = d.stage_id
  join public.pipelines pl on pl.id = d.pipeline_id
  join public.contacts c on c.id = d.contact_id
  left join public.profiles pr on pr.id = d.owner_id
  where d.account_id = v_account_id
  order by d.updated_at desc
  limit v_limit;
end;
$$;

revoke all on function public.dexter_recent_deals(text, uuid, int) from public, anon, authenticated;

-- ============================================================================
-- 4) dexter_open_activities(p_email text, p_account_id uuid default null, p_limit int default 20)
--    Pending (not done) tasks/calls/meetings/notes for the resolved tenant,
--    soonest due first. p_limit is clamped to [1, 50].
--    Gate: public.dexter_resolve_account (sem_acesso / 42501 on failure).
-- ============================================================================
create or replace function public.dexter_open_activities(p_email text, p_account_id uuid default null, p_limit int default 20)
returns table (
  activity_id uuid,
  activity_type text,
  content text,
  due_at timestamptz,
  contact_name text,
  deal_title text,
  created_by_name text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account_id uuid;
  v_limit int;
begin
  select ra.account_id into v_account_id
  from public.dexter_resolve_account(p_email, p_account_id) ra;

  v_limit := least(greatest(coalesce(p_limit, 20), 1), 50);

  return query
  select a.id,
         a.type::text,
         a.content,
         a.due_at,
         c.name,
         d.title,
         pr.full_name
  from public.activities a
  left join public.contacts c on c.id = a.contact_id
  left join public.deals d on d.id = a.deal_id
  left join public.profiles pr on pr.id = a.created_by
  where a.account_id = v_account_id
    and a.done = false
  order by a.due_at asc nulls last
  limit v_limit;
end;
$$;

revoke all on function public.dexter_open_activities(text, uuid, int) from public, anon, authenticated;
