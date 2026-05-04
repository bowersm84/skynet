-- ============================================================
-- S6 PROD Migration — Post-Assembly Outsourcing
-- Idempotent. Safe to re-run.
-- File: Docs/migrations/2026-05-04_sprint6_assembly_routing_PROD.sql
-- ============================================================

BEGIN;

-- 1. work_order_assembly_routing_steps table
CREATE TABLE IF NOT EXISTS public.work_order_assembly_routing_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_assembly_id uuid NOT NULL REFERENCES public.work_order_assemblies(id) ON DELETE CASCADE,
  step_order integer NOT NULL,
  step_name text NOT NULL,
  step_type text DEFAULT 'internal' CHECK (step_type IN ('internal', 'external')),
  station text,
  status text DEFAULT 'pending' CHECK (status IN ('pending','in_progress','complete','skipped','removal_pending','removed')),
  removal_requested_by uuid REFERENCES public.profiles(id),
  removal_requested_at timestamptz,
  removal_reason text,
  removal_approved_by uuid REFERENCES public.profiles(id),
  removal_approved_at timestamptz,
  is_added_step boolean DEFAULT false,
  added_by uuid REFERENCES public.profiles(id),
  added_at timestamptz,
  lot_number text,
  quantity integer,
  started_at timestamptz,
  completed_at timestamptz,
  completed_by uuid REFERENCES public.profiles(id),
  operator_initials text,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(work_order_assembly_id, step_order)
);

-- 2. work_order_assemblies ALN columns
ALTER TABLE public.work_order_assemblies
  ADD COLUMN IF NOT EXISTS assembly_lot_number text,
  ADD COLUMN IF NOT EXISTS assembly_lot_entered_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS assembly_lot_entered_at timestamptz;

-- 3. work_order_assemblies.status enum extension
ALTER TABLE public.work_order_assemblies
  DROP CONSTRAINT IF EXISTS work_order_assemblies_status_check;

ALTER TABLE public.work_order_assemblies
  ADD CONSTRAINT work_order_assemblies_status_check
  CHECK (status::text = ANY (ARRAY[
    'pending'::text,
    'in_progress'::text,
    'paused'::text,
    'ready_for_outsource'::text,
    'at_external_vendor'::text,
    'pending_tco'::text,
    'complete'::text
  ]));

-- 4. outbound_sends polymorphic columns
ALTER TABLE public.outbound_sends
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS source_id uuid,
  ADD COLUMN IF NOT EXISTS routing_step_id uuid;

ALTER TABLE public.outbound_sends
  DROP CONSTRAINT IF EXISTS outbound_sends_source_type_check;

ALTER TABLE public.outbound_sends
  ADD CONSTRAINT outbound_sends_source_type_check
  CHECK (source_type IS NULL OR source_type IN ('finishing_send','work_order_assembly'));

-- 5. routing_templates.template_type column
ALTER TABLE public.routing_templates
  ADD COLUMN IF NOT EXISTS template_type text;

UPDATE public.routing_templates
  SET template_type = 'component'
  WHERE template_type IS NULL;

ALTER TABLE public.routing_templates
  ALTER COLUMN template_type SET DEFAULT 'component';

ALTER TABLE public.routing_templates
  ALTER COLUMN template_type SET NOT NULL;

ALTER TABLE public.routing_templates
  DROP CONSTRAINT IF EXISTS routing_templates_template_type_check;

ALTER TABLE public.routing_templates
  ADD CONSTRAINT routing_templates_template_type_check
  CHECK (template_type IN ('component', 'assembly'));

-- 6. Seed assembly templates
INSERT INTO public.routing_templates (name, template_type, material_category, description, is_active)
VALUES
  ('Standard Assembly',     'assembly', NULL, 'Default assembly route. Assemble only, no external operations.', true),
  ('Painted Assembly',      'assembly', NULL, 'Assemble in-house, then send out for paint.', true),
  ('Heat-Treated Assembly', 'assembly', NULL, 'Assemble in-house, then send out for heat treatment.', true)
ON CONFLICT (name) DO NOTHING;

