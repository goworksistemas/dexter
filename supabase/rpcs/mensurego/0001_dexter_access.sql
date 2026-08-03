-- =============================================================================
-- Dexter :: camada de acesso read-only ao MensureGo (RH/DP)
-- Projeto Supabase: quzpakmslmcifvpjkdod
--
-- Modelo de acesso descoberto no MensureGo:
--   public.profiles(email, access_dp_rh boolean, access_medicoes boolean, ...)
--   public.has_rh_dp_access() -- já existente no MensureGo, mas usa auth.uid()
--     (sessão logada). O Dexter não tem sessão Supabase, então a gate abaixo
--     resolve o acesso por e-mail (dexter_has_rh_dp_access) contra a mesma
--     coluna profiles.access_dp_rh.
--
-- Convenções obrigatórias:
--   - Toda função é SECURITY DEFINER, com SET search_path = ''.
--   - Todo objeto do schema public é referenciado com o prefixo public.
--   - Toda função tem REVOKE ALL ... FROM PUBLIC, anon, authenticated logo
--     após a criação (postgres/service_role mantêm EXECUTE via privilégios
--     default do projeto — é assim que o Dexter, rodando com a service_role,
--     consegue chamar as funções mesmo com anon/authenticated bloqueados).
--   - Toda RPC "de negócio" (colaboradores/férias/medições/onboarding) tem
--     como 1º parâmetro p_email text e faz o gate:
--       IF NOT public.dexter_has_rh_dp_access(p_email) THEN
--         RAISE EXCEPTION 'sem_acesso' USING ERRCODE = '42501';
--       END IF;
--   - LGPD: dados de RH são sensíveis. As RPCs retornam AGREGADOS (contagens,
--     somas, médias) por departamento/unidade/etapa, nunca listas de
--     colaboradores com nome/e-mail/telefone/dados pessoais.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Gate interno: existe profile com este e-mail e access_dp_rh = true?
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dexter_has_rh_dp_access(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE lower(p.email) = lower(p_email)
      AND p.access_dp_rh = true
  );
$$;

