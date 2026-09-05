/* ============================================================================
   S11 Batch A — post-seed verification. Run each block separately (last-result-set rule).
   Expected values come from the scratch run of the same seed (2026-09-03).
   ============================================================================ */

/* ---------- V1 — books: expect Rev 81 active 2026-05-26, Rev 82 scheduled 2026-10-01 */
SELECT rev_label, effective_from, status, premier_pct, uplift_pct FROM public.price_books ORDER BY effective_from;

/* ---------- V2 — fingerprints (100-row limit safe)
   Rev 81 expected: 4454|e6db5d47e1c6cdf962645e6cca5d5cdd
   Rev 82 expected: 4454|af73b50eb61b9c57b89bab5d5dad599e */
SELECT b.rev_label,
       count(*) || '|' || md5(string_agg(i.part_key || ':' || coalesce(i.list_price::text,'-')
              || CASE WHEN b.rev_label LIKE 'Rev 81%' THEN ':' || coalesce(i.rule_code,'-') || ':' || i.ladder_code || ':' || i.status ELSE '' END,
              ',' ORDER BY i.part_key)) AS fingerprint
FROM public.price_items i JOIN public.price_books b ON b.id = i.book_id
GROUP BY b.rev_label ORDER BY b.rev_label;

/* ---------- V3 — status / section mix (Rev 81): priced 4244, component_sum 16, no_price 194; catalog 3297, resale 1157; sections 197 */
SELECT i.status, s.kind, count(*)
FROM public.price_items i JOIN public.price_sections s ON s.id = i.section_id JOIN public.price_books b ON b.id = i.book_id
WHERE b.rev_label LIKE 'Rev 81%' GROUP BY 1,2 ORDER BY 2,1;

/* ---------- V4 — spot table (expect these unit_price_2dp values on 2026-09-30; no customer = walk-in list/breaks) */
SELECT t, unit_price_2dp, basis, col_key FROM (
  SELECT 'SK2600-1 q1 -> 5.28' t, * FROM public.pricing_get_price('SK2600-1', NULL, 1, '2026-09-30')
  UNION ALL SELECT 'SK2600-1 q300 -> 4.17', * FROM public.pricing_get_price('SK2600-1', NULL, 300, '2026-09-30')
  UNION ALL SELECT 'SK2600-1 q5000 -> 3.85 (never a tier)', * FROM public.pricing_get_price('SK2600-1', NULL, 5000, '2026-09-30')
  UNION ALL SELECT 'SK2600-1 q1 Oct 1 -> 6.07', * FROM public.pricing_get_price('SK2600-1', NULL, 1, '2026-10-01')
  UNION ALL SELECT 'SK40S5-2S Airparts(57) q50 -> 3.47 tier3', * FROM public.pricing_get_price('SK40S5-2S', 57, 50, '2026-09-30')
  UNION ALL SELECT 'SK201-2 PinAir(12587) -> 0.37 exception', * FROM public.pricing_get_price('SK201-2', 12587, 1, '2026-09-30')
  UNION ALL SELECT 'SK40R17-1 Air Tractor(552) -> 2.52 exception', * FROM public.pricing_get_price('SK40R17-1', 552, 1, '2026-09-30')
  UNION ALL SELECT 'ZG2600-SET1 q1 -> 14.96 kit_sum', * FROM public.pricing_get_price('ZG2600-SET1', NULL, 1, '2026-09-30')
  UNION ALL SELECT 'Cloc 2000 Kit q3 -> 325.44', * FROM public.pricing_get_price('Cloc 2000 Kit', NULL, 3, '2026-09-30')
  UNION ALL SELECT 'SK700 q500 -> 28.75 (rule-P, no breaks)', * FROM public.pricing_get_price('SK700', NULL, 500, '2026-09-30')
  UNION ALL SELECT 'SK213-1SD -> 9.59 (alias of SK212-12SD)', * FROM public.pricing_get_price('SK213-1SD', NULL, 1, '2026-09-30')
  UNION ALL SELECT 'SK21060DC08 -> no pricing available', * FROM public.pricing_get_price('SK21060DC08', NULL, 1, '2026-09-30')
) x;

/* ---------- V5 — tier seeds: 108 rows (106 candidates + PinAir/Air Tractor premier); exceptions: 9 */
SELECT (SELECT count(*) FROM public.customer_pricing) AS tier_seeds,
       (SELECT count(*) FROM public.price_exceptions) AS exceptions,
       (SELECT count(*) FROM public.price_kit_components) AS kit_components;   /* 48 */

/* ---------- V6 — part links: how many Rev 81 items resolved to a SkyNet part / kit SKU / Fishbowl product (informational; fb_product_id fills on the first products poll too) */
SELECT count(*) FILTER (WHERE part_id IS NOT NULL) AS linked_parts,
       count(*) FILTER (WHERE kit_sku_id IS NOT NULL) AS linked_kits,
       count(*) FILTER (WHERE fb_product_id IS NOT NULL) AS linked_fb_products,
       count(*) AS items
FROM public.price_items WHERE book_id = public.pricing_book_for_date('2026-09-30');

/* ---------- V7 — role gate smoke (run signed in as April in the app later; in the editor auth.uid() is NULL so gates pass by design) */
SELECT public.pricing_book_for_date(CURRENT_DATE) IS NOT NULL AS has_current_book;
