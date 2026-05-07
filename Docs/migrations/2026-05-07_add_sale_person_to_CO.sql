-- 1. is_salesperson flag on profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_salesperson boolean NOT NULL DEFAULT false;

-- Partial index for the dropdown query
CREATE INDEX IF NOT EXISTS idx_profiles_active_salespeople
  ON public.profiles(full_name)
  WHERE is_salesperson = true AND is_active = true;

-- 2. salesperson_id on customer_orders (nullable for backward
-- compatibility — existing COs stay null until edited).
ALTER TABLE public.customer_orders
  ADD COLUMN IF NOT EXISTS salesperson_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customer_orders_salesperson
  ON public.customer_orders(salesperson_id);

-- 3. Mark known salespeople. Only matches users that already exist;
-- silently skips Sawyer and Peyton until their accounts are created.
UPDATE public.profiles
SET is_salesperson = true
WHERE lower(full_name) IN (
  'april braun',
  'christy exum',
  'sawyer griner',
  'peyton marshall'
);

-- Verification
SELECT full_name, username, role, is_active, is_salesperson
FROM public.profiles
WHERE is_salesperson = true
ORDER BY full_name;