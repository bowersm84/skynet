-- ============================================================================
-- S17 C0 — anon hardening (D-ASM-36): no SECURITY DEFINER function in public
--           is executable by the anon role, except the one sign-in helper
-- 2026-11-05, corrected 2026-11-10
--
-- Correction (Batch C.0 grep, CC, Nov 10): Login.jsx calls
-- get_email_by_username(text) BEFORE a session exists, to turn a username into
-- its email. Revoking it broke username sign-in on TEST from Nov 5 to Nov 10;
-- the grant is restored there (migration s17_c0_allow_get_email_by_username).
-- This copy keeps that one function executable by anon. Nothing else is called
-- before sign-in: kiosks authenticate through the edge function and then hold
-- an 'authenticated' JWT.
--
-- Applied on TEST by Claude (s17_c0_anon_hardening + the correction). Safe to
-- run on PROD now; independent of any deploy.
-- ============================================================================
DO $h$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public' AND p.prosecdef
      AND pg_get_function_result(p.oid) <> 'trigger'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
      AND p.proname NOT IN ('get_email_by_username')          -- pre-sign-in allowlist
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'anon EXECUTE revoked on % SECURITY DEFINER function(s)', n;
END
$h$;
GRANT EXECUTE ON FUNCTION public.get_email_by_username(text) TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;

-- Verify: expect exactly one row, get_email_by_username(text).
select p.oid::regprocedure as still_anon_executable
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef and pg_get_function_result(p.oid) <> 'trigger'
  and has_function_privilege('anon', p.oid, 'EXECUTE');
