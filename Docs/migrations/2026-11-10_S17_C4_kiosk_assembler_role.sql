-- ============================================================================
-- S17 C4 — a database role for tablet-only sessions: the tablet and nothing
--           else, enforced by the database
-- 2026-11-10  ·  D-ASM-50
--
-- Why: the screens are the only control on most of SkyNet's data today — any
-- signed-in session can read, and on many tables change, far more than its
-- screens show. For tablet-only (kiosk-only) assemblers the rule is "the
-- tablet and nothing else", so their sessions get their own Postgres role
-- with exactly the grants the assembly kiosk needs and no others. Anything
-- not granted here — every other table, view and function, including ones
-- added later — is refused by Postgres itself (permission denied, 42501).
--
-- INERT until kiosk-authenticate mints a token whose role claim is
-- kiosk_assembler (Batch C, phase 7). Nothing changes for any other role:
-- no existing policy, grant or function is altered.
--
-- Applied on TEST by Claude on 2026-11-10 (migration
-- s17_c4_kiosk_assembler_role) and exercised there by switching to the role:
-- the kiosk's reads and functions work; 21 forbidden reads, writes and
-- function calls are all refused.
-- PROD ORDER: after C1, C2a and C3; before the Batch C deploy.
-- ============================================================================

DO $r$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kiosk_assembler') THEN
    CREATE ROLE kiosk_assembler NOLOGIN;
  END IF;
END
$r$;
-- The API connects as authenticator and switches to the role named in the token;
-- this membership is what makes the role reachable.
GRANT kiosk_assembler TO authenticator;
GRANT USAGE ON SCHEMA public TO kiosk_assembler;

-- Reads: exactly what the assembly kiosk reads (CC's inventory, 2026-11-10).
GRANT SELECT ON public.v_assembly_kiosk_builds,
                public.assembly_builds, public.assembly_checklist_steps, public.assembly_checklist_templates,
                public.assembly_component_lots, public.assembly_requests, public.assembly_sessions,
                public.assembly_step_signoffs TO kiosk_assembler;
GRANT SELECT (id, part_number, description) ON public.parts TO kiosk_assembler;   -- no cost, no customer
GRANT SELECT ON public.profiles TO kiosk_assembler;        -- rows limited by policy below
GRANT SELECT ON public.app_settings TO kiosk_assembler;    -- rows limited by policy below

DO $p$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assembly_builds','assembly_checklist_steps','assembly_checklist_templates',
                           'assembly_component_lots','assembly_requests','assembly_sessions',
                           'assembly_step_signoffs','parts'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_kiosk_assembler_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO kiosk_assembler USING (true)', t || '_kiosk_assembler_read', t);
  END LOOP;
END
$p$;

-- profiles: the caller's own row, and the assembly team's rows (names and avatars on build cards).
DROP POLICY IF EXISTS profiles_kiosk_assembler_read ON public.profiles;
CREATE POLICY profiles_kiosk_assembler_read ON public.profiles FOR SELECT TO kiosk_assembler
  USING (
    id::text = (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    OR role = 'assembly'
    OR 'assembly' = ANY (COALESCE(roles, '{}'))
  );

-- app_settings: the assembly settings only (lot display prefix) — not the costing rules.
DROP POLICY IF EXISTS app_settings_kiosk_assembler_read ON public.app_settings;
CREATE POLICY app_settings_kiosk_assembler_read ON public.app_settings FOR SELECT TO kiosk_assembler
  USING (category = 'assembly');

-- No INSERT, UPDATE or DELETE on anything: every kiosk write goes through these functions.
GRANT EXECUTE ON FUNCTION public.assembly_kiosk_components(uuid) TO kiosk_assembler;
GRANT EXECUTE ON FUNCTION public.assembly_build_start(uuid, jsonb, text) TO kiosk_assembler;
GRANT EXECUTE ON FUNCTION public.assembly_session_clock_in(uuid) TO kiosk_assembler;
GRANT EXECUTE ON FUNCTION public.assembly_session_clock_out(uuid, integer, text) TO kiosk_assembler;
GRANT EXECUTE ON FUNCTION public.assembly_step_signoff(uuid, uuid, text[], jsonb, text) TO kiosk_assembler;
GRANT EXECUTE ON FUNCTION public.assembly_build_closeout(uuid, integer, integer, text) TO kiosk_assembler;
GRANT EXECUTE ON FUNCTION public.assembly_pin_resolve(text) TO kiosk_assembler;
GRANT EXECUTE ON FUNCTION public.profile_pin_set(text, text) TO kiosk_assembler;
GRANT EXECUTE ON FUNCTION public.profile_set_avatar(uuid, text, text) TO kiosk_assembler;
GRANT EXECUTE ON FUNCTION public._assembly_template_for_wave(uuid) TO kiosk_assembler;   -- used by the kiosk view

-- ---------------------------------------------------------------------------
-- Verify. Expect: 11 readable objects (app_settings, the seven assembly_*
-- tables, parts, profiles, v_assembly_kiosk_builds); 0 writable; and exactly
-- the ten functions granted above in the last column.
-- ---------------------------------------------------------------------------
select
 (select string_agg(c.relname, ', ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','v','m','p')
     and (has_table_privilege('kiosk_assembler', c.oid, 'SELECT') or has_any_column_privilege('kiosk_assembler', c.oid, 'SELECT'))) as readable,
 (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','v','m','p')
     and (has_table_privilege('kiosk_assembler', c.oid, 'INSERT') or has_table_privilege('kiosk_assembler', c.oid, 'UPDATE') or has_table_privilege('kiosk_assembler', c.oid, 'DELETE'))) as writable_count,
 (select string_agg(p.proname, ', ' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and pg_get_function_result(p.oid) <> 'trigger' and has_function_privilege('kiosk_assembler', p.oid, 'EXECUTE')) as security_definer_executable;
