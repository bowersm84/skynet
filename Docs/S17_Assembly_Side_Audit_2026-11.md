# S17 Assembly-Side Audit — November 2026

**Date:** 2026-11-03 · **Sprint:** S17 Batch 0 (read-only) · **Plan:** `Docs/Implementation_Plans/S17_Implementation_Plan.md` v1.1
**Source audited:** the SkyNet app (`src/`), Edge Functions (`supabase/functions/`) and SQL (`Docs/migrations/`) on `main` at `1565e2a` (branch `feature/s17-assembly`).
**Method:** code reading only; nothing was changed. Where a table has no defining migration in the repo, its columns and constraints were read from the Supabase TEST catalog (`ylzmyjjqibpbqbwjsnqj`) with three read-only `information_schema` / `pg_catalog` queries on 2026-11-03 ("TEST catalog" below). PROD was not queried. Companion: `Docs/Fishbowl_Bridge_Audit_2026-11.md` (bridge side).

**Four findings that change Batch B's starting point** (details in §8):
1. `work_orders.origin` does not exist. The plan's `stock_assembly` origin (D-ASM-03, §7.2) needs a new column or must ride on the existing `order_type`.
2. `getJobsCompleteRollup` does not exist anywhere in code or history; job readiness is inline in `Assembly.jsx` and duplicated in `Mainframe.jsx`.
3. A work order with no jobs is invisible to the Assembly board, WO Lookup, TCO Review and the nightly TCO auto-close, so it can never be closed. D-ASM-03's "existing floor, routing, outsourcing, TCO, traveler and genealogy apply unchanged" does not hold without changes.
4. No settings/config table exists; `kiosk-authenticate` refuses the `assembly` role; `program_log_entry` refuses everyone but `admin` / `order_processor`.

---

## 1. Existing Assembly module

### 1.1 `src/components/Assembly.jsx` — call graph
- **Mount:** `Assembly({ profile, onUpdate })` (`Assembly.jsx:20`), rendered from Mainframe only when `FEATURES.ASSEMBLY_MODULE` is true (`src/pages/Mainframe.jsx:2416-2421`).
- **Load — `loadAssemblies()`** (`Assembly.jsx:112-305`): one query on `work_orders` (`id, wo_number, customer, priority, due_date`) embedding `work_order_assemblies(id, quantity, status, station_number, assembler_number, assembly_started_at, assembly_completed_at, assembly_notes, good_quantity, bad_quantity, assembly_id, parent_work_order_assembly_id, assembly_lot_number, assembly:parts!work_order_assemblies_assembly_id_fkey(id, part_number, description, part_type), work_order_assembly_routing_steps(id, step_order, step_name, step_type, status))` and `jobs(id, status, work_order_assembly_id, quantity, good_pieces, missed_production_entries(quantity), is_maintenance, finishing_sends(id, quantity, verified_count, compliance_status, compliance_good_qty, compliance_bad_qty), outbound_sends(id, quantity, quantity_returned, returned_at))`, filtered `.not('order_type','eq','maintenance')`, ordered by `due_date` (`Assembly.jsx:116-166`). Realtime reload on `jobs` and `work_order_assemblies` changes (`Assembly.jsx:311-315`).
- **Readiness, per WOA** (`Assembly.jsx:186-252`):
  - skip any WOA whose assembly part is `finished_good` (`:189`, D-NEST-04);
  - `woaJobs` = jobs with `work_order_assembly_id = woa.id` (`:192`); `childSubs` = WOAs whose parent is this WOA (`:197-199`);
  - `allJobsReady` = every job in `ready_for_assembly | in_assembly | complete` (`:206-208`); `hasAssemblyWork` = some job in `ready_for_assembly | in_assembly`, or no jobs and at least one child sub-assembly (`:211-213`); skip unless both (`:216`);
  - `blocked` when any child sub-assembly is not `complete` (`:200-204`, `:237`; D-NEST-08);
  - bucket: `in_progress`/`paused` → In Progress; `complete` → Completed this week (from Sunday); otherwise Queued (`:241-251`). A WO with no WOA rows becomes a "virtual" queued item flagged `missingAssembly` (`:253-284`).
- **`computeSupplyQty(woa, woaJobs, childSubs)`** (`Assembly.jsx:69-89`): for each non-maintenance job, `floor(getEffectiveQty(job).qty × woa.quantity ÷ job.quantity)`; for each child sub, `floor(good_quantity × woa.quantity ÷ sub.quantity)`; returns the minimum, or `woa.quantity` when there are no jobs and no subs. `getEffectiveQty` is `src/lib/effectiveQty.js` (import `Assembly.jsx:3`).
- **`getJobsCompleteRollup`: does not exist.** `git grep` finds it only in the S17 plan (`S17_Implementation_Plan.md:162`). The equivalent logic is the inline pair above, duplicated for the Assembly KPI at `src/pages/Mainframe.jsx:321-327` (D-NEST-09).
- **Start — `handleStartAssembly()`** (`Assembly.jsx:323-430`): WOA → `in_progress` with `station_number`, `assembler_number`, `assembly_started_at`, `assembly_started_by = profile.id`, `assembly_notes`, `assembly_lot_number` (typed ALN), `assembly_lot_entered_by`, `assembly_lot_entered_at` (`:358-371`; a virtual item inserts the WOA instead, `:333-350`); routing step `step_order = 1` `pending → in_progress`, `started_at` (`:388-398`); this WOA's jobs `ready_for_assembly → in_assembly` (`:403-411`). Station and assembler are numbers picked from dropdowns (`:1168-1187`).
- **Complete — `handleCompleteAssembly()`** (`Assembly.jsx:433-611`):
  1. step 1 → `complete`, `completed_at`, `completed_by`, `quantity = good`, `lot_number = assembly_lot_number` (`:450-461`);
  2. if a pending external step exists, insert an `outbound_sends` row for the good quantity not yet sent (`:475-500`);
  3. close each external step whose sends have all returned, with total returned and the latest vendor lot (`:507-540`);
  4. WOA status = `ready_for_outsource` if any step is not `complete | skipped | removed`, else `complete` for a sub-assembly or `pending_tco` for a top assembly; writes `assembly_completed_at`, `assembly_completed_by`, `good_quantity`, `bad_quantity`, `assembly_notes` (`:542-569`);
  5. a finished sub-assembly is checked into its parent: `assembly_component_checkins` insert with `source_work_order_assembly_id` (`:573-585`);
  6. with no pending step, this WOA's jobs `ready_for_assembly | in_assembly → pending_tco` (`:591-598`).
- **Send Batch — `openSendBatchModal()` / `handleSendBatch()`** (`Assembly.jsx:614-681`): inserts `outbound_sends` with `source_type 'work_order_assembly'`, `source_id = woa.id`, `routing_step_id`, `operation_type` from `deriveAssemblyOpType(step_name)` (`:101-109`), `quantity`, `sent_by`. The button is on every in-progress card (`:984-994`).
- **Pause — `handlePauseAssembly()`** (`Assembly.jsx:684-746`): "return to queue" sets WOA `pending`, clears station/assembler, `good_quantity = count`, and moves jobs `in_assembly → ready_for_assembly` **by `work_order_id`** (`:711-719`, not scoped to the WOA, unlike Start/Complete); "pause at station" sets WOA `paused` and `good_quantity` (`:722-731`).
- **Resume — `handleResumeAssembly()`** (`Assembly.jsx:749-771`): WOA → `in_progress`.

**Tables and columns touched by `Assembly.jsx`:** reads `work_orders`, `work_order_assemblies`, `parts`, `work_order_assembly_routing_steps`, `jobs`, `missed_production_entries`, `finishing_sends`, `outbound_sends` (columns above); writes `work_order_assemblies` (`status, station_number, assembler_number, assembly_started_at/_by, assembly_completed_at/_by, assembly_notes, assembly_lot_number, assembly_lot_entered_by/_at, good_quantity, bad_quantity`), `work_order_assembly_routing_steps` (`status, started_at, completed_at, completed_by, quantity, lot_number`), `jobs` (`status, updated_at`), `outbound_sends` (insert), `assembly_component_checkins` (insert). All writes are direct browser table writes; there is no RPC.

