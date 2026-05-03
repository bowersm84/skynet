CREATE TABLE public.work_order_assembly_routing_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_assembly_id uuid NOT NULL REFERENCES public.work_order_assemblies(id) ON DELETE CASCADE,
  step_order integer NOT NULL,
  step_name text NOT NULL,
  step_type text DEFAULT 'internal' CHECK (step_type IN ('internal', 'external')),
  station text,
  status text DEFAULT 'pending' CHECK (status IN ('pending','in_progress','complete','skipped','removal_pending','removed')),
  -- modification tracking (mirror job_routing_steps)
  removal_requested_by uuid REFERENCES public.profiles(id),
  removal_requested_at timestamptz,
  removal_reason text,
  removal_approved_by uuid REFERENCES public.profiles(id),
  removal_approved_at timestamptz,
  is_added_step boolean DEFAULT false,
  added_by uuid REFERENCES public.profiles(id),
  added_at timestamptz,
  -- production data
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

ALTER TABLE outbound_sends
  ADD COLUMN source_type text CHECK (source_type IN ('finishing_send','work_order_assembly')),
  ADD COLUMN source_id uuid,  -- backfill from finishing_send_id
  ADD COLUMN routing_step_id uuid;  -- FK to whichever step (job_routing_steps OR work_order_assembly_routing_steps)
-- Eventually drop finishing_send_id once backfilled, or keep as a generated column for compat

-- 1. Backfill standard Assemble step for every existing assembly/FG part
INSERT INTO part_routing_steps (part_id, step_order, step_name, step_type, is_active)
SELECT id, 1, 'Assemble', 'internal', true
FROM parts
WHERE part_type IN ('assembly', 'finished_good')
  AND id NOT IN (SELECT part_id FROM part_routing_steps);

-- 2. Backfill work_order_assembly_routing_steps for in-flight WOAs
-- (status reflects WOA current state — completed for shipped WOs, pending for in-flight)

ALTER TABLE work_order_assemblies
  ADD COLUMN assembly_lot_number text,            -- ALN — manual entry from logbook
  ADD COLUMN assembly_lot_entered_by uuid REFERENCES profiles(id),
  ADD COLUMN assembly_lot_entered_at timestamptz;

-- outbound_sends.return_lot_number already exists for vendor lot capture;
-- assembly returns reuse it. Just rename the modal field copy if needed.