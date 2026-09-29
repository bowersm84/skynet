-- =====================================================================================
-- 2026-09-29_D-INV-07_length_aware_charging.sql
-- D-INV-07: length-aware inventory charging (step 2 of the raw-material correction).
--
-- Target:   TEST (ylzmyjjqibpbqbwjsnqj) first, then PROD (luzungoqfuplspzbqctb).
-- Run with: $env:PGCLIENTENCODING = 'UTF8'
--           & C:\pgsql\bin\psql.exe $env:PROD_DB_URL -v ON_ERROR_STOP=1 -P pager=off -f .\2026-09-29_D-INV-07_length_aware_charging.sql
-- Default:  DRY RUN. The last line is ROLLBACK. Change it to COMMIT; after review.
-- Re-run:   Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS).
-- Duration: seconds. It locks material_usage and inventory_adjustment_requests for the
--           length of the transaction, so a kiosk load in that window waits a moment.
--
-- Safe before the code: every existing caller keeps working. Old kiosk inserts carry
-- no charge_bars, so the new trigger computes it from the keyed inches and the charged
-- receipt's bar length - forward-only charging starts the moment this commits.
--
-- What it does
--   1. material_usage.charge_bars numeric NOT NULL, >= 0: bars of the charged receipt
--      the row consumes, in that receipt's own bar length. History is backfilled with
--      quantity_used, unchanged, because every approved cycle count was measured
--      against it (re-charging history would add the counts' corrections twice).
--   2. material_piece_fraction(), material_usage_charge(): a 48" piece of a 144" bar is
--      1/3 (a keyed 47.75 snaps to the same third); a full-length pull is 1; unknown
--      length is 1:1, as today.
--   3. trg_material_usage_set_charge (BEFORE INSERT OR UPDATE): fills charge_bars when a
--      caller does not; rescales it when quantity_used is corrected (40 -> 4).
--   4. material_availability: available_bars = received - SUM(charge_bars) + approved
--      adjustments; available_inches = available_bars x bar length (bars and inches now
--      agree); new column charged_bars appended. Column names, order and types of the
--      existing 17 columns unchanged; grants and security_invoker preserved.
--   5. raise_material_reconciliation_flags: judges the shelf bucket (lot + material +
--      size + bar length) charge-aware instead of one receipt's raw bar count; zero
--      entries raise nothing.
--   6. record_material_load(job, bars, used_by, notes) - NEW, both kiosks call it. Reads
--      the job's saved material record (lot, material, size, bar length), charges the
--      piece length first, then longer bars cut to it (shortest first), oldest first
--      within each, id as the tie-break; count-created receipts are consumable; a draw
--      never exceeds the length's net shelf balance (an old negative receipt nets against
--      its siblings); a load that outruns one receipt splits across the next; anything left over lands on the
--      newest receipt of the piece length so the shortfall shows there.
--   7. link_unknown_lot_usage: links only live entries (quantity > 0) whose job ran the
--      receipt's material and size, never opening-load pre-count usage; charges them by
--      length; leaves the flag open (and says why) when mismatched entries remain.
--   8. correct_job_material_lot: re-points to the receipt of the job's bar length first,
--      availability-aware (stubs qualify), id tie-break; recomputes the charge; never
--      touches voided (zero) rows.
--   9. report_inventory_movement: "Used" is the charge, so the report's values match
--      the balances.
--  10. trg_void_usage_on_jm_delete (AFTER DELETE on job_materials): when a material
--      entry is removed or setup is cancelled before Start Production (no PLN yet), the
--      job's usage rows are voided the D-INV-06 way (zeroed, lot and receipt cleared,
--      noted) and unknown-lot flags they alone raised are resolved.
--
-- Guard: available_bars is snapshotted per receipt before any change and compared after;
-- the migration raises GUARD_BALANCES_MOVED if a single receipt moved.
-- =====================================================================================

BEGIN;

LOCK TABLE public.material_usage, public.inventory_adjustment_requests IN EXCLUSIVE MODE;

CREATE TEMP TABLE _dinv07_before ON COMMIT DROP AS
  SELECT material_receiving_id, available_bars FROM public.material_availability;

-- -------------------------------------------------------------------------------------
-- 1. charge_bars
-- -------------------------------------------------------------------------------------
ALTER TABLE public.material_usage ADD COLUMN IF NOT EXISTS charge_bars numeric;

UPDATE public.material_usage SET charge_bars = quantity_used WHERE charge_bars IS NULL;

