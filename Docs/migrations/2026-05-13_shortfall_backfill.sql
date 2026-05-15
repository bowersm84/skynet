-- =====================================================================
-- Shortfall workflow backfill
-- Run AFTER 2026-05-13_shortfall_workflow.sql and AFTER the B0 + B + C
-- code drops have shipped to PROD (so the kiosk no longer creates new
-- 'incomplete' jobs, and the shortfall evaluator helper is live).
--
-- This script:
--  1. Migrates any historical jobs.status='incomplete' rows to
--     'manufacturing_complete', preserving their good_pieces /
--     bad_pieces / actual_end values. The 'incomplete' status stays
--     in the database as a valid (but unused-going-forward) value.
--  2. Synthesises wo_shortfall_resolutions rows for WOs that already
--     produced less than (order_quantity + stock_quantity) but never
--     captured a shortfall — so the new Shortfalls tab surfaces them.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Flip lingering 'incomplete' jobs forward.
--    These were created by the old kiosk flow. Treat them as completed
--    with whatever good_pieces was recorded. assigned_machine_id was
--    cleared by the old flow, which is fine — they're terminal now.
-- ---------------------------------------------------------------------
UPDATE public.jobs
   SET status = 'manufacturing_complete',
       updated_at = now()
 WHERE status = 'incomplete';

-- ---------------------------------------------------------------------
-- 2. Synthesise shortfall rows for WOs where:
--      - every live job has reached pending_tco / complete /
--        ready_for_assembly / ready_for_outsource / in_assembly /
--        manufacturing_complete
--      - aggregate produced < target
--      - no open or resolved shortfall row already exists
-- ---------------------------------------------------------------------
WITH wo_status AS (
  SELECT j.work_order_id,
         bool_and(
           j.status IN (
             'pending_tco', 'complete',
             'ready_for_assembly', 'ready_for_outsource',
             'in_assembly', 'manufacturing_complete'
           )
         ) AS all_done,
         SUM(COALESCE(j.post_mfg_good_qty, j.good_pieces, 0)) AS produced
    FROM public.jobs j
   WHERE j.status <> 'cancelled'
   GROUP BY j.work_order_id
),
candidates AS (
  SELECT wo.id AS work_order_id,
         COALESCE(wo.order_quantity, 0) + COALESCE(wo.stock_quantity, 0) AS target,
         ws.produced
    FROM public.work_orders wo
    JOIN wo_status ws ON ws.work_order_id = wo.id
   WHERE ws.all_done
     AND wo.status <> 'cancelled'
     AND COALESCE(wo.order_quantity, 0) + COALESCE(wo.stock_quantity, 0) > 0
     AND ws.produced < COALESCE(wo.order_quantity, 0) + COALESCE(wo.stock_quantity, 0)
     AND NOT EXISTS (
           SELECT 1 FROM public.wo_shortfall_resolutions r
            WHERE r.work_order_id = wo.id
         )
),
shortfall_type AS (
  SELECT c.work_order_id,
         c.target,
         c.produced,
         CASE WHEN EXISTS (
                SELECT 1
                  FROM public.customer_order_allocations a
                  JOIN public.customer_order_lines l
                    ON l.id = a.customer_order_line_id
                 WHERE a.work_order_id = c.work_order_id
                   AND a.is_active = true
                   AND COALESCE(l.quantity_ordered, 0)
                     - COALESCE(l.quantity_fulfilled, 0) > 0
              )
              THEN 'demand'
              ELSE 'plan_only'
         END AS shortfall_type
    FROM candidates c
)
INSERT INTO public.wo_shortfall_resolutions (
  work_order_id, shortfall_type, target_quantity,
  produced_quantity, shortfall_quantity, status
)
SELECT work_order_id,
       shortfall_type,
       target,
       produced,
       target - produced,
       'open'
  FROM shortfall_type;

-- Flip the marker flag on every WO that got a new open row above.
UPDATE public.work_orders
   SET has_open_shortfall = true
 WHERE id IN (
   SELECT work_order_id
     FROM public.wo_shortfall_resolutions
    WHERE status = 'open'
 );

COMMIT;

-- ---------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------
SELECT 'jobs still in incomplete' AS metric, COUNT(*) AS count
  FROM public.jobs WHERE status = 'incomplete';

SELECT 'open shortfalls (demand)' AS metric, COUNT(*) AS count
  FROM public.wo_shortfall_resolutions
 WHERE status = 'open' AND shortfall_type = 'demand';

SELECT 'open shortfalls (plan_only)' AS metric, COUNT(*) AS count
  FROM public.wo_shortfall_resolutions
 WHERE status = 'open' AND shortfall_type = 'plan_only';

SELECT 'work_orders with has_open_shortfall=true' AS metric, COUNT(*) AS count
  FROM public.work_orders WHERE has_open_shortfall = true;
