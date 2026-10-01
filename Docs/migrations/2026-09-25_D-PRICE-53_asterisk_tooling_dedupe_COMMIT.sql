/* ============================================================================================
   2026-09-25_D-PRICE-53_asterisk_tooling_dedupe_COMMIT.sql   -- the COMMIT run of the asterisk dedupe
   Same two statements as 2026-09-25_D-PRICE-53_asterisk_tooling_dedupe.sql (dry run already checked
   on PROD 2026-09-25: 0 | 22 | 0 | 22), but it COMMITs, and the check runs AFTER the commit, so the
   row the SQL Editor shows is the saved state.

   Run the whole sheet (nothing highlighted). Expect one row: 0 | 22 | 0 | 22.
   Safe to run again: once applied, both statements match nothing and the check still reads 0 | 22 | 0 | 22.
   ============================================================================================ */
BEGIN;

/* delete the resale duplicates (only where a '*' catalog row exists in the same book) */
DELETE FROM public.price_items d
USING public.price_sections ds
WHERE ds.id = d.section_id AND ds.kind = 'resale'
  AND EXISTS (SELECT 1 FROM public.price_items c JOIN public.price_sections cs ON cs.id = c.section_id
              WHERE c.book_id = d.book_id AND cs.kind = 'catalog' AND c.part_number LIKE '%*%'
                AND replace(c.part_key, '*', '') = d.part_key);

/* strip the asterisk from the catalog rows */
UPDATE public.price_items i
SET part_number = replace(i.part_number, '*', ''), updated_at = now()
FROM public.price_sections s
WHERE s.id = i.section_id AND s.kind = 'catalog' AND i.part_number LIKE '%*%';

COMMIT;

/* read back the saved state: 0 | 22 | 0 | 22 */
SELECT (SELECT count(*) FROM public.price_items WHERE part_number LIKE '%*%') AS rows_with_asterisk_after,
       (SELECT count(*) FROM public.price_items i JOIN public.price_sections s ON s.id = i.section_id
         WHERE s.kind = 'catalog' AND i.part_key IN ('SK2018-A2','SK2018-A3','SK2018-A4','SK2018-A5','SK2018-A6','SK2018-A65','SK2018-F4','SK2018-F5','SK2018-F6','SK2018-F65','SK2018C')) AS catalog_rows_plain_after,
       (SELECT count(*) FROM public.price_items i JOIN public.price_sections s ON s.id = i.section_id
         WHERE s.kind = 'resale' AND i.part_key IN ('SK2018-A2','SK2018-A3','SK2018-A4','SK2018-A5','SK2018-A6','SK2018-A65','SK2018-F4','SK2018-F5','SK2018-F6','SK2018-F65','SK2018C')) AS resale_rows_after,
       (SELECT count(*) FROM public.price_items i JOIN public.fb_products f ON f.product_key = i.part_key AND f.removed_at IS NULL
         WHERE i.part_key IN ('SK2018-A2','SK2018-A3','SK2018-A4','SK2018-A5','SK2018-A6','SK2018-A65','SK2018-F4','SK2018-F5','SK2018-F6','SK2018-F65','SK2018C')) AS rows_now_matching_fishbowl;
