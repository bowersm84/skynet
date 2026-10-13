/* =====================================================================================
   2026-10-14_TEST_ONLY_giza_branch_reset.sql  --  TEST ONLY. NEVER RUN ON PROD.

   BLOCK 1 (before 2026-10-14_giza_branches.sql): clears the pre-branch Giza test data —
   ledger rows, the test lot 3007 (with its two FLNs) — unlinks the test dry-film batches
   from the program and resets the counter to 3007. Historical 3001..3006 are kept.
   Guarded on the claude-test-seed marker, which exists only on TEST.

   BLOCK 2 (after the migration): seeds one branch through the new RPCs —
   nut TEST-51999 (1,000) -> lot 3007 -> nylon TEST-51853 -> Electrolab -> plating TEST-52030,
   plus cage / retainer / nylon receipts — so the kiosk picker shows "3007 · TEST-52030 · 1,000".
   ===================================================================================== */

/* ===================================== BLOCK 1 ===================================== */
DO $$
DECLARE v_prog uuid; n_led int; n_lots int; n_sends int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.program_ledger WHERE notes = 'claude-test-seed') THEN
    RAISE EXCEPTION 'GUARD: no claude-test-seed rows; this file is TEST-only';
  END IF;
  SELECT id INTO v_prog FROM public.programs WHERE code = 'GIZA-21077';
  DELETE FROM public.program_ledger WHERE program_id = v_prog;
  GET DIAGNOSTICS n_led = ROW_COUNT;
  UPDATE public.finishing_sends SET program_id = NULL WHERE program_id = v_prog;
  GET DIAGNOSTICS n_sends = ROW_COUNT;
  DELETE FROM public.program_final_lots WHERE program_id = v_prog AND status <> 'historical';
  GET DIAGNOSTICS n_lots = ROW_COUNT;
  UPDATE public.programs SET final_lot_next = 3007 WHERE id = v_prog;
  RAISE NOTICE 'TEST reset: % ledger rows deleted, % test lots deleted, % dry-film batches unlinked, counter -> 3007', n_led, n_lots, n_sends;
END $$;

/* ===================================== BLOCK 2 ===================================== */
DO $$
DECLARE v_prog uuid; v_nut uuid; v_cage uuid; v_ret uuid; v_ins uuid; v_r jsonb; v_lot uuid;
BEGIN
  SELECT id INTO v_prog FROM public.programs WHERE code = 'GIZA-21077';
  SELECT part_id INTO v_nut  FROM public.program_parts WHERE program_id = v_prog AND role = 'nut';
  SELECT part_id INTO v_cage FROM public.program_parts WHERE program_id = v_prog AND role = 'cage';
  SELECT part_id INTO v_ret  FROM public.program_parts WHERE program_id = v_prog AND role = 'retainer';
  SELECT part_id INTO v_ins  FROM public.program_parts WHERE program_id = v_prog AND role = 'insert';
  IF EXISTS (SELECT 1 FROM public.program_ledger WHERE program_id = v_prog AND voided_at IS NULL) THEN
    RAISE EXCEPTION 'GUARD: the program already has live ledger rows';
  END IF;

  v_r := public.program_log_entry(v_prog, v_nut, 'received', 1000, 'TEST-51999', NULL, NULL, NULL, 'Xiamen', 'TEST-PO-1', NULL, current_date - 12, NULL, 'claude-test-seed');
  v_lot := (v_r->>'lot_id')::uuid;
  PERFORM public.program_log_entry(v_prog, v_cage, 'received', 2000, 'TEST-51889', NULL, NULL, NULL, 'Xiamen', 'TEST-PO-1', NULL, current_date - 12, NULL, 'claude-test-seed');
  PERFORM public.program_log_entry(v_prog, v_ret,  'received', 2000, 'TEST-51873', NULL, NULL, NULL, 'Maxtrust', 'TEST-PO-2', NULL, current_date - 12, NULL, 'claude-test-seed');
  PERFORM public.program_log_entry(v_prog, v_ins,  'received', 1500, 'TEST-51853', NULL, NULL, NULL, 'Maxtrust', 'TEST-PO-2', NULL, current_date - 12, NULL, 'claude-test-seed');
  PERFORM public.program_log_entry(v_prog, v_nut,  'washer_inserted', 1000, 'TEST-51853', v_lot, NULL, NULL, NULL, NULL, NULL, current_date - 10, 'TEST', 'claude-test-seed');
  PERFORM public.program_log_entry(v_prog, v_nut,  'sent_plating', 1000, NULL, v_lot, NULL, NULL, 'Electrolab', NULL, current_date - 2, current_date - 9, NULL, 'claude-test-seed');
  PERFORM public.program_log_entry(v_prog, v_nut,  'returned_plating', 1000, 'TEST-52030', v_lot, NULL, NULL, 'Electrolab', NULL, NULL, current_date - 1, NULL, 'claude-test-seed');
  RAISE NOTICE 'seeded lot % — kiosk picker: %', v_r->>'lot_number',
    (SELECT jsonb_agg(jsonb_build_object('lot', lot_number, 'plating', plating_lot_number, 'left', remaining)) FROM public.program_plating_lots(v_prog));
END $$;
