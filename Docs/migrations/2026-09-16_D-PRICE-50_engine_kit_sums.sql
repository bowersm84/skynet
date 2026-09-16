-- D-PRICE-50 — Pricing engine: kit sums are all-or-nothing and set-based; customer sheet prices the book once.
-- psql, TEST then PROD. Three CREATE OR REPLACE with unchanged signatures (grants kept). Read-only functions.
--
-- Found 2026-09-16 while diagnosing "canceling statement due to statement timeout" on an Oct 1 price list:
--   • pricing_item_prices priced Rev 81 in 1.1 s and Rev 82 in 9.9 s — the component_sum branch ran a correlated
--     subquery per sum-row-per-column against the 25k-row simple_prices CTE.
--   • Both pricing_item_prices and pricing_get_price summed kits with SUM(), which skips NULL components, so a kit
--     with one unpriced component quoted a PARTIAL sum (B95-C1 $515.86 with 1 of 7 missing; LANCAIR-C1P-F
--     $1,035.68). The client (columnPrice) and the Products CSV already treat such kits as unpriced; the engine
--     now agrees: any missing component → no price.
--   • pricing_customer_sheet called pricing_item_prices three times per output row.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. pricing_item_prices — set-based, all-or-nothing sums
-- ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pricing_item_prices(p_book uuid)
 RETURNS TABLE(item_id uuid, part_number text, col_key text, col_kind text, col_label text, col_order integer, unit_price numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH b AS (SELECT premier_pct FROM public.price_books WHERE id = p_book),
  simple AS (
    SELECT i.id, i.part_number, i.part_key, i.list_price, i.rule_code, i.ladder_code, i.has_premier, i.status
    FROM public.price_items i WHERE i.book_id = p_book
  ),
  cols AS (
    SELECT s.id AS item_id, s.part_number, s.part_key, s.status, s.list_price, s.rule_code, s.ladder_code, s.has_premier,
           x.key, x.kind, x.label, x.ord
    FROM simple s
    JOIN LATERAL (
      SELECT 'each' AS key, 'each' AS kind, 'Each' AS label, 0 AS ord
      UNION ALL
      SELECT c->>'key', c->>'kind', c->>'label', (o::int)
      FROM public.price_ladders l, jsonb_array_elements(l.columns) WITH ORDINALITY AS e(c, o)
      WHERE l.book_id = p_book AND l.code = s.ladder_code
      UNION ALL
      SELECT 'premier', 'tier', 'Premier', 99 WHERE s.has_premier
    ) x ON true
  ),
  simple_prices AS MATERIALIZED (
    SELECT c.*,
      CASE
        WHEN c.status <> 'priced' THEN NULL
        WHEN c.key = 'each' THEN c.list_price
        WHEN c.key = 'premier' THEN c.list_price * public._pricing_multiplier(p_book, c.rule_code, c.ladder_code, 'tier3') * (SELECT premier_pct FROM b)
        ELSE c.list_price * public._pricing_multiplier(p_book, c.rule_code, c.ladder_code, c.key)
      END AS unit_price
    FROM cols c
  ),
  -- one row per (kit, column): the sum resolves only if EVERY BOM line finds a priced component for that column
  sums AS (
    SELECT k.item_id, k.part_number, k.key, k.kind, k.label, k.ord,
           CASE WHEN COUNT(kc.item_id) > 0 AND COUNT(kc.item_id) = COUNT(cp.unit_price)
                THEN SUM(cp.unit_price * kc.qty) END AS unit_price
    FROM simple_prices k
    LEFT JOIN public.price_kit_components kc ON kc.item_id = k.item_id
    LEFT JOIN simple_prices cp ON cp.part_key = kc.component_key AND cp.key = k.key AND cp.status = 'priced'
    WHERE k.status = 'component_sum'
    GROUP BY k.item_id, k.part_number, k.key, k.kind, k.label, k.ord
  )
  SELECT sp.item_id, sp.part_number, sp.key, sp.kind, sp.label, sp.ord, sp.unit_price
  FROM simple_prices sp WHERE sp.status <> 'component_sum'
  UNION ALL
  SELECT s.item_id, s.part_number, s.key, s.kind, s.label, s.ord, s.unit_price FROM sums s
$function$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. pricing_get_price — kit branch is all-or-nothing (everything else byte-identical to the current body)
-- ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pricing_get_price(p_part text, p_fb_customer_id integer DEFAULT NULL::integer, p_qty numeric DEFAULT 1, p_as_of date DEFAULT CURRENT_DATE)
 RETURNS TABLE(unit_price numeric, unit_price_2dp numeric, basis text, col_key text, tier text, exception_id uuid, book_id uuid, rev_label text, item_id uuid, item_status text, reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_book uuid; v_item public.price_items; v_tier text := 'none'; v_exc public.price_exceptions;
  v_ladder public.price_ladders; v_col text; v_mult numeric; v_price numeric; v_basis text;
  v_key text := upper(regexp_replace(p_part, '\s', '', 'g'));
  v_t3 numeric; v_has_tier boolean; v_tier_key text; c jsonb; v_best_min numeric := -1;
  v_missing int := 0; v_lines int := 0;
BEGIN
  v_book := public.pricing_book_for_date(p_as_of);
  IF v_book IS NULL THEN
    RETURN QUERY SELECT NULL::numeric, NULL::numeric, 'no_price'::text, NULL::text, NULL::text, NULL::uuid, NULL::uuid, NULL::text, NULL::uuid, NULL::text, 'no book effective on ' || p_as_of; RETURN;
  END IF;
  SELECT * INTO v_item FROM public.price_items WHERE book_id = v_book AND part_key = v_key;
  IF v_item IS NULL THEN
    RETURN QUERY SELECT NULL::numeric, NULL::numeric, 'no_price'::text, NULL::text, NULL::text, NULL::uuid, v_book, (SELECT rev_label FROM price_books WHERE id = v_book), NULL::uuid, NULL::text, 'not in book'::text; RETURN;
  END IF;
  IF v_item.status = 'no_price' THEN
    RETURN QUERY SELECT NULL::numeric, NULL::numeric, 'no_price'::text, NULL::text, NULL::text, NULL::uuid, v_book, (SELECT rev_label FROM price_books WHERE id = v_book), v_item.id, v_item.status, 'no pricing available'::text; RETURN;
  END IF;

  IF p_fb_customer_id IS NOT NULL THEN v_tier := public.pricing_customer_tier(p_fb_customer_id, p_as_of); END IF;
  SELECT * INTO v_ladder FROM public.price_ladders WHERE book_id = v_book AND code = v_item.ladder_code;
  v_has_tier := EXISTS (SELECT 1 FROM jsonb_array_elements(v_ladder.columns) e WHERE e->>'kind' = 'tier');

  /* Kits: sum the components at the same customer / qty / date (one level). All-or-nothing (D-PRICE-50):
     a single component without a price makes the kit unpriced, never a partial sum. */
  IF v_item.status = 'component_sum' THEN
    SELECT SUM(g.unit_price * kc.qty), MAX(g.col_key), MAX(g.basis),
           COUNT(*) FILTER (WHERE g.unit_price IS NULL), COUNT(*)
      INTO v_price, v_col, v_basis, v_missing, v_lines
    FROM public.price_kit_components kc
    JOIN LATERAL public.pricing_get_price(kc.component_part_number, p_fb_customer_id, p_qty, p_as_of) g ON true
    WHERE kc.item_id = v_item.id;
    IF v_lines = 0 OR v_missing > 0 OR v_price IS NULL THEN
      RETURN QUERY SELECT NULL::numeric, NULL::numeric, 'no_price'::text, NULL::text, v_tier, NULL::uuid, v_book, (SELECT rev_label FROM price_books WHERE id = v_book), v_item.id, v_item.status,
        CASE WHEN v_lines = 0 THEN 'kit has no components' ELSE v_missing || ' of ' || v_lines || ' component(s) without price' END; RETURN;
    END IF;
    RETURN QUERY SELECT v_price, round(v_price, 2), 'kit_sum'::text, v_col, v_tier, NULL::uuid, v_book, (SELECT rev_label FROM price_books WHERE id = v_book), v_item.id, v_item.status, NULL::text; RETURN;
  END IF;

  /* Resale / any ladder without columns: list only */
  IF v_ladder IS NULL OR jsonb_array_length(v_ladder.columns) = 0 THEN
    RETURN QUERY SELECT v_item.list_price, round(v_item.list_price, 2), 'list'::text, 'each'::text, v_tier, NULL::uuid, v_book, (SELECT rev_label FROM price_books WHERE id = v_book), v_item.id, v_item.status, NULL::text; RETURN;
  END IF;

  v_t3 := v_item.list_price * public._pricing_multiplier(v_book, v_item.rule_code, v_item.ladder_code, 'tier3');

  /* Customer x part exception */
  IF p_fb_customer_id IS NOT NULL THEN
    SELECT * INTO v_exc FROM public.price_exceptions
    WHERE fb_customer_id = p_fb_customer_id AND part_key = v_key
      AND effective_from <= p_as_of AND (effective_to IS NULL OR effective_to > p_as_of)
    ORDER BY effective_from DESC LIMIT 1;
    IF v_exc.id IS NOT NULL THEN
      v_price := CASE v_exc.mode WHEN 'fixed' THEN v_exc.value ELSE COALESCE(v_t3, v_item.list_price) * v_exc.value END;
      RETURN QUERY SELECT v_price, round(v_price, 2), 'exception'::text, 'exception'::text, v_tier, v_exc.id, v_book, (SELECT rev_label FROM price_books WHERE id = v_book), v_item.id, v_item.status, NULL::text; RETURN;
    END IF;
  END IF;

  /* Tiered customer */
  IF v_tier <> 'none' AND v_has_tier THEN
    IF v_tier = 'premier' THEN
      IF v_item.has_premier AND v_t3 IS NOT NULL THEN
        v_price := v_t3 * (SELECT premier_pct FROM public.price_books WHERE id = v_book); v_col := 'premier'; v_basis := 'premier';
      ELSE
        v_tier_key := 'tier3';
      END IF;
    ELSE
      v_tier_key := v_tier;
    END IF;
    IF v_price IS NULL THEN
      /* fall back down the tier columns the ladder actually has (e.g. each_t1_t2 has no tier3) */
      FOR v_col IN SELECT k FROM unnest(ARRAY['tier3','tier2','tier1']) k
        WHERE (CASE k WHEN 'tier3' THEN 3 WHEN 'tier2' THEN 2 ELSE 1 END)
              <= (CASE v_tier_key WHEN 'tier3' THEN 3 WHEN 'tier2' THEN 2 ELSE 1 END)
        ORDER BY (CASE k WHEN 'tier3' THEN 3 WHEN 'tier2' THEN 2 ELSE 1 END) DESC
      LOOP
        v_mult := public._pricing_multiplier(v_book, v_item.rule_code, v_item.ladder_code, v_col);
        IF v_mult IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_ladder.columns) e WHERE e->>'key' = v_col) THEN
          v_price := v_item.list_price * v_mult; v_basis := 'tier'; EXIT;
        END IF;
      END LOOP;
    END IF;
    IF v_price IS NOT NULL THEN
      RETURN QUERY SELECT v_price, round(v_price, 2), v_basis, v_col, v_tier, NULL::uuid, v_book, (SELECT rev_label FROM price_books WHERE id = v_book), v_item.id, v_item.status, NULL::text; RETURN;
    END IF;
  END IF;

  /* Quantity break: largest qty column with min <= qty */
  v_col := 'each'; v_price := v_item.list_price; v_basis := 'list';
  FOR c IN SELECT * FROM jsonb_array_elements(v_ladder.columns) LOOP
    IF c->>'kind' = 'qty' AND (c->>'min')::numeric <= p_qty AND (c->>'min')::numeric > v_best_min THEN
      v_mult := public._pricing_multiplier(v_book, v_item.rule_code, v_item.ladder_code, c->>'key');
      IF v_mult IS NOT NULL THEN
        v_best_min := (c->>'min')::numeric; v_col := c->>'key'; v_price := v_item.list_price * v_mult; v_basis := 'qty_break';
      END IF;
    END IF;
  END LOOP;
  RETURN QUERY SELECT v_price, round(v_price, 2), v_basis, v_col, v_tier, NULL::uuid, v_book, (SELECT rev_label FROM price_books WHERE id = v_book), v_item.id, v_item.status, NULL::text;
