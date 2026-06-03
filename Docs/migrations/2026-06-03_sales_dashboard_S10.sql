-- ============================================================================
-- Migration: 2026-06-03_sales_dashboard_S10.sql  (v3 - self-contained, split-safe)
-- Sprint 10 Sales Dashboard. Run in Supabase SQL Editor on TEST first, eyeball the
-- verification block at the bottom, then run the identical file on PROD.
--
-- SELF-CONTAINED: creates all seven views the dashboard depends on, in dependency
-- order (helpers first). All CREATE OR REPLACE / idempotent. Legacy report variants
-- v_sales_weekly_report (v1) and _v2 are intentionally NOT included.
--
-- SPLIT-SAFE: no semicolons appear inside comments or string literals, only as
-- statement terminators (this runner treats every semicolon as a hard boundary).
--
-- S10 changes vs the originals:
--   * v_sales_active_production : exclude pending_tco.
--   * v_sales_weekly_report_v3  : exclude pending_tco in the Section B inline rollup
--                                 AND append a priority column to all three sections.
--   * v_sales_mts_production    : NEW standalone Make-to-Stock area.
--   * GRANT SELECT TO authenticated on all seven views.
-- ============================================================================

CREATE OR REPLACE VIEW v_sales_wo_salesperson AS
WITH wo_alloc AS (
  SELECT
    coa.work_order_id,
    co.salesperson_id,
    SUM(coa.quantity_allocated)::int      AS qty_allocated_to_salesperson,
    MIN(col.due_date)                     AS earliest_co_due_date,
    STRING_AGG(DISTINCT cust.name, ', '
               ORDER BY cust.name)        AS customer_names,
    STRING_AGG(DISTINCT co.co_number, ', '
               ORDER BY co.co_number)     AS co_numbers,
    STRING_AGG(DISTINCT co.po_number, ', '
               ORDER BY co.po_number)
               FILTER (WHERE co.po_number IS NOT NULL) AS po_numbers
  FROM customer_order_allocations coa
  JOIN customer_order_lines       col  ON col.id = coa.customer_order_line_id
  JOIN customer_orders            co   ON co.id  = col.customer_order_id
  JOIN customers                  cust ON cust.id = co.customer_id
  WHERE coa.is_active = true
    AND col.status   <> 'cancelled'
    AND co.status    <> 'cancelled'
  GROUP BY coa.work_order_id, co.salesperson_id
)
SELECT
  wo.id                          AS work_order_id,
  wo.wo_number,
  wa.salesperson_id,
  p.full_name                    AS salesperson_name,
  p.email                        AS salesperson_email,
  wa.qty_allocated_to_salesperson,
  wa.earliest_co_due_date,
  wa.customer_names,
  wa.co_numbers,
  wa.po_numbers,
  wo.is_combined
FROM work_orders wo
LEFT JOIN wo_alloc wa ON wa.work_order_id = wo.id
LEFT JOIN profiles p  ON p.id            = wa.salesperson_id;

COMMENT ON VIEW v_sales_wo_salesperson IS
  'WO->Salesperson map. Multi-CO WOs return one row per salesperson with their allocated share. WOs without CO allocations return one row with NULL salesperson.';

CREATE OR REPLACE VIEW v_sales_job_effective_qty AS
SELECT
  j.id AS job_id,
  GREATEST(
    COALESCE(j.good_pieces, 0),
    COALESCE(
      (SELECT SUM(fs.compliance_good_qty)::int
         FROM finishing_sends fs
        WHERE fs.job_id = j.id
          AND fs.compliance_status = 'approved'),
      0)
  ) AS effective_good_qty
FROM jobs j;

