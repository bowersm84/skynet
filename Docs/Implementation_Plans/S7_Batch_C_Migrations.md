# SkyNet Sprint 7 — Batch C Migrations

**Drafted:** May 16, 2026
**Approach:** One migration at a time. Apply to TEST → regression-test affected surfaces on `test-skynet.skybolt.com` → apply to PROD → move to next.
**Companion docs:** `RLS_Audit_2026-05.md`, `RLS_Access_Matrix_v2.md`

---

## ⚠️ Read first — universal rules

1. **Always toggle "Limit results to 100 rows" OFF** in the Supabase SQL Editor before pasting. The auto-LIMIT wrapper breaks verification queries.
2. **Every migration is wrapped in `BEGIN; ... COMMIT;`.** If the verification query at the end returns unexpected results, immediately run `ROLLBACK;` instead of `COMMIT;`. Until COMMIT, nothing is persisted.
3. **Apply on TEST first.** Run the migration. Run the verification. Run the regression checklist on `test-skynet.skybolt.com`. Only after all that, apply to PROD.
4. **Prod promotion gate.** Each migration has a "before running on prod" SQL block — run it on prod first to confirm the prod state matches what the migration expects. Especially important for row counts and existing policy names.
5. **Migrations are independent.** If something goes sideways on one, the others are still safe to ship. You can pause and resume.

---

## Migration order (ship in this sequence)

| # | ID | Risk | Description |
|---|---|---|---|
| 1 | **M9** | 🟢 Low | DROP `wo_shortfall_resolutions` |
| 2 | **M1** | 🟢 Low | Lookup tables (7) — enable RLS, normalize legacy policies |
| 3 | **M8** | 🟡 Med | Remove temp anon SELECTs (5 tables) |
| 4 | **M4** | 🟡 Med | Finishing tables (3) — enable RLS on assembly_component_checkins, normalize finishing_sends |
| 5 | **M5** | 🟡 Med | Material tables (9) — add missing policies, normalize legacy |
| 6 | **M2** | 🟡 Med | Production tables (9) — enable RLS on job_materials, normalize legacy |
| 7 | **M6** | 🟡 Med | Kiosk tables (5) — enable RLS on 2, add explicit policies |
| 8 | **M7** | 🔴 High | Audit + staging + profiles (5) — biggest blast radius; includes ALTER FUNCTION for lot RPCs |

---

# Migration 1 — M9 — DROP `wo_shortfall_resolutions`

**Risk:** 🟢 Low
**Tables:** `wo_shortfall_resolutions` (1)
**Verified safe:** zero FKs, zero functions/views/MVs reference it, zero src/ references, 3 test artifacts only on test, 0 rows on prod at S8 cutover.

### Prod-promotion gate (run on PROD first, before applying)
```sql
SELECT COUNT(*) AS rows FROM public.wo_shortfall_resolutions;
-- Expected: 0. If non-zero, stop and inspect the rows before dropping.
```

### Migration SQL (apply to test first, then prod)
```sql
BEGIN;

DROP TABLE IF EXISTS public.wo_shortfall_resolutions;

-- Verification: table no longer exists
SELECT EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'wo_shortfall_resolutions'
) AS table_still_exists;
-- Expected: false

COMMIT;
```

### Regression checklist (after applying to TEST)
- [ ] Mainframe loads
- [ ] WO Lookup → Shortfalls tab still works (now reads `job_shortfall_resolutions` exclusively)
- [ ] Create a test shortfall scenario, verify it appears

---

# Migration 2 — M1 — Lookup tables

**Risk:** 🟢 Low
**Tables (7):** `bar_sizes`, `material_types`, `document_types`, `locations`, `machines`, `routing_templates`, `routing_template_steps`
**Changes:** Enable RLS on `bar_sizes` + `material_types`. Add missing cmd policies on `document_types`, `locations`, `machines`. Normalize legacy `ALL public` policies on `routing_templates` + `routing_template_steps`.

