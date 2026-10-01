# SkyNet MES — Sprint 12 Implementation Plan — CLOSED

**Sprint 12 — Order Queue: structured components, releases, line numbers, production dates, exceptions**

Implementation Plan v1.0 (opened Sep 30, 2026) · **Closed Sep 30, 2026** · Spec v4.8

**Owner:** Matt Bowers
**Outcome:** Batches A, A2, A3, the D-FB-46 cleanup and the replacement round (D-FB-48 / D-DATE-04 / D-FB-49) shipped to PROD on Sep 30; `main` == `test` at `bb060a3`. Batch B (Alert Roger) held. Batch C (Edit CO components) retired unmerged.

---

## 1. Goal (as opened)

Give the order processors and Customer Service what they need on the Order Queue without opening a work order: which components an order is waiting on, when production will have them done, a way to hand an unknown part to Roger, and a demand pool that shows a customer's release schedule instead of one lump (SO 19146 SK-OS, 20,630 pcs due 3/26/27).

## 2. What changed during the sprint

| When | Change | Why |
|---|---|---|
| Batch A review | CO line numbers must equal Fishbowl line numbers everywhere → **A3 / D-FB-45**, followed on every sync | Matt: "same all the way through SkyNet"; Fishbowl renumbers lines when one above is deleted (SO 15548) |
| After A3 | Split **every** combined line with no WO, not just SK-OS → **D-FB-46** (supersedes the hand-written SK-OS file on PROD) | Matt: "fix anything that does not have a WO at this point and forward" |
| Before Batch C ran | **Customer Orders set on a phase-out**; Batch C (Edit CO picker) retired; the Order Queue "edit components" button dropped on review | Matt: every order is driven by Fishbowl and the Order Queue; the component list is guidance, the WO's jobs are the truth |
| Replacement round | **D-FB-48 / D-DATE-04 / D-FB-49** — exceptions resolved in the queue, part change = exception, WO due dates follow Fishbowl, Customer Orders editing admin-only | Resolving exceptions still needed Customer Orders; 84 Fishbowl date changes never reached `work_orders.due_date` (35 of 101 open WOs stale) |

## 3. Decisions (final)

| ID | Decision |
|---|---|
| D-FB-42 / 42a | Components Needed picked from the BOM (≥ 1, validated server-side); Purchase on a BOM part names its components; review fixes (cache location, avail / needed tone, modal errors, failed reads shown) |
| D-FB-43 | One CO line per Fishbowl line (supersedes D-FB-26 / 27) |
| D-FB-44 / 44a | Prod Due column (last component off the machine; T = target; assembly / plating / finishing excluded); line dropdown; reads settle independently |
| D-FB-45 | CO line number = Fishbowl line number, kept in step by conversion and ingest |
| D-FB-46 | Combined lines with no WO split one per Fishbowl line; lines on WOs stay combined |
| D-FB-47 | Retired unmerged (Edit CO component picker) |
| D-FB-48 | Exceptions resolved on the Exceptions tab; product change is an exception; `co_cancel_line` the one cancel; dropdown shows pieces not on a WO |
| D-FB-49 | Customer Orders phased out — create / edit / cancel admin-only; removal after 2026-10-31 |
| D-CODATE-04 | Target = later of entered + 45 business days and a real Fishbowl due date |
| D-DATE-04 | `work_orders.due_date` follows its CO lines by trigger (SQL twin of `resyncWODueDates`) |

## 4. What shipped, in order

| Round | CC prompt | SQL (TEST by Claude, PROD by Matt) |
|---|---|---|
| A | `2026-09-30_D-FB-42_OrderQueue_UX_BatchA_CC_Prompt.md` (35 anchors) | `2026-09-30_D-FB-42_co_line_components_releases.sql`; TEST-only `2026-09-30_CO-6256-19146_SK-OS_release_split.sql` |
| A2 | `2026-09-30_D-FB-42a_OrderQueue_UX_BatchA2_CC_Prompt.md` (17) | — |
| A3 | `2026-09-30_D-FB-45_OrderQueue_UX_BatchA3_CC_Prompt.md` (5) | `2026-09-30_D-FB-45_co_line_numbers_follow_fishbowl.sql` |
| D-FB-46 | `2026-09-30_D-FB-46_Decisions_Append_CC_Prompt.md` (Decisions only) | `2026-09-30_D-FB-46_split_combined_lines_without_wo.sql` |
| Replacement | `2026-09-30_D-FB-48_Exceptions_WODue_PhaseOut_CC_Prompt.md` (22) | `2026-09-30_D-FB-48_exceptions_resolve_and_wo_due_follow.sql`; TEST-only `2026-09-30_TEST_ONLY_D-FB-48_seed_exceptions.sql` |
| ~~C~~ | ~~`2026-09-30_D-FB-47_EditCO_Components_BatchC_CC_Prompt.md`~~ retired | ~~`2026-09-30_D-FB-47_co_line_set_components_scheduler.sql`~~ TEST only, undone by D-FB-48 |

Every SQL file ran end to end in a scratch Postgres (real DDL, seeded scenario, dry-run / live / re-run / gate cases) before TEST. `fb_ingest_delta` was patched in place twice with md5 + anchor guards; current md5 `8794ae0ba1d23df9814465ad47991612` on TEST and PROD.

## 5. PROD outcome (read Sep 30, after the push)

- 147 CO lines linked to live Fishbowl lines; **0** off their Fishbowl number. Renumber: 49 COs, 84 lines followed, 5 hand-keyed lines moved, 0 failures.
- Splits (D-FB-46): CO-6256-19146 SK-OS 20,630 → #2 3,205 · #3 3,025 · #4 10,620 · #26 1,340 · #27 2,440; CO-687-19325 SK2600-3W 100 → 50 / 50. 4 combinations remain, all on WOs; 0 combined without a WO.
- Targets: 27 open lines moved later (D-CODATE-04).
- WO due dates: one-shot corrected **35** WOs; 0 stale after; 0 trigger failures.
- Components: 25 self-component rows backfilled; picker rows start with the next conversion.
- Exceptions: 0 open.

## 6. Held / deferred (spec §13.6)

- **Alert Roger (Batch B)** — part_requests, bell, Compliance worklist, KPI, auto-close on resolve, `notify-email` Edge Function on the SES v2 API. Needs an IAM key scoped to `ses:SendEmail`.
- Remove Create / Edit Customer Order after 2026-10-31 (D-FB-49); move Demand / Stock Requests / My Orders off the Customer Orders page.
- Create WO pre-selects job leaves from the CO line's components.
- The four combinations on WOs (CO-2311-19121 #1; CO-6256-19146 #9, #15, #17).
- Purchaser worklist for purchase component lists.
- Allocation-change trigger to complete D-DATE-04 in the database.

## 7. Documentation

Spec v4.8 (§5.37 new; notes in §5.24 / §5.27; §10.12; §11 rows; §12; §13.5 / §13.6) · Decisions.md D-FB-42 → D-FB-49, D-CODATE-04, D-DATE-04 and the Sprint 12 close-out entry · Cheatsheet v5.

**Sprint 12 is closed.**
