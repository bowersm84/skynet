-- =====================================================================
-- kit_assign_and_log — required-field enforcement (D-KSTC-16 / D-KSTC-17)
-- Applied to TEST 2026-08-02. Supersedes the function body in
-- 2026-08-02_kit_assign_and_log_rpc.sql (which predates validation).
--
-- REQUIRED: log date, kit name, customer, sales order #.
-- OPTIONAL: stud lot #, receptacle/platemount lot #, notes.
--
-- Stud lot # is NOT required (D-KSTC-17). It was briefly enforced for
-- non-RV kit types; that is reverted here, because the stud lot is not
-- always known at the moment the kit is logged and entry must never block
-- on data the bench doesn't have yet — the same principle as D-KSTC-07
-- (unmatched kit part / customer save as-written) and D-BLANKS-04
-- (production is never stopped for missing paperwork). The field is still
-- rendered for SK203/TRIM and hidden for RV; it is simply optional where
-- it appears.
--
-- All text is btrim'd here as well as in the client: the database does not
-- trust the form. Blank-after-trim optional fields store NULL, not ''.
--
-- Signature is unchanged, so CREATE OR REPLACE is safe (no overload risk)
-- and the existing REVOKE/GRANT set carries forward untouched.
-- =====================================================================

BEGIN;

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

  IF p_log_date IS NULL THEN
    RAISE EXCEPTION 'Log date is required';
  END IF;
  IF btrim(coalesce(p_kit_part_as_written,'')) = '' THEN
    RAISE EXCEPTION 'Kit name is required';
  END IF;
  IF btrim(coalesce(p_customer_as_written,'')) = '' THEN
    RAISE EXCEPTION 'Customer is required';
  END IF;
  IF btrim(coalesce(p_so_as_written,'')) = '' THEN
    RAISE EXCEPTION 'Sales order # is required';
  END IF;
  -- No stud lot # check: optional by design (D-KSTC-17).

  SELECT GREATEST(COALESCE(MAX(kl.lot_number), 0), COALESCE(v_book.last_lot, 0)) + 1
  INTO v_next
  FROM public.kit_lots kl WHERE kl.book_id = p_book_id;

  INSERT INTO public.kit_lots (book_id, lot_number, log_date, kit_part_as_written,
    kit_sku_id, customer_as_written, party_id, so_as_written, kit_sale_line_id,
    stud_number, rec_platemount_number, notes, record_status, source, created_by)
  VALUES (p_book_id, v_next, p_log_date, btrim(p_kit_part_as_written),
    p_kit_sku_id, btrim(p_customer_as_written), p_party_id,
    btrim(p_so_as_written), p_kit_sale_line_id,
    NULLIF(btrim(coalesce(p_stud_number,'')),''), NULLIF(btrim(coalesce(p_rec_platemount_number,'')),''),
    NULLIF(btrim(coalesce(p_notes,'')),''), 'active', 'skynet', p_created_by)
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id, v_next, v_book.code::text;
END $function$;

COMMIT;
