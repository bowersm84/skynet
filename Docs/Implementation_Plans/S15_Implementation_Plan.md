# SkyNet MES — Sprint 15 Implementation Plan

**Sprint 15 — Giza Program Tracker: Dry-Film Finishing + Giza Dashboard (+ Manual Certs)**

Implementation Plan v1.1 · October 12, 2026 (v1.1 adds the final-assembly lot register, §4.4)

**Owner:** Matt Bowers
**Decision family:** D-GIZA (no collisions — 0 existing entries)
**Status:** Awaiting sign-off. Nothing applied; no branch created.

---

## 1. Sprint Goal

Make the SK21077-5 (Giza, sold as MS21077-5) nutplate program visible in SkyNet end to end, even though nothing on it is machined in-house:

1. **Finishing kiosk** — a third standalone operation type, `dry_film`, so James creates a job for the SK21077-5-3 steel nut and runs it Paint → Bake (oven pick, 2 h / 350 °F cure record) → verified count. The batch's finishing lot number is minted when the bake completes, from the plating lot + dry-film lot pair.
2. **Giza Dashboard** — `/dashboards/giza`: the steel-nut pipeline from vendor receipt to shipment, component stock for the cage / retainer / insert, daily throughput, oven capacity, a finish-date forecast against SO 15548, and a **final-assembly lot register** that replaces the paper "MS21077 Platenut Assembly" sheet — SkyNet mints the next bag lot number in that sheet's sequence (3001, 3002 … next free 3007) when a lot is opened, and the closed lot carries the component lots, torsion test and inspection the sheet records today. Ashley logs the manual stages; James's batches fill in Paint/Bake automatically; shipments come from the Fishbowl mirror.
3. **Manual cert creation** in the Cert Repository for outsourced/purchased products (Giza requires full certs; Roger builds them by hand today). Scoped and built **after** 1 and 2 are live (Batch C).

Sprint 14 (Traveler Kiosk) is live. Sprint 13 (Fishbowl Inventory) stays paused with one batch left. The Oct 8 assembly re-enable round continues separately — this sprint does not touch it (D-GIZA-01).

---

## 2. Background

The program: Xiamen and Maxtrust supply all four pieces — SK21077-5-4 Steel Cage, SK21077-5-1 Steel Retainer, SK21077-5-2 Nylon Insert, SK21077-5-3 Steel Nut Plate. Skybolt inserts the nylon washer into the nut (assembly area), sends the nut to Electrolab for plating, sprays dry film (Dave, ~20 pans ≈ 2,060 nuts a side in ~45 min, flip, repeat), cures 2 h at 350 °F (two ovens, 6 pans × 103 ≈ 618 nuts per load; four ovens soon), final-assembles nut + cage + retainer, bags, ships to Giza.

The paper record today is the "MS21077 Platenut Assembly" sheet (SK21077 Assembly Rev 1, form REV 00 10/18/2022): pre-printed final lot numbers 3001–3019, one row per lot, with up to three Date / Qty / Assembled-by cells (a lot fills over several days — 3003 took 1,570 on 6-23-26 and more on 6-27-26), the assembly part (MS21077-(5)), and the component lots consumed — Cage SK# (e.g. 51859), Retainer SK# (51873), Nut Insert SK# (two numbers on most rows, e.g. 902815 / 51885 — the nut's lots before and after plating), Nylon Insert (51853) — then two torsion-test samples (qty / in-lbs, e.g. 10 / 34 and 10 / 27), the inspector's initials and an Inv initials column. Lots 3001–3004 are complete, 3005 is in progress (9-2-26, highlighted), 3006 has component lots assigned and no assembly yet; **3007 is the next free number**. Component lots are 5-digit receiving numbers from the same series as the chemical lots.

Demand already lives in the Fishbowl mirror — Giza SO 15548, product MS21077-5, three Sale lines: 50,000 (4,980 shipped, due Mar 13), 25,000 (0, due Mar 13), 70,020 (5,271 shipped, due Sep 18). **145,020 ordered / 10,251 shipped / 134,769 open** on TEST as of Oct 6 (bridge 1.8.0); PROD is current. All three lines are past due. Nothing between vendor receipt and shipment is recorded anywhere in SkyNet today.

What exists to build on (verified in src.zip of Oct 9 and on TEST):

- **Standalone J-FIN jobs** (`jobs.is_standalone_finishing`, `finishing_sends.is_standalone`, `standalone_operation_type`) are the manual-job path at the finishing station: created from Start New Job, auto-approved on completion, no compliance review, `J-FIN-NNNNNN` from `next_standalone_finishing_job_number()`. Only `passivation_only` has ever been used.
- **Stages** are a hard-coded `STAGES` array in `src/pages/Finishing.jsx` (Wash → Treatment → Dry, 10 references); Treatment picks a tank from `machines` where `machine_type = 'finishing'` (FIN-1, FIN-2 — the only two rows). Scheduling, the Production Display and the Mainframe all already special-case `machine_type = 'finishing'`, so ovens added under that type stay out of the scheduler.
- **CHECK constraints** on `finishing_sends` pin `finishing_stage` to wash/treatment/dry and `standalone_operation_type` to full_finishing/passivation_only — both must be rebuilt.
- **Lot RPCs** `next_finishing_lot_number()` (FLN-NNNNNN, `finishing_lot_seq`) and `next_standalone_finishing_job_number()` are SECURITY DEFINER, granted to `authenticated`. `finishing_sends` policies are `authenticated`-only; the station runs on an authenticated session with the PIN as the operator identity.
- The four SK21077-5-x parts exist in `parts`; there is no SK21077-5 / MS21077-5 assembly part, no BOM, no jobs. Two `component_lots` rows exist for the family — left alone (D-GIZA-06).
- Dashboards use CSS bars, no charting library (`SalesDemandChart.jsx`). Same here.

