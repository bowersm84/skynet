/* ============================================================================================
   2026-09-28_D-PRICE-53_three_decimal_list_prices.sql   (PROD SQL Editor: paste the whole file, Run)
   Matt 2026-09-28, option 1: Fishbowl gets the book's list price to the last decimal (1.705, not 1.71) for
   every item it prices through the SkyNet percentage rules, so each percentage lands on SkyNet's cent
   (closes the 3,019 one-cent gaps). A new 'SN <rule> <ladder> EA' rule per rule/ladder node rounds the
   each band (quantities below the first break) to the cent, so a 1-99 line still charges 1.71.
   Sets, kits and items without percentage rules keep their 2-decimal Each.
   Replaces: pricing_fb_expected_products, pricing_fb_expected_rules (adds the 38 EA rules),
   v_fb_price_drift and pricing_fb_sync_status (compare list prices at 4 dp), fb_push_enqueue (sends the
   trimmed value). Grants are kept by CREATE OR REPLACE. Nothing is pushed by this file.
   Right after it, the status shows ~2,630 prices and 38 rules to push; that is expected.
   The last statement reads the result back.
   ============================================================================================ */
CREATE OR REPLACE FUNCTION public.pricing_fb_expected_products(p_book uuid, p_include_resale boolean DEFAULT false)
RETURNS TABLE(product_num text, price numeric, kind text, part_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH each AS (
    SELECT p.item_id, p.unit_price FROM public.pricing_item_prices(p_book) p WHERE p.col_key = 'each'
  )
  SELECT f.product_num,
         /* items Fishbowl prices through the SkyNet percentage rules carry the book's list price to the last
            decimal (Fishbowl takes up to 4), so every percentage lands on SkyNet's cent; their each band is
            rounded to the cent by the 'SN .. EA' rule. Everything else carries its Each at 2 dp.
            (Matt 2026-09-28: three decimals.) */
         CASE WHEN s.kind = 'catalog' AND i.status = 'priced' AND jsonb_array_length(COALESCE(l.columns, '[]'::jsonb)) > 0 AND EXISTS (SELECT 1 FROM public.price_rules r WHERE r.book_id = i.book_id AND r.code = i.rule_code)
              THEN trim_scale(round(i.list_price, 4))
              ELSE round(e.unit_price, 2) END AS price,
         CASE WHEN i.status = 'component_sum' THEN 'kit' WHEN s.kind = 'resale' THEN 'resale' ELSE 'catalog' END AS kind,
         i.part_key
  FROM public.price_items i
  JOIN public.price_sections s ON s.id = i.section_id
  JOIN each e ON e.item_id = i.id
  JOIN public.fb_products f ON f.product_key = i.part_key AND f.removed_at IS NULL
  LEFT JOIN public.price_ladders l ON l.book_id = i.book_id AND l.code = i.ladder_code
  WHERE i.book_id = p_book
    AND i.status IN ('priced','component_sum')
    AND e.unit_price IS NOT NULL
    AND (p_include_resale OR s.kind <> 'resale')
$$;

CREATE OR REPLACE FUNCTION public.pricing_fb_expected_rules(p_book uuid, p_as_of date DEFAULT CURRENT_DATE)
RETURNS TABLE(kind text, name text, description text, is_active boolean, product_incl_type text, product text,
              pa_applies boolean, pa_type text, pa_percent numeric, pa_base_amount_type text, pa_amount numeric,
              rnd_applies boolean, round_type text, rnd_to_amount numeric, rnd_is_minus boolean, rnd_pm_amount numeric,
              customer_incl_type text, customer text, date_applies boolean, date_begin text, date_end text,
              qty_applies boolean, qty_min numeric, qty_max numeric, is_auto_apply boolean, is_tier2 boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_pp numeric; v_rows jsonb; v_dup int; v_long int; v_kit_prices jsonb;
BEGIN
  v_pp := (SELECT b.premier_pct FROM public.price_books b WHERE b.id = p_book);
  IF v_pp IS NULL THEN RAISE EXCEPTION 'pricing_fb_expected_rules: unknown book %', p_book; END IF;

  /* ---- sets and kits, step 1: kit price per (group, qty) = sum of component prices at that group/qty
     (pricing_get_price semantics). Each distinct component is priced ONCE per pair any kit needs and the
     sums read those prices through a jsonb lookup, so no join between large intermediate sets is left to
     the planner (Rev 82: 317 kits; the first version took ~10 s, over the 8 s API statement timeout). */
  v_kit_prices := (
    WITH kits AS (
      SELECT i.id AS item_id, f.product_num, COALESCE(l.columns, '[]'::jsonb) AS columns
      FROM public.price_items i
      JOIN public.fb_products f ON f.product_key = i.part_key AND f.removed_at IS NULL
      LEFT JOIN public.price_ladders l ON l.book_id = i.book_id AND l.code = i.ladder_code
      WHERE i.book_id = p_book AND i.status = 'component_sum'
        AND EXISTS (SELECT 1 FROM public.price_kit_components kc WHERE kc.item_id = i.id)
        AND NOT EXISTS (
          SELECT 1 FROM public.price_kit_components kc
          LEFT JOIN public.price_items ci ON ci.book_id = i.book_id AND ci.part_key = kc.component_key AND ci.status = 'priced' AND ci.list_price IS NOT NULL
          WHERE kc.item_id = i.id AND ci.id IS NULL)
    ),
    kit_combos AS (
      SELECT k.item_id, g.tier, g.qty
      FROM kits k
      CROSS JOIN LATERAL (
        SELECT 'none'::text AS tier, 1::numeric AS qty
        UNION ALL SELECT 'none', (q.col->>'min')::numeric FROM jsonb_array_elements(k.columns) q(col) WHERE q.col->>'kind' = 'qty'
        UNION ALL SELECT t, 1::numeric FROM unnest(ARRAY['tier1','tier2','tier3','premier','q100','q300','q500']) t
        UNION ALL SELECT t, (q.col->>'min')::numeric FROM unnest(ARRAY['tier1','tier2','tier3','premier']) t, jsonb_array_elements(k.columns) q(col) WHERE q.col->>'kind' = 'qty'
      ) g
    ),
    need AS (
      SELECT DISTINCT ci.id, kx.tier, kx.qty
      FROM kit_combos kx
      JOIN public.price_kit_components kc ON kc.item_id = kx.item_id
      JOIN public.price_items ci ON ci.book_id = p_book AND ci.part_key = kc.component_key
    ),
    comp AS (
      SELECT COALESCE(jsonb_object_agg(n.id::text || '|' || n.tier || '|' || n.qty::text, public._fb_price_at(p_book, ci, n.tier, n.qty)), '{}'::jsonb) AS m
      FROM need n JOIN public.price_items ci ON ci.id = n.id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('item_id', x.item_id, 'product_num', x.product_num, 'tier', x.tier, 'qty', x.qty, 'price', x.price)), '[]'::jsonb)
    FROM (
      SELECT k.item_id, k.product_num, kx.tier, kx.qty,
             SUM(((SELECT c.m FROM comp c) ->> (ci.id::text || '|' || kx.tier || '|' || kx.qty::text))::numeric * kc.qty) AS price
      FROM kits k
      JOIN kit_combos kx ON kx.item_id = k.item_id
      JOIN public.price_kit_components kc ON kc.item_id = k.item_id
      JOIN public.price_items ci ON ci.book_id = p_book AND ci.part_key = kc.component_key
      GROUP BY k.item_id, k.product_num, kx.tier, kx.qty
    ) x
  );

  v_rows := (
    WITH
    /* customer groups that exist in Fishbowl (a member of each is in the customer mirror). Group rules are
       generated only for these: Fishbowl's Pricing Rules import cannot point a rule at a group that does
       not exist, and the Customer Group Relations push is what creates a group (PROD 2026-09-25). A tier
       assigned in SkyNet therefore reaches Fishbowl as: groups push -> the group exists -> rules push. */
    live_groups AS (
      SELECT g.tier, g.group_name
      FROM public.fb_group_map g
      WHERE EXISTS (SELECT 1 FROM public.fb_customers c
                    WHERE c.removed_at IS NULL AND g.group_name = ANY (COALESCE(c.account_groups, '{}')))
    ),
    /* ---- catalog combos: (rule, ladder) pairs that price at least one catalog item ------------- */
    combos AS (
      SELECT i.rule_code, i.ladder_code, 'Product:SkyNet:' || i.rule_code || ':' || i.ladder_code AS path,
             bool_or(i.has_premier) AS has_premier, l.columns
      FROM public.price_items i
      JOIN public.price_sections s ON s.id = i.section_id AND s.kind = 'catalog'
      JOIN public.price_ladders l ON l.book_id = i.book_id AND l.code = i.ladder_code AND jsonb_array_length(l.columns) > 0
      JOIN public.price_rules r ON r.book_id = i.book_id AND r.code = i.rule_code
      WHERE i.book_id = p_book AND i.status = 'priced'
      GROUP BY i.rule_code, i.ladder_code, l.columns
    ),
    /* each band: 100% of the list price rounded to the cent, below the first quantity break (all quantities
       on a ladder without breaks). List prices go to Fishbowl with the book's three decimals, so without it
       a 1-99 line would charge 1.705. */
    eaches AS (
      SELECT 'each'::text AS kind, 'SN ' || c.rule_code || ' ' || public._fb_ladder_abbrev(c.ladder_code) || ' EA' AS name,
             'SkyNet rule ' || c.rule_code || ' / ' || c.ladder_code || ' each, list price to the cent' AS description,
             'Product Tree'::text AS product_incl_type, c.path AS product, 'Percent'::text AS pa_type, 100::numeric AS pa_percent, 0::numeric AS pa_amount,
             'All'::text AS customer_incl_type, ''::text AS customer, fq.first_min IS NOT NULL AS qty_applies,
             (CASE WHEN fq.first_min IS NOT NULL THEN 1 ELSE 0 END)::numeric AS qty_min, COALESCE(fq.first_min - 1, 0)::numeric AS qty_max, 5 AS sort
      FROM combos c
      CROSS JOIN LATERAL (SELECT MIN((q.col->>'min')::numeric) AS first_min FROM jsonb_array_elements(c.columns) q(col) WHERE q.col->>'kind' = 'qty') fq
      WHERE fq.first_min IS NULL OR fq.first_min > 1
    ),
    /* quantity breaks: All customers, bounded ranges */
    breaks AS (
      SELECT 'break'::text AS kind,
             'SN ' || c.rule_code || ' ' || public._fb_ladder_abbrev(c.ladder_code) || ' Q' || (q.col->>'min') AS name,
             'SkyNet rule ' || c.rule_code || ' / ' || c.ladder_code || ' qty ' || (q.col->>'min') || '+' AS description,
             'Product Tree'::text AS product_incl_type, c.path AS product, 'Percent'::text AS pa_type, round(m.mult * 100, 4) AS pa_percent, 0::numeric AS pa_amount,
             'All'::text AS customer_incl_type, ''::text AS customer, true AS qty_applies, (q.col->>'min')::numeric AS qty_min,
             COALESCE((SELECT MIN((n.col->>'min')::numeric) - 1 FROM jsonb_array_elements(c.columns) n(col)
                        WHERE n.col->>'kind' = 'qty' AND (n.col->>'min')::numeric > (q.col->>'min')::numeric), 0) AS qty_max,
             10 AS sort
      FROM combos c
      CROSS JOIN LATERAL jsonb_array_elements(c.columns) q(col)
      CROSS JOIN LATERAL (SELECT public._pricing_multiplier(p_book, c.rule_code, c.ladder_code, q.col->>'key') AS mult) m
      WHERE q.col->>'kind' = 'qty' AND m.mult IS NOT NULL
    ),
    /* tier groups on ladders that carry tier columns (with the RPC's tier3 -> tier2 -> tier1 fallback) */
    tiers AS (
      SELECT 'tier'::text, 'SN ' || c.rule_code || ' ' || public._fb_ladder_abbrev(c.ladder_code) || ' ' || CASE g.tier WHEN 'tier1' THEN 'T1' WHEN 'tier2' THEN 'T2' WHEN 'tier3' THEN 'T3' ELSE 'PR' END,
             'SkyNet rule ' || c.rule_code || ' / ' || c.ladder_code || ' ' || g.tier,
             'Product Tree'::text, c.path, 'Percent'::text, round(m.mult * 100, 4), 0::numeric, 'Customer Group'::text, g.group_name, false, 0::numeric, 0::numeric, 20
      FROM combos c
      JOIN live_groups g ON g.tier IN ('tier1','tier2','tier3','premier')
      CROSS JOIN LATERAL (
        SELECT public._pricing_multiplier(p_book, c.rule_code, c.ladder_code, t.k) AS mult
        FROM unnest(ARRAY['tier3','tier2','tier1']) WITH ORDINALITY AS t(k, o)
        WHERE (CASE t.k WHEN 'tier3' THEN 3 WHEN 'tier2' THEN 2 ELSE 1 END) <= (CASE g.tier WHEN 'tier1' THEN 1 WHEN 'tier2' THEN 2 ELSE 3 END)
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.columns) e WHERE e->>'key' = t.k)
          AND public._pricing_multiplier(p_book, c.rule_code, c.ladder_code, t.k) IS NOT NULL
        ORDER BY t.o LIMIT 1
      ) m
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(c.columns) e WHERE e->>'kind' = 'tier')
    ),
    /* Premier child node: tier3 x premier_pct for the flagged items */
    premier AS (
      SELECT 'premier'::text, 'SN ' || c.rule_code || ' ' || public._fb_ladder_abbrev(c.ladder_code) || ' PREM',
             'SkyNet rule ' || c.rule_code || ' / ' || c.ladder_code || ' premier = tier3 x ' || v_pp,
             'Product Tree'::text, c.path || ':Premier', 'Percent'::text,
             round(public._pricing_multiplier(p_book, c.rule_code, c.ladder_code, 'tier3') * v_pp * 100, 4), 0::numeric,
             'Customer Group'::text, (SELECT g.group_name FROM public.fb_group_map g WHERE g.tier = 'premier'), false, 0::numeric, 0::numeric, 30
      FROM combos c
      WHERE c.has_premier AND public._pricing_multiplier(p_book, c.rule_code, c.ladder_code, 'tier3') IS NOT NULL
        AND EXISTS (SELECT 1 FROM live_groups lg WHERE lg.tier = 'premier')
    ),
    /* column groups: that column regardless of quantity, or Each (100%) where the ladder lacks it */
    cols AS (
      SELECT 'column'::text, 'SN ' || c.rule_code || ' ' || public._fb_ladder_abbrev(c.ladder_code) || ' C' || substr(g.tier, 2),
             'SkyNet rule ' || c.rule_code || ' / ' || c.ladder_code || ' column ' || g.tier,
             'Product Tree'::text, c.path, 'Percent'::text,
             COALESCE((SELECT round(public._pricing_multiplier(p_book, c.rule_code, c.ladder_code, g.tier) * 100, 4)
                       WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(c.columns) e WHERE e->>'key' = g.tier)), 100)::numeric,
             0::numeric, 'Customer Group'::text, g.group_name, false, 0::numeric, 0::numeric, 40
      FROM combos c
      JOIN live_groups g ON g.tier IN ('q100','q300','q500')
    ),
    /* ---- sets and kits, step 2: Fixed price rules on the product, from step 1's prices. Window functions
       give each row its kit's Each, the next quantity of its band and whether the group's price varies
       with quantity, in one sort instead of correlated scans of the set against itself. */
    kit_prices AS (
      SELECT x.item_id, x.product_num, x.tier, x.qty, x.price,
             max(x.price) FILTER (WHERE x.tier = 'none' AND x.qty = 1) OVER (PARTITION BY x.item_id) AS each_price,
             lead(x.qty) OVER (PARTITION BY x.item_id, x.tier ORDER BY x.qty) AS next_qty,
             COALESCE(max(round(x.price, 2)) OVER (PARTITION BY x.item_id, x.tier) <> min(round(x.price, 2)) OVER (PARTITION BY x.item_id, x.tier), false) AS banded
      FROM jsonb_to_recordset(v_kit_prices) AS x(item_id uuid, product_num text, tier text, qty numeric, price numeric)
    ),
    /* All-customer bands: emitted only where the band price differs from the kit's Each */
    kit_breaks AS (
      SELECT 'kit_break'::text, 'SN K ' || p.product_num || ' Q' || p.qty, 'SkyNet kit ' || p.product_num || ' qty ' || p.qty || '+',
             'Product'::text, p.product_num, 'Fixed price'::text, 0::numeric, round(p.price, 2), 'All'::text, ''::text,
             true, p.qty, COALESCE(p.next_qty - 1, 0), 50
      FROM kit_prices p
      WHERE p.tier = 'none' AND p.qty > 1 AND p.price IS NOT NULL AND round(p.price, 2) <> round(p.each_price, 2)
    ),
    /* tier groups: one rule when the kit price is quantity-free for that tier (the usual case), else banded */
    kit_tiers AS (
      SELECT 'kit_tier'::text,
             'SN K ' || p.product_num || ' ' || CASE p.tier WHEN 'tier1' THEN 'T1' WHEN 'tier2' THEN 'T2' WHEN 'tier3' THEN 'T3' ELSE 'PR' END || CASE WHEN p.banded THEN ' Q' || p.qty ELSE '' END,
             'SkyNet kit ' || p.product_num || ' ' || p.tier || CASE WHEN p.banded THEN ' qty ' || p.qty || '+' ELSE '' END,
             'Product'::text, p.product_num, 'Fixed price'::text, 0::numeric, round(p.price, 2), 'Customer Group'::text, g.group_name,
             p.banded, CASE WHEN p.banded THEN p.qty ELSE 0 END,
             CASE WHEN p.banded THEN COALESCE(p.next_qty - 1, 0) ELSE 0 END, 60
      FROM kit_prices p
      JOIN live_groups g ON g.tier = p.tier
      WHERE p.tier IN ('tier1','tier2','tier3','premier') AND p.price IS NOT NULL AND (p.banded OR p.qty = 1)
    ),
    /* column groups on kits: quantity-free by construction */
    kit_cols AS (
      SELECT 'kit_column'::text, 'SN K ' || p.product_num || ' C' || substr(p.tier, 2), 'SkyNet kit ' || p.product_num || ' column ' || p.tier,
             'Product'::text, p.product_num, 'Fixed price'::text, 0::numeric, round(p.price, 2), 'Customer Group'::text, g.group_name, false, 0::numeric, 0::numeric, 70
      FROM kit_prices p
      JOIN live_groups g ON g.tier = p.tier
      WHERE p.tier IN ('q100','q300','q500') AND p.qty = 1 AND p.price IS NOT NULL
    ),
    /* ---- customer x part exceptions open on the date --------------------------------------- */
    exceptions AS (
      SELECT 'exception'::text, 'SN X ' || e.fb_customer_id || ' ' || f.product_num,
             'SkyNet exception ' || c.name_clean || ' ' || f.product_num || ' ' || e.mode || ' ' || e.value,
             'Product'::text, f.product_num,
             CASE e.mode WHEN 'fixed' THEN 'Fixed price' ELSE 'Percent' END,
             CASE e.mode WHEN 'fixed' THEN 0 ELSE round(public._pricing_multiplier(p_book, i.rule_code, i.ladder_code, 'tier3') * e.value * 100, 4) END,
             CASE e.mode WHEN 'fixed' THEN round(e.value, 2) ELSE 0 END,
             'Customer'::text, c.name, false, 0::numeric, 0::numeric, 80
      FROM public.price_exceptions e
      JOIN public.fb_customers c ON c.fb_customer_id = e.fb_customer_id AND c.removed_at IS NULL
      JOIN public.price_items i ON i.book_id = p_book AND i.part_key = e.part_key AND i.status = 'priced'
      JOIN public.fb_products f ON f.product_key = e.part_key AND f.removed_at IS NULL
      WHERE e.effective_from <= p_as_of AND (e.effective_to IS NULL OR e.effective_to > p_as_of)
        AND (e.mode = 'fixed' OR public._pricing_multiplier(p_book, i.rule_code, i.ladder_code, 'tier3') IS NOT NULL)
    ),
    all_rows (kind, name, description, product_incl_type, product, pa_type, pa_percent, pa_amount, customer_incl_type, customer, qty_applies, qty_min, qty_max, sort) AS (
      SELECT * FROM eaches UNION ALL SELECT * FROM breaks UNION ALL SELECT * FROM tiers UNION ALL SELECT * FROM premier UNION ALL SELECT * FROM cols
      UNION ALL SELECT * FROM kit_breaks UNION ALL SELECT * FROM kit_tiers UNION ALL SELECT * FROM kit_cols UNION ALL SELECT * FROM exceptions
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.sort, a.name), '[]'::jsonb) FROM all_rows a
  );

  /* ---- guards ------------------------------------------------------------------------------ */
  v_dup := (SELECT COUNT(*) - COUNT(DISTINCT r->>'name') FROM jsonb_array_elements(v_rows) r);
  IF v_dup > 0 THEN RAISE EXCEPTION 'pricing_fb_expected_rules: % duplicate rule name(s)', v_dup; END IF;
  v_long := (SELECT COUNT(*) FROM jsonb_array_elements(v_rows) r WHERE length(r->>'name') > 30);
  IF v_long > 0 THEN RAISE EXCEPTION 'pricing_fb_expected_rules: % rule name(s) over 30 characters', v_long; END IF;

  RETURN QUERY
  SELECT x.kind, x.name, x.description, true, x.product_incl_type, x.product,
         true, x.pa_type, x.pa_percent, 'Product Price'::text, x.pa_amount,
         true, 'Round to nearest'::text, 0.01::numeric, false, 0::numeric,
         x.customer_incl_type, x.customer, false, '01/01/1000'::text, '01/01/3000'::text,
         x.qty_applies, x.qty_min, x.qty_max, true, false
  FROM jsonb_to_recordset(v_rows) AS x(kind text, name text, description text, product_incl_type text, product text, pa_type text, pa_percent numeric, pa_amount numeric,
                                       customer_incl_type text, customer text, qty_applies boolean, qty_min numeric, qty_max numeric, sort int)
  ORDER BY x.sort, x.name;