### 1.2 `work_order_assemblies` — columns, status enum and transitions
- **Columns** (TEST catalog; the base table is not created in any repo migration): `id, work_order_id, assembly_id, quantity, created_at, status (varchar), assembly_started_at, assembly_started_by, assembly_completed_at, assembly_completed_by, assembly_notes, station_number, assembler_number, good_quantity, bad_quantity, order_quantity, stock_quantity, assembly_lot_number, assembly_lot_entered_by, assembly_lot_entered_at, parent_work_order_assembly_id`.
- **Status enum** — `Docs/migrations/2026-05-03_Assembly_Route_Changes.sql:45-57` (TEST catalog matches):
  ```sql
  ALTER TABLE public.work_order_assemblies
    ADD CONSTRAINT work_order_assemblies_status_check
    CHECK (status::text = ANY (ARRAY[
      'pending'::text, 'in_progress'::text, 'paused'::text, 'ready_for_outsource'::text,
      'at_external_vendor'::text, 'pending_tco'::text, 'complete'::text ]));
  ```
- **Transitions the code makes:**

| From | To | Where |
|---|---|---|
| `pending` / NULL | `in_progress` | Start, `Assembly.jsx:361` |
| `in_progress` | `paused` | Pause at station, `Assembly.jsx:726` |
| `in_progress` / `paused` | `pending` | Pause and return to queue, `Assembly.jsx:701` |
| `paused` | `in_progress` | Resume, `Assembly.jsx:757` |
| `in_progress` | `ready_for_outsource` / `complete` (sub) / `pending_tco` | Complete, `Assembly.jsx:555-557` |
| `ready_for_outsource` | `at_external_vendor` | Outsourced Operations send-out, `src/components/OutsourcedJobs.jsx:556-563` |
| `at_external_vendor` | `complete` (sub) / `pending_tco` | Outsourced Operations return, `src/components/OutsourcedJobs.jsx:731-739` |
| any ≠ `complete` | `complete` | TCO approve, `src/components/TCOReview.jsx:188-195`; nightly auto-close, `Docs/migrations/2026-09-02_auto_close_stale_tco.sql:138-139` |

  None of the plan's build states (`requested`, `assigned`, `released`, `ready_to_post`, `posted`, `verified`, `mismatch`; plan §7.3) exist; Batch B widens this CHECK or carries them in new columns.

### 1.3 The three ALN columns
`assembly_lot_number text`, `assembly_lot_entered_by uuid → profiles`, `assembly_lot_entered_at timestamptz` (`Docs/migrations/2026-05-03_Assembly_Route_Changes.sql:38-42`). Typed by hand in the Start modal (`Assembly.jsx:330`, `:345-347`, `:367-369`) and copied to the Assemble step's `lot_number` at Complete (`Assembly.jsx:457`). No sequence, no uniqueness, no format check. Until the module lands the ALN is entered in the cert package (D-CERTPKG-07, `Docs/Decisions.md:2238`).

### 1.4 `assembly_component_checkins`
- Columns (TEST catalog; base table not in a repo migration): `id, work_order_assembly_id, job_id, checked_in_at, checked_in_by, quantity_received, condition_notes, created_at, source_work_order_assembly_id`.
- Exactly one source: `CHECK ((job_id IS NOT NULL) <> (source_work_order_assembly_id IS NOT NULL))`; `job_id` made nullable (`Docs/migrations/2026-06-16_nested_assembly_batch_a.sql:24-43`; D-NEST-02).
- Writers: sub-assembly check-in at Complete (`Assembly.jsx:573-585`); component check-in when Compliance approves a finishing batch of a job that has a WOA (`src/components/ComplianceReview.jsx:780-795`).
- It records quantities, not lots. The plan's `assembly_component_lots` (lot per component) is new.

### 1.5 Routing-step tables
- `work_order_assembly_routing_steps` (`Docs/migrations/2026-05-03_Assembly_Route_Changes.sql:9-36`): `step_order` (unique per WOA), `step_name`, `step_type` `internal | external`, `station`, `status` `pending | in_progress | complete | skipped | removal_pending | removed`, removal request/approval columns, `is_added_step`, `added_by/_at`, `lot_number`, `quantity`, `started_at`, `completed_at`, `completed_by`, `operator_initials`, `notes`. RLS: select/insert/update for `authenticated`, delete admin only (`:174-195`).
- Templates: `routing_templates.template_type` `component | assembly` (`:72-91`); seeded `Standard Assembly` (Assemble), `Painted Assembly` (Assemble, Paint external), `Heat-Treated Assembly` (Assemble, Heat Treatment external) in `routing_template_steps` (`:93-122`); every active assembly part got an `Assemble` row in `part_routing_steps` (`:124-129`).
- Copied per WOA at Create WO from `part_routing_steps` (`src/components/CreateWorkOrderModal.jsx:797-846`) and for nested sub-WOAs (`src/lib/nestedAssembly.js:132`). Step 1 is the Assemble step by convention (`Assembly.jsx:387`, `:449`).

### 1.6 How `outbound_sends` rows are created for assemblies
- Columns (TEST catalog): `id, job_id, work_order_id, operation_type, vendor_name, quantity, sent_at, sent_by, expected_return_at, returned_at, returned_by, vendor_lot_number, cert_document_path, notes, created_at, updated_at, job_routing_step_id, quantity_returned, finishing_send_id, source_type, source_id, routing_step_id, consolidation_group_id, cancelled_at, cancelled_by, cancel_reason`. `source_type` CHECK `NULL | finishing_send | work_order_assembly` (`2026-05-03_Assembly_Route_Changes.sql:66-71`). `source_id` is polymorphic, no FK (`OutsourcedJobs.jsx:356-357`).
- **Only `Assembly.jsx` creates assembly rows** — at Complete (`:486-499`) and Send Batch (`:656-665`) — with `sent_at` NULL, which means "ready to send". `operation_type` is derived from the step name (`:101-109`; CHECK values listed at `:100`).
- **Who sends:** Outsourced Operations lists `source_type = 'work_order_assembly' AND sent_at IS NULL AND cancelled_at IS NULL` (`OutsourcedJobs.jsx:358-366`); `handleLogSendOut()` (`OutsourcedJobs.jsx:536`) writes `vendor_name` and `sent_at` and flips the WOA to `at_external_vendor` (`:556-563`). Admin cancel of a ready card is D-OUTCANCEL-01 (`Docs/migrations/2026-11-03_D-OUTCANCEL-01_outsourced_cancel.sql`). Today Jody also has a send-side control — the Send Batch button (`Assembly.jsx:984-994`) creates ready rows mid-assembly; D-ASM-05 removes it.

### 1.7 `src/pages/dashboards/AssemblyDisplay.jsx`
Route `/dashboards/assembly` (`src/App.jsx:648`; menu `src/App.jsx:40`), not gated by `ASSEMBLY_MODULE`. Two auto-scrolling panels, no views: finishing batches `finishing_sends` with `status = 'in_finishing'` and `is_standalone = false`, grouped by WO (`AssemblyDisplay.jsx:48-103`); and **jobs** with `status = 'ready_for_assembly'` and `is_standalone_finishing = false`, sorted by WO due date (`:105-140`). Realtime on `finishing_sends` and `jobs` plus a 30 s poll (`:148-164`). It reads no WOA rows, so builds, benches and assemblers do not appear.

