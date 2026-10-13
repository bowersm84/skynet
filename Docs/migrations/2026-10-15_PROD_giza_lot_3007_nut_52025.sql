/* =====================================================================================
   2026-10-15_PROD_giza_lot_3007_nut_52025.sql  --  PROD, Matt. Rehearsed on scratch and TEST.

   Matt 10/15: nut lot 52025 (Xiamen P260629-20, 11,100 received 10/6, SB# 52025) is about to go
   to Electrolab and should be lot 3007. Only 10,825 are on hand (275 missing). The lot now on
   3007 (nut 52029, Maxtrust, 10,000 awaiting nylon) moves to 3008.

     BLOCK 1  preview (read-only)
     BLOCK 2  nut 52029: 3007 -> 3008; receipt of nut 52025 (11,100, per the receiving log) creates
              3007 through program_log_entry; nylon 52004 x 10,825 inserted; note on the 275;
              counter -> 3009.
     BLOCK 3  verify (read-only)

   Nylon lot: 52004. Matt gave "42004", which is not in the 2026 receiving log (nylon lots there:
   51853, 51935, 52004) and is the same typo corrected on lot 3006 on 10/15. If the floor really
   has a nylon lot 42004, stop after BLOCK 1 and say so.

   "Sent to Electrolab" is not logged here: Ashley logs it on the dashboard when the lot ships,
   with the PO and expected-back date.
   ===================================================================================== */


/* ===================================== BLOCK 1 =====================================
   PREVIEW. PROD expect: lot_3007 nut 52029 waiting_insert 10000; lot_3008 none;
   nut_52025_logged 0; next 3008.
   ================================================================================== */
SELECT jsonb_build_object(
  'lot_3007', (SELECT jsonb_build_object('nut', nut_lot, 'status', status, 'waiting_insert', waiting_insert) FROM public.v_program_final_lots WHERE lot_number = '3007'),
  'lot_3008', (SELECT count(*) FROM public.program_final_lots WHERE lot_number = '3008'),
  'nut_52025_logged', (SELECT count(*) FROM public.program_ledger WHERE stage = 'received' AND lot_number = '52025' AND voided_at IS NULL),
  'next', (SELECT final_lot_next FROM public.programs WHERE code = 'GIZA-21077')
) AS preview;


/* ===================================== BLOCK 2 =====================================
   RENUMBER + LOG. Idempotent: a re-run after success only reports "already done".
   ================================================================================== */
DO $$
DECLARE
  v_prog uuid; v_nut uuid; v_r jsonb; v_lot uuid;
  v_b public.program_final_lots%ROWTYPE;   /* nut 52029 */
BEGIN
  SELECT id INTO v_prog FROM public.programs WHERE code = 'GIZA-21077';
  SELECT part_id INTO v_nut FROM public.program_parts WHERE program_id = v_prog AND role = 'nut';

  IF EXISTS (SELECT 1 FROM public.program_ledger WHERE program_id = v_prog AND stage = 'received' AND lot_number = '52025' AND voided_at IS NULL) THEN
    RAISE NOTICE 'nut 52025 is already logged; nothing to do';
    RETURN;
  END IF;

  SELECT * INTO v_b FROM public.program_final_lots WHERE program_id = v_prog AND nut_lot = '52029' AND origin = 'receipt' AND status = 'active';
  IF v_b.id IS NULL OR v_b.lot_number <> '3007' THEN RAISE EXCEPTION 'GUARD: expected nut 52029 on lot 3007'; END IF;
  IF EXISTS (SELECT 1 FROM public.program_final_lots WHERE program_id = v_prog AND lot_number = '3008') THEN
    RAISE EXCEPTION 'GUARD: lot 3008 already exists';
  END IF;
  IF (SELECT final_lot_next FROM public.programs WHERE id = v_prog) <> 3008 THEN RAISE EXCEPTION 'GUARD: expected the counter at 3008'; END IF;

  /* 1. nut 52029 moves to 3008 */
  UPDATE public.program_final_lots SET lot_number = '3008', updated_at = now() WHERE id = v_b.id;
  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('program_lot_renumbered', auth.uid(), jsonb_build_object('lot_id', v_b.id, 'from', '3007', 'to', '3008',
          'reason', 'Matt 10/15: nut 52025 (going to Electrolab first) takes 3007; nut 52029 follows as 3008'));

  /* 2. the receipt of nut 52025 creates lot 3007 */
  UPDATE public.programs SET final_lot_next = 3007 WHERE id = v_prog;
  v_r := public.program_log_entry(v_prog, v_nut, 'received', 11100, '52025', NULL, NULL, NULL, 'Xiamen', 'P260629-20', NULL, '2026-10-06', NULL,
                                  'Receiving log 10/6, SB# 52025');
  IF v_r->>'lot_number' <> '3007' THEN RAISE EXCEPTION 'GUARD: nut 52025 landed on % not 3007', v_r->>'lot_number'; END IF;
  v_lot := (v_r->>'lot_id')::uuid;

  /* 3. nylon in: 10,825, the quantity on hand */
  PERFORM public.program_log_entry(v_prog, v_nut, 'washer_inserted', 10825, '52004', v_lot, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                                   'Nylon 52004 (given as 42004, not a receiving-log lot); 10,825 on hand');
  PERFORM public.program_update_final_lot(v_lot, jsonb_build_object('notes',
    '275 of the 11,100 received (Xiamen P260629-20, SB# 52025) could not be found at the 10/15 count; 10,825 had nylon inserted.'));

  /* 4. 3008 is taken, so the next receipt gets 3009 */
  UPDATE public.programs SET final_lot_next = 3009 WHERE id = v_prog;
  RAISE NOTICE 'nut 52029 -> 3008; nut 52025 = 3007 with nylon 52004 x 10,825; next number 3009';
END $$;


/* ===================================== BLOCK 3 =====================================
   VERIFY. PROD expect: 3006 unchanged (52015, 171 / 7,813 / 2,016); 3007 nut 52025 nylon
   52004 waiting_insert 275 waiting_plating 10825; 3008 nut 52029 waiting_insert 10000; next 3009.
   ================================================================================== */
SELECT jsonb_build_object(
  'active', (SELECT jsonb_agg(jsonb_build_object('lot', lot_number, 'nut', nut_lot, 'nylon', insert_lot, 'waiting_insert', waiting_insert,
               'waiting_plating', waiting_plating, 'waiting_paint', waiting_paint, 'in_oven', in_oven) ORDER BY lot_number)
               FROM public.v_program_final_lots WHERE status = 'active'),
  'next', (SELECT final_lot_next FROM public.programs WHERE code = 'GIZA-21077')
) AS verify;