END $$;

CREATE OR REPLACE VIEW public.v_fb_price_drift AS
WITH b AS (SELECT public.pricing_book_for_date(CURRENT_DATE) AS id),
e AS (SELECT * FROM public.pricing_fb_expected_products((SELECT id FROM b), true))
SELECT e.product_num, e.kind, e.price AS book_price, trim_scale(round(f.list_price, 4)) AS fb_price,
       round(f.list_price, 4) - e.price AS delta,
       CASE WHEN round(f.list_price, 4) = e.price THEN 'in_sync' WHEN f.list_price = 0 THEN 'fb_zero' ELSE 'mismatch' END AS state
FROM e JOIN public.fb_products f ON f.product_num = e.product_num AND f.removed_at IS NULL
UNION ALL
SELECT i.part_number, CASE WHEN i.status = 'component_sum' THEN 'kit' WHEN s.kind = 'resale' THEN 'resale' ELSE 'catalog' END, round(p.unit_price, 2), NULL, NULL, 'not_in_fishbowl'
FROM public.price_items i
JOIN public.price_sections s ON s.id = i.section_id
JOIN public.pricing_item_prices((SELECT id FROM b)) p ON p.item_id = i.id AND p.col_key = 'each'
WHERE i.book_id = (SELECT id FROM b) AND i.status IN ('priced','component_sum') AND p.unit_price IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.fb_products f WHERE f.product_key = i.part_key AND f.removed_at IS NULL);

