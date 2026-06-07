# SkyNet MES — Raw Material Checkout Kiosk Implementation Plan

**Feature — Raw Material Issuing (Checkout) Kiosk, v1**

Implementation Plan v1.0 · June 3, 2026

**Owner:** Matt Bowers
**Status:** Design complete (June 3 2026 design session). Build deferred — to be slotted into a future sprint. One hard prerequisite before build: settle the `job_materials` table ownership with the in-flight job-start material-lot gate (see §3, §11).

---

## 1. Goal

Stand up a tablet kiosk at the raw-material area where material is **issued to a job** — recording the lot, bar length, and number of bars — so that:

1. Raw-material consumption is captured at the point of physical issue (accurate tracking), and
2. Material is *pushed* to jobs at issue time rather than relying on machine check-ins that get missed when the machinist is busy.

v1 is the **issuing/lot-capture layer only**, deliberately decoupled from raw-material *inventory* accounting (balances, received-stock validation, reorder), which is a later phase. The aim is to form the habit and capture the traceability link (heat/lot → job → WO → CO → customer) first.

---

## 2. Background

Today there is no system capture of which raw material (which lot/heat, how many bars) goes into a job. For FAA / AS9100 traceability that link is exactly what auditors want, and it's currently a manual gap. The proposal moves the capture to the natural moment — the machinist standing at the rack pulling bars.

A binding constraint shaped the design: **not all machines have kiosks yet** (kiosk rollout is roughly a month from complete). A "record at the machine kiosk" model fails on non-kiosk machines. So the rack kiosk is built as a **universal staging device** that works for every machine regardless of kiosk presence, with the machine kiosk and the finishing-completion screen as additional read/finalize points over the same record.

The June 3 design session settled the data model, the entry points, the completion/reconciliation flow, and the double-entry handling. This plan captures that for a later build.

---

## 3. Status & Prerequisites

- **Design:** complete (this document).
- **Build:** not started; deferred to a future sprint.
- **Hard prerequisite — single source of truth for the material lot.** A separate change is in progress that will block a job from starting at the machining kiosk without a material lot entered. That lot must live in the `job_materials` row defined here, and the gate must read/write it. Before building, confirm the gate change has **not** stood up its own material storage that would have to be reconciled. If it has, we align on one table first.
- **Confirm at build (do not guess — see §7.3):** the `materials` (Material Master) PK/columns used for selection; the exact Finishing.jsx completion path that sets `manufacturing_complete`; the kiosk PIN-auth mechanism reused here.

---

## 4. Scope

### 4.1 In scope (v1)

- Rack kiosk: stage material to a job (running **or** queued, so machinists can get ahead on incoming work).
- One material record per job: one lot, one length, a running bar count.
- Machine-kiosk check-in: confirm staged material at job start (satisfies the start-lot gate); reload / manual add with a "nothing staged" warning.
- Mandatory completion finalize on **both** completion paths (machining kiosk and Finishing.jsx), with confirm-or-correct of the loaded count and remnant capture.
- Closed-job reconciliation: allow checking a late-found leftover bar against a completed job, with a notice and machinist judgment.
- Lot captured as entered/selected (free text or off the bar tag) — for traceability and the start gate.
- Feature-flagged single-area pilot; machinist PIN auth.

### 4.2 Out of scope (later phases)

- Raw-material inventory balances, on-hand tracking, validation of lots against `material_receiving`, reorder — the "in" side.
- Barcode / lot scanning (this is what later makes double-entry airtight; ties to the Material Master barcode-printing roadmap).
- Remnant → stock returns (v1 records remnants as a number only).
- Multiple lots per job (explicitly **one lot per job**).
- Per-issue-event audit child table (single row + stamps in v1).

---

## 5. Decisions Locked