CREATE OR REPLACE VIEW v_sales_active_production AS
SELECT
  -- Salesperson grouping
  COALESCE(sp.salesperson_name, 'Unassigned / Stock') AS salesperson_name,
  sp.salesperson_id,

  -- Customer / order references
  COALESCE(sp.customer_names, wo.customer, '—')       AS customer,
  sp.co_numbers,
  sp.po_numbers,
  wo.wo_number,
  j.job_number,

  -- Part
  pt.part_number,
  pt.description                                      AS part_description,
  pt.part_type,

  -- Quantities
  COALESCE(sp.qty_allocated_to_salesperson, wo.order_quantity, j.quantity)
                                                      AS sales_qty,         -- this salespersons share
  wo.order_quantity                                   AS wo_order_qty,      -- full WO size
  j.quantity                                          AS job_qty,           -- job size (may differ for split/multi-batch)
  eq.effective_good_qty                               AS good_pieces_so_far,
  CASE
    WHEN COALESCE(j.quantity, 0) = 0 THEN NULL
    ELSE ROUND((eq.effective_good_qty::numeric / j.quantity) * 100, 0)
  END                                                 AS pct_complete,

  -- Status + production phase (sales-friendly bucketing)
  j.status                                            AS job_status_raw,
  CASE
    WHEN j.status IN ('pending_compliance','ready','assigned')
         THEN '1. Waiting to Run'
    WHEN j.status IN ('in_setup','in_progress')
         THEN '2. In Machining'
    WHEN j.status IN ('manufacturing_complete','pending_passivation',
                      'in_passivation','pending_post_manufacturing')
         THEN '3. Finishing / QC'
    WHEN j.status IN ('ready_for_outsourcing','at_external_vendor')
         THEN '4. Outsourced'
    WHEN j.status IN ('ready_for_assembly','in_assembly')
         THEN '5. Assembly'
    WHEN j.status = 'pending_tco'
         THEN '6. Pending TCO'
    ELSE  '?. ' || j.status
  END                                                 AS production_phase,

  -- Dates — what sales/CS care about
  COALESCE(sp.earliest_co_due_date, wo.due_date)      AS customer_due_date,
  wo.due_date                                         AS wo_due_date,
  j.scheduled_start,
  j.scheduled_end,
  j.actual_start,
  j.actual_end,

  -- Due-date aging bucket (relative to TODAY)
  CASE
    WHEN COALESCE(sp.earliest_co_due_date, wo.due_date) IS NULL THEN '0. No Due Date'
    WHEN COALESCE(sp.earliest_co_due_date, wo.due_date) <  CURRENT_DATE
         THEN '1. PAST DUE'
    WHEN COALESCE(sp.earliest_co_due_date, wo.due_date) <= CURRENT_DATE + INTERVAL '7 days'
         THEN '2. Due This Week'
    WHEN COALESCE(sp.earliest_co_due_date, wo.due_date) <= CURRENT_DATE + INTERVAL '14 days'
         THEN '3. Due Next Week'
    WHEN COALESCE(sp.earliest_co_due_date, wo.due_date) <= CURRENT_DATE + INTERVAL '28 days'
         THEN '4. Due in 2-4 Weeks'
    ELSE '5. 4+ Weeks Out'
  END                                                 AS due_bucket,

  (COALESCE(sp.earliest_co_due_date, wo.due_date) - CURRENT_DATE) AS days_to_due,

  -- WO priority + flags
  wo.priority                                         AS wo_priority,
  j.priority                                          AS job_priority,
  wo.is_combined,
  wo.has_open_shortfall,
  wo.has_cancelled_allocation,
  j.documents_deferred,

  -- Machine / location
  m.name                                              AS assigned_machine,
  ml.name                                             AS machine_location,

  -- Stuck-job heuristic: setup or in-progress for >7 days
  CASE
    WHEN j.status IN ('in_setup','in_progress')
     AND j.actual_start IS NOT NULL
     AND j.actual_start < NOW() - INTERVAL '7 days' THEN true
    ELSE false
  END                                                 AS appears_stalled

FROM jobs j
JOIN work_orders wo                ON wo.id = j.work_order_id
LEFT JOIN v_sales_wo_salesperson sp ON sp.work_order_id = wo.id
LEFT JOIN v_sales_job_effective_qty eq ON eq.job_id = j.id