### Migration SQL
```sql
BEGIN;

-- ============================================================
-- bar_sizes — enable RLS, create 4 auth policies
-- ============================================================
ALTER TABLE public.bar_sizes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bar_sizes_select_authenticated" ON public.bar_sizes
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "bar_sizes_insert_authenticated" ON public.bar_sizes
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "bar_sizes_update_authenticated" ON public.bar_sizes
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "bar_sizes_delete_authenticated" ON public.bar_sizes
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- material_types — enable RLS, create 4 auth policies
-- ============================================================
ALTER TABLE public.material_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "material_types_select_authenticated" ON public.material_types
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "material_types_insert_authenticated" ON public.material_types
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "material_types_update_authenticated" ON public.material_types
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "material_types_delete_authenticated" ON public.material_types
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- document_types — add missing INSERT, DELETE
-- ============================================================
CREATE POLICY "document_types_insert_authenticated" ON public.document_types
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "document_types_delete_authenticated" ON public.document_types
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- locations — add missing INSERT, DELETE (anon SELECT preserved)
-- ============================================================
CREATE POLICY "locations_insert_authenticated" ON public.locations
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "locations_delete_authenticated" ON public.locations
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- machines — add missing INSERT, DELETE (anon SELECT WHERE is_active preserved)
-- ============================================================
CREATE POLICY "machines_insert_authenticated" ON public.machines
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "machines_delete_authenticated" ON public.machines
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- routing_templates — replace legacy ALL public with per-cmd auth
-- ============================================================
DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.routing_templates;

CREATE POLICY "routing_templates_select_authenticated" ON public.routing_templates
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "routing_templates_insert_authenticated" ON public.routing_templates
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "routing_templates_delete_authenticated" ON public.routing_templates
  FOR DELETE TO authenticated USING (true);
-- UPDATE policy "Authenticated update routing_templates" already exists — keep

-- ============================================================
-- routing_template_steps — replace legacy ALL public + DELETE public
-- ============================================================
DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.routing_template_steps;
DROP POLICY IF EXISTS "Allow authenticated delete" ON public.routing_template_steps;

CREATE POLICY "routing_template_steps_select_authenticated" ON public.routing_template_steps
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "routing_template_steps_insert_authenticated" ON public.routing_template_steps
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "routing_template_steps_delete_authenticated" ON public.routing_template_steps
  FOR DELETE TO authenticated USING (true);
-- UPDATE policy "Authenticated update routing_template_steps" already exists — keep

-- ============================================================
-- Verification
-- ============================================================
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  COUNT(p.policyname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.schemaname = 'public'
WHERE n.nspname = 'public'
  AND c.relname IN ('bar_sizes', 'material_types', 'document_types',
                    'locations', 'machines', 'routing_templates',
                    'routing_template_steps')
GROUP BY c.relname, c.relrowsecurity
ORDER BY c.relname;
-- Expected (all should be rls_enabled=true):
--   bar_sizes              4
--   document_types         4
--   locations              5  (4 auth + 1 anon SELECT)
--   machines               5  (4 auth + 1 anon SELECT)
--   material_types         4
--   routing_template_steps 4
--   routing_templates      4

COMMIT;
```

### Regression checklist
- [ ] Mainframe loads (machines list visible)
- [ ] Schedule view loads (machines on the grid)
- [ ] Kiosk PIN screen reaches a machine via direct URL (anon SELECT on machines)
- [ ] Armory → routing templates: list, create, edit
- [ ] Armory → bar sizes and material types: list, edit
- [ ] Document types appear in compliance review modal

---

# Migration 3 — M8 — Remove temp anon SELECTs

**Risk:** 🟡 Medium
**Tables (5):** `customer_orders`, `customer_order_lines`, `customer_order_allocations`, `customers`, `job_documents`
**Changes:** Drop anon SELECT policies that were added during go-live triage. Authenticated SELECT is preserved on all 5 (separate policy exists).

### Prod-promotion gate (verify the anon policies still exist on prod)
```sql
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('customer_orders', 'customer_order_lines',
                    'customer_order_allocations', 'customers', 'job_documents')
  AND 'anon' = ANY(roles::text[])
ORDER BY tablename;
-- Expected on prod (same as test):
--   customer_order_allocations  co_alloc_select        SELECT  {anon,authenticated}
--   customer_order_lines        co_lines_select        SELECT  {anon,authenticated}
--   customer_orders             co_select              SELECT  {anon,authenticated}
--   customers                   customers_select       SELECT  {anon,authenticated}
--   job_documents               job_documents_select_anon  SELECT {anon}
```

