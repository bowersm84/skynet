/* =====================================================================================
   2026-10-15_PROD_giza_catch_up.sql  --  Giza lots caught up with the right lot numbers.
   Rehearsed on scratch and on TEST (TEST mirrored to PROD's state first). PROD: Matt.

   Sources: 2026 receiving log (SB#s), the 10/14 catch-up sheet, WO W5969:001, the 3004 and
   3005 cert packages, the paper MS21077 sheet, Fishbowl shipments. Genealogy doc:
   "SK21077 Lot Genealogy - Asia to Electrolab to Bag Lot".

     BLOCK 1  preview (read-only)
     BLOCK 2  renumber, matched by nut lot (never by number):
                nut 52015 (9,829 to Electrolab, back as 52035, FLN-100307)  3009 -> 3006
                nut 52029 (10,000 Maxtrust 10/9, awaiting nylon)             3008 -> 3007
                the voided typo receipt (nut "52729", 100,000)               3007 -> 3007-VOID
                the empty paper-sheet placeholder 3006                       -> 3005-2 (the 10/12 shipment)
              counter -> 3008. Every reference is by id, so batches, ledger rows and FLN-100307 follow.
     BLOCK 3  lot 3006 nylon: void the "42004" entry, re-log 52004 x 9,829 (what went to Electrolab).
              The 171 of the 10,000 received that nobody can find stay visible as "awaiting nylon".
     BLOCK 4  historical records: 3001-3004, 3005 (cert shipment) and 3005-2 (shipped 10/12 labeled 3005).
     BLOCK 5  verify (read-only)

   One block at a time. REVIEW STOP after BLOCK 1 (expected values are in its comment).
   ===================================================================================== */


/* ===================================== BLOCK 1 =====================================
   PREVIEW. PROD expect: lot_52015 "3009" active plating 52035 nylon 42004; lot_52029 "3008"
   active waiting_insert 10000; lot_3007 void; lot_3006 historical with no quantity; next 3010;
   J-FIN-000033 on lot "3009" with FLN-100307.
   ================================================================================== */
SELECT jsonb_build_object(
  'lot_52015', (SELECT jsonb_build_object('lot', lot_number, 'status', status, 'plating', plating_lot, 'nylon', insert_lot, 'waiting_paint', waiting_paint, 'in_oven', in_oven)
                  FROM public.v_program_final_lots WHERE nut_lot = '52015' AND status = 'active'),
  'lot_52029', (SELECT jsonb_build_object('lot', lot_number, 'status', status, 'waiting_insert', waiting_insert)
                  FROM public.v_program_final_lots WHERE nut_lot = '52029' AND status = 'active'),
  'lot_3007', (SELECT status || ' / nut ' || coalesce(nut_lot, '-') FROM public.program_final_lots WHERE lot_number = '3007'),
  'lot_3006', (SELECT status || ' / qty ' || coalesce(quantity::text, 'none') FROM public.program_final_lots WHERE lot_number = '3006'),
  'next', (SELECT final_lot_next FROM public.programs WHERE code = 'GIZA-21077'),
  'batch', (SELECT j.job_number || ' on lot ' || coalesce(l.lot_number, '-') || ' / ' || coalesce(fs.finishing_lot_number, '-')
              FROM public.finishing_sends fs JOIN public.jobs j ON j.id = fs.job_id LEFT JOIN public.program_final_lots l ON l.id = fs.program_dest_lot_id
             WHERE j.job_number = 'J-FIN-000033')
) AS preview;


/* ===================================== BLOCK 2 =====================================
   RENUMBER. Idempotent: a re-run after success only reports "already renumbered".
   ================================================================================== */
DO $$
DECLARE
  v_prog uuid;
  v_a public.program_final_lots%ROWTYPE;   /* nut 52015 */
  v_b public.program_final_lots%ROWTYPE;   /* nut 52029 */
  v_void public.program_final_lots%ROWTYPE;
  v_ph public.program_final_lots%ROWTYPE;
