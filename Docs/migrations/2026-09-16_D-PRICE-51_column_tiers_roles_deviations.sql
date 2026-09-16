-- D-PRICE-51 — Quantity-column tiers, tier assignment restricted to admin + pricing_manager, quote deviations view.
-- psql, TEST then PROD. Same-signature CREATE OR REPLACE throughout (grants kept). Sales-team requests 2026-09-16.
--
-- 1. Column tiers: a customer may be placed on the 100+, 300+ or 500+ column as a standing level. Rule (Matt):
--    "300 column means 300 column — never worse, never better." The engine prices that column regardless of
--    quantity; if an item's ladder has no such column, its Each applies. Kits sum their components at the same column.
-- 2. Tier assignment: only admin or the new `pricing_manager` role (April) may call pricing_set_customer_tier.
--    Other pricing edits keep _pricing_edit_roles() = admin.
-- 3. v_quote_deviations: every quote line where the rep left the recommendation — manual price, different
--    column, or a customer-part special — with the money involved. Read by the portal's Deviations view.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1a. tier vocabulary
-- ─────────────────────────────────────────────────────────────────────────────────────────────
alter table public.customer_pricing drop constraint if exists customer_pricing_tier_check;
alter table public.customer_pricing add constraint customer_pricing_tier_check
  check (tier = any (array['none','tier1','tier2','tier3','premier','q100','q300','q500']));

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1b. engine: column tiers price their column, no quantity logic (kit branch unchanged from D-PRICE-50)
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

  /* Kits: sum the components at the same customer / qty / date (one level). All-or-nothing (D-PRICE-50). */
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

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. tier assignment: admin or pricing_manager
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public._pricing_tier_roles() returns text[] language sql immutable as $$ select array['admin', 'pricing_manager'] $$;

CREATE OR REPLACE FUNCTION public.pricing_set_customer_tier(p_fb_customer_id integer, p_tier text, p_effective_from date DEFAULT CURRENT_DATE, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; v_uid uuid := auth.uid();
BEGIN
  PERFORM public._pricing_gate(public._pricing_tier_roles());   -- D-PRICE-51: admin or pricing_manager
  UPDATE public.customer_pricing SET effective_to = p_effective_from WHERE fb_customer_id = p_fb_customer_id AND effective_to IS NULL AND effective_from < p_effective_from;
  DELETE FROM public.customer_pricing WHERE fb_customer_id = p_fb_customer_id AND effective_to IS NULL AND effective_from >= p_effective_from;
  INSERT INTO public.customer_pricing (fb_customer_id, tier, effective_from, set_by, note) VALUES (p_fb_customer_id, p_tier, p_effective_from, v_uid, p_note) RETURNING id INTO v_id;
  RETURN v_id;
END $function$;

-- April: pricing_manager as an additional role (primary role customer_service unchanged). Absolute set.
update public.profiles set roles = array_append(coalesce(roles, '{}'), 'pricing_manager')
 where username = 'abraun' and not ('pricing_manager' = any (coalesce(roles, '{}')));

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 3. quote deviations — every line where the rep left the recommendation
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace view public.v_quote_deviations as
select q.id as quote_id, q.quote_number, q.status, q.issued_on, q.as_of, q.rev_label,
       q.fb_customer_id, q.customer_name, q.tier as customer_tier,
       q.created_by, q.created_by_name,
       l.id as line_id, l.sort, l.part_number, l.description, l.qty,
       l.recommended_col, l.recommended_price, l.col_key, l.unit_price, l.basis, l.is_override, l.note,
       case when l.basis = 'manual' then 'manual'
            when l.basis = 'exception' then 'special'
            when l.col_key is distinct from l.recommended_col then 'column'
            else 'price' end                                                       as deviation_kind,
       round(l.unit_price - l.recommended_price, 2)                                 as delta_unit,
       round((l.unit_price - l.recommended_price) * l.qty, 2)                       as delta_extended,
       case when l.recommended_price > 0 then round((l.unit_price / l.recommended_price - 1) * 100, 1) end as delta_pct
from public.quote_lines l
join public.quotes q on q.id = l.quote_id
where l.is_override
   or l.basis in ('manual', 'exception')
   or l.col_key is distinct from l.recommended_col
   or l.unit_price is distinct from l.recommended_price;
comment on view public.v_quote_deviations is 'D-PRICE-51: quote lines priced away from the engine recommendation (manual, other column, special). Portal Deviations view; admin + pricing_manager.';
grant select on public.v_quote_deviations to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- verify
-- ─────────────────────────────────────────────────────────────────────────────────────────────
select username, role, roles from public.profiles where username = 'abraun';                                        -- roles contains pricing_manager
select pg_get_constraintdef(oid) from pg_constraint where conname = 'customer_pricing_tier_check';                  -- includes q100/q300/q500
select count(*) as deviations_so_far, count(*) filter (where deviation_kind = 'manual') as manual from public.v_quote_deviations;
-- column-tier behaviour: a part priced with qty 1 for a customer on q300 must equal its q300 column
-- (run once a customer has been placed on q300 in the portal; until then this returns the qty-1 list price)
select unit_price_2dp, basis, col_key, tier from public.pricing_get_price('SK4002-20SFW', null, 1);
