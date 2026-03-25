# SkyNet Sprint 3 — Implementation Plan
## Finishing Overhaul & Material Tracking
### Originally: March 1, 2026 | Updated: March 25, 2026

---

## Sprint Goal
Transform the passivation module into a full Finishing station with multi-stage
processing. Implement partial batch progression through compliance. Inch-based
material tracking (Batch D).

---

## Action Items Status

| # | Action Item | Lead | Status | Batch |
|---|-------------|------|--------|-------|
| 21 | Rename Passivation → Finishing; multi-stage process | James | ✅ Complete | A |
| 22 | Add second finishing machine | James | ✅ Complete | A |
| 24 | Production lot + finishing lot number fields | James | ✅ Complete | B |
| 25 | DOWN indicators for finishing machines | James | ✅ Complete | A |
| 53 | Auto-generate finishing lot numbers | James | ✅ Complete | B |
| 54 | Finishing count field + discrepancy flagging | James | ✅ Complete | B |
| 58 | Finishing queue part lookup | James | ✅ Complete | C |
| 7 | Override logging with audit trail | All | ✅ Complete | C |
| 8 | Flexible document upload at finishing | Roger | ✅ Complete | C |
| 9 | Good/bad quantity in post-mfg compliance | Roger | ✅ Complete | C |
| 10 | Notes section in post-mfg compliance | Roger | ✅ Complete | C |
| 32a | Material master with inch-based UOM | James | 🔲 Pending | D |
| 32b | Raw material receiving log | James | 🔲 Pending | D |
| 66 | Import Harry's Trello machine data | Harry | 🔲 Pending | D |

---

## Batch A: Finishing Station Core — ✅ COMPLETE

**Delivered:**
- `src/pages/Finishing.jsx` — full finishing station replacing Secondary.jsx
- Route `/finishing` in App.jsx; `/secondary/passivation` removed
- Passivation columns renamed to finishing equivalents on `jobs`
- FIN-1 renamed from PASS-01; FIN-2 inserted
- Single "Finishing Station" card on Dashboard (not per-tank)
- DOWN indicators in station header
- Real-time subscription on `finishing_sends`
- Multiple simultaneous active batches (no limit)
- Collapsible batch cards + Job/Station view toggle
- Tank selection at Treatment stage (not login)
- Session enforcement via `kiosk_sessions` (admin exempt)

**Kiosk fixes delivered with Batch A:**
- "Send to Finishing" no longer changes job status
- Blank material types show "pieces" not "bars"
- PLN generation moved to production start (not material entry)
- Auto-send remaining qty on job complete

**Dashboard fixes delivered with Batch A:**
- Pending Compliance counter includes `pending_post_manufacturing`
- Assembly qty uses stored `woa.order_quantity/stock_quantity`
- `work_order_assemblies` columns added for per-assembly splits
- Compliance view shows plain job qty (no WO-level breakdown)

---

## Batch B: Lot Numbers & Count Verification — ✅ COMPLETE

**Delivered:**
- FLN auto-generated at batch start, persists across batches
- "Generate New" button for when chemicals/material change
- Chemical Lot # field — persists across batches
- Incoming Count at batch start (blank, required)
- Verified Count at Dry completion (blank, required)
- ALL discrepancies logged to `audit_logs` (no threshold)
- `jobs.finishing_lot_number` updated on batch complete

**New DB columns on `finishing_sends`:**
`finishing_lot_number`, `chemical_lot_number`, `incoming_count`, `verified_count`,
`count_discrepancy`, `verified_by`, `verified_at`

**New DB column on `jobs`:** `finishing_lot_number`

---

## Batch C: Finishing Queue & Compliance — ✅ COMPLETE

