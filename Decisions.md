# SkyNet MES — DECISIONS.md
# This file is context for AI coding assistants (Claude Code, etc.)
# Update after every design decision or schema change.
# Last updated: 2026-02-20

---

## Project Overview
- **App**: SkyNet MES for Skybolt Aeromotive Corp
- **Stack**: React 18 + Vite, Supabase (DB + Auth + Realtime), AWS S3 (file storage), AWS Amplify (deployment)
- **URL**: skynet.skybolt.com
- **Repo**: github.com/bowersm84/skynet

---

## Current Sprint: S1 — Foundation & Work Orders (Weeks 1–2)
**Goal**: Lock down WO form, compliance workflow fixes, master data. April and Roger can start creating real WOs.

### S1 Action Items (updated with routing scope)
| # | Item | Lead | Type | Effort |
|---|------|------|------|--------|
| 1 | WO form: display routing on job selection, copy to job_routing_steps, step removal request flow, step addition on in-progress jobs | April | Modify | XL |
| 43 | Add Stock Quantity field to WO form | April | Modify | S |
| 2 | Support make-to-stock for individual components (not just assemblies) | April | Modify | M |
| 3 | Move supplier packing slip from pre-mfg to post-mfg compliance | Roger | Modify | S |
| 4 | Print for Production — print traveler from job_routing_steps data | Roger | New | M |
| 5 | Make passivation card conditional (requires_passivation flag) | Roger | Modify | S |
| 34 | Configure required documents per component in Master Data | Roger | New | M |
| 30 | Keep TCO as-is; ensure Roger or Tom can complete final review | Roger | Modify | M |
| 31 | Fishbowl import script (small test set only for now) | Roger | Config | L |
| 6 | Backup compliance officers — Jody and Tom can approve post-mfg | Roger | Modify | S |
| NEW | Routing Templates UI in Master Data (create/edit templates + steps) | Roger | New | M |
| NEW | Part Routing in component create/edit (mandatory, load from template) | Roger | New | L |

---

## MB Decisions (Feb 13, 2026) — DO NOT OVERRIDE
These are Matt's decisions. They take precedence over any earlier spec versions.

1. **TCO Placement**: Keep TCO as-is. No separate Tom QC step. TCO = final gate.
2. **Finishing Overhaul**: Phase 1. Rename Passivation → Finishing. Every component goes through finishing (some passivation, others just wash/dry). Stage config per component in master data.
3. **Material Tracking**: ALL Phase 1. Base UOM = **inches**. System provides conversions to feet, bars, and weight.
4. **Assembly**: Phase 2. Must support stock-to-assembly path when activated. Need Fishbowl confidence first.
5. **Lot Change Handling**: Block lot changes on active job. Machinist completes partial, new job created for new lot.
6. **Dark Run / Idle Time**: Don't log as downtime. DO track idle time as separate metric.
7. **Jody QC**: NO separate QC software step. Visual inspection stays manual. TCO is only post-assembly gate.
8. **Assembly Pause**: Assemblers can pause anytime. Auto-pause after set afternoon time. Starting new assembly auto-pauses previous.
9. **Fishbowl Accuracy**: Needs improvement in ALL areas, not just legacy items.

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
- **Completed steps** cannot be removed
- Routing is MANDATORY when creating a new component in Master Data

### Step Types
- `internal` = performed in-house (Wash, Dry, Passivation, Machine Process)
- `external` = sent to outside vendor (Plating, Heat Treatment)

### Tables
- `routing_templates` + `routing_template_steps` — reusable templates
- `part_routing_steps` — per-component master routing
- `job_routing_steps` — per-job runtime copy with production data (lot#, qty, operator, dates)

---

## Key Database Facts

### Schema Location
- Live schema dump: `docs/schema.sql` (update after every migration)
- Supabase project dashboard for SQL execution

### Important Tables & Relationships
- `work_orders` → has many `jobs` (fan-out pattern)
- `work_orders` → has many `work_order_assemblies` (assembly tracking)
- `jobs` → belongs to `work_orders`, optionally to `work_order_assemblies`
- `parts` table stores BOTH assemblies and components (distinguished by `part_type`: assembly, manufactured, purchased, finished_good)
- `assembly_bom` links assemblies to components (both reference `parts.id`)
- `part_document_requirements` controls which docs are required per part at which stage
- `part_documents` stores master documents (drawings, specs) for parts
- `job_documents` stores per-job compliance documents
- `profiles` table links to `auth.users` — roles: admin, compliance, machinist, assembly, display, scheduler, customer_service

### Parts Table — Key Columns
- `parts.requires_passivation` (boolean, default false) — controls passivation card in compliance
- `parts.material_type_id` (FK to material_types) — what material this part is made from
- `parts.drawing_revision` (varchar) — current drawing revision letter (e.g., "Q")
- Sprint 3 will expand `requires_passivation` to full finishing stage config

### New S1 Columns
- `work_orders.stock_quantity` (integer) — available stock qty (April's 500/800 split)
- `profiles.can_approve_compliance` (boolean) — backup compliance officers (Jody, Tom)

### Job Status Flow
```
pending_compliance → ready → assigned → in_setup → in_progress → 
manufacturing_complete → pending_passivation → in_passivation → 
pending_post_manufacturing → ready_for_assembly → in_assembly → 
pending_tco → complete
```
Also: incomplete, cancelled

### Work Order Status Flow
```
pending → in_progress → ready_for_assembly → in_assembly → complete → shipped → closed
```
Also: on_hold

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

## Naming Conventions
- **Components** = individual manufactured parts (UI should say "components" not "parts")
- **Assemblies** = finished products made from components
- **Finishing** = the post-machining process (replaces "Passivation" in Sprint 3)
- Note: Action #12 (S4) will do a full UI terminology alignment

---

## File Structure — Key Files
```
src/
  components/
    CreateWorkOrderModal.jsx  ← S1 primary target (#1, #43, #2)
    ComplianceReview.jsx      ← S1 targets (#3, #5, #6, #30)
    TCOReview.jsx             ← S1 target (#30)
    EditWorkOrderModal.jsx
    Assembly.jsx              ← Phase 2
    BOMUpload.jsx
  pages/
    Dashboard.jsx
    Kiosk.jsx                 ← S2 targets
    MasterData.jsx            ← S1 target (#34, #31)
    Schedule.jsx              ← S2 targets
    Secondary.jsx             ← S3 target (Finishing overhaul)
    Login.jsx
  lib/
    supabase.js               ← Supabase client config
    s3.js                     ← AWS S3 file upload helpers
```

---

## Supabase Workflow for Schema Changes
1. Design the change here (document new columns, tables, constraints)
2. Write SQL migration in Claude Code
3. Run SQL in Supabase Dashboard → SQL Editor
4. Update `docs/schema.sql` with new dump
5. Update this file if the change affects decisions or conventions

---

## When to Update This File
- After ANY schema change (new table, column, constraint)
- After ANY design decision that affects multiple files
- After ANY MB decision or scope change
- After completing a sprint (update "Current Sprint" section)
- When a convention is established (naming, patterns, etc.)