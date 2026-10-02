-- ============================================================================
-- D-PRICE-63 — Split the "QL4 Stud Nutplates" section (89 items) of the active
-- book into three sections. Matt, 2026-10-01 (screenshot).
--
--   QL4 Stud Nutplates          QL4-21, QL4-NUT, QL4C-CAGE, QL4-BASE   4  (stays, same row)
--   Quad Lead Series - Tools    QL4C1-TOOL, QL4C2-TOOL                 2  (new)
--   Southco Fasteners           82-… and 85-… Southco parts           83  (new; 12 are no_price)
--
-- Placement: the two new sections sit directly after QL4 Stud Nutplates (sort
-- 194 and 195 on Rev 82); every later section's sort moves by +2. Item sort
-- values are untouched (they are already contiguous within each group).
-- source_row is null on the new sections — they come from no workbook row — so
-- the Catalog's cross-revision section match falls back to the unique name
-- (findSectionInBook, D-PRICE-58). Section pictures are keyed by source_row,
-- so the new sections start with none; part pictures are unaffected.
-- Fishbowl: none — the product tree path is rule:ladder, not section.
--
-- Scope: the ACTIVE book only (Rev 82). Rev 81 keeps the merged section as history.
-- Re-run safe: every step is guarded by the new sections' existence / the
-- item's current section, so a second run changes nothing.
-- ============================================================================

-- 1. DRY RUN — expect: items 89 · to_tools 2 · to_southco 83 · stays 4 · unaccounted 0
select count(*) as items,
       count(*) filter (where i.part_key in ('QL4C1-TOOL', 'QL4C2-TOOL')) as to_tools,
       count(*) filter (where i.part_key ~ '^8[25]-') as to_southco,
       count(*) filter (where i.part_key in ('QL4-21', 'QL4-NUT', 'QL4C-CAGE', 'QL4-BASE')) as stays,
       count(*) filter (where i.part_key not in ('QL4C1-TOOL', 'QL4C2-TOOL', 'QL4-21', 'QL4-NUT', 'QL4C-CAGE', 'QL4-BASE')
                          and i.part_key !~ '^8[25]-') as unaccounted
  from price_items i
  join price_sections s on s.id = i.section_id
  join price_books b on b.id = i.book_id and b.status = 'active'
 where s.name = 'QL4 Stud Nutplates';

-- 2. APPLY
begin;

-- a) make room: every section after QL4 Stud Nutplates moves +2 (skipped once Southco Fasteners exists)
update price_sections s
   set sort = s.sort + 2
  from price_books b
 where b.id = s.book_id and b.status = 'active'
   and s.sort > (select x.sort from price_sections x where x.book_id = b.id and x.name = 'QL4 Stud Nutplates')
   and not exists (select 1 from price_sections y where y.book_id = b.id and y.name = 'Southco Fasteners');

-- b) the two new sections, directly after QL4 Stud Nutplates
insert into price_sections (book_id, name, sort, kind, header_note, source_row)
select b.id, v.name, x.sort + v.off, 'catalog', null, null
  from price_books b
  join price_sections x on x.book_id = b.id and x.name = 'QL4 Stud Nutplates'
  cross join (values ('Quad Lead Series - Tools', 1), ('Southco Fasteners', 2)) as v(name, off)
 where b.status = 'active'
   and not exists (select 1 from price_sections y where y.book_id = b.id and y.name = v.name);

-- c) move the tools
update price_items i
   set section_id = t.id
  from price_books b, price_sections s, price_sections t
 where b.id = i.book_id and b.status = 'active'
   and s.id = i.section_id and s.name = 'QL4 Stud Nutplates'
   and t.book_id = b.id and t.name = 'Quad Lead Series - Tools'
   and i.part_key in ('QL4C1-TOOL', 'QL4C2-TOOL');

-- d) move the Southco parts
update price_items i
   set section_id = t.id
  from price_books b, price_sections s, price_sections t
 where b.id = i.book_id and b.status = 'active'
   and s.id = i.section_id and s.name = 'QL4 Stud Nutplates'
   and t.book_id = b.id and t.name = 'Southco Fasteners'
   and i.part_key ~ '^8[25]-';

commit;

-- 3. VERIFY — expect three rows in order: QL4 Stud Nutplates 193 / 4 items,
--    Quad Lead Series - Tools 194 / 2, Southco Fasteners 195 / 83; dup_sorts 0 on every row
select s.sort, s.name, count(i.id) as items,
       (select count(*) - count(distinct x.sort) from price_sections x where x.book_id = b.id) as dup_sorts
  from price_sections s
  join price_books b on b.id = s.book_id and b.status = 'active'
  left join price_items i on i.section_id = s.id
 where s.name in ('QL4 Stud Nutplates', 'Quad Lead Series - Tools', 'Southco Fasteners')
 group by b.id, s.sort, s.name
 order by s.sort;

-- ROLLBACK (only if needed — moves the items back and removes the two sections):
-- begin;
-- update price_items i set section_id = (select id from price_sections x where x.book_id = i.book_id and x.name = 'QL4 Stud Nutplates')
--   from price_sections s, price_books b
--  where s.id = i.section_id and b.id = i.book_id and b.status = 'active' and s.name in ('Quad Lead Series - Tools', 'Southco Fasteners');
-- delete from price_sections s using price_books b where b.id = s.book_id and b.status = 'active' and s.name in ('Quad Lead Series - Tools', 'Southco Fasteners');
-- update price_sections s set sort = s.sort - 2 from price_books b
--  where b.id = s.book_id and b.status = 'active' and s.sort > (select x.sort from price_sections x where x.book_id = b.id and x.name = 'QL4 Stud Nutplates');
-- commit;
