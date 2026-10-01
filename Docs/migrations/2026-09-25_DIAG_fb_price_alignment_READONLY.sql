/* ============================================================================================
   2026-09-25_DIAG_fb_price_alignment_READONLY.sql  (D-PRICE-53)
   Book-in-effect vs Fishbowl product prices, using only tables that exist BEFORE the migration
   (price_items / pricing_item_prices / fb_products / fb_customers / customer_pricing / price_exceptions).
   One statement, one jsonb row, SQL-Editor safe (no INTO, no meta-commands, < 100 rows).

   PASS = "pass": true  (every priced non-resale book row that Fishbowl knows has the same 2-dp price,
   and no set/kit is unresolved). Expected TODAY on PROD (Rev 81): FAIL with differ 507 / not_in_fb 97.
   Expected after the Rev 81 prices push: PASS except the 97 not_in_fb (they need Fishbowl products or
   the SK2018 asterisk fix). After Batch A the live confirmation is: select pricing_fb_sync_status();
   Optional: replace CURRENT_DATE with '2026-10-01' to preview the Rev 82 push.
   ============================================================================================ */
WITH bk AS (SELECT public.pricing_book_for_date(CURRENT_DATE) AS id),
each AS (SELECT p.item_id, p.unit_price FROM public.pricing_item_prices((SELECT id FROM bk)) p WHERE p.col_key = 'each'),
rows_ AS (
  SELECT i.part_number, i.part_key, s.kind AS section_kind, s.name AS section, i.status, i.rule_code, i.ladder_code,
         round(e.unit_price, 2) AS book_price, f.product_num, round(f.list_price, 2) AS fb_price
  FROM public.price_items i
  JOIN public.price_sections s ON s.id = i.section_id
  LEFT JOIN each e ON e.item_id = i.id
  LEFT JOIN public.fb_products f ON f.product_key = i.part_key AND f.removed_at IS NULL
  WHERE i.book_id = (SELECT id FROM bk) AND i.status IN ('priced','component_sum')
),
scope AS (SELECT * FROM rows_ WHERE section_kind <> 'resale' AND book_price IS NOT NULL),
cls AS (
  SELECT *,
    CASE WHEN product_num IS NULL THEN 'not_in_fb'
         WHEN fb_price = book_price THEN 'equal'
         WHEN fb_price = 0 THEN 'fb_zero'
         WHEN abs(fb_price - book_price) <= 0.011 THEN 'penny'
         WHEN abs(fb_price * 1.30 - book_price) <= 0.02 THEN 'fb_is_book_div_1.30'
         WHEN abs(fb_price * 1.25 - book_price) <= 0.02 THEN 'fb_is_book_div_1.25'
         WHEN fb_price > book_price THEN 'fb_higher'
         ELSE 'other_lower' END AS klass
  FROM scope)
