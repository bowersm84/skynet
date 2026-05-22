# SkyNet Sprint 2 — Implementation Plan
## Scheduling & Kiosk Fixes (Weeks 3–4, ~30 hrs)
### Created: Feb 23, 2026

---

## Sprint 2 Goal

Make scheduling usable for April's daily workflow. Fix kiosk issues that block
machinist adoption. Plus #31 Fishbowl import deferred from Sprint 1.

---

## Action Items (13 items)

### From Action List v1.2

| # | Action Item | Lead | Type | Effort | Priority |
|---|------------|------|------|--------|----------|
| 45 | Click-to-schedule (date + machine modal instead of drag-only) | April | New | L | P1 — Critical for April |
| 44 | Days input to schedule duration (alongside hours/minutes) | April | Modify | S | P2 |
| 47 | Display part number on schedule blocks (visible without hover) | April | Modify | S | P2 |
| 46 | Schedule search bar — find jobs by customer/part/job# | April | New | M | P2 |
| 13 | Add machine name to Work Order Lookup results | April | Modify | S | P3 — Quick win |
| 15 | Block lot number changes on active job (CRITICAL compliance) | Patrick | Modify | M | P1 — Compliance |
| 16 | Add blanks material type for Bolt Masters | Patrick | Modify | S | P3 |
| 59 | Pause for setup phase; auto-pause on login to another machine | Patrick | New | L | P1 |
| 61 | Track idle time separately from maintenance downtime | Patrick | Modify | M | P2 |
| 52 | Auto-generate production lot numbers on job start | James | New | M | P2 |
| 19 | Partial send to finishing from active job | James | New | L | P1 |
| 20 | Phase tooling tracking as Day 2 (skip by default) | Patrick | Config | S | P3 |
| 31 | Fishbowl import script (deferred from S1) | Roger | Config | L | P2 |

**Sprint 2 estimated effort: ~30 hours (3× L, 4× M, 5× S) + 1 L from S1 deferral**

---

## Suggested Batch Order

### BATCH A — Scheduling Core (Days 1–3, ~10 hrs)

**A1. #45 — Click-to-Schedule Modal** (L, 3–5 hrs)
- New component: `ScheduleJobModal.jsx`
- Trigger: "Schedule" button on unassigned jobs in job pool
- Fields: Date picker, Machine dropdown (filtered by machine preferences), 
  Start time, Duration (hours/minutes/days)
- On save: creates schedule_entries record, moves job to `scheduled` status
- Machine preferences from `part_machine_durations` highlight recommended machines
- Validate: no time overlap on same machine

**A2. #44 — Days Input for Duration** (S, <1 hr)
- Modify duration input component used in scheduling
- Add "Days" field alongside existing Hours/Minutes
- Auto-convert: 1 day = configured shift hours (default 8)
- Store in hours internally

**A3. #47 — Part Number on Schedule Blocks** (S, <1 hr)
- File: `Schedule.jsx` block rendering
- Add `job.component_part_number` to displayed text on each schedule block
- Currently shows customer + quantity; add part# above or below

**A4. #46 — Schedule Search Bar** (M, 2–3 hrs)
- New search component in Schedule module header
- Search by: customer name, part number, job number
- On match: scroll timeline view to the machine/date where job is scheduled
- If unscheduled: show result in job pool with highlight

---

### BATCH B — Kiosk & Compliance Fixes (Days 4–6, ~10 hrs)

**B1. #15 — Block Lot Number Changes** (M, 2–3 hrs)
- File: Manufacturing kiosk material entry
- On material entry: compare new lot_number to existing lot on active job
- If different: block with modal explaining the lot mismatch
- Message: "This job already has material from Lot [X]. A different lot requires 
  a new job. Complete the current job with partial quantity first."
- Log the attempted change for audit trail

**B2. #59 — Setup Pause & Auto-Pause** (L, 3–5 hrs)
- Kiosk state management changes:
  - Add "Setup" phase before production start
  - Operator can pause during setup (tool changes, alignment, etc.)
  - When operator logs into a DIFFERENT machine while a job is in setup on 
    another machine: auto-pause the setup job
  - Query `jobs` for same operator with status `in_progress` or `setup` 
    on other machines
- New status or flag: `setup_in_progress` vs `production_in_progress`
- Auto-pause sets `paused_at` timestamp and `pause_reason = 'auto_machine_switch'`

**B3. #61 — Idle Time Tracking** (M, 2–3 hrs)
- MB Decision: track idle time separately from downtime
- New field or table: `machine_idle_logs` with start/end times
- Definition: time between job completion (actual_end) and next job start on same machine
- Calculate automatically: when a new job starts, check if previous job on that 
  machine has ended. Gap = idle time.
