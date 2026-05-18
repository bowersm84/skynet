-- Add is_commissioned to machines: distinguishes "physical machine in service"
-- from is_active (soft-delete) and status (operational state).
-- A machine can be commissioned and currently down (broken), or not yet
-- commissioned (on order awaiting arrival).

ALTER TABLE public.machines
  ADD COLUMN IF NOT EXISTS is_commissioned BOOLEAN NOT NULL DEFAULT true;

-- Mark BM-6 as not yet commissioned (on order)
UPDATE public.machines
SET is_commissioned = false
WHERE code = 'BM-6';

-- Verify
SELECT code, name, status, is_active, is_commissioned
FROM public.machines
WHERE is_commissioned = false;
