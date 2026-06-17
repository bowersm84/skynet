# Nested Assembly (Assembly-within-Assembly) — Implementation Plan

**Status:** Draft for review
**Date:** 2026-06-16
**Author:** Matt Bowers
**Related:** Post-S6 assembly backlog; supersedes the manual MTS workaround logged in D-NEST-WKND01.

---

## 1. Problem

A finished good can contain a component that is *itself* an assembly with its own
bill of materials. The live example:

```
SK2600-2SW  (finished_good)  "Stainless Winged Head"
├─ SK26C2W2        (assembly)      "-2 Winged Stud Assembly"   ← sub-assembly
│  ├─ SK26C2W1     (manufactured)  "-2 Wing Stud"  (needs machining + finishing)
│  ├─ SK26CWING3   (purchased)     "2600 Series Wing"
│  └─ SK2600CGP174 (purchased)     "SK2600 Series Pin 17-4"
├─ SK2600-2C       (purchased)     "2600 Spring"
├─ SK26C           (manufactured)  "2600 Cup Stainless"
└─ SK2600CGP174    (purchased)     "SK2600 Series Pin 17-4"
```

When a customer order for SK2600-2SW is entered, Create Work Order will not let us
schedule manufacture of the SK26C2W1 stud, because the sub-assembly (SK26C2W2) is
filtered out of the buildable component list. The stud — the one part that actually
needs machining and finishing in this tree — becomes unschedulable through the normal
flow.

**Current workaround:** build the stud via a standalone MTS work order and manually
allocate the customer orders to it (D-NEST-WKND01). This is fragile, mis-levels the
demand, and does not scale.

**Goal:** support recursive BOM explosion so that building a finished good (or any
assembly) schedules every manufactured part at every depth, builds sub-assemblies
bottom-up, and rolls them into their parent — all under one work order, with customer
allocations at the top level.

---

## 2. Current-state analysis

### 2.1 Data model (already nesting-capable)

- `parts.part_type` ∈ {`assembly`, `finished_good`, `manufactured`, `purchased`}.
- `assembly_bom (assembly_id, component_id, quantity, sort_order)` — a recursive
  parent→child edge. A `component_id` in one row can be the `assembly_id` in others.
  **The schema already represents arbitrary-depth BOMs.** Nothing stops nesting at
  the data layer.
- `work_order_assemblies` (woa) — one row per assembly being built within a WO
  (status, quantity, order/stock qty, lot, good/bad qty, routing via
  `work_order_assembly_routing_steps`).
- `jobs.work_order_assembly_id` — links a component job to the woa it feeds.
- `assembly_component_checkins (work_order_assembly_id, job_id, quantity_received)` —
  records a component **job** being received into an assembly.

### 2.2 Where the single-level assumption is baked in

| # | Location | Behavior | Why it blocks nesting |
|---|----------|----------|-----------------------|
| 1 | `CreateWorkOrderModal.jsx:1435` | `.filter(bom => bom.component?.part_type !== 'assembly')` | Sub-assembly components are dropped from the buildable list entirely. |
| 2 | `CreateWorkOrderModal.jsx:246-261` | BOM load fetches only one level of `assembly_bom` (direct components + their `part_type`, not their nested BOM). | No data to recurse into. |
| 3 | `CreateWorkOrderModal.jsx:567-690` | Submit creates a woa + jobs only for each top-level `selectedAssemblies` row; jobs created only for that row's direct manufactured components. | No nested woa, no recursion, no parent linkage. |
| 4 | `CreateWorkOrderModal.jsx:448` (`addJobFromBOM`) | Sets component job `quantity = orderQty + stock`; ignores the displayed `×{bom.quantity}` multiplier. | Quantities don't multiply even at one level, let alone cascade through depth. |
| 5 | `assembly_component_checkins` schema | References `job_id` only. | A completed sub-assembly is a **woa**, not a job — it cannot be checked into its parent. **This is the core architectural gap.** |
| 6 | `Assembly.jsx:69` (`computeSupplyQty`) | "Possible assemblies" derived only from component **jobs**' effective qty. | A parent whose component is a sub-assembly has no job to read availability from. |
| 7 | PostgREST 2-level nesting cap (per Decisions.md) | Embedded selects deeper than 2 levels are unreliable. | A naive recursive BOM fetch won't work; needs an RPC/view. |

### 2.3 Root cause

The model stores recursion but the application explodes exactly one level and the
check-in primitive only understands job→assembly, not assembly→assembly. Closing the
gap is three coordinated changes: **recursive explosion** (Create WO), a
**sub-assembly check-in primitive** (schema + compliance/assembly), and
**availability across job- and woa-backed components** (Assembly).

---

## 3. Proposed architecture

### 3.1 Assembly hierarchy inside a work order

Add a self-referential parent link so a WO can hold a tree of assemblies:

- `work_order_assemblies.parent_work_order_assembly_id uuid NULL` (self-FK).
  - `NULL` = top assembly (current behavior, fully backward-compatible).
  - Non-null = sub-assembly whose output feeds the referenced parent woa.