### 1.8 `src/config.js` flags
| Flag | Value | Note | Source |
|---|---|---|---|
| `ASSEMBLY_MODULE` | `false` | hides Assembly nav/KPI; components route to `pending_tco` after external work | `src/config.js:11-30` |
| `NESTED_ASSEMBLY` | `true` | comment says "Keep false in PROD", but `config.js` builds both TEST and PROD | `src/config.js:52-60` |
| `MATERIAL_KIOSK` | `true` | | `src/config.js:39` |
| `TRAVELER_KIOSK` | `true` | D-TKIOSK-12 | `src/config.js:49` |
| `KIT_STC_REGISTRY` / `KIT_PACKING_SLIP` | `true` / `false` | kit kiosk; slip upload retired (D-KSTC-38) | `src/config.js:89`, `:124` |
| `PROGRAM_TRACKER` | `true` | Giza | `src/config.js:166` |
| `CUSTOMER_PROGRAMS` | `true` | | `src/config.js:180` |
| `PROGRAM_OVEN_LOADS_PER_DAY` | `4` | | `src/config.js:188` |

No `ASSEMBLY_KIOSK` flag exists yet (plan name). **Every site that reads `ASSEMBLY_MODULE`:** `src/components/ComplianceReview.jsx:840`, `:1537`, `:1706`; `src/components/OutsourcedJobs.jsx:618`, `:836`, `:981`; `src/lib/finishingCompletion.js:22`; `src/pages/dashboards/PresidentsBridge.jsx:305`, `:427`, `:433`, `:436`; `src/pages/Mainframe.jsx:1835`, `:1874`, `:2416`, `:2421`, `:2933`. `NESTED_ASSEMBLY` is read only in `src/components/CreateWorkOrderModal.jsx` (`:411`, `:436`, `:459`, `:556`, `:704`, `:984`, `:1054`, `:1727`).

### 1.9 D-NEST-13 and the finished-good routing in force
D-NEST-13 is on `main` as commit `12a6768` (2026-09-28, reached `test` and `main` through merge `912d9ed`): `isJobLeafNode()` makes a `finished_good` with no children a job leaf and `isGroupNode()` keeps a `finished_good` with children a group (`src/lib/nestedAssembly.js:84-96`), used by the Create WO tree and submit and by Edit WO's component picker (`src/components/EditWorkOrderModal.jsx:81`).

**The deferred item recorded under D-NEST-13 is not visible on `main`.** Note (2) of D-NEST-13 (`Docs/Decisions.md:3928`): a finished good that has its own BOM (SK2003-10A inside SK2003-14A, -24A, -42A, SK2003-51ADJ) still creates a sub-WOA typed `finished_good`, and `Assembly.jsx` skips such WOAs, so with `ASSEMBLY_MODULE` on that sub-WOA would never reach `complete` and would block its parent. On `main` at `1565e2a` the skip is still there (`Assembly.jsx:189`); the last commit touching `Assembly.jsx` is `dc938aa` (before D-NEST-13); the two commits dated 2026-11-03 are D-OUTCANCEL-01 and D-GIZA-31; no migration dated 2026-11-03 touches assembly. D-ASM-18 records the fix as promoted to PROD by Matt on Nov 3; if that was a database or data change on PROD it is not in the repo, and this audit cannot see PROD. **Matt to confirm what was promoted** before Batch B relies on it.

Finished-good routing in force today:
- A component job leaving finishing, outsourcing or post-manufacturing compliance goes to `ready_for_outsourcing` if an external step is pending, else `pending_tco` when its part is `finished_good` **or** `ASSEMBLY_MODULE` is false, else `ready_for_assembly` (`src/lib/finishingCompletion.js:7-25`; `ComplianceReview.jsx:840`, `:1524-1541`, `:1706`; `OutsourcedJobs.jsx:618`, `:836`, `:981`). With the flag off, **every** job goes to `pending_tco` and assembly is bypassed.
- The Assembly board skips WOAs whose part is `finished_good` (`Assembly.jsx:189`; D-NEST-04, `Docs/Decisions.md:1374`).
- In a BOM, a childless finished good is a job leaf; a finished good with children is a group and becomes a sub-WOA (`nestedAssembly.js:84-96`).

---

## 2. Kiosk patterns

### 2.1 `PinPad`
`src/components/PinPad.jsx:6-43` — display only; the caller owns the PIN state. Props: `icon`, `title`, `subtitle` (default `'Enter your PIN'`), `pin`, `error`, `busy`, `maxLength` (default 4), `buttonLabel` (default `'Enter'`), `onDigit(d)`, `onClear`, `onBackspace`, `onSubmit`. Submit is disabled while `pin.length < 4 || busy`; PinPad makes no network call. Used by `Kiosk.jsx:4414`, `Finishing.jsx:2079`, `MaterialKiosk.jsx:636`, `TravelerKiosk.jsx:401`, `KitKiosk.jsx:905` and `:1499`.

### 2.2 `kiosk-authenticate` and the kiosk JWT
`supabase/functions/kiosk-authenticate/index.ts`:
- Input `{ pin, machine_id, device_id }`; PIN shorter than 4 or no `machine_id` → 401 (`:40-47`).
- PIN lookup with the service-role client: `profiles … .eq('pin_code', pin).eq('is_active', true).limit(2)`; zero or two matches → 401, a collision is audited `kiosk_pin_collision` (`:57-84`). The PIN is compared as plain text.
- **Role gate on the primary role only:** `ALLOWED_ROLES = ['machinist','admin','finishing','display']` (`:26`, check `:88-90`). **`assembly` is not allowed.**
- Machine must be active and commissioned (`:94-104`).
- JWT HS256 with `JWT_SECRET` (`:109-148`): `sub` = profile id, `aud` and `role` = `'authenticated'` (the Postgres role), `iss` = `<SUPABASE_URL>/auth/v1`, `iat`, **`exp = iat + 8 h`** (`SHIFT_SECONDS`, `:25`, `:123-124`), `email`, `app_metadata { kiosk: true, kiosk_machine_id, kiosk_device_id }`, `user_metadata { full_name, role, username }`. The `refresh_token` is random and never honoured (`:150-154`). Audited `kiosk_authenticated` (`:156-166`).
- No `src/lib` helper; each kiosk calls the function inline (`Kiosk.jsx:1837`, `MaterialKiosk.jsx:157`, `TravelerKiosk.jsx:144`, `KitKiosk.jsx:288`) after choosing an anchor machine (first active, commissioned, by `display_order`; `TravelerKiosk.jsx:138-142`; D-KSTC-09). The token is adopted with `supabase.auth.setSession(...)` + `stopAutoRefresh()` on the shared client (`TravelerKiosk.jsx:149-158`; `src/lib/supabase.js:6-9`), so a kiosk sign-out also signs the main app out in the same browser profile (D-KIOSK-04, `Docs/Decisions.md:3835-3839`).

### 2.3 Inactivity sign-out (D-TKIOSK-09)
`const INACTIVITY_TIMEOUT = 2 * 60 * 1000` (`src/pages/TravelerKiosk.jsx:47`); checked every 15 s, never while printing (`:203-209`); reset by `mousedown`/`keydown`/`touchstart`/`pointerdown` (`:194-200`), PIN success (`:161`) and the print/setup handlers' `finally` blocks (`:293-381`); `handleLogout()` runs `signOut({ scope: 'local' })` and clears state (`:184-191`). For comparison: MaterialKiosk 3 min (`MaterialKiosk.jsx:61`), machine Kiosk 30 min (`Kiosk.jsx:98`), KitKiosk none.

