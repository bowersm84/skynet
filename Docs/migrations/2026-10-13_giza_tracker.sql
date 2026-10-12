/* =====================================================================================
   2026-10-13_giza_tracker.sql  --  Sprint 15 Batch A (D-GIZA-01 .. D-GIZA-16)

   Giza program tracker: ovens as finishing machines, dry-film finishing columns,
   program tables, lot RPCs, dashboard views, Giza seed.

   RUN ONE BLOCK AT A TIME in the Supabase SQL Editor (the editor runs a whole sheet as
   ONE transaction; a RAISE in any block rolls back earlier CREATEs). Blocks are numbered
   and independently runnable; every block is idempotent (re-run = no-op).

   Order:  BLOCK 1 preview (read-only)  ->  BLOCK 2 machines  ->  BLOCK 3 program tables
           ->  BLOCK 4 finishing_sends  ->  BLOCK 5 functions  ->  BLOCK 6 views
           ->  BLOCK 7 seed  ->  BLOCK 8 verify (read-only)

   REVIEW STOP after BLOCK 1: expect finishing_machines = 2 (FIN-1, FIN-2), ovens = 0,
   programs_table_exists = false, parts_found = 4, stage_check_present = true,
   optype_check_present = true. Anything else: stop and send the output back.

   REVIEW STOP after BLOCK 8: expect ovens = 4 (2 commissioned), tanks = 2, programs = 1,
   program_parts = 4, historical_lots = 6 (3001..3006), final_lot_next = 3007,
   demand_lines = 3 (SO 15548, MS21077-5), fn_count = 9, view_count = 4,
   stage_check_allows_paint_bake = true, optype_check_allows_dry_film = true.

   No UUIDs are hard-coded. TEST is applied by Claude; PROD is applied by Matt after
   the TEST review. Rehearsed end to end in a scratch Postgres 16 before delivery.
   ===================================================================================== */


/* ===================================== BLOCK 1 =====================================
   PREVIEW (read-only). One row of jsonb.
   ================================================================================== */
SELECT jsonb_build_object(
  'finishing_machines', (SELECT count(*) FROM public.machines WHERE machine_type = 'finishing'),
  'ovens',              (SELECT count(*) FROM public.machines WHERE code LIKE 'OVEN-%'),
  'fin1_present',       (SELECT count(*) = 1 FROM public.machines WHERE code = 'FIN-1'),
  'programs_table_exists', (SELECT to_regclass('public.programs') IS NOT NULL),
  'parts_found',        (SELECT count(*) FROM public.parts
                          WHERE part_number IN ('SK21077-5-1','SK21077-5-2','SK21077-5-3','SK21077-5-4')),
  'stage_check_present', (SELECT count(*) = 1 FROM pg_constraint
                           WHERE conrelid = 'public.finishing_sends'::regclass AND contype = 'c'
                             AND pg_get_constraintdef(oid) ILIKE '%finishing_stage%'),
  'optype_check_present', (SELECT count(*) = 1 FROM pg_constraint
                            WHERE conrelid = 'public.finishing_sends'::regclass AND contype = 'c'
                              AND pg_get_constraintdef(oid) ILIKE '%standalone_operation_type%'),
  'giza_fulfilled_now',  (SELECT coalesce(sum(l.qty_fulfilled), 0)
                           FROM public.fb_sales_order_lines l
                           JOIN public.fb_sales_orders s ON s.fb_so_id = l.fb_so_id
                          WHERE s.customer_name ILIKE '%GIZA%' AND l.product_num = 'MS21077-5'
                            AND l.type_id = 10 AND s.removed_at IS NULL AND l.removed_at IS NULL)
) AS preview;


/* ===================================== BLOCK 2 =====================================
   MACHINES: finishing_role column, tanks backfilled, OVEN-1..4 inserted beside FIN-1.
   ================================================================================== */
DO $$
DECLARE
  v_fin1 public.machines%ROWTYPE;
  v_i int;
  v_inserted int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'machines' AND column_name = 'finishing_role') THEN
    ALTER TABLE public.machines ADD COLUMN finishing_role text;
    ALTER TABLE public.machines ADD CONSTRAINT machines_finishing_role_check
      CHECK (finishing_role IS NULL OR finishing_role IN ('tank','oven'));
  END IF;

  UPDATE public.machines SET finishing_role = 'tank'
   WHERE machine_type = 'finishing' AND finishing_role IS NULL AND code NOT LIKE 'OVEN-%';

  SELECT * INTO v_fin1 FROM public.machines WHERE code = 'FIN-1' LIMIT 1;
  IF v_fin1.id IS NULL THEN
    RAISE EXCEPTION 'GUARD: FIN-1 not found; ovens need its location_id as the template';
  END IF;

  FOR v_i IN 1..4 LOOP
    IF NOT EXISTS (SELECT 1 FROM public.machines WHERE location_id = v_fin1.location_id AND code = 'OVEN-' || v_i) THEN
      INSERT INTO public.machines (location_id, name, code, machine_type, finishing_role, status, display_order,
                                   is_active, kiosk_enabled, is_commissioned, model)
      VALUES (v_fin1.location_id, 'Oven ' || v_i, 'OVEN-' || v_i, 'finishing', 'oven', 'available',
              coalesce(v_fin1.display_order, 100) + 10 * v_i, true, false, (v_i <= 2), 'Dry film cure oven');
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'BLOCK 2: ovens inserted = %, tanks now = %', v_inserted,
    (SELECT count(*) FROM public.machines WHERE finishing_role = 'tank');
END $$;


/* ===================================== BLOCK 3 =====================================
   PROGRAM TABLES: programs, program_parts, program_final_lots, program_ledger,
   dry_film_lot_map. RLS on; SELECT for authenticated; all writes via RPCs (BLOCK 5).
   ================================================================================== */