CREATE OR REPLACE FUNCTION public.pricing_fb_sync_status(p_as_of date DEFAULT CURRENT_DATE)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_book uuid; v_products jsonb; v_rules jsonb; v_tree jsonb; v_groups jsonb; v_state public.fb_sync_state;
        v_q jsonb; v_last jsonb; v_in_sync boolean; v_tree_loaded boolean; v_rules_loaded boolean;
BEGIN
  PERFORM public._pricing_gate(public._pricing_view_roles());
  v_book := public.pricing_book_for_date(p_as_of);
  IF v_book IS NULL THEN RETURN jsonb_build_object('as_of', p_as_of, 'book', NULL, 'in_sync', false, 'reason', 'no book effective'); END IF;
  v_state := (SELECT s FROM public.fb_sync_state s WHERE s.id = 1);
  v_rules_loaded := v_state.last_rules_at IS NOT NULL;
  v_tree_loaded := v_state.last_tree_at IS NOT NULL;

  /* one pricing_item_prices pass (it is the expensive part): the same rows and prices pricing_fb_expected_products returns */
  v_products := (
    WITH all_each AS MATERIALIZED (
           SELECT i.id, i.part_number, i.part_key, i.status, s.kind AS section_kind, p.unit_price,
                  CASE WHEN s.kind = 'catalog' AND i.status = 'priced' AND jsonb_array_length(COALESCE(l.columns, '[]'::jsonb)) > 0 AND EXISTS (SELECT 1 FROM public.price_rules r WHERE r.book_id = i.book_id AND r.code = i.rule_code)
                       THEN trim_scale(round(i.list_price, 4)) ELSE round(p.unit_price, 2) END AS exp_price
           FROM public.price_items i JOIN public.price_sections s ON s.id = i.section_id
           JOIN public.pricing_item_prices(v_book) p ON p.item_id = i.id AND p.col_key = 'each'
           LEFT JOIN public.price_ladders l ON l.book_id = i.book_id AND l.code = i.ladder_code
           WHERE i.book_id = v_book AND i.status IN ('priced','component_sum') AND p.unit_price IS NOT NULL),
         fbj AS MATERIALIZED (
           SELECT a.part_key, a.status, a.section_kind, a.exp_price AS price, f.product_num, f.list_price, trim_scale(round(f.list_price, 4)) AS fb_price
           FROM all_each a JOIN public.fb_products f ON f.product_key = a.part_key AND f.removed_at IS NULL),
         e AS (SELECT * FROM fbj WHERE section_kind <> 'resale'),
         r AS (SELECT * FROM fbj WHERE section_kind = 'resale' AND status <> 'component_sum')
    SELECT jsonb_build_object(
      'expected', (SELECT COUNT(*) FROM e),
      'in_sync', (SELECT COUNT(*) FROM e WHERE e.fb_price = e.price),
      'mismatched', (SELECT COUNT(*) FROM e WHERE e.fb_price <> e.price AND e.list_price <> 0),
      'fb_zero', (SELECT COUNT(*) FROM e WHERE e.list_price = 0 AND e.price <> 0),
      'not_in_fishbowl', (SELECT COUNT(*) FROM all_each a WHERE a.section_kind <> 'resale' AND NOT EXISTS (SELECT 1 FROM public.fb_products f WHERE f.product_key = a.part_key AND f.removed_at IS NULL)),
      'resale_drift', (SELECT COUNT(*) FROM r WHERE r.fb_price <> r.price),
      'kits_unresolved', (SELECT COUNT(*) FROM public.price_items i WHERE i.book_id = v_book AND i.status = 'component_sum'
                          AND NOT EXISTS (SELECT 1 FROM all_each a WHERE a.id = i.id)),
      'sample_mismatch', (SELECT jsonb_agg(x) FROM (SELECT e.product_num AS p, e.price AS book, e.fb_price AS fb FROM e WHERE e.fb_price <> e.price ORDER BY abs(e.fb_price - e.price) DESC LIMIT 10) x)));

  v_rules := (
    WITH e AS (SELECT * FROM public.pricing_fb_expected_rules(v_book, p_as_of)),
         m AS (SELECT * FROM public.fb_pricing_rules WHERE removed_at IS NULL),
         j AS (SELECT e.name AS ename, m.name AS mname, m.is_active,
                      (m.product_incl_type IS DISTINCT FROM e.product_incl_type OR m.product IS DISTINCT FROM e.product
                       OR m.customer_incl_type IS DISTINCT FROM e.customer_incl_type OR COALESCE(m.customer,'') IS DISTINCT FROM COALESCE(e.customer,'')
                       OR m.pa_type IS DISTINCT FROM e.pa_type
                       OR round(COALESCE(m.pa_percent,0),4) IS DISTINCT FROM round(COALESCE(e.pa_percent,0),4)
                       OR round(COALESCE(m.pa_amount,0),2) IS DISTINCT FROM round(COALESCE(e.pa_amount,0),2)
                       OR COALESCE(m.qty_applies,false) IS DISTINCT FROM e.qty_applies
                       OR (e.qty_applies AND (COALESCE(m.qty_min,0) IS DISTINCT FROM e.qty_min OR COALESCE(m.qty_max,0) IS DISTINCT FROM e.qty_max))
                       OR COALESCE(m.rnd_applies,false) IS DISTINCT FROM e.rnd_applies
                       OR (e.rnd_applies AND (m.round_type IS DISTINCT FROM e.round_type OR round(COALESCE(m.rnd_to_amount,0),4) IS DISTINCT FROM e.rnd_to_amount
                                              OR round(COALESCE(m.rnd_pm_amount,0),4) IS DISTINCT FROM e.rnd_pm_amount))) AS differs
               FROM e FULL OUTER JOIN m ON m.name = e.name)
    SELECT jsonb_build_object(
      'loaded', v_rules_loaded,
      'expected', (SELECT COUNT(*) FROM e),
      'by_kind', (SELECT jsonb_object_agg(k.kind, k.n) FROM (SELECT e.kind, COUNT(*) n FROM e GROUP BY e.kind) k),
      'in_sync', (SELECT COUNT(*) FROM j WHERE ename IS NOT NULL AND mname IS NOT NULL AND is_active AND NOT differs),
      'mismatched', (SELECT COUNT(*) FROM j WHERE ename IS NOT NULL AND mname IS NOT NULL AND is_active AND differs),
      'inactive_in_fb', (SELECT COUNT(*) FROM j WHERE ename IS NOT NULL AND mname IS NOT NULL AND NOT is_active),
      'missing', (SELECT COUNT(*) FROM j WHERE ename IS NOT NULL AND mname IS NULL),
      'legacy_active', (SELECT COUNT(*) FROM j WHERE ename IS NULL AND is_active AND mname NOT LIKE 'SN %'),
      'extra_sn_active', (SELECT COUNT(*) FROM j WHERE ename IS NULL AND is_active AND mname LIKE 'SN %')));

  v_tree := (
    WITH e AS (SELECT * FROM public.pricing_fb_expected_tree(v_book))
    SELECT jsonb_build_object(
      'loaded', v_tree_loaded,
      'expected', (SELECT COUNT(*) FROM e WHERE e.in_fishbowl),
      'in_sync', (SELECT COUNT(*) FROM e WHERE e.in_fishbowl AND EXISTS (SELECT 1 FROM public.fb_product_tree t WHERE t.product_key = e.part_key AND t.path = e.path AND t.removed_at IS NULL)),
      'missing', (SELECT COUNT(*) FROM e WHERE e.in_fishbowl AND NOT EXISTS (SELECT 1 FROM public.fb_product_tree t WHERE t.product_key = e.part_key AND t.path = e.path AND t.removed_at IS NULL)),
      'not_in_fishbowl', (SELECT COUNT(*) FROM e WHERE NOT e.in_fishbowl),
      'categories_expected', (SELECT COUNT(*) FROM public.pricing_fb_expected_categories(v_book)),
      'categories_missing', (SELECT COUNT(*) FROM public.pricing_fb_expected_categories(v_book) c WHERE NOT EXISTS (SELECT 1 FROM public.fb_product_tree_nodes n WHERE n.path = c.full_path AND n.removed_at IS NULL))));

  v_groups := (
    WITH e AS (SELECT * FROM public.pricing_fb_expected_groups(p_as_of)),
         m AS (SELECT c.fb_customer_id, g.group_name FROM public.fb_customers c JOIN public.fb_group_map g ON g.group_name = ANY(COALESCE(c.account_groups, '{}')) WHERE c.removed_at IS NULL)
    SELECT jsonb_build_object(
      'expected', (SELECT COUNT(*) FROM e),
      'in_sync', (SELECT COUNT(*) FROM e JOIN m ON m.fb_customer_id = e.fb_customer_id AND m.group_name = e.group_name),
      'missing', (SELECT COUNT(*) FROM e WHERE NOT EXISTS (SELECT 1 FROM m WHERE m.fb_customer_id = e.fb_customer_id AND m.group_name = e.group_name)),
      'extra_in_fb', (SELECT COUNT(*) FROM m WHERE NOT EXISTS (SELECT 1 FROM e WHERE m.fb_customer_id = e.fb_customer_id AND m.group_name = e.group_name))));

  v_q := (SELECT jsonb_build_object('queued', COUNT(*) FILTER (WHERE status = 'queued'), 'running', COUNT(*) FILTER (WHERE status = 'running')) FROM public.fb_push_commands);
  /* last REAL push per kind: dry runs, asked for or forced by the bridge's gate, are history, not pushes */
  v_last := (SELECT jsonb_object_agg(x.kind, x.j) FROM (
               SELECT DISTINCT ON (c.kind) c.kind, jsonb_build_object('id', c.id, 'status', c.status, 'rows', c.row_count,
                        'finished_at', c.finished_at, 'error', c.error, 'book_id', c.book_id) j
               FROM public.fb_push_commands c
               WHERE c.status IN ('done','failed') AND NOT (c.dry_run OR COALESCE((c.result->>'dry_run')::boolean, false))
               ORDER BY c.kind, c.id DESC) x);

  v_in_sync := (v_products->>'mismatched')::int = 0 AND (v_products->>'fb_zero')::int = 0
           AND v_rules_loaded AND (v_rules->>'mismatched')::int = 0 AND (v_rules->>'missing')::int = 0 AND (v_rules->>'legacy_active')::int = 0
           AND (v_rules->>'inactive_in_fb')::int = 0 AND (v_rules->>'extra_sn_active')::int = 0
           AND v_tree_loaded AND (v_tree->>'missing')::int = 0
           AND (v_groups->>'missing')::int = 0 AND (v_groups->>'extra_in_fb')::int = 0;

  RETURN jsonb_build_object(
    'as_of', p_as_of,
    'book', (SELECT jsonb_build_object('id', b.id, 'rev_label', b.rev_label, 'status', b.status, 'effective_from', b.effective_from) FROM public.price_books b WHERE b.id = v_book),
    'mirrors', jsonb_build_object('products_at', v_state.last_products_at, 'rules_at', v_state.last_rules_at, 'tree_at', v_state.last_tree_at,
                                  'customers_at', v_state.last_customers_at, 'heartbeat_at', v_state.last_heartbeat_at, 'bridge_version', v_state.bridge_version,
                                  'last_push_at', v_state.last_push_at, 'last_push_kind', v_state.last_push_kind),
    'products', v_products, 'rules', v_rules, 'tree', v_tree, 'groups', v_groups,
    'queue', v_q, 'last_push', COALESCE(v_last, '{}'::jsonb),
    'in_sync', v_in_sync);
