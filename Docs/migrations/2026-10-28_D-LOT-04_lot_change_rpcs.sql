/* ===========================================================================
   2026-10-28_D-LOT-04_lot_change_rpcs.sql
   SkyNet MES - D-LOT-04: lot-change split sizing + Correct Lot for blank jobs

   WHAT
     1. split_job_lot_change (same signature, same jsonb return; keys added):
        - Job B runs from now for remainder x pace x 1.10. Pace = Job A's actual
          production minutes / pieces made once it has made >= 25 pcs over >= 60 min;
          otherwise the planned rate (estimated_minutes / schedule_qty_basis);
          otherwise the old window, floored at one hour. Replaces copying Job A's
          scheduled_end, which gave J-000393 an end before its start (D-SCHED-31).
        - Not-started jobs that were waiting behind Job A (slot not yet ended when
          Job A went on the machine) move back behind Job B, push-only, keeping their
          durations (otherwise the longer window trips jobs_no_machine_overlap and the
          operator's Switch Lot fails). Older missed slots stay put (D-SCHED-03).
        - Job A gets time_per_unit = production minutes / pieces made (the kiosk
          completion rule), so split-closed runs feed the parts/day history.
        - The lot recorded on the split and on Job A's final batch falls back to
          jobs.blank_lot_number on blank jobs (was NULL - D-LOT-03).
        - One audit_logs row per split ('lot_change_split_sized') with the pace used
          and every queued job it moved.
     2. correct_job_blank_lot (new): the blank-lot twin of correct_job_material_lot.
        Rewrites blank_lot_number / blank_dash, the PLN (tail kept), the job's
        finishing-send lot fields, its job_splits lot fields, and repoints blank
        consumption already recorded at finishing. Once a batch on the job is
        compliance-approved it needs p_force (admin/compliance in the app; NULL uid
        in the SQL Editor is the escalation path, as in D-LOT-02).
     3. Both functions: EXECUTE for authenticated and service_role only (kiosk calls
        run under the operator's PIN session); revoked from PUBLIC and anon.
     4. Backfill: time_per_unit on past split-closed jobs (same rule, not cancelled,
        >= 25 pcs, >= 60 min), one audit row.

   HOW TO RUN (Supabase SQL Editor, RLS toggle OFF)
     1. PREVIEW -> one row, expect preview_ok = true
     2. APPLY   -> run the whole APPLY section at once; it is one transaction and the
                   guard block at its top aborts everything if the RPC fingerprint differs
     3. VERIFY  -> one row, expect verify_ok = true
   TEST first, then PROD, same text.
   =========================================================================== */


/* ---------------------------------------------------------------------------
   1. PREVIEW (read-only)
   --------------------------------------------------------------------------- */
select
  (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'split_job_lot_change')                    as split_rpc_md5,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'correct_job_blank_lot')                   as correct_blank_exists,
  (select count(*) from job_splits s join jobs j on j.id = s.original_job_id
    where s.reason = 'material lot change' and j.status <> 'cancelled' and j.time_per_unit is null
      and j.production_start is not null and j.actual_end is not null
      and s.original_qty_after >= 25
      and extract(epoch from (j.actual_end - j.production_start)) / 60.0 >= 60)          as tpu_backfill_candidates,
  (    (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'split_job_lot_change') = '336d4296c76e45d4b68eafc689f2b7bd'
   and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'correct_job_blank_lot') = 0
  )                                                                                       as preview_ok;


/* ===========================================================================
   2. APPLY - run this whole section at once (one transaction)
   =========================================================================== */

/* 2a. guard: the split RPC must still be the version this file replaces */
do $$
declare
  v_md5 text;
begin
  v_md5 := (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'split_job_lot_change');
  if v_md5 is distinct from '336d4296c76e45d4b68eafc689f2b7bd' then
    raise exception 'D-LOT-04: split_job_lot_change fingerprint is %, expected 336d4296c76e45d4b68eafc689f2b7bd - nothing changed', v_md5;
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'correct_job_blank_lot') then
    raise exception 'D-LOT-04: correct_job_blank_lot already exists - nothing changed';
  end if;
