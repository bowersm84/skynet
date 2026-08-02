-- =====================================================================
-- Kit & STC Registry — SkyNet-assigned lot numbers (D-KSTC-10 / D-KSTC-11)
-- Applied to TEST 2026-08-02.
--
-- Two changes travelling together:
--   1. kit_lots.so_as_written — the bench captures the Sales Order, because
--      no invoice exists yet when a kit is logged (D-KSTC-11).
--   2. public.kit_assign_and_log — the sole write path for bench entry.
--      Per-book numbering continues the paper ranges, computed as
--      GREATEST(max lot in book, book.last_lot) + 1 while holding a
--      FOR UPDATE lock on the kit_books row, so concurrent devices
--      serialise: atomic, gapless, race-free. source is hard-coded
--      'skynet' — the transcription loader remains the only writer of
--      source = 'paper_transcription'.
--
-- SECURITY NOTE — read before promoting to PROD. The GRANT below reproduces
-- what is live on TEST, which includes `anon`. Because the function is
-- SECURITY DEFINER it bypasses RLS, so an anon caller could create kit lots
-- even though the kit_lots INSERT policy is `TO authenticated`. The bench
-- runs authenticated (kiosk-authenticate device JWT), so anon is not needed.
-- Recommend dropping anon from the GRANT at promotion time.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. so_as_written
-- ---------------------------------------------------------------------
ALTER TABLE public.kit_lots ADD COLUMN IF NOT EXISTS so_as_written text;
CREATE INDEX IF NOT EXISTS kl_so_idx ON public.kit_lots USING btree (so_as_written);

-- ---------------------------------------------------------------------
-- 2. kit_assign_and_log
-- ---------------------------------------------------------------------
-- The previous revision took p_invoice_as_written in the 7th position. The
-- argument TYPES are unchanged, so CREATE OR REPLACE cannot be used to
-- rename that parameter — Postgres rejects renaming an input parameter, and
-- a differing signature would create an overload rather than replace the
-- function. Drop first, then create.
DROP FUNCTION IF EXISTS public.kit_assign_and_log(
  uuid, date, text, uuid, text, uuid, text, uuid, text, text, text, uuid);

CREATE OR REPLACE FUNCTION public.kit_assign_and_log(
  p_book_id uuid,
  p_log_date date,
  p_kit_part_as_written text,
  p_kit_sku_id uuid,
  p_customer_as_written text,
  p_party_id uuid,
  p_so_as_written text,
  p_kit_sale_line_id uuid,
  p_stud_number text,
  p_rec_platemount_number text,
  p_notes text,
  p_created_by uuid)
 RETURNS TABLE(lot_id uuid, lot_number integer, book_code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_book record;
  v_next integer;
  v_id uuid;
BEGIN
  SELECT id, code, last_lot, is_active INTO v_book
  FROM public.kit_books WHERE id = p_book_id FOR UPDATE;

  IF v_book.id IS NULL THEN
    RAISE EXCEPTION 'Unknown kit book %', p_book_id;
  END IF;
  IF NOT v_book.is_active THEN
    RAISE EXCEPTION 'Kit book % is inactive', v_book.code;
  END IF;

  SELECT GREATEST(COALESCE(MAX(kl.lot_number), 0), COALESCE(v_book.last_lot, 0)) + 1
  INTO v_next
  FROM public.kit_lots kl WHERE kl.book_id = p_book_id;

  INSERT INTO public.kit_lots (book_id, lot_number, log_date, kit_part_as_written,
    kit_sku_id, customer_as_written, party_id, so_as_written, kit_sale_line_id,
    stud_number, rec_platemount_number, notes, record_status, source, created_by)
  VALUES (p_book_id, v_next, p_log_date, NULLIF(p_kit_part_as_written,''),
    p_kit_sku_id, NULLIF(p_customer_as_written,''), p_party_id,
    NULLIF(p_so_as_written,''), p_kit_sale_line_id,
    NULLIF(p_stud_number,''), NULLIF(p_rec_platemount_number,''),
    NULLIF(p_notes,''), 'active', 'skynet', p_created_by)
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id, v_next, v_book.code::text;
END $function$;

REVOKE ALL ON FUNCTION public.kit_assign_and_log(
  uuid, date, text, uuid, text, uuid, text, uuid, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kit_assign_and_log(
  uuid, date, text, uuid, text, uuid, text, uuid, text, text, text, uuid)
  TO anon, authenticated, service_role;

COMMIT;
