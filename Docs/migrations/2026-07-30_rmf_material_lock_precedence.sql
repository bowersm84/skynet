-- 2026-07-30 — D-RMF-04: locked part_dimensions outrank job history in forecast bucketing
--
-- Task 0a finding: forecast_rm_bars() and forecast_rm_bar_parts() do NOT source
-- material_type / bar_size from part_dimensions alone. They run a two-branch
-- waterfall:
--
--   emp_profile  — most recent job history (job_materials.material_type / bar_size),
--                  DISTINCT ON (component_id) ORDER BY last_run DESC.  Wins.
--   geo_profile  — part_dimensions.material_type / bar_size, applied ONLY where
--                  NOT EXISTS an emp_profile row for the part.
--
-- So a human correction written to part_dimensions is invisible to bucketing for
-- any part that has ever run.  This migration makes a correction with
-- material_locked = true override the history-derived material/bar_size, while
-- leaving the empirical pieces-per-bar (and the 'empirical' basis) untouched —
-- the lock settles WHICH BAR the part is turned from, not how many pieces come
-- off one.  COALESCE is per-column, so a locked row that knows only one of the
-- two overrides only that one.
--
-- Everything else in both functions is byte-identical to the deployed
-- definitions.  Return signatures are unchanged, so CREATE OR REPLACE is safe
-- and the D-RMF-01 grants/REVOKEs carry forward untouched (no DROP).
--
-- Run on TEST -> verify -> PROD.

BEGIN;

CREATE OR REPLACE FUNCTION public.forecast_rm_bars()
 RETURNS TABLE(material_type text, bar_size text, week_start date, is_unscheduled boolean, jobs bigint, pieces bigint, bars_needed numeric, has_estimates boolean, cum_bars numeric, bars_on_hand numeric, projected_remaining numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM _rm_forecast_gate();
  RETURN QUERY
  WITH blank_fed AS (
    SELECT DISTINCT pmd.part_id AS component_id
    FROM part_machine_durations pmd JOIN machines m ON m.id = pmd.machine_id
    WHERE m.machine_type = 'Bolt Master'
    UNION SELECT DISTINCT j.component_id FROM jobs j
          WHERE j.blank_lot_number IS NOT NULL AND j.component_id IS NOT NULL
    UNION SELECT DISTINCT j.component_id FROM jobs j
          JOIN job_materials jm ON jm.job_id = j.id
          WHERE jm.material_type ILIKE 'blank%' AND j.component_id IS NOT NULL
  ),
  hist AS (
    SELECT j.component_id, jm.material_type AS mt, jm.bar_size AS bs,
           SUM(j.good_pieces + j.bad_pieces)::numeric AS pieces,
           SUM(jm.bars_loaded)::numeric AS bars, MAX(j.updated_at) AS last_run
    FROM jobs j JOIN job_materials jm ON jm.job_id = j.id
    WHERE ( j.status IN ('manufacturing_complete','pending_passivation','in_passivation',
                         'pending_post_manufacturing','ready_for_outsourcing','at_external_vendor',
                         'ready_for_assembly','in_assembly','pending_tco','complete')
            OR (j.status = 'in_progress' AND (j.good_pieces + j.bad_pieces) > 0) )
      AND (j.good_pieces + j.bad_pieces) > 0 AND jm.bars_loaded > 0
      AND jm.material_type IS NOT NULL AND jm.bar_size IS NOT NULL
      AND jm.material_type NOT ILIKE 'blank%'
      AND j.component_id NOT IN (SELECT bf.component_id FROM blank_fed bf)
    GROUP BY j.component_id, jm.material_type, jm.bar_size
  ),
  emp_profile AS (
    -- D-RMF-04: a human correction (material_locked) outranks the history-derived
    -- material/bar_size. ppb and basis stay empirical.
    SELECT DISTINCT ON (h.component_id) h.component_id,
           COALESCE(lk.material_type, h.mt) AS mt,
           COALESCE(lk.bar_size, h.bs) AS bs,
           GREATEST(h.pieces / NULLIF(h.bars,0), 1) AS ppb, 'empirical'::text AS basis
    FROM hist h
    JOIN parts p ON p.id = h.component_id
    LEFT JOIN part_dimensions lk
           ON lk.part_number = p.part_number AND lk.material_locked = true
    ORDER BY h.component_id, h.last_run DESC
  ),
  bar_len AS (
    SELECT jm.bar_size AS bs, MODE() WITHIN GROUP (ORDER BY jm.bar_length) AS len
    FROM job_materials jm WHERE jm.bar_length IS NOT NULL AND jm.bar_length > 0
    GROUP BY jm.bar_size
  ),
  geo_profile AS (
    SELECT p.id AS component_id, pd.material_type AS mt, pd.bar_size AS bs,
           GREATEST(FLOOR((COALESCE(bl.len,144) - 0.42) / (pd.length_in + 0.149)), 1) AS ppb,
           'geometric'::text AS basis
    FROM part_dimensions pd
    JOIN parts p ON p.part_number = pd.part_number
    LEFT JOIN bar_len bl ON bl.bs = pd.bar_size
    WHERE pd.length_in IS NOT NULL AND pd.material_type IS NOT NULL AND pd.bar_size IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM emp_profile e WHERE e.component_id = p.id)
  ),
  part_profile AS (SELECT * FROM emp_profile UNION ALL SELECT * FROM geo_profile),
  open_demand AS (
    SELECT j.component_id, j.scheduled_start, j.status,
           CASE WHEN j.status = 'in_progress'
                THEN GREATEST(j.quantity - j.good_pieces - j.bad_pieces, 0)
                ELSE j.quantity END AS remaining_pieces,
           j.quantity AS total_pieces, COALESCE(jm.bars_loaded, 0) AS loaded
    FROM jobs j LEFT JOIN job_materials jm ON jm.job_id = j.id
    WHERE j.status IN ('pending_compliance','ready','assigned','in_setup','in_progress')
      AND COALESCE(j.is_maintenance,false) = false
      AND COALESCE(j.is_standalone_finishing,false) = false
      AND j.component_id IS NOT NULL
      AND j.component_id NOT IN (SELECT bf.component_id FROM blank_fed bf)
  ),
  job_bars AS (
    SELECT pp.mt, pp.bs, pp.basis,
           CASE WHEN od.scheduled_start IS NULL THEN '9999-01-01'::date
                ELSE GREATEST(date_trunc('week', od.scheduled_start)::date,
                              date_trunc('week', now())::date) END AS wk,
           CASE WHEN od.status = 'in_progress'
                THEN GREATEST(CEIL(od.total_pieces / pp.ppb) - od.loaded, 0)
                ELSE CEIL(od.remaining_pieces / pp.ppb) END AS bn,
           od.remaining_pieces AS rp
    FROM open_demand od JOIN part_profile pp ON pp.component_id = od.component_id
  ),
  weekly AS (
    SELECT jb.mt, jb.bs, jb.wk, COUNT(*) AS jobs, SUM(jb.rp) AS pieces,
           SUM(jb.bn) AS bn, BOOL_OR(jb.basis = 'geometric') AS est
    FROM job_bars jb GROUP BY jb.mt, jb.bs, jb.wk
  ),
  on_hand AS (
    SELECT mr.material_type AS mt, mr.bar_size AS bs,
           SUM(mr.quantity) - COALESCE(SUM(u.used),0) AS oh
    FROM material_receiving mr
    LEFT JOIN (SELECT mu.material_receiving_id, SUM(mu.quantity_used) AS used
               FROM material_usage mu GROUP BY mu.material_receiving_id) u
          ON u.material_receiving_id = mr.id
    WHERE mr.category = 'bar' GROUP BY mr.material_type, mr.bar_size
  )
  SELECT w.mt, w.bs,
         NULLIF(w.wk, '9999-01-01'::date) AS week_start,
         (w.wk = '9999-01-01'::date) AS is_unscheduled,
         w.jobs, w.pieces, w.bn, w.est,
         SUM(w.bn) OVER (PARTITION BY w.mt, w.bs ORDER BY w.wk) AS cum_bars,
         COALESCE(oh.oh,0) AS bars_on_hand,
         COALESCE(oh.oh,0) - SUM(w.bn) OVER (PARTITION BY w.mt, w.bs ORDER BY w.wk) AS projected_remaining
  FROM weekly w LEFT JOIN on_hand oh ON oh.mt = w.mt AND oh.bs = w.bs
  ORDER BY w.mt, w.bs, w.wk;
