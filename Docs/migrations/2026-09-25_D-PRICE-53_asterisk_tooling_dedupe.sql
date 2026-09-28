/* ============================================================================================
   2026-09-25_D-PRICE-53_asterisk_tooling_dedupe.sql   -- PROD-style data correction, DRY RUN by default

   Problem. The guide lists the ZLoc grommet tooling with a footnote asterisk (SK2018-A2*, -A3*, -A4*,
   -A5*, -A6*, -A65*, -F4*, -F5*, -F6*, -F65*, SK2018C*: rule A, ladder q5, UPLIFTED in Rev 82). Fishbowl's
   products have no asterisk, so the D-PRICE-13 resale sweep created a second row for 10 of the 11 under the
   plain number in the Resale section (Fishbowl price, NOT uplifted). Today the plain (resale) row is what
   matches Fishbowl, so the Rev 82 push would leave these 11 tools at the old price and the catalog rows
   can never reach Fishbowl (product "SK2018-A3*" does not exist).

   Fix (both books: Rev 81 active, Rev 82 scheduled): delete the 10 Resale duplicates per book, then strip
   the asterisk from the 11 catalog rows (unique (book_id, part_key) needs the delete first). Nothing else
   references these rows (0 kit components, 0 exceptions).

   Knock-on: the 11 tools follow the catalog row (rule A, q5 breaks) and rise 15% in Fishbowl on Oct 1 with
   the rest of the guide. Direct SQL bypasses the portal's change log, as D-PRICE-41 did; this file is the record.

   Run in the SQL Editor as ONE sheet. Read the two previews. Then change the last line to COMMIT and run again.
   Expected preview: 22 catalog rows with '*' (11 per book), 20 resale duplicates (10 per book);
   after: 0 rows with '*', 0 duplicates, 22 catalog rows now spelled without '*'.
   ============================================================================================ */
BEGIN;

/* preview 1: the asterisk rows and whether a plain duplicate exists in the same book */
SELECT b.rev_label, i.part_number, s.name AS section, i.rule_code, i.ladder_code, i.list_price,
       (SELECT d.part_number FROM public.price_items d JOIN public.price_sections ds ON ds.id = d.section_id
         WHERE d.book_id = i.book_id AND d.part_key = replace(i.part_key, '*', '') AND ds.kind = 'resale') AS resale_duplicate
FROM public.price_items i
JOIN public.price_books b ON b.id = i.book_id
JOIN public.price_sections s ON s.id = i.section_id
WHERE i.part_number LIKE '%*%'
ORDER BY b.rev_label, i.part_number;

/* step 1: delete the resale duplicates (only where a '*' catalog row exists in the same book) */
DELETE FROM public.price_items d
USING public.price_sections ds
WHERE ds.id = d.section_id AND ds.kind = 'resale'
  AND EXISTS (SELECT 1 FROM public.price_items c JOIN public.price_sections cs ON cs.id = c.section_id
              WHERE c.book_id = d.book_id AND cs.kind = 'catalog' AND c.part_number LIKE '%*%'
                AND replace(c.part_key, '*', '') = d.part_key);

/* step 2: strip the asterisk from the catalog rows */
UPDATE public.price_items i
SET part_number = replace(i.part_number, '*', ''), updated_at = now()
FROM public.price_sections s
WHERE s.id = i.section_id AND s.kind = 'catalog' AND i.part_number LIKE '%*%';

/* preview 2: after */
SELECT (SELECT count(*) FROM public.price_items WHERE part_number LIKE '%*%') AS rows_with_asterisk_after,
       (SELECT count(*) FROM public.price_items i JOIN public.price_sections s ON s.id = i.section_id
         WHERE s.kind = 'catalog' AND i.part_key IN ('SK2018-A2','SK2018-A3','SK2018-A4','SK2018-A5','SK2018-A6','SK2018-A65','SK2018-F4','SK2018-F5','SK2018-F6','SK2018-F65','SK2018C')) AS catalog_rows_plain_after,
       (SELECT count(*) FROM public.price_items i JOIN public.price_sections s ON s.id = i.section_id
         WHERE s.kind = 'resale' AND i.part_key IN ('SK2018-A2','SK2018-A3','SK2018-A4','SK2018-A5','SK2018-A6','SK2018-A65','SK2018-F4','SK2018-F5','SK2018-F6','SK2018-F65','SK2018C')) AS resale_rows_after,
       (SELECT count(*) FROM public.price_items i JOIN public.fb_products f ON f.product_key = i.part_key AND f.removed_at IS NULL
         WHERE i.part_key IN ('SK2018-A2','SK2018-A3','SK2018-A4','SK2018-A5','SK2018-A6','SK2018-A65','SK2018-F4','SK2018-F5','SK2018-F6','SK2018-F65','SK2018C')) AS rows_now_matching_fishbowl;

ROLLBACK;   /* <- change to COMMIT once both previews read as expected */