ALTER TABLE public.material_usage ALTER COLUMN charge_bars SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'material_usage_charge_bars_nonneg') THEN
    ALTER TABLE public.material_usage ADD CONSTRAINT material_usage_charge_bars_nonneg CHECK (charge_bars >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.material_usage.charge_bars IS
  'D-INV-07: bars of the charged receipt this row consumes, in that receipt''s own bar length (a 48" piece of a 144" bar = 0.333333). material_availability subtracts this, not quantity_used. Rows written before D-INV-07 carry quantity_used unchanged: every approved cycle count was measured against that basis.';

-- -------------------------------------------------------------------------------------
-- 2. Charge helpers
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.material_piece_fraction(p_piece_len numeric, p_bar_len numeric)
RETURNS numeric
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $$
  -- Share of one bar of p_bar_len that one piece of p_piece_len consumes. A piece within
  -- an inch of an even division of the bar snaps to that division (47.75 of 144 = 1/3),
  -- so three pieces use exactly one bar. Unknown lengths and full-length pulls are 1.
  SELECT CASE
    WHEN COALESCE(p_piece_len, 0) <= 0 OR COALESCE(p_bar_len, 0) <= 0 THEN 1::numeric
    WHEN p_piece_len >= p_bar_len - 1 THEN 1::numeric
    WHEN abs(p_bar_len / greatest(1, round(p_bar_len / p_piece_len)) - p_piece_len) <= 1
      THEN 1::numeric / greatest(1, round(p_bar_len / p_piece_len))
    ELSE p_piece_len / p_bar_len
  END
$$;

CREATE OR REPLACE FUNCTION public.material_usage_charge(p_qty numeric, p_inches numeric, p_bar_len numeric)
RETURNS numeric
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN COALESCE(p_qty, 0) = 0 THEN 0::numeric
    WHEN COALESCE(p_bar_len, 0) <= 0 OR COALESCE(p_inches, 0) <= 0 THEN p_qty
    ELSE round(p_qty * public.material_piece_fraction(p_inches / p_qty, p_bar_len), 6)
  END
$$;

-- -------------------------------------------------------------------------------------
-- 3. Charge on write
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.material_usage_set_charge()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.charge_bars IS NULL THEN
      NEW.charge_bars := public.material_usage_charge(
        NEW.quantity_used, NEW.quantity_used_inches,
        (SELECT mr.bar_length_inches FROM material_receiving mr WHERE mr.id = NEW.material_receiving_id));
    END IF;
  ELSIF NEW.charge_bars IS NOT DISTINCT FROM OLD.charge_bars
        AND NEW.quantity_used IS DISTINCT FROM OLD.quantity_used THEN
    -- A quantity correction keeps the row's per-bar basis (a 40 -> 4 fix scales by 1/10).
    NEW.charge_bars := CASE
      WHEN COALESCE(OLD.quantity_used, 0) = 0 OR COALESCE(NEW.quantity_used, 0) = 0
        THEN public.material_usage_charge(
               NEW.quantity_used, NEW.quantity_used_inches,
               (SELECT mr.bar_length_inches FROM material_receiving mr WHERE mr.id = NEW.material_receiving_id))
      ELSE round(OLD.charge_bars * NEW.quantity_used / OLD.quantity_used, 6)
    END;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_material_usage_set_charge ON public.material_usage;
CREATE TRIGGER trg_material_usage_set_charge
  BEFORE INSERT OR UPDATE ON public.material_usage
  FOR EACH ROW EXECUTE FUNCTION public.material_usage_set_charge();

-- -------------------------------------------------------------------------------------
-- 4. Availability view (same 17 columns, charged_bars appended)
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.material_availability WITH (security_invoker = on) AS
 SELECT mr.id AS material_receiving_id,
    mr.material_id,
    mr.material_type,
    mr.bar_size,
    mr.lot_number,
    mr.vendor,
    mr.rack,
    mr.received_at,
    mr.po_number,
    mr.price_per_bar,
    mr.bar_length_inches,
    mr.quantity AS received_bars,
    COALESCE(u.used_bars, 0::bigint) AS used_bars,
    COALESCE(u.used_inches, 0::numeric) AS used_inches,
    COALESCE(a.net_delta, 0::numeric) AS adjustment_delta,
    mr.quantity::numeric - COALESCE(u.charged_bars, 0::numeric) + COALESCE(a.net_delta, 0::numeric) AS available_bars,
    (mr.quantity::numeric - COALESCE(u.charged_bars, 0::numeric) + COALESCE(a.net_delta, 0::numeric))
      * COALESCE(mr.bar_length_inches, 0::numeric) AS available_inches,
    COALESCE(u.charged_bars, 0::numeric) AS charged_bars
   FROM material_receiving mr
     LEFT JOIN ( SELECT material_usage.material_receiving_id,
            sum(material_usage.quantity_used) AS used_bars,
            sum(material_usage.quantity_used_inches) AS used_inches,
            sum(material_usage.charge_bars) AS charged_bars
           FROM material_usage
          WHERE material_usage.material_receiving_id IS NOT NULL
          GROUP BY material_usage.material_receiving_id) u ON u.material_receiving_id = mr.id
     LEFT JOIN ( SELECT inventory_adjustment_requests.material_receiving_id,
            sum(inventory_adjustment_requests.adjustment_delta) AS net_delta
           FROM inventory_adjustment_requests
          WHERE inventory_adjustment_requests.status = 'approved'::text
          GROUP BY inventory_adjustment_requests.material_receiving_id) a ON a.material_receiving_id = mr.id;

-- -------------------------------------------------------------------------------------
-- 5. Reconciliation flags: judge the shelf bucket, charge-aware
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.raise_material_reconciliation_flags()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_flag_type text;
  v_delta integer;
  v_bucket numeric;
  v_lot text;
  v_mat_type text;
  v_bar_size text;
  v_len numeric;
  v_existing uuid;
BEGIN
  -- Untracked staging (no lot) and zero entries are out of scope.
  IF NEW.lot_number IS NULL OR btrim(NEW.lot_number) = '' THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.quantity_used, 0) = 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.material_receiving_id IS NULL THEN
    -- Lot not found in inventory at staging time
    v_flag_type := 'unknown_lot';
    v_delta := NEW.quantity_used;
    v_mat_type := NULL;
    v_bar_size := NULL;
  ELSE
    v_lot      := (SELECT mr.lot_number        FROM material_receiving mr WHERE mr.id = NEW.material_receiving_id);
    v_mat_type := (SELECT mr.material_type     FROM material_receiving mr WHERE mr.id = NEW.material_receiving_id);
    v_bar_size := (SELECT mr.bar_size          FROM material_receiving mr WHERE mr.id = NEW.material_receiving_id);
    v_len      := (SELECT mr.bar_length_inches FROM material_receiving mr WHERE mr.id = NEW.material_receiving_id);
    -- D-INV-07: the shelf is the lot + material + size + bar length, not one receipt.
    v_bucket := (SELECT sum(ma.available_bars) FROM material_availability ma
                  WHERE ma.lot_number = v_lot
                    AND ma.material_type = v_mat_type
                    AND ma.bar_size IS NOT DISTINCT FROM v_bar_size
                    AND ma.bar_length_inches IS NOT DISTINCT FROM v_len);
    IF v_bucket IS NULL OR v_bucket >= -0.001 THEN
      RETURN NEW;
    END IF;
    v_flag_type := 'negative_inventory';
    v_delta := floor(v_bucket)::integer;
  END IF;

  -- Dedupe: one open/ignored flag per (type, lot). Open flags get a bump, ignored stay silent.
  v_existing := (SELECT f.id FROM material_reconciliation_flags f
                  WHERE f.flag_type = v_flag_type
                    AND f.lot_number = NEW.lot_number
                    AND f.status IN ('open', 'ignored')
                  LIMIT 1);

  IF v_existing IS NOT NULL THEN
    UPDATE material_reconciliation_flags
       SET occurrence_count = occurrence_count + 1,
           last_seen_at = now(),
           quantity_delta = v_delta,
           material_usage_id = NEW.id,
           job_id = COALESCE(NEW.job_id, job_id)
     WHERE id = v_existing AND status = 'open';
    RETURN NEW;
  END IF;

  INSERT INTO material_reconciliation_flags
    (flag_type, lot_number, material_type, bar_size, material_receiving_id,
     material_usage_id, job_id, quantity_delta)
  VALUES
    (v_flag_type, NEW.lot_number, v_mat_type, v_bar_size, NEW.material_receiving_id,
     NEW.id, NEW.job_id, v_delta);

  RETURN NEW;
