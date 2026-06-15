# SkyNet MES — Machinist Lot-Change Split Implementation Plan

**Feature — Kiosk-Triggered Lot-Change Job Split**

Implementation Plan v1.0 · June 3, 2026

**Owner:** Matt Bowers
**Status:** Scoped. Decisions 1–6 locked with Matt; three implementation defaults below flagged for confirmation before build.
**Suggested tracking id:** SKY-LotSplit (assign next SKY number)

---

## 1. Goal

Let a machinist, from the machine kiosk, declare "this material lot is finished" on the job they are running. The system then, in one atomic action and with no scheduler involvement:

- finalizes the current job (Job A) at the good-piece count made on the exhausted lot and auto-sends those pieces to finishing,
- creates a continuation job (Job B) for the remaining quantity, machine-assigned to the same machine and immediately startable,
- drops Job B into the lineup right after Job A, carrying **Job A's original end date/time** so no downstream dates move,
- records the split in `job_splits`, and
- posts an acknowledgement to the scheduler and a paperwork-gathering item to compliance — both informational, neither blocking.

The machinist starts Job B normally, entering the new lot, which mints Job B's PLN with that lot per the flow shipped on June 3.

---

## 2. Background

Machinists routinely reach the end of a raw-material lot mid-run and must switch to a new lot to finish the order. Today they walk to the scheduler and ask her to create the continuation job, verbally — easily forgotten, and a constant interruption.

Two changes shipped immediately before this make the feature both necessary and clean:

- **Single-lot guard (the "B1" check in `handleAddMaterial`)** blocks adding a second, different lot to a job. A lot switch therefore *must* spawn a new job — there is no in-place option. This feature is the sanctioned button for that.
- **Material lot in the PLN** (`generateProductionLotNumber` → `PLN-<lot>-YYMMDD-NNNN`, material mandatory at Start Production). Job A's PLN already carries Lot 1; Job B's will carry Lot 2 when started. Per-lot traceability falls out automatically — the split is what keeps one lot per PLN honest.

This is an extension of the Sprint 9 Job Split (scheduler/admin → `SplitJobModal` → `split_job` RPC → `job_splits`), not a greenfield build, but it is a **distinct operation** and gets its own RPC (see §4).

---

## 3. Locked decisions

From the scoping exchange with Matt:

