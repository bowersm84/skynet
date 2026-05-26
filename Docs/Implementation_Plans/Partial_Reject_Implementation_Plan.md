# Implementation Plan — Partial Reject (Compliance Post-Mfg Review)

**Status:** Planned (own ticket)
**Origin:** Surfaced May 26 2026 during the Production dashboard quality-metrics work —
discovered that Reject currently rejects the *entire* batch with no partial path.
**Related:** Release A dashboard quality metrics (the Rejected count reads
`finishing_sends.compliance_bad_qty` via option B — `bad_qty ?? verified_count` — so partial
reject makes that count exact, no dashboard change needed). `ComplianceReview.jsx`
`handleApproveBatch`. Shortfall/re-queue path (`job_shortfall_resolutions`,
`has_open_shortfall`, `AllocationResolutionModal` requeue).

---

## Context — current behavior

The Post-Mfg compliance review of each batch lives in `handleApproveBatch`
(`ComplianceReview.jsx`), driven off `finishing_sends` rows at
`compliance_status = 'pending_compliance'`. Roger picks **Accept / Rework / Reject** and
enters Good / Bad quantities.

- **Accept** and **Rework** both check in the good pieces (an
  `assembly_component_checkins` row when the job belongs to an assembly) and advance the job
  once total sent ≥ effective target. Rework is *already partial*: good pieces continue, only
  the bad portion goes to rework.
- **Reject** sets `compliance_status = 'rejected'`, `compliance_outcome = 'rejected'`,
  records the qty, then **short-circuits** — no check-in, the job does not advance. The whole
  send is rejected, and because the totals calc filters
  `allSends.filter(s => s.compliance_status !== 'rejected')`, the good pieces in that batch are
  excluded from the job's total. They are effectively lost to the job.

## Problem

Roger needs to reject only the bad portion of a batch (e.g. 5 of 100) while the 95 good
pieces continue forward and the job advances, and the 5 scrapped pieces reduce good output
and open a shortfall so the order is still made whole via re-queue. Today reject is
all-or-nothing.

## Agreed design decisions (locked)

- **Reject becomes quantity-aware.** Bad Quantity = the scrapped count; Good =
  `verified_count − bad` (auto-derive, same pattern as Accept).
- **Full reject** (`bad == verified_count`, `good == 0`) keeps today's behavior exactly:
  nothing checks in, the job does not advance, the send is marked rejected.
- **Partial reject** (`0 < bad < verified_count`): the good pieces check in and advance the
  job *exactly like Accept*; the bad pieces are scrapped (recorded). The send must **not** be
  `compliance_status = 'rejected'` (that excludes the good from the totals calc) — instead use
  `compliance_status = 'approved'` with `compliance_outcome = 'rejected'`, recording
  `compliance_good_qty` and `compliance_bad_qty`.
- **Scrapped qty registers as a shortfall** via the existing `job_shortfall_resolutions` /
  `has_open_shortfall` path, resolvable through `AllocationResolutionModal`'s requeue — the
  same UX April uses for short-completed jobs today.
- **Require a Bad Quantity entry when Reject is chosen** — added here, where it is finally
  meaningful (it mirrors the require-on-Rework rule already shipped in Release A).
- **Dashboard: no change needed.** The Rejected count already uses option B
  (`bad_qty ?? verified_count`); partial reject simply makes `bad_qty` exact.

## Build outline

1. **Diagnosis first (no code yet) — confirm the accounting before touching the flow:**
   - Where are `job_shortfall_resolutions` rows created today (TCO close-out? kiosk
     short-complete?) and what sets `has_open_shortfall`. The reject change must feed the
     *same* trigger, not invent a parallel one.
   - Whether the job-advancement comparison uses **good pieces** or `send.quantity`
     (`totalSentQty` currently sums `s.quantity`). This is the riskiest piece: if it counts
     `quantity`, a partial reject's good=95-of-100 would still count 100 toward target and the
     job could read "complete" while 5 are scrapped. The comparison needs to reflect good
     pieces (`compliance_good_qty` when present, else `quantity`).
   - Confirm `assembly_component_checkins` receives **good only** on a partial reject.

2. **`handleApproveBatch` reject branch** (`ComplianceReview.jsx`, the
   `if (isReject) { … return }` short-circuit and the qty derivation just above it):
   - Compute `good = enteredGood ?? (verified_count − enteredBad)`, `bad = enteredBad`.
   - If `good <= 0` → existing full-reject path (status rejected, short-circuit). Unchanged.
   - Else (partial): set `compliance_status='approved'`, `compliance_outcome='rejected'`,
     `compliance_good_qty=good`, `compliance_bad_qty=bad`; check in `good`; run the same
     accept/rework advancement (totals → `canAdvance` → `nextStatus`); register the scrapped
     `bad` as a shortfall.

3. **Validation:** require a Bad Quantity (≥ 1) when Reject is chosen; cap `bad ≤ verified_count`.

4. **UI:** the Quantity Check note shipped in Release A already covers reject. Add a small
   confirmation when `0 < bad < verified_count` ("Reject 5 of 100 — the remaining 95 will
   continue forward. Continue?") so a partial reject is never accidental.

5. **WO Lookup / Traveler:** surface the scrapped (rejected) qty on the job so April sees why
   the good count is short and can resolve the shortfall.

## Open questions for the design session

1. **Schema:** reuse `compliance_bad_qty` for the scrapped count, or add a dedicated
   `scrapped_qty` / `rejected_qty` column so "rework-bad" vs "rejected-scrap" stay separable
   in reporting? (Lean: reuse `compliance_bad_qty` + `compliance_outcome` to disambiguate;
   add a column only if reporting later needs the split.)
2. **Auto-requeue or manual?** Does a partial reject auto-create the makeup re-queue job, or
   only flag `has_open_shortfall` and let April resolve via `AllocationResolutionModal`?
   (Lean: flag + manual resolve, consistent with current shortfall UX.)
3. **Multi-batch full reject mid-stream:** if one batch of a multi-batch job is fully
   rejected, does the job stay open awaiting the remaining batches, or open a shortfall
   immediately? Confirm against current multi-batch completion semantics.
4. **Other consumers of `compliance_status` / `compliance_outcome`:** the dashboard Accepted
   query filters `compliance_outcome='accepted'`, so `approved` + `rejected` is safe there.
   Audit WO Lookup, traveler, and any assembly readers for the
   `status='approved'` + `outcome='rejected'` combination before shipping.

## Test cases (to formalize into a `.docx` test script)

- Reject 5 of 100 → 95 check in, job advances per routing, 5 recorded as rejected, a
  shortfall of 5 opens; dashboard Rejected += 5 for that part/machine.
- Reject 100 of 100 (full) → nothing checks in, job does not advance, send rejected (today's
  behavior preserved); dashboard Rejected += 100.
- Reject with no Bad Quantity entered → blocked by validation.
- Partial reject on an assembly job → component check-in = good only.
- Multi-batch job: batch A accepted, batch B partial-rejected → job totals and shortfall correct.

## Out of scope (this plan)

- Changing Rework behavior (already partial).
- Reworking the shortfall / re-queue UX itself.
- Pre-manufacturing (`pending_compliance`) review, which uses Accept/Hold/Flag — not Reject.
