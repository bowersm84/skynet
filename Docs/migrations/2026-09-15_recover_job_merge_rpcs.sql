-- D-JOBMERGE-21: RECOVERY of job-merge RPC source. These three functions were
-- deployed to TEST and PROD by JobMerge_R3_TEST_Migration.sql (D-JOBMERGE-03), which
-- was never tracked in Docs/migrations/. Bodies below are verbatim from
-- pg_get_functiondef on PROD, 2026-09-15 — the record of what is running, not a change.
--
-- Running this is a no-op against a current database (CREATE OR REPLACE, identical
-- bodies). GRANT/REVOKE statements were not captured by pg_get_functiondef and are
-- not restated here; existing privileges are unaffected by this file.
--
-- Note the paperwork_changed_reason prefixes these write — the D-SCHED-26a classifier
-- depends on them:
--   merge_job_into_host : host   'Merge: +N pcs (...) — run target A → B'
--                         member 'Merged into J-... — produced under the host run'
--   unmerge_job         : host   'Unmerge: -N pcs (...) — run target A → B'
--                         member 'Unmerged from J-... — standalone job again'
--
-- Also note: _job_merge_gate is NOT SECURITY DEFINER (callers are), and it deliberately
-- returns when auth.uid() IS NULL — the SQL Editor escalation path (D-LOT-01 pattern).