- Display on dashboard machine cards or as a metric
- NOT counted as downtime in downtime reports

**B4. #16 — Blanks Material Type** (S, <1 hr)
- Add "Blanks" to `material_types` table
- Bolt Master thread rollers use blanks (pre-formed pieces) not bar stock
- Material entry on Bolt Master machines should offer Blanks with qty/lot fields
- Different from bar stock: no bar size, no length tracking

**B5. #20 — Skip Tooling by Default** (S, <1 hr)
- Set `tooling_required = false` as default for new jobs
- Kiosk flow: skip tooling verification step when flag is false
- Can be overridden per job or per part in master data later

---

### BATCH C — Finishing & Lot Numbers (Days 7–9, ~8 hrs)

**C1. #19 — Partial Send to Finishing** (L, 3–5 hrs)
- New "Send to Finishing" button in kiosk during active production
- Creates a partial finishing record:
  - Records partial quantity sent (operator enters count)
  - Job stays in `in_progress` status (not complete yet)
  - Finishing station can see and process the partial batch
- Data model: new `finishing_batches` table or extend `job_routing_steps`
  - `job_id`, `quantity_sent`, `sent_at`, `sent_by`, `lot_number`
  - Links to the finishing routing steps for that job
- Multiple partial sends allowed per job
- Job completion sums all partial sends + final send

**C2. #52 — Auto-Generate Production Lot Numbers** (M, 2–3 hrs)
- Supabase DB function: generate lot number on first material entry for a job
- Format: TBD with James (likely date-based: YYMMDD-SEQ or similar)
- Triggered when machinist enters first material record for a job
- Stored on `jobs.production_lot_number` (may need new column)
- Prevents manual lot number entry errors

**C3. #13 — Machine Name in WO Lookup** (S, <1 hr)
- File: Work Order Lookup modal query
- Join `machines` table through `jobs.machine_id`
- Display machine name in job row (e.g., "Mazak 3" next to status badge)

---

### BATCH D — Fishbowl Import (Days 9–10, ~4 hrs)

**D1. #31 — Fishbowl Import Script** (L, 3–4 hrs)
- Deferred from Sprint 1
- Standalone Node.js script (not UI)
- Input: Fishbowl export CSV/Excel with assembly/component data
- Process:
  1. Parse export file
  2. Map fields to SkyNet schema (parts, assembly_bom)
  3. Duplicate detection (skip existing part numbers)
  4. Validate data integrity (BOM relationships, part types)
  5. Insert into Supabase
- Start with small test set, validate with Roger
- Full import only after validation
- Note: Fishbowl data quality is suspect per MB decision — 
  "needs improvement in ALL areas, not just legacy items"

---

## Dependencies & Risks

| Item | Dependency | Risk |
|------|-----------|------|
| #45 Click-to-schedule | Schedule data model (should already exist) | Low — extends existing |
| #15 Lot blocking | Clear on what "same job" means for lot tracking | Low — straightforward |
| #59 Auto-pause | Multi-machine session tracking | Medium — cross-machine state |
| #19 Partial finishing | Finishing data model may need new table | Medium — new workflow |
| #52 Lot number format | Need James to confirm format | Low — can default |
| #31 Fishbowl import | Roger provides export file | Medium — data quality |

---

## Pre-Sprint Checklist

- [ ] DECISIONS.md committed and current (updated end of S1)
- [ ] Fresh Supabase schema dump in docs/
- [ ] S1 code deployed and stable on production
- [ ] Confirm with April: click-to-schedule modal requirements
- [ ] Confirm with James: production lot number format
- [ ] Get Fishbowl export sample from Roger (for #31)
- [ ] Test data: ensure enough scheduled/unscheduled jobs for schedule testing

---

## Notes for Sprint 2 Chat

When starting the S2 chat session, provide Claude Code with:
1. This implementation plan (S2_Implementation_Plan.md)
2. DECISIONS.md (architectural context)
3. Current Gitingest or file tree export
4. The specific batch you're starting (A, B, C, or D)

The routing system built in S1 is foundational but NOT directly used in S2.
S2 is mostly scheduling and kiosk work. The routing foundation becomes critical
in S3 when the Finishing Overhaul (#21) builds on routing_templates and
job_routing_steps to drive multi-stage finishing workflows.

### Key S1 Decisions That Affect S2
- Lot number changes are BLOCKED on active jobs (#15) — this is an MB decision
- Idle time is tracked separately from downtime (#61) — MB: "DO track, but NOT as downtime"
- Tooling is Day 2 (#20) — skip by default, don't remove the capability
- Fishbowl data quality is suspect everywhere — don't assume any category is accurate
