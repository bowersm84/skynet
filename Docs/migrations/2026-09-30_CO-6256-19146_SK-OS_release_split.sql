/* ==========================================================================================
   CO-6256-19146 line 1 (SK-OS, 20,630 pcs) -> one CO line per Fishbowl line  (release split)
   Delivered 2026-09-30.  Run on TEST first (Claude ran it there), then PROD (Matt).

   WHY: fb_convert_to_co v3 (D-FB-26) grouped by part, so the five SK-OS release lines on
   Fishbowl SO 19146 (FB lines 2, 3, 4, 26, 27) landed on one CO line due 3/26/27. Demand
   therefore showed 20,630 pcs due 3/26/27 and hid the 6/30/27 and 12/31/27 releases.

   RESULT:  line  1  SK-OS  3,205  due 2027-03-26  <- FB line 2   (kept, quantity reduced)
            line 10  SK-OS  3,025  due 2027-06-30  <- FB line 3   (new)
            line 11  SK-OS 10,620  due 2027-12-31  <- FB line 4   (new)
            line 12  SK-OS  1,340  due 2027-06-30  <- FB line 26  (new)
            line 13  SK-OS  2,440  due 2027-12-31  <- FB line 27  (new)
            Sum unchanged: 20,630.  No allocations exist on line 1 (guarded), so nothing
            downstream moves.  fb_qty_* recomputed per line.  One audit_logs row.

   HOW TO RUN (three independent blocks; run ONE block at a time in the SQL editor):
     Block 1  PREVIEW   read-only, shows the pre-state the guards expect
     Block 2  SPLIT     v_dry_run := true performs the writes, prints the result and rolls
                        itself back with exception DRYRUN.  Set v_dry_run := false to apply.
     Block 3  VERIFY    read-only, expect 5 SK-OS lines summing to 20,630 and 5 FB links
   ========================================================================================== */

/* ---------------------------------- Block 1: PREVIEW --------------------------------- */
SELECT 'co_line' AS section, col.line_number, p.part_number, col.quantity_ordered, col.quantity_fulfilled,
       col.status, col.due_date::text AS due_date, col.components_needed,
       (SELECT COALESCE(SUM(a.quantity_allocated), 0) FROM customer_order_allocations a
         WHERE a.customer_order_line_id = col.id AND a.is_active) AS active_alloc,
       (SELECT MAX(line_number) FROM customer_order_lines x WHERE x.customer_order_id = co.id) AS max_line
  FROM customer_orders co
  JOIN customer_order_lines col ON col.customer_order_id = co.id
  JOIN parts p ON p.id = col.part_id
 WHERE co.co_number = 'CO-6256-19146' AND col.line_number = 1
UNION ALL
SELECT 'fb_line', l.line_number, l.product_num, l.qty_ordered::integer, l.qty_fulfilled::integer,
       l.disposition, l.effective_due_date::text, l.disposition_note, l.fb_soitem_id, NULL
  FROM fb_sales_order_lines l
  JOIN customer_order_lines col ON col.id = l.customer_order_line_id
  JOIN customer_orders co ON co.id = col.customer_order_id
 WHERE co.co_number = 'CO-6256-19146' AND col.line_number = 1 AND l.removed_at IS NULL
 ORDER BY 1, 2;

/* ----------------------------------- Block 2: SPLIT ---------------------------------- */
DO $$
DECLARE
  v_dry_run   boolean := true;   /* <- set false to apply */
  v_co_id     uuid;
  v_co_number text := 'CO-6256-19146';
  v_line_id   uuid;
  v_part_id   uuid;
  v_qty       integer;
  v_status    text;
  v_due       date;
  v_fulfilled integer;
  v_alloc     integer;
  v_max_line  integer;
  v_prio      text;
  v_comp      text;
  v_notes     text;
  v_fb        jsonb;
  v_expected  jsonb := '[{"id":109610,"ln":2,"qty":3205,"due":"2027-03-26"},
                         {"id":109611,"ln":3,"qty":3025,"due":"2027-06-30"},
                         {"id":109612,"ln":4,"qty":10620,"due":"2027-12-31"},
                         {"id":109634,"ln":26,"qty":1340,"due":"2027-06-30"},
                         {"id":109635,"ln":27,"qty":2440,"due":"2027-12-31"}]'::jsonb;
  r           record;
  v_next      integer;
  v_new_id    uuid;
  v_created   jsonb := '[]'::jsonb;
  v_has_comp  boolean := to_regclass('public.customer_order_line_components') IS NOT NULL;
  v_sum       integer;
