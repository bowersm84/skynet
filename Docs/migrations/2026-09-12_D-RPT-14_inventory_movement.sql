-- ============================================================================
-- D-RPT-14 — INVENTORY MOVEMENT (Raw Material: Bars & Blanks)
-- Run in: Supabase SQL Editor, TEST first, then PROD after frontend verification.
-- Additive and read-only against production data: two RPCs + one registry row.
-- All checks raise EXCEPTION on failure; reaching the final SELECT proves pass.
--
-- Objects may already exist from the Sep 4 SQL Editor run, so both functions are
-- DROPped before create (CREATE OR REPLACE cannot change a function's result
-- type) and the registry row is upserted on slug.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Detail RPC — one row per raw-material movement.
--
--    Auth guard mirrors report_part_history (D-RPT-13): any active SkyNet user;
--    a NULL uid passes so the SQL Editor can run it. Inlined rather than routed
--    through a shared helper so this migration cannot alter another report's
--    gate.
--
--    Movement semantics:
--      Received   material_receiving            +quantity
--      Used       material_usage                -quantity_used  (rows with
--                                               quantity_used = 0 are skipped:
--                                               inch-only partials, measured
--                                               negligible and excluded)
--      Adjustment inventory_adjustment_requests ±adjustment_delta, approved only
--
--    Unit cost matches the opening-balance valuation workbook:
--      COALESCE(price_per_bar, price_per_lb * weight_lbs / quantity)
--    adjustments prefer the price captured at count time. A NULL unit cost means
--    the lot has no cost data; the row carries NO value and is counted, never
--    silently zeroed.
--
--    Dates bucket in shop local time; BETWEEN makes both ends inclusive.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.report_inventory_movement(date, date);

CREATE FUNCTION public.report_inventory_movement(p_start date, p_end date)
RETURNS TABLE (
  mv_date       date,
  category      text,
  material      text,
  lot_number    text,
  heat_number   text,
  movement_type text,
  qty_change    numeric,
  unit_cost     numeric,
  value_change  numeric,
  reference     text,
  recorded_by   text,
  notes         text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.is_active) THEN
    RAISE EXCEPTION 'REPORT_GATE: an active SkyNet user is required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH recv AS (
    SELECT (mr.received_at AT TIME ZONE 'America/New_York')::date AS mv_date, mr.category,
           CASE WHEN mr.category = 'blank'
                THEN COALESCE(bt.stud_series || ' Series ' || bt.stud_length || ' ' || bt.material_type, mr.material_type)
                ELSE mr.material_type || COALESCE(' ' || mr.bar_size, '') END AS material,
           mr.lot_number, mr.heat_number, 'Received' AS movement_type, mr.quantity::numeric AS qty_change,
           ROUND(COALESCE(mr.price_per_bar, mr.price_per_lb * mr.weight_lbs / NULLIF(mr.quantity,0))::numeric, 4) AS unit_cost,
           COALESCE('PO ' || NULLIF(mr.po_number,''), mr.vendor, '') AS reference, pr.full_name AS recorded_by, mr.notes
    FROM material_receiving mr
    LEFT JOIN blank_types bt ON bt.id = mr.blank_type_id
    LEFT JOIN profiles pr ON pr.id = mr.received_by
  ),
  used AS (
    SELECT (mu.used_at AT TIME ZONE 'America/New_York')::date, mr.category,
           CASE WHEN mr.category = 'blank'
                THEN COALESCE(bt.stud_series || ' Series ' || bt.stud_length || ' ' || bt.material_type, mr.material_type)
                ELSE mr.material_type || COALESCE(' ' || mr.bar_size, '') END,
           COALESCE(mu.lot_number, mr.lot_number), mr.heat_number, 'Used', -mu.quantity_used::numeric,
           ROUND(COALESCE(mr.price_per_bar, mr.price_per_lb * mr.weight_lbs / NULLIF(mr.quantity,0))::numeric, 4),
           COALESCE('Job ' || j.job_number, 'Production'), pr.full_name, mu.notes
    FROM material_usage mu
    JOIN material_receiving mr ON mr.id = mu.material_receiving_id
    LEFT JOIN blank_types bt ON bt.id = mr.blank_type_id
    LEFT JOIN jobs j ON j.id = mu.job_id
    LEFT JOIN profiles pr ON pr.id = mu.used_by
    WHERE mu.quantity_used <> 0
  ),
  adj AS (
    SELECT (COALESCE(iar.reviewed_at, iar.requested_at) AT TIME ZONE 'America/New_York')::date, mr.category,
           CASE WHEN mr.category = 'blank'
                THEN COALESCE(bt.stud_series || ' Series ' || bt.stud_length || ' ' || bt.material_type, mr.material_type)
                ELSE mr.material_type || COALESCE(' ' || mr.bar_size, '') END,
           COALESCE(iar.lot_number, mr.lot_number), mr.heat_number, 'Adjustment', iar.adjustment_delta,
           ROUND(COALESCE(iar.price_per_bar_at_count, mr.price_per_bar, mr.price_per_lb * mr.weight_lbs / NULLIF(mr.quantity,0))::numeric, 4),
           COALESCE('Count: ' || NULLIF(iar.reason,''), 'Count adjustment'), pr.full_name, iar.review_notes
    FROM inventory_adjustment_requests iar
    JOIN material_receiving mr ON mr.id = iar.material_receiving_id
    LEFT JOIN blank_types bt ON bt.id = mr.blank_type_id
    LEFT JOIN profiles pr ON pr.id = iar.reviewed_by
    WHERE iar.status = 'approved'
  ),
  mv AS (SELECT * FROM recv UNION ALL SELECT * FROM used UNION ALL SELECT * FROM adj)
  SELECT mv.mv_date, mv.category, mv.material, mv.lot_number, mv.heat_number, mv.movement_type,
         mv.qty_change, mv.unit_cost,
         CASE WHEN mv.unit_cost IS NULL THEN NULL ELSE ROUND(mv.qty_change * mv.unit_cost, 2) END AS value_change,
         mv.reference, mv.recorded_by, mv.notes
  FROM mv
  WHERE mv.mv_date BETWEEN p_start AND p_end
  ORDER BY mv.mv_date DESC, mv.category, mv.movement_type, mv.material;
