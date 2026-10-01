/* ==========================================================================================
   D-FB-50  -  Retire the "Covered by existing CO" disposition
   Delivered 2026-10-01.  TEST: applied by Claude.  PROD: run by Matt BEFORE pushing the code.

   WHY: Matt, 2026-10-01 - "remove this option ... they should create new COs if production is
   needed." Since D-FB-43 every Fishbowl line becomes its own CO line and like parts are combined at
   Create WO, so a line that needs production is converted, never marked as covered by some other
   CO. A covered line is linked to no CO line, so its quantity never reached Demand or Prod Due.

   WHAT: fb_set_disposition refuses 'covered' with a message that says what to do instead, and
   'covered' leaves its allowed list. Nothing else changes: the CHECK constraint, the queue view's
   covered count and the badge stay, because 46 open PROD lines (48 on TEST) still carry the old
   value - they keep it until someone sends them Back to pending and converts them.

   Patched in place by two single-line anchors that must each occur once. No md5 guard: PROD's
   copy of this function has CRLF line endings and TEST's has LF (each was installed from a
   different copy of the D-FB-42 file), so their fingerprints differ while the code is the same.
   Re-running is a no-op (marker D-FB-50).

   HOW TO RUN - two independent blocks:
     Block 1  PATCH
     Block 2  VERIFY   expect marker true, covered_allowed false
   ========================================================================================== */

/* =================================== Block 1: PATCH ==================================== */
DO $patch$
DECLARE
  v_def  text := pg_get_functiondef('public.fb_set_disposition(integer[], text, text, jsonb)'::regprocedure);
  v_list text := 'NOT IN (''pending'', ''stock'', ''purchased'', ''covered'', ''assembly'', ''ignore'')';
  v_gate text := 'PERFORM public._fb_gate(ARRAY[''order_processor'', ''admin'']);';
  v_n1   integer;
  v_n2   integer;
BEGIN
  IF position('D-FB-50' in v_def) > 0 THEN
    RAISE NOTICE 'fb_set_disposition already carries D-FB-50 - skipped';
    RETURN;
  END IF;
  v_n1 := (length(v_def) - length(replace(v_def, v_list, ''))) / length(v_list);
  v_n2 := (length(v_def) - length(replace(v_def, v_gate, ''))) / length(v_gate);
  IF v_n1 <> 1 OR v_n2 <> 1 THEN
    RAISE EXCEPTION 'GUARD_ANCHOR: allowed-list anchor found % times, gate anchor % times (expected 1 and 1) - stop and tell Claude', v_n1, v_n2;
  END IF;
  v_def := replace(v_def, v_list, 'NOT IN (''pending'', ''stock'', ''purchased'', ''assembly'', ''ignore'')');
  v_def := replace(v_def, v_gate, v_gate || chr(10)
    || '  /* D-FB-50: retired - production goes through Create CO; like parts are combined at Create WO */' || chr(10)
    || '  IF p_disposition = ''covered'' THEN' || chr(10)
    || '    RAISE EXCEPTION ''"Covered by existing CO" is retired (D-FB-50): convert the line with Create CO - like parts are combined at Create WO''' || chr(10)
    || '      USING ERRCODE = ''22023'';' || chr(10)
    || '  END IF;');
  EXECUTE v_def;
  RAISE NOTICE 'fb_set_disposition patched (D-FB-50)';
END
$patch$;

/* =================================== Block 2: VERIFY =================================== */
SELECT jsonb_build_object(
  'marker',          position('D-FB-50' in pg_get_functiondef('public.fb_set_disposition(integer[], text, text, jsonb)'::regprocedure)) > 0,
  'covered_allowed', position('''purchased'', ''covered''' in pg_get_functiondef('public.fb_set_disposition(integer[], text, text, jsonb)'::regprocedure)) > 0,
  'anon_exec',       has_function_privilege('anon', 'public.fb_set_disposition(integer[], text, text, jsonb)', 'EXECUTE'),
  'legacy_covered_open_lines', (SELECT count(*) FROM public.fb_sales_order_lines l JOIN public.fb_sales_orders s ON s.fb_so_id = l.fb_so_id
                                 WHERE l.disposition = 'covered' AND l.removed_at IS NULL AND s.status_id IN (20, 25)
                                   AND l.status_id NOT IN (50, 60, 70, 75, 95))
) AS verify;
