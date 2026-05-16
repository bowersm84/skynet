-- ==============================================================================
-- SkyNet RLS Guardrail — Prevent Future Drift
-- ==============================================================================
--
-- Purpose:
--   Returns rows ONLY for public tables that violate the security baseline.
--   Empty result = healthy.  Any rows = block the deploy.
--
-- Baseline rules:
--   1. Every public table must have RLS enabled (relrowsecurity = true)
--   2. Every public table must have at least 1 policy
--      EXCEPT for service-role-only tables (Profile E intentional lockdown)
--
-- Wire into CI:
--   - GitHub Actions step against TEST Supabase on every PR
--   - Fail the build if any rows return
--   - Run before promoting any migration to prod
--
-- File: Docs/migrations/rls_guardrail.sql
-- Drafted: May 16, 2026 (Sprint 7 closeout)
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- Intentional exceptions: tables that are Profile E (service-role only).
-- These have RLS enabled but zero authenticated policies BY DESIGN.
-- If a new table needs this treatment, add it here AND document in Decisions.md.
-- ------------------------------------------------------------------------------
WITH service_role_only_tables AS (
  SELECT unnest(ARRAY[
    'import_bom_staging',
    'import_parts_staging'
  ]) AS table_name
),

-- ------------------------------------------------------------------------------
-- All public tables and their RLS state
-- ------------------------------------------------------------------------------
all_public_tables AS (
  SELECT
    c.relname AS table_name,
    c.relrowsecurity AS rls_enabled,
    (
      SELECT count(*)
      FROM pg_policies p
      WHERE p.schemaname = 'public'
        AND p.tablename = c.relname
    ) AS policy_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
)

-- ------------------------------------------------------------------------------
-- Violations: tables that fail the baseline
-- ------------------------------------------------------------------------------
SELECT
  t.table_name,
  t.rls_enabled,
  t.policy_count,
  CASE
    WHEN NOT t.rls_enabled
      THEN 'RLS DISABLED — must be enabled for all public tables'
    WHEN t.policy_count = 0 AND s.table_name IS NULL
      THEN 'NO POLICIES — table has RLS enabled but no policies, and it is not on the service-role-only allowlist'
  END AS violation_reason
FROM all_public_tables t
LEFT JOIN service_role_only_tables s
  ON s.table_name = t.table_name
WHERE
  NOT t.rls_enabled
  OR (t.policy_count = 0 AND s.table_name IS NULL)
ORDER BY t.table_name;

-- ==============================================================================
-- HOW TO INTERPRET RESULTS
-- ==============================================================================
--
-- ZERO rows returned: ✅ Baseline healthy. Safe to deploy.
--
-- ROWS returned: ❌ Investigate before deploying. For each violation:
--   - 'RLS DISABLED' → Add `ALTER TABLE public.<name> ENABLE ROW LEVEL SECURITY;`
--                     and at least one policy to your migration
--   - 'NO POLICIES'  → Add policies per the access matrix (Profile A is the
--                      default; consult Decisions.md and RLS_Access_Matrix_v2.md
--                      for the right profile). If the table SHOULD be
--                      service-role-only, add its name to the
--                      service_role_only_tables CTE above AND document in
--                      Decisions.md under the RLS section.
--
-- ==============================================================================
-- MAINTENANCE
-- ==============================================================================
--
-- When adding a new public table:
--   1. The migration must include `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`
--   2. The migration must include at least one policy (per the matrix)
--   3. OR the table must be added to the service_role_only_tables CTE in
--      this file AND documented in Decisions.md
--
-- When removing a public table:
--   1. The DROP TABLE migration is sufficient — this guardrail will simply
--      stop seeing the table. No changes needed here.
--
-- ==============================================================================
