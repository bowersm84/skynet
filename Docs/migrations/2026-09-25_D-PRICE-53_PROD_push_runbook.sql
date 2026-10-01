/* ============================================================================================
   2026-09-25_D-PRICE-53_PROD_push_runbook.sql   (D-PRICE-53, skyserver bridge 1.7.0)
   PROD SQL Editor. Highlight ONE block and run it, only at the deploy-runbook step that names it.
   Every block is a single statement. Claude checks each result read-only on PROD.
   BLOCKS 1-2 queue real pushes: they need FB_PUSH_ENABLED=true on skyserver (deploy runbook 2.2).
   ============================================================================================ */

/* BLOCK 1 -- smoke push (deploy runbook 2.3). One product, $0.00 in Fishbowl today -> $30.61.
   Returns the command id. Within 20 s the bridge log shows: push #<id> prices: Product 1 row(s) -> 200 */
SELECT public.fb_push_enqueue('prices', NULL, '{"only_changed": false, "only_products": ["ZG2600-21B"]}'::jsonb, false,
                              'PROD smoke push: ZG2600-21B (D-PRICE-53)') AS command_id;

/* BLOCK 2 -- Rev 81 prices push (deploy runbook 3.2). Only AFTER: both one-shots committed, BLOCK 1 done,
   the Fishbowl Product export saved, April and Sawyer briefed. Expect ~500 rows (TEST 2026-09-25: 500, none down). */
SELECT public.fb_push_enqueue('prices', NULL, '{"only_changed": true}'::jsonb, false,
                              'PROD Rev 81 prices push (D-PRICE-53)') AS command_id;

/* BLOCK 3 -- look, any time: the last five commands and what Fishbowl answered. */
SELECT id, kind, status, row_count, dry_run, result->>'dry_run' AS result_dry_run, result->'imports' AS imports,
       error, requested_at, finished_at
FROM public.fb_push_commands ORDER BY id DESC LIMIT 5;

/* BLOCK 4 -- look: the six sample products, at Fishbowl's price as the bridge last read it.
   After BLOCK 2: ZG2600-21B 30.61 . SK2600FW-SET1 18.37 . SK4001-13SFW 35.15 . QL8C21-13PHS 48.36 .
   SK2600-1 5.28 (unchanged) . SK4002-10HS 50.82 (unchanged) */
SELECT product_num, list_price, synced_at
FROM public.fb_products
WHERE removed_at IS NULL AND product_num IN ('ZG2600-21B','SK2600FW-SET1','SK4001-13SFW','QL8C21-13PHS','SK2600-1','SK4002-10HS')
ORDER BY product_num;

/* BLOCK 5 -- the confirmation, products part. After BLOCK 2: mismatched 0, fb_zero 0. */
SELECT public.pricing_fb_sync_status() -> 'products' AS products;

/* BLOCK 6 -- cancel a command that is still QUEUED (replace 0 with its id). The bridge claims commands
   within 20 s, so this only helps immediately after a mistaken BLOCK 1 or 2. */
SELECT public.fb_push_cancel(0);
