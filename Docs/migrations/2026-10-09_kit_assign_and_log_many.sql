/* =====================================================================================
   2026-10-09_kit_assign_and_log_many.sql
   D-KSTC-35 -- Kit Entry quantity: one entry logs a block of identical kits.

   WHAT
     New wrapper RPC public.kit_assign_and_log_many(<the 12 kit_assign_and_log args>, p_qty)
     RETURNS TABLE(lot_id, lot_number, book_code) -- one row per kit, lowest number first.
     It calls public.kit_assign_and_log p_qty times inside ONE transaction. The kit_books
     FOR UPDATE lock taken by the first inner call is held until commit, so the block is
     contiguous and gapless, and any RAISE inside rolls back every lot of the block.
     kit_assign_and_log itself is NOT changed (TEST md5 5d9a8090b559f023a6c327b9b58ba4b1).
     Grants follow D-KSTC-13: REVOKE PUBLIC and anon; GRANT authenticated, service_role.

   RUN ORDER (Supabase SQL Editor -- ONE BLOCK PER RUN, never the whole sheet)
     BLOCK 1  create + grants                     expect: success, no rows
     BLOCK 2  verify (read-only)                  expect: fn_exists true, anon false,
                                                  authenticated true, acl shows no PUBLIC/anon
     BLOCK 3  smoke (writes 3 lots, then RAISES   expect: an ERROR whose text starts SMOKE_OK
              on purpose so it rolls itself back) -- a SMOKE_FAIL text means stop and report
     BLOCK 4  after-smoke check (read-only)       expect: smoke_lots_left 0
     The editor runs a sheet as one transaction: BLOCK 3's deliberate RAISE would undo
     BLOCK 1 if they were run together. Keep them separate.

   ENVIRONMENTS
     TEST (ylzmyjjqibpbqbwjsnqj): applied by Claude 2026-10-09 (BLOCK 1 via apply_migration,
     BLOCKS 2-4 run; results in the conversation).
     PROD (luzungoqfuplspzbqctb): Matt runs BLOCK 1, 2, 3, 4 in that order after the TEST
     browser pass. Run PROD BEFORE pushing main (migration before frontend).
   ===================================================================================== */


/* ------------------------------- BLOCK 1 : create ---------------------------------- */

CREATE OR REPLACE FUNCTION public.kit_assign_and_log_many(
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
  p_created_by uuid,
  p_qty integer)