### Migration SQL
```sql
BEGIN;

-- ============================================================
-- Customer family: 4 tables have policies granting BOTH anon AND authenticated.
-- Drop and recreate as authenticated-only (other auth-only policies exist
-- separately and are NOT touched).
-- ============================================================
DROP POLICY IF EXISTS "co_alloc_select" ON public.customer_order_allocations;
CREATE POLICY "co_alloc_select" ON public.customer_order_allocations
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "co_lines_select" ON public.customer_order_lines;
CREATE POLICY "co_lines_select" ON public.customer_order_lines
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "co_select" ON public.customer_orders;
CREATE POLICY "co_select" ON public.customer_orders
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "customers_select" ON public.customers;
CREATE POLICY "customers_select" ON public.customers
  FOR SELECT TO authenticated USING (true);

-- ============================================================
-- job_documents: anon-only policy is separate from auth — just drop the anon one
-- ============================================================
DROP POLICY IF EXISTS "job_documents_select_anon" ON public.job_documents;

-- ============================================================
-- Verification: zero anon-granting policies should remain on these 5 tables
-- ============================================================
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('customer_orders', 'customer_order_lines',
                    'customer_order_allocations', 'customers', 'job_documents')
  AND 'anon' = ANY(roles::text[]);
-- Expected: zero rows

COMMIT;
```

### Regression checklist
- [ ] Customer Orders tab loads (admin / scheduler / customer_service)
- [ ] CO list view: filter, search, sort
- [ ] CO detail: lines, allocations, fulfilled counts
- [ ] Create new CO (admin/scheduler/cs)
- [ ] Mainframe: jobs with CO context render Customer Display
- [ ] Job Traveler print: customer name appears correctly
- [ ] Compliance Review: job_documents render in the review modal
- [ ] WO Lookup: works for both single-product and multi-product WOs
- [ ] **Kiosk regression:** open Kiosk URL in fresh browser session, PIN in, verify operator can see jobs (confirms post-S6 JWT path)

---

# Migration 4 — M4 — Finishing tables

**Risk:** 🟡 Medium
**Tables (3):** `finishing_sends`, `outbound_sends`, `assembly_component_checkins`
**Changes:** Enable RLS on `assembly_component_checkins`. Replace legacy `ALL public` on `finishing_sends`. `outbound_sends` already correct (verify only).

### Migration SQL
```sql
BEGIN;

-- ============================================================
-- assembly_component_checkins — enable RLS, create 4 auth policies
-- ============================================================
ALTER TABLE public.assembly_component_checkins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "assembly_component_checkins_select_authenticated" ON public.assembly_component_checkins
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "assembly_component_checkins_insert_authenticated" ON public.assembly_component_checkins
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "assembly_component_checkins_update_authenticated" ON public.assembly_component_checkins
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "assembly_component_checkins_delete_authenticated" ON public.assembly_component_checkins
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- finishing_sends — replace legacy ALL public with per-cmd auth
-- ============================================================
DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.finishing_sends;

CREATE POLICY "finishing_sends_select_authenticated" ON public.finishing_sends
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "finishing_sends_insert_authenticated" ON public.finishing_sends
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "finishing_sends_delete_authenticated" ON public.finishing_sends
  FOR DELETE TO authenticated USING (true);
-- UPDATE policy "Authenticated update finishing_sends" already exists — keep

-- ============================================================
-- outbound_sends — already correct, verification only (no changes)
-- ============================================================

-- ============================================================
-- Verification
-- ============================================================
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  COUNT(p.policyname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.schemaname = 'public'
WHERE n.nspname = 'public'
  AND c.relname IN ('assembly_component_checkins', 'finishing_sends', 'outbound_sends')
GROUP BY c.relname, c.relrowsecurity
ORDER BY c.relname;
-- Expected:
--   assembly_component_checkins  rls_enabled=true  4 policies
--   finishing_sends              rls_enabled=true  4 policies
--   outbound_sends               rls_enabled=true  4 policies

COMMIT;
```

