# SkyNet MES — Sprint 10 (Sales Dashboard)

**Implementation Plan v1.0 · May 27, 2026**

**Owner:** Matt Bowers
**Status:** Spec locked, awaiting branch creation.
**Branch:** `feature/sales-dashboard` (from `main`)

---

## 1. Sprint Goal

Build a Sales Dashboard at `/sales` that surfaces the same data Matt has been pulling weekly via the `v_sales_weekly_report_v3` SQL view, but as a live React surface in the SkyNet mainframe. Sits in the Dashboard family alongside President's Bridge (`/bridge`) and Production Dashboard (`/production`). Replaces the manual Supabase-export-to-Excel workflow for the weekly sales meeting.

Single-session sprint. ~2–3 hours of Claude Code work given the SQL views and HTML preview already exist.

---

## 2. Background

The weekly sales meeting reviews two things: current orders in SkyNet (production status + delivery dates) and demand (orders not yet scheduled). Matt iterated through several SQL view designs in May 2026, landing on `v_sales_weekly_report_v3` (CO-line grain, no job fan-out, bottleneck phase per CO line, summed good pieces with COMBINED-WO caveat). The view ships data for three sections per salesperson:

- A. Scorecard (one row per salesperson)
- B. Active Production (one row per CO line with WO/Job rollup)
- C. Open Demand (one row per CO line with un-allocated qty)

Matt validated the report output and built a polished sectioned Excel layout for handouts (CO & WO Report by Salesperson). He then built an interactive HTML dashboard as a design preview, which became the visual spec for this sprint. The HTML preview is included as a reference artifact (`SkyNet_Sales_Dashboard.html`); the React build should match its layout, KPI panel set, and color treatment.

The dashboard is read-only — no writes to any table. It consumes the three Postgres views as its API.

---

## 3. Where We Are at Sprint Open

### 3.1 SQL state (test + prod)

- `v_sales_wo_salesperson` — applied ✅
- `v_sales_job_effective_qty` — applied ✅
- `v_sales_active_production` — applied ✅ (with TCO exclusion patch — see §6.1)
- `v_sales_open_demand` — applied ✅
- `v_sales_summary_by_person` — applied ✅
- `v_sales_weekly_report_v3` — applied ✅
- `sales_weekly_report.sql` lives in `Docs/migrations/` for reference

### 3.2 Reference artifacts

- `SkyNet_Sales_Dashboard.html` — self-contained HTML dashboard preview with embedded test data; visual spec for the React build. Includes the CSV upload + Print logic the React version must preserve.
- `Supabase_Snippet_Claud_Commands__5_.csv` — Matt's polished export, the layout the CSV upload feature must parse.

### 3.3 Excluded from the report

- Jobs in `complete`, `cancelled`, `incomplete`, `pending_tco` (TCO closes the job from a sales standpoint — Matt removed these manually from his last report; we wire it into the SQL view rather than the React layer).
- WOs in `cancelled`, `closed`, `shipped`.
- MTS WOs group under a synthetic salesperson "Make to Stock (MTS)"; COs with `salesperson_id IS NULL` group under "Unassigned — needs owner". Both per the existing `v_sales_weekly_report_v3` output.

---

## 4. Sprint Scope

### 4.1 In scope

