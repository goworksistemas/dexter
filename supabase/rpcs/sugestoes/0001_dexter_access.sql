-- =====================================================================
-- Dexter access layer — Sugestões e Melhorias
-- project: iwtieifwvhmnbdhamvtx
--
-- Domínio: caixa de sugestões/melhorias multi-tenant. Cada "sistema"
-- (sistemas.slug: gowork, networkgo, pipego, ...) é um produto interno
-- da GoWork. Usuários (profiles) pertencem a um sistema; profiles.email
-- é a chave de identidade usada pelo Dexter (não há auth.users — o app
-- usa JWT próprio com claims sistema_id/is_admin lidos via
-- jwt_sistema_id()/jwt_is_admin() nas policies de RLS existentes).
--
-- Um mesmo email pode ter um profile em CADA sistema, com is_admin
-- independente por sistema (ex.: bpm@gowork.com.br é admin em "gowork"
-- mas não em "networkgo"/"pipego"). Portanto o gate do Dexter precisa
-- ser calculado por sistema, não globalmente.
--
-- Modelo de permissão usado:
--   - has_access (whoami)   = existe ao menos 1 profile com is_admin=true
--   - escopo dos dados      = apenas sistemas onde o email é is_admin=true
--   - fora do escopo        = raise exception 'sem_acesso' (42501)
--
-- Todas as funções: SECURITY DEFINER, SET search_path='', schema-qualificadas,
-- REVOKE ALL FROM public, anon, authenticated (execução restrita ao owner /
-- service_role usado pelo Dexter).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper interno: ids dos sistemas em que o email é admin.
-- Não é pensado para uso direto por humanos; usado pelas RPCs abaixo.
-- ---------------------------------------------------------------------
create or replace function public.dexter_admin_sistema_ids(p_email text)
returns uuid[]
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce(array_agg(p.sistema_id), array[]::uuid[])
  from public.profiles p
  where lower(p.email) = lower(trim(p_email))
    and p.is_admin = true;
$$;

revoke all on function public.dexter_admin_sistema_ids(text) from public, anon, authenticated;

comment on function public.dexter_admin_sistema_ids(text) is
  'Dexter (interno): retorna os sistema_id em que o email informado é is_admin=true. Usado como gate pelas demais funções dexter_*.';


-- ---------------------------------------------------------------------
-- 1) dexter_whoami(p_email) -> jsonb
--    Identidade + acesso do email em todos os sistemas onde tem profile.
--    has_access = true se for is_admin em pelo menos um sistema.
-- ---------------------------------------------------------------------
create or replace function public.dexter_whoami(p_email text)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_result jsonb;
begin
  if v_email = '' then
    return jsonb_build_object(
      'email', p_email,
      'has_access', false,
      'motivo', 'email_vazio',
      'perfis', '[]'::jsonb
    );
  end if;

  select jsonb_build_object(
    'email', v_email,
    'has_access', coalesce(bool_or(p.is_admin), false),
    'perfis', coalesce(
      jsonb_agg(
        jsonb_build_object(
          'sistema_slug', s.slug,
          'sistema_nome', s.nome,
          'nome', p.nome,
          'is_admin', p.is_admin,
          'empresa', p.empresa
        )
        order by s.slug
      ) filter (where p.id is not null),
      '[]'::jsonb
    )
  )
  into v_result
  from public.profiles p
  join public.sistemas s on s.id = p.sistema_id
  where lower(p.email) = v_email;

  return coalesce(v_result, jsonb_build_object(
    'email', v_email,
    'has_access', false,
    'perfis', '[]'::jsonb
  ));
end;
$$;

revoke all on function public.dexter_whoami(text) from public, anon, authenticated;

comment on function public.dexter_whoami(text) is
  'Dexter: identidade do email nas Sugestões e Melhorias. has_access=true se is_admin=true em ao menos 1 sistema; perfis lista a participação em cada sistema.';


