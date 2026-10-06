/* ============================================================================================
   DIAG S13 Batch A - read-only acceptance check (one statement, labelled jsonb sections)
   Run in the Supabase SQL Editor after bridge 1.8.0 has completed `npm run mirror:valuation` and at
   least one real inventory cycle. Paste the JSON back to Claude.

   BASELINE (TEST, 2026-10-07 before the bridge run): valuation_rows 3 (hand-seeded test rows),
     inventory_rows 1318, reorder: ok 44 / below 4 / no_min 2 / no_row 5 (TEST mirror is a Sept 28 copy).
   ACCEPTANCE after the real run:
     A1  valuation.rows about 11,000 (every typeId-10 part); valuation.removed_live = 0 right after a run.
     A2  valuation.by_class shows Product about 1,655 WITH stock (product_with_stock) - the Oct 6 export had 1,655.
     A3  coverage.product_without_inventory_row = 0 (every Product-class part has a 5-minute row).
     A4  reorder.states: no_row = 0 (SK4000-2 may stay no_row only if Fishbowl truly lacks the number); below = 1
         on PROD (SK2600CGP174) - more on TEST because its mirror is stale.
     A5  parity.mismatches = 0 (SUM(tag.qty) nightly vs qtyinventorytotals 5-minute, Product parts, same night).
         A non-zero count with a sample list is NOT a failure - it is the list Claude reviews before Batch C.
     A6  notifications.reorder_below_min >= 1 and no duplicates per part (crossing-only).
     A7  unclassified.product_like = parts with has_product true and class '(unclassified)' - the QA list for Matt.
   ============================================================================================ */
