# SkyNet Sprint 3 — Implementation Plan
## Finishing Overhaul & Material Tracking
### Originally: March 1, 2026 | Updated: March 18, 2026

---

## Sprint Goal
Transform the passivation module into a full Finishing station with multi-stage processing.
Implement inch-based material tracking. This is the largest sprint and the most complex
domain overhaul.

## Foundations from Previous Sprints
- **S1 Routing System:** `routing_templates` + `job_routing_steps` provide the step-based
  processing framework that finishing stages will build on
- **S2 `finishing_sends` table:** Partial sends from manufacturing kiosks feed into the
  finishing queue (status = `pending_finishing`)
- **S2 Production Lot Numbers:** `jobs.production_lot_number` carries through to finishing
  for chain-of-custody traceability
- **S2 `lot_number_sequences` table:** Reusable for finishing lot number generation
  (prefix = 'FLN')

---

## Action Items

| # | Action Item | Lead | Type | Effort | Status |
|---|-------------|------|------|--------|--------|
| 21 | Rename Passivation to Finishing; implement multi-stage process | James | Modify | XL | ✅ Batch A |
| 22 | Add second finishing machine in system | James | Config | S | ✅ Batch A |
| 24 | Add production lot + finishing lot number fields | James | Modify | M | ✅ Batch B |
| 25 | Add DOWN indicators for finishing machines | James | Modify | S | ✅ Batch A |
| 53 | Auto-generate finishing lot numbers at finishing start | James | New | M | ✅ Batch B |
| 54 | Finishing count field — James enters verified count, flags discrepancy | James | New | M | ✅ Batch B |
| 58 | Finishing queue part lookup — search by part# to find job | James | New | M | 🔲 Batch C |
| 7 | Override logging — all overrides logged with operator ID, timestamp | All | New | L | 🔲 Batch C |
| 8 | Flexible document upload at any workflow point | Roger | Modify | M | 🔲 Batch C |
| 9 | Add good/bad quantity entry to post-mfg compliance review | Roger | Modify | S | 🔲 Batch C |
| 10 | Add notes section to post-mfg compliance review | Roger | Modify | S | 🔲 Batch C |
| 32a | Material master with inch-based UOM and conversions | James | New | L | 🔲 Batch D |
| 32b | Raw material receiving log | James | New | M | 🔲 Batch D |
| 66 | Import Harry's Trello machine data | Harry | Config | M | 🔲 Batch D |

---

## Batch A: Finishing Station Core (#21, #22, #25) — ✅ COMPLETE

**Delivered:**
- `src/pages/Finishing.jsx` — new finishing station (replaces Secondary.jsx)
- Route `/finishing` added to App.jsx; `/secondary/passivation` removed
- Passivation columns renamed to finishing equivalents on `jobs` table
- `finishing_sends` columns added: `finishing_stage`, `stage_started_at`,
  `finishing_operator_id`, `finishing_started_at`, `finishing_completed_at`
- FIN-1 machine renamed from PASS-01, `machine_type` updated to 'finishing'
- FIN-2 (Finishing Tank 2) inserted as second finishing machine
- Dashboard shows single "Finishing Station" card (not per-tank cards)
- DOWN indicators for finishing machines shown in station header
- Real-time subscription on `finishing_sends` table

**Design decisions made during testing (deviations from original plan):**
- Single finishing station card on Dashboard, not one card per tank — tank status shown
  as indicators within the single card
- Multiple simultaneous active batches supported (no one-at-a-time limit)
- Tank selection moved from login to the Treatment stage advance step
- Collapsible batch cards added for space management
- Job/Station view toggle added (Job view = collapsible cards; Station view = three columns
  by stage)
- "Launch Finishing Station" button on Dashboard card instead of "Launch Kiosk"
- Finishing station integrated with `kiosk_sessions` for single-login enforcement
- Auto-send to finishing on "Complete Job": remaining quantity auto-creates
  `finishing_sends` record if machinist never manually sent
- Job status advances to `pending_post_manufacturing` when all sends for a job
  reach `finishing_complete`
- PIN login upgraded to match Kiosk numpad style with keyboard support

**Kiosk fixes delivered alongside Batch A:**
- "Send to Finishing" no longer changes job status (was incorrectly moving job out
  of `in_progress`)
- Blank material types display "pieces" not "bars" for quantity UOM
- PLN generation moved from material entry to production start (ensures every job
  gets a PLN even if machinist skips material loading)

**Dashboard fixes delivered alongside Batch A:**
- Pending Compliance counter includes `pending_post_manufacturing`
- Assembly line item order/stock qty uses stored `woa.order_quantity` /
  `woa.stock_quantity` (not calculated from WO totals)
- `work_order_assemblies` table: `order_quantity` and `stock_quantity` columns added;
  `CreateWorkOrderModal` and `EditWorkOrderModal` updated to save per-assembly splits
- Compliance view job rows show plain job quantity (no WO-level order/stock breakdown)

---

## Batch B: Lot Numbers & Count Verification (#24, #53, #54) — ✅ COMPLETE

