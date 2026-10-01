/* ============================================================================================
   2026-09-30_SK2600-TS1_kit_price_fix_COMMIT.sql   (PROD SQL Editor: paste the whole file, Run)
   Same change as the DRYRUN file (SK2600-TS1 becomes a kit priced as the sum of Template-213 +
   SK-T26 + Unibit-1 in Rev 82), but it COMMITs, and the check runs AFTER the commit, so the row the
   Editor shows is the saved state. Run the whole sheet with nothing highlighted.
   Expect: component_sum | each 81.48 | q5 70.73 | q10 66.27.
   Safe to run again: once applied, the UPDATE matches nothing and the check reads the same.
   Tonight's 02:10 push then sends 81.48 to Fishbowl, with the kit's quantity and tier rules.
   ============================================================================================ */
BEGIN;

UPDATE public.price_items
SET status = 'component_sum', list_price = NULL, updated_at = now()
WHERE book_id = '95b56bae-94ae-4677-b0bf-023d8104a8a5'          -- Rev 82
  AND part_key = 'SK2600-TS1' AND status = 'priced';

COMMIT;

SELECT (SELECT status FROM public.price_items WHERE book_id = '95b56bae-94ae-4677-b0bf-023d8104a8a5' AND part_key = 'SK2600-TS1') AS status_now,
       (SELECT unit_price_2dp FROM public.pricing_get_price('SK2600-TS1', NULL, 1, '2026-10-01')) AS each_price,
       (SELECT unit_price_2dp FROM public.pricing_get_price('SK2600-TS1', NULL, 5, '2026-10-01')) AS q5_price,
       (SELECT unit_price_2dp FROM public.pricing_get_price('SK2600-TS1', NULL, 10, '2026-10-01')) AS q10_price;