### Regression checklist
- [ ] **Finishing station** (regular computer): PIN in, queue loads, active batches visible
- [ ] Finishing: pick a batch → Wash → Treatment → Dry stage progression
- [ ] Finishing: Send to Compliance Review
- [ ] Compliance Review: pending queue loads, approve a batch
- [ ] Kiosk: send a batch to finishing (creates `finishing_sends` row)
- [ ] **Outsourcing flow:** send a job to outside vendor (creates `outbound_sends`), mark returned
- [ ] Assembly tab (if `FEATURES.ASSEMBLY_MODULE` is on): component check-in works → writes to `assembly_component_checkins`

---

# Migration 5 — M5 — Material tables

**Risk:** 🟡 Medium
**Tables (9):** `materials`, `material_receiving`, `material_usage`, `parts`, `assembly_bom`, `part_documents`, `part_document_requirements`, `part_routing_steps`, `part_machine_durations`
**Changes:** Add missing DELETE policies on `materials` (admin) and `parts` (auth). Normalize legacy `ALL public` on `part_routing_steps`. Normalize legacy DELETE-via-public on `part_documents` and `part_machine_durations`. Others already correct (verify).

### Migration SQL
```sql
BEGIN;

-- ============================================================
-- materials — add missing admin DELETE
-- ============================================================
CREATE POLICY "materials_delete_admin" ON public.materials
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
              AND profiles.role::text = 'admin')
  );

-- ============================================================
-- parts — add missing auth DELETE
-- ============================================================
CREATE POLICY "parts_delete_authenticated" ON public.parts
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- part_documents — normalize legacy DELETE TO public to TO authenticated
-- ============================================================
DROP POLICY IF EXISTS "Allow authenticated delete" ON public.part_documents;
CREATE POLICY "part_documents_delete_authenticated" ON public.part_documents
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- part_routing_steps — replace legacy ALL public + DELETE public
-- ============================================================
DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.part_routing_steps;
DROP POLICY IF EXISTS "Allow authenticated delete" ON public.part_routing_steps;

CREATE POLICY "part_routing_steps_select_authenticated" ON public.part_routing_steps
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "part_routing_steps_insert_authenticated" ON public.part_routing_steps
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "part_routing_steps_delete_authenticated" ON public.part_routing_steps
  FOR DELETE TO authenticated USING (true);
-- UPDATE "Authenticated update part_routing_steps" already exists — keep

-- ============================================================
-- part_machine_durations — normalize legacy DELETE only.
-- (INSERT is intentionally restricted to admin/scheduler via the existing
--  ALL policy — preserves current behavior; do NOT add an auth INSERT
--  policy which would loosen it.)
-- ============================================================
DROP POLICY IF EXISTS "Allow authenticated delete" ON public.part_machine_durations;
CREATE POLICY "part_machine_durations_delete_authenticated" ON public.part_machine_durations
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- Already-correct tables (verification only, no changes):
--   material_receiving, material_usage, assembly_bom, part_document_requirements
-- ============================================================

-- ============================================================
-- Verification
-- ============================================================
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  COUNT(p.policyname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.schemaname = 'public'
WHERE n.nspname = 'public'
  AND c.relname IN ('materials', 'material_receiving', 'material_usage',
                    'parts', 'assembly_bom', 'part_documents',
                    'part_document_requirements', 'part_routing_steps',
                    'part_machine_durations')
GROUP BY c.relname, c.relrowsecurity
ORDER BY c.relname;
-- All should be rls_enabled=true and policy_count >= 4

COMMIT;
```

### Regression checklist
- [ ] Receiving → Material Master: list, add new material (admin), edit, attempt delete (admin only)
- [ ] Receiving → Material Receiving Log: list, add new receipt (any auth), attempt delete (admin only)
- [ ] Receiving → Material Usage: list, attempt delete (admin only)
- [ ] Armory → Parts: list, add part, edit, delete
- [ ] Armory → Part Documents: list, upload, set current, delete
- [ ] Armory → Routing for a part: SELECT, INSERT, UPDATE, DELETE steps
- [ ] Schedule → expected duration on a job (reads `part_machine_durations`)
- [ ] Armory → Part Machine Durations: edit a row (admin/scheduler); try as non-admin/non-scheduler user (should still work for UPDATE per existing auth UPDATE policy)

---

