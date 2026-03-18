# SkyNet — DECISIONS.md
## Architectural Decisions & Key Design Patterns
### Updated: March 18, 2026 (Sprint 3 Batches A & B Complete)

---

## Routing Architecture (3-Tier Copy-Down)

Routing defines the ordered process steps a component goes through during manufacturing.
It uses a copy-down pattern where each level is independent after copying.

```
ROUTING TEMPLATES (Master Data)        → Reusable starting points by material type
    ↓ copies to (on component create)
PART ROUTING STEPS (per component)     → The "official" routing for this part
    ↓ copies to (on job creation)
JOB ROUTING STEPS (per job instance)   → The live runtime copy, filled during production
```

### Routing Templates (seed data — 4 material types)
| Template | Steps |
|----------|-------|
| Stainless | Machine Process → Wash (Sink) → Passivation (Ultrasonic Cleaner) → Dry (Fan) |
| Steel | Machine Process → Mineral Spirit Wash → Anticorrosion Bath (Zerust Axxanol) → Plating |
| Heat-Treat Steel | Machine Process → Mineral Spirit Wash → Heat Treatment → Plating |
| Aluminium | Machine Process → Wash (Sink) → Dry (Fan) |

### Step Modification Rules
- **Removing a step** = requires compliance officer approval (reason mandatory)
- **Adding a step** = immediate, no approval needed (additive, not reducing controls)
- **Compliance officers** can remove steps directly (no approval flow needed for compliance)
- **Completed steps** cannot be removed
- **Restore step** = compliance can undo a removal while job is in pending_compliance
- **Reset to Default** = compliance can restore all steps to match part_routing_steps master
- Routing is MANDATORY when creating a new component in Master Data

### Step Types
- `internal` = performed in-house (Wash, Dry, Passivation, Machine Process)
- `external` = sent to outside vendor (Plating, Heat Treatment)

### Step Status Values
- `pending` — awaiting execution
- `in_progress` — currently being performed
- `complete` — finished
- `removal_pending` — removal requested, awaiting compliance approval
- `removed` — step removed from routing
- `skipped` — step bypassed

