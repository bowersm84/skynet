# Sprint 9 — Implementation Plan (CLOSED)

**Status:** ✅ Complete. Shipped to TEST and PROD on May 19, 2026.
**Theme:** Compliance / Scheduling workflow flip + Job Split feature.
**Duration:** ~2 hours (single-session sprint).
**Spec bump:** v3.2 → v3.3.

---

## Sprint summary

Two coupled changes shipped together because they solve the same operational problem from two ends:

1. **Workflow flip (Batch A).** Pre-mfg Compliance Review is now gated on machine assignment. Roger doesn't see a `pending_compliance` job until April has put it on a machine. Several documents (machine-specific setup sheets, CAM programs, tooling lists) only make sense once the target machine is known — under the old flow Roger reviewed against the part's master doc set, then April scheduled later, sometimes onto a machine that warranted different docs. The flip puts April first in the chain. Rescheduling an already-approved job onto a different machine reverts it to `pending_compliance` so Roger re-reviews against the new machine's doc set.

2. **Job Split (Batch B).** Productizes the May 2026 manual SQL splits (J-000018, J-000022). Scheduler clicks Split on a job row in WO Lookup, picks a quantity, confirms. Original's quantity reduces; a new job is born in `pending_compliance`. Under Batch A's gate, the new job is invisible to Compliance until April schedules it — natural composition.

The two scenarios driving the sprint were both addressed:
- **Parallel run** (split one job across two machines simultaneously) — handled cleanly: split creates the new job, April schedules it on the second machine, Roger reviews docs against that machine.
- **Mid-flight machine move** (move partial production to a different machine) — same mechanism: split, schedule new job on the new machine, Roger re-reviews. Documents are reset by Batch A on the implicit machine change.

---

## Scope & status

| Item | Batch | Status | Notes |
|------|-------|--------|-------|
| ComplianceReview pre-mfg filter on `assigned_machine_id` | A | ✅ | Hides unscheduled jobs from Roger |
| Compliance card header surfaces machine code | A | ✅ | Data already in loader; just unused |
| Mainframe "Pending Compliance" KPI sync | A | ✅ | Filter pre-mfg branch; post-mfg unchanged |
| `applySchedule()` revertCompliance param | A | ✅ | Clears compliance fields + resets job_documents to pending |
| ScheduleJobModal machine-swap detection + amber warning + confirm | A | ✅ | `window.confirm()` pattern; Save button relabels |
| `public.job_splits` audit table | B | ✅ | With check constraint `before = after + new_qty` |
| `public.split_job()` RPC | B | ✅ | SECURITY DEFINER, role-gated, atomic |
| `SplitJobModal.jsx` component | B | ✅ | Quantity input + reason + workflow callout |
| Split button on WO Lookup job rows (assembly + non-assembly) | B | ✅ | Mainframe.jsx, both paths |
| `src/lib/jobs.js` helper (SPLITTABLE_STATUSES, canSplitJobs, isSplittable) | B | ✅ | Shared between UI and RPC gates |
| Decisions.md entries (D-S9-01, D-S9-02 — workflow flip; S9 Batch B entry — split feature) | C | ✅ | Two entries |
| Spec bump v3.2 → v3.3 (absorbs May 17–18 work + S9) | C | ✅ | Full backlog absorption |
| Closeout plan (this file) | C | ✅ | |
| Test script (.docx) | C | ⏭ Skipped | Manual run-through during build covered A–H verification |

---

## Migration files

- `Docs/migrations/2026-05-19_job_splits.sql` — creates `public.job_splits` table (with check constraint, RLS, SELECT policy for authenticated) and `public.split_job(UUID, INTEGER, TEXT) → UUID` RPC. GRANT EXECUTE to authenticated; permission check in-function via profile role.

No schema migration was needed for Batch A — all column reuse (`compliance_outcome`, `compliance_notes`, `documents_deferred*` on jobs; `status`, `approved_by`, `approved_at` on job_documents).

---

## Files touched

**New files:**
- `src/lib/jobs.js`
- `src/components/SplitJobModal.jsx`
- `Docs/migrations/2026-05-19_job_splits.sql`

**Modified:**
- `src/components/ComplianceReview.jsx` — pre-mfg filter (`assigned_machine_id IS NOT NULL`), card header machine display
- `src/lib/scheduling.js` — `applySchedule()` accepts `revertCompliance` flag
- `src/components/ScheduleJobModal.jsx` — `isMachineSwapRevert` detection, amber Step 3 banner, Save label, confirm gate
- `src/pages/Mainframe.jsx` — KPI filter sync, lucide Split icon import, SplitJobModal/jobs.js imports, splitJobTarget state, Split button on both job row blocks, modal render

---

## Key decisions (captured in Decisions.md, 2026-05-19)

**D-S9-01 — Compliance gated on machine assignment.** Pre-mfg Compliance is filtered by `assigned_machine_id IS NOT NULL`. Hard gate, not a soft preference. Roger has zero visibility into unscheduled work. KPI tile filters likewise.

