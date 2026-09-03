/* 2026-09-02_auto_close_stale_tco.sql
   Auto-close work orders that have sat in Pending TCO Review for more than
   30 days (D-TCO-AUTOCLOSE). Same three writes as the Approve TCO button
   (jobs pending_tco -> complete, work order -> complete with closed_at, any
   work_order_assemblies -> complete); closed_by stays NULL and tco_notes says
   why, so an auto-close is never mistaken for a compliance sign-off. CO
   fulfillment is untouched - it already posted on entry to pending_tco (SKY65).
   TEST first, then PROD. Run each block on its own. */

/* Block 1 - eligibility, shared by the preview and the closer.
   ready_since = the moment the LAST non-cancelled job on the WO entered
   pending_tco: co_fulfillment_applied_at (stamped on entry by the SKY65
   trigger) when present, else the latest of its last compliance approval,
   actual_end, updated_at. Eligible = every non-cancelled job is pending_tco
   (the Approve TCO button's own rule), ready_since older than p_days, no open
   shortfall on the WO, no open paperwork issue on any of its jobs. */
CREATE OR REPLACE FUNCTION public.tco_stale_candidates(p_days integer DEFAULT 30)
RETURNS TABLE (
  work_order_id uuid,
  wo_number text,
  customer text,
  part_numbers text,
  order_type text,
  due_date date,
  ready_since timestamptz,
  days_pending integer,
  job_count integer,
  pending_tco_jobs integer,
  has_open_shortfall boolean,
  open_paperwork_issues integer,
  eligible boolean,
  reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH j AS (
    SELECT jb.work_order_id, jb.id, jb.status::text AS status, jb.component_id,
           coalesce(
             jb.co_fulfillment_applied_at,
             greatest(
               (SELECT max(f.compliance_approved_at) FROM finishing_sends f WHERE f.job_id = jb.id),
               jb.actual_end,
               jb.updated_at
             )
           ) AS entered_at
    FROM jobs jb
    WHERE jb.work_order_id IS NOT NULL
      AND NOT coalesce(jb.is_maintenance, false)
      AND NOT jb.is_standalone_finishing
  ),
  per_wo AS (
    SELECT j.work_order_id,
           count(*) FILTER (WHERE j.status <> 'cancelled')::int                       AS job_count,
           count(*) FILTER (WHERE j.status = 'pending_tco')::int                      AS pending_tco_jobs,
           bool_and(j.status = 'pending_tco') FILTER (WHERE j.status <> 'cancelled')  AS all_pending_tco,
           max(j.entered_at) FILTER (WHERE j.status = 'pending_tco')                  AS ready_since,
           (SELECT count(*)::int FROM paperwork_issues pi WHERE pi.status = 'open' AND pi.job_id IN (SELECT jj.id FROM j jj WHERE jj.work_order_id = j.work_order_id)) AS open_paperwork_issues,
           (SELECT string_agg(DISTINCT p.part_number::text, ', ' ORDER BY p.part_number::text)
              FROM (
                SELECT jj.component_id AS pid FROM j jj WHERE jj.work_order_id = j.work_order_id
                UNION
                SELECT wa.assembly_id FROM work_order_assemblies wa WHERE wa.work_order_id = j.work_order_id
              ) x JOIN parts p ON p.id = x.pid) AS part_numbers
    FROM j
    GROUP BY j.work_order_id
  )
  SELECT w.id, w.wo_number::text, w.customer::text, pw.part_numbers, w.order_type::text, w.due_date,
         pw.ready_since,
         (extract(epoch FROM (now() - pw.ready_since)) / 86400)::int AS days_pending,
         pw.job_count, pw.pending_tco_jobs, w.has_open_shortfall, pw.open_paperwork_issues,
         (pw.all_pending_tco
          AND pw.ready_since < now() - make_interval(days => p_days)
          AND NOT w.has_open_shortfall
          AND pw.open_paperwork_issues = 0) AS eligible,
         CASE
           WHEN NOT pw.all_pending_tco THEN format('%s of %s jobs at pending_tco', pw.pending_tco_jobs, pw.job_count)
           WHEN pw.ready_since >= now() - make_interval(days => p_days) THEN format('pending %s days', (extract(epoch FROM (now() - pw.ready_since)) / 86400)::int)
           WHEN w.has_open_shortfall THEN 'open shortfall - compliance decides'
           WHEN pw.open_paperwork_issues > 0 THEN format('%s open paperwork issue(s)', pw.open_paperwork_issues)
           ELSE 'eligible'
         END AS reason
  FROM per_wo pw
  JOIN work_orders w ON w.id = pw.work_order_id
  WHERE pw.pending_tco_jobs > 0
    AND w.status <> 'complete'
  ORDER BY pw.ready_since
$$;

REVOKE ALL ON FUNCTION public.tco_stale_candidates(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tco_stale_candidates(integer) TO authenticated, service_role;

/* Block 2 - the closer. p_dry_run = true (default) only reports. Gate: NULL
   uid (pg_cron / SQL Editor) or admin / compliance. */
CREATE OR REPLACE FUNCTION public.auto_close_stale_tco(p_days integer DEFAULT 30, p_dry_run boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_now     timestamptz := now();
  v_row     record;
  v_closed  jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_jobs    int;
  v_note    text;
BEGIN
  IF v_uid IS NOT NULL AND NOT user_has_role(v_uid, 'admin', 'compliance') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  FOR v_row IN SELECT * FROM tco_stale_candidates(p_days) LOOP
    IF NOT v_row.eligible THEN
      v_skipped := v_skipped || jsonb_build_object('wo_number', v_row.wo_number, 'part_numbers', v_row.part_numbers,
                                                   'days_pending', v_row.days_pending, 'reason', v_row.reason);
      CONTINUE;
    END IF;

    IF NOT p_dry_run THEN
      UPDATE jobs SET status = 'complete', updated_at = v_now
       WHERE work_order_id = v_row.work_order_id AND status = 'pending_tco';
      GET DIAGNOSTICS v_jobs = ROW_COUNT;

      v_note := format('Auto-closed %s: pending TCO for %s days (policy: %s-day limit, D-TCO-AUTOCLOSE). No compliance sign-off recorded.',
                       to_char(v_now AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI'), v_row.days_pending, p_days);
      UPDATE work_orders
         SET status     = 'complete',
             tco_notes  = CASE WHEN tco_notes IS NULL OR btrim(tco_notes) = '' THEN v_note ELSE tco_notes || E'\n' || v_note END,
             closed_by  = NULL,
             closed_at  = v_now,
             updated_at = v_now
       WHERE id = v_row.work_order_id;

      UPDATE work_order_assemblies SET status = 'complete'
       WHERE work_order_id = v_row.work_order_id AND status <> 'complete';

      INSERT INTO audit_logs (event_type, job_id, machine_id, operator_id, details)
      VALUES ('tco_auto_closed', NULL, NULL, v_uid,
              jsonb_build_object('work_order_id', v_row.work_order_id, 'wo_number', v_row.wo_number,
                                 'part_numbers', v_row.part_numbers, 'days_pending', v_row.days_pending,
                                 'jobs_completed', v_jobs, 'policy_days', p_days));
    END IF;

    v_closed := v_closed || jsonb_build_object('wo_number', v_row.wo_number, 'part_numbers', v_row.part_numbers,
                                               'customer', v_row.customer, 'days_pending', v_row.days_pending,
                                               'jobs', v_row.job_count);
  END LOOP;

  IF NOT p_dry_run AND jsonb_array_length(v_closed) > 0 THEN
    INSERT INTO user_notifications (recipient_id, type, title, body, payload, created_by)
    SELECT pr.id, 'tco_auto_closed',
           format('%s work order%s auto-closed after %s days pending TCO',
                  jsonb_array_length(v_closed), CASE WHEN jsonb_array_length(v_closed) = 1 THEN '' ELSE 's' END, p_days),
           (SELECT string_agg(e->>'wo_number' || ' (' || coalesce(e->>'part_numbers', '-') || ', ' || (e->>'days_pending') || 'd)', ' · ')
              FROM jsonb_array_elements(v_closed) e),
           jsonb_build_object('closed', v_closed, 'policy_days', p_days),
           v_uid
    FROM profiles pr
    WHERE pr.is_active AND (pr.role = 'compliance' OR 'compliance' = ANY (pr.roles) OR pr.role = 'admin');
  END IF;

  RETURN jsonb_build_object(
    'dry_run', p_dry_run,
    'policy_days', p_days,
    'ran_at', v_now,
    'closed_count', jsonb_array_length(v_closed),
    'closed', v_closed,
    'skipped_count', jsonb_array_length(v_skipped),
    'skipped', v_skipped
  );
END;
$$;

REVOKE ALL ON FUNCTION public.auto_close_stale_tco(integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auto_close_stale_tco(integer, boolean) TO authenticated, service_role;

/* Block 3 - preview: what a live run would close right now, and why the rest
   would be skipped. Read-only. Look at this with Roger before Block 5. */
SELECT wo_number, part_numbers, customer, order_type, due_date,
       to_char(ready_since AT TIME ZONE 'America/New_York', 'Mon DD') AS ready_since,
       days_pending, job_count, pending_tco_jobs, eligible, reason
FROM tco_stale_candidates(30)
ORDER BY eligible DESC, ready_since;

/* Block 4 - schedule: nightly at 02:00 Eastern (06:00 UTC). pg_cron must be
   enabled first (Dashboard -> Database -> Extensions -> pg_cron); if this block
   errors with "schema cron does not exist", enable it and rerun. Idempotent:
   unschedules any previous copy first. */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'auto-close-stale-tco';
    PERFORM cron.schedule('auto-close-stale-tco', '0 6 * * *', 'SELECT public.auto_close_stale_tco(30, false)');
  ELSE
    RAISE EXCEPTION 'pg_cron is not enabled on this project - enable it under Database -> Extensions, then rerun Block 4';
  END IF;
END $$;

/* Block 5 - the first live sweep, by hand, after the preview has been reviewed.
   Returns the same shape as the preview plus what it actually closed. */
SELECT auto_close_stale_tco(30, false);

/* Block 6 - verify the schedule */
SELECT jobid, jobname, schedule, command, active FROM cron.job WHERE jobname = 'auto-close-stale-tco';