-- Part resolution: assembly WO → job component → CO line SKU (fallback chain)
-- jobs.part_id is often NULL for assembly WOs since the finished product lives
-- on work_order_assemblies.assembly_id. The CO line is the final safety net.
LEFT JOIN LATERAL (
  SELECT p.part_number, p.description, p.part_type
  FROM parts p
  WHERE p.id = COALESCE(
    (SELECT wa.assembly_id FROM work_order_assemblies wa
       WHERE wa.work_order_id = wo.id
       ORDER BY wa.created_at
       LIMIT 1),
    j.part_id,
    (SELECT col.part_id FROM customer_order_allocations coa
       JOIN customer_order_lines col ON col.id = coa.customer_order_line_id
       WHERE coa.work_order_id = wo.id
         AND coa.is_active = true
       LIMIT 1)
  )
) pt ON true

LEFT JOIN machines m                ON m.id = j.assigned_machine_id
LEFT JOIN locations ml              ON ml.id = m.location_id
WHERE j.status NOT IN ('complete','cancelled','incomplete','pending_tco')
  AND COALESCE(wo.status,'') NOT IN ('cancelled','closed','shipped')
  AND COALESCE(j.is_maintenance, false) = false;

COMMENT ON VIEW v_sales_active_production IS
  'Section 1 of weekly sales report — all in-flight jobs joined to salesperson via CO allocations. One row per (job, salesperson) for multi-CO WOs.';

CREATE OR REPLACE VIEW v_sales_open_demand AS
WITH allocated AS (
  SELECT
    coa.customer_order_line_id,
    SUM(coa.quantity_allocated)::int AS qty_active_allocated
  FROM customer_order_allocations coa
  WHERE coa.is_active = true
  GROUP BY coa.customer_order_line_id
)
SELECT
  -- Salesperson
  COALESCE(p.full_name, 'Unassigned') AS salesperson_name,
  co.salesperson_id,

  -- Customer / order
  cust.name                          AS customer,
  cust.customer_id                   AS customer_code,
  co.co_number,
  co.po_number,
  co.fishbowl_order_id,
  col.line_number,

  -- Part
  pt.part_number,
  pt.description                     AS part_description,
  pt.part_type,

  -- Quantities
  col.quantity_ordered,
  col.quantity_fulfilled,
  COALESCE(a.qty_active_allocated, 0)                                              AS qty_in_production,
  GREATEST(0,
           col.quantity_ordered
           - col.quantity_fulfilled
           - COALESCE(a.qty_active_allocated, 0))                                  AS qty_open_demand,

  -- Status / priority
  col.status                         AS line_status,
  co.status                          AS co_status,
  col.priority,

  -- Dates
  col.due_date                       AS line_due_date,
  CASE
    WHEN col.due_date IS NULL                                  THEN '0. No Due Date'
    WHEN col.due_date <  CURRENT_DATE                          THEN '1. PAST DUE'
    WHEN col.due_date <= CURRENT_DATE + INTERVAL '7 days'      THEN '2. Due This Week'
    WHEN col.due_date <= CURRENT_DATE + INTERVAL '14 days'     THEN '3. Due Next Week'
    WHEN col.due_date <= CURRENT_DATE + INTERVAL '28 days'     THEN '4. Due in 2-4 Weeks'
    ELSE                                                            '5. 4+ Weeks Out'
  END                                AS due_bucket,
  (col.due_date - CURRENT_DATE)      AS days_to_due,

  co.created_at::date                AS co_created_date,
  (CURRENT_DATE - co.created_at::date) AS age_days,
  col.notes                          AS line_notes,
  col.components_needed

FROM customer_order_lines col
JOIN customer_orders     co   ON co.id   = col.customer_order_id
JOIN customers           cust ON cust.id = co.customer_id
JOIN parts               pt   ON pt.id   = col.part_id
LEFT JOIN profiles       p    ON p.id    = co.salesperson_id
LEFT JOIN allocated      a    ON a.customer_order_line_id = col.id
WHERE col.status IN ('not_started','in_progress')
  AND co.status  IN ('not_started','in_progress')
  -- Only show lines where theres still un-allocated, un-fulfilled qty:
  AND GREATEST(0,
               col.quantity_ordered
               - col.quantity_fulfilled
               - COALESCE(a.qty_active_allocated, 0)) > 0;

