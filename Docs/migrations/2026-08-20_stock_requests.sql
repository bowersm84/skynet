-- =====================================================================
-- 2026-08-20_stock_requests.sql  —  Warehouse Stock Requests (D-STKREQ-01)
-- Run in Supabase SQL Editor on TEST first. SQL-Editor-ready: no psql
-- meta-commands. One transaction. Re-runnable (IF NOT EXISTS / OR REPLACE).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_requests (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  part_id            uuid        NOT NULL,
  quantity_requested integer     NOT NULL CHECK (quantity_requested > 0),
  priority           text        NOT NULL DEFAULT 'normal'
                                 CHECK (priority = ANY (ARRAY['critical','high','normal','low'])),
  reason             text        NOT NULL CHECK (btrim(reason) <> ''),
  status             text        NOT NULL DEFAULT 'open'
                                 CHECK (status = ANY (ARRAY['open','allocated','complete','cancelled'])),
  work_order_id      uuid,
  allocated_at       timestamptz,
  allocated_by       uuid,
  completed_at       timestamptz,
  cancelled_at       timestamptz,
  cancelled_by       uuid,
  cancel_reason      text,
  requested_by       uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_requests_pkey PRIMARY KEY (id),
  CONSTRAINT stock_requests_part_id_fkey       FOREIGN KEY (part_id)       REFERENCES public.parts(id),
  CONSTRAINT stock_requests_work_order_id_fkey FOREIGN KEY (work_order_id) REFERENCES public.work_orders(id),
  CONSTRAINT stock_requests_requested_by_fkey  FOREIGN KEY (requested_by)  REFERENCES public.profiles(id),
  CONSTRAINT stock_requests_allocated_by_fkey  FOREIGN KEY (allocated_by)  REFERENCES public.profiles(id),
  CONSTRAINT stock_requests_cancelled_by_fkey  FOREIGN KEY (cancelled_by)  REFERENCES public.profiles(id),
  -- an allocated row must point at a WO; an open row must not
  CONSTRAINT stock_requests_wo_state_chk CHECK (
    (status = 'open'      AND work_order_id IS NULL) OR
    (status <> 'open')
  )
);

CREATE INDEX IF NOT EXISTS stock_requests_status_idx ON public.stock_requests (status);
CREATE INDEX IF NOT EXISTS stock_requests_part_idx   ON public.stock_requests (part_id) WHERE status IN ('open','allocated');
CREATE INDEX IF NOT EXISTS stock_requests_wo_idx     ON public.stock_requests (work_order_id) WHERE work_order_id IS NOT NULL;

COMMENT ON TABLE public.stock_requests IS
  'Warehouse-originated demand for finished goods (D-STKREQ-01). Not a customer order: no Fishbowl SO, never ships, excluded from sales reporting. Flows into the Demand tab and is consumed as work_orders.stock_quantity.';

-- updated_at touch
CREATE OR REPLACE FUNCTION public.stock_requests_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS stock_requests_touch_trg ON public.stock_requests;
CREATE TRIGGER stock_requests_touch_trg
  BEFORE UPDATE ON public.stock_requests
  FOR EACH ROW EXECUTE FUNCTION public.stock_requests_touch();

-- ---------------------------------------------------------------------
-- 2. RLS: read for everyone signed in; all writes go through RPCs below
-- ---------------------------------------------------------------------
ALTER TABLE public.stock_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stock_requests_select ON public.stock_requests;
CREATE POLICY stock_requests_select ON public.stock_requests
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.stock_requests FROM PUBLIC, anon;
GRANT  SELECT ON public.stock_requests TO authenticated;

-- ---------------------------------------------------------------------
-- 3. RPCs  (SECURITY DEFINER; NULL uid = SQL Editor escalation path)
-- ---------------------------------------------------------------------

