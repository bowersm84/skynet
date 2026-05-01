# SkyNet Sprint 5 — Implementation Plan (CLOSED)
## Customer Orders & Demand Pool
### Started May 1, 2026 · Closed May 1, 2026 · Status: ✅ COMPLETE on TEST

---

## Sprint Goal
Introduce a Customer Order layer above Work Orders so April can capture demand
from Fishbowl, accumulate it as a pool, and roll multiple customer orders into
a single Work Order at scheduling time. Establish a customer master and rename
WO Lookup to Order Lookup. WO/Job relationship unchanged — change is upstream
of compliance, production, and finishing.

**Sprint completed end-to-end on TEST in a single day.** Pending April
sign-off Monday before promotion to PROD.

---

## Final Scope (as shipped)

| # | Decision | Outcome |
|---|----------|---------|
| 1 | Parent-child CO model | ✅ `customer_orders` (header) + `customer_order_lines` (per part) |
| 2 | Partial allocation | ✅ `customer_order_allocations` junction enables one line → many WOs |
| 3 | Customers as FK | ✅ New `customers` table, replaces free-text customer on WO |
| 4 | Status simplified | ✅ `not_started` / `in_progress` / `complete` / `cancelled` |
| 5 | Status maintenance | ✅ Trigger-driven, denormalized on row |
| 6 | CO number format | ✅ `CO-<customer_id>-<order_id>`, alphanumeric stripped/uppercased |
| 7 | Cancellation v1 | ✅ Flag + amber banner + Acknowledge button |
| 8 | Order Lookup rename | ✅ WO Lookup → Order Lookup with WO / CO sub-tabs |
| 9 | Customers tab in Armory | ✅ Flat list, inline edit, CSV paste import |
| 10 | Fulfillment v1 | ✅ Line marked complete in one shot |
| 11 | **Demand-driven WO creation (added mid-sprint)** | ✅ New Demand tab on CO module |
| 12 | **CO/PO/Order-Type stripped from Create WO modal (added mid-sprint)** | ✅ Now derived from linked COs |
| 13 | **Allocation drill-down with deep-link (added mid-sprint)** | ✅ Click part # → expand → click WO → jump to WO Lookup |

---

## Action Items — All Closed

| # | Action Item | Batch | Status |
|---|-------------|-------|--------|
| 1 | Schema migration: customers, COs, lines, allocations | A | ✅ |
| 2 | RLS policies for new tables (split by cmd) | A | ✅ |
| 3 | Status rollup triggers (line + parent) | A | ✅ |
| 4 | Customers tab in Armory (list/add/edit/CSV import) | A | ✅ |
| 5 | Customer Orders module — Orders list with master-detail | B | ✅ |
| 6 | Create CO modal (header + line items + Fishbowl ref) | B | ✅ |
| 7 | Cancel CO / cancel line actions | B | ✅ |
| 8 | Mark line complete action | B | ✅ |
| 9 | Order Lookup rename + WO/CO tabs | C | ✅ |
| 10 | Search across both tabs | C | ✅ |
| 11 | CreateWorkOrderModal: pending CO lines surface for selected part | C | ✅ |
| 12 | Allocation write on WO save | C | ✅ |
| 13 | WO has-cancelled-allocation banner (Mainframe + Schedule) | C | ✅ |
| 14 | `customerOrders.js` lib (formatCONumber, getOpenCOLinesForPart, getAllOpenCOLines, getAllocationsForLine, getCOLineQuantities) | A/B/C | ✅ |
| 15 | Job Traveler: Customer Orders Fulfilled section | C | ✅ |
| 16 | **Demand tab — aggregated by part with multi-CO selection** | C-rev | ✅ |
| 17 | **Strip customer/PO/order_type fields from Create WO modal** | C-rev | ✅ |
| 18 | **Pre-select prop pipeline (Demand → Create WO modal)** | C-rev | ✅ |
| 19 | **Hide New CO button when embedded or on Demand tab** | C-rev | ✅ |
| 20 | **Part # drill-down → allocation panel → WO deep-link** | C-rev | ✅ |
| 21 | Trim CO line sub-table columns to fit modal width | C-rev | ✅ |

---

## Migration File

`Docs/migrations/2026-05-01_sprint5_customer_orders.sql` — applied to TEST
on May 1, 2026. **Not yet applied to PROD** (pending April sign-off).

Schema additions:
- 4 new tables: `customers`, `customer_orders`, `customer_order_lines`,
  `customer_order_allocations`
- 2 new columns on `work_orders`: `is_combined`, `has_cancelled_allocation`
- 4 new functions: `recalc_co_line_status`, `recalc_co_status`,
  `trg_alloc_recalc`, `trg_line_recalc_parent`
- 4 new triggers: `trg_alloc_aiud`, `trg_line_au`, `trg_customers_uat`,
  `trg_co_uat`, `trg_co_lines_uat`
- 16 RLS policies (4 tables × 4 cmd values)

