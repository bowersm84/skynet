# Rev 81 load report — 2026-09-04

## Counts

- continuation_sections: 12
- dropped_zero_each: 1
- duplicates_resolved: 24
- exceptions: 9
- guide_rows_read: 2492
- premier_parts: 70
- range_rows: 103
- range_skus: 963
- ranges_no_product: 33
- resale_items: 1157
- resale_no_price: 118
- resale_removed: 8
- skipped_sk5s5: 37
- tier_seeds: 108
- unpriced_parts: 78
- sections: 197  items: 4454  ladders: 18  rules: 13
- item status: {'priced': 4244, 'component_sum': 16, 'no_price': 194}
- items per section kind: {'catalog': 3297, 'resale': 1157}

## Ladders derived from section headers

- `standard`: 100 | 300 | 500 | Tier 1 | Tier 2 | Tier 3  — used by 3151 items
- `each_t1_t2`: Tier 1 | Tier 2  — used by 4 items
- `none`:   — used by 1157 items
- `kit_2_5`: 2–4 | 5+  — used by 1 items
- `q100_q300_q500`: 100 | 300 | 500  — used by 19 items
- `q10_q50_q100`: 10 | 50 | 100  — used by 4 items
- `q10_q50_tier1_tier2_tier3`: 10 | 50 | Tier 1 | Tier 2 | Tier 3  — used by 9 items
- `q2_q5`: 2 | 5  — used by 1 items
- `q5_q10_tier1_tier2`: 5 | 10 | Tier 1 | Tier 2  — used by 4 items
- `q5_q10_tier1_tier2_tier3`: 5 | 10 | Tier 1 | Tier 2 | Tier 3  — used by 2 items
- `q5_q10_q25_tier1_tier2_tier3`: 5 | 10 | 25 | Tier 1 | Tier 2 | Tier 3  — used by 1 items
- `q5_q10`: 5 | 10  — used by 15 items
- `q5`: 5  — used by 37 items
- `q100`: 100  — used by 37 items
- `q10_q50_q300`: 10 | 50 | 300  — used by 2 items
- `q10_q20`: 10 | 20  — used by 4 items
- `q5_q20_q50`: 5 | 20 | 50  — used by 3 items
- `q2`: 2  — used by 3 items

## Rules

- A: [0.96, 0.9, 0.83, 0.64, 0.62, 0.6]  — 1706 items
- B: [0.97, 0.9, 0.84, 0.65, 0.64, 0.63]  — 786 items
- C: [0.84, 0.79, 0.73, 0.56, 0.52, 0.48]  — 229 items
- D: [0.9, 0.84, 0.78, 0.6, 0.58, 0.57]  — 135 items
- E: [0.84, 0.78, 0.73, 0.56, 0.55, 0.53]  — 151 items
- F: [0.84, 0.79, 0.73, 0.56, 0.52, 0.44]  — 3 items
- G: [0.95, 0.88, 0.82, 0.63, 0.62, 0.61]  — 87 items
- H: [0.95, 0.93, 0.86, 0.66, 0.64, 0.62]  — 38 items
- I: [0.96, 0.9, 0.83, 0.64, 0.62, 0.4]  — 30 items
- J: [0.96, 0.9, 0.83, 0.64, 0.62, 0.48]  — 6 items
- L: [0.96, 0.9, 0.83, 0.56, 0.52, 0.352]  — 25 items
- M: [0.84, 0.79, 0.73, 0.48, 0.472, 0.464]  — 8 items
- KIT: [0.8, 0.75, None, None, None, None]  — 1 items

## Exceptions (pct of Tier 3)

- customer 12587 × SK201-2: 0.8338  (special Premier kept from Rev 81 (0.365 vs T3 0.438))
- customer 12587 × SK201-3: 0.8338  (special Premier kept from Rev 81 (0.365 vs T3 0.438))
- customer 12587 × SK201-31: 0.8338  (special Premier kept from Rev 81 (0.365 vs T3 0.438))
- customer 12587 × SK201-4: 0.8338  (special Premier kept from Rev 81 (0.365 vs T3 0.438))
- customer 12587 × SK201-5: 0.8338  (special Premier kept from Rev 81 (0.365 vs T3 0.438))
- customer 12587 × SK201-6: 0.8338  (special Premier kept from Rev 81 (0.365 vs T3 0.438))
- customer 552 × SK40R17-1: 0.6871  (special Premier kept from Rev 81 (2.523 vs T3 3.672))
- customer 552 × SK40R17-1E: 0.6871  (special Premier kept from Rev 81 (2.878 vs T3 4.188))
- customer 552 × SK40R17-2: 0.6871  (special Premier kept from Rev 81 (2.523 vs T3 3.672))

## rules

- F Tier 3 filled = 0.73 (matches C)
- K, N, P retired (K→D, N→C, P→A each_t1_t2)
- K, N, P retired (K→D, N→C, P→A each_t1_t2)
- K, N, P retired (K→D, N→C, P→A each_t1_t2)
- KIT rule added for the Cloc 2000 Kit (2–4 = ×0.80, 5+ = ×0.75, typed on the sheet)

## descriptions

- 43 descriptions supplied by Matt applied by sheet row

## each_formula

