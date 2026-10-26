/* 2026-10-26_D-PRICE-70_whole_cent_list_prices.sql
   SkyNet Pricing Portal — the book carries whole-cent list prices; the 'SN .. EA' each-band rules are retired.

   Why (D-PRICE-70, supersedes D-PRICE-54): Fishbowl's Pricing Rule module compares every valid tier-3 rule with the
   list price and keeps the LOWER one (Product Pricing window on SO 19785: 'SN A std EA $14.71 Valid' listed, line
   left on 'Use List Price $14.705'). A 100 % rule that rounds UP can therefore never win, so three-decimal list
   prices leak onto orders (30 lines on 11 PROD SOs, Oct 7–26). With a two-decimal list there is nothing to compare.

   Run order: TEST (applied by Claude 2026-10-26 through the Supabase tools, results in the Decisions entry) → PROD
   (Matt, SQL Editor, each block separately: 0 preflight → 1 apply → 2 verify). Re-run safe: the DO block skips
   items already rounded and functions already patched. Nothing is deleted; before-images go to
   price_items_cents_backup_dprice70.

   PROD attempt 1 (2026-10-26) stopped inside the DO block on the hardware-costs anchor count (PROD has the v3 function
   with three cost × markup roundings; TEST has v2 with two) — the block is one transaction, so nothing landed, which
   is why the verify query found no backup table. This revision accepts any count ≥ 1 for that anchor.

   After PROD: Pricing › Fishbowl Sync → push PRICES (≈2,950 rows change) then RULES (kit fixed prices move, the
   38 'SN .. EA' rules are switched off). Expect in_sync = true after the bridge re-reads.
*/

-- ===================================================================================================
-- 0. PREFLIGHT (read-only): what will change. Expect PROD Rev 82: ~2,951 three-dp items outside resale.
-- ===================================================================================================
SELECT b.rev_label, b.status AS book_status, s.kind, i.status,
       count(*) AS items,
       count(*) FILTER (WHERE i.list_price IS NOT NULL AND i.list_price <> round(i.list_price, 2)) AS three_dp,
       md5(string_agg(i.id::text || ':' || coalesce(i.list_price::text, 'null'), ',' ORDER BY i.id)) AS fingerprint
FROM public.price_items i
JOIN public.price_books b ON b.id = i.book_id
JOIN public.price_sections s ON s.id = i.section_id
WHERE b.status <> 'superseded'
GROUP BY 1, 2, 3, 4
ORDER BY 1, 3, 4;

-- ===================================================================================================
-- 1. APPLY (one transaction): round the live books, patch the seven functions.
-- ===================================================================================================
DO $dp70$
DECLARE
  v_rounded   int := 0;
  v_backed_up int := 0;
  v_oid       oid;
  v_def       text;
  v_n         int;
  r           record;
  v_patches   jsonb := $j$[
    {"fn":"pricing_clone_book",            "n":1, "old":"round(i.list_price * (1 + COALESCE(p_uplift_pct,0)), 3)", "new":"round(i.list_price * (1 + COALESCE(p_uplift_pct,0)), 2)"},
    {"fn":"pricing_uplift_book",           "n":1, "old":"round(i.list_price * (1 + p_pct), 3)",                    "new":"round(i.list_price * (1 + p_pct), 2)"},
    {"fn":"pricing_set_section_vs_base",   "n":1, "old":"round(base.list_price * (1 + p_total_pct), 3)",           "new":"round(base.list_price * (1 + p_total_pct), 2)"},
    {"fn":"pricing_upsert_item",           "n":1, "old":"round((p_item->>'list_price')::numeric, 3)",              "new":"round((p_item->>'list_price')::numeric, 2)"},
    {"fn":"pricing_refresh_hardware_costs","n":null,"old":"round(c.last_cost * (1 + p_markup), 3)",                "new":"round(c.last_cost * (1 + p_markup), 2)"},
    {"fn":"pricing_fb_expected_products",  "n":1, "old":"THEN trim_scale(round(i.list_price, 4))",                  "new":"THEN round(i.list_price, 2)"},
    {"fn":"pricing_fb_expected_products",  "n":1, "old":"(Matt 2026-09-28: three decimals.)",                       "new":"(D-PRICE-54 three decimals; D-PRICE-70 2026-10-26: whole cents — Fishbowl keeps the lower of list and a rounding rule.)"},
    {"fn":"pricing_fb_expected_rules",     "n":1, "old":"WHERE fq.first_min IS NULL OR fq.first_min > 1",           "new":"WHERE false /* D-PRICE-70: no each band — list prices are whole cents, so there is nothing to round */"}
  ]$j$;
