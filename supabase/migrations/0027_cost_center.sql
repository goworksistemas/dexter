-- Central de custo: preços por modelo, crédito de providers, orçamento por usuário.

create table if not exists public.dexter_model_pricing (
  id text primary key,
  input_usd_per_million numeric(14, 8),
  output_usd_per_million numeric(14, 8),
  updated_at timestamptz not null default now()
);

comment on table public.dexter_model_pricing is
  'Preço USD por 1M tokens (entrada/saída) por id de catálogo provider:modelo — admin ou sync.';

alter table public.dexter_providers
  add column if not exists credit_status text not null default 'unknown'
    check (credit_status in ('available', 'low', 'depleted', 'unknown')),
  add column if not exists balance_usd numeric(14, 4),
  add column if not exists low_threshold_usd numeric(14, 4) default 5,
  add column if not exists balance_updated_at timestamptz;

comment on column public.dexter_providers.credit_status is
  'Crédito do provider (chave corporativa): available/low/depleted/unknown.';
comment on column public.dexter_providers.balance_usd is
  'Saldo manual ou sincronizado (USD). Null = desconhecido — não bloqueia.';

create table if not exists public.dexter_user_provider_credit (
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null,
  credit_status text not null default 'available'
    check (credit_status in ('available', 'low', 'depleted', 'unknown')),
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

comment on table public.dexter_user_provider_credit is
  'Status de crédito BYOK por usuário+provider (atualizado em erros de quota da API).';

alter table public.profiles
  add column if not exists usage_budget_usd numeric(14, 2);

comment on column public.profiles.usage_budget_usd is
  'Teto de gasto USD no mês corrente (null = sem limite).';

alter table public.dexter_model_pricing enable row level security;
alter table public.dexter_user_provider_credit enable row level security;
revoke all on table public.dexter_model_pricing from anon, authenticated;
revoke all on table public.dexter_user_provider_credit from anon, authenticated;
grant select, insert, update, delete on table public.dexter_model_pricing to service_role;
grant select, insert, update, delete on table public.dexter_user_provider_credit to service_role;

create index if not exists agent_messages_cost_idx
  on public.agent_messages (created_at desc)
  where cost_usd is not null and cost_usd > 0;

-- Overview: top_users com custo
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
      coalesce(sum(coalesce(cost_usd, 0)), 0)::numeric as cost_usd,
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
      coalesce(sum(coalesce(m.tokens_in, 0) + coalesce(m.tokens_out, 0)), 0)::bigint as tokens,
      coalesce(sum(coalesce(m.cost_usd, 0)), 0)::numeric as cost_usd
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
      select jsonb_agg(to_jsonb(tu) order by tu.cost_usd desc, tu.tokens desc, tu.email)
      from top_users tu
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- Detalhe usuário: conversas com custo
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
    select c.* from public.agent_chats c where c.user_id = p_user_id
  ),
  msgs as (
    select m.* from public.agent_messages m join chats c on c.id = m.chat_id
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
      coalesce(sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)), 0)::bigint as tokens,
      coalesce(sum(coalesce(cost_usd, 0)), 0)::numeric as cost_usd
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
      coalesce((
        select sum(coalesce(m.cost_usd, 0))
        from public.agent_messages m where m.chat_id = c.id and m.created_at >= v_since
      ), 0)::numeric as cost_usd_period,
      (
        select m.model from public.agent_messages m
        where m.chat_id = c.id and m.model is not null
        order by m.created_at desc limit 1
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
      'usage_budget_usd', v_profile.usage_budget_usd,
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

-- Central de custo (painel admin)
create or replace function public.dexter_admin_cost_center(p_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days integer := greatest(1, least(coalesce(p_days, 30), 365));
  v_since timestamptz := now() - make_interval(days => v_days);
  v_month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  v_result jsonb;
begin
  with msgs as (
    select m.*, c.user_id, c.title as chat_title
    from public.agent_messages m
    join public.agent_chats c on c.id = m.chat_id
    where m.created_at >= v_since
  ),
  totals as (
    select
      count(distinct user_id)::int as active_users,
      count(distinct chat_id)::int as chats,
      count(*)::int as messages,
      coalesce(sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)), 0)::bigint as tokens,
      coalesce(sum(coalesce(cost_usd, 0)), 0)::numeric as cost_usd
    from msgs
  ),
  by_user as (
    select
      p.id as user_id,
      p.email,
      p.full_name,
      p.role,
      p.usage_budget_usd,
      coalesce((
        select sum(coalesce(m2.cost_usd, 0))
        from public.agent_messages m2
        join public.agent_chats c2 on c2.id = m2.chat_id
        where c2.user_id = p.id and m2.created_at >= v_month_start
      ), 0)::numeric as cost_usd_month,
      count(distinct m.chat_id)::int as chats,
      count(m.id)::int as messages,
      coalesce(sum(coalesce(m.tokens_in, 0) + coalesce(m.tokens_out, 0)), 0)::bigint as tokens,
      coalesce(sum(coalesce(m.cost_usd, 0)), 0)::numeric as cost_usd
    from public.profiles p
    left join msgs m on m.user_id = p.id
    group by p.id, p.email, p.full_name, p.role, p.usage_budget_usd
    having count(m.id) > 0 or p.usage_budget_usd is not null
    order by cost_usd desc nulls last
    limit 100
  ),
  by_chat as (
    select
      m.chat_id,
      max(m.chat_title) as title,
      m.user_id,
      max(p.email) as email,
      max(p.full_name) as full_name,
      count(*)::int as messages,
      coalesce(sum(coalesce(m.tokens_in, 0) + coalesce(m.tokens_out, 0)), 0)::bigint as tokens,
      coalesce(sum(coalesce(m.cost_usd, 0)), 0)::numeric as cost_usd,
      max(m.created_at) as last_at
    from msgs m
    join public.profiles p on p.id = m.user_id
    group by m.chat_id, m.user_id
    order by cost_usd desc, tokens desc
    limit 200
  ),
  by_model as (
    select
      coalesce(nullif(trim(model), ''), '(sem modelo)') as model,
      count(*)::int as messages,
      coalesce(sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)), 0)::bigint as tokens,
      coalesce(sum(coalesce(cost_usd, 0)), 0)::numeric as cost_usd
    from msgs
    where role = 'assistant' or model is not null
    group by 1
    order by cost_usd desc, tokens desc
    limit 50
  ),
  by_provider as (
    select
      split_part(coalesce(nullif(trim(model), ''), 'unknown'), ':', 1) as provider,
      count(*)::int as messages,
      coalesce(sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)), 0)::bigint as tokens,
      coalesce(sum(coalesce(cost_usd, 0)), 0)::numeric as cost_usd
    from msgs
    where model like '%:%' or model is not null
    group by 1
    order by cost_usd desc
  ),
  by_day as (
    select
      to_char(date_trunc('day', created_at) at time zone 'UTC', 'YYYY-MM-DD') as day,
      count(*)::int as messages,
      coalesce(sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)), 0)::bigint as tokens,
      coalesce(sum(coalesce(cost_usd, 0)), 0)::numeric as cost_usd
    from msgs
    group by 1
    order by 1
  ),
  pricing as (
    select id, input_usd_per_million, output_usd_per_million, updated_at
    from public.dexter_model_pricing
  ),
  providers as (
    select
      id, label, default_cost_tier, credit_status,
      balance_usd, low_threshold_usd, balance_updated_at
    from public.dexter_providers
    order by id
  )
  select jsonb_build_object(
    'period_days', v_days,
    'since', v_since,
    'month_start', v_month_start,
    'totals', (select to_jsonb(t) from totals t),
    'by_user', coalesce((select jsonb_agg(to_jsonb(u)) from by_user u), '[]'::jsonb),
    'by_chat', coalesce((select jsonb_agg(to_jsonb(c)) from by_chat c), '[]'::jsonb),
    'by_model', coalesce((select jsonb_agg(to_jsonb(m)) from by_model m), '[]'::jsonb),
    'by_provider', coalesce((select jsonb_agg(to_jsonb(p)) from by_provider p), '[]'::jsonb),
    'by_day', coalesce((select jsonb_agg(to_jsonb(d)) from by_day d), '[]'::jsonb),
    'pricing', coalesce((select jsonb_agg(to_jsonb(pr)) from pricing pr), '[]'::jsonb),
    'providers', coalesce((select jsonb_agg(to_jsonb(pv)) from providers pv), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_admin_cost_center(integer) from public;
grant execute on function public.dexter_admin_cost_center(integer) to service_role;