**D-S9-02 — Reschedule reverts compliance.** When `editMode && status='assigned' && machine_changed`, status → `pending_compliance`, clear `compliance_outcome`, `compliance_notes`, `documents_deferred*` (4 fields), reset all `job_documents.status='pending'` with `approved_by`/`approved_at` cleared. Wholesale document reset (no per-doc machine-specific flag). User-confirmed via amber banner + `window.confirm()`.

**Split feature.** Scheduler+admin only. Allowed statuses: `pending_compliance`, `ready`, `assigned`, `in_setup`, `in_progress`, `manufacturing_complete`. New job at `pending_compliance` with no machine and no schedule. `qty_override` on original preserved (prior-work provenance). Routing steps cloned (skip `removed`); `job_documents` cloned with status='pending' and approved_* cleared. `job_materials` and `job_tools` NOT cloned — both are kiosk-time artifacts; new job starts fresh.

**Entry point: WO Lookup only.** Mainframe machine cards and Schedule grid deferred — narrow start.

**Atomic RPC over client-side orchestration.** Split is a single Postgres function with `FOR UPDATE` lock, status validation, quantity validation, audit row, and clone in one transaction. Frontend just calls `supabase.rpc('split_job', ...)`. Permission check lives in-function via profile role lookup; not RLS.

---

## Verification (live, during build)

Run on TEST against real data. All checks passed.

**Batch A:**
- A. Compliance queue filter — pre-mfg shows only machine-assigned `pending_compliance` jobs ✅
- B. Card header shows machine code in skynet-accent font-mono ✅
- C. Machine swap revert — status flips to `pending_compliance`, compliance + doc fields cleared ✅
- D. Same-machine reschedule does NOT revert ✅
- E. `pending_compliance` reschedule does NOT revert ✅
- F. No console errors on hard refresh ✅
- KPI mismatch caught during testing (6 vs 5) and patched: Mainframe `pendingComplianceJobs` array filtered to require `assigned_machine_id` for pre-mfg branch ✅

**Batch B:**
- A. Build clean ✅
- B. Role gating — machinist/compliance/finishing roles don't see Split button; scheduler/admin do ✅
- C. Happy-path split — original quantity reduces, new job created at `pending_compliance` no machine, routing + docs cloned, audit row written ✅
- D. Compliance invisibility — new (unscheduled) job invisible to Roger; Batch A gate doing its job ✅
- E. Schedule new job → surfaces to Compliance with new machine code in header ✅
- F. Validation edges (qty=0, qty=pieces_left, qty=pieces_left-1) ✅
- G. Direct RPC permission rejection (machinist UUID) ✅
- H. Direct RPC status block (complete job) ✅

---

## Known v1 limitations (deferred)

**Workflow flip (Batch A):**
- `in_setup`/`in_progress` machine swaps don't trigger compliance revert. The right tool for moving an actively-running job to a new machine is the Split feature; the reschedule modal doesn't block the action but doesn't revert either. Latent corner case — relies on user discipline.
- `ready` status code path in `ComplianceReview.handleApproveJob` kept as legacy fallback. Under new rules it won't execute; not ripped out.
- Document reset is wholesale (every doc to pending). No per-doc machine-specific flag exists; safer to re-review all than guess.

**Split feature (Batch B):**
- `pieces_left_to_make` slightly overcounts when batches are mid-finishing (`good_pieces` only updates at job complete). Scheduler can mentally adjust.
- Cloned `job_documents` reference the original job's S3 folder path. Files load fine; folder structure mildly untidy.
- Customer order allocations stay at WO level. Both halves of a split fulfill the same WO — no per-job allocation rebalancing.
- Operator at the original machine isn't notified their target shrank. They'll see the new quantity at the kiosk on next refresh. UX nudge deferred.
- Only entry point is WO Lookup. Mainframe machine card and Schedule grid Split buttons could be added in v1.1.
- No merge-back / undo. Once split, jobs are independent.
- Single split per operation (can't split into 3+ jobs at once). Run twice for that.

---

## Next sprint pointers

**Sprint 10 candidates (not yet committed):**
- Shipping module (long-standing backlog item — new module, new role, integration with TCO close-out)
- Per-batch assembly (currently all component batches must complete before assembly starts; Skybolt operates on partial batches in practice)
- Barcode printing for Material Master (still pending from Sprint 3)
- D-S8-17 auto-fulfill helper wire-up — `src/lib/coFulfillment.js` exists, integrate at `ComplianceReview.handleApproveBatch` and post-mfg accept paths
- Split feature v1.1 — additional entry points (Mainframe machine card, Schedule grid), three-way split, undo

**Infrastructure standing:**
- Git repo migration off Google Drive — flagged corruption risk; needs to move to local SSD
- PIN hashing (bcrypt/argon2) — currently plain text
- Edge Function audit_logs column-name mismatch — silent fail
- Move audit_logs INSERTs behind an Edge Function for forge-INSERT protection
- `tools` / `tool_instances` table drop if confirmed dormant
- Drop `wo_shortfall_resolutions` after one stability cycle (Sprint 8 deprecation)

---

## Files for the record

This plan, `Docs/Decisions.md` (2026-05-19 entries), and `SkyNet_Specification_v3_3.docx` capture the architectural state at sprint close. Implementation plan filename pattern: `S9_Implementation_Plan_CLOSED.md`.
