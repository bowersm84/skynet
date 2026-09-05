/* ============================================================================
   S11 Batch A — Pricing Portal schema (D-PRICE-01..25)
   Supabase SQL Editor, TEST first (ylzmyjjqibpbqbwjsnqj), then PROD.
   Idempotent: safe to re-run. Pure DDL + function bodies; no data.
   Executed end-to-end on a scratch Postgres 16 with the SkyNet DDL before delivery.

   Contents
     1. Tables: price_books, price_rules, price_ladders, price_sections, price_items,
        price_kit_components, price_exceptions, customer_pricing,
        fb_customers, fb_products, fb_so_history_lines (+ fb_sync_state columns)
     2. RLS: SELECT for authenticated on every table; NO direct write policies
     3. Gate: _pricing_gate(text[])  (NULL-uid passthrough, user_has_role otherwise)
     4. Read RPCs / functions: pricing_book_for_date, pricing_item_prices, pricing_get_price,
        pricing_customer_sheet
     5. Admin RPCs: pricing_clone_book, pricing_publish_book, pricing_unpublish_book,
        pricing_upsert_item, pricing_delete_item, pricing_upsert_rule, pricing_upsert_ladder,
        pricing_upsert_section, pricing_set_customer_tier, pricing_upsert_exception,
        pricing_close_exception
     6. Bridge RPCs (integration role): fb_upsert_customers, fb_upsert_products, fb_upsert_so_history
     7. Views: v_customer_pricing_current, v_customer_purchases
   ============================================================================ */

/* ---------------------------------------------------------------- 1. TABLES */