end $$;


/* 2b. split_job_lot_change */
CREATE OR REPLACE FUNCTION public.split_job_lot_change(p_job_id uuid, p_operator_id uuid, p_good_pieces integer, p_reason text DEFAULT 'material lot change'::text, p_new_lot_number text DEFAULT NULL::text)
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
  v_now          timestamptz := date_trunc('second', now());
  v_prod_minutes numeric;
  v_per_piece    numeric;
  v_pace_source  text;
  v_new_end      timestamptz;
  v_cursor       timestamptz;
  v_dur_secs     numeric;
  v_q_start      timestamptz;
  v_q_end        timestamptz;
  v_shifted      jsonb := '[]'::jsonb;
  q              record;
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

  -- D-LOT-04: size Job B from the pace Job A actually ran (production minutes per piece,
  -- the kiosk completion rule) once there is enough of it; else the planned rate; else
  -- the old window floored at an hour. +10% buffer, as the Adjust End Date calculator.
  v_prod_minutes := EXTRACT(EPOCH FROM (v_now - a.production_start)) / 60.0;
  IF v_made >= 25 AND COALESCE(v_prod_minutes, 0) >= 60 THEN
    v_per_piece   := v_prod_minutes / v_made;
    v_pace_source := 'actual';
  ELSIF COALESCE(a.estimated_minutes, 0) > 0 THEN
    v_per_piece   := a.estimated_minutes::numeric / COALESCE(NULLIF(a.schedule_qty_basis, 0), v_run_target);
    v_pace_source := 'planned';
  END IF;
  IF v_per_piece IS NOT NULL AND v_per_piece > 0 THEN
    v_minutes := GREATEST(1, ceil(v_remainder * v_per_piece * 1.10))::integer;
  ELSE
    v_minutes     := GREATEST(60, round(EXTRACT(EPOCH FROM (a.scheduled_end - v_now)) / 60.0))::integer;
    v_pace_source := 'inherited_window';
  END IF;
  v_new_end := v_now + make_interval(mins => v_minutes);

  -- D-LOT-04: queued work on this machine that was waiting behind Job A (its slot had not
  -- ended when Job A went on the machine) moves back behind Job B, push-only, durations
  -- kept. Jobs starting after the cursor stay put; slots that ended before Job A started
  -- are missed slots (D-SCHED-03) and stay where they are.
  v_cursor := v_new_end;
  FOR q IN
    SELECT j.id, j.job_number, j.scheduled_start, j.scheduled_end, j.estimated_minutes
      FROM public.jobs j
     WHERE j.assigned_machine_id = a.assigned_machine_id
       AND j.id <> p_job_id
       AND j.status IN ('ready', 'assigned', 'pending_compliance')
       AND j.scheduled_start IS NOT NULL
       AND j.scheduled_end IS NOT NULL
       AND j.scheduled_end > j.scheduled_start
       AND j.scheduled_end > COALESCE(a.setup_start, a.production_start, a.scheduled_start, v_now)
     ORDER BY j.scheduled_start, j.id
     FOR UPDATE
  LOOP
    v_dur_secs := COALESCE(NULLIF(q.estimated_minutes, 0) * 60.0,
                           EXTRACT(EPOCH FROM (q.scheduled_end - q.scheduled_start)));
    v_q_start  := GREATEST(v_cursor, q.scheduled_start);
    IF v_q_start <> q.scheduled_start THEN
      v_q_end := v_q_start + make_interval(secs => v_dur_secs);
      UPDATE public.jobs
         SET scheduled_start = v_q_start,
             scheduled_end   = v_q_end,
             updated_at      = now()
       WHERE id = q.id;
      v_shifted := v_shifted || jsonb_build_object(
        'job_id', q.id, 'job_number', q.job_number,
        'old_start', q.scheduled_start, 'old_end', q.scheduled_end,
        'new_start', v_q_start, 'new_end', v_q_end);
      v_cursor := v_q_end;
    ELSE
      v_cursor := GREATEST(v_cursor, q.scheduled_end);
    END IF;
  END LOOP;

  -- Job B: plain remainder job on the host WO. Merge allocations stay with Job A.
  INSERT INTO public.jobs (
    job_number, work_order_id, part_id, component_id, work_order_assembly_id,
    quantity, status, priority, assigned_machine_id,
    scheduled_start, scheduled_end, estimated_minutes, production_lot_number, created_at, updated_at
  ) VALUES (
    v_new_number, a.work_order_id, a.part_id, a.component_id, a.work_order_assembly_id,
    v_remainder, 'assigned', a.priority, a.assigned_machine_id,
    v_now, v_new_end, v_minutes, NULL, now(), now()
  ) RETURNING id INTO v_new_job_id;

  -- Job A finalizes at the made count. On a merge host the run target moved, so the
  -- host traveler is stamped stale (D-JOBMERGE-03 pattern; derived, no clear-flag).
  -- D-LOT-04: time_per_unit as the kiosk completion writes it (production minutes / made).
  UPDATE public.jobs
     SET quantity = v_made, good_pieces = v_made, status = 'manufacturing_complete',
         actual_end = now(), checked_out_at = now(), updated_at = now(),
         time_per_unit = CASE WHEN COALESCE(v_prod_minutes, 0) > 0
                              THEN round(v_prod_minutes / v_made, 2)
                              ELSE time_per_unit END,
         paperwork_changed_at = CASE WHEN v_member_qty > 0 THEN now() ELSE paperwork_changed_at END,
         paperwork_changed_reason = CASE WHEN v_member_qty > 0
           THEN format('Lot-change split: run target %s → %s on this job; %s continues on %s',
                       v_run_target, v_made, v_remainder, v_new_number)
           ELSE paperwork_changed_reason END
   WHERE id = p_job_id;

  -- D-LOT-04: blank jobs carry their lot on jobs.blank_lot_number (no job_materials row).
  v_material_lot := COALESCE((SELECT lot_number FROM public.job_materials
                               WHERE job_id = p_job_id AND lot_number IS NOT NULL LIMIT 1),
                             a.blank_lot_number);
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

  INSERT INTO public.audit_logs (event_type, job_id, operator_id, details)
  VALUES ('lot_change_split_sized', v_new_job_id, p_operator_id, jsonb_build_object(
    'job_a', a.job_number, 'job_b', v_new_number, 'machine_id', a.assigned_machine_id,
    'made', v_made, 'remainder', v_remainder, 'production_minutes', round(v_prod_minutes, 1),
    'pace_source', v_pace_source, 'minutes_per_piece', round(v_per_piece, 3),
    'estimated_minutes', v_minutes, 'scheduled_start', v_now, 'scheduled_end', v_new_end,
    'job_a_planned_end', a.scheduled_end, 'queue_shifted', v_shifted, 'decision', 'D-LOT-04'));

  RETURN jsonb_build_object(
    'new_job_id', v_new_job_id, 'new_job_number', v_new_number,
    'remainder', v_remainder, 'run_target', v_run_target,
    'new_end', v_new_end, 'estimated_minutes', v_minutes, 'pace_source', v_pace_source,
    'queue_shifted', jsonb_array_length(v_shifted)
  );
