# SkyNet Costing Model — Decisions Log

**Workstream:** Manufacturing cost model (input costs → margins) for SkyNet MES / Skybolt Aeromotive
**Phase:** 0 — external Excel model (proof + data collection) before building costing into SkyNet. Phase 1 (cost fields in SkyNet) not started; the Pricing Portal (D-PRICE series, Docs/Decisions.md) now carries the sell side.
**Companion deliverable:** `SkyNet_Costing_Model_v0_9_11.xlsx` (18 tabs — 10 reference tabs + 8 Product tabs)
**Spec:** `SkyNet_Costing_Specification_v0_4.docx` (v0.5 referenced in Decisions.md; v0.4 is the latest copy in the project)
**Status as of 2026-10-01:** eight products costed end-to-end on the template (QL8C62 · SK21077-5 · Exum Sleeve+Insert · SK203C22 · SK2003-10C1 · SK4002-SFW · SK220-15S + nut, in the workbook; FA6-1/2-45-ACP and SK35C38B1 on fork workbooks — see Open items). Machine cycle for four parts is MEASURED from SkyNet jobs; the rest are hand estimates or comparables, flagged. Bar prices and sell prices are pulled live from PROD (material_receiving, price_items).
**Log convention:** append-only. Entries are never rewritten; a superseded entry gets a "→ superseded by" note. From D-COST-34 on, every costing decision is also logged in `Docs/Decisions.md` (one file carries every decision); this file remains the costing-only view and is the one that will seed SkyNet's decision table.

---

## Methodology decisions (locked)