REVOKE ALL ON FUNCTION public.dexter_has_rh_dp_access(text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.dexter_has_rh_dp_access(text) IS
  'Gate interno do Dexter: true se o profile do e-mail informado tem access_dp_rh=true. Usado por todas as RPCs de negócio do Dexter no MensureGo.';


-- -----------------------------------------------------------------------------
-- 2. dexter_whoami(p_email) -- identidade + flags de acesso (sem gate: é ela
--    quem informa se o e-mail tem ou não acesso, então não pode lançar
--    exceção por falta de acesso).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dexter_whoami(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_profile public.profiles;
BEGIN
  SELECT p.* INTO v_profile
  FROM public.profiles p
  WHERE lower(p.email) = lower(p_email)
  ORDER BY p.updated_at DESC
  LIMIT 1;

  IF v_profile.id IS NULL THEN
    RETURN jsonb_build_object(
      'has_access', false,
      'email', p_email,
      'user_id', null,
      'full_name', null,
      'role', null,
      'pode_rh_dp', false,
      'pode_medicoes', false,
      'allowed_tabs', '[]'::jsonb,
      'colaborador_id', null,
      'departamentos_ids', '[]'::jsonb,
      'papel_rpgowork', null
    );
  END IF;

  RETURN jsonb_build_object(
    'has_access', coalesce(v_profile.access_dp_rh, false),
    'email', v_profile.email,
    'user_id', v_profile.id,
    'full_name', v_profile.name,
    'role', v_profile.role,
    'pode_rh_dp', coalesce(v_profile.access_dp_rh, false),
    'pode_medicoes', coalesce(v_profile.access_medicoes, false),
    'allowed_tabs', to_jsonb(coalesce(v_profile.allowed_tabs, '{}'::text[])),
    'colaborador_id', v_profile.colaborador_id,
    'departamentos_ids', to_jsonb(coalesce(v_profile.departamentos_ids, '{}'::uuid[])),
    'papel_rpgowork', v_profile.papel_rpgowork
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dexter_whoami(text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.dexter_whoami(text) IS
  'Dexter: identidade e flags de acesso do profile associado ao e-mail informado. Não lança exceção; has_access=false quando não encontrado ou sem access_dp_rh.';


-- -----------------------------------------------------------------------------
-- 3. dexter_rh_colaboradores_estrutura(p_email) -- contagem/estrutura de
--    colaboradores por departamento. Sem dado pessoal (nome/e-mail/telefone).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dexter_rh_colaboradores_estrutura(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.dexter_has_rh_dp_access(p_email) THEN
    RAISE EXCEPTION 'sem_acesso' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'por_departamento', (
      SELECT coalesce(jsonb_agg(t ORDER BY t.departamento), '[]'::jsonb)
      FROM (
        SELECT
          d.id AS departamento_id,
          d.nome AS departamento,
          d.eh_obras,
          count(c.id) FILTER (WHERE c.ativo) AS total_ativos,
          count(c.id) FILTER (WHERE NOT c.ativo) AS total_inativos,
          count(c.id) FILTER (WHERE c.ativo AND c.eh_gestor) AS total_gestores
        FROM public.rh_departamentos d
        LEFT JOIN public.rh_colaboradores c ON c.departamento_id = d.id
        WHERE d.ativo = true
        GROUP BY d.id, d.nome, d.eh_obras
      ) t
    ),
    'por_tipo_vaga', (
      SELECT coalesce(jsonb_agg(t2), '[]'::jsonb)
      FROM (
        SELECT c.tipo_vaga, count(*) AS total_ativos
        FROM public.rh_colaboradores c
        WHERE c.ativo = true
        GROUP BY c.tipo_vaga
      ) t2
    ),
    'total_ativos', (SELECT count(*) FROM public.rh_colaboradores WHERE ativo = true),
    'total_inativos', (SELECT count(*) FROM public.rh_colaboradores WHERE ativo = false),
    'gerado_em', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dexter_rh_colaboradores_estrutura(text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.dexter_rh_colaboradores_estrutura(text) IS
  'Dexter [gate RH/DP]: contagem de colaboradores ativos/inativos/gestores por departamento e por tipo_vaga. Não expõe nome, e-mail, telefone ou outro dado pessoal individual.';


-- -----------------------------------------------------------------------------
-- 4. dexter_rh_ferias_saldos(p_email, p_dias_alerta) -- saldos e vencimentos
--    de férias agregados (nunca por colaborador individual).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dexter_rh_ferias_saldos(p_email text, p_dias_alerta integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.dexter_has_rh_dp_access(p_email) THEN
    RAISE EXCEPTION 'sem_acesso' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'resumo_geral', (
      SELECT jsonb_build_object(
        'periodos_abertos', count(*),
        'saldo_total_dias', coalesce(sum(fp.saldo_dias), 0),
        'saldo_medio_dias', round(coalesce(avg(fp.saldo_dias), 0), 1),
        'vencidos', count(*) FILTER (WHERE fp.data_vencimento < current_date),
        'vencendo_no_periodo', count(*) FILTER (
          WHERE fp.data_vencimento >= current_date
            AND fp.data_vencimento <= current_date + make_interval(days => p_dias_alerta)
        ),
        'com_perda_confirmada', count(*) FILTER (WHERE fp.status_direito = 'perdido')
      )
      FROM public.rh_ferias_periodos_aquisitivos fp
      JOIN public.rh_colaboradores c ON c.id = fp.colaborador_id
      WHERE fp.status = 'aberto' AND c.ativo = true
    ),
    'por_departamento', (
      SELECT coalesce(jsonb_agg(t ORDER BY t.departamento), '[]'::jsonb)
      FROM (
        SELECT
          d.nome AS departamento,
          count(fp.id) AS periodos_abertos,
          coalesce(sum(fp.saldo_dias), 0) AS saldo_total_dias,
          count(fp.id) FILTER (
            WHERE fp.data_vencimento >= current_date
              AND fp.data_vencimento <= current_date + make_interval(days => p_dias_alerta)
          ) AS vencendo_no_periodo
        FROM public.rh_departamentos d
        JOIN public.rh_colaboradores c ON c.departamento_id = d.id AND c.ativo = true
        JOIN public.rh_ferias_periodos_aquisitivos fp ON fp.colaborador_id = c.id AND fp.status = 'aberto'
        GROUP BY d.nome
      ) t
    ),
    'dias_alerta', p_dias_alerta,
    'gerado_em', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dexter_rh_ferias_saldos(text, integer) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.dexter_rh_ferias_saldos(text, integer) IS
  'Dexter [gate RH/DP]: saldos e vencimentos de férias agregados por departamento e no total da empresa. p_dias_alerta (default 90) define a janela de "vencendo em breve". Não expõe saldo por colaborador individual.';


-- -----------------------------------------------------------------------------
-- 5. dexter_medicoes_por_unidade(p_email) -- consumo de água/energia agregado
--    por unidade, a partir de med_hidrometros e med_energia.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dexter_medicoes_por_unidade(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.dexter_has_rh_dp_access(p_email) THEN
    RAISE EXCEPTION 'sem_acesso' USING ERRCODE = '42501';
  END IF;

  RETURN (
    WITH energia_ranked AS (
      SELECT
        me.medidor_id, me.leitura, me.data_hora,
        row_number() OVER (PARTITION BY me.medidor_id ORDER BY me.data_hora DESC) AS rn
      FROM public.med_energia me
    ),
    energia_delta AS (
      SELECT
        r1.medidor_id,
        r1.data_hora AS ultima_leitura_em,
        (r1.leitura - r2.leitura) AS consumo_ultimo_periodo
      FROM energia_ranked r1
      LEFT JOIN energia_ranked r2 ON r2.medidor_id = r1.medidor_id AND r2.rn = 2
      WHERE r1.rn = 1
    ),
    hidro_ranked AS (
      SELECT
        mh.medidor_id, mh.leitura, mh.data_hora,
        row_number() OVER (PARTITION BY mh.medidor_id ORDER BY mh.data_hora DESC) AS rn
      FROM public.med_hidrometros mh
    ),
    hidro_delta AS (
      SELECT
        r1.medidor_id,
        r1.data_hora AS ultima_leitura_em,
        (r1.leitura - r2.leitura) AS consumo_ultimo_periodo
      FROM hidro_ranked r1
      LEFT JOIN hidro_ranked r2 ON r2.medidor_id = r1.medidor_id AND r2.rn = 2
      WHERE r1.rn = 1
    ),
    por_unidade AS (
      SELECT
        u.id AS unidade_id,
        u.nome AS unidade,
        'energia'::text AS tipo,
        count(mm.id) AS medidores_ativos,
        coalesce(sum(ed.consumo_ultimo_periodo), 0) AS consumo_ultimo_periodo,
        max(ed.ultima_leitura_em) AS ultima_leitura_em
      FROM public.med_medidores mm
      JOIN public.med_unidades u ON u.id = mm.unidade_id
      LEFT JOIN energia_delta ed ON ed.medidor_id = mm.id
      WHERE mm.ativo = true AND mm.tipo = 'energia'
      GROUP BY u.id, u.nome

      UNION ALL

      SELECT
        u.id AS unidade_id,
        u.nome AS unidade,
        'agua'::text AS tipo,
        count(mm.id) AS medidores_ativos,
        coalesce(sum(hd.consumo_ultimo_periodo), 0) AS consumo_ultimo_periodo,
        max(hd.ultima_leitura_em) AS ultima_leitura_em
      FROM public.med_medidores mm
      JOIN public.med_unidades u ON u.id = mm.unidade_id
      LEFT JOIN hidro_delta hd ON hd.medidor_id = mm.id
      WHERE mm.ativo = true AND mm.tipo = 'agua'
      GROUP BY u.id, u.nome
    )
    SELECT jsonb_build_object(
      'por_unidade', coalesce(jsonb_agg(por_unidade ORDER BY por_unidade.unidade, por_unidade.tipo), '[]'::jsonb),
      'gerado_em', now()
    )
    FROM por_unidade
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dexter_medicoes_por_unidade(text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.dexter_medicoes_por_unidade(text) IS
  'Dexter [gate RH/DP]: consumo de energia e água agregado por unidade (medidores ativos, consumo estimado entre as duas últimas leituras, data da última leitura). Baseado em med_energia e med_hidrometros + med_medidores/med_unidades.';


-- -----------------------------------------------------------------------------
-- 6. dexter_rh_onboarding_offboarding(p_email) -- kanban de onboarding
--    (L-*) e offboarding (D-*) agregado por etapa.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dexter_rh_onboarding_offboarding(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.dexter_has_rh_dp_access(p_email) THEN
    RAISE EXCEPTION 'sem_acesso' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'por_etapa', (
      SELECT coalesce(jsonb_agg(t ORDER BY t.ordem), '[]'::jsonb)
      FROM (
        SELECT
          e.id AS etapa_id,
          e.nome AS etapa,
          e.tipo,
          e.ordem,
          count(k.id) AS total_cartoes,
          count(k.id) FILTER (WHERE k.data_prevista < current_date) AS atrasados
        FROM public.rh_etapas e
        LEFT JOIN public.rh_kanban_cartoes k ON k.coluna = e.id
        WHERE e.ativo = true
        GROUP BY e.id, e.nome, e.tipo, e.ordem
      ) t
    ),
    'resumo', jsonb_build_object(
      'total_onboarding_em_andamento', (
        SELECT count(*)
        FROM public.rh_kanban_cartoes k
        JOIN public.rh_etapas e ON e.id = k.coluna
        WHERE e.tipo = 'ligado'
      ),
      'total_offboarding_em_andamento', (
        SELECT count(*)
        FROM public.rh_kanban_cartoes k
        JOIN public.rh_etapas e ON e.id = k.coluna
        WHERE e.tipo = 'desligado'
      )
    ),
    'gerado_em', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dexter_rh_onboarding_offboarding(text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.dexter_rh_onboarding_offboarding(text) IS
  'Dexter [gate RH/DP]: cartões do kanban de onboarding/offboarding agregados por etapa (rh_etapas), com contagem de atrasados (data_prevista < hoje). Não expõe nome do colaborador do cartão.';


-- =============================================================================
-- Camada modular (migration dexter_mensurego_modular)
--
-- As RPCs abaixo tornam a camada de acesso do Dexter filtrável por
-- departamento/unidade/status/período, mantendo o padrão conservador:
--   - dexter_rh_colaboradores_busca: contagens (ativos/inativos/gestores)
--     filtráveis por departamento/status/tipo_vaga. A "amostra_colaboradores"
--     retornada é capada em 50 linhas e traz apenas nome + cargo + departamento
--     (sem CPF, telefone, e-mail, matrícula ou salário).
--   - dexter_medicoes_busca: consumo de água/energia por unidade, filtrável
--     por unidade/tipo e por janela de meses (p_meses).
--   - dexter_dimensoes: valores distintos (departamentos/unidades/etapas/
--     status/tipo_vaga/tipo_medicao) para o agente resolver filtros antes de
--     chamar as RPCs de negócio.
-- Todas usam o mesmo gate dexter_has_rh_dp_access(p_email).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 7. dexter_rh_colaboradores_busca(p_email, p_departamento, p_status,
--    p_tipo_vaga) -- contagens filtráveis de colaboradores. Nunca expõe CPF,
--    telefone, e-mail, matrícula ou salário. Lista (quando incluída) é capada
--    em 50 linhas com nome + cargo + departamento.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dexter_rh_colaboradores_busca(
  p_email text,
  p_departamento text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_tipo_vaga text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status_norm text;
BEGIN
  IF NOT public.dexter_has_rh_dp_access(p_email) THEN
    RAISE EXCEPTION 'sem_acesso' USING ERRCODE = '42501';
  END IF;

  -- normaliza p_status: aceita ativo/ativos/true ou inativo/inativos/false;
  -- qualquer outro valor é tratado como "sem filtro de status".
  v_status_norm := CASE
    WHEN p_status IS NULL THEN NULL
    WHEN lower(p_status) IN ('ativo', 'ativos', 'true') THEN 'ativo'
    WHEN lower(p_status) IN ('inativo', 'inativos', 'false') THEN 'inativo'
    ELSE NULL
  END;

  RETURN jsonb_build_object(
    'filtros', jsonb_build_object(
      'departamento', p_departamento,
      'status', v_status_norm,
      'tipo_vaga', p_tipo_vaga
    ),
    'totais', (
      SELECT jsonb_build_object(
        'total', count(*),
        'ativos', count(*) FILTER (WHERE c.ativo),
        'inativos', count(*) FILTER (WHERE NOT c.ativo),
        'gestores', count(*) FILTER (WHERE c.ativo AND c.eh_gestor)
      )
      FROM public.rh_colaboradores c
      LEFT JOIN public.rh_departamentos d ON d.id = c.departamento_id
      WHERE (p_departamento IS NULL OR d.nome ILIKE '%' || p_departamento || '%')
        AND (v_status_norm IS NULL OR (v_status_norm = 'ativo') = c.ativo)
        AND (p_tipo_vaga IS NULL OR lower(c.tipo_vaga::text) = lower(p_tipo_vaga))
    ),
    'por_departamento', (
      SELECT coalesce(jsonb_agg(t ORDER BY t.departamento), '[]'::jsonb)
      FROM (
        SELECT
          coalesce(d.nome, 'sem_departamento') AS departamento,
          count(c.id) AS total,
          count(c.id) FILTER (WHERE c.ativo) AS ativos,
          count(c.id) FILTER (WHERE NOT c.ativo) AS inativos,
          count(c.id) FILTER (WHERE c.ativo AND c.eh_gestor) AS gestores
        FROM public.rh_colaboradores c
        LEFT JOIN public.rh_departamentos d ON d.id = c.departamento_id
        WHERE (p_departamento IS NULL OR d.nome ILIKE '%' || p_departamento || '%')
          AND (v_status_norm IS NULL OR (v_status_norm = 'ativo') = c.ativo)
          AND (p_tipo_vaga IS NULL OR lower(c.tipo_vaga::text) = lower(p_tipo_vaga))
        GROUP BY coalesce(d.nome, 'sem_departamento')
      ) t
    ),
    'amostra_colaboradores', (
      SELECT coalesce(jsonb_agg(t2), '[]'::jsonb)
      FROM (
        SELECT
          c.nome,
          c.cargo,
          coalesce(d.nome, 'sem_departamento') AS departamento
        FROM public.rh_colaboradores c
        LEFT JOIN public.rh_departamentos d ON d.id = c.departamento_id
        WHERE (p_departamento IS NULL OR d.nome ILIKE '%' || p_departamento || '%')
          AND (v_status_norm IS NULL OR (v_status_norm = 'ativo') = c.ativo)
          AND (p_tipo_vaga IS NULL OR lower(c.tipo_vaga::text) = lower(p_tipo_vaga))
        ORDER BY c.nome
        LIMIT 50
      ) t2
    ),
    'amostra_capada_em', 50,
    'gerado_em', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dexter_rh_colaboradores_busca(text, text, text, text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.dexter_rh_colaboradores_busca(text, text, text, text) IS
  'Dexter [gate RH/DP]: contagens de colaboradores (total/ativos/inativos/gestores), no total e por departamento, filtráveis por p_departamento (ILIKE parcial), p_status (ativo/inativo) e p_tipo_vaga (demais/obras). Inclui amostra_colaboradores capada em 50 linhas com apenas nome+cargo+departamento — nunca CPF, telefone, e-mail, matrícula ou salário.';


-- -----------------------------------------------------------------------------
-- 8. dexter_medicoes_busca(p_email, p_unidade, p_tipo, p_meses) -- consumo de
--    água/energia por unidade, filtrável por unidade/tipo e por janela de
--    meses (default 6, capado em 36).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dexter_medicoes_busca(
  p_email text,
  p_unidade text DEFAULT NULL,
  p_tipo text DEFAULT NULL,
  p_meses integer DEFAULT 6
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_meses integer;
  v_desde timestamptz;
  v_tipo_norm text;
BEGIN
  IF NOT public.dexter_has_rh_dp_access(p_email) THEN
    RAISE EXCEPTION 'sem_acesso' USING ERRCODE = '42501';
  END IF;

  v_meses := greatest(1, least(coalesce(p_meses, 6), 36));
  v_desde := now() - make_interval(months => v_meses);

  v_tipo_norm := CASE
    WHEN p_tipo IS NULL THEN NULL
    WHEN lower(p_tipo) IN ('agua', 'água') THEN 'agua'
    WHEN lower(p_tipo) IN ('energia', 'eletrica', 'elétrica') THEN 'energia'
    ELSE NULL
  END;

  RETURN (
    WITH energia_janela AS (
      SELECT me.medidor_id, me.leitura, me.data_hora
      FROM public.med_energia me
      WHERE me.data_hora >= v_desde
    ),
    energia_agg AS (
      SELECT
        medidor_id,
        count(*) AS leituras,
        min(leitura) AS leitura_min,
        max(leitura) AS leitura_max,
        min(data_hora) AS primeira_leitura_em,
        max(data_hora) AS ultima_leitura_em
      FROM energia_janela
      GROUP BY medidor_id
    ),
    hidro_janela AS (
      SELECT mh.medidor_id, mh.leitura, mh.data_hora
      FROM public.med_hidrometros mh
      WHERE mh.data_hora >= v_desde
    ),
    hidro_agg AS (
      SELECT
        medidor_id,
        count(*) AS leituras,
        min(leitura) AS leitura_min,
        max(leitura) AS leitura_max,
        min(data_hora) AS primeira_leitura_em,
        max(data_hora) AS ultima_leitura_em
      FROM hidro_janela
      GROUP BY medidor_id
    ),
    por_unidade AS (
      SELECT
        u.id AS unidade_id,
        u.nome AS unidade,
        'energia'::text AS tipo,
        count(mm.id) AS medidores_considerados,
        coalesce(sum(greatest(ea.leitura_max - ea.leitura_min, 0)), 0) AS consumo_periodo,
        min(ea.primeira_leitura_em) AS primeira_leitura_em,
        max(ea.ultima_leitura_em) AS ultima_leitura_em
      FROM public.med_medidores mm
      JOIN public.med_unidades u ON u.id = mm.unidade_id
      LEFT JOIN energia_agg ea ON ea.medidor_id = mm.id
      WHERE mm.ativo = true
        AND mm.tipo = 'energia'
        AND (v_tipo_norm IS NULL OR v_tipo_norm = 'energia')
        AND (p_unidade IS NULL OR u.nome ILIKE '%' || p_unidade || '%')
      GROUP BY u.id, u.nome

      UNION ALL

      SELECT
        u.id AS unidade_id,
        u.nome AS unidade,
        'agua'::text AS tipo,
        count(mm.id) AS medidores_considerados,
        coalesce(sum(greatest(ha.leitura_max - ha.leitura_min, 0)), 0) AS consumo_periodo,
        min(ha.primeira_leitura_em) AS primeira_leitura_em,
        max(ha.ultima_leitura_em) AS ultima_leitura_em
      FROM public.med_medidores mm
      JOIN public.med_unidades u ON u.id = mm.unidade_id
      LEFT JOIN hidro_agg ha ON ha.medidor_id = mm.id
      WHERE mm.ativo = true
        AND mm.tipo = 'agua'
        AND (v_tipo_norm IS NULL OR v_tipo_norm = 'agua')
        AND (p_unidade IS NULL OR u.nome ILIKE '%' || p_unidade || '%')
      GROUP BY u.id, u.nome
    )
    SELECT jsonb_build_object(
      'filtros', jsonb_build_object('unidade', p_unidade, 'tipo', v_tipo_norm, 'meses', v_meses),
      'por_unidade', coalesce(jsonb_agg(por_unidade ORDER BY por_unidade.unidade, por_unidade.tipo), '[]'::jsonb),
      'gerado_em', now()
    )
    FROM por_unidade
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dexter_medicoes_busca(text, text, text, integer) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.dexter_medicoes_busca(text, text, text, integer) IS
  'Dexter [gate RH/DP]: consumo de água/energia por unidade dentro da janela de p_meses (default 6, capado em 36), filtrável por p_unidade (ILIKE parcial) e p_tipo (agua/energia). consumo_periodo é a diferença entre a maior e a menor leitura acumulada do medidor dentro da janela.';


-- -----------------------------------------------------------------------------
-- 9. dexter_dimensoes(p_email, p_dimensao) -- valores distintos para o agente
--    resolver filtros antes de chamar as RPCs de negócio. Dimensões aceitas:
--    departamentos, unidades, etapas, status_colaborador, tipos_vaga,
--    tipos_medicao.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dexter_dimensoes(p_email text, p_dimensao text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dim text := lower(coalesce(p_dimensao, ''));
BEGIN
  IF NOT public.dexter_has_rh_dp_access(p_email) THEN
    RAISE EXCEPTION 'sem_acesso' USING ERRCODE = '42501';
  END IF;

  IF v_dim = 'departamentos' THEN
    RETURN jsonb_build_object(
      'dimensao', 'departamentos',
      'valores', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'nome', d.nome, 'eh_obras', d.eh_obras) ORDER BY d.nome), '[]'::jsonb)
        FROM public.rh_departamentos d
        WHERE d.ativo = true
      )
    );

  ELSIF v_dim = 'unidades' THEN
    RETURN jsonb_build_object(
      'dimensao', 'unidades',
      'valores', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'nome', u.nome) ORDER BY u.nome), '[]'::jsonb)
        FROM public.med_unidades u
        WHERE u.ativo = true
      )
    );

  ELSIF v_dim = 'etapas' THEN
    RETURN jsonb_build_object(
      'dimensao', 'etapas',
      'valores', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome, 'tipo', e.tipo, 'ordem', e.ordem) ORDER BY e.ordem), '[]'::jsonb)
        FROM public.rh_etapas e
        WHERE e.ativo = true
      )
    );

  ELSIF v_dim = 'status_colaborador' THEN
    RETURN jsonb_build_object(
      'dimensao', 'status_colaborador',
      'valores', '["ativo", "inativo"]'::jsonb
    );

  ELSIF v_dim = 'tipos_vaga' THEN
    RETURN jsonb_build_object(
      'dimensao', 'tipos_vaga',
      'valores', (
        SELECT coalesce(jsonb_agg(e ORDER BY e), '[]'::jsonb)
        FROM unnest(enum_range(NULL::public.rh_tipo_vaga)) AS e(e)
      )
    );

  ELSIF v_dim = 'tipos_medicao' THEN
    RETURN jsonb_build_object(
      'dimensao', 'tipos_medicao',
      'valores', '["agua", "energia"]'::jsonb
    );

  ELSE
    RAISE EXCEPTION 'dimensao_invalida: % (valores aceitos: departamentos, unidades, etapas, status_colaborador, tipos_vaga, tipos_medicao)', p_dimensao
      USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.dexter_dimensoes(text, text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.dexter_dimensoes(text, text) IS
  'Dexter [gate RH/DP]: valores distintos de uma dimensão (departamentos/unidades/etapas/status_colaborador/tipos_vaga/tipos_medicao) para o agente resolver filtros antes de chamar dexter_rh_colaboradores_busca/dexter_medicoes_busca. p_dimensao inválida lança exceção 22023.';
