-- Dexter access layer for QRápido (project oxavhvpbjjhaqffhgnyo)
-- Read-only, gated RPCs. Internal assistant only, no anon/authenticated access.
--
-- Domain: QRápido is a QR-code based facilities ticketing system.
-- Occupants scan a QR code at a bathroom/room (public.localizacoes, linked to
-- public.ambientes for type: banheiro/sala) and report a problem
-- (public.ocorrencias, tipo_problema free text, status aberto/em_andamento/resolvido).
-- public.timeline_eventos is an audit trail per ocorrencia.
-- public.users is both the identity and permission table: id = auth.users.id,
-- has email, ativo (active flag) and role (solicitante < executor < admin/developer,
-- mirroring the existing public.is_admin_or_dev()/is_executor_or_above() helpers).
--
-- Access model: gate on email -> public.users lookup. has_access requires
-- ativo = true AND role IN ('admin','developer','executor'). 'solicitante' is a
-- basic requester (submits tickets via QR code) and is intentionally excluded
-- from aggregate/staff data.

-- ---------------------------------------------------------------------------
-- Internal helper: resolve + enforce access, reused by every gated RPC below.
-- Not meant to be called directly by clients (revoked from public/anon/authenticated
-- like everything else here; only usable from within other SECURITY DEFINER
-- functions owned by the same role).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._dexter_assert_access(p_email text)
RETURNS public.users
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user public.users;
BEGIN
  SELECT u.* INTO v_user
  FROM public.users u
  WHERE lower(u.email) = lower(p_email)
  LIMIT 1;

  IF v_user.id IS NULL
     OR v_user.ativo IS NOT TRUE
     OR v_user.role NOT IN ('admin', 'developer', 'executor') THEN
    RAISE EXCEPTION 'sem_acesso' USING ERRCODE = '42501';
  END IF;

  RETURN v_user;
END;
$$;