CREATE TABLE IF NOT EXISTS public.programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  customer_match text NOT NULL,
  fb_product_num text NOT NULL,
  primary_part_id uuid NOT NULL REFERENCES public.parts(id),
  oven_load_qty integer NOT NULL DEFAULT 618,
  final_lot_next integer NOT NULL DEFAULT 1,
  final_lot_label text NOT NULL DEFAULT '',
  shipped_baseline numeric NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.program_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES public.programs(id),
  part_id uuid NOT NULL REFERENCES public.parts(id),
  role text NOT NULL CHECK (role IN ('nut','cage','retainer','insert')),
  consumed_at_stage text CHECK (consumed_at_stage IS NULL OR consumed_at_stage IN ('washer_inserted','assembled')),
  qty_per integer NOT NULL DEFAULT 1 CHECK (qty_per > 0),
  UNIQUE (program_id, part_id),
  UNIQUE (program_id, role)
);

CREATE TABLE IF NOT EXISTS public.program_final_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES public.programs(id),
  lot_number text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','historical')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  opened_by uuid REFERENCES public.profiles(id),
  closed_at timestamptz,
  closed_by uuid REFERENCES public.profiles(id),
  quantity integer,
  cage_lot text,
  retainer_lot text,
  insert_lot text,
  nut_lots text[],
  plating_lots text[],
  finishing_lots text[],
  torsion_1_qty integer,
  torsion_1_inlbs numeric,
  torsion_2_qty integer,
  torsion_2_inlbs numeric,
  inspected_by text,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, lot_number)
);

CREATE TABLE IF NOT EXISTS public.program_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES public.programs(id),
  part_id uuid NOT NULL REFERENCES public.parts(id),
  stage text NOT NULL CHECK (stage IN ('received','washer_inserted','sent_plating','returned_plating','assembled','bagged')),
  qty integer NOT NULL CHECK (qty > 0),
  lot_number text,
  ref_lot_number text,
  vendor text,
  po_number text,
  expected_return date,
  entry_date date NOT NULL DEFAULT current_date,
  final_lot_id uuid REFERENCES public.program_final_lots(id),
  done_by text,
  notes text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual')),
  entered_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid REFERENCES public.profiles(id),
  void_reason text
);
CREATE INDEX IF NOT EXISTS program_ledger_program_stage_date_idx ON public.program_ledger (program_id, stage, entry_date);
CREATE INDEX IF NOT EXISTS program_ledger_final_lot_idx ON public.program_ledger (final_lot_id);

CREATE TABLE IF NOT EXISTS public.dry_film_lot_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plating_lot_number text NOT NULL,
  dry_film_lot_number text NOT NULL,
  finishing_lot_number text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id),
  UNIQUE (plating_lot_number, dry_film_lot_number)
);

ALTER TABLE public.programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.program_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.program_final_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.program_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dry_film_lot_map ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['programs','program_parts','program_final_lots','program_ledger','dry_film_lot_map'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = t || '_select_authenticated') THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', t || '_select_authenticated', t);
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON public.programs, public.program_parts, public.program_final_lots, public.program_ledger, public.dry_film_lot_map FROM anon, public;
REVOKE ALL ON public.programs, public.program_parts, public.program_final_lots, public.program_ledger, public.dry_film_lot_map FROM authenticated;
GRANT SELECT ON public.programs, public.program_parts, public.program_final_lots, public.program_ledger, public.dry_film_lot_map TO authenticated;
GRANT ALL ON public.programs, public.program_parts, public.program_final_lots, public.program_ledger, public.dry_film_lot_map TO service_role;


/* ===================================== BLOCK 4 =====================================
   FINISHING_SENDS: dry-film columns; stage and operation-type CHECKs rebuilt
   (found by definition, not by name, so PROD naming cannot leave a stale check behind).
   ================================================================================== */
DO $$
DECLARE r record;
BEGIN
  ALTER TABLE public.finishing_sends
    ADD COLUMN IF NOT EXISTS program_id uuid REFERENCES public.programs(id),
    ADD COLUMN IF NOT EXISTS plating_lot_number text,
    ADD COLUMN IF NOT EXISTS dry_film_lot_number text,
    ADD COLUMN IF NOT EXISTS bake_temp_f integer;

  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.finishing_sends'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%finishing_stage%' LOOP
    EXECUTE format('ALTER TABLE public.finishing_sends DROP CONSTRAINT %I', r.conname);
  END LOOP;
  ALTER TABLE public.finishing_sends ADD CONSTRAINT finishing_sends_finishing_stage_check
    CHECK (finishing_stage IN ('wash','treatment','dry','paint','bake'));

  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.finishing_sends'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%standalone_operation_type%' LOOP
    EXECUTE format('ALTER TABLE public.finishing_sends DROP CONSTRAINT %I', r.conname);
  END LOOP;
  ALTER TABLE public.finishing_sends ADD CONSTRAINT finishing_sends_standalone_operation_type_check
    CHECK (standalone_operation_type IS NULL OR standalone_operation_type IN ('full_finishing','passivation_only','dry_film'));

  RAISE NOTICE 'BLOCK 4: finishing_sends columns added, checks rebuilt';
END $$;

CREATE INDEX IF NOT EXISTS finishing_sends_program_idx ON public.finishing_sends (program_id) WHERE program_id IS NOT NULL;


/* ===================================== BLOCK 5 =====================================
   FUNCTIONS. SECURITY DEFINER, search_path pinned, EXECUTE revoked from PUBLIC/anon,
   granted to authenticated and service_role. auth.uid() NULL (SQL Editor) passes the gate.
   ================================================================================== */

CREATE OR REPLACE FUNCTION public._program_gate(p_roles text[] DEFAULT ARRAY['admin','order_processor'])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  IF NOT public.user_has_role(v_uid, VARIADIC p_roles) THEN
    RAISE EXCEPTION 'Not authorized: requires one of %', array_to_string(p_roles, ', ') USING ERRCODE = '42501';
  END IF;
END $$;

