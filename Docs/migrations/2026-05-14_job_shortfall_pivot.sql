-- =====================================================================
-- Pivot shortfall tracking from WO-level to JOB-level.
--
-- 1. Create job_shortfall_resolutions (per-job rows) + jobs.has_open_shortfall
-- 2. RLS policies on the new table
-- 3. Backfill: synthesise one per-job row for each currently-short job
--    on a WO that has an open wo_shortfall_resolutions row
-- 4. Mark the deprecated wo_shortfall_resolutions / WO column for later removal
-- 5. (Commented) DROP wo_shortfall_resolutions — do NOT run until UI is stable
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. New per-job resolution table
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_shortfall_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  work_order_id uuid NOT NULL REFERENCES public.work_orders(id) ON DELETE CASCADE,
  job_quantity integer NOT NULL,
  produced_quantity integer NOT NULL,
  shortfall_quantity integer NOT NULL,
  resolution text CHECK (resolution IS NULL OR resolution IN
    ('accept_short', 'requeue', 'cancel_shortfall', 'acknowledge_plan')),
  resolution_notes text,
  resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  requeue_job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jsr_job
  ON public.job_shortfall_resolutions(job_id);
CREATE INDEX IF NOT EXISTS idx_jsr_wo
  ON public.job_shortfall_resolutions(work_order_id);
CREATE INDEX IF NOT EXISTS idx_jsr_open
  ON public.job_shortfall_resolutions(work_order_id)
  WHERE status = 'open';

-- ---------------------------------------------------------------------
-- 2. Job-level flag + index
-- ---------------------------------------------------------------------
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS has_open_shortfall boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_jobs_open_shortfall
  ON public.jobs(has_open_shortfall)
  WHERE has_open_shortfall = true;

-- ---------------------------------------------------------------------
-- 3. RLS — match the rest of the schema's authenticated-all-CRUD pattern
-- ---------------------------------------------------------------------
ALTER TABLE public.job_shortfall_resolutions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "jsr_select" ON public.job_shortfall_resolutions
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "jsr_insert" ON public.job_shortfall_resolutions
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "jsr_update" ON public.job_shortfall_resolutions
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "jsr_delete" ON public.job_shortfall_resolutions
  FOR DELETE TO authenticated USING (true);

-- ---------------------------------------------------------------------
-- 4. Migrate from wo_shortfall_resolutions to job-level rows.
--    For each currently-open WO-level row, synthesise one per-job row
--    for every short job on that WO whose status is terminal-or-near
--    (i.e. the job has reached a point where its produced count is
--    final-ish — same gate evaluateJobShortfall will use going forward).
--    Cancelled jobs are excluded — they never generate shortfalls.
-- ---------------------------------------------------------------------
INSERT INTO public.job_shortfall_resolutions
  (job_id, work_order_id, job_quantity, produced_quantity,
   shortfall_quantity, status, created_at)
SELECT
  j.id,
  j.work_order_id,
  j.quantity,
  COALESCE(j.post_mfg_good_qty, j.good_pieces, 0),
  j.quantity - COALESCE(j.post_mfg_good_qty, j.good_pieces, 0),
  'open',
  now()
FROM public.jobs j
WHERE j.status IN (
        'manufacturing_complete', 'pending_tco', 'complete',
        'ready_for_assembly', 'ready_for_outsource', 'in_assembly',
        'pending_passivation', 'in_passivation',
        'pending_post_manufacturing', 'ready_for_outsourcing',
        'at_external_vendor'
      )
  AND j.quantity > COALESCE(j.post_mfg_good_qty, j.good_pieces, 0)
  AND EXISTS (
    SELECT 1
      FROM public.wo_shortfall_resolutions r
     WHERE r.work_order_id = j.work_order_id
       AND r.status = 'open'
  )
  AND NOT EXISTS (
    SELECT 1
      FROM public.job_shortfall_resolutions jsr
     WHERE jsr.job_id = j.id
       AND jsr.status = 'open'
  );

UPDATE public.jobs
   SET has_open_shortfall = true
 WHERE id IN (
   SELECT DISTINCT job_id
     FROM public.job_shortfall_resolutions
    WHERE status = 'open'
 );

-- ---------------------------------------------------------------------
-- 5. Deprecation markers (do not actually drop until UI is stable)
-- ---------------------------------------------------------------------
COMMENT ON TABLE public.wo_shortfall_resolutions IS
  'DEPRECATED 2026-05-14. Replaced by job_shortfall_resolutions. Migrated rows preserved here for audit; new rows go to the per-job table.';

COMMENT ON COLUMN public.work_orders.has_open_shortfall IS
  'DEPRECATED 2026-05-14. Derive from EXISTS jobs.has_open_shortfall on this WO instead.';

COMMIT;

-- ---------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------
SELECT j.job_number, j.quantity, j.good_pieces, j.post_mfg_good_qty,
       jsr.shortfall_quantity, jsr.status, wo.wo_number
  FROM public.job_shortfall_resolutions jsr
  JOIN public.jobs j ON j.id = jsr.job_id
  JOIN public.work_orders wo ON wo.id = jsr.work_order_id
 WHERE jsr.status = 'open'
 ORDER BY jsr.created_at DESC;

SELECT 'jobs with has_open_shortfall=true' AS metric, COUNT(*) AS count
  FROM public.jobs WHERE has_open_shortfall = true;

SELECT 'open job-level shortfalls' AS metric, COUNT(*) AS count
  FROM public.job_shortfall_resolutions WHERE status = 'open';

-- ---------------------------------------------------------------------
-- Post-stability cleanup (RUN MANUALLY AFTER UI VERIFIED):
--   DROP TABLE public.wo_shortfall_resolutions CASCADE;
--   ALTER TABLE public.work_orders DROP COLUMN has_open_shortfall;
-- ---------------------------------------------------------------------
