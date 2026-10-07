-- ============================================================================
-- D-PRICE-66 — Kits price as Each and one Distributor column (Each − 30 %).
-- Matt, 2026-10-07. Effective immediately, in place on the active book (Rev 82).
--
-- RUN WITH psql ($env:TEST_DB_URL / $env:PROD_DB_URL, PGCLIENTENCODING=UTF8), NOT
-- the Supabase SQL Editor: both function bodies carry SELECT … INTO, which the
-- Editor's check rejects (lesson recorded in D-PRICE-46).
--
-- What changes
--   1. A new ladder `kit` on the active book with ONE column:
--        {"key":"distributor","kind":"tier","label":"Distributor","factor":0.70}
--      `factor` is new: a column with a factor prices as the item's EACH × factor
--      instead of through a rule multiplier. 0.70 = Each − 30 %, kept in the book's
--      data so a later revision can change it without code.
--   2. The 318 component_sum items of the four "Skybolt Kits — …" sections move
--      from ladder q100_q300_q500 to ladder kit. The 16 CLoc 2000 Common Sets,
--      Kit Hardware and the CLoc tool kit are NOT touched (Matt: common sets differ).
--   3. pricing_item_prices: a factor column on a kit = Σ components at Each × factor
--      (the components do not carry a "distributor" column of their own).
--   4. pricing_get_price: a kit on a ladder with a factor column prices as its Each
--      sum (components at list, qty 1, all-or-nothing as D-PRICE-50) and, for ANY
--      customer with a tier — Tier 1/2/3, Premier, or a 100/300/500 column tier —
--      × factor: basis 'kit_distributor', col_key 'distributor'. No-tier customers
--      pay the Each sum; quantity never changes a kit's price. Kits on any other
--      ladder (the Common Sets) keep the per-column component sum exactly as today.
--
-- Not in scope (Matt, 2026-10-07): Fishbowl. Kits are not in the SkyNet product
-- tree and stay out; the Each Σ keeps pushing as Fishbowl list price; the team
-- enters the distributor price on the order by hand. The kits site (pricing_kit_prices)
-- publishes list price only and is unaffected. Customer-part exceptions on a kit
-- were not applied before this change and still are not.
--
-- Price effect for a Tier 3 customer today → after (examples):
--   AC690-NA1P  $202.04 → $256.54     B55-AFP  $31.75 → $23.77
--   AC690-NA1S  $213.04 → $262.12     B55-AS1 $226.35 → $199.47
--
-- Re-run safe: every data step is guarded; CREATE OR REPLACE is idempotent.
-- ============================================================================

-- 1. DRY RUN — expect: kit_items 318 across 4 sections, all on q100_q300_q500; common_sets 16
select
  (select count(*) from price_items i join price_sections s on s.id = i.section_id join price_books b on b.id = i.book_id and b.status = 'active'
    where s.name like 'Skybolt Kits%' and i.status = 'component_sum') as kit_items,
  (select count(distinct s.id) from price_items i join price_sections s on s.id = i.section_id join price_books b on b.id = i.book_id and b.status = 'active'
    where s.name like 'Skybolt Kits%' and i.status = 'component_sum') as kit_sections,
  (select string_agg(distinct i.ladder_code, ', ') from price_items i join price_sections s on s.id = i.section_id join price_books b on b.id = i.book_id and b.status = 'active'
    where s.name like 'Skybolt Kits%' and i.status = 'component_sum') as kit_ladders_now,
  (select count(*) from price_items i join price_sections s on s.id = i.section_id join price_books b on b.id = i.book_id and b.status = 'active'
    where s.name like '%Common Sets%' and i.status = 'component_sum') as common_sets,
  (select count(*) from price_ladders l join price_books b on b.id = l.book_id and b.status = 'active' where l.code = 'kit') as kit_ladder_exists;

-- 2. APPLY
begin;

-- a) the kit ladder: one column, with the factor
insert into price_ladders (book_id, code, label, columns)
select b.id, 'kit', 'kit', '[{"key":"distributor","kind":"tier","label":"Distributor","factor":0.70}]'::jsonb
  from price_books b
 where b.status = 'active'
   and not exists (select 1 from price_ladders l where l.book_id = b.id and l.code = 'kit');

