-- =============================================================================
-- AgentCore × GoDash — camada de acesso do Dexter
--
-- Projeto Supabase: xggqzueehfvautkmaojy
--
-- Princípios (baseline de segurança do projeto):
--  - O Dexter NUNCA roda SQL livre. Só chama estas RPCs read-only.
--  - Autorização REUSA a permissão que já existe no GoDash: profiles (staff
--    ativo/inativo) + reports + user_report_access + user_groups/access_groups/
--    group_report_access. O Dexter enxerga (no máximo) o mesmo conjunto de
--    relatórios que o usuário veria logado no app.
--  - Regra de bypass: profiles.role = 'admin' enxerga todos os relatórios
--    ativos (mesmo comportamento do front do GoDash, onde admin não depende de
--    grant individual). Qualquer outro role só vê o que está em
--    user_report_access ou herdado via user_groups -> group_report_access.
--  - SECURITY DEFINER + search_path vazio + tudo schema-qualificado + EXECUTE
--    revogado de public/anon/authenticated (só quem tem privilégio de owner —
--    isto é, o backend do Dexter via service_role/postgres — chama).
--  - A chave de identidade é o EMAIL VERIFICADO vindo do JWT do Dexter.
--  - has_access = existe profile com esse email E profile.active = true. Isso
--    vale mesmo que, no futuro, o GoDash decida liberar "todos os internos
--    veem tudo": um usuário inativo ou inexistente NUNCA tem has_access=true.
--  - Nenhuma RLS foi alterada. O GoDash tem hoje 6 tabelas com RLS desabilitado
--    (_m1_renovacao_snap, projecao_proj_fato, projecao_iugu_faturas,
--    projecao_iugu_faturas_clientes, projecao_iugu_saques,
--    projecao_rendimento_parametros) — isso é pré-existente e não é alterado
--    aqui; como as RPCs abaixo são SECURITY DEFINER com gate próprio, o estado
--    de RLS dessas tabelas não abre nem fecha nada adicional para o Dexter.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) Helper interno — dexter_godash_pode(email, slug) — a pessoa tem acesso ao
--    relatório <slug> no GoDash agora? Reaproveitado por todas as RPCs de dado
--    abaixo. Não é chamado diretamente pelo Dexter (mas fica com o mesmo gate
--    de segurança das demais: SECURITY DEFINER, search_path vazio, EXECUTE
--    revogado de public/anon/authenticated — só o owner, dentro de outra
--    função SECURITY DEFINER, consegue executá-la).
-- -----------------------------------------------------------------------------
create or replace function public.dexter_godash_pode(p_email text, p_slug text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(
      bool_or(
        pr.active
        and (
          pr.role = 'admin'
          or exists (
            select 1
            from public.user_report_access ura
            join public.reports r on r.id = ura.report_id
            where ura.user_id = pr.id and r.slug = p_slug and r.active
          )
          or exists (
            select 1
            from public.user_groups ug
            join public.group_report_access gra on gra.group_id = ug.group_id
            join public.reports r on r.id = gra.report_id
            where ug.user_id = pr.id and r.slug = p_slug and r.active
          )
        )
      ),
      false
    )
  from public.profiles pr
  where lower(pr.email) = lower(p_email);
$$;

revoke all on function public.dexter_godash_pode(text, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 1) dexter_whoami(email) — quem é esse usuário no GoDash e o que ele enxerga.
--    has_access=false se não existir profile com esse email ou se estiver
--    inativo. relatorios_acessiveis é a lista efetiva (admin = todos os
--    relatórios ativos; demais = union de acesso individual + de grupo).
-- -----------------------------------------------------------------------------
create or replace function public.dexter_whoami(p_email text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with p as (
    select *
    from public.profiles
    where lower(email) = lower(p_email)
    limit 1
  ),
  relatorios as (
    select r.slug, r.name, r.category
    from public.reports r
    cross join p
    where r.active
      and (
        p.role = 'admin'
        or exists (
          select 1 from public.user_report_access ura
          where ura.user_id = p.id and ura.report_id = r.id
        )
        or exists (
          select 1
          from public.user_groups ug
          join public.group_report_access gra on gra.group_id = ug.group_id
          where ug.user_id = p.id and gra.report_id = r.id
        )
      )
  )
  select
    case
      when p.id is null or coalesce(p.active, false) = false then
        jsonb_build_object('has_access', false)
      else
        jsonb_build_object(
          'has_access', true,
          'user_id', p.id,
          'email', p.email,
          'full_name', p.full_name,
          'role', p.role,
          'relatorios_acessiveis', coalesce((
            select jsonb_agg(jsonb_build_object(
              'slug', relatorios.slug,
              'name', relatorios.name,
              'category', relatorios.category
            ) order by relatorios.category, relatorios.name)
            from relatorios
          ), '[]'::jsonb)
        )
    end
  from p
  union all
  select jsonb_build_object('has_access', false)
  where not exists (select 1 from p)
  limit 1;
$$;

revoke all on function public.dexter_whoami(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2) dexter_hubspot_funil_resumo(email, dias) — funil de vendas HubSpot
--    (hs_funil_deals, o pipeline greenfield que alimenta o relatório
--    "Funil HubSpot"). Agregado por pipeline + estágio, negócios criados nos
--    últimos p_dias. Gate: relatório 'funil-hubspot'.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_hubspot_funil_resumo(p_email text, p_dias int default 90)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not coalesce(public.dexter_godash_pode(p_email, 'funil-hubspot'), false) then
    raise exception 'sem_acesso: % nao tem acesso ao Funil HubSpot no GoDash', p_email
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'periodo_dias', p_dias,
    'total_negocios', count(*),
    'total_abertos', count(*) filter (where not d.is_closed),
    'total_ganhos', count(*) filter (where d.is_closed and d.is_won),
    'total_perdidos', count(*) filter (where d.is_closed and not d.is_won),
    'valor_aberto', coalesce(sum(d.amount) filter (where not d.is_closed), 0),
    'valor_ganho', coalesce(sum(d.amount) filter (where d.is_closed and d.is_won), 0),
    'por_pipeline_estagio', coalesce((
      select jsonb_agg(jsonb_build_object(
        'pipeline', coalesce(pl.label, sub.pipeline_id),
        'estagio', coalesce(st.label, sub.deal_stage, sub.stage_id),
        'qtd', sub.qtd,
        'valor', sub.valor
      ) order by sub.qtd desc)
      from (
        select pipeline_id, stage_id, deal_stage,
               count(*) as qtd,
               coalesce(sum(amount), 0) as valor
        from public.hs_funil_deals
        where create_date >= now() - make_interval(days => p_dias)
          and not archived
        group by pipeline_id, stage_id, deal_stage
        order by count(*) desc
        limit 50
      ) sub
      left join public.hubspot_pipelines pl on pl.hubspot_id = sub.pipeline_id
      left join public.hubspot_pipeline_stages st
        on st.pipeline_id = sub.pipeline_id and st.stage_id = sub.stage_id
    ), '[]'::jsonb)
  )
  into v_result
  from public.hs_funil_deals d
  where d.create_date >= now() - make_interval(days => p_dias)
    and not d.archived;

  return v_result;
end;
$$;

revoke all on function public.dexter_hubspot_funil_resumo(text, int) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3) dexter_projecao_financeira_resumo(email, meses) — contas a pagar/receber
--    OMIE (contas_pagar, contas_receber), agregado por origem + status +
--    mês de vencimento. Gate: relatório 'projecao' OU 'contas' (mesmas
--    tabelas-fonte alimentam os dois relatórios financeiros do GoDash).
-- -----------------------------------------------------------------------------
create or replace function public.dexter_projecao_financeira_resumo(p_email text, p_meses int default 3)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not (
    coalesce(public.dexter_godash_pode(p_email, 'projecao'), false)
    or coalesce(public.dexter_godash_pode(p_email, 'contas'), false)
  ) then
    raise exception 'sem_acesso: % nao tem acesso a Cashflow/Contas no GoDash', p_email
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'periodo_meses', p_meses,
    'contas_pagar', coalesce((
      select jsonb_agg(jsonb_build_object(
        'mes', to_char(sub.mes, 'YYYY-MM'),
        'origem', sub.origem,
        'status', sub.status_titulo,
        'qtd', sub.qtd,
        'valor_documento', sub.valor_documento,
        'valor_pago', sub.valor_pago
      ) order by sub.mes, sub.origem, sub.status_titulo)
      from (
        select
          date_trunc('month', cp.data_vencimento) as mes,
          cp.origem,
          cp.status_titulo,
          count(*) as qtd,
          coalesce(sum(cp.valor_documento), 0) as valor_documento,
          coalesce(sum(cp.valor_pago), 0) as valor_pago
        from public.contas_pagar cp
        where cp.data_vencimento >= date_trunc('month', now()) - make_interval(months => p_meses)
        group by date_trunc('month', cp.data_vencimento), cp.origem, cp.status_titulo
        limit 50
      ) sub
    ), '[]'::jsonb),
    'contas_receber', coalesce((
      select jsonb_agg(jsonb_build_object(
        'mes', to_char(sub.mes, 'YYYY-MM'),
        'origem', sub.origem,
        'status', sub.status_titulo,
        'qtd', sub.qtd,
        'valor_documento', sub.valor_documento,
        'valor_pago', sub.valor_pago
      ) order by sub.mes, sub.origem, sub.status_titulo)
      from (
        select
          date_trunc('month', cr.data_vencimento) as mes,
          cr.origem,
          cr.status_titulo,
          count(*) as qtd,
          coalesce(sum(cr.valor_documento), 0) as valor_documento,
          coalesce(sum(cr.valor_pago), 0) as valor_pago
        from public.contas_receber cr
        where cr.data_vencimento >= date_trunc('month', now()) - make_interval(months => p_meses)
        group by date_trunc('month', cr.data_vencimento), cr.origem, cr.status_titulo
        limit 50
      ) sub
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_projecao_financeira_resumo(text, int) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4) dexter_ranking_comissoes(email, dias) — comissões HubSpot
--    (hubspot_commissions_obj), ranking por vendedor/SDR (hubspot_owners).
--    Gate: relatório 'ranking' OU 'comissoes'.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_ranking_comissoes(p_email text, p_dias int default 180)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not (
    coalesce(public.dexter_godash_pode(p_email, 'ranking'), false)
    or coalesce(public.dexter_godash_pode(p_email, 'comissoes'), false)
  ) then
    raise exception 'sem_acesso: % nao tem acesso a Ranking/Comissoes no GoDash', p_email
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'periodo_dias', p_dias,
    'total_comissoes', count(*),
    'valor_total', coalesce(sum(c.commission_amount), 0),
    'por_status_pagamento', coalesce((
      select jsonb_object_agg(coalesce(x.payment_status, 'sem_status'), x.n)
      from (
        select payment_status, count(*) n
        from public.hubspot_commissions_obj
        where created_at >= now() - make_interval(days => p_dias)
          and not archived
        group by payment_status
      ) x
    ), '{}'::jsonb),
    'ranking_por_owner', coalesce((
      select jsonb_agg(jsonb_build_object(
        'owner_id', y.owner_id,
        'owner_nome', trim(both ' ' from coalesce(y.first_name, '') || ' ' || coalesce(y.last_name, '')),
        'owner_email', y.email,
        'qtd_comissoes', y.qtd,
        'valor_total', y.valor
      ) order by y.valor desc)
      from (
        select
          c.owner_id,
          ho.first_name,
          ho.last_name,
          ho.email,
          count(*) as qtd,
          coalesce(sum(c.commission_amount), 0) as valor
        from public.hubspot_commissions_obj c
        left join public.hubspot_owners ho on ho.hubspot_id = c.owner_id
        where c.created_at >= now() - make_interval(days => p_dias)
          and not c.archived
        group by c.owner_id, ho.first_name, ho.last_name, ho.email
        order by sum(c.commission_amount) desc
        limit 50
      ) y
    ), '[]'::jsonb)
  )
  into v_result
  from public.hubspot_commissions_obj c
  where c.created_at >= now() - make_interval(days => p_dias)
    and not c.archived;

  return v_result;
