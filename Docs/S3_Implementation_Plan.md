# SkyNet Sprint 3 — Implementation Plan
## Finishing Overhaul & Material Tracking (Weeks 5–6, ~34 hrs)
### March 1, 2026

---

## Sprint Goal
Transform the passivation module into a full Finishing station with multi-stage processing. Implement inch-based material tracking. This is the largest sprint and the most complex domain overhaul.

## Foundations from Previous Sprints
- **S1 Routing System:** `routing_templates` + `job_routing_steps` provide the step-based processing framework that finishing stages will build on
- **S2 `finishing_sends` table:** Partial sends from manufacturing kiosks feed into the finishing queue (status = `pending_finishing`)
- **S2 Production Lot Numbers:** `jobs.production_lot_number` carries through to finishing for chain-of-custody traceability
- **S2 `lot_number_sequences` table:** Reusable for finishing lot number generation (prefix = 'FLN')

---

## Action Items

| # | Action Item | Lead | Type | Effort | Notes |
|---|-------------|------|------|--------|-------|
| 21 | Rename Passivation to Finishing; implement multi-stage process per component master data | James | Modify | XL (6-12 hrs) | Secondary.jsx overhaul. Stage config per part. Every component goes through finishing. |
| 22 | Add second finishing machine in system | James | Config | S (<1 hr) | Insert machine record. Tank assignment if needed. |
| 24 | Add production lot + finishing lot number fields | James | Modify | M (1-3 hrs) | DB columns on jobs + finishing kiosk UI fields. |
| 25 | Add DOWN indicators for finishing machines | James | Modify | S (<1 hr) | Reuse existing DOWN indicator pattern. |
| 53 | Auto-generate finishing lot numbers at finishing start | James | New | M (1-3 hrs) | Reuse `next_lot_number` function with prefix='FLN'. |
| 54 | Finishing count field — James enters verified count, flags discrepancy | James | New | M (1-3 hrs) | Machine count vs James's count. Log delta. |
| 58 | Finishing queue part lookup — search by part# to find job | James | New | M (1-3 hrs) | James needs this for unknown parts on his table. |
| 7 | Override logging — all overrides logged with operator ID, timestamp, forced notes | All | New | L (3-6 hrs) | Audit trail table + UI. |
| 8 | Flexible document upload at any workflow point | Roger | Modify | M (1-3 hrs) | Extend existing S3 upload to allow docs at any stage. |
| 9 | Add good/bad quantity entry to post-mfg compliance review | Roger | Modify | S (<1 hr) | Add fields to ComplianceReview.jsx. |
| 10 | Add notes section to post-mfg compliance review | Roger | Modify | S (<1 hr) | Text field for Roger's audit trail. |
| 32a | Material master with inch-based UOM and conversions | James | New | L (3-6 hrs) | Base UOM = inches. Display conversions to feet, bars, weight. |
| 32b | Raw material receiving log | James | New | M (1-3 hrs) | Receiving module in Master Data. Foundation for inventory. |
| 66 | Import Harry's Trello machine data (serial numbers, mfr dates, photos) | Harry | Config | M (1-3 hrs) | One-time data import. |

**Total: 14 items | Est: ~34 hours (1x XL, 1x L+, 7x M, 4x S, 1x Config)**

---

## Batch Organization

### Batch A: Finishing Station Core (#21, #22, #25) — ~10 hrs
**Goal:** Transform Secondary.jsx from passivation-only to full finishing station.

**Scope:**
- Rename all "Passivation" references to "Finishing" across UI, DB, and code
- Implement multi-stage processing: Wash → Treatment → Dry (stages driven by component master data — not every part gets passivation)
- Add second finishing machine record
- DOWN indicators for finishing machines (reuse production pattern)
- Integrate `finishing_sends` as the incoming queue (replace direct job status transition)
- Steel path: wash → anti-rust oil → external heat treat
- Aluminum path: wash → Zexel coating

**Key Design Decision:** The finishing station reads from `finishing_sends WHERE status = 'pending_finishing'` as its work queue. Each send becomes a finishing batch. James processes batches, not individual jobs.

**Dependencies:** S1 routing system, S2 finishing_sends table

**Claude Code Prompt Sections:**
1. Database: rename passivation columns/statuses, add finishing_stage enum, add second machine
2. UI: overhaul Secondary.jsx — queue view, stage tracking, batch processing
3. DOWN indicators: copy pattern from production machines

---

### Batch B: Lot Numbers & Count Verification (#24, #53, #54) — ~6 hrs
**Goal:** Complete the lot number chain and add James's count verification.

**Scope:**
- Add `finishing_lot_number` column to finishing records
- Auto-generate finishing lot numbers using existing `next_lot_number` function (prefix = 'FLN')
- Finishing lot persists across daily batches for same material lot (only changes on material lot change or tank chemical change)
- Count verification: James enters his count, system compares to machine count, flags discrepancy
- Display both production lot and finishing lot in finishing UI

