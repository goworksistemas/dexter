-- ============================================================================
-- Dexter access layer for CheckGo (project zkfcqolkawmpxdyoxvjk)
-- ============================================================================
-- Dexter is an internal read-only assistant. It has no Supabase Auth session
-- (no auth.uid()), so every RPC receives the caller's e-mail explicitly as
-- p_email and resolves it against public.profiles to reuse CheckGo's existing
-- permission model (role: dev/admin = staff/full access, user = scoped by
-- departamento_id + unidade_ids, exactly like public.ckl_can_read_formulario
-- already does for authenticated app sessions).
--
-- Access is expected to be called with the service_role key (Dexter has no
-- anon/authenticated session), so every function here explicitly revokes
-- EXECUTE from public/anon/authenticated right after creation; service_role
-- keeps the default EXECUTE grant applied by this project's default
-- privileges (see pg_default_acl for schema public).
--
-- All functions are SECURITY DEFINER + `set search_path = ''` + fully
-- schema-qualified, so they cannot be hijacked via a mutated search_path and
-- run with the privileges needed to read across profiles/ckl_* regardless of
-- row level security policies (RLS on these tables is written for auth.uid(),
-- which is null for Dexter's connection).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Helper: resolve a profile row by e-mail, or raise sem_acesso (42501) if the
-- e-mail has no CheckGo profile at all. Used by every data RPC below (NOT by
-- dexter_whoami, which must answer has_access:false gracefully instead of
-- raising).
-- ----------------------------------------------------------------------------
create or replace function public.dexter_resolve_profile(p_email text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
begin
  select p.*
    into v_profile
  from public.profiles p
  where lower(p.email) = lower(trim(p_email))
  limit 1;

  if not found then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;

  return v_profile;
end;
$$;

revoke all on function public.dexter_resolve_profile(text) from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- Helper: mirrors public.ckl_can_read_formulario(), but takes an already
-- resolved profile row instead of reading it from auth.uid() (Dexter has no
-- auth session). Staff (role in admin/dev) can read every formulario; a
-- regular user is scoped to their departamento_id (or departamentos_ids) and,
-- when the formulario restricts by unidade in metadados->'unidadeIds', to
-- their unidade_ids.
-- ----------------------------------------------------------------------------
create or replace function public.dexter_can_read_formulario(p_profile public.profiles, p_formulario_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_form public.ckl_formularios%rowtype;
  v_dept_ids uuid[];
  v_meta_unidade jsonb;
  v_uid text;
begin
  if p_profile.role in ('admin', 'dev') then
    return true;
  end if;

  select *
    into v_form
  from public.ckl_formularios f
  where f.id = p_formulario_id;

  if not found then
    return false;
  end if;

  if coalesce(cardinality(v_form.departamentos_ids), 0) > 0 then
    v_dept_ids := v_form.departamentos_ids;
  elsif v_form.departamento_id is not null then
    v_dept_ids := array[v_form.departamento_id];
  else
    v_dept_ids := '{}'::uuid[];
  end if;

  if cardinality(v_dept_ids) > 0 then
    if p_profile.departamento_id is null or not (p_profile.departamento_id = any (v_dept_ids)) then
      return false;
    end if;
  end if;

  v_meta_unidade := v_form.metadados -> 'unidadeIds';
  if v_meta_unidade is null or jsonb_typeof(v_meta_unidade) <> 'array' or jsonb_array_length(v_meta_unidade) = 0 then
    return true;
  end if;

  if coalesce(cardinality(p_profile.unidade_ids), 0) = 0 then
    return false;
  end if;

  for v_uid in select jsonb_array_elements_text(v_meta_unidade) loop
    if v_uid::uuid = any (p_profile.unidade_ids) then
      return true;
    end if;
  end loop;

  return false;
end;
$$;

revoke all on function public.dexter_can_read_formulario(public.profiles, uuid) from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- Helper: is a given unidade (by ckl_unidades.nome, matched against
-- ckl_ambientes.unidade text) explicitly in scope for this profile? Staff and
-- users with an empty unidade_ids (== "todas as unidades disponiveis pelo
-- departamento", per the column's own comment) are authorized for any
-- unidade name (departamento scoping is still enforced separately, per
-- formulario, by dexter_can_read_formulario). A user with a non-empty
-- unidade_ids is only authorized for unidades in that list.
-- ----------------------------------------------------------------------------
create or replace function public.dexter_unidade_authorized(p_profile public.profiles, p_unidade text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unidade_id uuid;
begin
  if p_unidade is null then
    return true;
  end if;

  if p_profile.role in ('admin', 'dev') then
    return true;
  end if;

  if coalesce(cardinality(p_profile.unidade_ids), 0) = 0 then
    return true;
  end if;

  select u.id
    into v_unidade_id
  from public.ckl_unidades u
  where lower(u.nome) = lower(trim(p_unidade));

  if v_unidade_id is null then
    return false;
  end if;

  return v_unidade_id = any (p_profile.unidade_ids);
end;
$$;

revoke all on function public.dexter_unidade_authorized(public.profiles, text) from public, anon, authenticated;


-- ============================================================================
-- 1. dexter_whoami: identity + scope lookup. Never raises for an unknown
--    e-mail -- returns {has_access:false} so Dexter can answer gracefully.
-- ============================================================================
create or replace function public.dexter_whoami(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_departamento_nome text;
  v_unidade_nomes text[];
begin
  select p.*
    into v_profile
  from public.profiles p
  where lower(p.email) = lower(trim(p_email))
  limit 1;

  if not found then
    return jsonb_build_object(
      'has_access', false,
      'email', p_email
    );
  end if;

  select d.nome
    into v_departamento_nome
  from public.ckl_departamentos d
  where d.id = v_profile.departamento_id;

  select coalesce(array_agg(u.nome order by u.nome), '{}'::text[])
    into v_unidade_nomes
  from public.ckl_unidades u
  where u.id = any (v_profile.unidade_ids);

  return jsonb_build_object(
    'has_access', true,
    'user_id', v_profile.id,
    'email', v_profile.email,
    'full_name', v_profile.nome,
    'role', v_profile.role,
    'is_staff', v_profile.role in ('admin', 'dev'),
    'departamento_id', v_profile.departamento_id,
    'departamento_nome', v_departamento_nome,
    'unidade_ids', to_jsonb(coalesce(v_profile.unidade_ids, '{}'::uuid[])),
    'unidades', to_jsonb(v_unidade_nomes),
    'permissoes_rotas', to_jsonb(coalesce(v_profile.permissoes_rotas, '{}'::text[]))
  );
end;
$$;

revoke all on function public.dexter_whoami(text) from public, anon, authenticated;


-- ============================================================================
-- 2. dexter_ckl_scores: scores agregados por unidade, com resumo geral.
--    Gate: e-mail precisa ter profile (senao 42501); se p_unidade for
--    informado e estiver fora do escopo do usuario, tambem 42501.
-- ============================================================================
create or replace function public.dexter_ckl_scores(
  p_email text,
  p_data_inicio timestamptz default null,
  p_data_fim timestamptz default null,
  p_unidade text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_is_staff boolean;
  v_result jsonb;
begin
  v_profile := public.dexter_resolve_profile(p_email);
  v_is_staff := v_profile.role in ('admin', 'dev');

  if not public.dexter_unidade_authorized(v_profile, p_unidade) then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;

  with base as (
    select
      s.aplicacao_id,
      s.percentual_final,
      s.status,
      a.aplicado_em,
      amb.unidade
    from public.ckl_scores s
    join public.ckl_aplicacoes a on a.id = s.aplicacao_id
    join public.ckl_ambientes amb on amb.id = a.ambiente_id
    join public.ckl_formularios f on f.id = a.formulario_id
    where (p_data_inicio is null or a.aplicado_em >= p_data_inicio)
      and (p_data_fim is null or a.aplicado_em <= p_data_fim)
      and (p_unidade is null or lower(amb.unidade) = lower(trim(p_unidade)))
      and (v_is_staff or public.dexter_can_read_formulario(v_profile, f.id))
  ),
  por_unidade as (
    select
      unidade,
      count(*) as total_aplicacoes,
      round(avg(percentual_final), 2) as media_percentual_final,
      count(*) filter (where status = 'approved') as aprovadas,
      count(*) filter (where status = 'attention') as atencao,
      count(*) filter (where status = 'rejected') as reprovadas
    from base
    group by unidade
    order by unidade
    limit 50
  )
  select jsonb_build_object(
    'has_access', true,
    'is_staff', v_is_staff,
    'filtros', jsonb_build_object(
      'data_inicio', p_data_inicio,
      'data_fim', p_data_fim,
      'unidade', p_unidade
    ),
    'resumo', (
      select jsonb_build_object(
        'total_aplicacoes', count(*),
        'media_percentual_final', round(avg(percentual_final), 2),
        'aprovadas', count(*) filter (where status = 'approved'),
        'atencao', count(*) filter (where status = 'attention'),
        'reprovadas', count(*) filter (where status = 'rejected')
      )
      from base
    ),
    'por_unidade', coalesce((select jsonb_agg(to_jsonb(por_unidade)) from por_unidade), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_ckl_scores(text, timestamptz, timestamptz, text) from public, anon, authenticated;


-- ============================================================================
-- 3. dexter_ckl_aplicacoes: quantas aplicacoes, por status, com amostra
--    (cap 50) das mais recentes. Gate igual as demais.
-- ============================================================================
create or replace function public.dexter_ckl_aplicacoes(
  p_email text,
  p_status text default null,
  p_data_inicio timestamptz default null,
  p_data_fim timestamptz default null,
  p_unidade text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_is_staff boolean;
  v_result jsonb;
begin
  v_profile := public.dexter_resolve_profile(p_email);
  v_is_staff := v_profile.role in ('admin', 'dev');

  if not public.dexter_unidade_authorized(v_profile, p_unidade) then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;

  with base as (
    select
      a.id,
      a.status,
      a.responsavel,
      a.aplicado_em,
      a.finalizado_em,
      amb.unidade,
      amb.nome as ambiente_nome,
      f.nome as formulario_nome,
      s.percentual_final
    from public.ckl_aplicacoes a
    join public.ckl_ambientes amb on amb.id = a.ambiente_id
    join public.ckl_formularios f on f.id = a.formulario_id
    left join public.ckl_scores s on s.aplicacao_id = a.id
    where (p_data_inicio is null or a.aplicado_em >= p_data_inicio)
      and (p_data_fim is null or a.aplicado_em <= p_data_fim)
      and (p_unidade is null or lower(amb.unidade) = lower(trim(p_unidade)))
      and (p_status is null or a.status = p_status)
      and (v_is_staff or public.dexter_can_read_formulario(v_profile, f.id))
  ),
  amostra as (
    select *
    from base
    order by aplicado_em desc
    limit 50
  )
  select jsonb_build_object(
    'has_access', true,
    'is_staff', v_is_staff,
    'filtros', jsonb_build_object(
      'status', p_status,
      'data_inicio', p_data_inicio,
      'data_fim', p_data_fim,
      'unidade', p_unidade
    ),
    'resumo', (
      select jsonb_build_object(
        'total', count(*),
        'draft', count(*) filter (where status = 'draft'),
        'approved', count(*) filter (where status = 'approved'),
        'attention', count(*) filter (where status = 'attention'),
        'rejected', count(*) filter (where status = 'rejected')
      )
      from base
    ),
    'amostra', coalesce((select jsonb_agg(to_jsonb(amostra)) from amostra), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_ckl_aplicacoes(text, text, timestamptz, timestamptz, text) from public, anon, authenticated;


-- ============================================================================
-- 4. dexter_ckl_reincidencias: eventos de reincidencia agrupados por
--    unidade + tipo (cap 50), com total geral. Gate igual as demais.
-- ============================================================================
create or replace function public.dexter_ckl_reincidencias(
  p_email text,
  p_unidade text default null,
  p_data_inicio timestamptz default null,
  p_data_fim timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_is_staff boolean;
  v_result jsonb;
begin
  v_profile := public.dexter_resolve_profile(p_email);
  v_is_staff := v_profile.role in ('admin', 'dev');

  if not public.dexter_unidade_authorized(v_profile, p_unidade) then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;

  with base as (
    select
      r.id,
      r.tipo,
      r.registrado_em,
      amb.unidade,
      f.nome as formulario_nome,
      pg.enunciado as pergunta_enunciado,
      pg.categoria_problema
    from public.ckl_reincidencias r
    join public.ckl_ambientes amb on amb.id = r.ambiente_id
    join public.ckl_formularios f on f.id = r.formulario_id
    left join public.ckl_perguntas pg on pg.id = r.pergunta_id
    where (p_data_inicio is null or r.registrado_em >= p_data_inicio)
      and (p_data_fim is null or r.registrado_em <= p_data_fim)
      and (p_unidade is null or lower(amb.unidade) = lower(trim(p_unidade)))
      and (v_is_staff or public.dexter_can_read_formulario(v_profile, f.id))
  ),
  por_unidade_tipo as (
    select
      unidade,
      tipo,
      count(*) as total,
      max(registrado_em) as ultima_ocorrencia
    from base
    group by unidade, tipo
    order by total desc
    limit 50
  )
  select jsonb_build_object(
    'has_access', true,
    'is_staff', v_is_staff,
    'filtros', jsonb_build_object(
      'unidade', p_unidade,
      'data_inicio', p_data_inicio,
      'data_fim', p_data_fim
    ),
    'resumo', jsonb_build_object('total_eventos', (select count(*) from base)),
    'por_unidade_tipo', coalesce((select jsonb_agg(to_jsonb(por_unidade_tipo)) from por_unidade_tipo), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_ckl_reincidencias(text, text, timestamptz, timestamptz) from public, anon, authenticated;


-- ============================================================================
-- 5. dexter_ckl_ranking: ranking de conformidade por unidade (media do
--    percentual_final, desc), cap configuravel (default 20, teto 50).
-- ============================================================================
create or replace function public.dexter_ckl_ranking(
  p_email text,
  p_data_inicio timestamptz default null,
  p_data_fim timestamptz default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_is_staff boolean;
  v_limit integer;
  v_result jsonb;
begin
  v_profile := public.dexter_resolve_profile(p_email);
  v_is_staff := v_profile.role in ('admin', 'dev');
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 50);

  with base as (
    select
      amb.unidade,
      s.percentual_final,
      s.status
    from public.ckl_scores s
    join public.ckl_aplicacoes a on a.id = s.aplicacao_id
    join public.ckl_ambientes amb on amb.id = a.ambiente_id
    join public.ckl_formularios f on f.id = a.formulario_id
    where (p_data_inicio is null or a.aplicado_em >= p_data_inicio)
      and (p_data_fim is null or a.aplicado_em <= p_data_fim)
      and (v_is_staff or public.dexter_can_read_formulario(v_profile, f.id))
  ),
  ranking as (
    select
      unidade,
      count(*) as total_aplicacoes,
      round(avg(percentual_final), 2) as media_percentual_final,
      count(*) filter (where status = 'rejected') as reprovadas
    from base
    group by unidade
    order by media_percentual_final desc nulls last
    limit v_limit
  )
  select jsonb_build_object(
    'has_access', true,
    'is_staff', v_is_staff,
    'filtros', jsonb_build_object(
      'data_inicio', p_data_inicio,
      'data_fim', p_data_fim,
      'limit', v_limit
    ),
    'ranking', coalesce((select jsonb_agg(to_jsonb(ranking)) from ranking), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_ckl_ranking(text, timestamptz, timestamptz, integer) from public, anon, authenticated;


-- ============================================================================
-- Modular filter layer (migration dexter_checkgo_modular +
-- dexter_checkgo_modular_fix_dimensoes_scope) -- adds combinable filters on
-- top of the fixed summaries above. Reuses the same gate/scope helpers:
-- dexter_resolve_profile, dexter_can_read_formulario,
-- dexter_unidade_authorized.
-- ============================================================================


-- ============================================================================
-- 6. dexter_ckl_aplicacoes_busca: aplicacoes com filtro combinavel por
--    unidade/formulario (ilike parcial)/status/periodo, paginado (cap 200).
--    Gate + escopo iguais as demais (dept via formulario, unidade explicita
--    via dexter_unidade_authorized).
-- ============================================================================
create or replace function public.dexter_ckl_aplicacoes_busca(
  p_email text,
  p_unidade text default null,
  p_formulario text default null,
  p_status text default null,
  p_data_ini timestamptz default null,
  p_data_fim timestamptz default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_is_staff boolean;
  v_limit integer;
  v_result jsonb;
begin
  v_profile := public.dexter_resolve_profile(p_email);
  v_is_staff := v_profile.role in ('admin', 'dev');
  v_limit := least(greatest(coalesce(p_limit, 50), 1), 200);

  if not public.dexter_unidade_authorized(v_profile, p_unidade) then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;

  with base as (
    select
      a.id,
      a.status,
      a.responsavel,
      a.aplicado_em,
      a.finalizado_em,
      amb.unidade,
      amb.nome as ambiente_nome,
      f.nome as formulario_nome,
      s.percentual_final
    from public.ckl_aplicacoes a
    join public.ckl_ambientes amb on amb.id = a.ambiente_id
    join public.ckl_formularios f on f.id = a.formulario_id
    left join public.ckl_scores s on s.aplicacao_id = a.id
    where (p_data_ini is null or a.aplicado_em >= p_data_ini)
      and (p_data_fim is null or a.aplicado_em <= p_data_fim)
      and (p_unidade is null or lower(amb.unidade) = lower(trim(p_unidade)))
      and (p_formulario is null or f.nome ilike '%' || trim(p_formulario) || '%')
      and (p_status is null or a.status = p_status)
      and (v_is_staff or public.dexter_can_read_formulario(v_profile, f.id))
  ),
  pagina as (
    select *
    from base
    order by aplicado_em desc
    limit v_limit
  )
  select jsonb_build_object(
    'has_access', true,
    'is_staff', v_is_staff,
    'filtros', jsonb_build_object(
      'unidade', p_unidade,
      'formulario', p_formulario,
      'status', p_status,
      'data_ini', p_data_ini,
      'data_fim', p_data_fim,
      'limit', v_limit
    ),
    'total', (select count(*) from base),
    'lista', coalesce((select jsonb_agg(to_jsonb(pagina)) from pagina), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_ckl_aplicacoes_busca(text, text, text, text, timestamptz, timestamptz, integer) from public, anon, authenticated;


-- ============================================================================
-- 7. dexter_ckl_scores_busca: mesma agregacao de dexter_ckl_scores, mas com
--    filtro adicional por formulario (ilike parcial) e quebra tambem por
--    formulario, alem de por unidade. Criada como funcao nova (nao substitui
--    dexter_ckl_scores) para nao alterar a assinatura ja em uso.
-- ============================================================================
create or replace function public.dexter_ckl_scores_busca(
  p_email text,
  p_unidade text default null,
  p_formulario text default null,
  p_data_ini timestamptz default null,
  p_data_fim timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_is_staff boolean;
  v_result jsonb;
begin
  v_profile := public.dexter_resolve_profile(p_email);
  v_is_staff := v_profile.role in ('admin', 'dev');

  if not public.dexter_unidade_authorized(v_profile, p_unidade) then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;

  with base as (
    select
      s.aplicacao_id,
      s.percentual_final,
      s.status,
      a.aplicado_em,
      amb.unidade,
      f.nome as formulario_nome
    from public.ckl_scores s
    join public.ckl_aplicacoes a on a.id = s.aplicacao_id
    join public.ckl_ambientes amb on amb.id = a.ambiente_id
    join public.ckl_formularios f on f.id = a.formulario_id
    where (p_data_ini is null or a.aplicado_em >= p_data_ini)
      and (p_data_fim is null or a.aplicado_em <= p_data_fim)
      and (p_unidade is null or lower(amb.unidade) = lower(trim(p_unidade)))
      and (p_formulario is null or f.nome ilike '%' || trim(p_formulario) || '%')
      and (v_is_staff or public.dexter_can_read_formulario(v_profile, f.id))
  ),
  por_unidade as (
    select
      unidade,
      count(*) as total_aplicacoes,
      round(avg(percentual_final), 2) as media_percentual_final,
      count(*) filter (where status = 'approved') as aprovadas,
      count(*) filter (where status = 'attention') as atencao,
      count(*) filter (where status = 'rejected') as reprovadas
    from base
    group by unidade
    order by unidade
    limit 50
  ),
  por_formulario as (
    select
      formulario_nome,
      count(*) as total_aplicacoes,
      round(avg(percentual_final), 2) as media_percentual_final,
      count(*) filter (where status = 'approved') as aprovadas,
      count(*) filter (where status = 'attention') as atencao,
      count(*) filter (where status = 'rejected') as reprovadas
    from base
    group by formulario_nome
    order by formulario_nome
    limit 50
  )
  select jsonb_build_object(
    'has_access', true,
    'is_staff', v_is_staff,
    'filtros', jsonb_build_object(
      'unidade', p_unidade,
      'formulario', p_formulario,
      'data_ini', p_data_ini,
      'data_fim', p_data_fim
    ),
    'resumo', (
      select jsonb_build_object(
        'total_aplicacoes', count(*),
        'media_percentual_final', round(avg(percentual_final), 2),
        'aprovadas', count(*) filter (where status = 'approved'),
        'atencao', count(*) filter (where status = 'attention'),
        'reprovadas', count(*) filter (where status = 'rejected')
      )
      from base
    ),
    'por_unidade', coalesce((select jsonb_agg(to_jsonb(por_unidade)) from por_unidade), '[]'::jsonb),
    'por_formulario', coalesce((select jsonb_agg(to_jsonb(por_formulario)) from por_formulario), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_ckl_scores_busca(text, text, text, timestamptz, timestamptz) from public, anon, authenticated;


-- ============================================================================
-- 8. dexter_dimensoes: valores distintos disponiveis para popular filtros no
--    escopo do usuario (unidades / formularios / ambientes /
--    status_aplicacao). Staff enxerga o universo completo (ckl_unidades /
--    ckl_ambientes); usuario comum so enxerga o que e alcancavel pelos
--    formularios do seu departamento (dexter_can_read_formulario) e, quando
--    tem unidade_ids explicito, apenas essas unidades
--    (dexter_unidade_authorized). Importante: unidades/ambientes NAO sao
--    filtrados via ckl_formularios.ambiente_id -- esse campo e apenas a
--    referencia/default do formulario, nao uma restricao de dominio (um
--    formulario sem metadados->'unidadeIds' aplica-se a qualquer unidade,
--    exatamente como dexter_ckl_scores_busca/aplicacoes_busca ja retornam
--    dados de qualquer unidade uma vez que dexter_can_read_formulario e
--    verdadeiro). Gate: e-mail sem profile -> 42501.
-- ============================================================================
create or replace function public.dexter_dimensoes(p_email text, p_dimensao text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_is_staff boolean;
  v_dim text;
  v_valores jsonb;
begin
  v_profile := public.dexter_resolve_profile(p_email);
  v_is_staff := v_profile.role in ('admin', 'dev');
  v_dim := lower(trim(p_dimensao));

  if v_dim not in ('unidades', 'formularios', 'ambientes', 'status_aplicacao') then
    raise exception 'dimensao_invalida: use unidades, formularios, ambientes ou status_aplicacao' using errcode = '22023';
  end if;

  if v_dim = 'unidades' then
    if v_is_staff then
      select coalesce(jsonb_agg(distinct u.nome order by u.nome), '[]'::jsonb)
        into v_valores
      from public.ckl_unidades u;
    else
      select coalesce(jsonb_agg(distinct u.nome order by u.nome), '[]'::jsonb)
        into v_valores
      from public.ckl_unidades u
      where public.dexter_unidade_authorized(v_profile, u.nome)
        and exists (
          select 1
          from public.ckl_formularios f
          where f.ativo and public.dexter_can_read_formulario(v_profile, f.id)
        );
    end if;

  elsif v_dim = 'formularios' then
    select coalesce(jsonb_agg(distinct f.nome order by f.nome), '[]'::jsonb)
      into v_valores
    from public.ckl_formularios f
    where f.ativo
      and (v_is_staff or public.dexter_can_read_formulario(v_profile, f.id));

  elsif v_dim = 'ambientes' then
    if v_is_staff then
      select coalesce(jsonb_agg(distinct amb.nome order by amb.nome), '[]'::jsonb)
        into v_valores
      from public.ckl_ambientes amb;
    else
      select coalesce(jsonb_agg(distinct amb.nome order by amb.nome), '[]'::jsonb)
        into v_valores
      from public.ckl_ambientes amb
      where public.dexter_unidade_authorized(v_profile, amb.unidade)
        and exists (
          select 1
          from public.ckl_formularios f
          where f.ativo and public.dexter_can_read_formulario(v_profile, f.id)
        );
    end if;

  elsif v_dim = 'status_aplicacao' then
    select coalesce(jsonb_agg(distinct a.status order by a.status), '[]'::jsonb)
      into v_valores
    from public.ckl_aplicacoes a
    join public.ckl_ambientes amb on amb.id = a.ambiente_id
    join public.ckl_formularios f on f.id = a.formulario_id
    where a.status is not null
      and (v_is_staff or public.dexter_can_read_formulario(v_profile, f.id))
      and public.dexter_unidade_authorized(v_profile, amb.unidade);
  end if;

  return jsonb_build_object(
    'has_access', true,
    'is_staff', v_is_staff,
    'dimensao', v_dim,
    'valores', v_valores
  );
end;
$$;

revoke all on function public.dexter_dimensoes(text, text) from public, anon, authenticated;