-- 3a. create — admin / assembly. Reason is mandatory at BOTH layers.
CREATE OR REPLACE FUNCTION public.create_stock_request(
  p_part_id  uuid,
  p_quantity integer,
  p_priority text DEFAULT 'normal',
  p_reason   text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id  uuid;
BEGIN
  IF v_uid IS NOT NULL AND NOT public.user_has_role(v_uid, 'admin', 'assembly') THEN
    RAISE EXCEPTION 'Not permitted: stock requests are raised by admin or assembly';
  END IF;
  IF p_part_id IS NULL THEN
    RAISE EXCEPTION 'Part is required';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required for every stock request';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.parts WHERE id = p_part_id) THEN
    RAISE EXCEPTION 'Unknown part';
  END IF;

  INSERT INTO public.stock_requests (part_id, quantity_requested, priority, reason, requested_by)
  VALUES (p_part_id, p_quantity, COALESCE(NULLIF(btrim(p_priority), ''), 'normal'), btrim(p_reason), v_uid)
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- 3b. cancel — admin, or the original requester while still open.
CREATE OR REPLACE FUNCTION public.cancel_stock_request(
  p_id     uuid,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.stock_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.stock_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stock request not found';
  END IF;
  IF v_row.status <> 'open' THEN
    RAISE EXCEPTION 'Only open stock requests can be cancelled (current: %)', v_row.status;
  END IF;
  IF v_uid IS NOT NULL
     AND NOT public.user_has_role(v_uid, 'admin')
     AND v_row.requested_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Not permitted: only admin or the requester may cancel';
  END IF;

  UPDATE public.stock_requests
     SET status        = 'cancelled',
         cancelled_at  = now(),
         cancelled_by  = v_uid,
         cancel_reason = NULLIF(btrim(p_reason), '')
   WHERE id = p_id;
END $$;

-- 3c. allocate — admin / scheduler. Links open requests to a freshly created WO.
--     Raises if ANY id is not open so a stale Demand tab can't double-build.
CREATE OR REPLACE FUNCTION public.allocate_stock_requests(
  p_ids           uuid[],
  p_work_order_id uuid
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_n_open  integer;
  v_updated integer;
BEGIN
  IF v_uid IS NOT NULL AND NOT public.user_has_role(v_uid, 'admin', 'scheduler') THEN
    RAISE EXCEPTION 'Not permitted: only admin or scheduler may allocate stock requests';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.work_orders WHERE id = p_work_order_id) THEN
    RAISE EXCEPTION 'Unknown work order';
  END IF;

  SELECT count(*) INTO v_n_open
    FROM public.stock_requests
   WHERE id = ANY (p_ids) AND status = 'open';
  IF v_n_open <> cardinality(p_ids) THEN
    RAISE EXCEPTION 'One or more stock requests are no longer open — refresh Demand and try again';
  END IF;

  UPDATE public.stock_requests
     SET status        = 'allocated',
         work_order_id = p_work_order_id,
         allocated_at  = now(),
         allocated_by  = v_uid
   WHERE id = ANY (p_ids) AND status = 'open';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END $$;

REVOKE ALL ON FUNCTION public.create_stock_request(uuid, integer, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_stock_request(uuid, text)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.allocate_stock_requests(uuid[], uuid)           FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_stock_request(uuid, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_stock_request(uuid, text)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_stock_requests(uuid[], uuid)           TO authenticated;

-- ---------------------------------------------------------------------
-- 4. Lifecycle follows the WO: complete closes, cancel returns to pool
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stock_requests_follow_wo()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('complete','shipped','closed') THEN
    UPDATE public.stock_requests
       SET status = 'complete', completed_at = now()
     WHERE work_order_id = NEW.id AND status = 'allocated';

  ELSIF NEW.status = 'cancelled' THEN
    -- mirror D-ALLOC semantics: dead WO releases its demand back to the pool
    UPDATE public.stock_requests
       SET status = 'open', work_order_id = NULL, allocated_at = NULL, allocated_by = NULL
     WHERE work_order_id = NEW.id AND status = 'allocated';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS stock_requests_follow_wo_trg ON public.work_orders;
CREATE TRIGGER stock_requests_follow_wo_trg
  AFTER UPDATE OF status ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.stock_requests_follow_wo();

COMMIT;

-- ---------------------------------------------------------------------
-- Verification (run separately; single-row results, SQL-Editor safe)
-- ---------------------------------------------------------------------
-- SELECT count(*) FILTER (WHERE proname = 'create_stock_request')    AS create_fn,
--        count(*) FILTER (WHERE proname = 'cancel_stock_request')    AS cancel_fn,
--        count(*) FILTER (WHERE proname = 'allocate_stock_requests') AS alloc_fn
--   FROM pg_proc WHERE pronamespace = 'public'::regnamespace;
-- SELECT relrowsecurity FROM pg_class WHERE oid = 'public.stock_requests'::regclass;  -- expect true
-- SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.work_orders'::regclass AND tgname = 'stock_requests_follow_wo_trg';
