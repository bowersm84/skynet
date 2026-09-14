-- D-PRICE-46 — Kits into the price book as component sums (2026-09-14)
-- SQL Editor, one block at a time. Registry blocks (1) run on TEST then PROD. Book blocks (2–4) touch only
-- the DRAFT book (Rev 82) and are dry-run by default. Absolute values throughout; re-runnable.
-- Editor rule learned this round: inside a DO block, do not create temporary tables and use only := assignments — the Supabase SQL Editor injects row-level-security statements after anything that
-- looks like a table creation and splits the $$ body. Workbook data therefore rides inline as VALUES.
--
-- Rule (Matt, 2026-09-14): a kit's list price is the sum of its BOM components at the current book's Each
-- (status 'component_sum', evaluated per column by the engine); hardware components are valued at 2× their
-- latest received purchase cost; family ratios are all 1.0; no minimum-increase floor. Trim and Fuel Tank
-- kits are discontinued and priced nowhere.
-- Seeds come from Skybolt_Kit_Pricing_Analysis_v4_072826.xlsx: 'Kit Analysis' (family per kit) and
-- 'Hardware Exposure' (last PO cost per hardware SKU). Hardware costs are an interim seed until the bridge
-- feeds fb_part_costs nightly (D-PRICE-47).

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- BLOCK 0 — pre-checks (read-only). Expect: one draft book (Rev 82); the set item used as the template for
--   rule/ladder codes exists; kit_skus has no 'family' column yet (or already has it if re-running).
-- ═════════════════════════════════════════════════════════════════════════════════════════════
select id, rev_label, status, effective_from from public.price_books order by effective_from;
select part_number, status, rule_code, ladder_code, s.name as section
from public.price_items i join public.price_sections s on s.id = i.section_id
where i.book_id = (select id from public.price_books where status = 'draft' order by effective_from desc limit 1)
  and i.status = 'component_sum' order by 1 limit 5;
select column_name from information_schema.columns where table_name = 'kit_skus' and column_name = 'family';
select count(*) as kits, count(*) filter (where is_active) as active from public.kit_skus;

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- BLOCK 1 — Kit Registry: family column, seed from the workbook, inactivate Trim / Fuel Tank.
--   TEST first, then PROD. Idempotent. Re-run it: the earlier version used a temporary table.
-- ═════════════════════════════════════════════════════════════════════════════════════════════
alter table public.kit_skus add column if not exists family text
  check (family in ('Cowling Kit','Option Kit','RV Kit','Lancair Kit','Trim Kit','Fuel Tank Kit'));
comment on column public.kit_skus.family is 'Kit family (D-PRICE-46). Seeded from Skybolt_Kit_Pricing_Analysis_v4_072826.xlsx; groups the price-book Kits sections. Trim / Fuel Tank = discontinued.';