# Migration 6 — M2 — Production tables

**Risk:** 🟡 Medium
**Tables (9):** `jobs`, `job_routing_steps`, `job_materials`, `job_tools`, `job_documents`, `job_document_snapshots`, `work_orders`, `work_order_assemblies`, `work_order_assembly_routing_steps`
**Changes:** Enable RLS on `job_materials`. Add missing DELETE policies on `jobs`, `work_orders`, `work_order_assemblies`, `job_document_snapshots`. Normalize legacy `ALL public` on `job_routing_steps`. Normalize legacy DELETE-via-public on `job_tools` and `job_documents`. Drop duplicate INSERT on `work_order_assemblies`.

### Migration SQL
```sql
BEGIN;

-- ============================================================
-- job_materials — enable RLS, create 4 auth policies
-- ============================================================
ALTER TABLE public.job_materials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "job_materials_select_authenticated" ON public.job_materials
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "job_materials_insert_authenticated" ON public.job_materials
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "job_materials_update_authenticated" ON public.job_materials
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "job_materials_delete_authenticated" ON public.job_materials
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- jobs — add missing DELETE
-- ============================================================
CREATE POLICY "jobs_delete_authenticated" ON public.jobs
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- work_orders — add missing DELETE
-- ============================================================
CREATE POLICY "work_orders_delete_authenticated" ON public.work_orders
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- work_order_assemblies — drop duplicate INSERT, add missing DELETE
-- ============================================================
DROP POLICY IF EXISTS "Allow authenticated insert on work_order_assemblies" ON public.work_order_assemblies;
-- "Allow authenticated insert" remains (the kept one)

CREATE POLICY "work_order_assemblies_delete_authenticated" ON public.work_order_assemblies
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- job_document_snapshots — add missing DELETE
-- ============================================================
CREATE POLICY "job_document_snapshots_delete_authenticated" ON public.job_document_snapshots
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- job_routing_steps — replace legacy ALL public + DELETE public
-- ============================================================
DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.job_routing_steps;
DROP POLICY IF EXISTS "Allow authenticated delete" ON public.job_routing_steps;

CREATE POLICY "job_routing_steps_select_authenticated" ON public.job_routing_steps
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "job_routing_steps_insert_authenticated" ON public.job_routing_steps
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "job_routing_steps_delete_authenticated" ON public.job_routing_steps
  FOR DELETE TO authenticated USING (true);
-- UPDATE "Authenticated update job_routing_steps" already exists — keep

-- ============================================================
-- job_tools — normalize legacy DELETE TO public (preserves admin ALL + self-update)
-- ============================================================
DROP POLICY IF EXISTS "Allow authenticated delete" ON public.job_tools;
CREATE POLICY "job_tools_delete_authenticated" ON public.job_tools
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- job_documents — normalize legacy DELETE TO public
-- ============================================================
DROP POLICY IF EXISTS "Allow authenticated delete" ON public.job_documents;
CREATE POLICY "job_documents_delete_authenticated" ON public.job_documents
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- Verification
-- ============================================================
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  COUNT(p.policyname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.schemaname = 'public'
WHERE n.nspname = 'public'
  AND c.relname IN ('jobs', 'job_routing_steps', 'job_materials', 'job_tools',
                    'job_documents', 'job_document_snapshots', 'work_orders',
                    'work_order_assemblies', 'work_order_assembly_routing_steps')
GROUP BY c.relname, c.relrowsecurity
ORDER BY c.relname;
-- All should be rls_enabled=true and policy_count >= 4

COMMIT;
```

### Regression checklist
- [ ] Mainframe: jobs grid loads, KPI tiles populate
- [ ] Create new Work Order (admin/scheduler) — exercises jobs + work_orders INSERT
- [ ] Edit existing job: change machine, start date, qty
- [ ] Schedule: drag-drop a job to a new slot
- [ ] Compliance Review: approve a batch, add documents
- [ ] Kiosk: complete a job → exercises job_materials INSERT/UPDATE + jobs UPDATE
- [ ] Assembly tab: assembly progression touches `work_order_assemblies` UPDATE
- [ ] Job Traveler print

---

# Migration 7 — M6 — Kiosk tables

