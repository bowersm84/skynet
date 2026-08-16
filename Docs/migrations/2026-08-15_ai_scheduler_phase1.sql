-- ============================================================================
-- SkyNet AI Scheduler ("Uncle Bob") — Phase 1 database layer
-- File: Docs/migrations/2026-08-15_ai_scheduler_phase1.sql
-- Decisions: D-AISCHED-01, D-AISCHED-02 (see Decisions.md entries this round)
--
-- RUN ORDER: TEST (ylzmyjjqibpbqbwjsnqj) first -> verify -> PROD
-- (luzungoqfuplspzbqctb) at rollout step 5, BEFORE the PROD code deploy.
--
-- Paste this whole block as one run: it is a single transaction.
-- The VERIFY queries at the bottom must be run INDIVIDUALLY afterwards —
-- the SQL editor returns only the last result set of a multi-statement run.
--
-- NOTE on the earlier error: the canonical role helper is
--   user_has_role(uid uuid, VARIADIC roles text[])          (D-MROLE-02)
-- Calling user_has_role('scheduler') with no uid raises 42883
-- ("function user_has_role(unknown) does not exist"). Nothing below calls
-- it that way. The gate follows the _rm_forecast_gate / _job_merge_gate
-- pattern exactly: NULL-uid pass (SQL editor), user_has_role otherwise,
-- anon revoked.
-- ============================================================================

-- ============================================================================
-- STEP 0 — PRE-FLIGHT (run this SELECT alone, BEFORE the main block)
-- An earlier draft of this migration failed mid-run on TEST with 42883
-- (bare user_has_role('...') call). If that draft was pasted without its
-- BEGIN/COMMIT, it may have left partial objects behind — including a
-- schedule_ai_proposals whose status CHECK lacks 'expired'.
--
--   SELECT c.relname, c.relkind
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public'
--     AND c.relname IN ('schedule_ai_runs','schedule_ai_proposals',
--                       'scheduler_policies','part_machine_stats',
--                       'family_machine_stats','v_schedule_estimate_accuracy');
--
-- 0 rows  -> skip straight to the main block below.
-- Any rows -> run this cleanup first (safe: the feature has never run, the
--             tables hold no data; views are replaced by the main block anyway):
--
--   DROP TABLE IF EXISTS public.schedule_ai_proposals CASCADE;
--   DROP TABLE IF EXISTS public.schedule_ai_runs      CASCADE;
--   DROP TABLE IF EXISTS public.scheduler_policies    CASCADE;
--
-- ============================================================================

BEGIN;

-- ── 1. Role gate ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._schedule_ai_gate()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NULL
      OR public.user_has_role(auth.uid(), 'admin', 'scheduler');
$$;

REVOKE ALL ON FUNCTION public._schedule_ai_gate() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._schedule_ai_gate() FROM anon;
GRANT EXECUTE ON FUNCTION public._schedule_ai_gate() TO authenticated;
GRANT EXECUTE ON FUNCTION public._schedule_ai_gate() TO service_role;

-- ── 2. parts.family_key (inert until the seeding pass) ─────────────────────
ALTER TABLE public.parts ADD COLUMN IF NOT EXISTS family_key text;
CREATE INDEX IF NOT EXISTS idx_parts_family_key
  ON public.parts (family_key) WHERE family_key IS NOT NULL;

-- ── 3. part_machine_stats — per-part-per-machine actuals ───────────────────
-- Endpoint math over jobs actuals. 5-min/30-day sanity fence excludes
-- data-correction artifacts. finishing_sends waypoint rates are Phase 2.
CREATE OR REPLACE VIEW public.part_machine_stats AS
WITH runs AS (
  SELECT
    j.id,
    j.component_id                                        AS part_id,
    j.assigned_machine_id                                 AS machine_id,
    j.quantity,
    j.estimated_minutes,
    EXTRACT(EPOCH FROM (j.actual_end - j.actual_start)) / 60.0
                                                          AS actual_minutes,
    CASE WHEN j.setup_start IS NOT NULL AND j.actual_start > j.setup_start
         THEN EXTRACT(EPOCH FROM (j.actual_start - j.setup_start)) / 60.0
    END                                                   AS setup_minutes,
    j.actual_end
  FROM public.jobs j
  WHERE j.component_id IS NOT NULL
    AND j.assigned_machine_id IS NOT NULL
    AND j.actual_start IS NOT NULL
    AND j.actual_end   IS NOT NULL
    AND j.actual_end > j.actual_start
    AND j.status NOT IN ('cancelled', 'merged')
    AND EXTRACT(EPOCH FROM (j.actual_end - j.actual_start))
        BETWEEN 300 AND 60*60*24*30
    AND j.quantity > 0
)
SELECT
  r.part_id,
  p.part_number,
  r.machine_id,
  m.name                                                  AS machine_name,
  m.code                                                  AS machine_code,
  COUNT(*)                                                AS completed_runs,
  SUM(r.quantity)                                         AS total_qty,
  ROUND((SUM(r.quantity) / NULLIF(SUM(r.actual_minutes) / 60.0, 0))::numeric, 2)
                                                          AS actual_pcs_per_hour,
  ROUND(AVG(r.actual_minutes)::numeric, 1)                AS avg_actual_minutes,
  ROUND(AVG(r.setup_minutes)::numeric, 1)                 AS avg_setup_minutes,
  -- drift < 0 means runs finish faster than estimated
  ROUND((AVG( (r.actual_minutes - r.estimated_minutes)
              / NULLIF(r.estimated_minutes, 0) )
         FILTER (WHERE r.estimated_minutes > 0))::numeric, 3)
                                                          AS est_vs_actual_drift,
  MAX(r.actual_end)                                       AS last_run_at,
  COALESCE(mp.missed_qty, 0)                              AS missed_qty