end;
$$;

revoke all on function public.dexter_ranking_comissoes(text, int) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5) dexter_notion_tasks_resumo(email, dias) — tarefas Notion (notion_tasks):
--    resumo por status/departamento + lista de atrasadas. Gate: relatório
--    'notion'.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_notion_tasks_resumo(p_email text, p_dias int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not coalesce(public.dexter_godash_pode(p_email, 'notion'), false) then
    raise exception 'sem_acesso: % nao tem acesso a Tarefas Notion no GoDash', p_email
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'periodo_dias', p_dias,
    'total_tarefas_no_periodo', count(*) filter (where t.date_start >= now() - make_interval(days => p_dias)),
    'por_status', coalesce((
      select jsonb_object_agg(coalesce(x.status, 'sem_status'), x.n)
      from (
        select status, count(*) n
        from public.notion_tasks
        where date_start >= now() - make_interval(days => p_dias)
        group by status
      ) x
    ), '{}'::jsonb),
    'por_departamento', coalesce((
      select jsonb_object_agg(coalesce(x.department, 'sem_departamento'), x.n)
      from (
        select department, count(*) n
        from public.notion_tasks
        where date_start >= now() - make_interval(days => p_dias)
        group by department
      ) x
    ), '{}'::jsonb),
    'atrasadas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'title', z.title,
        'status', z.status,
        'priority', z.priority,
        'executor', z.executor,
        'department', z.department,
        'date_end', z.date_end
      ) order by z.date_end asc)
      from (
        select title, status, priority, executor, department, date_end
        from public.notion_tasks
        where date_end < current_date
          and status is not null
          and status not ilike '9%'   -- '9 - Concluído'
          and status not ilike '0%'   -- '0 - Cancelado'
        order by date_end asc
        limit 50
      ) z
    ), '[]'::jsonb)
  )
  into v_result
  from public.notion_tasks t
  where t.date_start >= now() - make_interval(days => p_dias);

  return v_result;
end;
$$;

revoke all on function public.dexter_notion_tasks_resumo(text, int) from public, anon, authenticated;
