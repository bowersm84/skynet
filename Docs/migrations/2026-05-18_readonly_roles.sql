-- Add 'president' and 'viewer' to profiles.role check constraint
-- 'president' = Ned Bowers, Apollo Bridge dashboard + read-only main shell
-- 'viewer'    = generic leadership read-only; main shell only, no Bridge

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role::text = ANY (ARRAY[
    'admin'::character varying::text,
    'compliance'::character varying::text,
    'machinist'::character varying::text,
    'assembly'::character varying::text,
    'display'::character varying::text,
    'scheduler'::character varying::text,
    'customer_service'::character varying::text,
    'finishing'::character varying::text,
    'president'::character varying::text,
    'viewer'::character varying::text
  ]));

-- Verify
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname = 'profiles_role_check';
