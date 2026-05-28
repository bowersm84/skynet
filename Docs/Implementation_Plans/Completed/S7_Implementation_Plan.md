# SkyNet Sprint 7 — Implementation Plan
## RLS Security Hardening
### Drafted: May 6, 2026

---

## Sprint Goal

Eliminate the standing Supabase RLS warnings, close anon-readable data
exposures introduced during go-live triage, and establish a sustainable
security posture that won't drift again.

This is a security sprint, not a feature sprint. No user-visible
behavior should change. Success is measured by: (a) Supabase dashboard
shows zero RLS warnings on public tables, (b) anon access is restricted
to a small, intentional set of pre-auth surfaces, and (c) a CI check
prevents new tables from being added without RLS.

---

## Why now

Several anon SELECT policies were added during go-live to unblock the
iPad kiosk before Sprint 6's JWT auth shipped. With Sprint 6 deployed,
the kiosk authenticates against Supabase like any other client, so
those broad anon policies are no longer needed. Leaving them in place
exposes customer order data, jobs, work orders, and other operational
records to anyone who scrapes the anon key from the JS bundle — a real
finding for any AS9100 / FAA audit.

Supabase's dashboard has been flagging missing or weak policies for
weeks. The warnings are accurate, not noise.

---

## Sprint Structure

| Batch | Scope | Effort | Status |
|-------|-------|--------|--------|
| A | Inventory & audit current RLS state | S | ⏳ Not started |
| B | Define and ratify the access matrix | S | ⏳ Not started |
| C | Migration: enable RLS, write policies, remove temp anon grants | M | ⏳ Not started |
| D | Verification, regression, CI guardrail, Decisions.md | S | ⏳ Not started |

**Total estimated effort:** 1.5–2 days of dev work + 0.5 day Matt regression.

---

## Open Decisions Needed Before Batch C

1. **Role-based row filtering within `authenticated`.** Today, every
   authenticated user can SELECT every row on most tables; the app
   filters by role in the UI. Should we add row-level filtering for
   sensitive tables (e.g. `audit_logs` admin-only, `customer_orders`
   excluding cancelled from non-admins)? Recommendation: defer —
   current approach is fine for a small trusted shop, and tightening
   row-level filters carries regression risk.

2. **Service role usage.** All edge functions use the service role key
   which bypasses RLS by design. We will not write policies for
   `service_role` — that's the standard pattern. Confirm.

3. **Anon access surface — final list.** Recommended:
   - `machines` — keep anon SELECT WHERE is_active = true (kiosk PIN
     screen needs the machine name before auth)
   - `locations` — keep anon SELECT (joined to machines on PIN screen)
   - Everything else — drop anon access entirely.
   Confirm or push back.

4. **What to do with tables that are currently completely public.**
   The Batch A inventory will surface these. Default plan: enable RLS,
   add `authenticated`-only policies, no anon access. Some tables
   (lookup/reference data like `material_types`, `bar_sizes`,
   `document_types`) might justify anon read for lighter-weight views,
   but only if a real use case exists. Default: lock down.

---

## Batch A — Inventory & Audit

**Output:** A markdown audit report committed to
`Docs/RLS_Audit_2026-05.md` showing every public table and its current
RLS state. Used as the baseline for Batch C.

**Diagnostic SQL (run in Supabase SQL Editor, paste results into the
audit doc):**

```sql
-- 1. Per-table RLS enabled status
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY rls_enabled, table_name;

-- 2. Per-policy detail
SELECT
  tablename,
  policyname,
  cmd,
  roles,
  qual AS using_clause,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, cmd, policyname;

-- 3. Coverage summary: which (table, op) combos lack a policy?
WITH ops AS (
  SELECT unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS cmd
),
tables AS (
  SELECT c.relname AS tablename
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
),
combos AS (
  SELECT t.tablename, o.cmd FROM tables t CROSS JOIN ops o
)
SELECT c.tablename, c.cmd, 'NO POLICY' AS status
FROM combos c
LEFT JOIN pg_policies p
  ON p.tablename = c.tablename AND p.cmd = c.cmd AND p.schemaname = 'public'
WHERE p.policyname IS NULL
ORDER BY c.tablename, c.cmd;

-- 4. Anon-accessible tables (any policy granting anon any operation)
SELECT DISTINCT tablename, cmd
FROM pg_policies
WHERE schemaname = 'public' AND 'anon' = ANY(roles::text[])
ORDER BY tablename, cmd;
```

