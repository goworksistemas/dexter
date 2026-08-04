-- =============================================================================
-- Analytics admin Dexter (somente service_role)
-- =============================================================================

create or replace function public.dexter_admin_overview(p_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days integer := greatest(1, least(coalesce(p_days, 30), 365));
  v_since timestamptz := now() - make_interval(days => v_days);
  v_result jsonb;
begin
  with msgs as (
    select m.*, c.user_id
    from public.agent_messages m
    join public.agent_chats c on c.id = m.chat_id
    where m.created_at >= v_since
  ),
  totals as (
    select
      (select count(*)::int from public.profiles) as users_total,
      (select count(*)::int from public.profiles where disabled_at is null) as users_active,
      (select count(*)::int from public.profiles where disabled_at is not null) as users_disabled,
      (select count(*)::int from public.agent_chats) as chats_total,
      (select count(*)::int from public.agent_chats where created_at >= v_since) as chats_period,
      (select count(*)::int from msgs) as messages_period,
      (select count(*)::int from msgs where role = 'user') as user_messages_period,
      (select count(*)::int from msgs where role = 'assistant') as assistant_messages_period,
      coalesce((select sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)) from msgs), 0)::bigint as tokens_period,
      coalesce((select sum(coalesce(tokens_in, 0)) from msgs), 0)::bigint as tokens_in_period,
      coalesce((select sum(coalesce(tokens_out, 0)) from msgs), 0)::bigint as tokens_out_period,
      coalesce((select sum(coalesce(cost_usd, 0)) from msgs), 0)::numeric as cost_usd_period
  ),
  by_model as (
    select
      coalesce(nullif(trim(model), ''), '(sem modelo)') as model,
      count(*)::int as messages,
      coalesce(sum(coalesce(tokens_in, 0)), 0)::bigint as tokens_in,
      coalesce(sum(coalesce(tokens_out, 0)), 0)::bigint as tokens_out,
      coalesce(sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)), 0)::bigint as tokens,
      coalesce(sum(coalesce(cost_usd, 0)), 0)::numeric as cost_usd
    from msgs
    where role = 'assistant' or model is not null
    group by 1
    order by tokens desc
    limit 20
  ),
  by_day as (
    select
      to_char(date_trunc('day', created_at) at time zone 'UTC', 'YYYY-MM-DD') as day,
      count(*)::int as messages,
      count(*) filter (where role = 'user')::int as user_messages,
      count(*) filter (where role = 'assistant')::int as assistant_messages,
      coalesce(sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)), 0)::bigint as tokens,
      count(distinct user_id)::int as active_users
    from msgs
    group by 1
    order by 1
  ),
  top_users as (
    select
      p.id as user_id,
      p.email,
      p.full_name,
      p.role,
      count(distinct m.chat_id)::int as chats,
      count(m.id)::int as messages,
      coalesce(sum(coalesce(m.tokens_in, 0) + coalesce(m.tokens_out, 0)), 0)::bigint as tokens
    from public.profiles p
    left join public.agent_chats c on c.user_id = p.id
    left join public.agent_messages m
      on m.chat_id = c.id and m.created_at >= v_since
    group by p.id, p.email, p.full_name, p.role
  )
  select jsonb_build_object(
    'period_days', v_days,
    'since', v_since,
    'totals', (select to_jsonb(t) from totals t),
    'by_model', coalesce((select jsonb_agg(to_jsonb(bm) order by bm.tokens desc) from by_model bm), '[]'::jsonb),
    'by_day', coalesce((select jsonb_agg(to_jsonb(bd) order by bd.day) from by_day bd), '[]'::jsonb),
    'top_users', coalesce((
      select jsonb_agg(to_jsonb(tu) order by tu.tokens desc, tu.messages desc, tu.email)
      from top_users tu
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_admin_overview(integer) from public;
grant execute on function public.dexter_admin_overview(integer) to service_role;

create or replace function public.dexter_admin_user_detail(
  p_user_id uuid,
  p_days integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days integer := greatest(1, least(coalesce(p_days, 30), 365));
  v_since timestamptz := now() - make_interval(days => v_days);
  v_profile public.profiles%rowtype;
  v_result jsonb;
begin
  select * into v_profile from public.profiles where id = p_user_id;
  if not found then
    return jsonb_build_object('erro', 'Usuário não encontrado');
  end if;

  with chats as (
    select c.*
    from public.agent_chats c
    where c.user_id = p_user_id
  ),
  msgs as (
    select m.*
    from public.agent_messages m
    join chats c on c.id = m.chat_id
  ),
  msgs_period as (
    select * from msgs where created_at >= v_since
  ),
  totals as (
    select
      (select count(*)::int from chats) as chats_total,
      (select count(*)::int from chats where created_at >= v_since) as chats_period,
      (select count(*)::int from msgs) as messages_total,
      (select count(*)::int from msgs_period) as messages_period,
      coalesce((select sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)) from msgs), 0)::bigint as tokens_total,
      coalesce((select sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)) from msgs_period), 0)::bigint as tokens_period,
      coalesce((select sum(coalesce(tokens_in, 0)) from msgs_period), 0)::bigint as tokens_in_period,
      coalesce((select sum(coalesce(tokens_out, 0)) from msgs_period), 0)::bigint as tokens_out_period,
      coalesce((select sum(coalesce(cost_usd, 0)) from msgs_period), 0)::numeric as cost_usd_period,
      (select max(created_at) from msgs) as last_message_at,
      (select count(*)::int from public.agent_tool_calls tc where tc.user_id = p_user_id and tc.created_at >= v_since) as tool_calls_period
  ),
  by_model as (
    select
      coalesce(nullif(trim(model), ''), '(sem modelo)') as model,
      count(*)::int as messages,
      coalesce(sum(coalesce(tokens_in, 0)), 0)::bigint as tokens_in,
      coalesce(sum(coalesce(tokens_out, 0)), 0)::bigint as tokens_out,
      coalesce(sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)), 0)::bigint as tokens,
      coalesce(sum(coalesce(cost_usd, 0)), 0)::numeric as cost_usd
    from msgs_period
    where role = 'assistant' or model is not null
    group by 1
    order by tokens desc
    limit 20
  ),
  by_day as (
    select
      to_char(date_trunc('day', created_at) at time zone 'UTC', 'YYYY-MM-DD') as day,
      count(*)::int as messages,
      count(*) filter (where role = 'user')::int as user_messages,
      count(*) filter (where role = 'assistant')::int as assistant_messages,
      coalesce(sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)), 0)::bigint as tokens
    from msgs_period
    group by 1
    order by 1
  ),
  chat_list as (
    select
      c.id,
      c.title,
      c.project_id,
      c.created_at,
      c.updated_at,
      (select count(*)::int from public.agent_messages m where m.chat_id = c.id) as message_count,
      coalesce((
        select sum(coalesce(m.tokens_in, 0) + coalesce(m.tokens_out, 0))
        from public.agent_messages m where m.chat_id = c.id
      ), 0)::bigint as tokens,
      (
        select m.model
        from public.agent_messages m
        where m.chat_id = c.id and m.model is not null
        order by m.created_at desc
        limit 1
      ) as last_model
    from chats c
    order by c.updated_at desc nulls last
    limit 100
  )
  select jsonb_build_object(
    'period_days', v_days,
    'since', v_since,
    'profile', jsonb_build_object(
      'id', v_profile.id,
      'email', v_profile.email,
      'full_name', v_profile.full_name,
      'avatar_url', v_profile.avatar_url,
      'role', v_profile.role,
      'disabled_at', v_profile.disabled_at,
      'created_at', v_profile.created_at,
      'updated_at', v_profile.updated_at
    ),
    'totals', (select to_jsonb(t) from totals t),
    'by_model', coalesce((select jsonb_agg(to_jsonb(bm)) from by_model bm), '[]'::jsonb),
    'by_day', coalesce((select jsonb_agg(to_jsonb(bd)) from by_day bd), '[]'::jsonb),
    'chats', coalesce((select jsonb_agg(to_jsonb(cl)) from chat_list cl), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_admin_user_detail(uuid, integer) from public;
grant execute on function public.dexter_admin_user_detail(uuid, integer) to service_role;
