# Implementation Plan — Missed Production Entries (Pre-System Production Log)

**Status:** Planned (own ticket)
**Origin:** Surfaced May 28 2026 diagnosing the Production Dashboard override bug. The
job-level `qty_override` scalar is being misused to record pre-system / carried-over
production, where it freezes the produced count and (if made additive) double-counts parts
that also flow through SkyNet. Matt's direction: replace the override-for-missed-pieces use
with a first-class production *entry* that sits alongside the other logs.
**Related:** `getEffectiveQty` (Mainframe, duplicated in `Assembly.jsx` + `SplitJobModal.jsx`);
Production Dashboard numerator/denominator; the seven existing `qty_override` rows.

---

## Context — what's wrong with override-as-it-is-today

`qty_override` is a single scalar on `jobs`. In `getEffectiveQty` it is the first branch and
**wins over everything** — once set, the produced count returns the override and stops looking
at outsourcing returns, approved batches, or the machinist count. So it **freezes**: J-000021
has made 3,086 (`good_pieces`) but shows 2,000 (the override). On the Production Dashboard it's
worse — the override is read as the *denominator* (`target = qty_override ?? quantity`), pinning
the goal to the override instead of the real order.

The audit of all seven existing overrides shows they are uniformly **legacy-WO carryover**
("Existing WO", "Carry over", "Started previously", "created under WO") — not recount/replacement
corrections. But they overlap with SkyNet-tracked production (J-000029's override production lot
2600-050126 matches its finishing batches; J-000021/J-000025 have `good_pieces` ≈ or > the
override), which is why neither freeze nor a naive additive sum is correct.

## Problem

Compliance needs to record parts **built before SkyNet was live** (or otherwise never captured
by the system) so they count toward a job's produced total — without freezing the count and
without double-counting parts that SkyNet *does* track. The recorded quantity should sit
**alongside the other production logs** (the finishing batches) and the live count should keep
climbing as real parts flow through machining and finishing.

## Why an entry, not a scalar override

A genuinely pre-system part will never appear in SkyNet's finishing/machining logs (the system
didn't exist when it was made). So a discrete "missed production" record summed alongside the
real logs is additive by construction and cannot double-count — provided the discipline holds:
**a missed entry is only for parts SkyNet will never otherwise track.** That discipline is what
the current scalar lacks; making it a logged entry with a reason makes the intent explicit.

## Agreed design decisions (confirm in session)

- **New record, not a scalar.** A missed-production entry is a row tied to a job, summed into
  the produced count like any other log — never a frozen replacement.
- **Additive into the produced count.** `produced = normal chain (getEffectiveQty) + SUM(missed
  entries)`. The override-wins-frozen branch is removed.
- **Dashboard.** Numerator includes missed entries (consistent with Mainframe, per the earlier
  decision); denominator becomes the real order qty (`j.quantity`), not the override.
- **Retire `qty_override` for this use.** Keep the column initially (don't drop) to support the
  per-job migration; stop reading it once the seven rows are migrated. (Open question: keep it
  for any genuine replacement-correction use? The audit shows none.)
- **Traceability.** Entries capture production lot / passivation lot + reason (the existing
  override reasons already carry these — AS9100 needs them preserved).
- **Migration is per-job, manual.** Do NOT auto-convert overrides to entries. Convert only the
  truly pre-system ones; retire the override on jobs SkyNet already counts.

## Build outline

1. **Diagnosis first — per-job override classification.** Before any migration, produce a
   diagnostic per existing override: override value vs what SkyNet has actually logged for that
   job (good_pieces, approved finishing batches with their lots, outbound returns). This lets
   Roger mark each: (a) pre-system → convert to a missed entry; (b) already in SkyNet → retire
   the override, no entry. This step gates the data migration.
2. **Migration / table** — new table `missed_production_entries`:
   - `id`, `job_id` (FK jobs), `quantity`, `reason` (required), `production_lot`,
     `passivation_lot`, `created_by` (FK profiles), `created_at`.
   - RLS mirroring the override permission (compliance + admin write; authenticated read),
     matching the established convention.
3. **Count logic — extract + change `getEffectiveQty`:**
   - Extract the duplicated helper (Mainframe `getEffectiveQty`, `Assembly.jsx` 71–72,
     `SplitJobModal.jsx` 16) into one `lib/` function so the three can't drift.
   - Remove the `qty_override`-wins branch; add `+ SUM(missed entries)` to the result. Callers
     fetch the entries alongside the existing job data.
4. **UI — create + display:**
   - Replace the Mainframe override modal with an "Add Pre-System / Missed Production" entry
     form (quantity, reason*, production lot, passivation lot).
   - Show entries alongside the batches in WO Lookup (e.g. a "Pre-system: N pcs (lot …)" line)
     so the produced total is transparent.
5. **Dashboard:**
   - Numerator via the shared helper (includes missed entries); denominator `j.quantity`. The
     dashboard query fetches missed entries + the richer finishing shape the helper needs.
6. **Retire override reads** once the seven rows are migrated; leave the column in place for a
   release before considering a drop.

## Open questions for the design session

1. **Keep `qty_override` at all** after this, for genuine replacement-corrections ("recount
   confirmed 615 not 620"), or retire it fully? (Audit shows zero such uses today.)
2. **Compliance status on entries** — pre-system parts presumably need no SkyNet compliance
   workflow; recorded as trusted/good by Roger. Confirm.
3. **Display placement** in WO Lookup and Mainframe — inline with batches, or a separate
   "pre-system" sub-section?
4. **Permissions** — compliance + admin only (mirrors today's override), or wider?
5. **Multiple entries per job** allowed (e.g. two legacy WOs feeding one job), or one?

## Test cases (to formalize into a `.docx` test script)

- Create a missed entry of N on a job → produced count rises by N immediately; entry shows
  alongside batches with its lot + reason.
- A new finishing batch on the same job → produced keeps climbing (entry + batches), no freeze.
- Pre-system-only job (no SkyNet batches) → produced = entry qty; dashboard shows entry/quantity.
- Dashboard numerator matches Mainframe produced for the same job.
- Migration: J-000023 (all pre-system) → one entry of 96,625, override retired, total unchanged.
- Migration: J-000029 (override overlaps finishing lot) → override retired, NO entry, total =
  SkyNet batches only (no double-count).

## Out of scope (this plan)

- Replacement-correction overrides (separate decision; not in the data today).
- Changing how finishing batches or outsourcing returns are counted.
- Hard-dropping the `qty_override` column (defer one release past migration).
