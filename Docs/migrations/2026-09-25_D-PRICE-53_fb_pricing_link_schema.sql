/* ============================================================================================
   2026-09-25_D-PRICE-53_fb_pricing_link_schema.sql
   SkyNet <-> Fishbowl pricing link (Phase F, D-PRICE-24 delivered as D-PRICE-53) -- Batch A schema.

   Apply on TEST first, then PROD. Every block below is independently runnable: paste ONE block
   at a time into the Supabase SQL Editor (the Editor runs a whole sheet as a single transaction,
   so a RAISE in a later block would roll back earlier CREATEs). No select-into statements anywhere.
   Pure-ASCII block comments only. auth.uid() may be NULL in the Editor: every gate passes NULL.

   What this creates
     BLOCK 1  mirrors  : fb_pricing_rules, fb_product_tree_nodes, fb_product_tree (written by the bridge)
                         fb_group_map (SkyNet tier -> Fishbowl customer group name), fb_sync_state clocks
     BLOCK 2  queue    : fb_push_commands + fb_push_next / fb_push_finish / fb_push_cancel
     BLOCK 6b enqueue  : fb_push_enqueue (builds the import rows) / fb_push_auto (nightly book-change trigger)
     BLOCK 3  bridge   : fb_upsert_pricing_rules, fb_upsert_product_tree (integration RPCs)
     BLOCK 4  engine   : _fb_price_at (one item at one tier/qty, no exceptions), _fb_ladder_abbrev
     BLOCK 5  expected : pricing_fb_expected_products / _tree / _categories / _groups / _rules
     BLOCK 6  sync     : pricing_fb_sync_status(jsonb) + v_fb_price_drift / v_fb_rule_drift /
                         v_fb_tree_drift / v_fb_group_drift
     BLOCK 7  grants   : revoke PUBLIC/anon on every new function; views SELECT to authenticated only
     BLOCK 8  verify   : one read-back statement (expected counts in the block header)

   Rule model pushed to Fishbowl (D-PRICE-53)
     - quantity breaks   -> All-customer Percent rules on product-tree node Product:SkyNet:<rule>:<ladder>,
                            bounded qty ranges (min .. next-min-1, last one open)
     - tiers             -> Customer Group Percent rules (fb_group_map names), no quantity trigger;
                            a tier group on a ladder without that column falls back the way
                            pricing_get_price does (tier3 -> tier2 -> tier1)
     - Premier           -> group 'SkyNet Premier' gets the Tier 3 rules on every node plus tier3 x premier_pct
                            on the child node Product:SkyNet:<rule>:<ladder>:Premier (has_premier items live there)
     - column tiers      -> groups 'SkyNet Column 100/300/500' at that column, or 100% (Each) where the
                            ladder lacks it (D-PRICE-51 never worse, never better)
     - sets / kits       -> Fixed price rules on the product itself (component sums are mixed-rule, so no
                            single percent reproduces them): All-customer qty bands from the kit ladder,
                            one rule per tier/column group (bands collapsed when the price is quantity-free)
     - exceptions        -> Customer x Product rules (pct_of_tier3 -> Percent, fixed -> Fixed price)
     - rounding          -> Round to nearest 0.01, +/- 0.00 (= round(x,2), Matt 2026-09-25)
     - names             -> every SkyNet-owned rule starts with 'SN ' (<= 30 chars); the push retires every
                            other active rule (isActive FALSE) when the command option retire_legacy is true
   ============================================================================================ */


