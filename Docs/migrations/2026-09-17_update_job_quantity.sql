-- D-WOLOOKUP-QTYEDIT01: quantity edits on scheduled (assigned / in_setup) jobs.
-- New RPC; pending_compliance / ready jobs keep the existing direct client write.
-- Stamps paperwork stale (D-JOBMERGE-03 pattern), notifies compliance, audits.
-- Reductions shrink the scheduled window proportionally (cannot create overlap);
-- increases leave the window alone and report it so the scheduler re-plans.
-- TEST first, then PROD.
BEGIN;

CREATE OR REPLACE FUNCTION public.update_job_quantity(
  p_job_id uuid, p_new_quantity integer, p_reason text DEFAULT 'Work order edit'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_job          public.jobs%ROWTYPE;
  v_old_qty      integer;
  v_member_qty   integer;
  v_old_target   integer;
  v_new_target   integer;
  v_new_minutes  integer;
  v_new_end      timestamptz;
  v_window_note  text;
  v_reason       text;
BEGIN
  PERFORM public._job_merge_gate(ARRAY['admin','scheduler']);

  v_job := (SELECT j FROM public.jobs j WHERE j.id = p_job_id FOR UPDATE);
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Job % not found.', p_job_id; END IF;

  IF v_job.status NOT IN ('pending_compliance','ready','assigned','in_setup') THEN
    RAISE EXCEPTION 'Job % is % — quantity can only change before production starts. Use a lot split or merge instead.',
      v_job.job_number, v_job.status;
  END IF;
  IF v_job.merged_into_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'Job % is a merged member — edit its host or unmerge first.', v_job.job_number;
  END IF;
  IF v_job.job_number LIKE 'DTU-%' OR v_job.job_number LIKE 'DTP-%' OR COALESCE(v_job.is_maintenance, false) THEN
    RAISE EXCEPTION 'Maintenance jobs have no production quantity.';
  END IF;
  IF p_new_quantity IS NULL OR p_new_quantity < 1 THEN
    RAISE EXCEPTION 'Quantity must be at least 1.';
  END IF;

  v_old_qty := COALESCE(v_job.quantity, 0);
  IF p_new_quantity = v_old_qty THEN
    RETURN jsonb_build_object('job_number', v_job.job_number, 'changed', false, 'quantity', v_old_qty);
  END IF;

  v_member_qty := (SELECT COALESCE(SUM(requested_qty), 0)
                     FROM public.job_merge_allocations
                    WHERE host_job_id = p_job_id AND is_active);
  v_old_target := v_old_qty + v_member_qty;
  v_new_target := p_new_quantity + v_member_qty;

  -- Schedule window: shrink on reduction for assigned jobs only; never grow here.
  v_new_minutes := v_job.estimated_minutes;
  v_new_end     := v_job.scheduled_end;
  v_window_note := NULL;
  IF v_job.status = 'assigned' AND v_job.scheduled_start IS NOT NULL AND v_job.scheduled_end IS NOT NULL THEN
    IF p_new_quantity < v_old_qty AND v_old_target > 0 THEN
      v_new_minutes := GREATEST(1, round(COALESCE(v_job.estimated_minutes,
                          EXTRACT(EPOCH FROM (v_job.scheduled_end - v_job.scheduled_start)) / 60.0)
                          * v_new_target::numeric / v_old_target))::integer;
      v_new_end     := v_job.scheduled_start + make_interval(mins => v_new_minutes);
      v_window_note := 'Scheduled window shortened to match the smaller run.';
    ELSIF p_new_quantity > v_old_qty THEN
      v_window_note := 'Scheduled window left unchanged — re-plan on the Schedule board for the larger run.';
    END IF;
  END IF;

  v_reason := format('Quantity changed: %s → %s', v_old_qty, p_new_quantity)
           || CASE WHEN v_member_qty > 0
                   THEN format(' (run target %s → %s)', v_old_target, v_new_target) ELSE '' END
           || CASE WHEN NULLIF(btrim(p_reason), '') IS NOT NULL THEN ' — ' || btrim(p_reason) ELSE '' END;

  UPDATE public.jobs
     SET quantity                 = p_new_quantity,
         estimated_minutes        = v_new_minutes,
         scheduled_end            = v_new_end,
         -- Only a scheduled job can have a printed traveler worth flagging.
         paperwork_changed_at     = CASE WHEN v_job.status IN ('assigned','in_setup') THEN now() ELSE paperwork_changed_at END,
         paperwork_changed_reason = CASE WHEN v_job.status IN ('assigned','in_setup') THEN v_reason ELSE paperwork_changed_reason END,
         updated_at               = now()
   WHERE id = p_job_id;

  IF v_job.status IN ('assigned','in_setup') THEN
    PERFORM public._notify_compliance(
      'job_quantity_changed',
      v_job.job_number || ' quantity ' || v_old_qty || ' → ' || p_new_quantity,
      'Scheduled job ' || v_job.job_number || ' quantity changed ' || v_old_qty || ' → ' || p_new_quantity
        || CASE WHEN v_member_qty > 0 THEN ' (run target ' || v_old_target || ' → ' || v_new_target || ')' ELSE '' END
        || '. Any printed traveler is out of date — reprint or acknowledge.',
      jsonb_build_object('job_id', p_job_id, 'job_number', v_job.job_number,
                         'old_quantity', v_old_qty, 'new_quantity', p_new_quantity,
                         'run_target', v_new_target, 'reason', v_reason));
  END IF;

  INSERT INTO public.audit_logs (event_type, job_id, machine_id, operator_id, details)
  VALUES ('job_quantity_changed', p_job_id, v_job.assigned_machine_id, auth.uid(),
          jsonb_build_object('job_number', v_job.job_number, 'status', v_job.status,
                             'old_quantity', v_old_qty, 'new_quantity', p_new_quantity,
                             'old_run_target', v_old_target, 'new_run_target', v_new_target,
                             'window_note', v_window_note, 'reason', v_reason));

  RETURN jsonb_build_object(
    'job_number', v_job.job_number, 'changed', true,
    'old_quantity', v_old_qty, 'new_quantity', p_new_quantity,
    'run_target', v_new_target, 'window_note', v_window_note);
END;
$function$;

REVOKE ALL ON FUNCTION public.update_job_quantity(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_job_quantity(uuid, integer, text) TO authenticated;

COMMIT;

-- Verification (read-only): expect 1 row, prosecdef = true
-- select proname, prosecdef, pg_get_function_arguments(oid)
-- from pg_proc where proname = 'update_job_quantity' and pronamespace = 'public'::regnamespace;
