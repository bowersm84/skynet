-- ============================================================================
-- D-PRICE-67 — 39 kits join the book at Σ (option (a), Matt 2026-10-07); the
-- book's kit sections mirror the Kit Registry / kits-site families; 18 registry
-- BOMs come from Fishbowl; SK221-2S added; PK-AN3 / PK-AN3A retired.
--
-- Source review: Pricing_Review_after_Rev82_2026-10-01_1.xlsx, tab "4 Nexternal
-- not in book" (43 "Add to book" less 3 hardware packs retired and SK221-2S, which
-- is a part, not a kit = 39 kits). BOMs: Kit_Component_Report_100726-2.csv, the
-- v2 Fishbowl export of every kititem row (682 kits); the 21 kits that already had
-- a registry BOM match Fishbowl line for line and to the cent, so Fishbowl is the
-- source for the other 18. Four lines are 1.5 oz against a per-pound book price
-- and are stored as 0.09375 lb (source column says so).
--
-- Scope: the ACTIVE book (Rev 82), in place, as D-PRICE-62/63/65/66. Registry
-- changes are permanent (not per book).
--
-- What it does
--   R1  kit_skus.family allows 'Accessory/Tool' (the site's seventh family);
--       kit_skus.kit_type (new column: conversion | replacement | null) — the
--       kits site's own field, so sync-kits keeps publishing `family` unchanged
--       and the site does not regroup. 'conversion' set by the site's pattern
--       (B35LC/B35UC, C1xxC2800, CIT-4000, PA30-270x, SK203C*) on active kits.
--   R2  11 new registry kits (RV non-J ×7, SK203C ×4), descriptions from Fishbowl.
--   R3  Missing kit_components (SK2003-24A) and 246 BOM lines for the 18 kits with
--       none; the 7 BOM-less kits also get their Fishbowl description.
--   R4  family on the batch: RV*→RV Kit; KA90-*, PA34-OPTIONS-1P, SK203C*→Option
--       Kit; C425-C1P→Cowling Kit; SK4P3-T26, SK4002-TS2→Accessory/Tool.
--       Everything else unfamilied (Common Sets, FBO packs, BE-KINGAIR…) untouched.
--   R5  PK-AN3, PK-AN3A → is_active = false (all hardware; PK-DIMPLE WASHER is not
--       in the registry — retire it in Fishbowl/Nexternal).
--   B1  Two sections: "Skybolt Kits — Conversion Kits (STC)" and "Skybolt Kits —
--       Accessory/Tool", after Lancair. The 22 conversion kits now in Option move.
--   B2  39 items on the kit ladder (status component_sum, Σ at Each, Distributor =
--       Each × 0.70, D-PRICE-66) with price_kit_components from the registry BOM
--       (instruction sheets left out, as every kit since D-PRICE-46).
--   B3  RV679-C1P-F: hand-priced $298.44 in Resale Items → component_sum in RV Kit
--       (Σ $1,001.21; tab 6's suggestion, and the only RV kit outside the family).
--   B4  SK221-2S: priced part, $5.62 (Nexternal), rule A, ladder standard, in the
--       SK209/210/220/221 Receptacles section beside SK221-2SN.
--
-- Fishbowl / kits site (not pushed by this file): the 40 Σ prices reach the kits
-- site on the next nightly run and Fishbowl list on the next prices push; the
-- team keeps entering distributor prices on orders by hand (D-PRICE-66).
-- Hardware-only kits still in the registry (FBO *, BE-KINGAIR *, PK-INTERIOR …)
-- are a follow-up retire list, not this file.
--
-- Run with psql ($env:TEST_DB_URL / PROD_DB_URL, PGCLIENTENCODING=UTF8). Re-run
-- safe: every insert is guarded by existence; the moves match only rows not yet
-- moved. The staging table is dropped at the end.
-- ============================================================================

-- 0. DRY RUN — expect: add_kits 39 · in_registry 28 · with_bom 21 · in_book 0 ·
--    conversion_in_option 22 · sections_now 205 · rv679_c1p_f 'priced $298.440 Resale Items'
with adds(p) as (values ('SK4P3-T26'),('SK203C172P-FW4'),('KA90-NP1'),('SK203C182P-FW4'),('SK203C172P-SD4'),('SK203C150P-FW4'),('SK203C172P-XP4'),('SK203C172PQ-SD4'),('SK203C150P-SD2'),('KA90-WP1'),('KA90-BP1'),('KA90-NP2'),('PA34-OPTIONS-1P'),('KA90-AP1'),('SK203C172P-RS4FW'),('RV1014-C1P-S'),('RV679-C1P'),('SK203C172P-RET'),('C425-C1P'),('RV1014-C1P'),('RV1014-C1P-UF'),('RV4-C1P-F'),('RV4-C1P-S'),('RV4-C1P-U'),('RV679-C1P-UF'),('RV679-C1S'),('RV679-C1S-UF'),('RV8-C1P'),('RV8-C1P-UF'),('SK203C182P-RET'),('RV679-C1P-S'),('RV679-C1S-S'),('RV8-C1P-F'),('SK203C150P-RET'),('SK203C172PXP-RET'),('SK203C177P-FW4'),('SK203C177P-RET'),('SK203C177P-SD4'),('SK203C182P2')),
b as (select id from price_books where status = 'active')
select (select count(*) from adds) add_kits,
       (select count(*) from adds a join kit_skus k on k.part_number = a.p) in_registry,
       (select count(*) from adds a join kit_skus k on k.part_number = a.p where exists (select 1 from kit_bom_lines l where l.kit_sku_id = k.id)) with_bom,
       (select count(*) from adds a join price_items i on i.part_key = a.p join b on b.id = i.book_id) in_book,
       (select count(*) from price_items i join price_sections s on s.id = i.section_id join b on b.id = i.book_id
         where s.name = 'Skybolt Kits — Option Kit' and i.part_key ~ '^(B35LC|B35UC|C1[0-9]{2}C2800|CIT-4000|PA30-270|SK203C)') conversion_in_option,
       (select count(*) from price_sections s join b on b.id = s.book_id) sections_now,
       (select i.status || ' $' || i.list_price || ' ' || s.name from price_items i join price_sections s on s.id = i.section_id join b on b.id = i.book_id where i.part_key = 'RV679-C1P-F') rv679_c1p_f;

-- 1. STAGE the 18 Fishbowl BOMs (dropped at the end)
drop table if exists _d67_bom;
create table _d67_bom (kit text, line_no int, component text, comp_desc text, qty numeric, uom text, source text);
insert into _d67_bom values
('C425-C1P',1,'SK40S5-3S','Phillips Stud - Stainless - 1050 LB - Diamondhead',28,'ea','Fishbowl kititem 2026-10-07'),
('C425-C1P',2,'SK40S5-4S','Phillips Stud - Stainless - 1050 LB - Diamondhead',3,'ea','Fishbowl kititem 2026-10-07'),
('C425-C1P',3,'SK40S5-5S','Phillips Stud - Stainless - 1050 LB - Diamondhead',20,'ea','Fishbowl kititem 2026-10-07'),
('C425-C1P',4,'SK40S5-6S','Phillips Stud - Stainless - 1050 LB - Diamondhead',40,'ea','Fishbowl kititem 2026-10-07'),
('C425-C1P',5,'SK40S5-7S','Phillips Stud - Stainless - 1050 LB - Diamondhead',12,'ea','Fishbowl kititem 2026-10-07'),
('C425-C1P',6,'SK40S5-8S','Phillips Stud - Stainless - 1050 LB - Diamondhead',15,'ea','Fishbowl kititem 2026-10-07'),
('C425-C1P',7,'SK40S5-9S','Phillips Stud - Stainless - 1050 LB - Diamondhead',3,'ea','Fishbowl kititem 2026-10-07'),
('C425-C1P',8,'SK-GS','CSK Grommet .065 Stainless',28,'ea','Fishbowl kititem 2026-10-07'),
('C425-C1P',9,'SK-HS','CSK Grommet .094 Stainless',86,'ea','Fishbowl kititem 2026-10-07'),
('C425-C1P',10,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',114,'ea','Fishbowl kititem 2026-10-07'),
('C425-C1P',11,'MS24693-C50','#8-32 Phillips Flush Head Screw - Stainless',50,'ea','Fishbowl kititem 2026-10-07'),
('C425-C1P',12,'MS24693-C272','#4-40  Flat Head Phillips',50,'ea','Fishbowl kititem 2026-10-07'),
('C425-C1P',13,'DP1080-17SS','#8  Stainless',50,'ea','Fishbowl kititem 2026-10-07'),
('C425-C1P',14,'DP1085-20SS','#10  Stainless',50,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',1,'SK245A162A','Non-Floating Receptacle - Alum Cage-Alum Insert - Clip Retainer',62,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',2,'SK245A161-INS','Floating Insert Assembly - Change 162 Receptacle to 161 Receptacle',2,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',3,'SK40S5-2S','Phillips Stud - Stainless - 1050 LB - Diamondhead',62,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',4,'SK-OSG1-8','PlusFlush Grommet .094 Stainless High Shear',62,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',5,'SK-O18S','PlusFlush Grommet .125  Stainless',2,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',6,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',64,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',7,'SK-RVC','Flange Cleko - without Magnet',10,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',8,'MS20426AD3-4C','Flush Head Rivet Package - 100 Pc Bag',2,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',9,'MS20426AD3-5C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',10,'MS20426AD4-4C','Flush Head Rivet Package - 100 Pc Bag',2,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',11,'MS21059L3','#10-32 Floating Two Lug AllMetal',10,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',12,'MS24693-C272','#10-32 Phillips Flush Head Screw - Stainless',10,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',13,'DP1085-20SS','#10  Stainless',10,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',14,'RV Instructions','N',1,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',15,'SK-RET012','Temporary Retainer',65,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',16,'Template-215','Pilot Drilling Template for SK215/SK245',1,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',17,'Template-245','Center Hole Template for SK215/SK245',1,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P',18,'D188C','N',6,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P-UF',1,'SK245A162A','Non-Floating Receptacle - Alum Cage-Alum Insert - Clip Retainer',19,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P-UF',2,'SK245A161-INS','Floating Insert Assembly - Change 162 Receptacle to 161 Receptacle',2,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P-UF',3,'SK40S5-2S','Phillips Stud - Stainless - 1050 LB - Diamondhead',19,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P-UF',4,'SK-OSG1-8','PlusFlush Grommet .094 Stainless High Shear',19,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P-UF',5,'SK-O18S','PlusFlush Grommet .125  Stainless',2,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P-UF',6,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',21,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P-UF',7,'SK-RET012','Temporary Retainer',30,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P-UF',8,'SK-RVC','Flange Cleko - without Magnet',5,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P-UF',9,'MS20426AD3-4C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P-UF',10,'MS20426AD3-5C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P-UF',11,'MS20426AD4-4C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P-UF',12,'RV Instructions','N',1,'ea','Fishbowl kititem 2026-10-07'),
('RV1014-C1P-UF',13,'D188C','3/8 x 3/16 Magnet',6,'ea','Fishbowl kititem 2026-10-07'),
('RV4-C1P-U',1,'SK245A162A','Non-Floating Receptacle - Alum Cage-Alum Insert - Clip Retainer',30,'ea','Fishbowl kititem 2026-10-07'),
('RV4-C1P-U',2,'SK245A161-INS','Floating Insert Assembly - Change 162 Receptacle to 161 Receptacle',2,'ea','Fishbowl kititem 2026-10-07'),
('RV4-C1P-U',3,'SK40S5-2S','Phillips Stud - Stainless - 1050 LB - Diamondhead',30,'ea','Fishbowl kititem 2026-10-07'),
('RV4-C1P-U',4,'SK-OSG1-8','PlusFlush Grommet .094 Stainless High Shear',30,'ea','Fishbowl kititem 2026-10-07'),
('RV4-C1P-U',5,'SK-O18S','PlusFlush Grommet .125  Stainless',2,'ea','Fishbowl kititem 2026-10-07'),
('RV4-C1P-U',6,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',32,'ea','Fishbowl kititem 2026-10-07'),
('RV4-C1P-U',7,'SK-RVC','Flange Cleko - without Magnet',10,'ea','Fishbowl kititem 2026-10-07'),
('RV4-C1P-U',8,'MS20426AD3-4C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV4-C1P-U',9,'MS20426AD3-5C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV4-C1P-U',10,'MS20426AD4-4C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV4-C1P-U',11,'MS21059L3','#10-32 Floating Two Lug AllMetal',10,'ea','Fishbowl kititem 2026-10-07'),
('RV4-C1P-U',12,'MS24693-C272','#10-32 Phillips Flush Head Screw - Stainless',10,'ea','Fishbowl kititem 2026-10-07'),
('RV4-C1P-U',13,'DP1085-20SS','#10  Stainless',10,'ea','Fishbowl kititem 2026-10-07'),
('RV4-C1P-U',14,'SK-RET012','Temporary Retainer',30,'ea','Fishbowl kititem 2026-10-07'),
('RV4-C1P-U',15,'RV Instructions','Instructions',1,'ea','Fishbowl kititem 2026-10-07'),
('RV4-C1P-U',16,'D188C','3/8 x 3/16 Magnet',6,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1P-S',1,'SK245A162A','Non-Floating Receptacle - Alum Cage-Alum Insert - Clip Retainer',20,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1P-S',2,'SK245A161-INS','Floating Insert Assembly - Change 162 Receptacle to 161 Receptacle',2,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1P-S',3,'SK40S5-2S','Phillips Stud - Stainless - 1050 LB - Diamondhead',20,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1P-S',4,'SK-OSG1-8','PlusFlush Grommet .094 Stainless High Shear',20,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1P-S',5,'SK-O18S','PlusFlush Grommet .125  Stainless',2,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1P-S',6,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',22,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1P-S',7,'MS20426AD3-4C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1P-S',8,'MS20426AD3-5C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1P-S',9,'MS20426AD4-4C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1P-S',10,'MS21059L3','#10-32 Floating Two Lug AllMetal',10,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1P-S',11,'MS24693-C272','#10-32 Phillips Flush Head Screw - Stainless',10,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1P-S',12,'DP1085-20SS','#10  Stainless',10,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1P-S',13,'RV Instructions','N',1,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1P-S',14,'SK-RET012','Temporary Retainer',30,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1P-S',15,'D188C','N',6,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',1,'SK245A162A','Non-Floating Receptacle - Alum Cage-Alum Insert - Clip Retainer',52,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',2,'SK245A161-INS','Floating Insert Assembly - Change 162 Receptacle to 161 Receptacle',2,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',3,'SK4002-2S','Collared Slot Stud - Stainless - 1050 LB',52,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',4,'SK-OSG1-8','PlusFlush Grommet .094 Stainless High Shear',52,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',5,'SK-O18S','PlusFlush Grommet .125  Stainless',2,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',6,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',54,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',7,'SK-RVC','Flange Cleko - without Magnet',10,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',8,'MS20426AD3-4C','Flush Head Rivet Package - 100 Pc Bag',2,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',9,'MS20426AD3-5C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',10,'MS20426AD4-4C','Flush Head Rivet Package - 100 Pc Bag',2,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',11,'MS21059L3','#10-32 Floating Two Lug AllMetal',10,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',12,'MS24693-C272','#4-40  Flat Head Phillips',10,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',13,'DP1085-20SS','#10  Stainless',10,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',14,'RV Instructions','N',1,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',15,'SK-RET012','Temporary Retainer',65,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',16,'Template-215','Pilot Drilling Template for SK215/SK245',1,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',17,'Template-245','Center Hole Template for SK215/SK245',1,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S',18,'D188C','N',6,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-S',1,'SK4002-2S','Collared Slot Stud - Stainless - 1050 LB',20,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-S',2,'SK-OSG1-8','PlusFlush Grommet .094 Stainless High Shear',20,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-S',3,'SK-O18S','PlusFlush Grommet .125  Stainless',2,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-S',4,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',22,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-S',5,'MS20426AD3-4','Flush Head Rivet   Package - 1 Pound per Unit Ordered',0.09375,'lb','Fishbowl kititem 2026-10-07 (1.5 oz -> lb; book prices per lb)'),
('RV679-C1S-S',6,'MS20426AD3-5','Flush Head Rivet   Package - 1 Pound per Unit Ordered',0.09375,'lb','Fishbowl kititem 2026-10-07 (1.5 oz -> lb; book prices per lb)'),
('RV679-C1S-S',7,'MS20426AD4-4','Flush Head Rivet   Package - 1 Pound per Unit Ordered',0.09375,'lb','Fishbowl kititem 2026-10-07 (1.5 oz -> lb; book prices per lb)'),
('RV679-C1S-S',8,'MS21059L3','#10-32 Floating Two Lug AllMetal',10,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-S',9,'MS24693-C272','#4-40  Flat Head Phillips',10,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-S',10,'DP1085-20SS','#10  Stainless',10,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-S',11,'RV Instructions','N',1,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-S',12,'SK245A162A','Non-Floating Receptacle - Alum Cage-Alum Insert - Clip Retainer',20,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-S',13,'SK245A161-INS','Floating Insert Assembly - Change 162 Receptacle to 161 Receptacle',2,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-S',14,'SK-RET012','Temporary Retainer',30,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-S',15,'D188C','N',6,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-UF',1,'SK4002-2S','Collared Slot Stud - Stainless - 1050 LB',32,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-UF',2,'SK-OSG1-8','PlusFlush Grommet .094 Stainless High Shear',32,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-UF',3,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',34,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-UF',4,'SK245A162A','Non-Floating Receptacle - Alum Cage-Alum Insert - Clip Retainer',32,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-UF',5,'SK245A161-INS','Floating Insert Assembly - Change 162 Receptacle to 161 Receptacle',2,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-UF',6,'MS20426AD3-4C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-UF',7,'MS20426AD3-5C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-UF',8,'MS20426AD4-4C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-UF',9,'SK-RVC','Flange Cleko - without Magnet',10,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-UF',10,'RV Instructions','Instructions',1,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-UF',11,'SK-O18S','PlusFlush Grommet .125  Stainless',2,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-UF',12,'SK-RET012','Temporary Retainer',65,'ea','Fishbowl kititem 2026-10-07'),
('RV679-C1S-UF',13,'D188C','3/8 x 3/16 Magnet',6,'ea','Fishbowl kititem 2026-10-07'),
('RV8-C1P-F',1,'SK245A162A','Non-Floating Receptacle - Alum Cage-Alum Insert - Clip Retainer',30,'ea','Fishbowl kititem 2026-10-07'),
('RV8-C1P-F',2,'SK245A161-INS','Floating Insert Assembly - Change 162 Receptacle to 161 Receptacle',2,'ea','Fishbowl kititem 2026-10-07'),
('RV8-C1P-F',3,'SK40S5-2S','Phillips Stud - Stainless - 1050 LB - Diamondhead',30,'ea','Fishbowl kititem 2026-10-07'),
('RV8-C1P-F',4,'SK-OSG1-8','PlusFlush Grommet .094 Stainless High Shear',30,'ea','Fishbowl kititem 2026-10-07'),
('RV8-C1P-F',5,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',32,'ea','Fishbowl kititem 2026-10-07'),
('RV8-C1P-F',6,'SK-RVC','Flange Cleko - without Magnet',10,'ea','Fishbowl kititem 2026-10-07'),
('RV8-C1P-F',7,'MS20426AD3-4C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV8-C1P-F',8,'MS20426AD3-5C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV8-C1P-F',9,'MS20426AD4-4C','Flush Head Rivet Package - 100 Pc Bag',1,'ea','Fishbowl kititem 2026-10-07'),
('RV8-C1P-F',10,'RV Instructions','N',1,'ea','Fishbowl kititem 2026-10-07'),
('RV8-C1P-F',11,'SK-RET012','Temporary Retainer',30,'ea','Fishbowl kititem 2026-10-07'),
('RV8-C1P-F',12,'D188C','N',6,'ea','Fishbowl kititem 2026-10-07'),
('SK203C150P-RET',1,'SK2003-42A','For Cloc 4000 Series Fastener (Non Adjustable)',11,'ea','Fishbowl kititem 2026-10-07'),
('SK203C150P-RET',2,'SK40S5-2S','Phillips Stud - Stainless - 1050 LB - Diamondhead',12,'ea','Fishbowl kititem 2026-10-07'),
('SK203C150P-RET',3,'SK40S5-3S','Phillips Stud - Stainless - 1050 LB - Diamondhead',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C150P-RET',4,'SK-OS','PlusFlush Grommet .094 Stainless',12,'ea','Fishbowl kititem 2026-10-07'),
('SK203C150P-RET',5,'SK-O18S','PlusFlush Grommet .125  Stainless',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C150P-RET',6,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C150P-RET',7,'AN525-832R8','#8-32 Washer Head Screw - Steel',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C150P-RET',8,'AN525-832R10','#8-32 Washer Head Screw - Steel',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C150P-RET',9,'MS21044N08','N',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C150P-RET',10,'SK2003-AW4S','Set (2ea AW4, 1ea SK2001A) Use with SK2003-14A,-24A,-42A',5,'ea','Fishbowl kititem 2026-10-07'),
('SK203C150P-RET',11,'SK203-TEM1','Alignment Template',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C150P-RET',12,'SK4150-42A.DOC','INSTRUCTIONS',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172P-RS4FW',1,'SK2003-42A','For Cloc 4000 Series Fastener (Non Adjustable)',11,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172P-RS4FW',2,'SK40S5-2S','Phillips Stud - Stainless - 1050 LB - Diamondhead',13,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172P-RS4FW',3,'SK40S5-3S','Phillips Stud - Stainless - 1050 LB - Diamondhead',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172P-RS4FW',4,'SK-OS','PlusFlush Grommet .094 Stainless',13,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172P-RS4FW',5,'SK-O18S','PlusFlush Grommet .125  Stainless',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172P-RS4FW',6,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',20,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172P-RS4FW',7,'SK-R4TS','Retaining Snap Ring .057 Stainless',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172P-RS4FW',8,'AN525-832R8','#8-32 Washer Head Screw - Steel',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172P-RS4FW',9,'AN525-832R10','#8-32 Washer Head Screw - Steel',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172P-RS4FW',10,'MS21044N08','N',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172P-RS4FW',11,'SK2003-AW4S','Set (2ea AW4, 1ea SK2001A) Use with SK2003-14A,-24A,-42A',5,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172P-RS4FW',12,'SK203-TEM1','Alignment Template',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172P-RS4FW',13,'SK4172RS-42A.DOC','INSTRUCTIONS',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PQ-SD4',1,'SK245-461A','New Cessna Conversion Kit Receptacle - Extended Cage',16,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PQ-SD4',2,'SK40S5-2S','Phillips Stud - Stainless - 1050 LB - Diamondhead',16,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PQ-SD4',3,'SK-OS','PlusFlush Grommet .094 Stainless',16,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PQ-SD4',4,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',20,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PQ-SD4',5,'SK-R4TS','Retaining Snap Ring .057 Stainless',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PQ-SD4',6,'MS20426AD4-5C','Diameter 1/8  Length 5/16',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PQ-SD4',7,'MS24693-C50','#8-32 Phillips Flush Head Screw - Stainless',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PQ-SD4',8,'8RX1/2THBS','#8 Phillips Head',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PQ-SD4',9,'10RX1/2THBS','#10 Phillips Head',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PQ-SD4',10,'DP1080-17SS','#8  Stainless',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PQ-SD4',11,'SK244-461','N',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PQ-SD4',12,'SK4172-42A.DOC','INSTRUCTIONS',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PXP-RET',1,'SK2003-42A','For Cloc 4000 Series Fastener (Non Adjustable)',13,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PXP-RET',2,'SK40S5-2S','Phillips Stud - Stainless - 1050 LB - Diamondhead',13,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PXP-RET',3,'SK40S5-3S','Phillips Stud - Stainless - 1050 LB - Diamondhead',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PXP-RET',4,'SK-OS','PlusFlush Grommet .094 Stainless',13,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PXP-RET',5,'SK-O18S','PlusFlush Grommet .125  Stainless',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PXP-RET',6,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',14,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PXP-RET',7,'AN525-832R8','#8-32 Washer Head Screw - Steel',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PXP-RET',8,'AN525-832R10','#8-32 Washer Head Screw - Steel',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PXP-RET',9,'MS21044N08','N',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PXP-RET',10,'SK2003-AW4S','Set (2ea AW4, 1ea SK2001A) Use with SK2003-14A,-24A,-42A',5,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PXP-RET',11,'SK203-TEM1','Alignment Template',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C172PXP-RET',12,'SK4172-42A.DOC','INSTRUCTIONS',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-FW4',1,'SK2003-42A','For Cloc 4000 Series Fastener (Non Adjustable)',14,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-FW4',2,'SK40S5-2S','Phillips Stud - Stainless - 1050 LB - Diamondhead',14,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-FW4',3,'SK40S5-3S','Phillips Stud - Stainless - 1050 LB - Diamondhead',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-FW4',4,'SK40S5-6S','Phillips Stud - Stainless - 1050 LB - Diamondhead',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-FW4',5,'SK-OS','PlusFlush Grommet .094 Stainless',10,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-FW4',6,'SK-O18S','PlusFlush Grommet .125  Stainless',4,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-FW4',7,'SK-316S','PlusFlush Grommet .1875  Stainless',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-FW4',8,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',20,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-FW4',9,'AN525-832R8','#8-32 Washer Head Screw - Steel',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-FW4',10,'AN525-832R10','#8-32 Washer Head Screw - Steel',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-FW4',11,'MS21044N08','N',30,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-FW4',12,'SK2003-AW4S','Set (2ea AW4, 1ea SK2001A) Use with SK2003-14A,-24A,-42A',5,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-FW4',13,'SK203-TEM1','Alignment Template',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-FW4',14,'SK4177-42A.DOC','INSTRUCTIONS',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-RET',1,'SK2003-42A','For Cloc 4000 Series Fastener (Non Adjustable)',14,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-RET',2,'SK40S5-2S','Phillips Stud - Stainless - 1050 LB - Diamondhead',14,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-RET',3,'SK40S5-3S','Phillips Stud - Stainless - 1050 LB - Diamondhead',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-RET',4,'SK-OS','PlusFlush Grommet .094 Stainless',14,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-RET',5,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',15,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-RET',6,'AN525-832R8','#8-32 Washer Head Screw - Steel',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-RET',7,'AN525-832R10','#8-32 Washer Head Screw - Steel',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-RET',8,'SK2003-AW4S','Set (2ea AW4, 1ea SK2001A) Use with SK2003-14A,-24A,-42A',5,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-RET',9,'SK203-TEM1','Alignment Template',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-RET',10,'SK4177-42A.DOC','INSTRUCTIONS',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-SD4',1,'SK245-461A','New Cessna Conversion Kit Receptacle - Extended Cage',10,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-SD4',2,'SK40S5-2S','Phillips Stud - Stainless - 1050 LB - Diamondhead',10,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-SD4',3,'SK-OS','PlusFlush Grommet .094 Stainless',10,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-SD4',4,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',10,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-SD4',5,'MS20426AD4-5','Flush Head Rivet   Package - 1 Pound per Unit Ordered',0.09375,'lb','Fishbowl kititem 2026-10-07 (1.5 oz -> lb; book prices per lb)'),
('SK203C177P-SD4',6,'MS24693-C50','#8-32 Phillips Flush Head Screw - Stainless',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-SD4',7,'DP1080-17SS','#8  Stainless',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-SD4',8,'Template-245A','Rivet Mount Template for SK245-4A',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C177P-SD4',9,'SK4177-42A.DOC','INSTRUCTIONS',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P-RET',1,'SK2003-42A','For Cloc 4000 Series Fastener (Non Adjustable)',14,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P-RET',2,'SK40S5-3S','Phillips Stud - Stainless - 1050 LB - Diamondhead',5,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P-RET',3,'SK40S5-4S','Phillips Stud - Stainless - 1050 LB - Diamondhead',6,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P-RET',4,'SK40S5-5S','Phillips Stud - Stainless - 1050 LB - Diamondhead',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P-RET',5,'SK40S5-6S','Phillips Stud - Stainless - 1050 LB - Diamondhead',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P-RET',6,'SK40S5-7S','Phillips Stud - Stainless - 1050 LB - Diamondhead',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P-RET',7,'SK-O18S','PlusFlush Grommet .125  Stainless',14,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P-RET',8,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',15,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P-RET',9,'AN525-832R8','#8-32 Washer Head Screw - Steel',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P-RET',10,'AN525-832R10','#8-32 Washer Head Screw - Steel',30,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P-RET',11,'MS21044N08','N',30,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P-RET',12,'SK2003-AW4S','Set (2ea AW4, 1ea SK2001A) Use with SK2003-14A,-24A,-42A',5,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P-RET',13,'SK203-TEM1','Alignment Template',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P-RET',14,'SK4182-42A.DOC','INSTRUCTIONS',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P2',1,'SK2003-24A','For Cloc 2600 Series Fastener (Non Adjustable)',14,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P2',2,'SK28S3-5S','Flush Head Stud - Phillips - Stainless',14,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P2',3,'SK2600-SW','Retaining Ring Split Ring - Non-Rigid - Stainless',15,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P2',4,'SK40S5-4S','Phillips Stud - Stainless - 1050 LB - Diamondhead',12,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P2',5,'SK40S5-5S','Phillips Stud - Stainless - 1050 LB - Diamondhead',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P2',6,'SK-HS','CSK Grommet .094 Stainless',12,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P2',7,'SK-R4GS','Retaining Snap Ring .038-.041 Stainless',15,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P2',8,'SK-R4TS','Retaining Snap Ring .057 Stainless',2,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P2',9,'AN525-832R8','#8-32 Washer Head Screw - Steel',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P2',10,'AN525-832R10','#8-32 Washer Head Screw - Steel',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P2',11,'MS24693-C50','#8-32 Phillips Flush Head Screw - Stainless',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P2',12,'DP1080-17SS','#8  Stainless',25,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P2',13,'MS21044N08','N',30,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P2',14,'SK2003-AW4S','Set (2ea AW4, 1ea SK2001A) Use with SK2003-14A,-24A,-42A',5,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P2',15,'SK203-TEM1','Alignment Template',1,'ea','Fishbowl kititem 2026-10-07'),
('SK203C182P2',16,'SK4182-42A.DOC','INSTRUCTIONS',1,'ea','Fishbowl kititem 2026-10-07');
-- expect 246 lines / 18 kits
select count(*) lines, count(distinct kit) kits, count(*) filter (where uom = 'lb') lb_lines from _d67_bom;

-- 2. APPLY
begin;

-- R1  kit_type on the registry, and the site's seventh family allowed on kit_skus.family
alter table kit_skus drop constraint if exists kit_skus_family_check;
alter table kit_skus add constraint kit_skus_family_check check (family = any (array['Cowling Kit','Option Kit','RV Kit','Lancair Kit','Trim Kit','Fuel Tank Kit','Accessory/Tool']));
alter table kit_skus add column if not exists kit_type text;
alter table kit_skus drop constraint if exists kit_skus_kit_type_check;
alter table kit_skus add constraint kit_skus_kit_type_check check (kit_type is null or kit_type in ('conversion', 'replacement'));

-- R2  the 11 new registry kits (description from Fishbowl; family by pattern; conversion by pattern)
insert into kit_skus (part_number, description, family, kit_type)
select v.p, v.d,
       case when v.p ~ '^RV' then 'RV Kit' else 'Option Kit' end,
       case when v.p ~ '^SK203C' then 'conversion' end
  from (values
    ('RV1014-C1P', 'Vans RV10,14 - Complete Kit - (No Flanges)'),
    ('RV1014-C1P-UF', 'RV10,14 - Upper Firewall Kit - Phillips Fasteners'),
    ('RV4-C1P-U', 'RV4 - Upper FW/Side Kit - 30 Phillips Fasteners'),
    ('RV679-C1S', 'Vans RV6,7,9,12 - Complete Kit - (No Flanges)'),
    ('RV679-C1S-UF', 'Vans RV6,7,9,12 - Upper Firewall Kit - (No Flanges)'),
    ('RV679-C1P-S', 'Vans RV6,7,9,12 - Side Kit - (No Flanges)'),
    ('RV679-C1S-S', 'Vans RV6,7,9,12 - Side Kit - (No Flanges)'),
    ('SK203C150P-RET', 'SK40S5S Phillips - Retro Kit'),
    ('SK203C172PXP-RET', 'SK40S5S Phillips - Retro Kit'),
    ('SK203C177P-RET', 'SK40S5S Phillips - Retro Kit'),
    ('SK203C177P-SD4', 'SK40S5S Phillips - Side Kit')) as v(p, d)
 where not exists (select 1 from kit_skus k where k.part_number = v.p);

-- R3a descriptions for the 7 registry kits that had none
update kit_skus k set description = v.d, updated_at = now()
  from (values ('SK203C172PQ-SD4', 'SK40S5S Phillips - Side Kit'), ('SK203C172P-RS4FW', 'SK40S5S Phillips - Firewall Kit'), ('C425-C1P', 'Engine Cowling - Phillips'),
               ('SK203C182P-RET', 'SK40S5S Phillips - Retro Kit'), ('RV8-C1P-F', 'RV8 - Firewall Kit (No Flanges) - 30 Phillips Fasteners'), ('SK203C177P-FW4', 'SK40S5S Phillips - Firewall Kit'),
               ('SK203C182P2', 'SK40S5S / SK28S3S Phillips - Complete Kit')) as v(p, d)
 where k.part_number = v.p and k.description is null;

-- R3b components the registry does not know yet
insert into kit_components (part_number, description)
select distinct on (upper(replace(s.component, ' ', ''))) s.component, s.comp_desc
  from _d67_bom s
 where not exists (select 1 from kit_components c where upper(replace(c.part_number, ' ', '')) = upper(replace(s.component, ' ', '')))
 order by upper(replace(s.component, ' ', '')), s.line_no;

-- R3c the 246 BOM lines — only for kits that have none (guard)
insert into kit_bom_lines (kit_sku_id, component_id, line_number, qty_per_kit, uom, source)
select k.id, c.id, s.line_no, s.qty, s.uom, s.source
  from _d67_bom s
  join kit_skus k on k.part_number = s.kit
  join kit_components c on upper(replace(c.part_number, ' ', '')) = upper(replace(s.component, ' ', ''))
 where not exists (select 1 from kit_bom_lines l where l.kit_sku_id = k.id);

-- R4  family on the batch (only where none)
update kit_skus k set family = v.f, updated_at = now()
  from (values ('RV Kit', '^RV'), ('Option Kit', '^(KA90-|PA34-OPTIONS-1P$|SK203C)'), ('Cowling Kit', '^C425-C1P$'), ('Accessory/Tool', '^(SK4P3-T26|SK4002-TS2)$')) as v(f, re)
 where k.family is null and k.is_active and k.part_number ~ v.re
   and k.part_number in ('SK4P3-T26','SK203C172P-FW4','KA90-NP1','SK203C182P-FW4','SK203C172P-SD4','SK203C150P-FW4','SK203C172P-XP4','SK203C172PQ-SD4','SK203C150P-SD2','KA90-WP1','KA90-BP1','KA90-NP2','PA34-OPTIONS-1P','KA90-AP1','SK203C172P-RS4FW','RV1014-C1P-S','RV679-C1P','SK203C172P-RET','C425-C1P','RV1014-C1P','RV1014-C1P-UF','RV4-C1P-F','RV4-C1P-S','RV4-C1P-U','RV679-C1P-UF','RV679-C1S','RV679-C1S-UF','RV8-C1P','RV8-C1P-UF','SK203C182P-RET','RV679-C1P-S','RV679-C1S-S','RV8-C1P-F','SK203C150P-RET','SK203C172PXP-RET','SK203C177P-FW4','SK203C177P-RET','SK203C177P-SD4','SK203C182P2','RV679-C1P-F','SK4002-TS2');

-- R1b conversion flag, the site's pattern, on every active registry kit
update kit_skus set kit_type = 'conversion', updated_at = now()
 where is_active and kit_type is distinct from 'conversion'
   and part_number ~ '^(B35LC|B35UC|C1[0-9]{2}C2800|CIT-4000|PA30-270|SK203C)';

-- R5  hardware packs retired
update kit_skus set is_active = false, updated_at = now() where part_number in ('PK-AN3', 'PK-AN3A') and is_active;

-- B1  the two new sections, after Lancair
insert into price_sections (book_id, name, sort, kind, header_note, source_row)
select b.id, v.name, (select max(sort) from price_sections x where x.book_id = b.id) + v.off, 'catalog', null, null
  from price_books b cross join (values ('Skybolt Kits — Conversion Kits (STC)', 1), ('Skybolt Kits — Accessory/Tool', 2)) as v(name, off)
 where b.status = 'active' and not exists (select 1 from price_sections y where y.book_id = b.id and y.name = v.name);

-- B1b the conversion kits already in Option move (item sort kept)
update price_items i set section_id = t.id, updated_at = now()
  from price_books b, price_sections s, price_sections t
 where b.id = i.book_id and b.status = 'active'
   and s.id = i.section_id and s.name = 'Skybolt Kits — Option Kit'
   and t.book_id = b.id and t.name = 'Skybolt Kits — Conversion Kits (STC)'
   and i.part_key ~ '^(B35LC|B35UC|C1[0-9]{2}C2800|CIT-4000|PA30-270|SK203C)';

-- B2  39 items on the kit ladder, section by kit_type / family, sort after the section's last item
insert into price_items (book_id, section_id, part_number, fb_product_id, kit_sku_id, description, list_price, rule_code, ladder_code, has_premier, dfar, sort, status, cost_plus)
select b.id, s.id, k.part_number, p.fb_product_id, k.id, k.description, null, null, 'kit', false, false,
       coalesce((select max(i.sort) from price_items i where i.section_id = s.id), 0) + row_number() over (partition by s.id order by k.part_number),
       'component_sum', false
  from price_books b
  join kit_skus k on k.part_number in ('SK4P3-T26','SK203C172P-FW4','KA90-NP1','SK203C182P-FW4','SK203C172P-SD4','SK203C150P-FW4','SK203C172P-XP4','SK203C172PQ-SD4','SK203C150P-SD2','KA90-WP1','KA90-BP1','KA90-NP2','PA34-OPTIONS-1P','KA90-AP1','SK203C172P-RS4FW','RV1014-C1P-S','RV679-C1P','SK203C172P-RET','C425-C1P','RV1014-C1P','RV1014-C1P-UF','RV4-C1P-F','RV4-C1P-S','RV4-C1P-U','RV679-C1P-UF','RV679-C1S','RV679-C1S-UF','RV8-C1P','RV8-C1P-UF','SK203C182P-RET','RV679-C1P-S','RV679-C1S-S','RV8-C1P-F','SK203C150P-RET','SK203C172PXP-RET','SK203C177P-FW4','SK203C177P-RET','SK203C177P-SD4','SK203C182P2')
  join price_sections s on s.book_id = b.id and s.name = case when k.kit_type = 'conversion' then 'Skybolt Kits — Conversion Kits (STC)' else 'Skybolt Kits — ' || k.family end
  left join fb_products p on p.product_key = upper(replace(k.part_number, ' ', '')) and p.removed_at is null
 where b.status = 'active'
   and not exists (select 1 from price_items i where i.book_id = b.id and i.part_key = upper(replace(k.part_number, ' ', '')));

-- B3  RV679-C1P-F: hand price → Σ, into the RV section
update price_items i
   set status = 'component_sum', list_price = null, rule_code = null, ladder_code = 'kit', section_id = t.id,
       sort = (select coalesce(max(x.sort), 0) + 1 from price_items x where x.section_id = t.id), updated_at = now()
  from price_books b, price_sections t
 where b.id = i.book_id and b.status = 'active' and i.part_key = 'RV679-C1P-F' and i.status = 'priced'
   and t.book_id = b.id and t.name = 'Skybolt Kits — RV Kit';

-- B2b/B3b book components for every kit item that has none, from the registry BOM, instruction sheets left out
insert into price_kit_components (item_id, component_part_number, qty)
select i.id, c.part_number, l.qty_per_kit
  from price_books b
  join price_items i on i.book_id = b.id and i.status = 'component_sum' and i.kit_sku_id is not null
  join kit_bom_lines l on l.kit_sku_id = i.kit_sku_id
  join kit_components c on c.id = l.component_id
 where b.status = 'active'
   and not exists (select 1 from price_kit_components x where x.item_id = i.id)
   and not exists (select 1 from pricing_excluded_products e where upper(replace(e.product_key, ' ', '')) = upper(replace(c.part_number, ' ', '')));

-- B4  SK221-2S at the Nexternal price
insert into price_items (book_id, section_id, part_number, fb_product_id, description, list_price, rule_code, ladder_code, has_premier, dfar, sort, status, cost_plus)
select b.id, s.id, 'SK221-2S', p.fb_product_id, coalesce(p.description, 'CSK Hd Insert 15/32-32 Stainless'), 5.62, 'A', 'standard', false, false,
       (select max(i.sort) + 1 from price_items i where i.section_id = s.id), 'priced', false
  from price_books b
  join price_sections s on s.book_id = b.id and s.name like 'SK209, SK210, SK220, SK221 Series Receptacles%'
  left join fb_products p on p.product_key = 'SK221-2S' and p.removed_at is null
 where b.status = 'active' and not exists (select 1 from price_items i where i.book_id = b.id and i.part_key = 'SK221-2S');

commit;

drop table if exists _d67_bom;

-- 3. VERIFY — TEST 2026-10-07 gave exactly: new_items 39 · unresolved 0 ·
--    kit_sections 'Cowling Kit 170 | Option Kit 89 | RV Kit 53 | Lancair Kit 7 | Conversion Kits (STC) 38 | Accessory/Tool 1' ·
--    rv679_c1p_f 'each=1001.21 | distributor=700.85' · sk203c172p_fw4 'each=1169.32 | distributor=818.52' ·
--    rv679_c1s_s 'each=649.20 | distributor=454.44' · sk221 'priced 5.620 A' · pk_retired 2 ·
--    kit_type_conversion 43 (the site's 43 exactly) · still_unfamilied 40 · new_bom_lines 246 · sections_total 207
with b as (select id from price_books where status = 'active'),
pp as (select * from pricing_item_prices((select id from b)))
select
  (select count(*) from price_items i, b where i.book_id = b.id and i.part_key in ('SK4P3-T26','SK203C172P-FW4','KA90-NP1','SK203C182P-FW4','SK203C172P-SD4','SK203C150P-FW4','SK203C172P-XP4','SK203C172PQ-SD4','SK203C150P-SD2','KA90-WP1','KA90-BP1','KA90-NP2','PA34-OPTIONS-1P','KA90-AP1','SK203C172P-RS4FW','RV1014-C1P-S','RV679-C1P','SK203C172P-RET','C425-C1P','RV1014-C1P','RV1014-C1P-UF','RV4-C1P-F','RV4-C1P-S','RV4-C1P-U','RV679-C1P-UF','RV679-C1S','RV679-C1S-UF','RV8-C1P','RV8-C1P-UF','SK203C182P-RET','RV679-C1P-S','RV679-C1S-S','RV8-C1P-F','SK203C150P-RET','SK203C172PXP-RET','SK203C177P-FW4','SK203C177P-RET','SK203C177P-SD4','SK203C182P2')) new_items,
  (select count(*) from pp where pp.col_key = 'each' and pp.unit_price is null and pp.part_number in ('SK4P3-T26','SK203C172P-FW4','KA90-NP1','SK203C182P-FW4','SK203C172P-SD4','SK203C150P-FW4','SK203C172P-XP4','SK203C172PQ-SD4','SK203C150P-SD2','KA90-WP1','KA90-BP1','KA90-NP2','PA34-OPTIONS-1P','KA90-AP1','SK203C172P-RS4FW','RV1014-C1P-S','RV679-C1P','SK203C172P-RET','C425-C1P','RV1014-C1P','RV1014-C1P-UF','RV4-C1P-F','RV4-C1P-S','RV4-C1P-U','RV679-C1P-UF','RV679-C1S','RV679-C1S-UF','RV8-C1P','RV8-C1P-UF','SK203C182P-RET','RV679-C1P-S','RV679-C1S-S','RV8-C1P-F','SK203C150P-RET','SK203C172PXP-RET','SK203C177P-FW4','SK203C177P-RET','SK203C177P-SD4','SK203C182P2','RV679-C1P-F')) unresolved,
  (select string_agg(s.name || ' ' || n, ' | ' order by s.sort) from (select s.name, s.sort, count(i.id) n from price_sections s join b on b.id = s.book_id left join price_items i on i.section_id = s.id where s.name like 'Skybolt Kits%' group by s.name, s.sort) s) kit_sections,
  (select string_agg(pp.col_key || '=' || round(pp.unit_price, 2), ' | ' order by pp.col_order) from pp where pp.part_number = 'RV679-C1P-F') rv679_c1p_f,
  (select string_agg(pp.col_key || '=' || round(pp.unit_price, 2), ' | ' order by pp.col_order) from pp where pp.part_number = 'SK203C172P-FW4') sk203c172p_fw4,
  (select string_agg(pp.col_key || '=' || round(pp.unit_price, 2), ' | ' order by pp.col_order) from pp where pp.part_number = 'RV679-C1S-S') rv679_c1s_s,
  (select i.status || ' ' || i.list_price || ' ' || i.rule_code from price_items i, b where i.book_id = b.id and i.part_key = 'SK221-2S') sk221,
  (select count(*) from kit_skus where part_number in ('PK-AN3', 'PK-AN3A') and not is_active) pk_retired,
  (select count(*) from kit_skus where kit_type = 'conversion') kit_type_conversion,
  (select count(*) from kit_skus where is_active and family is null) still_unfamilied,
  (select count(*) from kit_bom_lines l join kit_skus k on k.id = l.kit_sku_id where k.part_number in ('SK203C172PQ-SD4','SK203C172P-RS4FW','C425-C1P','SK203C182P-RET','RV8-C1P-F','SK203C177P-FW4','SK203C182P2','RV1014-C1P','RV1014-C1P-UF','RV4-C1P-U','RV679-C1S','RV679-C1S-UF','RV679-C1P-S','RV679-C1S-S','SK203C150P-RET','SK203C172PXP-RET','SK203C177P-RET','SK203C177P-SD4')) new_bom_lines,
  (select count(*) from price_sections s, b where s.book_id = b.id) sections_total;

-- ROLLBACK (only if needed — book side): delete price_kit_components / price_items for the 39 part keys above and
-- SK221-2S; restore RV679-C1P-F (status priced, list 298.44, ladder none, Resale Items section); move items with
-- part_key ~ the conversion pattern back to 'Skybolt Kits — Option Kit'; delete the two new sections.
-- Registry side: delete kit_bom_lines for the 18 kits, the 11 kit_skus rows, set family/kit_type back to null,
-- re-activate PK-AN3 / PK-AN3A, drop column kit_type.
