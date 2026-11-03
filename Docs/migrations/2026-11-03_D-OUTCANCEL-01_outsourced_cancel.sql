/* ===========================================================================
   2026-11-03_D-OUTCANCEL-01_outsourced_cancel.sql
   SkyNet MES - D-OUTCANCEL-01: an Admin can cancel a Ready to Send card

   WHAT
     1. outbound_sends gets cancelled_at, cancelled_by, cancel_reason, and a check
        that a cancelled row was never sent and carries a reason. (cancelled_by has
        no FK on purpose: a second FK to profiles would make the existing
        profiles(...) embeds on outbound_sends ambiguous.)
     2. cancel_outsourced_send(batch, step, reason, cascade, next_status):
        - Admin only (role or roles), reason required - enforced here, not just in
          the screen. A NULL auth.uid() (SQL Editor / service role) is allowed.
        - Writes a cancelled outbound_sends row for the batch + external step (same
          linkage as Log Send-Out, sent_at NULL), so the card leaves Ready to Send.
          With p_cascade_later_steps, the batch's later pending external steps are
          cancelled too (the screen leaves this unchecked).
        - Settles each touched step once nothing on it is still out or upstream
          (the D-LATEBATCH-02 guard) and machining is done: complete if any send on
          it came back from the vendor, skipped (reason in notes) if none did.
        - When every external step on the job is complete/skipped/removed, the job
          moves on: pending_tco if nothing was processed at a vendor (Matt,
          2026-11-03); otherwise p_next_status, which the screen computes with the
          same rule as a vendor return.
        - One audit_logs row ('outsourced_send_cancelled').
     3. EXECUTE for authenticated and service_role only.

   HOW TO RUN (Supabase SQL Editor, RLS toggle OFF)
     1. PREVIEW -> one row, expect preview_ok = true
     2. APPLY   -> run the whole APPLY section at once (one transaction)
     3. VERIFY  -> one row, expect verify_ok = true
   TEST first, then PROD, same text. Run before the app round reaches main.
   =========================================================================== */


/* ---------------------------------------------------------------------------
   1. PREVIEW (read-only)
   --------------------------------------------------------------------------- */
select
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'outbound_sends'
     and column_name in ('cancelled_at', 'cancelled_by', 'cancel_reason'))                 as cancel_columns_present,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'cancel_outsourced_send')                    as cancel_rpc_present,
  (select count(*) from outbound_sends)                                                      as outbound_rows,
  (    (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'outbound_sends'
          and column_name in ('cancelled_at', 'cancelled_by', 'cancel_reason')) = 0
   and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'cancel_outsourced_send') = 0
  )                                                                                          as preview_ok;


/* ===========================================================================
   2. APPLY - run this whole section at once (one transaction)
   =========================================================================== */

/* 2a. columns + check */
ALTER TABLE public.outbound_sends
  ADD COLUMN cancelled_at  timestamptz,
  ADD COLUMN cancelled_by  uuid,
  ADD COLUMN cancel_reason text;

ALTER TABLE public.outbound_sends
  ADD CONSTRAINT outbound_sends_cancel_check
  CHECK (cancelled_at IS NULL
         OR (sent_at IS NULL AND returned_at IS NULL
             AND cancel_reason IS NOT NULL AND btrim(cancel_reason) <> ''));

COMMENT ON COLUMN public.outbound_sends.cancelled_at IS
  'D-OUTCANCEL-01: set when an Admin cancels a Ready to Send card (never sent). The row keeps the batch/step linkage so the card stays resolved.';


/* 2b. cancel_outsourced_send */
CREATE OR REPLACE FUNCTION public.cancel_outsourced_send(
  p_finishing_send_id uuid,
  p_job_routing_step_id uuid,
  p_reason text,
  p_cascade_later_steps boolean DEFAULT false,
  p_next_status text DEFAULT 'pending_tco')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid          uuid := auth.uid();
  v_reason       text := NULLIF(btrim(p_reason), '');
  v_batch        public.finishing_sends%ROWTYPE;
  v_job          public.jobs%ROWTYPE;
  v_step         public.job_routing_steps%ROWTYPE;
  v_qty          integer;
  v_op           text;
  v_send_id      uuid;
  v_cancelled    jsonb := '[]'::jsonb;
  v_settled      jsonb := '[]'::jsonb;
  v_step_ids     uuid[] := '{}';
  v_unresolved   integer;
  v_upstream     integer;
  v_returned     integer;
  v_open_ext     integer;
  v_complete_ext integer;
  v_lot          text;
  v_new_status   text;
  s              record;
