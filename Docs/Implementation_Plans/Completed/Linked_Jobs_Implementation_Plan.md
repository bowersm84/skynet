# Linked Jobs (Co-Production Batches) — Implementation Plan

**Status:** Deferred. SKY89 reverted from PROD/TEST 2026-06-22. To be designed and built as a dedicated sprint after a working session with the scheduler.

**Origin:** Scheduler needs duplicate same-component jobs that live on different assembly work orders to run together as one physical batch under one production lot, then have the good pieces allocated back to each order. Template case: `J-000038` (SK4C10C cup, 3,499, WO-2605-0025 / SK40S5-10S, AIR TRACTOR) and `J-000067` (SK4C10C cup, 1,000, WO-2606-0018 / SK4002-10S, GIZA) — same component, same machine (Nexturn 2), different WOs and customer allocations.

---

## 1. Objective

Let a scheduler mark two or more pre-start jobs of the **same component on the same machine** as one co-production batch so that:

1. The shop runs them as a **single setup / single production lot / single material issue**.
2. Finishing happens once, under one finishing lot.
3. Good pieces are **allocated back to each member** by an agreed rule (earliest WO due date first was the working default).
4. Each member work order keeps a **complete, independently auditable record** (traveler + compliance document package).

The hard part is not the "run them together" mechanics — it is keeping each member a first-class, fully-traceable job while physically producing them as one lot.

---

## 2. Why this was deferred (root-cause issues found in SKY89)

These are the concrete failures that surfaced during the first attempt. The next design must address each one head-on.

### 2.1 Machine-overlap exclusion constraint (showstopper)
`jobs_no_machine_overlap` is an exclusion constraint preventing two jobs on the same machine with overlapping scheduled time ranges. A co-production batch is, by definition, two jobs on the **same machine at the same time** — so when the batch start set the member to `in_progress` (or advanced it on completion), the update collided with the constraint:

> `Batch member advance failed: conflicting key value violates exclusion constraint "jobs_no_machine_overlap"`

Tagging two independently-scheduled jobs and trying to co-run them is fundamentally at odds with a per-job, non-overlapping schedule model. **This is the central design problem.**

