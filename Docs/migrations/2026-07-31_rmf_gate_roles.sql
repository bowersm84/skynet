-- 2026-07-31_rmf_gate_roles.sql
-- D-RMF-06 — RM Forecast view access widened; gate honors multi-role.
--
-- Problem: public._rm_forecast_gate() resolved the caller's role from
-- profiles.role ONLY. Sawyer Griner holds purchaser as an ADDITIONAL role
-- (profiles.role = 'customer_service', profiles.roles = {purchaser}), so the
-- frontend showed the RM Forecast tab (hasRole() is multi-role aware,
-- D-MROLE-02) while all five forecast RPCs raised 'Not authorized' and the
-- screen rendered the "Forecast access is limited" panel.
--
-- Fix: same gate, two changes —
--   1. allowed set widened to admin / scheduler / purchaser / compliance / machinist
--   2. role resolution routed through public.user_has_role() (SECURITY DEFINER,
--      STABLE, SET search_path=public — verified safe to call from here), which
--      checks `role = ANY(...) OR roles && ...`, i.e. primary OR additional.
--
-- Deliberately unchanged: the function's signature, return type, language,
-- volatility and SECURITY properties (plpgsql / STABLE / SECURITY INVOKER /
-- no search_path pin / RETURNS void / no arguments); the 'Not authorized'
-- message string (src/components/rmforecast/forecastUtils.js isNotAuthorized
-- matches on it); the grants on the five forecast RPCs; part_dimensions RLS;
-- and the extract-part-dimensions Edge Function gate. Write actions
-- (Needs-data Save, Correct material, Extract) stay admin/scheduler.
--
-- Apply order: TEST -> verify -> PROD. Idempotent (CREATE OR REPLACE).
-- Pure SQL — no psql meta-commands; pastes into the Supabase SQL Editor as-is.

BEGIN;

