# SkyNet Sprint 4 — Implementation Plan
## Polish, Testing & Go-Live Prep
### March 26, 2026

---

## Sprint Goal

Sprint 4 is the final development sprint before the April go-live visit. The goal is **not to add major features** — it is to close the last functional gaps identified during the review sessions, validate the full workflow end-to-end with real data, and ensure the physical infrastructure (Wi-Fi, tablets, displays) is ready for Day 1. Sprint 3 delivered a production-grade Finishing Station, material tracking, and override logging. Everything built so far needs to be stress-tested together as a complete workflow before real users are handed the keys.

---

## Action Items

| # | Action Item | Lead | Type | Effort | Batch |
|---|-------------|------|------|--------|-------|
| — | Mainframe rename: Dashboard.jsx → Mainframe.jsx, `/dashboard` → `/mainframe`, dashboards folder created | All | Modify | S | A |
| 11 | Quality control fields in TCO (tensile/shear, parts tested) — moved from post-mfg | Roger / Tom | Modify | M | A |
| 12 | Align UI terminology: Parts (not Components), Products (not Assemblies) — UI labels only | April | Modify | M | A |
| — | Assembly Pipeline Dashboard (TV display for Jody's area) | Jody | New | M | A |
| 17 | "Now" button for time entry fields on kiosk | Patrick | New | S | B |
| — | Inventory deduction: connect kiosk material entry to receiving log | Patrick | New | M | B |
| T1 | End-to-end test: WO → compliance → schedule → kiosk → finishing → post-mfg → TCO | All | Test | L | C |
| T2 | Purge test data and load production master data | Roger | Config | M | C |
| T3 | User accounts: create PINs and profiles for all staff | All | Config | S | C |
| 69 | Upgrade shop floor Wi-Fi (1 pod per room) | Harry | Infra | — | Parallel |
| 35 | Procure tablets for pilot machines + finishing + spare | Patrick | Infra | — | Parallel |
| 36 | Set up display screens on shop floor | April / Jody | Infra | — | Parallel |
| — | Kiosk material dropdowns: lead with inventory-available materials | Patrick | Modify | S | B |
| — | Outbound processes workflow (heat treat, cad plating, external ops) | Roger | New | L | B |

> **Note on #50 — Cascade/Push Scheduling:** Confirmed already delivered. `Schedule.jsx` contains a full conflict resolution modal (`crashAction`, `cascadePreview`, push-back and return-to-queue options) that fires when a job is dropped into a conflict. No work needed.

**Sprint 4 estimated effort: ~22 hrs dev + infrastructure coordination running in parallel**

---

## Batch A: Compliance, Terminology & Assembly Dashboard

---

### Mainframe Rename & Dashboards Folder

**Lead:** All | **Type:** Modify | **Effort:** S | **Files:** `App.jsx`, `src/pages/Dashboard.jsx`, nav components

**What to do:**
This is a structural housekeeping task that must be completed first in Batch A since all other dashboard work depends on the new folder structure being in place.

1. Rename `src/pages/Dashboard.jsx` → `src/pages/Mainframe.jsx`
2. Update route in `App.jsx`: `/dashboard` → `/mainframe`
3. Update the nav label: "Dashboard" → "Mainframe"
4. Update all imports across the codebase that reference `./pages/Dashboard` or `../pages/Dashboard`
5. Create the new folder: `src/pages/dashboards/`
6. `AssemblyDisplay.jsx` (built later in this batch) goes into `src/pages/dashboards/`

No functional logic changes — this is a rename and reorganize only.

---

### #11 — Quality Control Fields in TCO (Moved from Post-Mfg)

**Lead:** Roger / Tom | **Type:** Modify | **Effort:** M | **File:** `TCOReview.jsx`

**Why this was added (and why it moves to TCO):**
During the February 11 Compliance Deep-Dive, Tom explained that he performs required tensile and shear testing — an FAA mandate — on a sample of completed parts. The original action list placed this in post-manufacturing compliance, but that was an error in placement. Tom's process is: wait for the parts to be assembled into a finished product, then pull a few from the assembly to test. The individual parts need to exist in assembled form before testing is meaningful. This means the QC step belongs at TCO (after assembly), not at post-mfg (after machining).

TCO is already the right conceptual home: it fires at the work-order level after all jobs are through manufacturing and compliance, at the point where Roger or Tom closes out the work order. The `work_orders` table already carries `tco_notes` and `closed_by` — the QC fields extend that pattern cleanly.

**What to build:**

Add three fields to the TCO approval card in `TCOReview.jsx`:

- **Parts Tested** — numeric input (how many parts Tom pulled from assembly for testing)
- **Tensile** — pass/fail toggle or checkbox
- **Shear** — pass/fail toggle or checkbox

**DB change required:** Add columns to `work_orders`:
```sql
ALTER TABLE public.work_orders
  ADD COLUMN tco_parts_tested integer,
  ADD COLUMN tco_tensile_pass boolean,
  ADD COLUMN tco_shear_pass boolean;
```

These fields are optional — not required to approve TCO, because not every work order involves Tom's testing (some parts may not require it). Save these values alongside `tco_notes` when TCO is approved in `handleApproveTCO`. Display them in the completed TCO section (recently closed work orders shown in TCO view) so there's a visible record of what was tested.

**Role note:** Both Roger and Tom have `can_approve_compliance`. Either can fill in the QC fields. Tom is the primary user of these fields; Roger manages the approval flow.

---

### #12 — Align UI Terminology: Parts and Products

**Lead:** April | **Type:** Modify | **Effort:** M

**Why this was added:**
Roger raised this in the February 11 All Staff Review. Fishbowl — the system April and Roger use daily alongside SkyNet — calls individual manufactured items "parts" and finished assembled products "products." SkyNet had grown inconsistent, using "assembly," "component," "product," and "part" interchangeably across different views. The alignment reduces confusion when staff move between systems and strengthens credibility with auditors.

**Critical scope boundary — UI labels only:**
The database schema uses `assembly_id`, `component_id`, `part_type` (with enum values `'assembly'`, `'finished_good'`, `'manufactured'`, `'purchased'`), and foreign key names like `assembly_bom_assembly_id_fkey`. **None of these identifiers should be changed.** They are embedded in dozens of Supabase queries across the codebase. The cost of renaming DB columns far outweighs the benefit, and Supabase PostgREST queries reference column names directly. This is strictly a display-layer change.

**The mapping to apply across all UI label strings:**

| Current Term (in UI labels) | New Term | Notes |
|---|---|---|
| "Component" (referring to a manufactured part) | **"Part"** | Column headers, form labels, dropdowns |
| "Assembly" (referring to a finished product type) | **"Product"** | Work order type selector, WO Lookup labels |
| "Assembly BOM" | **"Product BOM"** | Master Data tab label |
| "Assembly Queue" | **"Product Queue"** | If/when assembly module activates |

**What does NOT change:**
- The "Assembly" module tab name in the nav — leave as-is for now; this is a Phase 2 module and renaming it prematurely may confuse staff who know it from the review sessions
- DB column names, table names, Supabase query strings, JS variable names, prop names — no logic changes
- The `part_type` enum values in the DB (`'assembly'`, `'manufactured'`, etc.) — these are internal values; only their display labels change

**Discussion item before implementation:**
The `parts` table stores both manufactured parts and assembled products under a single table, using `part_type` to distinguish. When a user selects "Part Type" in Master Data, the current options come from the `part_type` enum. Under the new terminology, the suggested display labels are:
- `manufactured` → **"Part (Manufactured)"**
- `purchased` → **"Part (Purchased)"**
- `assembly` → **"Product (Assembly)"**
- `finished_good` → **"Product (Finished Good)"**

Confirm this mapping with Matt before implementing. The key risk is that `assembly` as a `part_type` has a specific structural meaning (it's the parent in `assembly_bom`). Displaying it as "Product (Assembly)" must not create ambiguity when staff configure new parts in Master Data.

---

### Assembly Pipeline Dashboard

**Lead:** Jody | **Type:** New | **Effort:** M | **File:** New `src/pages/dashboards/AssemblyDisplay.jsx`

**Why this was added:**
Action item #81 in the Phase 2 backlog describes an assembly dashboard TV display showing active jobs and the finishing pipeline. Jody's team needs visibility into what parts are coming from finishing so they can prepare for product assembly — knowing what's an hour away is very different from finding boxes of parts showing up unannounced. Rather than wait for Phase 2, this can be built now as a lightweight read-only display since all the necessary data already exists: `finishing_sends` tracks in-progress batches, and `jobs.status = 'ready_for_assembly'` identifies parts that have cleared compliance.

This also feeds directly into infrastructure item #36 — one of the two display screens is specifically for Jody's assembly area.

**What to build:**

Create a new route `/dashboards/assembly` rendering `src/pages/dashboards/AssemblyDisplay.jsx`. This page is designed to run full-screen on a TV with no user interaction — read-only, auto-refreshing via Supabase realtime subscriptions.

**Two panels:**

**Panel 1 — In Finishing (Parts on Their Way)**
Query `finishing_sends` joined to `jobs` and `work_orders` where the batch has not yet completed compliance (i.e., still actively in the finishing workflow). Show:
- Part number and description
- Job number and quantity in batch
- Current stage (Wash / Treatment / Dry)
- Work order number and customer name
- Group by work order so Jody can see how close each product's components are to completion

**Panel 2 — Ready for Assembly (Cleared, Waiting)**
Query `jobs` where `status = 'ready_for_assembly'`, joined to `work_orders`. Show:
- Part number and description
- Job number and available quantity
- Work order number and customer name
- Due date — with a visual urgency indicator if past due or within 3 days
- Sort by due date ascending so the most urgent products appear first

**Design notes:**
- Use the existing SkyNet dark theme (shop floor TV environment)
- Large font sizes appropriate for viewing from 10–15 feet away
- Auto-refresh via Supabase realtime subscriptions on `finishing_sends` and `jobs` tables
- No action buttons — display only
- No login required (or use a locked read-only session — consistent with how the main Dashboard display will be set up)

**Nav:** Add a "Assembly Display" link in the admin nav for easy navigation during setup. The TV itself will be pointed directly at the `/dashboards/assembly` URL.

---

## Batch B: Kiosk Enhancements

---

### #17 — "Now" Button for Time Entry Fields

**Lead:** Patrick | **Type:** New | **Effort:** S | **File:** `Kiosk.jsx`

**Why this was added:**
Roger suggested this in the February 11 Compliance Deep-Dive; Patrick reinforced it during the machinist walkthrough. The kiosk is used on a shop floor with gloved and oily hands. Machinists frequently log job completion the morning after a dark run — they need to enter the actual stop time from the machine's log or a reasonable estimate. A "Now" button eliminates the need to type time digits on a touch keyboard and directly reduces the friction that leads to skipped or inaccurate time entries. Reducing keystrokes on the kiosk is directly tied to adoption.

**What to build:**
Add a small "Now" tap target adjacent to every time input field on `Kiosk.jsx`. On tap, it fills the field with the current local time in the input's expected format. Apply to:
- Job start time (setup start, production start)
- Job end/completion time
- Downtime start/end fields

Implement as a reusable `<NowButton onSet={(time) => ...} />` component so it can be dropped next to any time input without repetition.

---

### Inventory Deduction — Kiosk Material Entry → Receiving Log

**Lead:** Patrick | **Type:** New | **Effort:** M | **Files:** `Kiosk.jsx`, `material_receiving` table

**Why this was added:**
This item was flagged as P1 in the Sprint 3 backlog when the `materials` and `material_receiving` tables were built in Batch D. The context comes from the February 12 machinist session: James and Scott both acknowledged the paper bar-count system has no real traceability — someone takes bars off the shelf and nothing is logged. The receiving log built in Sprint 3 creates the inventory pool. This item closes the loop so the system can begin tracking consumption from Day 1.

**What to build:**
When a machinist confirms material on a job in `Kiosk.jsx` (the material entry step that creates a `job_materials` record), execute a matching deduction against `material_receiving`:

1. Find the `material_receiving` record(s) matching the selected `material_id` and `lot_number`
2. Subtract the entered `quantity` (bars) from available inventory — review current `material_receiving` schema to determine whether to track via a `quantity_remaining` column or a separate `material_usage` insert before implementing
3. **Non-fatal:** If no matching receiving record exists, or if the deduction would go negative, log a warning to `audit_logs` but do not block the machinist — floor operations must never be gated by the inventory layer

> **Adoption note from session:** Scott and James both said perfect inventory accuracy from Day 1 is unrealistic. The goal is building the data trail so the team can identify patterns and tighten controls over time. Warn and log; never block.

---

### Kiosk Material Dropdowns — Lead with Inventory

**Lead:** Patrick | **Type:** Modify | **Effort:** S | **File:** `Kiosk.jsx`

**Why this was added:**
When a machinist opens the material entry step on the kiosk, they are presented with generic Material Type and Bar Size dropdowns that list all material types and sizes in the system. During testing, it was noted that the machinist should be guided first toward what is actually in inventory — materials that have been received and have available stock — rather than the full unconstrained list. This reduces input errors and reinforces inventory discipline: machinists should be pulling from known stock, not inventing material entries.

**What to build:**
In `Kiosk.jsx`, update the Material Type and Bar Size dropdowns in the material entry modal to prioritise inventory-available options:

1. Query `material_receiving` for records that have available stock (i.e. where `quantity > 0` and the lot has not been fully consumed per `material_usage`). Extract the unique `material_type` and `bar_size` values from those records.
2. In the Material Type dropdown, show a **"From Inventory"** optgroup at the top containing those available material types, followed by a **"All Materials"** optgroup with the remaining types.
3. In the Bar Size dropdown, apply the same pattern — once a material type is selected, show available bar sizes for that type at the top, followed by all other bar sizes.
4. If a machinist selects a material type and bar size that matches an inventory record, pre-fill the Lot # field with the most recently received matching lot number (as a suggested default — still editable).
5. If no inventory records exist at all, fall back to the current behaviour (full list, no grouping).

> **Non-blocking:** The machinist can always select a material type or bar size that is not in inventory — the grouping is a UX guide, not a restriction. Adoption depends on making the right choice easy, not forcing it.

---

### Outbound Processes Workflow

**Lead:** Roger | **Type:** New | **Effort:** L | **File:** New `OutboundQueue.jsx` or integrated into `ComplianceReview.jsx`

**Why this was added:**
Looking at the routing templates in the Armory, several steps are marked in amber — Heat Treatment and Plating — indicating they are outbound/external operations with no built-in workflow yet. These are processes where parts leave the building, go to a third-party vendor (heat treat facility, cad plating shop), and return with a cert and a new vendor-assigned number. From the February 11 All Staff Review and Compliance Deep-Dive sessions:

- Roger noted that a single production run can generate 3–4 different plating numbers because assemblies get plated in different batches for different customers
- Betty assigns a new 5-digit received number when plated parts return
- Roger wants the ability to attach PDF certs (plating certs, heat treat certs) to jobs at any point
- April confirmed she does not schedule external operations — they are triggered by part configuration and someone (Roger or Betty) logs the send-out and return dates
- This was originally action item #26 (Virtual machine centers for heat treat/cad plating), deferred from Phase 2 into Sprint 4 given it is blocking the completion of several routing templates

**What to build:**
Create a lightweight outbound operations workflow that tracks parts sent to and received from external vendors:

**DB changes required (add to next SQL migration):**
```sql
CREATE TABLE public.outbound_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES public.jobs(id),
  work_order_id uuid REFERENCES public.work_orders(id),
  operation_type text NOT NULL CHECK (operation_type IN ('heat_treat', 'cad_plating', 'paint', 'other')),
  vendor_name text,
  quantity integer NOT NULL,
  sent_at timestamptz,
  sent_by uuid REFERENCES public.profiles(id),
  expected_return_at date,
  returned_at timestamptz,
  returned_by uuid REFERENCES public.profiles(id),
  vendor_lot_number text,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
```

**UI — Outbound Queue section in ComplianceReview.jsx:**
Add an "Outbound" section to the compliance view (admin and compliance roles only) that shows jobs whose routing steps include Heat Treatment, Plating, or other external operations and have reached `manufacturing_complete` status:

- **Send Out:** Roger or Betty can log a send-out — selecting operation type, vendor, quantity, and expected return date. This creates an `outbound_sends` record with `sent_at` populated.
- **Receive Back:** When parts return, log the return — entering the vendor's lot/cert number and return date. This updates `returned_at` and `vendor_lot_number`.
- **Document attachment:** Allow a cert PDF to be attached to the outbound record using the existing S3 document upload pattern.
- **Status visibility:** Jobs with open outbound sends (sent but not returned) show a new status indicator in WO Lookup so April can see parts are at the vendor.

Jobs advance through the routing normally — outbound operations do not block compliance progression but are tracked for audit purposes and cert chain of custody.

---

## Batch C: Testing & Go-Live Preparation

---

### T1 — End-to-End Workflow Test

**Lead:** All | **Type:** Test | **Effort:** L

Every sprint introduced test cases for its own batch, but a complete end-to-end test crossing all four sprints has never been run. Before handing the system to the Skybolt team, the full production workflow must be validated with real part data.

**Full test path:**
```
Work Order Creation (April)
  → Pre-Mfg Compliance (Roger — document review, routing approval)
  → Schedule Job to Machine (April — click-to-schedule; test conflict modal if applicable)
  → Kiosk: Start Setup → Log Materials (lot # + bars) → Production Start → PLN generated
  → Kiosk: Send Partial to Finishing (mid-run partial)
  → Kiosk: Complete Job → Auto-send remaining qty to Finishing
  → Finishing Station: Receive Batch → Wash → Treatment (tank selection) → Dry
  → Finishing: Enter Verified Count → Discrepancy flagged if delta
  → Batch compliance approval (Roger — good/bad qty, notes)
  → Job advances to ready_for_assembly → Appears on Assembly Pipeline Dashboard
  → TCO (Roger or Tom — QC fields filled, notes, approve)
  → Work Order marked complete
```

Run at least **twice** — once on a stainless part (full passivation path) and once on a non-stainless part (wash + dry only). Use real part numbers from T2.

**Edge cases to deliberately test:**
- Partial send path: two sends from same job, verify batch labels A/B, both clear compliance independently
- Count discrepancy: mismatched counts at kiosk vs. finishing; verify audit log
- Scheduling conflict: crash two jobs on same machine; verify push-back and return-to-queue both work
- Lot number block: attempt second material with different lot on active job; verify warning + block
- Backup compliance: log in as Jody or Tom; verify `can_approve_compliance` allows post-mfg approval
- TCO QC fields: verify Parts Tested, Tensile, Shear save and show on completed TCO card

Document all blockers. Broken status transitions must be fixed before go-live. UI polish can be deferred.

---

### T2 — Purge Test Data and Load Production Master Data

**Lead:** Roger | **Type:** Config | **Effort:** M

SkyNet has been developed against seed and synthetic test data. The database must be cleaned and loaded with real Skybolt data before go-live.

**Purge (Matt + admin):**
- Delete test work orders, jobs, and all associated records (job_materials, finishing_sends, compliance records, audit_logs from test runs)
- Delete synthetic downtime and idle time records
- Delete test user accounts
- **Preserve:** machine records, material_types, routing_templates, document_types, and any real components already entered

**Load production data:**
- **Parts:** Verify all real Skybolt parts are in the `parts` table with correct part numbers, part types, material categories, routing configurations, and required document settings
- **Materials:** Confirm `materials` table has real material type + bar size + vendor combinations from the shop racks
- **Receiving log (optional but recommended):** Enter opening inventory counts for bars currently on the rack
- **Machines:** Confirm all Leesburg machines have `machine_type` populated; FIN-1 and FIN-2 are active

> Roger maintains a personal materials spreadsheet. Reconcile it against `materials` and `material_receiving` before go-live so the system and Roger's records agree from Day 1.

---

### T3 — Create User Accounts and PINs for All Staff

**Lead:** All department leads | **Type:** Config | **Effort:** S

**Accounts to create:**

| Name | Role | Primary Access |
|------|------|----------------|
| April | admin / scheduling | Work Order creation, Schedule, WO Lookup |
| Roger | compliance | Compliance Review, TCO, Master Data |
| Patrick | machinist / admin | Kiosk (all machines), Schedule visibility |
| Scott | machinist | Kiosk |
| Jeff | machinist | Kiosk |
| James | finishing | Finishing Station kiosk |
| Harry | admin | Machine management, Dashboard |
| Jody | compliance_backup | Post-mfg compliance (backup for Roger) |
| Tom | compliance_backup | Post-mfg compliance + TCO QC fields |
| Carlos | machinist | Kiosk (phased — start with 1–2 machines) |

For each account: create Supabase Auth user, create `profiles` record with correct `role` and `can_approve_compliance` flags, set kiosk PIN with the user present. Verify PIN login on physical tablet hardware.

> Carlos is a resistant adopter. His account should be created, but his machines should be added to the kiosk rotation gradually. Do not force simultaneous adoption across all machinists on Day 1.

---

## Infrastructure Track (Parallel to Development)

---

### #69 — Upgrade Shop Floor Wi-Fi

**Lead:** Harry (runs wires), Ned (approves MMD quote)

Harry flagged this during the February 12 machinist session: *"We only have one little pod running out there. If you want tablets in each machine, we're going to have to upgrade the Wi-Fi."* Harry confirmed he can run Ethernet cable himself — the dependency is an MMD contractor for the drops and pod procurement. Without reliable Wi-Fi, kiosk sessions will drop and the resulting login failures will immediately destroy adoption on Day 1. One pod per room: machining floor, finishing area, assembly.

**Actions:** Harry runs cable drops; Ned approves MMD quote; test signal strength at each machine station before tablets arrive; validate Supabase realtime stability under shop floor conditions.

---

### #35 — Procure Tablets for Pilot Machines + Finishing + Spare

**Lead:** Patrick (specs), Ned (procurement)

Patrick confirmed in the All Staff Review that phone navigation would be too difficult for the data entry required. Plan: test one unit on the shop floor first, then deploy the fleet.

**Actions:** Procure 1 test tablet; validate kiosk loads and PIN login works on hardware. If test passes: ~3 pilot machines + 1 finishing station + 1 spare. Consider ruggedized Android tablets with arm mounts for the oily, high-vibration environment.

---

### #36 — Set Up Display Screens on Shop Floor

**Lead:** April (machining floor), Jody (assembly area), Ned (hardware)

Two displays are now in scope given the new Assembly Pipeline Dashboard.

- **Machining floor:** Chrome kiosk mode → `https://skynet.skybolt.com/mainframe`
- **Assembly area:** Chrome kiosk mode → `https://skynet.skybolt.com/dashboards/assembly`

Both displays use a read-only account or locked admin session. Supabase realtime handles auto-refresh natively.

---

## Sprint 4 Success Criteria

- [ ] TCO view has Parts Tested, Tensile, and Shear fields; values save and appear on completed TCO cards
- [ ] "Component" → "Part" and "Assembly" (product type) → "Product" applied across all UI labels; no DB or logic changes
- [ ] Assembly Pipeline Dashboard live at `/assembly-display`; In Finishing and Ready for Assembly panels update in real time
- [ ] "Now" button fills current time on all kiosk time entry fields
- [ ] Kiosk material entry decrements `material_receiving`; non-fatal if no matching record; warning logged to `audit_logs`
- [ ] End-to-end workflow (WO → TCO) completes without errors on at least 2 real part types
- [ ] All test data purged; production parts, materials, and machines loaded
- [ ] All 10 staff accounts created with correct roles and PINs; kiosk login verified on physical hardware
- [ ] Wi-Fi pods installed in machining, finishing, and assembly areas
- [ ] Pilot tablets deployed; kiosk tested on physical hardware
- [ ] Machining floor display and assembly area display live and auto-refreshing
- [ ] No blocking bugs on the end-to-end path
- [ ] Kiosk material dropdowns show inventory-available options first; lot pre-fill works when a matching receiving record exists
- [ ] Outbound Sends table exists in DB; send-out and receive-back workflow functional in ComplianceReview; cert PDF attachment works

---

## Carry-Forward Notes (Post-Launch Backlog)

| Item | Why Deferred |
|------|-------------|
| #31 — Fishbowl bulk import | Needs Fishbowl data confidence first (MB Decision) |
| #14 — Day-block scheduling mode | Click-to-schedule with days input (S2) covers Day 1 needs |
| #23 — Incremental qty tracking through finishing stages | P2 after go-live data collected |
| #26 — Virtual machine centers (heat treat, cad plating) | Major new module; Phase 2 |
| Assembly module (#27–#28, #73–#75, P2a) | Full Phase 2; Jody tracking stays in Fishbowl for now |
| #55 — Scrap tracking at finishing | P2 after go-live |
| #64 — Auto-deduct raw material (advanced) | Depends on stable inventory data from Day 1 |
| Barcode printing for Material Master | Post-Sprint 3 backlog; receiving dock workflow |
| #81 — Full Assembly Dashboard (P2 version) | Lightweight version delivered in Sprint 4; Phase 2 adds assembly queue + job assignment |

---

*Sprint 4 plan prepared March 26, 2026. Spec reference: SkyNet_Specification_v2.3.*