| ID | Topic | Decision |
|----|-------|----------|
| D-JUN03-01 | Universal device | The rack kiosk is a pure **staging** device — it never "loads" a machine; staging is its only write. It works for every machine regardless of kiosk presence. Chosen because kiosk rollout is incomplete and we need one solution now. |
| D-JUN03-02 | Issue target | Material is issued to the **job**, not the machine (no tracking ambiguity). The kiosk surfaces the machine's **running + queued** jobs so machinists can stage ahead. |
| D-JUN03-03 | Record shape | **One material row per job**, `UNIQUE(job_id)`. One lot, one length, a single running bar count. The unique constraint is the DB-level backstop against duplicate rows. |
| D-JUN03-04 | Length & count | Length chosen **once** per job (all bars same length); bar count entered separately. On reload, lot + length **auto-fill**; only the added count is entered. |
| D-JUN03-05 | Authority point | **Completion is the authoritative, mandatory reconciliation.** It supports confirm-staged **or** enter-from-scratch, lets the operator **correct** the loaded count to physical reality, and captures remnants. Consumed = corrected loaded − remnants. |
| D-JUN03-06 | Completion homes | Same record, two homes: kiosk machines finalize at the machining-kiosk completion step; non-kiosk machines finalize on James's existing Finishing.jsx "set complete" path (unchanged behavior, material finalize added). |
| D-JUN03-07 | Manual add guard | Manual bar add at a kiosk machine is allowed, but warns when nothing is staged ("No bars staged for this machine — add manually?"). A nudge toward the staging habit, not a hard gate — completion is the gate. Supports both the diligent machinist and the one who catches up at the end. |
| D-JUN03-08 | Enforcement symmetry | Kiosk machines enforce a lot at **start** (the separate gate). **Every** machine enforces material at **completion**. Non-kiosk jobs flip to `run` via Finishing.jsx on the first batch (after machining), so there's no start moment to gate — the lot rides in via rack staging and is enforced at James's completion. |
| D-JUN03-09 | Double-entry | Handled by relocating authority to completion (confirm/correct + visible records), **not** per-keystroke prevention. Airtight prevention is deferred to barcode/lot scanning. |
| D-JUN03-10 | Closed-job check-in | Check-in is allowed against completed/closed jobs for late-found leftover bars. The kiosk shows a notice ("complete · X bars · Y remnants recorded"); the machinist decides missing vs already-captured. Late check-ins are tagged (who/when) and recorded as **returns** (never inflate consumed). |
| D-JUN03-11 | Remnants | Reported at completion; usually zero (bars run out ~9/10). James's closing step is unchanged — he checks, enters remnants if any; absence of an entry means none. |
| D-JUN03-12 | Inventory decoupled | v1 records issues, lots, and remnants as standalone data — no balances, no validation against received stock. Inventory accounting is a later phase that reads these records. |
| D-JUN03-13 | Auth | Machinist PIN, reusing the existing kiosk auth mechanism. |

---

## 6. Data Model

### 6.1 New table — `job_materials` (one row per job)

```sql
create table job_materials (
  id                 uuid primary key default gen_random_uuid(),
  job_id             uuid not null unique references jobs(id) on delete cascade,
  material_master_id uuid references materials(id),         -- nullable in v1
  lot_number         text,                                  -- traceability + start gate
  bar_length         numeric,                               -- one length per job
  bar_length_unit    text not null default 'in',
  bars_loaded        integer not null default 0,            -- running issued/loaded count
  bars_remaining     integer,                               -- remnants; null until finalized
  status             text not null default 'staged',        -- 'staged' | 'loaded' | 'finalized'
  staged_by          uuid references profiles(id),
  staged_at          timestamptz default now(),
  finalized_by       uuid references profiles(id),
  finalized_at       timestamptz,
  reconciled_by      uuid references profiles(id),          -- late closed-job check-in
  reconciled_at      timestamptz,
  notes              text,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
```

- **Derived consumed** (not stored): `bars_loaded - coalesce(bars_remaining, 0)`.
- `UNIQUE(job_id)` enforces one row per job (D-JUN03-03). One lot / one length fall out of the single row (D-JUN03-04).
- Row stays editable after completion to support closed-job reconciliation (D-JUN03-10); `reconciled_*` stamps flag post-close edits.
- `material_master_id` is nullable so v1 can capture a lot off the bar tag even before Material Master coverage is complete.