BEGIN
  SELECT id INTO v_prog FROM public.programs WHERE code = 'GIZA-21077';
  SELECT * INTO v_a FROM public.program_final_lots WHERE program_id = v_prog AND nut_lot = '52015' AND origin = 'receipt' AND status = 'active';
  SELECT * INTO v_b FROM public.program_final_lots WHERE program_id = v_prog AND nut_lot = '52029' AND origin = 'receipt' AND status = 'active';
  IF v_a.id IS NULL OR v_b.id IS NULL THEN RAISE EXCEPTION 'GUARD: expected one active lot each for nut 52015 and nut 52029'; END IF;

  IF v_a.lot_number = '3006' AND v_b.lot_number = '3007' THEN
    RAISE NOTICE 'already renumbered (52015 = 3006, 52029 = 3007); nothing to do';
    RETURN;
  END IF;
  IF v_a.lot_number <> '3009' OR v_b.lot_number <> '3008' THEN
    RAISE EXCEPTION 'GUARD: expected nut 52015 on 3009 and nut 52029 on 3008, found % and %', v_a.lot_number, v_b.lot_number;
  END IF;

  SELECT * INTO v_void FROM public.program_final_lots WHERE program_id = v_prog AND lot_number = '3007';
  IF v_void.id IS NULL OR v_void.status <> 'void' THEN RAISE EXCEPTION 'GUARD: lot 3007 is not the voided typo receipt'; END IF;
  SELECT * INTO v_ph FROM public.program_final_lots WHERE program_id = v_prog AND lot_number = '3006';
  IF v_ph.id IS NULL OR v_ph.status <> 'historical' OR v_ph.quantity IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.program_ledger WHERE final_lot_id = v_ph.id OR from_lot_id = v_ph.id)
     OR EXISTS (SELECT 1 FROM public.finishing_sends WHERE program_lot_id = v_ph.id OR program_dest_lot_id = v_ph.id) THEN
    RAISE EXCEPTION 'GUARD: 3006 is not the empty paper-sheet placeholder';
  END IF;
  IF EXISTS (SELECT 1 FROM public.program_final_lots WHERE program_id = v_prog AND lot_number IN ('3007-VOID', '3005-2')) THEN
    RAISE EXCEPTION 'GUARD: 3007-VOID or 3005-2 already exists';
  END IF;

  UPDATE public.program_final_lots SET lot_number = '3007-VOID', updated_at = now() WHERE id = v_void.id;
  UPDATE public.program_final_lots SET lot_number = '3005-2', updated_at = now() WHERE id = v_ph.id;
  UPDATE public.program_final_lots SET lot_number = '3006', updated_at = now() WHERE id = v_a.id;
  UPDATE public.program_final_lots SET lot_number = '3007', updated_at = now() WHERE id = v_b.id;
  UPDATE public.programs SET final_lot_next = 3008 WHERE id = v_prog;

  INSERT INTO public.audit_logs (event_type, operator_id, details) VALUES
    ('program_lot_renumbered', auth.uid(), jsonb_build_object('lot_id', v_void.id, 'from', '3007', 'to', '3007-VOID', 'reason', 'Voided typo receipt (nut 52729 x 100,000) moved off 3007')),
    ('program_lot_renumbered', auth.uid(), jsonb_build_object('lot_id', v_ph.id, 'from', '3006', 'to', '3005-2', 'reason', 'Empty paper-sheet placeholder reused for the 10/12 shipment that went out labeled 3005')),
    ('program_lot_renumbered', auth.uid(), jsonb_build_object('lot_id', v_a.id, 'from', '3009', 'to', '3006', 'reason', 'Matt 10/15: nut 52015 is lot 3006 on the paper sheet and the 10/14 catch-up sheet')),
    ('program_lot_renumbered', auth.uid(), jsonb_build_object('lot_id', v_b.id, 'from', '3008', 'to', '3007', 'reason', 'Matt 10/15: nut 52029 follows as 3007'));
  RAISE NOTICE 'renumbered: 52015 -> 3006, 52029 -> 3007, typo -> 3007-VOID, placeholder -> 3005-2; next number 3008';
END $$;


/* ===================================== BLOCK 3 =====================================
   LOT 3006 NYLON: 42004 -> 52004, quantity 9,829. Idempotent.
   ================================================================================== */
