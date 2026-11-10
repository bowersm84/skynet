-- ============================================================================
-- S17 C5 — two auth hardenings (CC's phase-7 findings)
-- 2026-11-10  ·  D-ASM-51
--
-- 1. A new account never takes anything that grants access from its own
--    sign-up data. handle_new_user used to copy `role` and
--    `can_approve_compliance` from the new user's metadata, which the person
--    signing up supplies. If sign-ups are open in the auth settings, anyone
--    with the site's public key and an email address could create themselves
--    as admin. Every new account now starts as an INACTIVE VIEWER; the admin
--    flows in manage-users set the role, the flags and is_active explicitly
--    right after creating the account.
--    THE REAL DOOR IS THE AUTH SETTING: "Allow new users to sign up" must be
--    OFF in the dashboard. This is the second lock, not the first.
--
-- 2. A tablet-only account's password, email and phone cannot be changed
--    through the auth service. A kiosk token is accepted by PUT /auth/v1/user;
--    changing the password or email there would turn a PIN into an ordinary
--    office sign-in and step around the tablet-only database role (C4). To
--    convert an account, an admin clears kiosk_only first.
--
-- Applied on TEST by Claude on 2026-11-10 (migration s17_c5_auth_hardening)
-- and exercised there in rolled-back probes:
--   · an account created with sign-up data claiming role admin and compliance
--     approval got a profile as an inactive viewer with neither;
--   · a password change and an email change on a tablet-only account were
--     refused; an ordinary update on that account and a password change on an
--     office account went through.
--
-- PROD ORDER: AFTER the Batch C deploy. Part 1 needs the new manage-users
-- (its email-invite path sets is_active = true); run earlier, newly invited
-- people would stay inactive until an admin activated them in the Users tab.
-- Run it with C0b and C2b: C0b → C2b → C5.
-- ============================================================================

-- 1. New accounts start as inactive viewers.
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
    'viewer',
    NULL,
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

-- 2. Tablet-only accounts: no password, email or phone change.
CREATE OR REPLACE FUNCTION public._auth_users_kiosk_only_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = NEW.id AND kiosk_only) THEN
    RAISE EXCEPTION 'This account works on the assembly tablet only: its password and email cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS auth_users_kiosk_only_guard ON auth.users;
CREATE TRIGGER auth_users_kiosk_only_guard
  BEFORE UPDATE ON auth.users
  FOR EACH ROW
  WHEN (OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password
        OR OLD.email        IS DISTINCT FROM NEW.email
        OR OLD.email_change IS DISTINCT FROM NEW.email_change
        OR OLD.phone        IS DISTINCT FROM NEW.phone
        OR OLD.phone_change IS DISTINCT FROM NEW.phone_change)
  EXECUTE FUNCTION public._auth_users_kiosk_only_guard();

-- Verify: expect two triggers on auth.users, and handle_new_user without the word "role" read from metadata.
select (select string_agg(t.tgname, ', ' order by t.tgname) from pg_trigger t where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal) as triggers_on_auth_users,
       (select position('raw_user_meta_data->>''role''' in p.prosrc) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'handle_new_user') as role_no_longer_taken_from_signup_data;
