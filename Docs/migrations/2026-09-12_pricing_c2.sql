/* ============================================================================
   S11 Batch C2 — saved quotes (D-PRICE-23)
   Supabase SQL Editor, TEST first. Idempotent.
   quotes / quote_lines; Q-YYMM-NNNN via pricing_next_number('Q'); prices frozen on
   the quote, valid 14 days from issue; pricing_save_quote (view roles), status RPC.
   ============================================================================ */
CREATE TABLE IF NOT EXISTS public.quotes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_number     text NOT NULL UNIQUE,
  fb_customer_id   integer,
  customer_name    text NOT NULL,
  customer_number  text,
  tier             text,
  contact_name     text,
  contact_email    text,
  customer_po      text,
  book_id          uuid REFERENCES public.price_books(id),
  rev_label        text,
  as_of            date NOT NULL,
  issued_on        date NOT NULL DEFAULT CURRENT_DATE,
  valid_until      date NOT NULL,
  status           text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','won','lost','cancelled','superseded')),
  payment_terms    text,
  notes            text,
  subtotal         numeric(14,2) NOT NULL DEFAULT 0,
  line_count       integer NOT NULL DEFAULT 0,
  override_count   integer NOT NULL DEFAULT 0,
  created_by       uuid REFERENCES public.profiles(id),
  created_by_name  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  sent_to          text,
  superseded_by    uuid REFERENCES public.quotes(id),
  fb_so_number     text
);
CREATE INDEX IF NOT EXISTS quotes_customer_idx ON public.quotes(fb_customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS quotes_created_idx ON public.quotes(created_at DESC);

CREATE TABLE IF NOT EXISTS public.quote_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id          uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
  sort              integer NOT NULL DEFAULT 0,
  part_number       text NOT NULL,
  part_key          text GENERATED ALWAYS AS (upper(regexp_replace(part_number, '\s', '', 'g'))) STORED,
  description       text,
  dfar              boolean NOT NULL DEFAULT false,
  qty               numeric(12,2) NOT NULL CHECK (qty > 0),
  unit_price        numeric(12,4) NOT NULL,
  extended          numeric(14,2) NOT NULL,
  col_key           text,
  recommended_col   text,
  recommended_price numeric(12,4),
  basis             text,
  is_override       boolean NOT NULL DEFAULT false,
  note              text
);
CREATE INDEX IF NOT EXISTS quote_lines_quote_idx ON public.quote_lines(quote_id, sort);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['quotes','quote_lines'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_authenticated', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', t || '_select_authenticated', t);
  END LOOP; END $$;

/* p = { fb_customer_id, customer_name, customer_number, tier, contact_name, contact_email, customer_po, book_id, rev_label, as_of,
         payment_terms, notes, supersedes (quote id, optional),
         lines: [{ part_number, description, dfar, qty, unit_price, col_key, recommended_col, recommended_price, basis, is_override, note }] } */
CREATE OR REPLACE FUNCTION public.pricing_save_quote(p jsonb)
RETURNS TABLE (id uuid, quote_number text, valid_until date, subtotal numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE v_id uuid; v_num text; v_uid uuid := auth.uid(); v_name text; v_sub numeric; v_n int; v_ov int; v_valid date; v_sup uuid;
BEGIN
  PERFORM public._pricing_gate(public._pricing_view_roles());
  IF jsonb_array_length(COALESCE(p->'lines','[]'::jsonb)) = 0 THEN RAISE EXCEPTION 'QUOTE: at least one line required'; END IF;
  IF COALESCE(p->>'customer_name','') = '' THEN RAISE EXCEPTION 'QUOTE: customer name required (use "Walk-in" for cash customers)'; END IF;
  SELECT full_name INTO v_name FROM public.profiles WHERE id = v_uid;
  v_num := public.pricing_next_number('Q');
  v_valid := CURRENT_DATE + 14;
  INSERT INTO public.quotes (quote_number, fb_customer_id, customer_name, customer_number, tier, contact_name, contact_email, customer_po, book_id, rev_label, as_of, valid_until, payment_terms, notes, created_by, created_by_name)
  VALUES (v_num, (p->>'fb_customer_id')::int, p->>'customer_name', p->>'customer_number', p->>'tier', p->>'contact_name', p->>'contact_email', p->>'customer_po',
          (p->>'book_id')::uuid, p->>'rev_label', COALESCE((p->>'as_of')::date, CURRENT_DATE), v_valid, COALESCE(p->>'payment_terms','Per account terms'), p->>'notes', v_uid, v_name)
  RETURNING quotes.id INTO v_id;
  INSERT INTO public.quote_lines (quote_id, sort, part_number, description, dfar, qty, unit_price, extended, col_key, recommended_col, recommended_price, basis, is_override, note)
  SELECT v_id, ord, x->>'part_number', x->>'description', COALESCE((x->>'dfar')::boolean,false), (x->>'qty')::numeric, round((x->>'unit_price')::numeric, 4),
         round((x->>'qty')::numeric * (x->>'unit_price')::numeric, 2), x->>'col_key', x->>'recommended_col', (x->>'recommended_price')::numeric, x->>'basis',
         COALESCE((x->>'is_override')::boolean,false), x->>'note'
  FROM jsonb_array_elements(p->'lines') WITH ORDINALITY AS e(x, ord);
  SELECT SUM(extended), COUNT(*), COUNT(*) FILTER (WHERE is_override) INTO v_sub, v_n, v_ov FROM public.quote_lines WHERE quote_id = v_id;
  UPDATE public.quotes SET subtotal = v_sub, line_count = v_n, override_count = v_ov WHERE quotes.id = v_id;
  v_sup := (p->>'supersedes')::uuid;
  IF v_sup IS NOT NULL THEN UPDATE public.quotes SET status = 'superseded', superseded_by = v_id, updated_at = now() WHERE quotes.id = v_sup AND status = 'issued'; END IF;
  RETURN QUERY SELECT v_id, v_num, v_valid, v_sub;
END $$;

CREATE OR REPLACE FUNCTION public.pricing_set_quote_status(p_id uuid, p_status text, p_fb_so_number text DEFAULT NULL, p_sent_to text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._pricing_gate(public._pricing_view_roles());
  IF p_status NOT IN ('issued','won','lost','cancelled') THEN RAISE EXCEPTION 'QUOTE: bad status %', p_status; END IF;
  UPDATE public.quotes SET status = p_status, fb_so_number = COALESCE(p_fb_so_number, fb_so_number),
         sent_at = CASE WHEN p_sent_to IS NOT NULL THEN now() ELSE sent_at END, sent_to = COALESCE(p_sent_to, sent_to), updated_at = now()
   WHERE id = p_id;
END $$;
REVOKE ALL ON FUNCTION public.pricing_save_quote(jsonb), public.pricing_set_quote_status(uuid,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pricing_save_quote(jsonb), public.pricing_set_quote_status(uuid,text,text,text) TO authenticated;

/* verify */
SELECT count(*) AS quotes FROM public.quotes;