BEGIN
  /* ---- 1a. before-images, then round every priced / kit item outside resale in every live book ---- */
  CREATE TABLE IF NOT EXISTS public.price_items_cents_backup_dprice70 (
    item_id uuid PRIMARY KEY,
    book_id uuid NOT NULL,
    part_number text,
    old_list_price numeric NOT NULL,
    new_list_price numeric NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  );

  INSERT INTO public.price_items_cents_backup_dprice70 (item_id, book_id, part_number, old_list_price, new_list_price)
  SELECT i.id, i.book_id, i.part_number, i.list_price, round(i.list_price, 2)
  FROM public.price_items i
  JOIN public.price_books b ON b.id = i.book_id
  JOIN public.price_sections s ON s.id = i.section_id
  WHERE b.status <> 'superseded'
    AND s.kind <> 'resale'
    AND i.status IN ('priced', 'component_sum')
    AND i.list_price IS NOT NULL
    AND i.list_price <> round(i.list_price, 2)
  ON CONFLICT (item_id) DO NOTHING;
  GET DIAGNOSTICS v_backed_up = ROW_COUNT;

  UPDATE public.price_items i
     SET list_price = round(i.list_price, 2), updated_at = now()
    FROM public.price_books b, public.price_sections s
   WHERE b.id = i.book_id AND s.id = i.section_id
     AND b.status <> 'superseded'
     AND s.kind <> 'resale'
     AND i.status IN ('priced', 'component_sum')
     AND i.list_price IS NOT NULL
     AND i.list_price <> round(i.list_price, 2);
  GET DIAGNOSTICS v_rounded = ROW_COUNT;

  IF v_rounded <> v_backed_up THEN
    RAISE EXCEPTION 'D-PRICE-70: rounded % rows but backed up % — aborting', v_rounded, v_backed_up;
  END IF;
  RAISE NOTICE 'D-PRICE-70: % list prices rounded to the cent (before-images in price_items_cents_backup_dprice70)', v_rounded;

  /* ---- 1b. functions: every 3-dp rounding becomes 2 dp; the each band leaves the expected rule set ----
     Each patch is applied to the function's CURRENT definition (pg_get_functiondef), so nothing is retyped and
     CRLF bodies survive. An anchor must match exactly the expected number of times; an already-patched function
     is skipped. Signatures do not change, so grants and ownership are kept by CREATE OR REPLACE. */
  FOR r IN SELECT * FROM jsonb_to_recordset(v_patches) AS x(fn text, n int, old text, new text) LOOP
    v_oid := (SELECT p.oid FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
               WHERE ns.nspname = 'public' AND p.proname = r.fn);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'D-PRICE-70: function public.% not found', r.fn;
    END IF;
    v_def := pg_get_functiondef(v_oid);
    v_n := (length(v_def) - length(replace(v_def, r.old, ''))) / length(r.old);
    IF v_n = 0 AND position(r.new IN v_def) > 0 THEN
      RAISE NOTICE 'D-PRICE-70: % already patched (%)', r.fn, left(r.new, 40);
      CONTINUE;
    END IF;
    /* n = null means "every occurrence, at least one" — pricing_refresh_hardware_costs has the cost × markup rounding
       twice on TEST (v2) and three times on PROD (v3, the kit-component adoption step); all of them become 2 dp. */
    IF (r.n IS NULL AND v_n < 1) OR (r.n IS NOT NULL AND v_n <> r.n) THEN
      RAISE EXCEPTION 'D-PRICE-70: % — anchor "%" found % time(s), expected %', r.fn, r.old, v_n, coalesce(r.n::text, 'at least 1');
    END IF;
    EXECUTE replace(v_def, r.old, r.new);
    RAISE NOTICE 'D-PRICE-70: % patched, % occurrence(s) (%)', r.fn, v_n, left(r.new, 40);
  END LOOP;
END
$dp70$;

-- ===================================================================================================
-- 2. VERIFY (read-only, one row). Expect: three_dp_live = 0 · funcs_still_3dp = 0 · ea_rules_expected = 0 ·
--    expected_products_max_scale = 2 · backup_rows = the 1a count · fb_price_drift = the rows the prices push will send
--    (≈ backup_rows until the push lands and the bridge re-reads, then 0).
-- ===================================================================================================
SELECT
  (SELECT count(*) FROM public.price_items i JOIN public.price_books b ON b.id = i.book_id JOIN public.price_sections s ON s.id = i.section_id
    WHERE b.status <> 'superseded' AND s.kind <> 'resale' AND i.status IN ('priced','component_sum')
      AND i.list_price IS NOT NULL AND i.list_price <> round(i.list_price, 2))                                   AS three_dp_live,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public'
      AND p.proname IN ('pricing_clone_book','pricing_uplift_book','pricing_set_section_vs_base','pricing_upsert_item','pricing_refresh_hardware_costs')
      AND pg_get_functiondef(p.oid) ~ ', 3\)')                                                                    AS funcs_still_3dp,
  (SELECT count(*) FROM public.pricing_fb_expected_rules((SELECT id FROM public.price_books WHERE status = 'active'), current_date) x
    WHERE x.name LIKE 'SN % EA')                                                                                  AS ea_rules_expected,
  (SELECT max(scale(x.price)) FROM public.pricing_fb_expected_products((SELECT id FROM public.price_books WHERE status = 'active'), false) x) AS expected_products_max_scale,
  (SELECT count(*) FROM public.price_items_cents_backup_dprice70)                                                  AS backup_rows,
  (SELECT count(*) FROM public.pricing_fb_expected_products((SELECT id FROM public.price_books WHERE status = 'active'), false) x
    JOIN public.fb_products f ON f.product_num = x.product_num AND f.removed_at IS NULL
    WHERE round(f.list_price, 4) <> round(x.price, 4))                                                            AS fb_price_drift;