**Key Rule (from James):** Finishing lot stays the same for weeks/months as long as same material heat is used. Only changes when material changes or passivation chemicals change. System auto-generates, but James can override if chemicals change.

---

### Batch C: Finishing Queue & Compliance (#58, #7, #8, #9, #10) — ~10 hrs
**Goal:** Part lookup for finishing, override audit trail, and compliance improvements.

**Scope:**
- Finishing queue part lookup: search by part number to find associated job/send
- Override logging: `audit_logs` table (already created in S2) — log all overrides with operator, timestamp, reason
- Flexible document upload: extend doc upload to finishing stage, not just compliance
- Post-mfg compliance: add good/bad quantity entry fields + notes section

**Dependencies:** S2 `audit_logs` table

---

### Batch D: Material Master & Data Import (#32a, #32b, #66) — ~8 hrs
**Goal:** Inch-based material tracking and raw material receiving.

**Scope:**
- Material master table: `materials` with base UOM in inches, auto-conversions to feet (÷12), bars (÷bar_length), weight (using material density)
- Material types already exist (`material_types` table from S2) — link to material master
- Raw material receiving log: new page in Master Data section for logging incoming material (vendor, heat/lot number, quantity, date received)
- Import Harry's Trello machine data (one-time script)

**Key Decision (MB):** Base UOM = inches. All conversions derive from inches. Display shows all three: inches, feet, bars.

---

## Database Changes (Preview)

```sql
-- Batch A: Finishing station
ALTER TABLE jobs RENAME COLUMN passivation_start TO finishing_start;
ALTER TABLE jobs RENAME COLUMN passivation_end TO finishing_end;
ALTER TABLE jobs RENAME COLUMN passivation_operator_id TO finishing_operator_id;
ALTER TABLE jobs RENAME COLUMN passivation_notes TO finishing_notes;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS finishing_lot_number text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS finishing_stage text; -- 'wash', 'treatment', 'dry'

-- Update job status enum to replace passivation references
-- (This requires careful migration — may need to update CHECK constraint)

-- Batch A: Second finishing machine
INSERT INTO machines (name, code, type, location, is_active)
VALUES ('Finishing Tank 2', 'FIN-2', 'finishing', 'Leesburg', true);

-- Batch B: Count verification
ALTER TABLE finishing_sends ADD COLUMN IF NOT EXISTS machine_count integer;
ALTER TABLE finishing_sends ADD COLUMN IF NOT EXISTS verified_count integer;
ALTER TABLE finishing_sends ADD COLUMN IF NOT EXISTS count_discrepancy integer;
ALTER TABLE finishing_sends ADD COLUMN IF NOT EXISTS verified_by uuid REFERENCES profiles(id);
ALTER TABLE finishing_sends ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- Batch D: Material master
CREATE TABLE IF NOT EXISTS public.materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_type_id uuid NOT NULL REFERENCES material_types(id),
  bar_size_inches numeric NOT NULL,        -- base UOM
  density_lbs_per_cubic_inch numeric,       -- for weight calc
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

## Schedule

| Week | Batch | Items | Hours | Notes |
|------|-------|-------|-------|-------|
| 5a | A: Finishing Core | #21, #22, #25 | ~10 | Largest item — Secondary.jsx overhaul |
| 5b | B: Lot Numbers & Counts | #24, #53, #54 | ~6 | Builds on Batch A finishing station |
| 6a | C: Queue & Compliance | #58, #7, #8, #9, #10 | ~10 | Independent of A/B |
| 6b | D: Material Master & Data | #32a, #32b, #66 | ~8 | Can partially parallel with C |

**Total: ~34 hours across 2 weeks**

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| #21 is XL and touches core workflow | Break into sub-tasks: rename first, then stages, then queue integration |
| Passivation→Finishing rename touches DB constraints | Test status enum migration on dev data first |
| James's finishing workflow is complex (multi-day batches) | Keep MVP simple: one finishing record per send. Daily batch grouping in Phase 2 |
| Material master scope creep | Keep to inch-based UOM + display conversions. No Fishbowl integration yet |
| Harry's Trello data may need cleanup | Manual review before import — one-time effort |

---

## Success Criteria
- [ ] "Passivation" renamed to "Finishing" everywhere in UI
- [ ] James can see incoming work from `finishing_sends` queue
- [ ] Multi-stage processing (wash/treatment/dry) per component configuration
- [ ] Finishing lot numbers auto-generated
- [ ] James's count verification with discrepancy flagging
- [ ] Part lookup in finishing queue
- [ ] Override logging with audit trail
- [ ] Post-mfg compliance has good/bad qty + notes
- [ ] Material master with inch-based UOM
- [ ] Raw material receiving log functional
