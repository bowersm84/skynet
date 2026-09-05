/* ============================================================================
   S11 Batch C1 — price lists, part images
   Supabase SQL Editor, TEST first (then PROD at cutover). Idempotent.
   1. pricing_counters + pricing_next_number('PL') → PL-YYMM-NNNN (also used for Q- in C2)
   2. price_lists / price_list_lines + pricing_save_price_list(jsonb) (view roles; records
      changed prices as customer specials when record_specials = true — D-PRICE-29)
   3. price_images + seed (198 images extracted from the Rev 81 workbook; files go to the
      public Storage bucket `pricing-images` — upload the zip's parts/ and sections/ folders)
   ============================================================================ */

/* ---------- 1. numbering */
CREATE TABLE IF NOT EXISTS public.pricing_counters (
  kind text NOT NULL, yymm text NOT NULL, n integer NOT NULL DEFAULT 0, PRIMARY KEY (kind, yymm));
ALTER TABLE public.pricing_counters ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.pricing_next_number(p_kind text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_yymm text := to_char(now() AT TIME ZONE 'America/New_York', 'YYMM'); v_n integer;
BEGIN
  INSERT INTO public.pricing_counters (kind, yymm, n) VALUES (p_kind, v_yymm, 1)
  ON CONFLICT (kind, yymm) DO UPDATE SET n = public.pricing_counters.n + 1 RETURNING n INTO v_n;
  RETURN p_kind || '-' || v_yymm || '-' || lpad(v_n::text, 4, '0');
END $$;
REVOKE ALL ON FUNCTION public.pricing_next_number(text) FROM PUBLIC, anon;

/* ---------- 2. price lists */
CREATE TABLE IF NOT EXISTS public.price_lists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_number     text NOT NULL UNIQUE,
  fb_customer_id  integer NOT NULL,
  customer_name   text NOT NULL,
  customer_number text,
  tier            text,
  book_id         uuid REFERENCES public.price_books(id),
  rev_label       text,
  as_of           date NOT NULL,
  status          text NOT NULL DEFAULT 'issued' CHECK (status IN ('draft','issued','superseded')),
  record_specials boolean NOT NULL DEFAULT true,
  notes           text,
  created_by      uuid REFERENCES public.profiles(id),
  created_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  sent_to         text,
  superseded_by   uuid REFERENCES public.price_lists(id)
);
CREATE INDEX IF NOT EXISTS price_lists_customer_idx ON public.price_lists(fb_customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.price_list_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_list_id     uuid NOT NULL REFERENCES public.price_lists(id) ON DELETE CASCADE,
  sort              integer NOT NULL DEFAULT 0,
  part_number       text NOT NULL,
  part_key          text GENERATED ALWAYS AS (upper(regexp_replace(part_number, '\s', '', 'g'))) STORED,
  description       text,
  dfar              boolean NOT NULL DEFAULT false,
  each_price        numeric(12,3),
  customer_price    numeric(12,3) NOT NULL,
  recommended_price numeric(12,3),
  basis             text,
  col_key           text,
  is_override       boolean NOT NULL DEFAULT false,
  last_paid         numeric(12,4),
  note              text
);
CREATE INDEX IF NOT EXISTS price_list_lines_list_idx ON public.price_list_lines(price_list_id, sort);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['price_lists','price_list_lines'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_authenticated', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', t || '_select_authenticated', t);
  END LOOP; END $$;

/* p = { fb_customer_id, customer_name, customer_number, tier, book_id, rev_label, as_of, record_specials, notes,
         lines: [{ part_number, description, dfar, each_price, customer_price, recommended_price, basis, col_key, is_override, last_paid, note }] } */