END;
$function$;


/* 2c. correct_job_blank_lot */
CREATE OR REPLACE FUNCTION public.correct_job_blank_lot(p_job_id uuid, p_new_lot text, p_new_dash text DEFAULT NULL::text, p_operator_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text, p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_job          public.jobs%ROWTYPE;
  v_old_lot      text;
  v_old_dash     text;
  v_new_dash     text;
  v_old_pln      text;
  v_new_pln      text;
  v_tail         text;
  v_recv_id      uuid;
  v_material_id  uuid;
  v_approved     integer;
  v_sends_pln    integer := 0;
  v_sends_mat    integer := 0;
  v_splits       integer := 0;
  v_usage_rows   integer := 0;
  v_n            integer := 0;
BEGIN
  p_new_lot := NULLIF(btrim(p_new_lot), '');
  IF p_new_lot IS NULL THEN
    RAISE EXCEPTION 'A blank lot number is required';
  END IF;

  v_job := (SELECT j FROM public.jobs j WHERE j.id = p_job_id FOR UPDATE);
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Job not found'; END IF;
  IF v_job.status = 'cancelled' THEN
    RAISE EXCEPTION 'Job % is cancelled', v_job.job_number;
  END IF;
  IF v_job.blank_lot_number IS NULL THEN
    RAISE EXCEPTION 'Job % has no blank lot — bar jobs are corrected with Correct Lot', v_job.job_number;
  END IF;

  v_old_lot  := v_job.blank_lot_number;
  v_old_dash := v_job.blank_dash;
  v_new_dash := COALESCE(NULLIF(btrim(p_new_dash), ''), v_old_dash);
  v_old_pln  := v_job.production_lot_number;

  IF v_old_lot = p_new_lot AND v_old_dash IS NOT DISTINCT FROM v_new_dash THEN
    RETURN jsonb_build_object('changed', false, 'reason', 'lot already set to this value');
  END IF;

  -- D-LOT-04 guard: an approved batch already carries this lot on its paperwork.
  v_approved := (SELECT count(*) FROM public.finishing_sends s
                  WHERE s.job_id = p_job_id AND s.compliance_status = 'approved');
  IF v_approved > 0 AND NOT COALESCE(p_force, false) THEN
    RAISE EXCEPTION 'Compliance has already approved % batch(es) on this job under lot %. An admin or compliance user has to make this correction.', v_approved, v_old_lot;
  END IF;

  -- p_force from the app requires admin or compliance. auth.uid() is NULL in the SQL
  -- Editor and for service-role calls; that is the deliberate escalation path (D-LOT-02).
  IF COALESCE(p_force, false) AND auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = auth.uid()
         AND (p.role IN ('admin', 'compliance') OR p.roles && array['admin', 'compliance']::text[])
    ) THEN
      RAISE EXCEPTION 'Forced lot correction requires the admin or compliance role';
    END IF;
  END IF;

  -- Rewrite only the lot segment of the PLN, keeping its date and sequence (D-LOT-01).
  IF v_old_pln IS NOT NULL THEN
    v_tail := substring(v_old_pln FROM '-\d{6}-\d{4}$');
    IF v_tail IS NOT NULL THEN
      v_new_pln := 'PLN-' || p_new_lot || v_tail;
    END IF;
  END IF;

  UPDATE public.jobs
     SET blank_lot_number      = p_new_lot,
         blank_dash            = v_new_dash,
         production_lot_number = COALESCE(v_new_pln, production_lot_number),
         updated_at            = now()
   WHERE id = p_job_id;

  IF v_new_pln IS NOT NULL THEN
    UPDATE public.finishing_sends
       SET production_lot_number = v_new_pln, updated_at = now()
     WHERE job_id = p_job_id
       AND production_lot_number IS NOT DISTINCT FROM v_old_pln;
    GET DIAGNOSTICS v_sends_pln = ROW_COUNT;
  END IF;

  UPDATE public.finishing_sends
     SET material_lot_number = p_new_lot, updated_at = now()
   WHERE job_id = p_job_id
     AND (material_lot_number IS NOT DISTINCT FROM v_old_lot OR material_lot_number IS NULL);
  GET DIAGNOSTICS v_sends_mat = ROW_COUNT;

  UPDATE public.job_splits SET new_lot_number = p_new_lot
   WHERE new_job_id = p_job_id AND new_lot_number IS NOT DISTINCT FROM v_old_lot;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_splits := v_n;
  UPDATE public.job_splits SET old_lot_number = p_new_lot
   WHERE original_job_id = p_job_id AND old_lot_number IS NOT DISTINCT FROM v_old_lot;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_splits := v_splits + v_n;

  -- The blank receipt for the corrected lot/dash (the consume_blank_lot rule).
  v_recv_id := (SELECT mr.id FROM public.material_receiving mr
                 WHERE mr.category = 'blank'
                   AND mr.lot_number = p_new_lot
                   AND (v_new_dash IS NULL OR mr.bar_size = v_new_dash)
                 ORDER BY mr.received_at DESC, mr.id
                 LIMIT 1);
  v_material_id := (SELECT mr.material_id FROM public.material_receiving mr WHERE mr.id = v_recv_id);

  -- Blank consumption already recorded at finishing follows the lot.
  UPDATE public.material_usage
     SET lot_number            = p_new_lot,
         material_receiving_id = v_recv_id,
         material_id           = v_material_id,
         notes = concat_ws(' | ', notes, 'Blank lot corrected ' || v_old_lot || ' -> ' || p_new_lot || ' (D-LOT-04)')
   WHERE job_id = p_job_id
     AND finishing_send_id IS NOT NULL
     AND quantity_used > 0
     AND lot_number IS NOT DISTINCT FROM v_old_lot;
  GET DIAGNOSTICS v_usage_rows = ROW_COUNT;

  IF v_usage_rows > 0 AND v_recv_id IS NULL THEN
    INSERT INTO public.audit_logs (event_type, job_id, operator_id, details)
    VALUES ('inventory_warning', p_job_id, p_operator_id, jsonb_build_object(
      'warning', 'Blank lot corrected but no blank receipt found for the new lot',
      'lot_number', p_new_lot, 'blank_dash', v_new_dash, 'usage_rows', v_usage_rows));
  END IF;

  INSERT INTO public.audit_logs (event_type, job_id, operator_id, details)
  VALUES ('material_lot_corrected', p_job_id, p_operator_id, jsonb_build_object(
    'job_number', v_job.job_number, 'job_status', v_job.status, 'kind', 'blank',
    'old_lot', v_old_lot, 'new_lot', p_new_lot, 'old_dash', v_old_dash, 'new_dash', v_new_dash,
    'old_pln', v_old_pln, 'new_pln', v_new_pln,
    'approved_batches', v_approved, 'forced', COALESCE(p_force, false),
    'finishing_sends_pln_updated', v_sends_pln, 'finishing_sends_material_lot_updated', v_sends_mat,
    'job_splits_updated', v_splits, 'blank_usage_repointed', v_usage_rows,
    'material_receiving_id', v_recv_id, 'reason', p_reason, 'decision', 'D-LOT-04'));

  RETURN jsonb_build_object(
    'changed', true, 'job_number', v_job.job_number,
    'old_lot', v_old_lot, 'new_lot', p_new_lot, 'old_dash', v_old_dash, 'new_dash', v_new_dash,
    'old_pln', v_old_pln, 'new_pln', v_new_pln,
    'finishing_sends_updated', GREATEST(v_sends_pln, v_sends_mat),
    'blank_usage_repointed', v_usage_rows);
