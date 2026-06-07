-- ============================================================================
-- Lot-Change Split — Batch A (TEST first)
-- A.1: job_splits ack columns (plan §5.1)
-- A.2: split_job_lot_change RPC (plan §5.2) — machinist-entered made count (D-3),
--      J-number scan fixed to exclude J-FIN-, Job A good_pieces set on finalize.
-- ============================================================================

-- A.1 — acknowledgement columns (idempotent)
ALTER TABLE public.job_splits
  ADD COLUMN IF NOT EXISTS scheduler_ack_at  timestamptz,
  ADD COLUMN IF NOT EXISTS scheduler_ack_by  uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS compliance_ack_at timestamptz,
  ADD COLUMN IF NOT EXISTS compliance_ack_by uuid REFERENCES public.profiles(id);

-- Remove the prior draft signature if it was applied (avoids a stale overload)
DROP FUNCTION IF EXISTS public.split_job_lot_change(uuid, uuid, text);

-- A.2 — split_job_lot_change RPC
CREATE OR REPLACE FUNCTION public.split_job_lot_change(
  p_job_id      uuid,
  p_operator_id uuid,
  p_good_pieces integer,
  p_reason      text DEFAULT 'material lot change'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a              public.jobs%ROWTYPE;
  v_made         integer;
  v_missed       integer;
  v_remainder    integer;
  v_orig_qty     integer;
  v_already_sent integer;
  v_final_send   integer;
  v_material_lot text;
  v_new_job_id   uuid;
  v_new_number   text;
  v_next_num     bigint;
  v_minutes      integer;
BEGIN
  -- 1. Load + lock Job A, validate
  SELECT * INTO a FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % not found.', p_job_id;
  END IF;
  IF a.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Lot change requires an in-progress job (job is %).', a.status;
  END IF;
  IF a.job_number LIKE 'DTU-%' OR a.job_number LIKE 'DTP-%' OR COALESCE(a.is_maintenance, false) THEN
    RAISE EXCEPTION 'Maintenance jobs cannot be lot-split.';
  END IF;

  v_orig_qty := COALESCE(a.quantity, 0);
  v_made     := COALESCE(p_good_pieces, 0);   -- D-3: machinist-entered count, not a.good_pieces

  -- Already sent to finishing on Lot 1 (every send carries Lot 1; job_materials is single-lot)
  SELECT COALESCE(SUM(quantity), 0) INTO v_already_sent
    FROM public.finishing_sends WHERE job_id = p_job_id;

  -- Remaining = target - effective produced. Effective produced = made + off-system
  -- (missed) carry-over, mirroring getEffectiveQty / SplitJobModal.
  -- (qty_override was retired May 2026 — carry-over is now missed_production_entries.)
  SELECT COALESCE(SUM(quantity), 0) INTO v_missed
    FROM public.missed_production_entries WHERE job_id = p_job_id;
  v_remainder := v_orig_qty - (v_made + v_missed);

  -- 2. Guards
  IF v_made <= 0 THEN
    RAISE EXCEPTION 'Enter the number of good pieces made on this lot.';
  END IF;
  IF v_made < v_already_sent THEN
    RAISE EXCEPTION 'Made count (%) is below the % pieces already sent to finishing on this job.', v_made, v_already_sent;
  END IF;
  IF v_remainder <= 0 THEN
    RAISE EXCEPTION 'No remainder left — complete the job normally rather than splitting.';
  END IF;

  -- 3. Create Job B FIRST. Same machine, remainder qty, startable, inherits Job A's end.
  --    PLN minted at Start Production when the machinist enters Lot 2.
  --    Job number: pure J-NNNNNN only (mirror CreateWorkOrderModal's /^J-(\d+)$/ —
  --    excludes J-FIN- standalone finishing jobs, which LIKE 'J-%' would wrongly include).
  SELECT COALESCE(MAX(substring(job_number FROM '^J-([0-9]+)$')::bigint), 0) + 1
    INTO v_next_num
    FROM public.jobs
   WHERE job_number ~ '^J-[0-9]+$';
  v_new_number := 'J-' || lpad(v_next_num::text, 6, '0');

  v_minutes := GREATEST(1, round(EXTRACT(EPOCH FROM (a.scheduled_end - now())) / 60.0))::integer;

  INSERT INTO public.jobs (
    job_number, work_order_id, part_id, component_id, work_order_assembly_id,
    quantity, status, priority, assigned_machine_id,
    scheduled_start, scheduled_end, estimated_minutes,
    production_lot_number, created_at, updated_at
  ) VALUES (
    v_new_number, a.work_order_id, a.part_id, a.component_id, a.work_order_assembly_id,
    v_remainder, 'assigned', a.priority, a.assigned_machine_id,
    now(), a.scheduled_end, v_minutes,
    NULL, now(), now()
  )
  RETURNING id INTO v_new_job_id;

  -- 4. Finalize Job A at its made count (→ no shortfall), machining done.
  UPDATE public.jobs
     SET quantity      = v_made,
         good_pieces   = v_made,
         status        = 'manufacturing_complete',
         actual_end    = now(),
         checked_out_at = now(),
         updated_at    = now()
   WHERE id = p_job_id;

  -- 5. Send Job A's not-yet-sent good pieces to finishing (mirrors the kiosk send).
  v_material_lot := (
    SELECT lot_number FROM public.job_materials
     WHERE job_id = p_job_id AND lot_number IS NOT NULL LIMIT 1
  );
  v_final_send := v_made - v_already_sent;
  IF v_final_send > 0 THEN
    INSERT INTO public.finishing_sends (
      job_id, machine_id, sent_by, quantity,
      production_lot_number, material_lot_number,
      status, is_partial_send, notes
    ) VALUES (
      p_job_id, a.assigned_machine_id, p_operator_id, v_final_send,
      a.production_lot