---

## 3. Scope

### 3.1 In scope

- Migration `2026-10-13_giza_tracker.sql` (TEST → PROD): ovens as machines, `machines.finishing_role`, `finishing_sends` columns + rebuilt checks, `programs` / `program_parts` / `program_ledger` / `dry_film_lot_map`, RPCs `assign_dry_film_fln`, `program_plating_lots`, `program_log_entry`, `program_void_entry`, views `v_program_pipeline`, `v_program_daily`, `v_program_demand`, seed row for the Giza program.
- Finishing station: `dry_film` operation type, Paint → Bake stages, oven picker, cure countdown, FLN assignment at bake completion, program-lot picker on Start New Job.
- Giza Dashboard page, Dashboards-menu entry, route, role gate, entry/void modals.
- Mainframe finishing strip recognises ovens.
- Batch C: manual cert creation — discovery + plan after A/B are live (§8.4).

### 3.2 Out of scope (named so nobody builds into it)

- Work orders, `work_order_assemblies`, Fishbowl MO, the Assembly module flag — the assembly re-enable round owns those. When it lands, the ledger's stage keys and lot columns map onto `work_order_assembly` / `outbound_sends` rows one-for-one; nothing here has to be undone.
- Outsourced Operations for the Electrolab leg (D-GIZA-04). The ledger captures qty, plating lot, expected return — enough to migrate later.
- Cert Repository changes before Batch C; `component_lots` stays as is (D-GIZA-06).
- Compliance review of dry-film batches (standalone rule applies: auto-approve). Batch C decides what Roger signs.
- Multi-oven loads under one batch (D-GIZA-02 revisit).
- Traveler changes for J-FIN dry-film jobs (no routing steps; cure record lives on the batch and surfaces in Batch C).

---

## 4. Process Model

### 4.1 Stage chain — steel nut SK21077-5-3