### 2.4 Lot-entry pieces an assembly kiosk can reuse
There is **no extracted lot-entry component**; lot inputs are inline JSX:
- MaterialKiosk: `<input list="rack-lot-list">` + `<datalist>` fed by `lotSuggestions` from `material_availability` (`MaterialKiosk.jsx:241-257`, `:396-406`, `:997-1004`); lot-mismatch modal and `handleCorrectLot` (`:528`, `:1030-1060`); pure helper `lotAllowed(existingLot, newLot)` (`src/lib/materialIssues.js:44-49`).
- KitKiosk: inline stud/receptacle lot inputs (`KitKiosk.jsx:1277-1290`); file-local `Field` (`:1530`) and `Suggestions` (`:1557`); per-save PIN confirm `handlePinConfirm` → `doSave(createdById, createdByName)` → RPC `kit_assign_and_log_many(p_created_by …)` (`:686-709`, `:825-850`) — the "PIN identifies the person, not `auth.uid()`" pattern (`:822-824`).
- Exported: `Typeahead({ label, value, onChange, pinned, onPin, onUnpin, fetcher, renderItem, placeholder, disabled })` (`src/components/kitregistry/ui.jsx:206`), `GridInput` (`src/components/kitregistry/SlipReviewGrid.jsx:13`).

### 2.5 Which kiosks need a `kiosk_sessions` row
`kiosk_sessions` columns (TEST catalog): `id, operator_id, machine_id, logged_in_at, is_active, device_id, logged_out_at, logout_reason`.
- **Need one:** machine Kiosk (`Kiosk.jsx:505-513` restore, `:1771-1807` insert with D-KIOSK-04 scoping, `:1964-1970` logout, `:604-681` displacement listener and poll) and Finishing (`Finishing.jsx:1063-1150`; it looks up `profiles.pin_code` directly instead of calling `kiosk-authenticate`, `:1047-1052`).
- **Do not:** TravelerKiosk (`TravelerKiosk.jsx:9`), MaterialKiosk, KitKiosk.

### 2.6 Roles, profiles and PINs
- Primary role `profiles.role`; additional roles `profiles.roles text[]` (TEST catalog; D-MROLE-02). The role CHECK lists `admin, compliance, machinist, assembly, display, scheduler, customer_service, finishing, president, viewer, purchaser, integration` (`Docs/migrations/2026-08-25_fishbowl_bridge_a.sql:26-28`); `roles[]` is unconstrained. `order_processor` needs no DDL — it lives in `roles[]` (`2026-08-25_fishbowl_bridge_a.sql:11-12`; D-FB-13, `Docs/Decisions.md:3162`).
- Client: `userRoles(profile)` = role ∪ roles, `hasRole(profile, ...roles)` (`src/lib/roles.js:21-28`); e.g. `canActOnOrderQueue` = admin or order_processor (`roles.js:64-66`). There is no auth hook; the profile is loaded in `App.jsx:182-186` and passed down.
- SQL: `user_has_role(p_uid uuid, VARIADIC p_roles text[])` (TEST catalog; its definition is not in any repo migration), wrapped by `_fb_gate`, `_pricing_gate`, `_program_gate` and others.
- PIN: `profiles.pin_code` plain text with a partial unique index (`Docs/Decisions.md:39-42`). PIN set-up is required only for `PIN_REQUIRED_ROLES = ['machinist','admin','finishing']` (`src/pages/SetPassword.jsx:5`; `Mainframe.jsx:450`) — **assembly users may have no PIN on file.**
- Names for sign-off display: `profiles.full_name`, `profiles.username`, `profiles.email` (TEST catalog). **There is no initials column on `profiles`**; the nearest are `work_order_assembly_routing_steps.operator_initials` (`2026-05-03_Assembly_Route_Changes.sql:31`) and `job_routing_steps.operator_initials`.

---

## 3. Order Queue

### 3.1 Dispositions and `fb_set_disposition`
- Vocabulary (CHECK): `pending, production, stock, purchased, covered, assembly, kit_header, ignore, unlisted` (`Docs/migrations/2026-08-26_fishbowl_bridge_c1.sql:31-32`). Labels and colours `src/lib/fishbowl.js:91-112`; hand-settable `MANUAL_DISPOSITIONS` = stock, purchased, assembly, ignore, pending (`fishbowl.js:117-123`).
- Contract: `fb_set_disposition(p_line_ids integer[], p_disposition text, p_note text DEFAULT NULL, p_components jsonb DEFAULT '{}') RETURNS integer` — `_fb_gate(['order_processor','admin'])`; acts only on lines with `removed_at IS NULL`, `customer_order_line_id IS NULL`, `type_id IN (10, 12, 80)`; sets `disposition`, `disposition_by = auth.uid()`, `disposition_at`, `disposition_note` (`Docs/migrations/2026-09-30_D-FB-42_co_line_components_releases.sql:250-322`). Client: `setDisposition(lineIds, disposition, note, components)` (`src/lib/fishbowl.js:368-374`), called from `handleBulkDisposition` (`src/pages/OrderQueue.jsx:217-240`).
- Refusals: `production` (or anything outside the hand list) → "cannot be set by hand (production goes through Create CO)", `22023` (`D-FB-42…sql:263-266`); `purchased` on a SkyNet part with a BOM without named components → "Purchase: choose which component(s)…" (D-FB-42, `:276-295`); `covered` → retired (D-FB-50, `Docs/migrations/2026-10-01_D-FB-50_retire_covered_disposition.sql:43-48`). D-FB-43 (one CO line per Fishbowl line) is enforced in `fb_convert_to_co`, not here.
- **Batch A's auto-disposition must work inside the same eligibility rule** — a line already linked to a CO line is never re-dispositioned — and per D-ASM-6 may only move a line forward.

### 3.2 Line selectors and kit derivation
- Lines are read straight from `fb_sales_order_lines` with `LINE_SELECT` (`src/lib/fishbowl.js:309-329`): `fb_soitem_id, fb_so_id, line_number, type_id, status_id, product_num, part_num, description, qty_ordered, qty_fulfilled, qty_to_fulfill, effective_due_date, due_date_is_default, remaining_parts_ship_date, customer_part_num, rev_level, resolution, disposition, disposition_at, disposition_note, part_id, kit_sku_id, customer_order_line_id, removed_at, parent_fb_soitem_id` + embedded `part`, `kit`, `co_line`, `disposition_by_profile(full_name)`. SO headers come from `v_fb_order_queue` (`fishbowl.js:298-307`).
- Predicates: `coQtyForLine` = ordered − shipped (D-FB-36, `fishbowl.js:202-204`); `isClosedLine` (statuses 50, 60, 70, 75, 95, `:87`, `:207-209`); `isSelectableLine` (`:212-217`); `convertBlocker` (`:220-229`).
- Kit header/child (D-FB-29): the bridge tags children positionally (`tools/fishbowl-bridge/src/mapper.mjs:107-132`) into `parent_fb_soitem_id`; the queue renders them with `buildKitTree(lines)` (`fishbowl.js:238-257`) and labels each child with its own Fishbowl line number (D-FB-45). Batch A replaces the positional rule with `objecttoobject` (plan §6).

### 3.3 Sync banner stamps
`getSyncState()` reads `fb_sync_state` `*` (`fishbowl.js:292-296`); `SyncStatusBanner` uses `last_heartbeat_at` (freshness), `last_error`, `last_rev`, `bridge_version`, `bridge_host` (`src/components/orderqueue/SyncStatusBanner.jsx:14-47`). No per-mirror stamp is shown on the Order Queue.

### 3.4 Create CO hand-off
`SOCard` Convert button `onConvert` (`src/components/orderqueue/SOCard.jsx:302`) → `openConvert(order)` (`OrderQueue.jsx:248`) → `ConvertToCOModal` (`OrderQueue.jsx:488-492`; component picker `ComponentPicker`, `ConvertToCOModal.jsx:9`, `:156`) → `convertToCO(fbSoId, lineIds, components)` (`ConvertToCOModal.jsx:77`; `fishbowl.js:378-385`) → RPC `fb_convert_to_co` → `handleConverted(result)` toast with the CO number (`OrderQueue.jsx:254-275`); the CO link navigates to Customer Orders (`OrderQueue.jsx:318`).

