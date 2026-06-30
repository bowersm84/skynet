# Cancel Work Order — Implementation Plan

**Goal:** When a work order has no remaining valid open jobs, offer to cancel the whole work order — releasing its CO allocations and closing it cleanly — so abandoned or test WOs don't linger open with allocations held against dead WOs. Two entry points: (a) an automatic prompt right after the last open job under a WO is cancelled, and (b) an explicit "Cancel Work Order" action in the WO Lookup / detail view.

---

## Current behavior / the gap

Cancelling the last job under a WO leaves the WO `status` unchanged (open), its `customer_order_allocations` still `is_active=true`, and the CO line still showing units allocated against a now-dead WO. There is no UI path to cancel a WO. (Reproduced with WO-2606-0052: job cancelled, WO stayed open, ROUSH CO line still allocated 300.)

---

## Data model (confirmed)

- `work_orders.status` enum includes `'cancelled'`; `closed_at` / `closed_by` for audit; `notes` for the reason.
- `customer_order_allocations` is **released by `is_active=false` + `deactivated_at` + `deactivated_by`** — never deleted. Established pattern in `EditWorkOrderModal.jsx`, `CustomerOrders.jsx` (line cancel), `AllocationResolutionModal.jsx`.
- `jobs.work_order_id`; an **open job** = `status NOT IN ('cancelled','complete')`.
- `work_order_assemblies` has **no `'cancelled'` status** in its enum; rows are left dormant under a cancelled WO (deleting would cascade `jobs`, `assembly_component_checkins`, `work_order_assembly_routing_steps`; the assembly module is feature-flagged off anyway).
- Releasing an allocation returns the CO line to **unallocated** — `quantity_fulfilled` is unchanged and the CO line `status` does not change. The freed demand reappears in the CO/demand view for re-allocation.
- Other FKs to `work_orders`: `outbound_sends`, `job_shortfall_resolutions` — surfaced as guards (see edge cases).
- **The Active WO Lookup keys off job status + recency, NOT `work_orders.status`.** Setting `status='cancelled'` alone does not remove a WO from the Active tab — a WO whose jobs are all terminal and was created within the last 7 days still shows there via the "recently completed" branch. **D-WOLOOKUP-CANCELLED01** (shipped) adds a `status NOT IN ('cancelled','closed')` pre-filter to the active lookup; that filter is the mechanism that makes a cancelled WO actually leave Active and surface under Closed. This cancel feature **depends on** that filter to be visibly effective — without it, cancelling a WO would update the status but the WO would linger in Active for 7 days (exactly the confusion this feature is meant to remove).

---

## Core operation — `cancel_work_order` RPC (recommended)

A single `SECURITY DEFINER` RPC, `cancel_work_order(p_wo_id uuid, p_reason text)`, doing the whole thing in one transaction (atomicity matters — a half-cancel that closes the WO but leaves the allocation active is worse than no cancel). Reusable from both UI entry points, and runs with elevated rights so the allocation/job writes work regardless of the caller's RLS.

In order, inside one transaction:
1. **Authz guard** — caller must be an allowed role (admin / scheduler / compliance — confirm set). Raise if not.
2. **State guard** — raise if the WO is already `cancelled` / `shipped`. If any `outbound_sends` exist for the WO, block with a clear message (product already shipped — cancel is not appropriate).
3. **Cancel remaining open jobs** — `jobs` under the WO with `status NOT IN ('cancelled','complete')` → `'cancelled'`. Makes the RPC idempotent whether or not the caller already cancelled the last job.
4. **Cancel the WO** — `status='cancelled'`, `closed_at=now()`, `closed_by=auth.uid()`, append `p_reason` to `notes`, `updated_at=now()`.
5. **Release allocations** — active `customer_order_allocations` for the WO → `is_active=false`, `deactivated_at=now()`, `deactivated_by=auth.uid()`.
6. **Leave `work_order_assemblies` dormant** (no enum value to cancel).
7. **Return a summary** — `{ jobs_cancelled, allocations_released, units_released, co_lines_touched }` so the UI can confirm what happened.

(Existing patterns deactivate allocations client-side, so a frontend-only version is possible — but the multi-table write is exactly the case where partial failure bites, so the RPC is preferred.)

---

## "Valid open work" — the trigger condition

A WO is eligible for the cancel prompt when it has **no open jobs** (`status NOT IN ('cancelled','complete')`) **and** no active assembly rows in progress (`work_order_assemblies.status` in an active state). Assembly WOs must count assembly progress as work, not just jobs — don't auto-prompt to cancel a WO whose assembly is mid-build. A brand-new WO with zero jobs yet is not auto-prompted either (the prompt fires *after a job cancel*, not on an empty WO); the explicit button (entry point B) covers the "WO has nothing under it" case.

---

## UI — two entry points

### A. Auto-prompt after cancelling the last open job
- Hook the existing job-cancel action (Mainframe job detail — the cancel near the "Cancelled jobs cannot be restarted" copy). After a successful job cancel, query the WO's remaining open jobs + active assembly rows.
- If none and the WO isn't already `cancelled`/`complete`/`shipped`, open the confirm modal: *"WO-XXXX has no remaining open jobs. Cancel the work order too? This releases N unit(s) allocated on M customer-order line(s)."*
- On confirm → `cancel_work_order(wo_id, reason)` → refresh.

### B. Explicit "Cancel Work Order" button in WO Lookup (Mainframe)
- In the SKY87 WO rollup, when the WO has no open jobs and isn't already cancelled, show a "Cancel Work Order" button.
- Opens the same confirm modal (with allocation-release impact) → `cancel_work_order`.

### Confirm modal (shared)
Shows: the WO, count of open jobs that will be cancelled (should be 0 on path A), and **the allocation impact** — N units across which CO lines will be released back to unallocated — plus a required/optional reason field appended to the WO notes.

---

## Edge cases / decisions

- **Active CO allocations:** the modal must state how many units on which CO lines return to unallocated, so the scheduler knows the demand needs re-allocation (it already resurfaces in the CO/demand view).
- **Completed jobs / shipped product:** if any `outbound_sends` exist, block the cancel (already shipped). If there are `complete` jobs but no sends, allow but warn that production occurred.
- **Assembly WOs:** "open work" = open jobs OR active assembly rows; don't auto-prompt mid-assembly.
- **The CO line itself:** releasing the allocation does **not** cancel the customer's line — if the CO was also test data, that's a separate cancel on the Customer Orders page.
- **Audit:** `closed_by` / `deactivated_by` = actor; reason appended to WO `notes`.
- **Closed-tab visibility (verify):** after cancel, the WO must remain findable under the Closed tab. Confirm the `search_closed_work_orders` RPC includes `status='cancelled'` (not just `'closed'`/`'complete'`); if it filters them out, extend it so cancelled WOs stay searchable in Closed.

---

## Build order

1. `cancel_work_order` RPC — TEST, then PROD.
2. Entry point B (explicit button in WO Lookup) — simplest, exercises the RPC end-to-end.
3. Confirm modal with allocation-release impact (shared).
4. Entry point A (auto-prompt after the last open job is cancelled).

## Out of scope / follow-on

- Hard-deleting WOs (not recommended; cancel is the model).
- Cancelling the customer's CO line (separate Customer Orders action).
- A `'cancelled'` status on `work_order_assemblies` (would let assembly rows be explicitly cancelled rather than left dormant) — optional later cleanup.
