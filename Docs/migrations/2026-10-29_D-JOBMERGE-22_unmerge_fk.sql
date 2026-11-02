/* ===========================================================================
   2026-10-29_D-JOBMERGE-22_unmerge_fk.sql
   SkyNet MES - Unmerge works again (job_merge_allocations -> WO link)

   WHY
     unmerge_job deactivates the allocation and then deletes its
     work_order_component_jobs link, but the allocation row still points at that
     link (linked_wocj_id, FK jma_wocj_fkey, no ON DELETE action), so every unmerge
     of a linked merge fails: "update or delete on table work_order_component_jobs
     violates foreign key constraint jma_wocj_fkey". On PROD no unmerge has ever
     succeeded (0 of 59 allocations unmerged; 58 of the 59 carry a link).
     The RPC rolls back whole, so the failed attempt on J-000395 changed nothing.

   WHAT
     unmerge_job: same body, one functional change - the deactivating UPDATE also
     clears linked_wocj_id, so the link row can be deleted. The removed link id is
     kept in the member's audit row. Execute rights: authenticated and service_role
     only (the merge gate lets a NULL uid through, which is the anon key's case).

   HOW TO RUN (Supabase SQL Editor, RLS toggle OFF)
     1. PREVIEW -> one row, expect preview_ok = true
     2. APPLY   -> run the whole APPLY section at once (one transaction; the guard
                   aborts it if the function is not the version this file replaces)
     3. VERIFY  -> one row, expect verify_ok = true
   TEST first, then PROD, same text.
   =========================================================================== */


/* ---------------------------------------------------------------------------
   1. PREVIEW (read-only)
   --------------------------------------------------------------------------- */
select
  (select md5(replace(pg_get_functiondef(p.oid), E'\r', '')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'unmerge_job')                              as unmerge_md5,
  (select count(*) from job_merge_allocations where is_active and linked_wocj_id is not null and allocated_at is null) as unmergeable_linked,
  has_function_privilege('anon', 'public.unmerge_job(uuid)', 'EXECUTE')                    as anon_can_execute,
  (    (select md5(replace(pg_get_functiondef(p.oid), E'\r', '')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'unmerge_job') = '6ea41f880e2cf8d5a0e4f686b7a2537a'
  )                                                                                        as preview_ok;


/* ===========================================================================
   2. APPLY - run this whole section at once (one transaction)
   =========================================================================== */

/* 2a. guard */
do $$
declare
  v_md5 text;
begin
  v_md5 := (select md5(replace(pg_get_functiondef(p.oid), E'\r', '')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'unmerge_job');
  if v_md5 is distinct from '6ea41f880e2cf8d5a0e4f686b7a2537a' then
    raise exception 'D-JOBMERGE-22: unmerge_job fingerprint is %, expected 6ea41f880e2cf8d5a0e4f686b7a2537a - nothing changed', v_md5;
  end if;
end $$;


/* 2b. unmerge_job */
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

  -- D-JOBMERGE-22: release the WO link before it is deleted below (jma_wocj_fkey).
  UPDATE public.job_merge_allocations
     SET is_active      = false,
         linked_wocj_id = NULL,
         unmerged_by    = auth.uid(),
         unmerged_at    = now()
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
                        'restored_status', v_restore, 'run_target', v_run_target,
                        'removed_wocj_id', v_alloc.linked_wocj_id)),
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


/* 2c. execute rights */
REVOKE ALL ON FUNCTION public.unmerge_job(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unmerge_job(uuid) TO authenticated, service_role;


/* ---------------------------------------------------------------------------
   3. VERIFY. Expect verify_ok = true.
   --------------------------------------------------------------------------- */
select
  (select md5(replace(pg_get_functiondef(p.oid), E'\r', '')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'unmerge_job')                              as unmerge_md5,
  has_function_privilege('anon', 'public.unmerge_job(uuid)', 'EXECUTE')                    as anon_can_execute,
  has_function_privilege('authenticated', 'public.unmerge_job(uuid)', 'EXECUTE')           as authenticated_can_execute,
  (    (select md5(replace(pg_get_functiondef(p.oid), E'\r', '')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'unmerge_job') = '086f74ce4103c2d70e051870a0efc8f2'
   and not has_function_privilege('anon', 'public.unmerge_job(uuid)', 'EXECUTE')
   and has_function_privilege('authenticated', 'public.unmerge_job(uuid)', 'EXECUTE')
  )                                                                                        as verify_ok;