COMMENT ON VIEW v_sales_open_demand IS
  'Section 2 of weekly sales report — CO lines with un-allocated, un-fulfilled qty awaiting WO creation.';

CREATE OR REPLACE VIEW v_sales_summary_by_person AS
WITH prod AS (
  SELECT salesperson_name,
         salesperson_id,
         COUNT(*)                                                          AS active_jobs,
         COUNT(*) FILTER (WHERE due_bucket = '1. PAST DUE')                AS past_due_jobs,
         COUNT(*) FILTER (WHERE due_bucket = '2. Due This Week')           AS due_this_week,
         COUNT(*) FILTER (WHERE appears_stalled)                            AS stalled_jobs,
         COUNT(*) FILTER (WHERE documents_deferred)                         AS docs_deferred,
         COUNT(DISTINCT wo_number)                                          AS active_wos
    FROM v_sales_active_production
   GROUP BY salesperson_name, salesperson_id
),
dem AS (
  SELECT salesperson_name,
         salesperson_id,
         COUNT(*)                                                          AS open_demand_lines,
         SUM(qty_open_demand)::int                                          AS open_demand_qty,
         COUNT(*) FILTER (WHERE due_bucket = '1. PAST DUE')                AS demand_past_due,
         MIN(line_due_date)                                                AS earliest_demand_due_date,
         MAX(age_days)                                                     AS oldest_demand_age_days
    FROM v_sales_open_demand
   GROUP BY salesperson_name, salesperson_id
),
keys AS (
  SELECT salesperson_name, salesperson_id FROM prod
  UNION
  SELECT salesperson_name, salesperson_id FROM dem
)
SELECT
  k.salesperson_name,
  k.salesperson_id,
  COALESCE(p.active_jobs, 0)        AS active_jobs,
  COALESCE(p.active_wos, 0)         AS active_wos,
  COALESCE(p.past_due_jobs, 0)      AS past_due_jobs,
  COALESCE(p.due_this_week, 0)      AS due_this_week,
  COALESCE(p.stalled_jobs, 0)       AS stalled_jobs,
  COALESCE(p.docs_deferred, 0)      AS docs_deferred,
  COALESCE(d.open_demand_lines, 0)  AS open_demand_lines,
  COALESCE(d.open_demand_qty, 0)    AS open_demand_qty,
  COALESCE(d.demand_past_due, 0)    AS demand_past_due,
  d.earliest_demand_due_date,
  d.oldest_demand_age_days
FROM keys k
LEFT JOIN prod p
       ON p.salesperson_name = k.salesperson_name
      AND p.salesperson_id IS NOT DISTINCT FROM k.salesperson_id
LEFT JOIN dem  d
       ON d.salesperson_name = k.salesperson_name
      AND d.salesperson_id IS NOT DISTINCT FROM k.salesperson_id;

COMMENT ON VIEW v_sales_summary_by_person IS
  'One-row-per-salesperson scorecard. Use as the header of each printable report page.';

CREATE OR REPLACE VIEW v_sales_weekly_report_v3 AS

-- --- A. Scorecard ----------------------------------------------------------
SELECT
  'A. Scorecard'                          AS section,
  salesperson_name,
  NULL::text AS customer, NULL::text AS co_number, NULL::text AS po_number,
  NULL::int  AS line_number,
  NULL::text AS part_number, NULL::text AS part_description,
  NULL::int  AS co_qty_ordered, NULL::date AS co_due_date,
  NULL::text AS due_bucket, NULL::int AS days_to_due,
  NULL::text AS row_type,
  NULL::text AS wo_numbers, NULL::int AS job_count,
  NULL::text AS production_phase, NULL::text AS machines,
  active_jobs AS qty_this_row,
  NULL::int  AS good_pieces, NULL::int AS pct_complete,
  NULL::date AS earliest_sched_start, NULL::date AS latest_sched_end,
  ('Active: ' || active_jobs || ' jobs / ' || active_wos || ' WOs'
   || ' | Past due: ' || past_due_jobs
   || ' | This wk: ' || due_this_week
   || ' | Stalled: ' || stalled_jobs
   || ' | Demand: ' || open_demand_lines || ' lines / '
   || open_demand_qty || ' pcs')          AS flags_or_notes,
  NULL::text                              AS priority