do $$
declare v_n int; v_off int;
begin
  update public.kit_skus k set family = f.family
    from (values
    ('AC500-C1', 'Cowling Kit'),
    ('AC500-C1P', 'Cowling Kit'),
    ('AC500-C2', 'Cowling Kit'),
    ('AC500-C2A', 'Cowling Kit'),
    ('AC500-C2AP', 'Cowling Kit'),
    ('AC500-C2P', 'Cowling Kit'),
    ('AC500-C3', 'Cowling Kit'),
    ('AC500-C3P', 'Cowling Kit'),
    ('AC500-C4', 'Cowling Kit'),
    ('AC500-C4P', 'Cowling Kit'),
    ('B35LC2090', 'Cowling Kit'),
    ('B35LC5080', 'Cowling Kit'),
    ('B35LC5100', 'Cowling Kit'),
    ('B35UC530', 'Cowling Kit'),
    ('B55-C1', 'Cowling Kit'),
    ('B55-C1P', 'Cowling Kit'),
    ('B55-C2', 'Cowling Kit'),
    ('B55-C2P', 'Cowling Kit'),
    ('B56-C1P', 'Cowling Kit'),
    ('B60-C1', 'Cowling Kit'),
    ('B60-C1P', 'Cowling Kit'),
    ('B76-C1', 'Cowling Kit'),
    ('B76-C1P', 'Cowling Kit'),
    ('B95-C1', 'Cowling Kit'),
    ('BM-C1', 'Cowling Kit'),
    ('BM-C1P', 'Cowling Kit'),
    ('BM-C1S', 'Cowling Kit'),
    ('BM-C2', 'Cowling Kit'),
    ('BM-C2P', 'Cowling Kit'),
    ('C150-C1', 'Cowling Kit'),
    ('C150-C1P', 'Cowling Kit'),
    ('C152-C1', 'Cowling Kit'),
    ('C152-C1P', 'Cowling Kit'),
    ('C152-C2', 'Cowling Kit'),
    ('C152-C2P', 'Cowling Kit'),
    ('C172-C1', 'Cowling Kit'),
    ('C172-C1P', 'Cowling Kit'),
    ('C172-C2', 'Cowling Kit'),
    ('C172-C2P', 'Cowling Kit'),
    ('C172-C3', 'Cowling Kit'),
    ('C172-C3P', 'Cowling Kit'),
    ('C172-C4', 'Cowling Kit'),
    ('C172-C4P', 'Cowling Kit'),
    ('C172-C5', 'Cowling Kit'),
    ('C172-C5P', 'Cowling Kit'),
    ('C172-C6', 'Cowling Kit'),
    ('C172-C6P', 'Cowling Kit'),
    ('C172-C8P', 'Cowling Kit'),
    ('C177-C1', 'Cowling Kit'),
    ('C177-C1P', 'Cowling Kit'),
    ('C180-C1', 'Cowling Kit'),
    ('C180-C1P', 'Cowling Kit'),
    ('C180-C2', 'Cowling Kit'),
    ('C180-C2P', 'Cowling Kit'),
    ('C182-C1', 'Cowling Kit'),
    ('C182-C1P', 'Cowling Kit'),
    ('C182-C2', 'Cowling Kit'),
    ('C182-C2P', 'Cowling Kit'),
    ('C182-C3', 'Cowling Kit'),
    ('C182-C3P', 'Cowling Kit'),
    ('C182-C4', 'Cowling Kit'),
    ('C182-C4P', 'Cowling Kit'),
    ('C182-C5', 'Cowling Kit'),
    ('C182-C5P', 'Cowling Kit'),
    ('C182-C6', 'Cowling Kit'),
    ('C182-C6P', 'Cowling Kit'),
    ('C182-C7', 'Cowling Kit'),
    ('C182-C7P', 'Cowling Kit'),
    ('C188-C1', 'Cowling Kit'),
    ('C188-C1P', 'Cowling Kit'),
    ('C205-C1', 'Cowling Kit'),
    ('C205-C1P', 'Cowling Kit'),
    ('C206-C1', 'Cowling Kit'),
    ('C206-C1P', 'Cowling Kit'),
    ('C206-C2P', 'Cowling Kit'),
    ('C207-C1', 'Cowling Kit'),
    ('C207-C1P', 'Cowling Kit'),
    ('C208-C1P', 'Cowling Kit'),
    ('C210-C1', 'Cowling Kit'),
    ('C210-C1P', 'Cowling Kit'),
    ('C210-C2', 'Cowling Kit'),
    ('C210-C2P', 'Cowling Kit'),
    ('C210-C3', 'Cowling Kit'),
    ('C210-C3P', 'Cowling Kit'),
    ('C210-C4', 'Cowling Kit'),
    ('C210-C4P', 'Cowling Kit'),
    ('C303-C1', 'Cowling Kit'),
    ('C303-C1P', 'Cowling Kit'),
    ('C310-C1', 'Cowling Kit'),
    ('C310-C1P', 'Cowling Kit'),
    ('C310-C2', 'Cowling Kit'),
    ('C310-C2P', 'Cowling Kit'),
    ('C310-C3', 'Cowling Kit'),
    ('C310-C3P', 'Cowling Kit'),
    ('C310-C5', 'Cowling Kit'),
    ('C310-C5P', 'Cowling Kit'),
    ('C336-C1', 'Cowling Kit'),
    ('C336-C1P', 'Cowling Kit'),
    ('C337-C1', 'Cowling Kit'),
    ('C337-C1P', 'Cowling Kit'),
    ('C340-C1', 'Cowling Kit'),
    ('C340-C1P', 'Cowling Kit'),
    ('C400-C1', 'Cowling Kit'),
    ('C400-C1P', 'Cowling Kit'),
    ('C400-C2', 'Cowling Kit'),
    ('C400-C2P', 'Cowling Kit'),
    ('C404-C1', 'Cowling Kit'),
    ('C404-C1P', 'Cowling Kit'),
    ('C414-C1', 'Cowling Kit'),
    ('C414-C1P', 'Cowling Kit'),
    ('C414-C2', 'Cowling Kit'),
    ('C414-C2P', 'Cowling Kit'),
    ('C421-C1', 'Cowling Kit'),
    ('C421-C1P', 'Cowling Kit'),
    ('C421-C2', 'Cowling Kit'),
    ('C421-C2P', 'Cowling Kit'),
    ('C425-C1', 'Cowling Kit'),
    ('C441-C1', 'Cowling Kit'),
    ('C441-C1P', 'Cowling Kit'),
    ('C500-C1', 'Cowling Kit'),
    ('C500-C1P', 'Cowling Kit'),
    ('C500-C2', 'Cowling Kit'),
    ('C500-C2P', 'Cowling Kit'),
    ('M20-C2', 'Cowling Kit'),
    ('M20-C2P', 'Cowling Kit'),
    ('M20-C3', 'Cowling Kit'),
    ('M20-C3P', 'Cowling Kit'),
    ('M20-C5', 'Cowling Kit'),
    ('M20-C5P', 'Cowling Kit'),
    ('M20-C6', 'Cowling Kit'),
    ('M20-C6A', 'Cowling Kit'),
    ('M20-C6AP', 'Cowling Kit'),
    ('M20-C6P', 'Cowling Kit'),
    ('M20-C7', 'Cowling Kit'),
    ('M20-C7P', 'Cowling Kit'),
    ('MU2-C1', 'Cowling Kit'),
    ('MU2-C1P', 'Cowling Kit'),
    ('MU2-C2', 'Cowling Kit'),
    ('MU2-C2P', 'Cowling Kit'),
    ('PA18-C1', 'Cowling Kit'),
    ('PA18-C2', 'Cowling Kit'),
    ('PA18-C3', 'Cowling Kit'),
    ('PA23-C1', 'Cowling Kit'),
    ('PA23-C1P', 'Cowling Kit'),
    ('PA23-C2', 'Cowling Kit'),
    ('PA23-C2P', 'Cowling Kit'),
    ('PA23-C3', 'Cowling Kit'),
    ('PA23-C4', 'Cowling Kit'),
    ('PA23-C4P', 'Cowling Kit'),
    ('PA28-C1', 'Cowling Kit'),
    ('PA28-C1P', 'Cowling Kit'),
    ('PA30-C2', 'Cowling Kit'),
    ('PA30-C2P', 'Cowling Kit'),
    ('PA32-C1', 'Cowling Kit'),
    ('PA32-C1P', 'Cowling Kit'),
    ('PA34-C2', 'Cowling Kit'),
    ('PA34-C2P', 'Cowling Kit'),
    ('PA34-C3', 'Cowling Kit'),
    ('PA34-C3P', 'Cowling Kit'),
    ('PA34-C4', 'Cowling Kit'),
    ('PA34-C4P', 'Cowling Kit'),
    ('PA44-C1', 'Cowling Kit'),
    ('PA44-C1P', 'Cowling Kit'),
    ('PA46-C1', 'Cowling Kit'),
    ('PA46-C1P', 'Cowling Kit'),
    ('PA600-C1', 'Cowling Kit'),
    ('PA600-C1P', 'Cowling Kit'),
    ('PA700-C1', 'Cowling Kit'),
    ('PA700-C1P', 'Cowling Kit'),
    ('C150-FT1', 'Fuel Tank Kit'),
    ('C150-FTLR', 'Fuel Tank Kit'),
    ('C172-FT1', 'Fuel Tank Kit'),
    ('C180-FT1', 'Fuel Tank Kit'),
    ('C180-FT2', 'Fuel Tank Kit'),
    ('C182-FT1', 'Fuel Tank Kit'),
    ('C182-FT2', 'Fuel Tank Kit'),
    ('C182-FT2LR', 'Fuel Tank Kit'),
    ('C182-FT3', 'Fuel Tank Kit'),
    ('C206-FT1', 'Fuel Tank Kit'),
    ('C206-FT1LR', 'Fuel Tank Kit'),
    ('C210-FT1', 'Fuel Tank Kit'),
    ('C210-FT2', 'Fuel Tank Kit'),
    ('C210-FT2LR', 'Fuel Tank Kit'),
    ('C210-FT3', 'Fuel Tank Kit'),
    ('C210-FT4', 'Fuel Tank Kit'),
    ('C310-FT1', 'Fuel Tank Kit'),
    ('C310-FT2', 'Fuel Tank Kit'),
    ('C310-FT3', 'Fuel Tank Kit'),
    ('C337-FT1', 'Fuel Tank Kit'),
    ('C340-FT1', 'Fuel Tank Kit'),
    ('C400-FT1', 'Fuel Tank Kit'),
    ('C402C-FT1', 'Fuel Tank Kit'),
    ('C414-FT1', 'Fuel Tank Kit'),
    ('MU2-FT1', 'Fuel Tank Kit'),
    ('PA28-FT1', 'Fuel Tank Kit'),
    ('PA28-FT2', 'Fuel Tank Kit'),
    ('PA32-FT1', 'Fuel Tank Kit'),
    ('PA32-FT2', 'Fuel Tank Kit'),
    ('PA32-FT3', 'Fuel Tank Kit'),
    ('PA32-FT4', 'Fuel Tank Kit'),
    ('PA32-FT5', 'Fuel Tank Kit'),
    ('PA34-FT1', 'Fuel Tank Kit'),
    ('PA34-FT2', 'Fuel Tank Kit'),
    ('LANCAIR-C1P', 'Lancair Kit'),
    ('LANCAIR-C1P-F', 'Lancair Kit'),
    ('LANCAIR-C1P-U', 'Lancair Kit'),
    ('LANCAIR-C1S', 'Lancair Kit'),
    ('LANCAIR-C1S-F', 'Lancair Kit'),
    ('LANCAIR-C1S-S', 'Lancair Kit'),
    ('LANCAIR-C1S-U', 'Lancair Kit'),
    ('AC690-NA1P', 'Option Kit'),
    ('AC690-NA1S', 'Option Kit'),
    ('B35LC27S', 'Option Kit'),
    ('B35LC28P', 'Option Kit'),
    ('B35LC40P', 'Option Kit'),
    ('B35LC40S', 'Option Kit'),
    ('B35UC40P', 'Option Kit'),
    ('B35UC40S', 'Option Kit'),
    ('B55-AFP', 'Option Kit'),
    ('B55-AS1', 'Option Kit'),
    ('B55-AS2', 'Option Kit'),
    ('B55-AS3', 'Option Kit'),
    ('B55-BD', 'Option Kit'),
    ('B55-EP', 'Option Kit'),
    ('B55-EPD', 'Option Kit'),
    ('B55-FG', 'Option Kit'),
    ('B55-NC', 'Option Kit'),
    ('B55-NP1', 'Option Kit'),
    ('B55-NP2', 'Option Kit'),
    ('B55-RAD', 'Option Kit'),
    ('B58P-AS1', 'Option Kit'),
    ('B60-LP1P', 'Option Kit'),
    ('B60-LP1S', 'Option Kit'),
    ('B60-LP2P', 'Option Kit'),
    ('B60-LP2S', 'Option Kit'),
    ('C100-AF1', 'Option Kit'),
    ('C100-EAD3', 'Option Kit'),
    ('C100-EAD4', 'Option Kit'),
    ('C100-EAD5', 'Option Kit'),
    ('C100-EPD1P', 'Option Kit'),
    ('C100-EPD1S', 'Option Kit'),
    ('C150C2800P', 'Option Kit'),
    ('C172C2800P', 'Option Kit'),
    ('C175C2800P', 'Option Kit'),
    ('C180C2800P', 'Option Kit'),
    ('C182C2800P', 'Option Kit'),
    ('C188-RSP1', 'Option Kit'),
    ('C200-2800', 'Option Kit'),
    ('C200-28S3', 'Option Kit'),
    ('C300-BA1', 'Option Kit'),
    ('C300-BA3', 'Option Kit'),
    ('C300-NA1P', 'Option Kit'),
    ('C300-NA1S', 'Option Kit'),
    ('C300-NA2', 'Option Kit'),
    ('C300-NA3P', 'Option Kit'),
    ('C300-NA3S', 'Option Kit'),
    ('C300-NA4P', 'Option Kit'),
    ('C300-NA4S', 'Option Kit'),
    ('C300-OAD1P', 'Option Kit'),
    ('C300-OAD1S', 'Option Kit'),
    ('C400-BA1P', 'Option Kit'),
    ('C400-BA1S', 'Option Kit'),
    ('C400-BA2P', 'Option Kit'),
    ('C400-BA2S', 'Option Kit'),
    ('C400-CP1P', 'Option Kit'),
    ('C400-CP1S', 'Option Kit'),
    ('C400-CP2P', 'Option Kit'),
    ('C400-CP2S', 'Option Kit'),
    ('C400-NF1', 'Option Kit'),
    ('C400-NP1P', 'Option Kit'),
    ('C400-NP1S', 'Option Kit'),
    ('C400-NP2P', 'Option Kit'),
    ('C400-NP2S', 'Option Kit'),
    ('C400-NP3P', 'Option Kit'),
    ('C400-NP3S', 'Option Kit'),
    ('C400-NP4P', 'Option Kit'),
    ('C400-NP4S', 'Option Kit'),
    ('C400-NP5P', 'Option Kit'),
    ('C400-NP5S', 'Option Kit'),
    ('C400-NP6P', 'Option Kit'),
    ('C400-NP6S', 'Option Kit'),
    ('C400-NP7P', 'Option Kit'),
    ('C400-NP7S', 'Option Kit'),
    ('C400-NP8P', 'Option Kit'),
    ('C400-NP8S', 'Option Kit'),
    ('C400-OD1P', 'Option Kit'),
    ('C400-OD1S', 'Option Kit'),
    ('C400-RAD1P', 'Option Kit'),
    ('C400-RAD1S', 'Option Kit'),
    ('M20-BAT1P', 'Option Kit'),
    ('M20-BAT1S', 'Option Kit'),
    ('M20-BAT2P', 'Option Kit'),
    ('M20-BAT2S', 'Option Kit'),
    ('M20-BP1P', 'Option Kit'),
    ('PA-FD1W', 'Option Kit'),
    ('PA-NAC1P', 'Option Kit'),
    ('PA-NAC1S', 'Option Kit'),
    ('PA-NP1P', 'Option Kit'),
    ('PA-NP1S', 'Option Kit'),
    ('PA-NP2P', 'Option Kit'),
    ('PA-NP2S', 'Option Kit'),
    ('PA-NP3P', 'Option Kit'),
    ('PA-NP3S', 'Option Kit'),
    ('PA30-2701P', 'Option Kit'),
    ('PA30-2701S', 'Option Kit'),
    ('PA30-2702P', 'Option Kit'),
    ('PA30-2702S', 'Option Kit'),
    ('PA30-NP1', 'Option Kit'),
    ('SK203C150P4', 'Option Kit'),
    ('SK203C150P4D', 'Option Kit'),
    ('SK203C172P-RS4', 'Option Kit'),
    ('SK203C172P4', 'Option Kit'),
    ('SK203C172PQ4', 'Option Kit'),
    ('SK203C177P4', 'Option Kit'),
    ('SK203C182P4', 'Option Kit'),
    ('RV-OD1', 'RV Kit'),
    ('RV-OD2', 'RV Kit'),
    ('RV1014J-C1P', 'RV Kit'),
    ('RV1014J-C1P-F', 'RV Kit'),
    ('RV1014J-C1P-S', 'RV Kit'),
    ('RV1014J-C1P-U', 'RV Kit'),
    ('RV1014J-C1P-UF', 'RV Kit'),
    ('RV1014J-C1S', 'RV Kit'),
    ('RV1014J-C1S-F', 'RV Kit'),
    ('RV1014J-C1S-S', 'RV Kit'),
    ('RV1014J-C1S-U', 'RV Kit'),
    ('RV1014J-C1S-UF', 'RV Kit'),
    ('RV4J-C1P', 'RV Kit'),
    ('RV4J-C1P-C', 'RV Kit'),
    ('RV4J-C1P-F', 'RV Kit'),
    ('RV4J-C1P-S', 'RV Kit'),
    ('RV4J-C1P-U', 'RV Kit'),
    ('RV4J-C1P-UF', 'RV Kit'),
    ('RV4J-C1S-S', 'RV Kit'),
    ('RV4J-C1S-UF', 'RV Kit'),
    ('RV679J-C1P', 'RV Kit'),
    ('RV679J-C1P-F', 'RV Kit'),
    ('RV679J-C1P-S', 'RV Kit'),
    ('RV679J-C1P-U', 'RV Kit'),
    ('RV679J-C1P-UF', 'RV Kit'),
    ('RV679J-C1S', 'RV Kit'),
    ('RV679J-C1S-U', 'RV Kit'),
    ('RV679J-C1S-UF', 'RV Kit'),
    ('RV8J-C1P', 'RV Kit'),
    ('RV8J-C1P-F', 'RV Kit'),
    ('RV8J-C1P-S', 'RV Kit'),
    ('RV8J-C1P-U', 'RV Kit'),
    ('RV8J-C1P-UF', 'RV Kit'),
    ('RV8J-C1S', 'RV Kit'),
    ('RV8J-C1S-F', 'RV Kit'),
    ('RV8J-C1S-U', 'RV Kit'),
    ('RV8J-C1S-UF', 'RV Kit'),
    ('BE-BARON55', 'Trim Kit'),
    ('BE-BARON58', 'Trim Kit'),
    ('BE-BONANZA', 'Trim Kit'),
    ('BE-KINGAIR', 'Trim Kit'),
    ('BE-MUSKETEER', 'Trim Kit'),
    ('BE-TRAVELAIR', 'Trim Kit'),
    ('BEL-SCOUT', 'Trim Kit'),
    ('BEL-VIKING', 'Trim Kit'),
    ('C-120/140', 'Trim Kit'),
    ('C-150/152', 'Trim Kit'),
    ('C-170', 'Trim Kit'),
    ('C-172/172RG', 'Trim Kit'),
    ('C-180/185', 'Trim Kit'),
    ('C-182/182RG', 'Trim Kit'),
    ('C-206/207', 'Trim Kit'),
    ('C-208', 'Trim Kit'),
    ('C-210', 'Trim Kit'),
    ('C-310-1', 'Trim Kit'),
    ('C-310-2', 'Trim Kit'),
    ('C-335/340', 'Trim Kit'),
    ('C-336/337', 'Trim Kit'),
    ('C-401/402', 'Trim Kit'),
    ('C-411/414', 'Trim Kit'),
    ('C-421', 'Trim Kit'),
    ('C-AGWAGON', 'Trim Kit'),
    ('ERCOUPE', 'Trim Kit'),
    ('G-AG CAT', 'Trim Kit'),
    ('G-TIGER', 'Trim Kit'),
    ('M-201/231', 'Trim Kit'),
    ('M-20B', 'Trim Kit'),
    ('M-20C/D', 'Trim Kit'),
    ('M-20E/G', 'Trim Kit'),
    ('M-252', 'Trim Kit'),
    ('MU2', 'Trim Kit'),
    ('PA-140-235', 'Trim Kit'),
    ('PA-AEROSTAR', 'Trim Kit'),
    ('PA-APACHE', 'Trim Kit'),
    ('PA-ARROW', 'Trim Kit'),
    ('PA-AZTEC', 'Trim Kit'),
    ('PA-CHEROKEE SIX', 'Trim Kit'),
    ('PA-CHEYENNE', 'Trim Kit'),
    ('PA-COMANCHE', 'Trim Kit'),
    ('PA-J3 CUB', 'Trim Kit'),
    ('PA-MALIBU', 'Trim Kit'),
    ('PA-NAVAJO', 'Trim Kit'),
    ('PA-PAWNEE', 'Trim Kit'),
    ('PA-SEMINOLE', 'Trim Kit'),
    ('PA-SENECA', 'Trim Kit'),
    ('PA-SUPER CUB', 'Trim Kit'),
    ('PA-T COMANCHE', 'Trim Kit'),
    ('PA-TOMAHAWK', 'Trim Kit'),
    ('PA-WARRIOR', 'Trim Kit'),
    ('R-COMMANDER 500', 'Trim Kit')
    ) as f(part_number, family)
   where upper(regexp_replace(k.part_number, '\s', '', 'g')) = upper(regexp_replace(f.part_number, '\s', '', 'g'))
     and k.family is distinct from f.family;
  get diagnostics v_n = row_count;
  update public.kit_skus set is_active = false
   where family in ('Trim Kit', 'Fuel Tank Kit') and is_active;
  get diagnostics v_off = row_count;
  raise notice 'kit_skus: % family values set, % Trim/Fuel Tank kits inactivated', v_n, v_off;