Verification query result: **16 cmd policies confirmed on 4 tables.**

---

## File Inventory

**New files:**
- `src/lib/customerOrders.js`
- `src/components/CreateCustomerOrderModal.jsx`
- `src/pages/CustomerOrders.jsx`
- `src/pages/CustomersTab.jsx`
- `Docs/migrations/2026-05-01_sprint5_customer_orders.sql`

**Modified files:**
- `src/App.jsx` — added route + canAccessCustomerOrders gate
- `src/pages/Armory.jsx` — Customers tab wiring + role updates
- `src/pages/Mainframe.jsx` — Order Lookup rename, tabs, banner, deep-link bridge
- `src/pages/Schedule.jsx` — amber-ring outline for has_cancelled_allocation jobs
- `src/components/CreateWorkOrderModal.jsx` — pending CO lines surface, pre-select pipeline, customer/PO/order_type stripped & derived
- `src/lib/traveler.js` — Customer Orders Fulfilled section

---

## Sprint Highlights & Pivots

**Pivot 1 (mid-sprint): Demand-driven WO creation.**
Initial Batch C built the part-first flow — pick part, see open COs for that
part. Matt review surfaced that this forced April to know what part to run
before seeing demand, which inverts the natural workflow. Built a new Demand
tab on the CO module: lines grouped by part, sorted by total open demand,
multi-select within a part group, "Create Work Order from Selection"
button feeds pre-selected lines into Create WO modal. Original part-first
flow retained as a secondary path for stock-build-with-some-demand-mixed-in.

**Pivot 2 (mid-sprint): Strip Customer/PO/Order Type from Create WO.**
With CO linkage now the source of truth, manually entering customer / PO
on a WO conflicts with the derived data. Removed the fields and the
MTO/MTS toggle entirely. Values now derive from linked COs:
- 0 COs linked → `make_to_stock`, customer/po null
- 1 CO linked → `make_to_order`, customer/po denormalized from the CO
- 2+ COs linked → `make_to_order`, `is_combined = true`, customer/po null
  (UI displays "Multi-Customer")

**Pivot 3 (mid-sprint): Allocation drill-down with deep-link.**
April's review noted that seeing "Allocated: 450" on a CO line gave no path
to the actual WO. Added click-to-expand on part numbers in the CO line
table. Expanded panel shows all active allocations (WO #, status, due,
qty); clicking any row deep-links to Order Lookup → Work Orders tab with
the WO # pre-filled in search.

---

## Deferred to Sprint 6 (not blockers for go-live)

- **Cancellation decision UI** — 3-option flow (reduce qty / convert to stock /
  keep as-is). Currently just a banner + manual ack.
- **Per-shipment fulfillment tracking** — multiple ship events per line.
  Currently mark-complete is one-shot.
- **Fishbowl sync** — programmatic pull of customers + orders from Fishbowl.
  Currently April mirrors Fishbowl orders by hand into SkyNet.
- **Customer detail page in Armory** — history, contacts, ordering patterns.
- **Multi-WO timeline view per CO** — visualize how a CO's lines spread
  across WOs over time.

---

## Lessons Captured (see Decisions.md for detail)

1. **Two-tier demand model.** Conflating "what was ordered" with "what we're
   running" stops working the moment you want to combine orders. Splitting
   into Customer Orders + Work Orders + Allocations junction is the correct
   default; a flat model is only viable while N=1 customer per WO holds.
2. **Demand-driven UI beats part-first UI.** Schedulers think in terms of
   demand pool first, parts second. UI ordering matters.
3. **Derive over enter.** When a value can be computed from linked records,
   don't ask the user to enter it. Customer/PO on WO is the canonical case.
4. **Trigger-driven status rollup.** Status of a parent record (CO) computed
   from its lines, lines computed from allocations + fulfillment. Keep
   status derivation in PL/pgSQL triggers, not in app code, so every write
   path arrives at the same answer.
5. **RLS audit pattern continues to pay off.** Splitting policies by `cmd`
   (SELECT/INSERT/UPDATE/DELETE) makes the standing audit query catch
   missing policies. 16-row verification confirmed all four new tables.

---

## Build Timing (actual)

Original estimate: 8–12 days. Compressed to: **1 day (3-day target with
2-day reserve)**. Achieved through aggressive scope cutting (decision UI
deferred, per-shipment tracking deferred, customer detail page deferred)
and the surgical-prompt CC pattern.

---

## Closeout Checklist

- ✅ Schema applied to TEST
- ✅ All 21 action items shipped on TEST
- ✅ End-to-end test pass on TEST (smoke tests across all batches)
- ⏸ April walkthrough on TEST (scheduled Monday)
- ⏸ Spec bumped to v2.8
- ⏸ Decisions.md updated with Sprint 5 entries
- ⏸ Cheatsheet updated for new chats
- ⏸ Migration applied to PROD (after April sign-off)
- ⏸ Code merged to main (after PROD migration)