END;
$function$;


/* 2d. execute rights: the operator's PIN session (authenticated) and service_role only */
REVOKE ALL ON FUNCTION public.split_job_lot_change(uuid, uuid, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.split_job_lot_change(uuid, uuid, integer, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.correct_job_blank_lot(uuid, text, text, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_job_blank_lot(uuid, text, text, uuid, text, boolean) TO authenticated, service_role;


/* 2e. backfill time_per_unit on past split-closed jobs (same rule as the RPC) */
do $$
declare
  v_rows jsonb;
  v_n    integer;
begin
  v_rows := (select coalesce(jsonb_agg(jsonb_build_object(
                'job_number', j.job_number, 'made', s.original_qty_after,
                'time_per_unit', round((extract(epoch from (j.actual_end - j.production_start)) / 60.0 / s.original_qty_after)::numeric, 2))
                order by j.job_number), '[]'::jsonb)
               from job_splits s join jobs j on j.id = s.original_job_id
              where s.reason = 'material lot change' and j.status <> 'cancelled' and j.time_per_unit is null
                and j.production_start is not null and j.actual_end is not null
                and s.original_qty_after >= 25
                and extract(epoch from (j.actual_end - j.production_start)) / 60.0 >= 60);

  update jobs j
     set time_per_unit = round((extract(epoch from (j.actual_end - j.production_start)) / 60.0 / s.original_qty_after)::numeric, 2)
    from job_splits s
   where s.original_job_id = j.id
     and s.reason = 'material lot change' and j.status <> 'cancelled' and j.time_per_unit is null
     and j.production_start is not null and j.actual_end is not null
     and s.original_qty_after >= 25
     and extract(epoch from (j.actual_end - j.production_start)) / 60.0 >= 60;
  get diagnostics v_n = row_count;

  insert into audit_logs (event_type, job_id, operator_id, details)
  values ('time_per_unit_backfilled', null, null, jsonb_build_object(
    'rule', 'split-closed job: (actual_end - production_start) minutes / pieces made; >= 25 pcs, >= 60 min; cancelled excluded',
    'rows', v_n, 'jobs', v_rows, 'marker', 'D-LOT-04',
    'correction', '2026-10-28_D-LOT-04_lot_change_rpcs.sql'));
end $$;


/* ---------------------------------------------------------------------------
   3. VERIFY. Expect verify_ok = true. (Fingerprints ignore line endings; values pinned from TEST.)
   --------------------------------------------------------------------------- */
select
  (select md5(replace(pg_get_functiondef(p.oid), E'\r', '')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'split_job_lot_change')                    as split_rpc_md5,
  (select md5(replace(pg_get_functiondef(p.oid), E'\r', '')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'correct_job_blank_lot')                   as correct_blank_md5,
  (select string_agg(r || '=' || has_function_privilege(r, 'public.split_job_lot_change(uuid, uuid, integer, text, text)', 'EXECUTE')::text
                     || '/' || has_function_privilege(r, 'public.correct_job_blank_lot(uuid, text, text, uuid, text, boolean)', 'EXECUTE')::text, ', ')
     from unnest(array['anon', 'authenticated', 'service_role']) r)                       as execute_rights,
  (select count(*) from job_splits s join jobs j on j.id = s.original_job_id
    where s.reason = 'material lot change' and j.status <> 'cancelled' and j.time_per_unit is null
      and j.production_start is not null and j.actual_end is not null
      and s.original_qty_after >= 25
      and extract(epoch from (j.actual_end - j.production_start)) / 60.0 >= 60)          as tpu_still_missing,
  (select count(*) from audit_logs where event_type = 'time_per_unit_backfilled' and details->>'marker' = 'D-LOT-04') as backfill_audit_rows,
  (    (select md5(replace(pg_get_functiondef(p.oid), E'\r', '')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'split_job_lot_change') = '8301b7a79383b4e758a70b019bf84046'
   and (select md5(replace(pg_get_functiondef(p.oid), E'\r', '')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'correct_job_blank_lot') = '07e6525f6c4dd3aa897de744a54ef479'
   and not has_function_privilege('anon', 'public.split_job_lot_change(uuid, uuid, integer, text, text)', 'EXECUTE')
   and not has_function_privilege('anon', 'public.correct_job_blank_lot(uuid, text, text, uuid, text, boolean)', 'EXECUTE')
   and has_function_privilege('authenticated', 'public.split_job_lot_change(uuid, uuid, integer, text, text)', 'EXECUTE')
   and has_function_privilege('authenticated', 'public.correct_job_blank_lot(uuid, text, text, uuid, text, boolean)', 'EXECUTE')
   and (select count(*) from job_splits s join jobs j on j.id = s.original_job_id
         where s.reason = 'material lot change' and j.status <> 'cancelled' and j.time_per_unit is null
           and j.production_start is not null and j.actual_end is not null
           and s.original_qty_after >= 25
           and extract(epoch from (j.actual_end - j.production_start)) / 60.0 >= 60) = 0
   and (select count(*) from audit_logs where event_type = 'time_per_unit_backfilled' and details->>'marker' = 'D-LOT-04') = 1
  )                                                                                       as verify_ok;
