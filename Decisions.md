# SkyNet — DECISIONS.md
## Architectural Decisions & Key Design Patterns
### Updated: Feb 23, 2026 (Sprint 1 Complete)

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

### Document Sources
- Part Documents: master docs from `part_documents` where `is_current=true`
- Job Documents: per-job uploads from `job_documents`

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

## Conditional Passivation

Passivation document requirements in compliance review are only displayed when the
component's routing includes passivation-related steps. This is checked against
the `requires_passivation` flag on the parts table AND the routing step names.

---

## Document Requirements Configuration

Configured per component in Master Data (component edit modal):
- Collapsible "Document Requirements" section
- Each row: Document Type (dropdown) | Required At (stage) | Required (flag)
- Stored in `part_document_requirements` table
- Drives compliance review checklist automatically

---

## Traveler Field Mapping

The paper traveler is replaced by data from multiple SkyNet tables.
No single "traveler" table — data is composed at print time.

| Traveler Field | SkyNet Source |
|---------------|---------------|
| Part Number | parts.part_number |
| Customer | work_orders.customer |
| Order Number | work_orders.wo_number |
| Final Process | Derived: last step in job_routing_steps |
| Manufacturing # | job_materials.lot_number |
| Heat / Lot # | job_materials.lot_number |
| Material | material_types.name (via parts.material_type_id) |
| QA Initial | Future field (not S1) |
| Draw. Rev | parts.drawing_revision |
| TSO Rev | Future field (not S1) |
| Start Date | jobs.actual_start |
| Due Date | work_orders.due_date |
| Routing Steps | job_routing_steps (step_name, station, lot#, qty, date, operator) |
| Notes | work_orders.notes + jobs.notes |

---

## Key Database Facts

### Sprint 1 Schema Additions

**New Tables:**
- `routing_templates` — reusable routing template definitions
- `routing_template_steps` — ordered steps for each template
- `part_routing_steps` — per-component master routing
- `job_routing_steps` — per-job runtime routing with full tracking

**New Columns:**
- `work_orders.stock_quantity` (integer) — additional units for inventory
- `work_orders.tco_notes` (text) — TCO review comments
- `work_orders.closed_by` (uuid FK profiles) — who completed TCO
- `work_orders.closed_at` (timestamptz) — when TCO was completed
- `profiles.can_approve_compliance` (boolean) — backup compliance approver flag
- `parts.material_type_id` (uuid FK material_types) — material type link
- `parts.drawing_revision` (varchar 20) — current drawing revision

### Naming Conventions
- Production jobs: `J-######` (e.g., J-000241)
- Planned maintenance: `DTP-######`
- Unplanned maintenance: `DTU-######`
- Work orders: `WO-YYMM-####` (e.g., WO-2602-0231)

### Soft Deletes
All deletions use soft delete pattern (is_active=false or status='cancelled').
No hard deletes in production data.

### Two-Step Job Cancellation
Job cancellation requires explicit confirmation to prevent accidental data loss.

---

## Packing Slip Document Placement

Supplier packing slip moved from pre-manufacturing compliance to post-manufacturing
compliance stage. Updated in `part_document_requirements.required_at` from
'compliance_review' to 'manufacturing_complete'.

---

## Sprint 1 Action Items Completed

| # | Action Item | Status |
|---|------------|--------|
| 1 | WO form routing display + job creation + step modification | ✓ Complete |
| 2 | MTS for individual components | ✓ Complete |
| 3 | Move packing slip to post-mfg | ✓ Complete |
| 4 | Print for Production (Print Package) | ✓ Complete |
| 5 | Conditional passivation | ✓ Complete |
| 6 | Backup compliance officers | ✓ Complete |
| 30 | TCO cleanup with notes + closed_by | ✓ Complete |
| 31 | Fishbowl import | Deferred to S2 |
| 34 | Document requirements config in Master Data | ✓ Complete |
| 43 | Stock Quantity field | ✓ Complete |
| NEW | Routing Templates UI in Master Data | ✓ Complete |
| NEW | Part Routing in component create/edit | ✓ Complete |
| NEW | Compliance routing review (approve/reject/restore/reset/reorder) | ✓ Complete |
| NEW | Print Package modal + Print Hub workflow | ✓ Complete |

---

## Technology Stack

- **Frontend:** React 18 + Vite + Tailwind CSS
- **Backend:** Supabase (PostgreSQL, Auth, Realtime, RLS)
- **Document Storage:** AWS S3 with signed URLs
- **Deployment:** AWS Amplify (CI/CD from GitHub main branch)
- **Domain:** skynet.skybolt.com (SSL via ACM wildcard *.skybolt.com)

# Sprint 2 New Decisions — March 1, 2026

---

## Kiosk Session Management

**Single-Machine Login:** One operator can only be logged into one kiosk at a time. Logging into Machine B automatically logs out Machine A. If Machine A has a job in `in_setup`, the auto-pause modal fires first. No modal for `in_progress` jobs — CNC machines run autonomously.

**Session Persistence:** Kiosk sessions survive page refresh. On mount, the kiosk checks `kiosk_sessions` for an active session on this machine and restores the operator state. Uses `.maybeSingle()` (not `.single()`) to avoid 406 errors on first visit.

**Force-Logout via Realtime:** `kiosk_sessions` table added to Supabase Realtime publication (`ALTER PUBLICATION supabase_realtime ADD TABLE kiosk_sessions`). When a session is deactivated by another kiosk, the old tab receives the change event and immediately returns to the PIN screen. Polling fallback (every 30 seconds) catches cases where Realtime drops.

**Inactivity Timeout:** 30-minute inactivity timeout on kiosk sessions. Warning banner appears at 28 minutes. Any interaction (click, tap, keypress, scroll) resets the timer.

**Login Must Always Succeed:** Session management is wrapped in try/catch — if session DB operations fail, the operator still gets logged in. Machinists must never be locked out.

## Pause Behavior

**Pause Only During Setup:** Pause (both manual and auto-pause on machine switch) ONLY applies to `in_setup` status. Jobs in `in_progress` run autonomously on the CNC — walking away doesn't stop the machine. No pause button shown during `in_progress`. Auto-pause query filters to `status = 'in_setup'` only.

## Material Handling

**Blanks Material Matching:** Uses `material_type.toLowerCase().includes('blank')` pattern instead of exact match. Supports renamed variants like "Blank Studs - 4000 Series".

**Bolt Master Material Filtering:** Bolt Master machines (code starts with 'bm') only show blank material types in dropdown. All other machines hide blank types. Determined by `machine?.code?.toLowerCase().startsWith('bm')`.

## Production Lot Numbers

**Format:** `PLN-YYMMDD-XXXX` (e.g., PLN-260301-0001). Sequential counter resets per day.

**Generation Trigger:** Auto-generated on first material entry for a job. Uses atomic DB function (`next_lot_number`) with upsert to prevent duplicates from concurrent kiosks.

**Persistence:** `lot_number_sequences` table tracks counters by prefix + date. Production lot number stored on `jobs.production_lot_number`. Persists permanently after job completion.

## Finishing Sends

**Partial Send to Finishing:** Machinists can send partial quantities to finishing while the job stays `in_progress`. `finishing_sends` table captures quantity, production lot number, material lot number, operator, and timestamp per send.

**No Status Change on Send:** Partial sends do NOT change job status. Job stays `in_progress`. Multiple sends allowed. Warning (not block) if total sent exceeds job quantity.

**Complete Job Modal Context:** When completing a job with finishing sends, the modal shows all sends with quantities and times, plus a note: "Enter your total good/bad count for the entire job — including pieces already sent."

**Finishing Sends Realtime:** `finishing_sends` added to Realtime publication for future finishing station use.

## Deferred Items

**Fishbowl Import (#31):** Deferred from Sprint 2. Waiting on sample Fishbowl export file for field mapping. Will revisit when file is available — may slot into S3 or S4.