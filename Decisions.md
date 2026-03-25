# SkyNet — DECISIONS.md
## Architectural Decisions & Key Design Patterns
### Updated: March 25, 2026 (Sprint 3 Batches A, B & C Complete)

---

## Routing Architecture (3-Tier Copy-Down)

```
ROUTING TEMPLATES (Master Data)        → Reusable starting points by material type
    ↓ copies to (on component create)
PART ROUTING STEPS (per component)     → The "official" routing for this part
    ↓ copies to (on job creation)
JOB ROUTING STEPS (per job instance)   → The live runtime copy, filled during production
```

### Routing Templates
| Template | Steps |
|----------|-------|
| Stainless | Machine Process → Wash → Passivation → Dry |
| Steel | Machine Process → Mineral Spirit Wash → Anticorrosion Bath → Plating |
| Heat-Treat Steel | Machine Process → Mineral Spirit Wash → Heat Treatment → Plating |
| Aluminium | Machine Process → Wash → Dry |

### Step Modification Rules
- Removing = compliance approval required (reason mandatory)
- Adding = immediate, no approval needed
- Completed steps cannot be removed
- Routing is MANDATORY when creating a new component in Master Data

---

## Stock Quantity Model

- `order_quantity` — units committed to customer
- `stock_quantity` — additional units for inventory
- Per-assembly split stored on `work_order_assemblies.order_quantity/stock_quantity`
- Display: "Qty: 700 (500 order + 200 stock)"

---

## Print Package System (Print Hub Pattern)

Single window opens, traveler auto-prints, then individual "Open & Print" buttons
for each PDF document. Avoids browser popup restrictions.

---

## TCO (Total Close Out)

Notes saved to `work_orders.tco_notes`. Records `closed_by` and `closed_at`.
Any user with `can_approve_compliance = true` can complete TCO.

---

## Backup Compliance Officers

`profiles.can_approve_compliance` boolean. True for compliance and admin roles.
Jody and Tom designated as backup approvers.

---

## Soft Deletes

All deletions use soft delete (is_active=false or status='cancelled').
**Exception:** `job_documents` hard DELETE is allowed (RLS policy added) — James
removes incorrect uploads at the finishing station.

---

## RLS DELETE Policy Audit (March 24, 2026)

DELETE policies added to: `job_routing_steps`, `job_tools`, `part_routing_steps`,
`routing_template_steps`, `part_documents`, `part_machine_durations`, `job_documents`

Intentionally no DELETE (soft delete only): `jobs`, `work_orders`, `machines`,
`locations`, `parts`, `work_order_assemblies`, `assembly_bom`, `routing_templates`,
`tools`, `tool_instances`, `finishing_sends`, `job_document_snapshots`,
`machine_downtime_logs`, `document_types`

**Go-live checklist item:** Re-run audit query before launch.

---

## Technology Stack

- **Frontend:** React 18 + Vite + Tailwind CSS
- **Backend:** Supabase (PostgreSQL, Auth, Realtime, RLS)
- **Storage:** AWS S3 with signed URLs
- **Deployment:** AWS Amplify (CI/CD from GitHub main)
- **Domain:** skynet.skybolt.com

---

# Sprint 2 Decisions — March 1, 2026

## Kiosk Session Management

Single-machine login enforced via `kiosk_sessions` table.
**Admin exception:** Admin-role users can be logged into multiple kiosks simultaneously.
Session failures never block operator login (try/catch everywhere).
Force-logout via Realtime subscription + 30-second polling fallback.
30-minute inactivity timeout with 28-minute warning.

## Pause Behavior

Pause ONLY applies to `in_setup`. Jobs in `in_progress` run autonomously on CNC.

## Material Handling

Blanks: `material_type.toLowerCase().includes('blank')` pattern.
Bolt Masters (code starts 'bm'): only show blank material types.
Blank quantity UOM displays as "pieces" not "bars".

## Production Lot Numbers

**Format:** `PLN-YYMMDD-XXXX`
**Trigger:** Generated when machinist clicks "Start Production" (→ `in_progress`).
NOT on material entry — ensures every job gets a PLN even if materials skipped.

## Finishing Sends & Auto-Send

Manual "Send to Finishing" → `is_partial_send = true`
Auto-send on job complete → `is_partial_send = false` (default)
Auto-send calculates remaining qty (`job.quantity - total already sent`).

---

# Sprint 3 Decisions — March 25, 2026

## Finishing Station Architecture

**Single Station, Two Tanks:** One "Finishing Station" card on Dashboard.
FIN-1 and FIN-2 shown as status indicators, not separate workstations.
**Route:** `/finishing` — PIN-authenticated, outside main app auth wrapper.
**Multiple active batches:** No limit on concurrent `in_finishing` batches.
**Collapsible cards:** Expand/collapse tracked per batchId in state.
**Job/Station view toggle:** Job view (collapsible cards) or Station view (columns:
Wash | Treatment — Tank 1 | Treatment — Tank 2 | Dry).
**Tank selection:** Chosen when advancing Wash → Treatment, not at login.
**Recent Completions:** Collapsible panel, last 5 days of `finishing_complete` sends.

## Compliance Section Naming

- Pre-mfg: **"Pending Review - Pre-Manufacturing"**
- Post-mfg: **"Pending Review - Post-Manufacturing"** (merged with batch reviews)
- Quantity entry section: **"Quantity Check"** (not "Compliance Review")
- Routing steps: shown in pre-mfg only, NOT in post-mfg

## Post-Manufacturing Compliance Card Layout

Same layout for both job cards and batch cards:
1. Traceability grid (all lot numbers + counts + discrepancy warning)
2. Quantity Check (good qty, bad qty, notes) — optional
3. Required Documents (post-mfg stage, full interactive format)
4. Documents from Pre-Manufacturing (read-only for final review)
5. Approve button

