-- =============================================================================
-- AgentCore × NetworkGo — camada de acesso do Dexter (APLICADO em producao)
--
-- Aplicado no projeto Supabase qgtbxeobqlyptevsckjp via mcp apply_migration
-- (migration name: dexter_networkgo_data). Testado com bpm@gowork.com.br (admin).
--
-- Princípios (baseline de seguranca do projeto):
--  - O Dexter NUNCA roda SQL livre. So chama estas RPCs read-only.
--  - Autorizacao REUSA a permissao que ja existe no NetworkGo (platform_users +
--    gowork_member_permissions) — o Dexter enxerga o mesmo que o usuario veria no app.
--  - SECURITY DEFINER + search_path vazio + EXECUTE revogado de anon/authenticated
--    (so o backend, via service_role, chama). Tudo auditado em agent_tool_calls.
--  - A chave de identidade e o EMAIL VERIFICADO vindo do JWT do Dexter.
--  - GATE com bypass de admin: platform_role='admin' nao tem linha em
--    gowork_member_permissions (permissions vem {} para admin), entao o gate
--    sempre checa "e admin OU tem o flag granular <> 'none'".
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) dexter_whoami(email) — quem e esse usuario AQUI e o que ele pode ver.
--    Retorna has_access=false se nao for staff ativo do NetworkGo.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_whoami(p_email text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select
    case
      when pu.id is null or coalesce(pu.is_active, false) = false
        then jsonb_build_object('has_access', false)
      else jsonb_build_object(
        'has_access',    true,
        'user_id',       pr.id,
        'email',         pr.email,
        'full_name',     pr.full_name,
        'platform_role', pu.platform_role,
        'access_profile', pu.access_profile_slug,
        -- flags granulares (tickets_admin, service_orders, buildings, companies, ...)
        'permissions',   coalesce(to_jsonb(gmp)
                            - 'id' - 'platform_user_id' - 'created_at' - 'updated_at',
                          '{}'::jsonb)
      )
    end
  from public.profiles pr
  left join public.platform_users pu on pu.user_id = pr.id
  left join public.gowork_member_permissions gmp on gmp.platform_user_id = pu.id
  where lower(pr.email) = lower(p_email)
  limit 1;
$$;

revoke all on function public.dexter_whoami(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2) dexter_tickets_resumo(p_email, p_dias=30, p_building_id=null)
--    Gate: tickets_admin <> 'none' (ou admin de plataforma)
--    Resumo de chamados: total, urgentes em aberto, atrasados (deadline vencido
--    e nao resolvido), avaliacao media, quebra por status/categoria e ate 50
--    chamados recentes.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_tickets_resumo(
  p_email text,
  p_dias int default 30,
  p_building_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pode boolean;
  v_result jsonb;
begin
  -- Gate: reaproveita a permissao real do NetworkGo.
  -- IMPORTANTE: admin de plataforma tem acesso total (nao tem linha de flags
  -- granulares) — dai o bypass por platform_role, senao o admin seria barrado.
  select (pu.platform_role = 'admin')
      or (coalesce(gmp.tickets_admin, 'none') <> 'none')
    into v_pode
  from public.profiles pr
  join public.platform_users pu
    on pu.user_id = pr.id and coalesce(pu.is_active, false) = true
  left join public.gowork_member_permissions gmp
    on gmp.platform_user_id = pu.id
  where lower(pr.email) = lower(p_email)
  limit 1;

  if not coalesce(v_pode, false) then
    raise exception 'sem_acesso: % nao tem acesso a tickets no NetworkGo', p_email
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'periodo_dias', p_dias,
    'building_id', p_building_id,
    'total', count(*) filter (where true),
    'urgentes_abertos', count(*) filter (
      where t.is_urgent = true and t.resolved_at is null
    ),
    'atrasados', count(*) filter (
      where t.deadline is not null and t.deadline < now() and t.resolved_at is null
    ),
    'avaliacao_media', round(avg(t.evaluation_score)::numeric, 2),
    'por_status', coalesce((
      select jsonb_object_agg(x.status_name, x.n)
      from (
        select coalesce(s.name, 'sem_status') as status_name, count(*) n
        from public.tickets t2
        left join public.statuses s on s.id = t2.status_id
        where t2.created_at >= now() - make_interval(days => p_dias)
          and (p_building_id is null or t2.building_id = p_building_id)
        group by coalesce(s.name, 'sem_status')
      ) x
    ), '{}'::jsonb),
    'por_categoria', coalesce((
      select jsonb_object_agg(x.category_name, x.n)
      from (
        select coalesce(c.name, 'sem_categoria') as category_name, count(*) n
        from public.tickets t2
        left join public.categories c on c.id = t2.category_id
        where t2.created_at >= now() - make_interval(days => p_dias)
          and (p_building_id is null or t2.building_id = p_building_id)
        group by coalesce(c.name, 'sem_categoria')
      ) x
    ), '{}'::jsonb),
    'recentes', coalesce((
      select jsonb_agg(y.row_data)
      from (
        select jsonb_build_object(
          'id', t3.id,
          'ticket_number', t3.ticket_number,
          'title', t3.title,
          'status', s3.name,
          'building', b3.name,
          'is_urgent', t3.is_urgent,
          'deadline', t3.deadline,
          'created_at', t3.created_at
        ) as row_data
        from public.tickets t3
        left join public.statuses s3 on s3.id = t3.status_id
        left join public.buildings b3 on b3.id = t3.building_id
        where t3.created_at >= now() - make_interval(days => p_dias)
          and (p_building_id is null or t3.building_id = p_building_id)
        order by t3.created_at desc
        limit 50
      ) y
    ), '[]'::jsonb)
  )
  into v_result
  from public.tickets t
  where t.created_at >= now() - make_interval(days => p_dias)
    and (p_building_id is null or t.building_id = p_building_id);

  return v_result;
end;
$$;

revoke all on function public.dexter_tickets_resumo(text, int, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3) dexter_os_resumo(p_email, p_dias=30, p_building_id=null)
--    Gate: service_orders <> 'none' (ou admin de plataforma)
--    Resumo de ordens de servico (os_service_orders): total, atrasadas
--    (due_date vencido e nao fechada), custo total/medio, avaliacao media,
--    quebra por status/tipo e ate 50 OS recentes.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_os_resumo(
  p_email text,
  p_dias int default 30,
  p_building_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pode boolean;
  v_result jsonb;
begin
  select (pu.platform_role = 'admin')
      or (coalesce(gmp.service_orders, 'none') <> 'none')
    into v_pode
  from public.profiles pr
  join public.platform_users pu
    on pu.user_id = pr.id and coalesce(pu.is_active, false) = true
  left join public.gowork_member_permissions gmp
    on gmp.platform_user_id = pu.id
  where lower(pr.email) = lower(p_email)
  limit 1;

  if not coalesce(v_pode, false) then
    raise exception 'sem_acesso: % nao tem acesso a ordens de servico no NetworkGo', p_email
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'periodo_dias', p_dias,
    'building_id', p_building_id,
    'total', count(*),
    'atrasadas', count(*) filter (
      where os.due_date is not null and os.due_date < now() and os.closed_at is null
    ),
    'custo_total', coalesce(sum(os.actual_cost), 0),
    'custo_medio', round(coalesce(avg(os.actual_cost), 0)::numeric, 2),
    'avaliacao_media', round(avg(os.evaluation_score)::numeric, 2),
    'por_status', coalesce((
      select jsonb_object_agg(x.status_name, x.n)
      from (
        select coalesce(s.name, 'sem_status') as status_name, count(*) n
        from public.os_service_orders os2
        left join public.statuses s on s.id = os2.status_id
        where os2.created_at >= now() - make_interval(days => p_dias)
          and (p_building_id is null or os2.building_id = p_building_id)
        group by coalesce(s.name, 'sem_status')
      ) x
    ), '{}'::jsonb),
    'por_tipo', coalesce((
      select jsonb_object_agg(x.type_name, x.n)
      from (
        select coalesce(tp.name, 'sem_tipo') as type_name, count(*) n
        from public.os_service_orders os2
        left join public.os_types tp on tp.id = os2.type_id
        where os2.created_at >= now() - make_interval(days => p_dias)
          and (p_building_id is null or os2.building_id = p_building_id)
        group by coalesce(tp.name, 'sem_tipo')
      ) x
    ), '{}'::jsonb),
    'recentes', coalesce((
      select jsonb_agg(y.row_data)
      from (
        select jsonb_build_object(
          'id', os3.id,
          'numero', os3.service_order_number,
          'title', os3.title,
          'status', s3.name,
          'building', b3.name,
          'executor', pe.full_name,
          'due_date', os3.due_date,
          'actual_cost', os3.actual_cost,
          'created_at', os3.created_at
        ) as row_data
        from public.os_service_orders os3
        left join public.statuses s3 on s3.id = os3.status_id
        left join public.buildings b3 on b3.id = os3.building_id
        left join public.profiles pe on pe.id = os3.executor_id
        where os3.created_at >= now() - make_interval(days => p_dias)
          and (p_building_id is null or os3.building_id = p_building_id)
        order by os3.created_at desc
        limit 50
      ) y
    ), '[]'::jsonb)
  )
  into v_result
  from public.os_service_orders os
  where os.created_at >= now() - make_interval(days => p_dias)
    and (p_building_id is null or os.building_id = p_building_id);

  return v_result;
end;
$$;

revoke all on function public.dexter_os_resumo(text, int, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4) dexter_correspondencia_resumo(p_email, p_dias=30, p_building_id=null)
--    Gate: correspondence_admin <> 'none' (ou admin de plataforma)
--    Resumo de correspondencia: total, pendentes, tempo medio de entrega
--    (received_date -> delivered_date), quebra por status/tipo e ate 50
--    correspondencias recentes.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_correspondencia_resumo(
  p_email text,
  p_dias int default 30,
  p_building_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pode boolean;
  v_result jsonb;
begin
  select (pu.platform_role = 'admin')
      or (coalesce(gmp.correspondence_admin, 'none') <> 'none')
    into v_pode
  from public.profiles pr
  join public.platform_users pu
    on pu.user_id = pr.id and coalesce(pu.is_active, false) = true
  left join public.gowork_member_permissions gmp
    on gmp.platform_user_id = pu.id
  where lower(pr.email) = lower(p_email)
  limit 1;

  if not coalesce(v_pode, false) then
    raise exception 'sem_acesso: % nao tem acesso a correspondencia no NetworkGo', p_email
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'periodo_dias', p_dias,
    'building_id', p_building_id,
    'total', count(*),
    'pendentes', count(*) filter (where co.status = 'pending'),
    'tempo_medio_entrega_horas', round((
      avg(extract(epoch from (co.delivered_date - co.received_date))) / 3600.0
    )::numeric, 2),
    'por_status', coalesce((
      select jsonb_object_agg(x.status_name, x.n)
      from (
        select coalesce(co2.status, 'sem_status') as status_name, count(*) n
        from public.correspondence co2
        where co2.created_at >= now() - make_interval(days => p_dias)
          and (p_building_id is null or co2.building_id = p_building_id)
        group by coalesce(co2.status, 'sem_status')
      ) x
    ), '{}'::jsonb),
    'por_tipo', coalesce((
      select jsonb_object_agg(x.type_name, x.n)
      from (
        select coalesce(co2.type, 'sem_tipo') as type_name, count(*) n
        from public.correspondence co2
        where co2.created_at >= now() - make_interval(days => p_dias)
          and (p_building_id is null or co2.building_id = p_building_id)
        group by coalesce(co2.type, 'sem_tipo')
      ) x
    ), '{}'::jsonb),
    'recentes', coalesce((
      select jsonb_agg(y.row_data)
      from (
        select jsonb_build_object(
          'id', co3.id,
          'subject', co3.subject,
          'sender', co3.sender,
          'recipient', co3.recipient,
          'status', co3.status,
          'building', b3.name,
          'received_date', co3.received_date,
          'delivered_date', co3.delivered_date
        ) as row_data
        from public.correspondence co3
        left join public.buildings b3 on b3.id = co3.building_id
        where co3.created_at >= now() - make_interval(days => p_dias)
          and (p_building_id is null or co3.building_id = p_building_id)
        order by co3.created_at desc
        limit 50
      ) y
    ), '[]'::jsonb)
  )
  into v_result
  from public.correspondence co
  where co.created_at >= now() - make_interval(days => p_dias)
    and (p_building_id is null or co.building_id = p_building_id);

  return v_result;
end;
$$;

revoke all on function public.dexter_correspondencia_resumo(text, int, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5) dexter_reservas_resumo(p_email, p_dias=30, p_building_id=null)
--    Gate: reservations_admin <> 'none' (ou admin de plataforma)
--    Filtro de periodo usa start_date da reserva. Resumo de reservas de sala:
--    total, confirmadas, canceladas (cancelled/client_cancelled/system_cancelled),
--    no-show, receita paga, quebra por status/sala e ate 50 reservas recentes.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_reservas_resumo(
  p_email text,
  p_dias int default 30,
  p_building_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pode boolean;
  v_result jsonb;
begin
  select (pu.platform_role = 'admin')
      or (coalesce(gmp.reservations_admin, 'none') <> 'none')
    into v_pode
  from public.profiles pr
  join public.platform_users pu
    on pu.user_id = pr.id and coalesce(pu.is_active, false) = true
  left join public.gowork_member_permissions gmp
    on gmp.platform_user_id = pu.id
  where lower(pr.email) = lower(p_email)
  limit 1;

  if not coalesce(v_pode, false) then
    raise exception 'sem_acesso: % nao tem acesso a reservas no NetworkGo', p_email
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'periodo_dias', p_dias,
    'building_id', p_building_id,
    'total', count(*),
    'confirmadas', count(*) filter (where rr.status = 'confirmed'),
    'canceladas', count(*) filter (
      where rr.status in ('cancelled', 'client_cancelled', 'system_cancelled')
    ),
    'no_show', count(*) filter (where rr.status = 'no_show'),
    'receita_paga', coalesce(sum(rr.amount) filter (where rr.payment_status = 'paid'), 0),
    'por_status', coalesce((
      select jsonb_object_agg(x.status_name, x.n)
      from (
        select coalesce(rr2.status, 'sem_status') as status_name, count(*) n
        from public.room_reservations rr2
        join public.rooms rm2 on rm2.id = rr2.room_id
        where rr2.start_date >= now() - make_interval(days => p_dias)
          and (p_building_id is null or rm2.building_id = p_building_id)
        group by coalesce(rr2.status, 'sem_status')
      ) x
    ), '{}'::jsonb),
    'por_sala', coalesce((
      select jsonb_object_agg(x.room_name, x.n)
      from (
        select coalesce(rm2.name, 'sem_sala') as room_name, count(*) n
        from public.room_reservations rr2
        join public.rooms rm2 on rm2.id = rr2.room_id
        where rr2.start_date >= now() - make_interval(days => p_dias)
          and (p_building_id is null or rm2.building_id = p_building_id)
        group by coalesce(rm2.name, 'sem_sala')
      ) x
    ), '{}'::jsonb),
    'recentes', coalesce((
      select jsonb_agg(y.row_data)
      from (
        select jsonb_build_object(
          'id', rr3.id,
          'sala', rm3.name,
          'building', b3.name,
          'title', rr3.title,
          'status', rr3.status,
          'payment_status', rr3.payment_status,
          'amount', rr3.amount,
          'start_date', rr3.start_date,
          'end_date', rr3.end_date
        ) as row_data
        from public.room_reservations rr3
        join public.rooms rm3 on rm3.id = rr3.room_id
        left join public.buildings b3 on b3.id = rm3.building_id
        where rr3.start_date >= now() - make_interval(days => p_dias)
          and (p_building_id is null or rm3.building_id = p_building_id)
        order by rr3.start_date desc
        limit 50
      ) y
    ), '[]'::jsonb)
  )
  into v_result
  from public.room_reservations rr
  join public.rooms rm on rm.id = rr.room_id
  where rr.start_date >= now() - make_interval(days => p_dias)
    and (p_building_id is null or rm.building_id = p_building_id);

  return v_result;
end;
$$;

revoke all on function public.dexter_reservas_resumo(text, int, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6) dexter_satisfacao_resumo(p_email, p_dias=30, p_building_id=null)
--    Gate: satisfaction_responses <> 'none' (ou admin de plataforma)
--    Usa a view existente v_satisfaction_response_cards (ja resolve NPS/zona
--    a partir do jsonb livre de "responses"). Resumo: total de respostas,
--    NPS medio, contagem promoters/passives/detractors, quebra por
--    follow_up_status/categoria e ate 50 respostas recentes.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_satisfacao_resumo(
  p_email text,
  p_dias int default 30,
  p_building_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pode boolean;
  v_result jsonb;
begin
  select (pu.platform_role = 'admin')
      or (coalesce(gmp.satisfaction_responses, 'none') <> 'none')
    into v_pode
  from public.profiles pr
  join public.platform_users pu
    on pu.user_id = pr.id and coalesce(pu.is_active, false) = true
  left join public.gowork_member_permissions gmp
    on gmp.platform_user_id = pu.id
  where lower(pr.email) = lower(p_email)
  limit 1;

  if not coalesce(v_pode, false) then
    raise exception 'sem_acesso: % nao tem acesso a satisfacao no NetworkGo', p_email
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'periodo_dias', p_dias,
    'building_id', p_building_id,
    'total_respostas', count(*),
    'nps_medio', round(avg(v.nps_value)::numeric, 2),
    'promoters', count(*) filter (where v.nps_zone = 'promoter'),
    'passives', count(*) filter (where v.nps_zone = 'passive'),
    'detractors', count(*) filter (where v.nps_zone = 'detractor'),
    'com_ordem_servico', count(*) filter (where v.has_service_order = true),
    'por_follow_up_status', coalesce((
      select jsonb_object_agg(x.st, x.n)
      from (
        select coalesce(v2.follow_up_status, 'sem_status') as st, count(*) n
        from public.v_satisfaction_response_cards v2
        where coalesce(v2.responded_at, v2.created_at) >= now() - make_interval(days => p_dias)
          and (p_building_id is null or v2.building_id = p_building_id)
        group by coalesce(v2.follow_up_status, 'sem_status')
      ) x
    ), '{}'::jsonb),
    'por_categoria', coalesce((
      select jsonb_object_agg(x.cat, x.n)
      from (
        select coalesce(v2.category_name, 'sem_categoria') as cat, count(*) n
        from public.v_satisfaction_response_cards v2
        where coalesce(v2.responded_at, v2.created_at) >= now() - make_interval(days => p_dias)
          and (p_building_id is null or v2.building_id = p_building_id)
        group by coalesce(v2.category_name, 'sem_categoria')
      ) x
    ), '{}'::jsonb),
    'recentes', coalesce((
      select jsonb_agg(y.row_data)
      from (
        select jsonb_build_object(
          'id', v3.id,
          'survey', v3.survey_title,
          'respondent', v3.respondent_name,
          'building', v3.building_name,
          'company', v3.company_name,
          'nps_value', v3.nps_value,
          'nps_zone', v3.nps_zone,
          'comment', v3.comment_text,
          'follow_up_status', v3.follow_up_status,
          'responded_at', v3.responded_at
        ) as row_data
        from public.v_satisfaction_response_cards v3
        where coalesce(v3.responded_at, v3.created_at) >= now() - make_interval(days => p_dias)
          and (p_building_id is null or v3.building_id = p_building_id)
        order by coalesce(v3.responded_at, v3.created_at) desc
        limit 50
      ) y
    ), '[]'::jsonb)
  )
  into v_result
  from public.v_satisfaction_response_cards v
  where coalesce(v.responded_at, v.created_at) >= now() - make_interval(days => p_dias)
    and (p_building_id is null or v.building_id = p_building_id);

  return v_result;
end;
$$;

revoke all on function public.dexter_satisfacao_resumo(text, int, uuid) from public, anon, authenticated;

-- =============================================================================
-- Ainda pendentes (fora do escopo desta rodada): faturas/invoices_admin.
-- Mesmo padrao de gate se/quando forem construidas.
-- =============================================================================
