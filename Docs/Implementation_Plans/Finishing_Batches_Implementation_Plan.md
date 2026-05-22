# Implementation Plan — Standalone J-FIN Multi-Batch Finishing

**Status:** Planned (deferred from Batch C, May 21 2026 — reverted from working tree pending design)
**Origin:** SKY52 (James, Finishing) — "James needs Batch capability in FIN jobs"
**Related:** Sprint 3 finishing overhaul, go-live J-FIN auto-approval (v2.7), FLN-NNNNNN sequence

---

## Problem

Standalone finishing jobs (J-FIN-NNNNNN, created via "Start New Job" in the Finishing
station for parts that arrive already machined / from the old process / received) are
currently **single-batch**: "Start New Job" creates one J-FIN job with exactly one
`finishing_send` for the full quantity. There is no way to run a standalone job as
multiple batches (Batch A / B / C) the way machining-sourced jobs already do.

James needs to send a standalone job to finishing in multiple batches — e.g. a 20,000-pc
receipt processed in three passes — with each batch carrying its own finishing lot (FLN)
and progressing through Wash → Treatment → Dry independently, all rolling up to one J-FIN job.

## Why this was deferred

A first cut was built in Batch C (add-batch-to-existing-J-FIN) and reverted. The revert
was not because the approach was wrong, but because Matt wanted to **brainstorm the model
more** before committing — specifically how quantity, batch labelling, and the relationship
between the parent J-FIN job and its batches should behave. This plan captures the agreed
direction and the open questions to resolve in the design session.

## Agreed direction

- **Add batches to an existing J-FIN job** (not split-at-creation). Mirrors the machining
  flow: a J-FIN job can receive additional `finishing_sends` after creation, each a new batch.
- Batch letters **derive from `sent_at` order** (existing mechanism — there is no
  `batch_letter` column; the finishing display already labels A/B/C by send order).
- The parent job's `quantity` / `good_pieces` grow by each added batch's quantity, so the
  job total reflects the sum of its batches rather than a fixed up-front number.

## Build outline (from the reverted Batch C work — for reference)

1. **State** in `Finishing.jsx`: `addBatchTargetJob` ({ id, job_number, part_id,
   part_number, quantity }) — when set, the New Job modal operates in "add batch" mode.
2. **Create handler branch**: when `addBatchTargetJob` is set, skip job creation; insert
   only a new `finishing_send` against the existing `job_id`; bump the parent job's
   `quantity` + `good_pieces` by the batch qty. Rollback path reverts the bump (does NOT
   delete the parent job).
3. **Entry point**: "+ Add Batch" button on standalone batch cards AND in the expanded
   batch detail panel header (only for `batch.is_standalone` with a `job.id`).
4. **Modal**: title shows "Add Batch to {job_number}"; part is prefilled/locked to the
   parent job's part so batches match.

## Open questions for the design session

1. **Quantity model.** Should the J-FIN job's `quantity` be entered up front (and batches
   draw down against it), or should it be purely the running sum of batches (no target)?
   The reverted cut used the running-sum approach. Confirm which matches how James thinks
   about a multi-pass receipt.
2. **`good_pieces` semantics.** For a standalone job, `good_pieces` was bumped at batch
   creation. But "good pieces" normally means verified-through-finishing. Should the bump
   happen at batch *creation* or only at batch *completion* (verified_count)? This affects
   what the Bridge/dashboards count for J-FIN.
3. **FLN per batch.** Each batch should get its own FLN from the global sequence. Confirm a
   second batch on the same job mints a NEW FLN (not reuse the parent's). (Note: the May 21
   phantom-batch cleanup revealed two sends on one job sharing FLN-100034 — worth confirming
   the intended behaviour so batches are individually traceable.)
4. **Material lot per batch.** Standalone batches capture material lot at creation. If
   batches of one J-FIN job can have different material lots, that interacts with the
   Outsourcing Consolidation rule (consolidation requires identical material lot). Decide
   whether a J-FIN job's batches must share one material lot or may differ.
5. **Stop-and-report guard.** The build must detect if it is being re-applied over an
   already-present version and stop, to avoid duplicate plumbing.

## Test cases (to formalize into an S?_Batch_?_Test_Script.docx)

- Add a second batch to an existing standalone J-FIN job → labelled Batch B, own FLN,
  independent Wash/Treatment/Dry progression, parent job quantity increases by batch qty.
- Verify no new J-FIN job number is created when adding a batch.
- Verify the part is locked to the parent job's part in add-batch mode.
- Rollback: a failed add-batch reverts the parent quantity bump and creates no orphan send.
- Interaction: a multi-batch J-FIN job appears correctly in the finishing queue and (if
  applicable) the outsourcing ready-to-send list.

## Out of scope (v1)

- Per-batch quantity editing after creation.
- Splitting an existing single-batch J-FIN into multiple batches retroactively.