CREATE OR REPLACE FUNCTION public._rm_forecast_gate()
RETURNS void
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE v_uid uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RETURN; END IF;  -- editor/service contexts; anon blocked by grants
  -- Multi-role aware (D-MROLE-02): profiles.role OR profiles.roles[].
  IF NOT public.user_has_role(
       v_uid, 'admin', 'scheduler', 'purchaser', 'compliance', 'machinist'
     ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
END $function$;


-- ---------------------------------------------------------------------------
-- Verification 1 — the deployed definition
-- ---------------------------------------------------------------------------
SELECT pg_get_functiondef(p.oid) AS gate_definition_after_replace
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = '_rm_forecast_gate';


-- ---------------------------------------------------------------------------
-- Verification 2 — signature / language / SECURITY properties did not drift
-- ---------------------------------------------------------------------------
DO $props$
DECLARE p record;
BEGIN
  SELECT l.lanname,
         pr.prosecdef,
         pr.provolatile,
         pr.proconfig,
         pg_get_function_result(pr.oid)              AS result,
         pg_get_function_identity_arguments(pr.oid)  AS args
    INTO p
    FROM pg_proc pr
    JOIN pg_namespace n ON n.oid = pr.pronamespace
    JOIN pg_language  l ON l.oid = pr.prolang
   WHERE n.nspname = 'public' AND pr.proname = '_rm_forecast_gate';

  IF p.lanname <> 'plpgsql'
     OR p.prosecdef IS DISTINCT FROM false
     OR p.provolatile <> 's'
     OR p.proconfig IS NOT NULL
     OR p.result <> 'void'
     OR p.args <> '' THEN
    RAISE EXCEPTION
      'Gate properties drifted: lang=% secdef=% volatile=% config=% result=% args=%',
      p.lanname, p.prosecdef, p.provolatile, p.proconfig, p.result, p.args;
  END IF;

  RAISE NOTICE 'Properties OK: plpgsql / STABLE / SECURITY INVOKER / no search_path / RETURNS void / no args';
END
$props$;


-- ---------------------------------------------------------------------------
-- Verification 3 — grants untouched on the gate and the five forecast RPCs.
-- CREATE OR REPLACE preserves the ACL; assert it rather than assume it.
-- Expected on every row: postgres + authenticated + service_role, no anon,
-- no PUBLIC (D-KSTC-13).
-- ---------------------------------------------------------------------------
DO $grants$
DECLARE r record; v_bad int := 0;
BEGIN
  FOR r IN
    SELECT p.proname,
           coalesce(array_to_string(p.proacl::text[], ' | '), '(default — PUBLIC EXECUTE!)') AS acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('_rm_forecast_gate', 'forecast_rm_bars', 'forecast_rm_bar_parts',
                         'forecast_blank_demand', 'forecast_blank_onhand', 'forecast_rm_exceptions')
     ORDER BY p.proname
  LOOP
    IF r.acl NOT LIKE '%authenticated=X%'
       OR r.acl NOT LIKE '%service_role=X%'
       OR r.acl LIKE '%anon=%'
       OR r.acl LIKE '=X%'                -- PUBLIC, first entry
       OR r.acl LIKE '%| =X%' THEN        -- PUBLIC, mid-list
      v_bad := v_bad + 1;
      RAISE WARNING 'GRANT DRIFT  %  ->  %', rpad(r.proname, 24), r.acl;
    ELSE
      RAISE NOTICE 'grants OK    %  ->  %', rpad(r.proname, 24), r.acl;
    END IF;
  END LOOP;

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Grant verification failed on % function(s)', v_bad;
  END IF;
END
$grants$;


-- ---------------------------------------------------------------------------
-- Verification 4 — resolve every active profile through the NEW gate for real.
-- auth.uid() reads request.jwt.claim.sub, so impersonating a profile is a
-- transaction-local set_config away. This CALLS _rm_forecast_gate() itself —
-- it does not re-implement the check — and asserts the outcome against the
-- multi-role expectation (primary role OR roles[]). Aborts the transaction on
-- any mismatch, so a bad gate can never commit.
-- ---------------------------------------------------------------------------
DO $gate$
DECLARE
  k_allowed  text[] := ARRAY['admin','scheduler','purchaser','compliance','machinist'];
  r          record;
  v_allow    boolean;
  v_expected boolean;
  v_msg      text;
  v_ok       int := 0;
  v_bad      int := 0;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE 'RESULT | PROFILE            | PRIMARY ROLE     | ADDITIONAL   | GATE  | EXPECT | SCREEN';
  RAISE NOTICE '-------+--------------------+------------------+--------------+-------+--------+---------------';

  FOR r IN
    SELECT p.id, p.full_name, p.role, COALESCE(p.roles, '{}'::text[]) AS roles
      FROM public.profiles p
     WHERE p.is_active
     ORDER BY p.role, p.full_name
  LOOP
    v_expected := (r.role = ANY (k_allowed)) OR (r.roles && k_allowed);

    PERFORM set_config('request.jwt.claim.sub', r.id::text, true);

    BEGIN
      PERFORM public._rm_forecast_gate();
      v_allow := true;
      v_msg   := NULL;
    EXCEPTION WHEN OTHERS THEN
      v_allow := false;
      v_msg   := SQLERRM;
    END;

    -- The frontend detects the gate by message text; a reworded exception would
    -- silently turn the gated panel into a red error banner.
    IF NOT v_allow AND v_msg IS DISTINCT FROM 'Not authorized' THEN
      RAISE EXCEPTION 'Gate raised an unexpected message for %: %', r.full_name, v_msg;
    END IF;

    IF v_allow = v_expected THEN v_ok := v_ok + 1; ELSE v_bad := v_bad + 1; END IF;

    RAISE NOTICE '%   | % | % | % | % | %  | %',
      CASE WHEN v_allow = v_expected THEN 'PASS' ELSE 'FAIL' END,
      rpad(r.full_name, 18),
      rpad(r.role, 16),
      rpad(array_to_string(r.roles, ','), 12),
      CASE WHEN v_allow THEN 'ALLOW' ELSE 'DENY ' END,
      CASE WHEN v_expected THEN 'ALLOW' ELSE 'DENY ' END,
      CASE WHEN v_allow THEN 'forecast loads' ELSE 'gated panel' END;
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub', '', true);

  RAISE NOTICE '-------+--------------------+------------------+--------------+-------+--------+---------------';
  RAISE NOTICE '% profile(s) matched expectation, % mismatched', v_ok, v_bad;

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Gate verification failed on % profile(s)', v_bad;
  END IF;
END
$gate$;


-- ---------------------------------------------------------------------------
-- Verification 5 — service/editor context still short-circuits (auth.uid() NULL)
-- ---------------------------------------------------------------------------
DO $svc$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM public._rm_forecast_gate();
  RAISE NOTICE 'No-JWT (SQL editor / service_role) context still passes through — OK';
END
$svc$;


-- ---------------------------------------------------------------------------
-- Verification 6 — the same per-profile result as a RESULT SET.
-- The Supabase SQL Editor does not surface RAISE NOTICE, so this is the
-- readable pass/fail table for the PROD run. gate_allows is evaluated with
-- public.user_has_role(), which is the sole predicate the new gate applies to
-- an authenticated caller.
-- ---------------------------------------------------------------------------
SELECT p.full_name,
       p.role                                          AS primary_role,
       COALESCE(p.roles, '{}'::text[])                 AS additional_roles,
       (p.role IN ('admin','scheduler','purchaser'))   AS passed_old_gate,
       public.user_has_role(p.id, 'admin','scheduler','purchaser','compliance','machinist')
                                                       AS passes_new_gate,
       CASE
         WHEN public.user_has_role(p.id, 'admin','scheduler','purchaser','compliance','machinist')
           THEN 'forecast loads'
         ELSE 'gated panel'
       END                                             AS rm_forecast_screen
  FROM public.profiles p
 WHERE p.is_active
 ORDER BY p.role, p.full_name;

COMMIT;