BEGIN
  IF v_uid IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.profiles p
        WHERE p.id = v_uid
          AND (p.role = 'admin' OR 'admin' = ANY (COALESCE(p.roles, '{}'::text[])))) THEN
    RAISE EXCEPTION 'Only an Admin can cancel an outsourced operation';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required to cancel an outsourced operation';
  END IF;
  IF p_next_status NOT IN ('pending_tco', 'ready_for_assembly') THEN
    RAISE EXCEPTION 'Invalid next status %', p_next_status;
  END IF;

  v_batch := (SELECT f FROM public.finishing_sends f WHERE f.id = p_finishing_send_id);
  IF v_batch.id IS NULL THEN
    RAISE EXCEPTION 'Finishing batch not found';
  END IF;
  IF v_batch.compliance_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Batch % is not compliance-approved', v_batch.finishing_lot_number;
  END IF;

  v_job := (SELECT j FROM public.jobs j WHERE j.id = v_batch.job_id FOR UPDATE);
  v_step := (SELECT st FROM public.job_routing_steps st WHERE st.id = p_job_routing_step_id FOR UPDATE);
  IF v_step.id IS NULL OR v_step.job_id <> v_job.id OR v_step.step_type <> 'external' THEN
    RAISE EXCEPTION 'That step is not an outsourced step on job %', v_job.job_number;
  END IF;
  IF EXISTS (SELECT 1 FROM public.outbound_sends o
              WHERE o.finishing_send_id = v_batch.id AND o.job_routing_step_id = v_step.id) THEN
    RAISE EXCEPTION 'This batch already has a send-out or a cancellation logged for %', v_step.step_name;
  END IF;

  -- the batch quantity the card shows (getBatchQty)
  v_qty := COALESCE(v_batch.compliance_good_qty,
                    CASE WHEN v_batch.compliance_bad_qty IS NOT NULL AND v_batch.verified_count IS NOT NULL
                         THEN GREATEST(0, v_batch.verified_count - v_batch.compliance_bad_qty) END,
                    v_batch.verified_count, v_batch.quantity, 0);

  -- this step, plus (when asked) the batch's later pending external steps
  FOR s IN
    SELECT st.id, st.step_name, st.step_order
      FROM public.job_routing_steps st
     WHERE st.job_id = v_job.id
       AND st.step_type = 'external'
       AND (st.id = v_step.id
            OR (COALESCE(p_cascade_later_steps, false)
                AND st.step_order > v_step.step_order
                AND st.status IN ('pending', 'in_progress')))
       AND NOT EXISTS (SELECT 1 FROM public.outbound_sends o
                        WHERE o.finishing_send_id = v_batch.id AND o.job_routing_step_id = st.id)
     ORDER BY st.step_order
  LOOP
    v_op := CASE
              WHEN lower(s.step_name) LIKE '%heat%'  THEN 'heat_treat'
              WHEN lower(s.step_name) LIKE '%plat%'  THEN 'cad_plating'
              WHEN lower(s.step_name) LIKE '%oxide%' THEN 'black_oxide'
              ELSE 'other' END;   -- deriveOperationType in OutsourcedJobs.jsx

    INSERT INTO public.outbound_sends (
      source_type, source_id, routing_step_id, job_id, work_order_id,
      job_routing_step_id, finishing_send_id, operation_type, quantity, notes,
      cancelled_at, cancelled_by, cancel_reason, created_at, updated_at
    ) VALUES (
      'finishing_send', v_batch.id, s.id, v_job.id, v_job.work_order_id,
      s.id, v_batch.id, v_op, v_qty, 'Cancelled: ' || v_reason,
      now(), v_uid, v_reason, now(), now()
    ) RETURNING id INTO v_send_id;

    v_step_ids := v_step_ids || s.id;
    v_cancelled := v_cancelled || jsonb_build_object('outbound_send_id', v_send_id, 'step', s.step_name);
  END LOOP;

  -- settle each touched step (mirrors the vendor-return rollup + D-LATEBATCH-02 guard)
  IF v_job.actual_end IS NOT NULL THEN
    FOR s IN
      SELECT st.id, st.step_name, st.status
        FROM public.job_routing_steps st
       WHERE st.id = ANY (v_step_ids)
       ORDER BY st.step_order
    LOOP
      CONTINUE WHEN s.status NOT IN ('pending', 'in_progress');

      v_unresolved := (SELECT count(*) FROM public.outbound_sends o
                        WHERE o.job_routing_step_id = s.id
                          AND o.returned_at IS NULL AND o.cancelled_at IS NULL);
      v_upstream := (SELECT count(*) FROM public.finishing_sends f
                      WHERE f.job_id = v_job.id
                        AND (f.compliance_status IS NULL OR f.compliance_status <> 'rejected')
                        AND NOT EXISTS (SELECT 1 FROM public.outbound_sends o
                                         WHERE o.job_routing_step_id = s.id AND o.finishing_send_id = f.id));
      CONTINUE WHEN v_unresolved > 0 OR v_upstream > 0;

      v_returned := (SELECT count(*) FROM public.outbound_sends o
                      WHERE o.job_routing_step_id = s.id AND o.returned_at IS NOT NULL);
      IF v_returned > 0 THEN
        v_lot := (SELECT o.vendor_lot_number FROM public.outbound_sends o
                   WHERE o.job_routing_step_id = s.id AND o.returned_at IS NOT NULL
                   ORDER BY o.returned_at DESC LIMIT 1);
        UPDATE public.job_routing_steps
           SET status = 'complete', completed_at = now(), completed_by = v_uid,
               lot_number = COALESCE(lot_number, v_lot), updated_at = now()
         WHERE id = s.id;
        v_settled := v_settled || jsonb_build_object('step', s.step_name, 'status', 'complete');
      ELSE
        UPDATE public.job_routing_steps
           SET status = 'skipped', completed_at = now(), completed_by = v_uid,
               notes = concat_ws(' | ', notes, 'Skipped: outsourcing cancelled - ' || v_reason),
               updated_at = now()
         WHERE id = s.id;
        v_settled := v_settled || jsonb_build_object('step', s.step_name, 'status', 'skipped');
      END IF;
    END LOOP;

    IF v_job.status IN ('ready_for_outsourcing', 'at_external_vendor') THEN
      v_open_ext := (SELECT count(*) FROM public.job_routing_steps st
                      WHERE st.job_id = v_job.id AND st.step_type = 'external'
                        AND st.status NOT IN ('complete', 'skipped', 'removed'));
      IF v_open_ext = 0 THEN
        v_complete_ext := (SELECT count(*) FROM public.job_routing_steps st
                            WHERE st.job_id = v_job.id AND st.step_type = 'external' AND st.status = 'complete');
        -- Matt, 2026-11-03: nothing processed at a vendor -> straight to TCO
        v_new_status := CASE WHEN v_complete_ext = 0 THEN 'pending_tco' ELSE p_next_status END;
        UPDATE public.jobs SET status = v_new_status, updated_at = now() WHERE id = v_job.id;
      END IF;
    END IF;
  END IF;

  INSERT INTO public.audit_logs (event_type, job_id, operator_id, details)
  VALUES ('outsourced_send_cancelled', v_job.id, v_uid, jsonb_build_object(
    'job_number', v_job.job_number, 'finishing_send_id', v_batch.id, 'fln', v_batch.finishing_lot_number,
    'quantity', v_qty, 'reason', v_reason, 'cascade_later_steps', COALESCE(p_cascade_later_steps, false),
    'cancelled', v_cancelled, 'settled_steps', v_settled,
    'job_status_before', v_job.status, 'job_status_after', COALESCE(v_new_status, v_job.status),
    'decision', 'D-OUTCANCEL-01'));

  RETURN jsonb_build_object(
    'job_number', v_job.job_number, 'cancelled', v_cancelled, 'settled_steps', v_settled,
    'job_status', COALESCE(v_new_status, v_job.status));