CREATE OR REPLACE FUNCTION public.pricing_save_price_list(p jsonb)
RETURNS TABLE (id uuid, list_number text, specials_recorded integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_id uuid; v_num text; v_uid uuid := auth.uid(); v_name text; v_cust integer; v_rec boolean; v_n integer := 0; l jsonb; v_t3 numeric; v_prev uuid;
BEGIN
  PERFORM public._pricing_gate(public._pricing_view_roles());
  v_cust := (p->>'fb_customer_id')::int; v_rec := COALESCE((p->>'record_specials')::boolean, true);
  IF v_cust IS NULL OR jsonb_array_length(COALESCE(p->'lines','[]'::jsonb)) = 0 THEN RAISE EXCEPTION 'PRICE_LIST: customer and at least one line required'; END IF;
  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_uid;
  v_num := public.pricing_next_number('PL');
  INSERT INTO public.price_lists (list_number, fb_customer_id, customer_name, customer_number, tier, book_id, rev_label, as_of, record_specials, notes, created_by, created_by_name)
  VALUES (v_num, v_cust, p->>'customer_name', p->>'customer_number', p->>'tier', (p->>'book_id')::uuid, p->>'rev_label', COALESCE((p->>'as_of')::date, CURRENT_DATE), v_rec, p->>'notes', v_uid, v_name)
  RETURNING price_lists.id INTO v_id;
  INSERT INTO public.price_list_lines (price_list_id, sort, part_number, description, dfar, each_price, customer_price, recommended_price, basis, col_key, is_override, last_paid, note)
  SELECT v_id, ord, x->>'part_number', x->>'description', COALESCE((x->>'dfar')::boolean,false), (x->>'each_price')::numeric, round((x->>'customer_price')::numeric, 3),
         (x->>'recommended_price')::numeric, x->>'basis', x->>'col_key', COALESCE((x->>'is_override')::boolean,false), (x->>'last_paid')::numeric, x->>'note'
  FROM jsonb_array_elements(p->'lines') WITH ORDINALITY AS e(x, ord);
  /* previous issued list for this customer becomes superseded */
  UPDATE public.price_lists SET status = 'superseded', superseded_by = v_id, updated_at = now()
   WHERE fb_customer_id = v_cust AND status = 'issued' AND price_lists.id <> v_id;
  /* record overrides as customer-part specials (fixed price; closes any open special on the part) */
  IF v_rec THEN
    FOR l IN SELECT x FROM jsonb_array_elements(p->'lines') x WHERE COALESCE((x->>'is_override')::boolean,false) LOOP
      UPDATE public.price_exceptions SET effective_to = COALESCE((p->>'as_of')::date, CURRENT_DATE), closed_by = v_uid, closed_at = now()
       WHERE fb_customer_id = v_cust AND part_key = upper(regexp_replace(l->>'part_number', '\s', '', 'g')) AND effective_to IS NULL;
      INSERT INTO public.price_exceptions (fb_customer_id, part_number, mode, value, note, effective_from, created_by)
      VALUES (v_cust, l->>'part_number', 'fixed', round((l->>'customer_price')::numeric, 3), 'from price list ' || v_num, COALESCE((p->>'as_of')::date, CURRENT_DATE), v_uid);
      v_n := v_n + 1;
    END LOOP;
  END IF;
  RETURN QUERY SELECT v_id, v_num, v_n;
END $$;

CREATE OR REPLACE FUNCTION public.pricing_mark_price_list_sent(p_id uuid, p_sent_to text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._pricing_gate(public._pricing_view_roles());
  UPDATE public.price_lists SET sent_at = now(), sent_to = p_sent_to, updated_at = now() WHERE id = p_id;
END $$;
REVOKE ALL ON FUNCTION public.pricing_save_price_list(jsonb), public.pricing_mark_price_list_sent(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pricing_save_price_list(jsonb), public.pricing_mark_price_list_sent(uuid, text) TO authenticated;

/* ---------- 3. images */
CREATE TABLE IF NOT EXISTS public.price_images (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope              text NOT NULL CHECK (scope IN ('part','section')),
  part_key           text,
  section_source_row integer,
  storage_path       text NOT NULL,
  source_row         integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_images_target CHECK ((scope = 'part' AND part_key IS NOT NULL) OR (scope = 'section' AND section_source_row IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS price_images_part_uniq ON public.price_images(part_key) WHERE scope = 'part';
CREATE UNIQUE INDEX IF NOT EXISTS price_images_section_uniq ON public.price_images(section_source_row) WHERE scope = 'section';
ALTER TABLE public.price_images ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS price_images_select_authenticated ON public.price_images;
CREATE POLICY price_images_select_authenticated ON public.price_images FOR SELECT TO authenticated USING (true);

INSERT INTO public.price_images (scope, part_key, section_source_row, storage_path, source_row) VALUES
  ('part', 'SK40S5-3S', NULL, 'parts/SK40S5-3S.jpeg', 1290),
  ('part', 'SKEHF5-40', NULL, 'parts/SKEHF5-40.jpeg', 2221),
  ('section', NULL, 2228, 'sections/2228.jpeg', 2228),
  ('section', NULL, 2260, 'sections/2260.jpeg', 2260),
  ('part', 'SKAO65-40', NULL, 'parts/SKAO65-40.jpeg', 2268),
  ('section', NULL, 2360, 'sections/2360.jpeg', 2360),
  ('part', 'SK946', NULL, 'parts/SK946.jpeg', 2375),
  ('part', 'SK945CL', NULL, 'parts/SK945CL.jpeg', 2371),
  ('part', 'SK945', NULL, 'parts/SK945.jpeg', 2364),
  ('part', 'SK945EHF', NULL, 'parts/SK945EHF.jpeg', 2367),
  ('part', 'SK3-150', NULL, 'parts/SK3-150.jpeg', 2527),
  ('section', NULL, 2380, 'sections/2380.jpeg', 2380),
  ('part', 'GP3B', NULL, 'parts/GP3B.jpeg', 2385),
  ('section', NULL, 2627, 'sections/2627.jpeg', 2626),
  ('section', NULL, 2617, 'sections/2617.jpeg', 2616),
  ('part', 'SK294186-1-.070', NULL, 'parts/SK294186-1-.070.jpeg', 2692),
  ('section', NULL, 2289, 'sections/2289.jpeg', 2289),
  ('part', 'ZGO65-40', NULL, 'parts/ZGO65-40.jpeg', 2297),
  ('section', NULL, 2641, 'sections/2641.jpeg', 2639),
  ('part', 'SK215-4', NULL, 'parts/SK215-4.jpeg', 2058),
  ('part', 'SK4003-3S', NULL, 'parts/SK4003-3S.jpeg', 1749),
  ('part', 'SK220-2SW/ONUT', NULL, 'parts/SK220-2SW_ONUT.jpeg', 764),
  ('part', 'SK2500-2S', NULL, 'parts/SK2500-2S.jpeg', 2805),
  ('part', 'ZG2500-2', NULL, 'parts/ZG2500-2.jpeg', 2835),
  ('part', 'SK25S51-1', NULL, 'parts/SK25S51-1.jpeg', 2819),
  ('part', 'ZG25S51-1', NULL, 'parts/ZG25S51-1.jpeg', 2880),
  ('part', 'SK25S3-1S', NULL, 'parts/SK25S3-1S.jpeg', 2912),
  ('part', 'ZG25S3-1', NULL, 'parts/ZG25S3-1.jpeg', 2928),
  ('part', 'SK2500-1SW', NULL, 'parts/SK2500-1SW.jpeg', 2976),
  ('part', 'ZG2500-2W', NULL, 'parts/ZG2500-2W.jpeg', 2992),
  ('part', 'SK2500R1S', NULL, 'parts/SK2500R1S.jpeg', 3022),
  ('part', 'ZG2500R1B', NULL, 'parts/ZG2500R1B.jpeg', 3053),
  ('section', NULL, 3037, 'sections/3037.jpeg', 3037),
  ('part', 'ZG25S51-2B', NULL, 'parts/ZG25S51-2B.jpeg', 2896),
  ('part', 'ZG25S3-1B', NULL, 'parts/ZG25S3-1B.jpeg', 2944),
  ('part', 'ZG2500-2WB', NULL, 'parts/ZG2500-2WB.jpeg', 3008),
  ('part', 'ZG2600-1', NULL, 'parts/ZG2600-1.jpeg', 64),
  ('part', 'ZG26S51-2', NULL, 'parts/ZG26S51-2.jpeg', 171),
  ('part', 'ZG26S51-1B', NULL, 'parts/ZG26S51-1B.jpeg', 185),
  ('part', 'SK2600-2SW', NULL, 'parts/SK2600-2SW.jpeg', 217),
  ('part', 'ZG2600-2W', NULL, 'parts/ZG2600-2W.jpeg', 234),
  ('part', 'ZG2600-2WB', NULL, 'parts/ZG2600-2WB.jpeg', 249),
  ('section', NULL, 311, 'sections/311.jpeg', 311),
  ('section', NULL, 339, 'sections/339.jpeg', 339),
  ('section', NULL, 353, 'sections/353.jpeg', 353),
  ('part', 'ZG28S3-1', NULL, 'parts/ZG28S3-1.jpeg', 609),
  ('part', 'SK28S3-1S', NULL, 'parts/SK28S3-1S.jpeg', 592),
  ('part', 'SK2800-1S', NULL, 'parts/SK2800-1S.jpeg', 576),
  ('part', 'SK212-10A', NULL, 'parts/SK212-10A.jpeg', 673),
  ('part', 'SK212-12AD', NULL, 'parts/SK212-12AD.jpeg', 710),
  ('part', 'SK209-31S', NULL, 'parts/SK209-31S.jpeg', 756),
  ('part', 'SK220-1S', NULL, 'parts/SK220-1S.jpeg', 762),
  ('part', 'SK4002-3S', NULL, 'parts/SK4002-3S.jpeg', 1147),
  ('part', 'ZG4002-4', NULL, 'parts/ZG4002-4.jpeg', 1248),
  ('part', 'SK4002-5S45', NULL, 'parts/SK4002-5S45.jpeg', 1226),
  ('part', 'SK40S5-4S45', NULL, 'parts/SK40S5-4S45.jpeg', 1358),
  ('part', 'SK4002-2SW', NULL, 'parts/SK4002-2SW.jpeg', 1551),
  ('part', 'SK4002-2SR', NULL, 'parts/SK4002-2SR.jpeg', 1627),
  ('part', 'ZG4002-2R', NULL, 'parts/ZG4002-2R.jpeg', 1735),
  ('part', 'SK-G', NULL, 'parts/SK-G.jpeg', 1838),
  ('part', 'SK-O', NULL, 'parts/SK-O.jpeg', 1858),
  ('part', 'SK-GS', NULL, 'parts/SK-GS.jpeg', 1846),
  ('section', NULL, 1993, 'sections/1993.jpeg', 1993),
  ('part', 'SK-R4GS', NULL, 'parts/SK-R4GS.jpeg', 1995),
  ('section', NULL, 1980, 'sections/1980.jpeg', 1985),
  ('section', NULL, 1931, 'sections/1931.jpeg', 1931),
  ('section', NULL, 1884, 'sections/1884.jpeg', 1878),
  ('part', 'SK-N3S', NULL, 'parts/SK-N3S.jpeg', 1973),
  ('part', 'SK214-16', NULL, 'parts/SK214-16.jpeg', 2003),
  ('section', NULL, 2120, 'sections/2120.jpeg', 2120),
  ('part', 'SK2700-2', NULL, 'parts/SK2700-2.jpeg', 502),
  ('part', 'SK27S3-2', NULL, 'parts/SK27S3-2.jpeg', 532),
  ('part', 'SK4002-8', NULL, 'parts/SK4002-8.jpeg', 1106),
  ('part', 'SK40S5-8', NULL, 'parts/SK40S5-8.jpeg', 1268),
  ('part', 'SK2600-1', NULL, 'parts/SK2600-1.jpeg', 33),
  ('part', 'SK26S8-2', NULL, 'parts/SK26S8-2.jpeg', 107),
  ('part', 'SK221-2SN', NULL, 'parts/SK221-2SN.jpeg', 770),
  ('part', 'SK221-2AN', NULL, 'parts/SK221-2AN.jpeg', 768),
  ('part', 'ZG25T3-1', NULL, 'parts/ZG25T3-1.jpeg', 2960),
  ('part', 'SK28T3-2S', NULL, 'parts/SK28T3-2S.jpeg', 626),
  ('part', 'ZG28T3-1', NULL, 'parts/ZG28T3-1.jpeg', 640),
  ('part', 'SK-N114-2S', NULL, 'parts/SK-N114-2S.jpeg', 1962),
  ('section', NULL, 2093, 'sections/2093.jpeg', 2093),
  ('part', 'SK410-32A', NULL, 'parts/SK410-32A.jpeg', 2098),
  ('part', 'SK221-3S', NULL, 'parts/SK221-3S.jpeg', 771),
  ('section', NULL, 796, 'sections/796.jpeg', 795),
  ('part', 'SK4000-200', NULL, 'parts/SK4000-200.jpeg', 2113),
  ('part', 'ZG2600-1B', NULL, 'parts/ZG2600-1B.jpeg', 92),
  ('part', 'ZG2600-1A1BLK', NULL, 'parts/ZG2600-1A1BLK.jpeg', 78),
  ('part', 'ZG2500-1B', NULL, 'parts/ZG2500-1B.jpeg', 2864),
  ('section', NULL, 2078, 'sections/2078.jpeg', 2078),
  ('part', 'SK244A161C', NULL, 'parts/SK244A161C.jpeg', 2052),
  ('part', 'SK201A21A', NULL, 'parts/SK201A21A.jpeg', 681),
  ('part', 'SK203A21A', NULL, 'parts/SK203A21A.jpeg', 687),
  ('part', 'ZG2500-1A1BLK', NULL, 'parts/ZG2500-1A1BLK.jpeg', 2849),
  ('part', 'SKN4-2G', NULL, 'parts/SKN4-2G.jpeg', 1935),
  ('part', 'ZGN4-2', NULL, 'parts/ZGN4-2.jpeg', 1965),
  ('part', 'SK2601-2SFW', NULL, 'parts/SK2601-2SFW.jpeg', 470),
  ('part', 'SK2603-2SFW', NULL, 'parts/SK2603-2SFW.jpeg', 485),
  ('part', 'SK4001-3SFW', NULL, 'parts/SK4001-3SFW.jpeg', 1705),
  ('part', 'SK4002-3SFW', NULL, 'parts/SK4002-3SFW.jpeg', 1690),
  ('section', NULL, 2027, 'sections/2027.jpeg', 2027),
  ('part', 'SK4004-3SFW', NULL, 'parts/SK4004-3SFW.jpeg', 1721),
  ('part', 'SK2600-2SFW', NULL, 'parts/SK2600-2SFW.jpeg', 455),
  ('section', NULL, 2189, 'sections/2189.jpeg', 2189),
  ('section', NULL, 2203, 'sections/2203.jpeg', 2199),
  ('section', NULL, 2032, 'sections/2032.jpeg', 2032),
  ('part', 'SK40S5-7SH', NULL, 'parts/SK40S5-7SH.jpeg', 1314),
  ('part', 'SKEJ-40A', NULL, 'parts/SKEJ-40A.jpeg', 2243),
  ('section', NULL, 2305, 'sections/2305.jpeg', 2305),
  ('section', NULL, 2632, 'sections/2632.jpeg', 2629),
  ('section', NULL, 2622, 'sections/2622.jpeg', 2620),
  ('section', NULL, 2156, 'sections/2156.jpeg', 2155),
  ('section', NULL, 2125, 'sections/2125.jpeg', 2124),
  ('part', 'SK40S128-2-2AA', NULL, 'parts/SK40S128-2-2AA.jpeg', 1797),
  ('part', 'ZGF65-40.25', NULL, 'parts/ZGF65-40.25.jpeg', 2560),
  ('part', 'ZGO65-40.25', NULL, 'parts/ZGO65-40.25.jpeg', 2566),
  ('part', 'SKEHF5-40.25', NULL, 'parts/SKEHF5-40.25.jpeg', 2580),
  ('part', 'SKEHF6-40.25', NULL, 'parts/SKEHF6-40.25.jpeg', 2585),
  ('part', 'SKFO65-40.25', NULL, 'parts/SKFO65-40.25.jpeg', 2550),
  ('part', 'SKFO65-65.25', NULL, 'parts/SKFO65-65.25.jpeg', 2554),
  ('part', 'SK-DP1.25', NULL, 'parts/SK-DP1.25.jpeg', 2574),
  ('section', NULL, 2605, 'sections/2605.jpeg', 2604),
  ('section', NULL, 2601, 'sections/2601.jpeg', 2600),
  ('part', 'SK5-325.25', NULL, 'parts/SK5-325.25.jpeg', 2591),
  ('part', 'SKPG8', NULL, 'parts/SKPG8.jpeg', 2137),
  ('part', 'SK40S41-2S', NULL, 'parts/SK40S41-2S.jpeg', 1199),
  ('part', 'SK35C37', NULL, 'parts/SK35C37.jpeg', 2453),
  ('part', 'SK4002-4SD', NULL, 'parts/SK4002-4SD.jpeg', 1481),
  ('part', 'SK4002-3SD', NULL, 'parts/SK4002-3SD.jpeg', 1480),
  ('part', 'SK4002-3W', NULL, 'parts/SK4002-3W.jpeg', 1525),
  ('section', NULL, 2149, 'sections/2149.jpeg', 2148),
  ('part', 'SK26022', NULL, 'parts/SK26022.jpeg', 2158),
  ('section', NULL, 2164, 'sections/2164.jpeg', 2163),
  ('part', 'SK2600-1S', NULL, 'parts/SK2600-1S.jpeg', 50),
  ('part', 'SK26S22-2', NULL, 'parts/SK26S22-2.jpeg', 369),
  ('part', 'SK201A01AE', NULL, 'parts/SK201A01AE.jpeg', 810),
  ('section', NULL, 1069, 'sections/1069.jpeg', 1068),
  ('part', 'SK40S47-3', NULL, 'parts/SK40S47-3.jpeg', 1642),
  ('part', 'SK40S47-2S', NULL, 'parts/SK40S47-2S.jpeg', 1673),
  ('part', 'SK2018-A2*', NULL, 'parts/SK2018-A2_.jpeg', 2675),
  ('part', 'SK2018-DA1', NULL, 'parts/SK2018-DA1.jpeg', 2676),
  ('part', 'SK2018C*', NULL, 'parts/SK2018C_.jpeg', 2648),
  ('part', 'SK2018-2AP', NULL, 'parts/SK2018-2AP.jpeg', 2673),
  ('section', NULL, 3535, 'sections/3535.jpeg', 3534),
  ('part', 'SK-TT706-B', NULL, 'parts/SK-TT706-B.jpeg', 2654),
  ('part', 'SK4002-2SW45', NULL, 'parts/SK4002-2SW45.jpeg', 1613),
  ('part', 'SK40S41-2SC', NULL, 'parts/SK40S41-2SC.jpeg', 1333),
  ('part', 'SK40S41-2SW', NULL, 'parts/SK40S41-2SW.jpeg', 1599),
  ('part', 'SK2600-2W', NULL, 'parts/SK2600-2W.jpeg', 202),
  ('part', 'SK26S22-2B', NULL, 'parts/SK26S22-2B.jpeg', 395),
  ('section', NULL, 325, 'sections/325.jpeg', 325),
  ('part', 'SK245A162A', NULL, 'parts/SK245A162A.jpeg', 2081),
  ('part', 'SK26S51-1', NULL, 'parts/SK26S51-1.jpeg', 121),
  ('part', 'SK26S51-1B', NULL, 'parts/SK26S51-1B.jpeg', 152),
  ('part', 'SK4012-2SW', NULL, 'parts/SK4012-2SW.jpeg', 1576),
  ('part', 'SK2700-1S', NULL, 'parts/SK2700-1S.jpeg', 516),
  ('part', 'SK27S3-2S', NULL, 'parts/SK27S3-2S.jpeg', 547),
  ('part', 'SK-O18S', NULL, 'parts/SK-O18S.jpeg', 1873),
  ('part', 'SKFJ5-40SS', NULL, 'parts/SKFJ5-40SS.jpeg', 2428),
  ('part', 'SKAJ4-40SS', NULL, 'parts/SKAJ4-40SS.jpeg', 2405),
  ('part', 'SK26S22-3B90', NULL, 'parts/SK26S22-3B90.jpeg', 424),
  ('section', NULL, 789, 'sections/789.jpeg', 789),
  ('section', NULL, 1059, 'sections/1059.jpeg', 1059),
  ('part', 'SK21060L08', NULL, 'parts/SK21060L08.jpeg', 879),
  ('part', 'SK35C37B1', NULL, 'parts/SK35C37B1.jpeg', 2466),
  ('section', NULL, 1078, 'sections/1078.jpeg', 1078),
  ('part', 'SK21060L08E', NULL, 'parts/SK21060L08E.jpeg', 841),
  ('part', 'SK21060DC08', NULL, 'parts/SK21060DC08.jpeg', 856),
  ('part', 'SKN4-2G-YEL', NULL, 'parts/SKN4-2G-YEL.jpeg', 1939),
  ('part', 'SKN4-3G-YEL', NULL, 'parts/SKN4-3G-YEL.jpeg', 1944),
  ('part', 'SKN4-4G-YEL', NULL, 'parts/SKN4-4G-YEL.jpeg', 1949),
  ('part', 'SKM10-1032-3AS', NULL, 'parts/SKM10-1032-3AS.jpeg', 980),
  ('section', NULL, 1030, 'sections/1030.jpeg', 1030),
  ('part', 'SKN-632ACR', NULL, 'parts/SKN-632ACR.jpeg', 1042),
  ('part', 'SKN-632PCR', NULL, 'parts/SKN-632PCR.jpeg', 1050),
  ('section', NULL, 1021, 'sections/1021.jpeg', 1021),
  ('section', NULL, 913, 'sections/913.jpeg', 911),
  ('part', 'SK-FL68-250A', NULL, 'parts/SK-FL68-250A.jpeg', 921),
  ('part', 'SK-FL68-125A', NULL, 'parts/SK-FL68-125A.jpeg', 918),
  ('part', 'SK-FL68-125C', NULL, 'parts/SK-FL68-125C.jpeg', 929),
  ('section', NULL, 936, 'sections/936.jpeg', 934),
  ('part', 'SK-FL68-3.17A', NULL, 'parts/SK-FL68-3.17A.jpeg', 942),
  ('section', NULL, 948, 'sections/948.jpeg', 946),
  ('part', 'SK-FL68-3.17C', NULL, 'parts/SK-FL68-3.17C.jpeg', 954),
  ('section', NULL, 959, 'sections/959.jpeg', 959),
  ('part', 'QL4S-EXT4', NULL, 'parts/QL4S-EXT4.jpeg', 3398),
  ('section', NULL, 3325, 'sections/3325.jpeg', 3324),
  ('part', 'QL8C10', NULL, 'parts/QL8C10.jpeg', 3359),
  ('section', NULL, 3421, 'sections/3421.jpeg', 3419),
  ('part', 'QL8C20-0FH', NULL, 'parts/QL8C20-0FH.jpeg', 3141),
  ('section', NULL, 3165, 'sections/3165.jpeg', 3165),
  ('part', 'QL8C28-0KN', NULL, 'parts/QL8C28-0KN.jpeg', 3242),
  ('part', 'QL8C32-0FHS', NULL, 'parts/QL8C32-0FHS.jpeg', 3268),
  ('part', 'QL8-21-1FH', NULL, 'parts/QL8-21-1FH.jpeg', 3290),
  ('part', 'QL8C24-0PH', NULL, 'parts/QL8C24-0PH.jpeg', 3194),
  ('part', 'SK27S8-1-2S', NULL, 'parts/SK27S8-1-2S.jpeg', 562),
  ('section', NULL, 3337, 'sections/3337.jpeg', 3335)
ON CONFLICT DO NOTHING;

/* range-derived items inherit the image anchored on their range row */
INSERT INTO public.price_images (scope, part_key, storage_path, source_row)
SELECT DISTINCT 'part', i.part_key, im.storage_path, im.source_row
FROM public.price_items i
JOIN public.price_images im ON im.scope = 'part' AND im.part_key = upper(regexp_replace(i.range_of, '\s', '', 'g'))
WHERE i.range_of IS NOT NULL
ON CONFLICT DO NOTHING;

/* public bucket for the image files (upload parts/ and sections/ from pricing-images.zip via the dashboard) */
INSERT INTO storage.buckets (id, name, public) VALUES ('pricing-images', 'pricing-images', true) ON CONFLICT (id) DO NOTHING;

/* ---------- verify (run separately) */
SELECT scope, count(*) FROM public.price_images GROUP BY 1;                 /* part ≈ 175 + range-derived, section 45 */
SELECT public.pricing_next_number('TEST');                                  /* TEST-2609-0001 (harmless counter row) */