FROM v_sales_summary_by_person

UNION ALL

-- --- B. Production rolled up to CO line ------------------------------------
SELECT
  'B. Production'                         AS section,
  COALESCE(p.full_name, 'Unassigned')     AS salesperson_name,
  cust.name                               AS customer,
  co.co_number, co.po_number, col.line_number,
  pt.part_number, pt.description          AS part_description,
  col.quantity_ordered                    AS co_qty_ordered,
  col.due_date                            AS co_due_date,
  CASE
    WHEN col.due_date IS NULL                              THEN '0. No Due Date'
    WHEN col.due_date <  CURRENT_DATE                      THEN '1. PAST DUE'
    WHEN col.due_date <= CURRENT_DATE + INTERVAL '7 days'  THEN '2. Due This Week'
    WHEN col.due_date <= CURRENT_DATE + INTERVAL '14 days' THEN '3. Due Next Week'
    WHEN col.due_date <= CURRENT_DATE + INTERVAL '28 days' THEN '4. Due in 2-4 Weeks'
    ELSE                                                        '5. 4+ Weeks Out'
  END                                     AS due_bucket,
  (col.due_date - CURRENT_DATE)           AS days_to_due,
  'Production'                            AS row_type,
  agg.wo_numbers,
  agg.job_count,
  agg.bottleneck_phase                    AS production_phase,
  agg.machines,
  agg.qty_allocated                       AS qty_this_row,
  agg.good_pieces,
  CASE WHEN COALESCE(col.quantity_ordered,0) = 0 THEN NULL
       ELSE ROUND((agg.good_pieces::numeric / col.quantity_ordered) * 100, 0)::int
  END                                     AS pct_complete,
  agg.earliest_sched_start,
  agg.latest_sched_end,
  agg.flags                               AS flags_or_notes,
  col.priority                            AS priority
