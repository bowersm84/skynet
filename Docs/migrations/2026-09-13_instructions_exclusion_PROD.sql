-- D-PRICE-43 — Instruction sheets out of every price list / quote / purchase view — PROD run (2026-09-13)
-- Already applied and verified on TEST. Run each block on its own in the PROD SQL Editor, in order.
-- Expected results are noted on each block; stop and send me the output if one differs.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- BLOCK 1 — preview (read-only). Expect the same 14 products as TEST, all already_excluded = false.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
select p.product_num, p.description, p.list_price, p.is_active,
       exists (select 1 from public.pricing_excluded_products x where x.product_num = p.product_num) as already_excluded,
       (select count(*) from public.fb_so_history_lines l where l.product_key = p.product_key) as history_lines
from public.fb_products p
where p.product_num ~* '\.DOC$'
   or p.product_num ~* 'INSTRUCTION'
   or p.description ~* '^INSTRUCTIONS?( |-|$)'
order by 1;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- BLOCK 2 — add them. Idempotent (NOT EXISTS on product_num); fills product_key itself only when
--   the column is not generated. The Editor reports "no rows returned" — the NOTICE carries the count.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_gen text; v_n int;
begin
  v_gen := (select is_generated from information_schema.columns
             where table_schema = 'public' and table_name = 'pricing_excluded_products' and column_name = 'product_key');

  if v_gen = 'ALWAYS' then
    insert into public.pricing_excluded_products (product_num, reason)
    select p.product_num, 'instruction sheet — free document (D-PRICE-43)'
    from public.fb_products p
    where (p.product_num ~* '\.DOC$' or p.product_num ~* 'INSTRUCTION' or p.description ~* '^INSTRUCTIONS?( |-|$)')
      and not exists (select 1 from public.pricing_excluded_products x where x.product_num = p.product_num);
  else
    insert into public.pricing_excluded_products (product_num, product_key, reason)
    select p.product_num, p.product_key, 'instruction sheet — free document (D-PRICE-43)'
    from public.fb_products p
    where (p.product_num ~* '\.DOC$' or p.product_num ~* 'INSTRUCTION' or p.description ~* '^INSTRUCTIONS?( |-|$)')
      and not exists (select 1 from public.pricing_excluded_products x where x.product_num = p.product_num);
  end if;

  get diagnostics v_n = row_count;
  raise notice 'pricing_excluded_products: % instruction products added (product_key generated = %)', v_n, coalesce(v_gen, '?');
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- BLOCK 3 — verify. Expect new_rows 14, missing_key 0.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
select count(*) as new_rows, count(*) filter (where product_key is null) as missing_key
from public.pricing_excluded_products
where reason like 'instruction sheet%';

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- BLOCK 4 — verify on Irwin. Expect 0 / 0.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
with irwin as (select fb_customer_id from public.fb_customers where name ilike 'irwin%' order by fb_customer_id limit 1)
select
  (select count(*) from public.v_customer_purchases v, irwin
     where v.fb_customer_id = irwin.fb_customer_id and (v.product_num ~* '\.DOC$' or v.product_num ~* 'INSTRUCTION')) as purchases_view_docs,
  (select count(*) from irwin, public.pricing_customer_sheet(irwin.fb_customer_id, current_date, 'purchased') s
     where s.part_number ~* '\.DOC$' or s.part_number ~* 'INSTRUCTION')                                        as builder_sheet_docs;