**Inventory writeup.** For each table, the audit doc should record:
- RLS enabled? (yes/no)
- Existing policies (count by operation)
- Anon-accessible? (yes/no)
- Recommended target state (decided in Batch B)
- Migration assignment (which Batch C migration covers it)

---

## Batch B — Define the Access Matrix

**Output:** An access matrix table in
`Docs/RLS_Access_Matrix_v1.md` covering every public table. Reviewed
and approved by Matt before Batch C migrations are written.

**Default profile (apply unless table calls for a deviation):**

| Operation | anon | authenticated | service_role |
|-----------|------|---------------|--------------|
| SELECT    | ❌   | ✅ (qual=true) | ✅ (bypass)   |
| INSERT    | ❌   | ✅ (with_check=true) | ✅ (bypass) |
| UPDATE    | ❌   | ✅ (qual=true, with_check=true) | ✅ (bypass) |
| DELETE    | ❌   | ✅ (qual=true) | ✅ (bypass) |

**Deviations from default:**

| Table | Deviation | Reason |
|-------|-----------|--------|
| `machines` | anon SELECT WHERE is_active = true | Kiosk PIN screen needs machine name pre-auth |
| `locations` | anon SELECT | Joined to machines on kiosk PIN screen |
| `audit_logs` | INSERT only via service_role; no UPDATE or DELETE | Audit integrity |
| `import_*_staging` | service_role only | Internal Fishbowl import scratchpad |
| `lot_number_sequences` | UPDATE via RPC only (no direct UPDATE policy) | Lot number generation must be atomic |

**Tables identified during go-live triage with broad anon policies to remove:**
- `customer_orders`
- `customer_order_lines`
- `customer_order_allocations`
- `customers`
- `job_documents`

These were added when the kiosk was anon-only. With Sprint 6's JWT
auth, the kiosk is now authenticated and these can revert to
authenticated-only.

---

## Batch C — Migration & Patch

**Approach:** One migration file per logical table group. Each
migration is idempotent (`drop policy if exists` + `create policy`),
runs in a transaction, and is paired with a verification SELECT at the
end. Apply to test first, validate, then prod.

**Migration grouping:**

1. `2026-05-XX_rls_lookup_tables.sql` — bar_sizes, material_types,
   document_types, routing_templates, routing_template_steps
2. `2026-05-XX_rls_production_tables.sql` — jobs, work_orders,
   work_order_assemblies, work_order_assembly_routing_steps,
   job_routing_steps, job_materials, job_tools, job_documents,
   job_document_snapshots
3. `2026-05-XX_rls_customer_tables.sql` — customers, customer_orders,
   customer_order_lines, customer_order_allocations
4. `2026-05-XX_rls_finishing_tables.sql` — finishing_sends,
   outbound_sends, assembly_component_checkins
5. `2026-05-XX_rls_material_tables.sql` — materials, material_receiving,
   material_usage, parts, assembly_bom, part_documents,
   part_document_requirements, part_routing_steps,
   part_machine_durations
6. `2026-05-XX_rls_kiosk_tables.sql` — kiosk_sessions,
   machine_downtime_logs, machine_idle_logs, tools, tool_instances
7. `2026-05-XX_rls_audit_and_staging.sql` — audit_logs,
   import_bom_staging, import_parts_staging, lot_number_sequences
8. `2026-05-XX_rls_remove_temp_anon.sql` — drop the broad anon policies
   from go-live triage (customers, customer_orders, customer_order_lines,
   customer_order_allocations, job_documents). Keep machines/locations
   anon SELECT.

**Per-migration template:**