RETURNS TABLE(lot_id uuid, lot_number integer, book_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_i integer;
BEGIN
  /* Same ceiling as MAX_KITS_PER_ENTRY in src/pages/KitKiosk.jsx (D-KSTC-35). */
  IF p_qty IS NULL OR p_qty < 1 THEN
    RAISE EXCEPTION 'Quantity must be at least 1';
  END IF;
  IF p_qty > 25 THEN
    RAISE EXCEPTION 'Quantity cannot exceed 25 kits per entry';
  END IF;

  /* Every inner call validates the same fields and inserts one lot under the
     kit_books row lock. The lock is transaction-scoped, so it stays held across
     the loop: no other bench can interleave a number, and a failure anywhere
     (blank field, inactive book) leaves zero lots behind. */
  FOR v_i IN 1..p_qty LOOP
    RETURN QUERY
      SELECT * FROM public.kit_assign_and_log(
        p_book_id, p_log_date, p_kit_part_as_written, p_kit_sku_id,
        p_customer_as_written, p_party_id, p_so_as_written, p_kit_sale_line_id,
        p_stud_number, p_rec_platemount_number, p_notes, p_created_by);
  END LOOP;
  RETURN;
END
$function$;

REVOKE ALL ON FUNCTION public.kit_assign_and_log_many(uuid, date, text, uuid, text, uuid, text, uuid, text, text, text, uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.kit_assign_and_log_many(uuid, date, text, uuid, text, uuid, text, uuid, text, text, text, uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.kit_assign_and_log_many(uuid, date, text, uuid, text, uuid, text, uuid, text, text, text, uuid, integer) TO authenticated, service_role;


/* ------------------------------- BLOCK 2 : verify ---------------------------------- */
/* Read-only. Expect fn_exists true, anon_can_execute false, authenticated_can_execute
   true, acl with postgres/authenticated/service_role only. inner_md5 is informational:
   it is the kit_assign_and_log text on this environment (TEST reads
   5d9a8090b559f023a6c327b9b58ba4b1; PROD may differ in whitespace only). */

SELECT jsonb_build_object(
  'fn_exists', EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = 'kit_assign_and_log_many' AND pronargs = 13),
  'acl', (
    SELECT proacl::text FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'kit_assign_and_log_many'),
  'anon_can_execute', has_function_privilege('anon',
    'public.kit_assign_and_log_many(uuid,date,text,uuid,text,uuid,text,uuid,text,text,text,uuid,integer)', 'EXECUTE'),
  'authenticated_can_execute', has_function_privilege('authenticated',
    'public.kit_assign_and_log_many(uuid,date,text,uuid,text,uuid,text,uuid,text,text,text,uuid,integer)', 'EXECUTE'),
  'inner_md5', (
    SELECT md5(pg_get_functiondef(oid)) FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'kit_assign_and_log'),
  'inner_md5_test_reference', '5d9a8090b559f023a6c327b9b58ba4b1'
) AS verify;


/* ------------------------------- BLOCK 3 : smoke ----------------------------------- */
/* Writes a 3-kit block into the active SK203 book, checks it, tests the 0 and 26 guards,
   then RAISES on purpose so the whole block rolls back. The ERROR text is the report:
   SMOKE_OK = pass. Leaves no rows (BLOCK 4 proves it). Assignments only (no SELECT INTO)
   because of the SQL Editor DO-block rewrite. No profile UUIDs are hardcoded. */

DO $smoke$
DECLARE
  v_book uuid;
  v_creator uuid;
  v_before integer;
  v_res jsonb;
  v_left integer;
  v_g0 text := 'NOT RAISED';
  v_g26 text := 'NOT RAISED';
  v_verdict text;
BEGIN
  v_book := (SELECT id FROM public.kit_books WHERE code = 'SK203' AND is_active = true);
  IF v_book IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no active SK203 book';
  END IF;
  v_creator := (SELECT id FROM public.profiles WHERE is_active = true ORDER BY username LIMIT 1);

  v_before := (SELECT GREATEST(COALESCE(MAX(kl.lot_number), 0),
                                COALESCE((SELECT b.last_lot FROM public.kit_books b WHERE b.id = v_book), 0))
               FROM public.kit_lots kl WHERE kl.book_id = v_book);

  v_res := (SELECT jsonb_build_object(
              'n', count(*),
              'ids', count(DISTINCT f.lot_id),
              'min', min(f.lot_number),
              'max', max(f.lot_number),
              'nums', string_agg(f.lot_number::text, ',' ORDER BY f.lot_number),
              'book', min(f.book_code))
            FROM public.kit_assign_and_log_many(
              v_book, CURRENT_DATE, 'SMOKE-TEST-KIT', NULL, 'SMOKE TEST CUSTOMER', NULL,
              'SMOKE-D-KSTC-35', NULL, '', '', 'D-KSTC-35 smoke block - rolled back', v_creator, 3) f);

  v_left := (SELECT count(*) FROM public.kit_lots
             WHERE book_id = v_book AND so_as_written = 'SMOKE-D-KSTC-35' AND source = 'skynet');

  BEGIN
    PERFORM * FROM public.kit_assign_and_log_many(
      v_book, CURRENT_DATE, 'SMOKE-TEST-KIT', NULL, 'SMOKE TEST CUSTOMER', NULL,
      'SMOKE-D-KSTC-35', NULL, '', '', 'guard', v_creator, 0);
  EXCEPTION WHEN OTHERS THEN
    v_g0 := SQLERRM;
  END;

  BEGIN
    PERFORM * FROM public.kit_assign_and_log_many(
      v_book, CURRENT_DATE, 'SMOKE-TEST-KIT', NULL, 'SMOKE TEST CUSTOMER', NULL,
      'SMOKE-D-KSTC-35', NULL, '', '', 'guard', v_creator, 26);
  EXCEPTION WHEN OTHERS THEN
    v_g26 := SQLERRM;
  END;

  v_verdict := CASE
    WHEN (v_res->>'n')::int = 3
     AND (v_res->>'ids')::int = 3
     AND (v_res->>'min')::int = v_before + 1
     AND (v_res->>'max')::int = v_before + 3
     AND v_left = 3
     AND v_g0 LIKE 'Quantity must be at least 1%'
     AND v_g26 LIKE 'Quantity cannot exceed 25%'
    THEN 'SMOKE_OK' ELSE 'SMOKE_FAIL' END;

  RAISE EXCEPTION '%: before=% block=% rows_in_table=% guard0=[%] guard26=[%] (all rolled back)',
    v_verdict, v_before, v_res::text, v_left, v_g0, v_g26;
END
$smoke$;


/* ------------------------------- BLOCK 4 : after smoke ----------------------------- */
/* Read-only. Expect smoke_lots_left 0 and next_sk203 equal to the "before" value in the
   BLOCK 3 message plus 1 -- the smoke block left no gap and no rows. */

SELECT jsonb_build_object(
  'smoke_lots_left', (SELECT count(*) FROM public.kit_lots WHERE so_as_written = 'SMOKE-D-KSTC-35'),
  'next_sk203', (SELECT GREATEST(COALESCE(MAX(kl.lot_number), 0), COALESCE(b.last_lot, 0)) + 1
                 FROM public.kit_books b LEFT JOIN public.kit_lots kl ON kl.book_id = b.id
                 WHERE b.code = 'SK203' GROUP BY b.last_lot)
) AS after_smoke;
