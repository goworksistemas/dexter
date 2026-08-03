-- =============================================================================
-- Dexter — consulta genérica READ-ONLY + introspecção de schema
-- Aplicar EM TODOS os projetos GoWork (networkgo, pipego, godash, mensurego,
-- checkgo, expertgo, supplygo, qrapido, sugestoes). É read-only e seguro:
--   - role dexter_ro só tem SELECT (qualquer escrita falha por privilégio);
--   - dexter_sql só aceita 1 SELECT/WITH, com statement_timeout e cap de linhas;
--   - executor real é dexter_sql_run criado COM set role dexter_ro —
--     Postgres/Supabase bloqueia SET ROLE *dentro* de SECURITY DEFINER;
--   - ambas gated pelo acesso do usuário (dexter_whoami.has_access).
-- Depois de rodar, ligar as tools no manifesto do backend e testar.
-- =============================================================================

-- 1) Role read-only
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'dexter_ro') then
    create role dexter_ro nologin;
  end if;
end $$;
grant usage on schema public to dexter_ro;
grant select on all tables in schema public to dexter_ro;
alter default privileges in schema public grant select on tables to dexter_ro;
-- Sem isto, policies com auth.uid() zeram o resultado (Dexter não tem sessão do app).
alter role dexter_ro bypassrls;
grant dexter_ro to postgres;
grant create on schema public to dexter_ro; -- temporário p/ criar dexter_sql_run

-- 2) Introspecção de schema (tabelas/colunas/FKs)
create or replace function public.dexter_schema(p_email text, p_tabela text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  if not coalesce((public.dexter_whoami(p_email)->>'has_access')::boolean, false) then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;
  if p_tabela is null then
    select coalesce(jsonb_agg(t order by (t->>'tabela')), '[]'::jsonb) into v from (
      select jsonb_build_object(
        'tabela', c.relname,
        'comentario', obj_description(c.oid),
        'colunas_qtd', (select count(*) from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
        'linhas_estimadas', c.reltuples::bigint
      ) t
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','v','m','p')
    ) x;
  else
    select jsonb_build_object(
      'tabela', p_tabela,
      'colunas', coalesce((
        select jsonb_agg(jsonb_build_object(
          'coluna', a.attname, 'tipo', format_type(a.atttypid,a.atttypmod),
          'nullable', not a.attnotnull, 'comentario', col_description(a.attrelid,a.attnum)
        ) order by a.attnum)
        from pg_attribute a
        where a.attrelid = ('public.'||quote_ident(p_tabela))::regclass and a.attnum>0 and not a.attisdropped
      ), '[]'::jsonb),
      'fks', coalesce((
        select jsonb_agg(jsonb_build_object(
          'coluna', att.attname, 'referencia', cf.relname||'.'||attf.attname))
        from pg_constraint con
        join pg_class cf on cf.oid=con.confrelid
        join lateral unnest(con.conkey) with ordinality k(an,ord) on true
        join lateral unnest(con.confkey) with ordinality kf(an,ord) on kf.ord=k.ord
        join pg_attribute att on att.attrelid=con.conrelid and att.attnum=k.an
        join pg_attribute attf on attf.attrelid=con.confrelid and attf.attnum=kf.an
        where con.contype='f' and con.conrelid=('public.'||quote_ident(p_tabela))::regclass
      ), '[]'::jsonb)
    ) into v;
  end if;
  return v;
end $$;
revoke all on function public.dexter_schema(text, text) from public, anon, authenticated;
grant execute on function public.dexter_schema(text, text) to service_role;

-- 3a) Executor READ-ONLY (criado como role dexter_ro)
set role dexter_ro;
create or replace function public.dexter_sql_run(p_sql text, p_limit int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_json jsonb;
begin
  perform set_config('statement_timeout', '8000', true);
  execute format(
    'select coalesce(jsonb_agg(row_to_json(_t)), ''[]''::jsonb) from (select * from (%s) _q limit %s) _t',
    p_sql, least(coalesce(p_limit, 200), 1000)
  ) into v_json;
  return coalesce(v_json, '[]'::jsonb);
end;
$$;
reset role;
revoke create on schema public from dexter_ro;
revoke all on function public.dexter_sql_run(text, int) from public, anon, authenticated;
grant execute on function public.dexter_sql_run(text, int) to postgres;

-- 3b) Gate + allowlist SELECT/WITH + chama o executor
create or replace function public.dexter_sql(p_email text, p_sql text, p_limit int default 200)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_json jsonb;
  v_sql text;
  v_limite int;
  v_total int;
  v_aviso text;
begin
  if not coalesce((public.dexter_whoami(p_email)->>'has_access')::boolean, false) then
    raise exception 'sem_acesso' using errcode = '42501';
  end if;
  v_sql := btrim(p_sql);
  v_sql := regexp_replace(v_sql, ';\s*$', '');
  if v_sql !~* '^(select|with)([[:space:]]|\()' then
    return jsonb_build_object('erro', 'Apenas SELECT/WITH permitido.');
  end if;
  if position(';' in v_sql) > 0 then
    return jsonb_build_object('erro', 'Apenas uma instrucao (sem ;).');
  end if;
  v_limite := least(coalesce(p_limit, 200), 1000);
  begin
    v_json := public.dexter_sql_run(v_sql, v_limite);
  exception when others then
    return jsonb_build_object('erro', sqlerrm);
  end;
  v_total := jsonb_array_length(v_json);
  if v_total >= v_limite and v_sql !~* '\m(count|sum|avg|min|max|group\s+by)\M' then
    v_aviso := 'Resultado pode estar truncado pelo limite — use count(*) ou agregacao para totais exatos.';
  end if;
  return jsonb_build_object(
    'linhas', v_json,
    'total_retornado', v_total,
    'limite_aplicado', v_limite,
    'aviso', v_aviso
  );
end $$;
revoke all on function public.dexter_sql(text, text, int) from public, anon, authenticated;
grant execute on function public.dexter_sql(text, text, int) to service_role;

-- ===== Testes (rode e confira) =====
-- select public.dexter_schema('bpm@gowork.com.br');
-- select public.dexter_sql('bpm@gowork.com.br','select count(*) from public.tickets');
-- select public.dexter_sql('bpm@gowork.com.br','update public.tickets set title=title'); -- erro allowlist