end $$;

-- verify (expect ~405 with a family; 87 Trim/Fuel inactive; rows without a family = registry SKUs the July
-- workbook did not cover — April names their family, then Block 2 is re-run)
select family, count(*) as kits, count(*) filter (where is_active) as active from public.kit_skus group by 1 order by 1;
select part_number, description from public.kit_skus where family is null and is_active order by 1;

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- BLOCK 2 — Rev 82 (draft): Kits sections by family, one component_sum item per active kit with a BOM,
--   price_kit_components rebuilt from kit_bom_lines, and a cost-based 'Kit Hardware' resale section seeded
--   at 2× last PO cost. Dry run by default. Skips kits already in the book and kits with no BOM (reported).
-- ═════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_dry_run boolean := false;   -- ← set false to apply
  v_book uuid; v_rule text; v_ladder text; v_res_rule text; v_res_ladder text;
  v_sort int; v_sec uuid; v_hw_sec uuid; v_fam text; v_cnt int;
  v_kits int := 0; v_comps int := 0; v_hw int := 0; v_hw_fallback int := 0;
  v_eligible int; v_nobom int; v_existing int;
begin
  v_book := (select id from public.price_books where status = 'draft' order by effective_from desc limit 1);
  if v_book is null then raise exception 'no draft book'; end if;

  v_rule       := (select i.rule_code   from public.price_items i where i.book_id = v_book and i.status = 'component_sum' limit 1);
  v_ladder     := (select i.ladder_code from public.price_items i where i.book_id = v_book and i.status = 'component_sum' limit 1);
  v_res_rule   := (select i.rule_code   from public.price_items i join public.price_sections s on s.id = i.section_id where i.book_id = v_book and s.kind = 'resale' and i.status = 'priced' limit 1);
  v_res_ladder := (select i.ladder_code from public.price_items i join public.price_sections s on s.id = i.section_id where i.book_id = v_book and s.kind = 'resale' and i.status = 'priced' limit 1);

  v_eligible := (select count(*) from public.kit_skus k where k.is_active and k.family in ('Cowling Kit','Option Kit','RV Kit','Lancair Kit'));
  v_nobom    := (select count(*) from public.kit_skus k where k.is_active and k.family in ('Cowling Kit','Option Kit','RV Kit','Lancair Kit') and not exists (select 1 from public.kit_bom_lines b where b.kit_sku_id = k.id));
  v_existing := (select count(*) from public.kit_skus k where k.is_active and k.family in ('Cowling Kit','Option Kit','RV Kit','Lancair Kit') and exists (select 1 from public.price_items i where i.book_id = v_book and i.part_key = upper(regexp_replace(k.part_number, '\s', '', 'g'))));

  raise notice 'draft book %, template rule/ladder %/%, resale rule/ladder %/%', v_book, v_rule, v_ladder, v_res_rule, v_res_ladder;
  raise notice 'kits eligible: % | no BOM (skipped): % | already in book (left alone): % | hardware SKUs with PO cost: 91 | sale-price fallback: 80', v_eligible, v_nobom, v_existing;
  if v_dry_run then raise notice 'dry run — nothing written'; return; end if;

  -- 2a. Kit Hardware section (resale kind: never uplifted; follows cost)
  v_hw_sec := (select id from public.price_sections where book_id = v_book and name = 'Kit Hardware (cost-based)');
  if v_hw_sec is null then
    v_sort := coalesce((select max(sort) from public.price_sections where book_id = v_book), 0) + 1;
    insert into public.price_sections(book_id, name, sort, kind, header_note)
    values (v_book, 'Kit Hardware (cost-based)', v_sort, 'resale', 'Hardware inside Skybolt kits, valued at 2× latest received purchase cost (D-PRICE-46/47). Not a catalog section.');
    v_hw_sec := (select id from public.price_sections where book_id = v_book and name = 'Kit Hardware (cost-based)');
  end if;

  insert into public.price_items(book_id, section_id, part_number, description, list_price, rule_code, ladder_code, status, sort, notes, fb_product_id)
  select v_book, v_hw_sec, h.part_number, nullif(h.description, ''), round(h.po_cost * 2, 3), v_res_rule, v_res_ladder, 'priced',
         row_number() over (order by h.part_number),
         'Seed: 2 × last PO cost ' || h.po_cost || ' (' || h.basis || '); replaced by fb_part_costs (D-PRICE-47)',
         (select p.fb_product_id from public.fb_products p where p.product_key = upper(regexp_replace(h.part_number, '\s', '', 'g')) limit 1)
  from (values
    ('MS24693-C50', 'MS24693-C50 - #8-32 Phillips Flush Head Screw - Stainless', 0.1200, 'Last PO 10/2025 — MONROE AEROSPACE'),
    ('MS24693-C272', 'MS24693-C272 - #4-40  Flat Head Phillips', 0.1000, 'Last PO 06/2026 — BILD INDUSTRIES'),
    ('AN526C832R8', 'AN526C832R8 - #8-32 Phillips Oval Head Screw - Stainless', 0.1120, 'Last PO 06/2026 — BILD INDUSTRIES'),
    ('8RX1/2THBS', '8RX1/2THBS - #8 Phillips Head', 0.0600, 'Last PO 06/2026 — BILD INDUSTRIES'),
    ('MS24693-C273', 'MS24693-C273 - #10-32 Phillips Flush Head Screw - Stainless', 0.1200, 'Last PO 06/2026 — BILD INDUSTRIES'),
    ('NAS1515-H-3L', 'NAS1515-H-3L - #10  Nylon', 0.0400, 'Last PO 06/2026 — ECAS, LLC DBA MONROE AEROSPA'),
    ('AN526C1032R8', 'AN526C1032R8 - #10-32 Phillips Oval Head Screw - Stainless', 0.1690, 'Last PO 06/2026 — BILD INDUSTRIES'),
    ('NAS1515-H-08L', 'NAS1515-H-08L - #8  Nylon', 0.0600, 'Last PO 06/2026 — ECAS, LLC DBA MONROE AEROSPA'),
    ('MS24693-C28', 'MS24693-C28 - #6-32 Phillips Flush Head Screw - Stainless', 0.0610, 'Last PO 08/2025 — BILD INDUSTRIES'),
    ('AN526C632R8', 'AN526C632R8 - #6-32 Phillips Oval Head Screw - Stainless', 0.0910, 'Last PO 06/2026 — BILD INDUSTRIES'),
    ('10RX1/2THBS', '10RX1/2THBS - #10 Phillips Head', 0.0700, 'Last PO 06/2026 — BILD INDUSTRIES'),
    ('MS24694-S5', 'MS24694-S5 - #8-32 Phillips Flush Head Screw - Steel 125,000 PSI', 0.2300, 'Last PO 03/2026 — MONROE AEROSPACE'),
    ('8RX1/2FHBS100', '8RX1/2FHBS100 - #8 Phillips Head', 0.1100, 'Last PO 10/2025 — BILD INDUSTRIES'),
    ('6RX1/2THBS', '6RX1/2THBS - #6 Phillips Head', 0.0500, 'Last PO 12/2025 — BILD INDUSTRIES'),
    ('AN526C832R10', 'AN526C832R10 - #8-32 Phillips Oval Head Screw - Stainless', 0.1400, 'Last PO 06/2026 — BILD INDUSTRIES'),
    ('MS24693-C52', 'MS24693-C52 - #8-32 Phillips Flush Head Screw - Stainless', 0.1100, 'Last PO 10/2025 — BILD INDUSTRIES'),
    ('MS27039C0809', 'MS27039C0809 - #8-32 Pan Head Screw - Stainless 125,000 PSI', 0.8300, 'Last PO 07/2024 — AIRCRAFT SPRUCE & SPECIALTY '),
    ('AN526C1032R10', 'AN526C1032R10 - #10-32 Phillips Oval Head Screw - Stainless', 0.1900, 'Last PO 12/2025 — BILD INDUSTRIES'),
    ('MS24693-C48', 'MS24693-C48 - #8-32 Phillips Flush Head Screw - Stainless', 0.0900, 'Last PO 05/2024 — MONROE AEROSPACE'),
    ('MS24693-C271', 'MS24693-C271 - #10-32 Phillips Flush Head Screw - Stainless', 0.1600, 'Last PO 07/2025 — MONROE AEROSPACE'),
    ('AN526C832R6', 'AN526C832R6 - #8-32 Phillips Oval Head Screw - Stainless', 0.0980, 'Last PO 02/2024 — BILD INDUSTRIES'),
    ('MS27039C0808', 'MS27039C0808 - #8-32 Pan Head Screw - Stainless 125,000 PSI', 0.4700, 'Last PO 10/2025 — BILD INDUSTRIES'),
    ('AN525-832R8', 'AN525-832R8 - #8-32 Washer Head Screw - Steel', 0.1460, 'Last PO 06/2026 — BILD INDUSTRIES'),
    ('MS24694-C51', 'MS24694-C51 - #10-32 Phillips Flush Head Screw - Stainless 85,000 PSI', 0.5799, 'Last PO 04/2025 — MONROE AEROSPACE'),
    ('MS27039C1-08', 'MS27039C1-08 - #10-32 Pan Head Screw - Stainless 125,000 PSI', 0.6100, 'Last PO 02/2025 — BILD INDUSTRIES'),
    ('MS24694-S50', 'MS24694-S50 - #10-32 Phillips Flush Head Screw - Steel 125,000 PSI', 0.1800, 'Last PO 02/2025 — BILD INDUSTRIES'),
    ('MS24694-C50', 'MS24694-C50 - #10-32 Phillips Flush Head Screw - Stainless 85,000 PSI', 0.2000, 'Last PO 11/2025 — BILD INDUSTRIES'),
    ('MS24693-C293', 'MS24693-C293 - 1/4-28 Phillips Flush Head Screw - Stainless', 0.2600, 'Last PO 09/2024 — MONROE AEROSPACE'),
    ('AN960C10L', 'AN960C10L - #10', 0.0500, 'Last PO 03/2024 — AIRCRAFT SPRUCE & SPECIALTY '),
    ('MS51957-46', 'MS51957-46 - N', 0.1400, 'Last PO 09/2025 — AIRCRAFT SPRUCE & SPECIALTY '),
    ('MS51957-45', 'MS51957-45 - Screw, Course Thread, Pan Head Machine Steel #8-32 x 5/16 Lngth', 0.1500, 'Last PO 03/2026 — MONROE AEROSPACE'),
    ('MS24694-S49', 'MS24694-S49 - #10-32 Phillips Flush Head Screw - Steel 125,000 PSI', 0.1300, 'Last PO 05/2024 — MONROE AEROSPACE'),
    ('MS24694-C49', 'MS24694-C49 - #10-32 Phillips Flush Head Screw - Stainless 85,000 PSI', 0.3000, 'Last PO 07/2025 — MONROE AEROSPACE'),
    ('MS24694-C48', 'MS24694-C48 - #10-32 Phillips Flush Head Screw - Stainless 85,000 PSI', 0.1100, 'Last PO 05/2024 — MONROE AEROSPACE'),
    ('MS24693-C270', 'MS24693-C270 - #10-32 Phillips Flush Head Screw - Stainless', 0.2200, 'Last PO 07/2025 — MONROE AEROSPACE'),
    ('D188C', 'D188C - N', 0.8862, 'Last PO 05/2026 — Amazing Magnets'),
    ('8RX1/2FHAS100', '8RX1/2FHAS100 - #8 Phillips Head', 0.1000, 'Last PO 05/2026 — BILD INDUSTRIES'),
    ('AN525-10R6', 'AN525-10R6 - #10-32 Washer Head Screw - Steel', 0.1400, 'Last PO 02/2025 — BILD INDUSTRIES'),
    ('MS21044C06', 'MS21044C06 - Stainless Nylon Insert Locknut #6-32', 0.3100, 'Last PO 09/2024 — BILD INDUSTRIES'),
    ('MS24693-C49', 'MS24693-C49 - #8-32 Phillips Flush Head Screw - Stainless', 0.0900, 'Last PO 03/2024 — AIRCRAFT SPRUCE & SPECIALTY '),
    ('AN525-832R10', 'AN525-832R10 - #8-32 Washer Head Screw - Steel', 0.1600, 'Last PO 04/2026 — BILD INDUSTRIES'),
    ('MS24693-C274', 'MS24693-C274 - #10-32 Phillips Flush Head Screw - Stainless', 0.1400, 'Last PO 05/2026 — BILD INDUSTRIES'),
    ('MS24694-S3', 'MS24694-S3 - #8-32 Phillips Flush Head Screw - Steel 125,000 PSI', 0.2200, 'Last PO 03/2026 — MONROE AEROSPACE'),
    ('MS21044N08', 'MS21044N08 - N', 0.1700, 'Last PO 05/2026 — BILD INDUSTRIES'),
    ('MS24693-C275', 'MS24693-C275 - #10-32 Phillips Flush Head Screw - Stainless', 0.1400, 'Last PO 06/2025 — BILD INDUSTRIES'),
    ('MS24693-C276', 'MS24693-C276 - #10-32 Phillips Flush Head Screw - Stainless', 0.1600, 'Last PO 06/2025 — BILD INDUSTRIES'),
    ('MS24694-S51', 'MS24694-S51 - #10-32 Phillips Flush Head Screw - Steel 125,000 PSI', 0.2100, 'Last PO 08/2025 — BILD INDUSTRIES'),
    ('AN525-10R8', 'AN525-10R8 - #10-32 Washer Head Screw - Steel', 0.1600, 'Last PO 06/2026 — BILD INDUSTRIES'),
    ('AN526C632R6', 'AN526C632R6 - #6-32 Phillips Oval Head Screw - Stainless', 0.0800, 'Last PO 09/2025 — BILD INDUSTRIES'),
    ('MS24694-C52', 'MS24694-C52 - #10-32 Phillips Flush Head Screw - Stainless 85,000 PSI', 0.2900, 'Last PO 05/2025 — MONROE AEROSPACE'),
    ('MS24694-C4', 'MS24694-C4 - #8-32 Phillips Flush Head Screw - Stainless 85,000 PSI', 0.1400, 'Last PO 02/2025 — BILD INDUSTRIES'),
    ('8RX1/2THAS', '8RX1/2THAS - #8 Phillips Head', 0.0600, 'Last PO 03/2024 — MONROE AEROSPACE'),
    ('MS24693-C26', 'MS24693-C26 - #6-32 Phillips Flush Head Screw - Stainless', 0.0600, 'Last PO 09/2025 — BILD INDUSTRIES'),
    ('MS24693-S52', 'MS24693-S52 - #8-32 Phillips Flush Head Screw - Steel', 0.0900, 'Last PO 06/2025 — BILD INDUSTRIES'),
    ('AN526C832R4', 'AN526C832R4 - #8-32 Phillips Oval Head Screw - Stainless', 0.1400, 'Last PO 11/2024 — ECAS, LLC DBA MONROE AEROSPA'),
    ('AN526C832R12', 'AN526C832R12 - #8-32 Phillips Oval Head Screw - Stainless', 0.1500, 'Last PO 12/2025 — BILD INDUSTRIES'),
    ('SR4SS', 'SR4SS - #4 Ring Retainer - Stainless..', 0.4700, 'Last PO 07/2026 — AIRCRAFT SPRUCE & SPECIALTY '),
    ('MS24693-C30', 'MS24693-C30 - #6-32 Phillips Flush Head Screw - Stainless', 0.1000, 'Last PO 01/2026 — BILD INDUSTRIES'),
    ('6RX1/2THAS', '6RX1/2THAS - #6 Phillips Head', 0.0400, 'Last PO 05/2025 — BILD INDUSTRIES'),
    ('AN526C832R7', 'AN526C832R7 - #8-32 Phillips Oval Head Screw - Stainless', 0.1600, 'Last PO 09/2024 — MONROE AEROSPACE'),
    ('MS27039C1-09', 'MS27039C1-09 - #10-32 Pan Head Screw - Stainless 125,000 PSI', 1.2000, 'Last PO 03/2026 — MONROE AEROSPACE'),
    ('MS24693-S3', 'MS24693-S3 - #4-40 Phillips Flush Head Screw - Steel', 0.0500, 'Last PO 10/2025 — BILD INDUSTRIES'),
    ('AN960C6L', 'AN960C6L - #6', 0.0200, 'Last PO 02/2024 — BILD INDUSTRIES'),
    ('AN526C1032R12', 'AN526C1032R12 - #10-32 Phillips Oval Head Screw - Stainless', 0.2300, 'Last PO 06/2026 — BILD INDUSTRIES'),
    ('AN526C440R8', 'AN526C440R8 - #4-40 Phillips Oval Head Screw - Stainless', 0.2200, 'Last PO 01/2026 — BILD INDUSTRIES'),
    ('4RX3/8THAS', '4RX3/8THAS - #4 Phillips Head', 0.0400, 'Last PO 01/2026 — MONROE AEROSPACE'),
    ('MS24694-S52', 'MS24694-S52 - #10-32 Phillips Flush Head Screw - Steel 125,000 PSI', 0.2100, 'Last PO 06/2025 — BILD INDUSTRIES'),
    ('8RX5/8THBS', '8RX5/8THBS - #8 Phillips Head', 0.0600, 'Last PO 01/2026 — BILD INDUSTRIES'),
    ('MS24694-C5', 'MS24694-C5 - #8-32 Phillips Flush Head Screw - Stainless 85,000 PSI', 0.2700, 'Last PO 03/2026 — MONROE AEROSPACE'),
    ('CR3212-4-3', 'CR3212-4-3 - Nominal Countersunk  .126 Dia  .126-.187', 3.8500, 'Last PO 01/2025 — MONROE AEROSPACE'),
    ('MS27039C4-07', 'MS27039C4-07 - QTY 1-99', 1.3000, 'Last PO 02/2025 — BILD INDUSTRIES'),
    ('CCR264SS-3-3', 'CCR264SS-3-3 - N', 3.9500, 'Last PO 03/2026 — MONROE AEROSPACE'),
    ('AN525-10R7', 'AN525-10R7 - #10-32 Washer Head Screw - Steel', 0.1900, 'Last PO 02/2025 — MONROE AEROSPACE'),
    ('AN526-1032R10', 'AN526-1032R10 - #10-32 Phillips Oval Head Screw - Steel', 0.0930, 'Last PO 05/2026 — BILD INDUSTRIES'),
    ('AN526-1032R28', 'AN526-1032R28 - #10-32 Phillips Oval Head Screw - Steel', 0.2400, 'Last PO 10/2024 — AIRCRAFT SPRUCE & SPECIALTY '),
    ('MS24694-S48', 'MS24694-S48 - #10-32 Phillips Flush Head Screw - Steel 125,000 PSI', 0.1200, 'Last PO 09/2025 — MONROE AEROSPACE'),
    ('AN525-832R7', 'AN525-832R7 - #8-32 Washer Head Screw - Steel', 0.2000, 'Last PO 04/2026 — AIRCRAFT SPRUCE & SPECIALTY '),
    ('AN960-10L', 'AN960-10L - #10', 0.1700, 'Last PO 03/2024 — BILD INDUSTRIES'),
    ('MS27039C1-10', 'MS27039C1-10 - #10-32 Pan Head Screw - Stainless 125,000 PSI', 1.2100, 'Last PO 05/2024 — MONROE AEROSPACE'),
    ('AN525-416R9', 'AN525-416R9 - AN525 WASHER HEAD SCREWS', 0.6400, 'Last PO 05/2026 — ECAS, LLC DBA MONROE AEROSPA'),
    ('MS51957-44', 'MS51957-44 - Screw, Course Thread, Pan Head Machine Steel #8-32 x 5/16 Lngth', 0.1800, 'Last PO 08/2025 — MONROE AEROSPACE'),
    ('6RX5/8THBS', '6RX5/8THBS - #6 Phillips Head', 0.1600, 'Last PO 12/2024 — BILD INDUSTRIES'),
    ('8RX3/8THAS', '8RX3/8THAS - #8 Phillips Head', 0.0450, 'Last PO 05/2025 — BILD INDUSTRIES'),
    ('AN3C3A', 'AN3C3A - 1/16 Grip 15/32 Length', 0.7590, 'Last PO 04/2026 — AIRCRAFT SPRUCE & SPECIALTY '),
    ('MS24693-S51', 'MS24693-S51 - #8-32 Phillips Flush Head Screw - Steel', 0.1300, 'Last PO 07/2025 — MONROE AEROSPACE'),
    ('MS21044C4', 'MS21044C4 - Stainless Nylon Insert Locknut 1/4-28', 1.3000, 'Last PO 04/2026 — BILD INDUSTRIES'),
    ('MS28775-008', 'MS28775-008 - N', 0.9800, 'Last PO 09/2025 — AIRCRAFT SPRUCE & SPECIALTY '),
    ('MS28775-011', 'MS28775-011 - O Ring', 1.0100, 'Last PO 09/2025 — AIRCRAFT SPRUCE & SPECIALTY '),
    ('SK244-461', 'SK244-461 - N', 0.2000, 'Last PO 12/2025 — ELECTROLAB II, INC'),
    ('MS24694-C59', 'MS24694-C59 - #10-32 Phillips Flush Head Screw - Stainless 85,000 PSI', 0.5100, 'Last PO 05/2024 — MONROE AEROSPACE'),
    ('SK-C150DL', 'SK-C150DL - SK203 Doubler, Left ..SK2003 STC FAA-PMA TSO-C148', 10.0000, 'Last PO 03/2026 — ELECTROLAB II, INC')
  ) as h(part_number, description, po_cost, basis)
  where not exists (select 1 from public.price_items i where i.book_id = v_book and i.part_key = upper(regexp_replace(h.part_number, '\s', '', 'g')));
  get diagnostics v_hw = row_count;

  insert into public.price_items(book_id, section_id, part_number, description, list_price, rule_code, ladder_code, status, sort, notes, fb_product_id)
  select v_book, v_hw_sec, h.part_number, nullif(h.description, ''), round(h.sale_price, 3), v_res_rule, v_res_ladder, 'priced',
         1000 + row_number() over (order by h.part_number),
         'Seed: Fishbowl sale price (no PO cost on file) — REVIEW; replaced by fb_part_costs (D-PRICE-47)',
         (select p.fb_product_id from public.fb_products p where p.product_key = upper(regexp_replace(h.part_number, '\s', '', 'g')) limit 1)
  from (values
    ('MS24693-S50', 'MS24693-S50 - #8-32 Phillips Flush Head Screw - Steel', 0.1500),
    ('MS27039C0812', 'MS27039C0812 - #8-32 Pan Head Screw - Stainless 125,000 PSI', 1.4500),
    ('4RX3/8THBS', '4RX3/8THBS - #4 Phillips Head', 0.2200),
    ('MS21044C3', 'MS21044C3 - Stainless Nylon Insert Locknut #10-32', 0.4900),
    ('AN526C632R10', 'AN526C632R10 - #6-32 Phillips Oval Head Screw - Stainless', 0.2000),
    ('SK-RVC', 'SK-RVC - Flange Cleko - without Magnet', 3.5900),
    ('NAS1515-H-06L', 'NAS1515-H-06L - #6  Nylon', 0.2000),
    ('MS24694-S4', 'MS24694-S4 - #8-32 Phillips Flush Head Screw - Steel 125,000 PSI', 0.2900),
    ('NAS1515-H-4L', 'NAS1515-H-4L - 1/4  Nylon', 0.1000),
    ('MS24693-C51', 'MS24693-C51 - #8-32 Phillips Flush Head Screw - Stainless', 0.1500),
    ('AN960C8L', 'AN960C8L - #8', 0.2000),
    ('10RX1/2FHBS100  (DISCONTINUED)', '10RX1/2FHBS100  (DISCONTINUED) - 10RX1/2FHBS100 - #10 Phillips Head', 0.5600),
    ('AN525-10R10', 'AN525-10R10 - #10-32 Washer Head Screw - Steel', 0.5600),
    ('AN526C632R4', 'AN526C632R4 - #6-32 Phillips Oval Head Screw - Stainless', 0.2000),
    ('SK294186-1-090', 'SK294186-1-090 - #5 Flush Stud - Stainless', 5.9400),
    ('6RX1/2FHAS100', '6RX1/2FHAS100 - #6 Phillips Head', 0.3600),
    ('MS21044C08', 'MS21044C08 - Stainless Nylon Insert Locknut #8-32', 0.7900),
    ('AN525C10R8', 'AN525C10R8 - #10-32 Washer Head Screw - Stainless', 0.7900),
    ('DP1080-17', 'DP1080-17 - #8  Steel', 0.1200),
    ('AN526C632R12', 'AN526C632R12 - #6-32 Phillips Oval Head Screw - Stainless', 0.2100),
    ('MS24694-C95', 'MS24694-C95 - 1/4-28  Phillips Flush Head Screw - Stainless 85,000 PSI', 0.7800),
    ('MS20426AD3-4C', 'MS20426AD3-4C - Flush Head Rivet Package - 100 Pc Bag', 4.0300),
    ('AN525-832R6', 'AN525-832R6 - #8-32 Washer Head Screw - Steel', 0.2100),
    ('MS24694-C65', 'MS24694-C65 - #10-32 Phillips Flush Head Screw - Stainless 85,000 PSI', 0.9400),
    ('MS24694-C14', 'MS24694-C14 - #8-32 Phillips Flush Head Screw - Stainless 85,000 PSI', 0.5500),
    ('MS20426AD4-4C', 'MS20426AD4-4C - Flush Head Rivet Package - 100 Pc Bag', 4.0300),
    ('82-14-180-20 (DISCONTINUED)', '82-14-180-20 (Discontinued) - 82-14-180-20 - #82 Slotted Flush Head Stud - Stainless', 4.2900),
    ('MS27039C4-11', 'MS27039C4-11 - 1/4-28 Pan Head Screw - Stainless 125,000 PSI', 1.5700),
    ('SK294186-2-200', 'SK294186-2-200 - #5 Flush Stud - Stainless', 7.4300),
    ('MS20426AD3-5C', 'MS20426AD3-5C - Flush Head Rivet Package - 100 Pc Bag', 4.0300),
    ('MS24694-S1', 'MS24694-S1 - #8-32 Phillips Flush Head Screw - Steel 125,000 PSI', 0.3900),
    ('MS27039-1-08', 'MS27039-1-08 - #10-32 Pan Head Screw - Steel 125,000 PSI', 0.2600),
    ('4RX1/2FHAS100', '4RX1/2FHAS100 - #4 Phillips Head', 0.3500),
    ('MS24693BB50', 'MS24693BB50 - #8-32  Flat Head Phillips', 0.3200),
    ('MS27039C0810', 'MS27039C0810 - #8-32 Pan Head Screw - Stainless 125,000 PSI', 0.8400),
    ('AN526C1032R16', 'AN526C1032R16 - #10-32 Phillips Oval Head Screw - Stainless', 0.4200),
    ('SKFJ5-35SS', 'SKFJ5-35SS - #5 Flush Stud - Stainless 9/16', 5.4700),
    ('SK294186-1-100', 'SK294186-1-100 - #5 Flush Stud - Stainless', 7.4300),
    ('MS24694-C9', 'MS24694-C9 - #8-32 Phillips Flush Head Screw - Stainless 85,000 PSI', 0.3700),
    ('SK294186-1-080', 'SK294186-1-080 - #5 Flush Stud - Stainless', 7.4300),
    ('AN525C832R10', 'AN525C832R10 - #8-32 Washer Head Screw - Stainless', 0.6500),
    ('SK294186-2-180', 'SK294186-2-180 - #5 Flush Stud - Stainless', 7.4300),
    ('MS20426AD3-4', 'MS20426AD3-4 - Flush Head Rivet   Package - 1 Pound per Unit Ordered', 4.0300),
    ('AN960-8L', 'AN960-8L - #8', 0.2000),
    ('MS24694-S58', 'MS24694-S58 - #10-32 Phillips Flush Head Screw - Steel 125,000 PSI', 0.6700),
    ('SK294186-2-250', 'SK294186-2-250 - #5 Flush Stud - Stainless', 7.4300),
    ('MS20426AD4-4', 'MS20426AD4-4 - Flush Head Rivet   Package - 1 Pound per Unit Ordered', 4.0300),
    ('MS20426AD3-5', 'MS20426AD3-5 - Flush Head Rivet   Package - 1 Pound per Unit Ordered', 4.0300),
    ('AN525-10R12', 'AN525-10R12 - #10-32 Washer Head Screw - Steel', 0.5400),
    ('AN525-10R14', 'AN525-10R14 - #10-32 Washer Head Screw - Steel', 0.1500),
    ('MS27039C0806', 'MS27039C0806 - #8-32 Pan Head Screw - Stainless 125,000 PSI', 1.0500),
    ('MS24694-C58', 'MS24694-C58 - #10-32 Phillips Flush Head Screw - Stainless 85,000 PSI', 0.6700),
    ('MS24694-C56', 'MS24694-C56 - #10-32 Phillips Flush Head Screw - Stainless 85,000 PSI', 0.6100),
    ('MS27039-0806', 'MS27039-0806 - #8-32 Pan Head Screw - Steel 125,000 PSI', 0.2200),
    ('SK294186-1-130', 'SK294186-1-130 - #5 Flush Stud - Stainless', 7.4300),
    ('8RX3/8THBS', '8RX3/8THBS - #8 Phillips Head', 0.2700),
    ('6RX3/8THBS', '6RX3/8THBS - #6 Phillips Head', 0.3000),
    ('MS24694-C7', 'MS24694-C7 - #8-32 Phillips Flush Head Screw - Stainless 85,000 PSI', 0.3400),
    ('SK294186-2-210', 'SK294186-2-210 - #5 Flush Stud - Stainless', 7.4300),
    ('MS24694-S56', 'MS24694-S56 - #10-32 Phillips Flush Head Screw - Steel 125,000 PSI', 0.6100),
    ('SK294186-1-120', 'SK294186-1-120 - #5 Flush Stud - Stainless', 7.4300),
    ('MS24694-C57', 'MS24694-C57 - #10-32 Phillips Flush Head Screw - Stainless 85,000 PSI', 0.6400),
    ('AN526C428R8', 'AN526C428R8 - 1/4-28 Phillips Oval Head Screw - Stainless', 0.3800),
    ('SK294290-2-250', 'SK294290-2-250 - #5 Oval  Stud-Stainless', 7.4300),
    ('MS20426AD4-5.5', 'MS20426AD4-5.5 - Flush Head Rivet   Package - 1 Pound per Unit Ordered', 4.0300),
    ('SK294290-2-170', 'SK294290-2-170 - #5 Oval Stud - Stainless', 7.4300),
    ('MS20426AD4-5C', 'MS20426AD4-5C - fill in later', 4.0300),
    ('82-14-120-20 (DISCONTINUED)', '82-14-120-20 (Discontinued) - 82-14-120-20 - #82 Slotted Flush Head Stud - Stainless', 4.2900),
    ('10RX3/4THBS', '10RX3/4THBS - #10 Phillips Head', 0.5600),
    ('AN960PD516L', 'AN960PD516L - 16-May', 0.7200),
    ('SK294186-1-150', 'SK294186-1-150 - #5 Flush Stud - Stainless', 7.4300),
    ('SK294290-2-170W', 'SK294290-2-170W - #5 Wing Stud  - Baron Baggage Door', 12.5100),
    ('SK294290-2-180W', 'SK294290-2-180W - #5 Wing Stud -Stainless C172 Access Door', 12.5100),
    ('MS24694-S47', 'MS24694-S47 - #10-32 Phillips Flush Head Screw - Steel 125,000 PSI', 0.4100),
    ('SK294290-1-130W', 'SK294290-1-130W - #5 Wing Stud -Stainless/C180 Access Door..', 12.5100),
    ('MS24694-C55', 'MS24694-C55 - #10-32 Phillips Flush Head Screw - Stainless 85,000 PSI', 0.5800),
    ('MS20426AD4-3C', 'MS20426AD4-3C - Diameter 1/8  Length 3/16', 4.0300),
    ('SK2700-11S', 'SK2700-11S - Flush Head Stud - Slotted - Stainless', 6.1000),
    ('SK27S3-11S', 'SK27S3-11S - Flush Head Stud - Phillips - Stainless', 7.2900),
    ('SK-C150DR', 'SK-C150DR - SK203 Doubler, Right..SK2003 STC FAA-PMA TSO-C148', 99.5000)
  ) as h(part_number, description, sale_price)
  where not exists (select 1 from public.price_items i where i.book_id = v_book and i.part_key = upper(regexp_replace(h.part_number, '\s', '', 'g')));
  get diagnostics v_hw_fallback = row_count;

  -- 2b. one Kits section per family, one component_sum item per kit with a BOM
  for v_fam in select unnest(array['Cowling Kit','Option Kit','RV Kit','Lancair Kit']) loop
    v_sec := (select id from public.price_sections where book_id = v_book and name = 'Skybolt Kits — ' || v_fam);
    if v_sec is null then
      v_sort := (select max(sort) from public.price_sections where book_id = v_book) + 1;
      insert into public.price_sections(book_id, name, sort, kind, header_note)
      values (v_book, 'Skybolt Kits — ' || v_fam, v_sort, 'catalog', 'Kit price = sum of BOM components at book price (D-PRICE-46). Component list from the Kit Registry.');
      v_sec := (select id from public.price_sections where book_id = v_book and name = 'Skybolt Kits — ' || v_fam);
    end if;
    insert into public.price_items(book_id, section_id, part_number, kit_sku_id, description, list_price, rule_code, ladder_code, status, sort, fb_product_id)
    select v_book, v_sec, k.part_number, k.id, k.description, null, v_rule, v_ladder, 'component_sum',
           row_number() over (order by k.part_number),
           (select p.fb_product_id from public.fb_products p where p.product_key = upper(regexp_replace(k.part_number, '\s', '', 'g')) limit 1)
    from public.kit_skus k
    where k.is_active and k.family = v_fam
      and exists (select 1 from public.kit_bom_lines b where b.kit_sku_id = k.id)
      and not exists (select 1 from public.price_items i where i.book_id = v_book and i.part_key = upper(regexp_replace(k.part_number, '\s', '', 'g')));
    get diagnostics v_cnt = row_count; v_kits := v_kits + v_cnt;
  end loop;

  -- 2c. BOM rows for every kit item in the book, rebuilt from kit_bom_lines (absolute)
  delete from public.price_kit_components c
   using public.price_items i
   where c.item_id = i.id and i.book_id = v_book and i.kit_sku_id is not null;
  insert into public.price_kit_components(item_id, component_part_number, qty)
  select i.id, kc.part_number, sum(b.qty_per_kit)
  from public.price_items i
  join public.kit_bom_lines b on b.kit_sku_id = i.kit_sku_id
  join public.kit_components kc on kc.id = b.component_id
  where i.book_id = v_book and i.kit_sku_id is not null
  group by i.id, kc.part_number;
  get diagnostics v_comps = row_count;

  raise notice 'applied: % kit items, % BOM rows, % hardware items at 2× cost, % hardware items at sale-price fallback', v_kits, v_comps, v_hw, v_hw_fallback;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- BLOCK 3 — coverage report (read-only). A kit prices only when every BOM component resolves to a priced