/* ============================================================================================ */
/* BLOCK 1 -- mirrors, group map, sync clocks                                                     */
/* ============================================================================================ */
CREATE TABLE IF NOT EXISTS public.fb_pricing_rules (
  fb_rule_id           integer PRIMARY KEY,
  name                 text NOT NULL,
  description          text,
  is_active            boolean NOT NULL DEFAULT true,
  product_incl_type    text,            /* All | Product | Product Tree  (resolved name) */
  product              text,            /* product number, or the tree path Product:...  */
  customer_incl_type   text,            /* All | Customer | Customer Group (resolved name) */
  customer             text,            /* customer name or customer group name */
  pa_applies           boolean,
  pa_type              text,            /* Percent | Fixed price | Markdown | ... (resolved name) */
  pa_percent           numeric,
  pa_base_amount_type  text,
  pa_amount            numeric,
  rnd_applies          boolean,
  round_type           text,
  rnd_to_amount        numeric,
  rnd_is_minus         boolean,
  rnd_pm_amount        numeric,
  date_applies         boolean,
  date_begin           timestamptz,
  date_end             timestamptz,
  qty_applies          boolean,
  qty_min              numeric,
  qty_max              numeric,
  is_auto_apply        boolean,
  is_tier2             boolean,
  fb_date_created      timestamptz,
  fb_date_modified     timestamptz,
  synced_at            timestamptz NOT NULL DEFAULT now(),
  removed_at           timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS fb_pricing_rules_name_uniq ON public.fb_pricing_rules (name) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.fb_product_tree_nodes (
  fb_node_id   integer PRIMARY KEY,
  name         text NOT NULL,
  parent_id    integer,
  path         text NOT NULL,           /* Product:SkyNet:A:standard -- built by the bridge from parent_id */
  synced_at    timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz
);

CREATE TABLE IF NOT EXISTS public.fb_product_tree (
  fb_product_id integer NOT NULL,
  fb_node_id    integer NOT NULL,
  product_num   text NOT NULL,
  product_key   text GENERATED ALWAYS AS (upper(regexp_replace(product_num, '\s', '', 'g'))) STORED,
  path          text NOT NULL,
  synced_at     timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  PRIMARY KEY (fb_product_id, fb_node_id)
);
CREATE INDEX IF NOT EXISTS fb_product_tree_key_idx ON public.fb_product_tree (product_key) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.fb_group_map (
  tier        text PRIMARY KEY,
  group_name  text NOT NULL UNIQUE
);
INSERT INTO public.fb_group_map (tier, group_name) VALUES
  ('tier1',   'SkyNet Tier 1'),
  ('tier2',   'SkyNet Tier 2'),
  ('tier3',   'SkyNet Tier 3'),
  ('premier', 'SkyNet Premier'),
  ('q100',    'SkyNet Column 100'),
  ('q300',    'SkyNet Column 300'),
  ('q500',    'SkyNet Column 500')
ON CONFLICT (tier) DO NOTHING;

ALTER TABLE public.fb_sync_state
  ADD COLUMN IF NOT EXISTS last_rules_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_tree_at  timestamptz,
  ADD COLUMN IF NOT EXISTS last_push_at  timestamptz,
  ADD COLUMN IF NOT EXISTS last_push_kind text;

ALTER TABLE public.fb_pricing_rules      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_product_tree_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_product_tree       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_group_map          ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fb_pricing_rules_select_authenticated      ON public.fb_pricing_rules;
DROP POLICY IF EXISTS fb_product_tree_nodes_select_authenticated ON public.fb_product_tree_nodes;
DROP POLICY IF EXISTS fb_product_tree_select_authenticated       ON public.fb_product_tree;
DROP POLICY IF EXISTS fb_group_map_select_authenticated          ON public.fb_group_map;
CREATE POLICY fb_pricing_rules_select_authenticated      ON public.fb_pricing_rules      FOR SELECT TO authenticated USING (true);
CREATE POLICY fb_product_tree_nodes_select_authenticated ON public.fb_product_tree_nodes FOR SELECT TO authenticated USING (true);
CREATE POLICY fb_product_tree_select_authenticated       ON public.fb_product_tree       FOR SELECT TO authenticated USING (true);
CREATE POLICY fb_group_map_select_authenticated          ON public.fb_group_map          FOR SELECT TO authenticated USING (true);
REVOKE ALL ON TABLE public.fb_pricing_rules, public.fb_product_tree_nodes, public.fb_product_tree, public.fb_group_map FROM anon, public;
GRANT SELECT ON TABLE public.fb_pricing_rules, public.fb_product_tree_nodes, public.fb_product_tree, public.fb_group_map TO authenticated;


/* ============================================================================================ */
/* BLOCK 2 -- outbound command queue (D-PRICE-24: polled by the bridge, never pushed to)          */
/* ============================================================================================ */
CREATE TABLE IF NOT EXISTS public.fb_push_commands (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('prices','rules','tree','groups')),
  book_id       uuid,
  as_of         date NOT NULL DEFAULT CURRENT_DATE,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
  dry_run       boolean NOT NULL DEFAULT false,
  options       jsonb NOT NULL DEFAULT '{}'::jsonb,
  import_name   text NOT NULL,          /* Fishbowl import name with dashes, e.g. Pricing-Rules */
  payload       jsonb,                  /* [[header...],[row...],...] exactly what the bridge posts */
  row_count     integer,
  requested_by  uuid,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  bridge_host   text,
  result        jsonb,
  error         text,
  note          text
);
CREATE INDEX IF NOT EXISTS fb_push_commands_status_idx ON public.fb_push_commands (status, id);
ALTER TABLE public.fb_push_commands ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fb_push_commands_select_authenticated ON public.fb_push_commands;
CREATE POLICY fb_push_commands_select_authenticated ON public.fb_push_commands FOR SELECT TO authenticated USING (true);
REVOKE ALL ON TABLE public.fb_push_commands FROM anon, public;
GRANT SELECT ON TABLE public.fb_push_commands TO authenticated;
GRANT USAGE ON SEQUENCE public.fb_push_commands_id_seq TO authenticated;

