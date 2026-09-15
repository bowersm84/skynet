-- D-JOBMERGE-20: split_job_lot_change computes remainder against the RUN TARGET
-- (own quantity + active merged member qty), matching getRunTarget() in the kiosk.
-- Same signature → CREATE OR REPLACE is safe; grants unchanged.
-- Applied TEST then PROD 2026-09-15 (J-000229 / SK27CP8 lot-change split).
BEGIN;

CREATE OR REPLACE FUNCTION public.split_job_lot_change(
  p_job_id uuid, p_operator_id uuid, p_good_pieces integer,
  p_reason text DEFAULT 'material lot change'::text,
  p_new_lot_number text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  a              public.jobs%ROWTYPE;
  v_made         integer;
  v_remainder    integer;
  v_own_qty      integer;
  v_member_qty   integer;
  v_run_target   integer;
  v_already_sent integer;
  v_final_send   integer;
  v_material_lot text;
  v_new_job_id   uuid;
  v_new_number   text;
  v_next_num     bigint;
  v_minutes      integer;
BEGIN
  a := (SELECT j FROM public.jobs j WHERE j.id = p_job_id FOR UPDATE);
  IF a.id IS NULL THEN RAISE EXCEPTION 'Job % not found.', p_job_id; END IF;
  IF a.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Lot change requires an in-progress job (job is %).', a.status;
  END IF;
  IF a.job_number LIKE 'DTU-%' OR a.job_number LIKE 'DTP-%' OR COALESCE(a.is_maintenance, false) THEN
    RAISE EXCEPTION 'Maintenance jobs cannot be lot-split.';
  END IF;
  IF a.merged_into_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'Job % is a merged member — the lot change is declared on its host.', a.job_number;
  END IF;

  v_own_qty    := COALESCE(a.quantity, 0);
  v_member_qty := (SELECT COALESCE(SUM(requested_qty), 0)
                     FROM public.job_merge_allocations
                    WHERE host_job_id = p_job_id AND is_active);
  v_run_target := v_own_qty + v_member_qty;                 -- D-JOBMERGE-04 run target
  v_made       := COALESCE(p_good_pieces, 0);

  v_already_sent := (SELECT COALESCE(SUM(quantity), 0)
                       FROM public.finishing_sends WHERE job_id = p_job_id);

  v_remainder := v_run_target - v_made;

  IF v_made <= 0 THEN RAISE EXCEPTION 'Enter the number of good pieces made on this lot.'; END IF;
  IF v_made < v_already_sent THEN
    RAISE EXCEPTION 'Made count (%) is below the % pieces already sent to finishing.', v_made, v_already_sent;
  END IF;
  IF v_remainder <= 0 THEN
    RAISE EXCEPTION 'No remainder left against the run target of % — complete the job normally rather than splitting.', v_run_target;
  END IF;

  v_next_num := (SELECT COALESCE(MAX(substring(job_number FROM '^J-([0-9]+)$')::bigint), 0) + 1
                   FROM public.jobs WHERE job_number ~ '^J-[0-9]+$');
  v_new_number := 'J-' || lpad(v_next_num::text, 6, '0');

  v_minutes := GREATEST(1, round(EXTRACT(EPOCH FROM (a.scheduled_end - now())) / 60.0))::integer;

  -- Job B: plain remainder job on the host WO. Merge allocations stay with Job A.
  INSERT INTO public.jobs (
    job_number, work_order_id, part_id, component_id, work_order_assembly_id,
    quantity, status, priority, assigned_machine_id,
    scheduled_start, scheduled_end, estimated_minutes, production_lot_number, created_at, updated_at
  ) VALUES (
    v_new_number, a.work_order_id, a.part_id, a.component_id, a.work_order_assembly_id,
    v_remainder, 'assigned', a.priority, a.assigned_machine_id,
    now(), a.scheduled_end, v_minutes, NULL, now(), now()
  ) RETURNING id INTO v_new_job_id;

  -- Job A finalizes at the made count. On a merge host the run target moved, so the
  -- host traveler is stamped stale (D-JOBMERGE-03 pattern; derived, no clear-flag).
  UPDATE public.jobs
     SET quantity = v_made, good_pieces = v_made, status = 'manufacturing_complete',
         actual_end = now(), checked_out_at = now(), updated_at = now(),
         paperwork_changed_at = CASE WHEN v_member_qty > 0 THEN now() ELSE paperwork_changed_at END,
         paperwork_changed_reason = CASE WHEN v_member_qty > 0
           THEN format('Lot-change split: run target %s → %s on this job; %s continues on %s',
                       v_run_target, v_made, v_remainder, v_new_number)
           ELSE paperwork_changed_reason END
   WHERE id = p_job_id;

  v_material_lot := (SELECT lot_number FROM public.job_materials
                      WHERE job_id = p_job_id AND lot_number IS NOT NULL LIMIT 1);
  v_final_send := v_made - v_already_sent;
  IF v_final_send > 0 THEN
    INSERT INTO public.finishing_sends (
      job_id, machine_id, sent_by, quantity, production_lot_number, material_lot_number,
      status, is_partial_send, notes
    ) VALUES (
      p_job_id, a.assigned_machine_id, p_operator_id, v_final_send,
      a.production_lot_number, v_material_lot, 'pending_finishing', false, 'Material lot change — Job A finalized'
    );
  END IF;

  INSERT INTO public.job_documents (
    job_id, document_type_id, file_name, file_url, file_size, mime_type, uploaded_by, status, source
  )
  SELECT v_new_job_id, jd.document_type_id, jd.file_name, jd.file_url, jd.file_size, jd.mime_type,
         p_operator_id, 'approved', COALESCE(jd.source, 'part_pulled_forward')
    FROM public.job_documents jd
   WHERE jd.job_id = p_job_id AND COALESCE(jd.status, 'approved') <> 'rejected';

  INSERT INTO public.job_routing_steps (job_id, step_order, step_name, step_type, station, status)
  SELECT v_new_job_id, prs.step_order, prs.step_name, prs.step_type, prs.default_station, 'pending'
    FROM public.part_routing_steps prs
   WHERE prs.part_id = a.component_id AND prs.is_active = true
   ORDER BY prs.step_order;

  -- original_qty_before = run target so the split reads target → made + remainder.
  INSERT INTO public.job_splits (
    original_job_id, new_job_id, split_by, original_qty_before, original_qty_after, new_job_qty,
    reason, old_lot_number, new_lot_number
  ) VALUES (
    p_job_id, v_new_job_id, p_operator_id, v_run_target, v_made, v_remainder,
    p_reason, v_material_lot, NULLIF(btrim(p_new_lot_number), '')
  );

  RETURN jsonb_build_object(
    'new_job_id', v_new_job_id, 'new_job_number', v_new_number,
    'remainder', v_remainder, 'run_target', v_run_target, 'inherited_end', a.scheduled_end
  );
END;
$function$;

COMMIT;

-- Verification (run after each environment): expect patched = true, overloads = 1
-- select pg_get_functiondef('public.split_job_lot_change'::regproc) like '%v_run_target%' as patched,
--        (select count(*) from pg_proc where proname = 'split_job_lot_change') as overloads;