FROM runs r
JOIN public.parts p    ON p.id = r.part_id
JOIN public.machines m ON m.id = r.machine_id
LEFT JOIN LATERAL (
  SELECT SUM(e.quantity) AS missed_qty
  FROM public.missed_production_entries e
  JOIN public.jobs j2 ON j2.id = e.job_id
  WHERE j2.component_id = r.part_id
    AND j2.assigned_machine_id = r.machine_id
) mp ON true
GROUP BY r.part_id, p.part_number, r.machine_id, m.name, m.code, mp.missed_qty;

-- ── 4. family_machine_stats — ships inert (0 rows until family_key seeded) ─
CREATE OR REPLACE VIEW public.family_machine_stats AS
SELECT
  p.family_key,
  s.machine_id,
  s.machine_name,
  s.machine_code,
  COUNT(DISTINCT s.part_id)      AS parts_in_family,
  SUM(s.completed_runs)          AS completed_runs,
  SUM(s.total_qty)               AS total_qty,
  ROUND((SUM(s.total_qty)
         / NULLIF(SUM(s.total_qty / NULLIF(s.actual_pcs_per_hour, 0)), 0))::numeric, 2)
                                 AS actual_pcs_per_hour,   -- qty-weighted
  MAX(s.last_run_at)             AS last_run_at
FROM public.part_machine_stats s
JOIN public.parts p ON p.id = s.part_id
WHERE p.family_key IS NOT NULL
GROUP BY p.family_key, s.machine_id, s.machine_name, s.machine_code;

-- ── 5. v_schedule_estimate_accuracy — the pre-AI baseline, retroactive ─────
CREATE OR REPLACE VIEW public.v_schedule_estimate_accuracy AS
SELECT
  date_trunc('week', j.actual_end)                        AS week,
  COUNT(*)                                                AS completed_jobs,
  ROUND((AVG( ABS(EXTRACT(EPOCH FROM (j.actual_end - j.actual_start)) / 60.0
                  - j.estimated_minutes)
              / NULLIF(j.estimated_minutes, 0) )
         FILTER (WHERE j.estimated_minutes > 0))::numeric, 3)
                                                          AS mape,
  ROUND(AVG( CASE WHEN wo.due_date IS NOT NULL
                  THEN CASE WHEN j.actual_end::date <= wo.due_date
                            THEN 1.0 ELSE 0.0 END
             END )::numeric, 3)                           AS on_time_rate
FROM public.jobs j
JOIN public.work_orders wo ON wo.id = j.work_order_id
WHERE j.actual_start IS NOT NULL
  AND j.actual_end   IS NOT NULL
  AND j.status NOT IN ('cancelled', 'merged')
GROUP BY 1
ORDER BY 1;

-- View grants (views-as-API; anon never reads)
GRANT SELECT ON public.part_machine_stats          TO authenticated, service_role;
GRANT SELECT ON public.family_machine_stats        TO authenticated, service_role;
GRANT SELECT ON public.v_schedule_estimate_accuracy TO authenticated, service_role;
REVOKE ALL   ON public.part_machine_stats           FROM anon;
REVOKE ALL   ON public.family_machine_stats         FROM anon;
REVOKE ALL   ON public.v_schedule_estimate_accuracy FROM anon;

-- ── 6. Proposal rail ────────────────────────────────────────────────────────
-- Edge Function writes NOTHING (D-RMF-05 precedent). The panel — running as
-- the authenticated scheduler — inserts the run row and its proposals, then
-- updates them on apply / dismiss / supersede / expire.
CREATE TABLE public.schedule_ai_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_by        uuid NOT NULL REFERENCES public.profiles(id),
  run_at        timestamptz NOT NULL DEFAULT now(),
  model         text NOT NULL,
  snapshot      jsonb NOT NULL,          -- exact advisor input (audit)
  briefing      text,
  risks         jsonb,
  data_gaps     jsonb,
  usage         jsonb,                   -- token counts from the API response
  error         text
);

