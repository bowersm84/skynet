# SkyNet — DECISIONS.md
## Architectural Decisions & Key Design Patterns
### Updated: March 25, 2026 (Sprint 3 All Batches Complete)

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

# Sprint 3 Batch D Decisions — March 25, 2026

## Material Master Tab Architecture

Three existing/new tabs serve distinct, non-overlapping purposes and all remain:

| Tab | Table | Purpose |
|-----|-------|---------|
| Materials | `material_types` | Type name list (303 Stainless, Aluminum 6061, etc.). Used as FK everywhere. |
| Bar Sizes | `bar_sizes` | Standard diameter catalog. Used in kiosk dropdowns. |
| Material Master | `materials` (new) | Specific combinations: type + bar size + vendor. The catalog for inventory tracking. |

`materials` is the foundation for future inventory deduction. You cannot track
"how many bars do we have" until you define what a specific stockable item is.

**Base UOM = inches.** Display in inches, feet, or bars as context requires.

## Material Receiving — Vendor-First Flow

Receiving is restricted to combinations that exist in the `materials` table.
Free-text material entry is not permitted.

**Entry order enforced:** Vendor (dropdown from materials.vendor) →
Material (dropdown filtered to that vendor's materials) → Lot # → Quantity → Notes.

Material dropdown is disabled until a vendor is selected. If no vendors are
defined in the materials table yet, a warning is shown instead of the dropdown.

**"Heat lot number" renamed to "Lot #"** — in the DB column (`lot_number`),
all UI labels, state variables, and comments throughout the codebase.

**Bar length not captured at receiving.** This is a future phase concern (needed
for inch-based inventory deduction). The `bar_length_inches` column exists on
`material_receiving` for future use but is not populated by the current UI.

## Machine Type Values

`machines.machine_type` uses **descriptive functional values**, not brand names:

| Value | Machines |
|-------|----------|
| `Lathe` | All Mazaks, all Nexturns |
| `Mill` | Ganesh |
| `Roller` | All Bolt Masters |
| `finishing` | FIN-1, FIN-2 |

These values were already present in the DB before the Batch D script ran.
The script's `WHERE machine_type IS NULL OR machine_type = ''` guard preserved them.
Functional labels are preferred over brand labels for grouping and display.

## Material Lot # — Always Query Fresh

**Pattern:** Never rely on `activeJob.materials` for lot numbers in send operations.
`loadJobs()` does not include a `job_materials` join — `activeJob.materials` is
always `undefined`.

**Correct pattern:** Query `job_materials` fresh from the DB immediately before
inserting a `finishing_sends` record, whether manual send or auto-send on complete.
This was a pre-existing Batch C bug caught during Batch D testing.

## Dashboard Finishing Station Card

Card upgraded from count-only to live batch display:
- **Active batches** (`in_finishing`): one row per batch showing job #, current
  stage (wash/treatment/dry), part number, quantity
- **Pending queue** (`pending_finishing`): count pill only (not individual rows)
- **Tank status dots** moved to card header (saves vertical space)
- Data fetch upgraded from `count: exact` to full record fetch with job join
- `finishingQueueCount` state replaced by `finishingSends` array; active/pending
  split derived in component body

## Barcode Printing — Deferred

Barcode printing for Material Master records is deferred to a future phase.
Each `materials` record will eventually have a printable barcode (Code 128 or QR)
encoding `materials.id`. A "Print Barcode Sheet" button on the Material Master tab
will open a print-ready page. Receiver scans the barcode to pre-fill the vendor,
material type, and bar size on the receiving form automatically.

---

## Backlog Items

| Item | Description | Priority |
|------|-------------|----------|
| Finishing status in WO Lookup | "In Finishing (X pcs)" badge on April's WO Lookup job rows | P2 |
| Barcode printing for Material Master | Print barcode sheet per material/vendor combo; receiver scans to pre-fill receiving form. Encodes `materials.id`. Print button on Material Master tab. | P2 |
| Inventory deduction | Connect kiosk material entry to receiving log; bar counts decrement automatically. Foundation tables exist. | P1 — Sprint 4 |
| Fishbowl import | Deferred from Sprint 1. | P2 |
---

# Sprint 4 Decisions — March 26, 2026

## Master Data → Armory Rename

The Master Data module has been renamed to "Armory" to align
with the SkyNet theme. Fits the function — it is the central
repository where all parts, materials, routing configs, and
operational specs are stored and maintained.

- `src/pages/MasterData.jsx` → `src/pages/Armory.jsx`
- Nav button label: "Master Data" → "Armory"
- Page title/header: "Master Data" → "Armory"
- All imports and references to `MasterData` updated to `Armory`
- Internal page state value (`'masterdata'`) may be updated to
  `'armory'` or left as-is — display strings are the priority
- DB identifiers, table names, and query strings are frozen —
  only display strings and the filename change

## Armory Tab Labels and Count Rules

"Material Master" tab renamed to "Raw Material" inside Armory.

Tab count badges — show only where they signal something actionable:

| Tab | Count shown |
|-----|-------------|
| Products | Always — active product count |
| Parts | Always — active part count |
| Materials | Never — remove badge |
| Bar Sizes | Never — remove badge |
| Routing Templates | Never — remove badge |
| Raw Material | Never — remove badge |
| Inventory | Staging count (rack = null) only; hidden entirely if 0 |
| Receiving | Never — remove badge |

## Dashboard → Mainframe Rename

The main dashboard has grown into a full operational home screen
and is being renamed to reflect that.

- `src/pages/Dashboard.jsx` → `src/pages/Mainframe.jsx`
- Route: `/dashboard` → `/mainframe`
- Nav label: "Dashboard" → "Mainframe"
- All imports in `App.jsx` and nav components updated accordingly

## Dashboard Folder Structure

```
src/pages/
  Mainframe.jsx                    ← renamed from Dashboard.jsx
  dashboards/
    AssemblyDisplay.jsx            ← Sprint 4
    SalesDashboard.jsx             ← future
    ShopFloorDisplay.jsx           ← future
```

Routes for dashboards follow `/dashboards/*` convention.
The Dashboards nav button is a dropdown (admin only) defined
via a DASHBOARDS array for easy future expansion.

## Assembly Pipeline Dashboard

**File:** `src/pages/dashboards/AssemblyDisplay.jsx`
**Route:** `/dashboards/assembly`
Read-only TV display for Jody's assembly area. Two panels:
1. In Finishing — active `finishing_sends` batches not yet approved
2. Ready for Assembly — `jobs` where `status = 'ready_for_assembly'`
Auto-refresh via Supabase realtime. No login gate.

## #50 Cascade/Push Scheduling — Already Delivered

Fully implemented in `Schedule.jsx`. State: `crashAction`,
`conflicts`, `conflictResolutions`, `cascadePreview`.
Options: `return_to_queue` and `push_back`.

## TCO Quality Control Fields

Tom's FAA-mandated tensile/shear testing belongs at TCO
(work-order level, post-assembly) — NOT at post-mfg compliance.

```sql
ALTER TABLE public.work_orders
  ADD COLUMN tco_parts_tested integer,
  ADD COLUMN tco_tensile_pass boolean,
  ADD COLUMN tco_shear_pass boolean;
```

Fields are optional. Warning shown when approving TCO with all
three fields empty — user must confirm to proceed.

## Terminology Alignment — UI Labels Only

DB identifiers frozen. Only display strings change:

| Current label | New label |
|---|---|
| "Component" | "Part" |
| "Assembly" (product type) | "Product" |
| "Assembly BOM" | "Product BOM" |

part_type enum display labels:

| DB value | Display label |
|---|---|
| `manufactured` | "Part (Manufactured)" |
| `purchased` | "Part (Purchased)" |
| `assembly` | "Product (Assembly)" |
| `finished_good` | "Product (Finished Good)" |

Assembly nav tab name unchanged (Phase 2 module).

New/Product modal filters: "New Product" shows only Product
types; "New Part" shows only Part types. Edit modal shows all.

## Inventory Deduction — material_usage Table (Option B)

Kiosk material entry decrements via `material_usage` table.
Never mutates `material_receiving`. Available inventory =
SUM(received) - SUM(used) per material + lot.

```sql
CREATE TABLE public.material_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_receiving_id uuid REFERENCES public.material_receiving(id),
  material_id uuid REFERENCES public.materials(id),
  lot_number text,
  job_id uuid REFERENCES public.jobs(id),
  quantity_used integer NOT NULL,
  quantity_used_inches numeric,
  used_by uuid REFERENCES public.profiles(id),
  used_at timestamptz DEFAULT now(),
  notes text,
  created_at timestamptz DEFAULT now()
);
```

Deduction is fire-and-forget. Never blocks the machinist.
Warns to `audit_logs` if no matching receiving record or if
deduction would go negative.

## Raw Material Inventory Screen

**Location:** New "Inventory" tab in Armory (Master Data).
**Calculation (Option A):** Available = received_inches - used_inches.
Available bars = available_inches ÷ bar_length_inches (received bar length
used as the denominator — Option A).

New DB columns added:
- `material_receiving.rack` (text, nullable) — R1/R2/R3/R4 or null
- `material_usage.quantity_used_inches` (numeric) — bars × bar_length

**Staging:** rack = null means unassigned/staging. Bars can be
received to Staging and assigned to a rack inline from the
Inventory tab via a dropdown in the Assign column.

**Armory tab structure (new):**
- Material Master — definitions only (receiving log removed)
- Inventory — computed available stock view
- Receiving — Raw Material Receiving Log + Log Receipt button
  (moved from Material Master; shows all records, no 90-day filter)

---

## Sprint 4 Session 2 — Decisions (April 10, 2026)

### Schedule List View
- List view is a toggle alongside the existing grid — same page, not a separate route
- List view is per-machine cards in a 2-column grid, grouped by location/brand (same grouping toggle as grid)
- List view is read-only for layout but drag-and-drop is supported for resequencing
- Drag-drop in list view: dropped job snaps to next business-hours slot AFTER the preceding job ends — no forced conflict unless duration genuinely bleeds into the next job
- "Insert after" zones visible as h-8 dashed strips during drag; expand to h-10 with label on hover
- Unscheduled queue jobs draggable onto list view machine cards (opens ScheduleJobModal)
- loadAllScheduledJobs is a separate query from the week-windowed scheduledJobs — status filter only, no date filter
- Active/in-progress jobs stay on list view until manufacturing_complete status

### Compliance Inline with Scheduling
- WOs are schedulable immediately on creation regardless of compliance status
- pending_compliance jobs appear in Schedule unscheduled pool with amber "Compliance Pending" badge
- ScheduleJobModal saves pending_compliance jobs without promoting to assigned
- On compliance approval: if job has assigned_machine_id → status = 'assigned'; otherwise → status = 'ready'
- Kiosk loads pending_compliance jobs in queue but grays them out — non-clickable, amber banner
- handleStartSetup has safety check blocking start if job.status === 'pending_compliance'
- Unschedule handler preserves pending_compliance status (not promoted to ready)

### Kiosk Job Documents
- Documents section always visible on active job panel (not hidden when empty)
- Queued job selection panel shows documents on-demand when job is tapped
- WO Lookup: per-job collapsible document dropdown, loaded on demand, cached per session
- All document views use getDocumentUrl from ../lib/s3 — opens signed URL in new tab
- Machinists can view documents but cannot upload, delete, or approve

### Kiosk Material Modal — Sequential Flow
- Field order: Material Type → Bar Size → Lot Number → Availability Banner → Bar Length → Bars Loaded
- Material Type change cascades: clears bar_size AND lot_number
- Bar Size change cascades: clears lot_number only
- Material Type and Bar Size dropdowns use optgroups: "From Inventory" first, "All Materials/Sizes" second
- Bar Size "From Inventory" uses raw inventory values directly (not cross-referenced with bar_sizes table) — avoids format mismatch between "3/8" and "0.375 dia"
- Lot Number uses HTML datalist for suggestions — free text always allowed
- Pre-fill: single inventory match → auto-fill; multiple matches → clear field, show suggestions; no match → clear field
- Availability banner: if bar length entered and inch data available → shows Math.floor(available_inches / entered_length); if no inch data → shows raw bar count; if no bar length → shows raw bars with hint
- Over-inventory warning on Bars Loaded: amber border + message, never blocks submission
- All inventory logic is non-blocking — machinists can always proceed regardless of inventory state

### Armory Rack Assignment
- Rack select must be controlled (value=) not uncontrolled (defaultValue=) — React onChange unreliable on uncontrolled selects
- Fires handleAssignRack immediately on change — no confirm button
- Root cause was missing RLS UPDATE policy on material_receiving

### RLS Policy Audit
- 14 tables were missing UPDATE policies — all patched April 10, 2026
- Pattern going forward: every new table needs SELECT, INSERT, UPDATE, DELETE policies
- Use USING (true) WITH CHECK (true) for authenticated role as baseline
- Kiosk uses anon key (PIN auth, not Supabase Auth) — tables read by kiosk need anon SELECT policy

### Schedule Module Rename
- Name not yet decided — options: Ops, Command, Dispatch, Grid, Launchpad
- Ops remains recommended (natural shop floor language)