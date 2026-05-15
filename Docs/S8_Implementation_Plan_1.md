# SkyNet MES — Sprint 8 Implementation Plan

**Sprint 8 — Job-Level Shortfall & Allocation Resolution**

Implementation Plan v1.0 · May 15, 2026

**Owner:** Matt Bowers
**Status:** Resumed after mid-deploy git recovery; allocation work parked on `feature/allocation-saved`.

---

## 1. Sprint Goal

Pivot shortfall tracking from work-order level to job level. Each job that completes with produced < target generates its own resolution row. The scheduler resolves each short job individually through a unified Allocation modal that allocates produced quantity to customer orders, sends excess to stock, and chooses an outcome (Accept Short / Re-queue / Cancel Shortfall) in one save.

Sprint 7 (RLS hardening) deferred. Sprint 8 supersedes the WO-level shortfall feature shipped in v3.0 and is the prerequisite for the Shipping module.

---

## 2. Background

Sprint 6 (v2.9) introduced WO-level shortfall resolution backed by `wo_shortfall_resolutions`. The model required all jobs on a WO to reach a terminal-or-near status before a shortfall would surface. In practice this delayed visibility too long — for multi-job WOs, the scheduler could not intervene on a short job while sibling jobs were still in production.

A May 15 design review with Matt produced a pivot decision: shortfalls become a per-job concern. Each kiosk Complete Job with produced < target — and each compliance post-mfg Accept that reduces good count below target — creates its own resolution row. The Shortfalls tab now shows job cards, not WO cards. The Allocation modal still allocates against the WO's customer orders (since COs are allocated to WOs), but operates on a single job's produced quantity at a time.

---

## 3. Where We Are at Sprint 8 Open

### 3.1 Code state

- `main` and `test` branches both at commit `5684a04` (merge of `hotfix/compliance-qty-override`). Production and test are aligned at this baseline.
- `feature/allocation-saved` holds the in-flight allocation work from the May 13–15 session. This branch includes a mixed commit with both allocation modal updates and the compliance role override change. The role override has since been cleanly re-applied to main, so the saved branch still has value as a reference but should not be merged directly.
- `feature/allocation-standby` holds an earlier WIP snapshot of the allocation modal (commit `f987a4e`) before the role change was mixed in.
- Sprint 8 work resumes on a new branch `feature/job-shortfall`, branched from main.

### 3.2 What was completed before the deploy incident

- Schema migration scripts for `job_shortfall_resolutions` and `jobs.has_open_shortfall` — validated on test, **NOT yet on prod**.
- Backfill SQL converting `wo_shortfall_resolutions` open rows into per-job rows — ran on test, identified 1 row (J-000019); broader backfill identified 9 jobs across test and required a manual cleanup of 5 test artifacts.
- `src/lib/shortfall.js` helper rewritten as `evaluateJobShortfall` — operates per job, includes `manufacturing_complete` in `TERMINAL_OR_NEAR`, uses `COALESCE(post_mfg_good_qty, good_pieces, 0)` for produced count, uses `stock_quantity + order_quantity` for WO target.
- `src/components/WOLookupShortfalls.jsx` updated to query `job_shortfall_resolutions`, render job-centric cards (job number, part, machine, parent WO), and pass `job_id` + `producedQuantity` to the Allocation modal.
- `src/components/AllocationResolutionModal.jsx` — built end-to-end with manual per-CO allocation table, Step 2 resolution picker, Re-queue branch using `work_order_assemblies` (not jobs) as the structural anchor. Compliance auto-pull of `part_documents` into `job_documents` wired.
- Three card-level action buttons consolidated to a single Allocate button at Matt's request — modal opens with Accept Short pre-selected, user can change to Re-queue or Cancel.
- Open Shortfalls KPI tile removed from Mainframe (scheduler finds shortfalls via WO Lookup tab).
- Card header shows Job # · Part # · WO context; expanded CO detail table sorts by `due_date` ASC then priority; cancelled CO rows render strikethrough/grey, at-risk rows amber.

### 3.3 What's left to verify before promotion to prod

