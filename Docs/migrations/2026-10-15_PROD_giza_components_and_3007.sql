/* =====================================================================================
   2026-10-15_PROD_giza_components_and_3007.sql  --  PROD, Matt. Rehearsed on scratch and TEST.

   Source: Matt's count sheet of 10/13 (Giza_Assembly_Counts_101326.pdf) and his answers of 10/15.

     BLOCK 1  preview (read-only)
     BLOCK 2  lot 3007: the nut receipt goes from 11,100 (receiving log) to 11,126 (Matt's count),
              so the 11,126 that got nylon no longer leave -26 awaiting nylon; the lot note is
              corrected (nothing is missing). One-shot correction with an audit row.
     BLOCK 3  component stock by lot, as counted 10/13:
                cages      51888 5,011 | 51900 20,042 (all ringed with retainer 51873) | 51918 23,000 | 52021 20,000
                retainers  51873 20,042 (all on cages 51900) | 51940 680 | 51961 53,000
                nylon      51853 43,936 | 52004 82,000 received
              Nylon 52004 goes in at its 82,000 received: SkyNet already took out the 9,829 (lot 3006)
              and 11,126 (lot 3007) inserted from it, so it stands at 72,171 before 3007 (Fishbowl's
              figure, Matt's answer) and 61,045 now.
              Not loaded: nylon 51935 (not for Giza products), cage 51859 and the in-house nylon lots
              (counted 0), unplated stock (cage 52014: 24,000 counted, stays in Fishbowl).
     BLOCK 4  verify (read-only)
   ===================================================================================== */


/* ===================================== BLOCK 1 =====================================
   PREVIEW. PROD expect: lot_3007 receipt 11100, waiting_insert -26; component_receipts 0;
   insert_on_hand -20955, cage_on_hand 0, retainer_on_hand 0.
   ================================================================================== */
SELECT jsonb_build_object(
  'lot_3007', (SELECT jsonb_build_object('receipt', (SELECT qty FROM public.program_ledger WHERE final_lot_id = v.id AND stage = 'received' AND voided_at IS NULL),
                 'waiting_insert', v.waiting_insert, 'waiting_plating', v.waiting_plating) FROM public.v_program_final_lots v WHERE v.lot_number = '3007'),
  'component_receipts', (SELECT count(*) FROM public.program_ledger l JOIN public.program_parts pp ON pp.part_id = l.part_id AND pp.program_id = l.program_id
                          WHERE pp.role <> 'nut' AND l.stage = 'received' AND l.voided_at IS NULL),
  'on_hand', (SELECT jsonb_build_object('nylon', insert_on_hand, 'cage', cage_on_hand, 'retainer', retainer_on_hand) FROM public.v_program_pipeline)
) AS preview;


/* ===================================== BLOCK 2 =====================================
   LOT 3007 RECEIPT 11,100 -> 11,126. Idempotent.
   ================================================================================== */
DO $$
DECLARE v_lot uuid; v_entry uuid; v_qty numeric;
BEGIN
  SELECT id INTO v_lot FROM public.program_final_lots WHERE lot_number = '3007' AND nut_lot = '52025' AND status = 'active';
  IF v_lot IS NULL THEN RAISE EXCEPTION 'GUARD: lot 3007 is not nut 52025'; END IF;
  SELECT id, qty INTO v_entry, v_qty FROM public.program_ledger WHERE final_lot_id = v_lot AND stage = 'received' AND voided_at IS NULL;
  IF v_qty = 11126 THEN RAISE NOTICE 'receipt already 11,126; nothing to do'; RETURN; END IF;
  IF v_qty <> 11100 THEN RAISE EXCEPTION 'GUARD: expected the 3007 receipt at 11,100, found %', v_qty; END IF;

  UPDATE public.program_ledger
     SET qty = 11126,
         notes = 'Receiving log 10/6, SB# 52025: 11,100. Corrected to 11,126, Matt''s count of 10/13 (26 more than the packing list).'
   WHERE id = v_entry;
  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('program_ledger_corrected', auth.uid(), jsonb_build_object('entry_id', v_entry, 'lot', '3007', 'field', 'qty', 'from', 11100, 'to', 11126,
          'reason', 'Matt counted 11,126 of nut 52025 on 10/13; all 11,126 had nylon inserted'));
  PERFORM public.program_update_final_lot(v_lot, jsonb_build_object('notes',
    'Counted 11,126 on 10/13 (Matt) against 11,100 on the receiving log; all 11,126 had nylon 52004 inserted.'));
  RAISE NOTICE 'lot 3007 receipt corrected to 11,126';