## Lot Number Chain of Custody

**Material Lot #** — vendor's number, manual entry at kiosk.
Path: `job_materials.lot_number` → `finishing_sends.material_lot_number`

**Production Lot # (PLN)** — auto-generated at production start.
Format: `PLN-YYMMDD-XXXX`. Unique per job, permanent.
Path: `jobs.production_lot_number` → `finishing_sends.production_lot_number`

**Finishing Lot # (FLN)** — auto-generated at batch start, confirmed by James.
Format: `FLN-YYMMDD-XXXX`. Persists while same material heat AND same chemicals.
Changes when: material lot changes OR tank chemicals change (James controls).
Path: `finishing_sends.finishing_lot_number` → `jobs.finishing_lot_number`

**Chemical Lot #** — treatment chemical container lot, entered by James.
Persists across batches same as FLN. Stored: `finishing_sends.chemical_lot_number`

## Count Verification

Incoming Count: blank at start (no pre-fill), required.
Verified Count: blank at Dry completion (no pre-fill), required.
ALL discrepancies logged to `audit_logs` — no percentage threshold.

## Batch Labeling (A, B, C...)

Labels show ONLY when genuinely split:
- `is_partial_send = true` (manual send) → show label
- Multiple sends for same job → label all A, B, C by `sent_at` order
- Single auto-send covering full qty → NO label

Batch label computation uses ALL sends for a job (not just pending) via
`allJobSendsMap` state in `ComplianceReview.jsx` — ensures correct sequence
when earlier batches already approved.

## Partial Batch Progression

Each `finishing_sends` advances through compliance independently:
1. Batch completes Dry → `compliance_status = 'pending_compliance'`
2. Job stays at `manufacturing_complete` (not advanced yet)
3. Roger reviews individual batches in merged Post-Mfg Review section
4. Roger approves → `compliance_status = 'approved'`
5. Job advances to `ready_for_assembly` only when:
   - ALL quantity has been sent to finishing (`totalSentQty >= jobQty`) AND
   - This is the first approval (job still at `in_progress` or `manufacturing_complete`)
6. If remaining qty still on machine → job stays `in_progress` on kiosk

Legacy `pending_post_manufacturing` jobs continue through existing job-level flow.
Both paths coexist in the merged Post-Mfg Review section.

## Override Logging

Mandatory reason required for all kiosk overrides before proceeding.
"Skip Materials" and "Skip Tooling" buttons removed. Override modal fires when
"Confirm & Start Production" / "Confirm Tooling" clicked with nothing recorded.
Audit log inserts are fire-and-forget (`.then()`) — never block operator.

Event types: `material_override`, `tooling_override` in `audit_logs`.

## Document Upload at Finishing

All finishing uploads use `document_type_id = '644c26a8-7c13-4939-9e52-130dff278191'`
(Other type) and `status = 'approved'` (auto-approved).
Documents are job-level — shared across all batches for same job.
Roger can reassign "Other" docs to required types via dropdown in compliance review.

## document_types Changes

- "Passivation Card" → "Finishing Card" (code: `finishing_card`)
- "Other" added: id `644c26a8-7c13-4939-9e52-130dff278191`, code `other`

## work_orders Status Constraint

`cancelled` added. Full valid values: `pending, in_progress, ready_for_assembly,
in_assembly, complete, shipped, on_hold, closed, cancelled`

## finishing_sends Table — Complete Sprint 3 Column List

| Column | Type | Description |
|--------|------|-------------|
| finishing_stage | text | wash / treatment / dry |
| stage_started_at | timestamptz | Current stage start |
| finishing_operator_id | uuid FK | James's operator ID |
| finishing_started_at | timestamptz | Batch entered in_finishing |
| finishing_completed_at | timestamptz | Batch reached finishing_complete |
| finishing_lot_number | text | FLN |
| chemical_lot_number | text | Treatment chemical lot |
| incoming_count | integer | James's count at start |
| verified_count | integer | James's count at completion |
| count_discrepancy | integer | verified - incoming |
| verified_by | uuid FK | Who entered verified count |
| verified_at | timestamptz | When verified |
| compliance_status | text | pending_compliance / approved / rejected |
| compliance_approved_by | uuid FK | Roger's user ID |
| compliance_approved_at | timestamptz | When approved |
| compliance_notes | text | Roger's notes |
| compliance_good_qty | integer | Good parts (Roger) |
| compliance_bad_qty | integer | Bad parts (Roger) |
| is_partial_send | boolean | true=manual, false=auto |

## jobs Table — Sprint 3 Columns

| Column | Type | Description |
|--------|------|-------------|
| finishing_start | timestamptz | Renamed from passivation_start |
| finishing_end | timestamptz | Renamed from passivation_end |
| finishing_operator_id | uuid FK | Renamed from passivation_operator_id |
| finishing_notes | text | Renamed from passivation_notes |
| finishing_lot_number | text | Copied from finishing_sends on complete |
| post_mfg_good_qty | integer | Roger's good qty |
| post_mfg_bad_qty | integer | Roger's bad qty |
| post_mfg_notes | text | Roger's notes |
| post_mfg_reviewed_by | uuid FK | Who reviewed |
| post_mfg_reviewed_at | timestamptz | When reviewed |

---

## Backlog Items

| Item | Description | Priority |
|------|-------------|----------|
| Finishing status in WO Lookup | "In Finishing (X pcs)" badge on April's WO Lookup job rows | P2 |
| Assembly partial check-in | Each compliance-approved batch checks into assembly as its own quantity | P1 — Batch D |