- End-to-end manual test on test environment: complete a fresh kiosk job below target → shortfall row appears in tab automatically, click Allocate → manual per-CO allocation → save accept-short → fulfillments persist, allocation rows correctly deactivated for partial deliveries, audit log entry written.
- Re-queue path test: allocate produced qty, choose Re-queue, save → new job created at `pending_compliance` with auto-pulled part documents, original job's resolution row marked resolved, `has_open_shortfall` flipped on the original job.
- Cancel Shortfall path test: reason required, fulfillments still commit, audit log records cancel reason.
- WO row badge derivation — verify any WO with at least one open job shortfall displays the red Shortfall badge in WO Lookup row rendering, even though `work_orders.has_open_shortfall` column is deprecated.
- Compliance Accept post-mfg path — when `post_mfg_good_qty` is recorded below quantity, `evaluateJobShortfall` fires.
- Cancelled jobs (operator/scheduler cancels mid-run) do NOT create shortfall rows.
- After all checks pass on test, `wo_shortfall_resolutions` table dropped on test via CASCADE.

### 3.4 Test data state to be aware of

- **J-000018** (WO-2605-0012) — partially exercised through earlier Accept Short flow. Resolution row exists.
- **J-000019** (WO-2605-0013) — open shortfall row; valid for new flow testing.
- **J-000026** (WO-2605-0019) — completed at 500/1300 short; needed broader backfill to surface.
- **RQ-13750298** — re-queue test artifact; status anomaly requires investigation (was created at `pending_compliance` but appeared in shortfall list, suggesting status drift).
- 5 test artifacts cleaned up: J-000003, J-000005, J-000007, J-000016, J-000017 — resolved as `cancel_shortfall` with "Test data cleanup" notes.

---

## 4. Sprint Scope

### 4.1 In scope

- Cherry-pick the WIP allocation modal work from `feature/allocation-standby` (or extract clean changes from `feature/allocation-saved` minus the role mixing) into `feature/job-shortfall`.
- Schema migration for `job_shortfall_resolutions`, `jobs.has_open_shortfall` — applied to test, then validated, then prod.
- Job-level `evaluateJobShortfall` helper, trigger wiring in Kiosk Complete Job and Compliance post-mfg Accept paths.
- UI rewrite of Shortfalls tab to job-centric cards with chevron-expandable CO detail.
- Unified Allocation modal with manual per-CO allocation, three resolution paths (Accept Short / Re-queue / Cancel Shortfall), Re-queue creates new job at `pending_compliance` with auto-pulled part documents.
- WO row badge derivation from EXISTS check against `job_shortfall_resolutions`.
- Backfill SQL for production short jobs that pre-date the feature (the J-000002 / J-000016 manual splits that were applied this week were one-off; the migration handles future cases automatically).
- Spec bump to v3.1 documenting the job-level model.
- Decisions.md update.

### 4.2 Out of scope

- Sprint 7 RLS hardening — deferred.
- Shipping module — depends on this sprint.
- Multi-product WO support in the allocation modal — current model assumes single-product WOs (the dominant case). When multi-product becomes real, the modal's CO list will need filtering to COs allocated to the same part as the shorting job.
- Per-CO allocation buttons (Accept Short for one CO, Re-queue for another) — deferred as future polish.
- Drop of `work_orders.has_open_shortfall` column — marked deprecated only; physical drop deferred to a future cleanup sprint.

---

## 5. Decisions Locked