Building SK2600-2SW produces:

```
woa(SK2600-2SW, parent=NULL)
└─ woa(SK26C2W2, parent=SK2600-2SW woa)
   └─ job(SK26C2W1)            ← manufactured leaf, work_order_assembly_id = SK26C2W2 woa
└─ job(SK26C)                  ← manufactured leaf, work_order_assembly_id = SK2600-2SW woa
(purchased parts: no job; tracked as purchased components as today)
```

### 3.2 Sub-assembly → parent check-in (the key decision)

**Proposed (Option A — extend the check-in primitive):**

- `assembly_component_checkins`:
  - add `source_work_order_assembly_id uuid NULL` (FK → work_order_assemblies),
  - make `job_id` nullable,
  - add `CHECK ( (job_id IS NOT NULL) <> (source_work_order_assembly_id IS NOT NULL) )`
    — exactly one source.
- A component **job** clearing compliance checks in via `job_id` (unchanged).
- A **sub-assembly woa** completing checks into its parent via
  `source_work_order_assembly_id` (qty = child `good_quantity`).
- All existing rows (job_id set, source NULL) remain valid — no data migration.

*Rejected — Option B (synthetic phantom job per sub-assembly):* simpler to read in
Assembly.jsx but pollutes the `jobs` table with non-manufactured rows and complicates
scheduling, traveler, and KPI queries. Not recommended.

### 3.3 BOM explosion primitive

PostgREST can't fetch the tree, so add a recursive primitive:

- `explode_bom(p_part_id uuid, p_top_qty int)` — SECURITY DEFINER, recursive CTE,
  returns one row per node: `path` (array of part_ids), `depth`, `parent_part_id`,
  `component_id`, `part_number`, `part_type`, `bom_quantity`, `cumulative_quantity`
  (= product of bom quantities down the path × `p_top_qty`).
- Includes a **cycle guard**: stop descending when a part already appears in `path`;
  return a `cycle = true` flag on that node so the UI can warn instead of looping.
- Used by Create WO (drive the tree UI + submit) and available for validation/tests.

### 3.4 Quantity propagation rules

- Manufactured/sub-assembly node qty = `parent_node_qty × bom_quantity`.
- **Order vs stock:** order qty multiplies through every level (demand-driven). Stock
  qty is entered only at the level the user specifies; default sub-level stock = 0.
  (Confirm — see §7.)
