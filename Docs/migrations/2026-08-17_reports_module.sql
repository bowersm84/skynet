-- ============================================================================
-- REPORTS MODULE — registry table + report_open_demand view  (Batch A)
-- Run in: Supabase SQL Editor, TEST first, then PROD after frontend verification.
-- Read-only against production data; creates two new objects and one seed row.
-- All checks raise EXCEPTION on failure; reaching the final SELECT proves pass.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Registry table
-- ---------------------------------------------------------------------------
CREATE TABLE public.reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  description   text,
  explainer     text,
  source_object text NOT NULL,
  columns       text[] NOT NULL,
  order_by      jsonb NOT NULL DEFAULT '[]'::jsonb,
  view_roles    text[] NOT NULL DEFAULT '{}',   -- empty = all authenticated roles
  export_roles  text[] NOT NULL DEFAULT '{}',
  sort_order    integer NOT NULL DEFAULT 100,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY reports_select ON public.reports
  FOR SELECT TO authenticated USING (true);
-- No INSERT/UPDATE/DELETE policies: registry writes happen only via
-- migrations / service role, by design.

REVOKE ALL ON public.reports FROM anon, public;
GRANT SELECT ON public.reports TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Report view — verbatim port of Skybolt_SkyNet_Backlog_v1_1.sql.
--    Sole deviation (D-RPT-03): scheduled_finish cast ::date per output
--    contract rule "dates bare YYYY-MM-DD".
-- ---------------------------------------------------------------------------
CREATE VIEW public.report_open_demand
WITH (security_invoker = on)
AS
SELECT
    co.co_number                                   AS co_number,
    co.fishbowl_order_id                           AS fishbowl_so,
    co.po_number                                   AS customer_po,
    cust.customer_id                               AS customer_number,
    cust.name                                      AS customer_name,
    sp.username                                    AS salesperson,
    co.status                                      AS co_status,
    l.line_number                                  AS line_number,
    p.part_number                                  AS part_number,
    l.quantity_ordered                             AS qty_ordered,
    l.quantity_fulfilled                           AS qty_fulfilled,
    (l.quantity_ordered - l.quantity_fulfilled)    AS qty_open,
    l.due_date                                     AS due_date,
    l.created_at::date                             AS entered_date,
    l.status                                       AS line_status,
    l.priority                                     AS priority,
    COALESCE(alloc.qty_allocated, 0)               AS qty_allocated_active,
    COALESCE(alloc.wo_count, 0)                    AS wo_count,
    alloc.wo_numbers                               AS wo_numbers,
    alloc.wo_statuses                              AS wo_statuses,
    alloc.wo_due                                   AS wo_due_date,
    alloc.scheduled_finish                         AS scheduled_finish,
    COALESCE(alloc.produced_good, 0)               AS produced_good_pieces,
    alloc.job_statuses                             AS job_statuses
FROM customer_order_lines l
JOIN customer_orders co ON co.id = l.customer_order_id
JOIN customers cust ON cust.id = co.customer_id
LEFT JOIN profiles sp ON sp.id = co.salesperson_id
LEFT JOIN parts p ON p.id = l.part_id
LEFT JOIN LATERAL (
    SELECT
        SUM(a.quantity_allocated)                  AS qty_allocated,
        COUNT(DISTINCT w.id)                       AS wo_count,
        STRING_AGG(DISTINCT w.wo_number, ', ')     AS wo_numbers,
        STRING_AGG(DISTINCT w.status, ', ')        AS wo_statuses,
        MIN(w.due_date)                            AS wo_due,
        MAX(j.scheduled_end)::date                 AS scheduled_finish,
        SUM(j.good_pieces)                         AS produced_good,
        STRING_AGG(DISTINCT j.status, ', ')        AS job_statuses
    FROM customer_order_allocations a
    JOIN work_orders w ON w.id = a.work_order_id
    LEFT JOIN jobs j ON j.work_order_id = w.id
                    AND j.status NOT IN ('cancelled', 'merged')
    WHERE a.customer_order_line_id = l.id
      AND a.is_active
) alloc ON true
WHERE l.status NOT IN ('complete', 'cancelled')
ORDER BY l.due_date NULLS LAST, co.co_number, l.line_number;

REVOKE ALL ON public.report_open_demand FROM anon, public;
GRANT SELECT ON public.report_open_demand TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Seed row
-- ---------------------------------------------------------------------------
INSERT INTO public.reports
  (slug, name, description, explainer, source_object, columns, order_by,
   view_roles, export_roles, sort_order)