SELECT jsonb_build_object(
  'as_of', CURRENT_DATE,
  'book', (SELECT jsonb_build_object('id', b.id, 'rev_label', b.rev_label, 'status', b.status, 'effective_from', b.effective_from) FROM public.price_books b WHERE b.id = (SELECT id FROM bk)),
  'fb_products_synced_at', (SELECT max(synced_at) FROM public.fb_products),
  'counts', (SELECT jsonb_build_object(
      'book_priced_non_resale', count(*),
      'in_fishbowl', count(*) FILTER (WHERE product_num IS NOT NULL),
      'equal', count(*) FILTER (WHERE klass = 'equal'),
      'differ', count(*) FILTER (WHERE product_num IS NOT NULL AND klass <> 'equal'),
      'not_in_fb', count(*) FILTER (WHERE klass = 'not_in_fb'),
      'sets_kits_resolved', count(*) FILTER (WHERE status = 'component_sum')) FROM cls),
  'differ_by_class', (SELECT jsonb_object_agg(klass, n) FROM (SELECT klass, count(*) n FROM cls WHERE product_num IS NOT NULL AND klass <> 'equal' GROUP BY klass) x),
  'differ_by_section', (SELECT jsonb_agg(jsonb_build_object('section', section, 'n', n) ORDER BY n DESC) FROM (SELECT section, count(*) n FROM cls WHERE product_num IS NOT NULL AND klass <> 'equal' GROUP BY section ORDER BY n DESC LIMIT 15) x),
  'largest_diffs', (SELECT jsonb_agg(jsonb_build_object('part', part_number, 'book', book_price, 'fb', fb_price, 'class', klass) ORDER BY abs(fb_price - book_price) DESC)
                    FROM (SELECT * FROM cls WHERE product_num IS NOT NULL AND klass <> 'equal' ORDER BY abs(fb_price - book_price) DESC LIMIT 20) x),
  'fb_higher', (SELECT jsonb_agg(jsonb_build_object('part', part_number, 'book', book_price, 'fb', fb_price, 'ratio', round(fb_price / NULLIF(book_price, 0), 3)) ORDER BY part_number)
                FROM cls WHERE klass = 'fb_higher'),
  'not_in_fb', (SELECT jsonb_build_object(
      'asterisk_rows', (SELECT jsonb_agg(part_number ORDER BY part_number) FROM cls WHERE klass = 'not_in_fb' AND part_number LIKE '%*%'),
      'renamed_discontinued', (SELECT jsonb_agg(jsonb_build_object('book', c.part_number, 'fb', f.product_num) ORDER BY c.part_number)
                               FROM cls c JOIN public.fb_products f ON f.removed_at IS NULL AND f.product_key LIKE c.part_key || '%' AND f.product_key <> c.part_key AND f.product_num ILIKE '%discont%'
                               WHERE c.klass = 'not_in_fb'),
      'no_product', (SELECT jsonb_agg(part_number ORDER BY part_number) FROM cls c WHERE klass = 'not_in_fb' AND part_number NOT LIKE '%*%'
                     AND NOT EXISTS (SELECT 1 FROM public.fb_products f WHERE f.removed_at IS NULL AND f.product_key LIKE c.part_key || '%' AND f.product_num ILIKE '%discont%')))),
  'resale', (SELECT jsonb_build_object(
      'rows', count(*), 'in_fishbowl', count(*) FILTER (WHERE product_num IS NOT NULL),
      'differ', count(*) FILTER (WHERE product_num IS NOT NULL AND fb_price IS DISTINCT FROM book_price),
      'differ_list', (SELECT jsonb_agg(jsonb_build_object('part', part_number, 'book', book_price, 'fb', fb_price)) FROM rows_ WHERE section_kind = 'resale' AND product_num IS NOT NULL AND fb_price IS DISTINCT FROM book_price))
      FROM rows_ WHERE section_kind = 'resale' AND book_price IS NOT NULL),
  'sets_kits', (SELECT jsonb_build_object(
      'total', count(*), 'resolved', count(*) FILTER (WHERE book_price IS NOT NULL),
      'unresolved', (SELECT jsonb_agg(part_number ORDER BY part_number) FROM (SELECT part_number FROM rows_ WHERE status = 'component_sum' AND book_price IS NULL ORDER BY part_number LIMIT 30) x),
      'differ_in_fb', (SELECT jsonb_agg(jsonb_build_object('part', part_number, 'book', book_price, 'fb', fb_price) ORDER BY part_number) FROM cls WHERE status = 'component_sum' AND product_num IS NOT NULL AND klass <> 'equal'))
      FROM rows_ WHERE status = 'component_sum'),
  'tiers_and_exceptions', (SELECT jsonb_build_object(
      'tiered_customers', (SELECT count(DISTINCT fb_customer_id) FROM public.customer_pricing WHERE effective_to IS NULL AND tier <> 'none'),
      'by_tier', (SELECT jsonb_object_agg(tier, n) FROM (SELECT tier, count(*) n FROM public.customer_pricing WHERE effective_to IS NULL AND tier <> 'none' GROUP BY tier) x),
      'open_exceptions', (SELECT count(*) FROM public.price_exceptions WHERE effective_to IS NULL))),
  'pass', (SELECT count(*) FILTER (WHERE product_num IS NOT NULL AND klass <> 'equal') = 0 FROM cls)
       AND (SELECT count(*) FILTER (WHERE book_price IS NULL) = 0 FROM rows_ WHERE status = 'component_sum')
) AS diag;