**Delivered:**
- Finishing Lot # (FLN) auto-generated at batch start using `next_lot_number('FLN', ...)`
- FLN persists across batches: pre-filled from most recent active lot, not always new
- "Generate New" button allows James to force a new FLN when chemicals/material change
- Chemical Lot # field added to Start Batch modal — persists across batches same as FLN
- Incoming Count field at batch start (pre-filled from send quantity, editable)
- Verified Count field at batch completion (starts blank, required)
- Discrepancy warnings shown inline at both entry points (non-blocking)
- ALL discrepancies logged to `audit_logs` — no percentage threshold
- `jobs.finishing_lot_number` updated when batch completes

**New DB columns added in Batch B:**

On `finishing_sends`:
- `finishing_lot_number` text
- `chemical_lot_number` text
- `incoming_count` integer
- `verified_count` integer
- `count_discrepancy` integer
- `verified_by` uuid FK profiles
- `verified_at` timestamptz

On `jobs`:
- `finishing_lot_number` text

**Design decisions made during testing:**
- Chemical lot number added to Start Batch modal (not in original scope) — required for
  Roger's compliance audit trail and is the signal for when FLN should change
- Verified count starts blank (not pre-filled) to force conscious entry — pre-filling
  caused a UI bug where the field wasn't recognized as user-entered
- All discrepancies logged regardless of size — threshold removed; percentage filtering
  is a reporting concern, not a data capture concern

---

## Batch C: Finishing Queue & Compliance (#58, #7, #8, #9, #10) — 🔲 NEXT

**Goal:** Part lookup for finishing, override audit trail, and compliance improvements.

**Scope:**
- Finishing queue part lookup: search by part number to find associated job/send.
  James needs this to identify unknown parts that arrive on his table without paperwork.
- Override logging: `audit_logs` table (already created in S2) — log all overrides with
  operator, timestamp, reason. Build override confirmation modal UI.
- Flexible document upload: extend S3 doc upload to finishing stage, not just compliance.
  Roger wants James to scan and attach production logs directly to jobs at finishing.
- Post-mfg compliance: add good/bad quantity entry fields + notes section to
  `ComplianceReview.jsx` post-mfg section.

**Dependencies:** S2 `audit_logs` table (exists)

**Claude Code Prompt Sections:**
1. Finishing queue search bar — filter pending queue by part number
2. Override logging modal — confirm + notes required, log to audit_logs
3. Document upload at finishing stage — extend existing S3 upload pattern
4. ComplianceReview.jsx post-mfg section — good qty, bad qty, notes fields

---

## Batch D: Material Master & Data Import (#32a, #32b, #66) — 🔲 PLANNED

**Goal:** Inch-based material tracking and raw material receiving.

**Scope:**
- Material master table: `materials` with base UOM in inches, auto-conversions to feet
  (÷12), bars (÷bar_length), weight (using material density)
- Material types already exist (`material_types` table from S2) — link to material master
- Raw material receiving log: new page in Master Data section for logging incoming
  material (vendor, heat/lot number, quantity, date received). Betty would use this.
- Import Harry's Trello machine data (serial numbers, mfr dates, photos) — one-time script

**Key Decision (MB):** Base UOM = inches. All conversions derive from inches. Display
shows all three: inches, feet, bars.

**Database Changes:**
```sql
CREATE TABLE IF NOT EXISTS public.materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_type_id uuid NOT NULL REFERENCES material_types(id),
  bar_size_inches numeric NOT NULL,
  density_lbs_per_cubic_inch numeric,
  vendor text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.material_receiving (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id uuid REFERENCES materials(id),
  material_type text NOT NULL,
  bar_size text,
  bar_length_inches numeric,
  heat_lot_number text NOT NULL,
  quantity integer NOT NULL,
  received_by uuid REFERENCES profiles(id),
  received_at timestamptz DEFAULT now(),
  vendor text,
  notes text,
  created_at timestamptz DEFAULT now()
);
```

---

## Backlog Items Identified During Sprint 3

| Item | Description | Sprint |
|------|-------------|--------|
| Finishing status in WO Lookup | Show "In Finishing (X pcs)" cyan badge on job rows in April's WO Lookup when `finishing_sends` records exist. Query `finishing_sends` grouped by `job_id`, sum quantities by status, display inline on job row. | S4 |

---

## Sprint 3 Success Criteria

- [x] "Passivation" renamed to "Finishing" everywhere in UI
- [x] James can see incoming work from `finishing_sends` queue
- [x] Multi-stage processing (Wash → Treatment → Dry)
- [x] Single finishing station card on Dashboard with queue count
- [x] Multiple simultaneous active batches supported
- [x] Collapsible batch cards + Job/Station view toggle
- [x] Tank selection at Treatment stage
- [x] Finishing lot numbers auto-generated with persistence logic
- [x] Chemical lot number captured and persisted
- [x] Incoming count at batch start
- [x] Verified count at batch completion (required, starts blank)
- [x] All discrepancies logged to audit_logs
- [x] Job advances to pending_post_manufacturing when all sends complete
- [x] PLN generated at production start (not material entry)
- [x] Auto-send to finishing on job complete
- [x] kiosk_sessions integration for single-login enforcement
- [ ] Part lookup in finishing queue (Batch C)
- [ ] Override logging with audit trail (Batch C)
- [ ] Post-mfg compliance has good/bad qty + notes (Batch C)
- [ ] Material master with inch-based UOM (Batch D)
- [ ] Raw material receiving log functional (Batch D)