CREATE TABLE public.schedule_ai_proposals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES public.schedule_ai_runs(id),
  job_id              uuid NOT NULL REFERENCES public.jobs(id),
  machine_id          uuid NOT NULL REFERENCES public.machines(id),
  insert_after_job_id uuid REFERENCES public.jobs(id),
  proposed_start      timestamptz NOT NULL,
  proposed_end        timestamptz NOT NULL,
  estimated_minutes   integer CHECK (estimated_minutes > 0),
  confidence          text NOT NULL CHECK (confidence IN ('high','medium','low')),
  rationale           text NOT NULL,
  evidence            jsonb,             -- {basis, runs, actual_pcs_per_hour,
                                         --  drift, last_run_at, queue_fp, ...}
  status              text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','applied','dismissed',
                                        'superseded','expired')),
  applied_by          uuid REFERENCES public.profiles(id),
  applied_at          timestamptz,
  applied_with_edits  boolean NOT NULL DEFAULT false,
  dismissed_by        uuid REFERENCES public.profiles(id),
  dismissed_at        timestamptz,
  dismissal_reason    text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_proposals_run    ON public.schedule_ai_proposals (run_id);
CREATE INDEX idx_ai_proposals_status ON public.schedule_ai_proposals (status)
  WHERE status = 'open';

CREATE TABLE public.scheduler_policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_text text NOT NULL,             -- natural language, advisor-readable
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid NOT NULL REFERENCES public.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  source      text NOT NULL DEFAULT 'manual'
              CHECK (source IN ('manual','ai_suggested'))
);

-- RLS: admin/scheduler via the gate; anon revoked; no service writes needed
ALTER TABLE public.schedule_ai_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_ai_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduler_policies    ENABLE ROW LEVEL SECURITY;

CREATE POLICY sar_select ON public.schedule_ai_runs
  FOR SELECT TO authenticated USING (public._schedule_ai_gate());
CREATE POLICY sar_insert ON public.schedule_ai_runs
  FOR INSERT TO authenticated WITH CHECK (public._schedule_ai_gate());

CREATE POLICY sap_select ON public.schedule_ai_proposals
  FOR SELECT TO authenticated USING (public._schedule_ai_gate());
CREATE POLICY sap_insert ON public.schedule_ai_proposals
  FOR INSERT TO authenticated WITH CHECK (public._schedule_ai_gate());
CREATE POLICY sap_update ON public.schedule_ai_proposals
  FOR UPDATE TO authenticated
  USING (public._schedule_ai_gate())
  WITH CHECK (public._schedule_ai_gate());

CREATE POLICY spol_select ON public.scheduler_policies
  FOR SELECT TO authenticated USING (public._schedule_ai_gate());
CREATE POLICY spol_insert ON public.scheduler_policies
  FOR INSERT TO authenticated WITH CHECK (public._schedule_ai_gate());
CREATE POLICY spol_update ON public.scheduler_policies
  FOR UPDATE TO authenticated
  USING (public._schedule_ai_gate())
  WITH CHECK (public._schedule_ai_gate());

GRANT SELECT, INSERT         ON public.schedule_ai_runs      TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.schedule_ai_proposals TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.scheduler_policies    TO authenticated;
GRANT ALL ON public.schedule_ai_runs, public.schedule_ai_proposals,
             public.scheduler_policies TO service_role;
REVOKE ALL ON public.schedule_ai_runs      FROM anon;
REVOKE ALL ON public.schedule_ai_proposals FROM anon;
REVOKE ALL ON public.scheduler_policies    FROM anon;

COMMIT;

-- ============================================================================
-- VERIFY — run each of these INDIVIDUALLY after the block above commits
-- ============================================================================
-- V1  expect: true (NULL-uid pass in the SQL editor)
--   SELECT public._schedule_ai_gate();
--
-- V2  eyeball the top runners: known parts on their usual machines, sane
--     pcs/hr, and — for the first time — est_vs_actual_drift:
--   SELECT * FROM part_machine_stats ORDER BY completed_runs DESC LIMIT 20;
--
-- V3  expect: 0 (inert until family_key is seeded)
--   SELECT count(*) FROM family_machine_stats;
--
-- V4  the pre-AI baseline, retroactive:
--   SELECT * FROM v_schedule_estimate_accuracy ORDER BY week DESC LIMIT 12;
--
-- V5  expect: three rows, relrowsecurity = true on all
--   SELECT relname, relrowsecurity FROM pg_class
--   WHERE relname IN ('schedule_ai_runs','schedule_ai_proposals',
--                     'scheduler_policies');