Options to resolve (decide with scheduler):
- Model the batch as a **single scheduled entity** that occupies the machine once; members are *not* independently scheduled while linked (they reference the batch's slot).
- Keep members unscheduled (no `scheduled_start/end`) while linked, so they don't participate in the overlap constraint; only the carrier/batch holds the slot.
- Relax the constraint to ignore rows that share a `combined_batch_id` (partial exclusion / predicate) — riskier, weakens a real guardrail.

### 2.2 Non-atomic completion → duplicated finishing sends
On kiosk completion the final finishing batch was inserted **before** the member-advance step. When the member advance failed (2.1), the completion errored — but the finishing send had already been written. Each retry inserted another send. Three completion attempts left three orphaned `pending_finishing` batches (Batch C/D/E, 3,900 each) on the carrier.

Requirement for v2: completion of a batch must be **atomic** — send + good-piece distribution + per-member advance + lot stamping all succeed or all roll back. This points to a single server-side RPC (transaction) rather than a sequence of client-side `supabase` calls.

### 2.3 Carrier-only finishing and documents (traceability gaps)
The chosen model put all finishing sends and uploaded documents on a single "carrier" member. Consequences:
- The member's **Job Traveler** rendered blank finishing rows (FLN / date / operator / qty) because the traveler reads each job's own `finishing_sends`. Patched read-side by pulling the carrier's batch, but it is a workaround.
- Compliance **documents** (production log, certs) attached to the carrier's `job_id` only, leaving the member WO's package empty. Patched by copying `job_documents` rows to members at approval — but copies can drift and only fire at approval time.

v2 must decide where the source of truth for finishing + documents lives for a multi-order batch (shared batch entity vs. per-job copies) so neither traveler nor document package needs a band-aid.

### 2.4 Kiosk visibility model (UX, unsettled)
First pass hid non-carrier members from the kiosk queue (so nobody started them separately); that made the second order invisible mid-run. Second pass un-hid them and routed selection to the carrier. The right behavior — what the operator should see and be able to tap for a linked batch — needs to be settled with the people running the machines.

### 2.5 Compliance lockstep
Because finishing/compliance only touch the carrier, members had to be advanced in lockstep at the carrier's compliance approval. Workable, but it assumes every member shares identical routing/part_type (true today because linking requires same component) and adds coupling to the compliance flow.

---

## 3. What was built in SKY89 (for resurrection / reference)

All of the following was reverted. The git history (commits behind Decisions IDs `D-JOBLINK-01` … `D-JOBLINK-08`) is the reference implementation to mine, not to restore wholesale.

**Database**
- `jobs.combined_batch_id uuid` + partial index `idx_jobs_combined_batch`.
- `link_jobs(uuid[])` — validate (≥2 jobs, same component, same machine, pre-start, no lot/material, not maintenance, not already linked) and stamp a shared `combined_batch_id`.
- `unlink_jobs(uuid)` — clear linkage while still pre-start.
- `distribute_batch_completion(uuid,int,int,text,text)` — fill members by earliest WO due date up to each member's quantity; surplus + scrap to the earliest-due (carrier); stamp production/finishing lots.

**Frontend**
- `src/lib/coProduction.js` (new) — `batchPrimaries`, `hiddenBatchMemberIds`, `batchCombinedQty`, `propagateBatchStart`, `machineBatchMergePlan`.
- `src/pages/Schedule.jsx` — link/unlink panel in the job detail; combined badge on blocks; contiguous-merge band (`getJobsForMachineDay` + style fns + `JobBlockContent`).
- `src/pages/Kiosk.jsx` — queue collapse/expose of members; combined-batch banner + linked-jobs list; lot/material propagation on start (`propagateBatchStart`); completion distribution + lockstep member advance; combined run target.
- `src/pages/Mainframe.jsx` — WO Lookup combined-batch panel (`batchFinishing` map); traveler synthesizes the carrier's finishing batch for members.
- `src/pages/Finishing.jsx` — pickup-queue completion distribution for batches.
- `components/ComplianceReview.jsx` — lockstep member advance + `job_documents` copy to members at approval.

**Design decisions that still hold up**
- Carrier = earliest WO due date (then job number).
- Distribution = fill earliest-due member to quantity, then next; surplus + scrap to the carrier.
- Linking restricted to same component + same machine + pre-start (no lot/material yet), reversible until start.

---

## 4. Recommended architecture for v2 (to discuss)

A cleaner model than "tag two jobs and co-run them":

1. **Introduce a `production_batches` entity** (id, component_id, machine_id, planned_qty, production_lot, material lot, finishing lot, status). Member jobs reference `production_batch_id`. The batch — not the individual jobs — owns the machine slot, the run, the finishing, and the document package.
2. **Schedule the batch once.** Members are not independently scheduled while in a batch, sidestepping `jobs_no_machine_overlap` entirely. The batch holds one `tstzrange` on the machine.
3. **Atomic batch lifecycle RPCs.** `start_batch`, `complete_batch` (send + distribute + advance + lot stamp in one transaction), `split/unlink_batch`. No client-side multi-write sequences that can half-apply.
4. **Allocation is explicit and stored** (a `batch_allocations` row per member with allocated_good, allocated_scrap), so travelers, shipping, and compliance read one consistent source rather than reconstructing it.
5. **Finishing and documents at the batch level**, with each member's traveler/package deriving from the batch by reference — no row-copies that can drift.
6. **Kiosk + Finishing + Compliance** treat the batch as the unit of work; member identity is preserved for allocation/traceability but the operator interacts with the batch.

---

## 5. Open questions for the scheduler session

1. Should a linked batch be schedulable/movable as one block, and what happens to a member's own due date / priority for scheduling?
2. Can a batch ever include **more than two** orders? Different quantities and due dates?
3. What is the correct allocation rule — earliest due date first (working default), proportional, or scheduler-chosen per batch?
4. Can members be **added/removed after start** (e.g., a rush order joins a running batch)? Per-batch assembly already on the backlog touches this.
5. Surplus handling — does overrun go to the earliest-due order as stock, to a named stock order, or get split?
6. What must each member's printed traveler show for a shared run (one FLN, shared chemical lots, allocated qty) to satisfy AS9100/AS9100D audit?
7. Where do compliance documents live — one batch package referenced by each WO, or a copy per WO?
8. Kiosk: what does the operator see and tap for a batch; how are the member orders surfaced during the run?

---

## 6. References

- Decisions log: `D-JOBLINK-01` … `D-JOBLINK-08` (reverted; kept in the log for history).
- SKY87 (WO Lookup product/parts rollup, `D-WOLOOKUP-ROLLUP01/02/03`) is **independent and shipped** — not part of this deferral.
- Template batch for testing: same-component cups `J-000038` (AIR TRACTOR) + `J-000067` (GIZA) on Nexturn 2.