END
$fn$;

REVOKE ALL ON FUNCTION public.report_inventory_movement(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_inventory_movement(date, date) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Summary RPC — one jsonb of aggregates for the range and the immediately
--    preceding range of equal length.
--
--    Both periods are computed FROM report_inventory_movement(...) so there is
--    exactly one definition of a movement in the system. The frontend re-adds
--    the detail rows and compares (D-RPT-12 integrity check); that check is only
--    meaningful because both layers come from the same function.
--
--    Prior period: prior_end = p_start - 1, prior_start = prior_end - (p_end - p_start).
--    This is calendar arithmetic, NOT week alignment: the prior period for
--    Mon Sep 7 - Fri Sep 11 is Wed Sep 2 - Sun Sep 6, not the Mon-Fri week before.
--
--    Value math uses COALESCE(value_change, 0); rows with no lot cost are
--    counted separately as missing_cost_rows and never valued at zero silently.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.report_inventory_movement_summary(date, date);

CREATE FUNCTION public.report_inventory_movement_summary(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid         uuid := auth.uid();
  v_prior_end   date := p_start - 1;
  v_prior_start date := (p_start - 1) - (p_end - p_start);
  v_out         jsonb;
BEGIN
  IF v_uid IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.is_active) THEN
    RAISE EXCEPTION 'REPORT_GATE: an active SkyNet user is required' USING ERRCODE = '42501';
  END IF;

  WITH rows_all AS (
    SELECT 'current'::text AS period, m.* FROM public.report_inventory_movement(p_start, p_end) m
    UNION ALL
    SELECT 'previous'::text, m.* FROM public.report_inventory_movement(v_prior_start, v_prior_end) m
  ),
  -- period x category grid so a category with no movement still reports zeros
  grid AS (
    SELECT p.period, c.category
    FROM (VALUES ('current'), ('previous')) p(period)
    CROSS JOIN (VALUES ('bar'), ('blank')) c(category)
  ),
  per_cat AS (
    SELECT g.period, g.category,
      COALESCE(SUM(r.qty_change) FILTER (WHERE r.movement_type = 'Received'), 0)                 AS received_units,
      COALESCE(SUM(COALESCE(r.value_change,0)) FILTER (WHERE r.movement_type = 'Received'), 0)   AS received_value,
      COUNT(*) FILTER (WHERE r.movement_type = 'Received')                                       AS received_txns,
      COALESCE(SUM(r.qty_change) FILTER (WHERE r.movement_type = 'Used'), 0)                     AS used_units,
      COALESCE(SUM(COALESCE(r.value_change,0)) FILTER (WHERE r.movement_type = 'Used'), 0)       AS used_value,
      COUNT(*) FILTER (WHERE r.movement_type = 'Used')                                           AS used_txns,
      COALESCE(SUM(r.qty_change) FILTER (WHERE r.movement_type = 'Adjustment'), 0)               AS adj_units,
      COALESCE(SUM(COALESCE(r.value_change,0)) FILTER (WHERE r.movement_type = 'Adjustment'), 0) AS adj_value,
      COUNT(*) FILTER (WHERE r.movement_type = 'Adjustment')                                     AS adj_txns,
      COALESCE(SUM(r.qty_change), 0)                                                             AS net_units,
      COALESCE(SUM(COALESCE(r.value_change,0)), 0)                                               AS net_value
    FROM grid g
    LEFT JOIN rows_all r ON r.period = g.period AND r.category = g.category
    GROUP BY g.period, g.category
  ),
  per_cat_obj AS (
    SELECT pc.period, pc.category, jsonb_build_object(
      'received_units', pc.received_units, 'received_value', ROUND(pc.received_value, 2), 'received_txns', pc.received_txns,
      'used_units',     pc.used_units,     'used_value',     ROUND(pc.used_value, 2),     'used_txns',     pc.used_txns,
      'adj_units',      pc.adj_units,      'adj_value',      ROUND(pc.adj_value, 2),      'adj_txns',      pc.adj_txns,
      'net_units',      pc.net_units,      'net_value',      ROUND(pc.net_value, 2)
    ) AS obj
    FROM per_cat pc
  ),
  period_obj AS (
    SELECT g2.period, jsonb_build_object(
      'movements',         (SELECT COUNT(*) FROM rows_all r WHERE r.period = g2.period),
      'net_value',         (SELECT ROUND(COALESCE(SUM(COALESCE(r.value_change,0)), 0), 2) FROM rows_all r WHERE r.period = g2.period),
      'bars',              (SELECT o.obj FROM per_cat_obj o WHERE o.period = g2.period AND o.category = 'bar'),
      'blanks',            (SELECT o.obj FROM per_cat_obj o WHERE o.period = g2.period AND o.category = 'blank'),
      'missing_cost_rows', (SELECT COUNT(*) FROM rows_all r WHERE r.period = g2.period AND r.value_change IS NULL)
    ) AS obj
    FROM (VALUES ('current'), ('previous')) g2(period)
  ),
  draws AS (
    SELECT r.category, r.material,
           SUM(r.qty_change)                AS units,
           SUM(COALESCE(r.value_change, 0)) AS value
    FROM rows_all r
    WHERE r.period = 'current' AND r.movement_type = 'Used'
    GROUP BY r.category, r.material
  ),
  -- Requeue: the detail row's reference is the only job handle in the summary,
  -- and Used references are built as 'Job ' || jobs.job_number, so 'Job RQ-%'
  -- is exactly jobs.job_number LIKE 'RQ-%' (the Part History RQ chip rule).
  rq AS (
    SELECT r.period, r.reference, r.category,
           SUM(COALESCE(r.value_change, 0)) AS value,
           SUM(r.qty_change)                AS units
    FROM rows_all r
    WHERE r.movement_type = 'Used' AND r.reference LIKE 'Job RQ-%'
    GROUP BY r.period, r.reference, r.category
  ),
  rq_job AS (
    SELECT q.reference,
      COALESCE(SUM(q.value) FILTER (WHERE q.period = 'current'), 0)  AS current_value,
      COALESCE(SUM(q.value) FILTER (WHERE q.period = 'previous'), 0) AS previous_value,
      COALESCE(SUM(q.units) FILTER (WHERE q.period = 'current'), 0)  AS current_units,
      COALESCE(SUM(q.units) FILTER (WHERE q.period = 'previous'), 0) AS previous_units
    FROM rq q
    GROUP BY q.reference
  ),
  bar_draw AS (
    SELECT b.period, COALESCE(SUM(COALESCE(r.value_change, 0)), 0) AS value
    FROM (VALUES ('current'), ('previous')) b(period)
    LEFT JOIN rows_all r ON r.period = b.period AND r.movement_type = 'Used' AND r.category = 'bar'
    GROUP BY b.period
  ),
  rq_period AS (
    SELECT b.period,
      COALESCE((SELECT SUM(q.value) FROM rq q WHERE q.period = b.period), 0)                        AS value,
      COALESCE((SELECT SUM(q.value) FROM rq q WHERE q.period = b.period AND q.category = 'bar'), 0) AS bar_value,
      COALESCE((SELECT jsonb_agg(DISTINCT q.reference) FROM rq q WHERE q.period = b.period), '[]'::jsonb) AS jobs
    FROM (VALUES ('current'), ('previous')) b(period)
  )
  SELECT jsonb_build_object(
    'range', jsonb_build_object(
      'start', p_start, 'end', p_end,
      'days', (p_end - p_start) + 1,
      'business_days', (SELECT COUNT(*) FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') d
                        WHERE EXTRACT(ISODOW FROM d) < 6)
    ),
    'prior', jsonb_build_object('start', v_prior_start, 'end', v_prior_end),
    'current',  (SELECT po.obj FROM period_obj po WHERE po.period = 'current'),
    'previous', (SELECT po.obj FROM period_obj po WHERE po.period = 'previous'),
    'receipts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'mv_date', r.mv_date, 'category', r.category, 'material', r.material,
               'lot_number', r.lot_number, 'qty_change', r.qty_change, 'unit_cost', r.unit_cost,
               'value_change', r.value_change, 'reference', r.reference, 'recorded_by', r.recorded_by)
             ORDER BY r.mv_date, r.category, r.material)
      FROM rows_all r WHERE r.period = 'current' AND r.movement_type = 'Received'), '[]'::jsonb),
    'bar_draws_by_material', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('material', d.material, 'units', d.units, 'value', ROUND(d.value, 2))
             ORDER BY d.value ASC, d.material)
      FROM draws d WHERE d.category = 'bar'), '[]'::jsonb),
    'blank_draws_by_material', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('material', d.material, 'units', d.units, 'value', ROUND(d.value, 2))
             ORDER BY d.value ASC, d.material)
      FROM draws d WHERE d.category = 'blank'), '[]'::jsonb),
    'top_jobs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('reference', t.reference, 'value', ROUND(t.value, 2), 'lines', t.lines)
             ORDER BY t.value ASC, t.reference)
      FROM (SELECT r.reference, SUM(COALESCE(r.value_change, 0)) AS value, COUNT(*) AS lines
            FROM rows_all r WHERE r.period = 'current' AND r.movement_type = 'Used'
            GROUP BY r.reference
            ORDER BY SUM(COALESCE(r.value_change, 0)) ASC, r.reference
            LIMIT 6) t), '[]'::jsonb),
    'requeue', jsonb_build_object(
      'current_value',     (SELECT ROUND(rp.value, 2)     FROM rq_period rp WHERE rp.period = 'current'),
      'current_bar_value', (SELECT ROUND(rp.bar_value, 2) FROM rq_period rp WHERE rp.period = 'current'),
      'current_share_of_bar_draw', (
        SELECT CASE WHEN bd.value = 0 THEN NULL ELSE ROUND(rp.bar_value / bd.value, 4) END
        FROM rq_period rp JOIN bar_draw bd ON bd.period = rp.period WHERE rp.period = 'current'),
      'jobs_current',      (SELECT rp.jobs FROM rq_period rp WHERE rp.period = 'current'),
      'previous_value',     (SELECT ROUND(rp.value, 2)     FROM rq_period rp WHERE rp.period = 'previous'),
      'previous_bar_value', (SELECT ROUND(rp.bar_value, 2) FROM rq_period rp WHERE rp.period = 'previous'),
      'previous_share_of_bar_draw', (
        SELECT CASE WHEN bd.value = 0 THEN NULL ELSE ROUND(rp.bar_value / bd.value, 4) END
        FROM rq_period rp JOIN bar_draw bd ON bd.period = rp.period WHERE rp.period = 'previous'),
      'jobs_previous',     (SELECT rp.jobs FROM rq_period rp WHERE rp.period = 'previous'),
      'by_job', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'reference', rj.reference,
                 'current_value',  ROUND(rj.current_value, 2),
                 'previous_value', ROUND(rj.previous_value, 2),
                 'total_value',    ROUND(rj.current_value + rj.previous_value, 2),
                 'current_units',  rj.current_units,
                 'previous_units', rj.previous_units)
               ORDER BY (rj.current_value + rj.previous_value) ASC, rj.reference)
        FROM rq_job rj), '[]'::jsonb)
    ),
    'quality', jsonb_build_object(
      'missing_cost_rows', (SELECT COUNT(*) FROM rows_all r WHERE r.period = 'current' AND r.value_change IS NULL),
      'adjustment_count',  (SELECT COUNT(*) FROM rows_all r WHERE r.period = 'current' AND r.movement_type = 'Adjustment'),
      'adjustment_value',  (SELECT ROUND(COALESCE(SUM(COALESCE(r.value_change, 0)), 0), 2) FROM rows_all r WHERE r.period = 'current' AND r.movement_type = 'Adjustment'),
      'recorders', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('name', x.name, 'count', x.cnt) ORDER BY x.cnt DESC, x.name)
        FROM (SELECT COALESCE(r.recorded_by, '(unknown)') AS name, COUNT(*) AS cnt
              FROM rows_all r WHERE r.period = 'current'
              GROUP BY COALESCE(r.recorded_by, '(unknown)')) x), '[]'::jsonb)
    )
  )
  INTO v_out;

  RETURN v_out;