**Risk:** 🟡 Medium
**Tables (5):** `kiosk_sessions`, `machine_downtime_logs`, `machine_idle_logs`, `tools`, `tool_instances`
**Changes:** Enable RLS on `kiosk_sessions` and `machine_idle_logs`. Add explicit DELETE on `tools`, `tool_instances`, `machine_downtime_logs` (currently covered only by admin ALL — making explicit). Add explicit INSERT on `tools` (currently covered only by admin/compliance ALL).

### Migration SQL
```sql
BEGIN;

-- ============================================================
-- kiosk_sessions — enable RLS, create 4 auth policies
-- ============================================================
ALTER TABLE public.kiosk_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "kiosk_sessions_select_authenticated" ON public.kiosk_sessions
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "kiosk_sessions_insert_authenticated" ON public.kiosk_sessions
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "kiosk_sessions_update_authenticated" ON public.kiosk_sessions
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "kiosk_sessions_delete_authenticated" ON public.kiosk_sessions
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- machine_idle_logs — enable RLS, create 4 auth policies
-- ============================================================
ALTER TABLE public.machine_idle_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "machine_idle_logs_select_authenticated" ON public.machine_idle_logs
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "machine_idle_logs_insert_authenticated" ON public.machine_idle_logs
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "machine_idle_logs_update_authenticated" ON public.machine_idle_logs
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "machine_idle_logs_delete_authenticated" ON public.machine_idle_logs
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- machine_downtime_logs — add explicit auth DELETE
-- (admin ALL policy stays; self-UPDATE policy stays; this just normalizes)
-- ============================================================
CREATE POLICY "machine_downtime_logs_delete_authenticated" ON public.machine_downtime_logs
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- tools — add explicit auth INSERT and DELETE
-- (admin/compliance ALL policy stays; this normalizes)
-- ============================================================
CREATE POLICY "tools_insert_authenticated" ON public.tools
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "tools_delete_authenticated" ON public.tools
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- tool_instances — add explicit auth DELETE
-- (admin ALL policy stays; this normalizes)
-- ============================================================
CREATE POLICY "tool_instances_delete_authenticated" ON public.tool_instances
  FOR DELETE TO authenticated USING (true);

-- ============================================================
-- Verification
-- ============================================================
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  COUNT(p.policyname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.schemaname = 'public'
WHERE n.nspname = 'public'
  AND c.relname IN ('kiosk_sessions', 'machine_downtime_logs',
                    'machine_idle_logs', 'tools', 'tool_instances')
GROUP BY c.relname, c.relrowsecurity
ORDER BY c.relname;
-- All should be rls_enabled=true and policy_count >= 4

COMMIT;
```

### Regression checklist
- [ ] **Kiosk on iPad fresh URL** (Mazak 5 wave 1): PIN in via `kiosk-authenticate`, jobs visible, session row created in `kiosk_sessions`
- [ ] Kiosk: realtime session-takeover from a second device (force-logout flow)
- [ ] Kiosk: log a machine downtime → writes to `machine_downtime_logs`
- [ ] Schedule view: downtime markers visible
- [ ] Idle tracking: leave kiosk idle for >5 min, verify `machine_idle_logs` writes (if applicable)
- [ ] Finishing logout flow: deactivates kiosk session
- [ ] Realtime subscription on `kiosk_sessions` still fires (session sub for finishing operator)

---

# Migration 8 — M7 — Audit + staging + profiles (HIGHEST RISK)

**Risk:** 🔴 High
**Tables (5):** `audit_logs`, `import_bom_staging`, `import_parts_staging`, `lot_number_sequences`, `profiles`
**Changes:**
1. `ALTER FUNCTION` to make 2 lot RPCs SECURITY DEFINER (prerequisite for `lot_number_sequences` lockdown)
2. Enable RLS on all 5 tables
3. `audit_logs` → Profile F (auth SELECT + INSERT only; no UPDATE/DELETE policies)
4. `lot_number_sequences` → Profile E (auth SELECT only; writes via service_role + DEFINER RPCs)
5. `import_*_staging` → Profile E (no auth access; service_role only)
6. `profiles` → broad SELECT TO authenticated; drop duplicate narrow policy

**This is the most sensitive migration. Ship it last, on a Sunday morning, with extra regression time.**