| # | Stage key | Who logs | Where | Lot carried | Extra fields |
|---|---|---|---|---|---|
| 1 | `received` | Ashley (from receiving's log) | Dashboard | nut lot (assigned by receiving) | vendor (Xiamen / Maxtrust), PO |
| 2 | `washer_inserted` | Ashley | Dashboard | nut lot | consumes SK21077-5-2 (1 per) |
| 3 | `sent_plating` | Ashley | Dashboard | nut lot | expected return date |
| 4 | `returned_plating` | Ashley (from receiving's log) | Dashboard | **plating lot** (assigned by receiving on return) ← ref: nut lot | |
| 5 | `painted` | James | Finishing kiosk — batch created at Paint | plating lot (picked), dry-film lot (5-digit) | qty = oven load (618 default) |
| 6 | `baked` | James | Finishing kiosk — bake complete | **FLN** minted from (plating lot, dry-film lot) | oven, in/out stamps, temp °F, verified count |
| 7 | `assembled` | Ashley | Dashboard — into the open final lot (§4.4) | FLN ← consumes SK21077-5-4 cage + SK21077-5-1 retainer (1 each) | assembled-by initials |
| 8 | `bagged` | Ashley | Dashboard — against a closed final lot | **final lot** (bag lot number) | inv initials |
| 9 | `shipped` | nobody — Fishbowl mirror | `fb_sales_order_lines.qty_fulfilled` on SO 15548 / MS21077-5 | | |

Components (cage -5-4, retainer -5-1, insert -5-2): `received` entries only (vendor, lot, qty, PO). Consumption is derived — insert at stage 2, cage and retainer at stage 7 — so Ashley never logs a consumption.

### 4.2 Occupancy (one place, SQL view `v_program_pipeline`)

Ledger stages are movements; the view derives what sits in each bucket. Painted/Baked come from `finishing_sends` and are never written to the ledger (D-GIZA-09).

```
waiting_washer      = Σ received(nut)                − Σ washer_inserted
waiting_plating     = Σ washer_inserted              − Σ sent_plating
at_electrolab       = Σ sent_plating                 − Σ returned_plating
waiting_paint       = Σ returned_plating             − Σ painted
in_paint            = Σ incoming_count  dry_film sends, stage 'paint', status in_finishing
in_oven             = Σ incoming_count  dry_film sends, stage 'bake',  status in_finishing
waiting_assembly    = Σ verified_count  dry_film sends, finishing_complete − Σ assembled
waiting_bag         = Σ assembled                    − Σ bagged
waiting_ship        = Σ bagged                       − shipped
shipped             = Σ qty_fulfilled (fb Sale lines, program product, program customer)
painted             = Σ incoming_count of all dry_film sends linked to the program
dry_film_loss       = painted − Σ verified_count (completed sends only)
component on hand   = Σ received(part) − derived consumption
```

A negative bucket is never blocked at entry (timing is real on the floor); it renders red with "over-moved" so it gets fixed, not hidden.

### 4.3 Lot rule (D-GIZA-03)

- Dry-film lot: a 5-digit number, entered at batch creation, pre-filled from the last dry-film batch (same persistence rule as the chemical drums), editable.
- Plating lot: picked from the program's returned-from-Electrolab lots with remaining quantity (`program_plating_lots`), or typed when the batch isn't a tracked program lot.
- FLN: assigned **when Bake completes**, by `assign_dry_film_fln(send_id)`: look up `dry_film_lot_map(plating_lot_number, dry_film_lot_number)`; if present, reuse its `finishing_lot_number`; if not, `next_finishing_lot_number()` → `FLN-NNNNNN`, insert the map row (`ON CONFLICT DO NOTHING`, then re-select — two ovens finishing together cannot mint twice). Written to `finishing_sends.finishing_lot_number` and `jobs.finishing_lot_number`. Same pair = same FLN across oven loads and across days.
- Until bake completes the card shows "FLN — assigned at bake".

### 4.4 Final assembly lots — the bag lot (D-GIZA-14, 15, 16)

The register replaces the paper sheet one-for-one and lives on the dashboard:

- **Open lot** (Ashley): SkyNet reserves the next number from the program's own counter (`programs.final_lot_next`, seeded 3007 so the sequence continues from the sheet), race-safe inside `program_open_final_lot`. One open lot per program at a time is the default; a second can be opened if the floor runs two in parallel.
- **Assembled entries** (stage 7) always land in an open lot — date, qty, assembled-by initials — exactly the sheet's Date / Qty / Assembled-by cells, with no three-cell limit.
- **Close lot** (Ashley, with the inspector's numbers): the component lots the sheet records — Cage SK#, Retainer SK#, Nylon Insert — picked from received lots with remaining quantity; the nut columns (nut lot / plating lot / FLNs) are **derived** from the FLNs consumed, not typed; two torsion-test samples (qty, in-lbs) and inspector initials; notes. Closing freezes the quantity (Σ assembled entries) and makes the number the bag lot.
- **Bagged entries** (stage 8) reference a closed lot; **Print lot label** opens a self-contained print window (lot number, MS21077-5, qty, date) on the count-sheet pattern — no new dependencies.
- **Historical rows** 3001–3006 are seeded with their lot numbers and status `historical`; Ashley completes their component lots and quantities from the paper via Edit so the register is continuous and Batch C can cite them.

---

## 5. Decisions Locked

| ID | Topic | Decision |
|---|---|---|
| D-GIZA-01 | Boundary | Standalone program tracker. No work orders, WOAs, Fishbowl MO, Assembly module. Migrates into the assembly round later; ledger stage keys are the mapping. |
| D-GIZA-02 | Kiosk batch unit | One batch = one oven load (default 618 = 6 pans × 103, qty editable), created at Paint, one oven at Bake. Revisit after the first week of live use. |
| D-GIZA-03 | Lot number | Existing FLN-NNNNNN scheme, assigned at bake completion, keyed on (plating lot, dry-film lot); same pair → same FLN (`dry_film_lot_map`). |
| D-GIZA-04 | Plating leg | Tracked in the program ledger (sent / returned, expected return, plating lot). Not Outsourced Operations. |
| D-GIZA-05 | Entry model | Movement ledger, one row per move, soft-void only (reason required). No daily snapshots. |
| D-GIZA-06 | Lot assignment | Receiving assigns nut lots and plating lots by hand as today; the tracker records them as typed. `component_lots` / Cert Repository untouched until Batch C. |
| D-GIZA-07 | Ovens | `machines` rows OVEN-1..4, `machine_type = 'finishing'`, new `finishing_role` ('tank' \| 'oven'); FIN-1/2 backfilled 'tank'; OVEN-3/4 inserted uncommissioned. Mainframe code-prefix heuristic gains `oven`. |
| D-GIZA-08 | Dashboard access | `/dashboards/giza` in the Dashboards menu for every role (SKY56 pattern). Writes: admin + `order_processor` additional role (`canLogProgramTracker`). RPC-enforced server-side. |
| D-GIZA-09 | Painted / Baked source | Derived from `finishing_sends` (`program_id` link) inside `v_program_pipeline`. Never duplicated into the ledger. |
| D-GIZA-10 | Dry-film lot | 5-digit, persisted like chemical lots, pre-filled from the last dry-film batch. Required before a dry-film batch can be created. |
| D-GIZA-11 | Shipped | `fb_sales_order_lines.qty_fulfilled` on Sale lines of the program's Fishbowl product for the program's customer. Nobody types shipments. |
| D-GIZA-12 | Cure record | Bake start = `stage_started_at` at the paint→bake move; bake end = `finishing_completed_at`; `bake_temp_f` default 350 (editable on the oven pick). Oven = `finishing_sends.machine_id`. |
| D-GIZA-13 | Manual certs | Batch C. Discovery needs a copy of a Giza cert Roger produces today; built after A and B are live on PROD. |
| D-GIZA-14 | Final lot register | Replaces the "MS21077 Platenut Assembly" sheet. Per-program integer counter (`programs.final_lot_next`), seeded 3007; 3001–3006 seeded as historical rows. Bag lot number = this number. |
| D-GIZA-15 | When the number is minted | Reserved when the lot is **opened**, so the team can label pans and bins while the lot fills over days as the sheet does; it becomes the bag lot when the lot is **closed**. (Mint-at-close instead is a one-line change if preferred.) |
| D-GIZA-16 | Lot close record | Cage / Retainer / Nylon Insert lots picked from received lots; nut lot, plating lot and FLNs derived from the FLNs consumed; two torsion samples (qty, in-lbs) + inspector initials; quantity frozen at close. Feeds Batch C. |

---

## 6. Schema Migration

Runnable file `2026-10-13_giza_tracker.sql` ships with Batch A after sign-off, executed end to end in the scratch Postgres first (cheatsheet §6), then applied to TEST by Claude, then PROD by Matt. Independently-runnable blocks, pure-ASCII block comments, no UUIDs — the oven rows copy `location_id`, `status`, `display_order` base from FIN-1. The shape:

### 6.1 Machines

```sql
ALTER TABLE public.machines ADD COLUMN IF NOT EXISTS finishing_role text
  CHECK (finishing_role IS NULL OR finishing_role IN ('tank','oven'));
UPDATE public.machines SET finishing_role = 'tank'
  WHERE machine_type = 'finishing' AND finishing_role IS NULL;
/* OVEN-1 .. OVEN-4: machine_type 'finishing', finishing_role 'oven', kiosk_enabled false,
   is_active true, is_commissioned true for 1-2 / false for 3-4, status 'available',
   location_id and display_order (+10..+40) taken from FIN-1. Idempotent on (location_id, code). */
```

### 6.2 finishing_sends

```sql
ALTER TABLE public.finishing_sends
  ADD COLUMN IF NOT EXISTS program_id uuid REFERENCES public.programs(id),
  ADD COLUMN IF NOT EXISTS plating_lot_number text,
  ADD COLUMN IF NOT EXISTS dry_film_lot_number text,
  ADD COLUMN IF NOT EXISTS bake_temp_f integer;
ALTER TABLE public.finishing_sends DROP CONSTRAINT IF EXISTS finishing_sends_finishing_stage_check;
ALTER TABLE public.finishing_sends ADD CONSTRAINT finishing_sends_finishing_stage_check
  CHECK (finishing_stage IN ('wash','treatment','dry','paint','bake'));
ALTER TABLE public.finishing_sends DROP CONSTRAINT IF EXISTS finishing_sends_standalone_operation_type_check;
ALTER TABLE public.finishing_sends ADD CONSTRAINT finishing_sends_standalone_operation_type_check
  CHECK (standalone_operation_type IS NULL OR standalone_operation_type IN ('full_finishing','passivation_only','dry_film'));
```

### 6.3 Program tables

```sql
CREATE TABLE public.programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,                 /* 'GIZA-21077' */
  name text NOT NULL,                        /* 'Giza — MS21077-5 nutplate' */
  customer_match text NOT NULL,              /* 'GIZA' — ILIKE against fb_sales_orders.customer_name */
  fb_product_num text NOT NULL,              /* 'MS21077-5' — fb_sales_order_lines.product_num */
  primary_part_id uuid NOT NULL REFERENCES public.parts(id),   /* SK21077-5-3 */
  oven_load_qty integer NOT NULL DEFAULT 618,
  final_lot_next integer NOT NULL DEFAULT 1,          /* seeded 3007 for GIZA-21077 */
  final_lot_label text NOT NULL DEFAULT '',           /* assembly part printed on the label: 'MS21077-5' */
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.program_final_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES public.programs(id),
  lot_number text NOT NULL,                  /* '3007' — the bag lot */
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','historical')),
  opened_at timestamptz NOT NULL DEFAULT now(), opened_by uuid REFERENCES public.profiles(id),
  closed_at timestamptz, closed_by uuid REFERENCES public.profiles(id),
  quantity integer,                          /* frozen at close = sum of assembled entries */
  cage_lot text, retainer_lot text, insert_lot text,
  nut_lots text[], plating_lots text[], finishing_lots text[],   /* derived at close from the FLNs consumed */
  torsion_1_qty integer, torsion_1_inlbs numeric, torsion_2_qty integer, torsion_2_inlbs numeric,
  inspected_by text, notes text,
  UNIQUE (program_id, lot_number)
);

CREATE TABLE public.program_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES public.programs(id),
  part_id uuid NOT NULL REFERENCES public.parts(id),
  role text NOT NULL CHECK (role IN ('nut','cage','retainer','insert')),
  consumed_at_stage text CHECK (consumed_at_stage IN ('washer_inserted','assembled')),
  qty_per integer NOT NULL DEFAULT 1,
  UNIQUE (program_id, part_id)
);

CREATE TABLE public.program_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES public.programs(id),
  part_id uuid NOT NULL REFERENCES public.parts(id),
  stage text NOT NULL CHECK (stage IN ('received','washer_inserted','sent_plating','returned_plating','assembled','bagged')),
  qty integer NOT NULL CHECK (qty > 0),
  lot_number text,                           /* the lot being moved (nut lot / plating lot / FLN) */
  ref_lot_number text,                       /* source lot when a stage assigns a new one (returned_plating: nut lot) */
  vendor text, po_number text,
  expected_return date,
  entry_date date NOT NULL DEFAULT current_date,
  final_lot_id uuid REFERENCES public.program_final_lots(id),   /* assembled: the open lot; bagged: a closed lot */
  done_by text,                              /* initials from the floor (assembled-by / inv) */
  notes text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual')),
  entered_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz, voided_by uuid REFERENCES public.profiles(id), void_reason text
);
CREATE INDEX ON public.program_ledger (program_id, stage, entry_date);

CREATE TABLE public.dry_film_lot_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plating_lot_number text NOT NULL,
  dry_film_lot_number text NOT NULL,
  finishing_lot_number text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id),
  UNIQUE (plating_lot_number, dry_film_lot_number)
);
```

RLS on all five: SELECT `authenticated`; INSERT/UPDATE/DELETE none — every write goes through the RPCs below (the D-S7 pattern). Seed: one `programs` row (GIZA-21077, `final_lot_next = 3007`, `final_lot_label = 'MS21077-5'`) + four `program_parts` rows by part number lookup + six `program_final_lots` rows 3001–3006 with status `historical` (numbers only; details completed from the paper by Ashley). `sources` of truth for the seed are the `parts` rows already on both projects; the migration raises a named GUARD if any of the four part numbers is missing.

### 6.4 RPCs (SECURITY DEFINER, `SET search_path = public`, EXECUTE revoked from PUBLIC and anon, granted to authenticated; NULL `auth.uid()` allowed for the SQL Editor)

- `assign_dry_film_fln(p_send_id uuid) RETURNS text` — §4.3. GUARDs: send exists, `standalone_operation_type = 'dry_film'`, both lots non-empty, send not already carrying an FLN (idempotent return if it does).
- `program_plating_lots(p_program_id uuid) RETURNS TABLE(plating_lot_number text, returned_qty int, painted_qty int, remaining int, last_returned date)` — returned_plating ledger minus linked dry-film sends; only `remaining > 0`. Powers the kiosk picker.
- `program_log_entry(p_program_id, p_part_id, p_stage, p_qty, p_lot, p_ref_lot, p_vendor, p_po, p_expected_return, p_entry_date, p_notes) RETURNS uuid` — role gate: `user_has_role('admin')` or `order_processor` in `profiles.roles`; writes `entered_by = auth.uid()`; one `audit_logs` row (`program_ledger_entry`). No quantity blocking (§4.2).
- `program_void_entry(p_entry_id, p_reason) RETURNS void` — same gate; reason required; sets `voided_*`; audit row (`program_ledger_void`). Voiding an `assembled` entry on a closed lot is refused with a named GUARD (reopen first).
- `program_open_final_lot(p_program_id, p_notes) RETURNS program_final_lots` — same gate; `SELECT ... FOR UPDATE` on the program row, takes `final_lot_next`, increments it, inserts the lot `open`; audit row (`program_final_lot_opened`).
- `program_close_final_lot(p_lot_id, p_cage_lot, p_retainer_lot, p_insert_lot, p_torsion jsonb, p_inspected_by, p_notes) RETURNS program_final_lots` — same gate; GUARDs: lot open, at least one assembled entry; freezes `quantity`; derives `finishing_lots` from the assembled entries' lot numbers, `plating_lots` and `nut_lots` through `dry_film_lot_map` and the ledger chain; audit row (`program_final_lot_closed`). `program_reopen_final_lot(p_lot_id, p_reason)` is admin-only.
- `program_update_final_lot(p_lot_id, ...)` — same gate; edits the recorded component lots / torsion / notes on `historical` and `closed` lots (never the number or the frozen quantity); audit row.

### 6.5 Views (revoke ALL from authenticated/anon/public, then GRANT SELECT to authenticated — new views inherit ALL otherwise)

- `v_program_pipeline` — one row per program: every bucket in §4.2 plus component on-hand per role, painted, dry_film_loss, oven count commissioned, computed from `program_ledger` (non-voided), `finishing_sends` (`program_id`, `standalone_operation_type = 'dry_film'`), `machines`, and `v_program_demand`.
- `v_program_final_lots` — the register: one row per lot with status, opened / closed, quantity (frozen, or live Σ assembled while open), assembled entries as a jsonb array of {date, qty, done_by}, the component lots, derived nut / plating / finishing lots, torsion samples, inspector, bagged qty.
- `v_program_daily` — program × date × stage × qty for the last 60 days: ledger stages by `entry_date`, `painted` by `finishing_started_at::date`, `baked` by `finishing_completed_at::date`, `shipped` omitted (the mirror has no per-day fulfilment).
- `v_program_demand` — program × SO line: `so_number, line_number, qty_ordered, qty_fulfilled, open, effective_due_date, days_late` for Sale lines (`type_id = 10`) of `fb_product_num` on non-removed SOs whose `customer_name ILIKE '%' || customer_match || '%'` and `status_id IN (10,20,25)`.

### 6.6 Critical column names (do not guess)

- `finishing_sends.incoming_count` (what James started with), `verified_count` (what came out), `finishing_started_at`, `finishing_completed_at`, `stage_started_at`, `machine_id`, `is_standalone`, `standalone_operation_type`, `finishing_lot_number`.
- `jobs.is_standalone_finishing`, `jobs.finishing_lot_number`, `jobs.good_pieces`, `jobs.source_description`.
- `machines.is_commissioned`, `machines.kiosk_enabled`, `machines.display_order`, UNIQUE `(location_id, code)`, status CHECK available/in_use/maintenance/offline/down.
- `fb_sales_order_lines.product_num`, `qty_ordered`, `qty_fulfilled`, `effective_due_date`, `type_id`, `removed_at`; `fb_sales_orders.customer_name`, `so_number`, `status_id`, `removed_at`.
- `parts.part_type` ('purchased' / 'manufactured'); there is no `parts.category`.

---

## 7. Code Changes

### 7.1 Files

| File | Type | Change |
|---|---|---|
| `src/pages/Finishing.jsx` | Update (surgical) | `STAGES` → `stagesFor(batch)` (`DRY_FILM_STAGES` = paint, bake) at all 10 sites; `loadMachines` keeps all finishing machines and splits `tanks` / `ovens` by `finishing_role`; tank modal filtered to tanks; new oven modal (paint → bake) writing `machine_id`, `bake_temp_f`, `stage_started_at`; Start New Job: third operation button "Dry Film (Paint → Bake)" with program-lot picker (`program_plating_lots`), plating lot, dry-film lot (5-digit, prefilled, required), qty default `programs.oven_load_qty`, source forced `received` with `source_description` "Plated SK21077-5-3 — plating lot X", chemical fields hidden; `handleSubmitNewJob` skips the FLN mint and starts at `paint` for dry_film; `handleAdvanceStage` last-stage branch calls `assign_dry_film_fln` before the existing standalone auto-approve + job complete; bake card shows cure countdown (120 min from `stage_started_at`, green when elapsed) and temp; station view gains a Dry Film grid (Paint \| one column per commissioned oven) rendered when any dry-film batch is active; `getCurrentChemicalLot`-style `getLastDryFilmLot()`. |
| `src/pages/Mainframe.jsx` | Update | Finishing-strip heuristic (`code.startsWith('fin') || name.includes('finishing')`) gains `code.startsWith('oven') || name.includes('oven')`; oven cards show the active bake batch and countdown where tank cards show the batch today. |
| `src/lib/roles.js` | Update | `canLogProgramTracker(profile)` = admin or `order_processor`, not read-only. |
| `src/lib/programTracker.js` | New | Queries (`loadProgram`, `loadPipeline`, `loadDaily`, `loadDemand`, `loadLedger`, `loadFinalLots`, `logEntry`, `voidEntry`, `openFinalLot`, `closeFinalLot`, `updateFinalLot`, `loadPlatingLots`) + pure helpers (`forecast`, `ovenCapacity`, `sevenDayRates`, `lotLabelHtml`). |
| `src/lib/programTracker.test.mjs` | New | `node:assert` tests for the pure helpers (repo convention). |
| `src/pages/dashboards/GizaDashboard.jsx` | New | The page (§7.2), including the Final Lots register, Open / Close / Edit lot modals and the lot-label print window. |
| `src/App.jsx` | Update | `DASHBOARDS` entry `{ label: 'Giza Dashboard', path: '/dashboards/giza' }`; route; import. |
| `src/config.js` | Update | `FEATURES.PROGRAM_TRACKER: true` (menu + route gate, default on), `PROGRAM_OVEN_LOADS_PER_DAY: 4` (capacity assumption, editable). |
| `Docs/Decisions.md` | Append | D-GIZA-01..16 per batch. |
| `Docs/migrations/2026-10-13_giza_tracker.sql` | New | §6. |

### 7.2 Giza Dashboard layout

Standalone office route under `MainApp` like the other dashboards (not the KitKiosk/Pricing pattern — Ashley is logged in). Header: program name, customer, product, bridge freshness (`fb_sync_state.last_rev_at`).

1. **Demand** — per SO line (part number first): ordered / shipped / open / due / days late; program totals. Source `v_program_demand`.
2. **Pipeline** — nine stage cards left to right with occupancy, colour by age of the oldest un-moved lot (ledger) and red "over-moved" on negatives; Paint and Oven cards show live batches (James's) with countdowns; each manual stage card has a **Log** button (gated) that opens the entry modal pre-selected on that stage.
3. **Components** — cage / retainer / insert: received, consumed, on hand; **buildable sets** = min(waiting_assembly nuts, cages, retainers); insert cover = on hand vs nuts waiting for washer.
4. **Throughput** — last 14 days, per stage, CSS bars; 7-day average per stage; constraining stage = lowest 7-day rate downstream of received.
5. **Forecast** — open qty ÷ constraining rate → days / projected finish date vs each line's due date; oven capacity/day = commissioned ovens × `oven_load_qty` × `PROGRAM_OVEN_LOADS_PER_DAY` vs actual baked/day (assumption shown on the card so it is never mistaken for a measurement).
6. **Final Lots** — the sheet as a table: Lot# · status · assembled rows (date / qty / by) · Cage SK# · Retainer SK# · Nut (nut lot / plating lot / FLN) · Nylon Insert · Torsion 1 · Torsion 2 · Insp · bagged qty. **Open next lot** (reserves 3007…), row actions **Log assembled**, **Close lot**, **Print label**, **Edit** (historical / closed details). Open lots sit at the top with a live running quantity.
7. **Ledger** — newest first, filter by stage / lot / part, Void (gated, reason required); voided rows stay visible struck through.

**Entry modal:** stage → part (fixed by stage: nut for 2–8, any component for `received`) → qty → lot (type-ahead over upstream lots with remaining qty for 2/3/4/7/8; free text for `received`) → ref lot (auto-filled, editable) → vendor + PO (`received`; quick-picks Xiamen / Maxtrust / Electrolab) → expected return (`sent_plating`) → final lot (`assembled`: the open lot, required — opens one if none; `bagged`: a closed lot) → done-by initials (`assembled`, `bagged`; quick-picks from recent) → date (default today) → notes. Soft warning when qty exceeds the upstream bucket; never blocks.

**Close-lot modal:** running quantity and the assembled rows read-only; Cage / Retainer / Nylon Insert lot pickers (received lots with remaining qty, free text allowed); the derived nut / plating / FLN chain shown read-only; Torsion 1 and 2 (qty, in-lbs); inspector initials; notes → Close. The label prints from the register row afterwards.

---

## 8. Claude Code Prompt Batches

Run in order, one in flight at a time, each on `feature/giza-tracker`; CC builds and stops (D-PROC-01). Each batch: SQL first (own file, applied to TEST by Claude with the result stated), then the CC prompt (anchors verified against the Oct 9 src.zip + applied working copies), then the ~2-minute Quick Test Procedure. ✅ / ❌ before the next batch.

### 8.1 Batch A — Migration + finishing kiosk dry-film process (D-GIZA-02, 03, 07, 09, 10, 12)

- Migration §6 on scratch → TEST. Seeds GIZA-21077 and OVEN-1..4.
- `Finishing.jsx`, `Mainframe.jsx` edits per §7.1.
- **Verify (James's flow on test-skynet):** Start New Job → Dry Film → pick a seeded plating lot (Claude seeds a TEST_ONLY `program_ledger` chain for one nut lot through `returned_plating`, labelled, fb_username-style note `claude-test-seed`) → 618 → Paint card appears → Advance → oven pick (only OVEN-1/2 offered; tanks absent) → countdown → Complete with verified count → FLN assigned, `jobs.finishing_lot_number` set, auto-approved, job complete. Second batch, same plating lot + dry-film lot → same FLN. Third batch, new dry-film lot → new FLN. A full_finishing batch still picks tanks only. Production Dashboard tally includes the completion.

### 8.2 Batch B — Giza Dashboard (D-GIZA-01, 04, 05, 06, 08, 11)

- `programTracker.js` + test, `GizaDashboard.jsx`, `roles.js`, `App.jsx`, `config.js`.
- **Verify:** every role sees the menu entry and the page; only admin / order_processor see Log, Void and the lot actions (RPC rejects a customer_service call); log received → washer → sent → returned on a lot; pipeline moves; Batch A's dry-film batches appear in Paint / Oven / waiting_assembly; Open next lot → 3007 (register shows 3001–3006 as historical); log assembled twice on different dates → running quantity; Close lot with component lots and torsion → quantity frozen, nut / plating / FLN chain derived from Batch A's FLN; Print label renders; log bagged against 3007 → waiting_ship; demand matches the Fishbowl numbers on TEST; void an entry → bucket restores; forecast shows the assumption line.

### 8.3 PROD rollout (Matt)

Numbered, with the review stop:

1. Run `2026-10-13_giza_tracker.sql` on PROD block by block (preview block first: expect 2 finishing machines → 'tank', 0 ovens; after: 6 finishing machines, OVEN-3/4 uncommissioned; 1 program, 4 program_parts; `v_program_demand` returns 3 lines for MS21077-5 with open = PROD's current numbers).
2. Review stop: paste the verify block output.
3. Merge `feature/giza-tracker` → test → main (fast-forward); Amplify deploys. Migration before frontend or the dashboard renders empty.
4. Smoke on PROD: Dashboards menu shows Giza Dashboard; Finishing → Start New Job offers Dry Film; Mainframe finishing strip shows Oven 1–4 (3 and 4 greyed as uncommissioned).
5. Tell James (new Dry Film button, oven pick, FLN comes at the end), Ashley (where to log, what receiving must hand her: nut lots, plating lots), Roger (Oven cards on the Mainframe; dry-film completions in the Production Dashboard tallies; certs are Batch C).

### 8.4 Batch C — Manual cert creation in the Cert Repository (D-GIZA-13) — after A/B are live

Not built in this plan version. Discovery inputs needed from Matt/Roger before scoping: (1) one cert Roger produces for Giza today (the C of C format and what it must cite — material certs from Xiamen/Maxtrust, Electrolab plating cert, dry-film cure record, lot genealogy); (2) whether the cert is per shipment, per FLN, or per SO line; (3) who signs. Design hypothesis, to confirm against that sample: Cert Repository → **Manual Cert** → pick program + shipment (FLNs) → SkyNet assembles the genealogy from the ledger and the batches (nut lots → plating lot → dry-film lot → FLN → cage / retainer / insert lots, oven, cure in/out, °F) → Roger attaches the vendor certs (uploads, `component_lot_documents` pattern) → C of C PDF via the `certPackagePdf.js` route → stored against the shipment and searchable by any lot in the chain. Everything the tracker captures in A/B is chosen so this needs no re-entry.

---

## 9. Test Checklist (TEST)

| # | Test |
|---|---|
| T-01 | Migration applies cleanly; re-run is a no-op; both rebuilt CHECKs accept old and new values. |
| T-02 | OVEN-1..4 present; FIN-1/2 `finishing_role = 'tank'`; scheduler modal and Production Display still exclude them. |
| T-03 | Dry-film batch cannot be created without a 5-digit dry-film lot or a plating lot. |
| T-04 | Paint → Bake offers ovens only; Treatment offers tanks only; uncommissioned ovens are not offered. |
| T-05 | Bake countdown reads 2 h from the move; temp defaults 350 and is editable. |
| T-06 | Completion requires verified count; FLN assigned; same (plating, dry-film) pair → same FLN; new pair → new FLN; `jobs.finishing_lot_number` set; auto-approved; job `complete`. |
| T-07 | `assign_dry_film_fln` is idempotent and refuses a non-dry-film send with a named GUARD. |
| T-08 | Dashboard visible to all roles; Log/Void visible to admin + order_processor only; RPC rejects others. |
| T-09 | Ledger chain moves the pipeline exactly as §4.2 (hand-computed numbers in the seed script header). |
| T-10 | Over-move renders red, is not blocked, and is audited. |
| T-11 | Painted / in oven / waiting_assembly reflect Batch A batches with no ledger rows. |
| T-12 | Demand matches `fb_sales_order_lines` for MS21077-5 on TEST; a removed line drops out. |
| T-13 | Void restores the bucket and keeps the row visible, struck through, with reason and user. |
| T-14 | Throughput by day lands on `entry_date` for manual stages and on finishing timestamps for kiosk stages (local-noon rule respected). |
| T-15 | `node src/lib/programTracker.test.mjs` passes; `npm run build` clean; eslint no new findings. |
| T-16 | Open next lot mints 3007, then 3008; two users opening at once never share a number; 3001–3006 present as `historical`. |
| T-17 | Assembled entries require an open lot; close freezes quantity = Σ entries; derived nut / plating / FLN chain matches the Batch A batches; close with zero entries is refused; void on a closed lot's entry is refused. |
| T-18 | Label window shows lot number, MS21077-5, frozen quantity and close date; bagged entries only accept closed lots. |

---

## 10. Risks & Open Items

- **STAGES is referenced ten times in `Finishing.jsx`.** Missing one site leaves a dry-film card rendering Wash/Treatment/Dry pills. The prompt converts every site programmatically and the VERIFY asserts zero remaining `STAGES[` / `STAGES.` references.
- **CHECK constraint rebuild.** Dropped by name (`finishing_sends_finishing_stage_check`, `finishing_sends_standalone_operation_type_check` — names verified on TEST); the migration guards that the names match on PROD before dropping.
- **Fishbowl customer naming.** The mirror has `GIZA TECHNOLOGIES / AB`; the match is `ILIKE '%GIZA%'`. If Giza ships under a second account name, the program row's `customer_match` is edited, not code.
- **Batch sizing is a guess until James runs it.** If 618-piece batches cost too many clicks, D-GIZA-02 flips to paint-run batches with oven loads underneath — a Batch A2, not a rewrite.
- **Receiving discipline.** The whole chain keys on receiving writing a nut lot on arrival and a plating lot on return. Ashley types what receiving wrote; the dashboard cannot repair a missing lot.
- **Production Dashboard tallies** gain dry-film completions (J-FIN kept in finishing-throughput by SKY51). Say so to Roger; exclude later if it muddies the passivation picture.
- **Assembly round collision.** Both rounds touch `Finishing.jsx` and the finishing completion path. One change in flight: the Giza branch merges before the assembly branch rebases.
- **No per-day shipments** in the mirror — throughput shows shipped as a running total, not a daily bar.
- **Paper legibility.** The scan's component lots are partly ambiguous (3005's retainer, 3006's cage). The migration seeds only the six numbers; Ashley confirms the details from the physical sheet, so no misread digit is ever stored as fact.
- **Parallel open lots.** The default is one open lot per program; if the floor keeps two bins going, Open next lot still works and the entry modal asks which — no schema change.

---

## 11. Spec & Documentation Updates

- `SkyNet_Specification` → **v5.0**: §5.9 Finishing Station (dry-film operation type, ovens, cure record, FLN-at-bake), new §5.39 Program Tracker & Giza Dashboard (pipeline, ledger, final lot register), §8 Lot Number Chain (dry-film rule; final lot = program counter), §10.14 schema additions, §12 sprint history, §13 follow-ups (Batch C, paint-run batching, Outsourced Operations migration).
- `Docs/Decisions.md` — Sprint 15 header + D-GIZA-01..16 appended by CC per batch.
- `Docs/migrations/2026-10-13_giza_tracker.sql` (+ TEST-only seed file, never run on PROD).
- Cheatsheet: nothing new unless the round teaches something.

---

## 12. Definition of Done

- T-01..T-15 pass on TEST; migration on PROD with the verify output pasted; `feature/giza-tracker` merged, main == test.
- James has created, baked and completed a real SK21077-5-3 dry-film batch on PROD with an FLN.
- Final lot 3007 has been opened, filled, closed and labelled on PROD, and the paper sheet is retired.
- Ashley has logged one real day on the Giza Dashboard and the pipeline matches what is on the floor.
- The Giza Dashboard shows open quantity, days late and a projected finish date against SO 15548 without anyone typing a shipment.
- Spec v5.0, Decisions.md, migration file committed. Batch C discovery scheduled with Roger's sample cert in hand.
