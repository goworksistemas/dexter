-- =============================================================================
-- AgentCore × SupplyGo — camada de acesso do Dexter
--
-- Projeto Supabase: dtcklkhvrsyxjjjmuquw
--
-- Domínio: SupplyGo é o módulo de COMPRAS CORPORATIVAS da GoWork
-- (Solicitação de Compra → Cotação/RFQ → Pedido de Compra → Recebimento/NF),
-- com fornecedores homologados, contratos com saldo por vigência, alçadas de
-- aprovação por valor, cartões corporativos e, além disso, a integração de
-- VENDAS no Mercado Livre (ml_pedidos/ml_envios/ml_notas_fiscais) — quando um
-- pedido ML precisa de reposição, ele pode gerar um Pedido de Compra
-- (ml_pedidos.pedido_compra_id). Existe também um esqueleto de estoque/almox
-- (depositos, insumos, estoque_atual, movimentacoes, inventarios,
-- alertas_estoque) que está com 0 linhas em todas as tabelas — não é usado
-- hoje, então não foi coberto por nenhuma RPC de dado.
--
-- Modelo de permissão (public.profiles, chave = email):
--   - profiles.role   : admin | diretor | gestor | comprador | user (enum user_role)
--   - profiles.status : pendente | aprovado | rejeitado (enum user_status)
--   - profiles.ativo  : boolean
--   - has_access (whoami) = existe profile com esse email, ativo=true e
--     status='aprovado'. Sem isso, NUNCA has_access=true (mesmo que a linha
--     exista pendente ou rejeitada).
--   - Escopo dos dados agregados (SC/cotação/pedido/fornecedor/ML) = reservado
--     aos papéis que enxergam visão consolidada de compras no app: admin,
--     diretor, gestor, comprador. O papel 'user' (solicitante comum) só
--     enxerga as próprias SCs dentro do app — não tem visão de dashboard
--     consolidado, então as RPCs de dado abaixo barram esse papel
--     (has_access do whoami continua true, só os RPCs agregados que negam).
--     Escolha conservadora: nenhuma tabela nova foi lida para inferir escopo
--     por departamento; o gate é só por papel.
--
-- Todas as funções: SECURITY DEFINER, SET search_path='', schema-qualificadas,
-- REVOKE ALL FROM public, anon, authenticated (execução restrita ao owner /
-- service_role usado pelo Dexter). Nenhuma RLS foi alterada.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) Helper interno — dexter_supplygo_pode(email) — o usuário é staff ativo e
--    aprovado com papel que enxerga dashboards consolidados de compras
--    (admin/diretor/gestor/comprador)? Não é pensado para uso direto pelo
--    Dexter; usado como gate pelas RPCs de dado abaixo.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_supplygo_pode(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    bool_or(
      p.ativo
      and p.status = 'aprovado'
      and p.role in ('admin', 'diretor', 'gestor', 'comprador')
    ),
    false
  )
  from public.profiles p
  where lower(p.email) = lower(trim(p_email));
$$;

revoke all on function public.dexter_supplygo_pode(text) from public, anon, authenticated;

comment on function public.dexter_supplygo_pode(text) is
  'Dexter (interno): true se o email é staff ativo+aprovado com papel admin/diretor/gestor/comprador no SupplyGo. Gate reutilizado pelas RPCs de dado.';


-- -----------------------------------------------------------------------------
-- 1) dexter_whoami(p_email) — quem é esse usuário no SupplyGo e o que ele
--    enxerga. has_access=false se não existir profile ativo+aprovado com esse
--    email (mesmo que exista pendente/rejeitado/inativo).
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
      when p.id is null
        or coalesce(p.ativo, false) = false
        or p.status is distinct from 'aprovado'
      then jsonb_build_object(
        'has_access', false,
        'email', lower(trim(p_email)),
        'motivo', case
          when p.id is null then 'sem_cadastro'
          when coalesce(p.ativo, false) = false then 'inativo'
          else 'status_' || p.status::text
        end
      )
      else jsonb_build_object(
        'has_access', true,
        'user_id', p.id,
        'email', p.email,
        'nome', p.nome,
        'role', p.role,
        'status', p.status,
        'departamento', d.nome,
        'pode_ver_dashboards_compras', p.role in ('admin', 'diretor', 'gestor', 'comprador')
      )
    end
  from (select p_email as e) q
  left join public.profiles p on lower(p.email) = lower(trim(q.e))
  left join public.core_departamentos d on d.id = p.departamento_id
  limit 1;
$$;

revoke all on function public.dexter_whoami(text) from public, anon, authenticated;

comment on function public.dexter_whoami(text) is
  'Dexter: identidade do email no SupplyGo. has_access=true só se profile existir, ativo=true e status=aprovado. pode_ver_dashboards_compras indica se o papel dá direito às RPCs agregadas abaixo.';