### 3.5 Where the new line signals attach with least change
- **"Flagged by Fishbowl" marker:** the disposition chip cell (`SOCard.jsx:240-256`) already shows who/when/note in its tooltip from `disposition_by_profile`, `disposition_at`, `disposition_note` (`:249`). A source column on `fb_sales_order_lines` (added to `LINE_SELECT`, `fishbowl.js:309-318`) rendered as a small tag beside that chip is the least change.
- **Shipped / Invoiced chips:** same cell, beside the CO link (`SOCard.jsx:257-268`). Data per `fb_soitem_id` can be fetched in `loadLines` alongside `getLineDetail` and the purchase list, using the existing `Promise.allSettled` pattern (`OrderQueue.jsx:77-110`). The SO header view already counts `shipped_lines` from Fishbowl line statuses 50/60 (`Docs/migrations/2026-08-27_fishbowl_bridge_c2_2.sql:241`).
- **Needs CO worklist:** a fifth value for the tab state `'queue' | 'all' | 'exceptions' | 'changes'` (`OrderQueue.jsx:27`) and a clause in the list filter (`OrderQueue.jsx:328`). Note the Queue tab counts `pending_lines` (`c2_2.sql:232-233`), so lines that auto-move to `assembly` leave it — intended.

---

## 4. Finishing, compliance and TCO completion hooks

### 4.1 TCO close — the `inventory_add` hook point
- **Manual:** `handleApproveTCO(wo)` in `src/components/TCOReview.jsx:146-205` (button `:328-342`, shown to compliance, admin or `can_approve_compliance`, `:28`). **No RPC** — three browser writes, not atomic: jobs `pending_tco → complete` by `work_order_id` (`:159-166`); `work_orders` → `complete` with `tco_notes`, `tco_parts_tested`, `tco_tensile_pass`, `tco_shear_pass`, `closed_by = profile.id`, `closed_at` (`:171-183`); `work_order_assemblies` → `complete` where not complete, error unchecked (`:188-195`).
- **Automatic:** `auto_close_stale_tco(p_days integer DEFAULT 30, p_dry_run boolean DEFAULT true) RETURNS jsonb` (`Docs/migrations/2026-09-02_auto_close_stale_tco.sql:97-176`), candidates from `tco_stale_candidates(p_days)` (`:17-90`), pg_cron `auto-close-stale-tco` 06:00 UTC (`:193-201`). The S17 handoff records this cron missing on PROD since Sept 13 (`Docs/S17_Handoff_2026-10-28.md:70`).
- **Fields in hand at the manual close** (from `loadTCOItems`, `TCOReview.jsx:33-82`): WO `id, wo_number, customer, order_type, tco_*`; WOAs `id, assembly_id, quantity, status, assembly{id, part_number, description, part_type}`; jobs `id, job_number, status, quantity, good_pieces, bad_pieces, component{id, part_number, …}`; acting `profile.id`. **Not loaded:** `jobs.production_lot_number`, `jobs.finishing_lot_number`, `jobs.post_mfg_good_qty`, `work_order_assemblies.assembly_lot_number`, `good_quantity`, `work_orders.stock_quantity` / `order_quantity`. There is no `jobs.lot_number`; a job's lots are `production_lot_number` (PLN), `finishing_lot_number` (FLN) and `blank_lot_number`.
- **Hook point:** an `inventory_add` enqueue at TCO close needs the part, the SkyNet lot (FLN for a machined component, ALN for an assembly), the good quantity and the actor. Today the handler would have to read those itself; moving the close into one RPC (as the auto-close already is) gives one transaction and one place to enqueue.
- Side effects today: `stock_requests_follow_wo_trg` completes allocated stock requests when the WO turns `complete` (`Docs/migrations/2026-08-20_stock_requests.sql:198-223`); CO fulfilment posts earlier, when a job **enters** `pending_tco` (`trg_fulfill_co_on_tco`, DDL only in `Docs/test_triggers.sql:24`; `Docs/Decisions.md:235`).

### 4.2 Compliance close (if the moment moves)
`src/components/ComplianceReview.jsx` — browser writes, no RPC. Job review `handleApproveJob(jobId, currentStatus, outcome, deferInfo)` (`:1444-1618`) and `handleApproveAndPrint` (`:1620-1785`): post-manufacturing accept writes `post_mfg_good_qty`, `post_mfg_bad_qty`, `post_mfg_notes`, `post_mfg_reviewed_by`, `post_mfg_reviewed_at` and routes as in §1.9 (`:1524-1583`). Finishing-batch review `handleApproveBatch(send, outcome)` (`:679-871`): `finishing_sends.compliance_good_qty` etc. (`:757-772`) and the WOA check-in (`:780-795`). In hand: the job row (`component_id`, `production_lot_number`, `finishing_lot_number`, `work_order_id`, from `Mainframe.jsx:170-176`), the good quantity from the form, `profile.id`.

### 4.3 `stock_requests` (D-STKREQ-01)
- Table `Docs/migrations/2026-08-20_stock_requests.sql:12-42` (TEST catalog matches): `id, part_id, quantity_requested, priority (critical|high|normal|low), reason, status (open|allocated|complete|cancelled), work_order_id, allocated_at, allocated_by, completed_at, cancelled_at, cancelled_by, cancel_reason, requested_by, created_at, updated_at`. RLS select-only; writes through RPCs (`:67-74`).
- **Create:** `create_stock_request(p_part_id uuid, p_quantity integer, p_priority text DEFAULT 'normal', p_reason text DEFAULT NULL) RETURNS uuid`, gate admin or **assembly** (`:81-114`); UI "New Stock Request" (`src/pages/CustomerOrders.jsx:404-410`, `canRaiseStockRequest` `:64`) → `StockRequestModal.handleSubmit` (`src/components/StockRequestModal.jsx:169-200`) → `createStockRequest` (`src/lib/customerOrders.js:393-402`). Cancel: `cancel_stock_request(p_id, p_reason)` (`:117-146`).
- **Consume (Demand tab):** `DemandView` (`CustomerOrders.jsx:1399`) loads open CO lines and `getOpenStockRequestLines()` (`src/lib/customerOrders.js:358-391`; open requests shaped as lines `line_id 'sr:'+id`, `co_number 'STOCK'`) and merges them **in the browser** (`CustomerOrders.jsx:1422`); no SQL view unions them. Create WO (admin/scheduler, `:1404`) passes the selected requests (`:1593-1596`, `:1876-1884`); `CreateWorkOrderModal.handleProductionSubmit` (`:699`) creates the WO (`make_to_stock` when no CO lines, `:1011-1012`) and calls `allocate_stock_requests(p_ids uuid[], p_work_order_id uuid)` (`stock_requests.sql:150-186`; wrapper `customerOrders.js:418-423`) → `open → allocated`. The request then follows its WO through `stock_requests_follow_wo()` (`:198-223`).
- For Batch B: a build short of a machined component raises a request with `create_stock_request` — the `assembly` role is already allowed.

---

## 5. Program tracker (Giza)

### 5.1 The ledger write path
- Ledger `program_ledger` (`Docs/migrations/2026-10-13_giza_tracker.sql:148-169`; `from_lot_id`, `cage_lot`, `retainer_lot` added `2026-10-14_giza_branches.sql:81-84`). Stage CHECK, current (`2026-10-14_giza_branches.sql:93-94`):
  `CHECK (stage IN ('received','washer_inserted','sent_plating','returned_plating','assembled'))`
- **The RPC the dashboard calls** (`2026-10-14_giza_branches.sql:236-319`):
  ```sql
  public.program_log_entry(
    p_program_id uuid, p_part_id uuid, p_stage text, p_qty integer,
    p_lot text DEFAULT NULL, p_branch_id uuid DEFAULT NULL, p_cage_lot text DEFAULT NULL, p_retainer_lot text DEFAULT NULL,
    p_vendor text DEFAULT NULL, p_po text DEFAULT NULL, p_expected_return date DEFAULT NULL, p_entry_date date DEFAULT NULL,
    p_done_by text DEFAULT NULL, p_notes text DEFAULT NULL) RETURNS jsonb
  ```
  Returns the route (`lot_id, lot_number, split, reason, reused, new_branch, from_lot_number`) plus `entry_id` (`:318`). Granted to `authenticated, service_role` (`:541`).
