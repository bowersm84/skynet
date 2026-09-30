/* ==========================================================================================
   TEST ONLY - seeds three Fishbowl exceptions so the D-FB-48 Exceptions-tab buttons can be clicked
   Delivered and run on TEST (ylzmyjjqibpbqbwjsnqj) by Claude 2026-09-30.  NEVER run on PROD.
   Events carry fb_username 'claude-test-seed'. A TEST bridge run from Matt's PC will restore the
   two Fishbowl lines this touches (removed_at / product_num) from Fishbowl itself.

     E1  SO 15019 line 2  SK220-2S    qty 5,000 -> 4,000, CO-1081-15019 #2 fully allocated on
                                      WO-2609-0006  -> "Apply Fishbowl qty" refused until the WO
                                      allocation is cut to 4,000 in Edit WO, then applies
     E2  SO 19276 line 4  SK213-26D   line removed, CO-1713-19276 #4 (46 pcs, no WO)
                                      -> "Cancel CO line"
     E3  SO 18136 line 2  SK26S51-20 -> SK26S51-1 (product changed), CO-1187-18136 #2 on
                                      WO-2608-0015 -> "Cancel CO line": allocation released, WO
                                      flagged, the Fishbowl line back in the Queue as SK26S51-1
   ========================================================================================== */
DO $seed$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fb_sync_events WHERE fb_username = 'claude-test-seed') THEN
    RAISE NOTICE 'already seeded'; RETURN;
  END IF;
  UPDATE public.fb_sales_order_lines SET removed_at = now() WHERE fb_soitem_id = 110325 AND removed_at IS NULL;
  UPDATE public.fb_sales_order_lines SET product_num = 'SK26S51-1', part_num = 'SK26S51-1' WHERE fb_soitem_id = 103679;
  INSERT INTO public.fb_sync_events (fb_so_id, fb_soitem_id, event_type, changes, fb_username, fb_timestamp, affects_co, requires_ack) VALUES
    (9426,  87171,  'line_changed', '{"qty_ordered": {"old": 5000, "new": 4000}}', 'claude-test-seed', now(), true, true),
    (11896, 110325, 'line_removed', '{"product_num": "SK213-26D", "qty_ordered": 46}', 'claude-test-seed', now(), true, true),
    (11211, 103679, 'line_changed', '{"product_num": {"old": "SK26S51-20", "new": "SK26S51-1"}}', 'claude-test-seed', now(), true, true);
END
$seed$;
SELECT id, so_number, line_number, event_type, changes, co_number, co_line_number, co_line_status
  FROM public.v_fb_recent_changes WHERE requires_ack AND acknowledged_at IS NULL ORDER BY id;