END $function$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 3. pricing_customer_sheet — price the book once, pivot the three qty columns, join
-- ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pricing_customer_sheet(p_fb_customer_id integer, p_as_of date DEFAULT CURRENT_DATE, p_mode text DEFAULT 'purchased'::text)
 RETURNS TABLE(section_name text, section_sort integer, part_number text, description text, dfar boolean, item_status text, tier text, unit_price numeric, col_key text, basis text, q100 numeric, q300 numeric, q500 numeric, last_paid numeric, last_bought date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH bk AS (SELECT public.pricing_book_for_date(p_as_of) AS id),
  hist AS (
    SELECT product_key, MAX(fb_date_created)::date AS last_bought,
           (array_agg(unit_price ORDER BY fb_date_created DESC))[1] AS last_paid
    FROM public.fb_so_history_lines WHERE fb_customer_id = p_fb_customer_id AND qty_fulfilled > 0
    GROUP BY product_key
  ),
  qty_cols AS MATERIALIZED (
    SELECT p.item_id,
           round(MAX(p.unit_price) FILTER (WHERE p.col_key = 'q100'), 2) AS q100,
           round(MAX(p.unit_price) FILTER (WHERE p.col_key = 'q300'), 2) AS q300,
           round(MAX(p.unit_price) FILTER (WHERE p.col_key = 'q500'), 2) AS q500
    FROM public.pricing_item_prices((SELECT id FROM bk)) p
    WHERE p.col_key IN ('q100', 'q300', 'q500')
    GROUP BY p.item_id
  )
  SELECT s.name, s.sort, i.part_number, i.description, i.dfar, i.status,
         g.tier, g.unit_price_2dp, g.col_key, g.basis,
         qc.q100, qc.q300, qc.q500,
         h.last_paid, h.last_bought
  FROM public.price_items i
  JOIN public.price_sections s ON s.id = i.section_id
  LEFT JOIN hist h ON h.product_key = i.part_key
  LEFT JOIN qty_cols qc ON qc.item_id = i.id
  JOIN LATERAL public.pricing_get_price(i.part_number, p_fb_customer_id, 1, p_as_of) g ON true
  WHERE i.book_id = (SELECT id FROM bk)
    AND i.status <> 'no_price'
    AND (p_mode = 'all' OR h.product_key IS NOT NULL)
  ORDER BY s.sort, i.sort
$function$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- verify (psql): timings and the all-or-nothing behaviour
-- ─────────────────────────────────────────────────────────────────────────────────────────────
\timing on
select count(*) from public.pricing_item_prices((select id from public.price_books where rev_label like 'Rev 82%'));   -- was 9.9 s
select count(*) from public.pricing_customer_sheet(9818, '2026-10-01', 'purchased');                                 -- Lanzen, Oct 1 — was a timeout
select part_number, col_key, unit_price
from public.pricing_item_prices((select id from public.price_books where rev_label like 'Rev 82%'))
where part_number in ('AC500-C1', 'B95-C1', 'LANCAIR-C1P-F') and col_key = 'each' order by 1;                      -- AC500-C1 3380.439; the other two NULL
select unit_price, basis, reason from public.pricing_get_price('B95-C1', null, 1, '2026-10-01');                    -- no_price, "1 of 7 component(s) without price"
select unit_price, basis, reason from public.pricing_get_price('AC500-C1', null, 1, '2026-10-01');                  -- 3380.44, kit_sum
\timing off