--   item in the same book. Send both results to April.
-- ═════════════════════════════════════════════════════════════════════════════════════════════
with b as (select id from public.price_books where status = 'draft' order by effective_from desc limit 1),
kits as (select i.id, i.part_number, s.name as section from public.price_items i join public.price_sections s on s.id = i.section_id, b where i.book_id = b.id and i.kit_sku_id is not null and i.status = 'component_sum'),
comp as (
  select k.id, k.part_number, k.section, c.component_key, c.qty,
         exists (select 1 from public.price_items x, b where x.book_id = b.id and x.part_key = c.component_key and x.status = 'priced' and x.list_price is not null) as resolved
  from kits k join public.price_kit_components c on c.item_id = k.id)
select section, count(distinct id) as kits,
       count(distinct id) filter (where id not in (select id from comp where not resolved)) as fully_priced,
       count(distinct id) filter (where id in (select id from comp where not resolved)) as blocked
from comp group by 1 order by 1;

-- 3b. the missing components, by how many kits they block — this is the to-do list
with b as (select id from public.price_books where status = 'draft' order by effective_from desc limit 1),
kits as (select i.id from public.price_items i, b where i.book_id = b.id and i.kit_sku_id is not null and i.status = 'component_sum'),
comp as (select k.id, c.component_key, c.component_part_number from kits k join public.price_kit_components c on c.item_id = k.id)
select c.component_part_number, count(distinct c.id) as kits_blocked,
       exists (select 1 from public.fb_products p where p.product_key = c.component_key) as in_fishbowl,
       (select p.list_price from public.fb_products p where p.product_key = c.component_key limit 1) as fishbowl_sale_price
