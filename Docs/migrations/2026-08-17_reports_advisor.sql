-- ============================================================================
-- REPORTS ADVISOR — report_ai_runs audit table  (Batch B)
-- Run in: Supabase SQL Editor, TEST first, then PROD after verification.
-- Mirrors schedule_ai_runs (D-AISCHED audit pattern): every advisor run is
-- recorded with its exact input envelope and output, successes and failures.
-- ============================================================================
BEGIN;

CREATE TABLE public.report_ai_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_by      uuid NOT NULL REFERENCES public.profiles(id),
  run_at      timestamptz NOT NULL DEFAULT now(),
  report_slug text NOT NULL,
  model       text NOT NULL,
  envelope    jsonb NOT NULL,
  row_count   integer,
  reading     text,
  observations jsonb,
  watch_items jsonb,
  data_gaps   jsonb,
  usage       jsonb,
  error       text
);

CREATE INDEX report_ai_runs_by_user_slug
  ON public.report_ai_runs (run_by, report_slug, run_at DESC);

ALTER TABLE public.report_ai_runs ENABLE ROW LEVEL SECURITY;

-- Users read and write only their own runs. No UPDATE/DELETE policies:
-- the audit trail is append-only by design (AS9100 traceability posture).
CREATE POLICY report_ai_runs_select_own ON public.report_ai_runs
  FOR SELECT TO authenticated USING (run_by = auth.uid());

CREATE POLICY report_ai_runs_insert_own ON public.report_ai_runs
  FOR INSERT TO authenticated WITH CHECK (run_by = auth.uid());

REVOKE ALL ON public.report_ai_runs FROM anon, public;
GRANT SELECT, INSERT ON public.report_ai_runs TO authenticated;

-- ---------------------------------------------------------------------------
-- Verification — EXCEPTION on any failure; commit only if all pass.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_pols text[];
BEGIN
  -- [1/4] table exists with RLS enabled
  IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'report_ai_runs'
        AND c.relkind = 'r' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'CHECK 1 FAILED: report_ai_runs missing or RLS disabled';
  END IF;

  -- [2/4] exactly the two own-row policies, no UPDATE/DELETE
  SELECT array_agg(cmd::text ORDER BY cmd::text) INTO v_pols
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'report_ai_runs';
  IF v_pols IS DISTINCT FROM ARRAY['INSERT','SELECT'] THEN
    RAISE EXCEPTION 'CHECK 2 FAILED: expected exactly INSERT+SELECT policies, got %', v_pols;
  END IF;

  -- [3/4] anon holds zero privileges
  IF EXISTS (
      SELECT 1 FROM information_schema.table_privileges
      WHERE table_schema = 'public' AND table_name = 'report_ai_runs'
        AND grantee = 'anon') THEN
    RAISE EXCEPTION 'CHECK 3 FAILED: anon still holds privileges on report_ai_runs';
  END IF;

  -- [4/4] Batch A objects still intact — this migration must not have disturbed them
  IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'report_open_demand'
        AND c.relkind = 'v' AND 'security_invoker=on' = ANY (c.reloptions)) THEN
    RAISE EXCEPTION 'CHECK 4 FAILED: report_open_demand view missing or altered';
  END IF;
END $$;

COMMIT;

SELECT 'REPORTS ADVISOR MIGRATION VERIFIED' AS status,
       (SELECT count(*) FROM public.report_ai_runs) AS existing_runs;