/* ---- assign_dry_film_fln: FLN at bake completion, keyed on (plating lot, dry-film lot) ---- */
CREATE OR REPLACE FUNCTION public.assign_dry_film_fln(p_send_id uuid, p_operator_id uuid DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_send public.finishing_sends%ROWTYPE;
  v_fln text;
BEGIN
  SELECT * INTO v_send FROM public.finishing_sends WHERE id = p_send_id FOR UPDATE;
  IF v_send.id IS NULL THEN RAISE EXCEPTION 'GUARD: finishing send % not found', p_send_id; END IF;
  IF v_send.standalone_operation_type IS DISTINCT FROM 'dry_film' THEN
    RAISE EXCEPTION 'GUARD: send % is not a dry-film batch', p_send_id;
  END IF;
  IF v_send.finishing_lot_number IS NOT NULL THEN
    RETURN v_send.finishing_lot_number;   /* idempotent */
  END IF;
  IF coalesce(btrim(v_send.plating_lot_number), '') = '' OR coalesce(btrim(v_send.dry_film_lot_number), '') = '' THEN
    RAISE EXCEPTION 'GUARD: plating lot and dry-film lot are both required before an FLN can be assigned';
  END IF;

  SELECT m.finishing_lot_number INTO v_fln FROM public.dry_film_lot_map m
   WHERE m.plating_lot_number = btrim(v_send.plating_lot_number)
     AND m.dry_film_lot_number = btrim(v_send.dry_film_lot_number);

  IF v_fln IS NULL THEN
    v_fln := 'FLN-' || lpad(public.next_finishing_lot_number()::text, 6, '0');
    INSERT INTO public.dry_film_lot_map (plating_lot_number, dry_film_lot_number, finishing_lot_number, created_by)
    VALUES (btrim(v_send.plating_lot_number), btrim(v_send.dry_film_lot_number), v_fln, p_operator_id)
    ON CONFLICT (plating_lot_number, dry_film_lot_number) DO NOTHING;
    /* re-select: if another oven finished the same pair first, its FLN wins and one sequence value is skipped */
    SELECT m.finishing_lot_number INTO v_fln FROM public.dry_film_lot_map m
     WHERE m.plating_lot_number = btrim(v_send.plating_lot_number)
       AND m.dry_film_lot_number = btrim(v_send.dry_film_lot_number);
  END IF;

  UPDATE public.finishing_sends SET finishing_lot_number = v_fln, updated_at = now() WHERE id = p_send_id;
  UPDATE public.jobs SET finishing_lot_number = v_fln, updated_at = now() WHERE id = v_send.job_id;
  RETURN v_fln;
END $$;

/* ---- program_plating_lots: returned-from-plating lots with remaining qty (kiosk picker) ---- */
CREATE OR REPLACE FUNCTION public.program_plating_lots(p_program_id uuid)
RETURNS TABLE (plating_lot_number text, nut_lots text, returned_qty bigint, painted_qty bigint, remaining bigint, last_returned date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH ret AS (
    SELECT btrim(l.lot_number) AS plating_lot,
           string_agg(DISTINCT btrim(l.ref_lot_number), ', ') AS nut_lots,
           sum(l.qty)::bigint AS returned_qty,
           max(l.entry_date) AS last_returned
      FROM public.program_ledger l
     WHERE l.program_id = p_program_id AND l.stage = 'returned_plating' AND l.voided_at IS NULL
       AND coalesce(btrim(l.lot_number), '') <> ''
     GROUP BY btrim(l.lot_number)
  ), painted AS (
    SELECT btrim(fs.plating_lot_number) AS plating_lot, coalesce(sum(fs.incoming_count), 0)::bigint AS painted_qty
      FROM public.finishing_sends fs
     WHERE fs.program_id = p_program_id AND fs.standalone_operation_type = 'dry_film'
     GROUP BY btrim(fs.plating_lot_number)
  )
  SELECT r.plating_lot, r.nut_lots, r.returned_qty, coalesce(p.painted_qty, 0),
         r.returned_qty - coalesce(p.painted_qty, 0), r.last_returned
    FROM ret r LEFT JOIN painted p ON p.plating_lot = r.plating_lot
   WHERE r.returned_qty - coalesce(p.painted_qty, 0) > 0
   ORDER BY r.last_returned, r.plating_lot;
$$;

/* ---- program_log_entry: one ledger movement ---- */
CREATE OR REPLACE FUNCTION public.program_log_entry(
  p_program_id uuid, p_part_id uuid, p_stage text, p_qty integer,
  p_lot text DEFAULT NULL, p_ref_lot text DEFAULT NULL, p_vendor text DEFAULT NULL, p_po text DEFAULT NULL,
  p_expected_return date DEFAULT NULL, p_entry_date date DEFAULT NULL, p_final_lot_id uuid DEFAULT NULL,
  p_done_by text DEFAULT NULL, p_notes text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prog public.programs%ROWTYPE;
  v_pp public.program_parts%ROWTYPE;
  v_lot public.program_final_lots%ROWTYPE;
  v_id uuid;
  v_lot_number text := nullif(btrim(coalesce(p_lot, '')), '');
  v_ref text := nullif(btrim(coalesce(p_ref_lot, '')), '');
BEGIN
  PERFORM public._program_gate();
  SELECT * INTO v_prog FROM public.programs WHERE id = p_program_id;
  IF v_prog.id IS NULL OR NOT v_prog.is_active THEN RAISE EXCEPTION 'GUARD: program not found or inactive'; END IF;
  IF p_stage IS NULL OR p_stage NOT IN ('received','washer_inserted','sent_plating','returned_plating','assembled','bagged') THEN
    RAISE EXCEPTION 'GUARD: unknown stage %', p_stage;
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'GUARD: quantity must be > 0'; END IF;
  SELECT * INTO v_pp FROM public.program_parts WHERE program_id = p_program_id AND part_id = p_part_id;
  IF v_pp.id IS NULL THEN RAISE EXCEPTION 'GUARD: part is not on this program'; END IF;
  IF p_stage <> 'received' AND v_pp.role <> 'nut' THEN
    RAISE EXCEPTION 'GUARD: stage % applies to the nut only (part role %)', p_stage, v_pp.role;
  END IF;
  IF p_stage IN ('received','washer_inserted','sent_plating','returned_plating','assembled') AND v_lot_number IS NULL THEN
    RAISE EXCEPTION 'GUARD: lot number required for stage %', p_stage;
  END IF;
  IF p_stage = 'returned_plating' AND v_ref IS NULL THEN
    RAISE EXCEPTION 'GUARD: returned_plating needs the nut lot it came from (ref lot)';
  END IF;
  IF p_stage = 'assembled' THEN
    IF p_final_lot_id IS NULL THEN RAISE EXCEPTION 'GUARD: assembled entries need an open final lot'; END IF;
    SELECT * INTO v_lot FROM public.program_final_lots WHERE id = p_final_lot_id AND program_id = p_program_id;
    IF v_lot.id IS NULL OR v_lot.status <> 'open' THEN RAISE EXCEPTION 'GUARD: final lot is not open on this program'; END IF;
  ELSIF p_stage = 'bagged' THEN
    IF p_final_lot_id IS NULL THEN RAISE EXCEPTION 'GUARD: bagged entries need a closed final lot'; END IF;
    SELECT * INTO v_lot FROM public.program_final_lots WHERE id = p_final_lot_id AND program_id = p_program_id;
    IF v_lot.id IS NULL OR v_lot.status <> 'closed' THEN RAISE EXCEPTION 'GUARD: final lot is not closed on this program'; END IF;
    v_lot_number := coalesce(v_lot_number, v_lot.lot_number);
  ELSIF p_final_lot_id IS NOT NULL THEN
    RAISE EXCEPTION 'GUARD: only assembled and bagged entries carry a final lot';
  END IF;

  INSERT INTO public.program_ledger (program_id, part_id, stage, qty, lot_number, ref_lot_number, vendor, po_number,
                                     expected_return, entry_date, final_lot_id, done_by, notes, entered_by)
  VALUES (p_program_id, p_part_id, p_stage, p_qty, v_lot_number, v_ref, nullif(btrim(coalesce(p_vendor,'')),''),
          nullif(btrim(coalesce(p_po,'')),''), p_expected_return, coalesce(p_entry_date, current_date), p_final_lot_id,
          nullif(btrim(coalesce(p_done_by,'')),''), nullif(btrim(coalesce(p_notes,'')),''), auth.uid())
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('program_ledger_entry', auth.uid(), jsonb_build_object(
    'entry_id', v_id, 'program', v_prog.code, 'stage', p_stage, 'qty', p_qty, 'lot', v_lot_number, 'ref_lot', v_ref,
    'part_id', p_part_id, 'final_lot_id', p_final_lot_id, 'entry_date', coalesce(p_entry_date, current_date)));
  RETURN v_id;
END $$;

/* ---- program_void_entry: soft void ---- */
CREATE OR REPLACE FUNCTION public.program_void_entry(p_entry_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_e public.program_ledger%ROWTYPE; v_lot_status text;
BEGIN
  PERFORM public._program_gate();
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'GUARD: a void reason is required'; END IF;
  SELECT * INTO v_e FROM public.program_ledger WHERE id = p_entry_id FOR UPDATE;
  IF v_e.id IS NULL THEN RAISE EXCEPTION 'GUARD: entry not found'; END IF;
  IF v_e.voided_at IS NOT NULL THEN RAISE EXCEPTION 'GUARD: entry already voided'; END IF;
  IF v_e.stage = 'assembled' AND v_e.final_lot_id IS NOT NULL THEN
    SELECT status INTO v_lot_status FROM public.program_final_lots WHERE id = v_e.final_lot_id;
    IF v_lot_status = 'closed' THEN RAISE EXCEPTION 'GUARD: final lot is closed; reopen it before voiding its assembled entries'; END IF;
  END IF;
  UPDATE public.program_ledger SET voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason) WHERE id = p_entry_id;
  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('program_ledger_void', auth.uid(), jsonb_build_object('entry_id', p_entry_id, 'stage', v_e.stage, 'qty', v_e.qty, 'lot', v_e.lot_number, 'reason', btrim(p_reason)));
END $$;

/* ---- program_open_final_lot: reserve the next bag lot number ---- */
CREATE OR REPLACE FUNCTION public.program_open_final_lot(p_program_id uuid, p_notes text DEFAULT NULL)
RETURNS public.program_final_lots LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_prog public.programs%ROWTYPE; v_row public.program_final_lots%ROWTYPE;
BEGIN
  PERFORM public._program_gate();
  SELECT * INTO v_prog FROM public.programs WHERE id = p_program_id FOR UPDATE;
  IF v_prog.id IS NULL OR NOT v_prog.is_active THEN RAISE EXCEPTION 'GUARD: program not found or inactive'; END IF;
  INSERT INTO public.program_final_lots (program_id, lot_number, status, opened_by, notes)
  VALUES (p_program_id, v_prog.final_lot_next::text, 'open', auth.uid(), nullif(btrim(coalesce(p_notes,'')),''))
  RETURNING * INTO v_row;
  UPDATE public.programs SET final_lot_next = final_lot_next + 1 WHERE id = p_program_id;
  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('program_final_lot_opened', auth.uid(), jsonb_build_object('lot_id', v_row.id, 'lot_number', v_row.lot_number, 'program', v_prog.code));
  RETURN v_row;
END $$;

/* ---- program_close_final_lot: freeze quantity, record component lots, derive the nut chain ---- */
CREATE OR REPLACE FUNCTION public.program_close_final_lot(
  p_lot_id uuid, p_cage_lot text DEFAULT NULL, p_retainer_lot text DEFAULT NULL, p_insert_lot text DEFAULT NULL,
  p_torsion jsonb DEFAULT '{}'::jsonb, p_inspected_by text DEFAULT NULL, p_notes text DEFAULT NULL)
RETURNS public.program_final_lots LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lot public.program_final_lots%ROWTYPE;
  v_qty integer;
  v_flns text[];
  v_plating text[];
  v_nuts text[];
BEGIN
  PERFORM public._program_gate();
  SELECT * INTO v_lot FROM public.program_final_lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN RAISE EXCEPTION 'GUARD: final lot not found'; END IF;
  IF v_lot.status <> 'open' THEN RAISE EXCEPTION 'GUARD: final lot % is %, not open', v_lot.lot_number, v_lot.status; END IF;

  SELECT coalesce(sum(qty), 0), array_remove(array_agg(DISTINCT btrim(lot_number)), NULL)
    INTO v_qty, v_flns
    FROM public.program_ledger
   WHERE final_lot_id = p_lot_id AND stage = 'assembled' AND voided_at IS NULL;
  IF v_qty <= 0 THEN RAISE EXCEPTION 'GUARD: final lot % has no assembled entries', v_lot.lot_number; END IF;

  SELECT array_agg(DISTINCT m.plating_lot_number ORDER BY m.plating_lot_number) INTO v_plating
    FROM public.dry_film_lot_map m WHERE m.finishing_lot_number = ANY (coalesce(v_flns, '{}'));
  SELECT array_agg(DISTINCT btrim(l.ref_lot_number) ORDER BY btrim(l.ref_lot_number)) INTO v_nuts
    FROM public.program_ledger l
   WHERE l.program_id = v_lot.program_id AND l.stage = 'returned_plating' AND l.voided_at IS NULL
     AND btrim(l.lot_number) = ANY (coalesce(v_plating, '{}')) AND l.ref_lot_number IS NOT NULL;

  UPDATE public.program_final_lots SET
    status = 'closed', closed_at = now(), closed_by = auth.uid(), quantity = v_qty,
    cage_lot = nullif(btrim(coalesce(p_cage_lot,'')),''),
    retainer_lot = nullif(btrim(coalesce(p_retainer_lot,'')),''),
    insert_lot = nullif(btrim(coalesce(p_insert_lot,'')),''),
    nut_lots = v_nuts, plating_lots = v_plating, finishing_lots = v_flns,
    torsion_1_qty = (p_torsion->>'t1_qty')::integer, torsion_1_inlbs = (p_torsion->>'t1_inlbs')::numeric,
    torsion_2_qty = (p_torsion->>'t2_qty')::integer, torsion_2_inlbs = (p_torsion->>'t2_inlbs')::numeric,
    inspected_by = nullif(btrim(coalesce(p_inspected_by,'')),''),
    notes = coalesce(nullif(btrim(coalesce(p_notes,'')),''), notes),
    updated_at = now()
  WHERE id = p_lot_id RETURNING * INTO v_lot;

  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('program_final_lot_closed', auth.uid(), jsonb_build_object('lot_id', p_lot_id, 'lot_number', v_lot.lot_number, 'quantity', v_qty,
          'finishing_lots', v_flns, 'plating_lots', v_plating, 'nut_lots', v_nuts));
  RETURN v_lot;
END $$;

/* ---- program_reopen_final_lot: admin only; refused once bagged ---- */
CREATE OR REPLACE FUNCTION public.program_reopen_final_lot(p_lot_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lot public.program_final_lots%ROWTYPE;
BEGIN
  PERFORM public._program_gate(ARRAY['admin']);
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'GUARD: a reason is required'; END IF;
  SELECT * INTO v_lot FROM public.program_final_lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN RAISE EXCEPTION 'GUARD: final lot not found'; END IF;
  IF v_lot.status <> 'closed' THEN RAISE EXCEPTION 'GUARD: only a closed lot can be reopened'; END IF;
  IF EXISTS (SELECT 1 FROM public.program_ledger WHERE final_lot_id = p_lot_id AND stage = 'bagged' AND voided_at IS NULL) THEN
    RAISE EXCEPTION 'GUARD: lot % has bagged entries; void them first', v_lot.lot_number;
  END IF;
  UPDATE public.program_final_lots SET status = 'open', closed_at = NULL, closed_by = NULL, updated_at = now() WHERE id = p_lot_id;
  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('program_final_lot_reopened', auth.uid(), jsonb_build_object('lot_id', p_lot_id, 'lot_number', v_lot.lot_number, 'reason', btrim(p_reason)));
END $$;

/* ---- program_update_final_lot: edit recorded details on closed / historical lots ---- */
CREATE OR REPLACE FUNCTION public.program_update_final_lot(p_lot_id uuid, p_fields jsonb)
RETURNS public.program_final_lots LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lot public.program_final_lots%ROWTYPE; v_bad text;
BEGIN
  PERFORM public._program_gate();
  SELECT * INTO v_lot FROM public.program_final_lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN RAISE EXCEPTION 'GUARD: final lot not found'; END IF;
  SELECT string_agg(k, ', ') INTO v_bad FROM jsonb_object_keys(coalesce(p_fields, '{}'::jsonb)) k
   WHERE k NOT IN ('cage_lot','retainer_lot','insert_lot','nut_lots','plating_lots','finishing_lots',
                   'torsion_1_qty','torsion_1_inlbs','torsion_2_qty','torsion_2_inlbs','inspected_by','notes','quantity');
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'GUARD: fields not editable here: %', v_bad; END IF;
  IF (p_fields ? 'quantity' OR p_fields ? 'nut_lots' OR p_fields ? 'plating_lots' OR p_fields ? 'finishing_lots') AND v_lot.status <> 'historical' THEN
    RAISE EXCEPTION 'GUARD: quantity and the nut chain are frozen at close; only historical lots take them by hand';
  END IF;
  UPDATE public.program_final_lots SET
    cage_lot        = CASE WHEN p_fields ? 'cage_lot' THEN nullif(btrim(p_fields->>'cage_lot'),'') ELSE cage_lot END,
    retainer_lot    = CASE WHEN p_fields ? 'retainer_lot' THEN nullif(btrim(p_fields->>'retainer_lot'),'') ELSE retainer_lot END,
    insert_lot      = CASE WHEN p_fields ? 'insert_lot' THEN nullif(btrim(p_fields->>'insert_lot'),'') ELSE insert_lot END,
    nut_lots        = CASE WHEN p_fields ? 'nut_lots' THEN ARRAY(SELECT jsonb_array_elements_text(p_fields->'nut_lots')) ELSE nut_lots END,
    plating_lots    = CASE WHEN p_fields ? 'plating_lots' THEN ARRAY(SELECT jsonb_array_elements_text(p_fields->'plating_lots')) ELSE plating_lots END,
    finishing_lots  = CASE WHEN p_fields ? 'finishing_lots' THEN ARRAY(SELECT jsonb_array_elements_text(p_fields->'finishing_lots')) ELSE finishing_lots END,
    torsion_1_qty   = CASE WHEN p_fields ? 'torsion_1_qty' THEN (p_fields->>'torsion_1_qty')::integer ELSE torsion_1_qty END,
    torsion_1_inlbs = CASE WHEN p_fields ? 'torsion_1_inlbs' THEN (p_fields->>'torsion_1_inlbs')::numeric ELSE torsion_1_inlbs END,
    torsion_2_qty   = CASE WHEN p_fields ? 'torsion_2_qty' THEN (p_fields->>'torsion_2_qty')::integer ELSE torsion_2_qty END,
    torsion_2_inlbs = CASE WHEN p_fields ? 'torsion_2_inlbs' THEN (p_fields->>'torsion_2_inlbs')::numeric ELSE torsion_2_inlbs END,
    inspected_by    = CASE WHEN p_fields ? 'inspected_by' THEN nullif(btrim(p_fields->>'inspected_by'),'') ELSE inspected_by END,
    notes           = CASE WHEN p_fields ? 'notes' THEN nullif(btrim(p_fields->>'notes'),'') ELSE notes END,
    quantity        = CASE WHEN p_fields ? 'quantity' THEN (p_fields->>'quantity')::integer ELSE quantity END,
    updated_at = now()
  WHERE id = p_lot_id RETURNING * INTO v_lot;
  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('program_final_lot_updated', auth.uid(), jsonb_build_object('lot_id', p_lot_id, 'lot_number', v_lot.lot_number, 'fields', p_fields));
  RETURN v_lot;
END $$;

REVOKE EXECUTE ON FUNCTION public._program_gate(text[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.assign_dry_film_fln(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.program_plating_lots(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.program_log_entry(uuid, uuid, text, integer, text, text, text, text, date, date, uuid, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.program_void_entry(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.program_open_final_lot(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.program_close_final_lot(uuid, text, text, text, jsonb, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.program_reopen_final_lot(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.program_update_final_lot(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._program_gate(text[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assign_dry_film_fln(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.program_plating_lots(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.program_log_entry(uuid, uuid, text, integer, text, text, text, text, date, date, uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.program_void_entry(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.program_open_final_lot(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.program_close_final_lot(uuid, text, text, text, jsonb, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.program_reopen_final_lot(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.program_update_final_lot(uuid, jsonb) TO authenticated, service_role;


/* ===================================== BLOCK 6 =====================================
   VIEWS (security_invoker; table RLS applies). Revoke-then-grant so nothing inherits ALL.
   ================================================================================== */
CREATE OR REPLACE VIEW public.v_program_demand WITH (security_invoker = true) AS
SELECT p.id AS program_id, p.code AS program_code, s.so_number, l.line_number, l.product_num,
       l.qty_ordered, l.qty_fulfilled, greatest(l.qty_ordered - l.qty_fulfilled, 0) AS open_qty,
       l.effective_due_date, (current_date - l.effective_due_date) AS days_late
  FROM public.programs p
  JOIN public.fb_sales_orders s ON s.customer_name ILIKE '%' || p.customer_match || '%' AND s.removed_at IS NULL AND s.status_id IN (10,20,25)
  JOIN public.fb_sales_order_lines l ON l.fb_so_id = s.fb_so_id AND l.product_num = p.fb_product_num AND l.type_id = 10 AND l.removed_at IS NULL
 WHERE p.is_active;

CREATE OR REPLACE VIEW public.v_program_pipeline WITH (security_invoker = true) AS
WITH led AS (
  SELECT l.program_id, pp.role, l.stage, sum(l.qty)::bigint AS qty
    FROM public.program_ledger l
    JOIN public.program_parts pp ON pp.program_id = l.program_id AND pp.part_id = l.part_id
   WHERE l.voided_at IS NULL
   GROUP BY l.program_id, pp.role, l.stage
), fs AS (
  SELECT program_id,
         coalesce(sum(incoming_count), 0)::bigint AS painted,
         coalesce(sum(incoming_count) FILTER (WHERE status = 'in_finishing' AND finishing_stage = 'paint'), 0)::bigint AS in_paint,
         coalesce(sum(incoming_count) FILTER (WHERE status = 'in_finishing' AND finishing_stage = 'bake'), 0)::bigint AS in_oven,
         coalesce(sum(incoming_count) FILTER (WHERE status = 'finishing_complete'), 0)::bigint AS completed_in,
         coalesce(sum(verified_count) FILTER (WHERE status = 'finishing_complete'), 0)::bigint AS baked,
         count(*) FILTER (WHERE status = 'in_finishing')::int AS active_batches
    FROM public.finishing_sends
   WHERE program_id IS NOT NULL AND standalone_operation_type = 'dry_film'
   GROUP BY program_id
), dem AS (
  SELECT program_id, sum(qty_ordered) AS ordered, sum(qty_fulfilled) AS fulfilled, sum(open_qty) AS open_qty,
         min(effective_due_date) AS earliest_due
    FROM public.v_program_demand GROUP BY program_id
), ov AS (
  SELECT count(*) FILTER (WHERE is_active AND is_commissioned)::int AS ovens_commissioned,
         count(*) FILTER (WHERE is_active)::int AS ovens_total
    FROM public.machines WHERE finishing_role = 'oven'
), q AS (
  SELECT p.id AS program_id, p.code, p.name, p.fb_product_num, p.oven_load_qty, p.final_lot_next, p.shipped_baseline,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'nut' AND stage = 'received'), 0)         AS nut_received,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'nut' AND stage = 'washer_inserted'), 0)  AS washer_inserted,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'nut' AND stage = 'sent_plating'), 0)     AS sent_plating,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'nut' AND stage = 'returned_plating'), 0) AS returned_plating,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'nut' AND stage = 'assembled'), 0)        AS assembled,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'nut' AND stage = 'bagged'), 0)           AS bagged,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'cage' AND stage = 'received'), 0)        AS cage_received,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'retainer' AND stage = 'received'), 0)    AS retainer_received,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'insert' AND stage = 'received'), 0)      AS insert_received,
         coalesce((SELECT qty_per FROM public.program_parts WHERE program_id = p.id AND role = 'cage'), 1)     AS cage_per,
         coalesce((SELECT qty_per FROM public.program_parts WHERE program_id = p.id AND role = 'retainer'), 1) AS retainer_per,
         coalesce((SELECT qty_per FROM public.program_parts WHERE program_id = p.id AND role = 'insert'), 1)   AS insert_per,
         coalesce(fs.painted, 0) AS painted, coalesce(fs.in_paint, 0) AS in_paint, coalesce(fs.in_oven, 0) AS in_oven,
         coalesce(fs.completed_in, 0) AS completed_in, coalesce(fs.baked, 0) AS baked, coalesce(fs.active_batches, 0) AS active_batches,
         coalesce(dem.ordered, 0) AS ordered, coalesce(dem.fulfilled, 0) AS fulfilled, coalesce(dem.open_qty, 0) AS open_qty, dem.earliest_due,
         ov.ovens_commissioned, ov.ovens_total
    FROM public.programs p
    LEFT JOIN fs ON fs.program_id = p.id
    LEFT JOIN dem ON dem.program_id = p.id
    CROSS JOIN ov
   WHERE p.is_active
)
SELECT q.*,
       (fulfilled - shipped_baseline)                              AS shipped_since_start,
       nut_received - washer_inserted                              AS waiting_washer,
       washer_inserted - sent_plating                              AS waiting_plating,
       sent_plating - returned_plating                             AS at_electrolab,
       returned_plating - painted                                  AS waiting_paint,
       baked - assembled                                           AS waiting_assembly,
       assembled - bagged                                          AS waiting_bag,
       bagged - (fulfilled - shipped_baseline)                     AS waiting_ship,
       completed_in - baked                                        AS dry_film_loss,
       insert_received - washer_inserted * insert_per              AS insert_on_hand,
       cage_received - assembled * cage_per                        AS cage_on_hand,
       retainer_received - assembled * retainer_per                AS retainer_on_hand,
       least(baked - assembled,
             (cage_received - assembled * cage_per) / cage_per,
             (retainer_received - assembled * retainer_per) / retainer_per) AS buildable_sets,
       ovens_commissioned * oven_load_qty                          AS oven_load_capacity
  FROM q;

CREATE OR REPLACE VIEW public.v_program_daily WITH (security_invoker = true) AS
SELECT program_id, d, stage, sum(qty)::bigint AS qty FROM (
  SELECT l.program_id, l.entry_date AS d,
         CASE WHEN l.stage = 'received' THEN 'received_' || pp.role ELSE l.stage END AS stage, l.qty
    FROM public.program_ledger l
    JOIN public.program_parts pp ON pp.program_id = l.program_id AND pp.part_id = l.part_id
   WHERE l.voided_at IS NULL
  UNION ALL
  SELECT fs.program_id, (fs.finishing_started_at AT TIME ZONE 'America/New_York')::date, 'painted', fs.incoming_count
    FROM public.finishing_sends fs
   WHERE fs.program_id IS NOT NULL AND fs.standalone_operation_type = 'dry_film' AND fs.finishing_started_at IS NOT NULL
  UNION ALL
  SELECT fs.program_id, (fs.finishing_completed_at AT TIME ZONE 'America/New_York')::date, 'baked', fs.verified_count
    FROM public.finishing_sends fs
   WHERE fs.program_id IS NOT NULL AND fs.standalone_operation_type = 'dry_film' AND fs.status = 'finishing_complete'
) x
WHERE d >= current_date - 60
GROUP BY program_id, d, stage;

CREATE OR REPLACE VIEW public.v_program_final_lots WITH (security_invoker = true) AS
SELECT f.id, f.program_id, f.lot_number, f.status, f.opened_at, f.opened_by, f.closed_at, f.closed_by,
       f.quantity, f.cage_lot, f.retainer_lot, f.insert_lot, f.nut_lots, f.plating_lots, f.finishing_lots,
       f.torsion_1_qty, f.torsion_1_inlbs, f.torsion_2_qty, f.torsion_2_inlbs, f.inspected_by, f.notes, f.updated_at,
       coalesce((SELECT sum(qty) FROM public.program_ledger l WHERE l.final_lot_id = f.id AND l.stage = 'assembled' AND l.voided_at IS NULL), 0)::bigint AS assembled_qty,
       coalesce((SELECT sum(qty) FROM public.program_ledger l WHERE l.final_lot_id = f.id AND l.stage = 'bagged' AND l.voided_at IS NULL), 0)::bigint AS bagged_qty,
       (SELECT jsonb_agg(jsonb_build_object('id', l.id, 'date', l.entry_date, 'qty', l.qty, 'done_by', l.done_by, 'fln', l.lot_number) ORDER BY l.entry_date, l.created_at)
          FROM public.program_ledger l WHERE l.final_lot_id = f.id AND l.stage = 'assembled' AND l.voided_at IS NULL) AS assembled_entries,
       (SELECT array_remove(array_agg(DISTINCT btrim(l.lot_number)), NULL)
          FROM public.program_ledger l WHERE l.final_lot_id = f.id AND l.stage = 'assembled' AND l.voided_at IS NULL) AS finishing_lots_live
  FROM public.program_final_lots f;

REVOKE ALL ON public.v_program_demand, public.v_program_pipeline, public.v_program_daily, public.v_program_final_lots FROM authenticated, anon, public;
GRANT SELECT ON public.v_program_demand, public.v_program_pipeline, public.v_program_daily, public.v_program_final_lots TO authenticated;
GRANT SELECT ON public.v_program_demand, public.v_program_pipeline, public.v_program_daily, public.v_program_final_lots TO service_role;


/* ===================================== BLOCK 7 =====================================
   SEED: GIZA-21077 program, its four parts, historical lots 3001..3006, shipped baseline.
   Idempotent: the program row is never rewritten once it exists (final_lot_next is live).
   ================================================================================== */
DO $$
DECLARE
  v_nut uuid; v_cage uuid; v_ret uuid; v_ins uuid; v_prog uuid; v_i int; v_baseline numeric;
BEGIN
  SELECT id INTO v_nut  FROM public.parts WHERE part_number = 'SK21077-5-3';
  SELECT id INTO v_cage FROM public.parts WHERE part_number = 'SK21077-5-4';
  SELECT id INTO v_ret  FROM public.parts WHERE part_number = 'SK21077-5-1';
  SELECT id INTO v_ins  FROM public.parts WHERE part_number = 'SK21077-5-2';
  IF v_nut IS NULL OR v_cage IS NULL OR v_ret IS NULL OR v_ins IS NULL THEN
    RAISE EXCEPTION 'GUARD: one of SK21077-5-1 / -2 / -3 / -4 is missing from parts';
  END IF;

  SELECT coalesce(sum(l.qty_fulfilled), 0) INTO v_baseline
    FROM public.fb_sales_order_lines l JOIN public.fb_sales_orders s ON s.fb_so_id = l.fb_so_id
   WHERE s.customer_name ILIKE '%GIZA%' AND l.product_num = 'MS21077-5' AND l.type_id = 10
     AND s.removed_at IS NULL AND l.removed_at IS NULL AND s.status_id IN (10,20,25);

  INSERT INTO public.programs (code, name, customer_match, fb_product_num, primary_part_id, oven_load_qty, final_lot_next, final_lot_label, shipped_baseline)
  VALUES ('GIZA-21077', 'Giza - MS21077-5 nutplate', 'GIZA', 'MS21077-5', v_nut, 618, 3007, 'MS21077-5', v_baseline)
  ON CONFLICT (code) DO NOTHING;
  SELECT id INTO v_prog FROM public.programs WHERE code = 'GIZA-21077';

  INSERT INTO public.program_parts (program_id, part_id, role, consumed_at_stage, qty_per) VALUES
    (v_prog, v_nut,  'nut',      NULL,              1),
    (v_prog, v_cage, 'cage',     'assembled',       1),
    (v_prog, v_ret,  'retainer', 'assembled',       1),
    (v_prog, v_ins,  'insert',   'washer_inserted', 1)
  ON CONFLICT (program_id, part_id) DO NOTHING;

  FOR v_i IN 3001..3006 LOOP
    INSERT INTO public.program_final_lots (program_id, lot_number, status, notes)
    VALUES (v_prog, v_i::text, 'historical', 'From the paper MS21077 Platenut Assembly sheet; details to be confirmed from the sheet')
    ON CONFLICT (program_id, lot_number) DO NOTHING;
  END LOOP;

  RAISE NOTICE 'BLOCK 7: program % seeded; shipped_baseline at seed = %', v_prog, v_baseline;
END $$;


/* ===================================== BLOCK 8 =====================================
   VERIFY (read-only, its own statement). One row of jsonb. Expected values in the header.
   ================================================================================== */
SELECT jsonb_build_object(
  'ovens', (SELECT count(*) FROM public.machines WHERE finishing_role = 'oven'),
  'ovens_commissioned', (SELECT count(*) FROM public.machines WHERE finishing_role = 'oven' AND is_commissioned),
  'tanks', (SELECT count(*) FROM public.machines WHERE finishing_role = 'tank'),
  'programs', (SELECT count(*) FROM public.programs),
  'program_parts', (SELECT count(*) FROM public.program_parts),
  'historical_lots', (SELECT count(*) FROM public.program_final_lots WHERE status = 'historical'),
  'final_lot_next', (SELECT final_lot_next FROM public.programs WHERE code = 'GIZA-21077'),
  'shipped_baseline', (SELECT shipped_baseline FROM public.programs WHERE code = 'GIZA-21077'),
  'demand_lines', (SELECT count(*) FROM public.v_program_demand),
  'demand_open', (SELECT sum(open_qty) FROM public.v_program_demand),
  'pipeline_rows', (SELECT count(*) FROM public.v_program_pipeline),
  'fn_count', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname IN ('_program_gate','assign_dry_film_fln','program_plating_lots','program_log_entry',
                  'program_void_entry','program_open_final_lot','program_close_final_lot','program_reopen_final_lot','program_update_final_lot')),
  'view_count', (SELECT count(*) FROM pg_views WHERE schemaname = 'public' AND viewname IN ('v_program_demand','v_program_pipeline','v_program_daily','v_program_final_lots')),
  'anon_can_select_views', (SELECT bool_or(has_table_privilege('anon', 'public.' || v, 'SELECT')) FROM unnest(ARRAY['v_program_demand','v_program_pipeline','v_program_daily','v_program_final_lots']) v),
  'anon_can_exec_rpcs', (SELECT bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                          WHERE n.nspname = 'public' AND p.proname LIKE 'program\_%'),
  'stage_check_allows_paint_bake', (SELECT count(*) = 1 FROM pg_constraint WHERE conrelid = 'public.finishing_sends'::regclass AND contype = 'c'
                                     AND pg_get_constraintdef(oid) ILIKE '%finishing_stage%' AND pg_get_constraintdef(oid) ILIKE '%bake%'),
  'optype_check_allows_dry_film', (SELECT count(*) = 1 FROM pg_constraint WHERE conrelid = 'public.finishing_sends'::regclass AND contype = 'c'
                                    AND pg_get_constraintdef(oid) ILIKE '%standalone_operation_type%' AND pg_get_constraintdef(oid) ILIKE '%dry_film%'),
  'fs_new_columns', (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'finishing_sends'
                      AND column_name IN ('program_id','plating_lot_number','dry_film_lot_number','bake_temp_f'))
) AS verify;
