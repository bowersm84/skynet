# SkyNet Costing Model — Decisions Log

**Workstream:** Manufacturing cost model (input costs → margins) for SkyNet MES / Skybolt Aeromotive
**Phase:** 0 — external Excel model (proof + data collection) before building costing into SkyNet
**Companion deliverable:** `SkyNet_Costing_Model_v0.4.xlsx` (10 tabs)
**Spec:** `SkyNet_Costing_Specification_v0_1.docx`
**Status as of close:** QL8C62 worked end-to-end as the template; cost = **$4.63/unit FLOOR** (material + heat-treat + purchased in; machine run-time + assembly labor still $0).

---

## Methodology decisions (locked)

- **D-COST-01 — Burden granularity: by individual machine, not class.** Size/tooling differ even within the Mazak class, so each machine carries its own $/hr.
- **D-COST-02 — Operator labor / attendance: machines-per-operator.** `requires_attendance` is not captured (all jobs log as unattended). v1 spreads each operator's loaded annual cost across the machines they tend; single 8-hr shift, ~250 work days/yr. This allocation **is** the attendance factor. Operator labor is folded **into** the machine burden $/hr — so the Cost Model uses one rate for machine time and adds only finishing labor separately.
- **D-COST-03 — Plant / G&A: single % of conversion cost for v1.** Default 15%. Refine to a rate in a later phase.
- **D-COST-04 — TCO destructive-test scrap: EXCLUDED.** Low volumes, parts preserved for sale. (Reverses the initial recommendation, per Matt's call.)
- **D-COST-05 — Three non-overlapping tiers.** Machine Burden ($/machine-hr) · Direct Labor ($/labor-hr) · Plant G&A (% of conversion). Every cost maps to exactly one tier; nothing double-counts.
- **D-COST-06 — Setup capture is unreliable.** Machinists click through the setup step, so captured setup understates reality; estimates use **standard setup minutes**.
- **D-COST-07 — Labor burden multiplier = 1.30 (tunable).** FICA 7.65% + FUTA/SUI ~1% + WC ~3% + ADP admin, divided by ~0.90 productive hours. Tune once the WC rate is confirmed.
- **D-COST-08 — Facilities costed separately (Leesburg vs Tavares).** Machining-floor occupancy is **$0.28/sqft/yr at Leesburg vs $11.32/sqft/yr at Tavares** — a ~40× asymmetry that makes a blended facility rate meaningless.
- **D-COST-09 — Machine depreciation = amount-financed ÷ 15-yr life.** Economic life (the fleet runs 2008→present), not MACRS. Amount-financed (US Bank Equipment Loans) is the acquisition-cost proxy. Paid-off/owned machines may carry $0 depreciation in v1.
- **D-COST-10 — Material cost includes scrap material.** Bars needed = (order qty ÷ yield) ÷ pieces-per-bar, rounded up; the scrapped pieces' bar is a real cost. Pieces-per-bar = `FLOOR(usable bar ÷ (cutoff + kerf))`, where usable bar is net of the collet-grip remnant.
- **D-COST-11 — Phasing.** Phase 0 = external Excel model (now). Phase 1 = build costing into SkyNet (add cost fields, load prices). Phase 2 = assembly costing once `FEATURES.ASSEMBLY_MODULE` is on.
- **D-COST-12 — Costing unit = the ASSEMBLY.** Per Matt's pivot mid-chat: stop costing individual pieces in isolation; roll machined components + purchased components + assembly labor into one product number per assembly. The machined-component build-ups feed the assembly headline.
- **D-COST-13 — Heat-treat estimate via vendor rate card.** Braddock card (~$1,400 age + $65 cert + $20 handling + ~15% fuel surcharge) **reproduces the QL8-CS actual to the penny** ($1,707.75 / 1,072 = $1.593/pc), so it is validated as the estimating basis.
- **D-COST-14 — Two paths to the machine-burden rate.** Bottom-up (per-machine pool: depreciation + floor + power + coolant + tooling + maintenance + operator labor ÷ productive hrs) **or** top-down (total manufacturing overhead from QuickBooks ÷ annual machine-hours). For the leadership demo, top-down is the fast, defensible v1; bottom-up is the refinement.

---

## Cost build-up (the model)

Per part (estimate): **Material** (bars × $/bar) + **Machine conversion** (machine-hrs × burden $/hr, operator already inside the rate) + **Internal finishing** (finishing-min × loaded finishing rate) + **Outsourcing** ($/lot from matched ops) = **Factory cost**. Then **Plant G&A** = G&A% × conversion cost (machine + finishing). **Fully-burdened cost** = factory + G&A. Per piece = ÷ good pieces.

Per assembly (the product number): Σ machined component cost/pc (qty per BOM) + Σ purchased component cost/pc (qty per BOM) + assembly labor ($/unit) = **total assembly cost**; vs sell price → **margin**.

---

## Reference data captured this chat

**Labor (ADP Master Control, period ending 6/14/2026), base $/hr → loaded (×1.30):**
Patrick Recor 45.00→58.50 (Mazak 3-6, NT7, Mazak7, NT1 — 7); Jeff Branch 32.50→42.25 (Ganesh, BM1-6, NT2-6 — 12); Carlos Osorio 39.00 salary→50.70 (Mazak 1-2); Scott Weber 27.50→35.75 (floater); **David Phillips 41.60→54.08 (role UNCONFIRMED)**; Harry Swinnes 34.32→44.62 (machine maintenance); James Yates 21.50→27.95 (finishing); Jody Perine 26.65→34.65 (assembly, not yet active).

**Facility:** Leesburg 30,000 sqft, City of Leesburg airport rent $695/mo → $8,340/yr, machining floor **$0.28/sqft/yr**, alloc 65/15/20 (machining/assembly/G&A). Tavares 7,500 sqft, Koenke Trust $5,072.56 + $2,000 CAM = $7,073/mo → $84,876/yr, machining floor **$11.32/sqft/yr**, alloc 25/5/70. ⚠ If Skybolt owns the Leesburg building on leased airport land, add building depreciation.

**Electric:** Leesburg May'26 — 61,620 kWh, $7,133/mo, blended **$0.116/kWh** all-in (energy $0.048). Tavares electric = NEEDED.

**Insurance:** liability only ~$14.3k/yr in hand; property/WC/auto/umbrella + the WC rate = NEEDED.

**Outsourcing rates:** Braddock (heat treat) ~$1,400 age + $65 cert + $20 handling + ~15% fuel surcharge per lot. Electrolab (chem film) ~$0.23/pc + $25 cert + $112.05 lot min + $22.50 env. 50+ Electrolab and 8 Braddock invoices available to build per-part averages.

**Bar stock pricing (full inventory dump, received ~6/11/26):**
A286 0.375″ **lot 2583 (Tri Star) = $96.5622/bar, $19.39/lb, 144″** — the exact lot behind the QL8-CS demo. (Other A286 .375″: lot 2446 $95.50, lot 2604 $93.375.) 303 SS 0.625″: lot 2618 $64.2686/bar ($5.13/lb), lot 2622 $54.3307 ($4.31/lb), lot 2591 $44.3928 ($3.49/lb). **A286 ≈ 10× 303 SS by weight.**

**Machine acquisition cost (Equipment Loans tab, US Bank amount-financed, balances 4/30/26):**
BM3 $115,325; BM4 $122,974; BM5 $173,350; NT5 $111,895; NT6 $131,400; NT7 $234,909; Maz5 $71,100; Maz7 $273,267. Total **$1,234,220**, payment ~$24,381/mo. Depreciated over 15 yr. The other ~13 machines are paid-off/owned or under the undetailed US Bank "Next 4" — acq cost NEEDED (or $0 if fully depreciated).

**Purchased components (QL8C62), per piece:** QL8-UC $0.33; QL8-LC $0.33; QL8-SPG1 $0.17 (Murphy & Read Inv 25089, invoiced as SK1810SPG1); QL8-SPG2 $0.17 (Murphy & Read Inv 24999, invoiced as SK1810-SPG2); QL8C62-7 KEE **$0.26 ×4 = $1.04** (corrected from $0.61). **Purchased subtotal = $2.04/assembly.** (SK1810 spring part numbers match the QL8 spring geometry — treated as the same parts.)

**QL8-CS actuals (lot 2583-042726, 1,072 pc):** heat treat $1,707.75 (Braddock Inv 147557) → $1.593/pc; passivation dry stage 5.0 min (974 batch) + 3.7 min (98 batch), chem lots 51490 / 51489. No machining job, material draw, or outsourcing send is in SkyNet for this lot (predate capture) → reconstructed from invoice + drawing.

**Sell prices (June 2026 pricing guide):** QL8C62 $42.0875 list / $20.20 volume-10k; SK203C22 $23.0472 / $14.0588; SK2003-42A $72.25 / $31.79; **SK21077-5 not in the guide**.

**Month-end financials (`Skybolt_Month-End_Report_P1_1.xlsx`, April-2026 anchor):** revenue $607k, COGS $215k (incl. reclassed shop+warehouse labor), opex $271k, operating income $120k (19.8%), net $99k; cash $670k; total debt $1.43M; backlog $3.18M. The P&L + Equipment-Loans + COGS structure feed the **G&A pool** and a **top-down machine-burden rate**.

---

## SkyNet schema findings (relevant to costing)

- `parts.unit_cost numeric DEFAULT 0` — all seven QL8C62 components currently **$0** (purchased prices live only in invoices, not loaded).
- `assembly_bom` (assembly_id, component_id, quantity, sort_order) — **QL8C62 BOM is populated** (7 components), so the structure is ready for in-DB rollup. **BUG: the KEE (`QL8C62-KEE`) shows quantity 1; the drawing (`QL8C62-7`) calls for 4** → $0.78/assembly understatement if modeled as 4 individual keys.
- `part_machine_durations` (estimated_minutes, base_quantity) — **EMPTY for QL8-CS / QL8C62-1** → no standard cycle times exist. This is the #1 blocker for machine conversion cost.
- `outbound_sends` — has quantity/vendor/op_type but **no cost field** → Phase-1 build (the Braddock send for QL8-CS isn't even logged).
- `customer_order_lines` — **no unit_price** → Phase-1 build for sell-side in SkyNet.
- `material_receiving` — has `price_per_bar`, `price_per_lb`, `bar_length_inches`, `weight_lbs`, lot, material_id → the bar-pricing source (used for the queries).
- `materials` — `bar_size_inches`, `density_lbs_per_cubic_inch`, vendor, material_type_id.

---

## Open items / critical path (for the next chat)

**To finish QL8C62 (in priority order):**
1. **Cycle time** — setup + run/piece for the stud and barrel. `part_machine_durations` empty → stopwatch the next run of each, or enter `estimated_minutes`. THE blocker.
2. **Rest of the machine-burden pool** — footprint, connected HP, coolant, tooling, maintenance per machine — OR adopt the top-down blended rate from the month-end financials (faster for the demo).
3. **Assembly labor time** (min/unit) — quick time study with Jody.

**SkyNet data fixes (optional, external model already correct):**
4. Load purchased `unit_cost` into `parts` (UC/LC $0.33, SPG1/SPG2 $0.17, KEE $0.26). 5. Fix KEE quantity 1 → 4 in `assembly_bom` (or confirm it's a pre-kitted set). Deliver as preview-SELECT → TEST → PROD, wrapped BEGIN/COMMIT.

**Still-needed global inputs:** Tavares electric; full insurance + the WC rate; the parts-per-bar calculator file ("machines tab"); acq cost for the other ~13 machines; confirm the barrel's bar size; confirm the Dept-200 operator-pool role and where David Phillips fits.

**Roadmap:** replicate the QL8C62 template for the other four demo parts (QL8C78-1, SK21077-5-3, SK203C22B, SK213C-CAGE, SK244-42) once each drawing + a material receipt are in hand. Then Phase-1 schema changes (cost fields on `outbound_sends`, `customer_order_lines`; load `parts.unit_cost`).

**Recommended first move next chat:** build the **top-down machine-burden rate** from the month-end report and drop in **estimated cycle times** so QL8C62 reads as a *finished* number for leadership, then refine with the time study and per-machine pool.

---

## Part-number / mapping notes

- **QL8-S = QL8-CS** (same stud; QL8-S/4140 and QL8-CS/A286 are two finishes on one drawing — Skybolt makes the A286 QL8-CS).
- **QL8C62's barrel is QL8C62-1**, not QL8C78-1 (the latter belongs to the separate QL8C78 assembly).
- Skybolt **makes** only the stud (QL8-CS) and barrel (QL8C62-1); the cams, springs, and KEE are **purchased**.