VALUES
  ('open-demand',
   'Open Demand / Backlog',
   'Open customer order lines with allocation, work order, and job rollup. Weekly reporting.',
   'Each row is one open customer order line — an ordered part Skybolt has not yet fully shipped. qty_open is the quantity still owed. The allocation columns show which work orders and jobs are producing against the line; a line showing 0 work orders has nothing in production yet. Parts Skybolt buys rather than makes never appear here by design — SkyNet tracks manufactured demand only, so this is the make-side backlog, not the full sales backlog.',
   'report_open_demand',
   ARRAY['co_number','fishbowl_so','customer_po','customer_number','customer_name',
         'salesperson','co_status','line_number','part_number','qty_ordered',
         'qty_fulfilled','qty_open','due_date','entered_date','line_status',
         'priority','qty_allocated_active','wo_count','wo_numbers','wo_statuses',
         'wo_due_date','scheduled_finish','produced_good_pieces','job_statuses'],
   '[{"column":"due_date","ascending":true,"nullsFirst":false},
     {"column":"co_number","ascending":true},
     {"column":"line_number","ascending":true}]'::jsonb,
   '{}',
   ARRAY['admin','president','scheduler'],
   10);

-- ---------------------------------------------------------------------------
-- 4. Verification — EXCEPTION on any failure; commit only if all pass.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_expected text[] := ARRAY['co_number','fishbowl_so','customer_po','customer_number',
    'customer_name','salesperson','co_status','line_number','part_number','qty_ordered',
    'qty_fulfilled','qty_open','due_date','entered_date','line_status','priority',
    'qty_allocated_active','wo_count','wo_numbers','wo_statuses','wo_due_date',
    'scheduled_finish','produced_good_pieces','job_statuses'];
  v_cols text[]; v_seed_cols text[];
  v_view_cnt int; v_inline_cnt int;
  v_view_fp text; v_inline_fp text;
BEGIN
  -- [1/7] registry table exists with RLS enabled
  IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'reports'
        AND c.relkind = 'r' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'CHECK 1 FAILED: reports table missing or RLS disabled';
  END IF;

  -- [2/7] view exists with security_invoker=on
  IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'report_open_demand'
        AND c.relkind = 'v' AND 'security_invoker=on' = ANY (c.reloptions)) THEN
    RAISE EXCEPTION 'CHECK 2 FAILED: report_open_demand missing or not security_invoker';
  END IF;

  -- [3/7] anon holds zero privileges on both objects
  IF EXISTS (
      SELECT 1 FROM information_schema.table_privileges
      WHERE table_schema = 'public'
        AND table_name IN ('reports','report_open_demand')
        AND grantee = 'anon') THEN
    RAISE EXCEPTION 'CHECK 3 FAILED: anon still holds privileges';
  END IF;

  -- [4/7] seed row present and active
  SELECT columns INTO v_seed_cols
  FROM public.reports WHERE slug = 'open-demand' AND is_active;
  IF v_seed_cols IS NULL THEN
    RAISE EXCEPTION 'CHECK 4 FAILED: open-demand seed row missing';
  END IF;

  -- [5/7] view column order == registry columns == output contract (24 exact)
  SELECT array_agg(column_name::text ORDER BY ordinal_position) INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'report_open_demand';
  IF v_cols IS DISTINCT FROM v_expected OR v_seed_cols IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'CHECK 5 FAILED: column list/order mismatch. view=% seed=%', v_cols, v_seed_cols;
  END IF;

  -- [6/7] row-count parity: view vs inline base predicate
  SELECT count(*) INTO v_view_cnt FROM public.report_open_demand;
  SELECT count(*) INTO v_inline_cnt
  FROM customer_order_lines l
  JOIN customer_orders co ON co.id = l.customer_order_id
  WHERE l.status NOT IN ('complete','cancelled');
  IF v_view_cnt IS DISTINCT FROM v_inline_cnt THEN
    RAISE EXCEPTION 'CHECK 6 FAILED: view rows=% inline rows=%', v_view_cnt, v_inline_cnt;
  END IF;

  -- [7/7] fingerprint parity on (co_number|line_number)
  SELECT md5(string_agg(co_number || '|' || line_number::text, ','
             ORDER BY co_number, line_number)) INTO v_view_fp
  FROM public.report_open_demand;
  SELECT md5(string_agg(co.co_number || '|' || l.line_number::text, ','
             ORDER BY co.co_number, l.line_number)) INTO v_inline_fp
  FROM customer_order_lines l
  JOIN customer_orders co ON co.id = l.customer_order_id
  WHERE l.status NOT IN ('complete','cancelled');
  IF v_view_fp IS DISTINCT FROM v_inline_fp THEN
    RAISE EXCEPTION 'CHECK 7 FAILED: fingerprint mismatch view=% inline=%', v_view_fp, v_inline_fp;
  END IF;
END $$;

COMMIT;

-- Final result set (the SQL Editor shows only the last statement — reaching
-- this SELECT means every check above passed without exception).
SELECT 'REPORTS MODULE MIGRATION VERIFIED' AS status,
       (SELECT count(*) FROM public.report_open_demand) AS open_demand_rows,
       (SELECT md5(string_agg(co_number || '|' || line_number::text, ','
                   ORDER BY co_number, line_number))
          FROM public.report_open_demand) AS fingerprint;