- Fixes the latent `addJobFromBOM` 1:1 bug (#4) as part of the same change: leaf job
  qty now respects `bom_quantity` at its depth.

---

## 4. Work breakdown

All UI changes gated behind `FEATURES.NESTED_ASSEMBLY` (default `false`) so the
current single-level flow is untouched until validated. Coordinates with the existing
`FEATURES.ASSEMBLY_MODULE` gate (nested assembly only matters once assembly is live).

### Batch A — Schema + BOM explosion primitive
- Migration: `work_order_assemblies.parent_work_order_assembly_id`.
- Migration: `assembly_component_checkins` — `source_work_order_assembly_id`, nullable
  `job_id`, one-source CHECK.
- `explode_bom(part_id, qty)` RPC (recursive CTE + cycle guard), granted to
  authenticated.
- Apply to TEST; verify against SK2600-2SW returns the expected 2-level tree with
  correct cumulative quantities.

### Batch B — Create WO recursive explosion (behind flag)
- Replace single-level BOM load (#2) with `explode_bom`.
- Remove the `part_type !== 'assembly'` filter (#1); render the BOM as an expandable
  tree: assembly/finished_good nodes are sub-assembly groups; manufactured leaves are
  job toggles; purchased leaves shown, no job.
- Fix quantity propagation (#4) — leaf qty = cumulative qty from `explode_bom`.
- Recursive submit (#3): walk the tree creating a woa per assembly node (with
  `parent_work_order_assembly_id`) and jobs per manufactured leaf
  (`work_order_assembly_id` = nearest enclosing woa), quantities multiplied. CO
  allocations stay at the top WO.

### Batch C — Sub-assembly check-in + Assembly.jsx
- On sub-assembly woa completion, auto-create an `assembly_component_checkins` row
  into the parent woa via `source_work_order_assembly_id` (mirror the compliance-driven
  job check-in at `ComplianceReview.jsx:601`).
- `computeSupplyQty` (#6): consider both job-backed and woa-backed components when
  computing "possible assemblies."
- Assembly.jsx: surface sub-assemblies bottom-up; a parent woa is blocked
  ("waiting on sub-assembly X") until its child sub-assemblies are complete and
  checked in.

### Batch D — Traveler, lookups, edge cases
- Traveler: sub-assembly woa references its parent; finished-good traveler can list
  the sub-assembly chain.
- WO Lookup / Order Lookup: render the nested woa tree under the WO.
- EditWorkOrderModal: handle nested structure (read at minimum; edit if in scope).
- Cycle/depth guard surfaced in UI; max-depth sanity cap.
- Optional: retire the SK2600-2SW MTS workaround (re-platform onto a proper nested WO).

### Batch E — Close-out
- Test script `.docx` (S3_Batch_D style) covering the SK2600-2SW tree end to end:
  create WO → machine + finish stud → assemble SK26C2W2 → check into SK2600-2SW →
  assemble finished good → TCO.
- Decisions.md entries (D-NEST-##) appended via the CC prompts.
- Spec bump; implementation plan → CLOSED.

---

## 5. Files in scope

- `components/CreateWorkOrderModal.jsx` (load, tree UI, recursive submit, qty fix)
- `components/ComplianceReview.jsx` (sub-assembly check-in trigger parity)
- `components/Assembly.jsx` (supply across job+woa, bottom-up ordering, blocked state)
- `lib/` new helper for tree walk / explosion consumption
- `components/EditWorkOrderModal.jsx`, `lib/traveler.js`, WO/Order Lookup (Batch D)
- Migrations in `Docs/migrations/`; new `explode_bom` RPC

No change to the CO allocation model — allocations remain at the top WO.

---

## 6. Risks & edge cases

- **Check-in CHECK constraint** must accept all existing rows (it does: job_id set,
  source NULL). Verify before PROD.
- **SKY63 / scheduling**: nested jobs schedule like any other job; no overlap-constraint
  interaction expected (jobs, not woa, occupy machines).
- **Partial-batch assembly** (separate backlog item) compounds with depth — a parent
  consuming partial sub-assembly batches. Keep nested explosion independent of that;
  note the interaction for the partial-batch sprint.
- **Cycles / bad BOM data** — guarded in `explode_bom`; surface a warning, never loop.
- **Flag coordination** — `NESTED_ASSEMBLY` layered on `ASSEMBLY_MODULE`; both default
  off. Single-level WOs unaffected when the flag is off (`parent_...` stays NULL).
- **Auto-fulfillment** (still unwired) — out of scope here; nested doesn't change it.

---

## 7. Open decisions to confirm

1. **Check-in model** — proceed with Option A (extend `assembly_component_checkins`
   to reference a source woa)? *(Recommended.)*
2. **Stock-qty propagation** — order qty multiplies through all levels; stock entered
   per level, default 0 at sub-levels. Confirm, or should top-level stock explode into
   sub-component stock too?
3. **Edit scope in Batch D** — does EditWorkOrderModal need full nested-edit, or is
   read-only display of the nested tree enough for v1?
4. **Workaround cleanup** — migrate the existing SK2600-2SW MTS WO onto a proper nested
   WO in Batch D, or leave it as-is and only use nesting going forward?

---

## 8. Out of scope (future)

- Per-batch assembly consumption across levels (existing backlog).
- Auto-fulfillment of CO lines on completion (D-S8-17, deferred).
- BOM editing for nested structures beyond what already exists in the BOM modal.

---

## CLOSEOUT (2026-06-16)

**Status: COMPLETE.** All batches A–D shipped and verified on TEST behind FEATURES.NESTED_ASSEMBLY (requires ASSEMBLY_MODULE=true to exercise).

Delivered:
- **Batch A** — Schema + explode_bom() recursive RPC. work_order_assemblies.parent_work_order_assembly_id self-FK; assembly_component_checkins extended (source_work_order_assembly_id, nullable job_id, XOR CHECK). Migration: Docs/migrations/2026-06-16_nested_assembly_batch_a.sql. (D-NEST-01..04)
- **Batch B** (B1/B2) — Create-WO recursive BOM explosion: NestedBomTree.jsx + lib/nestedAssembly.js. B1 = tree + selection UI; B2 = recursive submit (sub-assembly WOA per node, job per selected manufactured leaf, routing + part-doc pull-forward, job-number threading). (D-NEST-05, D-NEST-06)
- **Batch C** (C1/C2) — Assembly-side consumption: sub-assembly completes to 'complete' and checks into parent; parent readiness treats child sub-assemblies as inputs (BLOCKED until subs complete); computeSupplyQty folds WOA-backed components; sub-only parents no longer skipped. KPI tile aligned to the same readiness (D-NEST-09). (D-NEST-07, D-NEST-08, D-NEST-09)
- **Batch D** (D1/D2/D3) — Surfacing + edge cases:
  - D1: Order Lookup nests sub-assemblies under their parent. (D-NEST-10)
  - D2: Job Traveler "Assembly Genealogy" section across the 4 shared surfaces. (D-NEST-11)
  - D3: Sub-assembly with its own external routing checks into parent when that external work returns. (D-NEST-12)

Confirmed correct & intentionally untouched: finished_good parts are never assembled and never top of a nested tree (finished_good skip + finished_good→pending_tco routing correct).

Deferred (tracked, non-blocking): PrintPackageModal genealogy — it has its own trimmed traveler builder (no CO-section table either).

Live validation target: SK2600-2SW (contains sub-assembly SK26C2W2). Zero assembly_bom rows currently have quantity>1, so the per-node quantity multiply has no current blast radius but is correct for future multi-qty BOMs.