REVOKE ALL ON FUNCTION public._dexter_assert_access(text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._dexter_assert_access(text) IS
  'Dexter: resolve public.users by email and enforce ativo + role gate (executor/admin/developer). Raises 42501 (sem_acesso) otherwise. Internal use only.';

-- ---------------------------------------------------------------------------
-- 1) dexter_whoami(p_email text) -> jsonb
--    Identity check. Does NOT raise on missing/inactive users - it reports
--    has_access = false instead, so Dexter can explain "no access" to the user.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dexter_whoami(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user public.users;
BEGIN
  SELECT u.* INTO v_user
  FROM public.users u
  WHERE lower(u.email) = lower(p_email)
  LIMIT 1;

  IF v_user.id IS NULL THEN
    RETURN jsonb_build_object(
      'has_access', false,
      'email', p_email,
      'motivo', 'usuario_nao_encontrado'
    );
  END IF;

  RETURN jsonb_build_object(
    'has_access', (v_user.ativo IS TRUE AND v_user.role IN ('admin', 'developer', 'executor')),
    'email', v_user.email,
    'nome', v_user.nome,
    'role', v_user.role,
    'predio', v_user.predio,
    'andar', v_user.andar,
    'tipo', v_user.tipo,
    'ativo', v_user.ativo,
    'motivo', CASE
      WHEN v_user.ativo IS NOT TRUE THEN 'usuario_inativo'
      WHEN v_user.role NOT IN ('admin', 'developer', 'executor') THEN 'role_sem_acesso'
      ELSE NULL
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dexter_whoami(text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.dexter_whoami(text) IS
  'Dexter: identity/access lookup by email against public.users. Never raises; returns has_access=false with a motivo when the user is unknown, inactive, or a plain solicitante.';

-- ---------------------------------------------------------------------------
-- 2) dexter_ocorrencias_metricas(p_email text, p_dias integer default 30) -> jsonb
--    Aggregated ticket metrics for the last p_dias days (capped 1..365).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dexter_ocorrencias_metricas(
  p_email text,
  p_dias integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dias integer := GREATEST(1, LEAST(COALESCE(p_dias, 30), 365));
  v_cutoff timestamptz := now() - (v_dias || ' days')::interval;
  v_result jsonb;
BEGIN
  PERFORM public._dexter_assert_access(p_email);

  WITH periodo AS (
    SELECT o.*, l.predio AS predio_nome
    FROM public.ocorrencias o
    JOIN public.localizacoes l ON l.id = o.id_localizacao
    WHERE o.criado_em >= v_cutoff
  ),
  por_status AS (
    SELECT COALESCE(jsonb_object_agg(status, cnt), '{}'::jsonb) AS j
    FROM (SELECT status, COUNT(*) AS cnt FROM periodo GROUP BY status) s
  ),
  por_tipo AS (
    SELECT COALESCE(jsonb_object_agg(tipo_problema, cnt), '{}'::jsonb) AS j
    FROM (SELECT tipo_problema, COUNT(*) AS cnt FROM periodo GROUP BY tipo_problema) t
  ),
  por_predio AS (
    SELECT COALESCE(jsonb_object_agg(predio_nome, cnt), '{}'::jsonb) AS j
    FROM (
      SELECT predio_nome, COUNT(*) AS cnt
      FROM periodo
      GROUP BY predio_nome
      ORDER BY cnt DESC
      LIMIT 50
    ) p
  )
  SELECT jsonb_build_object(
    'periodo_dias', v_dias,
    'total', (SELECT COUNT(*) FROM periodo),
    'por_status', (SELECT j FROM por_status),
    'por_tipo_problema', (SELECT j FROM por_tipo),
    'por_predio', (SELECT j FROM por_predio),
    'tempo_medio_resolucao_horas', (
      SELECT ROUND((EXTRACT(EPOCH FROM AVG(resolvido_em - criado_em)) / 3600)::numeric, 1)
      FROM periodo WHERE resolvido_em IS NOT NULL
    ),
    'abertas_ha_mais_de_3_dias', (
      SELECT COUNT(*) FROM public.ocorrencias
      WHERE status = 'aberto' AND criado_em < now() - interval '3 days'
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.dexter_ocorrencias_metricas(text, integer) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.dexter_ocorrencias_metricas(text, integer) IS
  'Dexter: aggregated ocorrencias metrics (counts by status/tipo_problema/predio, avg resolution time, stale-open count) for the last p_dias days (1..365, default 30). Gated by email via _dexter_assert_access.';

-- ---------------------------------------------------------------------------
-- 3) dexter_ocorrencias_lista(p_email text, p_status text, p_predio text, p_limit integer) -> jsonb
--    Recent tickets, optionally filtered by status/predio. Capped at 50 rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dexter_ocorrencias_lista(
  p_email text,
  p_status text DEFAULT NULL,
  p_predio text DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 20), 50));
  v_result jsonb;
BEGIN
  PERFORM public._dexter_assert_access(p_email);

  SELECT COALESCE(jsonb_agg(row_to_json(x)), '[]'::jsonb) INTO v_result
  FROM (
    SELECT
      o.id,
      l.predio,
      l.andar,
      l.identificador_extra,
      a.nome AS ambiente,
      a.categoria AS ambiente_categoria,
      o.tipo_problema,
      o.status,
      o.observacao,
      o.criado_em,
      o.resolvido_em,
      o.webhook_enviado
    FROM public.ocorrencias o
    JOIN public.localizacoes l ON l.id = o.id_localizacao
    LEFT JOIN public.ambientes a ON a.id = l.id_ambiente
    WHERE (p_status IS NULL OR o.status = p_status)
      AND (p_predio IS NULL OR l.predio = p_predio)
    ORDER BY o.criado_em DESC
    LIMIT v_limit
  ) x;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.dexter_ocorrencias_lista(text, text, text, integer) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.dexter_ocorrencias_lista(text, text, text, integer) IS
  'Dexter: recent ocorrencias (tickets), optionally filtered by status/predio, newest first, capped at 50 rows (default 20). Gated by email via _dexter_assert_access.';

-- ---------------------------------------------------------------------------
-- 4) dexter_localizacoes_status(p_email text, p_predio text) -> jsonb
--    Per-location ticket load (open/total counts, last ticket date). Capped at 50 rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dexter_localizacoes_status(
  p_email text,
  p_predio text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public._dexter_assert_access(p_email);

  SELECT COALESCE(jsonb_agg(row_to_json(x)), '[]'::jsonb) INTO v_result
  FROM (
    SELECT
      l.id,
      l.predio,
      l.andar,
      l.identificador_extra,
      a.nome AS ambiente,
      a.categoria AS ambiente_categoria,
      l.ativo,
      COUNT(o.id) FILTER (WHERE o.status = 'aberto') AS ocorrencias_abertas,
      COUNT(o.id) AS ocorrencias_total,
      MAX(o.criado_em) AS ultima_ocorrencia_em
    FROM public.localizacoes l
    LEFT JOIN public.ambientes a ON a.id = l.id_ambiente
    LEFT JOIN public.ocorrencias o ON o.id_localizacao = l.id
    WHERE (p_predio IS NULL OR l.predio = p_predio)
    GROUP BY l.id, l.predio, l.andar, l.identificador_extra, a.nome, a.categoria, l.ativo
    ORDER BY ocorrencias_abertas DESC, ocorrencias_total DESC
    LIMIT 50
  ) x;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.dexter_localizacoes_status(text, text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.dexter_localizacoes_status(text, text) IS
  'Dexter: per-location ticket load (open/total ocorrencias counts, last ticket date), optionally filtered by predio, capped at 50 rows ordered by open count. Gated by email via _dexter_assert_access.';