END $$;

CREATE OR REPLACE FUNCTION public.fb_push_enqueue(p_kind text, p_book uuid DEFAULT NULL, p_options jsonb DEFAULT '{}'::jsonb,
                                                  p_dry_run boolean DEFAULT false, p_note text DEFAULT NULL, p_as_of date DEFAULT CURRENT_DATE)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_book uuid; v_payload jsonb; v_rows int; v_id bigint; v_import text; v_only_changed boolean; v_retire boolean; v_resale boolean;
BEGIN
  PERFORM public._pricing_gate(ARRAY['admin','integration']);
  IF p_kind NOT IN ('prices','rules','tree','groups') THEN RAISE EXCEPTION 'fb_push_enqueue: unknown kind %', p_kind; END IF;
  v_book := COALESCE(p_book, public.pricing_book_for_date(p_as_of));
  IF v_book IS NULL THEN RAISE EXCEPTION 'fb_push_enqueue: no book effective on %', p_as_of; END IF;
  IF EXISTS (SELECT 1 FROM public.fb_push_commands WHERE kind = p_kind AND status IN ('queued','running')) THEN
    RAISE EXCEPTION 'fb_push_enqueue: a % command is already queued or running', p_kind;
  END IF;
  v_only_changed := COALESCE((p_options->>'only_changed')::boolean, true);
  v_retire := COALESCE((p_options->>'retire_legacy')::boolean, false);
  v_resale := COALESCE((p_options->>'include_resale')::boolean, false);

  IF p_kind = 'prices' THEN
    /* Fishbowl's Product Pricing import (list prices only): columns Product, Price -- the same header as its
       Product Pricing export. NOT the Product import, which creates/edits whole products and needs PartNumber
       first (PROD 2026-09-25: it read a ProductNumber header as a part number and rejected the file). */
    v_import := 'Product-Pricing';
    v_payload := (
      SELECT jsonb_build_array(jsonb_build_array('Product', 'Price')) || COALESCE(jsonb_agg(jsonb_build_array(e.product_num, trim_scale(e.price)::text) ORDER BY e.product_num), '[]'::jsonb)
      FROM public.pricing_fb_expected_products(v_book, v_resale) e
      /* join on the product NUMBER, which Fishbowl keeps unique: two products can share a key
         ('SK-N114-2S' / 'SK-N114 -2S'), and a key join would send each of them twice */
      JOIN public.fb_products f ON f.product_num = e.product_num AND f.removed_at IS NULL
      WHERE (NOT v_only_changed OR round(f.list_price, 4) IS DISTINCT FROM e.price)
        /* only_products: an explicit list (smoke tests: push one product) */
        AND (p_options->'only_products' IS NULL
             OR e.part_key IN (SELECT upper(regexp_replace(x, '\s', '', 'g')) FROM jsonb_array_elements_text(p_options->'only_products') x)));
  ELSIF p_kind = 'rules' THEN
    v_import := 'Pricing-Rules';
    v_payload := (
      WITH e AS (SELECT * FROM public.pricing_fb_expected_rules(v_book, p_as_of)),
      rows_out AS (
        SELECT e.name AS sort_name, jsonb_build_array(e.name, e.description, 'true', e.product_incl_type, e.product, 'true', e.pa_type, public._fb_pct(e.pa_percent), e.pa_base_amount_type, public._fb_money(e.pa_amount),
                 'true', e.round_type, public._fb_money(e.rnd_to_amount), 'false', public._fb_money(e.rnd_pm_amount), e.customer_incl_type, e.customer, 'false', e.date_begin, e.date_end,
                 CASE WHEN e.qty_applies THEN 'true' ELSE 'false' END, e.qty_min::text, e.qty_max::text, 'true', 'false') AS j
        FROM e
        LEFT JOIN public.fb_pricing_rules m ON m.name = e.name AND m.removed_at IS NULL
        WHERE NOT v_only_changed OR m.fb_rule_id IS NULL OR NOT m.is_active
           OR m.product_incl_type IS DISTINCT FROM e.product_incl_type OR m.product IS DISTINCT FROM e.product
           OR m.customer_incl_type IS DISTINCT FROM e.customer_incl_type OR COALESCE(m.customer,'') IS DISTINCT FROM COALESCE(e.customer,'')
           OR m.pa_type IS DISTINCT FROM e.pa_type OR round(COALESCE(m.pa_percent,0),4) IS DISTINCT FROM round(COALESCE(e.pa_percent,0),4)
           OR round(COALESCE(m.pa_amount,0),2) IS DISTINCT FROM round(COALESCE(e.pa_amount,0),2)
           OR COALESCE(m.qty_applies,false) IS DISTINCT FROM e.qty_applies
           OR (e.qty_applies AND (COALESCE(m.qty_min,0) IS DISTINCT FROM e.qty_min OR COALESCE(m.qty_max,0) IS DISTINCT FROM e.qty_max))
           OR COALESCE(m.rnd_applies,false) IS DISTINCT FROM e.rnd_applies
           OR (e.rnd_applies AND (m.round_type IS DISTINCT FROM e.round_type OR round(COALESCE(m.rnd_to_amount,0),4) IS DISTINCT FROM e.rnd_to_amount
                                  OR round(COALESCE(m.rnd_pm_amount,0),4) IS DISTINCT FROM e.rnd_pm_amount))
        UNION ALL
        /* deactivate, re-sent unchanged with isActive false: every active 'SN ' rule SkyNet no longer expects
           (a closed exception, a kit gone from the book, a band that changed name on a new book) -- always,
           because SkyNet owns those names -- and, with retire_legacy, every other active rule */
        SELECT 'zz ' || m.name, jsonb_build_array(m.name, COALESCE(m.description, ''), 'false', m.product_incl_type, COALESCE(m.product, ''), CASE WHEN m.pa_applies THEN 'true' ELSE 'false' END, m.pa_type,
                 public._fb_pct(COALESCE(m.pa_percent, 0)), COALESCE(m.pa_base_amount_type, 'Product Price'), public._fb_money(COALESCE(m.pa_amount, 0)),
                 CASE WHEN m.rnd_applies THEN 'true' ELSE 'false' END, COALESCE(m.round_type, 'Round to nearest'), public._fb_money(COALESCE(m.rnd_to_amount, 0.01)), CASE WHEN m.rnd_is_minus THEN 'true' ELSE 'false' END, public._fb_money(COALESCE(m.rnd_pm_amount, 0)),
                 m.customer_incl_type, COALESCE(m.customer, ''), 'false', '01/01/1000', '01/01/3000',
                 CASE WHEN m.qty_applies THEN 'true' ELSE 'false' END, COALESCE(m.qty_min, 0)::text, COALESCE(m.qty_max, 0)::text, CASE WHEN m.is_auto_apply THEN 'true' ELSE 'false' END, 'false')
        FROM public.fb_pricing_rules m
        WHERE m.removed_at IS NULL AND m.is_active AND NOT EXISTS (SELECT 1 FROM e WHERE e.name = m.name)
          AND (m.name LIKE 'SN %' OR v_retire))
      SELECT jsonb_build_array(jsonb_build_array('name','description','isActive','productInclType','product','paApplies','paType','paPercent','paBaseAmountType','paAmount',
                                                 'rndApplies','roundType','rndToAmount','rndIsMinus','rndPMAmount','customerInclType','customer','dateApplies','dateBegin','dateEnd',
                                                 'qtyApplies','qtyMin','qtyMax','isAutoApply','isTier2'))
             || COALESCE(jsonb_agg(r.j ORDER BY r.sort_name), '[]'::jsonb)
      FROM rows_out r);
  ELSIF p_kind = 'tree' THEN
    v_import := 'Product-Tree-Categories+Product-Tree';
    v_payload := jsonb_build_object(
      'categories', (SELECT jsonb_build_array(jsonb_build_array('Name','Description','Path')) || COALESCE(jsonb_agg(jsonb_build_array(c.name, c.description, c.path) ORDER BY c.full_path), '[]'::jsonb)
                     FROM public.pricing_fb_expected_categories(v_book) c
                     WHERE NOT v_only_changed OR NOT EXISTS (SELECT 1 FROM public.fb_product_tree_nodes n WHERE n.path = c.full_path AND n.removed_at IS NULL)),
      'members', (SELECT jsonb_build_array(jsonb_build_array('ProductNumber','Path')) || COALESCE(jsonb_agg(jsonb_build_array(t.product_num, t.path) ORDER BY t.path, t.product_num), '[]'::jsonb)
                  FROM public.pricing_fb_expected_tree(v_book) t
                  WHERE t.in_fishbowl AND (NOT v_only_changed OR NOT EXISTS (SELECT 1 FROM public.fb_product_tree x WHERE x.product_key = t.part_key AND x.path = t.path AND x.removed_at IS NULL))));
  ELSE
    v_import := 'Customer-Group-Relations';
    v_payload := (SELECT jsonb_build_array(jsonb_build_array('CustomerName','CustomerGroupName')) || COALESCE(jsonb_agg(jsonb_build_array(g.customer_name, g.group_name) ORDER BY g.group_name, g.customer_name), '[]'::jsonb)
                  FROM public.pricing_fb_expected_groups(p_as_of) g
                  LEFT JOIN public.fb_customers c ON c.fb_customer_id = g.fb_customer_id
                  WHERE NOT v_only_changed OR NOT (g.group_name = ANY(COALESCE(c.account_groups, '{}'))));
  END IF;

  v_rows := CASE WHEN p_kind = 'tree' THEN (jsonb_array_length(v_payload->'categories') - 1) + (jsonb_array_length(v_payload->'members') - 1)
                 ELSE jsonb_array_length(v_payload) - 1 END;
  v_id := nextval('public.fb_push_commands_id_seq');
  INSERT INTO public.fb_push_commands (id, kind, book_id, as_of, dry_run, options, import_name, payload, row_count, requested_by, note)
  VALUES (v_id, p_kind, v_book, p_as_of, p_dry_run, COALESCE(p_options, '{}'::jsonb), v_import, v_payload, v_rows, auth.uid(), p_note);
  RETURN v_id;
