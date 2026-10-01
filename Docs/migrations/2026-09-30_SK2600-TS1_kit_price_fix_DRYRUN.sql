/* ============================================================================================
   2026-09-30_SK2600-TS1_kit_price_fix_DRYRUN.sql   (PROD SQL Editor: paste the whole file, Run)
   SK2600-TS1 (SK2600 / SK2700 Installation Set) is a kit in Fishbowl and in the Kit Registry:
   Template-213 x1 + SK-T26 x1 + Unibit-1 x1. Rev 82 prices it as a plain item at 26.652, less than
   SK-T26 alone (41.11). This makes it a kit priced as the sum of its components, like the other 334
   Rev 82 kits: 81.48 each, 70.73 at 5+, 66.27 at 10+ (component prices on 2026-10-01).
   Rev 82 only (Rev 81 has no components for it and retires tonight).
   Before: status 'priced', list_price 26.652. To undo: set them back.

   DRY RUN: this file ends in ROLLBACK. The row the Editor shows is the state INSIDE the transaction;
   nothing is saved. Expect: 1 row changed | component_sum | each 81.48 | q5 70.73 | q10 66.27.
   Then run 2026-09-30_SK2600-TS1_kit_price_fix_COMMIT.sql.
   ============================================================================================ */
BEGIN;

UPDATE public.price_items
SET status = 'component_sum', list_price = NULL, updated_at = now()
WHERE book_id = '95b56bae-94ae-4677-b0bf-023d8104a8a5'          -- Rev 82
  AND part_key = 'SK2600-TS1' AND status = 'priced';

SELECT (SELECT count(*) FROM public.price_items WHERE book_id = '95b56bae-94ae-4677-b0bf-023d8104a8a5' AND part_key = 'SK2600-TS1' AND updated_at >= now() - interval '1 minute') AS rows_changed,
       (SELECT status FROM public.price_items WHERE book_id = '95b56bae-94ae-4677-b0bf-023d8104a8a5' AND part_key = 'SK2600-TS1') AS status_now,
       (SELECT unit_price_2dp FROM public.pricing_get_price('SK2600-TS1', NULL, 1, '2026-10-01')) AS each_price,
       (SELECT unit_price_2dp FROM public.pricing_get_price('SK2600-TS1', NULL, 5, '2026-10-01')) AS q5_price,
       (SELECT unit_price_2dp FROM public.pricing_get_price('SK2600-TS1', NULL, 10, '2026-10-01')) AS q10_price;

ROLLBACK;