- **D-COST-01 — Burden granularity: by individual machine, not class.** Size/tooling differ even within the Mazak class, so each machine carries its own $/hr. *(Implemented: Machine Master tab, one row per machine, 21 machines.)*
- **D-COST-02 — Operator labor / attendance: machines-per-operator.** `requires_attendance` is not captured (all jobs log as unattended). v1 spreads each operator's loaded annual cost across the machines they tend; single 8-hr shift, ~250 work days/yr. This allocation **is** the attendance factor. Operator labor is folded **into** the machine burden $/hr — so the Cost Model uses one rate for machine time and adds only finishing labor separately. *(Extended by D-COST-27: lights-out parts divide the same pool by 4,500 hrs.)*
- **D-COST-03 — Plant / G&A: single % of conversion cost for v1.** Default 15%. Refine to a rate in a later phase. *→ superseded by D-COST-19 (20%, bottom-up).*
- **D-COST-04 — TCO destructive-test scrap: EXCLUDED.** Low volumes, parts preserved for sale. (Reverses the initial recommendation, per Matt's call.)
- **D-COST-05 — Three non-overlapping tiers.** Machine Burden ($/machine-hr) · Direct Labor ($/labor-hr) · Plant G&A (% of conversion). Every cost maps to exactly one tier; nothing double-counts.
- **D-COST-06 — Setup capture is unreliable.** Machinists click through the setup step, so captured setup understates reality; estimates use **standard setup minutes** (30 min/lot). *(See D-COST-33 for new-program setups.)*
- **D-COST-07 — Labor burden multiplier = 1.30 (tunable).** FICA 7.65% + FUTA/SUI ~1% + WC ~3% + ADP admin, divided by ~0.90 productive hours. Tune once the WC rate is confirmed. *(Still 1.30; WC rate still unconfirmed.)*
- **D-COST-08 — Facilities costed separately (Leesburg vs Tavares).** Machining-floor occupancy is **$0.28/sqft/yr at Leesburg vs $11.32/sqft/yr at Tavares** — a ~40× asymmetry that makes a blended facility rate meaningless.
- **D-COST-09 — Machine depreciation = amount-financed ÷ 15-yr life.** Economic life (the fleet runs 2008→present), not MACRS. Amount-financed (US Bank Equipment Loans) is the acquisition-cost proxy. Paid-off/owned machines may carry $0 depreciation in v1. *(13 of 21 machines still carry $0 — every burden pool is a FLOOR; see Gap Log #4.)*
- **D-COST-10 — Material cost includes scrap material.** Bars needed = (order qty ÷ yield) ÷ pieces-per-bar, rounded up; the scrapped pieces' bar is a real cost. Pieces-per-bar = `FLOOR(usable bar ÷ (cutoff + kerf))`, where usable bar is net of the collet-grip remnant. *(Model standards: 141" usable on a 144" bar, 95% yield, kerf by bar size .05–.08.)*
- **D-COST-11 — Phasing.** Phase 0 = external Excel model (now). Phase 1 = build costing into SkyNet (add cost fields, load prices). Phase 2 = assembly costing once `FEATURES.ASSEMBLY_MODULE` is on.
- **D-COST-12 — Costing unit = the ASSEMBLY.** Per Matt's pivot mid-chat: stop costing individual pieces in isolation; roll machined components + purchased components + assembly labor into one product number per assembly. The machined-component build-ups feed the assembly headline. *(Clarified in practice: the costing unit is the sellable product. A standalone machined part that is itself the product — Exum Sleeve/Insert, FA6, SK220-15S — is costed as a one-component roll-up with overhead on its own conversion; an internal component with no price follows D-COST-35.)*
- **D-COST-13 — Heat-treat estimate via vendor rate card.** Braddock card (~$1,400 age + $65 cert + $20 handling + ~15% fuel surcharge) **reproduces the QL8-CS actual to the penny** ($1,707.75 / 1,072 = $1.593/pc), so it is validated as the estimating basis.
- **D-COST-14 — Two paths to the machine-burden rate.** Bottom-up (per-machine pool: depreciation + floor + power + coolant + tooling + maintenance + operator labor ÷ productive hrs) **or** top-down (total manufacturing overhead from QuickBooks ÷ annual machine-hours). For the leadership demo, top-down is the fast, defensible v1; bottom-up is the refinement. *(Outcome: bottom-up per-machine pools are the basis (Machine Master); top-down from the P&L was used for the overhead pool instead — D-COST-15/19.)*

### Overhead pool and labor placement (Spec v0.3, June 2026)

- **D-COST-15 —** Overhead pool built bottom-up from the trailing-365 P&L, owner-stripped ≈ $2.64M/yr (≈ 38% of revenue), itemized into 7 categories.
- **D-COST-16 —** Owner / non-operating costs (≈ $0.61M), direct production labor (≈ $1.04M, above the line), and machine-specific costs (≈ $0.10M, in Tier 1) are excluded from the G&A pool.
- **D-COST-17 —** Payroll is placed by cost-accounting reality, not QuickBooks' GL: direct production labor sits above the COGS line (Tiers 1–2); indirect/corporate payroll is the G&A pool.
- **D-COST-18 —** Two kinds of overhead — manufacturing-support (product cost, inventoriable, in every part) vs corporate G&A/SG&A (period cost, recovered via the pricing margin).
- **D-COST-19 —** Tier-3 = manufacturing-support overhead at ≈ 20% of conversion (pool ≈ $287k ÷ conversion ≈ $1.46M), replacing the flat 15% placeholder of D-COST-03. *(G&A Pool tab B41 = 0.20; every Product tab links to it.)*
- **D-COST-20 —** Corporate G&A (≈ $2.35M) is NOT absorbed per unit; recovered via pricing margin. Full absorption (82% of total cost) is retained only as a decision lens, not the costing basis.
- **D-COST-21 —** Overhead is applied once at the assembly roll-up on total conversion; machined components are carried at factory cost (no per-component overhead embedded). Conversion = machine run + setup + in-house finishing + assembly labor; outside processing, purchased parts, duty and NRE sit outside the base.
- **D-COST-22 —** Labor Rates placements finalized (v0.5): Jody + Ashley → direct/assembly; Phillips → indirect (R&D CAD); CS trio → Customer Service; Carr + Hawley = quality/manufacturing-support; Hawley added (File 000142, Dept 400, loaded $67,600/yr).
- **D-COST-23 —** QL8C62 headline = $17.00/unit (estimate): Stud $5.03 + Barrel $0.93 + Purchased $2.04 + Assembly labor $6.93 + Mfg-support overhead $2.07. Margins 60% list / 16% Tier 3. *(Workbook v0.8 re-based assembly to 3 min → $10.75/unit, 74% list / 47% Tier 3; the 12-vs-3-min question is still the time study.)*
- **D-COST-24 —** "Tier 3 price" replaces "volume / volume-10k" as the term for the $20.20 OEM/volume break. *(The Pricing Portal's rule multipliers — e.g. rule A T3 = 0.60, rule B T3 = 0.63 — are now the source of Tier 1/2/3.)*

### Assembly labor, measured cycles and the lights-out basis (Spec v0.4 §13, SK203C22, 10 Jul 2026)

- **D-COST-25 —** Assembly labor prices at the weighted-average loaded rate of the 10-person Dept-200 assembly crew ($22.69/hr), not an individual's rate. (MB, 10 Jul 2026) *(Jody excluded from the average per Matt; Labor Rates G17:G26.)*
- **D-COST-26 —** Measured cycle times from the SkyNet jobs harvest are the estimate source of record where they exist; hand estimates remain, flagged, only where no completed jobs exist. *(Precedence, as extended by D-COST-30/31/36: measured → send-derived → proxy → comparable → hand estimate.)*
- **D-COST-27 —** Lights-out Swiss machines costed on elapsed time use a 4,500 producing-hrs/yr burden basis (24 × 250 × 75%); attended machines keep the 1-shift 1,500-hr basis. *(Applied since to every 24-hr bar-fed part on the Mazaks too — SK2003-10C1, SK4002-SFW stud, SK220-15S. The attended/lights-out call per part is a stated assumption on each tab.)*
- **D-COST-28 —** SK203C-CAGE, SK203C22-CLIP, SK203-22CAP, SK201/203-CLIP are BUY (Maxtrust/Detian, China) — landed per the landed-cost rules (D-COST-39–41). Clip at $0.055 FOB per MB, superseding the $0.16 invoice price.
- **D-COST-29 —** Pinair special price $12.29 recorded alongside list/tier pricing; order-level margin reported at 44,000 pc.
- **D-COST-30 —** Harvest pieces divisor = good_pieces first (physical output), then qty_override, then quantity. Where production_start is missing, a rate recovered from the best bracketing timestamps (e.g. actual_start) is admissible, flagged PROXY.
- **D-COST-31 —** Where batch finishing sends exist, the send-waypoint method is the preferred rate recovery: pieces after the first send ÷ first→last-send span. It excludes setup and ramp ambiguity and needs no production_start. Used for SK213C-INS (J-000027, 4.26 min/pc). Calendar elapsed (weekends in) stays the costing basis, consistent with the barrel.

### Custom / new-program parts (FA6-1/2-45-ACP for AirCorps Aviation, 15 Jul 2026)

- **D-COST-32 —** NRE / special tooling (engraving cutters, custom inserts, dies) is a pass-through line on the part tab — a stated $ amount amortized over the quoted quantity (or billed separately as NRE), outside the conversion / 20% overhead base, like outsourcing. First use: FA6 "ACA" engraving cutter ($0 placeholder). Reused by D-COST-37 for the Wrico die.
- **D-COST-33 —** An attended new-program setup (new part, new program, proving out) is charged at the machinist's loaded $/hr for the stated hours (e.g. 4 hr × Patrick $58.50 = $234), not at machine burden $/hr, which would price a half-day of attended setup at ~$29. Standard repeat setups stay at 30 standard minutes × the attended machine rate (D-COST-06).

### Machine choice, internal components, comparables, DFARS, dash families (Docs/Decisions.md, Sep 2026)

- **D-COST-34 — Highest eligible machine is the costing basis when a part can run on several (2026-09-11).** When a part is eligible for more than one machine ("any Mazak or the Ganesh"), the headline uses the machine with the HIGHEST burden $/hr among the eligible set; every other eligible machine is a sensitivity row. Costing high is the conservative internal standard because machine assignment is an allocation choice (whose labor a pool carries), not a manufacturing fact. First use: SK2003-10C1 on Mazak 1/2 ($11.72/hr lights-out) vs Ganesh 1 ($1.63/hr).
- **D-COST-35 — Internal components with no sell price are costed to factory cost with volume from the parent product (2026-09-11).** A component never sold on its own (SK2003-10C1 → SK2003-X Platemount) is costed to factory cost INCLUDING the 20% overhead, with no margin or quote section; annual volume comes from Fishbowl shipments of the parent(s). First use: SK2003-10C1 = $0.518/pc at 42,567/yr.
- **D-COST-36 — Comparable-part cycle time is admissible when the part has no timestamped run (2026-09-16).** Where no SkyNet job has production_start → actual_end and no send-waypoint recovery is possible, the elapsed cycle of the closest MEASURED comparable (same feature set, bar, material, machine class) is the costing rate, flagged COMPARABLE, superseded by the part's own harvest the first time one exists. First use: SK4SFW(x) ← SK26SFW3/5, 5.22 min/pc Mazak 1 (3 jobs, 9,706 pcs).
- **D-COST-37 — DFARS / US-sourced components: domestic quote + tooling pass-through, no duty, post-processing in-house inside conversion, assembly rides the standard list (2026-09-16).** Costed at the domestic quote for the actual release plus the one-time die/engineering charge as a pass-through (D-COST-32) amortized over that release (longer amortization as sensitivity); any finishing the vendor does not do and Skybolt does in-house is direct labor inside the conversion base; the assembly keeps its standard Portal price, the premium is absorbed in margin and reported as its own line. First use: SK4FW2S via Wrico — $1.99/pc vs Maxtrust $0.28 landed.
- **D-COST-38 — Dash families are costed at the average dash unless a single dash is asked for (2026-09-16).** Headline cost uses the mean length-driven geometry across the family, cycle blended across the family's measured runs, headline price = mean of the family's Portal list prices. First use: SK4002-(x)SFW — stud L 1.160", cup A 0.397", avg list $25.53 / Tier 3 $16.08. *(SK220-15S-(x)SN, 2026-10-01: costed on the -5SN with an 8-dash length table instead — the series shares one Each, so a single costed dash plus the material spread is the honest view; see D-COST-43.)*

### Landed cost and import duty (Spec v0.3 §9, SK21077-5, June 2026) — RENUMBERED, see collision note

- **D-COST-39 (was D-COST-25 in Spec §9) —** Imported components are costed LANDED = FOB vendor price + import duty + domestic processing. Duty applies to FOB goods value only — never to domestic plating / finishing / assembly, and never in the conversion or overhead base.
- **D-COST-40 (was D-COST-26 in Spec §9) —** Duty rate is taken from the actual CBP entry (Form 7501), not an assumed headline. SK21077-5 entry 8K9-2419112-3 (Maxtrust, 6/25/26) = 25% §301 + 10% §122 = 35% (+ MPF ~0.35%).
- **D-COST-41 (was D-COST-27 in Spec §9) —** Parts enter as aircraft parts (HTS 8807.30.0060, MFN duty-free), which avoids Section 232 steel (50%) — classification is the dominant rate driver and must be protected. The 10% §122 layer is under appeal (possible refund). Inbound freight excluded (FOB basis); drawback possible if re-exported.
- **D-COST-42 (was D-COST-28 in Spec §9) —** SK21077-5 worked example = $4.33/unit landed (make). Make-vs-buy: buy Maxtrust now (landed $3.88, 54.4%, ~$34k/yr); qualify Xiamen (landed $3.03, 64.3%). Buying a machined component removes its machining from conversion and the 20% overhead base.

> **Collision note (2026-10-01).** Spec §9 (v0.3, June) and Spec §13 (v0.4, July) both issued D-COST-25 … D-COST-28. Everything written since July — D-COST-29 … 38, the workbook tab notes, Decisions.md — continues from the §13 set (D-COST-25 = crew rate, D-COST-26 = harvest, D-COST-27 = lights-out, D-COST-28 = SK203 BUY), so the §13 numbers are kept and the four landed-cost decisions move to D-COST-39–42. Artifacts that cite the old numbers for the landed-cost meaning and need a one-line correction when next touched: Spec v0.4 §9 table; SK21077-5 Product tab §6 notes; SK4002-SFW Product tab §4 ("35% per entry 8K9-2419112-3 (D-COST-26)" → D-COST-40). **Pending Matt's sign-off on the renumbering.**

### Proposed (2026-10-01) — pending Matt's approval

- **D-COST-43 (PROPOSED) — Standalone catalog parts: Each from the family comparable where one exists, cost-plus at 55% on Tier 3 otherwise; one Each across a length series.** When a new standalone part has a same-family comparable in the active book, its proposed Each is the comparable's Each (not cost-plus) so the family stays coherent; a part with no comparable is priced cost ÷ 0.45 ÷ (rule Tier 3 multiplier), rounded. A length-dash series whose factory cost spreads by less than ~$0.25 carries one Each. The two open approvals on this part pair — lights-out vs attended basis, and the nut Each ($2.50 cost-plus vs ~$3.75 family-margin) — are the first test of the rule. First use: SK220-15S $7.534 (= SK220-2S w/o Nut) + SK220-15S-(x)SN $2.500 (= $0.674 ÷ 0.45 ÷ 0.60). Migration `2026-10-01_D-PRICE-63_SK220-15S_into_Rev82.sql` (TEST applied, PROD pending).

---

## Cost build-up (the model)

Per machined part (estimate): **Material** (bar price ÷ (pcs/bar × yield)) + **Machine** (cycle min ÷ 60 × burden $/hr on the lights-out or attended basis, + standard setup amortized over the lot at the attended rate) + **In-house finishing** (passivation / wash minutes per lot ÷ lot × James loaded rate) + **Outsourcing / duty / NRE** (per piece or per lot, outside the overhead base) = **Factory cost** before overhead. **Conversion** = machine + setup + in-house finishing (+ assembly labor at the roll-up).

Per sellable product: Σ machined component factory cost (BOM qty) + Σ purchased component landed cost (BOM qty) + assembly labor (min/unit × $22.69/hr crew) + **mfg-support overhead = 20% × total conversion**, applied once = **total cost / unit**; vs the Portal price (list, column, tier, special) → **margin**. A standalone part is the one-component case of the same formula.

Standard inputs today: 144" bar, 141" usable, 95% yield, kerf .05 (3/8") · .06 (5/8") · .08 (3/4"–7/8"); setup 30 min/lot; passivation 15 min/lot; lights-out 4,500 hr, attended 1,500 hr; overhead 20%; labor multiplier 1.30; duty 35% on China FOB (entry 8K9-2419112-3).

---

## Reference data (current — superseding the June snapshot below where they differ)

**Machine burden (Machine Master, v0.9.11), attended $/hr → lights-out $/hr:** Mazak 1/2 35.15 → 11.72 (Carlos over 2 machines) · Mazak 3/4/6 11.59 → 3.86 · Mazak 5 14.75 → 4.92 · Mazak 7 23.73 → 7.91 · Nexturn 7 22.03 → 7.34 · Nexturn 5/6 9.86–10.72 → 3.29–3.57 · Nexturn 1 11.59 · Nexturn 2/3/4, Ganesh 1, BM 1/2/6 4.88 → 1.63 · BM 3/4/5 10.01–12.59. Pools = op-labor + depreciation only; floor / coolant / tooling / maintenance still $0 everywhere (floors).

**Labor (loaded ×1.30):** James Yates (finishing) $27.95 · Dept-200 assembly crew weighted average $22.69 (10 heads, ex-Jody) · Jody $34.65 · Patrick $58.50 · Jeff $42.25 · Carlos $50.70.

**Bar stock on hand (PROD material_receiving, 144" bars):** 3/8" 303 lot 2592 weighted $18.29/bar (4 receipts, 1,460 bars, Tri Star) · 5/8" 303 weighted $58.74/bar (lots 2618 $64.27, 2624 $53.30, 2622 $54.33, 2591 $44.39) · 3/4" 303 weighted $69.20/bar (lot 2588 $71.42 ×28; 2563, 2530, 2380 opening lots) · 7/8" 303 lot 2625 $104.08 · 3/8" A286 lot 2583 $96.56 ($19.39/lb) · 3/4" 8620 Alro quote 118127231 $38.06/bar ($2.11/lb) · 1" 6061-T6 still the $3.50/lb placeholder.

**Outsourcing / vendor rate cards:** Braddock heat treat ~$1,400 age + $65 cert + $20 handling + ~15% fuel (validated, D-COST-13) · Electrolab chem film ~$0.23/pc + $112.05 lot min + $25 cert + $22.50 env · Silverman-Gorf black oxide $0.2506/pc production rate, $607 flat lot minimum (crossover ~2,420 pc; solved from 6 invoices) · Wrico stamping (DFARS) SK4FW2S $0.857 @1–2k / $0.517 @2.5k / $0.419 @5k + $3,600 die · Maxtrust (China) SK4FW2S $0.21 FOB; SK21077-5 landed $3.88; Xiamen $3.03.

**Sell prices:** from the Pricing Portal (`price_items`, Rev 82 — Oct 2026 active from 10/1, Rev 81 superseded). Rule multipliers A: q100 .96 · q300 .90 · q500 .83 · T1 .64 · T2 .62 · T3 .60; B: .97 / .90 / .84 / .65 / .64 / .63. Customer tiers in `customer_pricing` (Beta Technologies tier2 since 9/29; Pinair special $12.29 is a price exception). The June pricing-guide figures below are Rev 81 history.

**Costed products (workbook tab · headline · cycle status):** QL8C62 Product · $10.75/unit (3-min assembly; $17.00 at 12 min) · cycles ESTIMATE · SK21077-5 Product · $4.33 landed make vs $3.88 buy · ESTIMATE · Exum Sleeve+Insert · $2.19 + $1.35 = $3.54, quoted $4.87/$3.00 at 55% (now book rows AC58/AC45) · ESTIMATE · SK203C22 Product · $5.22, 57.5% at Pinair $12.29 · MEASURED (barrel NT3/NT7, insert send-derived 4.26 min) · SK2003-10C1 Product · $0.518 internal component, 42.6k/yr · ESTIMATE 750/day · SK4002-SFW Product · $4.97 DFARS wing / $3.25 China wing, avg list $25.53 · stud COMPARABLE 5.22 min, cup MEASURED 2.44 min · SK220-15S Product · $1.03 recp + $0.67 nut = $1.70, Beta Tier 2 $6.22 · ESTIMATE 3:15 / 2:00.

**Fork workbooks not merged into the main line:** FA6-1/2-45-ACP (15 Jul 2026, "v0.9.9 → v0.9.10" of its day; $1.38/pc internal at 1,000 on NT7, 7-min estimate; 8620 bar $38.06) and SK35C38B1 (7 Aug 2026, "v0.9.9 → v1.0.3"; $1.300/unit at 0:45 assembly, black-oxide rate card) each advanced the version number on a copy of the workbook; the main line later reused v0.9.9/v0.9.10 for SK2003-10C1 and SK4002-SFW. Their Product tabs (and the Outsourcing Rates rows for Silverman-Gorf and Alro 8620) need porting into v0.9.12 so one workbook carries all ten products.

---

## Reference data captured in the first chat (June 2026 snapshot — kept for the record)

**Labor (ADP Master Control, period ending 6/14/2026), base $/hr → loaded (×1.30):**
Patrick Recor 45.00→58.50 (Mazak 3-6, NT7, Mazak7, NT1 — 7); Jeff Branch 32.50→42.25 (Ganesh, BM1-6, NT2-6 — 12); Carlos Osorio 39.00 salary→50.70 (Mazak 1-2); Scott Weber 27.50→35.75 (floater); **David Phillips 41.60→54.08 (role resolved: R&D CAD, indirect — D-COST-22)**; Harry Swinnes 34.32→44.62 (machine maintenance); James Yates 21.50→27.95 (finishing); Jody Perine 26.65→34.65 (assembly, not yet active).

**Facility:** Leesburg 30,000 sqft, City of Leesburg airport rent $695/mo → $8,340/yr, machining floor **$0.28/sqft/yr**, alloc 65/15/20 (machining/assembly/G&A). Tavares 7,500 sqft, Koenke Trust $5,072.56 + $2,000 CAM = $7,073/mo → $84,876/yr, machining floor **$11.32/sqft/yr**, alloc 25/5/70. ⚠ If Skybolt owns the Leesburg building on leased airport land, add building depreciation.

**Electric:** Leesburg May'26 — 61,620 kWh, $7,133/mo, blended **$0.116/kWh** all-in (energy $0.048). Tavares electric = NEEDED.

**Insurance:** liability only ~$14.3k/yr in hand; property/WC/auto/umbrella + the WC rate = NEEDED.

**Bar stock pricing (full inventory dump, received ~6/11/26):**
A286 0.375″ **lot 2583 (Tri Star) = $96.5622/bar, $19.39/lb, 144″** — the exact lot behind the QL8-CS demo. (Other A286 .375″: lot 2446 $95.50, lot 2604 $93.375.) 303 SS 0.625″: lot 2618 $64.2686/bar ($5.13/lb), lot 2622 $54.3307 ($4.31/lb), lot 2591 $44.3928 ($3.49/lb). **A286 ≈ 10× 303 SS by weight.**

**Machine acquisition cost (Equipment Loans tab, US Bank amount-financed, balances 4/30/26):**
BM3 $115,325; BM4 $122,974; BM5 $173,350; NT5 $111,895; NT6 $131,400; NT7 $234,909; Maz5 $71,100; Maz7 $273,267. Total **$1,234,220**, payment ~$24,381/mo. Depreciated over 15 yr. The other ~13 machines are paid-off/owned or under the undetailed US Bank "Next 4" — acq cost NEEDED (or $0 if fully depreciated).

**Purchased components (QL8C62), per piece:** QL8-UC $0.33; QL8-LC $0.33; QL8-SPG1 $0.17 (Murphy & Read Inv 25089, invoiced as SK1810SPG1); QL8-SPG2 $0.17 (Murphy & Read Inv 24999, invoiced as SK1810-SPG2); QL8C62-7 KEE **$0.26 ×4 = $1.04** (corrected from $0.61). **Purchased subtotal = $2.04/assembly.**

**QL8-CS actuals (lot 2583-042726, 1,072 pc):** heat treat $1,707.75 (Braddock Inv 147557) → $1.593/pc; passivation dry stage 5.0 min (974 batch) + 3.7 min (98 batch), chem lots 51490 / 51489. No machining job, material draw, or outsourcing send is in SkyNet for this lot (predate capture) → reconstructed from invoice + drawing.

**Sell prices (June 2026 pricing guide = Rev 81):** QL8C62 $42.0875 list / $20.20 Tier 3; SK203C22 $23.0472 / $14.0588; SK2003-42A $72.25 / $31.79; SK21077-5 not in the guide. Rev 82 (Oct 1) = Rev 81 × 1.15 on catalog Each.

**Month-end financials (`Skybolt_Month-End_Report_P1_1.xlsx`, April-2026 anchor):** revenue $607k, COGS $215k (incl. reclassed shop+warehouse labor), opex $271k, operating income $120k (19.8%), net $99k; cash $670k; total debt $1.43M; backlog $3.18M. The P&L + Equipment-Loans + COGS structure fed the **G&A pool** (D-COST-15–20).

---

## SkyNet schema findings (relevant to costing) — updated

- `parts.unit_cost numeric DEFAULT 0` — still unloaded for most parts (purchased prices live in invoices / the workbook; `fb_part_costs` now mirrors Fishbowl's latest PO cost per part nightly — D-PRICE-4x — and is the Phase-1 load source for purchased parts).
- `assembly_bom` — populated for the costed assemblies. **Open BUG:** QL8C62 KEE quantity 1 vs 4 on the drawing (unchanged). SK4002-SFW -20 BOM carries pin SK400CGP-01 vs drawing SK4000CGP81, ring 5103-018H vs 97414A620.
- `part_machine_durations` — still not the cycle source. Cycle times now come from jobs actuals through `v_part_run_rates` (calendar rate on the effectiveTimePerUnit basis, steady rate on the D-COST-31 waypoint basis, paper-era rows flagged) and `v_length_family_machine_history` — the Phase-1 harvest should read these views, not the durations table.
- `outbound_sends` — still **no cost field** → Phase-1 build (vendor rate cards live in the Outsourcing Rates tab meanwhile).
- `customer_order_lines` — still no unit_price in SkyNet, but the Pricing Portal (`price_books` / `price_items` / `price_rules` / `price_exceptions` / `pricing_get_price`) is now the sell-price source of record and Fishbowl's list price is pushed from it (D-PRICE-53). Phase-1 margin reporting can join orders to `pricing_get_price` by part and customer.
- `material_receiving` / `material_availability` — the bar-pricing source (price_per_bar, price_per_lb, bar_length_inches, weight_lbs, lot). Weighted-average-by-bars across the lots on hand is the convention since D-COST-36/38 (lot 2592) and SK220-15S.
- `jobs` — `production_start`, `actual_end`, `good_pieces`, `qty_override`, `finishing_start/end`; non-kiosk machines never stamp `production_start` on manual pickup (NT6, J-000027) → the send-waypoint method (D-COST-31).

---

## Open items / critical path

**Model-wide:**
1. **Burden pools are floors** — floor space, coolant, tooling, maintenance still $0 on every machine; acquisition cost on 13 of 21 machines; Tavares electric; full insurance + WC rate. The single largest understatement in every headline.
2. **Assembly time studies** — QL8C62 (12 vs 3 min), SK203C22 (6 min), SK35C38B1 (0:45), SK4002-SFW (2 min). Jody not yet active; the crew-average rate is standing in.
3. **Cycle harvests** owed: SK4SFW(x) (when J-000169 completes), SK2003-10C1, SK220-15S / -(x)SN (first kiosk runs), QL8-CS / QL8C62-1, FA6.
4. **Merge the fork workbooks** (FA6, SK35C38B1) into v0.9.12; carry their Outsourcing Rates and Cycle Times rows.
5. **Spec v0.5 → v0.6**: fold D-COST-32 … 43 and the collision renumbering into §9; the project copy is v0.4.
6. **Phase 1 (costing into SkyNet):** cost on `outbound_sends`; `parts.unit_cost` load from `fb_part_costs`; per-part standard cost record (material / machine / finishing / overhead) keyed to this log's decisions; margin view = `pricing_get_price` vs standard cost.

**Per part (newest first):** SK220-15S — basis call (lights-out vs attended), nut Each, order qty, Ø.625 flange on 5/8" bar, Fishbowl products + SkyNet parts rows to create before the push · SK4002-SFW — wing post-processing placed (in-house), ring price corrected to $0.075, die amortization horizon · SK2003-10C1 — 6061 bar $/lb from a PO · SK203C22 — second clip price, cage p/n mapping, §122 appeal · SK21077-5 — Xiamen qualification, inbound freight · QL8C62 — KEE qty in assembly_bom, purchased unit_cost load.

---

## Part-number / mapping notes

- **QL8-S = QL8-CS** (same stud; QL8-S/4140 and QL8-CS/A286 are two finishes on one drawing — Skybolt makes the A286 QL8-CS).
- **QL8C62's barrel is QL8C62-1**, not QL8C78-1 (the latter belongs to the separate QL8C78 assembly).
- Skybolt **makes** only the stud (QL8-CS) and barrel (QL8C62-1); the cams, springs, and KEE are **purchased**.
- **SK203C22:** cage invoice p/n SK21R17-2 ↔ SK203C-CAGE (confirm); clip, cap, cage are BUY (D-COST-28).
- **SK4002-SFW:** wing SK4FW2S = Wrico SK4FW2SE Rev A = Maxtrust SK4CWING3 Rev E (assumed same part); cups SK4C(x)C, Nexturn 2/4/6.
- **Exum:** Sleeve = AC58, Insert = AC45 (Fishbowl 12889 / 12890), book section Customer-Specific Machined Parts.
- **SK220-15S:** drawing titles "SK220-15S Recp" (receptacle, 15/32-32 UNS-2A) and "SK220-15S Barrel" (the backing nut, SK220-15S-1SN … -8SN by L); the 10/1 upload file names were swapped against the title blocks.