-- -----------------------------------------------------------------------------
-- 2) dexter_compras_funil_resumo(p_email, p_dias) — funil de compras no
--    período: Solicitação de Compra -> Cotação (RFQ) -> Pedido de Compra,
--    contagem e valor por status, + gargalo atual de aprovações pendentes
--    (sem filtro de período, é "agora"). Gate: dexter_supplygo_pode.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_compras_funil_resumo(p_email text, p_dias int default 90)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dias int := greatest(coalesce(p_dias, 90), 1);
  v_result jsonb;
begin
  if not coalesce(public.dexter_supplygo_pode(p_email), false) then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;

  with sc as (
    select * from public.cmp_solicitacoes_compra
    where created_at >= now() - make_interval(days => v_dias)
  ),
  cot as (
    select * from public.cmp_cotacoes
    where created_at >= now() - make_interval(days => v_dias)
  ),
  ped as (
    select * from public.cmp_pedidos_compra
    where created_at >= now() - make_interval(days => v_dias)
  )
  select jsonb_build_object(
    'periodo_dias', v_dias,
    'solicitacoes_compra', jsonb_build_object(
      'total', (select count(*) from sc),
      'por_status', coalesce((
        select jsonb_object_agg(x.status, x.n)
        from (select status, count(*) n from sc group by status) x
      ), '{}'::jsonb),
      'valor_estimado_total', coalesce((
        select sum(i.quantidade * coalesce(i.preco_estimado, 0))
        from public.cmp_solicitacoes_compra_itens i
        join sc on sc.id = i.solicitacao_id
      ), 0)
    ),
    'cotacoes', jsonb_build_object(
      'total', (select count(*) from cot),
      'por_status', coalesce((
        select jsonb_object_agg(x.status, x.n)
        from (select status, count(*) n from cot group by status) x
      ), '{}'::jsonb)
    ),
    'pedidos_compra', jsonb_build_object(
      'total', (select count(*) from ped),
      'por_status', coalesce((
        select jsonb_object_agg(x.status, x.n)
        from (select status, count(*) n from ped group by status) x
      ), '{}'::jsonb),
      'valor_total', coalesce((
        select sum(i.quantidade * i.preco_unitario)
        from public.cmp_pedidos_compra_itens i
        join ped on ped.id = i.pedido_id
      ), 0),
      'valor_recebido', coalesce((
        select sum(i.quantidade_recebida * i.preco_unitario)
        from public.cmp_pedidos_compra_itens i
        join ped on ped.id = i.pedido_id
      ), 0)
    ),
    'pendencias_agora', jsonb_build_object(
      'solicitacoes_aguardando_aprovacao', (
        select count(*) from public.cmp_solicitacoes_compra where status = 'aguardando_aprovacao'
      ),
      'pedidos_aguardando_aprovacao', (
        select count(*) from public.cmp_pedidos_compra where status ilike '%aprova%'
      )
    )
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_compras_funil_resumo(text, int) from public, anon, authenticated;

comment on function public.dexter_compras_funil_resumo(text, int) is
  'Dexter: funil de compras (SC -> Cotação -> Pedido) no período, contagem/valor por status, + pendências de aprovação atuais. Gate: dexter_supplygo_pode (42501 se negado).';


-- -----------------------------------------------------------------------------
-- 3) dexter_fornecedores_contratos_resumo(p_email, p_dias, p_limit) — visão
--    de fornecedores (cadastro/homologação) + ranking de spend por
--    fornecedor via Pedidos de Compra no período + saúde dos contratos
--    (saldo restante, vencendo em 30 dias). Gate: dexter_supplygo_pode.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_fornecedores_contratos_resumo(
  p_email text,
  p_dias int default 180,
  p_limit int default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dias int := greatest(coalesce(p_dias, 180), 1);
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 50);
  v_result jsonb;