END $function$;

CREATE OR REPLACE FUNCTION public.forecast_rm_bar_parts()
 RETURNS TABLE(material_type text, bar_size text, part_number text, week_start date, is_unscheduled boolean, pieces bigint, bars_needed numeric, basis text, machines text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM _rm_forecast_gate();
  RETURN QUERY
  WITH blank_fed AS (
    SELECT DISTINCT pmd.part_id AS component_id
    FROM part_machine_durations pmd JOIN machines m ON m.id = pmd.machine_id
    WHERE m.machine_type = 'Bolt Master'
    UNION SELECT DISTINCT j.component_id FROM jobs j
          WHERE j.blank_lot_number IS NOT NULL AND j.component_id IS NOT NULL
    UNION SELECT DISTINCT j.component_id FROM jobs j
          JOIN job_materials jm ON jm.job_id = j.id
          WHERE jm.material_type ILIKE 'blank%' AND j.component_id IS NOT NULL
  ),
  hist AS (
    SELECT j.component_id, jm.material_type AS mt, jm.bar_size AS bs,
           SUM(j.good_pieces + j.bad_pieces)::numeric AS pieces,
           SUM(jm.bars_loaded)::numeric AS bars, MAX(j.updated_at) AS last_run
    FROM jobs j JOIN job_materials jm ON jm.job_id = j.id
    WHERE ( j.status IN ('manufacturing_complete','pending_passivation','in_passivation',
                         'pending_post_manufacturing','ready_for_outsourcing','at_external_vendor',
                         'ready_for_assembly','in_assembly','pending_tco','complete')
            OR (j.status = 'in_progress' AND (j.good_pieces + j.bad_pieces) > 0) )
      AND (j.good_pieces + j.bad_pieces) > 0 AND jm.bars_loaded > 0
      AND jm.material_type IS NOT NULL AND jm.bar_size IS NOT NULL
      AND jm.material_type NOT ILIKE 'blank%'
      AND j.component_id NOT IN (SELECT bf.component_id FROM blank_fed bf)
    GROUP BY j.component_id, jm.material_type, jm.bar_size
  ),
  emp_profile AS (
    -- D-RMF-04: see forecast_rm_bars(). Same override, kept identical so the two
    -- functions can never disagree about which bucket a part belongs to.
    SELECT DISTINCT ON (h.component_id) h.component_id,
           COALESCE(lk.material_type, h.mt) AS mt,
           COALESCE(lk.bar_size, h.bs) AS bs,
           GREATEST(h.pieces / NULLIF(h.bars,0), 1) AS ppb, 'empirical'::text AS basis
    FROM hist h
    JOIN parts p ON p.id = h.component_id
    LEFT JOIN part_dimensions lk
           ON lk.part_number = p.part_number AND lk.material_locked = true
    ORDER BY h.component_id, h.last_run DESC
  ),
  bar_len AS (
    SELECT jm.bar_size AS bs, MODE() WITHIN GROUP (ORDER BY jm.bar_length) AS len
    FROM job_materials jm WHERE jm.bar_length IS NOT NULL AND jm.bar_length > 0
    GROUP BY jm.bar_size
  ),
  geo_profile AS (
    SELECT p.id AS component_id, pd.material_type AS mt, pd.bar_size AS bs,
           GREATEST(FLOOR((COALESCE(bl.len,144) - 0.42) / (pd.length_in + 0.149)), 1) AS ppb,
           'geometric'::text AS basis
    FROM part_dimensions pd JOIN parts p ON p.part_number = pd.part_number
    LEFT JOIN bar_len bl ON bl.bs = pd.bar_size
    WHERE pd.length_in IS NOT NULL AND pd.material_type IS NOT NULL AND pd.bar_size IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM emp_profile e WHERE e.component_id = p.id)
  ),
  part_profile AS (SELECT * FROM emp_profile UNION ALL SELECT * FROM geo_profile),
  open_demand AS (
    SELECT j.component_id, j.scheduled_start, j.status, j.assigned_machine_id,
           CASE WHEN j.status = 'in_progress'
                THEN GREATEST(j.quantity - j.good_pieces - j.bad_pieces, 0)
                ELSE j.quantity END AS remaining_pieces,
           j.quantity AS total_pieces, COALESCE(jm.bars_loaded, 0) AS loaded
    FROM jobs j LEFT JOIN job_materials jm ON jm.job_id = j.id
    WHERE j.status IN ('pending_compliance','ready','assigned','in_setup','in_progress')
      AND COALESCE(j.is_maintenance,false) = false
      AND COALESCE(j.is_standalone_finishing,false) = false
      AND j.component_id IS NOT NULL
      AND j.component_id NOT IN (SELECT bf.component_id FROM blank_fed bf)
  )
  SELECT pp.mt, pp.bs, p.part_number::text,
         NULLIF(CASE WHEN od.scheduled_start IS NULL THEN '9999-01-01'::date
                     ELSE GREATEST(date_trunc('week', od.scheduled_start)::date,
                                   date_trunc('week', now())::date) END, '9999-01-01'::date),
         od.scheduled_start IS NULL,
         SUM(od.remaining_pieces),
         SUM(CASE WHEN od.status = 'in_progress'
                  THEN GREATEST(CEIL(od.total_pieces / pp.ppb) - od.loaded, 0)
                  ELSE CEIL(od.remaining_pieces / pp.ppb) END),
         pp.basis,
         STRING_AGG(DISTINCT COALESCE(mc.name::text, 'Unassigned'),
                    ', ' ORDER BY COALESCE(mc.name::text, 'Unassigned'))
  FROM open_demand od
  JOIN part_profile pp ON pp.component_id = od.component_id
  JOIN parts p ON p.id = od.component_id
  LEFT JOIN machines mc ON mc.id = od.assigned_machine_id
  GROUP BY pp.mt, pp.bs, p.part_number, od.scheduled_start IS NULL,
           CASE WHEN od.scheduled_start IS NULL THEN '9999-01-01'::date
                ELSE GREATEST(date_trunc('week', od.scheduled_start)::date,
                              date_trunc('week', now())::date) END, pp.basis
  ORDER BY pp.mt, pp.bs, p.part_number::text;
END $function$;

-- Verify: both functions still present with unchanged signatures, and EXECUTE
-- still revoked from PUBLIC/anon while authenticated + service_role keep it.
SELECT p.proname,
       pg_get_function_result(p.oid) AS returns,
       p.prosecdef AS security_definer,
       p.proacl::text AS acl
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('forecast_rm_bars','forecast_rm_bar_parts')
ORDER BY p.proname;

COMMIT;
