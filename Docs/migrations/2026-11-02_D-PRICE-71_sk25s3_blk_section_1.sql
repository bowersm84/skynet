/* 2026-11-02_D-PRICE-71_sk25s3_blk_section.sql
   Pricing Portal — new catalog section "SK25S3B Stainless Phillips - Flush Head - Anodized Black" in the book in
   effect (Rev 82), 12 items SK25S3-(x)BLK mirroring SK25S3-(x)S with the black-anodize upcharge used for
   SK25S51-(x)BLK (+32 % over the S price; where the S price is the same as an SK25S51 S price the BLK price is
   copied from that family so the two black families stay identical: 7.24 → 9.55, 7.81 → 10.31, 10.37 → 13.68;
   7.71 → 10.18 is new, 7.71 × 1.32).

   Mirrors the SK25S51B rows: rule A, standard ladder, DFAR, not Premier, tso_status not_tso ("black anodize not on
   drawing"), item sort = the S item's sort, the 11/14 range note carried over. No Fishbowl product exists yet for
   any SK25S3-(x)BLK, so fb_product_id stays NULL until the products are created in Fishbowl (the nightly products
   mirror links them by number). The section lands at sort 169, right after SK25S3S (168); later sections shift +1.

   Run order: TEST (applied by Claude 2026-11-02) → PROD (Matt, SQL Editor, each block separately: 0 → 1 → 2).
   Re-run safe: block 1 does nothing when the section already exists.
*/

-- ===================================================================================================
-- 0. PREFLIGHT (read-only). Expect: 12 source items, 0 blk items, section 169 = "ZG25S3 …" (to be shifted).
-- ===================================================================================================
SELECT
  (SELECT count(*) FROM public.price_items i JOIN public.price_sections s ON s.id = i.section_id
    WHERE i.book_id = (SELECT id FROM public.price_books WHERE status = 'active') AND s.name LIKE 'SK25S3S %' AND i.status = 'priced') AS source_items,
  (SELECT count(*) FROM public.price_items i
    WHERE i.book_id = (SELECT id FROM public.price_books WHERE status = 'active') AND i.part_number LIKE 'SK25S3-%BLK') AS blk_items,
  (SELECT string_agg(s.sort || ' ' || left(s.name, 30), ' | ' ORDER BY s.sort) FROM public.price_sections s
    WHERE s.book_id = (SELECT id FROM public.price_books WHERE status = 'active') AND s.sort BETWEEN 167 AND 171) AS sections_167_171,
  (SELECT rev_label FROM public.price_books WHERE status = 'active') AS book;

-- ===================================================================================================
-- 1. APPLY (one transaction)
-- ===================================================================================================
DO $dp71$
DECLARE
  v_book    uuid;
  v_src     uuid;
  v_new     uuid;
  v_name    text := 'SK25S3B Stainless Phillips - Flush Head - Anodized Black - (Stainless Stud/Stainless Cup)';
  v_n       int;
  v_fallback int;
BEGIN
  v_book := (SELECT id FROM public.price_books WHERE status = 'active');
  IF v_book IS NULL THEN RAISE EXCEPTION 'D-PRICE-71: no active book'; END IF;

  IF EXISTS (SELECT 1 FROM public.price_sections WHERE book_id = v_book AND name = v_name) THEN
    RAISE NOTICE 'D-PRICE-71: section already exists — nothing to do';
    RETURN;
  END IF;

  v_src := (SELECT id FROM public.price_sections WHERE book_id = v_book AND name LIKE 'SK25S3S %' AND kind = 'catalog');
  IF v_src IS NULL THEN RAISE EXCEPTION 'D-PRICE-71: source section SK25S3S not found'; END IF;
  v_n := (SELECT count(*) FROM public.price_items WHERE section_id = v_src AND status = 'priced');
  IF v_n <> 12 THEN RAISE EXCEPTION 'D-PRICE-71: expected 12 priced SK25S3S items, found %', v_n; END IF;

  /* make room at 169 */
  UPDATE public.price_sections SET sort = sort + 1 WHERE book_id = v_book AND sort >= 169;

  INSERT INTO public.price_sections (book_id, name, sort, kind, header_note, source_row)
  VALUES (v_book, v_name, 169, 'catalog', NULL, NULL)
  RETURNING id INTO v_new;

  INSERT INTO public.price_items (book_id, section_id, part_number, fb_product_id, part_id, kit_sku_id, description, list_price,
                                  rule_code, ladder_code, has_premier, dfar, xref_arconic, xref_lisi, nsn, cessna, sort, status,
                                  source_row, range_of, notes, cost_plus, tso_status, tso_basis)
  SELECT v_book, v_new,
         regexp_replace(i.part_number, 'S$', 'BLK'),
         NULL, NULL, NULL,
         i.description || ' - Anodized Black',
         CASE i.list_price
           WHEN 7.24  THEN 9.55     /* = SK25S51-1..5BLK  */
           WHEN 7.71  THEN 10.18    /* 7.71 × 1.32         */
           WHEN 7.81  THEN 10.31    /* = SK25S51-8..10BLK */
           WHEN 10.37 THEN 13.68    /* = SK25S51-11..15BLK */
           ELSE round(i.list_price * 1.32, 2)
         END,
         'A', 'standard', false, true, NULL, NULL, NULL, NULL,
         i.sort, 'priced', NULL,
         CASE WHEN i.range_of IS NOT NULL THEN replace(replace(i.range_of, 'S to ', 'BLK to '), '20S', '20BLK') END,
         'D-PRICE-71: SK25S3-(x)S + 32 % black anodize, mirrors SK25S51-(x)BLK',
         false, 'not_tso', 'Not TSO (material) | MDL SK27P; black anodize not on drawing'
  FROM public.price_items i
  WHERE i.section_id = v_src AND i.status = 'priced'
  ORDER BY i.sort;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  v_fallback := (SELECT count(*) FROM public.price_items WHERE section_id = v_new
                  AND list_price NOT IN (9.55, 10.18, 10.31, 13.68));
  IF v_fallback > 0 THEN
    RAISE EXCEPTION 'D-PRICE-71: % item(s) priced by the ×1.32 fallback — an S price is not one of 7.24 / 7.71 / 7.81 / 10.37; aborting', v_fallback;
  END IF;

  RAISE NOTICE 'D-PRICE-71: section % created at sort 169 with % items', v_new, v_n;
END
$dp71$;

-- ===================================================================================================
-- 2. VERIFY (read-only). Expect 12 rows, 9.55 ×5 · 10.18 ×2 · 10.31 ×3 · 13.68 ×2, range on -11BLK / -14BLK,
--    all rule A / standard / DFAR / not_tso, section sort 169 with ZG25S3 now at 170.
-- ===================================================================================================
SELECT i.part_number, i.description, i.list_price, i.rule_code, i.ladder_code, i.dfar, i.tso_status, i.range_of, i.sort,
       s.sort AS section_sort, i.fb_product_id,
       (SELECT p.unit_price FROM public.pricing_item_prices(i.book_id) p WHERE p.item_id = i.id AND p.col_key = 'tier3') AS tier3
FROM public.price_items i JOIN public.price_sections s ON s.id = i.section_id
WHERE i.book_id = (SELECT id FROM public.price_books WHERE status = 'active') AND i.part_number LIKE 'SK25S3-%BLK'
ORDER BY i.sort;
