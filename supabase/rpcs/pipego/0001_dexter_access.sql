-- =============================================================================
-- AgentCore × PipeGo — camada de acesso do Dexter
--
-- Projeto Supabase: xalvwhdkiwuyfrtslxnq
--
-- Princípios (baseline de segurança do projeto):
--  - O Dexter NUNCA roda SQL livre. Só chama estas RPCs read-only.
--  - Autorização REUSA a permissão que já existe no PipeGo: usuarios
--    (ativo/inativo + perfil_sistema) + perfis_sistema (permissoes jsonb por
--    módulo: {"ver","criar","editar","excluir"}) + usuarios.permissoes_overrides
--    (overrides por usuário, mesma granularidade). O merge efetivo (override
--    de uma ação específica vence o valor do perfil) é o MESMO já implementado
--    em public.usuario_permissao_efetiva(user_id, modulo, acao) — reaproveitado
--    diretamente aqui em vez de duplicar a lógica.
--  - Regra de bypass: usuarios.perfil_sistema = 'admin' enxerga tudo (mesmo
--    comportamento de public.is_admin() usado no restante do PipeGo).
--  - A chave de identidade é o EMAIL VERIFICADO vindo do JWT do Dexter
--    (usuarios.email, comparado case-insensitive). Usuário inexistente ou
--    inativo (usuarios.ativo = false) NUNCA tem has_access=true nem passa em
--    nenhum gate, independentemente do que diga perfis_sistema.
--  - SECURITY DEFINER + search_path vazio + tudo schema-qualificado + EXECUTE
--    revogado de public/anon/authenticated (só quem tem privilégio de owner —
--    isto é, o backend do Dexter via service_role/postgres — chama).
--  - Nenhuma RLS foi alterada. Estas RPCs têm gate próprio e não dependem de
--    policies de RLS das tabelas subjacentes.
--  - Toda RPC de dado é agregada/limitada (jsonb, listas com cap de 50 linhas)
--    — não expõe tabelas inteiras.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) Helper interno — dexter_pipego_pode(email, modulo) — a pessoa tem
--    permissão de "ver" nesse módulo agora, no PipeGo? Reaproveita
--    usuario_permissao_efetiva (já existente) para o merge perfil+overrides;
--    aqui só resolve o email -> user_id e aplica o bypass de admin. Não é
--    pensado para ser chamado diretamente pelo Dexter, mas segue o mesmo gate
--    de segurança das demais (EXECUTE revogado de public/anon/authenticated).
-- -----------------------------------------------------------------------------
create or replace function public.dexter_pipego_pode(p_email text, p_modulo text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_perfil text;
  v_ativo boolean;
begin
  select u.id, u.perfil_sistema, coalesce(u.ativo, true)
    into v_user_id, v_perfil, v_ativo
  from public.usuarios u
  where lower(u.email) = lower(p_email)
  limit 1;

  if v_user_id is null or not v_ativo then
    return false;
  end if;

  if v_perfil = 'admin' then
    return true;
  end if;

  return coalesce(public.usuario_permissao_efetiva(v_user_id, p_modulo, 'ver'), false);
end;
$$;

revoke all on function public.dexter_pipego_pode(text, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 1) dexter_whoami(email) — quem é essa pessoa no PipeGo e o que ela enxerga.
--    has_access=false se não existir usuarios com esse email ou se estiver
--    inativo. "permissions" é o merge efetivo perfis_sistema.permissoes +
--    usuarios.permissoes_overrides (mesma regra usada por
--    usuario_permissao_efetiva: override de uma ação específica vence o valor
--    do perfil; módulos que só existem no override também aparecem).
-- -----------------------------------------------------------------------------
create or replace function public.dexter_whoami(p_email text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with perfil as (
    select
      u.id as user_id,
      u.nome,
      u.email,
      u.cargo,
      coalesce(u.ativo, true) as ativo,
      u.perfil_sistema,
      coalesce(u.permissoes_overrides, '{}'::jsonb) as permissoes_overrides,
      ps.label as perfil_label,
      coalesce(ps.permissoes, '{}'::jsonb) as perfil_permissoes,
      coalesce(ps.ativo, true) as perfil_ativo
    from public.usuarios u
    left join public.perfis_sistema ps on ps.codigo = u.perfil_sistema
    where lower(u.email) = lower(p_email)
    limit 1
  ),
  mod_keys as (
    select modulo from perfil, jsonb_object_keys(perfil.perfil_permissoes) as modulo
    union
    select modulo from perfil, jsonb_object_keys(perfil.permissoes_overrides) as modulo
  ),
  permissoes_efetivas as (
    select coalesce(
      jsonb_object_agg(
        mk.modulo,
        coalesce(p.perfil_permissoes -> mk.modulo, '{}'::jsonb)
          || coalesce(p.permissoes_overrides -> mk.modulo, '{}'::jsonb)
      ),
      '{}'::jsonb
    ) as permissoes
    from mod_keys mk, perfil p
  )
  select
    case
      when perfil.user_id is null or perfil.ativo = false then
        jsonb_build_object('has_access', false)
      else
        jsonb_build_object(
          'has_access', true,
          'user_id', perfil.user_id,
          'email', perfil.email,
          'full_name', perfil.nome,
          'cargo', perfil.cargo,
          'role', perfil.perfil_sistema,
          'role_label', perfil.perfil_label,
          'is_admin', (perfil.perfil_sistema = 'admin'),
          'permissions', (select permissoes from permissoes_efetivas)
        )
    end
  from perfil
  union all
  select jsonb_build_object('has_access', false)
  where not exists (select 1 from perfil)
  limit 1;
$$;

revoke all on function public.dexter_whoami(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2) dexter_pipego_contas_receber_resumo(email, dias, status) — contas a
--    receber OMIE (omie_contas_receber) + IUGU (iugu_contas_receber),
--    agregado por mês de vencimento/origem/status, mais os títulos OMIE em
--    aberto já vencidos (cap 50). Gate: módulo 'financeiro'.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_pipego_contas_receber_resumo(
  p_email text,
  p_dias int default 90,
  p_status text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not coalesce(public.dexter_pipego_pode(p_email, 'financeiro'), false) then
    raise exception 'sem_acesso: % nao tem acesso a Financeiro/Contas a Receber no PipeGo', p_email
      using errcode = '42501';
  end if;

  with base_omie as (
    select *
    from public.omie_contas_receber o
    where o.data_vencimento >= current_date - make_interval(days => p_dias)
      and (p_status is null or o.status_titulo ilike p_status)
  ),
  omie_agg as (
    select
      origem,
      status_titulo,
      date_trunc('month', data_vencimento) as mes,
      count(*) as qtd,
      coalesce(sum(valor_documento), 0) as valor_documento,
      coalesce(sum(valor_pago), 0) as valor_pago,
      coalesce(sum(valor_aberto), 0) as valor_aberto
    from base_omie
    group by origem, status_titulo, date_trunc('month', data_vencimento)
  ),
  base_iugu as (
    select *
    from public.iugu_contas_receber i
    where i.data_vencimento >= current_date - make_interval(days => p_dias)
      and (p_status is null or i.status ilike p_status)
  ),
  iugu_agg as (
    select
      status,
      date_trunc('month', data_vencimento) as mes,
      count(*) as qtd,
      coalesce(sum(valor), 0) as valor
    from base_iugu
    group by status, date_trunc('month', data_vencimento)
  ),
  vencidos as (
    select
      id_unico_titulo,
      numero_documento,
      id_unico_cliente,
      valor_aberto,
      data_vencimento,
      (current_date - data_vencimento) as dias_atraso
    from public.omie_contas_receber
    where valor_aberto > 0
      and data_vencimento < current_date
    order by data_vencimento asc
    limit 50
  )
  select jsonb_build_object(
    'periodo_dias', p_dias,
    'status_filtro', p_status,
    'omie_total_titulos', (select coalesce(sum(qtd), 0) from omie_agg),
    'omie_valor_documento_total', (select coalesce(sum(valor_documento), 0) from omie_agg),
    'omie_valor_pago_total', (select coalesce(sum(valor_pago), 0) from omie_agg),
    'omie_valor_aberto_total', (select coalesce(sum(valor_aberto), 0) from omie_agg),
    'omie_por_mes_origem_status', coalesce((
      select jsonb_agg(jsonb_build_object(
        'mes', to_char(mes, 'YYYY-MM'),
        'origem', origem,
        'status', status_titulo,
        'qtd', qtd,
        'valor_documento', valor_documento,
        'valor_pago', valor_pago,
        'valor_aberto', valor_aberto
      ) order by mes, origem, status_titulo)
      from omie_agg
    ), '[]'::jsonb),
    'iugu_total_titulos', (select coalesce(sum(qtd), 0) from iugu_agg),
    'iugu_valor_total', (select coalesce(sum(valor), 0) from iugu_agg),
    'iugu_por_mes_status', coalesce((
      select jsonb_agg(jsonb_build_object(
        'mes', to_char(mes, 'YYYY-MM'),
        'status', status,
        'qtd', qtd,
        'valor', valor
      ) order by mes, status)
      from iugu_agg
    ), '[]'::jsonb),
    'omie_vencidos_em_aberto', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id_unico_titulo', id_unico_titulo,
        'numero_documento', numero_documento,
        'id_unico_cliente', id_unico_cliente,
        'valor_aberto', valor_aberto,
        'data_vencimento', data_vencimento,
        'dias_atraso', dias_atraso
      ) order by data_vencimento asc)
      from vencidos
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_pipego_contas_receber_resumo(text, int, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3) dexter_pipego_pendencias_resumo(email, estagio, incluir_excluidos) —
--    pipeline de cobrança/pendências (pendencias_pipeline): total por estágio
--    + fila de atuação (cap 50, ordenada por próximo contato). Por padrão
--    exclui quem já saiu da fila (excluido_cobranca = true); p_incluir_excluidos
--    força ver tudo. Gate: módulo 'pendencias'.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_pipego_pendencias_resumo(
  p_email text,
  p_estagio text default null,
  p_incluir_excluidos boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not coalesce(public.dexter_pipego_pode(p_email, 'pendencias'), false) then
    raise exception 'sem_acesso: % nao tem acesso a Pendencias/Cobranca no PipeGo', p_email
      using errcode = '42501';
  end if;

  with base as (
    select *
    from public.pendencias_pipeline p
    where (p_incluir_excluidos or coalesce(p.excluido_cobranca, false) = false)
      and (p_estagio is null or p.estagio ilike p_estagio)
  ),
  por_estagio as (
    select coalesce(estagio, 'sem_estagio') as estagio, count(*) as qtd
    from base
    group by coalesce(estagio, 'sem_estagio')
  ),
  lista as (
    select
      cliente_documento,
      estagio,
      observacao,
      data_ultimo_contato,
      responsavel_nome,
      contato_telefone,
      contato_email,
      proximo_contato_em,
      proximo_passo,
      promessa_valor,
      promessa_em,
      excluido_cobranca,
      excluido_motivo
    from base
    order by proximo_contato_em asc nulls last, data_ultimo_contato desc nulls last
    limit 50
  )
  select jsonb_build_object(
    'estagio_filtro', p_estagio,
    'incluir_excluidos', p_incluir_excluidos,
    'total', (select count(*) from base),
    'por_estagio', coalesce((select jsonb_object_agg(estagio, qtd) from por_estagio), '{}'::jsonb),
    'pendencias', coalesce((
      select jsonb_agg(jsonb_build_object(
        'cliente_documento', cliente_documento,
        'estagio', estagio,
        'observacao', observacao,
        'data_ultimo_contato', data_ultimo_contato,
        'responsavel_nome', responsavel_nome,
        'contato_telefone', contato_telefone,
        'contato_email', contato_email,
        'proximo_contato_em', proximo_contato_em,
        'proximo_passo', proximo_passo,
        'promessa_valor', promessa_valor,
        'promessa_em', promessa_em,
        'excluido_cobranca', excluido_cobranca,
        'excluido_motivo', excluido_motivo
      ) order by proximo_contato_em asc nulls last)
      from lista
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_pipego_pendencias_resumo(text, text, boolean) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4) dexter_pipego_jornadas_resumo(email, tipo_jornada, dias) — jornadas
--    (jornadas + jornada_status), ativas (inativo = false), tocadas
--    (created_at ou updated_at) nos últimos p_dias. Agregado por
--    tipo_jornada + status, mais lista (cap 50) das mais recentes. Gate:
--    módulo 'jornadas'.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_pipego_jornadas_resumo(
  p_email text,
  p_tipo_jornada text default null,
  p_dias int default 180
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not coalesce(public.dexter_pipego_pode(p_email, 'jornadas'), false) then
    raise exception 'sem_acesso: % nao tem acesso a Jornadas no PipeGo', p_email
      using errcode = '42501';
  end if;

  with base as (
    select
      j.*,
      js.nome as status_nome,
      js.tipo as status_tipo,
      js.cor as status_cor
    from public.jornadas j
    left join public.jornada_status js on js.id = j.status_id
    where coalesce(j.inativo, false) = false
      and (p_tipo_jornada is null or j.tipo_jornada = p_tipo_jornada)
      and (
        j.created_at >= now() - make_interval(days => p_dias)
        or j.updated_at >= now() - make_interval(days => p_dias)
      )
  ),
  por_tipo_status as (
    select tipo_jornada, coalesce(status_nome, 'sem_status') as status_nome, count(*) as qtd
    from base
    group by tipo_jornada, coalesce(status_nome, 'sem_status')
  ),
  lista as (
    select
      titulo,
      cliente_documento,
      tipo_jornada,
      status_nome,
      status_cor,
      contato_principal_nome,
      contato_principal_email,
      prioridade,
      data_checkin_previsto,
      data_checkin_realizado,
      created_at,
      updated_at
    from base
    order by updated_at desc nulls last, created_at desc nulls last
    limit 50
  )
  select jsonb_build_object(
    'periodo_dias', p_dias,
    'tipo_jornada_filtro', p_tipo_jornada,
    'total', (select count(*) from base),
    'por_tipo_status', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tipo_jornada', tipo_jornada,
        'status', status_nome,
        'qtd', qtd
      ) order by tipo_jornada, status_nome)
      from por_tipo_status
    ), '[]'::jsonb),
    'jornadas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'titulo', titulo,
        'cliente_documento', cliente_documento,
        'tipo_jornada', tipo_jornada,
        'status', status_nome,
        'status_cor', status_cor,
        'contato_principal_nome', contato_principal_nome,
        'contato_principal_email', contato_principal_email,
        'prioridade', prioridade,
        'data_checkin_previsto', data_checkin_previsto,
        'data_checkin_realizado', data_checkin_realizado,
        'atualizado_em', updated_at
      ) order by updated_at desc nulls last)
      from lista
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_pipego_jornadas_resumo(text, text, int) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5) dexter_pipego_clientes_busca(email, busca, limit) — busca em
--    cliente_unico por nome/documento/email/codigo (ilike). Sem p_busca,
--    devolve os primeiros N por ordem alfabética. Limite sempre capado em 50.
--    Gate: módulo 'clientes'.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_pipego_clientes_busca(
  p_email text,
  p_busca text default null,
  p_limit int default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_limit int;
begin
  if not coalesce(public.dexter_pipego_pode(p_email, 'clientes'), false) then
    raise exception 'sem_acesso: % nao tem acesso a Clientes no PipeGo', p_email
      using errcode = '42501';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 20), 1), 50);

  with base as (
    select id, nome, email, telefone, documento, codigo
    from public.cliente_unico c
    where p_busca is null
       or c.nome ilike '%' || p_busca || '%'
       or c.documento ilike '%' || p_busca || '%'
       or c.email ilike '%' || p_busca || '%'
       or c.codigo ilike '%' || p_busca || '%'
    order by c.nome asc nulls last
    limit v_limit
  )
  select jsonb_build_object(
    'busca', p_busca,
    'limit', v_limit,
    'total_retornado', (select count(*) from base),
    'clientes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'nome', nome,
        'email', email,
        'telefone', telefone,
        'documento', documento,
        'codigo', codigo
      ) order by nome asc nulls last)
      from base
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_pipego_clientes_busca(text, text, int) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6) dexter_pipego_obras_resumo(email, status, incluir_inativas) — obras
--    (kanban de obras), agregado por status + contagem de atrasadas, mais
--    lista (cap 50, atrasadas primeiro). Por padrão exclui obras marcadas
--    inativa = true. Gate: módulo 'obras'.
-- -----------------------------------------------------------------------------
create or replace function public.dexter_pipego_obras_resumo(
  p_email text,
  p_status text default null,
  p_incluir_inativas boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not coalesce(public.dexter_pipego_pode(p_email, 'obras'), false) then
    raise exception 'sem_acesso: % nao tem acesso a Obras no PipeGo', p_email
      using errcode = '42501';
  end if;

  with base as (
    select
      o.*,
      os.nome as status_obra_nome
    from public.obras o
    left join public.obras_status os on os.id = o.status_obra
    where (p_incluir_inativas or coalesce(o.inativa, false) = false)
      and (p_status is null or o.status::text = p_status)
  ),
  por_status as (
    select
      status::text as status_enum,
      coalesce(status_obra_nome, 'sem_status') as status_obra_nome,
      count(*) as qtd,
      count(*) filter (where coalesce(atrasada, false)) as qtd_atrasadas
    from base
    group by status::text, coalesce(status_obra_nome, 'sem_status')
  ),
  lista as (
    select
      nome_obra,
      cliente_nome,
      unidade,
      andar,
      status::text as status_enum,
      status_obra_nome,
      atrasada,
      data_termino_estimada,
      data_termino_real,
      gestor_nome,
      gestor_nome_2
    from base
    order by coalesce(atrasada, false) desc, data_termino_estimada asc nulls last
    limit 50
  )
  select jsonb_build_object(
    'status_filtro', p_status,
    'incluir_inativas', p_incluir_inativas,
    'total', (select count(*) from base),
    'total_atrasadas', (select count(*) from base where coalesce(atrasada, false)),
    'por_status', coalesce((
      select jsonb_agg(jsonb_build_object(
        'status', status_enum,
        'status_label', status_obra_nome,
        'qtd', qtd,
        'qtd_atrasadas', qtd_atrasadas
      ) order by status_enum)
      from por_status
    ), '[]'::jsonb),
    'obras', coalesce((
      select jsonb_agg(jsonb_build_object(
        'nome_obra', nome_obra,
        'cliente_nome', cliente_nome,
        'unidade', unidade,
        'andar', andar,
        'status', status_enum,
        'status_label', status_obra_nome,
        'atrasada', atrasada,
        'data_termino_estimada', data_termino_estimada,
        'data_termino_real', data_termino_real,
        'gestor_nome', gestor_nome,
        'gestor_nome_2', gestor_nome_2
      ) order by coalesce(atrasada, false) desc, data_termino_estimada asc nulls last)
      from lista
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_pipego_obras_resumo(text, text, boolean) from public, anon, authenticated;