from comp c, b
where not exists (select 1 from public.price_items x where x.book_id = b.id and x.part_key = c.component_key and x.status = 'priced' and x.list_price is not null)
group by 1, 3, 4 order by kits_blocked desc limit 100;

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- BLOCK 4 — sanity vs today's Fishbowl list (read-only). For fully priced kits, the engine's Each should
--   be close to the July 28 list (Σ at Rev 81 × 1.15 uplift ≈ Fishbowl list × 1.15, less the hardware
--   change). Large deviations = BOM differences between the registry and the July workbook.
-- ═════════════════════════════════════════════════════════════════════════════════════════════
with b as (select id from public.price_books where status = 'draft' order by effective_from desc limit 1),
kits as (select i.id, i.part_number, i.part_key from public.price_items i, b where i.book_id = b.id and i.kit_sku_id is not null and i.status = 'component_sum'),
sums as (
  select k.id, k.part_number, k.part_key, sum(c.qty * x.list_price) as sum_each, count(*) as comps, count(x.id) as resolved
  from kits k join public.price_kit_components c on c.item_id = k.id
  left join public.price_items x on x.book_id = (select id from b) and x.part_key = c.component_key and x.status = 'priced'
  group by 1, 2, 3)
select s.part_number, round(s.sum_each, 2) as rev82_sum, p.list_price as fishbowl_list_jul28,
       round(s.sum_each / nullif(p.list_price, 0), 3) as ratio, s.comps, s.resolved
from sums s left join public.fb_products p on p.product_key = s.part_key
where s.resolved = s.comps
order by abs(coalesce(s.sum_each / nullif(p.list_price, 0), 0) - 1.15) desc
limit 60;

