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

-- ============================================================================
-- 5) dexter_deals_busca(p_email text, p_account_id uuid default null,
--    p_owner text default null, p_estagio text default null,
--    p_contato text default null, p_status text default null,
--    p_limit int default 50)
--    Modular/filterable deal search for the resolved tenant. Every filter is
--    optional and AND-combined. p_owner/p_estagio/p_contato match by
--    substring (ilike) against owner full_name / stage name / contact name.
--    p_status matches public.deal_status (open/won/lost), case-insensitive,
--    with a small pt-BR synonym map (aberto/ganho/perdido, ...). Returns one
--    row per deal PLUS a total_count column (window count over the full
--    filtered set, unaffected by p_limit) so callers can tell "50 of 137"
--    apart from "50 of 50". p_limit is clamped to [1, 100].
--    Gate: public.dexter_resolve_account (sem_acesso / 42501 on failure).
-- ============================================================================
create or replace function public.dexter_deals_busca(
  p_email text,
  p_account_id uuid default null,
  p_owner text default null,
  p_estagio text default null,
  p_contato text default null,
  p_status text default null,
  p_limit int default 50
)
returns table (
  total_count bigint,
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
  v_status text;
begin
  select ra.account_id into v_account_id
  from public.dexter_resolve_account(p_email, p_account_id) ra;

  v_limit := least(greatest(coalesce(p_limit, 50), 1), 100);

  if p_status is not null then
    v_status := lower(trim(p_status));
    v_status := case v_status
      when 'aberto' then 'open'
      when 'aberta' then 'open'
      when 'ganho' then 'won'
      when 'ganha' then 'won'
      when 'perdido' then 'lost'
      when 'perdida' then 'lost'
      else v_status
    end;
  end if;

  return query
  select count(*) over()::bigint,
         d.id,
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
    and (p_owner is null or pr.full_name ilike '%' || p_owner || '%')
    and (p_estagio is null or s.name ilike '%' || p_estagio || '%')
    and (p_contato is null or c.name ilike '%' || p_contato || '%')
    and (v_status is null or d.status::text = v_status)
  order by d.updated_at desc
  limit v_limit;
end;
$$;

revoke all on function public.dexter_deals_busca(text, uuid, text, text, text, text, int) from public, anon, authenticated;

-- ============================================================================
-- 6) dexter_atividades_busca(p_email text, p_account_id uuid default null,
--    p_tipo text default null, p_owner text default null,
--    p_pendentes boolean default true, p_limit int default 50)
--    Modular/filterable activity search for the resolved tenant. p_tipo
--    matches public.activity_type (note/call/email/task/meeting),
--    case-insensitive, with a small pt-BR synonym map. p_owner matches by
--    substring (ilike) against the activity creator's full_name.
--    p_pendentes (default true) restricts to not-done activities, matching
--    dexter_open_activities' existing behavior; pass false to see both done
--    and pending activities. Returns one row per activity PLUS a total_count
--    column (window count over the full filtered set, unaffected by
--    p_limit). p_limit is clamped to [1, 100].
--    Gate: public.dexter_resolve_account (sem_acesso / 42501 on failure).
-- ============================================================================
create or replace function public.dexter_atividades_busca(
  p_email text,
  p_account_id uuid default null,
  p_tipo text default null,
  p_owner text default null,
  p_pendentes boolean default true,
  p_limit int default 50
)
returns table (
  total_count bigint,
  activity_id uuid,
  activity_type text,
  content text,
  due_at timestamptz,
  done boolean,
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
  v_tipo text;
begin
  select ra.account_id into v_account_id
  from public.dexter_resolve_account(p_email, p_account_id) ra;

  v_limit := least(greatest(coalesce(p_limit, 50), 1), 100);

  if p_tipo is not null then
    v_tipo := lower(trim(p_tipo));
    v_tipo := case v_tipo
      when 'nota' then 'note'
      when 'ligacao' then 'call'
      when 'ligação' then 'call'
      when 'chamada' then 'call'
      when 'e-mail' then 'email'
      when 'tarefa' then 'task'
      when 'reuniao' then 'meeting'
      when 'reunião' then 'meeting'
      else v_tipo
    end;
  end if;

  return query
  select count(*) over()::bigint,
         a.id,
         a.type::text,
         a.content,
         a.due_at,
         a.done,
         c.name,
         d.title,
         pr.full_name
  from public.activities a
  left join public.contacts c on c.id = a.contact_id
  left join public.deals d on d.id = a.deal_id
  left join public.profiles pr on pr.id = a.created_by
  where a.account_id = v_account_id
    and (not p_pendentes or a.done = false)
    and (v_tipo is null or a.type::text = v_tipo)
    and (p_owner is null or pr.full_name ilike '%' || p_owner || '%')
  order by a.due_at asc nulls last
  limit v_limit;
end;
$$;

revoke all on function public.dexter_atividades_busca(text, uuid, text, text, boolean, int) from public, anon, authenticated;

-- ============================================================================
-- 7) dexter_dimensoes(p_email text, p_account_id uuid default null, p_dimensao text)
--    Distinct filter values for the resolved tenant, so a caller (or Dexter
--    itself) can discover valid inputs for dexter_deals_busca /
--    dexter_atividades_busca before calling them. p_dimensao (case-insensitive)
--    selects the dimension:
--      'pipelines'        -> distinct pipeline names (tenant-scoped)
--      'estagios'         -> distinct stage names (tenant-scoped, across all
--                            pipelines; use dexter_pipeline_summary to see
--                            stage<->pipeline pairing)
--      'owners'           -> distinct active profile full_names (tenant-scoped)
--      'tipos_atividade'  -> the full public.activity_type enum (global, not
--                            tenant data -- these are the only valid p_tipo
--                            values for dexter_atividades_busca)
--      'status_deals' / 'status' -> the full public.deal_status enum (global
--                            -- the only valid p_status values for
--                            dexter_deals_busca)
--    Any other p_dimensao raises 'dimensao_invalida' (errcode 22023).
--    Gate: public.dexter_resolve_account (sem_acesso / 42501 on failure).
-- ============================================================================
create or replace function public.dexter_dimensoes(
  p_email text,
  p_account_id uuid default null,
  p_dimensao text default null
)
returns table (valor text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account_id uuid;
  v_dimensao text;
begin
  select ra.account_id into v_account_id
  from public.dexter_resolve_account(p_email, p_account_id) ra;

  v_dimensao := lower(trim(coalesce(p_dimensao, '')));

  if v_dimensao = 'pipelines' then
    return query
    select distinct pl.name
    from public.pipelines pl
    where pl.account_id = v_account_id
    order by 1
    limit 200;

  elsif v_dimensao = 'estagios' then
    return query
    select distinct s.name
    from public.stages s
    where s.account_id = v_account_id
    order by 1
    limit 200;

  elsif v_dimensao = 'owners' then
    return query
    select distinct pr.full_name
    from public.profiles pr
    where pr.account_id = v_account_id
      and pr.is_active = true
    order by 1
    limit 200;

  elsif v_dimensao = 'tipos_atividade' then
    return query
    select unnest(enum_range(null::public.activity_type))::text
    order by 1;

  elsif v_dimensao in ('status_deals', 'status') then
    return query
    select unnest(enum_range(null::public.deal_status))::text
    order by 1;

  else
    raise exception 'dimensao_invalida: %', p_dimensao using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.dexter_dimensoes(text, uuid, text) from public, anon, authenticated;
