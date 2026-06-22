# Closed Work Order Search — Implementation Plan

**Status:** Draft for build (separate chat)
**Date:** 2026-06-17
**Author:** Matt Bowers
**Related:** Raised while retrieving J-000058 for compliance; supersedes the ad-hoc SQL
retrieval as the standard process for TCO'd jobs.

---

## 1. Problem

Once a work order is TCO'd, `TCOReview.handleApproveTCO` sets every `pending_tco` job to
`complete` and the WO to `complete` (with `closed_at` / `closed_by`). The Order Lookup
only surfaces active WOs plus those completed in the **last 7 days**, so any older closed
WO — e.g. J-000058 — becomes unreachable through the UI. The data is fully retained
(`jobs`, `work_orders` incl. `tco_*` fields, `job_documents`, `finishing_sends`,
`material_loads`), but the only way to pull it today is a manual SQL query.

For an FAA / AS9100 shop, compliance must be able to retrieve historical job records
(traveler, lots, QC results, documents) on demand. Manual SQL is not an acceptable
standing process.

**Goal:** add a closed-WO search to the Order Lookup so compliance/admin can find any
TCO'd or cancelled WO by WO #, job #, part #, or customer, and open the full existing
drill-down (jobs, routing, documents, live traveler) — without SQL.

---

## 2. Current-state analysis

### 2.1 How the Order Lookup loads today (`Mainframe.jsx`)

- `fetchWOLookup` (≈480–705) queries `work_orders` with embedded
  `work_order_assemblies`, `jobs`, routing, allocations — **no status filter at the DB
  level** and **no limit** — then filters client-side into:
  - `activeWOs` — any job not in `complete`/`cancelled`.
  - `completedWOs` — all jobs `complete`/`cancelled` **and** `created_at` within the last
    7 days (note: keyed off `created_at`, not `closed_at`).
  - `finalWOs = [...activeWOs, ...completedWOs]` → `setWOLookupData`.
- Search (`filteredWOLookup`, ≈893) is **client-side** over `woLookupData`, matching
  `wo_number`, `customer`, allocation customer names, assembly part numbers, job numbers,
  and component part numbers.
- Drill-down (jobs, routing, `renderJobDocRow`/`handleViewWODoc`, `handleViewTraveler`)
  renders off a job id and is **status-agnostic** — it already works for `complete` jobs.

### 2.2 Why closed WOs aren't searchable

The 7-day `completedWOs` window. Older closed WOs are excluded before the search ever
runs. The search itself can already match them — they just aren't in `woLookupData`.

### 2.3 Two distinct constraints

1. **Coverage:** the active path intentionally hides old closed WOs.
2. **Scale:** the active path fetches *all* WOs and filters client-side. That is tolerable
   for the small active set but **must not** be the model for full history — closed WOs
   grow unbounded. The closed search has to be **search-driven and server-side**, fetching
   only matches, not the whole table.

---

## 3. Proposed design

A **"Closed" mode** in the Work Orders tab of the Order Lookup (a toggle, or a third
sub-filter alongside the existing list). When active:

- The search box drives a **server-side** query for closed WOs (`status IN
  ('complete','cancelled')`) matching the term across WO #, job #, part #, and customer.
- Results (bounded, e.g. top 50 by `closed_at` desc) hydrate into the **same** embedded
  shape `woLookupData` already uses, so the existing drill-down, document viewer, and
  Job Traveler render unchanged.
- Empty search in Closed mode shows a prompt ("Search a closed WO/job/part #") rather
  than loading all history.

Key principle: **reuse the existing render and traveler; change only how closed WOs are
found and fetched.**

### 3.1 Server-side search primitive

Closed search spans four fields across three tables (`work_orders`, `jobs`, `parts`),
which PostgREST can't filter cleanly in one embedded query. Two options:

- **Option A (recommended) — RPC.** `search_closed_work_orders(p_term text, p_limit int
  default 50)`, SECURITY DEFINER, returns matching `work_order_id`s (DISTINCT, ordered by
  `closed_at` desc) where `wo.status IN ('complete','cancelled')` and the term matches
  `wo.wo_number`, `wo.customer`, any `job.job_number`, or any component `part.part_number`
  (ILIKE). Mainframe then fetches those WO ids with the existing embedded select. One round
  trip to find, one to hydrate; bounded and index-friendly.
