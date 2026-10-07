-- ============================================================================
-- D-PRICE-68 — Kits tab reorganised (Matt, 2026-10-07, two screenshots).
-- Active book (Rev 82), in place. One transaction, re-run safe.
--
-- Result, in Matt's order:
--   1  Skybolt CLoc® Sets          ← "Skybolt CLoc® 2000 Series Common Sets" (16 sums) renamed,
--                                    plus the 3 hand-priced sets of "…4000 Series Common Sets"
--                                    (SK40S5-SET1, SK4002FW-SET1, ZG4002-SET1); that section goes.
--   2  Conversion Kits             ← "Skybolt Kits — Conversion Kits (STC)"
--   3  Cowling Kits                ← "Skybolt Kits — Cowling Kit"
--   4  Option Kits                 ← "Skybolt Kits — Option Kit"
--   5  RV Kits                     ← "Skybolt Kits — RV Kit"
--   6  Lancair Kits                ← "Skybolt Kits — Lancair Kit"
--   7  Tooling & Accessory Kits    ← "Skybolt Kits — Accessory/Tool", plus the 15 items of the ONE
--                                    "Skybolt CLoc® Tools …" section that reached the Kits tab (sort 115,
--                                    source_row 2171: SK245-PK, SK2600-TS1, SK4002-TS1/TS2, the Templates,
--                                    Unibits, SK-RVFS1, SKRVC, SK-RVC1 …); that section goes. The other
--                                    five "Skybolt CLoc® Tools …" sections (sorts 110–114, 6 items, 3 with
--                                    section pictures) are Catalog tools and are untouched.
--   Kit Hardware (cost-based) leaves the Kits tab — a client change (CC prompt), not this file;
--   the section itself stays in the book at sort 200.
--   Customer-Specific Machined Parts moves from 205 to 208 so the kit block is contiguous (201–207).
--   The ZLoc® Series Common Sets (7 hand-priced, sort 118) were not named and stay in the Catalog.
--
-- Section identity: the surviving sections keep their rows, ids and source_rows (Sets keeps
-- source_row 12), so section pictures and the cross-revision match (D-PRICE-58) are unaffected;
-- the two sections removed have no pictures. Item sort values are kept; moved items go after the
-- destination's last item.
-- ============================================================================

-- 0. DRY RUN — expect the current layout (Sets at 2, 4000 Sets at 61, Tools at 115, kits 201–207), sets4000 '3 items / 0 pics', tools115 '15 items / 0 pics'
with b as (select id from price_books where status = 'active')
select (select string_agg(s.sort || ' ' || s.name || ' (' || (select count(*) from price_items i where i.section_id = s.id) || ')', ' | ' order by s.sort)
          from price_sections s, b where s.book_id = b.id and (s.sort between 199 and 207 or s.name ilike '%common sets%' or (s.name ilike 'Skybolt CLoc® Tools%' and s.sort = 115))) layout_now,
       (select (select count(*) from price_items i where i.section_id = s.id) || ' items / ' || (select count(*) from price_images p where p.scope = 'section' and p.section_source_row = s.source_row) || ' pics'
          from price_sections s, b where s.book_id = b.id and s.name ilike '%4000 Series Common Sets%') sets4000,
       (select (select count(*) from price_items i where i.section_id = s.id) || ' items / ' || (select count(*) from price_images p where p.scope = 'section' and p.section_source_row = s.source_row) || ' pics'
          from price_sections s, b where s.book_id = b.id and s.name ilike 'Skybolt CLoc® Tools%' and s.sort = 115) tools115;

-- 1. APPLY
begin;

-- a) renames (idempotent)
update price_sections s set name = v.new_name
  from price_books b, (values
    ('Skybolt CLoc® 2000 Series Common Sets', 'Skybolt CLoc® Sets'),
    ('Skybolt Kits — Conversion Kits (STC)', 'Conversion Kits'),
    ('Skybolt Kits — Cowling Kit', 'Cowling Kits'),
    ('Skybolt Kits — Option Kit', 'Option Kits'),
    ('Skybolt Kits — RV Kit', 'RV Kits'),
    ('Skybolt Kits — Lancair Kit', 'Lancair Kits'),
    ('Skybolt Kits — Accessory/Tool', 'Tooling & Accessory Kits')) as v(old_name, new_name)
 where b.id = s.book_id and b.status = 'active' and s.name = v.old_name;