**Delivered (original scope #58, #7, #8, #9, #10):**
- Queue search by part #, job #, WO # (client-side, real-time filter)
- Material and tooling override modals require mandatory reason
- Override reason logged to `audit_logs` (fire-and-forget)
- "Skip Materials" and "Skip Tooling" buttons removed
- Document upload at finishing station (job-level, shared across batches)
- Document remove button with RLS DELETE policy fix
- Post-mfg compliance: good/bad qty + notes + Quantity Check section
- Routing steps removed from post-mfg compliance view

**Delivered (additional scope discovered during testing):**
- Partial batch progression: each `finishing_sends` advances through compliance
  independently while job stays on machinist kiosk
- `compliance_status` column on `finishing_sends`
- Batch labels (A, B, C) using `is_partial_send` flag
- `is_partial_send` column on `finishing_sends`
- Merged Post-Mfg Review section (batches + legacy jobs together)
- Recently Approved Batches section in ComplianceReview
- WO Lookup batch status summary with compliance states
- `allJobSendsMap` for accurate cross-history batch labeling
- Job advancement guard: only advances when totalSentQty >= jobQty
- Admin multi-kiosk exception to single-login rule
- Recent Completions panel on finishing station (last 5 days)
- Station view splits Treatment into Tank 1 / Tank 2 columns
- Incoming Queue collapses to compact strip in Station view
- Documents auto-load on batch card expand (no manual "Load" button)
- Batch label in Start Batch modal
- Quantity fields in post-mfg not pre-filled (forces conscious entry)
- CreateWorkOrderModal new products prepend to top
- Schedule module single scrollbar sync for header + body
- `work_orders` status constraint updated to include `cancelled`
- `document_types`: "Passivation Card" → "Finishing Card"; "Other" added
- RLS DELETE policies added to 7 tables

**New DB columns on `finishing_sends`:**
`compliance_status`, `compliance_approved_by`, `compliance_approved_at`,
`compliance_notes`, `compliance_good_qty`, `compliance_bad_qty`, `is_partial_send`

**New DB columns on `jobs`:**
`post_mfg_good_qty`, `post_mfg_bad_qty`, `post_mfg_notes`,
`post_mfg_reviewed_by`, `post_mfg_reviewed_at`

---

## Batch D: Material Master & Data Import — 🔲 NEXT

**Goal:** Inch-based material tracking and raw material receiving.
**Also:** Assembly partial check-in (each compliance-approved batch checks into
assembly independently — deferred from Batch C).

**Scope:**
- Material master table with base UOM in inches, conversions to feet/bars/weight
- Raw material receiving log in Master Data (Betty's module)
- Import Harry's Trello machine data (one-time script)
- Assembly partial check-in: approved batches check into assembly as own quantity

**Key Decision (MB):** Base UOM = inches. Display: inches, feet, bars.

**Database:**
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

## Backlog Items (Post-Sprint 3)

| Item | Description |
|------|-------------|
| Finishing status in WO Lookup | "In Finishing (X pcs)" badge on April's job rows |
| Assembly partial check-in | Batch D scope |

---

## Sprint 3 Success Criteria

- [x] Passivation renamed to Finishing everywhere
- [x] James can see incoming queue from `finishing_sends`
- [x] Multi-stage Wash → Treatment → Dry
- [x] Single finishing station card on Dashboard
- [x] Multiple simultaneous active batches
- [x] Collapsible cards + Job/Station view toggle
- [x] Tank selection at Treatment
- [x] Finishing lot numbers with persistence
- [x] Chemical lot number captured
- [x] Count verification (incoming + verified, both blank)
- [x] All discrepancies logged
- [x] Job advances to `ready_for_assembly` on first batch compliance approval
- [x] Job stays on kiosk while remaining qty still on machine
- [x] PLN at production start
- [x] Batch labels A/B/C for split jobs
- [x] Partial batch progression end-to-end (finishing → compliance)
- [x] Override logging with mandatory reason
- [x] Document upload at finishing with remove
- [x] Post-mfg compliance: quantity check + documents
- [x] Merged Pre/Post-Mfg compliance sections correctly named
- [ ] Assembly partial check-in (Batch D)
- [ ] Material master inch-based UOM (Batch D)
- [ ] Raw material receiving log (Batch D)