### Prod-promotion gate
```sql
-- Confirm the two RPCs are still NOT SECURITY DEFINER on prod
-- (if someone already manually fixed them, skip the ALTER FUNCTION lines)
SELECT proname, prosecdef
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND proname IN ('next_lot_number', 'next_standalone_finishing_job_number');
-- Expected: prosecdef = false for both (or true if already fixed manually).
```

### Migration SQL
```sql
BEGIN;

-- ============================================================
-- STEP 1: Make lot RPCs SECURITY DEFINER so they bypass RLS on
-- lot_number_sequences. Without this, locking down lot_number_sequences
-- in step 4 breaks PLN generation at the Kiosk.
-- ============================================================
ALTER FUNCTION public.next_lot_number(text, text) SECURITY DEFINER;
ALTER FUNCTION public.next_standalone_finishing_job_number() SECURITY DEFINER;
-- next_finishing_lot_number already SECURITY DEFINER

-- ============================================================
-- STEP 2: profiles — enable RLS, drop redundant narrow SELECT
-- Per D1: keep broad SELECT (4 paths depend on it: Finishing PIN auth,
-- Kiosk session restore, UsersTab, salespeople dropdown).
-- ============================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- The "Users can view own profile" policy (USING auth.uid()=id) is redundant
-- given the broad "Allow authenticated read" — drop it.
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;

-- Add missing INSERT/UPDATE/DELETE policies. Profile management goes
-- through the manage-users Edge Function (service_role bypass) so these
-- auth policies are belt-and-suspenders for edge cases (e.g.,
-- ChangePinModal updates own profile, SetPassword.jsx PIN write).
CREATE POLICY "profiles_insert_authenticated" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "profiles_update_authenticated" ON public.profiles
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "profiles_delete_authenticated" ON public.profiles
  FOR DELETE TO authenticated USING (true);
-- SELECT "Allow authenticated read" already exists — keep (broad)

-- ============================================================
-- STEP 3: audit_logs — Profile F (append-only integrity)
-- Auth users: SELECT + INSERT only. NO update or delete policies →
-- denied for everyone except service_role (which bypasses).
-- ============================================================
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_logs_select_authenticated" ON public.audit_logs
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "audit_logs_insert_authenticated" ON public.audit_logs
  FOR INSERT TO authenticated WITH CHECK (true);
-- Intentionally NO UPDATE or DELETE policies — append-only.

-- ============================================================
-- STEP 4: lot_number_sequences — Profile E (service_role only writes)
-- Auth users can SELECT (read sequence state) but cannot modify.
-- The 3 lot RPCs (now all SECURITY DEFINER) perform writes server-side.
-- ============================================================
ALTER TABLE public.lot_number_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lot_number_sequences_select_authenticated" ON public.lot_number_sequences
  FOR SELECT TO authenticated USING (true);
-- Intentionally NO INSERT/UPDATE/DELETE policies — service_role only.

-- ============================================================
-- STEP 5: import_*_staging — Profile E (full service_role lockdown)
-- No auth access at all. Fishbowl import runs as service_role.
-- ============================================================
ALTER TABLE public.import_bom_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_parts_staging ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies — service_role only.

-- ============================================================
-- Verification — RLS + policy counts
-- ============================================================
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  COUNT(p.policyname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.schemaname = 'public'
WHERE n.nspname = 'public'
  AND c.relname IN ('audit_logs', 'import_bom_staging', 'import_parts_staging',
                    'lot_number_sequences', 'profiles')
GROUP BY c.relname, c.relrowsecurity
ORDER BY c.relname;
-- Expected:
--   audit_logs              rls_enabled=true  2 policies (SELECT + INSERT)
--   import_bom_staging      rls_enabled=true  0 policies (locked down)
--   import_parts_staging    rls_enabled=true  0 policies (locked down)
--   lot_number_sequences    rls_enabled=true  1 policy  (SELECT)
--   profiles                rls_enabled=true  4 policies (SELECT broad + INSERT/UPDATE/DELETE)

-- Verification — RPC SECURITY DEFINER
SELECT
  proname AS function_name,
  prosecdef AS is_security_definer
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND proname IN ('next_finishing_lot_number',
                  'next_lot_number',
                  'next_standalone_finishing_job_number');
-- Expected: all three is_security_definer = true

COMMIT;
```