-- b) the 4000 Series sets join the Sets section, after its last item; the empty section goes
update price_items i
   set section_id = t.id, sort = t.max_sort + r.rn, updated_at = now()
  from price_books b,
       (select x.id, x.book_id, coalesce((select max(y.sort) from price_items y where y.section_id = x.id), 0) max_sort
          from price_sections x where x.name = 'Skybolt CLoc® Sets') t,
       (select i2.id, row_number() over (order by i2.sort) rn
          from price_items i2 join price_sections s2 on s2.id = i2.section_id
         where s2.name = 'Skybolt CLoc® 4000 Series Common Sets') r
 where b.id = i.book_id and b.status = 'active' and t.book_id = b.id and i.id = r.id;
delete from price_sections s using price_books b
 where b.id = s.book_id and b.status = 'active' and s.name = 'Skybolt CLoc® 4000 Series Common Sets'
   and not exists (select 1 from price_items i where i.section_id = s.id);

-- c) the Kits-tab Tools section (sort 115) joins Tooling & Accessory Kits; the empty section goes
update price_items i
   set section_id = t.id, sort = t.max_sort + r.rn, updated_at = now()   -- keeps their order, after SK4P3-T26
  from price_books b,
       (select x.id, x.book_id, coalesce((select max(y.sort) from price_items y where y.section_id = x.id), 0) max_sort
          from price_sections x where x.name = 'Tooling & Accessory Kits') t,
       (select i2.id, row_number() over (order by i2.sort) rn
          from price_items i2 join price_sections s2 on s2.id = i2.section_id
         where s2.name like 'Skybolt CLoc® Tools%' and s2.sort = 115) r
 where b.id = i.book_id and b.status = 'active' and t.book_id = b.id and i.id = r.id;
delete from price_sections s using price_books b
 where b.id = s.book_id and b.status = 'active' and s.name like 'Skybolt CLoc® Tools%' and s.sort = 115
   and not exists (select 1 from price_items i where i.section_id = s.id);

-- d) the kit block in Matt's order, contiguous after Kit Hardware (200); Customer-Specific after it
update price_sections s set sort = v.new_sort
  from price_books b, (values
    ('Skybolt CLoc® Sets', 201), ('Conversion Kits', 202), ('Cowling Kits', 203), ('Option Kits', 204),
    ('RV Kits', 205), ('Lancair Kits', 206), ('Tooling & Accessory Kits', 207), ('Customer-Specific Machined Parts', 208)) as v(name, new_sort)
 where b.id = s.book_id and b.status = 'active' and s.name = v.name and s.sort is distinct from v.new_sort;

commit;

-- 2. VERIFY — expect: layout '200 Kit Hardware (cost-based) (40) | 201 Skybolt CLoc® Sets (19) | 202 Conversion Kits (38) |
--    203 Cowling Kits (170) | 204 Option Kits (89) | 205 RV Kits (53) | 206 Lancair Kits (7) | 207 Tooling & Accessory Kits (16) |
--    (TEST 2026-10-07 gave exactly this, Sets 19)
--    208 Customer-Specific Machined Parts (11)' · old_names_left 0 · tools_sections_left 5 · dup_sorts 0 ·
--    sets_src 12 · sk40s5_set1_section 'Skybolt CLoc® Sets' · sk2600_ts1_section 'Tooling & Accessory Kits'
with b as (select id from price_books where status = 'active')
select (select string_agg(s.sort || ' ' || s.name || ' (' || (select count(*) from price_items i where i.section_id = s.id) || ')', ' | ' order by s.sort)
          from price_sections s, b where s.book_id = b.id and s.sort between 200 and 208) layout,
       (select count(*) from price_sections s, b where s.book_id = b.id and (s.name like 'Skybolt Kits — %' or s.name ilike '%Common Sets%' and s.name not ilike '%ZLoc%')) old_names_left,
       (select count(*) from price_sections s, b where s.book_id = b.id and s.name like 'Skybolt CLoc® Tools%') tools_sections_left,
       (select count(*) - count(distinct s.sort) from price_sections s, b where s.book_id = b.id) dup_sorts,
       (select s.source_row from price_sections s, b where s.book_id = b.id and s.name = 'Skybolt CLoc® Sets') sets_src,
       (select s.name from price_items i join price_sections s on s.id = i.section_id, b where i.book_id = b.id and i.part_key = 'SK40S5-SET1') sk40s5_set1_section,
       (select s.name from price_items i join price_sections s on s.id = i.section_id, b where i.book_id = b.id and i.part_key = 'SK2600-TS1') sk2600_ts1_section;

-- ROLLBACK (only if needed): reverse the renames; re-create the two sections (names above, source_row 1093 and 2171,
-- sorts 61 and 115) and move SK40S5-SET1 / SK4002FW-SET1 / ZG4002-SET1 and the 15 tools back; restore sorts 2, 201–207, 205.
