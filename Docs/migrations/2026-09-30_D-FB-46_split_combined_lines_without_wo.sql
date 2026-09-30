/* ==========================================================================================
   D-FB-46  -  Split every combined CO line that has no work order yet: one CO line per Fishbowl line
   Delivered 2026-09-30.  Requires D-FB-42 and D-FB-45 Block 1 (uses _co_sync_line_numbers).
   TEST: function installed by Claude; nothing to split on TEST (SK-OS was done by hand, SO 19325
   is not in TEST's copy).  PROD: run by Matt.

   WHY: Matt, 2026-09-30 - "fix anything that does not have a WO at this point and forward, like the
   SK-OS." Under D-FB-26 several Fishbowl lines were combined into one CO line; D-FB-43 stopped that
   for new conversions. This splits the combined lines that are still free to split - no active
   allocation, nothing fulfilled - and leaves the ones already on a work order alone.

   PROD today (read 2026-09-30):
     split   CO-6256-19146 #1  SK-OS      20,630 = FB 2 (3,205) + 3 (3,025) + 4 (10,620) + 26 (1,340) + 27 (2,440)
             CO-687-19325  #1  SK2600-3W     100 = FB 2 (50) + FB 3 (50), both due 12/23/26
     keep    CO-2311-19121 #1 SK215-4D (WO-2609-0027) · CO-6256-19146 #4 SK4002-12S (WO-2609-0048),
             #6 SK4002-7 (WO-2609-0055), #8 SK4002-6W (WO-2609-0053)
   This supersedes 2026-09-30_CO-6256-19146_SK-OS_release_split.sql for PROD - do NOT run that file
   on PROD; this one does SK-OS and SK2600-3W in one pass with the same result. (It stays in
   Docs/migrations as the record of what ran on TEST.)

   RULE per combined line: it must be open, have no active allocation, nothing fulfilled, every linked
   Fishbowl line open with something left, and its quantity must equal the sum of what those lines
   have left - otherwise it is reported as skipped with the reason and not touched. The existing CO
   line keeps the lowest Fishbowl line (quantity, due date and fb_qty_* set to that line's); every
   other Fishbowl line gets a new CO line with its own quantity and due date, the same priority,
   note and Components Needed; the Fishbowl lines are relinked; then D-FB-45 sets every line on the
   CO to its Fishbowl number. One audit row per split (co_line_release_split, tag D-FB-46).

   HOW TO RUN - four independent blocks, one at a time:
     Block 1  FUNCTION  co_split_combined_lines(p_dry_run)
     Block 2  DRY RUN   paste the result to Claude before Block 3
     Block 3  LIVE
     Block 4  VERIFY    expect splittable = 0 and combined_with_wo = 4 on PROD
   ========================================================================================== */