### 6.2 RLS

- Enable RLS. Mirror the existing kiosk-writable tables. Machinist (and admin) roles get INSERT + a **full** UPDATE policy (the audit history shows missing UPDATE policies cause silent failures). SELECT scoped to the roles that read it (kiosk, finishing, scheduler, admin).
- Run the standing RLS audit before go-live.

### 6.3 Deferred

- A `material_issue_events` child table (per stage/reload/finalize/reconcile event, with deltas + who/when) if per-reload granularity is wanted later. v1 keeps the single row + stamps.
- Inventory linkage: a later phase ties `job_materials` issues to `material_receiving` lots and maintains on-hand balances.

---

## 7. Code Changes

### 7.1 New files

- `src/pages/MaterialKiosk.jsx` — the rack kiosk. Machinist PIN → pick machine → see its running + queued jobs → select a job → stage material (pick `materials` master, enter lot + length + bars). Also hosts the machinist finalize/remnant path and the **closed-job reconciliation** entry (search a completed job → notice → record found bar).
- `src/components/MaterialStageModal.jsx` — stage / add bars (length once, count; reload auto-fills lot+length).
- `src/components/MaterialFinalizeModal.jsx` — confirm-or-correct loaded count + enter remnants (shared by the kiosk completion step and Finishing.jsx).
- `src/components/ClosedJobMaterialNotice.jsx` — "complete · X bars · Y remnants recorded" notice + record-as-return action (tagged late).
- `src/lib/materialIssues.js` — pure helpers (derive consumed, validate, format). No DB calls; unit-testable. Mirrors `machineStatus.js` / `salesMetrics.js`.

### 7.2 Modified files

- `src/pages/Kiosk.jsx` — start step surfaces staged material to confirm (hooks the start-lot gate); manual-add warning when nothing staged; completion step opens `MaterialFinalizeModal`.
- `src/pages/Finishing.jsx` — at the point James's batch flow sets `manufacturing_complete`, require the material finalize (`MaterialFinalizeModal`) — confirm/correct + remnants. Same record as the kiosk path.
- `src/config.js` — add `FEATURES.MATERIAL_KIOSK` (default `false`).
- `src/App.jsx` — route + launch entry for `MaterialKiosk` (tablet URL near the material area).
- **In-flight gate change** — point it at `job_materials` as the single source of truth (per §3).

### 7.3 Critical names — confirm, do not guess

- `materials` is the Material Master table (`material_type`, `bar_size` seen in Armory.jsx); `material_receiving` is the existing receiving log. Confirm the PK + the columns used for the selection list.
- Confirm the exact Finishing.jsx branch that sets `manufacturing_complete` (the non-kiosk completion home) so the finalize hangs on the right action.
- Confirm the kiosk PIN-auth path reused for the rack kiosk.
- `job_routing_steps.status` uses `'complete'`; jobs use `'manufacturing_complete'` for machining-done (already relevant to scheduling).

---

## 8. Workflows