- row 717 SK212-12ENC: Each formula evaluated to 14.524537500000001

## dropped

- row 1493 All parts below require SK4SWS Retainers: Each=0 dropped

## ranges_dropped

- row 45 SK2600-21 to -30: no Fishbowl product
- row 46 SK2600-31 to -50: no Fishbowl product
- row 163 SK26S51-21B to 30B: no Fishbowl product
- row 466 SK2600-13SFW1to 20SFW: no Fishbowl product
- row 481 SK2601-13SFW1to 20SFW: no Fishbowl product
- row 496 SK2603-13SFW1to 20SFW: no Fishbowl product
- row 497 SK2603-21SFW to 30SFW: no Fishbowl product
- row 512 SK2700-21 to 30: no Fishbowl product
- row 527 SK2700-21S to 30S: no Fishbowl product
- row 603 SK28S3-21S to 30S: no Fishbowl product
- row 1219 SK40S41-21S to -30S: no Fishbowl product
- row 1243 SK4002-21S45 to -30S45: no Fishbowl product
- row 1255 ZG4000-11 to -20: no Fishbowl product
- row 1256 ZG4000-21 to -30: no Fishbowl product
- row 1257 ZG4000-31 to -50: no Fishbowl product
- row 1353 SK40S41-21SC to -30SC: no Fishbowl product
- row 1399 SK4002-21SL to -30SL: no Fishbowl product
- row 1400 SK4002-31SL to -50SL: no Fishbowl product
- row 1428 SK4002-31HS to -50HS: no Fishbowl product
- row 1453 SK40S37-21S to -30S: no Fishbowl product
- row 1454 SK40S37-31S to -50S: no Fishbowl product
- row 1622 SK4002-11SW45 to 45-20SW: no Fishbowl product
- row 1623 SK4002-21SW45 to 45-50SW: no Fishbowl product
- row 1731 SK4004-13SFW to -20SFW: no Fishbowl product
- row 1732 SK4004-21SFW to -50SFW: no Fishbowl product
- row 1744 SG4002-11R to -20R: no Fishbowl product
- row 2814 SK2500-11 to 20S: no Fishbowl product
- row 2815 SK2500-21 to 30S: no Fishbowl product
- row 2830 SK25S51-21 to 30: no Fishbowl product
- row 2923 SK25S3-21S to 30S: no Fishbowl product
- row 2986 SK2500-11SW to 20SW: no Fishbowl product
- row 2987 SK2500-21SW to 30SW: no Fishbowl product
- row 3033 SK2500R21S to R30S: no Fishbowl product

## removed

- 1 guide rows removed per the resale decisions: CATALOG, CUSTOMERNOTES, RESTOCKINGFEE, SK2003-AW5S, SK201/203CLIP, SK212-12E, USPSFREIGHT, ZGO65-50H

## duplicates

- SK212-12ENC: rows 702 & 717 → kept row 717 (Each 14.525)
- SK212-12DENC: rows 703 & 718 → kept row 718 (Each 17.474)
- SK212E12A: rows 700 & 807 → kept row 700 (Each 5.247)
- SK212E12S: rows 701 & 808 → kept row 808 (Each 9.852)
- SK21060L08E: rows 841 & 894 → kept row 841 (Each 7.05)
- SK21060L3E: rows 842 & 895 → kept row 842 (Each 7.05)
- SK21060L4E: rows 843 & 896 → kept row 843 (Each 7.41)
- SK21060L420E: rows 844 & 897 → kept row 844 (Each 7.41)
- SK21060LM4E: rows 846 & 899 → kept row 846 (Each 7.05)
- SK21060LM5E: rows 847 & 900 → kept row 847 (Each 7.05)
- SK21060LM6E: rows 848 & 901 → kept row 848 (Each 7.41)
- SK214C-ENC: rows 1403 & 1431 → kept row 1403 (Each 33.162)
- SK214C-ENCB: rows 1404 & 1432 → kept row 1404 (Each 33.162)
- SK4002-27: rows 1126 & 1571 → kept row 1571 (Each 22.62)
- SK4002-28: rows 1127 & 1571 → kept row 1571 (Each 22.62)
- SK4002-29: rows 1128 & 1571 → kept row 1571 (Each 22.62)
- SK4002-30: rows 1129 & 1571 → kept row 1571 (Each 22.62)
- SK-R4GS: rows 1510 & 1995 → kept row 1510 (Each 0.536)
- SK201-6: rows 834 & 2025 → kept row 834 (Each 0.912)
- SK244C16PB: rows 2044 & 2049 → kept row 2044 (Each 23.062)
- SK245A161A: rows 1513 & 2079 → kept row 1513 (Each 12.787)
- SK245-461A: rows 2084 & 2085 → kept row 2084 (Each 24.475)
- SKFJ4-30SS: rows 2424 & 2425 → kept row 2424 (Each 6.696)
- ZG2500-21A1BLK: rows 2860 & 2875 → kept row 2860 (Each 12.614)

## resale_aliased

- SK203A01A → SK203A01AE
- SK212-12S8 → SK212-12S
- SK213-1SD → SK212-12SD

## resale_priced_by_matt

- SK244-461 = 1.5
- SK245A36 = 2.0
- SK245C36 = 5.0