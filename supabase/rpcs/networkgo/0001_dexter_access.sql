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
--    ATUALIZADA em dexter_networkgo_pesquisas_fix (v2 em
--    dexter_networkgo_pesquisas_fix_v2) — ver bloco "CONSERTO DA CAMADA DE
--    PESQUISAS DE SATISFACAO" mais abaixo no arquivo para o motivo do fix e
--    a versao final (redefinicao completa desta funcao, sem "nps_medio"
--    agregado cross-pesquisa). Esta definicao antiga fica so de historico —
--    o `create or replace function` do bloco abaixo e o que esta em producao.
-- -----------------------------------------------------------------------------

-- =============================================================================
-- CAMADA MODULAR (busca/filtro) — APLICADO em producao
--
-- Aplicado no projeto Supabase qgtbxeobqlyptevsckjp via mcp apply_migration
-- (migration name: dexter_networkgo_modular). Testado com bpm@gowork.com.br
-- (admin) e com email inexistente (gate negativo -> 42501).
--
-- Motivo: as RPCs acima (*_resumo) sao agregados fixos. O dono quer perguntar
-- coisas especificas tipo "quantos chamados do Luis Cuba", filtrar por
-- pessoa/status/data. As RPCs abaixo dao essa capacidade de FILTRO/BUSCA
-- livre, sem nada fixo por pergunta.
--
-- Descobertas de schema (coletadas via information_schema + testes de join,
-- ja que assigned_to/user_id/executor_id etc. em tickets/os_service_orders
-- NAO tem FK declarada para profiles, mas casam 100% na pratica):
--
--   tickets.user_id     -> profiles: SOLICITANTE (quem abriu). 74910/76037
--                          linhas NAO sao staff (platform_users) -> confirma
--                          que e o membro/cliente que abriu o chamado.
--   tickets.assigned_to -> profiles: RESPONSAVEL designado (~metade staff,
--                          metade nao-staff).
--   tickets.agent_id    -> profiles: AGENTE que atendeu/conversou (31545/
--                          76096 sao staff).
--   -> dexter_tickets_busca.p_responsavel casa contra assigned_to OU
--      agent_id (rede mais ampla: cobre "designado para" e "quem atendeu").
--
--   os_service_orders.requester_id -> profiles: SOLICITANTE.
--   os_service_orders.executor_id  -> profiles: EXECUTOR (quem executa
--                                     fisicamente a OS).
--   os_service_orders.assigned_to  -> profiles: designado (pode ser time).
--   os_service_orders.supervisor_id -> profiles: supervisor (so 39541/125579
--                                      preenchido, por isso nao usado como
--                                      filtro principal).
--   -> dexter_os_busca.p_responsavel casa contra executor_id OU assigned_to.
--
--   statuses/categories tem flags for_tickets/for_service_orders (mesma
--   tabela serve os dois dominios) -> dexter_dimensoes usa p_contexto
--   ('tickets'|'os') para escolher o subconjunto certo.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 7) dexter_dimensoes(p_email, p_dimensao, p_contexto='tickets')
--    Gate: has_access (staff ativo do NetworkGo, mesmo criterio de has_access
--    do whoami — nao expoe dado sensivel de chamado/OS, so listas de valores
--    validos, entao nao exige flag granular especifica).
--    p_dimensao IN ('status','categorias','buildings','responsaveis','companies').
--    p_contexto IN ('tickets','os') — so importa para 'status'/'categorias'/
--    'responsaveis' (define qual tabela/join usar).
--    Retorna os valores validos (id+nome, e contagem de uso para
--    'responsaveis') para o Dexter descobrir ANTES de montar um filtro em
--    dexter_tickets_busca/dexter_os_busca.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_dimensoes(
  p_email text,
  p_dimensao text,
  p_contexto text default 'tickets'
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
  select coalesce(pu.is_active, false)
    into v_pode
  from public.profiles pr
  join public.platform_users pu on pu.user_id = pr.id
  where lower(pr.email) = lower(p_email)
  limit 1;

  if not coalesce(v_pode, false) then
    raise exception 'sem_acesso: % nao tem acesso ao NetworkGo', p_email
      using errcode = '42501';
  end if;

  if p_dimensao = 'status' then
    select coalesce(jsonb_agg(
             jsonb_build_object('id', s.id, 'nome', s.name)
             order by s.display_order nulls last, s.name
           ), '[]'::jsonb)
      into v_result
    from public.statuses s
    where coalesce(s.is_active, true)
      and (
        (p_contexto = 'os' and s.for_service_orders)
        or (p_contexto <> 'os' and s.for_tickets)
      );

  elsif p_dimensao = 'categorias' then
    select coalesce(jsonb_agg(
             jsonb_build_object('id', c.id, 'nome', c.name)
             order by c.name
           ), '[]'::jsonb)
      into v_result
    from public.categories c
    where coalesce(c.is_active, true)
      and (
        (p_contexto = 'os' and c.for_service_orders)
        or (p_contexto <> 'os' and c.for_tickets)
      );

  elsif p_dimensao = 'buildings' then
    select coalesce(jsonb_agg(
             jsonb_build_object('id', b.id, 'nome', b.name)
             order by b.name
           ), '[]'::jsonb)
      into v_result
    from public.buildings b
    where coalesce(b.is_active, true);

  elsif p_dimensao = 'responsaveis' then
    if p_contexto = 'os' then
      select coalesce(jsonb_agg(
               jsonb_build_object('id', x.id, 'nome', x.nome, 'qtd', x.qtd)
               order by x.qtd desc
             ), '[]'::jsonb)
        into v_result
      from (
        select p.id, p.full_name as nome, count(*) as qtd
        from public.os_service_orders o
        join public.profiles p on p.id = o.executor_id
        group by p.id, p.full_name
        order by count(*) desc
        limit 200
      ) x;
    else
      select coalesce(jsonb_agg(
               jsonb_build_object('id', x.id, 'nome', x.nome, 'qtd', x.qtd)
               order by x.qtd desc
             ), '[]'::jsonb)
        into v_result
      from (
        select p.id, p.full_name as nome, count(*) as qtd
        from public.tickets t
        join public.profiles p on p.id = t.assigned_to
        group by p.id, p.full_name
        order by count(*) desc
        limit 200
      ) x;
    end if;

  elsif p_dimensao = 'companies' then
    select coalesce(jsonb_agg(
             jsonb_build_object('id', x.id, 'nome', x.nome, 'qtd', x.qtd)
             order by x.qtd desc
           ), '[]'::jsonb)
      into v_result
    from (
      select
        c.id,
        coalesce(c.nome_fantasia, c.razao_social, c.name, c.nome_omie) as nome,
        count(t.id) as qtd
      from public.companies c
      left join public.tickets t on t.company_id = c.id
      where coalesce(c.is_active, true)
      group by c.id, c.nome_fantasia, c.razao_social, c.name, c.nome_omie
      order by count(t.id) desc
      limit 200
    ) x;

  else
    raise exception 'dimensao_invalida: % (use status|categorias|buildings|responsaveis|companies)', p_dimensao
      using errcode = '22023';
  end if;

  return jsonb_build_object(
    'dimensao', p_dimensao,
    'contexto', p_contexto,
    'valores', v_result
  );
end;
$$;

revoke all on function public.dexter_dimensoes(text, text, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 8) dexter_tickets_busca(..., p_company_id, p_empresa)
--    p_empresa filtra pelo CADASTRO (companies.*), nao titulo do chamado.
--    p_dias=0 ou null = historico completo (sem filtro de data).
-- -----------------------------------------------------------------------------
drop function if exists public.dexter_tickets_busca(text, text, text, text, text, uuid, int, int);
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
    and (p_texto is null or t.title ilike '%' || p_texto || '%'
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
      and (p_texto is null or t.title ilike '%' || p_texto || '%'
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
    and (p_texto is null or o.title ilike '%' || p_texto || '%'
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
      and (p_texto is null or o.title ilike '%' || p_texto || '%'
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

-- =============================================================================
-- CONSERTO DA CAMADA DE PESQUISAS DE SATISFACAO (CustOps) — APLICADO em producao
--
-- Aplicado no projeto Supabase qgtbxeobqlyptevsckjp via mcp apply_migration
-- (migrations: dexter_networkgo_pesquisas_fix, depois
-- dexter_networkgo_pesquisas_fix_v2 com o fix de extracao descrito abaixo).
-- Testado com bpm@gowork.com.br (admin) e com email inexistente (gate
-- negativo -> 42501).
--
-- BUG CONSERTADO: a dexter_satisfacao_resumo original (secao 6 acima)
-- misturava TODAS as pesquisas de satisfacao (survey_type 'nps' e 'general',
-- tipos e periodos diferentes) num "nps_medio" agregado unico — numero sem
-- sentido de negocio (ex.: media entre a pesquisa "NPS- Q2" 0-10 e a "CSAT"
-- 1-5). Pesquisas sao entidades SEPARADAS: nunca devem ser agregadas entre si.
--
-- Fix (3 pecas):
--   10) dexter_pesquisas_listar   -> descobre QUAL pesquisa existe (id,
--       titulo, tipo, periodo, total_respostas). E como o Dexter encontra,
--       por ex., "a pesquisa NPS do trimestre" antes de pedir o resultado.
--   11) dexter_pesquisa_resultado -> resultado de UMA pesquisa especifica
--       (por id ou por titulo ilike; ambiguo/nao encontrado retorna aviso
--       com candidatos, nunca adivinha). survey_type='nps' -> NPS real
--       (formula %promoters - %detractors); demais tipos -> nota
--       media/distribuicao. Sempre identifica survey_id/survey_title/
--       survey_type/total_respostas/periodo no retorno.
--   6r) dexter_satisfacao_resumo REDEFINIDA (mesma assinatura, comportamento
--       novo) -> painel POR PESQUISA (lista, cada uma com sua metrica
--       separada), com aviso explicito de que nao existe mais um "NPS medio"
--       cross-pesquisa e orientando a usar dexter_pesquisa_resultado /
--       dexter_pesquisas_listar.
--
-- Extracao de nota: reaproveita a logica da view
-- v_satisfaction_response_cards (numero / string numerica / {rating} /
-- {value} no jsonb "responses"), generalizada para TODAS as perguntas da
-- resposta (a view so resolve a 1a pergunta tipo 'nps' e a 1a tipo 'text'),
-- porque pesquisas "general" (CSAT) tem N perguntas tipo rating e o
-- nps_value da view fica NULL pra elas.
--
-- ARMADILHA ENCONTRADA E CONSERTADA (v2): o jsonb "responses" tambem carrega
-- metadados soltos fora do padrao "question_N", ex. "_phone" (string 100%
-- numerica, tipo "46999263665") e "_company". Sem filtrar as chaves por
-- `kv.key ~ '^question_[0-9]+$'`, o CASE generico lia "_phone" como se fosse
-- nota e explodia a media pra ~bilhoes. Confirmado via
-- `select distinct kv.key from satisfaction_responses r, jsonb_each(r.responses) kv
--  where kv.key !~ '^question_[0-9]+$'` -> so aparecem "_phone" e "_company".
--
-- Gate: platform_role='admin' OR gowork_member_permissions.satisfaction_responses
-- <> 'none' — mesmo criterio das RPCs de satisfacao anteriores.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 10) dexter_pesquisas_listar(p_email, p_data_ini=null, p_data_fim=null, p_tipo=null)
--     Gate: satisfaction_responses <> 'none' (ou admin).
--     Lista as pesquisas com {id, title, survey_type, is_active, periodo
--     (start/end configurado na pesquisa OU min/max responded_at quando a
--     pesquisa nao tem start/end), total_respostas}. Filtra por tipo (exato,
--     case-insensitive) e/ou periodo (overlap entre o periodo efetivo da
--     pesquisa e [p_data_ini, p_data_fim]).
-- -----------------------------------------------------------------------------
create or replace function public.dexter_pesquisas_listar(
  p_email text,
  p_data_ini date default null,
  p_data_fim date default null,
  p_tipo text default null
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

  with agg as (
    select
      s.id,
      s.title,
      s.survey_type,
      s.is_active,
      s.start_date,
      s.end_date,
      count(r.id) as total_respostas,
      min(r.responded_at) as primeira_resposta,
      max(r.responded_at) as ultima_resposta
    from public.satisfaction_surveys s
    left join public.satisfaction_responses r on r.survey_id = s.id
    where (p_tipo is null or lower(s.survey_type) = lower(p_tipo))
    group by s.id, s.title, s.survey_type, s.is_active, s.start_date, s.end_date
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', a.id,
      'title', a.title,
      'survey_type', a.survey_type,
      'is_active', a.is_active,
      'periodo', jsonb_build_object(
        'start', coalesce(a.start_date, a.primeira_resposta),
        'end', coalesce(a.end_date, a.ultima_resposta),
        'primeira_resposta', a.primeira_resposta,
        'ultima_resposta', a.ultima_resposta
      ),
      'total_respostas', a.total_respostas
    )
    order by coalesce(a.start_date, a.primeira_resposta) desc nulls last
  ), '[]'::jsonb)
  into v_result
  from agg a
  where (p_data_ini is null or coalesce(a.end_date::date, a.ultima_resposta::date) >= p_data_ini)
    and (p_data_fim is null or coalesce(a.start_date::date, a.primeira_resposta::date) <= p_data_fim);

  return jsonb_build_object(
    'filtros', jsonb_build_object(
      'data_ini', p_data_ini,
      'data_fim', p_data_fim,
      'tipo', p_tipo
    ),
    'pesquisas', v_result
  );
