-- D-PRICE-47 v3 — pricing_refresh_hardware_costs adopts unpriced kit components that have a cost on file.
-- psql or Editor (one CREATE OR REPLACE, then one SELECT). TEST and PROD. Same signature → grants kept.
-- Gap found 2026-09-14: MS21059L3 (blocks 25 RV/Lancair kits) had a cost ($1.20) but already existed in
-- Rev 82 as an unpriced row, so it was neither auto-added (row exists) nor repriced (not cost_plus).

create or replace function public.pricing_refresh_hardware_costs(p_book uuid, p_markup numeric default 1.0)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_updated int; v_no_cost int; v_added int; v_adopted int;
begin
  perform public._pricing_gate(public._pricing_edit_roles());
  perform public._pricing_assert_draft(p_book);
  if p_markup is null or p_markup < 0 then
    raise exception 'pricing_refresh_hardware_costs: p_markup must be >= 0 (got %)', p_markup using errcode = '22023';
  end if;

  -- a. every cost_plus item with a cost on file: Each = cost × (1 + markup)
  update public.price_items i
     set list_price = round(c.last_cost * (1 + p_markup), 3), status = 'priced', updated_at = now(),
         notes = 'Cost-plus: ' || c.last_cost || ' × ' || (1 + p_markup) || ' — ' || coalesce(c.last_vendor, '?') || ' ' || coalesce(c.last_po_number, '') || ' ' || to_char(c.last_cost_date, 'YYYY-MM-DD') || ' (D-PRICE-47)'
    from public.fb_part_costs c
   where i.book_id = p_book and i.cost_plus and c.part_key = i.part_key and c.last_cost > 0;
  get diagnostics v_updated = row_count;

  -- b. kit components with a cost but NO row in the book: add to the Kit Hardware section
  insert into public.price_items (book_id, section_id, part_number, description, list_price, rule_code, ladder_code, status, sort, notes, cost_plus, fb_product_id)
  select p_book, s.id, coalesce(c.product_num, c.part_num),
         (select p.description from public.fb_products p where p.product_key = c.part_key limit 1),
         round(c.last_cost * (1 + p_markup), 3),
         (select rule_code from public.price_items where book_id = p_book and cost_plus limit 1),
         coalesce((select ladder_code from public.price_items where book_id = p_book and cost_plus limit 1), 'none'),
         'priced', 5000 + row_number() over (order by c.part_key),
         'Cost-plus: ' || c.last_cost || ' × ' || (1 + p_markup) || ' — ' || coalesce(c.last_vendor, '?') || ' ' || coalesce(c.last_po_number, '') || ' ' || to_char(c.last_cost_date, 'YYYY-MM-DD') || ' (D-PRICE-47, auto-added for a kit sum)',
         true,
         (select p.fb_product_id from public.fb_products p where p.product_key = c.part_key limit 1)
  from public.price_sections s
  join public.fb_part_costs c on c.last_cost > 0
  where s.book_id = p_book and s.name = 'Kit Hardware (cost-based)'
    and exists (select 1 from public.price_kit_components k join public.price_items ki on ki.id = k.item_id
                where ki.book_id = p_book and k.component_key = c.part_key)
    and not exists (select 1 from public.price_items x where x.book_id = p_book and x.part_key = c.part_key);
  get diagnostics v_added = row_count;

  -- c. kit components that EXIST in the book unpriced and have a cost: adopt as cost-based and price them (v3)
  update public.price_items i
     set cost_plus = true, list_price = round(c.last_cost * (1 + p_markup), 3), status = 'priced', updated_at = now(),
         notes = 'Cost-plus: ' || c.last_cost || ' × ' || (1 + p_markup) || ' — ' || coalesce(c.last_vendor, '?') || ' ' || coalesce(c.last_po_number, '') || ' ' || to_char(c.last_cost_date, 'YYYY-MM-DD') || ' (D-PRICE-47, adopted: was unpriced and blocks a kit sum)'
    from public.fb_part_costs c
   where i.book_id = p_book and not i.cost_plus
     and (i.list_price is null or i.status = 'no_price')
     and c.part_key = i.part_key and c.last_cost > 0
     and exists (select 1 from public.price_kit_components k join public.price_items ki on ki.id = k.item_id
                 where ki.book_id = p_book and k.component_key = i.part_key);
  get diagnostics v_adopted = row_count;

  v_no_cost := (select count(*) from public.price_items i
                 where i.book_id = p_book and i.cost_plus
                   and not exists (select 1 from public.fb_part_costs c where c.part_key = i.part_key and c.last_cost > 0));

  return jsonb_build_object('updated', v_updated, 'added', v_added, 'adopted', v_adopted, 'no_cost_on_file', v_no_cost, 'markup', p_markup);
end $$;

-- run it again on the draft (PROD; TEST once its fb_part_costs is populated)
select public.pricing_refresh_hardware_costs(
  (select id from public.price_books where status = 'draft' order by effective_from desc limit 1), 1.0);
-- expect adopted >= 1 (MS21059L3) — then re-run the coverage query: RV should rise toward 37 and Lancair toward 6
