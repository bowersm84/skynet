/* =====================================================================================
   2026-10-15_PROD_jfin34_qty.sql  --  PROD, Matt. Rehearsed on TEST with a copy of the batch.

   J-FIN-000034 (dry film, lot 3006, plating 52035, dry film 52000, FLN-100307, Oven 1) was started
   10/14 07:55 with 7,813 — the kiosk filled Quantity with lot 3006's whole balance (D-GIZA-02a).
   Only 1,140 went into the oven. The batch and its job go to 1,140; the other 6,673 are back in
   "Back from plating — awaiting paint" on lot 3006 by themselves, because that bucket is lot 3006's
   returns minus what its batches took.

     BLOCK 1  preview (read-only)
     BLOCK 2  correction (guarded, idempotent, audited)
     BLOCK 3  verify (read-only)
   ===================================================================================== */


/* ===================================== BLOCK 1 =====================================
   PREVIEW. PROD expect: batch in_finishing / bake, quantity 7813, incoming 7813; job 7813 / 7813;
   lot 3006 waiting_paint 0, in_oven 7813.
   ================================================================================== */
SELECT jsonb_build_object(
  'batch', (SELECT jsonb_build_object('status', fs.status, 'stage', fs.finishing_stage, 'quantity', fs.quantity, 'incoming', fs.incoming_count, 'fln', fs.finishing_lot_number)
              FROM public.finishing_sends fs JOIN public.jobs j ON j.id = fs.job_id WHERE j.job_number = 'J-FIN-000034'),
  'job', (SELECT jsonb_build_object('quantity', quantity, 'good_pieces', good_pieces) FROM public.jobs WHERE job_number = 'J-FIN-000034'),
  'lot_3006', (SELECT jsonb_build_object('waiting_paint', waiting_paint, 'in_paint', in_paint, 'in_oven', in_oven) FROM public.v_program_final_lots WHERE lot_number = '3006')
) AS preview;


/* ===================================== BLOCK 2 =====================================
   CORRECTION: 7,813 -> 1,140 on the batch and its job.
   ================================================================================== */
DO $$
DECLARE v_job public.jobs%ROWTYPE; v_send public.finishing_sends%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.jobs WHERE job_number = 'J-FIN-000034';
  SELECT * INTO v_send FROM public.finishing_sends WHERE job_id = v_job.id;
  IF v_job.id IS NULL OR v_send.id IS NULL THEN RAISE EXCEPTION 'GUARD: J-FIN-000034 or its batch not found'; END IF;
  IF v_send.incoming_count = 1140 AND v_send.quantity = 1140 AND v_job.quantity = 1140 THEN
    RAISE NOTICE 'J-FIN-000034 is already 1,140; nothing to do';
    RETURN;
  END IF;
  IF v_send.status <> 'in_finishing' OR v_send.incoming_count <> 7813 OR v_send.quantity <> 7813
     OR coalesce(v_send.plating_lot_number, '') <> '52035' OR v_send.verified_count IS NOT NULL THEN
    RAISE EXCEPTION 'GUARD: J-FIN-000034 is not the in-finishing 7,813 batch from plating 52035 (status %, incoming %, verified %)',
      v_send.status, v_send.incoming_count, v_send.verified_count;
  END IF;

  UPDATE public.finishing_sends SET quantity = 1140, incoming_count = 1140, updated_at = now() WHERE id = v_send.id;
  UPDATE public.jobs SET quantity = 1140, good_pieces = 1140, updated_at = now() WHERE id = v_job.id;
  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('finishing_count_corrected', auth.uid(), jsonb_build_object('job', 'J-FIN-000034', 'send_id', v_send.id, 'field', 'quantity / incoming_count',
          'from', 7813, 'to', 1140, 'reason', 'Matt 10/15: 1,140 went into the oven; the kiosk had filled the whole lot 3006 balance. The other 6,673 return to awaiting paint.'));
  RAISE NOTICE 'J-FIN-000034: 7,813 -> 1,140';
END $$;


/* ===================================== BLOCK 3 =====================================
   VERIFY. PROD expect: batch 1140 / 1140, FLN-100307 unchanged; job 1140 / 1140;
   lot 3006 waiting_paint 6673, in_oven 1140.
   ================================================================================== */
SELECT jsonb_build_object(
  'batch', (SELECT jsonb_build_object('quantity', fs.quantity, 'incoming', fs.incoming_count, 'fln', fs.finishing_lot_number, 'stage', fs.finishing_stage)
              FROM public.finishing_sends fs JOIN public.jobs j ON j.id = fs.job_id WHERE j.job_number = 'J-FIN-000034'),
  'job', (SELECT jsonb_build_object('quantity', quantity, 'good_pieces', good_pieces) FROM public.jobs WHERE job_number = 'J-FIN-000034'),
  'lot_3006', (SELECT jsonb_build_object('waiting_paint', waiting_paint, 'in_paint', in_paint, 'in_oven', in_oven) FROM public.v_program_final_lots WHERE lot_number = '3006')
) AS verify;