-- 7. Seed steps for assembly templates
INSERT INTO public.routing_template_steps (template_id, step_order, step_name, step_type)
SELECT t.id, 1, 'Assemble', 'internal'
FROM public.routing_templates t
WHERE t.name = 'Standard Assembly'
  AND NOT EXISTS (SELECT 1 FROM public.routing_template_steps s WHERE s.template_id = t.id);

INSERT INTO public.routing_template_steps (template_id, step_order, step_name, step_type)
SELECT t.id, v.step_order, v.step_name, v.step_type
FROM public.routing_templates t
CROSS JOIN (VALUES (1,'Assemble','internal'),(2,'Paint','external')) AS v(step_order, step_name, step_type)
WHERE t.name = 'Painted Assembly'
  AND NOT EXISTS (SELECT 1 FROM public.routing_template_steps s WHERE s.template_id = t.id);

INSERT INTO public.routing_template_steps (template_id, step_order, step_name, step_type)
SELECT t.id, v.step_order, v.step_name, v.step_type
FROM public.routing_templates t
CROSS JOIN (VALUES (1,'Assemble','internal'),(2,'Heat Treatment','external')) AS v(step_order, step_name, step_type)
WHERE t.name = 'Heat-Treated Assembly'
  AND NOT EXISTS (SELECT 1 FROM public.routing_template_steps s WHERE s.template_id = t.id);

-- 8. Backfill: standard 'Assemble' step on every active assembly/FG part
INSERT INTO public.part_routing_steps (part_id, step_order, step_name, step_type, is_active)
SELECT p.id, 1, 'Assemble', 'internal', true
FROM public.parts p
WHERE p.part_type IN ('assembly', 'finished_good')
  AND p.is_active = true
  AND NOT EXISTS (SELECT 1 FROM public.part_routing_steps prs WHERE prs.part_id = p.id);

-- 9. Backfill: routing steps for in-flight WOAs
INSERT INTO public.work_order_assembly_routing_steps
  (work_order_assembly_id, step_order, step_name, step_type, status)
SELECT
  woa.id,
  1,
  'Assemble',
  'internal',
  CASE
    WHEN woa.assembly_completed_at IS NOT NULL THEN 'complete'
    WHEN woa.assembly_started_at IS NOT NULL  THEN 'in_progress'
    ELSE 'pending'
  END
FROM public.work_order_assemblies woa
WHERE NOT EXISTS (
  SELECT 1 FROM public.work_order_assembly_routing_steps s
  WHERE s.work_order_assembly_id = woa.id
);

-- 10. Backfill: legacy outbound_sends → polymorphic columns
UPDATE public.outbound_sends
SET source_type = 'finishing_send',
    source_id   = finishing_send_id,
    routing_step_id = COALESCE(routing_step_id, job_routing_step_id)
WHERE finishing_send_id IS NOT NULL
  AND source_type IS NULL;

-- 11. Indexes
CREATE INDEX IF NOT EXISTS idx_woa_routing_steps_woa_id
  ON public.work_order_assembly_routing_steps(work_order_assembly_id);

CREATE INDEX IF NOT EXISTS idx_outbound_sends_source
  ON public.outbound_sends(source_type, source_id)
  WHERE source_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_routing_templates_type
  ON public.routing_templates(template_type)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_part_routing_steps_part_id
  ON public.part_routing_steps(part_id)
  WHERE is_active = true;

-- 12. RLS on work_order_assembly_routing_steps
ALTER TABLE public.work_order_assembly_routing_steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "WOA routing steps select" ON public.work_order_assembly_routing_steps;
CREATE POLICY "WOA routing steps select"
  ON public.work_order_assembly_routing_steps
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "WOA routing steps insert" ON public.work_order_assembly_routing_steps;
CREATE POLICY "WOA routing steps insert"
  ON public.work_order_assembly_routing_steps
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "WOA routing steps update" ON public.work_order_assembly_routing_steps;
CREATE POLICY "WOA routing steps update"
  ON public.work_order_assembly_routing_steps
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "WOA routing steps delete" ON public.work_order_assembly_routing_steps;
CREATE POLICY "WOA routing steps delete"
  ON public.work_order_assembly_routing_steps
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

COMMIT;