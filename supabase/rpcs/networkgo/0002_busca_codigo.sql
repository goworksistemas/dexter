create or replace function public.dexter_tickets_busca(
  p_email text,
  p_texto text default null,
  p_solicitante text default null,
  p_responsavel text default null,
  p_status text default null,
  p_building_id uuid default null,
  p_dias int default 30,
  p_limit int default 50,
  p_company_id uuid default null,
  p_empresa text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pode boolean;
  v_limit int;
  v_total bigint;
  v_itens jsonb;
begin
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

  v_limit := greatest(1, least(coalesce(p_limit, 50), 50));

  select count(*)
    into v_total
  from public.tickets t
  left join public.profiles ps on ps.id = t.user_id
  left join public.profiles pa on pa.id = t.assigned_to
  left join public.profiles pg on pg.id = t.agent_id
  left join public.statuses s on s.id = t.status_id
  where (coalesce(p_dias, 0) <= 0 or t.created_at >= now() - make_interval(days => p_dias))
    and (p_building_id is null or t.building_id = p_building_id)
    and (p_status is null or s.name ilike '%' || p_status || '%')
    and (p_solicitante is null or ps.full_name ilike '%' || p_solicitante || '%')
    and (p_responsavel is null or pa.full_name ilike '%' || p_responsavel || '%'
                               or pg.full_name ilike '%' || p_responsavel || '%')
    and (p_texto is null or t.ticket_number ilike '%' || p_texto || '%'
                         or t.title ilike '%' || p_texto || '%'
                         or t.description ilike '%' || p_texto || '%')
    and (p_company_id is null or t.company_id = p_company_id)
    and (p_empresa is null or exists (
      select 1 from public.companies c
      where c.id = t.company_id
        and (
          coalesce(c.name, '') ilike '%' || p_empresa || '%'
          or coalesce(c.nome_fantasia, '') ilike '%' || p_empresa || '%'
          or coalesce(c.razao_social, '') ilike '%' || p_empresa || '%'
          or coalesce(c.nome_omie, '') ilike '%' || p_empresa || '%'
          or coalesce(c.profile_name, '') ilike '%' || p_empresa || '%'
        )
    ));

  select coalesce(jsonb_agg(z.row_data), '[]'::jsonb)
    into v_itens
  from (
    select jsonb_build_object(
      'id', t.id,
      'ticket_number', t.ticket_number,
      'title', t.title,
      'status', s.name,
      'building', b.name,
      'empresa', coalesce(cmp.nome_fantasia, cmp.razao_social, cmp.name),
      'solicitante', ps.full_name,
      'responsavel', pa.full_name,
      'agente', pg.full_name,
      'is_urgent', t.is_urgent,
      'deadline', t.deadline,
      'resolved_at', t.resolved_at,
      'evaluation_score', t.evaluation_score,
      'created_at', t.created_at
    ) as row_data
    from public.tickets t
    left join public.companies cmp on cmp.id = t.company_id
    left join public.profiles ps on ps.id = t.user_id
    left join public.profiles pa on pa.id = t.assigned_to
    left join public.profiles pg on pg.id = t.agent_id
    left join public.statuses s on s.id = t.status_id
    left join public.buildings b on b.id = t.building_id
    where (coalesce(p_dias, 0) <= 0 or t.created_at >= now() - make_interval(days => p_dias))
      and (p_building_id is null or t.building_id = p_building_id)
      and (p_status is null or s.name ilike '%' || p_status || '%')
      and (p_solicitante is null or ps.full_name ilike '%' || p_solicitante || '%')
      and (p_responsavel is null or pa.full_name ilike '%' || p_responsavel || '%'
                                 or pg.full_name ilike '%' || p_responsavel || '%')
      and (p_texto is null or t.ticket_number ilike '%' || p_texto || '%'
                           or t.title ilike '%' || p_texto || '%'
                           or t.description ilike '%' || p_texto || '%')
      and (p_company_id is null or t.company_id = p_company_id)
      and (p_empresa is null or exists (
        select 1 from public.companies c
        where c.id = t.company_id
          and (
            coalesce(c.name, '') ilike '%' || p_empresa || '%'
            or coalesce(c.nome_fantasia, '') ilike '%' || p_empresa || '%'
            or coalesce(c.razao_social, '') ilike '%' || p_empresa || '%'
            or coalesce(c.nome_omie, '') ilike '%' || p_empresa || '%'
            or coalesce(c.profile_name, '') ilike '%' || p_empresa || '%'
          )
      ))
    order by t.created_at desc
    limit v_limit
  ) z;

  return jsonb_build_object(
    'filtros', jsonb_build_object(
      'texto', p_texto,
      'solicitante', p_solicitante,
      'responsavel', p_responsavel,
      'status', p_status,
      'building_id', p_building_id,
      'periodo_dias', p_dias,
      'company_id', p_company_id,
      'empresa', p_empresa,
      'limit', v_limit
    ),
    'total_encontrado', v_total,
    'itens', v_itens
  );
end;
$$;

revoke all on function public.dexter_tickets_busca(text, text, text, text, text, uuid, int, int, uuid, text)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 9) dexter_os_busca(p_email, p_texto, p_solicitante, p_responsavel, p_status,
--                      p_building_id, p_dias=30, p_limit=50)
--    Gate: service_orders <> 'none' (ou admin de plataforma) — mesmo gate de
--    dexter_os_resumo.
--    Mesmo padrao de dexter_tickets_busca, aplicado a os_service_orders.
--    p_solicitante casa contra requester_id; p_responsavel casa contra
--    executor_id OU assigned_to (cobre "quem executa" e "designado para").
-- -----------------------------------------------------------------------------

