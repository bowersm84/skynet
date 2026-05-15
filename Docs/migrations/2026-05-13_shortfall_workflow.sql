-- 1. Shortfall resolution table
CREATE TABLE IF NOT EXISTS public.wo_shortfall_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES public.work_orders(id) ON DELETE CASCADE,
  shortfall_type text NOT NULL CHECK (shortfall_type IN ('demand', 'plan_only')),
  target_quantity integer NOT NULL,
  produced_quantity integer NOT NULL,
  shortfall_quantity integer NOT NULL,
  resolution text CHECK (resolution IS NULL OR resolution IN
    ('accept_short', 'requeue', 'cancel_shortfall', 'acknowledge_plan')),
  resolution_notes text,
  resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  requeue_job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wo_shortfall_resolutions_wo
  ON public.wo_shortfall_resolutions(work_order_id);
CREATE INDEX IF NOT EXISTS idx_wo_shortfall_resolutions_open
  ON public.wo_shortfall_resolutions(work_order_id)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_wo_shortfall_resolutions_resolved_at
  ON public.wo_shortfall_resolutions(resolved_at DESC);

-- 2. Marker on work_orders
ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS has_open_shortfall boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_work_orders_open_shortfall
  ON public.work_orders(has_open_shortfall)
  WHERE has_open_shortfall = true;

-- 3. RLS policies for new table
ALTER TABLE public.wo_shortfall_resolutions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wo_shortfall_resolutions_select" ON public.wo_shortfall_resolutions
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "wo_shortfall_resolutions_insert" ON public.wo_shortfall_resolutions
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "wo_shortfall_resolutions_update" ON public.wo_shortfall_resolutions
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "wo_shortfall_resolutions_delete" ON public.wo_shortfall_resolutions
  FOR DELETE TO authenticated USING (true);

-- 4. Verification
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='wo_shortfall_resolutions'
ORDER BY ordinal_position;

SELECT policyname, cmd FROM pg_policies
WHERE schemaname='public' AND tablename='wo_shortfall_resolutions'
ORDER BY cmd;