CREATE TABLE IF NOT EXISTS public.price_books (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rev_label          text NOT NULL,
  effective_from     date,
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','scheduled','active','superseded')),
  source             text NOT NULL DEFAULT 'clone',
  cloned_from_book_id uuid REFERENCES public.price_books(id),
  uplift_pct         numeric(8,4),
  premier_pct        numeric(6,4) NOT NULL DEFAULT 0.97,
  notes              text,
  created_by         uuid REFERENCES public.profiles(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  published_by       uuid REFERENCES public.profiles(id),
  published_at       timestamptz,
  superseded_at      timestamptz,
  CONSTRAINT price_books_published_have_date CHECK (status = 'draft' OR effective_from IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS price_books_one_per_date
  ON public.price_books(effective_from) WHERE status IN ('scheduled','active');

CREATE TABLE IF NOT EXISTS public.price_rules (
  book_id   uuid NOT NULL REFERENCES public.price_books(id) ON DELETE CASCADE,
  code      text NOT NULL,
  m_q100    numeric(6,4),
  m_q300    numeric(6,4),
  m_q500    numeric(6,4),
  m_tier1   numeric(6,4),
  m_tier2   numeric(6,4),
  m_tier3   numeric(6,4),
  notes     text,
  PRIMARY KEY (book_id, code)
);

/* columns jsonb = ordered array of {key, kind ('qty'|'tier'), min (qty only), label}
   keys are drawn from: q100 q300 q500 tier1 tier2 tier3 premier, plus ladder-specific
   qty keys (q5 q10 q20 q25 q50). Multiplier lookup for a qty key = the rule column
   in the same POSITION among that ladder's qty columns (1st qty col -> m_q100, 2nd -> m_q300, 3rd -> m_q500). */
CREATE TABLE IF NOT EXISTS public.price_ladders (
  book_id  uuid NOT NULL REFERENCES public.price_books(id) ON DELETE CASCADE,
  code     text NOT NULL,
  label    text,
  columns  jsonb NOT NULL,
  PRIMARY KEY (book_id, code)
);

CREATE TABLE IF NOT EXISTS public.price_sections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id      uuid NOT NULL REFERENCES public.price_books(id) ON DELETE CASCADE,
  name         text NOT NULL,
  sort         integer NOT NULL DEFAULT 0,
  kind         text NOT NULL DEFAULT 'catalog' CHECK (kind IN ('catalog','resale')),
  header_note  text,
  source_row   integer
);
CREATE INDEX IF NOT EXISTS price_sections_book_idx ON public.price_sections(book_id, sort);

CREATE TABLE IF NOT EXISTS public.price_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id       uuid NOT NULL REFERENCES public.price_books(id) ON DELETE CASCADE,
  section_id    uuid NOT NULL REFERENCES public.price_sections(id) ON DELETE CASCADE,
  part_number   text NOT NULL,
  part_key      text GENERATED ALWAYS AS (upper(regexp_replace(part_number, '\s', '', 'g'))) STORED,
  fb_product_id integer,
  part_id       uuid REFERENCES public.parts(id),
  kit_sku_id    uuid REFERENCES public.kit_skus(id),
  description   text,
  list_price    numeric(12,3),
  rule_code     text,
  ladder_code   text NOT NULL DEFAULT 'standard',
  has_premier   boolean NOT NULL DEFAULT false,
  dfar          boolean NOT NULL DEFAULT false,
  xref_arconic  text,
  xref_lisi     text,
  nsn           text,
  cessna        text,
  sort          integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'priced' CHECK (status IN ('priced','no_price','component_sum')),
  source_row    integer,
  range_of      text,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_items_book_part_uniq UNIQUE (book_id, part_key),
  CONSTRAINT price_items_priced_has_price CHECK (status <> 'priced' OR list_price IS NOT NULL),
  CONSTRAINT price_items_rule_fk FOREIGN KEY (book_id, rule_code) REFERENCES public.price_rules(book_id, code) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT price_items_ladder_fk FOREIGN KEY (book_id, ladder_code) REFERENCES public.price_ladders(book_id, code) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS price_items_book_section_idx ON public.price_items(book_id, section_id, sort);
CREATE INDEX IF NOT EXISTS price_items_part_key_idx ON public.price_items(part_key);

CREATE TABLE IF NOT EXISTS public.price_kit_components (
  item_id               uuid NOT NULL REFERENCES public.price_items(id) ON DELETE CASCADE,
  component_part_number text NOT NULL,
  component_key         text GENERATED ALWAYS AS (upper(regexp_replace(component_part_number, '\s', '', 'g'))) STORED,
  qty                   numeric(10,3) NOT NULL DEFAULT 1,
  PRIMARY KEY (item_id, component_key)
);

CREATE TABLE IF NOT EXISTS public.price_exceptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fb_customer_id  integer NOT NULL,
  part_number     text NOT NULL,
  part_key        text GENERATED ALWAYS AS (upper(regexp_replace(part_number, '\s', '', 'g'))) STORED,
  mode            text NOT NULL CHECK (mode IN ('pct_of_tier3','fixed')),
  value           numeric(12,4) NOT NULL,
  note            text,
  effective_from  date NOT NULL DEFAULT CURRENT_DATE,
  effective_to    date,
  created_by      uuid REFERENCES public.profiles(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_by       uuid REFERENCES public.profiles(id),
  closed_at       timestamptz
);
CREATE INDEX IF NOT EXISTS price_exceptions_lookup_idx ON public.price_exceptions(fb_customer_id, part_key) WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS public.customer_pricing (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fb_customer_id  integer NOT NULL,
  tier            text NOT NULL CHECK (tier IN ('none','tier1','tier2','tier3','premier')),
  effective_from  date NOT NULL DEFAULT CURRENT_DATE,
  effective_to    date,
  set_by          uuid REFERENCES public.profiles(id),
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_pricing_one_open ON public.customer_pricing(fb_customer_id) WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS public.fb_customers (
  fb_customer_id   integer PRIMARY KEY,
  customer_number  text,
  name             text NOT NULL,
  name_clean       text NOT NULL,
  is_active        boolean NOT NULL DEFAULT true,
  salesman         text,
  account_groups   text[],
  payment_terms    text,
  fb_date_created  timestamptz,
  fb_date_modified timestamptz,
  first_synced_at  timestamptz NOT NULL DEFAULT now(),
  synced_at        timestamptz NOT NULL DEFAULT now(),
  removed_at       timestamptz,
  customer_id      uuid REFERENCES public.customers(id)
);
CREATE INDEX IF NOT EXISTS fb_customers_name_idx ON public.fb_customers(lower(name_clean));

CREATE TABLE IF NOT EXISTS public.fb_products (
  fb_product_id   integer PRIMARY KEY,
  product_num     text NOT NULL,
  product_key     text GENERATED ALWAYS AS (upper(regexp_replace(product_num, '\s', '', 'g'))) STORED,
  part_num        text,
  description     text,
  list_price      numeric(12,3),
  is_active       boolean NOT NULL DEFAULT true,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz
);
CREATE INDEX IF NOT EXISTS fb_products_key_idx ON public.fb_products(product_key);

CREATE TABLE IF NOT EXISTS public.fb_so_history_lines (
  fb_soitem_id      integer PRIMARY KEY,
  fb_so_id          integer NOT NULL,
  so_number         text,
  fb_customer_id    integer,
  so_status_id      smallint,
  line_status_id    smallint,
  line_type_id      smallint,
  product_num       text NOT NULL,
  product_key       text GENERATED ALWAYS AS (upper(regexp_replace(product_num, '\s', '', 'g'))) STORED,
  part_num          text,
  description       text,
  qty_ordered       numeric,
  qty_fulfilled     numeric,
  unit_price        numeric(12,4),
  total_price       numeric(14,4),
  fb_date_created   timestamptz,
  fb_date_completed timestamptz,
  salesman          text,
  synced_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_so_history_cust_idx ON public.fb_so_history_lines(fb_customer_id, product_key);
CREATE INDEX IF NOT EXISTS fb_so_history_key_idx  ON public.fb_so_history_lines(product_key);

ALTER TABLE public.fb_sync_state ADD COLUMN IF NOT EXISTS last_customers_at timestamptz;
ALTER TABLE public.fb_sync_state ADD COLUMN IF NOT EXISTS last_history_at   timestamptz;
ALTER TABLE public.fb_sync_state ADD COLUMN IF NOT EXISTS last_products_at  timestamptz;
ALTER TABLE public.fb_sync_state ADD COLUMN IF NOT EXISTS history_cursor    timestamptz;

/* ---------------------------------------------------------------- 2. RLS */
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['price_books','price_rules','price_ladders','price_sections','price_items',
                          'price_kit_components','price_exceptions','customer_pricing','fb_customers','fb_products','fb_so_history_lines']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_authenticated', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', t || '_select_authenticated', t);
  END LOOP;
END $$;

/* ---------------------------------------------------------------- 3. GATE */
CREATE OR REPLACE FUNCTION public._pricing_gate(p_roles text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;   /* SQL Editor / pg_cron passthrough */
  IF NOT public.user_has_role(v_uid, VARIADIC p_roles) THEN
    RAISE EXCEPTION 'PRICING_GATE: one of % required', p_roles USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public._pricing_gate(text[]) FROM PUBLIC, anon;

/* Roles */
CREATE OR REPLACE FUNCTION public._pricing_view_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS
$$ SELECT ARRAY['admin','customer_service','president','viewer'] $$;
CREATE OR REPLACE FUNCTION public._pricing_edit_roles() RETURNS text[] LANGUAGE sql IMMUTABLE AS
$$ SELECT ARRAY['admin'] $$;

/* ---------------------------------------------------------------- 4. READ FUNCTIONS */

CREATE OR REPLACE FUNCTION public.pricing_book_for_date(p_as_of date DEFAULT CURRENT_DATE)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM public.price_books
  WHERE status IN ('scheduled','active') AND effective_from <= p_as_of
  ORDER BY effective_from DESC LIMIT 1
$$;

/* Multiplier for a ladder column key under a rule (NULL when the column does not apply) */
CREATE OR REPLACE FUNCTION public._pricing_multiplier(p_book uuid, p_rule text, p_ladder text, p_col_key text)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.price_rules; l public.price_ladders; pos int := 0; c jsonb; kind text;
BEGIN
  SELECT * INTO r FROM public.price_rules WHERE book_id = p_book AND code = p_rule;
  SELECT * INTO l FROM public.price_ladders WHERE book_id = p_book AND code = p_ladder;
  IF r IS NULL OR l IS NULL THEN RETURN NULL; END IF;
  FOR c IN SELECT * FROM jsonb_array_elements(l.columns) LOOP
    kind := c->>'kind';
    IF kind = 'qty' THEN pos := pos + 1; END IF;
    IF c->>'key' = p_col_key THEN
      IF kind = 'qty' THEN
        RETURN CASE pos WHEN 1 THEN r.m_q100 WHEN 2 THEN r.m_q300 WHEN 3 THEN r.m_q500 END;
      ELSE
        RETURN CASE p_col_key WHEN 'tier1' THEN r.m_tier1 WHEN 'tier2' THEN r.m_tier2 WHEN 'tier3' THEN r.m_tier3 END;
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

/* Long-format price grid for a book: one row per item per ladder column (+ 'each' + 'premier').
   Kits (component_sum) are one level deep: Σ components' value for the same column. */
CREATE OR REPLACE FUNCTION public.pricing_item_prices(p_book uuid)
RETURNS TABLE (item_id uuid, part_number text, col_key text, col_kind text, col_label text, col_order int, unit_price numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
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
  simple_prices AS (
    SELECT c.*,
      CASE
        WHEN c.status <> 'priced' THEN NULL
        WHEN c.key = 'each' THEN c.list_price
        WHEN c.key = 'premier' THEN c.list_price * public._pricing_multiplier(p_book, c.rule_code, c.ladder_code, 'tier3') * (SELECT premier_pct FROM b)
        ELSE c.list_price * public._pricing_multiplier(p_book, c.rule_code, c.ladder_code, c.key)
      END AS unit_price
    FROM cols c
  )
  SELECT sp.item_id, sp.part_number, sp.key, sp.kind, sp.label, sp.ord, sp.unit_price
  FROM simple_prices sp WHERE sp.status <> 'component_sum'
  UNION ALL
  SELECT k.item_id, k.part_number, k.key, k.kind, k.label, k.ord,
         (SELECT SUM(cp.unit_price * kc.qty)
            FROM public.price_kit_components kc
            JOIN simple_prices cp ON cp.part_key = kc.component_key AND cp.key = k.key
           WHERE kc.item_id = k.item_id)
  FROM simple_prices k WHERE k.status = 'component_sum'
$$;

/* Current tier for a customer on a date */
CREATE OR REPLACE FUNCTION public.pricing_customer_tier(p_fb_customer_id integer, p_as_of date DEFAULT CURRENT_DATE)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((
    SELECT tier FROM public.customer_pricing
    WHERE fb_customer_id = p_fb_customer_id AND effective_from <= p_as_of
      AND (effective_to IS NULL OR effective_to > p_as_of)
    ORDER BY effective_from DESC LIMIT 1), 'none')
$$;

/* The price. Authoritative resolution (D-PRICE-03..06, plan §5.4). */
CREATE OR REPLACE FUNCTION public.pricing_get_price(
  p_part text, p_fb_customer_id integer DEFAULT NULL, p_qty numeric DEFAULT 1, p_as_of date DEFAULT CURRENT_DATE)
RETURNS TABLE (
  unit_price numeric, unit_price_2dp numeric, basis text, col_key text, tier text, exception_id uuid,
  book_id uuid, rev_label text, item_id uuid, item_status text, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_book uuid; v_item public.price_items; v_tier text := 'none'; v_exc public.price_exceptions;
  v_ladder public.price_ladders; v_col text; v_mult numeric; v_price numeric; v_basis text;
  v_key text := upper(regexp_replace(p_part, '\s', '', 'g'));
  v_t3 numeric; v_has_tier boolean; v_tier_key text; c jsonb; v_best_min numeric := -1;
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

  /* Kits: sum the components at the same customer / qty / date (one level) */
  IF v_item.status = 'component_sum' THEN
    SELECT SUM(g.unit_price * kc.qty), MAX(g.col_key), MAX(g.basis)
      INTO v_price, v_col, v_basis
    FROM public.price_kit_components kc
    JOIN LATERAL public.pricing_get_price(kc.component_part_number, p_fb_customer_id, p_qty, p_as_of) g ON true
    WHERE kc.item_id = v_item.id;
    IF v_price IS NULL THEN
      RETURN QUERY SELECT NULL::numeric, NULL::numeric, 'no_price'::text, NULL::text, v_tier, NULL::uuid, v_book, (SELECT rev_label FROM price_books WHERE id = v_book), v_item.id, v_item.status, 'component without price'::text; RETURN;
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
END $$;

/* Price sheet rows. mode: 'purchased' (parts this customer has bought) | 'all' */
CREATE OR REPLACE FUNCTION public.pricing_customer_sheet(p_fb_customer_id integer, p_as_of date DEFAULT CURRENT_DATE, p_mode text DEFAULT 'purchased')
RETURNS TABLE (section_name text, section_sort int, part_number text, description text, dfar boolean, item_status text,
               tier text, unit_price numeric, col_key text, basis text, q100 numeric, q300 numeric, q500 numeric, last_paid numeric, last_bought date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH bk AS (SELECT public.pricing_book_for_date(p_as_of) AS id),
  hist AS (
    SELECT product_key, MAX(fb_date_created)::date AS last_bought,
           (array_agg(unit_price ORDER BY fb_date_created DESC))[1] AS last_paid
    FROM public.fb_so_history_lines WHERE fb_customer_id = p_fb_customer_id AND qty_fulfilled > 0
    GROUP BY product_key
  )
  SELECT s.name, s.sort, i.part_number, i.description, i.dfar, i.status,
         g.tier, g.unit_price_2dp, g.col_key, g.basis,
         round((SELECT unit_price FROM public.pricing_item_prices((SELECT id FROM bk)) p WHERE p.item_id = i.id AND p.col_key = 'q100'), 2),
         round((SELECT unit_price FROM public.pricing_item_prices((SELECT id FROM bk)) p WHERE p.item_id = i.id AND p.col_key = 'q300'), 2),
         round((SELECT unit_price FROM public.pricing_item_prices((SELECT id FROM bk)) p WHERE p.item_id = i.id AND p.col_key = 'q500'), 2),
         h.last_paid, h.last_bought
  FROM public.price_items i
  JOIN public.price_sections s ON s.id = i.section_id
  LEFT JOIN hist h ON h.product_key = i.part_key
  JOIN LATERAL public.pricing_get_price(i.part_number, p_fb_customer_id, 1, p_as_of) g ON true
  WHERE i.book_id = (SELECT id FROM bk)
    AND i.status <> 'no_price'
    AND (p_mode = 'all' OR h.product_key IS NOT NULL)
  ORDER BY s.sort, i.sort
$$;

/* ---------------------------------------------------------------- 5. ADMIN RPCs */

CREATE OR REPLACE FUNCTION public.pricing_clone_book(p_src uuid, p_label text, p_effective_from date, p_uplift_pct numeric DEFAULT 0, p_notes text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_new uuid; v_uid uuid := auth.uid();
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles());
  INSERT INTO public.price_books (rev_label, effective_from, status, source, cloned_from_book_id, uplift_pct, premier_pct, notes, created_by)
  SELECT p_label, p_effective_from, 'draft', 'clone', p_src, p_uplift_pct, premier_pct, p_notes, v_uid FROM public.price_books WHERE id = p_src
  RETURNING id INTO v_new;
  IF v_new IS NULL THEN RAISE EXCEPTION 'CLONE: source book % not found', p_src; END IF;
  INSERT INTO public.price_rules (book_id, code, m_q100, m_q300, m_q500, m_tier1, m_tier2, m_tier3, notes)
    SELECT v_new, code, m_q100, m_q300, m_q500, m_tier1, m_tier2, m_tier3, notes FROM public.price_rules WHERE book_id = p_src;
  INSERT INTO public.price_ladders (book_id, code, label, columns)
    SELECT v_new, code, label, columns FROM public.price_ladders WHERE book_id = p_src;
  CREATE TEMP TABLE IF NOT EXISTS _sec_map (old_id uuid, new_id uuid) ON COMMIT DROP;
  DELETE FROM _sec_map;
  INSERT INTO _sec_map SELECT id, gen_random_uuid() FROM public.price_sections WHERE book_id = p_src;
  INSERT INTO public.price_sections (id, book_id, name, sort, kind, header_note, source_row)
    SELECT m.new_id, v_new, s.name, s.sort, s.kind, s.header_note, s.source_row FROM public.price_sections s JOIN _sec_map m ON m.old_id = s.id;
  CREATE TEMP TABLE IF NOT EXISTS _item_map (old_id uuid, new_id uuid) ON COMMIT DROP;
  DELETE FROM _item_map;
  INSERT INTO _item_map SELECT id, gen_random_uuid() FROM public.price_items WHERE book_id = p_src;
  INSERT INTO public.price_items (id, book_id, section_id, part_number, fb_product_id, part_id, kit_sku_id, description, list_price, rule_code, ladder_code,
                                  has_premier, dfar, xref_arconic, xref_lisi, nsn, cessna, sort, status, source_row, range_of, notes)
    SELECT im.new_id, v_new, sm.new_id, i.part_number, i.fb_product_id, i.part_id, i.kit_sku_id, i.description,
           CASE WHEN s.kind = 'catalog' AND i.list_price IS NOT NULL THEN round(i.list_price * (1 + COALESCE(p_uplift_pct,0)), 3) ELSE i.list_price END,
           i.rule_code, i.ladder_code, i.has_premier, i.dfar, i.xref_arconic, i.xref_lisi, i.nsn, i.cessna, i.sort, i.status, i.source_row, i.range_of, i.notes
    FROM public.price_items i JOIN _item_map im ON im.old_id = i.id JOIN public.price_sections s ON s.id = i.section_id JOIN _sec_map sm ON sm.old_id = s.id;
  INSERT INTO public.price_kit_components (item_id, component_part_number, qty)
    SELECT im.new_id, kc.component_part_number, kc.qty FROM public.price_kit_components kc JOIN _item_map im ON im.old_id = kc.item_id;
  RETURN v_new;
END $$;

CREATE OR REPLACE FUNCTION public.pricing_publish_book(p_book uuid, p_effective_from date DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_eff date; v_uid uuid := auth.uid();
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles());
  UPDATE public.price_books SET effective_from = COALESCE(p_effective_from, effective_from) WHERE id = p_book AND status = 'draft'
    RETURNING effective_from INTO v_eff;
  IF v_eff IS NULL THEN RAISE EXCEPTION 'PUBLISH: book % is not a draft or has no effective date', p_book; END IF;
  IF EXISTS (SELECT 1 FROM public.price_books WHERE id <> p_book AND status IN ('scheduled','active') AND effective_from = v_eff) THEN
    RAISE EXCEPTION 'PUBLISH: another book is already effective on %', v_eff;
  END IF;
  /* any published book effective on/before this one's date and later than nothing newer becomes superseded */
  UPDATE public.price_books SET status = 'superseded', superseded_at = now()
   WHERE id <> p_book AND status = 'active' AND v_eff <= CURRENT_DATE AND effective_from < v_eff;
  UPDATE public.price_books
     SET status = CASE WHEN v_eff <= CURRENT_DATE THEN 'active' ELSE 'scheduled' END,
         published_by = v_uid, published_at = now()
   WHERE id = p_book;
END $$;

/* Nightly / on-open housekeeping: a scheduled book whose date has arrived becomes active; older actives supersede. Safe to call any time. */
CREATE OR REPLACE FUNCTION public.pricing_roll_books()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0; v_now uuid;
BEGIN
  v_now := public.pricing_book_for_date(CURRENT_DATE);
  IF v_now IS NULL THEN RETURN 0; END IF;
  UPDATE public.price_books SET status = 'active', published_at = COALESCE(published_at, now()) WHERE id = v_now AND status = 'scheduled';
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.price_books SET status = 'superseded', superseded_at = now()
   WHERE status = 'active' AND id <> v_now AND effective_from < (SELECT effective_from FROM public.price_books WHERE id = v_now);
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.pricing_unpublish_book(p_book uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles());
  UPDATE public.price_books SET status = 'draft', published_by = NULL, published_at = NULL WHERE id = p_book AND status = 'scheduled';
  IF NOT FOUND THEN RAISE EXCEPTION 'UNPUBLISH: book % is not scheduled (active books cannot be unpublished)', p_book; END IF;
END $$;

CREATE OR REPLACE FUNCTION public._pricing_assert_draft(p_book uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.price_books WHERE id = p_book AND status = 'draft') THEN
    RAISE EXCEPTION 'DRAFT_ONLY: book % is not a draft', p_book;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pricing_upsert_section(p_book uuid, p_id uuid, p_name text, p_sort int, p_kind text DEFAULT 'catalog', p_note text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid := COALESCE(p_id, gen_random_uuid());
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles()); PERFORM public._pricing_assert_draft(p_book);
  INSERT INTO public.price_sections (id, book_id, name, sort, kind, header_note) VALUES (v_id, p_book, p_name, p_sort, p_kind, p_note)
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, sort = EXCLUDED.sort, kind = EXCLUDED.kind, header_note = EXCLUDED.header_note;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.pricing_upsert_rule(p_book uuid, p_code text, p_q100 numeric, p_q300 numeric, p_q500 numeric, p_t1 numeric, p_t2 numeric, p_t3 numeric, p_notes text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles()); PERFORM public._pricing_assert_draft(p_book);
  INSERT INTO public.price_rules VALUES (p_book, p_code, p_q100, p_q300, p_q500, p_t1, p_t2, p_t3, p_notes)
  ON CONFLICT (book_id, code) DO UPDATE SET m_q100 = EXCLUDED.m_q100, m_q300 = EXCLUDED.m_q300, m_q500 = EXCLUDED.m_q500,
    m_tier1 = EXCLUDED.m_tier1, m_tier2 = EXCLUDED.m_tier2, m_tier3 = EXCLUDED.m_tier3, notes = EXCLUDED.notes;
END $$;

CREATE OR REPLACE FUNCTION public.pricing_upsert_ladder(p_book uuid, p_code text, p_label text, p_columns jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles()); PERFORM public._pricing_assert_draft(p_book);
  INSERT INTO public.price_ladders VALUES (p_book, p_code, p_label, p_columns)
  ON CONFLICT (book_id, code) DO UPDATE SET label = EXCLUDED.label, columns = EXCLUDED.columns;
END $$;

CREATE OR REPLACE FUNCTION public.pricing_upsert_item(p_book uuid, p_item jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid := COALESCE((p_item->>'id')::uuid, gen_random_uuid());
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles()); PERFORM public._pricing_assert_draft(p_book);
  INSERT INTO public.price_items (id, book_id, section_id, part_number, fb_product_id, part_id, kit_sku_id, description, list_price, rule_code, ladder_code,
                                  has_premier, dfar, xref_arconic, xref_lisi, nsn, cessna, sort, status, source_row, range_of, notes)
  VALUES (v_id, p_book, (p_item->>'section_id')::uuid, p_item->>'part_number', (p_item->>'fb_product_id')::int, (p_item->>'part_id')::uuid, (p_item->>'kit_sku_id')::uuid,
          p_item->>'description', round((p_item->>'list_price')::numeric, 3), p_item->>'rule_code', COALESCE(p_item->>'ladder_code','standard'),
          COALESCE((p_item->>'has_premier')::boolean,false), COALESCE((p_item->>'dfar')::boolean,false),
          p_item->>'xref_arconic', p_item->>'xref_lisi', p_item->>'nsn', p_item->>'cessna', COALESCE((p_item->>'sort')::int,0),
          COALESCE(p_item->>'status','priced'), (p_item->>'source_row')::int, p_item->>'range_of', p_item->>'notes')
  ON CONFLICT (id) DO UPDATE SET
    section_id = EXCLUDED.section_id, part_number = EXCLUDED.part_number, fb_product_id = EXCLUDED.fb_product_id, part_id = EXCLUDED.part_id, kit_sku_id = EXCLUDED.kit_sku_id,
    description = EXCLUDED.description, list_price = EXCLUDED.list_price, rule_code = EXCLUDED.rule_code, ladder_code = EXCLUDED.ladder_code,
    has_premier = EXCLUDED.has_premier, dfar = EXCLUDED.dfar, xref_arconic = EXCLUDED.xref_arconic, xref_lisi = EXCLUDED.xref_lisi, nsn = EXCLUDED.nsn, cessna = EXCLUDED.cessna,
    sort = EXCLUDED.sort, status = EXCLUDED.status, notes = EXCLUDED.notes, updated_at = now();
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.pricing_delete_item(p_book uuid, p_item uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles()); PERFORM public._pricing_assert_draft(p_book);
  DELETE FROM public.price_items WHERE id = p_item AND book_id = p_book;
END $$;

/* Bulk % uplift on a draft (catalog sections only; resale untouched — D-PRICE-13/15) */
CREATE OR REPLACE FUNCTION public.pricing_uplift_book(p_book uuid, p_pct numeric, p_section uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles()); PERFORM public._pricing_assert_draft(p_book);
  UPDATE public.price_items i SET list_price = round(i.list_price * (1 + p_pct), 3), updated_at = now()
  FROM public.price_sections s
  WHERE i.section_id = s.id AND i.book_id = p_book AND s.kind = 'catalog' AND i.list_price IS NOT NULL
    AND (p_section IS NULL OR s.id = p_section);
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.pricing_set_customer_tier(p_fb_customer_id integer, p_tier text, p_effective_from date DEFAULT CURRENT_DATE, p_note text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_uid uuid := auth.uid();
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles());
  UPDATE public.customer_pricing SET effective_to = p_effective_from WHERE fb_customer_id = p_fb_customer_id AND effective_to IS NULL AND effective_from < p_effective_from;
  DELETE FROM public.customer_pricing WHERE fb_customer_id = p_fb_customer_id AND effective_to IS NULL AND effective_from >= p_effective_from;
  INSERT INTO public.customer_pricing (fb_customer_id, tier, effective_from, set_by, note) VALUES (p_fb_customer_id, p_tier, p_effective_from, v_uid, p_note) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.pricing_upsert_exception(p_fb_customer_id integer, p_part text, p_mode text, p_value numeric, p_note text DEFAULT NULL, p_effective_from date DEFAULT CURRENT_DATE)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_uid uuid := auth.uid(); v_key text := upper(regexp_replace(p_part, '\s', '', 'g'));
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles());
  UPDATE public.price_exceptions SET effective_to = p_effective_from, closed_by = v_uid, closed_at = now()
   WHERE fb_customer_id = p_fb_customer_id AND part_key = v_key AND effective_to IS NULL;
  INSERT INTO public.price_exceptions (fb_customer_id, part_number, mode, value, note, effective_from, created_by)
  VALUES (p_fb_customer_id, p_part, p_mode, p_value, p_note, p_effective_from, v_uid) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.pricing_close_exception(p_id uuid, p_effective_to date DEFAULT CURRENT_DATE)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles());
  UPDATE public.price_exceptions SET effective_to = p_effective_to, closed_by = auth.uid(), closed_at = now() WHERE id = p_id AND effective_to IS NULL;
END $$;

/* ---------------------------------------------------------------- 6. BRIDGE RPCs */

CREATE OR REPLACE FUNCTION public._fb_clean_name(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(regexp_replace(p, '\s*/\s*(AB|CE|PM|SG|HC)\s*$', '', 'i'), '\s{2,}', ' ', 'g'))
$$;

CREATE OR REPLACE FUNCTION public.fb_upsert_customers(p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  PERFORM public._pricing_gate(ARRAY['integration','admin']);
  INSERT INTO public.fb_customers (fb_customer_id, customer_number, name, name_clean, is_active, salesman, account_groups, payment_terms, fb_date_created, fb_date_modified, synced_at, removed_at)
  SELECT (r->>'id')::int, r->>'number', r->>'name', public._fb_clean_name(r->>'name'),
         COALESCE((r->>'activeFlag')::boolean, true), r->>'salesman',
         CASE WHEN r ? 'groups' THEN ARRAY(SELECT jsonb_array_elements_text(r->'groups')) END,
         r->>'paymentTerms', (r->>'dateCreated')::timestamptz, (r->>'dateLastModified')::timestamptz, now(), NULL
  FROM jsonb_array_elements(p_rows) r
  ON CONFLICT (fb_customer_id) DO UPDATE SET
    customer_number = EXCLUDED.customer_number, name = EXCLUDED.name, name_clean = EXCLUDED.name_clean, is_active = EXCLUDED.is_active,
    salesman = EXCLUDED.salesman, account_groups = COALESCE(EXCLUDED.account_groups, fb_customers.account_groups), payment_terms = EXCLUDED.payment_terms,
    fb_date_created = EXCLUDED.fb_date_created, fb_date_modified = EXCLUDED.fb_date_modified, synced_at = now(), removed_at = NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  /* link SkyNet customers by Fishbowl customer number where not yet linked */
  UPDATE public.fb_customers f SET customer_id = c.id
    FROM public.customers c WHERE f.customer_id IS NULL AND c.customer_id = f.customer_number;
  UPDATE public.fb_sync_state SET last_customers_at = now(), updated_at = now() WHERE id = 1;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.fb_upsert_products(p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  PERFORM public._pricing_gate(ARRAY['integration','admin']);
  INSERT INTO public.fb_products (fb_product_id, product_num, part_num, description, list_price, is_active, synced_at, removed_at)
  SELECT (r->>'id')::int, r->>'num', r->>'partNum', r->>'description', round((r->>'price')::numeric, 3), COALESCE((r->>'activeFlag')::boolean, true), now(), NULL
  FROM jsonb_array_elements(p_rows) r
  ON CONFLICT (fb_product_id) DO UPDATE SET product_num = EXCLUDED.product_num, part_num = EXCLUDED.part_num, description = EXCLUDED.description,
    list_price = EXCLUDED.list_price, is_active = EXCLUDED.is_active, synced_at = now(), removed_at = NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.price_items i SET fb_product_id = p.fb_product_id FROM public.fb_products p WHERE i.fb_product_id IS NULL AND p.product_key = i.part_key;
  UPDATE public.fb_sync_state SET last_products_at = now(), updated_at = now() WHERE id = 1;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.fb_upsert_so_history(p_rows jsonb, p_cursor timestamptz DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  PERFORM public._pricing_gate(ARRAY['integration','admin']);
  INSERT INTO public.fb_so_history_lines (fb_soitem_id, fb_so_id, so_number, fb_customer_id, so_status_id, line_status_id, line_type_id, product_num, part_num, description,
                                          qty_ordered, qty_fulfilled, unit_price, total_price, fb_date_created, fb_date_completed, salesman, synced_at)
  SELECT (r->>'soItemId')::int, (r->>'soId')::int, r->>'soNum', (r->>'customerId')::int, (r->>'soStatusId')::smallint, (r->>'lineStatusId')::smallint, (r->>'typeId')::smallint,
         r->>'productNum', r->>'partNum', r->>'description', (r->>'qtyOrdered')::numeric, (r->>'qtyFulfilled')::numeric, (r->>'unitPrice')::numeric, (r->>'totalPrice')::numeric,
         (r->>'dateCreated')::timestamptz, (r->>'dateCompleted')::timestamptz, r->>'salesman', now()
  FROM jsonb_array_elements(p_rows) r
  ON CONFLICT (fb_soitem_id) DO UPDATE SET fb_customer_id = EXCLUDED.fb_customer_id, so_status_id = EXCLUDED.so_status_id, line_status_id = EXCLUDED.line_status_id,
    product_num = EXCLUDED.product_num, part_num = EXCLUDED.part_num, description = EXCLUDED.description, qty_ordered = EXCLUDED.qty_ordered, qty_fulfilled = EXCLUDED.qty_fulfilled,
    unit_price = EXCLUDED.unit_price, total_price = EXCLUDED.total_price, fb_date_completed = EXCLUDED.fb_date_completed, salesman = EXCLUDED.salesman, synced_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.fb_sync_state SET last_history_at = now(), history_cursor = COALESCE(p_cursor, history_cursor), updated_at = now() WHERE id = 1;
  RETURN n;
END $$;

/* ---------------------------------------------------------------- 7. VIEWS */

CREATE OR REPLACE VIEW public.v_customer_pricing_current WITH (security_invoker = on) AS
SELECT c.fb_customer_id, c.customer_number, c.name, c.name_clean, c.is_active, c.salesman, c.customer_id,
       COALESCE(cp.tier, 'none') AS tier, cp.effective_from AS tier_since, cp.note AS tier_note, cp.set_by AS tier_set_by
FROM public.fb_customers c
LEFT JOIN public.customer_pricing cp ON cp.fb_customer_id = c.fb_customer_id AND cp.effective_to IS NULL;

/* History ∪ open mirror, one row per customer x part */
CREATE OR REPLACE VIEW public.v_customer_purchases WITH (security_invoker = on) AS
WITH lines AS (
  SELECT fb_customer_id, product_key, product_num, description, qty_fulfilled AS qty, unit_price, fb_date_created AS dt, 'history' AS src
  FROM public.fb_so_history_lines WHERE COALESCE(qty_fulfilled,0) > 0
  UNION ALL
  SELECT so.fb_customer_id, upper(regexp_replace(l.product_num, '\s', '', 'g')), l.product_num, l.description, l.qty_ordered, l.unit_price, so.fb_date_created, 'open'
  FROM public.fb_sales_order_lines l JOIN public.fb_sales_orders so ON so.fb_so_id = l.fb_so_id
  WHERE l.removed_at IS NULL AND so.removed_at IS NULL AND l.type_id IN (10, 30)
    AND NOT EXISTS (SELECT 1 FROM public.fb_so_history_lines h WHERE h.fb_soitem_id = l.fb_soitem_id)
)
SELECT fb_customer_id, product_key, MAX(product_num) AS product_num, MAX(description) AS description,
       MIN(dt)::date AS first_bought, MAX(dt)::date AS last_bought, COUNT(*) AS lines,
       SUM(qty) AS qty, SUM(qty * COALESCE(unit_price,0)) AS revenue,
       (array_agg(unit_price ORDER BY dt DESC))[1] AS last_paid,
       MIN(unit_price) FILTER (WHERE unit_price > 0) AS min_paid, MAX(unit_price) AS max_paid
FROM lines GROUP BY fb_customer_id, product_key;

/* ---------------------------------------------------------------- GRANTS */
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
GRANT EXECUTE ON FUNCTION
  public.pricing_book_for_date(date), public._pricing_multiplier(uuid,text,text,text), public.pricing_item_prices(uuid),
  public.pricing_customer_tier(integer,date), public.pricing_get_price(text,integer,numeric,date), public.pricing_customer_sheet(integer,date,text),
  public.pricing_clone_book(uuid,text,date,numeric,text), public.pricing_publish_book(uuid,date), public.pricing_roll_books(), public.pricing_unpublish_book(uuid),
  public.pricing_upsert_section(uuid,uuid,text,int,text,text), public.pricing_upsert_rule(uuid,text,numeric,numeric,numeric,numeric,numeric,numeric,text),
  public.pricing_upsert_ladder(uuid,text,text,jsonb), public.pricing_upsert_item(uuid,jsonb), public.pricing_delete_item(uuid,uuid), public.pricing_uplift_book(uuid,numeric,uuid),
  public.pricing_set_customer_tier(integer,text,date,text), public.pricing_upsert_exception(integer,text,text,numeric,text,date), public.pricing_close_exception(uuid,date),
  public.fb_upsert_customers(jsonb), public.fb_upsert_products(jsonb), public.fb_upsert_so_history(jsonb,timestamptz)
TO authenticated;
GRANT SELECT ON public.v_customer_pricing_current, public.v_customer_purchases TO authenticated;
