/* =====================================================================================
   2026-10-15_PROD_giza_shipped_baseline.sql  --  PROD, Matt. One-shot data correction.

   "Assembled & bagged - awaiting ship" shows -4,483. The tracker's shipped baseline was set
   to 10,251 (Fishbowl's shipped total when the tracker started). The 10/12 shipment (4,483,
   now historical lot 3005-2) synced in afterwards and counted as shipped-since-tracking,
   although SkyNet never assembled it. The baseline becomes 14,734: every piece shipped
   under the historical lots 3001-3005-2, which is exactly Fishbowl's shipped total today.

   Absolute value, guarded: runs only while Fishbowl's shipped total and the historical
   register both equal 14,734. Rehearsed on scratch with PROD's numbers (TEST's Fishbowl
   mirror is older and still shows 10,251 shipped, so the guard stops it there by design).
   ===================================================================================== */


/* ===================================== BLOCK 1 =====================================
   PREVIEW. PROD expect: fulfilled 14734, historical_total 14734, baseline 10251,
   shipped_since_start 4483, waiting_ship -4483.
   ================================================================================== */
SELECT jsonb_build_object(
  'fulfilled', (SELECT fulfilled FROM public.v_program_pipeline),
  'historical_total', (SELECT sum(quantity) FROM public.program_final_lots WHERE status = 'historical'),
  'baseline', (SELECT shipped_baseline FROM public.programs WHERE code = 'GIZA-21077'),
  'shipped_since_start', (SELECT shipped_since_start FROM public.v_program_pipeline),
  'waiting_ship', (SELECT waiting_ship FROM public.v_program_pipeline)
) AS preview;


/* ===================================== BLOCK 2 =====================================
   SET THE BASELINE TO 14,734.
   ================================================================================== */
DO $$
DECLARE v_prog uuid; v_old numeric; v_ful numeric; v_hist numeric;
BEGIN
  SELECT id, shipped_baseline INTO v_prog, v_old FROM public.programs WHERE code = 'GIZA-21077';
  SELECT fulfilled INTO v_ful FROM public.v_program_pipeline WHERE program_id = v_prog;
  SELECT sum(quantity) INTO v_hist FROM public.program_final_lots WHERE program_id = v_prog AND status = 'historical';
  IF v_old = 14734 THEN RAISE NOTICE 'baseline already 14,734; nothing to do'; RETURN; END IF;
  IF v_ful <> 14734 OR v_hist <> 14734 THEN
    RAISE EXCEPTION 'GUARD: expected Fishbowl shipped and the historical register both at 14,734 (found % and %)', v_ful, v_hist;
  END IF;
  UPDATE public.programs SET shipped_baseline = 14734 WHERE id = v_prog;
  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('program_baseline_corrected', auth.uid(), jsonb_build_object('program', 'GIZA-21077', 'from', v_old, 'to', 14734,
          'reason', 'The 10/12 shipment (historical 3005-2, 4,483) was assembled before tracking; baseline = historical lots 3001-3005-2'));
  RAISE NOTICE 'shipped baseline % -> 14,734', v_old;
END $$;


/* ===================================== BLOCK 3 =====================================
   VERIFY. PROD expect: baseline 14734, shipped_since_start 0, waiting_ship 0, open 130286.
   ================================================================================== */
SELECT jsonb_build_object(
  'baseline', (SELECT shipped_baseline FROM public.programs WHERE code = 'GIZA-21077'),
  'shipped_since_start', (SELECT shipped_since_start FROM public.v_program_pipeline),
  'waiting_ship', (SELECT waiting_ship FROM public.v_program_pipeline),
  'open', (SELECT open_qty FROM public.v_program_pipeline)
) AS verify;
