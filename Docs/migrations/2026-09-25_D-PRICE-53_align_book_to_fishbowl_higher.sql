/* ============================================================================================
   2026-09-25_D-PRICE-53_align_book_to_fishbowl_higher.sql   -- PROD-style data correction, DRY RUN by default

   Matt 2026-09-25: "bring SkyNet into alignment with the current Fishbowl price" for the rows where
   Fishbowl is HIGHER than the book: the 19 SK4002-xHS Sealed Series rows (Fishbowl = Rev 81 x 1.385) and
   SK-P3-1125 ($40.84 vs $38.89). SK4002-29HS / -30HS are $0.00 in Fishbowl and are NOT touched (they keep
   the book price and the push will fill them).

   Rev 81 (active): list_price := Fishbowl's current price.
   Rev 82 (scheduled Oct 1): list_price := Rev 81 new price x (1 + Rev 82 uplift_pct), 3 dp -- the same
   uplift every other row got, so Oct 1 stays a uniform +15%. (If you want Rev 82 to stay AT Fishbowl's
   current price instead, replace the second UPDATE's expression with f.list_price.)

   Rules, ladders, has_premier are unchanged. Direct SQL bypasses the portal change log (as D-PRICE-41 did);
   this file is the record. Run as ONE sheet; read the preview; change ROLLBACK to COMMIT and run again.
   Expected preview: 20 rows, every fb_price > book_81; after: 20 rows with book_81 = fb_price.
   ============================================================================================ */
BEGIN;

/* preview: the rows in scope */
SELECT i.part_number, i.list_price AS book_81, round(f.list_price, 3) AS fb_price,
       (SELECT i2.list_price FROM public.price_items i2 JOIN public.price_books b2 ON b2.id = i2.book_id AND b2.rev_label ILIKE '%82%' WHERE i2.part_key = i.part_key) AS book_82_now,
       round(f.list_price * (1 + (SELECT b2.uplift_pct FROM public.price_books b2 WHERE b2.rev_label ILIKE '%82%')), 3) AS book_82_after
FROM public.price_items i
JOIN public.price_books b ON b.id = i.book_id AND b.rev_label ILIKE '%81%'
JOIN public.fb_products f ON f.product_key = i.part_key AND f.removed_at IS NULL
WHERE i.status = 'priced' AND f.list_price > 0 AND round(f.list_price, 2) > round(i.list_price, 2)
  AND (i.part_key LIKE 'SK4002-%HS' OR i.part_key = 'SK-P3-1125')
ORDER BY i.part_number;

/* step 1: Rev 81 takes Fishbowl's price */
UPDATE public.price_items i
SET list_price = round(f.list_price, 3), updated_at = now()
FROM public.price_books b, public.fb_products f
WHERE b.id = i.book_id AND b.rev_label ILIKE '%81%'
  AND f.product_key = i.part_key AND f.removed_at IS NULL
  AND i.status = 'priced' AND f.list_price > 0 AND round(f.list_price, 2) > round(i.list_price, 2)
  AND (i.part_key LIKE 'SK4002-%HS' OR i.part_key = 'SK-P3-1125');

/* step 2: Rev 82 = new Rev 81 x (1 + uplift) for the same parts */
UPDATE public.price_items i82
SET list_price = round(i81.list_price * (1 + b82.uplift_pct), 3), updated_at = now()
FROM public.price_books b82, public.price_books b81, public.price_items i81
WHERE b82.id = i82.book_id AND b82.rev_label ILIKE '%82%'
  AND b81.id = i81.book_id AND b81.rev_label ILIKE '%81%' AND i81.part_key = i82.part_key
  AND i82.status = 'priced' AND i81.status = 'priced'
  AND (i82.part_key LIKE 'SK4002-%HS' OR i82.part_key = 'SK-P3-1125')
  AND EXISTS (SELECT 1 FROM public.fb_products f WHERE f.product_key = i82.part_key AND f.removed_at IS NULL AND f.list_price > 0
              AND round(f.list_price, 3) = i81.list_price);

/* after */
SELECT i.part_number, i.list_price AS book_81, round(f.list_price, 3) AS fb_price,
       (SELECT i2.list_price FROM public.price_items i2 JOIN public.price_books b2 ON b2.id = i2.book_id AND b2.rev_label ILIKE '%82%' WHERE i2.part_key = i.part_key) AS book_82
FROM public.price_items i
JOIN public.price_books b ON b.id = i.book_id AND b.rev_label ILIKE '%81%'
JOIN public.fb_products f ON f.product_key = i.part_key AND f.removed_at IS NULL
WHERE (i.part_key LIKE 'SK4002-%HS' OR i.part_key = 'SK-P3-1125')
ORDER BY i.part_number;

ROLLBACK;   /* <- change to COMMIT once the preview reads as expected */
