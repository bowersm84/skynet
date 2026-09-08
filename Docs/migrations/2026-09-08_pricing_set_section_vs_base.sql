-- D-PRICE-39 — set one price-book section to a total % over a base (in-effect) book.
-- Run in the Supabase SQL Editor: TEST first, then PROD. Idempotent (CREATE OR REPLACE on a new name;
-- no existing overload). No data is touched by this migration — only the RPC is created.
--
-- Each priced row in the section whose part_key exists in the base book gets
--   list_price = round(base.list_price * (1 + p_total_pct), 3)
-- Rows with no base price are left unchanged and counted as `unmatched`.
-- Absolute, re-runnable: setting +25% twice yields +25%. Mirrors pricing_uplift_book's gates.

CREATE OR REPLACE FUNCTION public.pricing_set_section_vs_base(
  p_book uuid, p_section uuid, p_base uuid, p_total_pct numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_updated int; v_unmatched int; v_kind text; v_section_book uuid;
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles());
  PERFORM public._pricing_assert_draft(p_book);

  IF p_base IS NULL OR p_base = p_book THEN
    RAISE EXCEPTION 'pricing_set_section_vs_base: base book must be a different book' USING ERRCODE = '22023';
  END IF;
  IF p_total_pct IS NULL OR p_total_pct <= -1 THEN
    RAISE EXCEPTION 'pricing_set_section_vs_base: p_total_pct must be > -1 (got %)', p_total_pct USING ERRCODE = '22023';
  END IF;

  SELECT s.kind, s.book_id INTO v_kind, v_section_book FROM public.price_sections s WHERE s.id = p_section;
  IF v_section_book IS NULL OR v_section_book <> p_book THEN
    RAISE EXCEPTION 'pricing_set_section_vs_base: section % is not in book %', p_section, p_book USING ERRCODE = '22023';
  END IF;
  IF v_kind <> 'catalog' THEN
    RAISE EXCEPTION 'pricing_set_section_vs_base: only catalog sections can be repriced (D-PRICE-13)' USING ERRCODE = '22023';
  END IF;

  -- Base Each per part_key; if a base book ever carried a duplicate key, the higher Each wins (D-PRICE-11).
  WITH base AS (
    SELECT b.part_key, max(b.list_price) AS list_price
    FROM public.price_items b
    WHERE b.book_id = p_base AND b.status = 'priced' AND b.list_price IS NOT NULL
    GROUP BY b.part_key
  )
  UPDATE public.price_items i
     SET list_price = round(base.list_price * (1 + p_total_pct), 3), updated_at = now()
    FROM base
   WHERE i.book_id = p_book AND i.section_id = p_section
     AND i.status = 'priced' AND i.list_price IS NOT NULL
     AND i.part_key = base.part_key;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  SELECT count(*) INTO v_unmatched
    FROM public.price_items i
   WHERE i.book_id = p_book AND i.section_id = p_section
     AND i.status = 'priced' AND i.list_price IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.price_items b
                      WHERE b.book_id = p_base AND b.status = 'priced' AND b.list_price IS NOT NULL
                        AND b.part_key = i.part_key);

  RETURN jsonb_build_object('updated', v_updated, 'unmatched', v_unmatched);
END $$;

REVOKE ALL ON FUNCTION public.pricing_set_section_vs_base(uuid, uuid, uuid, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pricing_set_section_vs_base(uuid, uuid, uuid, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.pricing_set_section_vs_base(uuid, uuid, uuid, numeric) TO authenticated, service_role;

-- Verify (run as its own statement):
-- SELECT pg_get_function_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname = 'pricing_set_section_vs_base';
-- Expected one row: p_book uuid, p_section uuid, p_base uuid, p_total_pct numeric