| ID | Topic | Decision |
|---|---|---|
| D-S8-01 | Shortfall granularity | Job-level. Each job with produced < target generates its own row. |
| D-S8-02 | Trigger states | Trigger fires from kiosk Complete Job and Compliance post-mfg Accept. Cancelled jobs never trigger. |
| D-S8-03 | Produced calculation | `COALESCE(post_mfg_good_qty, good_pieces, 0)`. Verified count if available, operator count otherwise. |
| D-S8-04 | Target calculation | WO target = `stock_quantity + order_quantity` (single-product WO assumed). |
| D-S8-05 | Allocation flow | Manual per-CO entry. No pre-fill, no FIFO suggestions, no auto-distribute. Intentional friction to build the habit. |
| D-S8-06 | Excess handling | Allocated < produced → remainder auto-flows to stock implicitly. No explicit stock writes. |
| D-S8-07 | Partial allocation effect | Allocated < existing allocation row's `quantity_allocated` → deactivate the allocation row (`is_active = false`). Returns the remainder to the demand pool for future re-allocation. Shipping can still ship the partial. |
| D-S8-08 | Resolution outcomes | Three: Accept Short (close), Re-queue (close + new job for this job's gap at `pending_compliance`), Cancel Shortfall (close + reason required). |
| D-S8-09 | Re-queue WO target | New job goes on same WO. New WO option removed from design. |
| D-S8-10 | Re-queue structural anchor | `work_order_assemblies`, not existing jobs. `component_id` pulled from the WOA. **For assembly WOs, `component_id` must come from the shorting job (not the WOA's `assembly_id`)** — verified manually in the J-000018 fix. |
| D-S8-11 | Re-queue documents | Auto-pull current `part_documents` (`is_current = true`) into `job_documents` at `source = 'part_pulled_forward'`. If `part_documents` is empty for the component, copy `compliance_review`-phase docs from the source job. |
| D-S8-12 | WO row badge | Derived from EXISTS check against `job_shortfall_resolutions` where `status = 'open'`. `work_orders.has_open_shortfall` column deprecated, kept for now. |
| D-S8-13 | Card action UX | Single Allocate button per card. Modal Step 2 picks outcome. Three-button design (Accept Short / Re-queue / Cancel Shortfall) abandoned. |
| D-S8-14 | Card visibility | Job-centric: Job # · Part # · Machine. Parent WO as secondary line. Chevron expands per-CO detail. |
| D-S8-15 | Open Shortfalls KPI tile | Removed from Mainframe. Discovery via WO Lookup → Shortfalls tab only. |

---

## 6. Schema Migration

Apply this SQL block to test first. Validate the test checklist in Section 9. Apply to prod only after all test scenarios pass. The migration is idempotent and safe to re-run.

### 6.1 New table and column

```sql
CREATE TABLE IF NOT EXISTS public.job_shortfall_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  work_order_id uuid NOT NULL REFERENCES public.work_orders(id) ON DELETE CASCADE,
  job_quantity integer NOT NULL,
  produced_quantity integer NOT NULL,
  shortfall_quantity integer NOT NULL,
  resolution text CHECK (resolution IS NULL OR resolution IN
    ('accept_short', 'requeue', 'cancel_shortfall')),
  resolution_notes text,
  resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  requeue_job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jsr_job ON public.job_shortfall_resolutions(job_id);
CREATE INDEX IF NOT EXISTS idx_jsr_wo ON public.job_shortfall_resolutions(work_order_id);
CREATE INDEX IF NOT EXISTS idx_jsr_open
  ON public.job_shortfall_resolutions(work_order_id)
  WHERE status = 'open';

ALTER TABLE public.job_shortfall_resolutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY jsr_select ON public.job_shortfall_resolutions
  FOR SELECT TO authenticated USING (true);
CREATE POLICY jsr_insert ON public.job_shortfall_resolutions
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY jsr_update ON public.job_shortfall_resolutions
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY jsr_delete ON public.job_shortfall_resolutions
  FOR DELETE TO authenticated USING (true);

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS has_open_shortfall boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_jobs_open_shortfall
  ON public.jobs(has_open_shortfall) WHERE has_open_shortfall = true;

COMMENT ON COLUMN public.work_orders.has_open_shortfall IS
  'DEPRECATED. Use EXISTS on job_shortfall_resolutions.status=open instead.';
```

### 6.2 Backfill

Catches all `manufacturing_complete` (or later) jobs with produced < target. Idempotent.

```sql
INSERT INTO public.job_shortfall_resolutions
  (job_id, work_order_id, job_quantity, produced_quantity,
   shortfall_quantity, status, created_at)
SELECT
  j.id, j.work_order_id, j.quantity,
  COALESCE(j.post_mfg_good_qty, j.good_pieces, 0),
  j.quantity - COALESCE(j.post_mfg_good_qty, j.good_pieces, 0),
  'open', now()
FROM public.jobs j
WHERE j.status IN (
  'manufacturing_complete', 'pending_tco', 'complete',
  'ready_for_assembly', 'ready_for_outsource', 'in_assembly',
  'pending_passivation', 'in_passivation',
  'pending_post_manufacturing', 'ready_for_outsourcing',
  'at_external_vendor'
)
  AND j.quantity > COALESCE(j.post_mfg_good_qty, j.good_pieces, 0)
  AND NOT EXISTS (
    SELECT 1 FROM public.job_shortfall_resolutions jsr
    WHERE jsr.job_id = j.id AND jsr.status = 'open'
  );

UPDATE public.jobs SET has_open_shortfall = true
WHERE id IN (
  SELECT DISTINCT job_id FROM public.job_shortfall_resolutions WHERE status = 'open'
);
```

### 6.3 Drop `wo_shortfall_resolutions` (deferred)

Only after all test scenarios pass AND prod has been on the new feature for at least one stability cycle:

```sql
-- DROP TABLE public.wo_shortfall_resolutions CASCADE;
```

---

## 7. Code Changes

### 7.1 New / rewritten files

| File | Type | Change |
|---|---|---|
| `src/lib/shortfall.js` | Rewrite | `evaluateJobShortfall(jobId)` — per-job evaluation. Idempotent. Backwards-compat alias `evaluateShortfall = evaluateJobShortfall`. |
| `src/lib/woFulfillment.js` | Update | Confirm `quantity_ordered` (not `ordered_quantity`) and `customer_orders.po_number`. |
| `src/components/WOLookupShortfalls.jsx` | Rewrite | Job-centric cards. Query `job_shortfall_resolutions` with `job:jobs!job_id` explicit FK to avoid PostgREST PGRST201 ambiguity (table has two `jobs` FKs). |
| `src/components/AllocationResolutionModal.jsx` | Update | Header uses `{workOrder.wo_number}` without 'WO ' prefix. Header shows `part_number`. Re-queue qty default = `jobQuantity - producedQuantity`. Save handler updates `job_shortfall_resolutions` and sets `jobs.has_open_shortfall = false`. |
| `src/pages/Kiosk.jsx` | Update | Complete Job handler calls `evaluateJobShortfall(job.id)`. |
| `src/components/ComplianceReview.jsx` | Update | Post-mfg Accept handler calls `evaluateJobShortfall(job.id)`. |
| `src/pages/Mainframe.jsx` | Update | WO row Shortfall badge: derive via EXISTS on `job_shortfall_resolutions`. Job row Shortfall badge: read `jobs.has_open_shortfall`. |

### 7.2 Removed

- Open Shortfalls KPI tile in Mainframe — remove the tile, the count fetcher, and the `openShortfallCount` state.
- Three-button card UI (Accept Short / Re-queue / Cancel Shortfall) — replaced by single Allocate button.
- New WO radio in Re-queue section — removed entirely.

### 7.3 Critical schema column names (do not guess)

- `jobs.good_pieces` (not `good_quantity`)
- `jobs.post_mfg_good_qty` (compliance-verified count, nullable)
- `work_orders.stock_quantity` and `work_orders.order_quantity` (no `total_quantity` column)
- `customer_order_lines.quantity_ordered` (not `ordered_quantity`)
- `customer_orders.po_number`
- `customer_order_allocations.quantity_allocated`, `is_active`, `deactivated_at`, `deactivated_by`
- `part_document_requirements.required_at IN ('compliance_review', 'manufacturing_complete', 'tco')`

---

## 8. Claude Code Prompt Batches

Run in order. Each batch is independently testable. Read `Decisions.md` and this implementation plan before each batch.

### 8.1 Batch A — Schema migration + helper rewrite + trigger wiring

- Run SQL in Section 6.1 and 6.2 on test.
- Rewrite `src/lib/shortfall.js` per Decisions D-S8-01 through D-S8-04.
- Update `Kiosk.jsx` and `ComplianceReview.jsx` call sites — pass `job.id` to `evaluateJobShortfall`.
- **Verify:** complete a kiosk job below target → `job_shortfall_resolutions` row exists, `jobs.has_open_shortfall = true`.

### 8.2 Batch B — Shortfalls tab UI rewrite

- Rewrite `WOLookupShortfalls.jsx` query and card rendering.
- Use `job:jobs!job_id` explicit FK in the embed to avoid PostgREST PGRST201.
- Card content: Job # · Part # · Machine · WO link · Target/Produced/Short by · CO impact summary · single Allocate button.
- Expanded CO detail (chevron) reuses `getWOFulfillmentSummary`.

### 8.3 Batch C — Allocation modal job-context updates

- Modal accepts `producedQuantity` = THIS JOB's count and `jobQuantity` = THIS JOB's target.
- Save handler updates `job_shortfall_resolutions` (not `wo_shortfall_resolutions`) and sets `jobs.has_open_shortfall = false`.
- Re-queue qty default = `jobQuantity - producedQuantity`.
- Re-queue structural anchor remains `work_order_assemblies` (per D-S8-10).

### 8.4 Batch D — WO row badge, job row badge, KPI removal

- WO row Shortfall badge derived from EXISTS on `job_shortfall_resolutions` where `status = 'open'`.
- Job rows in all lists (Mainframe, Kiosk queue, Schedule, Compliance Review, Finishing) show Shortfall badge when `jobs.has_open_shortfall = true`.
- Remove Open Shortfalls KPI tile + state + fetcher.

### 8.5 Batch E — Migration to prod

- Apply Section 6.1 and 6.2 SQL on prod after test scenarios pass.
- Merge `feature/job-shortfall` → main. Amplify auto-deploys.
- Run smoke tests in prod. Confirm a fresh kiosk Complete Job below target generates a shortfall row.
- Defer DROP of `wo_shortfall_resolutions` until next sprint.

---

## 9. Test Checklist

| ID | Test Case |
|---|---|
| T-01 | Schema migration runs cleanly on test. Verification SELECT shows any pre-existing short jobs as new per-job rows. `jobs.has_open_shortfall = true` on those jobs. |
| T-02 | Shortfalls tab loads without PGRST201 errors and shows job cards (not WO cards). |
| T-03 | Card header reads `J-000019 · SK28S3-2S` format with parent WO as secondary. |
| T-04 | Chevron expands CO detail table, sorted by `due_date` ASC then priority. |
| T-05 | Single Allocate button opens the Allocation modal with Accept Short pre-selected. |
| T-06 | Modal header reads `Resolve Shortfall — {wo_number} · {part_number}` with no duplicate 'WO ' prefix. |
| T-07 | Modal subtitle shows job target, produced, and short by. |
| T-08 | Manual per-CO allocation: entering numbers updates 'Allocated to COs / To stock' summary live. |
| T-09 | Validation blocks save when any input exceeds row remaining, or sum exceeds produced. |
| T-10 | Accept Short save: CO fulfillment increments, allocation rows deactivated when partial, audit log written, resolution row status = resolved, `jobs.has_open_shortfall = false`, card disappears. |
| T-11 | Re-queue save: new job created on same WO at `pending_compliance`, qty defaults to `jobQuantity - producedQuantity`, auto-pulled part documents present on new job, original resolution row marked requeue with `requeue_job_id`. |
| T-12 | Cancel Shortfall save: reason required, fulfillments still commit per Step 1 allocation, audit log records cancel reason. |
| T-13 | Compliance Accept post-mfg with `post_mfg_good_qty < quantity` triggers `evaluateJobShortfall` and creates a row. |
| T-14 | Cancelled job (operator/scheduler cancels mid-run) does NOT create a shortfall row. |
| T-15 | WO row Shortfall badge appears in WO Lookup when any job on the WO has `has_open_shortfall = true`; disappears when last open row resolves. |
| T-16 | Job rows in all queues (Mainframe, Kiosk, Schedule, Compliance, Finishing) show their own Shortfall badge. |
| T-17 | Open Shortfalls KPI tile no longer renders on Mainframe. |
| T-18 | RQ-XXXXXXXX re-queue jobs do NOT incorrectly appear as shortfalls when at `pending_compliance` — investigate test artifact RQ-13750298. |

---

## 10. Risks & Open Items

- **RQ-13750298 anomaly:** test artifact appears in shortfall list at status `pending_compliance` despite migration filter excluding that status. Investigate before promoting to prod.
- **Re-queue `component_id` for assembly WOs:** `WOA.assembly_id` points to the parent assembly, but jobs make components. The Re-queue handler must copy `component_id` from the shorting job, not from the WOA. Verified manually for J-000018; needs to be encoded in `AllocationResolutionModal.jsx`.
- **Cross-component allocation:** `AllocationResolutionModal` currently shows all WO COs. For multi-product WOs (deferred), the CO list should filter to COs allocated to the same part as the shorting job.
- **WO Lookup "override" count display anomaly:** J-000002 showed "2416/6000 override" but DB showed 1925 produced. Possible UI bug summing finishing batch good counts instead of sent counts. Out of scope for Sprint 8; tracked for future.
- **Git hygiene:** deploy incident on May 15 reinforced the need for hotfix discipline — main and test re-aligned at commit `5684a04`. Going forward, every sprint branch starts from clean main, and the test branch tracks the sprint branch only when the sprint is ready to validate.

---

## 11. Spec & Documentation Updates

- SkyNet_Specification bumps to **v3.1**. Sections to revise: §4 Workflow (shortfall trigger fires per job, not per WO), §5 Modules (Shortfalls tab is job-list, not WO-list), §6 Schema (new table, deprecated column).
- `Docs/Decisions.md` — append decisions D-S8-01 through D-S8-15 in the Sprint 8 section.
- `Docs/migrations/` — add the SQL file from Section 6 as `Sprint8_JobShortfall_Migration.sql`.

---

## 12. Definition of Done

- All 18 test cases in Section 9 pass on test.
- Schema migration applied to prod.
- `feature/job-shortfall` merged to main.
- Amplify deploy succeeds, prod Shortfalls tab renders without error.
- A fresh kiosk Complete Job below target on prod generates a job-level shortfall row automatically.
- Spec v3.1 generated. Decisions.md updated. Migration SQL committed under `Docs/migrations/`.