create or replace function public.dexter_os_busca(
  p_email text,
  p_texto text default null,
  p_solicitante text default null,
  p_responsavel text default null,
  p_status text default null,
  p_building_id uuid default null,
  p_dias int default 30,
  p_limit int default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pode boolean;
  v_limit int;
  v_total bigint;
  v_itens jsonb;
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

  v_limit := greatest(1, least(coalesce(p_limit, 50), 50));

  select count(*)
    into v_total
  from public.os_service_orders o
  left join public.profiles pr2 on pr2.id = o.requester_id
  left join public.profiles pe on pe.id = o.executor_id
  left join public.profiles pat on pat.id = o.assigned_to
  left join public.statuses s on s.id = o.status_id
  where o.created_at >= now() - make_interval(days => p_dias)
    and (p_building_id is null or o.building_id = p_building_id)
    and (p_status is null or s.name ilike '%' || p_status || '%')
    and (p_solicitante is null or pr2.full_name ilike '%' || p_solicitante || '%')
    and (p_responsavel is null or pe.full_name ilike '%' || p_responsavel || '%'
                               or pat.full_name ilike '%' || p_responsavel || '%')
    and (p_texto is null or o.service_order_number::text ilike '%' || p_texto || '%'
                         or o.title ilike '%' || p_texto || '%'
                         or o.description ilike '%' || p_texto || '%');

  select coalesce(jsonb_agg(z.row_data), '[]'::jsonb)
    into v_itens
  from (
    select jsonb_build_object(
      'id', o.id,
      'numero', o.service_order_number,
      'title', o.title,
      'status', s.name,
      'building', b.name,
      'solicitante', pr2.full_name,
      'executor', pe.full_name,
      'designado', pat.full_name,
      'due_date', o.due_date,
      'actual_cost', o.actual_cost,
      'closed_at', o.closed_at,
      'evaluation_score', o.evaluation_score,
      'created_at', o.created_at
    ) as row_data
    from public.os_service_orders o
    left join public.profiles pr2 on pr2.id = o.requester_id
    left join public.profiles pe on pe.id = o.executor_id
    left join public.profiles pat on pat.id = o.assigned_to
    left join public.statuses s on s.id = o.status_id
    left join public.buildings b on b.id = o.building_id
    where o.created_at >= now() - make_interval(days => p_dias)
      and (p_building_id is null or o.building_id = p_building_id)
      and (p_status is null or s.name ilike '%' || p_status || '%')
      and (p_solicitante is null or pr2.full_name ilike '%' || p_solicitante || '%')
      and (p_responsavel is null or pe.full_name ilike '%' || p_responsavel || '%'
                                 or pat.full_name ilike '%' || p_responsavel || '%')
      and (p_texto is null or o.service_order_number::text ilike '%' || p_texto || '%'
                           or o.title ilike '%' || p_texto || '%'
                           or o.description ilike '%' || p_texto || '%')
    order by o.created_at desc
    limit v_limit
  ) z;

  return jsonb_build_object(
    'filtros', jsonb_build_object(
      'texto', p_texto,
      'solicitante', p_solicitante,
      'responsavel', p_responsavel,
      'status', p_status,
      'building_id', p_building_id,
      'periodo_dias', p_dias,
      'limit', v_limit
    ),
    'total_encontrado', v_total,
    'itens', v_itens
  );
end;
$$;

revoke all on function public.dexter_os_busca(text, text, text, text, text, uuid, int, int)
  from public, anon, authenticated;

