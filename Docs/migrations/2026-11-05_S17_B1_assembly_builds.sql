-- ============================================================================
-- S17 Batch B1 — assembly builds: data model, requests, lot sequence,
--                 checklist templates seeded from Fishbowl BOM instructions,
--                 settings, benches, WOA mirror, RPCs
-- 2026-11-05  ·  D-ASM-02, -04, -07, -15, -16, -17, -20, -24 (settings part)
--
-- Applied on TEST by Claude on 2026-11-04 (migrations s17_b1_assembly_builds,
-- s17_b1_seed_coarse_families, s17_b1_request_sync_so_number_fix); this file
-- is the consolidated PROD copy, run before the Batch B deploy. Idempotent.
-- TEST result: 28 draft families from 233 BOMs, 232 parts mapped, 3 open
-- requests from the three lines already dispositioned 'assembly'; the build,
-- lot (80000 reuse / 80001 / 8151R), assign, release and cancel RPCs verified.
--
-- Shape (D-ASM-20): assembly_builds is the floor object. A build may link to
-- an existing work_order_assembly (WO-driven) or stand alone (stock, special,
-- rework, program). Requests come from Order Queue lines whose disposition is
-- 'assembly' (any source). Sessions, component lots, sign-offs, lot number,
-- cost snapshot and Fishbowl post status hang off the build. No work order
-- without jobs is ever created.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Settings and benches
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_settings (
  key          text PRIMARY KEY,
  value        jsonb NOT NULL,
  description  text,
  updated_by   uuid REFERENCES public.profiles(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_settings_read ON public.app_settings;
CREATE POLICY app_settings_read ON public.app_settings FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.app_settings TO authenticated;
REVOKE ALL ON public.app_settings FROM anon;

INSERT INTO public.app_settings (key, value, description) VALUES
  ('assembly_labor_rate',          '22.69'::jsonb, 'Loaded assembly labor rate, $/hour (costing spec v0.4, D-COST-25)'),
  ('mfg_support_overhead_pct',     '20'::jsonb,    'Manufacturing-support overhead, % of conversion (D-COST-21)'),
  ('assembly_lot_prefix_display',  '"ALN-"'::jsonb, 'Display-only prefix for assembly lot numbers; the lot written to Fishbowl is the bare number (D-ASM-02)'),
  ('assembly_lot_new_set_second_pin', 'true'::jsonb, 'Require a second PIN on the lot pull when the component-lot combination is new (D-ASM-07/08)')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.app_setting_set(p_key text, p_value jsonb, p_description text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._fb_gate(ARRAY['admin']);
  INSERT INTO public.app_settings (key, value, description, updated_by, updated_at)
  VALUES (p_key, p_value, p_description, auth.uid(), now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
    description = COALESCE(EXCLUDED.description, public.app_settings.description),
    updated_by = EXCLUDED.updated_by, updated_at = now();
END $$;
REVOKE ALL ON FUNCTION public.app_setting_set(text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_setting_set(text, jsonb, text) TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.assembly_benches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true
);
ALTER TABLE public.assembly_benches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assembly_benches_read ON public.assembly_benches;
CREATE POLICY assembly_benches_read ON public.assembly_benches FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.assembly_benches TO authenticated;
REVOKE ALL ON public.assembly_benches FROM anon;
INSERT INTO public.assembly_benches (name, sort_order)
SELECT 'Bench ' || g, g FROM generate_series(1, 6) g
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. Checklist templates (configuration, D-ASM-07) and the part → family map
-- ---------------------------------------------------------------------------
ALTER TABLE public.parts ADD COLUMN IF NOT EXISTS assembly_family text;
CREATE INDEX IF NOT EXISTS parts_assembly_family_idx ON public.parts (assembly_family) WHERE assembly_family IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.assembly_checklist_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_key    text NOT NULL,
  wave          integer NOT NULL DEFAULT 1 CHECK (wave IN (1, 2)),
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  source        text NOT NULL DEFAULT 'seed' CHECK (source IN ('seed', 'manual')),
  seed_note     text,
  approved_by   uuid REFERENCES public.profiles(id),
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_key, wave)
);

CREATE TABLE IF NOT EXISTS public.assembly_checklist_steps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       uuid NOT NULL REFERENCES public.assembly_checklist_templates(id) ON DELETE CASCADE,
  step_order        integer NOT NULL,
  step_type         text NOT NULL CHECK (step_type IN ('pull', 'pull_check', 'assemble', 'pressure_test', 'crimp_check',
                                                       'gauge_check', 'tensile_shear', 'inspect', 'release', 'instruction')),
  label             text NOT NULL,
  pins_required     integer NOT NULL DEFAULT 0 CHECK (pins_required BETWEEN 0 AND 2),
  distinct_from     text CHECK (distinct_from IS NULL OR distinct_from IN ('assembler', 'puller', 'crimper')),
  readings_count    integer NOT NULL DEFAULT 0,
  reading_unit      text,
  threshold_min     numeric,
  sample_qty        integer,
  instruction_text  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, step_order)
);