-- ---------------------------------------------------------------------
-- 2) dexter_sugestoes_resumo_status(p_email, p_sistema_slug, p_data_inicio, p_data_fim) -> jsonb
--    Agregados de sugestões (contagem por status/categoria/tipo/impacto)
--    dentro do(s) sistema(s) em que o email é admin, com filtro opcional
--    de sistema e período. Somente agregados — nenhuma linha individual.
-- ---------------------------------------------------------------------
create or replace function public.dexter_sugestoes_resumo_status(
  p_email text,
  p_sistema_slug text default null,
  p_data_inicio timestamptz default null,
  p_data_fim timestamptz default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_admin_ids uuid[] := public.dexter_admin_sistema_ids(p_email);
  v_sistema_id uuid;
  v_result jsonb;
begin
  if coalesce(array_length(v_admin_ids, 1), 0) = 0 then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;

  if p_sistema_slug is not null then
    select s.id into v_sistema_id from public.sistemas s where s.slug = p_sistema_slug;

    if v_sistema_id is null or not (v_sistema_id = any(v_admin_ids)) then
      raise exception 'sem_acesso' using errcode = '42501';
    end if;
  end if;

  with escopo as (
    select su.*, s.slug as sistema_slug
    from public.sugestoes su
    join public.sistemas s on s.id = su.sistema_id
    where su.sistema_id = any(v_admin_ids)
      and (v_sistema_id is null or su.sistema_id = v_sistema_id)
      and (p_data_inicio is null or su.criado_em >= p_data_inicio)
      and (p_data_fim is null or su.criado_em <= p_data_fim)
  )
  select jsonb_build_object(
    'sistemas_no_escopo', (
      select coalesce(jsonb_agg(distinct s.slug), '[]'::jsonb)
      from public.sistemas s
      where s.id = any(v_admin_ids)
        and (v_sistema_id is null or s.id = v_sistema_id)
    ),
    'periodo', jsonb_build_object('inicio', p_data_inicio, 'fim', p_data_fim),
    'total_sugestoes', (select count(*) from escopo),
    'total_votos', (select coalesce(sum(votos_count), 0) from escopo),
    'total_comentarios', (select coalesce(sum(comentarios_count), 0) from escopo),
    'por_status', (
      select coalesce(jsonb_agg(jsonb_build_object('status_interno', status_interno, 'quantidade', qtd) order by qtd desc), '[]'::jsonb)
      from (select status_interno, count(*) as qtd from escopo group by status_interno) x
    ),
    'por_categoria', (
      select coalesce(jsonb_agg(jsonb_build_object('categoria', categoria, 'quantidade', qtd) order by qtd desc), '[]'::jsonb)
      from (select categoria, count(*) as qtd from escopo group by categoria) x
    ),
    'por_tipo', (
      select coalesce(jsonb_agg(jsonb_build_object('tipo', tipo, 'quantidade', qtd) order by qtd desc), '[]'::jsonb)
      from (select tipo, count(*) as qtd from escopo where tipo is not null group by tipo) x
    ),
    'por_impacto', (
      select coalesce(jsonb_agg(jsonb_build_object('impacto', impacto, 'quantidade', qtd) order by qtd desc), '[]'::jsonb)
      from (select impacto, count(*) as qtd from escopo where impacto is not null group by impacto) x
    )
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.dexter_sugestoes_resumo_status(text, text, timestamptz, timestamptz) from public, anon, authenticated;

comment on function public.dexter_sugestoes_resumo_status(text, text, timestamptz, timestamptz) is
  'Dexter: agregados (contagens) de sugestões por status/categoria/tipo/impacto, escopados aos sistemas em que o email é admin. Gate: sem_acesso (42501) se o email não é admin em nenhum sistema, ou se pedir um sistema fora do seu escopo.';


-- ---------------------------------------------------------------------
-- 3) dexter_sugestoes_top(p_email, p_sistema_slug, p_status, p_limit) -> jsonb
--    Lista (não agregada, mas enxuta e sem campos sensíveis internos)
--    das sugestões mais votadas, escopada aos sistemas em que o email é
--    admin. Não expõe notas_internas / anexo_url / link_chamados / dependencias.
-- ---------------------------------------------------------------------
create or replace function public.dexter_sugestoes_top(
  p_email text,
  p_sistema_slug text default null,
  p_status text default null,
  p_limit int default 20
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_admin_ids uuid[] := public.dexter_admin_sistema_ids(p_email);
  v_sistema_id uuid;
  v_status public.status_interno;
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_result jsonb;
begin
  if coalesce(array_length(v_admin_ids, 1), 0) = 0 then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;

  if p_sistema_slug is not null then
    select s.id into v_sistema_id from public.sistemas s where s.slug = p_sistema_slug;

    if v_sistema_id is null or not (v_sistema_id = any(v_admin_ids)) then
      raise exception 'sem_acesso' using errcode = '42501';
    end if;
  end if;

  if p_status is not null then
    begin
      v_status := p_status::public.status_interno;
    exception when invalid_text_representation then
      raise exception 'status_invalido' using errcode = '22023';
    end;
  end if;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  into v_result
  from (
    select
      s.slug as sistema_slug,
      su.titulo,
      su.categoria,
      su.status_interno,
      su.tipo,
      su.impacto,
      su.esforco_tecnico,
      su.votos_count,
      su.comentarios_count,
      su.criado_em
    from public.sugestoes su
    join public.sistemas s on s.id = su.sistema_id
    where su.sistema_id = any(v_admin_ids)
      and (v_sistema_id is null or su.sistema_id = v_sistema_id)
      and (v_status is null or su.status_interno = v_status)
    order by su.votos_count desc, su.criado_em desc
    limit v_limit
  ) t;

  return v_result;
end;
$$;

revoke all on function public.dexter_sugestoes_top(text, text, text, int) from public, anon, authenticated;

comment on function public.dexter_sugestoes_top(text, text, text, int) is
  'Dexter: lista enxuta das sugestões mais votadas (sem campos internos sensíveis), escopada aos sistemas em que o email é admin. Filtros opcionais por sistema e status. Gate: sem_acesso (42501) se sem admin em nenhum sistema, ou sistema fora do escopo.';


-- ---------------------------------------------------------------------
-- 4) dexter_sugestoes_busca(p_email, p_sistema_slug, p_status, p_categoria,
--    p_tipo, p_impacto, p_texto, p_limit) -> jsonb
--    Camada modular: busca filtrável e enxuta (sem campos internos
--    sensíveis), escopada aos sistemas em que o email é admin.
--    p_texto faz ilike no título. Substitui os resumos fixos por filtros
--    livres combináveis (sistema/status/categoria/tipo/impacto/texto).
-- ---------------------------------------------------------------------
create or replace function public.dexter_sugestoes_busca(
  p_email text,
  p_sistema_slug text default null,
  p_status text default null,
  p_categoria text default null,
  p_tipo text default null,
  p_impacto text default null,
  p_texto text default null,
  p_limit int default 50
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_admin_ids uuid[] := public.dexter_admin_sistema_ids(p_email);
  v_sistema_id uuid;
  v_status public.status_interno;
  v_categoria public.categoria_sugestao;
  v_tipo public.tipo_sugestao;
  v_impacto public.impacto_nivel;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_texto text := nullif(trim(coalesce(p_texto, '')), '');
  v_total bigint;
  v_lista jsonb;
begin
  if coalesce(array_length(v_admin_ids, 1), 0) = 0 then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;

  if p_sistema_slug is not null then
    select s.id into v_sistema_id from public.sistemas s where s.slug = p_sistema_slug;

    if v_sistema_id is null or not (v_sistema_id = any(v_admin_ids)) then
      raise exception 'sem_acesso' using errcode = '42501';
    end if;
  end if;

  if p_status is not null then
    begin
      v_status := p_status::public.status_interno;
    exception when invalid_text_representation then
      raise exception 'status_invalido' using errcode = '22023';
    end;
  end if;

  if p_categoria is not null then
    begin
      v_categoria := p_categoria::public.categoria_sugestao;
    exception when invalid_text_representation then
      raise exception 'categoria_invalida' using errcode = '22023';
    end;
  end if;

  if p_tipo is not null then
    begin
      v_tipo := p_tipo::public.tipo_sugestao;
    exception when invalid_text_representation then
      raise exception 'tipo_invalido' using errcode = '22023';
    end;
  end if;

  if p_impacto is not null then
    begin
      v_impacto := p_impacto::public.impacto_nivel;
    exception when invalid_text_representation then
      raise exception 'impacto_invalido' using errcode = '22023';
    end;
  end if;

  with escopo as (
    select
      su.*,
      s.slug as sistema_slug,
      pr.nome as autor_nome
    from public.sugestoes su
    join public.sistemas s on s.id = su.sistema_id
    left join public.profiles pr on pr.id = su.autor_id
    where su.sistema_id = any(v_admin_ids)
      and (v_sistema_id is null or su.sistema_id = v_sistema_id)
      and (v_status is null or su.status_interno = v_status)
      and (v_categoria is null or su.categoria = v_categoria)
      and (v_tipo is null or su.tipo = v_tipo)
      and (v_impacto is null or su.impacto = v_impacto)
      and (v_texto is null or su.titulo ilike ('%' || v_texto || '%'))
  )
  select count(*) into v_total from escopo;

  with escopo as (
    select
      su.*,
      s.slug as sistema_slug,
      pr.nome as autor_nome
    from public.sugestoes su
    join public.sistemas s on s.id = su.sistema_id
    left join public.profiles pr on pr.id = su.autor_id
    where su.sistema_id = any(v_admin_ids)
      and (v_sistema_id is null or su.sistema_id = v_sistema_id)
      and (v_status is null or su.status_interno = v_status)
      and (v_categoria is null or su.categoria = v_categoria)
      and (v_tipo is null or su.tipo = v_tipo)
      and (v_impacto is null or su.impacto = v_impacto)
      and (v_texto is null or su.titulo ilike ('%' || v_texto || '%'))
    order by su.criado_em desc
    limit v_limit
  )
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  into v_lista
  from (
    select
      sistema_slug,
      titulo,
      descricao,
      categoria,
      status_interno,
      tipo,
      impacto,
      esforco_tecnico,
      votos_count,
      comentarios_count,
      autor_nome,
      criado_em
    from escopo
  ) t;

  return jsonb_build_object(
    'filtros', jsonb_build_object(
      'sistema_slug', p_sistema_slug,
      'status', p_status,
      'categoria', p_categoria,
      'tipo', p_tipo,
      'impacto', p_impacto,
      'texto', v_texto,
      'limit', v_limit
    ),
    'total', v_total,
    'lista', v_lista
  );
end;
$$;

revoke all on function public.dexter_sugestoes_busca(text, text, text, text, text, text, text, int) from public, anon, authenticated;

comment on function public.dexter_sugestoes_busca(text, text, text, text, text, text, text, int) is
  'Dexter: busca filtrável de sugestões (sistema/status/categoria/tipo/impacto/texto no título), sem campos internos sensíveis, escopada aos sistemas em que o email é admin. Retorna total + lista. Gate: sem_acesso (42501) se sem admin em nenhum sistema, ou sistema fora do escopo; *_invalido (22023) se filtro de enum não reconhecido.';


-- ---------------------------------------------------------------------
-- 5) dexter_dimensoes(p_email, p_dimensao) -> jsonb
--    Camada modular: valores distintos (facetas) para montar filtros
--    dinâmicos no cliente do Dexter, apenas dentro dos dados dos
--    sistemas em que o email é admin.
--    p_dimensao in ('sistemas','status','categorias','tipos','impactos','autores').
-- ---------------------------------------------------------------------
create or replace function public.dexter_dimensoes(
  p_email text,
  p_dimensao text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_admin_ids uuid[] := public.dexter_admin_sistema_ids(p_email);
  v_dimensao text := lower(trim(coalesce(p_dimensao, '')));
  v_result jsonb;
begin
  if coalesce(array_length(v_admin_ids, 1), 0) = 0 then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;

  if v_dimensao not in ('sistemas', 'status', 'categorias', 'tipos', 'impactos', 'autores') then
    raise exception 'dimensao_invalida' using errcode = '22023';
  end if;

  if v_dimensao = 'sistemas' then
    select coalesce(jsonb_agg(jsonb_build_object('sistema_slug', s.slug, 'sistema_nome', s.nome) order by s.slug), '[]'::jsonb)
    into v_result
    from public.sistemas s
    where s.id = any(v_admin_ids);

  elsif v_dimensao = 'status' then
    select coalesce(jsonb_agg(jsonb_build_object('valor', x.status_interno, 'quantidade', x.qtd) order by x.qtd desc), '[]'::jsonb)
    into v_result
    from (
      select su.status_interno, count(*) as qtd
      from public.sugestoes su
      where su.sistema_id = any(v_admin_ids)
      group by su.status_interno
    ) x;

  elsif v_dimensao = 'categorias' then
    select coalesce(jsonb_agg(jsonb_build_object('valor', x.categoria, 'quantidade', x.qtd) order by x.qtd desc), '[]'::jsonb)
    into v_result
    from (
      select su.categoria, count(*) as qtd
      from public.sugestoes su
      where su.sistema_id = any(v_admin_ids)
      group by su.categoria
    ) x;

  elsif v_dimensao = 'tipos' then
    select coalesce(jsonb_agg(jsonb_build_object('valor', x.tipo, 'quantidade', x.qtd) order by x.qtd desc), '[]'::jsonb)
    into v_result
    from (
      select su.tipo, count(*) as qtd
      from public.sugestoes su
      where su.sistema_id = any(v_admin_ids)
        and su.tipo is not null
      group by su.tipo
    ) x;

  elsif v_dimensao = 'impactos' then
    select coalesce(jsonb_agg(jsonb_build_object('valor', x.impacto, 'quantidade', x.qtd) order by x.qtd desc), '[]'::jsonb)
    into v_result
    from (
      select su.impacto, count(*) as qtd
      from public.sugestoes su
      where su.sistema_id = any(v_admin_ids)
        and su.impacto is not null
      group by su.impacto
    ) x;

  elsif v_dimensao = 'autores' then
    select coalesce(jsonb_agg(jsonb_build_object('valor', x.autor_nome, 'quantidade', x.qtd) order by x.qtd desc), '[]'::jsonb)
    into v_result
    from (
      select pr.nome as autor_nome, count(*) as qtd
      from public.sugestoes su
      join public.profiles pr on pr.id = su.autor_id
      where su.sistema_id = any(v_admin_ids)
        and pr.nome is not null
      group by pr.nome
    ) x;
  end if;

  return jsonb_build_object('dimensao', v_dimensao, 'valores', v_result);
end;
$$;

revoke all on function public.dexter_dimensoes(text, text) from public, anon, authenticated;

comment on function public.dexter_dimensoes(text, text) is
  'Dexter: valores distintos (facetas: sistemas/status/categorias/tipos/impactos/autores) para montar filtros dinâmicos, calculados apenas dentro dos sistemas em que o email é admin. Gate: sem_acesso (42501) se sem admin em nenhum sistema; dimensao_invalida (22023) se p_dimensao não reconhecida.';