END $$;

/* read back: expect expected_rules 324 (each 38 + the 286 already in Fishbowl), three_dp_prices ~2,630,
   rules_to_push 38, prices_to_push ~2,630, markers all true */
SELECT jsonb_build_object(
  'expected_rules', (SELECT count(*) FROM public.pricing_fb_expected_rules(public.pricing_book_for_date(CURRENT_DATE), CURRENT_DATE)),
  'each_rules', (SELECT count(*) FROM public.pricing_fb_expected_rules(public.pricing_book_for_date(CURRENT_DATE), CURRENT_DATE) WHERE kind = 'each'),
  'three_dp_prices', (SELECT count(*) FROM public.pricing_fb_expected_products(public.pricing_book_for_date(CURRENT_DATE), false) WHERE price <> round(price, 2)),
  'rules_to_push', (SELECT (s->'rules'->>'missing')::int FROM public.pricing_fb_sync_status(CURRENT_DATE) s),
  'prices_to_push', (SELECT (s->'products'->>'mismatched')::int FROM public.pricing_fb_sync_status(CURRENT_DATE) s),
  'markers', (SELECT jsonb_build_object(
      'products', (SELECT prosrc LIKE '%trim_scale(round(i.list_price, 4))%' FROM pg_proc WHERE proname = 'pricing_fb_expected_products' AND pronamespace = 'public'::regnamespace),
      'rules', (SELECT prosrc LIKE '%eaches AS (%' FROM pg_proc WHERE proname = 'pricing_fb_expected_rules' AND pronamespace = 'public'::regnamespace),
      'status', (SELECT prosrc LIKE '%exp_price%' FROM pg_proc WHERE proname = 'pricing_fb_sync_status' AND pronamespace = 'public'::regnamespace),
      'enqueue', (SELECT prosrc LIKE '%round(f.list_price, 4) IS DISTINCT FROM e.price%' FROM pg_proc WHERE proname = 'fb_push_enqueue' AND pronamespace = 'public'::regnamespace),
      'view', (SELECT pg_get_viewdef('public.v_fb_price_drift'::regclass) LIKE '%round(f.list_price, 4)%')))
) AS verify;