```sql
-- Migration: <description>
BEGIN;

-- Ensure RLS is enabled on every covered table
ALTER TABLE public.<table_name> ENABLE ROW LEVEL SECURITY;
-- ... repeat for each table in this group ...

-- Drop any pre-existing policies we're replacing (idempotent)
DROP POLICY IF EXISTS "<old_policy_name>" ON public.<table_name>;
-- ... etc ...

-- Create the canonical policies per the access matrix
CREATE POLICY "<table>_select_authenticated"
  ON public.<table_name> FOR SELECT TO authenticated USING (true);

CREATE POLICY "<table>_insert_authenticated"
  ON public.<table_name> FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "<table>_update_authenticated"
  ON public.<table_name> FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY "<table>_delete_authenticated"
  ON public.<table_name> FOR DELETE TO authenticated USING (true);

-- Verification: every table covered must have RLS enabled and
-- at least 4 policies after this migration
SELECT
  c.relname,
  c.relrowsecurity AS rls_enabled,
  (SELECT count(*) FROM pg_policies p
    WHERE p.tablename = c.relname AND p.schemaname = 'public') AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN (<comma-list of tables>)
ORDER BY c.relname;

COMMIT;
```

If the verification step shows any covered table with `rls_enabled =
false` or `policy_count < 4`, run `ROLLBACK` and investigate before
moving to the next migration.

---

## Batch D — Verification, Regression, & Guardrails

**(1) Manual end-to-end regression (Matt):** Walk every major surface
of the app to confirm no functional regression. Suggested checklist:

- [ ] Login as admin — Mainframe loads with all WO/jobs visible
- [ ] WO Lookup — search, expand, edit
- [ ] Customer Orders — list, create, edit, allocate
- [ ] Schedule (Command View) — grid + list, drag/drop, scheduled jobs visible
- [ ] Compliance Review — pending queue, approve/reject
- [ ] Kiosk on iPad (fresh) — PIN in, jobs visible, materials, send to finishing
- [ ] Finishing — wash/treatment/dry, approve, partial check-in
- [ ] Machinist role — log in, see only assigned machines, complete a job
- [ ] Compliance role — see only compliance queue
- [ ] Backup compliance approver — verify access works
- [ ] Receiving — material master, raw material receipt
- [ ] TCO module — close work orders
- [ ] Print Hub — print package, traveler with multi-CO customer

Any failure during regression: pause, isolate which migration broke it,
fix the policy.

**(2) CI/SQL guardrail.** Add a SQL test (run via GitHub Actions, or as
a pre-deploy check) that fails the build if any public table has RLS
disabled or zero policies. This prevents drift on future migrations.

```sql
-- Returns rows ONLY for tables that fail the security baseline
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  (SELECT count(*) FROM pg_policies p
    WHERE p.tablename = c.relname AND p.schemaname = 'public') AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND (c.relrowsecurity = false
       OR (SELECT count(*) FROM pg_policies p
           WHERE p.tablename = c.relname AND p.schemaname = 'public') = 0);
```

If this query returns any rows, the deploy fails. Empty result =
healthy.

**(3) Documentation.** Update `Docs/Decisions.md` with:
- The access matrix (snapshot of v1)
- The list of intentional anon surfaces (machines, locations) and why
- The CI guardrail and how to update it when adding tables
- The rationale for not doing role-based row filtering yet (deferred,
  not abandoned)

Bump the spec to v3.0 to reflect the security baseline shift.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| A migration breaks a query path we forgot about | Apply to test first, run full regression, only then promote to prod |
| Removing anon policy breaks the kiosk on a fresh device | Sprint 6 must be deployed and verified BEFORE Batch C runs |
| Edge function silently fails after policy change | Edge functions use service_role and bypass RLS — should be unaffected, but verify each function still works post-migration |
| Real-time subscriptions stop firing | Realtime respects RLS — if a policy excludes a row, that row's events won't be delivered. Test the kiosk's session subscription specifically |

---

## Out of Scope

- Role-based row filtering inside `authenticated` (deferred)
- Field-level encryption / column masking
- Multi-tenant isolation (single tenant for now)
- Auth provider changes (still email + PIN)

---

## Sprint Closeout Criteria

- [ ] Audit doc committed (`Docs/RLS_Audit_2026-05.md`)
- [ ] Access matrix doc committed (`Docs/RLS_Access_Matrix_v1.md`)
- [ ] All Batch C migrations applied to prod and verified
- [ ] All temp anon policies from go-live removed
- [ ] CI guardrail SQL added and passing
- [ ] Manual regression checklist complete with no open issues
- [ ] `Docs/Decisions.md` updated
- [ ] Spec bumped to v3.0
- [ ] Supabase dashboard shows zero RLS warnings on public tables