end;
$$;

revoke all on function public.dexter_pesquisas_listar(text, date, date, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 11) dexter_pesquisa_resultado(p_email, p_survey_id=null, p_titulo=null,
--                                 p_data_ini=null, p_data_fim=null)
--     Gate: satisfaction_responses <> 'none' (ou admin).
--     Resolve UMA pesquisa por id (prioridade) ou por titulo (ilike). Se o
--     titulo casar com mais de uma pesquisa, retorna aviso com a lista de
--     candidatos (nao adivinha). Se nao achar nenhuma, retorna aviso.
--     Resultado da pesquisa resolvida (nunca mistura com outras):
--       - survey_type='nps': NPS real = %promoters - %detractors (notas
--         9-10 / 7-8 / 0-6), nota media, contagens promoters/passives/
--         detractors.
--       - demais tipos: nota media (media das perguntas numericas/rating de
--         cada resposta) + distribuicao (contagem por nota arredondada).
--     Sempre identifica survey_id/survey_title/survey_type/total_respostas/
--     periodo no retorno.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_pesquisa_resultado(
  p_email text,
  p_survey_id uuid default null,
  p_titulo text default null,
  p_data_ini date default null,
  p_data_fim date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pode boolean;
  v_survey record;
  v_count_matches int;
  v_candidatos jsonb;
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

  if p_survey_id is null and (p_titulo is null or btrim(p_titulo) = '') then
    return jsonb_build_object(
      'encontrado', false,
      'mensagem', 'Informe p_survey_id ou p_titulo. Use dexter_pesquisas_listar para descobrir qual pesquisa usar.'
    );
  end if;

  -- Resolucao da pesquisa: por id (exato) ou por titulo (ilike, pode ser ambiguo).
  if p_survey_id is not null then
    select s.id, s.title, s.survey_type, s.is_active, s.start_date, s.end_date
      into v_survey
    from public.satisfaction_surveys s
    where s.id = p_survey_id;

    if not found then
      return jsonb_build_object(
        'encontrado', false,
        'mensagem', format('Nenhuma pesquisa encontrada com id %s.', p_survey_id)
      );
    end if;
  else
    select count(*)
      into v_count_matches
    from public.satisfaction_surveys s
    where s.title ilike '%' || p_titulo || '%';

    if v_count_matches = 0 then
      return jsonb_build_object(
        'encontrado', false,
        'mensagem', format('Nenhuma pesquisa com titulo parecido com "%s". Use dexter_pesquisas_listar para ver os titulos existentes.', p_titulo)
      );
    elsif v_count_matches > 1 then
      select jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'title', s.title,
          'survey_type', s.survey_type,
          'is_active', s.is_active,
          'start_date', s.start_date,
          'end_date', s.end_date
        )
        order by s.start_date desc nulls last
      )
        into v_candidatos
      from public.satisfaction_surveys s
      where s.title ilike '%' || p_titulo || '%';

      return jsonb_build_object(
        'encontrado', false,
        'ambiguo', true,
        'mensagem', format('%s pesquisas encontradas com titulo parecido com "%s". Especifique p_survey_id.', v_count_matches, p_titulo),
        'candidatos', v_candidatos
      );
    end if;

    select s.id, s.title, s.survey_type, s.is_active, s.start_date, s.end_date
      into v_survey
    from public.satisfaction_surveys s
    where s.title ilike '%' || p_titulo || '%'
    limit 1;
  end if;

  -- Resultado da pesquisa resolvida (v_survey.id), nunca misturado com outras.
  with response_notes as (
    select
      v.id as response_id,
      v.responded_at,
      v.created_at,
      v.nps_value,
      v.nps_zone,
      -- Extracao generica de nota: mesma logica da view
      -- v_satisfaction_response_cards (numero / string numerica / {rating} /
      -- {value}), aplicada a TODAS as perguntas da resposta. Filtro
      -- kv.key ~ '^question_[0-9]+$' exclui metadados soltos ("_phone",
      -- "_company") que sao strings 100% numericas e explodiam a media.
      (
        select avg(ex.val)
        from jsonb_each(r.responses) kv
        cross join lateral (
          select case
            when jsonb_typeof(kv.value) = 'number' then (kv.value #>> '{}')::numeric
            when jsonb_typeof(kv.value) = 'string'
                 and (kv.value #>> '{}') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
              then btrim(kv.value #>> '{}')::numeric
            when jsonb_typeof(kv.value) = 'object'
                 and (kv.value ->> 'rating') ~ '^-?[0-9]+(\.[0-9]+)?$'
              then (kv.value ->> 'rating')::numeric
            when jsonb_typeof(kv.value) = 'object'
                 and (kv.value ->> 'value') ~ '^-?[0-9]+(\.[0-9]+)?$'
              then (kv.value ->> 'value')::numeric
            else null
          end as val
        ) ex
        where kv.key ~ '^question_[0-9]+$'
      ) as nota_generica
    from public.v_satisfaction_response_cards v
    join public.satisfaction_responses r on r.id = v.id
    where v.survey_id = v_survey.id
      and (p_data_ini is null or coalesce(v.responded_at, v.created_at)::date >= p_data_ini)
      and (p_data_fim is null or coalesce(v.responded_at, v.created_at)::date <= p_data_fim)
  )
  select jsonb_build_object(
    'encontrado', true,
    'survey_id', v_survey.id,
    'survey_title', v_survey.title,
    'survey_type', v_survey.survey_type,
    'is_active', v_survey.is_active,
    'periodo', jsonb_build_object(
      'start', v_survey.start_date,
      'end', v_survey.end_date,
      'primeira_resposta', min(rn.responded_at),
      'ultima_resposta', max(rn.responded_at)
    ),
    'total_respostas', count(rn.response_id),
    'metricas', case
      when v_survey.survey_type = 'nps' then jsonb_build_object(
        'nps', round(
          (100.0 * count(*) filter (where rn.nps_zone = 'promoter') / nullif(count(rn.nps_value), 0))
          - (100.0 * count(*) filter (where rn.nps_zone = 'detractor') / nullif(count(rn.nps_value), 0))
        , 1),
        'formula', 'NPS = %promotores(9-10) - %detratores(0-6), sobre respostas com nota',
        'nota_media', round(avg(rn.nps_value)::numeric, 2),
        'promoters', count(*) filter (where rn.nps_zone = 'promoter'),
        'passives', count(*) filter (where rn.nps_zone = 'passive'),
        'detractors', count(*) filter (where rn.nps_zone = 'detractor')
      )
      else jsonb_build_object(
        'nota_media', round(avg(rn.nota_generica)::numeric, 2),
        'distribuicao_notas', coalesce((
          select jsonb_object_agg(d.bucket::text, d.n order by d.bucket)
          from (
            select round(rn2.nota_generica)::int as bucket, count(*) as n
            from response_notes rn2
            where rn2.nota_generica is not null
            group by round(rn2.nota_generica)::int
          ) d
        ), '{}'::jsonb)
      )
    end
  )
  into v_result
  from response_notes rn;

  return v_result;
end;
$$;

revoke all on function public.dexter_pesquisa_resultado(text, uuid, text, date, date) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6r) dexter_satisfacao_resumo(p_email, p_dias=30, p_building_id=null) —
--     REDEFINIDA (create or replace sobre a funcao da secao 6). Mesma
--     assinatura (compatibilidade), MAS agora NAO existe mais "nps_medio"
--     agregado cross-pesquisa. Retorna panorama POR PESQUISA: cada pesquisa
--     com sua metrica separada (nps real se survey_type='nps', nota
--     media/distribuicao para os demais), mais um aviso explicito orientando
--     o uso de dexter_pesquisa_resultado (uma pesquisa especifica) ou
--     dexter_pesquisas_listar (descobrir qual usar).
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

  with response_notes as (
    select
      v.survey_id,
      v.id as response_id,
      v.responded_at,
      v.created_at,
      v.nps_value,
      v.nps_zone,
      (
        select avg(ex.val)
        from jsonb_each(r.responses) kv
        cross join lateral (
          select case
            when jsonb_typeof(kv.value) = 'number' then (kv.value #>> '{}')::numeric
            when jsonb_typeof(kv.value) = 'string'
                 and (kv.value #>> '{}') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
              then btrim(kv.value #>> '{}')::numeric
            when jsonb_typeof(kv.value) = 'object'
                 and (kv.value ->> 'rating') ~ '^-?[0-9]+(\.[0-9]+)?$'
              then (kv.value ->> 'rating')::numeric
            when jsonb_typeof(kv.value) = 'object'
                 and (kv.value ->> 'value') ~ '^-?[0-9]+(\.[0-9]+)?$'
              then (kv.value ->> 'value')::numeric
            else null
          end as val
        ) ex
        where kv.key ~ '^question_[0-9]+$'
      ) as nota_generica
    from public.v_satisfaction_response_cards v
    join public.satisfaction_responses r on r.id = v.id
    where coalesce(v.responded_at, v.created_at) >= now() - make_interval(days => p_dias)
      and (p_building_id is null or v.building_id = p_building_id)
  ),
  por_survey as (
    select
      s.id,
      s.title,
      s.survey_type,
      s.is_active,
      s.start_date,
      s.end_date,
      count(rn.response_id) as total_respostas,
      min(rn.responded_at) as primeira_resposta,
      max(rn.responded_at) as ultima_resposta,
      count(*) filter (where rn.nps_zone = 'promoter') as promoters,
      count(*) filter (where rn.nps_zone = 'passive') as passives,
      count(*) filter (where rn.nps_zone = 'detractor') as detractors,
      count(rn.nps_value) as cnt_nps,
      round(avg(rn.nps_value)::numeric, 2) as nota_media_nps,
      round(avg(rn.nota_generica)::numeric, 2) as nota_media_generica
    from public.satisfaction_surveys s
    join response_notes rn on rn.survey_id = s.id
    group by s.id, s.title, s.survey_type, s.is_active, s.start_date, s.end_date
  )
  select jsonb_build_object(
    'aviso', 'Cada pesquisa e INDEPENDENTE e de um survey_type diferente (nps vs general) — nao existe um "NPS medio" unico entre pesquisas. Este retorno e um panorama POR PESQUISA. Para o resultado detalhado de UMA pesquisa, use dexter_pesquisa_resultado(p_survey_id ou p_titulo). Para descobrir qual pesquisa usar, use dexter_pesquisas_listar.',
    'periodo_dias', p_dias,
    'building_id', p_building_id,
    'total_pesquisas_no_periodo', count(*),
    'pesquisas', coalesce(jsonb_agg(
      jsonb_build_object(
        'survey_id', ps.id,
        'survey_title', ps.title,
        'survey_type', ps.survey_type,
        'is_active', ps.is_active,
        'total_respostas', ps.total_respostas,
        'periodo', jsonb_build_object(
          'start', ps.start_date,
          'end', ps.end_date,
          'primeira_resposta', ps.primeira_resposta,
          'ultima_resposta', ps.ultima_resposta
        ),
        'metricas', case
          when ps.survey_type = 'nps' then jsonb_build_object(
            'nps', round(
              (100.0 * ps.promoters / nullif(ps.cnt_nps, 0))
              - (100.0 * ps.detractors / nullif(ps.cnt_nps, 0))
            , 1),
            'nota_media', ps.nota_media_nps,
            'promoters', ps.promoters,
            'passives', ps.passives,
            'detractors', ps.detractors
          )
          else jsonb_build_object(
            'nota_media', ps.nota_media_generica
          )
        end
      )
      order by ps.total_respostas desc
    ), '[]'::jsonb)
  )
  into v_result
  from por_survey ps;

  return v_result;
end;
$$;

revoke all on function public.dexter_satisfacao_resumo(text, int, uuid) from public, anon, authenticated;

-- =============================================================================
-- Ainda pendentes (fora do escopo desta rodada): faturas/invoices_admin.
-- Mesmo padrao de gate se/quando forem construidas.
-- =============================================================================