-- b) the four kit families onto it (expect UPDATE 318 first run, 0 on a re-run)
update price_items i
   set ladder_code = 'kit'
  from price_books b, price_sections s
 where b.id = i.book_id and b.status = 'active'
   and s.id = i.section_id and s.name like 'Skybolt Kits%'
   and i.status = 'component_sum'
   and i.ladder_code is distinct from 'kit';

-- c) pricing_item_prices — carries the column's factor; a factor column sums components at Each × factor
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
           x.key, x.kind, x.label, x.ord, x.factor
    FROM simple s
    JOIN LATERAL (
      SELECT 'each' AS key, 'each' AS kind, 'Each' AS label, 0 AS ord, NULL::numeric AS factor
      UNION ALL
      SELECT c->>'key', c->>'kind', c->>'label', (o::int), (c->>'factor')::numeric
      FROM public.price_ladders l, jsonb_array_elements(l.columns) WITH ORDINALITY AS e(c, o)
      WHERE l.book_id = p_book AND l.code = s.ladder_code
      UNION ALL
      SELECT 'premier', 'tier', 'Premier', 99, NULL::numeric WHERE s.has_premier
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
  -- one row per (kit, column): the sum resolves only if EVERY BOM line finds a priced component for that column.
  -- D-PRICE-66: a column with a factor (the kit ladder's Distributor) is the kit's EACH sum × factor —
  -- its components are summed at Each, not at a column they do not carry.
  sums AS (
    SELECT k.item_id, k.part_number, k.key, k.kind, k.label, k.ord,
           CASE WHEN COUNT(kc.item_id) > 0 AND COUNT(kc.item_id) = COUNT(cp.unit_price)
                THEN SUM(cp.unit_price * kc.qty) * COALESCE(k.factor, 1) END AS unit_price
    FROM simple_prices k
    LEFT JOIN public.price_kit_components kc ON kc.item_id = k.item_id
    LEFT JOIN simple_prices cp ON cp.part_key = kc.component_key
                              AND cp.key = CASE WHEN k.factor IS NOT NULL THEN 'each' ELSE k.key END
                              AND cp.status = 'priced'
    WHERE k.status = 'component_sum'
    GROUP BY k.item_id, k.part_number, k.key, k.kind, k.label, k.ord, k.factor
  )
  SELECT sp.item_id, sp.part_number, sp.key, sp.kind, sp.label, sp.ord, sp.unit_price
  FROM simple_prices sp WHERE sp.status <> 'component_sum'
  UNION ALL
  SELECT s.item_id, s.part_number, s.key, s.kind, s.label, s.ord, s.unit_price FROM sums s
$function$;

-- d) pricing_get_price — the kit branch gains the factor path; everything else verbatim
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

  /* Kits: sum the components. All-or-nothing (D-PRICE-50). */
  IF v_item.status = 'component_sum' THEN
    /* D-PRICE-66: a kit on a ladder with a factor column (the kit ladder's Distributor) is its EACH sum —
       components at list, qty 1 — and, for ANY customer with a tier (level or column), × the factor.
       Quantity never changes a kit's price. Kits on any other ladder (Common Sets) take the per-column
       sum below, as before. */
    v_mult := NULL;
    SELECT (e->>'factor')::numeric INTO v_mult FROM jsonb_array_elements(v_ladder.columns) e WHERE e->>'factor' IS NOT NULL LIMIT 1;
    IF v_mult IS NOT NULL THEN
      SELECT SUM(g.unit_price * kc.qty), COUNT(*) FILTER (WHERE g.unit_price IS NULL), COUNT(*)
        INTO v_price, v_missing, v_lines
      FROM public.price_kit_components kc
      JOIN LATERAL public.pricing_get_price(kc.component_part_number, NULL, 1, p_as_of) g ON true
      WHERE kc.item_id = v_item.id;
      IF v_lines = 0 OR v_missing > 0 OR v_price IS NULL THEN
        RETURN QUERY SELECT NULL::numeric, NULL::numeric, 'no_price'::text, NULL::text, v_tier, NULL::uuid, v_book, (SELECT rev_label FROM price_books WHERE id = v_book), v_item.id, v_item.status,
          CASE WHEN v_lines = 0 THEN 'kit has no components' ELSE v_missing || ' of ' || v_lines || ' component(s) without price' END; RETURN;
      END IF;
      IF v_tier <> 'none' THEN
        v_price := v_price * v_mult; v_col := 'distributor'; v_basis := 'kit_distributor';
      ELSE
        v_col := 'each'; v_basis := 'kit_sum';
      END IF;
      RETURN QUERY SELECT v_price, round(v_price, 2), v_basis, v_col, v_tier, NULL::uuid, v_book, (SELECT rev_label FROM price_books WHERE id = v_book), v_item.id, v_item.status, NULL::text; RETURN;
    END IF;

    /* Per-column sum at the same customer / qty / date (one level). */
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

  /* Column tier (D-PRICE-51): the customer's standing column, regardless of quantity — never worse, never better.
     If this item's ladder has no such column, its Each applies. */
  IF v_tier IN ('q100', 'q300', 'q500') THEN
    v_mult := public._pricing_multiplier(v_book, v_item.rule_code, v_item.ladder_code, v_tier);
    IF v_mult IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_ladder.columns) e WHERE e->>'key' = v_tier) THEN
      v_price := v_item.list_price * v_mult; v_col := v_tier; v_basis := 'column';
    ELSE
      v_price := v_item.list_price; v_col := 'each'; v_basis := 'list';
    END IF;
    RETURN QUERY SELECT v_price, round(v_price, 2), v_basis, v_col, v_tier, NULL::uuid, v_book, (SELECT rev_label FROM price_books WHERE id = v_book), v_item.id, v_item.status, NULL::text; RETURN;
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