begin
  if not coalesce(public.dexter_supplygo_pode(p_email), false) then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;

  with ped as (
    select * from public.cmp_pedidos_compra
    where created_at >= now() - make_interval(days => v_dias)
  ),
  spend as (
    select
      f.id as fornecedor_id,
      f.razao_social,
      f.nome_fantasia,
      f.homologado,
      count(distinct ped.id) as qtd_pedidos,
      sum(i.quantidade * i.preco_unitario) as valor_total
    from ped
    join public.cmp_fornecedores f on f.id = ped.fornecedor_id
    join public.cmp_pedidos_compra_itens i on i.pedido_id = ped.id
    group by f.id, f.razao_social, f.nome_fantasia, f.homologado
  )
  select jsonb_build_object(
    'periodo_dias', v_dias,
    'fornecedores', jsonb_build_object(
      'total', (select count(*) from public.cmp_fornecedores),
      'ativos', (select count(*) from public.cmp_fornecedores where ativo),
      'homologados', (select count(*) from public.cmp_fornecedores where homologado)
    ),
    'top_fornecedores_por_spend', coalesce((
      select jsonb_agg(jsonb_build_object(
        'fornecedor', coalesce(s.nome_fantasia, s.razao_social),
        'homologado', s.homologado,
        'qtd_pedidos', s.qtd_pedidos,
        'valor_total', s.valor_total
      ) order by s.valor_total desc)
      from (select * from spend order by valor_total desc limit v_limit) s
    ), '[]'::jsonb),
    'contratos', jsonb_build_object(
      'total', (select count(*) from public.cmp_contratos),
      'vigentes', (select count(*) from public.cmp_contratos where status = 'vigente'),
      'saldo_total_vigentes', coalesce((select sum(saldo) from public.cmp_contratos where status = 'vigente'), 0),
      'valor_total_vigentes', coalesce((select sum(valor_total) from public.cmp_contratos where status = 'vigente'), 0),
      'vencendo_30_dias', coalesce((
        select jsonb_agg(jsonb_build_object(
          'fornecedor', coalesce(f.nome_fantasia, f.razao_social),
          'valor_total', c.valor_total,
          'saldo', c.saldo,
          'vigencia_fim', upper(c.vigencia)
        ) order by upper(c.vigencia) asc)
        from (
          select * from public.cmp_contratos
          where status = 'vigente'
            and upper(vigencia) between current_date and current_date + 30
          limit v_limit
        ) c
        join public.cmp_fornecedores f on f.id = c.fornecedor_id
      ), '[]'::jsonb)
    )
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_fornecedores_contratos_resumo(text, int, int) from public, anon, authenticated;

comment on function public.dexter_fornecedores_contratos_resumo(text, int, int) is
  'Dexter: cadastro/homologação de fornecedores, ranking de spend via Pedidos de Compra no período (cap p_limit<=50), e saúde de contratos (saldo, vencendo em 30 dias). Gate: dexter_supplygo_pode (42501 se negado).';


-- -----------------------------------------------------------------------------
-- 4) dexter_vendas_ml_resumo(p_email, p_dias, p_limit) — vendas no Mercado
--    Livre (ml_pedidos/ml_envios): contagem/valor por status de pedido,
--    status de envio, e top produtos vendidos por quantidade/valor no
--    período. Gate: dexter_supplygo_pode (mesma visão consolidada de
--    compras/operação — ML alimenta pedidos de compra de reposição).
-- -----------------------------------------------------------------------------
create or replace function public.dexter_vendas_ml_resumo(
  p_email text,
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
  v_dias int := greatest(coalesce(p_dias, 30), 1);
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 50);
  v_result jsonb;
begin
  if not coalesce(public.dexter_supplygo_pode(p_email), false) then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;

  with pe as (
    select * from public.ml_pedidos
    where data_criacao >= now() - make_interval(days => v_dias)
  )
  select jsonb_build_object(
    'periodo_dias', v_dias,
    'pedidos', jsonb_build_object(
      'total', (select count(*) from pe),
      'por_status', coalesce((
        select jsonb_object_agg(coalesce(x.status, 'sem_status'), x.n)
        from (select status, count(*) n from pe group by status) x
      ), '{}'::jsonb),
      'valor_total_pago', coalesce((select sum(total) from pe where status = 'paid'), 0),
      'ticket_medio_pago', coalesce((select avg(total) from pe where status = 'paid'), 0)
    ),
    'envios_por_status', coalesce((
      select jsonb_object_agg(coalesce(x.status, 'sem_status'), x.n)
      from (
        select e.status, count(*) n
        from pe
        join public.ml_envios e on e.ml_shipment_id = pe.ml_shipment_id
        group by e.status
      ) x
    ), '{}'::jsonb),
    'top_produtos_vendidos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'titulo', s.titulo,
        'quantidade_total', s.qtd,
        'valor_total', s.valor
      ) order by s.valor desc)
      from (
        select
          i.titulo,
          sum(i.quantidade) as qtd,
          sum(i.quantidade * i.preco_unitario) as valor
        from pe
        join public.ml_pedidos_itens i on i.ml_pedido_id = pe.id
        where pe.status <> 'cancelled'
        group by i.titulo
        order by sum(i.quantidade * i.preco_unitario) desc
        limit v_limit
      ) s
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_vendas_ml_resumo(text, int, int) from public, anon, authenticated;

comment on function public.dexter_vendas_ml_resumo(text, int, int) is
  'Dexter: vendas no Mercado Livre no período — pedidos por status/valor, envios por status, top produtos vendidos (cap p_limit<=50). Gate: dexter_supplygo_pode (42501 se negado).';