FROM customer_order_lines col
JOIN customer_orders      co   ON co.id   = col.customer_order_id
JOIN customers            cust ON cust.id = co.customer_id
JOIN parts                pt   ON pt.id   = col.part_id
LEFT JOIN profiles        p    ON p.id    = co.salesperson_id
JOIN LATERAL (
  SELECT
    alloc.qty_allocated,
    jr.wo_numbers, jr.job_count, jr.good_pieces, jr.bottleneck_phase,
    jr.earliest_sched_start, jr.latest_sched_end, jr.machines, jr.flags
  FROM
    -- (1) allocation total for THIS line — computed WITHOUT job fan-out
    (SELECT SUM(ca.quantity_allocated)::int AS qty_allocated
       FROM customer_order_allocations ca
       JOIN work_orders wo ON wo.id = ca.work_order_id
      WHERE ca.customer_order_line_id = col.id
        AND ca.is_active = true
        AND COALESCE(wo.status,'') NOT IN ('cancelled','closed','shipped')
    ) alloc
    -- (2) job rollup over the DISTINCT WOs serving this line — each job once
    CROSS JOIN
    (SELECT
        STRING_AGG(DISTINCT wo.wo_number, ', ' ORDER BY wo.wo_number) AS wo_numbers,
        COUNT(DISTINCT j.id)                                          AS job_count,
        COALESCE(SUM(eq.effective_good_qty),0)::int                   AS good_pieces,
        MIN(
          CASE
            WHEN j.status IN ('pending_compliance','ready','assigned')              THEN '1. Waiting to Run'
            WHEN j.status IN ('in_setup','in_progress')                             THEN '2. In Machining'
            WHEN j.status IN ('manufacturing_complete','pending_passivation',
                              'in_passivation','pending_post_manufacturing')        THEN '3. Finishing / QC'
            WHEN j.status IN ('ready_for_outsourcing','at_external_vendor')         THEN '4. Outsourced'
            WHEN j.status IN ('ready_for_assembly','in_assembly')                   THEN '5. Assembly'
            WHEN j.status =  'pending_tco'                                          THEN '6. Pending TCO'
            ELSE                                                                         '?. ' || j.status
          END
        )                                                             AS bottleneck_phase,
        MIN(j.scheduled_start)::date                                  AS earliest_sched_start,
        MAX(j.scheduled_end)::date                                    AS latest_sched_end,
        STRING_AGG(DISTINCT m.name, ', ')                             AS machines,
        TRIM(BOTH ' ' FROM
             CASE WHEN bool_or(j.actual_start IS NOT NULL
                           AND j.actual_start < NOW() - INTERVAL '7 days'
                           AND j.status IN ('in_setup','in_progress')) THEN 'STALLED '       ELSE '' END
          || CASE WHEN bool_or(j.documents_deferred)                  THEN 'DOCS-DEFERRED ' ELSE '' END
          || CASE WHEN bool_or(wo.has_open_shortfall)                 THEN 'SHORTFALL '     ELSE '' END
          || CASE WHEN bool_or(wo.is_combined)                        THEN 'COMBINED-WO '   ELSE '' END)
                                                                      AS flags
      FROM (SELECT DISTINCT ca2.work_order_id
              FROM customer_order_allocations ca2
              JOIN work_orders wo2 ON wo2.id = ca2.work_order_id
             WHERE ca2.customer_order_line_id = col.id
               AND ca2.is_active = true
               AND COALESCE(wo2.status,'') NOT IN ('cancelled','closed','shipped')
           ) lw
      JOIN work_orders wo ON wo.id = lw.work_order_id
      JOIN jobs j         ON j.work_order_id = wo.id
                         AND j.status NOT IN ('complete','cancelled','incomplete','pending_tco')
                         AND COALESCE(j.is_maintenance,false) = false
      LEFT JOIN machines m ON m.id = j.assigned_machine_id
      LEFT JOIN v_sales_job_effective_qty eq ON eq.job_id = j.id
    ) jr
) agg ON agg.job_count > 0
WHERE COALESCE(co.status,'')  NOT IN ('cancelled','closed','shipped')
  AND COALESCE(col.status,'') NOT IN ('cancelled','shipped','complete')

UNION ALL

-- --- C. Open Demand (one row per CO line with un-allocated qty) ------------
SELECT
  'C. Open Demand'                        AS section,
  COALESCE(p.full_name, 'Unassigned')     AS salesperson_name,
  cust.name                               AS customer,
  co.co_number, co.po_number, col.line_number,
  pt.part_number, pt.description          AS part_description,
  col.quantity_ordered                    AS co_qty_ordered,
  col.due_date                            AS co_due_date,
  CASE
    WHEN col.due_date IS NULL                              THEN '0. No Due Date'
    WHEN col.due_date <  CURRENT_DATE                      THEN '1. PAST DUE'
    WHEN col.due_date <= CURRENT_DATE + INTERVAL '7 days'  THEN '2. Due This Week'
    WHEN col.due_date <= CURRENT_DATE + INTERVAL '14 days' THEN '3. Due Next Week'
    WHEN col.due_date <= CURRENT_DATE + INTERVAL '28 days' THEN '4. Due in 2-4 Weeks'
    ELSE                                                        '5. 4+ Weeks Out'
  END                                     AS due_bucket,
  (col.due_date - CURRENT_DATE)           AS days_to_due,
  'Open Demand'                           AS row_type,
  NULL::text AS wo_numbers, NULL::int AS job_count,
  NULL::text AS production_phase, NULL::text AS machines,
  GREATEST(0, col.quantity_ordered - col.quantity_fulfilled
           - COALESCE((SELECT SUM(quantity_allocated)::int
                         FROM customer_order_allocations
                        WHERE customer_order_line_id = col.id AND is_active=true),0))
                                          AS qty_this_row,
  NULL::int AS good_pieces, NULL::int AS pct_complete,
  NULL::date AS earliest_sched_start, NULL::date AS latest_sched_end,
  COALESCE(col.notes,'')                  AS flags_or_notes,
  col.priority                            AS priority