commit;

-- 3. VERIFY — expect: on_kit_ladder 318; common_sets_untouched 16 (still q100_q300_q500);
--    the book shows AC690-NA1P Each 366.48 / Distributor 256.54 and no other column;
--    Tier 3 and Premier customers get 256.54 'kit_distributor' (a column-tier customer would too — none exist on TEST);
--    a no-tier customer 366.48 'kit_sum';
--    qty 100 for a no-tier customer still 366.48; a Common Set's Tier 3 price is unchanged.
select
  (select count(*) from price_items i join price_books b on b.id = i.book_id and b.status = 'active' where i.ladder_code = 'kit') as on_kit_ladder,
  (select string_agg(distinct i.ladder_code, ', ') from price_items i join price_sections s on s.id = i.section_id join price_books b on b.id = i.book_id and b.status = 'active'
    where s.name like '%Common Sets%' and i.status = 'component_sum') as common_sets_ladder,
  (select string_agg(p.col_key || '=' || round(p.unit_price, 2), ' | ' order by p.col_order)
     from pricing_item_prices((select id from price_books where status = 'active')) p where p.part_number = 'AC690-NA1P') as ac690_book_columns,
  (select g.unit_price_2dp || ' ' || g.basis || ' ' || g.col_key from pricing_get_price('AC690-NA1P', (select fb_customer_id from v_customer_pricing_current where tier = 'tier3' and is_active limit 1), 1, current_date) g) as ac690_tier3,
  (select g.unit_price_2dp || ' ' || g.basis || ' ' || g.col_key from pricing_get_price('AC690-NA1P', (select fb_customer_id from v_customer_pricing_current where tier = 'premier' and is_active limit 1), 1, current_date) g) as ac690_premier,
  (select g.unit_price_2dp || ' ' || g.basis || ' ' || g.col_key from pricing_get_price('AC690-NA1P', null, 100, current_date) g) as ac690_no_tier_qty100,
  (select g.unit_price_2dp || ' ' || g.basis || ' ' || g.col_key from pricing_get_price(
      (select i.part_number from price_items i join price_sections s on s.id = i.section_id join price_books b on b.id = i.book_id and b.status = 'active' where s.name like '%Common Sets%' and i.status = 'component_sum' order by i.sort limit 1),
      (select fb_customer_id from v_customer_pricing_current where tier = 'tier3' and is_active limit 1), 1, current_date) g) as first_common_set_tier3;

-- ROLLBACK (only if needed): the two functions come back from Docs/migrations/2026-09-16_D-PRICE-50_engine_kit_sums.sql
-- (pricing_item_prices, pricing_get_price), then:
-- update price_items i set ladder_code = 'q100_q300_q500' from price_books b where b.id = i.book_id and b.status = 'active' and i.ladder_code = 'kit';
-- delete from price_ladders l using price_books b where b.id = l.book_id and b.status = 'active' and l.code = 'kit';