- **Stage (rack, any machine):** PIN → machine → pick a running/queued job → select material + lot + length + bars → row created `staged`.
- **Start (kiosk machine):** the start step shows the staged row; operator confirms (gate satisfied) and runs. If nothing's staged, he enters it there (gate satisfied), creating the row.
- **Reload / manual add (kiosk machine):** add bars; lot + length auto-fill. If nothing was ever staged, the "add manually?" warning fires (nudge), but the add is allowed.
- **Completion finalize (kiosk machine):** `MaterialFinalizeModal` — confirm or **correct** the loaded count to actual, enter remnants (usually 0). Mandatory before close.
- **Completion finalize (non-kiosk, James in Finishing.jsx):** same modal/flow on James's set-complete path. He checks for remnants, enters if any. Mandatory before close.
- **Closed-job reconciliation:** find the completed job → notice ("complete · X bars · Y remnants") → machinist decides: already-captured → skip; missing → record as a tagged return (doesn't inflate consumed).

---

## 9. Claude Code Prompt Batches

- **Batch A — schema + helper + flag.** `job_materials` migration + RLS (TEST → verify → PROD). `src/lib/materialIssues.js`. `FEATURES.MATERIAL_KIOSK` in `src/config.js`.
- **Batch B — rack kiosk (staging).** `MaterialKiosk.jsx` + `MaterialStageModal.jsx`: PIN → machine → running/queued jobs → stage.
- **Batch C — machine-kiosk integration.** `Kiosk.jsx`: start-step staged-material confirm + start-gate hook; manual-add warning; reload (auto-fill lot/length).
- **Batch D — completion finalize + closed-job reconciliation.** `MaterialFinalizeModal.jsx` wired into both `Kiosk.jsx` completion and `Finishing.jsx` set-complete; `ClosedJobMaterialNotice.jsx` + reconciliation path on the rack kiosk.
- **Batch E — pilot + docs + deploy.** Flip the flag for one material area; append D-JUN03-01..13 to `Docs/Decisions.md`; add the spec section (§5.NN); merge `feature/material-kiosk` → test → main.

---

## 10. Test Checklist

- Stage at the rack → appears on the job at the machine kiosk.
- Start with staged material → single confirm satisfies the start-lot gate and runs.
- Start with nothing staged → enter-at-start works and satisfies the gate.
- Manual add with nothing staged → warning shown; add still allowed.
- Reload → lot + length auto-filled, only count entered; count increments the one row.
- Completion finalize (kiosk) → confirm path and **correct** path both write; remnants recorded; consumed = loaded − remnants.
- Completion finalize (non-kiosk via Finishing.jsx) → same outcome on James's set-complete.
- Double-entry scenario → stage 5 + manual-add 3, then correct to actual at completion → final number matches physical reality.
- Closed-job check-in → notice shows recorded bars + remnants; record-as-return is tagged late and does not change consumed.
- RLS → machinist can insert/update; other roles scoped; no silent UPDATE failures.
- Capture rate → fraction of completed jobs with a `job_materials` row (the pilot's success metric).

---

## 11. Risks & Open Items

- **Single source of truth (blocking):** the in-flight start-lot gate must read/write `job_materials`, not a parallel store. Resolve before build (§3).
- **Material Master coverage:** if parts carry a required-material spec, the kiosk can pre-fill/validate against the chosen job; confirm whether they do. If not, v1 is free selection from `materials` + lot entry.
- **Double-entry not airtight without scanning** — accepted for v1; completion confirm/correct is the backstop; barcode/lot scanning closes it in a later phase.
- **Adoption / behavior change** — mitigated by the pilot + the capture-rate metric.
- **Non-kiosk remnant knowledge** — James may not see remnants at his bench; the rack finalize (machinist returning leftover bars) is the preferred reporting point, with James's step as the mandatory backstop.
- **RLS audit** required before go-live.

---

## 12. Spec & Documentation Updates

- **Spec section at build close** (per convention — spec bumped at close, not before): add a new `§5.NN — Raw Material Checkout Kiosk` to the SkyNet Specification `.docx` (Node `docx`, existing house style).
- **Decisions:** append `D-JUN03-01` … `D-JUN03-13` to `Docs/Decisions.md` (renumber to the prevailing scheme if the feature is slotted into a numbered sprint, e.g. `D-S11-NN`).
- File this plan alongside the other implementation plans.

---

## 13. Deferred / Future Phases

- **Raw-material inventory tracking** — on-hand balances, validating lots against `material_receiving`, reorder triggers; reads the `job_materials` issue records as the consumption side.
- **Barcode / lot scanning** — scan the bar/lot tag to stage and to confirm at the machine; makes double-entry airtight. Ties to the Material Master barcode-printing roadmap.
- **Remnant → stock returns** — turn the captured remnant count into stock movements once inventory is live.
- **`material_issue_events`** child table for per-event audit granularity.
