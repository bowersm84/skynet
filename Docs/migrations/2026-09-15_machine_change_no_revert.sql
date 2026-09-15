-- D-SCHED-25: a machine change on an approved job no longer reverts compliance.
-- The job stays 'assigned' with its document approvals intact; the traveler is
-- stamped stale (D-JOBMERGE-03 derived pattern) and compliance is notified.
-- p_revert_compliance is retained in the signature (avoids a second overload)
-- but no longer resets anything.
-- Same signature → CREATE OR REPLACE is safe; grants unchanged. TEST first, then PROD.
BEGIN;

CREATE OR REPLACE FUNCTION public.reschedule_with_cascade(
  p_target_id uuid, p_target_machine_id uuid,
  p_target_start timestamp with time zone, p_target_end timestamp with time zone,
  p_target_minutes integer, p_new_status text, p_scheduled_by uuid,
  p_cascade jsonb DEFAULT '[]'::jsonb, p_revert_compliance boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c               jsonb;
  v_job           public.jobs%ROWTYPE;
  v_old_machine   text;
  v_new_machine   text;
  v_machine_moved boolean;
  v_reason        text;
BEGIN
  -- Defer the overlap check to the end of this transaction (explicit/defensive —
  -- the constraint is already INITIALLY DEFERRED).
  SET CONSTRAINTS jobs_no_machine_overlap DEFERRED;

  v_job := (SELECT j FROM public.jobs j WHERE j.id = p_target_id FOR UPDATE);
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Job % not found.', p_target_id; END IF;

  -- Machine moved on a job compliance already approved for a machine.
  v_machine_moved := v_job.assigned_machine_id IS NOT NULL
                 AND v_job.assigned_machine_id IS DISTINCT FROM p_target_machine_id
                 AND v_job.status = 'assigned';

  -- 1) Shift each downstream job to its new window.
  FOR c IN SELECT * FROM jsonb_array_elements(p_cascade)
  LOOP
    UPDATE public.jobs
       SET scheduled_start = (c->>'new_start')::timestamptz,
           scheduled_end   = (c->>'new_end')::timestamptz,
           updated_at      = now()
     WHERE id = (c->>'job_id')::uuid;
  END LOOP;

  -- 2) Place the target. Status never drops to pending_compliance here:
  --    an approved job stays approved through a machine change.
  UPDATE public.jobs
     SET assigned_machine_id = p_target_machine_id,
         scheduled_start     = p_target_start,
         scheduled_end       = p_target_end,
         estimated_minutes   = p_target_minutes,
         status              = CASE WHEN p_new_status = 'pending_compliance' AND v_job.status = 'assigned'
                                    THEN 'assigned' ELSE p_new_status END,
         scheduled_by        = p_scheduled_by,
         scheduled_at        = now(),
         updated_at          = now()
   WHERE id = p_target_id;

  -- 3) Machine change on an approved job: stamp the traveler stale and notify.
  IF v_machine_moved THEN
    v_old_machine := (SELECT name FROM public.machines WHERE id = v_job.assigned_machine_id);
    v_new_machine := (SELECT name FROM public.machines WHERE id = p_target_machine_id);
    v_reason := format('Machine changed: %s → %s', COALESCE(v_old_machine, '—'), COALESCE(v_new_machine, '—'));

    UPDATE public.jobs
       SET paperwork_changed_at     = now(),
           paperwork_changed_reason = v_reason
     WHERE id = p_target_id;

    PERFORM public._notify_compliance(
      'machine_changed',
      v_job.job_number || ' moved to ' || COALESCE(v_new_machine, 'another machine'),
      'Approved job ' || v_job.job_number || ' was rescheduled from ' || COALESCE(v_old_machine, '—')
        || ' to ' || COALESCE(v_new_machine, '—') || '. Reprint the traveler or acknowledge to continue on existing paper.',
      jsonb_build_object('job_id', p_target_id, 'job_number', v_job.job_number,
                         'old_machine_id', v_job.assigned_machine_id, 'new_machine_id', p_target_machine_id,
                         'reason', v_reason));

    INSERT INTO public.audit_logs (event_type, job_id, machine_id, operator_id, details)
    VALUES ('machine_changed', p_target_id, p_target_machine_id, p_scheduled_by,
            jsonb_build_object('job_number', v_job.job_number,
                               'old_machine_id', v_job.assigned_machine_id,
                               'new_machine_id', p_target_machine_id,
                               'reason', v_reason));
  END IF;
END;
$function$;

COMMIT;

-- Verification (run after each environment): expect patched = true, overloads = 1
-- select pg_get_functiondef('public.reschedule_with_cascade'::regproc) like '%v_machine_moved%' as patched,
--        (select count(*) from pg_proc where proname = 'reschedule_with_cascade') as overloads;