FROM customer_order_lines col
JOIN customer_orders co   ON co.id   = col.customer_order_id
JOIN customers       cust ON cust.id = co.customer_id
JOIN parts           pt   ON pt.id   = col.part_id
LEFT JOIN profiles   p    ON p.id    = co.salesperson_id
WHERE col.status IN ('not_started','in_progress')
  AND co.status  IN ('not_started','in_progress')
  AND GREATEST(0, col.quantity_ordered - col.quantity_fulfilled
           - COALESCE((SELECT SUM(quantity_allocated)::int
                         FROM customer_order_allocations
                        WHERE customer_order_line_id = col.id AND is_active=true),0)) > 0;

COMMENT ON VIEW v_sales_weekly_report_v3 IS
  'CO-line-grain weekly sales report (PREFERRED). One row per CO line, production jobs rolled up (no fan-out). Bottleneck phase + summed good pieces. Combined-WO rows flagged COMBINED-WO (good_pieces/pct reflect whole WO vs single line).';

CREATE OR REPLACE VIEW v_sales_mts_production AS
-- VIEW 7 (S10): Make-to-Stock production — standalone area on the Sales Dashboard.
-- MTS work orders (order_type=make_to_stock) have no customer-order allocation, so
-- they never appear in v_sales_weekly_report_v3 Section B (CO-line anchored). This
-- surfaces them WO-grain with the same phase/good-pieces/flags rollup as Section B.
SELECT
  'D. Make to Stock'                       AS section,
  'Make to Stock (MTS)'                    AS salesperson_name,
  wo.wo_number                             AS wo_numbers,
  COALESCE(pt.part_number, '-')            AS part_number,
  pt.description                           AS part_description,
  jr.bottleneck_phase                      AS production_phase,
  jr.machines,
  jr.good_pieces,
  wo.order_quantity                        AS co_qty_ordered,
  COALESCE(wo.order_quantity, wo.stock_quantity, 0) AS qty_this_row,
  CASE
    WHEN COALESCE(wo.order_quantity, 0) = 0 THEN NULL
    ELSE ROUND((jr.good_pieces::numeric / wo.order_quantity) * 100, 0)::int
  END                                      AS pct_complete,
  wo.due_date                              AS co_due_date,
  CASE
    WHEN wo.due_date IS NULL                              THEN '0. No Due Date'
    WHEN wo.due_date <  CURRENT_DATE                      THEN '1. PAST DUE'
    WHEN wo.due_date <= CURRENT_DATE + INTERVAL '7 days'  THEN '2. Due This Week'
    WHEN wo.due_date <= CURRENT_DATE + INTERVAL '14 days' THEN '3. Due Next Week'
    WHEN wo.due_date <= CURRENT_DATE + INTERVAL '28 days' THEN '4. Due in 2-4 Weeks'
    ELSE                                                       '5. 4+ Weeks Out'
  END                                      AS due_bucket,
  (wo.due_date - CURRENT_DATE)             AS days_to_due,
  jr.earliest_sched_start,
  jr.latest_sched_end,
  jr.flags                                 AS flags_or_notes,
  wo.priority                              AS priority,
  NULL::text                               AS customer,
  NULL::text                               AS co_number,
  NULL::int                                AS line_number,
  jr.job_count
