-- ============================================================================
-- S17 C0b — the public anon key can no longer read profiles (or PINs)
-- 2026-11-10  ·  D-ASM-41
--
-- Finding (CC, Batch C.0): profiles carries a policy "anon_pin_lookup" —
-- anon SELECT USING (true) — so the public key shipped in the web app can read
-- every profile row including pin_code. It exists only for Finishing's PIN
-- sign-in, which looks the PIN up from the browser before a session exists.
-- Same on TEST and PROD (PROD: 18 active profiles, 7 with a PIN).
--
-- ORDER MATTERS: run this only AFTER the build that moves Finishing's PIN
-- sign-in to the kiosk-authenticate edge function is live in that environment;
-- before that, this would break Finishing sign-in.
--   TEST: Claude applies it once CC's Finishing change is in the dev build.
--   PROD: after the Batch C deploy is up and Finishing sign-in is confirmed.
-- ============================================================================
DROP POLICY IF EXISTS anon_pin_lookup ON public.profiles;
REVOKE ALL ON public.profiles FROM anon;

-- Verify: expect false, false, and no policy naming anon.
select has_table_privilege('anon', 'public.profiles', 'SELECT')              as anon_reads_profiles,
       has_column_privilege('anon', 'public.profiles', 'pin_code', 'SELECT') as anon_reads_pins,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'profiles' and 'anon' = any(roles)) as anon_policies;