/* Bridge claims the oldest queued command. One command runs at a time. */
CREATE OR REPLACE FUNCTION public.fb_push_next(p_host text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_id bigint; v_row public.fb_push_commands;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration','admin']);
  IF EXISTS (SELECT 1 FROM public.fb_push_commands WHERE status = 'running' AND started_at > now() - interval '30 minutes') THEN
    RETURN NULL;
  END IF;
  /* a command that has been 'running' for over 30 minutes is a crashed bridge: fail it so the queue moves */
  UPDATE public.fb_push_commands SET status = 'failed', finished_at = now(), error = 'bridge did not report back within 30 minutes'
   WHERE status = 'running' AND started_at <= now() - interval '30 minutes';
  v_id := (SELECT id FROM public.fb_push_commands WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED);
  IF v_id IS NULL THEN RETURN NULL; END IF;
  UPDATE public.fb_push_commands SET status = 'running', started_at = now(), bridge_host = p_host WHERE id = v_id;
  v_row := (SELECT c FROM public.fb_push_commands c WHERE c.id = v_id);
  RETURN jsonb_build_object('id', v_row.id, 'kind', v_row.kind, 'book_id', v_row.book_id, 'as_of', v_row.as_of,
                            'dry_run', v_row.dry_run, 'options', v_row.options, 'import_name', v_row.import_name,
                            'payload', v_row.payload, 'row_count', v_row.row_count);
END $$;

CREATE OR REPLACE FUNCTION public.fb_push_finish(p_id bigint, p_ok boolean, p_result jsonb DEFAULT NULL, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_kind text;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration','admin']);
  v_kind := (SELECT c.kind FROM public.fb_push_commands c WHERE c.id = p_id AND c.status = 'running');
  IF v_kind IS NULL THEN RAISE EXCEPTION 'fb_push_finish: command % is not running', p_id; END IF;
  UPDATE public.fb_push_commands
     SET status = CASE WHEN p_ok THEN 'done' ELSE 'failed' END, finished_at = now(), result = p_result, error = left(p_error, 2000)
   WHERE id = p_id AND status = 'running';
  IF p_ok THEN
    UPDATE public.fb_sync_state SET last_push_at = now(), last_push_kind = v_kind, updated_at = now() WHERE id = 1;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fb_push_cancel(p_id bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles());
  UPDATE public.fb_push_commands SET status = 'cancelled', finished_at = now() WHERE id = p_id AND status = 'queued';
  IF NOT FOUND THEN RAISE EXCEPTION 'fb_push_cancel: command % is not queued', p_id; END IF;
END $$;


/* ============================================================================================ */
/* BLOCK 3 -- bridge mirror RPCs (integration role). Rows arrive resolved to names by the bridge.  */
/* ============================================================================================ */
CREATE OR REPLACE FUNCTION public.fb_upsert_pricing_rules(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE n int;
BEGIN
  PERFORM public._pricing_gate(ARRAY['integration','admin']);
  /* a full snapshot every time: anything not in the payload is marked removed */
  UPDATE public.fb_pricing_rules SET removed_at = now()
   WHERE removed_at IS NULL AND jsonb_array_length(p_rows) > 0
     AND fb_rule_id NOT IN (SELECT (r->>'id')::int FROM jsonb_array_elements(p_rows) r);
  INSERT INTO public.fb_pricing_rules (fb_rule_id, name, description, is_active, product_incl_type, product, customer_incl_type, customer,
      pa_applies, pa_type, pa_percent, pa_base_amount_type, pa_amount, rnd_applies, round_type, rnd_to_amount, rnd_is_minus, rnd_pm_amount,
      date_applies, date_begin, date_end, qty_applies, qty_min, qty_max, is_auto_apply, is_tier2, fb_date_created, fb_date_modified, synced_at, removed_at)
  SELECT (r->>'id')::int, r->>'name', r->>'description', COALESCE((r->>'isActive')::boolean, true),
         r->>'productInclType', r->>'product', r->>'customerInclType', r->>'customer',
         (r->>'paApplies')::boolean, r->>'paType', (r->>'paPercent')::numeric, r->>'paBaseAmountType', (r->>'paAmount')::numeric,
         (r->>'rndApplies')::boolean, r->>'roundType', (r->>'rndToAmount')::numeric, (r->>'rndIsMinus')::boolean, (r->>'rndPMAmount')::numeric,
         (r->>'dateApplies')::boolean, (r->>'dateBegin')::timestamptz, (r->>'dateEnd')::timestamptz,
         (r->>'qtyApplies')::boolean, (r->>'qtyMin')::numeric, (r->>'qtyMax')::numeric,
         (r->>'isAutoApply')::boolean, (r->>'isTier2')::boolean, (r->>'dateCreated')::timestamptz, (r->>'dateLastModified')::timestamptz, now(), NULL
  FROM jsonb_array_elements(p_rows) r
  ON CONFLICT (fb_rule_id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, is_active = EXCLUDED.is_active,
    product_incl_type = EXCLUDED.product_incl_type, product = EXCLUDED.product, customer_incl_type = EXCLUDED.customer_incl_type, customer = EXCLUDED.customer,
    pa_applies = EXCLUDED.pa_applies, pa_type = EXCLUDED.pa_type, pa_percent = EXCLUDED.pa_percent, pa_base_amount_type = EXCLUDED.pa_base_amount_type, pa_amount = EXCLUDED.pa_amount,
    rnd_applies = EXCLUDED.rnd_applies, round_type = EXCLUDED.round_type, rnd_to_amount = EXCLUDED.rnd_to_amount, rnd_is_minus = EXCLUDED.rnd_is_minus, rnd_pm_amount = EXCLUDED.rnd_pm_amount,
    date_applies = EXCLUDED.date_applies, date_begin = EXCLUDED.date_begin, date_end = EXCLUDED.date_end,
    qty_applies = EXCLUDED.qty_applies, qty_min = EXCLUDED.qty_min, qty_max = EXCLUDED.qty_max,
    is_auto_apply = EXCLUDED.is_auto_apply, is_tier2 = EXCLUDED.is_tier2, fb_date_created = EXCLUDED.fb_date_created, fb_date_modified = EXCLUDED.fb_date_modified,
    synced_at = now(), removed_at = NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.fb_sync_state SET last_rules_at = now(), updated_at = now() WHERE id = 1;
  RETURN n;
END $$;

/* p_nodes: [{id, name, parentId, path}], p_members: [{productId, productNum, nodeId, path}]. Full snapshots. */
CREATE OR REPLACE FUNCTION public.fb_upsert_product_tree(p_nodes jsonb, p_members jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE n int;
BEGIN
  PERFORM public._pricing_gate(ARRAY['integration','admin']);
  UPDATE public.fb_product_tree_nodes SET removed_at = now()
   WHERE removed_at IS NULL AND jsonb_array_length(p_nodes) > 0
     AND fb_node_id NOT IN (SELECT (r->>'id')::int FROM jsonb_array_elements(p_nodes) r);
  INSERT INTO public.fb_product_tree_nodes (fb_node_id, name, parent_id, path, synced_at, removed_at)
  SELECT (r->>'id')::int, r->>'name', (r->>'parentId')::int, r->>'path', now(), NULL FROM jsonb_array_elements(p_nodes) r
  ON CONFLICT (fb_node_id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id, path = EXCLUDED.path, synced_at = now(), removed_at = NULL;

  UPDATE public.fb_product_tree t SET removed_at = now()
   WHERE t.removed_at IS NULL AND jsonb_array_length(p_members) > 0
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_members) r WHERE (r->>'productId')::int = t.fb_product_id AND (r->>'nodeId')::int = t.fb_node_id);
  INSERT INTO public.fb_product_tree (fb_product_id, fb_node_id, product_num, path, synced_at, removed_at)
  SELECT DISTINCT ON ((r->>'productId')::int, (r->>'nodeId')::int) (r->>'productId')::int, (r->>'nodeId')::int, r->>'productNum', r->>'path', now(), NULL
  FROM jsonb_array_elements(p_members) r
  ON CONFLICT (fb_product_id, fb_node_id) DO UPDATE SET product_num = EXCLUDED.product_num, path = EXCLUDED.path, synced_at = now(), removed_at = NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.fb_sync_state SET last_tree_at = now(), updated_at = now() WHERE id = 1;
  RETURN n;
END $$;


/* ============================================================================================ */
/* BLOCK 4 -- engine helpers                                                                     */
/* ============================================================================================ */
/* Fishbowl's Pricing Rules EXPORT is the documented import format: percents as '96%' / '58.2%', money as
   '$17.60' / '$0.01', booleans lower-case. The payload builder emits exactly that (D-PRICE-53, CC finding). */
CREATE OR REPLACE FUNCTION public._fb_pct(p numeric) RETURNS text LANGUAGE sql IMMUTABLE
AS $$ SELECT rtrim(rtrim(to_char(COALESCE(p, 0), 'FM9999990.9999'), '0'), '.') || '%' $$;
CREATE OR REPLACE FUNCTION public._fb_money(p numeric) RETURNS text LANGUAGE sql IMMUTABLE
AS $$ SELECT '$' || to_char(COALESCE(p, 0), 'FM9999999990.00') $$;

/* Ladder code -> the short form used inside rule names ('standard' -> 'std', 'q5_q10_q25_tier1_tier2_tier3' -> '5/10/25/T1/T2/T3'). */
CREATE OR REPLACE FUNCTION public._fb_ladder_abbrev(p_ladder text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN p_ladder = 'standard' THEN 'std'
              WHEN p_ladder = 'each_t1_t2' THEN 'E/T1/T2'
              ELSE replace(replace(replace(p_ladder, 'tier', 'T'), 'q', ''), '_', '/') END
$$;

/* The price of ONE non-kit item for a tier/column group at a quantity, mirroring pricing_get_price
   minus the customer x part exception branch (group rules carry no customer). p_tier: none | tier1..3 |
   premier | q100 | q300 | q500. Returns NULL when the item cannot be priced. */
CREATE OR REPLACE FUNCTION public._fb_price_at(p_book uuid, p_item public.price_items, p_tier text, p_qty numeric)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_ladder public.price_ladders; v_has_tier boolean; v_mult numeric; v_col text; v_tier_key text;
        v_price numeric; c jsonb; v_best_min numeric := -1; v_pp numeric;
BEGIN
  IF p_item.id IS NULL OR p_item.status <> 'priced' OR p_item.list_price IS NULL THEN RETURN NULL; END IF;
  v_ladder := (SELECT l FROM public.price_ladders l WHERE l.book_id = p_book AND l.code = p_item.ladder_code);
  IF v_ladder.code IS NULL OR jsonb_array_length(v_ladder.columns) = 0 THEN RETURN p_item.list_price; END IF;
  v_has_tier := EXISTS (SELECT 1 FROM jsonb_array_elements(v_ladder.columns) e WHERE e->>'kind' = 'tier');

  IF p_tier IN ('q100','q300','q500') THEN
    v_mult := public._pricing_multiplier(p_book, p_item.rule_code, p_item.ladder_code, p_tier);
    IF v_mult IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_ladder.columns) e WHERE e->>'key' = p_tier) THEN
      RETURN p_item.list_price * v_mult;
    END IF;
    RETURN p_item.list_price;
  END IF;

  IF p_tier IN ('tier1','tier2','tier3','premier') AND v_has_tier THEN
    IF p_tier = 'premier' AND p_item.has_premier THEN
      v_mult := public._pricing_multiplier(p_book, p_item.rule_code, p_item.ladder_code, 'tier3');
      IF v_mult IS NOT NULL THEN
        v_pp := (SELECT premier_pct FROM public.price_books WHERE id = p_book);
        RETURN p_item.list_price * v_mult * v_pp;
      END IF;
    END IF;
    v_tier_key := CASE WHEN p_tier = 'premier' THEN 'tier3' ELSE p_tier END;
    FOR v_col IN SELECT k FROM unnest(ARRAY['tier3','tier2','tier1']) k
      WHERE (CASE k WHEN 'tier3' THEN 3 WHEN 'tier2' THEN 2 ELSE 1 END) <= (CASE v_tier_key WHEN 'tier3' THEN 3 WHEN 'tier2' THEN 2 ELSE 1 END)
      ORDER BY (CASE k WHEN 'tier3' THEN 3 WHEN 'tier2' THEN 2 ELSE 1 END) DESC
    LOOP
      v_mult := public._pricing_multiplier(p_book, p_item.rule_code, p_item.ladder_code, v_col);
      IF v_mult IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_ladder.columns) e WHERE e->>'key' = v_col) THEN
        RETURN p_item.list_price * v_mult;
      END IF;
    END LOOP;
  END IF;

  /* quantity break: largest qty column whose min <= qty (a tier group on a qty-only ladder lands here, like the RPC) */
  v_price := p_item.list_price;
  FOR c IN SELECT * FROM jsonb_array_elements(v_ladder.columns) LOOP
    IF c->>'kind' = 'qty' AND (c->>'min')::numeric <= p_qty AND (c->>'min')::numeric > v_best_min THEN
      v_mult := public._pricing_multiplier(p_book, p_item.rule_code, p_item.ladder_code, c->>'key');
      IF v_mult IS NOT NULL THEN v_best_min := (c->>'min')::numeric; v_price := p_item.list_price * v_mult; END IF;
    END IF;
  END LOOP;
  RETURN v_price;
END $$;


/* ============================================================================================ */
/* BLOCK 5 -- expected Fishbowl state, derived from a book                                        */
/* ============================================================================================ */
/* Product prices: every priced catalog row and every resolved set/kit Each (round half-up to 2 dp
   in SQL -- the D-PRICE-22 client export used toFixed(2), which rounds 48.355 to 48.35). Resale rows
   are Fishbowl-owned (D-PRICE-13) and are included only on request. kind: catalog | kit | resale.
   Only products Fishbowl knows (fb_products, not removed) are returned; the rest is reported by
   pricing_fb_sync_status as not_in_fishbowl. */
CREATE OR REPLACE FUNCTION public.pricing_fb_expected_products(p_book uuid, p_include_resale boolean DEFAULT false)
RETURNS TABLE(product_num text, price numeric, kind text, part_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH each AS (
    SELECT p.item_id, p.unit_price FROM public.pricing_item_prices(p_book) p WHERE p.col_key = 'each'
  )
  SELECT f.product_num, round(e.unit_price, 2) AS price,
         CASE WHEN i.status = 'component_sum' THEN 'kit' WHEN s.kind = 'resale' THEN 'resale' ELSE 'catalog' END AS kind,
         i.part_key
  FROM public.price_items i
  JOIN public.price_sections s ON s.id = i.section_id
  JOIN each e ON e.item_id = i.id
  JOIN public.fb_products f ON f.product_key = i.part_key AND f.removed_at IS NULL
  WHERE i.book_id = p_book
    AND i.status IN ('priced','component_sum')
    AND e.unit_price IS NOT NULL
    AND (p_include_resale OR s.kind <> 'resale')
$$;

/* Tree membership: catalog items with a rule and a ladder that has columns -> Product:SkyNet:<rule>:<ladder>,
   has_premier items in the :Premier child node instead. */
CREATE OR REPLACE FUNCTION public.pricing_fb_expected_tree(p_book uuid)
RETURNS TABLE(product_num text, path text, part_key text, in_fishbowl boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT COALESCE(f.product_num, i.part_number) AS product_num,
         'Product:SkyNet:' || i.rule_code || ':' || i.ladder_code || CASE WHEN i.has_premier THEN ':Premier' ELSE '' END AS path,
         i.part_key,
         f.product_num IS NOT NULL AS in_fishbowl
  FROM public.price_items i
  JOIN public.price_sections s ON s.id = i.section_id AND s.kind = 'catalog'
  JOIN public.price_ladders l ON l.book_id = i.book_id AND l.code = i.ladder_code AND jsonb_array_length(l.columns) > 0
  JOIN public.price_rules r ON r.book_id = i.book_id AND r.code = i.rule_code
  LEFT JOIN public.fb_products f ON f.product_key = i.part_key AND f.removed_at IS NULL
  WHERE i.book_id = p_book AND i.status = 'priced'
$$;

/* Categories the tree needs (Product Tree Categories import: Name <= 30, Description, Path = parent path). */
CREATE OR REPLACE FUNCTION public.pricing_fb_expected_categories(p_book uuid)
RETURNS TABLE(name text, description text, path text, full_path text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH leaves AS (SELECT DISTINCT t.path FROM public.pricing_fb_expected_tree(p_book) t),
  parts AS (
    SELECT DISTINCT split_part(path, ':', 3) AS rule, split_part(path, ':', 4) AS ladder, split_part(path, ':', 5) AS premier FROM leaves
  )
  SELECT 'SkyNet', 'SkyNet price book (generated, do not edit)', 'Product', 'Product:SkyNet'
  UNION
  SELECT DISTINCT rule, 'Rule ' || rule, 'Product:SkyNet', 'Product:SkyNet:' || rule FROM parts
  UNION
  SELECT DISTINCT ladder, 'Rule ' || rule || ' ladder ' || ladder, 'Product:SkyNet:' || rule, 'Product:SkyNet:' || rule || ':' || ladder FROM parts
  UNION
  SELECT DISTINCT 'Premier', 'Premier-flagged items (tier3 x premier_pct)', 'Product:SkyNet:' || rule || ':' || ladder, 'Product:SkyNet:' || rule || ':' || ladder || ':Premier'
  FROM parts WHERE premier = 'Premier'
  ORDER BY 4
$$;

/* Customer group membership expected on a date (Customer Group Relations import: CustomerName, CustomerGroupName). */
CREATE OR REPLACE FUNCTION public.pricing_fb_expected_groups(p_as_of date DEFAULT CURRENT_DATE)
RETURNS TABLE(customer_name text, group_name text, fb_customer_id integer, tier text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT c.name, g.group_name, c.fb_customer_id, t.tier
  FROM (
    SELECT DISTINCT ON (cp.fb_customer_id) cp.fb_customer_id, cp.tier
    FROM public.customer_pricing cp
    WHERE cp.effective_from <= p_as_of AND (cp.effective_to IS NULL OR cp.effective_to > p_as_of)
    ORDER BY cp.fb_customer_id, cp.effective_from DESC
  ) t
  JOIN public.fb_group_map g ON g.tier = t.tier
  JOIN public.fb_customers c ON c.fb_customer_id = t.fb_customer_id AND c.removed_at IS NULL
  WHERE t.tier <> 'none'
$$;

/* The rule set. One row per Fishbowl pricing rule the book implies, in the Pricing Rules import's
   column order. kind: break | tier | premier | column | kit_break | kit_tier | kit_column | exception.
   Names are unique and <= 30 chars (asserted). No temp tables, no SELECT INTO: one CTE chain
   collected into jsonb, guarded, then returned. */
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
      JOIN public.fb_group_map g ON g.tier IN ('tier1','tier2','tier3','premier')
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
      JOIN public.fb_group_map g ON g.tier IN ('q100','q300','q500')
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
      JOIN public.fb_group_map g ON g.tier = p.tier
      WHERE p.tier IN ('tier1','tier2','tier3','premier') AND p.price IS NOT NULL AND (p.banded OR p.qty = 1)
    ),
    /* column groups on kits: quantity-free by construction */
    kit_cols AS (
      SELECT 'kit_column'::text, 'SN K ' || p.product_num || ' C' || substr(p.tier, 2), 'SkyNet kit ' || p.product_num || ' column ' || p.tier,
             'Product'::text, p.product_num, 'Fixed price'::text, 0::numeric, round(p.price, 2), 'Customer Group'::text, g.group_name, false, 0::numeric, 0::numeric, 70
      FROM kit_prices p
      JOIN public.fb_group_map g ON g.tier = p.tier
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
      SELECT * FROM breaks UNION ALL SELECT * FROM tiers UNION ALL SELECT * FROM premier UNION ALL SELECT * FROM cols
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


/* ============================================================================================ */
/* BLOCK 6 -- sync status (the confirmation) and drift views                                     */
/* ============================================================================================ */
CREATE OR REPLACE VIEW public.v_fb_price_drift AS
WITH b AS (SELECT public.pricing_book_for_date(CURRENT_DATE) AS id),
e AS (SELECT * FROM public.pricing_fb_expected_products((SELECT id FROM b), true))
SELECT e.product_num, e.kind, e.price AS book_price, round(f.list_price, 2) AS fb_price,
       round(f.list_price, 2) - e.price AS delta,
       CASE WHEN round(f.list_price, 2) = e.price THEN 'in_sync' WHEN f.list_price = 0 THEN 'fb_zero' ELSE 'mismatch' END AS state
FROM e JOIN public.fb_products f ON f.product_key = e.part_key AND f.removed_at IS NULL
UNION ALL
SELECT i.part_number, CASE WHEN i.status = 'component_sum' THEN 'kit' WHEN s.kind = 'resale' THEN 'resale' ELSE 'catalog' END, round(p.unit_price, 2), NULL, NULL, 'not_in_fishbowl'
FROM public.price_items i
JOIN public.price_sections s ON s.id = i.section_id
JOIN public.pricing_item_prices((SELECT id FROM b)) p ON p.item_id = i.id AND p.col_key = 'each'
WHERE i.book_id = (SELECT id FROM b) AND i.status IN ('priced','component_sum') AND p.unit_price IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.fb_products f WHERE f.product_key = i.part_key AND f.removed_at IS NULL);

CREATE OR REPLACE VIEW public.v_fb_rule_drift AS
WITH b AS (SELECT public.pricing_book_for_date(CURRENT_DATE) AS id),
e AS (SELECT * FROM public.pricing_fb_expected_rules((SELECT id FROM b), CURRENT_DATE)),
m AS (SELECT * FROM public.fb_pricing_rules WHERE removed_at IS NULL)
SELECT COALESCE(e.name, m.name) AS name, e.kind,
       CASE
         WHEN e.name IS NULL AND m.is_active AND m.name NOT LIKE 'SN %' THEN 'legacy_active'
         WHEN e.name IS NULL AND m.is_active THEN 'extra_sn_active'
         WHEN e.name IS NULL THEN 'inactive_other'
         WHEN m.name IS NULL THEN 'missing'
         WHEN NOT m.is_active THEN 'inactive_in_fb'
         WHEN m.product_incl_type IS DISTINCT FROM e.product_incl_type OR m.product IS DISTINCT FROM e.product
           OR m.customer_incl_type IS DISTINCT FROM e.customer_incl_type OR COALESCE(m.customer, '') IS DISTINCT FROM COALESCE(e.customer, '')
           OR m.pa_type IS DISTINCT FROM e.pa_type
           OR round(COALESCE(m.pa_percent, 0), 4) IS DISTINCT FROM round(COALESCE(e.pa_percent, 0), 4)
           OR round(COALESCE(m.pa_amount, 0), 2) IS DISTINCT FROM round(COALESCE(e.pa_amount, 0), 2)
           OR COALESCE(m.qty_applies, false) IS DISTINCT FROM e.qty_applies
           OR (e.qty_applies AND (COALESCE(m.qty_min, 0) IS DISTINCT FROM e.qty_min OR COALESCE(m.qty_max, 0) IS DISTINCT FROM e.qty_max))
           OR COALESCE(m.rnd_applies, false) IS DISTINCT FROM e.rnd_applies
           OR (e.rnd_applies AND (m.round_type IS DISTINCT FROM e.round_type OR round(COALESCE(m.rnd_to_amount, 0), 4) IS DISTINCT FROM e.rnd_to_amount
                                  OR round(COALESCE(m.rnd_pm_amount, 0), 4) IS DISTINCT FROM e.rnd_pm_amount))
           THEN 'mismatch'
         ELSE 'in_sync' END AS state,
       e.product AS expected_product, m.product AS fb_product, e.customer AS expected_customer, m.customer AS fb_customer,
       e.pa_type AS expected_pa_type, m.pa_type AS fb_pa_type, e.pa_percent AS expected_pct, m.pa_percent AS fb_pct,
       e.pa_amount AS expected_amount, m.pa_amount AS fb_amount, e.qty_min AS expected_qty_min, m.qty_min AS fb_qty_min,
       e.qty_max AS expected_qty_max, m.qty_max AS fb_qty_max, m.fb_rule_id
FROM e FULL OUTER JOIN m ON m.name = e.name;

CREATE OR REPLACE VIEW public.v_fb_tree_drift AS
WITH b AS (SELECT public.pricing_book_for_date(CURRENT_DATE) AS id),
e AS (SELECT * FROM public.pricing_fb_expected_tree((SELECT id FROM b)))
SELECT e.product_num, e.path AS expected_path,
       CASE WHEN NOT e.in_fishbowl THEN 'not_in_fishbowl'
            WHEN EXISTS (SELECT 1 FROM public.fb_product_tree t WHERE t.product_key = e.part_key AND t.path = e.path AND t.removed_at IS NULL) THEN 'in_sync'
            ELSE 'missing' END AS state,
       (SELECT string_agg(t.path, ' | ') FROM public.fb_product_tree t WHERE t.product_key = e.part_key AND t.removed_at IS NULL AND t.path LIKE 'Product:SkyNet:%') AS fb_skynet_paths
FROM e;

CREATE OR REPLACE VIEW public.v_fb_group_drift AS
WITH e AS (SELECT * FROM public.pricing_fb_expected_groups(CURRENT_DATE)),
m AS (SELECT c.fb_customer_id, c.name, g.group_name
      FROM public.fb_customers c JOIN public.fb_group_map g ON g.group_name = ANY(COALESCE(c.account_groups, '{}'))
      WHERE c.removed_at IS NULL)
SELECT COALESCE(e.customer_name, m.name) AS customer_name, COALESCE(e.fb_customer_id, m.fb_customer_id) AS fb_customer_id,
       e.group_name AS expected_group, m.group_name AS fb_group, e.tier,
       CASE WHEN e.customer_name IS NULL THEN 'extra_in_fb' WHEN m.name IS NULL THEN 'missing' ELSE 'in_sync' END AS state
FROM e FULL OUTER JOIN m ON m.fb_customer_id = e.fb_customer_id AND m.group_name = e.group_name;

/* The confirmation the portal shows. in_sync is true only when every population is clean. */
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

  /* one pricing_item_prices pass (it is the expensive part): the same rows pricing_fb_expected_products returns */
  v_products := (
    WITH all_each AS MATERIALIZED (
           SELECT i.id, i.part_number, i.part_key, i.status, s.kind AS section_kind, p.unit_price
           FROM public.price_items i JOIN public.price_sections s ON s.id = i.section_id
           JOIN public.pricing_item_prices(v_book) p ON p.item_id = i.id AND p.col_key = 'each'
           WHERE i.book_id = v_book AND i.status IN ('priced','component_sum') AND p.unit_price IS NOT NULL),
         fbj AS MATERIALIZED (
           SELECT a.part_key, a.status, a.section_kind, round(a.unit_price, 2) AS price, f.product_num, f.list_price, round(f.list_price, 2) AS fb_price
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
  v_last := (SELECT jsonb_object_agg(x.kind, x.j) FROM (
               SELECT DISTINCT ON (c.kind) c.kind, jsonb_build_object('id', c.id, 'status', c.status, 'dry_run', c.dry_run, 'rows', c.row_count,
                        'finished_at', c.finished_at, 'error', c.error, 'book_id', c.book_id) j
               FROM public.fb_push_commands c WHERE c.status IN ('done','failed') ORDER BY c.kind, c.id DESC) x);

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

/* Enqueue: builds the payload from the expected-set functions at enqueue time (what was pushed is stored).
   kind prices -> Product import (ProductNumber, Price); rules -> Pricing-Rules; tree -> Product-Tree-Categories
   then Product-Tree (two payloads, one command: categories first); groups -> Customer-Group-Relations.
   options: {"include_resale": bool, "retire_legacy": bool, "only_changed": bool (default true),
             "only_products": ["SK2600-1", ...] (prices only)}. Edit roles or the bridge. */
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
    v_import := 'Product';
    v_payload := (
      SELECT jsonb_build_array(jsonb_build_array('ProductNumber', 'Price')) || COALESCE(jsonb_agg(jsonb_build_array(e.product_num, e.price::text) ORDER BY e.product_num), '[]'::jsonb)
      FROM public.pricing_fb_expected_products(v_book, v_resale) e
      JOIN public.fb_products f ON f.product_key = e.part_key AND f.removed_at IS NULL
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


/* Nightly automation (the bridge calls this after the products poll). It never makes the FIRST push of a
   kind: the first prices push and the rules cutover (retire_legacy) are always queued by hand (S12 section 9),
   so deploying the bridge to PROD cannot trigger either at 02:10. After that, when the book in effect is not
   the book of the last successful, non-dry push of that kind, it queues that push for the new book (the
   Oct 1 case). Drift on an unchanged book is reported by pricing_fb_sync_status, never auto-pushed. */
CREATE OR REPLACE FUNCTION public.fb_push_auto(p_as_of date DEFAULT CURRENT_DATE)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_book uuid; v_last_prices uuid; v_last_rules uuid; v_p bigint; v_r bigint;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration','admin']);
  v_book := public.pricing_book_for_date(p_as_of);
  IF v_book IS NULL THEN RETURN jsonb_build_object('queued', '[]'::jsonb, 'reason', 'no book effective'); END IF;
  v_last_prices := (SELECT c.book_id FROM public.fb_push_commands c WHERE c.kind = 'prices' AND c.status = 'done' AND NOT c.dry_run
                    AND COALESCE((c.result->>'dry_run')::boolean, false) = false ORDER BY c.id DESC LIMIT 1);
  v_last_rules  := (SELECT c.book_id FROM public.fb_push_commands c WHERE c.kind = 'rules' AND c.status = 'done' AND NOT c.dry_run
                    AND COALESCE((c.result->>'dry_run')::boolean, false) = false ORDER BY c.id DESC LIMIT 1);
  IF v_last_prices IS NOT NULL AND v_last_prices <> v_book
     AND NOT EXISTS (SELECT 1 FROM public.fb_push_commands WHERE kind = 'prices' AND status IN ('queued','running')) THEN
    v_p := public.fb_push_enqueue('prices', v_book, '{"only_changed": true}'::jsonb, false, 'auto: book in effect changed', p_as_of);
  END IF;
  IF v_last_rules IS NOT NULL AND v_last_rules <> v_book
     AND NOT EXISTS (SELECT 1 FROM public.fb_push_commands WHERE kind = 'rules' AND status IN ('queued','running')) THEN
    v_r := public.fb_push_enqueue('rules', v_book, '{"only_changed": true, "retire_legacy": true}'::jsonb, false, 'auto: book in effect changed', p_as_of);
  END IF;
  RETURN jsonb_build_object('book_id', v_book, 'prices_cmd', v_p, 'rules_cmd', v_r,
                            'prices_last_book', v_last_prices, 'rules_last_book', v_last_rules);
END $$;


/* ============================================================================================ */
/* BLOCK 7 -- grants. Views inherit ALL for anon/authenticated by default (D-RLS-VIEWS01): fix.  */
/* ============================================================================================ */
REVOKE ALL ON public.v_fb_price_drift, public.v_fb_rule_drift, public.v_fb_tree_drift, public.v_fb_group_drift FROM authenticated, anon, public;
GRANT SELECT ON public.v_fb_price_drift, public.v_fb_rule_drift, public.v_fb_tree_drift, public.v_fb_group_drift TO authenticated;

REVOKE EXECUTE ON FUNCTION public.fb_push_next(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fb_push_finish(bigint, boolean, jsonb, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fb_push_cancel(bigint) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fb_push_auto(date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fb_push_enqueue(text, uuid, jsonb, boolean, text, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fb_upsert_pricing_rules(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fb_upsert_product_tree(jsonb, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public._fb_price_at(uuid, public.price_items, text, numeric) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public._fb_ladder_abbrev(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public._fb_pct(numeric) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public._fb_money(numeric) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pricing_fb_expected_products(uuid, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pricing_fb_expected_tree(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pricing_fb_expected_categories(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pricing_fb_expected_groups(date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pricing_fb_expected_rules(uuid, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pricing_fb_sync_status(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fb_push_next(text), public.fb_push_finish(bigint, boolean, jsonb, text), public.fb_push_cancel(bigint), public.fb_push_auto(date),
                          public.fb_push_enqueue(text, uuid, jsonb, boolean, text, date),
                          public.fb_upsert_pricing_rules(jsonb), public.fb_upsert_product_tree(jsonb, jsonb),
                          public._fb_price_at(uuid, public.price_items, text, numeric), public._fb_ladder_abbrev(text), public._fb_pct(numeric), public._fb_money(numeric),
                          public.pricing_fb_expected_products(uuid, boolean), public.pricing_fb_expected_tree(uuid),
                          public.pricing_fb_expected_categories(uuid), public.pricing_fb_expected_groups(date),
                          public.pricing_fb_expected_rules(uuid, date), public.pricing_fb_sync_status(date)
  TO authenticated, service_role;


/* ============================================================================================ */
/* BLOCK 8 -- verify (read-only). Expected on PROD 2026-09-25 (Rev 81 in effect, mirrors empty):    */
/*   tables 5 . functions 17 . views 4 . group_map 7 . anon_grants 0                                */
/*   expected_products 3,127 (3,111 catalog + 16 sets; resale excluded) . expected_tree_rows 3,111  */
/*   expected_rules ~ 448 (break 88, tier 72, premier 5, column 114, exception 9, kit ~160)         */
/*   expected_categories 57 . expected_groups 109                                                   */
/*   sync.in_sync false (rules/tree mirrors not loaded yet) -- becomes the pass/fail after Batch B  */
/*   Ran end to end in a scratch Postgres 16 on a 223-item PROD slice (all 38 combos) 2026-09-25.  */
/* ============================================================================================ */
SELECT jsonb_build_object(
  'tables', (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('fb_pricing_rules','fb_product_tree_nodes','fb_product_tree','fb_group_map','fb_push_commands')),
  'functions', (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN
                 ('fb_push_next','fb_push_finish','fb_push_cancel','fb_push_auto','fb_push_enqueue','fb_upsert_pricing_rules','fb_upsert_product_tree','_fb_price_at','_fb_ladder_abbrev','_fb_pct','_fb_money',
                  'pricing_fb_expected_products','pricing_fb_expected_tree','pricing_fb_expected_categories','pricing_fb_expected_groups','pricing_fb_expected_rules','pricing_fb_sync_status')),
  'views', (SELECT COUNT(*) FROM information_schema.views WHERE table_schema = 'public' AND table_name IN ('v_fb_price_drift','v_fb_rule_drift','v_fb_tree_drift','v_fb_group_drift')),
  'group_map', (SELECT COUNT(*) FROM public.fb_group_map),
  'anon_grants', (SELECT COUNT(*) FROM information_schema.role_table_grants WHERE grantee = 'anon' AND table_schema = 'public'
                  AND table_name IN ('fb_pricing_rules','fb_product_tree_nodes','fb_product_tree','fb_group_map','fb_push_commands','v_fb_price_drift','v_fb_rule_drift','v_fb_tree_drift','v_fb_group_drift')),
  'expected_products', (SELECT COUNT(*) FROM public.pricing_fb_expected_products(public.pricing_book_for_date(CURRENT_DATE), false)),
  'expected_rules', (SELECT COUNT(*) FROM public.pricing_fb_expected_rules(public.pricing_book_for_date(CURRENT_DATE), CURRENT_DATE)),
  'expected_rules_by_kind', (SELECT jsonb_object_agg(k, n) FROM (SELECT kind k, COUNT(*) n FROM public.pricing_fb_expected_rules(public.pricing_book_for_date(CURRENT_DATE), CURRENT_DATE) GROUP BY kind) x),
  'expected_tree_rows', (SELECT COUNT(*) FROM public.pricing_fb_expected_tree(public.pricing_book_for_date(CURRENT_DATE)) WHERE in_fishbowl),
  'expected_categories', (SELECT COUNT(*) FROM public.pricing_fb_expected_categories(public.pricing_book_for_date(CURRENT_DATE))),
  'expected_groups', (SELECT COUNT(*) FROM public.pricing_fb_expected_groups(CURRENT_DATE)),
  'sync', public.pricing_fb_sync_status(CURRENT_DATE)
) AS verify;