- **Option B (no RPC) — multi-query union.** Separate ILIKE queries (WO #, customer; jobs
  by job #; jobs by part #) → union the WO ids → hydrate. More round trips, more client
  glue; acceptable if avoiding a migration is preferred.

Recommend Option A. Add supporting indexes if absent: `work_orders(status, closed_at)`,
and trigram/ILIKE support on `wo_number`, `job_number`, `parts.part_number` as needed.

### 3.2 Reused, unchanged

- Drill-down render (jobs/routing/assembly rows).
- `renderJobDocRow` + `handleViewWODoc` (documents).
- `handleViewTraveler` (live Job Traveler) — generated from job data, status-agnostic.
- `setJobDocCache` / `expandedJobDocs` mechanics.

---

## 4. Work breakdown

### Batch A — Closed-search primitive
- `search_closed_work_orders(p_term, p_limit)` RPC (Option A) + any missing indexes.
- Verify on TEST against J-000058 (search by job #, by part #, by WO #) returns its WO.

### Batch B — Closed mode in the Order Lookup
- Add a Closed/Active toggle to the Work Orders tab; `woLookupMode` state ('active' |
  'closed'), default 'active' (current behavior untouched).
- Closed mode: on search submit/debounce, call the RPC, hydrate matched WO ids via the
  existing embedded select (filtered to those ids), set into a `closedWOLookupData` set
  rendered by the existing list/drill-down.
- Empty-search prompt; result-count + "showing top N" note; loading + no-results states.
- Confirm documents and traveler open for a closed job end to end.

### Batch C — Access, polish, close-out
- Access decision (see §6) — gate Closed mode if restricting to compliance/admin.
- Optional date filter (e.g. "closed in last 12 months" default, "all" option) layered on
  the RPC for additional bounding.
- Test script (.docx, S3_Batch_D style): retrieve J-000058 via Closed search → open
  traveler → open a document → confirm QC/TCO fields visible.
- Decisions.md entry (appended via the CC prompt); spec bump; plan → CLOSED.

---

## 5. Files in scope

- `pages/Mainframe.jsx` — toggle, closed fetch/hydrate, render wiring (reuses drill-down).
- New RPC `search_closed_work_orders` (Option A) + indexes — `Docs/migrations/`.
- No change to TCO close-out, the traveler, the document viewer, or the active lookup path.

---

## 6. Open decisions

1. **Search primitive:** Option A (RPC) vs Option B (multi-query union). *(Recommend A.)*
2. **Access:** Closed search available to everyone who has the lookup today, or restricted
   to admin/compliance? Historical records are read-only but compliance-sensitive.
   *(Recommend admin/compliance; easy to widen later.)*
3. **Default bounding:** purely search-term-driven (no results until a term is entered), or
   also a default date window? *(Recommend search-driven + a "last 12 months / all" filter
   in Batch C.)*
4. **"Closed" definition:** filter on `work_orders.status IN ('complete','cancelled')`
   (clean, TCO sets `status='complete'`) vs all-jobs-complete derivation. *(Recommend
   `wo.status`.)*

---

## 7. Risks & edge cases

- **Scale:** the active lookup's fetch-all-then-filter pattern must NOT be copied for
  closed; the RPC keeps closed search bounded. (Refactoring the active path's full-table
  fetch is a separate, optional cleanup — out of scope.)
- **Cancelled WOs/jobs:** included via `status IN ('complete','cancelled')`.
- **Traveler for complete jobs:** confirm `handleViewTraveler` renders for `complete`
  status (expected — it builds from job data live).
- **Document storage:** `file_url` paths persist after close; `getDocumentUrl` signing
  works regardless of WO status.
- **Mixed-status WOs:** a partially-cancelled WO with some complete jobs still appears in
  Closed mode if its `status` is `complete`/`cancelled`; its active jobs (if any) would
  also still show in Active mode — acceptable overlap.
- **Search cost:** ILIKE across history needs the indexes in Batch A or it degrades as the
  table grows.

---

## 8. Out of scope

- Refactoring the active lookup's unbounded fetch-all (separate performance pass).
- Editing or reopening closed WOs (read-only retrieval only).
- A separate compliance "records export" (PDF package) — possible future follow-on; the
  Job Traveler already covers single-job retrieval.
