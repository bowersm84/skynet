/* =====================================================================================
   2026-10-13_TEST_ONLY_giza_seed_chain.sql  --  TEST ONLY. NEVER RUN ON PROD.

   Seeds one steel-nut lot through the ledger to returned_plating so the Finishing
   kiosk's Dry Film picker has a plating lot to choose (Batch A review), plus component
   receipts so the dashboard (Batch B) has stock to show. Every row is labelled
   claude-test-seed in notes; BLOCK 2 voids them again.

   Lots:  nut TEST-51999 (1,000)  ->  plating TEST-52030 (1,000)
          cage TEST-51889 (2,000), retainer TEST-51873 (2,000), insert TEST-51853 (1,500)
   Applied to TEST by Claude on 2026-10-12 (BLOCK 1). Run BLOCK 2 to clean up.
   ===================================================================================== */

/* ===================================== BLOCK 1 ===================================== */
DO $$
DECLARE v_prog uuid; v_nut uuid; v_cage uuid; v_ret uuid; v_ins uuid;
BEGIN
  SELECT id INTO v_prog FROM public.programs WHERE code = 'GIZA-21077';
  SELECT part_id INTO v_nut  FROM public.program_parts WHERE program_id = v_prog AND role = 'nut';
  SELECT part_id INTO v_cage FROM public.program_parts WHERE program_id = v_prog AND role = 'cage';
  SELECT part_id INTO v_ret  FROM public.program_parts WHERE program_id = v_prog AND role = 'retainer';
  SELECT part_id INTO v_ins  FROM public.program_parts WHERE program_id = v_prog AND role = 'insert';
  IF v_prog IS NULL OR v_nut IS NULL THEN RAISE EXCEPTION 'GUARD: GIZA-21077 program not seeded'; END IF;
  IF EXISTS (SELECT 1 FROM public.program_ledger WHERE program_id = v_prog AND notes = 'claude-test-seed' AND voided_at IS NULL) THEN
    RAISE EXCEPTION 'GUARD: seed rows already present (not voided); run BLOCK 2 first';
  END IF;

  PERFORM public.program_log_entry(v_prog, v_nut,  'received',         1000, 'TEST-51999', NULL, 'Xiamen',    'TEST-PO-1', NULL, current_date - 12, NULL, NULL, 'claude-test-seed');
  PERFORM public.program_log_entry(v_prog, v_cage, 'received',         2000, 'TEST-51889', NULL, 'Xiamen',    'TEST-PO-1', NULL, current_date - 12, NULL, NULL, 'claude-test-seed');
  PERFORM public.program_log_entry(v_prog, v_ret,  'received',         2000, 'TEST-51873', NULL, 'Maxtrust',  'TEST-PO-2', NULL, current_date - 12, NULL, NULL, 'claude-test-seed');
  PERFORM public.program_log_entry(v_prog, v_ins,  'received',         1500, 'TEST-51853', NULL, 'Maxtrust',  'TEST-PO-2', NULL, current_date - 12, NULL, NULL, 'claude-test-seed');
  PERFORM public.program_log_entry(v_prog, v_nut,  'washer_inserted',  1000, 'TEST-51999', NULL, NULL,        NULL,        NULL, current_date - 10, NULL, 'TEST', 'claude-test-seed');
  PERFORM public.program_log_entry(v_prog, v_nut,  'sent_plating',     1000, 'TEST-51999', NULL, 'Electrolab', NULL,       current_date - 2, current_date - 9, NULL, NULL, 'claude-test-seed');
  PERFORM public.program_log_entry(v_prog, v_nut,  'returned_plating', 1000, 'TEST-52030', 'TEST-51999', 'Electrolab', NULL, NULL, current_date - 1, NULL, NULL, 'claude-test-seed');
  RAISE NOTICE 'seeded: plating lot TEST-52030 remaining = %', (SELECT remaining FROM public.program_plating_lots(v_prog) WHERE plating_lot_number = 'TEST-52030');
END $$;

/* ===================================== BLOCK 2 =====================================
   CLEANUP: void every seed row (soft; the ledger never hard-deletes).
   ================================================================================== */
DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT id FROM public.program_ledger WHERE notes = 'claude-test-seed' AND voided_at IS NULL LOOP
    PERFORM public.program_void_entry(r.id, 'TEST seed cleanup');
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'voided % seed rows', n;
END $$;