END $$;


/* ===================================== BLOCK 3 =====================================
   COMPONENT STOCK BY LOT. Runs once (refuses if any component receipt exists).
   ================================================================================== */
DO $$
DECLARE v_prog uuid; v_cage uuid; v_ret uuid; v_ins uuid; c record; n int := 0;
BEGIN
  SELECT id INTO v_prog FROM public.programs WHERE code = 'GIZA-21077';
  SELECT part_id INTO v_cage FROM public.program_parts WHERE program_id = v_prog AND role = 'cage';
  SELECT part_id INTO v_ret  FROM public.program_parts WHERE program_id = v_prog AND role = 'retainer';
  SELECT part_id INTO v_ins  FROM public.program_parts WHERE program_id = v_prog AND role = 'insert';
  IF EXISTS (SELECT 1 FROM public.program_ledger WHERE program_id = v_prog AND stage = 'received' AND part_id IN (v_cage, v_ret, v_ins) AND voided_at IS NULL) THEN
    RAISE NOTICE 'component stock already loaded; nothing to do';
    RETURN;
  END IF;

  FOR c IN SELECT * FROM (VALUES
      ('cage',     '51888', 5011,  'Electrolab', 'P3563',      'Count 10/13 (MB). Plated from Xiamen cage 51861; received 6/15.'),
      ('cage',     '51900', 20042, 'Electrolab', 'P3589',      'Count 10/13 (MB). Plated from Maxtrust cage 51881; received 6/22. All 20,042 are ringed with retainer 51873.'),
      ('cage',     '51918', 23000, 'Electrolab', 'P3699',      'Count 10/13 (MB). Plated from Maxtrust cage 51881; received 7/9.'),
      ('cage',     '52021', 20000, 'Electrolab', 'P4207',      'Count 10/13 (MB). Plated from Xiamen cage 52005; received 10/1.'),
      ('retainer', '51873', 20042, 'Electrolab', 'P3459',      'Count 10/13 (MB). Plated from Xiamen retainer 51854; received 6/3. All 20,042 are on cages 51900.'),
      ('retainer', '51940', 680,   'Electrolab', 'P3774',      'Count 10/13 (MB). Plated from Xiamen retainer 51854/51862; received 7/23.'),
      ('retainer', '51961', 53000, 'Electrolab', 'P3841',      'Count 10/13 (MB). Plated from Xiamen retainer 51936; received 8/12.'),
      ('insert',   '51853', 43936, 'Xiamen',     'P260320-20', 'Count 10/13 (MB). Received 5/15 (50,000).'),
      ('insert',   '52004', 82000, 'Xiamen',     'P260818-22', 'Received 9/22. Loaded at the 82,000 received: lots 3006 (9,829) and 3007 (11,126) were inserted from it, leaving 72,171 before 3007 (count 10/13) and 61,045 after.')
    ) AS t(role, lot, qty, vendor, po, note)
  LOOP
    PERFORM public.program_log_entry(v_prog, CASE c.role WHEN 'cage' THEN v_cage WHEN 'retainer' THEN v_ret ELSE v_ins END,
                                     'received', c.qty, c.lot, NULL, NULL, NULL, c.vendor, c.po, NULL, '2026-10-13', NULL, c.note);
    n := n + 1;
  END LOOP;
  RAISE NOTICE '% component lots loaded', n;
END $$;


/* ===================================== BLOCK 4 =====================================
   VERIFY. PROD expect: lot_3007 receipt 11126, waiting_insert 0, waiting_plating 11126;
   on hand: cage 68053, retainer 73722, nylon 104981; buildable 2016 (the baked 2,016 of lot 3006).
   ================================================================================== */
SELECT jsonb_build_object(
  'lot_3007', (SELECT jsonb_build_object('receipt', (SELECT qty FROM public.program_ledger WHERE final_lot_id = v.id AND stage = 'received' AND voided_at IS NULL),
                 'waiting_insert', v.waiting_insert, 'waiting_plating', v.waiting_plating) FROM public.v_program_final_lots v WHERE v.lot_number = '3007'),
  'on_hand', (SELECT jsonb_build_object('nylon', insert_on_hand, 'cage', cage_on_hand, 'retainer', retainer_on_hand, 'buildable', buildable_sets) FROM public.v_program_pipeline)
) AS verify;
