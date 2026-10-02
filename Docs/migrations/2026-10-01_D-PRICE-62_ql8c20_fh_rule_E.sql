-- ============================================================================
-- D-PRICE-62 — QL8C20-0FH .. QL8C20-7FH carry rule M in the active book; the
-- whole QL8C20-xFH series is rule E (QL8C20-8FH .. 18FH already are).
-- Matt, 2026-10-01 (screenshot, Price Books → Rev 82 → Stud Nut - Flat Head).
--
-- Scope: the ACTIVE book only (Rev 82 — Oct 2026). Rev 81 (superseded) carries
-- the same M on these 8 and is left alone as history (it still prices its own
-- dates, D-PRICE-56).
--
-- Effect: tier prices rise — M tiers are .48 / .472 / .464, E tiers .56 / .55 / .53;
-- quantity columns are the same except 300+ (.79 → .78). QL8C20-0FH tier 3:
-- $9.34 → $10.67. Checked on PROD before writing: no price list line, quote line
-- or open special on QL8C20-0..7FH since 2026-10-01, so no issued document is
-- contradicted.
--
-- Fishbowl: the product tree path is Product:SkyNet:<rule>:<ladder>, so these 8
-- products move M:standard → E:standard and show as "missing" on v_fb_tree_drift
-- until the next TREE push from the Fishbowl Sync tab. List prices do not change,
-- so no price drift; the "SN E …" rules already exist.
--
-- Re-run safe: the UPDATE matches only rows still on M (UPDATE 0 on a re-run).
-- Run in the SQL Editor as a whole (the last result set is the verification) or
-- step by step in psql.
-- ============================================================================

-- 1. DRY RUN — expect 8 rows, every one rule M on ladder standard
select i.part_number, i.rule_code, i.ladder_code, i.list_price,
       round(i.list_price * m.m_tier3, 2) as tier3_now,
       round(i.list_price * e.m_tier3, 2) as tier3_after
  from price_items i
  join price_books b on b.id = i.book_id and b.status = 'active'
  join price_rules m on m.book_id = i.book_id and m.code = 'M'
  join price_rules e on e.book_id = i.book_id and e.code = 'E'
 where i.part_key ~ '^QL8C20-[0-7]FH$'
 order by i.sort;

-- 2. APPLY — expect UPDATE 8 (first run) / UPDATE 0 (re-run)
begin;
update price_items i
   set rule_code = 'E'
  from price_books b
 where b.id = i.book_id and b.status = 'active'
   and i.part_key ~ '^QL8C20-[0-7]FH$'
   and i.rule_code = 'M';
commit;

-- 3. VERIFY — expect still_on_M = 0, on_E = 19, the series listed E throughout
select count(*) filter (where i.rule_code = 'M') as still_on_M,
       count(*) filter (where i.rule_code = 'E') as on_E,
       string_agg(i.part_number || '=' || i.rule_code, ', ' order by i.sort) as series
  from price_items i
  join price_books b on b.id = i.book_id and b.status = 'active'
 where i.part_key like 'QL8C20-%FH';

-- ROLLBACK (only if needed — puts the 8 back on M):
-- update price_items i set rule_code = 'M' from price_books b
--  where b.id = i.book_id and b.status = 'active' and i.part_key ~ '^QL8C20-[0-7]FH$' and i.rule_code = 'E';