- One SQL view tweak: add `pending_tco` to the excluded statuses in `v_sales_active_production` (matches Matt's manual report).
- New helper module: `src/lib/salesMetrics.js` — KPI computations from view rows (mirrors `machineStatus.js` pattern: pure functions, single source of truth).
- New helper export: `canViewSalesDashboard(profile)` in `src/lib/roles.js` — one place to change access if it ever shifts.
- New page component: `src/pages/SalesDashboard.jsx` — five-panel layout matching the HTML preview, scope filter, 60s poll, CSV upload, Print, Export CSV.
- Routing: `/sales` route in `App.jsx`. Dashboard dropdown entry in nav.
- Tab visibility: salesperson role flag, CS, Admin, President, Viewer can see it.
- Spec bump to v3.4 documenting §5.15 Sales Dashboard.
- Decisions.md entry: D-MAY27-01 (access model) and D-MAY27-02 (views-as-API architectural choice).

### 4.2 Out of scope

- No new tables, no schema changes (intentional — purely consumes existing views).
- No drill-down modals; rows link to existing WO Lookup / CO Lookup surfaces.
- No PDF export library (browser Print → Save as PDF handles it).
- No editable fields anywhere.
- No multi-product WO special handling — the underlying view already handles this; dashboard surfaces whatever the view emits.
- No mobile / responsive layout pass — desktop-first; mobile is a future polish.

### 4.3 Deferred (post-S10 backlog)

- Per-salesperson drill-down view (a focused page for one salesperson's book — could replace today's printable handout entirely).
- Trend lines (e.g., "past-due count week-over-week") — needs a snapshot table to be useful; not worth building until we've used the dashboard for a quarter.
- Real-time push (vs 60s poll) — only justified if the dashboard becomes always-on display in the sales area.
- Materialized refresh of the views — only justified if poll latency becomes visible at >500 production rows.

---

## 5. Decisions Locked

| ID | Topic | Decision |
|---|---|---|
| D-MAY27-01 | Access | Salespeople (`is_salesperson=true`) + CS + Admin + President + Viewer. Compliance does NOT see the tab. Tab gate via new `canViewSalesDashboard(profile)` helper in `src/lib/roles.js`. |
| D-MAY27-02 | Architecture | Views-as-API. The React page reads `v_sales_weekly_report_v3` and `v_sales_summary_by_person`; it does NOT issue raw queries against `jobs` / `customer_orders` / etc. Every business rule (combined-WO rollup, bottleneck phase, TCO exclusion, MTS bucketing) lives in SQL. UI fixes that affect numbers happen in the view, propagating to every consumer. |
| D-MAY27-03 | Default scope (salesperson) | "All sales." Toggle to "Just mine" available. Sticky per-user in `localStorage` (`skynet.sales_dashboard.scope`). |
| D-MAY27-04 | Default scope (CS/Admin/President/Viewer) | "All sales" with a "Filter by salesperson" dropdown. Sticky. |
| D-MAY27-05 | Refresh interval | 60-second poll, matching Bridge and Production Dashboard. Same `useEffect` + cleanup pattern. |
| D-MAY27-06 | Visual style | Clean utilitarian (light surface, SkyNet blue accent), NOT Bridge-style cinema-dark. Matches `SkyNet_Sales_Dashboard.html` preview. Read-only role conventions apply: no action buttons rendered for president/viewer beyond the universal scope dropdown + Print + Export + Load CSV. |
| D-MAY27-07 | KPI panels | Six tiles: Active WOs, Past Due (production), Stalled, Demand Lines, Demand Qty, Unassigned. Past Due → red border. Stalled and Unassigned → amber border when count > 0. Counts respect the scope filter EXCEPT the Unassigned tile, which always shows the org-wide count (leadership signal that shouldn't be hidden by a personal-view toggle). |
| D-MAY27-08 | Pipeline chart | Horizontal bar chart, Chart.js, phases ordered Waiting → Machining → Finishing/QC → Outsourced → Assembly → Pending TCO (Pending TCO won't appear since the view excludes it; ordering reserved for forward compatibility if business rules change). |
| D-MAY27-09 | Demand chart | Vertical bar chart, ordered Past Due → This Week → Next Week → 2-4 Wks → 4+ Wks → No Date. Bar height = sum of `qty_open_demand` in that bucket. |
| D-MAY27-10 | Workload table | Hidden when scope is "Just mine" (one row is uninteresting). Visible when scope is "All" or "Filter by [name]" (the latter shows one row but with the right context). Sorted: real salespeople alphabetically, then "Unassigned", then "MTS" last. |
| D-MAY27-11 | Past-due & at-risk table | Sorted by days late ascending (most overdue first). Production rows + Open Demand rows merged into one list. Deduplication by `(type, ref, part)` to handle the rare case of the same item surfacing both ways. Critical-priority rows badged. |
| D-MAY27-12 | Load CSV behavior | Accepts the polished sectioned export format (e.g. `Supabase_Snippet_Claud_Commands__5_.csv`). Parses ISO-8859-1 encoded files. When loaded, banner reads "Showing snapshot from `<filename>` · [Use live data]" — clicking "Use live data" reverts to the poll. Sticky during the session but cleared on page reload. |
| D-MAY27-13 | Print behavior | `@media print` block hides scope controls, Load CSV, Print, Export CSV. Page header collapses to title + "As of `<date>`". Borders darken from `--line` to `#ccc` for B&W printing. Two-column charts stay side-by-side. Tables don't break across pages mid-row (page-break-inside: avoid). |
| D-MAY27-14 | Export CSV behavior | Re-flattens the currently-visible data (respecting scope filter) into a flat CSV. Headers match the SQL view column names so the export is round-trippable through Load CSV. Filename: `skynet_sales_dashboard_<YYYYMMDD>.csv`. |

---

## 6. SQL Changes

### 6.1 Tweak `v_sales_active_production` to exclude `pending_tco`

```sql
CREATE OR REPLACE VIEW v_sales_active_production AS
-- ... (existing view body unchanged through the FROM/JOIN section) ...
WHERE j.status NOT IN ('complete','cancelled','incomplete','pending_tco')
  AND COALESCE(wo.status,'') NOT IN ('cancelled','closed','shipped')
  AND COALESCE(j.is_maintenance, false) = false;
```

One-line change: add `'pending_tco'` to the existing `NOT IN` list. No schema impact, idempotent. Apply on test, eyeball Query 0 output, apply on prod.

`v_sales_weekly_report_v3` and `v_sales_summary_by_person` both consume `v_sales_active_production`, so they pick up the exclusion automatically.

### 6.2 Verification queries

```sql
-- Before: how many pending_tco jobs are currently surfacing
SELECT j.job_number, j.status, wo.wo_number
FROM v_sales_active_production
WHERE production_phase = '6. Pending TCO';

-- After applying 6.1: should return zero rows
SELECT * FROM v_sales_active_production WHERE production_phase = '6. Pending TCO';

-- And: spot-check that other phases still flow
SELECT production_phase, COUNT(*) FROM v_sales_active_production GROUP BY 1;
```

---

## 7. React Implementation

### 7.1 New / Updated Files

| File | Action | Purpose |
|---|---|---|
| `src/lib/salesMetrics.js` | NEW | Pure functions for KPI computations (mirrors `machineStatus.js`). Exports: `computeKpis(rows, scope)`, `groupByPhase(rows)`, `groupByDueBucket(rows)`, `summarizeBySalesperson(rows)`, `selectAtRisk(rows)`. |
| `src/lib/roles.js` | Update | Add `canViewSalesDashboard(profile)` export. Returns true for admin, customer_service, president, viewer, or any role where `profile.is_salesperson === true`. |
| `src/pages/SalesDashboard.jsx` | NEW | Page component. ~400 lines. Five panels matching HTML preview. Scope dropdown in header. CSV upload + Print + Export controls. 60s poll via `useEffect` + cleanup. |
| `src/components/SalesScopeFilter.jsx` | NEW (small) | The scope dropdown component. Pulls the live salesperson list from `profiles` filtered to `is_salesperson=true` ordered by `full_name`. Sticky to localStorage. |
| `src/components/SalesPipelineChart.jsx` | NEW (small) | Horizontal Chart.js bar. Receives `phaseCounts` from `groupByPhase()`. |
| `src/components/SalesDemandChart.jsx` | NEW (small) | Vertical Chart.js bar. Receives `bucketQtys` from `groupByDueBucket()`. |
| `src/App.jsx` | Update | Add `/sales` route, gated by `canViewSalesDashboard`. |
| `src/components/Nav.jsx` (or equivalent dashboard dropdown component) | Update | Add "Sales" item between "President's Bridge" and "Production Dashboard". |

### 7.2 Component Architecture

```
SalesDashboard.jsx
├── Header
│   ├── Title + "As of <timestamp>"
│   └── Controls
│       ├── SalesScopeFilter ("All" | "Just mine" | specific person)
│       ├── Load CSV button (file input hidden behind it)
│       ├── Export CSV button
│       └── Print button (window.print())
├── If snapshot loaded: amber banner "Showing snapshot · [Use live data]"
├── KpiGrid (6 tiles)
├── ChartsRow (2 columns)
│   ├── Pipeline panel + SalesPipelineChart
│   └── Demand panel + SalesDemandChart
├── WorkloadTable (hidden when scope = "Just mine")
└── AtRiskTable
```

### 7.3 Data Fetch Pattern

Two parallel Supabase queries on each poll:

```javascript
const [report, summary] = await Promise.all([
  supabase.from('v_sales_weekly_report_v3')
    .select('*')
    .in('section', ['B. Production', 'C. Open Demand']),  // skip A; we build the KPI from summary view
  supabase.from('v_sales_summary_by_person').select('*')
]);
```

`v_sales_weekly_report_v3` already does the heavy lifting. The React page never sees raw `jobs` / `customer_orders` / `customer_order_allocations` data — it only sees pre-joined view rows.

Scope filter applies client-side after fetch (data volume is small — ~100 rows at present, ~500 at peak projected). Filter logic:

- `"all"` → no filter, but Workload table visible
- `"mine"` → filter rows where `salesperson_name === profile.full_name`. Workload table hidden.
- `<specific name>` → filter rows where `salesperson_name === <name>`. Workload table visible (one row).

The Unassigned KPI tile bypasses the scope filter (always shows org-wide count per D-MAY27-07).

### 7.4 CSV Upload Parsing

The polished sectioned format has this structure:

```
CO & WO Report by Salesperson
<blank>
APRIL BRAUN
Scorecard - ...
Active Production (N)
Due Bucket,Days to Due,Priority,Customer,Reference,Sub Ref,Line,Part Number,Description,Qty Ord,Qty WIP,Qty Rem,Status / Phase,Due Date,Sched/Age (days),Machine / CO,Flags / Notes
<data rows>
Open Demand (N)
Due Bucket,...
<data rows>
<blank>
CHRISTY EXUM
... etc
```

Parser logic (matches the HTML preview's `parseCSV`):

1. Read with ISO-8859-1 encoding (handles the em-dash byte 0x97).
2. Split lines, iterate.
3. If line has content in col 0 and nothing in cols 1+: it's a section marker. Match against:
   - `/^Scorecard/i` → skip (we recompute from data)
   - `/^Active Production/i` → kind = 'production'
   - `/^Open Demand/i` → kind = 'demand'
   - `/Report by Salesperson/i` → skip (title)
   - else → it's a salesperson name; reset kind = null
4. If col 0 is `'Due Bucket'`: skip (column header row).
5. Else: data row. Emit `{sp, kind, bucket, days, priority, cust, ref, sub_ref, line, part, qty_ord, qty_wip, qty_rem, phase, due_date, sched_age, machine_co, flags}`.

After parsing, set state to the parsed rows and stop the poll. Banner appears. Clicking "Use live data" clears the snapshot and restarts the poll.

### 7.5 Print CSS

```css
@media print {
  body { background: #fff; }
  .controls, .snapshot-banner { display: none; }
  .panel, .kpi { border-color: #ccc; }
  .panel { break-inside: avoid; }
  table tr { break-inside: avoid; }
  .charts-row { break-inside: avoid; }
}
```

Already proven in the HTML preview; transplant directly.

### 7.6 Role Gate Pattern

In `Nav.jsx` (or wherever the Dashboard dropdown lives):

```jsx
{canViewSalesDashboard(profile) && (
  <DropdownItem to="/sales">Sales Dashboard</DropdownItem>
)}
```

In `App.jsx`:

```jsx
<Route path="/sales" element={
  canViewSalesDashboard(profile)
    ? <SalesDashboard profile={profile} />
    : <Navigate to="/" replace />
} />
```

`canViewSalesDashboard` in `src/lib/roles.js`:

```javascript
export function canViewSalesDashboard(profile) {
  if (!profile) return false;
  const ALLOWED_ROLES = ['admin', 'customer_service', 'president', 'viewer'];
  return ALLOWED_ROLES.includes(profile.role) || profile.is_salesperson === true;
}
```

Read-only enforcement is automatic (the page has no write paths). The president-auto-redirect rule (v3.3) is unchanged — president still lands at `/bridge`, but can navigate to `/sales` from the dropdown.

---

## 8. Critical schema / column names (do not guess)

- `v_sales_weekly_report_v3.section` IN `('A. Scorecard', 'B. Production', 'C. Open Demand')`
- `v_sales_weekly_report_v3.row_type` IN `('Production', 'Open Demand', null)` (null on scorecard rows)
- `v_sales_weekly_report_v3.salesperson_name` — text, source for scope filtering. Values include real names, `"Unassigned"`, `"Make to Stock (MTS)"`.
- `v_sales_weekly_report_v3.production_phase` — text, "1. Waiting to Run" through "6. Pending TCO". UI uses the integer prefix for ordering.
- `v_sales_weekly_report_v3.due_bucket` — text, "0. No Due Date" through "5. 4+ Weeks Out". Same prefix convention.
- `v_sales_weekly_report_v3.flags_or_notes` — text, may contain "STALLED", "COMBINED-WO", "DOCS-DEFERRED", "SHORTFALL", or "" — substring match needed (not equality).
- `v_sales_weekly_report_v3.qty_this_row` — int. Meaning varies by section (per the cheat-sheet at the top of the SQL view comment): scorecard = active_jobs, production = sales_qty_allocated, demand = qty_open_demand.
- `profiles.is_salesperson` — boolean, the access gate (alongside role).
- `profiles.full_name` — text, used for scope filter dropdown.

---

## 9. Test Plan

### 9.1 Functional

- Open `/sales` as Admin → all six KPIs render, both charts render, both tables render, scope filter defaults to "All sales".
- Open as a salesperson (April or Christy) → default to "All sales" with toggle visible. Switch to "Just mine" → only that person's rows appear, Workload table disappears, Unassigned KPI still shows org-wide count.
- Open as CS → default to "All sales" with filter-by-salesperson dropdown showing all `is_salesperson` profiles.
- Open as President → default redirect still works (lands at `/bridge`); navigating to `/sales` shows the dashboard.
- Open as Viewer → dashboard visible, no write buttons (there shouldn't be any anyway).
- Open as Machinist / Finishing / Assembly / Compliance / Scheduler → no "Sales Dashboard" item in the dropdown. Manual nav to `/sales` redirects to `/`.

### 9.2 Data correctness

- Cross-check KPIs against direct SQL queries against `v_sales_weekly_report_v3`:
  ```sql
  -- Active WO count
  SELECT COUNT(DISTINCT wo_numbers) FROM v_sales_weekly_report_v3 WHERE section='B. Production';
  -- Past-due production count
  SELECT COUNT(*) FROM v_sales_weekly_report_v3 WHERE section='B. Production' AND due_bucket='1. PAST DUE';
  -- Demand qty
  SELECT SUM(qty_this_row) FROM v_sales_weekly_report_v3 WHERE section='C. Open Demand';
  ```
- Scope filter math: filter to April Braun in UI, count rows; run `SELECT COUNT(*) FROM v_sales_weekly_report_v3 WHERE salesperson_name = 'April Braun'`; counts should match per section.
- Verify TCO exclusion: query view for `production_phase = '6. Pending TCO'` → should return zero rows.

### 9.3 CSV upload

- Export from Supabase using Query 0 → load into dashboard → KPIs match a fresh poll.
- Load Matt's polished sectioned CSV (`Supabase_Snippet_Claud_Commands__5_.csv`) → renders correctly with snapshot banner.
- Click "Use live data" → snapshot clears, poll resumes.

### 9.4 Print

- Click Print in browser → preview shows clean layout, controls hidden, charts side-by-side, tables don't break mid-row.
- Save as PDF → 1–2 pages, legible.

---

## 10. Claude Code Prompt Batches

Run in order. Each batch is independently testable. Read `Decisions.md` and this plan before each batch.

### 10.1 Batch A — SQL view tweak + helper module

- Apply §6.1 SQL on test, verify with §6.2.
- Create `src/lib/salesMetrics.js` with the five pure functions listed in §7.1.
- Create `src/lib/roles.js` export `canViewSalesDashboard(profile)`.
- **Verify:** Open Node REPL in `/home/claude/skynet`; import salesMetrics; pass it sample data from `v_sales_weekly_report_v3`; KPI numbers match the SQL-direct counts.

### 10.2 Batch B — Page component + route + nav

- Create `src/pages/SalesDashboard.jsx` with the structure in §7.2.
- Create the three small sub-components (`SalesScopeFilter`, `SalesPipelineChart`, `SalesDemandChart`).
- Wire `/sales` route in `App.jsx`.
- Add Dashboard dropdown entry in nav, gated by `canViewSalesDashboard`.
- **Verify:** Page renders for Admin user, no console errors, both charts visible, all six KPIs populated, tables render with data.

### 10.3 Batch C — Scope filter + sticky preference

- Wire scope dropdown to filter the page state.
- Sticky to `localStorage['skynet.sales_dashboard.scope']`.
- Workload table conditional hide when scope = "Just mine".
- Unassigned KPI bypass: compute from unfiltered data.
- **Verify:** Switch scopes, refresh page, scope persists. Numbers update correctly.

### 10.4 Batch D — CSV upload + Print + Export

- Wire file input behind "Load CSV" button. Parser per §7.4.
- Snapshot banner with "Use live data" reset.
- Print: `window.print()` button + `@media print` CSS per §7.5.
- Export CSV: flatten current visible rows, headers match view column names.
- **Verify:** Round-trip works: Export CSV → Load CSV → same data renders.

### 10.5 Batch E — Spec bump + Decisions.md + merge

- Update `SkyNet_Specification_v3_4.docx` adding §5.15 Sales Dashboard.
- Append `Decisions.md`: D-MAY27-01 through D-MAY27-14.
- Merge `feature/sales-dashboard` → `main`.

---

## 11. Risk & Mitigation

| Risk | Mitigation |
|---|---|
| View-as-API query latency at scale | At present row volume (100 rows) latency is sub-100ms. If it grows past 1000+ active production rows we'd notice via the 60s poll feeling laggy; that's the trigger for materialized refresh, not now. |
| Combined-WO `good_pieces` reading over 100% on a CO line | Already flagged via COMBINED-WO badge in `flags_or_notes`. UI renders the badge as a pill so the reader knows the caveat. Future polish: prorate by allocation share (6-line view change). |
| Scope filter leaking another salesperson's data through Export CSV | Export respects the in-memory filtered rows, not the raw view. Verified by reading the Export handler reads from filtered state. |
| Print layout breaking on large datasets | Tested in HTML preview against current data. With more salespeople or longer at-risk lists, print could go multi-page; `break-inside: avoid` on rows and panels keeps it readable. |
| Salesperson role flag inconsistency | Some users may have both `role='customer_service'` and `is_salesperson=true`. The OR logic in `canViewSalesDashboard` handles this correctly. The scope filter pulls from `is_salesperson=true` regardless of role, so the dropdown shows them as filterable. |

---

## 12. Open Questions

None at sprint open. All access, scope, and visual decisions locked per the May 27 design session.

---

## 13. Definition of Done

- [ ] §6.1 SQL applied on prod, verified via §6.2.
- [ ] `/sales` reachable, role-gated correctly across 8 user roles (admin, CS, salesperson, president, viewer, machinist, finishing, assembly, scheduler, compliance).
- [ ] All six KPIs match direct SQL queries against the views.
- [ ] Scope filter persists, hides Workload table when "Just mine".
- [ ] CSV upload parses the polished sectioned format.
- [ ] Print renders cleanly to PDF.
- [ ] Export CSV is round-trippable through Load CSV.
- [ ] Spec v3.4 §5.15 written.
- [ ] D-MAY27-01 through D-MAY27-14 in Decisions.md.
- [ ] Merged to main, deployed to prod, used in the next weekly sales meeting without falling back to the Excel handout.
