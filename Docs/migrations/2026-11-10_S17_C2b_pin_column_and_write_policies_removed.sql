-- ============================================================================
-- S17 C2b — retire profiles.pin_code and the open write policies on profiles
-- 2026-11-10  ·  D-ASM-43, D-ASM-45
--
-- RUN ONLY AFTER the Batch C build is live in that environment and confirmed:
-- every reader and writer of pin_code has moved to the vault functions, and
-- kiosk-authenticate / manage-users are deployed in their vault versions.
-- Before that, this breaks kiosk sign-in and PIN set-up.
--   TEST: Claude applies it once Claude Code confirms no code path reads or
--         writes profiles.pin_code and the edge functions are deployed.
--   PROD: after the Batch C deploy, together with C0b
--         (2026-11-10_S17_C0b_profiles_anon_read_removed.sql).
--
-- What it does:
--   1. handle_new_user no longer mentions pin_code (it would otherwise fail
--      silently on every new account once the column is gone).
--   2. The transitional sync trigger and its function go.
--   3. profiles.pin_code and its unique index go — plain-text PINs no longer
--      exist anywhere.
--   4. The three policies that let ANY signed-in user insert, update or delete
--      ANY profile go. The browser never writes profiles directly any more:
--      PINs go through profile_pin_set, avatars through profile_set_avatar,
--      the password flag through clear_my_must_change_password, and everything
--      else through the manage-users edge function (service role, admin only).
-- ============================================================================

-- 0. Stop if anything still depends on the column (a view, a function, a policy).
DO $chk$
DECLARE n integer; d text;
BEGIN
  SELECT COUNT(*), string_agg(DISTINCT c.relname, ', ')
    INTO n, d
  FROM pg_depend dep
  JOIN pg_rewrite rw ON rw.oid = dep.objid
  JOIN pg_class c ON c.oid = rw.ev_class
  JOIN pg_attribute a ON a.attrelid = dep.refobjid AND a.attnum = dep.refobjsubid
  WHERE dep.refobjid = 'public.profiles'::regclass AND a.attname = 'pin_code' AND c.relname <> 'profiles';
  IF n > 0 THEN RAISE EXCEPTION 'profiles.pin_code is still used by view(s): % — fix them first', d; END IF;

  SELECT COUNT(*), string_agg(p.proname, ', ') INTO n, d
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public' AND p.prosrc ILIKE '%pin_code%'
    AND p.proname NOT IN ('handle_new_user', '_profiles_pin_code_sync_trg');
  IF n > 0 THEN RAISE EXCEPTION 'function(s) still mention pin_code: % — fix them first', d; END IF;
END
$chk$;

-- 1. New-account trigger without the column — and, as of C5, without trusting sign-up data.
--    (Same behaviour as C5, so the order in which C2b and C5 run does not matter.)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  INSERT INTO public.profiles (
    id, email, full_name, role, home_location_id,
    can_float, is_active, can_approve_compliance
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    'viewer',     -- C5 / D-ASM-51: nothing that grants access comes from the new user's own sign-up data;
    NULL,         -- every new account starts as an inactive viewer and manage-users sets the rest.
    false,
    false,
    false
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'handle_new_user error: %', SQLERRM;
  RETURN NEW;
END;
$function$;

-- 2. Transitional sync.
DROP TRIGGER IF EXISTS profiles_pin_code_sync ON public.profiles;
DROP FUNCTION IF EXISTS public._profiles_pin_code_sync_trg();

-- 3. The plain-text column.
DROP INDEX IF EXISTS public.uniq_profiles_pin_code_not_null;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS pin_code;

-- 4. Open write policies.
DROP POLICY IF EXISTS profiles_update_authenticated ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_authenticated ON public.profiles;
DROP POLICY IF EXISTS profiles_delete_authenticated ON public.profiles;
REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM authenticated;

-- Verify
select (select count(*) from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='pin_code') as pin_code_columns,   -- 0
       (select count(*) from profile_pins) as vault_pins,
       (select count(*) from profiles where has_pin) as has_pin_flags,                                                                                              -- equal to vault_pins
       (select string_agg(policyname || ' [' || array_to_string(roles, '/') || ' ' || cmd || ']', ' · ') from pg_policies where schemaname='public' and tablename='profiles') as profiles_policies;   -- only the authenticated read