### Tables
- `routing_templates` + `routing_template_steps` — reusable templates
- `part_routing_steps` — per-component master routing
- `job_routing_steps` — per-job runtime copy with production data (lot#, qty, operator, dates)

---

## Stock Quantity Model

Work orders support two quantity fields:
- `order_quantity` — units committed to customer order
- `stock_quantity` — additional units for inventory replenishment

Total manufactured = order_quantity + stock_quantity

For MTS (Make-to-Stock) orders, order_quantity = 0 and only stock_quantity is used.

Display format: "Qty: 700 (500 order + 200 stock)"

Floor workers can see the split to prioritize committed orders during urgent situations.

Per-assembly order/stock split is stored on `work_order_assemblies.order_quantity` and
`work_order_assemblies.stock_quantity` — not derived by calculation from WO totals.

---

## Make-to-Stock for Individual Components

MTS orders support both assemblies AND individual manufactured components.
When an MTS order selects a manufactured component (not an assembly):
- A single job is auto-created
- No `work_order_assemblies` record is created
- The component flows through manufacturing → compliance → TCO like any other job

---

## Compliance Routing Review

The compliance review includes a full routing section with:
- Visual display of all job_routing_steps with status indicators
- Approve/reject removal requests from CS
- Add new steps directly (no approval needed)
- Remove steps directly (compliance privilege)
- Restore removed steps (undo removal)
- Reset to Default (restore to part_routing_steps master)
- Reorder steps (up/down arrows)
- "Routing Reviewed" checkbox — required before job approval
  - Disabled until: all docs approved AND no pending removal requests remain

---

## Print Package System

### Print Hub Pattern
Browser popup restrictions (Chrome allows only one window.open per user gesture) require
a single-window approach:

1. User clicks "Print Selected" → ONE new window opens
2. Traveler renders as HTML at top → auto-triggers browser print dialog
3. Below traveler: "Documents to Print" section with individual "Open & Print" buttons
4. Each button is a separate user gesture → browser allows PDF tab to open
5. PDFs open in native browser PDF viewer (correct orientation + pagination)

### Print Package Modal Access Points
- Compliance Review → "Approve & Print" button (approves job + opens print package)
- Compliance Review → Print icon on approved/unassigned jobs
- Work Order Lookup → Print button on each job row

### Traveler Format
- Landscape orientation via `@page { size: landscape }` CSS
- Header: part info, customer, job/WO/PO numbers, dates, quantities
- Body: routing steps table with blank columns for floor data entry
- Three blank rows for floor-added steps
- Footer: print timestamp

---

## TCO (Total Close Out)

- TCO notes: optional textarea saved to `work_orders.tco_notes`
- Records `closed_by` (user ID) and `closed_at` (timestamp) on approval
- Recently Closed section: last 5 closed WOs, collapsible, default collapsed
- Any user with `can_approve_compliance = true` can complete TCO

---

## Backup Compliance Officers

The `profiles.can_approve_compliance` boolean flag allows any user to approve:
- Compliance reviews (pre-mfg and post-mfg)
- TCO close-outs
- Routing step removal requests

Set to `true` by default for compliance and admin roles.
Jody and Tom designated as backup approvers.

---

## Soft Deletes

All deletions use soft delete pattern (is_active=false or status='cancelled').
No hard deletes in production data.

---

## Two-Step Job Cancellation

Job cancellation requires explicit confirmation to prevent accidental data loss.

---

## Packing Slip Document Placement

Supplier packing slip moved from pre-manufacturing compliance to post-manufacturing
compliance stage. Updated in `part_document_requirements.required_at` from
'compliance_review' to 'manufacturing_complete'.

---

## Technology Stack

- **Frontend:** React 18 + Vite + Tailwind CSS
- **Backend:** Supabase (PostgreSQL, Auth, Realtime, RLS)
- **Document Storage:** AWS S3 with signed URLs
- **Deployment:** AWS Amplify (CI/CD from GitHub main branch)
- **Domain:** skynet.skybolt.com (SSL via ACM wildcard *.skybolt.com)

---

# Sprint 2 Decisions — March 1, 2026

---

## Kiosk Session Management

**Single-Machine Login:** One operator can only be logged into one kiosk at a time.
Logging into Machine B automatically logs out Machine A. If Machine A has a job in
`in_setup`, the auto-pause modal fires first. No modal for `in_progress` jobs — CNC
machines run autonomously.

**Session Persistence:** Kiosk sessions survive page refresh. On mount, the kiosk checks
`kiosk_sessions` for an active session on this machine and restores the operator state.
Uses `.maybeSingle()` (not `.single()`) to avoid 406 errors on first visit.

**Force-Logout via Realtime:** `kiosk_sessions` table added to Supabase Realtime
publication. When a session is deactivated by another kiosk, the old tab receives the
change event and immediately returns to the PIN screen. 30-second polling fallback.

**Inactivity Timeout:** 30-minute inactivity timeout on kiosk sessions. Warning banner
appears at 28 minutes. Any interaction resets the timer.

**Login Must Always Succeed:** Session management is wrapped in try/catch — if session DB
operations fail, the operator still gets logged in.

**Finishing Station Session Integration:** The finishing station (`/finishing`) also
participates in `kiosk_sessions`. Logging into the finishing station deactivates any
active kiosk session for that operator, and vice versa. Same Realtime listener pattern
as production kiosks.

## Pause Behavior

**Pause Only During Setup:** Pause ONLY applies to `in_setup` status. Jobs in
`in_progress` run autonomously. No pause button shown during `in_progress`.

## Material Handling

**Blanks Material Matching:** Uses `material_type.toLowerCase().includes('blank')` pattern.

**Bolt Master Material Filtering:** Bolt Master machines (code starts with 'bm') only show
blank material types. All other machines hide blank types.

**Quantity UOM for Blanks:** When a material type contains 'blank', quantity is displayed
as "pieces" not "bars" throughout the kiosk UI.

## Production Lot Numbers

**Format:** `PLN-YYMMDD-XXXX` (e.g., PLN-260301-0001). Sequential counter resets per day.

**Generation Trigger (UPDATED Sprint 3):** Auto-generated when the machinist clicks
"Start Production" (transition to `in_progress`), NOT on material entry. This ensures
every job gets a PLN regardless of whether the machinist loads material before starting.
If `production_lot_number` is already set (e.g., from a prior partial entry), it is not
overwritten.

**Persistence:** `lot_number_sequences` table tracks counters by prefix + date.
Production lot number stored on `jobs.production_lot_number`. Persists permanently.

## Finishing Sends

**Partial Send to Finishing:** Machinists can send partial quantities to finishing while
the job stays `in_progress`. `finishing_sends` table captures quantity, production lot
number, material lot number, operator, and timestamp per send.

**No Status Change on Send:** Partial sends do NOT change job status. Job stays
`in_progress`. Multiple sends allowed.

**Auto-Send on Job Complete:** When a machinist clicks "Complete Job," the system
automatically calculates remaining quantity (`job.quantity - total already sent`) and
creates a `finishing_sends` record for any remainder. If the machinist already sent
everything manually, no record is created (remainder = 0).

---

# Sprint 3 Decisions — March 18, 2026

---

## Finishing Station Architecture

**Single Station, Two Tanks:** The Dashboard shows one "Finishing Station" card (not one
card per tank). Both physical tanks (FIN-1, FIN-2) are tracked in the `machines` table
with `machine_type = 'finishing'` but appear as status indicators within the single card,
not as separate workstations. Launch button on the card opens `/finishing`.

**Route:** `/finishing` — standalone PIN-authenticated page, not under the main app auth
wrapper. Same pattern as `/kiosk/:machineCode`.

**Batch Model (not job model):** James works on `finishing_sends` records, not jobs
directly. A single job may have multiple sends (partial quantities sent across the day).
Each send goes through the full Wash → Treatment → Dry cycle independently.

**Multiple Simultaneous Active Batches:** There is no limit on the number of batches
James can have active (`in_finishing`) at the same time. He routinely runs multiple
batches at different stages simultaneously. The active batches panel shows all
`in_finishing` records, each independently advanceable.

**Collapsible Batch Cards:** Active batch cards can be collapsed to save screen space.
Collapsed state shows: job number, part number, current stage badge, duration timer.
Expanded state shows full detail and the advance/complete button. Cards start expanded
by default. Collapse state is tracked per batch ID in component state.

**Job/Station View Toggle:** The active batches panel has a toggle between:
- **Job view** (default) — collapsible cards, one per batch
- **Station view** — three columns (Wash | Treatment | Dry), showing which batches
  are at each stage. No advance/complete buttons in station view — read-only.

**Tank Selection at Treatment (not at login):** When James advances a batch from Wash to
Treatment, a tank selection modal appears asking which physical tank (FIN-1 or FIN-2)
the batch is going into. Tank is stored on the `finishing_sends` record. No session-level
machine selection — tank is chosen per batch at the Treatment step.

**Job Status After Finishing:** When all `finishing_sends` for a job reach
`finishing_complete`, the parent job automatically advances to
`pending_post_manufacturing`. This triggers appearance in Roger's post-mfg compliance
queue. Jobs remain at `manufacturing_complete` while any sends are still in-progress.

**Dashboard Compliance Counter:** Only counts `pending_compliance` and
`pending_post_manufacturing`. Does NOT include `manufacturing_complete` — those belong
to finishing, not Roger's queue.

---

## Lot Number Chain of Custody

Three lot numbers travel with every batch through the system. All three appear on the
`finishing_sends` record for full chain-of-custody traceability.

### Material Lot # (vendor traceability)
- Source: vendor's heat/cert number, entered by machinist at kiosk during material loading
- Stored on: `job_materials.lot_number`, carried to `finishing_sends.material_lot_number`
- Persistence: stays with the material bar stock — does not change per job
- System behavior: entered manually, never auto-generated
- Lot blocking: once a lot number is set on a job, all subsequent materials must use the
  same lot (compliance requirement). Mismatches are blocked and logged to `audit_logs`.

### Production Lot # (PLN — job traceability)
- Format: `PLN-YYMMDD-XXXX` (e.g., PLN-260318-0003)
- Source: auto-generated by `next_lot_number('PLN', datePart)` RPC
- Trigger: generated when machinist clicks "Start Production" (transition to `in_progress`)
- Stored on: `jobs.production_lot_number`, carried to `finishing_sends.production_lot_number`
- Persistence: tied to the job — unique per job, never reused
- Dies: permanently associated with the job after completion, never reopened

### Finishing Lot # (FLN — finishing batch traceability)
- Format: `FLN-YYMMDD-XXXX` (e.g., FLN-260318-0007)
- Source: auto-generated by `next_lot_number('FLN', datePart)` RPC, confirmed by James
- Trigger: generated/suggested when James starts a batch in the finishing station
- Stored on: `finishing_sends.finishing_lot_number`, copied to `jobs.finishing_lot_number`
  on batch completion
- Persistence rule: **FLN persists across multiple batches as long as the same material
  heat AND the same tank chemicals are in use.** System defaults to the most recent active
  FLN (queried from most recent non-completed `finishing_sends` record with a lot number).
- Resets when: material lot changes OR chemicals change (James generates new via "New" button)
- Override: James can always manually edit the FLN field or click "New" to generate fresh
- Fallback: if `next_lot_number` RPC fails, timestamp-based fallback is used

### Chemical Lot # (chemical traceability)
- Source: lot number from treatment chemical containers in the tank, entered by James
- Stored on: `finishing_sends.chemical_lot_number`
- Persistence: pre-filled from most recent `finishing_sends` record with a chemical lot
- Captured at: Start Batch modal, alongside FLN and incoming count
- Relationship to FLN: when chemical lot changes, James should also generate a new FLN.
  System displays reminder but does not enforce this automatically — James's judgment.

---

## Count Verification at Finishing

Two count entry points per batch:

**Incoming Count (at batch start):**
- James physically counts parts received from the machinist
- Entered in Start Batch modal; pre-filled with `finishing_sends.quantity` (machinist's
  send quantity) as a starting point — James must consciously change if different
- Stored on: `finishing_sends.incoming_count`
- Discrepancy warning shown inline if count differs from send quantity (not a block)

**Verified Count (at batch completion):**
- James counts good parts after finishing is complete
- Entered in completion modal at the Dry stage; field starts blank (not pre-filled)
  to force conscious entry
- Required — cannot complete batch without entering a verified count
- Stored on: `finishing_sends.verified_count`
- `count_discrepancy` = verified_count - incoming_count (negative = parts lost)
- `verified_by` and `verified_at` recorded on completion
- Discrepancy warning shown inline if count differs from incoming count (not a block)

**Discrepancy Logging:** ALL discrepancies (any non-zero difference) are logged to
`audit_logs` with `event_type = 'finishing_count_discrepancy'`. No percentage threshold —
even 1 part difference is logged. Report filtering by percentage is a reporting-layer
concern, not a capture-layer concern.

---

## finishing_sends Table — Sprint 3 Columns Added

In addition to Sprint 2 columns (job_id, machine_id, sent_by, quantity,
production_lot_number, material_lot_number, status, notes, sent_at):

| Column | Type | Description |
|--------|------|-------------|
| finishing_stage | text | Current stage: wash, treatment, dry |
| stage_started_at | timestamptz | When current stage began |
| finishing_operator_id | uuid FK profiles | James's operator ID |
| finishing_started_at | timestamptz | When batch entered in_finishing |
| finishing_completed_at | timestamptz | When batch reached finishing_complete |
| finishing_lot_number | text | FLN auto-generated at batch start |
| chemical_lot_number | text | Treatment chemical lot, entered by James |
| incoming_count | integer | James's count of parts received |
| verified_count | integer | James's count of good parts after finishing |
| count_discrepancy | integer | verified_count - incoming_count |
| verified_by | uuid FK profiles | Who entered the verified count |
| verified_at | timestamptz | When verified count was entered |

---

## jobs Table — Sprint 3 Columns Added

| Column | Type | Description |
|--------|------|-------------|
| finishing_start | timestamptz | Renamed from passivation_start |
| finishing_end | timestamptz | Renamed from passivation_end |
| finishing_operator_id | uuid FK profiles | Renamed from passivation_operator_id |
| finishing_notes | text | Renamed from passivation_notes |
| finishing_lot_number | text | Copied from finishing_sends on batch complete |

---

## Backlog Items Identified in Sprint 3

| Item | Description | Priority |
|------|-------------|----------|
| Finishing status in WO Lookup | Show "In Finishing (X pcs)" cyan badge on job rows in April's WO Lookup when finishing_sends records exist for that job. Query finishing_sends grouped by job_id, sum quantities by status, display inline. | P2 |