END
$fn$;

REVOKE ALL ON FUNCTION public.report_inventory_movement_summary(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_inventory_movement_summary(date, date) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Registry row — upsert on slug (the Sep 4 SQL Editor run may have seeded it).
--    source_object is NOT NULL even for an interactive report, so it carries the
--    detail RPC's name. sort_order is set on insert only: a hand-tuned position
--    survives a re-run.
-- ---------------------------------------------------------------------------
INSERT INTO public.reports
  (slug, name, description, explainer, source_object, columns, order_by,
   view_roles, export_roles, report_kind, is_active, sort_order)
VALUES (
  'inventory-movement',
  'Inventory Movement (Bars & Blanks)',
  'Raw material in and out for any date range: receipts, production draws, and approved count adjustments, valued at lot cost — with a period summary and prior-period comparison.',
  'Received rows come from material receiving. Used rows are production draws against lots (job number cited when logged). Adjustments are approved count corrections, valued at the price captured at count time. A blank Unit Cost means the lot has no cost data and its value is not included in totals. Both report dates are inclusive; the comparison period is the immediately preceding range of equal length.',
  'report_inventory_movement',
  ARRAY['mv_date','category','material','lot_number','heat_number','movement_type',
        'qty_change','unit_cost','value_change','reference','recorded_by','notes'],
  '[]'::jsonb,
  '{}',
  ARRAY['admin','president','scheduler','compliance','customer_service','purchaser'],
  'inventory_movement',
  true,
  (SELECT COALESCE(MAX(r.sort_order), 0) + 10 FROM public.reports r WHERE r.slug <> 'inventory-movement')
)
ON CONFLICT (slug) DO UPDATE SET
  name          = EXCLUDED.name,
  description   = EXCLUDED.description,
  explainer     = EXCLUDED.explainer,
  source_object = EXCLUDED.source_object,
  columns       = EXCLUDED.columns,
  order_by      = EXCLUDED.order_by,
  view_roles    = EXCLUDED.view_roles,
  export_roles  = EXCLUDED.export_roles,
  report_kind   = EXCLUDED.report_kind,
  is_active     = true,
  updated_at    = now();

-- ---------------------------------------------------------------------------
-- 4. Verification — EXCEPTION on any failure; commit only if all pass.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_expected text[] := ARRAY['mv_date','category','material','lot_number','heat_number','movement_type',
                             'qty_change','unit_cost','value_change','reference','recorded_by','notes'];
  v_fn_cols    text[];
  v_seed_cols  text[];
  v_kind       text;
  v_src        text;
  v_lo         date := CURRENT_DATE - 180;
  v_hi         date := CURRENT_DATE;
  v_sum        jsonb;
  v_rows       bigint;
  v_net        numeric;
  v_bars       numeric;
  v_blanks     numeric;
BEGIN
  -- [1/8] both functions exist, SECURITY DEFINER, STABLE, search_path pinned
  IF (SELECT count(*) FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('report_inventory_movement','report_inventory_movement_summary')
        AND p.prosecdef
        AND p.provolatile = 's'
        AND 'search_path=public' = ANY (COALESCE(p.proconfig, ARRAY[]::text[]))) <> 2 THEN
    RAISE EXCEPTION 'CHECK 1 FAILED: RPCs missing, or not SECURITY DEFINER / STABLE / search_path-pinned';
  END IF;

  -- [2/8] anon holds no EXECUTE on either RPC
  IF EXISTS (
      SELECT 1 FROM information_schema.routine_privileges
      WHERE specific_schema = 'public'
        AND routine_name IN ('report_inventory_movement','report_inventory_movement_summary')
        AND grantee = 'anon') THEN
    RAISE EXCEPTION 'CHECK 2 FAILED: anon still holds EXECUTE on a report RPC';
  END IF;

  -- [3/8] detail RPC output columns == the 12-column CSV contract, in order
  SELECT array_agg(a.nm ORDER BY a.ord) INTO v_fn_cols
  FROM pg_proc p,
       LATERAL unnest(p.proargnames, p.proargmodes) WITH ORDINALITY AS a(nm, md, ord)
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'report_inventory_movement'
    AND a.md = 't';
  IF v_fn_cols IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'CHECK 3 FAILED: detail RPC columns = %, expected %', v_fn_cols, v_expected;
  END IF;

  -- [4/8] registry row present, active, dispatching, and CSV-contract aligned
  SELECT r.columns, r.report_kind, r.source_object INTO v_seed_cols, v_kind, v_src
  FROM public.reports r WHERE r.slug = 'inventory-movement' AND r.is_active;
  IF v_seed_cols IS NULL THEN
    RAISE EXCEPTION 'CHECK 4 FAILED: inventory-movement registry row missing or inactive';
  END IF;
  IF v_seed_cols IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'CHECK 4 FAILED: registry columns = %, expected %', v_seed_cols, v_expected;
  END IF;
  IF v_kind IS DISTINCT FROM 'inventory_movement' OR v_src IS DISTINCT FROM 'report_inventory_movement' THEN
    RAISE EXCEPTION 'CHECK 4 FAILED: report_kind = % / source_object = %', v_kind, v_src;
  END IF;

  -- [5/8] both RPCs execute over a live 180-day window
  SELECT count(*) INTO v_rows FROM public.report_inventory_movement(v_lo, v_hi);
  v_sum := public.report_inventory_movement_summary(v_lo, v_hi);
  IF v_sum IS NULL THEN
    RAISE EXCEPTION 'CHECK 5 FAILED: summary RPC returned NULL';
  END IF;

  -- [6/8] summary.current.movements == detail row count (one definition of a movement)
  IF (v_sum -> 'current' ->> 'movements')::bigint IS DISTINCT FROM v_rows THEN
    RAISE EXCEPTION 'CHECK 6 FAILED: summary movements = %, detail rows = %',
      (v_sum -> 'current' ->> 'movements'), v_rows;
  END IF;

  -- [7/8] integrity: detail Σ value_change == summary.current.net_value == bars + blanks
  SELECT ROUND(COALESCE(SUM(COALESCE(m.value_change, 0)), 0), 2) INTO v_net
  FROM public.report_inventory_movement(v_lo, v_hi) m;
  v_bars   := (v_sum -> 'current' -> 'bars'   ->> 'net_value')::numeric;
  v_blanks := (v_sum -> 'current' -> 'blanks' ->> 'net_value')::numeric;
  IF (v_sum -> 'current' ->> 'net_value')::numeric IS DISTINCT FROM v_net THEN
    RAISE EXCEPTION 'CHECK 7 FAILED: summary net_value = %, detail Σ = %',
      (v_sum -> 'current' ->> 'net_value'), v_net;
  END IF;
  IF ROUND(v_bars + v_blanks, 2) IS DISTINCT FROM v_net THEN
    RAISE EXCEPTION 'CHECK 7 FAILED: bars (%) + blanks (%) <> net (%)', v_bars, v_blanks, v_net;
  END IF;

  -- [8/8] prior period is the immediately preceding range of equal length
  IF (v_sum -> 'prior' ->> 'end')::date   IS DISTINCT FROM v_lo - 1
  OR (v_sum -> 'prior' ->> 'start')::date IS DISTINCT FROM (v_lo - 1) - (v_hi - v_lo)
  OR (v_sum -> 'range' ->> 'days')::int   IS DISTINCT FROM (v_hi - v_lo) + 1 THEN
    RAISE EXCEPTION 'CHECK 8 FAILED: prior/range arithmetic wrong: %', v_sum -> 'prior';
  END IF;
END $verify$;

COMMIT;

-- Final result set (the SQL Editor shows only the last statement — reaching
-- this SELECT means every check above passed without exception).
SELECT 'D-RPT-14 INVENTORY MOVEMENT MIGRATION VERIFIED' AS status,
       (SELECT count(*) FROM public.report_inventory_movement(CURRENT_DATE - 180, CURRENT_DATE)) AS movements_180d,
       (SELECT r.sort_order FROM public.reports r WHERE r.slug = 'inventory-movement')           AS sort_order,
       public.report_inventory_movement_summary(CURRENT_DATE - 6, CURRENT_DATE) -> 'current'     AS last_7_days;