### Regression checklist (extensive — this is the high-risk one)
- [ ] **Login flow:** username + password, lands on Mainframe (exercises `profiles` SELECT for self)
- [ ] **Logout, login as different user** — verify session change
- [ ] **Kiosk fresh URL on Mazak 5:** PIN in via `kiosk-authenticate` Edge Function (this uses service_role to look up profiles — bypass-RLS unaffected)
- [ ] **Finishing kiosk:** PIN in (this does direct client-side profile lookup — depends on persisted authenticated session; if it fails, see "Finishing kiosk troubleshoot" below)
- [ ] **Admin → Users tab:** lists all users (broad SELECT on profiles)
- [ ] **Salespeople dropdown** appears on Customer Order forms (broad SELECT, filter `is_salesperson=true`)
- [ ] **Kiosk Complete Job:** generates PLN (uses `next_lot_number` RPC → must work after SECURITY DEFINER change)
- [ ] **Finishing kiosk Send to Compliance:** generates FLN (uses `next_finishing_lot_number` RPC)
- [ ] **Standalone J-FIN creation:** uses `next_standalone_finishing_job_number` RPC
- [ ] **Audit log entries:** create a kiosk material override → confirm `audit_logs` INSERT works
- [ ] **Compliance Review:** approve a batch → confirm `audit_logs` INSERT works
- [ ] **TRY (and expect failure) to UPDATE or DELETE audit_logs from the app** — if any path does this, it must fail; if it fails silently, audit integrity is good. The src/ audit confirmed zero such paths exist.
- [ ] **Change own PIN** (ChangePinModal) — exercises profile UPDATE
- [ ] **Admin reset PIN for another user** — goes through manage-users Edge Function (service_role)
- [ ] **Set password flow** for a new invite — exercises profile SELECT + UPDATE

### Finishing kiosk troubleshoot (if PIN auth breaks after M7)

If the finishing computer can't authenticate post-M7, that means the persisted Supabase session expired / was cleared. Recovery:

1. Open `https://skynet.skybolt.com/` in a browser tab on the finishing computer
2. Log in with the shared finishing account credentials (or any auth account)
3. Navigate back to `/finishing` — PIN auth should work again
4. Add backlog ticket: migrate Finishing.jsx to use a kiosk-authenticate-style Edge Function so it doesn't depend on a persisted session

This is not a Sprint 7 bug — it's exposing a pre-existing fragility. But you'll want a recovery plan in your back pocket Monday morning.

---

## Final wrap — after all 8 migrations are applied to PROD

Run the original 4 diagnostic queries again on prod and confirm:

1. **Q1 (RLS state):** Zero tables with `rls_enabled = false` (down from 11)
2. **Q3 (coverage gap):** Significantly fewer rows. Some intentional gaps remain (audit_logs UPDATE/DELETE, lot_number_sequences INSERT/UPDATE/DELETE, import_*_staging everything) — those are Profile E/F by design.
3. **Q4 (anon access):** Only 2 rows — `locations` SELECT and `machines` SELECT (both intentional kiosk pre-auth)

If Q1/Q3/Q4 match these expectations, Sprint 7 is closed out. Update `Decisions.md` with the new RLS baseline, bump the spec to v3.2.

## Backlog items spawned by Sprint 7

1. **PIN hashing** (bcrypt/argon2) — prerequisite for narrowing `profiles` SELECT in a future sprint
2. **Migrate `Finishing.jsx` to JWT-per-PIN auth pattern** matching `Kiosk.jsx` — eliminates fragility of persisted-session dependency
3. **Move `audit_logs` INSERTs behind an Edge Function** — graduate Profile F → Profile E for full lockdown
4. **`tools` / `tool_instances` usage audit** — zero src/ references; either vestigial or admin-via-SQL-only
5. **Schema drift cleanup** (test vs prod): `job_shortfall_resolutions.resolution` CHECK and `outbound_sends.source_type` CHECK
6. **CI guardrail SQL** (Batch D scope) — fails the deploy if any public table has RLS disabled or zero policies. Prevents regression on future migrations.