/* ================================= Block 1: FUNCTION ================================== */
CREATE OR REPLACE FUNCTION public.co_split_combined_lines(p_dry_run boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_split    jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_into     jsonb;
  v_reason   text;
  v_alloc    integer;
  v_wos      text;
  v_next     integer;
  v_new_id   uuid;
  v_first    boolean;
  v_cos      uuid[] := ARRAY[]::uuid[];
  v_fb_ids   integer[] := ARRAY[]::integer[];
  v_co       uuid;
  c          record;
  f          record;
  s          jsonb;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin']);
  BEGIN
    FOR c IN
      SELECT col.id, col.customer_order_id, co.co_number, co.fishbowl_order_id, col.line_number, col.part_id, p.part_number::text AS part_number,
             col.status, col.quantity_ordered, col.quantity_fulfilled, col.priority, col.notes, col.components_needed,
             count(*) AS fb_n,
             sum(round(GREATEST(l.qty_ordered - l.qty_fulfilled, 0)))::integer AS fb_remaining,
             bool_or(l.status_id IN (50, 60, 70, 75, 95) OR round(GREATEST(l.qty_ordered - l.qty_fulfilled, 0)) <= 0) AS any_closed
        FROM public.customer_order_lines col
        JOIN public.customer_orders co ON co.id = col.customer_order_id
        JOIN public.parts p ON p.id = col.part_id
        JOIN public.fb_sales_order_lines l ON l.customer_order_line_id = col.id AND l.removed_at IS NULL
       GROUP BY col.id, co.co_number, co.fishbowl_order_id, p.part_number
      HAVING count(*) > 1
       ORDER BY co.co_number, col.line_number
    LOOP
      SELECT COALESCE(sum(a.quantity_allocated), 0), string_agg(DISTINCT w.wo_number, ', ')
        INTO v_alloc, v_wos
        FROM public.customer_order_allocations a JOIN public.work_orders w ON w.id = a.work_order_id
       WHERE a.customer_order_line_id = c.id AND a.is_active;

      v_reason := CASE
        WHEN c.status NOT IN ('not_started', 'in_progress') THEN 'line is ' || c.status
        WHEN v_alloc > 0 THEN 'on a work order (' || v_wos || ') - left combined'
        WHEN c.quantity_fulfilled > 0 THEN c.quantity_fulfilled || ' already fulfilled - split by hand'
        WHEN c.any_closed THEN 'a linked Fishbowl line is closed or fully shipped - split by hand'
        WHEN c.quantity_ordered <> c.fb_remaining THEN 'CO quantity ' || c.quantity_ordered || ' differs from Fishbowl remaining ' || c.fb_remaining || ' - split by hand'
        ELSE NULL END;
      IF v_reason IS NOT NULL THEN
        v_skipped := v_skipped || jsonb_build_object('co_number', c.co_number, 'line', c.line_number, 'part', c.part_number,
                       'qty', c.quantity_ordered, 'reason', v_reason);
        CONTINUE;
      END IF;

      PERFORM 1 FROM public.customer_order_lines WHERE id = c.id FOR UPDATE;
      SELECT COALESCE(max(line_number), 0) INTO v_next FROM public.customer_order_lines WHERE customer_order_id = c.customer_order_id;
      v_into := '[]'::jsonb;
      v_first := true;
      FOR f IN
        SELECT l.fb_soitem_id, l.line_number, l.effective_due_date, l.qty_ordered, l.qty_fulfilled, l.qty_to_fulfill,
               round(GREATEST(l.qty_ordered - l.qty_fulfilled, 0))::integer AS rem
          FROM public.fb_sales_order_lines l
         WHERE l.customer_order_line_id = c.id AND l.removed_at IS NULL
         ORDER BY l.line_number
      LOOP
        v_fb_ids := v_fb_ids || f.fb_soitem_id;
        IF v_first THEN
          UPDATE public.customer_order_lines
             SET quantity_ordered = f.rem, due_date = f.effective_due_date,
                 fb_qty_ordered = f.qty_ordered, fb_qty_fulfilled = f.qty_fulfilled, fb_qty_to_fulfill = f.qty_to_fulfill,
                 notes = concat_ws(E'\n', c.notes, 'Split ' || to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')
                   || ' (D-FB-46): was ' || c.quantity_ordered || ' pcs over ' || c.fb_n || ' Fishbowl lines; now Fishbowl line ' || f.line_number || ' only.')
           WHERE id = c.id;
          v_into := v_into || jsonb_build_object('fb_line', f.line_number, 'qty', f.rem, 'due', f.effective_due_date, 'kept', true);
          v_first := false;
        ELSE
          v_next := v_next + 1;
          INSERT INTO public.customer_order_lines (customer_order_id, line_number, part_id, quantity_ordered, due_date, priority,
                                                   notes, components_needed, status, fb_qty_ordered, fb_qty_fulfilled, fb_qty_to_fulfill)
          VALUES (c.customer_order_id, v_next, c.part_id, f.rem, f.effective_due_date, c.priority,
                  'Fishbowl SO ' || c.fishbowl_order_id || ' line ' || f.line_number || ' - split from CO line ' || c.line_number
                    || ' on ' || to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') || ' (D-FB-46)',
                  c.components_needed, 'not_started', f.qty_ordered, f.qty_fulfilled, f.qty_to_fulfill)
          RETURNING id INTO v_new_id;
          INSERT INTO public.customer_order_line_components (customer_order_line_id, component_id, created_by)
          SELECT v_new_id, x.component_id, x.created_by FROM public.customer_order_line_components x WHERE x.customer_order_line_id = c.id
          ON CONFLICT DO NOTHING;
          UPDATE public.fb_sales_order_lines SET customer_order_line_id = v_new_id WHERE fb_soitem_id = f.fb_soitem_id;
          v_into := v_into || jsonb_build_object('fb_line', f.line_number, 'qty', f.rem, 'due', f.effective_due_date, 'kept', false);
        END IF;
      END LOOP;

      INSERT INTO public.audit_logs (event_type, operator_id, details)
      VALUES ('co_line_release_split', auth.uid(), jsonb_build_object('co_number', c.co_number, 'part_number', c.part_number,
              'from_line', c.line_number, 'from_qty', c.quantity_ordered, 'into', v_into, 'tag', 'D-FB-46'));
      v_split := v_split || jsonb_build_object('co_number', c.co_number, 'part', c.part_number, 'line', c.line_number,
                   'qty', c.quantity_ordered, 'into', v_into);
      IF NOT (c.customer_order_id = ANY (v_cos)) THEN v_cos := v_cos || c.customer_order_id; END IF;
    END LOOP;

    /* D-FB-45: every line on the touched COs takes its Fishbowl number; the split Fishbowl lines' notes
       then name their final CO line */
    FOREACH v_co IN ARRAY v_cos LOOP
      PERFORM public._co_sync_line_numbers(v_co);
    END LOOP;
    UPDATE public.fb_sales_order_lines l
       SET disposition_note = 'Converted to ' || co.co_number || ' line ' || col.line_number || ' (split D-FB-46)'
      FROM public.customer_order_lines col JOIN public.customer_orders co ON co.id = col.customer_order_id
     WHERE l.customer_order_line_id = col.id AND l.fb_soitem_id = ANY (v_fb_ids);
    /* final CO line numbers into the report */
    SELECT COALESCE(jsonb_agg(sp || jsonb_build_object('into',
             (SELECT jsonb_agg(i || jsonb_build_object('co_line',
                 (SELECT col.line_number FROM public.fb_sales_order_lines l JOIN public.customer_order_lines col ON col.id = l.customer_order_line_id
                    JOIN public.customer_orders co ON co.id = col.customer_order_id
                   WHERE co.co_number = sp->>'co_number' AND l.line_number = (i->>'fb_line')::integer AND l.removed_at IS NULL LIMIT 1)))
                FROM jsonb_array_elements(sp->'into') i))), '[]'::jsonb)
      INTO v_split FROM jsonb_array_elements(v_split) sp;

    IF p_dry_run THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'D-FB-46 DRYRUN';
    END IF;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'D-FB-46 DRYRUN' THEN RAISE; END IF;
  END;
  RETURN jsonb_build_object('dry_run', p_dry_run, 'lines_split', jsonb_array_length(v_split),
                            'split', v_split, 'skipped', v_skipped);
END;
$function$;
REVOKE ALL ON FUNCTION public.co_split_combined_lines(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.co_split_combined_lines(boolean) TO authenticated;

/* ================================== Block 2: DRY RUN ================================== */
SELECT public.co_split_combined_lines(true) AS dry_run;

/* =================================== Block 3: LIVE ==================================== */
SELECT public.co_split_combined_lines(false) AS applied;

/* ================================== Block 4: VERIFY =================================== */
WITH m AS (
  SELECT col.id, count(*) AS fb_n,
         (SELECT COALESCE(sum(a.quantity_allocated), 0) FROM public.customer_order_allocations a
           WHERE a.customer_order_line_id = col.id AND a.is_active) AS alloc
    FROM public.customer_order_lines col
    JOIN public.fb_sales_order_lines l ON l.customer_order_line_id = col.id AND l.removed_at IS NULL
   WHERE col.status IN ('not_started', 'in_progress')
   GROUP BY col.id HAVING count(*) > 1)
SELECT jsonb_build_object(
  'splittable',       (SELECT count(*) FROM m WHERE alloc = 0),
  'combined_with_wo', (SELECT count(*) FROM m WHERE alloc > 0),
  'line_numbers_mismatched', (SELECT count(*) FROM (SELECT col.line_number, min(l.line_number) AS fb_ln
                                  FROM public.customer_order_lines col JOIN public.fb_sales_order_lines l ON l.customer_order_line_id = col.id AND l.removed_at IS NULL
                                 GROUP BY col.id) x WHERE line_number <> fb_ln),
  'split_audits',     (SELECT count(*) FROM public.audit_logs WHERE event_type = 'co_line_release_split' AND details->>'tag' = 'D-FB-46')
) AS verify;