- **Gate:** `PERFORM public._program_gate()` (`2026-10-14_giza_branches.sql:257`), default roles `ARRAY['admin','order_processor']` (`2026-10-13_giza_tracker.sql:245-253`). **An assembly-role kiosk session is refused** (§8).
- Validation (`:257-302`): program active; stage in the list; `qty > 0`; part on the program; non-`received` stages act on the nut part only; `p_branch_id` required (on this program) for every stage but `received`. `washer_inserted` requires `p_lot` = the nylon insert lot (`:285-288`). `assembled` requires the source lot to have a `finishing_lot` ("nothing baked yet") and both `p_cage_lot` and `p_retainer_lot` (`:297-302`); the ledger row's lot is the source FLN. No over-move check (negative buckets allowed, D-GIZA-05).
- **Split rules (D-GIZA-22)** are in `_program_route(p_source uuid, p_stage text, p_values jsonb)` (`2026-10-14_giza_branches.sql:141-233`, private): per stage it sets `insert_lot` (washer_inserted), `plating_lot` (returned_plating), `dry_film_lot` + `finishing_lot` (bake), `cage_lot` + `retainer_lot` (assembled) and carries the parent's earlier attributes (`:162-173`); an empty attribute is filled in place, the same value stays, a different value splits (`:184-205`); a closed source splits `after_close` (`:181-182`); split reason `nylon_lot | plating_lot | dry_film_lot | cage_lot | retainer_lot | component_lots` (`:207-213`); an existing active child with the same trail is reused (`:220-228`). Quantity never causes a split.
- **Component lots:** nylon insert → `p_lot` on `washer_inserted` (stored as ledger `lot_number` and the lot's `insert_lot`); cage and retainer → `p_cage_lot` / `p_retainer_lot` on `assembled` (stored on the ledger row and the lot); steel nut → `p_lot` on a nut `received` move (`nut_lot`).

### 5.2 `v_program_final_lots`
Latest definition `Docs/migrations/2026-10-14_giza_branches.sql:554-607` (no later redefinition). Columns (`:584-601`): `id, program_id, lot_number, status, origin, split_reason, parent_lot_id, parent_lot_number, opened_at, opened_by, closed_at, closed_by, quantity, nut_lot, insert_lot, plating_lot, dry_film_lot, finishing_lot, cage_lot, retainer_lot, nut_lots, plating_lots, finishing_lots, torsion_1_qty, torsion_1_inlbs, torsion_2_qty, torsion_2_inlbs, inspected_by, notes, updated_at, waiting_insert, waiting_plating, at_electrolab, waiting_paint, in_paint, in_oven, waiting_assembly, assembled_qty, assembled_entries, last_move`.

### 5.3 Where "Insert nylon" and "Assembled" are entered today
`src/pages/dashboards/GizaDashboard.jsx`: bucket cards `{ key: 'nylon', label: 'Insert nylon', log: 'washer_inserted' }` and `{ key: 'assembled', label: 'Assembled & bagged', log: 'assembled' }` (`:40-50`); log button on the card when `canWrite` (`canLogProgramTracker` = admin or order_processor, `:977`; `src/lib/roles.js:121-123`) → `onLog({ stage, lotId })` (`:530-532`) → `EntryModal` (`:145-339`, opened `:1084-1086`). Handler `save()` (`:190-211`) → `logEntry({...})` → `rpc('program_log_entry', …)` (`src/lib/programTracker.js:108-123`). Insert nylon passes the nut part, `p_stage 'washer_inserted'`, `p_qty`, `p_lot` = nylon lot, `p_branch_id`; Assembled passes `p_stage 'assembled'`, `p_qty`, `p_branch_id`, `p_cage_lot`, `p_retainer_lot` (no `p_lot`). Both pass `p_entry_date`, `p_done_by` (initials text), `p_notes`. The split preview mirrors the router in `src/lib/programTrackerMath.js:153-167`.

---

## 6. Settings, parts, costs

### 6.1 Settings / config table
**None exists.** No table whose name contains "setting" or "config" is in the TEST catalog; no migration creates one; no `src/` code reads one. `src/config.js` `FEATURES` is build-time (a change needs a commit and an Amplify deploy). Single-purpose tables that are not general config: `fb_sync_state` (bridge clocks), `scheduler_policies` (`Docs/migrations/2026-08-15_ai_scheduler_phase1.sql:223-231`), `pricing_counters` (`2026-09-10_pricing_c1.sql:12-13`). Batch B/D must create the table the plan calls `app_settings` for `assembly_labor_rate` and `mfg_support_overhead_pct`.

### 6.2 `parts.unit_cost`
- Column exists (TEST catalog `parts`: `id, part_number, description, customer, is_active, created_at, updated_at, part_type, specification, unit_cost, requires_passivation, material_type_id, drawing_revision, family_key, length_family_key, length_dash, length_family_source, length_family_set_at`); not defined in a repo migration. "Still unloaded for most parts" (`Docs/SkyNet_Costing_Decisions.md:141`).
- **Written only by Armory's part modal:** `handleSavePart()` (`src/pages/Armory.jsx:1171`), `unit_cost: parseFloat(partForm.unit_cost) || 0` on update (`:1215`) and insert (`:1235`); input `:4842-4850`. No RPC, migration, Edge Function or bridge writes it; D-PRICE-47's costs go to `fb_part_costs`, not `parts` (`Docs/migrations/2026-09-15_D-PRICE-47_part_costs.sql:19-63`).
- **Read:** Armory edit modal (`Armory.jsx:1040`); embedded in Create WO's BOM select (`src/components/CreateWorkOrderModal.jsx:325`) but never used there.
- An unloaded part reads `0`, which D-ASM-13 treats as "not > 0" and falls through to Fishbowl `stdCost`.

### 6.3 Classification columns for `parts.assembly_family`
`parts.assembly_family` does not exist (only the plan, `S17_Implementation_Plan.md:132`). Closest: `part_type` (Armory offers `assembly`, `finished_good`, `manufactured`, `purchased`, `Armory.jsx:4823-4836`); `family_key` (pricing/costing family, "inert until the seeding pass", `Docs/migrations/2026-08-15_ai_scheduler_phase1.sql:65-68`); `length_family_key`, `length_dash`, `length_family_source`, `length_family_set_at` (D-SCHED-27 machining family, `2026-09-22_D-SCHED-27_length_family_history.sql:113-125`). There is no `category`, `series` or product-line column; `kit_skus.family` is on kits only (`2026-09-14_D-PRICE-46_kits_into_book.sql:31`).

### 6.4 Profiles for sign-off display
`full_name`, `username`, `email`; no initials column (§2.6).

---

## 7. Facts for Batches B–D

| Need | Exact name | Source |
|---|---|---|
| Assembly board component | `Assembly({ profile, onUpdate })` | `src/components/Assembly.jsx:20` |
| Loader / readiness / supply | `loadAssemblies`, inline `allJobsReady` / `hasAssemblyWork`, `computeSupplyQty(woa, woaJobs, childSubs)` | `src/components/Assembly.jsx:112-305`, `:206-216`, `:69-89` |
| Handlers | `handleStartAssembly`, `handleCompleteAssembly`, `handleSendBatch`, `handlePauseAssembly`, `handleResumeAssembly` | `src/components/Assembly.jsx:323`, `:433`, `:639`, `:684`, `:749` |
| Effective qty | `getEffectiveQty(job)` | `src/lib/effectiveQty.js` (import `src/components/Assembly.jsx:3`) |
| WOA status CHECK | `work_order_assemblies_status_check` (7 values) | `Docs/migrations/2026-05-03_Assembly_Route_Changes.sql:45-57` |
| ALN columns | `assembly_lot_number`, `assembly_lot_entered_by`, `assembly_lot_entered_at` | `2026-05-03_Assembly_Route_Changes.sql:38-42`; written `src/components/Assembly.jsx:367-369` |
| Nested parent | `work_order_assemblies.parent_work_order_assembly_id` | `Docs/migrations/2026-06-16_nested_assembly_batch_a.sql:10-22` |
| Check-ins | `assembly_component_checkins` (XOR `job_id` / `source_work_order_assembly_id`) | `2026-06-16_nested_assembly_batch_a.sql:24-43`; insert `src/components/Assembly.jsx:573-585` |
| WOA routing | `work_order_assembly_routing_steps`; copy at Create WO | `2026-05-03_Assembly_Route_Changes.sql:9-36`; `src/components/CreateWorkOrderModal.jsx:797-846`; `src/lib/nestedAssembly.js:132` |
| Outbound send (assembly) | `outbound_sends` `source_type 'work_order_assembly'`, `source_id`, `routing_step_id`, `operation_type`, `quantity`, `sent_by`; ready = `sent_at IS NULL` | `src/components/Assembly.jsx:486-499`; `src/components/OutsourcedJobs.jsx:358-366` |
| Send-out handler | `handleLogSendOut(row)` | `src/components/OutsourcedJobs.jsx:536-566` |
| Job routing after finishing | `resolveNextStatusAfterFinishing(jobId)` | `src/lib/finishingCompletion.js:7-25` |
| Flag | `FEATURES.ASSEMBLY_MODULE` | `src/config.js:30` |
| Leaf / group rule | `isJobLeafNode(node)`, `isGroupNode(node)` | `src/lib/nestedAssembly.js:88-96` |
| WO type | `work_orders.order_type` (`make_to_order`, `make_to_stock`, `maintenance`) — no `origin` column | TEST catalog; set `src/components/CreateWorkOrderModal.jsx:1011-1012` |
| PIN pad | `PinPad` props (§2.1) | `src/components/PinPad.jsx:6-43` |
| Kiosk auth | Edge Function `kiosk-authenticate`, `ALLOWED_ROLES`, `SHIFT_SECONDS` | `supabase/functions/kiosk-authenticate/index.ts:25-26`, `:88` |
| Inactivity | `INACTIVITY_TIMEOUT` = 120 000 ms | `src/pages/TravelerKiosk.jsx:47` |
| Role helpers | `userRoles`, `hasRole`, `canActOnOrderQueue`, `canLogProgramTracker` | `src/lib/roles.js:21-28`, `:64-66`, `:121-123` |
| SQL role check | `user_has_role(p_uid uuid, VARIADIC p_roles text[])` | TEST catalog; used `Docs/migrations/2026-08-20_stock_requests.sql:93` |
| Disposition RPC / client | `fb_set_disposition(p_line_ids, p_disposition, p_note, p_components)` / `setDisposition()` | `Docs/migrations/2026-09-30_D-FB-42_co_line_components_releases.sql:252`; `src/lib/fishbowl.js:368-374` |
| Queue line select | `LINE_SELECT`, `getQueueLines(fbSoId)` | `src/lib/fishbowl.js:309-329` |
| Kit tree | `buildKitTree(lines)`, column `parent_fb_soitem_id` | `src/lib/fishbowl.js:238-257`; `Docs/migrations/2026-08-26_fishbowl_bridge_c1.sql:13` |
| Banner | `SyncStatusBanner({ state })`, `getSyncState()` | `src/components/orderqueue/SyncStatusBanner.jsx:7`; `src/lib/fishbowl.js:292-296` |
| Line cell to extend | disposition chip cell in `SOCard` | `src/components/orderqueue/SOCard.jsx:240-269` |
| TCO close | `handleApproveTCO(wo)`; `auto_close_stale_tco(p_days, p_dry_run)` | `src/components/TCOReview.jsx:146-205`; `Docs/migrations/2026-09-02_auto_close_stale_tco.sql:97-176` |
| Job lot columns | `jobs.production_lot_number`, `jobs.finishing_lot_number`, `jobs.blank_lot_number` | `Docs/migrations/2026-10-27_D-LOT-03_j000380_void_retag_j000391_blank_deduction.sql:59` (PLN format); `src/components/ComplianceReview.jsx:173-191` (select) |
| Stock request create | `create_stock_request(p_part_id, p_quantity, p_priority, p_reason)`; client `createStockRequest` | `Docs/migrations/2026-08-20_stock_requests.sql:81-114`; `src/lib/customerOrders.js:393-402` |
| Stock request allocate | `allocate_stock_requests(p_ids, p_work_order_id)` | `Docs/migrations/2026-08-20_stock_requests.sql:150-186`; `src/lib/customerOrders.js:418-423` |
| Demand merge | `getOpenStockRequestLines()` | `src/lib/customerOrders.js:358-391` |
| Program ledger RPC | `program_log_entry(...)` (14 params) | `Docs/migrations/2026-10-14_giza_branches.sql:236-319`; client `logEntry` `src/lib/programTracker.js:108-123` |
| Program gate | `_program_gate(p_roles DEFAULT ARRAY['admin','order_processor'])` | `Docs/migrations/2026-10-13_giza_tracker.sql:245-253` |
| Ledger stages | `received, washer_inserted, sent_plating, returned_plating, assembled` | `Docs/migrations/2026-10-14_giza_branches.sql:93-94` |
| Final-lot view | `v_program_final_lots` | `Docs/migrations/2026-10-14_giza_branches.sql:554-607`; read `src/lib/programTracker.js:40` |
| Giza entry UI | `EntryModal`, `save()` | `src/pages/dashboards/GizaDashboard.jsx:145-339`, `:190-211` |
| Part cost | `parts.unit_cost` (Armory only) | `src/pages/Armory.jsx:1215`, `:1235` |
| Fishbowl cost mirror | `fb_part_costs.std_cost`, `last_cost` | `Docs/migrations/2026-09-15_D-PRICE-47_part_costs.sql:19-31`; `tools/fishbowl-bridge/src/queries.mjs:175-193` |
| Classification | `parts.part_type`, `parts.family_key`, `parts.length_family_key` | TEST catalog; `src/pages/Armory.jsx:4823-4836`; `Docs/migrations/2026-08-15_ai_scheduler_phase1.sql:65-68` |
| Sign-off names | `profiles.full_name`, `profiles.username` | TEST catalog; pattern `src/pages/TravelerKiosk.jsx:275` |

**Plan names that do not exist yet** (new, not facts): `work_orders.origin` / `stock_assembly`, `build_kind`, `fb_mo_id`, `fb_mo_num`, `fb_post_status`, `rework_source_lot`, `released_by`, `released_at`, `wave_current`, `program_id`, `program_final_lot_id` on `work_order_assemblies`; tables `assembly_requests`, `assembly_sessions`, `assembly_component_lots`, `assembly_checklist_templates`, `assembly_checklist_steps`, `assembly_step_signoffs`, `assembly_lot_sequence`, `assembly_lot_index`, `assembly_benches`, `assembly_build_costs`, `app_settings`; columns `parts.assembly_family`; flag `FEATURES.ASSEMBLY_KIOSK`; function `getJobsCompleteRollup`.

---

## 8. Surprises and risks

### 8.1 Work orders without jobs (D-ASM-03)
D-ASM-03 makes a stock/special/rework build a WO with one WOA and no jobs. Today that WO breaks or disappears here:

| Where | What happens with zero jobs | Severity |
|---|---|---|
| Assembly board — `src/components/Assembly.jsx:206-216` | `[].every()` is true but `hasAssemblyWork` is false (no jobs, no child subs) → the WOA is skipped in every bucket; it can never be started | breaks |
| Assembly KPI — `src/pages/Mainframe.jsx:321-327` | same pair → never counted | mis-renders |
| TCO KPI — `src/pages/Mainframe.jsx:349-352` | `if (!wo.jobs || wo.jobs.length === 0) return false` | mis-renders |
| WO Lookup Active / recently completed — `src/pages/Mainframe.jsx:793-797`, `:803-805` | same guard → dropped from both lists | breaks (hidden) |
| WO Lookup badges — `src/pages/Mainframe.jsx:2702`, `:2712`, `:2779`, `:2824`, `:2839` | `wo.jobs?.every(...)` vacuously true → shown COMPLETE, Edit hidden, "0/0" | mis-renders |
| TCO Review — `src/components/TCOReview.jsx:94` | `continue` on no jobs → never listed; Approve TCO is the only app path to `complete`, so the WO stays `pending` and the WOA `pending_tco` for ever | breaks |
| Nightly auto-close — `Docs/migrations/2026-09-02_auto_close_stale_tco.sql:39-53`, `:85-87` | candidates are built from jobs (`WHERE pw.pending_tco_jobs > 0`) → never closed | breaks |
| CO fulfilment — trigger on `jobs` entering `pending_tco` (`Docs/test_triggers.sql:24`) | never fires → a build allocated to a CO line never posts `quantity_fulfilled` | breaks (if allocated) |
| Stock requests — `Docs/migrations/2026-08-20_stock_requests.sql:205-208` | follows WO `complete`, which never comes → request stays `allocated` | breaks (follows TCO) |
| `v_co_line_dates`, `v_co_line_component_status` — `Docs/migrations/2026-09-30_D-FB-42_co_line_components_releases.sql:391-397`, `:403-416` | join on `jobs` → Prod Due falls back to target; components read "no job yet" | mis-renders (if allocated) |
| Sales report / MTS panel — `Docs/migrations/2026-06-03_sales_dashboard_S10.sql:447-454`, `:575-583` | `job_count > 0` joins → line or WO drops out | breaks (hidden) / mis-renders |
| My Orders / customer program — `src/lib/myOrders.js:100-101`; `src/lib/customerProgramMath.js:168-173` | "Not scheduled" / "0 jobs · waiting to start" regardless of build state | mis-renders |
| Edit WO — `src/components/EditWorkOrderModal.jsx:1069`, `:1105`, `:1123` | `assembly.jobs.every(...)` vacuously true → quantities never lock | latent |
| Cert package — `src/pages/CertRepository.jsx:1582-1583`, `:1624`; `src/lib/certPackage.js:592-598` | packages are per job → "No jobs found", Build disabled | breaks |
| Cert status — `src/lib/certRepository.js:629-654`, `:672-674` | every BOM component "no source linked" until linked by hand | mis-renders |
| Traveler / genealogy — `src/lib/traveler.js:49-56`; `src/components/PrintPackageModal.jsx:90`, `:106` | genealogy hangs off a component job; no WOA-level traveler exists | breaks |
| TV board — `src/pages/dashboards/AssemblyDisplay.jsx:105-124` | reads `jobs` only | mis-renders |
| President's Bridge — `src/pages/dashboards/PresidentsBridge.jsx:103-171` | product rollup and trajectory from jobs; "orders in flight" counts it for ever | mis-renders |
| Create WO — `src/components/CreateWorkOrderModal.jsx:708-709` | `throw new Error('Please add at least one job')` | breaks if reused for builds |

Already safe: `computeSupplyQty` returns `woa.quantity` with no jobs (`Assembly.jsx:73`); the job-status writes in Start/Complete/Pause become no-ops; the outsourced assembly path is WOA-based (`OutsourcedJobs.jsx:168-204`, `:716-765`); the WO Lookup drill-down shows "No component jobs" (`Mainframe.jsx:2902-2919`, `:3607-3609`); `report_open_demand` uses `LEFT JOIN jobs`; the scheduler, Job Pool, machine Kiosk, Finishing and Compliance queues are job-driven by design and simply never see a build. Three loaders filter `.not('order_type','eq','maintenance')` (`Assembly.jsx:165`, `Mainframe.jsx:307`, `TCOReview.jsx:81`), which also drops a NULL `order_type` — a build WO must set it. Not verifiable in the repo (source absent): `search_closed_work_orders`, `fulfill_co_on_tco_entry` / `fulfill_co_for_job`, `v_wo_dates`, `report_part_history`.

### 8.2 Other surprises
1. **`work_orders.origin` does not exist** (TEST catalog; no migration). The plan's `stock_assembly` origin needs a new column, or Batch B uses `order_type` plus `work_order_assemblies.build_kind`.
2. **D-NEST-13's deferred item is not on `main`** (§1.9) though D-ASM-18 records it promoted to PROD; Matt to confirm what was promoted.
3. **`kiosk-authenticate` refuses the `assembly` role** (`index.ts:26`, `:88`) and checks only the primary role; assembly users are not prompted to set a PIN (`SetPassword.jsx:5`). Batch C needs the role added to `ALLOWED_ROLES` (or the check widened to `roles[]`) and PINs issued to Jody's team; adding a role also means checking the role-gated RLS policies (`Docs/Decisions.md:310`). The function also requires a `machine_id`; benches are not machines, so the assembly kiosk needs an anchor rule (TravelerKiosk's first-commissioned-machine pattern, or a bench id).
4. **`program_log_entry` refuses assemblers.** `_program_gate()` defaults to admin/order_processor (`2026-10-13_giza_tracker.sql:245`, used `2026-10-14_giza_branches.sql:257`). Batch C's two-wave closeout must widen that gate for these two stages (or call through a gated wrapper); the plan says reuse the RPC, not write moves directly. `p_done_by` is free-text initials, not a profile id.
5. **No settings table** (§6.1) — Batch B creates it.
6. **No initials column on `profiles`** (§2.6) — sign-off display uses `full_name`, or derives initials.
7. **TCO close is browser-side, three non-atomic writes, the WOA write unchecked** (`TCOReview.jsx:159-195`). The `inventory_add` hook (D-ASM-13) is safest after moving the close into one RPC; today's handler does not even load the lot numbers or WOA good quantity it would need (§4.1). The PROD auto-close cron is reported missing since Sept 13 (`Docs/S17_Handoff_2026-10-28.md:70`).
8. **Pause "return to queue" is not WOA-scoped** (`Assembly.jsx:711-719`): it moves every `in_assembly` job on the WO back to `ready_for_assembly`, including a parent WOA's jobs in a nested WO.
9. **Send Batch gives Jody a send control** (`Assembly.jsx:984-994`), contrary to D-ASM-05; and the `ASSEMBLY_MODULE` comment's claim that with the flag off "post-assembly outsourcing batches [are] auto-created when components complete" (`src/config.js:21-22`) has no implementation — only `Assembly.jsx` creates assembly sends.
10. **`NESTED_ASSEMBLY` is `true` in the shared `config.js`** while its comment says "Keep false in PROD" (`src/config.js:52-60`); PROD therefore runs the nested Create WO tree today.
11. **Several functions the app relies on are not in the repo:** `user_has_role`, `fulfill_co_on_tco_entry`, `fulfill_co_for_job`, `job_effective_qty`, `ack_merged_member_compliance`, `allocate_merged_batch`; and two files Decisions cites are missing (`2026-09-02_auto_close_stale_tco_v2.sql`, `Docs/Decisions.md:3302`; `2026-09-02_job_effective_qty_all_rejected.sql`, `:3297`). Batches touching them start from `pg_get_functiondef` on TEST.
12. **The base tables `work_order_assemblies`, `assembly_component_checkins`, `outbound_sends`, `kiosk_sessions` and `parts.unit_cost` have no defining migration in the repo**; their columns here come from the TEST catalog.
13. **D-GIZA numbering collision:** `Docs/migrations/2026-10-15_giza_part_aliases.sql:2` calls itself D-GIZA-31, while `Docs/Decisions.md:5010` assigns D-GIZA-31 to the dry-film cure default; no D-GIZA-28 heading exists.