DO $$
DECLARE v_prog uuid; v_nut uuid; v_lot uuid; v_entry uuid;
BEGIN
  SELECT id INTO v_prog FROM public.programs WHERE code = 'GIZA-21077';
  SELECT part_id INTO v_nut FROM public.program_parts WHERE program_id = v_prog AND role = 'nut';
  SELECT id INTO v_lot FROM public.program_final_lots WHERE program_id = v_prog AND lot_number = '3006' AND nut_lot = '52015';
  IF v_lot IS NULL THEN RAISE EXCEPTION 'GUARD: run BLOCK 2 first (3006 is not nut 52015)'; END IF;

  SELECT id INTO v_entry FROM public.program_ledger
   WHERE final_lot_id = v_lot AND stage = 'washer_inserted' AND lot_number = '42004' AND voided_at IS NULL;
  IF v_entry IS NULL THEN
    RAISE NOTICE 'nylon entry already corrected; nothing to do';
    RETURN;
  END IF;
  PERFORM public.program_void_entry(v_entry,
    'Nylon lot typo: 42004 should be 52004 (receiving log SB# 52004). Re-logged at 9,829, the quantity sent to Electrolab on PO 4248.');
  PERFORM public.program_log_entry(v_prog, v_nut, 'washer_inserted', 9829, '52004', v_lot, NULL, NULL, NULL, NULL, NULL, '2026-10-02', NULL,
    'Corrected 10/15: nylon 52004 x 9,829 (replaces the 42004 x 10,000 entry)');
  PERFORM public.program_update_final_lot(v_lot, jsonb_build_object('notes',
    '171 of the 10,000 received (Maxtrust P260602-20, SB# 52015) were never sent to Electrolab and could not be found at the 10/14 count.'));
  RAISE NOTICE 'lot 3006 nylon corrected to 52004 x 9,829';
END $$;


/* ===================================== BLOCK 4 =====================================
   HISTORICAL RECORDS. program_update_final_lot sets each field absolutely, so a re-run
   writes the same values.
   ================================================================================== */
DO $$
DECLARE v_prog uuid; v_lot uuid; c record;
BEGIN
  SELECT id INTO v_prog FROM public.programs WHERE code = 'GIZA-21077';
  FOR c IN SELECT * FROM (VALUES
    ('3001',   '{"quantity": 835,  "nut_lots": ["902815"], "plating_lots": ["51885"], "cage_lot": "51859", "retainer_lot": "51873", "insert_lot": "51853", "torsion_1_qty": 10, "torsion_1_inlbs": 34, "torsion_2_qty": 10, "torsion_2_inlbs": 27, "inspected_by": "NCB", "notes": "Shipped 6/23 (S15548). In-house nut. Nut and plated lot as read from the paper sheet; plated 51885 = Electrolab P3561 from Braddock HT 51872."}'),
    ('3002',   '{"quantity": 384,  "nut_lots": ["902816"], "plating_lots": ["51883"], "cage_lot": "51859", "retainer_lot": "51873", "insert_lot": "51853", "torsion_1_qty": 10, "torsion_1_inlbs": 40, "torsion_2_qty": 10, "torsion_2_inlbs": 35, "inspected_by": "NCB", "notes": "Shipped 7/6 (S15548-02). In-house nut. Nut and plated lot as read from the paper sheet; plated 51883 = Electrolab P3554 from Braddock HT 51877."}'),
    ('3003',   '{"quantity": 2186, "nut_lots": ["902817"], "plating_lots": ["51885"], "cage_lot": "51859", "retainer_lot": "51873", "insert_lot": "51853", "torsion_1_qty": 10, "torsion_1_inlbs": 35, "torsion_2_qty": 10, "torsion_2_inlbs": 42, "inspected_by": "NCB", "notes": "Shipped 1,370 on 6/23 and 816 on 7/6. In-house nut. Paper sheet reads plated 51885, but 51885 (2,541) cannot cover both 3001 and 3003 (3,021): part of 3003 is probably 51883. Confirm from the original sheet."}'),
    ('3004',   '{"quantity": 1575, "nut_lots": ["902818"], "plating_lots": ["51925"], "finishing_lots": ["FLN-100052"], "cage_lot": "51859", "retainer_lot": "51873", "insert_lot": "51853", "torsion_1_qty": 10, "torsion_1_inlbs": 40, "torsion_2_qty": 10, "torsion_2_inlbs": 38, "inspected_by": "NCB", "notes": "Shipped 8/3 (S15548-03). Cert package FLN-100052-CP2: in-house nut 902818 (PLN-260527-0002, bar lot 2616), Braddock HT 51886, Electrolab P3723 -> 51925, dry film 51683."}'),
    ('3005',   '{"quantity": 5271, "nut_lots": ["51986"], "plating_lots": ["52008", "52028"], "cage_lot": "51888", "retainer_lot": "51940", "insert_lot": "51853", "inspected_by": "NCB", "notes": "Shipped 10/1 (S15548-04), cert QC release 9/23. Nut 51986 (Xiamen P260629-20) was plated in two returns: 52008 (P4123, 3,408, nylon 51853) and 52028 (P4193, 6,393, nylon 52004). 5,271 exceeds 3,408, so at least 1,863 of 3005 came from 52028 and carry nylon 52004. Cage 51888 = Electrolab P3563 from 51861. Retainer 51940 = Electrolab P3774 from 51854/51862. Dry film 51683. Cert correction is Quality''s call."}'),
    ('3005-2', '{"quantity": 4483, "nut_lots": ["51986"], "plating_lots": ["52028"], "cage_lot": "51900", "retainer_lot": "51940", "insert_lot": "52004", "notes": "Shipped 10/12 (S15548-05: 2,500 + 1,983) labeled 3005; a separate trail from 3005. WO W5969:001 built 4,489 (its lots were wrong in Fishbowl: nylon 51853 and nut 51986 should read 52004 and 52028). Cage 51900 = Electrolab P3589 from Maxtrust 51881. The catch-up sheet also lists retainer 51873 (\"Clip\") - confirm whether part of this build used it. Cert for this shipment is Quality''s call."}')
  ) AS t(lot, fields)
  LOOP
    SELECT id INTO v_lot FROM public.program_final_lots WHERE program_id = v_prog AND lot_number = c.lot AND status = 'historical';
    IF v_lot IS NULL THEN RAISE EXCEPTION 'GUARD: historical lot % missing (run BLOCK 2 first)', c.lot; END IF;
    PERFORM public.program_update_final_lot(v_lot, c.fields::jsonb);
  END LOOP;
  RAISE NOTICE 'historical 3001-3005 and 3005-2 recorded';