-- ============================================================================
-- _job_merge_gate
-- ============================================================================
CREATE OR REPLACE FUNCTION public._job_merge_gate(p_roles text[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  IF public.user_has_role(auth.uid(), VARIADIC p_roles) THEN
    RETURN;
  END IF;
  RAISE EXCEPTION 'Insufficient role for job-merge operation (need one of: %)',
    array_to_string(p_roles, ', ')
    USING ERRCODE = 'insufficient_privilege';
END $function$;

-- ============================================================================
-- merge_job_into_host
-- ============================================================================
CREATE OR REPLACE FUNCTION public.merge_job_into_host(p_member_job_id uuid, p_host_job_id uuid, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_host             public.jobs%ROWTYPE;
  v_member           public.jobs%ROWTYPE;
  v_wocj_id          uuid;
  v_part_number      text;
  v_run_target       bigint;
  v_old_target       bigint;
  v_member_wo_number text;
  v_member_customer  text;
BEGIN
  PERFORM public._job_merge_gate(ARRAY['admin','scheduler']);

  IF p_member_job_id = p_host_job_id THEN
    RAISE EXCEPTION 'A job cannot be merged into itself';
  END IF;

  -- Lock both rows in stable id order (same order used by unmerge_job).
  PERFORM 1 FROM public.jobs
   WHERE id IN (p_member_job_id, p_host_job_id)
   ORDER BY id
   FOR UPDATE;

  SELECT * INTO v_host   FROM public.jobs WHERE id = p_host_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Host job % not found', p_host_job_id; END IF;
  SELECT * INTO v_member FROM public.jobs WHERE id = p_member_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member job % not found', p_member_job_id; END IF;

  -- ---- Host eligibility -----------------------------------------------------
  IF v_host.is_maintenance THEN
    RAISE EXCEPTION 'Host % is a maintenance job', v_host.job_number;
  END IF;
  IF v_host.is_standalone_finishing THEN
    RAISE EXCEPTION 'Host % is a standalone finishing job', v_host.job_number;
  END IF;
  IF v_host.merged_into_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'Host % is itself merged into another job', v_host.job_number;
  END IF;
  IF v_host.status NOT IN ('pending_compliance','ready','assigned','in_setup','in_progress') THEN
    RAISE EXCEPTION 'Host % has status % — merging closes at production completion',
      v_host.job_number, v_host.status;
  END IF;
  IF v_host.component_id IS NULL THEN
    RAISE EXCEPTION 'Host % has no component_id', v_host.job_number;
  END IF;

  -- ---- Member eligibility ("a started job never becomes a member") ---------
  IF v_member.is_maintenance THEN
    RAISE EXCEPTION 'Member % is a maintenance job', v_member.job_number;
  END IF;
  IF v_member.is_standalone_finishing THEN
    RAISE EXCEPTION 'Member % is a standalone finishing job', v_member.job_number;
  END IF;
  IF v_member.merged_into_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'Member % is already merged', v_member.job_number;
  END IF;
  IF v_member.status NOT IN ('pending_compliance','ready','assigned') THEN
    RAISE EXCEPTION 'Member % has status % — only untouched pre-start jobs can merge',
      v_member.job_number, v_member.status;
  END IF;
  IF v_member.production_lot_number IS NOT NULL
     OR v_member.setup_start IS NOT NULL
     OR v_member.production_start IS NOT NULL
     OR v_member.actual_start IS NOT NULL THEN
    RAISE EXCEPTION 'Member % has already been started at a machine', v_member.job_number;
  END IF;
  IF v_member.component_id IS NULL OR v_member.component_id <> v_host.component_id THEN
    RAISE EXCEPTION 'Member % and host % are not the same component',
      v_member.job_number, v_host.job_number;
  END IF;
  IF v_member.quantity IS NULL OR v_member.quantity <= 0 THEN
    RAISE EXCEPTION 'Member % has no positive quantity', v_member.job_number;
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_materials    WHERE job_id = p_member_job_id) THEN
    RAISE EXCEPTION 'Member % already has material issued', v_member.job_number;
  END IF;
  IF EXISTS (SELECT 1 FROM public.finishing_sends  WHERE job_id = p_member_job_id) THEN
    RAISE EXCEPTION 'Member % already has finishing sends', v_member.job_number;
  END IF;
  IF EXISTS (SELECT 1 FROM public.outbound_sends   WHERE job_id = p_member_job_id) THEN
    RAISE EXCEPTION 'Member % already has outsourcing sends', v_member.job_number;
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_merge_allocations
              WHERE host_job_id = p_member_job_id AND is_active) THEN
    RAISE EXCEPTION 'Member % is itself a host of an active merge — unmerge its members first',
      v_member.job_number;
  END IF;

  -- ---- Cross-WO traceability link (feeds the cert package builder) ---------
  IF v_member.work_order_id IS NOT NULL
     AND v_member.work_order_id IS DISTINCT FROM v_host.work_order_id THEN
    INSERT INTO public.work_order_component_jobs (work_order_id, job_id, linked_by, notes)
    VALUES (
      v_member.work_order_id,
      p_host_job_id,
      auth.uid(),
      'Job merge: host run ' || v_host.job_number || ' carries ' || v_member.job_number
    )
    RETURNING id INTO v_wocj_id;
  END IF;

  -- ---- Allocation claim -----------------------------------------------------
  INSERT INTO public.job_merge_allocations
    (host_job_id, member_job_id, member_work_order_id, requested_qty,
     pre_merge_status, linked_wocj_id, merged_by, notes)
  VALUES
    (p_host_job_id, p_member_job_id, v_member.work_order_id, v_member.quantity,
     v_member.status, v_wocj_id, auth.uid(), p_notes);

  SELECT part_number INTO v_part_number FROM public.parts WHERE id = v_host.component_id;

  SELECT v_host.quantity + COALESCE(SUM(requested_qty), 0)
    INTO v_run_target
    FROM public.job_merge_allocations
   WHERE host_job_id = p_host_job_id AND is_active;

  v_old_target := v_run_target - v_member.quantity;

  SELECT wo_number, customer INTO v_member_wo_number, v_member_customer
    FROM public.work_orders WHERE id = v_member.work_order_id;

  -- ---- Member leaves the board: status merged, schedule + machine cleared,
  --      own paperwork stamped stale (its printed traveler, if any, no longer
  --      describes how the pieces will be produced) ---------------------------
  UPDATE public.jobs
     SET status                   = 'merged',
         -- D-JOBMERGE-12: a member merged while awaiting pre-production
         -- review carries the obligation with it.
         merge_requires_compliance_ack = (v_member.status = 'pending_compliance'),
         merged_into_job_id       = p_host_job_id,
         scheduled_start          = NULL,
         scheduled_end            = NULL,
         assigned_machine_id      = NULL,
         scheduled_by             = NULL,
         scheduled_at             = NULL,
         paperwork_changed_at     = now(),
         paperwork_changed_reason = 'Merged into ' || v_host.job_number
                                    || ' — produced under the host run',
         updated_at               = now()
   WHERE id = p_member_job_id;

  -- ---- Host paperwork stamp: quantity context changed ----------------------
  UPDATE public.jobs
     SET paperwork_changed_at     = now(),
         paperwork_changed_reason = 'Merge: +' || v_member.quantity || ' pcs ('
                                    || v_member.job_number
                                    || COALESCE(' / ' || v_member_wo_number, '')
                                    || COALESCE(' ' || v_member_customer, '')
                                    || ') — run target ' || v_old_target || ' → ' || v_run_target,
         updated_at               = now()
   WHERE id = p_host_job_id;

  -- ---- Compliance notification (server-side, cannot be skipped) ------------
  PERFORM public._notify_compliance(
    'job_merge_paperwork',
    'Job quantity changed by merge',
    v_host.job_number || ' (' || COALESCE(v_part_number, '?') || ') run target '
      || v_old_target || ' → ' || v_run_target
      || ' — ' || v_member.job_number
      || COALESCE(' / ' || v_member_wo_number, '')
      || COALESCE(' (' || v_member_customer || ')', '')
      || ', ' || v_member.quantity || ' pcs merged in. Any printed traveler for '
      || v_host.job_number || ' is out of date.'
      || CASE WHEN v_member.status = 'pending_compliance'
              THEN ' Member was awaiting pre-production review — acknowledge in Compliance Review before allocation.'
              ELSE '' END,
    jsonb_build_object(
      'kind', 'merge', 'job_id', p_host_job_id,
      'host_job', v_host.job_number, 'member_job', v_member.job_number,
      'part_number', v_part_number, 'run_target', v_run_target)
  );

  INSERT INTO public.audit_logs (event_type, job_id, machine_id, operator_id, details)
  VALUES
    ('job_merge_member', p_member_job_id, v_host.assigned_machine_id, auth.uid(),
     jsonb_build_object('host_job', v_host.job_number, 'member_job', v_member.job_number,
                        'part_number', v_part_number, 'requested_qty', v_member.quantity,
                        'run_target', v_run_target)),
    ('job_merge_host', p_host_job_id, v_host.assigned_machine_id, auth.uid(),
     jsonb_build_object('host_job', v_host.job_number, 'member_job', v_member.job_number,
                        'part_number', v_part_number, 'requested_qty', v_member.quantity,
                        'run_target', v_run_target));

  RETURN jsonb_build_object(
    'host_job',    v_host.job_number,
    'member_job',  v_member.job_number,
    'part_number', v_part_number,
    'member_qty',  v_member.quantity,
    'run_target',  v_run_target
  );
END $function$;

-- ============================================================================
-- unmerge_job
-- ============================================================================
CREATE OR REPLACE FUNCTION public.unmerge_job(p_member_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_alloc      public.job_merge_allocations%ROWTYPE;
  v_host       public.jobs%ROWTYPE;
  v_member     public.jobs%ROWTYPE;
  v_restore    text;
  v_run_target bigint;
  v_old_target bigint;
BEGIN
  PERFORM public._job_merge_gate(ARRAY['admin','scheduler']);

  SELECT * INTO v_alloc
    FROM public.job_merge_allocations
   WHERE member_job_id = p_member_job_id AND is_active
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % has no active merge', p_member_job_id;
  END IF;
  IF v_alloc.allocated_at IS NOT NULL THEN
    RAISE EXCEPTION 'Merge already allocated — the allocation is the record now';
  END IF;

  -- Lock both jobs in the same stable order used by merge_job_into_host.
  PERFORM 1 FROM public.jobs
   WHERE id IN (p_member_job_id, v_alloc.host_job_id)
   ORDER BY id
   FOR UPDATE;

  SELECT * INTO v_host   FROM public.jobs WHERE id = v_alloc.host_job_id;
  SELECT * INTO v_member FROM public.jobs WHERE id = p_member_job_id;

  IF v_host.actual_end IS NOT NULL
     OR v_host.status NOT IN ('pending_compliance','ready','assigned','in_setup','in_progress') THEN
    RAISE EXCEPTION 'Host % production is complete — unmerge window is closed', v_host.job_number;
  END IF;

  v_restore := CASE WHEN v_alloc.pre_merge_status = 'assigned'
                    THEN 'ready'
                    ELSE v_alloc.pre_merge_status END;

  UPDATE public.jobs
     SET status                   = v_restore,
         merged_into_job_id       = NULL,
         merge_requires_compliance_ack = false,
         paperwork_changed_at     = now(),
         paperwork_changed_reason = 'Unmerged from ' || v_host.job_number
                                    || ' — standalone job again',
         updated_at               = now()
   WHERE id = p_member_job_id;

  UPDATE public.job_merge_allocations
     SET is_active   = false,
         unmerged_by = auth.uid(),
         unmerged_at = now()
   WHERE id = v_alloc.id;

  IF v_alloc.linked_wocj_id IS NOT NULL THEN
    DELETE FROM public.work_order_component_jobs WHERE id = v_alloc.linked_wocj_id;
  END IF;

  SELECT v_host.quantity + COALESCE(SUM(requested_qty), 0)
    INTO v_run_target
    FROM public.job_merge_allocations
   WHERE host_job_id = v_alloc.host_job_id AND is_active;

  v_old_target := v_run_target + v_alloc.requested_qty;

  -- ---- Host paperwork stamp: quantity context changed back -----------------
  UPDATE public.jobs
     SET paperwork_changed_at     = now(),
         paperwork_changed_reason = 'Unmerge: -' || v_alloc.requested_qty || ' pcs ('
                                    || v_member.job_number
                                    || ') — run target ' || v_old_target || ' → ' || v_run_target,
         updated_at               = now()
   WHERE id = v_alloc.host_job_id;

  PERFORM public._notify_compliance(
    'job_merge_paperwork',
    'Job quantity changed by unmerge',
    v_host.job_number || ' run target ' || v_old_target || ' → ' || v_run_target
      || ' — ' || v_member.job_number || ' (' || v_alloc.requested_qty
      || ' pcs) removed from the combined run. Any printed traveler for '
      || v_host.job_number || ' is out of date.',
    jsonb_build_object(
      'kind', 'unmerge', 'job_id', v_alloc.host_job_id,
      'host_job', v_host.job_number, 'member_job', v_member.job_number,
      'run_target', v_run_target)
  );

  INSERT INTO public.audit_logs (event_type, job_id, machine_id, operator_id, details)
  VALUES
    ('job_unmerge_member', p_member_job_id, v_host.assigned_machine_id, auth.uid(),
     jsonb_build_object('host_job', v_host.job_number, 'member_job', v_member.job_number,
                        'restored_status', v_restore, 'run_target', v_run_target)),
    ('job_unmerge_host', v_alloc.host_job_id, v_host.assigned_machine_id, auth.uid(),
     jsonb_build_object('host_job', v_host.job_number, 'member_job', v_member.job_number,
                        'restored_status', v_restore, 'run_target', v_run_target));

  RETURN jsonb_build_object(
    'host_job',        v_host.job_number,
    'member_job',      v_member.job_number,
    'restored_status', v_restore,
    'run_target',      v_run_target
  );
END $function$;

-- Verification (read-only): expect 3 rows, one per function, each with a body.
-- select proname, length(pg_get_functiondef(oid)) as body_len
-- from pg_proc where proname in ('_job_merge_gate','merge_job_into_host','unmerge_job')
--   and pronamespace = 'public'::regnamespace order by proname;