FROM work_orders wo
JOIN LATERAL (
  SELECT
    COUNT(DISTINCT j.id)                                          AS job_count,
    COALESCE(SUM(eq.effective_good_qty), 0)::int                  AS good_pieces,
    MIN(
      CASE
        WHEN j.status IN ('pending_compliance','ready','assigned')              THEN '1. Waiting to Run'
        WHEN j.status IN ('in_setup','in_progress')                             THEN '2. In Machining'
        WHEN j.status IN ('manufacturing_complete','pending_passivation',
                          'in_passivation','pending_post_manufacturing')        THEN '3. Finishing / QC'
        WHEN j.status IN ('ready_for_outsourcing','at_external_vendor')         THEN '4. Outsourced'
        WHEN j.status IN ('ready_for_assembly','in_assembly')                   THEN '5. Assembly'
        WHEN j.status =  'pending_tco'                                          THEN '6. Pending TCO'
        ELSE                                                                         '?. ' || j.status
      END
    )                                                             AS bottleneck_phase,
    MIN(j.scheduled_start)::date                                  AS earliest_sched_start,
    MAX(j.scheduled_end)::date                                    AS latest_sched_end,
    STRING_AGG(DISTINCT m.name, ', ')                             AS machines,
    TRIM(BOTH ' ' FROM
         CASE WHEN bool_or(j.actual_start IS NOT NULL
                       AND j.actual_start < NOW() - INTERVAL '7 days'
                       AND j.status IN ('in_setup','in_progress')) THEN 'STALLED '       ELSE '' END
      || CASE WHEN bool_or(j.documents_deferred)                  THEN 'DOCS-DEFERRED ' ELSE '' END)
                                                                  AS flags
  FROM jobs j
  LEFT JOIN machines m                    ON m.id = j.assigned_machine_id
  LEFT JOIN v_sales_job_effective_qty eq  ON eq.job_id = j.id
  WHERE j.work_order_id = wo.id
    AND j.status NOT IN ('complete','cancelled','incomplete','pending_tco')
    AND COALESCE(j.is_maintenance, false) = false
) jr ON jr.job_count > 0
LEFT JOIN LATERAL (
  SELECT p.part_number, p.description
  FROM parts p
  WHERE p.id = COALESCE(
    (SELECT wa.assembly_id FROM work_order_assemblies wa
       WHERE wa.work_order_id = wo.id ORDER BY wa.created_at LIMIT 1),
    (SELECT j2.part_id FROM jobs j2
       WHERE j2.work_order_id = wo.id AND j2.part_id IS NOT NULL LIMIT 1)
  )
) pt ON true
WHERE wo.order_type = 'make_to_stock'
  AND COALESCE(wo.status,'') NOT IN ('cancelled','closed','shipped');

COMMENT ON VIEW v_sales_mts_production IS
  'S10 Make-to-Stock WO-grain production for the Sales Dashboard standalone MTS panel';

-- ============================================================================
-- GRANTS: the React app reads these as the authenticated role via the anon key.
-- PostgREST will not expose a view without SELECT for that role. Idempotent.
-- ============================================================================
GRANT SELECT ON
  v_sales_wo_salesperson,
  v_sales_job_effective_qty,
  v_sales_active_production,
  v_sales_open_demand,
  v_sales_summary_by_person,
  v_sales_weekly_report_v3,
  v_sales_mts_production
TO authenticated;

-- ============================================================================
-- VERIFICATION: run AFTER the statements above (read-only). TEST first.
-- ============================================================================
-- 1. pending_tco gone from the dashboard production source (NOT v_sales_active_production)
SELECT COUNT(*) AS should_be_zero
FROM v_sales_weekly_report_v3
WHERE section = 'B. Production' AND production_phase = '6. Pending TCO';

-- 2. priority column present and populated
SELECT section, priority, COUNT(*) AS n
FROM v_sales_weekly_report_v3 GROUP BY section, priority ORDER BY section, priority;

-- 3. MTS standalone view returns the stock WOs
SELECT wo_numbers, part_number, production_phase, due_bucket, qty_this_row, flags_or_notes, priority
FROM v_sales_mts_production ORDER BY due_bucket, wo_numbers;

-- 4. authenticated has SELECT (the silent-empty-dashboard guard)
SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'authenticated' AND table_name LIKE 'v_sales_%' ORDER BY table_name;

-- 5. Sanity: other phases still flow
SELECT production_phase, COUNT(*) AS n
FROM v_sales_weekly_report_v3 WHERE section = 'B. Production'
GROUP BY production_phase ORDER BY production_phase;