END $$;


/* ===================================== BLOCK 5 =====================================
   VERIFY. PROD expect: 3006 nut 52015 nylon 52004 plating 52035 FLN-100307, waiting_insert 171,
   waiting_plating 0, waiting_paint 7813, in_oven 2016; 3007 nut 52029 waiting_insert 10000;
   J-FIN-000033 on 3006; next 3008; historical 835 / 384 / 2186 / 1575 / 5271 / 4483 (total 14734,
   the Fishbowl shipped total for SO 15548).
   ================================================================================== */
SELECT jsonb_build_object(
  'active', (SELECT jsonb_agg(jsonb_build_object('lot', lot_number, 'nut', nut_lot, 'nylon', insert_lot, 'plating', plating_lot, 'fln', finishing_lot,
               'waiting_insert', waiting_insert, 'waiting_plating', waiting_plating, 'waiting_paint', waiting_paint, 'in_oven', in_oven) ORDER BY lot_number)
               FROM public.v_program_final_lots WHERE status = 'active'),
  'batch', (SELECT j.job_number || ' on lot ' || coalesce(l.lot_number, '-') || ' / ' || coalesce(fs.finishing_lot_number, '-')
              FROM public.finishing_sends fs JOIN public.jobs j ON j.id = fs.job_id LEFT JOIN public.program_final_lots l ON l.id = fs.program_dest_lot_id
             WHERE j.job_number = 'J-FIN-000033'),
  'historical', (SELECT jsonb_object_agg(lot_number, quantity) FROM public.program_final_lots WHERE status = 'historical'),
  'historical_total', (SELECT sum(quantity) FROM public.program_final_lots WHERE status = 'historical'),
  'void', (SELECT string_agg(lot_number, ',') FROM public.program_final_lots WHERE status = 'void'),
  'next', (SELECT final_lot_next FROM public.programs WHERE code = 'GIZA-21077')
) AS verify;
