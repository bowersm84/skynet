-- D-PRICE-49 (SkyNet side) — pricing_kit_prices(p_as_of): one row per registry kit from the book in effect
-- on a date, for the skybolt-kits sync (Edge Function `sync-kits`). Read-only. psql or Editor. TEST then PROD.
--
-- Σ is computed exactly as the engine's 'each' column does for component_sum items: sum(qty × component Each),
-- one level deep, null if any component is unpriced. Kits are matched to the book by kit_sku_id.

create or replace function public.pricing_kit_prices(p_as_of date default current_date)
returns table (
  kit_number      text,
  description     text,
  family          text,
  is_active       boolean,
  in_book         boolean,          -- the kit has an item in the book in effect
  book_id         uuid,
  book_label      text,
  effective_from  date,
  list_price      numeric,          -- resolved Σ (2 dp) or null
  resolved        boolean,
  component_count integer,
  unpriced_count  integer,
  unpriced_keys   text[],
  bom             jsonb             -- [{component, description, qty, each}] from price_kit_components + book
)
language sql stable security definer set search_path to 'public'
as $$
  with b as (
    -- the book in effect on p_as_of: latest effective_from <= p_as_of among active/scheduled books
    select id, rev_label, effective_from
    from public.price_books
    where status in ('active', 'scheduled') and effective_from <= p_as_of
    order by effective_from desc limit 1
  ),
  ki as (
    select i.id as item_id, i.kit_sku_id
    from public.price_items i, b
    where i.book_id = b.id and i.kit_sku_id is not null and i.status = 'component_sum'
  ),
  comp as (
    select ki.kit_sku_id, c.component_part_number, c.component_key, c.qty, x.list_price,
           (select p.description from public.fb_products p where p.product_key = c.component_key limit 1) as description
    from ki
    join public.price_kit_components c on c.item_id = ki.item_id
    left join public.price_items x on x.book_id = (select id from b) and x.part_key = c.component_key
                                   and x.status = 'priced' and x.list_price is not null
  ),
  agg as (
    select kit_sku_id,
           count(*)::int                                   as component_count,
           count(*) filter (where list_price is null)::int as unpriced_count,
           array_agg(component_key order by component_key) filter (where list_price is null) as unpriced_keys,
           sum(qty * list_price)                            as sum_each,
           jsonb_agg(jsonb_build_object('component', component_part_number, 'description', description,
                                        'qty', qty, 'each', list_price) order by component_part_number) as bom
    from comp group by kit_sku_id
  )
  select k.part_number, k.description, k.family, k.is_active,
         (ki.kit_sku_id is not null)                       as in_book,
         b.id, b.rev_label, b.effective_from,
         case when a.unpriced_count = 0 then round(a.sum_each, 2) end as list_price,
         coalesce(a.unpriced_count = 0, false)             as resolved,
         coalesce(a.component_count, 0), coalesce(a.unpriced_count, 0),
         coalesce(a.unpriced_keys, '{}'::text[]),
         coalesce(a.bom, '[]'::jsonb)
  from public.kit_skus k
  cross join b
  left join ki  on ki.kit_sku_id = k.id
  left join agg a on a.kit_sku_id = k.id
  order by k.part_number
$$;
revoke all on function public.pricing_kit_prices(date) from public;
revoke execute on function public.pricing_kit_prices(date) from anon;
grant execute on function public.pricing_kit_prices(date) to authenticated, service_role;   -- the Edge Function calls it with the service role

-- verify (today = Rev 81: kits are not in Rev 81, so in_book is false for all 477 and list_price null — expected;
--         the second call, as of 2026-10-01, must show Rev 82 with 314 resolved once Rev 82 is scheduled)
select count(*) as kits, count(*) filter (where in_book) as in_book, count(*) filter (where resolved) as resolved,
       min(book_label) as book
from public.pricing_kit_prices(current_date);

select count(*) as kits, count(*) filter (where in_book) as in_book, count(*) filter (where resolved) as resolved,
       min(book_label) as book
from public.pricing_kit_prices('2026-10-01');   -- Rev 82 only counts once it is 'scheduled' or 'active'

select kit_number, list_price, resolved, unpriced_count, unpriced_keys
from public.pricing_kit_prices('2026-10-01') where in_book and not resolved order by 1;   -- the 17 open kits
