/* ============================================================================================
   2026-09-25_D-PRICE-53_product_pricing_import_fix.sql   (PROD SQL Editor: paste the whole file, Run)
   The prices push used Fishbowl's "Product" import, which creates/edits whole products and needs PartNumber
   first; it read our ProductNumber header as a part number and rejected the file (command #1, 2026-09-25).
   List prices belong to the "Product Pricing" import: columns Product, Price -- the header of Fishbowl's own
   Product Pricing export. This replaces fb_push_enqueue with that header (and labels commands
   Product-Pricing). Grants are kept by CREATE OR REPLACE. Pair it with FB_IMPORT_PRODUCT=Product-Pricing in
   skyserver's .env. The last statement reads the change back: expect product_pricing_header = true.
   ============================================================================================ */
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
      SELECT jsonb_build_array(jsonb_build_array('Product', 'Price')) || COALESCE(jsonb_agg(jsonb_build_array(e.product_num, e.price::text) ORDER BY e.product_num), '[]'::jsonb)
      FROM public.pricing_fb_expected_products(v_book, v_resale) e
      /* join on the product NUMBER, which Fishbowl keeps unique: two products can share a key
         ('SK-N114-2S' / 'SK-N114 -2S'), and a key join would send each of them twice */
      JOIN public.fb_products f ON f.product_num = e.product_num AND f.removed_at IS NULL
      WHERE (NOT v_only_changed OR round(f.list_price, 2) IS DISTINCT FROM e.price)
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
        /* retire: every active rule Fishbowl holds that SkyNet does not own, re-sent unchanged with isActive FALSE */
        SELECT 'zz ' || m.name, jsonb_build_array(m.name, COALESCE(m.description, ''), 'false', m.product_incl_type, COALESCE(m.product, ''), CASE WHEN m.pa_applies THEN 'true' ELSE 'false' END, m.pa_type,
                 public._fb_pct(COALESCE(m.pa_percent, 0)), COALESCE(m.pa_base_amount_type, 'Product Price'), public._fb_money(COALESCE(m.pa_amount, 0)),
                 CASE WHEN m.rnd_applies THEN 'true' ELSE 'false' END, COALESCE(m.round_type, 'Round to nearest'), public._fb_money(COALESCE(m.rnd_to_amount, 0.01)), CASE WHEN m.rnd_is_minus THEN 'true' ELSE 'false' END, public._fb_money(COALESCE(m.rnd_pm_amount, 0)),
                 m.customer_incl_type, COALESCE(m.customer, ''), 'false', '01/01/1000', '01/01/3000',
                 CASE WHEN m.qty_applies THEN 'true' ELSE 'false' END, COALESCE(m.qty_min, 0)::text, COALESCE(m.qty_max, 0)::text, CASE WHEN m.is_auto_apply THEN 'true' ELSE 'false' END, 'false')
        FROM public.fb_pricing_rules m
        WHERE v_retire AND m.removed_at IS NULL AND m.is_active AND m.name NOT LIKE 'SN %' AND NOT EXISTS (SELECT 1 FROM e WHERE e.name = m.name))
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

SELECT (SELECT prosrc LIKE '%jsonb_build_array(''Product'', ''Price'')%' FROM pg_proc WHERE proname = 'fb_push_enqueue' AND pronamespace = 'public'::regnamespace) AS product_pricing_header,
       (SELECT prosrc LIKE '%f.product_num = e.product_num%' FROM pg_proc WHERE proname = 'fb_push_enqueue' AND pronamespace = 'public'::regnamespace) AS product_num_join_kept,
       (SELECT prosrc LIKE '%_fb_pct(e.pa_percent)%' FROM pg_proc WHERE proname = 'fb_push_enqueue' AND pronamespace = 'public'::regnamespace) AS rules_format_kept;