SELECT jsonb_build_object(
  'run_at', now(),
  'clocks', (SELECT jsonb_build_object('last_inventory_at', last_inventory_at, 'last_valuation_at', last_valuation_at,
                                       'last_products_at', last_products_at, 'bridge_version', bridge_version, 'bridge_host', bridge_host)
               FROM public.fb_sync_state WHERE id = 1),

  'valuation', (SELECT jsonb_build_object(
      'rows', count(*),
      'removed_live', count(*) FILTER (WHERE removed_at IS NOT NULL),
      'by_class', (SELECT jsonb_object_agg(valuation_class, n) FROM (
                     SELECT valuation_class, count(*) n FROM public.fb_part_valuation WHERE removed_at IS NULL GROUP BY 1) c),
      'product_with_stock', count(*) FILTER (WHERE removed_at IS NULL AND valuation_class = 'Product' AND qty_on_hand <> 0),
      'product_value_est', round(sum(qty_on_hand * COALESCE(avg_cost, 0)) FILTER (WHERE removed_at IS NULL AND valuation_class = 'Product')::numeric, 2),
      'product_zero_cost_with_stock', count(*) FILTER (WHERE removed_at IS NULL AND valuation_class = 'Product' AND qty_on_hand <> 0 AND COALESCE(avg_cost, 0) = 0),
      'oldest_synced_at', min(synced_at) FILTER (WHERE removed_at IS NULL),
      'newest_synced_at', max(synced_at) FILTER (WHERE removed_at IS NULL))
     FROM public.fb_part_valuation),

  'coverage', (SELECT jsonb_build_object(
      'inventory_rows', (SELECT count(*) FROM public.fb_part_inventory),
      'inventory_zero_rows', (SELECT count(*) FROM public.fb_part_inventory WHERE COALESCE(by_location, '{}'::jsonb) = '{}'::jsonb),
      'inventory_stale_rows', (SELECT count(*) FROM public.fb_part_inventory i, public.fb_sync_state s
                                WHERE s.id = 1 AND i.snapshot_at < s.last_inventory_at - interval '10 minutes'),
      'product_without_inventory_row', (SELECT count(*) FROM public.fb_part_valuation v
                                         LEFT JOIN public.fb_part_inventory i ON upper(btrim(i.part_num)) = v.part_key
                                        WHERE v.removed_at IS NULL AND v.valuation_class = 'Product' AND i.part_num IS NULL),
      'product_without_row_sample', (SELECT jsonb_agg(part_num ORDER BY part_num) FROM (
                                        SELECT v.part_num FROM public.fb_part_valuation v
                                          LEFT JOIN public.fb_part_inventory i ON upper(btrim(i.part_num)) = v.part_key
                                         WHERE v.removed_at IS NULL AND v.valuation_class = 'Product' AND i.part_num IS NULL
                                         ORDER BY v.part_num LIMIT 25) x),
      'reorder_without_inventory_row', (SELECT jsonb_agg(rp.part_num ORDER BY rp.part_num) FROM public.fb_reorder_points rp
                                         LEFT JOIN public.fb_part_inventory i ON upper(btrim(i.part_num)) = rp.part_key
                                        WHERE i.part_num IS NULL))),

  'reorder', (SELECT jsonb_build_object(
      'rules', count(*),
      'states', (SELECT jsonb_object_agg(alert_state, n) FROM (SELECT alert_state, count(*) n FROM public.fb_reorder_points GROUP BY 1) s),
      'below', (SELECT jsonb_agg(jsonb_build_object('part', rp.part_num, 'min', rp.min_qty, 'on_hand', i.qty_on_hand, 'on_order', i.qty_on_order) ORDER BY rp.part_num)
                  FROM public.fb_reorder_points rp LEFT JOIN public.fb_part_inventory i ON upper(btrim(i.part_num)) = rp.part_key
                 WHERE rp.alert_state = 'below'),
      'no_row', (SELECT jsonb_agg(part_num ORDER BY part_num) FROM public.fb_reorder_points WHERE alert_state = 'no_row'),
      'no_min', (SELECT jsonb_agg(part_num ORDER BY part_num) FROM public.fb_reorder_points WHERE alert_state = 'no_min'))
     FROM public.fb_reorder_points),

  'parity', (SELECT jsonb_build_object(
      'compared', count(*),
      'mismatches', count(*) FILTER (WHERE abs(COALESCE(i.qty_on_hand, 0) - v.qty_on_hand) > 0.001),
      'sample', (SELECT jsonb_agg(jsonb_build_object('part', part_num, 'nightly_tag_qty', nq, 'five_min_qty', iq) ORDER BY abs(nq - iq) DESC) FROM (
                   SELECT v2.part_num, v2.qty_on_hand nq, COALESCE(i2.qty_on_hand, 0) iq
                     FROM public.fb_part_valuation v2 JOIN public.fb_part_inventory i2 ON upper(btrim(i2.part_num)) = v2.part_key
                    WHERE v2.removed_at IS NULL AND v2.valuation_class = 'Product'
                      AND abs(COALESCE(i2.qty_on_hand, 0) - v2.qty_on_hand) > 0.001
                    ORDER BY abs(COALESCE(i2.qty_on_hand, 0) - v2.qty_on_hand) DESC LIMIT 20) m),
      'note', 'a mismatch is expected for parts that moved between the 02:10 valuation read and the latest 5-minute cycle; compare snapshot times')
     FROM public.fb_part_valuation v JOIN public.fb_part_inventory i ON upper(btrim(i.part_num)) = v.part_key
    WHERE v.removed_at IS NULL AND v.valuation_class = 'Product'),

  'notifications', (SELECT jsonb_build_object(
      'reorder_below_min', count(*),
      'distinct_parts', count(DISTINCT payload->>'part_num'),
      'recipients', count(DISTINCT recipient_id),
      'latest', max(created_at),
      'duplicates_per_part_recipient', (SELECT count(*) FROM (
          SELECT recipient_id, payload->>'part_num' p, count(*) c FROM public.user_notifications
           WHERE type = 'reorder_below_min' GROUP BY 1, 2 HAVING count(*) > 1) d))
     FROM public.user_notifications WHERE type = 'reorder_below_min'),

  'unclassified', (SELECT jsonb_build_object(
      'product_like', count(*),
      'sample', (SELECT jsonb_agg(part_num ORDER BY qty_on_hand DESC) FROM (
                   SELECT part_num, qty_on_hand FROM public.fb_part_valuation
                    WHERE removed_at IS NULL AND has_product AND valuation_class = '(unclassified)' AND qty_on_hand <> 0
                    ORDER BY qty_on_hand DESC LIMIT 25) u))
     FROM public.fb_part_valuation WHERE removed_at IS NULL AND has_product AND valuation_class = '(unclassified)' AND qty_on_hand <> 0),

  'registry', (SELECT jsonb_agg(jsonb_build_object('slug', slug, 'rows', CASE slug WHEN 'fb-stock-on-hand' THEN (SELECT count(*) FROM public.v_report_fb_stock_on_hand)
                                                                                      ELSE (SELECT count(*) FROM public.v_report_fb_reorder_status) END) ORDER BY sort_order)
                 FROM public.reports WHERE slug IN ('fb-stock-on-hand', 'fb-reorder-status'))
) AS diag_s13_a;