END;
$$;

-- -------------------------------------------------------------------------------------
-- 6. record_material_load: the one inventory charge path both kiosks call
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_material_load(
  p_job_id  uuid,
  p_bars    integer,
  p_used_by uuid DEFAULT NULL,
  p_notes   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_lot       text;
  v_type      text;
  v_size      text;
  v_len       numeric;
  v_left      integer;
  v_take      integer;
  v_per       numeric;
  v_avail     numeric;
  v_over      integer := 0;
  v_fallback  uuid;
  v_id        uuid;
  v_rows      jsonb := '[]'::jsonb;
  v_n         integer;
  r           record;
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_active) THEN
    RAISE EXCEPTION 'RML_GATE: an active SkyNet user is required' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(p_bars, 0) <= 0 THEN
    RAISE EXCEPTION 'RML_BARS: bars must be greater than zero';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM job_materials jm WHERE jm.job_id = p_job_id) THEN
    RAISE EXCEPTION 'RML_NO_MATERIAL: job % has no material record; write job_materials first', p_job_id;
  END IF;

  -- The job's saved record is the truth for what was loaded (the kiosk has just written it).
  v_lot  := (SELECT NULLIF(btrim(jm.lot_number), '') FROM job_materials jm WHERE jm.job_id = p_job_id);
  v_type := (SELECT jm.material_type FROM job_materials jm WHERE jm.job_id = p_job_id);
  v_size := (SELECT jm.bar_size      FROM job_materials jm WHERE jm.job_id = p_job_id);
  v_len  := (SELECT jm.bar_length    FROM job_materials jm WHERE jm.job_id = p_job_id);
  IF v_len IS NOT NULL AND v_len <= 0 THEN v_len := NULL; END IF;
  v_left := p_bars;

  -- Serialize concurrent loads against the same lot.
  PERFORM 1 FROM material_receiving mr
   WHERE mr.lot_number = v_lot AND mr.material_type = v_type AND mr.bar_size = v_size AND mr.category = 'bar'
   FOR UPDATE;

  v_n := (SELECT count(*) FROM material_receiving mr
           WHERE mr.lot_number = v_lot AND mr.material_type = v_type AND mr.bar_size = v_size AND mr.category = 'bar');

  IF v_n = 0 THEN
    -- No receipt (or no lot): logged without deduction, exactly as the kiosks did before.
    INSERT INTO material_usage (material_receiving_id, material_id, lot_number, job_id, quantity_used,
                                quantity_used_inches, charge_bars, used_by, used_at, notes)
    VALUES (NULL, NULL, v_lot, p_job_id, p_bars, p_bars * COALESCE(v_len, 0), p_bars, p_used_by, now(), p_notes)
    RETURNING id INTO v_id;
    IF v_lot IS NOT NULL THEN
      INSERT INTO audit_logs (event_type, job_id, operator_id, details)
      VALUES ('inventory_warning', p_job_id, p_used_by,
              jsonb_build_object('warning', 'No matching material_receiving record found',
                                 'material_type', v_type, 'bar_size', v_size, 'lot_number', v_lot,
                                 'bars_loaded', p_bars, 'source', 'record_material_load'));
    END IF;
    RETURN jsonb_build_object('matched', false, 'overdrawn', 0,
             'rows', jsonb_build_array(jsonb_build_object('usage_id', v_id, 'receipt_id', NULL, 'bars', p_bars, 'charge', p_bars)));
  END IF;

  -- Tier 1: receipts of the piece length. Tier 2: longer bars cut to it, shortest first.
  -- Oldest first within a tier (FIFO, D-INV-01); id breaks ties, so opening-load receipts
  -- that share one timestamp resolve the same way every time. Count-created receipts
  -- (quantity 0) are consumable: their stock is the approved adjustment.
  FOR r IN
    SELECT mr.id, mr.material_id, mr.bar_length_inches AS len, ma.available_bars AS avail
      FROM material_receiving mr
      JOIN material_availability ma ON ma.material_receiving_id = mr.id
     WHERE mr.lot_number = v_lot AND mr.material_type = v_type AND mr.bar_size = v_size AND mr.category = 'bar'
       AND (v_len IS NULL OR COALESCE(mr.bar_length_inches, 0) >= v_len - 1)
     ORDER BY CASE WHEN v_len IS NULL THEN 0
                   WHEN abs(COALESCE(mr.bar_length_inches, 0) - v_len) <= 1 THEN 0
                   ELSE 1 END,
              CASE WHEN v_len IS NULL THEN 0 ELSE COALESCE(mr.bar_length_inches, 0) END,
              mr.received_at, mr.id
  LOOP
    EXIT WHEN v_left <= 0;
    v_per := public.material_piece_fraction(v_len, r.len);
    -- Never draw more than the length's net shelf balance: a receipt can show stock
    -- while an older receipt of the same length sits negative (D-INV-01 history), and
    -- the shelf holds only the net. Re-read each pass, so earlier draws in this load count.
    v_avail := least(r.avail,
                     (SELECT sum(ma.available_bars)
                        FROM material_availability ma
                        JOIN material_receiving mr2 ON mr2.id = ma.material_receiving_id
                       WHERE mr2.lot_number = v_lot AND mr2.material_type = v_type AND mr2.bar_size = v_size
                         AND mr2.category = 'bar' AND mr2.bar_length_inches IS NOT DISTINCT FROM r.len));
    CONTINUE WHEN v_avail IS NULL OR v_avail < v_per - 0.000001;
    v_take := least(v_left, floor(v_avail / v_per + 0.000001)::integer);
    CONTINUE WHEN v_take <= 0;
    INSERT INTO material_usage (material_receiving_id, material_id, lot_number, job_id, quantity_used,
                                quantity_used_inches, charge_bars, used_by, used_at, notes)
    VALUES (r.id, r.material_id, v_lot, p_job_id, v_take, v_take * COALESCE(v_len, 0),
            round(v_take * v_per, 6), p_used_by, now(), p_notes)
    RETURNING id INTO v_id;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('usage_id', v_id, 'receipt_id', r.id, 'bars', v_take, 'charge', round(v_take * v_per, 6)));
    v_left := v_left - v_take;
  END LOOP;

  IF v_left > 0 THEN
    -- More than the shelf holds: the rest lands on the newest stocked receipt of the piece
    -- length (else the shortest longer bar, else any), so the shortfall shows on that line.
    v_over := v_left;
    v_fallback := (SELECT mr.id FROM material_receiving mr
                    WHERE mr.lot_number = v_lot AND mr.material_type = v_type AND mr.bar_size = v_size AND mr.category = 'bar'
                    ORDER BY CASE WHEN v_len IS NULL THEN 0
                                  WHEN abs(COALESCE(mr.bar_length_inches, 0) - v_len) <= 1 THEN 0
                                  WHEN COALESCE(mr.bar_length_inches, 0) > v_len THEN 1
                                  ELSE 2 END,
                             CASE WHEN v_len IS NULL THEN 0 ELSE COALESCE(mr.bar_length_inches, 0) END,
                             (mr.quantity > 0) DESC, mr.received_at DESC, mr.id DESC
                    LIMIT 1);
    v_per := public.material_piece_fraction(v_len, (SELECT mr.bar_length_inches FROM material_receiving mr WHERE mr.id = v_fallback));
    INSERT INTO material_usage (material_receiving_id, material_id, lot_number, job_id, quantity_used,
                                quantity_used_inches, charge_bars, used_by, used_at, notes)
    VALUES (v_fallback, (SELECT mr.material_id FROM material_receiving mr WHERE mr.id = v_fallback),
            v_lot, p_job_id, v_left, v_left * COALESCE(v_len, 0), round(v_left * v_per, 6), p_used_by, now(), p_notes)
    RETURNING id INTO v_id;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('usage_id', v_id, 'receipt_id', v_fallback, 'bars', v_left, 'charge', round(v_left * v_per, 6)));
    INSERT INTO audit_logs (event_type, job_id, operator_id, details)
    VALUES ('inventory_warning', p_job_id, p_used_by,
            jsonb_build_object('warning', 'Material usage exceeds recorded inventory',
                               'lot_number', v_lot, 'material_type', v_type, 'bar_size', v_size,
                               'bar_length', v_len, 'bars_loaded', p_bars, 'bars_over', v_over,
                               'source', 'record_material_load'));
  END IF;

  RETURN jsonb_build_object('matched', true, 'overdrawn', v_over, 'rows', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.record_material_load(uuid, integer, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_material_load(uuid, integer, uuid, text) TO authenticated;

-- -------------------------------------------------------------------------------------
-- 7. link_unknown_lot_usage v2 (same signature and return keys, plus two)
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.link_unknown_lot_usage(p_flag_id uuid, p_receiving_id uuid, p_notes text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller      uuid := auth.uid();
  v_flag_status text;
  v_flag_type   text;
  v_flag_lot    text;
  v_recv_lot    text;
  v_recv_type   text;
  v_recv_size   text;
  v_recv_len    numeric;
  v_recv_mat    uuid;
  v_recv_po     text;
  v_recv_at     timestamptz;
  v_recv_opening boolean;
  v_linked_rows int;
  v_linked_bars numeric;
  v_skipped     int;
  v_bucket      numeric;
  v_neg_flag    uuid;
  v_resolved    boolean;
BEGIN
  IF NOT user_has_role(auth.uid(), 'admin','compliance','purchaser') THEN
    RAISE EXCEPTION 'Not authorized to link lot usage';
  END IF;

  PERFORM 1 FROM material_reconciliation_flags WHERE id = p_flag_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Flag not found'; END IF;
  v_flag_status := (SELECT f.status     FROM material_reconciliation_flags f WHERE f.id = p_flag_id);
  v_flag_type   := (SELECT f.flag_type  FROM material_reconciliation_flags f WHERE f.id = p_flag_id);
  v_flag_lot    := (SELECT f.lot_number FROM material_reconciliation_flags f WHERE f.id = p_flag_id);
  IF v_flag_status <> 'open' OR v_flag_type <> 'unknown_lot' THEN
    RAISE EXCEPTION 'Flag is not an open unknown_lot flag';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM material_receiving WHERE id = p_receiving_id) THEN
    RAISE EXCEPTION 'Receiving record not found';
  END IF;
  v_recv_lot  := (SELECT mr.lot_number        FROM material_receiving mr WHERE mr.id = p_receiving_id);
  v_recv_type := (SELECT mr.material_type     FROM material_receiving mr WHERE mr.id = p_receiving_id);
  v_recv_size := (SELECT mr.bar_size          FROM material_receiving mr WHERE mr.id = p_receiving_id);
  v_recv_len  := (SELECT mr.bar_length_inches FROM material_receiving mr WHERE mr.id = p_receiving_id);
  v_recv_mat  := (SELECT mr.material_id       FROM material_receiving mr WHERE mr.id = p_receiving_id);
  v_recv_po   := (SELECT mr.po_number         FROM material_receiving mr WHERE mr.id = p_receiving_id);
  v_recv_at   := (SELECT mr.received_at       FROM material_receiving mr WHERE mr.id = p_receiving_id);
  v_recv_opening := COALESCE((SELECT mr.notes ILIKE 'Initial inventory load%' FROM material_receiving mr WHERE mr.id = p_receiving_id), false);
  IF v_recv_lot <> v_flag_lot THEN
    RAISE EXCEPTION 'Receipt lot % does not match flag lot %', v_recv_lot, v_flag_lot;
  END IF;

  -- D-INV-07: link only live entries whose job ran this receipt's material and size, and
  -- never usage the opening physical count already absorbed.
  UPDATE material_usage mu
     SET material_receiving_id = p_receiving_id,
         material_id = v_recv_mat,
         charge_bars = public.material_usage_charge(mu.quantity_used, mu.quantity_used_inches, v_recv_len)
   WHERE mu.lot_number = v_flag_lot
     AND mu.material_receiving_id IS NULL
     AND mu.quantity_used > 0
     AND NOT (v_recv_opening AND mu.used_at < v_recv_at)
     AND EXISTS (SELECT 1 FROM job_materials jm
                  WHERE jm.job_id = mu.job_id
                    AND jm.material_type = v_recv_type
                    AND jm.bar_size IS NOT DISTINCT FROM v_recv_size);
  GET DIAGNOSTICS v_linked_rows = ROW_COUNT;

  v_skipped := (SELECT count(*) FROM material_usage mu
                 WHERE mu.lot_number = v_flag_lot AND mu.material_receiving_id IS NULL AND mu.quantity_used > 0
                   AND NOT (v_recv_opening AND mu.used_at < v_recv_at));

  v_linked_bars := (SELECT COALESCE(sum(mu.quantity_used), 0) FROM material_usage mu WHERE mu.material_receiving_id = p_receiving_id);

  v_bucket := (SELECT sum(ma.available_bars) FROM material_availability ma
                WHERE ma.lot_number = v_recv_lot AND ma.material_type = v_recv_type
                  AND ma.bar_size IS NOT DISTINCT FROM v_recv_size
                  AND ma.bar_length_inches IS NOT DISTINCT FROM v_recv_len);

  -- Consumption exceeds the shelf: raise/refresh negative flag (the trigger only covers inserts)
  IF v_bucket < -0.001 THEN
    v_neg_flag := (SELECT f.id FROM material_reconciliation_flags f
                    WHERE f.flag_type = 'negative_inventory' AND f.lot_number = v_flag_lot
                      AND f.status IN ('open', 'ignored') LIMIT 1);
    IF v_neg_flag IS NOT NULL THEN
      UPDATE material_reconciliation_flags
         SET occurrence_count = occurrence_count + 1, last_seen_at = now(), quantity_delta = floor(v_bucket)::integer
       WHERE id = v_neg_flag AND status = 'open';
    ELSE
      INSERT INTO material_reconciliation_flags
        (flag_type, lot_number, material_type, bar_size, material_receiving_id, quantity_delta)
      VALUES ('negative_inventory', v_flag_lot, v_recv_type, v_recv_size, p_receiving_id, floor(v_bucket)::integer);
    END IF;
  END IF;

  v_resolved := v_skipped = 0;
  IF v_resolved THEN
    UPDATE material_reconciliation_flags
       SET status = 'resolved', resolved_by = v_caller, resolved_at = now(), material_receiving_id = p_receiving_id,
           resolution_notes = COALESCE(p_notes, '') ||
             format(' [Linked %s staged bars to receipt PO %s]', v_linked_bars, COALESCE(v_recv_po, '-'))
     WHERE id = p_flag_id;
  ELSE
    UPDATE material_reconciliation_flags
       SET last_seen_at = now(),
           resolution_notes = COALESCE(p_notes, '') ||
             format(' [Linked %s entries to receipt PO %s; %s entries on lot %s were keyed as a different material or size and were not linked - flag left open]',
                    v_linked_rows, COALESCE(v_recv_po, '-'), v_skipped, v_flag_lot)
     WHERE id = p_flag_id;
  END IF;

  RETURN jsonb_build_object(
    'linked_rows', v_linked_rows,
    'linked_bars', v_linked_bars,
    'available', v_bucket,
    'negative_flag_raised', COALESCE(v_bucket < -0.001, false),
    'skipped_mismatch', v_skipped,
    'resolved', v_resolved
  );
END;
$$;

-- -------------------------------------------------------------------------------------
-- 8. correct_job_material_lot v3 (receipt pick + charge; everything else unchanged)
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.correct_job_material_lot(p_job_id uuid, p_new_lot text, p_operator_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text, p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_old_lot      text;
  v_old_pln      text;
  v_new_pln      text;
  v_tail         text;
  v_job_number   text;
  v_job_status   text;
  v_mat_type     text;
  v_bar_size     text;
  v_recv_id      uuid;
  v_material_id  uuid;
  v_len          numeric;
  v_recv_len     numeric;
  v_load_count   int := 0;
  v_sends_pln    int := 0;
  v_sends_mat    int := 0;
  v_usage_rows   int := 0;
begin
  p_new_lot := nullif(btrim(p_new_lot), '');
  if p_new_lot is null then
    raise exception 'A lot number is required';
  end if;

  select j.job_number, j.status, j.production_lot_number
    into v_job_number, v_job_status, v_old_pln
  from jobs j where j.id = p_job_id for update;
  if not found then
    raise exception 'Job not found';
  end if;

  select jm.lot_number, jm.material_type, jm.bar_size, jm.bar_length
    into v_old_lot, v_mat_type, v_bar_size, v_len
  from job_materials jm where jm.job_id = p_job_id for update;

  if v_old_lot is not distinct from p_new_lot then
    return jsonb_build_object('changed', false, 'reason', 'lot already set to this value');
  end if;

  -- D-LOT-02 guard: once a PLN is minted, a job with more than one recorded load has had
  -- bars drawn against the current lot repeatedly - a one-tap retag of that history is
  -- not coherent. Physical changes go through the lot-change split. The guard applies
  -- only post-PLN: before the PLN exists nothing downstream carries the lot, so
  -- pre-production corrections (including the silent kiosk path) always pass.
  select count(*) into v_load_count from material_loads where job_id = p_job_id;

  if v_old_pln is not null and v_load_count > 1 and not coalesce(p_force, false) then
    raise exception
      'This job has % recorded material loads against lot %. Correcting a lot this far in retags repeatedly-confirmed material history. Use Material Lot Finished - Switch Lot for a physical change, or have an admin apply a forced correction.',
      v_load_count, coalesce(v_old_lot, '(none)');
  end if;

  -- p_force from the app requires admin or compliance. auth.uid() is NULL in the SQL
  -- Editor and for service-role calls; that is the deliberate escalation path.
  if coalesce(p_force, false) and auth.uid() is not null then
    if not exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and (p.role in ('admin', 'compliance')
             or p.roles && array['admin', 'compliance']::text[])
    ) then
      raise exception 'Forced lot correction requires the admin or compliance role';
    end if;
  end if;

  -- Rewrite only the lot segment, preserving the date and sequence. Anchoring on the
  -- -YYMMDD-NNNN tail handles both minted shapes (PLN-<lot>-YYMMDD-NNNN and the
  -- lotless PLN-YYMMDD-NNNN) and survives lot numbers that contain hyphens.
  if v_old_pln is not null then
    v_tail := substring(v_old_pln from '-\d{6}-\d{4}$');
    if v_tail is not null then
      v_new_pln := 'PLN-' || p_new_lot || v_tail;
    end if;
  end if;

  update job_materials
  set lot_number = p_new_lot, updated_at = now()
  where job_id = p_job_id;

  if v_new_pln is not null then
    update jobs
    set production_lot_number = v_new_pln, updated_at = now()
    where id = p_job_id;

    update finishing_sends
    set production_lot_number = v_new_pln, updated_at = now()
    where job_id = p_job_id
      and production_lot_number is not distinct from v_old_pln;
    get diagnostics v_sends_pln = row_count;
  end if;

  update finishing_sends
  set material_lot_number = p_new_lot, updated_at = now()
  where job_id = p_job_id
    and material_lot_number is not distinct from v_old_lot;
  get diagnostics v_sends_mat = row_count;

  -- D-INV-07: re-point the inventory charge at the receipt of the job's bar length first,
  -- then one with stock (availability includes approved counts, so count-created receipts
  -- qualify), oldest first, id as the tie-break.
  if v_mat_type is not null and v_bar_size is not null then
    v_recv_id := (
      select mr.id
        from material_receiving mr
        join material_availability ma on ma.material_receiving_id = mr.id
       where mr.lot_number = p_new_lot
         and mr.material_type = v_mat_type
         and mr.bar_size = v_bar_size
         and mr.category = 'bar'
       order by (v_len is not null and abs(coalesce(mr.bar_length_inches, 0) - v_len) <= 1) desc,
                (ma.available_bars > 0.001) desc,
                mr.received_at asc, mr.id asc
       limit 1);
    v_material_id := (select mr.material_id from material_receiving mr where mr.id = v_recv_id);
    v_recv_len    := (select mr.bar_length_inches from material_receiving mr where mr.id = v_recv_id);
  end if;

  update material_usage
  set lot_number = p_new_lot,
      material_receiving_id = coalesce(v_recv_id, material_receiving_id),
      material_id = coalesce(v_material_id, material_id),
      charge_bars = case when v_recv_id is not null
                         then public.material_usage_charge(quantity_used, quantity_used_inches, v_recv_len)
                         else charge_bars end,
      notes = concat_ws(' | ', notes,
              'Lot corrected ' || coalesce(v_old_lot, '(none)') || ' -> ' || p_new_lot)
  where job_id = p_job_id
    and quantity_used > 0
    and lot_number is not distinct from v_old_lot;
  get diagnostics v_usage_rows = row_count;

  if v_usage_rows > 0 and v_recv_id is null then
    insert into audit_logs (event_type, job_id, operator_id, details)
    values ('inventory_warning', p_job_id, p_operator_id,
            jsonb_build_object(
              'warning', 'Lot corrected but no matching material_receiving row found',
              'lot_number', p_new_lot,
              'material_type', v_mat_type,
              'bar_size', v_bar_size));
  end if;

  insert into audit_logs (event_type, job_id, operator_id, details)
  values ('material_lot_corrected', p_job_id, p_operator_id,
          jsonb_build_object(
            'job_number', v_job_number,
            'job_status', v_job_status,
            'old_lot', v_old_lot,
            'new_lot', p_new_lot,
            'old_pln', v_old_pln,
            'new_pln', v_new_pln,
            'load_count_at_correction', v_load_count,
            'forced', coalesce(p_force, false),
            'finishing_sends_pln_updated', v_sends_pln,
            'finishing_sends_material_lot_updated', v_sends_mat,
            'material_usage_rows_repointed', v_usage_rows,
            'reason', p_reason));

  return jsonb_build_object(
    'changed', true,
    'job_number', v_job_number,
    'old_lot', v_old_lot,
    'new_lot', p_new_lot,
    'old_pln', v_old_pln,
    'new_pln', v_new_pln,
    'load_count', v_load_count,
    'forced', coalesce(p_force, false),
    'finishing_sends_updated', greatest(v_sends_pln, v_sends_mat),
    'material_usage_repointed', v_usage_rows);
end;
$function$;

-- -------------------------------------------------------------------------------------
-- 9. report_inventory_movement v3: "Used" is the charge (two expressions changed)
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_inventory_movement(p_start date, p_end date)
RETURNS TABLE(mv_date date, category text, material text, lot_number text, heat_number text, movement_type text, qty_change numeric, unit_cost numeric, value_change numeric, reference text, recorded_by text, notes text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.is_active) THEN
    RAISE EXCEPTION 'REPORT_GATE: an active SkyNet user is required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH recv AS (
    SELECT (mr.received_at AT TIME ZONE 'America/New_York')::date AS mv_date, mr.category,
           CASE WHEN mr.category = 'blank'
                THEN COALESCE(bt.stud_series || ' Series ' || bt.stud_length || ' ' || bt.material_type, mr.material_type)
                ELSE mr.material_type || COALESCE(' ' || mr.bar_size, '') END AS material,
           mr.lot_number, mr.heat_number, 'Received' AS movement_type, mr.quantity::numeric AS qty_change,
           ROUND(COALESCE(mr.price_per_bar, mr.price_per_lb * mr.weight_lbs / NULLIF(mr.quantity,0))::numeric, 4) AS unit_cost,
           COALESCE('PO ' || NULLIF(mr.po_number,''), mr.vendor, '') AS reference, pr.full_name AS recorded_by, mr.notes
    FROM material_receiving mr
    LEFT JOIN blank_types bt ON bt.id = mr.blank_type_id
    LEFT JOIN profiles pr ON pr.id = mr.received_by
  ),
  used AS (
    SELECT (mu.used_at AT TIME ZONE 'America/New_York')::date, mr.category,
           CASE WHEN mr.category = 'blank'
                THEN COALESCE(bt.stud_series || ' Series ' || bt.stud_length || ' ' || bt.material_type, mr.material_type)
                ELSE mr.material_type || COALESCE(' ' || mr.bar_size, '') END,
           COALESCE(mu.lot_number, mr.lot_number), mr.heat_number, 'Used', -mu.charge_bars,
           ROUND(COALESCE(mr.price_per_bar, mr.price_per_lb * mr.weight_lbs / NULLIF(mr.quantity,0))::numeric, 4),
           COALESCE('Job ' || j.job_number, 'Production'), pr.full_name, mu.notes
    FROM material_usage mu
    JOIN material_receiving mr ON mr.id = mu.material_receiving_id
    LEFT JOIN blank_types bt ON bt.id = mr.blank_type_id
    LEFT JOIN jobs j ON j.id = mu.job_id
    LEFT JOIN profiles pr ON pr.id = mu.used_by
    WHERE mu.charge_bars <> 0
  ),
  adj AS (
    SELECT (COALESCE(iar.reviewed_at, iar.requested_at) AT TIME ZONE 'America/New_York')::date, mr.category,
           CASE WHEN mr.category = 'blank'
                THEN COALESCE(bt.stud_series || ' Series ' || bt.stud_length || ' ' || bt.material_type, mr.material_type)
                ELSE mr.material_type || COALESCE(' ' || mr.bar_size, '') END,
           COALESCE(iar.lot_number, mr.lot_number), mr.heat_number, 'Adjustment', iar.adjustment_delta,
           ROUND(COALESCE(iar.price_per_bar_at_count, mr.price_per_bar, mr.price_per_lb * mr.weight_lbs / NULLIF(mr.quantity,0))::numeric, 4),
           COALESCE('Count: ' || NULLIF(iar.reason,''), 'Count adjustment'), pr.full_name, iar.review_notes
    FROM inventory_adjustment_requests iar
    JOIN material_receiving mr ON mr.id = iar.material_receiving_id
    LEFT JOIN blank_types bt ON bt.id = mr.blank_type_id
    LEFT JOIN profiles pr ON pr.id = iar.reviewed_by
    WHERE iar.status = 'approved'
  ),
  mv AS (SELECT * FROM recv UNION ALL SELECT * FROM used UNION ALL SELECT * FROM adj)
  -- v2: every output is cast explicitly. RETURN QUERY in PL/pgSQL requires exact
  -- type matches against RETURNS TABLE; profiles.full_name is varchar(100) and
  -- several source columns are varchar, so the uncast v1 failed with 42804.
  -- Casting all twelve also makes the contract immune to future source-column
  -- type changes.
  SELECT mv.mv_date::date,
         mv.category::text,
         mv.material::text,
         mv.lot_number::text,
         mv.heat_number::text,
         mv.movement_type::text,
         mv.qty_change::numeric,
         mv.unit_cost::numeric,
         (CASE WHEN mv.unit_cost IS NULL THEN NULL
               ELSE ROUND(mv.qty_change * mv.unit_cost, 2) END)::numeric AS value_change,
         mv.reference::text,
         mv.recorded_by::text,
         mv.notes::text
  FROM mv
  WHERE mv.mv_date BETWEEN p_start AND p_end
  ORDER BY mv.mv_date DESC, mv.category, mv.movement_type, mv.material;
END
$function$;

-- -------------------------------------------------------------------------------------
-- 10. Void usage when a material entry is removed before Start Production
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_usage_on_job_material_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_pln  text;
  v_rows int;
  v_lots text[];
BEGIN
  v_pln := (SELECT j.production_lot_number FROM jobs j WHERE j.id = OLD.job_id);
  -- Once a PLN exists the usage is production history; it stays.
  IF v_pln IS NOT NULL THEN
    RETURN OLD;
  END IF;

  v_lots := ARRAY(SELECT DISTINCT mu.lot_number FROM material_usage mu
                   WHERE mu.job_id = OLD.job_id AND mu.quantity_used > 0 AND mu.lot_number IS NOT NULL);

  UPDATE material_usage mu
     SET quantity_used = 0,
         quantity_used_inches = 0,
         charge_bars = 0,
         material_receiving_id = NULL,
         material_id = NULL,
         lot_number = NULL,
         notes = concat_ws(' | ', mu.notes, format(
           'Voided %s: material entry removed before Start Production (was lot %s, %s bars, %s in). (auto, D-INV-07)',
           to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD'),
           COALESCE(mu.lot_number, 'none'), mu.quantity_used, COALESCE(mu.quantity_used_inches, 0)))
   WHERE mu.job_id = OLD.job_id
     AND mu.quantity_used > 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows > 0 THEN
    -- An unknown-lot flag raised only by entries that no longer exist has nothing to chase.
    UPDATE material_reconciliation_flags f
       SET status = 'resolved',
           resolved_at = now(),
           resolution_notes = concat_ws(' ', f.resolution_notes, format(
             'Auto-resolved %s: the entries on this lot were removed before Start Production (D-INV-07).',
             to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')))
     WHERE f.flag_type = 'unknown_lot'
       AND f.status = 'open'
       AND f.lot_number = ANY(v_lots)
       AND NOT EXISTS (SELECT 1 FROM material_usage mu
                        WHERE mu.lot_number = f.lot_number
                          AND mu.material_receiving_id IS NULL
                          AND mu.quantity_used > 0);

    INSERT INTO audit_logs (event_type, job_id, details)
    VALUES ('material_usage_voided', OLD.job_id,
            jsonb_build_object('source', 'job_materials removed before Start Production',
                               'rows', v_rows, 'lots', to_jsonb(v_lots), 'decision', 'D-INV-07'));
  END IF;

  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS trg_void_usage_on_jm_delete ON public.job_materials;
CREATE TRIGGER trg_void_usage_on_jm_delete
  AFTER DELETE ON public.job_materials
  FOR EACH ROW EXECUTE FUNCTION public.void_usage_on_job_material_delete();

-- -------------------------------------------------------------------------------------
-- 11. GUARD: not one receipt's available_bars moved
-- -------------------------------------------------------------------------------------
DO $$
DECLARE
  v_moved int;
  v_missing int;
BEGIN
  v_moved := (SELECT count(*) FROM _dinv07_before b
                JOIN public.material_availability a USING (material_receiving_id)
               WHERE abs(a.available_bars - b.available_bars) > 0.000001);
  v_missing := (SELECT count(*) FROM _dinv07_before b
                 WHERE NOT EXISTS (SELECT 1 FROM public.material_availability a WHERE a.material_receiving_id = b.material_receiving_id));
  IF v_moved > 0 OR v_missing > 0 THEN
    RAISE EXCEPTION 'GUARD_BALANCES_MOVED: % receipts changed available_bars, % missing', v_moved, v_missing;
  END IF;
  RAISE NOTICE 'D-INV-07: balances unchanged across % receipts', (SELECT count(*) FROM _dinv07_before);
END $$;

-- -------------------------------------------------------------------------------------
-- 12. VERIFY
-- -------------------------------------------------------------------------------------
SELECT 'charge_bars' AS item,
       (SELECT count(*) FROM public.material_usage)::text || ' rows, '
       || (SELECT count(*) FROM public.material_usage WHERE charge_bars IS DISTINCT FROM quantity_used)::text
       || ' differ from quantity_used (expect 0)' AS state
UNION ALL
SELECT 'objects',
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname IN ('material_piece_fraction','material_usage_charge','material_usage_set_charge',
               'record_material_load','void_usage_on_job_material_delete'))::text || ' of 5 new functions, '
       || (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_material_usage_set_charge','trg_void_usage_on_jm_delete'))::text
       || ' of 2 triggers'
UNION ALL
SELECT 'view', (SELECT string_agg(attname, ', ' ORDER BY attnum) FROM pg_attribute
                 WHERE attrelid = 'public.material_availability'::regclass AND attnum > 14 AND NOT attisdropped)
               || ' | ' || COALESCE((SELECT array_to_string(reloptions, ',') FROM pg_class WHERE oid = 'public.material_availability'::regclass), '')
UNION ALL
SELECT 'record_material_load grants',
       COALESCE((SELECT string_agg(grantee, ', ' ORDER BY grantee) FROM information_schema.routine_privileges
                  WHERE routine_schema = 'public' AND routine_name = 'record_material_load' AND privilege_type = 'EXECUTE'), '(none)')
UNION ALL
SELECT 'fractions (expect 1/3, 1/3, 1/2, 1, 2/3, 1)',
       concat_ws(', ',
         round(public.material_piece_fraction(48, 144), 6), round(public.material_piece_fraction(47.75, 144), 6),
         round(public.material_piece_fraction(72, 144), 6), round(public.material_piece_fraction(143.75, 144), 6),
         round(public.material_piece_fraction(96, 144), 6), round(public.material_piece_fraction(NULL, 144), 6))
UNION ALL
SELECT 'charges (expect 3 pieces of 48 on 144 = 1, unknown length = 5, 40->0 void = 0)',
       concat_ws(', ', public.material_usage_charge(3, 144, 144), public.material_usage_charge(5, 0, 144), public.material_usage_charge(0, 0, 144))
UNION ALL
SELECT 'lot 2587 (unchanged by the migration)',
       (SELECT string_agg(bar_length_inches || '": ' || round(available_bars, 1) || ' bars / ' || round(available_inches) || ' in', '; ' ORDER BY bar_length_inches DESC)
          FROM (SELECT bar_length_inches, sum(available_bars) AS available_bars, sum(available_inches) AS available_inches
                  FROM public.material_availability WHERE lot_number = '2587' AND material_type = '41L40 Steel'
                 GROUP BY bar_length_inches) x);

ROLLBACK;   -- DRY RUN. After reviewing the NOTICE and the VERIFY result, change this line to COMMIT; and run again.