ALTER TABLE public.assembly_checklist_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembly_checklist_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assembly_checklist_templates_read ON public.assembly_checklist_templates;
DROP POLICY IF EXISTS assembly_checklist_steps_read ON public.assembly_checklist_steps;
CREATE POLICY assembly_checklist_templates_read ON public.assembly_checklist_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY assembly_checklist_steps_read ON public.assembly_checklist_steps FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.assembly_checklist_templates, public.assembly_checklist_steps TO authenticated;
REVOKE ALL ON public.assembly_checklist_templates, public.assembly_checklist_steps FROM anon;

-- Normalization of one Fishbowl instruction line (name + details) to a step type.
-- Mirrors plan §9.2a; the 120-spelling vocabulary of Nov 3 was the test set.
CREATE OR REPLACE FUNCTION public.assembly_instruction_step_type(p_name text, p_details text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN n ~ '^\s*(1ST|2ND|1 ST|2 ND|1|2)\s*$'                 THEN NULL            -- bare ordinal rows, dropped
    WHEN n ~ 'START|^STEP|DATE'                              THEN NULL            -- derived, dropped
    WHEN n ~ 'SUPERVISOR'                                    THEN 'release'
    WHEN n ~ 'PRESSURE|STRESS'                               THEN 'pressure_test'
    WHEN n ~ 'TENSILE|SHEAR'                                 THEN 'tensile_shear'
    WHEN n ~ '25 PIECES|BOLT'                                THEN 'gauge_check'
    WHEN n ~ 'CRIMP'                                         THEN 'crimp_check'
    WHEN n ~ 'INSPECT'                                       THEN 'inspect'
    WHEN n ~ 'CHECK'                                         THEN 'pull_check'
    WHEN n ~ 'PULL'                                          THEN 'pull'
    WHEN n ~ 'ASSEMBL|WING|PINNED|ASSEBLED|ASSEMBED'         THEN 'assemble'
    ELSE 'instruction'
  END
  FROM (SELECT upper(coalesce(p_name, '') || ' ' || coalesce(p_details, '')) AS n) s;
$$;

-- Seed: one draft template per distinct SET of step types (canonical order,
-- pins per type = max seen) across active Fishbowl BOMs whose finished good
-- is a SkyNet assembly part; parts get assembly_family = that set key.
-- TEST, Nov 4: 233 BOMs → 28 families, the top seven covering 199.
-- Roger renames / merges / approves.
CREATE OR REPLACE FUNCTION public.assembly_seed_checklists_from_fishbowl()
RETURNS TABLE (families_created integer, parts_mapped integer, boms_considered integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fam integer := 0; v_parts integer := 0; v_boms integer := 0;
  r record; t_id uuid;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin']);

  CREATE TEMP TABLE IF NOT EXISTS _bomsteps (fb_bom_id integer, bom_num text, step_type text, pins integer, rank integer) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _sig (fb_bom_id integer, bom_num text, sig text) ON COMMIT DROP;
  DELETE FROM _bomsteps; DELETE FROM _sig;

  INSERT INTO _bomsteps (fb_bom_id, bom_num, step_type, pins, rank)
  SELECT b.fb_bom_id, b.bom_num, x.step_type, x.pins,
         CASE x.step_type WHEN 'pull' THEN 1 WHEN 'pull_check' THEN 2 WHEN 'assemble' THEN 3 WHEN 'pressure_test' THEN 4
                          WHEN 'crimp_check' THEN 5 WHEN 'gauge_check' THEN 6 WHEN 'tensile_shear' THEN 7
                          WHEN 'inspect' THEN 8 WHEN 'release' THEN 9 ELSE 10 END
  FROM public.fb_boms b
  JOIN (
    SELECT i.fb_bom_id,
           public.assembly_instruction_step_type(i.name, i.details) AS step_type,
           CASE WHEN BOOL_OR(upper(coalesce(i.name,'') || ' ' || coalesce(i.details,'')) ~ '2ND|2 ND|SECOND|2$|CHECKED BY 1')
                     OR BOOL_OR(coalesce(btrim(i.details), '') <> '') THEN 2 ELSE 1 END AS pins
    FROM public.fb_bom_instructions i
    GROUP BY i.fb_bom_id, public.assembly_instruction_step_type(i.name, i.details)
  ) x ON x.fb_bom_id = b.fb_bom_id AND x.step_type IS NOT NULL AND x.step_type <> 'instruction'
  WHERE b.active AND b.removed_at IS NULL
    AND EXISTS (SELECT 1 FROM public.parts p WHERE p.part_number = b.bom_num AND p.part_type = 'assembly');

  INSERT INTO _sig (fb_bom_id, bom_num, sig)
  SELECT fb_bom_id, bom_num, string_agg(step_type, '>' ORDER BY rank) FROM _bomsteps GROUP BY fb_bom_id, bom_num;
  GET DIAGNOSTICS v_boms = ROW_COUNT;

  FOR r IN SELECT sig, COUNT(*) AS n, MIN(bom_num) AS example FROM _sig GROUP BY sig LOOP
    SELECT id INTO t_id FROM public.assembly_checklist_templates WHERE family_key = r.sig AND wave = 1;
    IF t_id IS NULL THEN
      INSERT INTO public.assembly_checklist_templates (family_key, wave, name, status, source, seed_note)
      VALUES (r.sig, 1, 'Seed family: ' || replace(r.sig, '>', ' → ') || ' (e.g. ' || r.example || ')', 'draft', 'seed',
              'Seeded from Fishbowl BOM instructions, ' || now()::date || '; ' || r.n || ' BOM(s) share this step set')
      RETURNING id INTO t_id;
      v_fam := v_fam + 1;

      INSERT INTO public.assembly_checklist_steps
        (template_id, step_order, step_type, label, pins_required, distinct_from, readings_count, reading_unit, threshold_min, sample_qty)
      SELECT t_id, row_number() OVER (ORDER BY s.rank), s.step_type,
             CASE s.step_type
               WHEN 'pull' THEN 'Pull components' WHEN 'pull_check' THEN 'Component check'
               WHEN 'assemble' THEN 'Assemble' WHEN 'pressure_test' THEN 'Pressure test'
               WHEN 'crimp_check' THEN '10-piece crimp check' WHEN 'gauge_check' THEN '25-piece gauge check with bolt'
               WHEN 'tensile_shear' THEN 'Tensile-shear test' WHEN 'inspect' THEN 'Final inspection'
               WHEN 'release' THEN 'Supervisor release' ELSE 'Instruction' END,
             CASE s.step_type
               WHEN 'pull' THEN 0 WHEN 'assemble' THEN 0 WHEN 'release' THEN 0
               WHEN 'pressure_test' THEN 2 WHEN 'crimp_check' THEN 2 WHEN 'gauge_check' THEN 2
               WHEN 'tensile_shear' THEN 2
               ELSE LEAST(2, GREATEST(1, s.max_pins)) END,
             CASE s.step_type WHEN 'pull_check' THEN 'puller' WHEN 'crimp_check' THEN 'crimper' WHEN 'inspect' THEN 'assembler' ELSE NULL END,
             CASE s.step_type WHEN 'pressure_test' THEN 2 WHEN 'tensile_shear' THEN 5 ELSE 0 END,
             CASE s.step_type WHEN 'pressure_test' THEN 'lb' WHEN 'tensile_shear' THEN 'lb-f' ELSE NULL END,
             CASE s.step_type WHEN 'tensile_shear' THEN 1050 ELSE NULL END,
             CASE s.step_type WHEN 'crimp_check' THEN 10 WHEN 'gauge_check' THEN 25 WHEN 'tensile_shear' THEN 5 ELSE NULL END
      FROM (SELECT bs.step_type, MIN(bs.rank) AS rank, MAX(bs.pins) AS max_pins
            FROM _bomsteps bs JOIN _sig sg ON sg.fb_bom_id = bs.fb_bom_id
            WHERE sg.sig = r.sig GROUP BY bs.step_type) s;
    END IF;
  END LOOP;

  UPDATE public.parts p SET assembly_family = s.sig
  FROM _sig s
  WHERE p.part_number = s.bom_num AND p.part_type = 'assembly' AND p.assembly_family IS DISTINCT FROM s.sig;
  GET DIAGNOSTICS v_parts = ROW_COUNT;

  RETURN QUERY SELECT v_fam, v_parts, v_boms;
END $$;
REVOKE ALL ON FUNCTION public.assembly_seed_checklists_from_fishbowl() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assembly_seed_checklists_from_fishbowl() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Lot sequence and reuse index (D-ASM-02)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.assembly_lot_sequence (
  id            integer PRIMARY KEY CHECK (id = 1),
  next_number   bigint NOT NULL
);
INSERT INTO public.assembly_lot_sequence (id, next_number) VALUES (1, 80000) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.assembly_lot_index (
  lot_set_hash          text PRIMARY KEY,
  assembly_part_number  text NOT NULL,
  lot_set               text NOT NULL,
  assembly_lot_number   text NOT NULL,
  first_build_id        uuid,
  created_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.assembly_lot_sequence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembly_lot_index ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assembly_lot_sequence_read ON public.assembly_lot_sequence;
CREATE POLICY assembly_lot_sequence_read ON public.assembly_lot_sequence FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS assembly_lot_index_read ON public.assembly_lot_index;
CREATE POLICY assembly_lot_index_read ON public.assembly_lot_index FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.assembly_lot_sequence, public.assembly_lot_index TO authenticated;
REVOKE ALL ON public.assembly_lot_sequence, public.assembly_lot_index FROM anon;

-- ---------------------------------------------------------------------------
-- 3. Builds and satellites (D-ASM-20)
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.assembly_build_number_seq START 1;

CREATE TABLE IF NOT EXISTS public.assembly_builds (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_number              text NOT NULL UNIQUE DEFAULT ('AB-' || lpad(nextval('public.assembly_build_number_seq')::text, 5, '0')),
  part_id                   uuid REFERENCES public.parts(id),
  part_number               text NOT NULL,
  quantity                  integer NOT NULL CHECK (quantity > 0),
  build_kind                text NOT NULL CHECK (build_kind IN ('order', 'stock', 'special', 'rework', 'program')),
  status                    text NOT NULL DEFAULT 'requested'
                            CHECK (status IN ('requested', 'assigned', 'in_progress', 'paused', 'complete',
                                              'ready_for_outsource', 'at_external_vendor', 'pending_tco',
                                              'released', 'cancelled')),
  priority                  text NOT NULL DEFAULT 'normal' CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  wave_count                integer NOT NULL DEFAULT 1 CHECK (wave_count IN (1, 2)),
  wave_current              integer NOT NULL DEFAULT 1 CHECK (wave_current IN (1, 2)),
  work_order_assembly_id    uuid REFERENCES public.work_order_assemblies(id),
  program_id                uuid,
  program_final_lot_id      uuid,
  checklist_template_id     uuid REFERENCES public.assembly_checklist_templates(id),
  assembly_lot_number       text,
  rework_source_lot         text,
  fb_mo_id                  integer,
  fb_mo_num                 text,
  fb_post_status            text NOT NULL DEFAULT 'not_posted'
                            CHECK (fb_post_status IN ('not_posted', 'ready_to_post', 'posted', 'verified', 'mismatch', 'not_applicable')),
  bench_id                  uuid REFERENCES public.assembly_benches(id),
  assigned_to               uuid REFERENCES public.profiles(id),
  assigned_at               timestamptz,
  good_quantity             integer,
  bad_quantity              integer,
  started_at                timestamptz,
  completed_at              timestamptz,
  released_by               uuid REFERENCES public.profiles(id),
  released_at               timestamptz,
  cancelled_by              uuid REFERENCES public.profiles(id),
  cancelled_at              timestamptz,
  cancel_reason             text,
  note                      text,
  created_by                uuid REFERENCES public.profiles(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assembly_builds_rework_lot CHECK (build_kind <> 'rework' OR rework_source_lot IS NOT NULL),
  CONSTRAINT assembly_builds_woa_once UNIQUE (work_order_assembly_id)
);
CREATE INDEX IF NOT EXISTS assembly_builds_status_idx ON public.assembly_builds (status);
CREATE INDEX IF NOT EXISTS assembly_builds_part_idx   ON public.assembly_builds (part_number);
CREATE INDEX IF NOT EXISTS assembly_builds_bench_idx  ON public.assembly_builds (bench_id) WHERE status IN ('assigned', 'in_progress', 'paused');

CREATE TABLE IF NOT EXISTS public.assembly_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fb_soitem_id    integer NOT NULL UNIQUE,
  fb_so_id        integer,
  so_number       text,
  line_number     integer,
  part_id         uuid REFERENCES public.parts(id),
  part_number     text NOT NULL,
  qty             numeric NOT NULL,
  due_date        date,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_build', 'built', 'cancelled')),
  build_id        uuid REFERENCES public.assembly_builds(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assembly_requests_open_idx ON public.assembly_requests (part_number) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS public.assembly_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id      uuid NOT NULL REFERENCES public.assembly_builds(id) ON DELETE CASCADE,
  wave          integer NOT NULL DEFAULT 1,
  profile_id    uuid NOT NULL REFERENCES public.profiles(id),
  bench_id      uuid REFERENCES public.assembly_benches(id),
  clock_in      timestamptz NOT NULL DEFAULT now(),
  clock_out     timestamptz,
  qty_done      integer,
  pause_reason  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assembly_sessions_build_idx ON public.assembly_sessions (build_id);
CREATE INDEX IF NOT EXISTS assembly_sessions_open_idx  ON public.assembly_sessions (profile_id) WHERE clock_out IS NULL;

CREATE TABLE IF NOT EXISTS public.assembly_component_lots (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id               uuid NOT NULL REFERENCES public.assembly_builds(id) ON DELETE CASCADE,
  wave                   integer NOT NULL DEFAULT 1,
  component_part_number  text NOT NULL,
  component_part_id      uuid REFERENCES public.parts(id),
  fb_tag_id              bigint,
  lot_number             text NOT NULL,
  qty                    numeric,
  validated_qty          numeric,
  picked_by              uuid REFERENCES public.profiles(id),
  picked_at              timestamptz NOT NULL DEFAULT now(),
  second_pin_by          uuid REFERENCES public.profiles(id),
  UNIQUE (build_id, wave, component_part_number, lot_number)
);
CREATE INDEX IF NOT EXISTS assembly_component_lots_build_idx ON public.assembly_component_lots (build_id);

CREATE TABLE IF NOT EXISTS public.assembly_step_signoffs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id    uuid NOT NULL REFERENCES public.assembly_builds(id) ON DELETE CASCADE,
  wave        integer NOT NULL DEFAULT 1,
  step_id     uuid NOT NULL REFERENCES public.assembly_checklist_steps(id),
  pin_1       uuid REFERENCES public.profiles(id),
  pin_2       uuid REFERENCES public.profiles(id),
  readings    jsonb,
  result      text NOT NULL DEFAULT 'pass' CHECK (result IN ('pass', 'fail')),
  note        text,
  signed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (build_id, wave, step_id)
);

CREATE TABLE IF NOT EXISTS public.assembly_build_costs (
  build_id             uuid PRIMARY KEY REFERENCES public.assembly_builds(id) ON DELETE CASCADE,
  good_qty             integer,
  minutes_total        numeric,
  minutes_per_unit     numeric,
  labor_rate           numeric,
  labor_cost_unit      numeric,
  component_cost_unit  numeric,
  overhead_pct         numeric,
  overhead_unit        numeric,
  model_cost_unit      numeric,
  basis_note           text,
  computed_at          timestamptz NOT NULL DEFAULT now()
);

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assembly_builds','assembly_requests','assembly_sessions','assembly_component_lots',
                           'assembly_step_signoffs','assembly_build_costs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', t || '_read', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
  END LOOP;
END
$rls$;

-- Outsourcing from a build (D-ASM-20): a third source type.
ALTER TABLE public.outbound_sends DROP CONSTRAINT IF EXISTS outbound_sends_source_type_check;
ALTER TABLE public.outbound_sends ADD CONSTRAINT outbound_sends_source_type_check
  CHECK (source_type IS NULL OR source_type IN ('finishing_send', 'work_order_assembly', 'assembly_build'));

-- updated_at upkeep
CREATE OR REPLACE FUNCTION public.assembly_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS assembly_builds_touch ON public.assembly_builds;
CREATE TRIGGER assembly_builds_touch BEFORE UPDATE ON public.assembly_builds FOR EACH ROW EXECUTE FUNCTION public.assembly_touch_updated_at();
DROP TRIGGER IF EXISTS assembly_requests_touch ON public.assembly_requests;
CREATE TRIGGER assembly_requests_touch BEFORE UPDATE ON public.assembly_requests FOR EACH ROW EXECUTE FUNCTION public.assembly_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. WOA status mirror (D-ASM-20): a build linked to a work_order_assembly
--    drives the WOA's existing enum.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assembly_build_mirror_woa() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_woa text;
BEGIN
  IF NEW.work_order_assembly_id IS NULL OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
  v_woa := CASE NEW.status
             WHEN 'requested' THEN 'pending' WHEN 'assigned' THEN 'pending'
             WHEN 'in_progress' THEN 'in_progress' WHEN 'paused' THEN 'paused'
             WHEN 'complete' THEN 'pending_tco'
             WHEN 'ready_for_outsource' THEN 'ready_for_outsource' WHEN 'at_external_vendor' THEN 'at_external_vendor'
             WHEN 'pending_tco' THEN 'pending_tco'
             WHEN 'released' THEN 'complete'
             ELSE NULL END;
  IF v_woa IS NOT NULL THEN
    UPDATE public.work_order_assemblies
       SET status = v_woa,
           assembly_started_at   = COALESCE(assembly_started_at, NEW.started_at),
           assembly_completed_at = CASE WHEN v_woa IN ('pending_tco','complete','ready_for_outsource') THEN COALESCE(assembly_completed_at, NEW.completed_at) ELSE assembly_completed_at END,
           good_quantity = COALESCE(NEW.good_quantity, good_quantity),
           bad_quantity  = COALESCE(NEW.bad_quantity, bad_quantity),
           assembly_lot_number = COALESCE(NEW.assembly_lot_number, assembly_lot_number)
     WHERE id = NEW.work_order_assembly_id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS assembly_builds_mirror_woa ON public.assembly_builds;
CREATE TRIGGER assembly_builds_mirror_woa AFTER UPDATE OF status ON public.assembly_builds
  FOR EACH ROW EXECUTE FUNCTION public.assembly_build_mirror_woa();

-- ---------------------------------------------------------------------------
-- 5. Requests from Order Queue lines (disposition = 'assembly', any source)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assembly_request_sync(p_soitem_ids integer[] DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0; r record;
BEGIN
  FOR r IN
    SELECT l.fb_soitem_id, l.fb_so_id, so.so_number, l.line_number, l.part_id,
           COALESCE(l.part_num, l.product_num) AS part_number,
           GREATEST(COALESCE(l.qty_to_fulfill, l.qty_ordered - COALESCE(l.qty_fulfilled, 0)), 0) AS qty,
           l.effective_due_date::date AS due_date,
           (l.disposition = 'assembly' AND l.removed_at IS NULL AND so.status_id IN (20, 25)) AS wants_request,
           rq.id AS request_id, rq.status AS request_status
    FROM public.fb_sales_order_lines l
    JOIN public.fb_sales_orders so ON so.fb_so_id = l.fb_so_id
    LEFT JOIN public.assembly_requests rq ON rq.fb_soitem_id = l.fb_soitem_id
    WHERE (p_soitem_ids IS NULL OR l.fb_soitem_id = ANY(p_soitem_ids))
      AND (l.disposition = 'assembly' OR rq.id IS NOT NULL)
  LOOP
    IF r.wants_request AND r.qty > 0 THEN
      IF r.request_id IS NULL THEN
        INSERT INTO public.assembly_requests (fb_soitem_id, fb_so_id, so_number, line_number, part_id, part_number, qty, due_date)
        VALUES (r.fb_soitem_id, r.fb_so_id, r.so_number, r.line_number, r.part_id, r.part_number, r.qty, r.due_date);
        n := n + 1;
      ELSIF r.request_status = 'cancelled' THEN
        UPDATE public.assembly_requests SET status = 'open', build_id = NULL, qty = r.qty, due_date = r.due_date WHERE id = r.request_id;
        n := n + 1;
      ELSIF r.request_status = 'open' THEN
        UPDATE public.assembly_requests SET qty = r.qty, due_date = r.due_date, part_id = COALESCE(r.part_id, part_id)
         WHERE id = r.request_id AND (qty IS DISTINCT FROM r.qty OR due_date IS DISTINCT FROM r.due_date);
      END IF;
    ELSIF r.request_id IS NOT NULL AND r.request_status = 'open' THEN
      UPDATE public.assembly_requests SET status = 'cancelled' WHERE id = r.request_id;   -- line left assembly, never built
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.assembly_request_sync(integer[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assembly_request_sync(integer[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fb_sales_order_lines_request_trg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.disposition = 'assembly' OR OLD.disposition = 'assembly' OR NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
    PERFORM public.assembly_request_sync(ARRAY[NEW.fb_soitem_id]);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS fb_sales_order_lines_request_sync ON public.fb_sales_order_lines;
CREATE TRIGGER fb_sales_order_lines_request_sync AFTER UPDATE OF disposition, removed_at, qty_fulfilled, qty_to_fulfill ON public.fb_sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.fb_sales_order_lines_request_trg();

-- ---------------------------------------------------------------------------
-- 6. Build RPCs (gate: admin / assembly)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assembly_build_create(
  p_part_number text, p_quantity integer, p_build_kind text,
  p_priority text DEFAULT 'normal', p_request_ids uuid[] DEFAULT NULL,
  p_rework_source_lot text DEFAULT NULL, p_program_id uuid DEFAULT NULL, p_program_final_lot_id uuid DEFAULT NULL,
  p_work_order_assembly_id uuid DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_part public.parts%ROWTYPE; v_tpl uuid; v_waves integer := 1; v_id uuid;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  IF p_part_number IS NULL OR btrim(p_part_number) = '' THEN RAISE EXCEPTION 'Part number is required'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'Quantity must be greater than zero'; END IF;
  IF p_build_kind NOT IN ('order','stock','special','rework','program') THEN RAISE EXCEPTION 'Unknown build kind %', p_build_kind; END IF;
  IF p_build_kind = 'rework' AND (p_rework_source_lot IS NULL OR btrim(p_rework_source_lot) = '') THEN
    RAISE EXCEPTION 'A rework build needs the source lot number';
  END IF;

  SELECT * INTO v_part FROM public.parts WHERE part_number = btrim(p_part_number) LIMIT 1;

  IF v_part.assembly_family IS NOT NULL THEN
    SELECT id INTO v_tpl FROM public.assembly_checklist_templates
     WHERE family_key = v_part.assembly_family AND wave = 1 AND status <> 'retired' ORDER BY (status = 'approved') DESC LIMIT 1;
    SELECT COALESCE(MAX(wave), 1) INTO v_waves FROM public.assembly_checklist_templates
     WHERE family_key = v_part.assembly_family AND status <> 'retired';
  END IF;
  IF p_build_kind = 'program' THEN v_waves := 2; END IF;

  INSERT INTO public.assembly_builds
    (part_id, part_number, quantity, build_kind, priority, wave_count, work_order_assembly_id,
     program_id, program_final_lot_id, checklist_template_id, rework_source_lot,
     fb_post_status, note, created_by)
  VALUES
    (v_part.id, btrim(p_part_number), p_quantity, p_build_kind, COALESCE(NULLIF(p_priority,''), 'normal'), v_waves, p_work_order_assembly_id,
     p_program_id, p_program_final_lot_id, v_tpl, NULLIF(btrim(p_rework_source_lot), ''),
     CASE WHEN p_build_kind = 'program' THEN 'not_applicable' ELSE 'not_posted' END, p_note, v_uid)
  RETURNING id INTO v_id;

  IF p_request_ids IS NOT NULL THEN
    UPDATE public.assembly_requests SET status = 'in_build', build_id = v_id
     WHERE id = ANY(p_request_ids) AND status = 'open';
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.assembly_build_create(text, integer, text, text, uuid[], text, uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assembly_build_create(text, integer, text, text, uuid[], text, uuid, uuid, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assembly_build_assign(p_build_id uuid, p_bench_id uuid DEFAULT NULL, p_profile_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  UPDATE public.assembly_builds
     SET bench_id = COALESCE(p_bench_id, bench_id), assigned_to = p_profile_id, assigned_at = now(),
         status = CASE WHEN status = 'requested' THEN 'assigned' ELSE status END
   WHERE id = p_build_id AND status IN ('requested', 'assigned');
  IF NOT FOUND THEN RAISE EXCEPTION 'Build cannot be assigned in its current state'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.assembly_build_assign(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assembly_build_assign(uuid, uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assembly_build_release(p_build_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.assembly_builds%ROWTYPE;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown build'; END IF;
  IF b.status NOT IN ('complete', 'pending_tco') THEN RAISE EXCEPTION 'Only a completed build can be released (status %)', b.status; END IF;
  IF b.work_order_assembly_id IS NOT NULL AND b.status = 'pending_tco' THEN
    RAISE EXCEPTION 'This build closes through TCO, not release';
  END IF;
  UPDATE public.assembly_builds
     SET status = 'released', released_by = auth.uid(), released_at = now(),
         fb_post_status = CASE WHEN build_kind = 'program' THEN 'not_applicable' ELSE 'ready_to_post' END
   WHERE id = p_build_id;
  UPDATE public.assembly_requests SET status = 'built' WHERE build_id = p_build_id AND status = 'in_build';
END $$;
REVOKE ALL ON FUNCTION public.assembly_build_release(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assembly_build_release(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assembly_build_cancel(p_build_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  UPDATE public.assembly_builds
     SET status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = btrim(p_reason)
   WHERE id = p_build_id AND status IN ('requested', 'assigned', 'paused');
  IF NOT FOUND THEN RAISE EXCEPTION 'Only a requested, assigned or paused build can be cancelled'; END IF;
  UPDATE public.assembly_requests SET status = 'open', build_id = NULL WHERE build_id = p_build_id AND status = 'in_build';
END $$;
REVOKE ALL ON FUNCTION public.assembly_build_cancel(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assembly_build_cancel(uuid, text) TO authenticated, service_role;

-- Lot assignment (D-ASM-02). Same component-lot set for the same part → same
-- number; any difference → next number. Rework = source lot + 'R'. Program
-- builds keep the program's final lot (returns NULL).
CREATE OR REPLACE FUNCTION public.assembly_lot_assign(p_build_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.assembly_builds%ROWTYPE; v_set text; v_hash text; v_lot text; v_next bigint;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown build'; END IF;
  IF b.assembly_lot_number IS NOT NULL THEN RETURN b.assembly_lot_number; END IF;
  IF b.build_kind = 'program' THEN RETURN NULL; END IF;
  IF b.build_kind = 'rework' THEN
    v_lot := b.rework_source_lot || 'R';
    UPDATE public.assembly_builds SET assembly_lot_number = v_lot WHERE id = p_build_id;
    RETURN v_lot;
  END IF;

  SELECT string_agg(component_part_number || '=' || lot_number, '|' ORDER BY component_part_number, lot_number)
    INTO v_set FROM public.assembly_component_lots WHERE build_id = p_build_id;
  IF v_set IS NULL THEN RAISE EXCEPTION 'No component lots recorded for this build'; END IF;
  v_hash := md5(b.part_number || '#' || v_set);

  SELECT assembly_lot_number INTO v_lot FROM public.assembly_lot_index WHERE lot_set_hash = v_hash;
  IF v_lot IS NULL THEN
    UPDATE public.assembly_lot_sequence SET next_number = next_number + 1 WHERE id = 1 RETURNING next_number - 1 INTO v_next;
    v_lot := v_next::text;
    INSERT INTO public.assembly_lot_index (lot_set_hash, assembly_part_number, lot_set, assembly_lot_number, first_build_id)
    VALUES (v_hash, b.part_number, v_set, v_lot, p_build_id);
  END IF;
  UPDATE public.assembly_builds SET assembly_lot_number = v_lot WHERE id = p_build_id;
  RETURN v_lot;
END $$;
REVOKE ALL ON FUNCTION public.assembly_lot_assign(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assembly_lot_assign(uuid) TO authenticated, service_role;

-- Is this component-lot set new for the part? (the kiosk asks before start,
-- to decide whether a second PIN is required — D-ASM-08)
CREATE OR REPLACE FUNCTION public.assembly_lot_set_is_new(p_part_number text, p_lots jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_set text; v_hash text;
BEGIN
  SELECT string_agg((e->>'part') || '=' || (e->>'lot'), '|' ORDER BY e->>'part', e->>'lot') INTO v_set
  FROM jsonb_array_elements(p_lots) e;
  IF v_set IS NULL THEN RETURN true; END IF;
  v_hash := md5(p_part_number || '#' || v_set);
  RETURN NOT EXISTS (SELECT 1 FROM public.assembly_lot_index WHERE lot_set_hash = v_hash);
END $$;
GRANT EXECUTE ON FUNCTION public.assembly_lot_set_is_new(text, jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Board views
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_assembly_requests_open WITH (security_invoker = true) AS
SELECT part_number, part_id,
       COUNT(*)::int AS request_count, SUM(qty) AS qty_total, MIN(due_date) AS earliest_due,
       string_agg(so_number || ' #' || line_number, ', ' ORDER BY due_date NULLS LAST, so_number) AS lines,
       array_agg(id ORDER BY due_date NULLS LAST, so_number) AS request_ids
FROM public.assembly_requests
WHERE status = 'open'
GROUP BY part_number, part_id;
GRANT SELECT ON public.v_assembly_requests_open TO authenticated;

CREATE OR REPLACE VIEW public.v_assembly_builds_board WITH (security_invoker = true) AS
SELECT b.*,
       p.description AS part_description, p.assembly_family,
       bn.name AS bench_name,
       pa.full_name AS assigned_name,
       t.name AS template_name, t.status AS template_status,
       (SELECT COUNT(*)::int FROM public.assembly_requests r WHERE r.build_id = b.id) AS request_count,
       (SELECT COUNT(*)::int FROM public.assembly_sessions s WHERE s.build_id = b.id AND s.clock_out IS NULL) AS open_sessions,
       (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(s.clock_out, now()) - s.clock_in)) / 60), 0)::numeric(10,1)
          FROM public.assembly_sessions s WHERE s.build_id = b.id) AS minutes_total,
       (SELECT COUNT(*)::int FROM public.assembly_component_lots cl WHERE cl.build_id = b.id) AS lots_recorded
FROM public.assembly_builds b
LEFT JOIN public.parts p ON p.id = b.part_id
LEFT JOIN public.assembly_benches bn ON bn.id = b.bench_id
LEFT JOIN public.profiles pa ON pa.id = b.assigned_to
LEFT JOIN public.assembly_checklist_templates t ON t.id = b.checklist_template_id;
GRANT SELECT ON public.v_assembly_builds_board TO authenticated;


-- ---------------------------------------------------------------------------
-- 7b. Roger's checklist administration (D-ASM-07). Gate: admin / compliance.
--     (TEST: migration s17_b1_checklist_admin_rpcs)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assembly_template_set(p_template_id uuid, p_name text DEFAULT NULL, p_status text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','compliance']);
  IF p_status IS NOT NULL AND p_status NOT IN ('draft','approved','retired') THEN RAISE EXCEPTION 'Unknown status %', p_status; END IF;
  UPDATE public.assembly_checklist_templates
     SET name = COALESCE(NULLIF(btrim(p_name), ''), name),
         status = COALESCE(p_status, status),
         approved_by = CASE WHEN p_status = 'approved' THEN auth.uid() ELSE approved_by END,
         approved_at = CASE WHEN p_status = 'approved' THEN now() ELSE approved_at END,
         updated_at = now()
   WHERE id = p_template_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown template'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.assembly_template_set(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assembly_template_set(uuid, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assembly_step_set(p_step_id uuid, p_label text DEFAULT NULL, p_pins integer DEFAULT NULL,
                                                    p_threshold_min numeric DEFAULT NULL, p_sample_qty integer DEFAULT NULL,
                                                    p_instruction_text text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','compliance']);
  UPDATE public.assembly_checklist_steps
     SET label = COALESCE(NULLIF(btrim(p_label), ''), label),
         pins_required = COALESCE(p_pins, pins_required),
         threshold_min = COALESCE(p_threshold_min, threshold_min),
         sample_qty = COALESCE(p_sample_qty, sample_qty),
         instruction_text = COALESCE(p_instruction_text, instruction_text)
   WHERE id = p_step_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown step'; END IF;
  UPDATE public.assembly_checklist_templates t SET updated_at = now()
   WHERE t.id = (SELECT template_id FROM public.assembly_checklist_steps WHERE id = p_step_id);
END $$;
REVOKE ALL ON FUNCTION public.assembly_step_set(uuid, text, integer, numeric, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assembly_step_set(uuid, text, integer, numeric, integer, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assembly_part_set_family(p_part_numbers text[], p_family_key text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','compliance']);
  IF p_family_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.assembly_checklist_templates WHERE family_key = p_family_key) THEN
    RAISE EXCEPTION 'Unknown family %', p_family_key;
  END IF;
  UPDATE public.parts SET assembly_family = p_family_key WHERE part_number = ANY(p_part_numbers);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.assembly_part_set_family(text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assembly_part_set_family(text[], text) TO authenticated, service_role;

CREATE OR REPLACE VIEW public.v_assembly_checklist_families WITH (security_invoker = true) AS
SELECT t.id, t.family_key, t.wave, t.name, t.status, t.source, t.seed_note, t.approved_at,
       ap.full_name AS approved_by_name,
       (SELECT COUNT(*)::int FROM public.parts p WHERE p.assembly_family = t.family_key) AS part_count,
       (SELECT string_agg(p.part_number, ', ' ORDER BY p.part_number) FROM (SELECT part_number FROM public.parts WHERE assembly_family = t.family_key ORDER BY part_number LIMIT 8) p) AS example_parts,
       (SELECT COUNT(*)::int FROM public.assembly_checklist_steps s WHERE s.template_id = t.id) AS step_count
FROM public.assembly_checklist_templates t
LEFT JOIN public.profiles ap ON ap.id = t.approved_by;
GRANT SELECT ON public.v_assembly_checklist_families TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Seeds and backfill
-- ---------------------------------------------------------------------------
SELECT * FROM public.assembly_seed_checklists_from_fishbowl();
SELECT public.assembly_request_sync(NULL) AS requests_synced;