END;
$function$;


/* 2c. execute rights */
REVOKE ALL ON FUNCTION public.cancel_outsourced_send(uuid, uuid, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_outsourced_send(uuid, uuid, text, boolean, text) TO authenticated, service_role;


/* ---------------------------------------------------------------------------
   3. VERIFY. Expect verify_ok = true.
   --------------------------------------------------------------------------- */
select
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'outbound_sends'
     and column_name in ('cancelled_at', 'cancelled_by', 'cancel_reason'))                 as cancel_columns,
  (select count(*) from pg_constraint where conname = 'outbound_sends_cancel_check')         as cancel_check,
  (select md5(replace(pg_get_functiondef(p.oid), E'\r', '')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'cancel_outsourced_send')                    as rpc_md5,
  has_function_privilege('anon', 'public.cancel_outsourced_send(uuid, uuid, text, boolean, text)', 'EXECUTE')          as anon_can_execute,
  has_function_privilege('authenticated', 'public.cancel_outsourced_send(uuid, uuid, text, boolean, text)', 'EXECUTE') as authenticated_can_execute,
  (    (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'outbound_sends'
          and column_name in ('cancelled_at', 'cancelled_by', 'cancel_reason')) = 3
   and (select count(*) from pg_constraint where conname = 'outbound_sends_cancel_check') = 1
   and (select md5(replace(pg_get_functiondef(p.oid), E'\r', '')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'cancel_outsourced_send') = 'e213550830d70f4b4f19793ab3e24427'
   and not has_function_privilege('anon', 'public.cancel_outsourced_send(uuid, uuid, text, boolean, text)', 'EXECUTE')
   and has_function_privilege('authenticated', 'public.cancel_outsourced_send(uuid, uuid, text, boolean, text)', 'EXECUTE')
  )                                                                                          as verify_ok;