1. **Split count** — auto from Job A's current good-piece count, with a confirm screen. Machinist confirms; does not type a number.
2. **Job A → finishing** — the trigger auto-sends Job A's good pieces to finishing so the batch flows to compliance/paperwork hands-free.
3. **Compliance is not a gate here.** Every job still goes to compliance, but for a lot-change child this is a *document-gathering exercise only* — it does not block the machinist. The split has already happened.
4. **Job B is immediately startable.** It lands machine-assigned on the same machine; the machinist starts it right away and enters the new material + lot (which mints Job B's PLN with Lot 2).
5. **Dates never change.** Job B carries Job A's end date/time even if the remainder cannot physically fit before it; nothing is auto-shifted. The situation is surfaced to the scheduler via the renamed **Messages** section's new **Acknowledgements** list (modeled on the shortfalls tab).
6. **Any machinist** can trigger it (no scheduler/admin gate). Applies to standard and re-queue jobs; DTU/maintenance excluded; if the lot ends exactly at target there is no Job B — it is just a normal complete.

---

## 4. Design — how this differs from the existing split, and why dates hold

**Existing split (`split_job`)** redivides *remaining* work: both halves keep machining, the new qty must be strictly `< piecesLeft`, and the original job continues. **Lot-change split** is different on three points:

- The split point is the **good-piece count already made**, not a chosen quantity.
- Job A is **finalized** (sent to finishing), not continued. Its target drops to its made count, so it carries **no shortfall** — the remainder is fully accounted for by Job B (this is the key reason to route through a split rather than a kiosk "complete," which would book a shortfall).
- Job B takes the **entire** remainder (`= piecesLeft`, not `<`).

That difference in validation and in the disposition of the original job is why this gets its own RPC rather than overloading `split_job`. It reuses the same atomic pattern and writes to the same `job_splits` audit table, distinguished by `reason`.

**Why "dates never change" is free:** Job A finishes early and Job B inherits Job A's `scheduled_end`. The machine timeline's endpoint is unchanged, so the propagation walker in `lib/scheduling.js` (`buildPropagatedQueue`) never needs to run — Job B simply fills `[now → Job A's scheduled_end]`, and the next job still starts where it always did. We set Job B's window explicitly and do **not** call the propagated-queue insert. Back-to-back `end == start` with the following job is the already-accepted convention, so no overlap is introduced. If the remainder cannot fit before the inherited end, Job B will read as tight/over-capacity on the board — that is intentional per decision 5, and the scheduler is notified to review.

---

## 5. Batch A — Database

### 5.1 `job_splits` extension (one migration)

Add nullable acknowledgement columns (mirrors the open/closed flag pattern on `job_shortfall_resolutions`):

- `scheduler_ack_at timestamptz`, `scheduler_ack_by uuid` (FK profiles)
- `compliance_ack_at timestamptz`, `compliance_ack_by uuid` (FK profiles)

`reason` already exists; lot-change splits set it to `'material lot change'`. Open scheduler/compliance items are rows where `reason = 'material lot change'` and the respective `*_ack_at IS NULL`.

### 5.2 New RPC `split_job_lot_change(p_job_id uuid, p_reason text)` — SECURITY DEFINER, `SET search_path = public`

Server reads `jobs.good_pieces` for the count (decision 1 — auto, not client-passed, to avoid tampering). All-or-nothing in a single transaction:

1. **Load + validate.** Job exists, `status = 'in_progress'`, machinist owns the active session on the job's machine. Compute effective target via the same chain `split_job`/`SplitJobModal` use (mirror `effectiveQty.js` / `getEffectiveQty`, honoring `qty_override` = prior-WO work already done). Let `made = good_pieces`, `remainder = effectiveTarget − made`.
   - Guard: `made > 0` and `remainder > 0`; otherwise raise (e.g., `remainder = 0` → caller falls back to normal complete; `made = 0` → reject).
   - Guard: job is not DTU/maintenance (`job_number NOT LIKE 'DTU-%'`).
2. **Finalize Job A.** Set `jobs.quantity = made` (its made count → no shortfall), then perform the **same finishing-send the kiosk's `handleFinishingSend` performs**: insert a `finishing_sends` row for `made` pieces carrying Job A's `production_lot_number` (Lot 1 PLN) and `material_lot_number` (Lot 1), and transition Job A to its post-machining status (same transition `handleFinishingSend` applies).
3. **Create Job B.** New `jobs` row:
   - `quantity = remainder`, `status = 'assigned'` (past the pre-mfg gate so it is startable — decision 4), `machine_id = ` Job A's machine, `work_order_assembly_id = ` Job A's,
   - `scheduled_start = now()`, `scheduled_end = ` Job A's `scheduled_end` (decision 5),
   - new `job_number` from the standard sequence; `production_lot_number = NULL` (minted at Start Production when the machinist enters Lot 2),
   - inherit Job A's part/compliance configuration and **auto-pull `part_documents` into `job_documents`** for Job B (same mechanism the S8 Re-queue path uses), so only the new lot's material cert remains to gather.
4. **Audit row.** Insert `job_splits`: `original_job_id = A`, `new_job_id = B`, `original_qty_before = ` Job A's effective target before, `original_qty_after = made`, `new_job_qty = remainder`, `reason = 'material lot change'`, `split_by = ` machinist, all `*_ack_at` NULL.
5. Return `{ new_job_id, new_job_number, remainder, inherited_end }`.

RPC is SECURITY DEFINER because it is machinist-initiated and writes across `jobs`, `finishing_sends`, `job_documents`, and `job_splits`, several of which the machinist role cannot write directly under RLS.

---

## 6. Batch B — Kiosk trigger

`src/pages/Kiosk.jsx`, on the active in-progress job:

- New action **"Material Lot Finished — Switch Lot"** (distinct from existing controls). Visible to any machinist (no `canSplitJobs` gate — decision 6), only when the active job is `in_progress`, not DTU, and `good_pieces > 0`.
- On tap → **confirm modal** (decision 1): "You've made **{good_pieces}** good pieces on lot **{lot1}**. The remaining **{remainder}** will move to a new job to run on a new lot, due by **{Job A's end date/time}**. This job's finished pieces will be sent to finishing. Continue?"
  - If `remainder <= 0`, do not offer the split — direct to normal Complete instead.
- On confirm → `supabase.rpc('split_job_lot_change', { p_job_id, p_reason: 'material lot change' })`.
- On success → reload jobs. Job B is `assigned` on this machine, so it surfaces in the machine's queue; optionally auto-select it as the next job to start. The machinist starts it through the **existing** Start-Production flow — enters the new material + lot, single-lot guard applies as normal, and `generateProductionLotNumber` mints `PLN-<lot2>-YYMMDD-NNNN`.

No change to the start/material/PLN code shipped June 3 — Job B rides it unchanged.

---

## 7. Batch C — Scheduler "Messages" + compliance paperwork

### 7.1 Schedule.jsx — rename to **Messages**, add **Acknowledgements**

- Rename the SKY57 schedule-change-requests panel/section to **"Messages"** and restructure it into two sub-sections:
  - **Change Requests** — the existing SKY57 queue (`changeRequests` / `schedule_change_requests` / `loadChangeRequests`), unchanged in behavior.
  - **Acknowledgements** (new) — open lot-change splits: `job_splits` where `reason = 'material lot change'` and `scheduler_ack_at IS NULL`. Each row shows original job → new job, part, machine, remainder qty, the inherited end date, and a tight-window flag when `remainder` cannot fit before the inherited end. Per-row **Acknowledge** stamps `scheduler_ack_at/by` and writes an `audit_logs` event `lot_split_acknowledged`. Pattern mirrors `WOLookupShortfalls.jsx` (`submitAcknowledgePlan`).
- Realtime: extend the existing channel (or add one) to refresh on `job_splits` changes.

### 7.2 ComplianceReview.jsx — **Lot-Change Paperwork** worklist

- New non-blocking section listing open lot-change splits for compliance: `job_splits` where `reason = 'material lot change'` and `compliance_ack_at IS NULL`. Row links to Job B and the new lot; per-row **Paperwork Gathered** stamps `compliance_ack_at/by` + audit event. Same acknowledge pattern.
- This is a heads-up worklist, **not** a gate. The real cert backstop is Job B's normal **post-mfg** compliance review when its finished pieces come through — Lot 2's docs must be present there as for any job. Acknowledging the worklist item just lets compliance get ahead of it.

---

## 8. Edge cases / guards

- `remainder = 0` (made full target on the lot) → no split; normal Complete.
- `good_pieces = 0` → reject (nothing to finalize).
- DTU/maintenance jobs → action hidden and RPC rejects.
- Re-queue jobs → in scope; treated like any in-progress job (effective-target chain already handles `qty_override`).
- Reassignment after split → out of scope; the compliance/scheduling flip already reverts approval on machine reassignment, and Job B is created already machine-assigned.
- Job A shortfall → explicitly avoided: Job A's target is set to its made count, so no shortfall row is generated.

---

## 9. Test plan (test-first, then promote)

Build `Lot_Change_Split_Test_Script.docx` in the S3 Batch D style. Core cases on `test-skynet`:

1. **Happy path** — in-progress job, 1000 target, log 600 good on Lot 1, trigger Switch Lot → confirm shows 600 made / 400 remaining / inherited end. After: Job A qty = 600, finishing_send for 600 with Lot 1 PLN, Job A in post-mfg status; Job B exists, qty 400, `assigned`, same machine, `scheduled_end` == Job A's original end, no shortfall row for Job A, `job_splits` row written with `reason = 'material lot change'`.
2. **Start Job B** — machinist starts Job B, enters Lot 2 → PLN mints `PLN-<lot2>-YYMMDD-NNNN`; single-lot guard still blocks a different lot.
3. **No downstream movement** — confirm the next job on that machine keeps its original `scheduled_start`/`scheduled_end`.
4. **Tight window** — set Job A's end such that 400 cannot fit before it → Job B still carries the end; Acknowledgements row shows the tight-window flag.
5. **Scheduler acknowledge** — row appears under Schedule → Messages → Acknowledgements; Acknowledge clears it and writes `lot_split_acknowledged`.
6. **Compliance worklist** — Job B appears under Lot-Change Paperwork; Paperwork Gathered clears it; Job B's later post-mfg review still requires Lot 2 docs.
7. **Guards** — `remainder = 0` offers Complete not split; `good_pieces = 0` rejects; DTU job has no action.
8. **Permissions** — a plain machinist PIN can trigger it (no scheduler/admin needed).

---

## 10. Open implementation defaults — confirm before build

These are committed in the plan as sensible defaults; flag any you want changed:

- **D-1 — Compliance surface.** Job B is `assigned` (startable) and surfaces to compliance as a **non-blocking worklist** in ComplianceReview, with the hard cert check remaining at Job B's normal post-mfg review. Alternative would be to surface it only at post-mfg (no pre-mfg heads-up at all). *Default: the worklist.*
- **D-2 — Acknowledgement storage.** Acknowledgements are driven off `job_splits` (extended columns) rather than a new generic `messages`/`notifications` table. If you expect "Messages" to grow into a general inbox (multiple message types beyond change-requests + lot-splits), a dedicated table would age better. *Default: extend `job_splits` now, revisit if Messages broadens.*
- **D-3 — Count source.** Server reads `jobs.good_pieces` (machinist confirms, cannot edit). If machinists should be able to adjust the made count at the confirm step, the RPC takes `p_good_pieces` instead. *Default: server-read, confirm-only.*
