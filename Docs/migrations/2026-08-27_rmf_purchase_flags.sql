-- 2026-08-27_rmf_purchase_flags.sql
-- RM Forecast purchase-check flags (D-RMF-08): two read RPCs behind the same
-- gate as the five forecast RPCs. TEST first, then PROD.
-- SQL Editor: run each block on its own (last-result-set rule).

-- ── Block 0 · preflight: the gate helper, by name and body ──────────────────
-- If its body RAISEs on failure, the PERFORM lines below are right as written.
-- If it RETURNS boolean instead, replace each PERFORM line with:
--   IF NOT public._rm_forecast_gate() THEN RAISE EXCEPTION 'Not authorized'; END IF;
SELECT proname, pg_get_function_result(oid) AS returns, pg_get_functiondef(oid) AS body
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname = '_rm_forecast_gate';

-- ── Block 1 · bar-stock receiving history per material + numeric bar size ───
CREATE OR REPLACE FUNCTION public.forecast_rm_material_history()
RETURNS TABLE (
  material_key      text,          -- lower(btrim(material_type))
  bar_size_num      numeric,       -- leading number of bar_size ('0.500 dia' → 0.500)
  material_type     text,          -- as most recently received (display)
  bar_size          text,          -- as most recently received (display)
  receipts          bigint,
  bars_received     bigint,
  first_received_at timestamptz,
  last_received_at  timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public._rm_forecast_gate();

  RETURN QUERY
  WITH r AS (
    SELECT
      lower(btrim(mr.material_type))                                        AS material_key,
      (substring(mr.bar_size FROM '([0-9]+(?:\.[0-9]+)?)'))::numeric        AS bar_size_num,
      mr.material_type,
      mr.bar_size,
      mr.quantity,
      COALESCE(mr.received_at, mr.created_at)                               AS received_at
    FROM material_receiving mr
    WHERE mr.category = 'bar'
      AND mr.quantity > 0                                   -- qty-0 stubs are not "had it"
      AND substring(mr.bar_size FROM '([0-9]+(?:\.[0-9]+)?)') IS NOT NULL
  )
  SELECT
    r.material_key,
    r.bar_size_num,
    (array_agg(r.material_type ORDER BY r.received_at DESC NULLS LAST))[1] AS material_type,
    (array_agg(r.bar_size      ORDER BY r.received_at DESC NULLS LAST))[1] AS bar_size,
    count(*)                                                                AS receipts,
    sum(r.quantity)::bigint                                                 AS bars_received,
    min(r.received_at)                                                      AS first_received_at,
    max(r.received_at)                                                      AS last_received_at
  FROM r
  GROUP BY r.material_key, r.bar_size_num;
END;
$$;

REVOKE ALL ON FUNCTION public.forecast_rm_material_history() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forecast_rm_material_history() TO authenticated, service_role;

-- ── Block 2 · prior production runs per part that has an open job ───────────
-- prior run = a job for the part that finished manufacturing, or was marked
-- incomplete after making good pieces. In-progress jobs are the run happening
-- now, not history. Maintenance, standalone-finishing and merged members never count.
CREATE OR REPLACE FUNCTION public.forecast_rm_part_history()
RETURNS TABLE (
  part_number  text,
  prior_runs   bigint,
  last_run_at  timestamptz,
  first_run    boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public._rm_forecast_gate();

  RETURN QUERY
  WITH open_parts AS (
    SELECT DISTINCT COALESCE(j.component_id, j.part_id) AS pid
    FROM jobs j
    WHERE j.status IN ('pending_compliance', 'ready', 'assigned', 'in_setup', 'in_progress')
      AND NOT COALESCE(j.is_maintenance, false)
      AND NOT j.is_standalone_finishing
      AND COALESCE(j.component_id, j.part_id) IS NOT NULL
  ),
  runs AS (
    SELECT COALESCE(j.component_id, j.part_id)                                 AS pid,
           count(*)                                                            AS prior_runs,
           max(COALESCE(j.production_start, j.actual_end, j.updated_at))       AS last_run_at
    FROM jobs j
    WHERE NOT COALESCE(j.is_maintenance, false)
      AND NOT j.is_standalone_finishing
      AND (
        j.status IN ('manufacturing_complete', 'pending_passivation', 'in_passivation',
                     'pending_post_manufacturing', 'ready_for_outsourcing', 'at_external_vendor',
                     'ready_for_assembly', 'in_assembly', 'pending_tco', 'complete')
        OR (j.status = 'incomplete' AND COALESCE(j.good_pieces, 0) > 0)
      )
    GROUP BY COALESCE(j.component_id, j.part_id)
  )
  SELECT p.part_number::text,
         COALESCE(r.prior_runs, 0)       AS prior_runs,
         r.last_run_at,
         COALESCE(r.prior_runs, 0) = 0   AS first_run
  FROM open_parts op
  JOIN parts p ON p.id = op.pid
  LEFT JOIN runs r ON r.pid = op.pid;
END;
$$;

REVOKE ALL ON FUNCTION public.forecast_rm_part_history() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.forecast_rm_part_history() TO authenticated, service_role;

-- ── Block 3 · grants (expect {postgres, authenticated, service_role}; no PUBLIC / anon) ──
SELECT proname, proacl
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('forecast_rm_material_history', 'forecast_rm_part_history')
ORDER BY proname;