BEGIN
  /* ---- guards: exact pre-state ---- */
  SELECT id INTO v_co_id FROM customer_orders WHERE co_number = v_co_number AND status <> 'cancelled';
  IF v_co_id IS NULL THEN RAISE EXCEPTION 'GUARD_CO: % not found or cancelled', v_co_number; END IF;

  SELECT col.id, col.part_id, col.quantity_ordered, col.quantity_fulfilled, col.status, col.due_date,
         col.priority, col.components_needed, col.notes
    INTO v_line_id, v_part_id, v_qty, v_fulfilled, v_status, v_due, v_prio, v_comp, v_notes
    FROM customer_order_lines col WHERE col.customer_order_id = v_co_id AND col.line_number = 1 FOR UPDATE;
  IF v_line_id IS NULL THEN RAISE EXCEPTION 'GUARD_LINE: line 1 not found'; END IF;
  IF (SELECT part_number FROM parts WHERE id = v_part_id) <> 'SK-OS' THEN RAISE EXCEPTION 'GUARD_PART: line 1 is not SK-OS'; END IF;
  IF v_qty <> 20630 OR v_fulfilled <> 0 OR v_status <> 'not_started' OR v_due <> DATE '2027-03-26' THEN
    RAISE EXCEPTION 'GUARD_STATE: line 1 is qty % fulfilled % status % due % (expected 20630 / 0 / not_started / 2027-03-26) - already split or moved', v_qty, v_fulfilled, v_status, v_due;
  END IF;
  SELECT COALESCE(SUM(quantity_allocated), 0) INTO v_alloc FROM customer_order_allocations WHERE customer_order_line_id = v_line_id AND is_active;
  IF v_alloc <> 0 THEN RAISE EXCEPTION 'GUARD_ALLOC: line 1 has % active allocated pcs; split by hand', v_alloc; END IF;
  SELECT MAX(line_number) INTO v_max_line FROM customer_order_lines WHERE customer_order_id = v_co_id;
  IF v_max_line <> 9 THEN RAISE EXCEPTION 'GUARD_MAXLINE: CO max line is % (expected 9)', v_max_line; END IF;

  SELECT jsonb_agg(jsonb_build_object('id', l.fb_soitem_id, 'ln', l.line_number, 'qty', l.qty_ordered::integer, 'due', l.effective_due_date::text) ORDER BY l.line_number)
    INTO v_fb
    FROM fb_sales_order_lines l
   WHERE l.customer_order_line_id = v_line_id AND l.removed_at IS NULL AND l.qty_fulfilled = 0 AND l.product_num = 'SK-OS';
  IF v_fb IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'GUARD_FBLINES: linked Fishbowl lines are % (expected %)', v_fb::text, v_expected::text;
  END IF;

  /* ---- writes ---- */
  UPDATE customer_order_lines
     SET quantity_ordered = 3205, due_date = DATE '2027-03-26',
         fb_qty_ordered = 3205, fb_qty_fulfilled = 0, fb_qty_to_fulfill = 3205,
         notes = concat_ws(E'\n', v_notes,
           'Release split 2026-09-30: was 20,630 pcs over Fishbowl lines 2, 3, 4, 26, 27 (D-FB-26 merge); now Fishbowl line 2 only. Lines 10-13 carry the other releases.')
   WHERE id = v_line_id;
  UPDATE fb_sales_order_lines
     SET disposition_note = 'Converted to ' || v_co_number || ' line 1 (release split 2026-09-30)'
   WHERE fb_soitem_id = 109610;

  v_next := v_max_line;
  FOR r IN SELECT (e->>'id')::integer AS id, (e->>'ln')::integer AS ln, (e->>'qty')::integer AS qty, (e->>'due')::date AS due
             FROM jsonb_array_elements(v_expected) e WHERE (e->>'id')::integer <> 109610 ORDER BY (e->>'ln')::integer
  LOOP
    v_next := v_next + 1;
    INSERT INTO customer_order_lines (customer_order_id, line_number, part_id, quantity_ordered, due_date, priority, notes, components_needed,
                                      status, fb_qty_ordered, fb_qty_fulfilled, fb_qty_to_fulfill)
    VALUES (v_co_id, v_next, v_part_id, r.qty, r.due, v_prio,
            'Fishbowl SO 19146 line ' || r.ln || ' - split from CO line 1 on 2026-09-30 (release split)',
            v_comp, 'not_started', r.qty, 0, r.qty)
    RETURNING id INTO v_new_id;
    UPDATE fb_sales_order_lines
       SET customer_order_line_id = v_new_id,
           disposition_note = 'Converted to ' || v_co_number || ' line ' || v_next || ' (release split 2026-09-30)'
     WHERE fb_soitem_id = r.id;
    IF v_has_comp THEN
      EXECUTE 'INSERT INTO customer_order_line_components (customer_order_line_id, component_id, created_by)
               SELECT $1, component_id, created_by FROM customer_order_line_components WHERE customer_order_line_id = $2
               ON CONFLICT DO NOTHING' USING v_new_id, v_line_id;
    END IF;
    v_created := v_created || jsonb_build_object('co_line', v_next, 'fb_line', r.ln, 'fb_soitem_id', r.id, 'qty', r.qty, 'due', r.due);
  END LOOP;

  INSERT INTO audit_logs (event_type, operator_id, details)
  VALUES ('co_line_release_split', auth.uid(),
          jsonb_build_object('co_number', v_co_number, 'part_number', 'SK-OS', 'from_line', 1, 'from_qty', 20630,
                             'line_1_now', 3205, 'new_lines', v_created, 'tag', 'SKOS-RELEASE-0930'));

  SELECT SUM(quantity_ordered) INTO v_sum FROM customer_order_lines WHERE customer_order_id = v_co_id AND part_id = v_part_id;
  IF v_sum <> 20630 THEN RAISE EXCEPTION 'POST_SUM: SK-OS lines sum to % (expected 20630)', v_sum; END IF;

  IF v_dry_run THEN
    RAISE EXCEPTION 'DRYRUN complete, rolled back. Would create: % ; line 1 -> 3205 ; SK-OS sum %', v_created::text, v_sum;
  END IF;
  RAISE NOTICE 'APPLIED: % ; line 1 -> 3205 ; SK-OS sum %', v_created::text, v_sum;
END $$;

/* ----------------------------------- Block 3: VERIFY --------------------------------- */
SELECT col.line_number, p.part_number, col.quantity_ordered, col.due_date::text AS due_date, col.status,
       col.fb_qty_ordered, col.fb_qty_to_fulfill,
       (SELECT string_agg(l.line_number::text, ',' ORDER BY l.line_number) FROM fb_sales_order_lines l WHERE l.customer_order_line_id = col.id AND l.removed_at IS NULL) AS fb_lines,
       SUM(col.quantity_ordered) OVER () AS sk_os_total
  FROM customer_orders co
  JOIN customer_order_lines col ON col.customer_order_id = co.id
  JOIN parts p ON p.id = col.part_id
 WHERE co.co_number = 'CO-6256-19146' AND p.part_number = 'SK-OS'
 ORDER BY col.line_number;
