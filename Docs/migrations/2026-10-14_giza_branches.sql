/* =====================================================================================
   2026-10-14_giza_branches.sql  --  Sprint 15, branch model (D-GIZA-21 .. D-GIZA-27)

   Every bag lot is one unbroken trail. A branch (= bag lot number) is created automatically
   at Steel Nut Receipt; it splits automatically into a new numbered branch whenever the trail
   would change: a different nylon insert lot, plating lot, dry-film lot (-> FLN), cage lot or
   retainer lot. Moving only part of a branch's quantity never splits it. Moves out of a closed
   branch continue as a new branch. Bagged is gone (assembled = bagged). No manual Open.
   Requires 2026-10-13_giza_tracker.sql.

   RUN ONE BLOCK AT A TIME in the SQL Editor (one sheet = one transaction).
   Order: BLOCK 1 preview -> BLOCK 2 schema -> BLOCK 3 functions -> BLOCK 4 views -> BLOCK 5 verify.

   REVIEW STOP after BLOCK 1 (PROD): ledger_rows 0, active_or_open_lots 0, historical_lots 6,
   bagged_rows 0, dry_film_sends_linked 0. TEST must have run 2026-10-14_TEST_ONLY_giza_branch_reset.sql
   BLOCK 1 first. Anything else: stop and send the output back.

   REVIEW STOP after BLOCK 5: branch_columns 7, ledger_columns 3, send_columns 2, open_fn_gone true,
   fn_count 10, view_count 4, status_check_has_active true, stage_check_has_bagged false,
   anon_can_exec false, anon_can_select false, helpers_private true.
   ===================================================================================== */


/* ===================================== BLOCK 1 =====================================
   PREVIEW (read-only).
   ================================================================================== */
SELECT jsonb_build_object(
  'ledger_rows', (SELECT count(*) FROM public.program_ledger),
  'bagged_rows', (SELECT count(*) FROM public.program_ledger WHERE stage = 'bagged'),
  'active_or_open_lots', (SELECT count(*) FROM public.program_final_lots WHERE status <> 'historical'),
  'historical_lots', (SELECT count(*) FROM public.program_final_lots WHERE status = 'historical'),
  'dry_film_sends_linked', (SELECT count(*) FROM public.finishing_sends WHERE program_id IS NOT NULL),
  'final_lot_next', (SELECT final_lot_next FROM public.programs WHERE code = 'GIZA-21077'),
  'branch_columns_already', (SELECT count(*) FROM information_schema.columns
                              WHERE table_schema = 'public' AND table_name = 'program_final_lots' AND column_name = 'parent_lot_id')
) AS preview;


/* ===================================== BLOCK 2 =====================================
   SCHEMA. First run requires an empty pre-branch ledger (PROD: true; TEST: after the reset).
   ================================================================================== */
DO $$
DECLARE r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'program_final_lots' AND column_name = 'parent_lot_id') THEN
    IF EXISTS (SELECT 1 FROM public.program_ledger) THEN
      RAISE EXCEPTION 'GUARD: program_ledger has pre-branch rows; on TEST run the reset file first (PROD has none)';
    END IF;
    IF EXISTS (SELECT 1 FROM public.program_final_lots WHERE status <> 'historical') THEN
      RAISE EXCEPTION 'GUARD: non-historical final lots exist; on TEST run the reset file first (PROD has none)';
    END IF;
  END IF;

  /* program_final_lots: the branch attributes */
  ALTER TABLE public.program_final_lots
    ADD COLUMN IF NOT EXISTS parent_lot_id uuid REFERENCES public.program_final_lots(id),
    ADD COLUMN IF NOT EXISTS origin text,
    ADD COLUMN IF NOT EXISTS split_reason text,
    ADD COLUMN IF NOT EXISTS nut_lot text,
    ADD COLUMN IF NOT EXISTS plating_lot text,
    ADD COLUMN IF NOT EXISTS dry_film_lot text,
    ADD COLUMN IF NOT EXISTS finishing_lot text;
  UPDATE public.program_final_lots SET origin = 'historical' WHERE origin IS NULL AND status = 'historical';

  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.program_final_lots'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) ILIKE '%status%' OR pg_get_constraintdef(oid) ILIKE '%origin%'
                   OR pg_get_constraintdef(oid) ILIKE '%split_reason%') LOOP
    EXECUTE format('ALTER TABLE public.program_final_lots DROP CONSTRAINT %I', r.conname);
  END LOOP;
  UPDATE public.program_final_lots SET status = 'active' WHERE status = 'open';
  ALTER TABLE public.program_final_lots ADD CONSTRAINT program_final_lots_status_check
    CHECK (status IN ('active','closed','historical','void'));
  ALTER TABLE public.program_final_lots ADD CONSTRAINT program_final_lots_origin_check
    CHECK (origin IS NULL OR origin IN ('receipt','split','historical'));
  ALTER TABLE public.program_final_lots ADD CONSTRAINT program_final_lots_split_reason_check
    CHECK (split_reason IS NULL OR split_reason IN ('nylon_lot','plating_lot','dry_film_lot','cage_lot','retainer_lot','component_lots','after_close'));

  /* program_ledger: source branch, assembly component lots, no bagged */
  ALTER TABLE public.program_ledger
    ADD COLUMN IF NOT EXISTS from_lot_id uuid REFERENCES public.program_final_lots(id),
    ADD COLUMN IF NOT EXISTS cage_lot text,
    ADD COLUMN IF NOT EXISTS retainer_lot text;
  IF EXISTS (SELECT 1 FROM public.program_ledger WHERE stage = 'bagged') THEN
    RAISE EXCEPTION 'GUARD: bagged ledger rows exist';
  END IF;
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.program_ledger'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%stage%' LOOP
    EXECUTE format('ALTER TABLE public.program_ledger DROP CONSTRAINT %I', r.conname);
  END LOOP;
  ALTER TABLE public.program_ledger ADD CONSTRAINT program_ledger_stage_check
    CHECK (stage IN ('received','washer_inserted','sent_plating','returned_plating','assembled'));

  /* finishing_sends: the branch a dry-film batch was painted from, and where it landed at bake */
  ALTER TABLE public.finishing_sends
    ADD COLUMN IF NOT EXISTS program_lot_id uuid REFERENCES public.program_final_lots(id),
    ADD COLUMN IF NOT EXISTS program_dest_lot_id uuid REFERENCES public.program_final_lots(id);

  RAISE NOTICE 'BLOCK 2: branch schema in place';
END $$;

CREATE INDEX IF NOT EXISTS program_ledger_from_lot_idx ON public.program_ledger (from_lot_id);
CREATE INDEX IF NOT EXISTS program_final_lots_parent_idx ON public.program_final_lots (parent_lot_id);
CREATE INDEX IF NOT EXISTS finishing_sends_program_lot_idx ON public.finishing_sends (program_lot_id) WHERE program_lot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finishing_sends_program_dest_lot_idx ON public.finishing_sends (program_dest_lot_id) WHERE program_dest_lot_id IS NOT NULL;


/* ===================================== BLOCK 3 =====================================
   FUNCTIONS. Helpers (_program_new_branch, _program_route) are private: callable only from
   the SECURITY DEFINER RPCs. auth.uid() NULL (SQL Editor) passes the gate.
   ================================================================================== */

DROP FUNCTION IF EXISTS public.program_open_final_lot(uuid, text);
DROP FUNCTION IF EXISTS public.program_log_entry(uuid, uuid, text, integer, text, text, text, text, date, date, uuid, text, text);
DROP FUNCTION IF EXISTS public.program_close_final_lot(uuid, text, text, text, jsonb, text, text);
DROP FUNCTION IF EXISTS public.program_plating_lots(uuid);

/* ---- next number, new branch ---- */
CREATE OR REPLACE FUNCTION public._program_new_branch(p_program_id uuid, p_parent uuid, p_origin text, p_reason text, p_attrs jsonb)
RETURNS public.program_final_lots LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_prog public.programs%ROWTYPE; v_row public.program_final_lots%ROWTYPE;
BEGIN
  SELECT * INTO v_prog FROM public.programs WHERE id = p_program_id FOR UPDATE;
  IF v_prog.id IS NULL THEN RAISE EXCEPTION 'GUARD: program not found'; END IF;
  INSERT INTO public.program_final_lots (program_id, lot_number, status, opened_by, parent_lot_id, origin, split_reason,
                                         nut_lot, insert_lot, plating_lot, dry_film_lot, finishing_lot, cage_lot, retainer_lot)
  VALUES (p_program_id, v_prog.final_lot_next::text, 'active', auth.uid(), p_parent, p_origin, p_reason,
          p_attrs->>'nut_lot', p_attrs->>'insert_lot', p_attrs->>'plating_lot', p_attrs->>'dry_film_lot',
          p_attrs->>'finishing_lot', p_attrs->>'cage_lot', p_attrs->>'retainer_lot')
  RETURNING * INTO v_row;
  UPDATE public.programs SET final_lot_next = final_lot_next + 1 WHERE id = p_program_id;
  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('program_branch_created', auth.uid(), jsonb_build_object('lot_id', v_row.id, 'lot_number', v_row.lot_number,
          'parent_lot_id', p_parent, 'origin', p_origin, 'reason', p_reason, 'attrs', p_attrs));
  RETURN v_row;
END $$;

/* ---- route a move out of a branch: same branch, fill its attribute, or split ---- */
CREATE OR REPLACE FUNCTION public._program_route(p_source uuid, p_stage text, p_values jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s public.program_final_lots%ROWTYPE;
  v_src jsonb;
  v_keys text[];
  v_up text[];
  v_fill jsonb := '{}'::jsonb;
  v_mismatch text[] := '{}';
  v_reason text;
  v_target jsonb := '{}'::jsonb;
  v_child public.program_final_lots%ROWTYPE;
  k text;
BEGIN
  SELECT * INTO s FROM public.program_final_lots WHERE id = p_source FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'GUARD: lot % not found', p_source; END IF;
  IF s.status NOT IN ('active','closed') THEN
    RAISE EXCEPTION 'GUARD: lot % is %; it cannot take moves', s.lot_number, s.status;
  END IF;

  /* attributes this stage sets, and the upstream ones a child inherits */
  v_keys := CASE p_stage
    WHEN 'washer_inserted'  THEN ARRAY['insert_lot']
    WHEN 'sent_plating'     THEN ARRAY[]::text[]
    WHEN 'returned_plating' THEN ARRAY['plating_lot']
    WHEN 'bake'             THEN ARRAY['dry_film_lot','finishing_lot']
    WHEN 'assembled'        THEN ARRAY['cage_lot','retainer_lot'] END;
  v_up := CASE p_stage
    WHEN 'washer_inserted'  THEN ARRAY['nut_lot']
    WHEN 'sent_plating'     THEN ARRAY['nut_lot','insert_lot']
    WHEN 'returned_plating' THEN ARRAY['nut_lot','insert_lot']
    WHEN 'bake'             THEN ARRAY['nut_lot','insert_lot','plating_lot']
    WHEN 'assembled'        THEN ARRAY['nut_lot','insert_lot','plating_lot','dry_film_lot','finishing_lot'] END;
  IF v_keys IS NULL THEN RAISE EXCEPTION 'GUARD: unknown routing stage %', p_stage; END IF;

  FOREACH k IN ARRAY v_keys LOOP
    IF nullif(btrim(coalesce(p_values->>k, '')), '') IS NULL THEN RAISE EXCEPTION 'GUARD: % is required', k; END IF;
  END LOOP;
  v_src := to_jsonb(s);

  IF s.status = 'closed' THEN
    v_reason := 'after_close';
  ELSE
    FOREACH k IN ARRAY v_keys LOOP
      IF v_src->>k IS NULL THEN
        v_fill := v_fill || jsonb_build_object(k, btrim(p_values->>k));
      ELSIF v_src->>k IS DISTINCT FROM btrim(p_values->>k) THEN
        v_mismatch := v_mismatch || k;
      END IF;
    END LOOP;

    IF cardinality(v_mismatch) = 0 THEN
      IF v_fill <> '{}'::jsonb THEN
        UPDATE public.program_final_lots SET
          insert_lot    = coalesce(v_fill->>'insert_lot', insert_lot),
          plating_lot   = coalesce(v_fill->>'plating_lot', plating_lot),
          dry_film_lot  = coalesce(v_fill->>'dry_film_lot', dry_film_lot),
          finishing_lot = coalesce(v_fill->>'finishing_lot', finishing_lot),
          cage_lot      = coalesce(v_fill->>'cage_lot', cage_lot),
          retainer_lot  = coalesce(v_fill->>'retainer_lot', retainer_lot),
          updated_at = now()
        WHERE id = s.id;
      END IF;
      RETURN jsonb_build_object('lot_id', s.id, 'lot_number', s.lot_number, 'split', false);
    END IF;

    v_reason := CASE
      WHEN p_stage = 'washer_inserted'  THEN 'nylon_lot'
      WHEN p_stage = 'returned_plating' THEN 'plating_lot'
      WHEN p_stage = 'bake'             THEN 'dry_film_lot'
      WHEN cardinality(v_mismatch) = 2  THEN 'component_lots'
      WHEN v_mismatch[1] = 'cage_lot'   THEN 'cage_lot'
      ELSE 'retainer_lot' END;
  END IF;

  /* the child's trail: everything upstream of this step from the source, plus this step's lots */
  FOREACH k IN ARRAY v_up LOOP v_target := v_target || jsonb_build_object(k, v_src->k); END LOOP;
  FOREACH k IN ARRAY v_keys LOOP v_target := v_target || jsonb_build_object(k, btrim(p_values->>k)); END LOOP;

  /* reuse an active child already holding exactly this trail, so repeated moves land together */
  SELECT c.* INTO v_child FROM public.program_final_lots c
   WHERE c.parent_lot_id = s.id AND c.status = 'active' AND c.split_reason = v_reason
     AND NOT EXISTS (SELECT 1 FROM unnest(v_up || v_keys) ck WHERE (to_jsonb(c)->>ck) IS DISTINCT FROM (v_target->>ck))
   ORDER BY (c.lot_number)::int LIMIT 1;
  IF v_child.id IS NOT NULL THEN
    RETURN jsonb_build_object('lot_id', v_child.id, 'lot_number', v_child.lot_number, 'split', true, 'reason', v_reason, 'reused', true,
                              'from_lot_number', s.lot_number);
  END IF;

  v_child := public._program_new_branch(s.program_id, s.id, 'split', v_reason, v_target);
  RETURN jsonb_build_object('lot_id', v_child.id, 'lot_number', v_child.lot_number, 'split', true, 'reason', v_reason, 'reused', false,
                            'from_lot_number', s.lot_number);
END $$;

/* ---- program_log_entry: one ledger move, branch-aware ---- */
CREATE OR REPLACE FUNCTION public.program_log_entry(
  p_program_id uuid, p_part_id uuid, p_stage text, p_qty integer,
  p_lot text DEFAULT NULL, p_branch_id uuid DEFAULT NULL, p_cage_lot text DEFAULT NULL, p_retainer_lot text DEFAULT NULL,
  p_vendor text DEFAULT NULL, p_po text DEFAULT NULL, p_expected_return date DEFAULT NULL, p_entry_date date DEFAULT NULL,
  p_done_by text DEFAULT NULL, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prog public.programs%ROWTYPE;
  v_pp public.program_parts%ROWTYPE;
  v_src public.program_final_lots%ROWTYPE;
  v_new public.program_final_lots%ROWTYPE;
  v_lot text := nullif(btrim(coalesce(p_lot, '')), '');
  v_cage text := nullif(btrim(coalesce(p_cage_lot, '')), '');
  v_ret text := nullif(btrim(coalesce(p_retainer_lot, '')), '');
  v_route jsonb;
  v_dest uuid;
  v_from uuid;
  v_row_lot text;
  v_ref text;
  v_id uuid;
BEGIN
  PERFORM public._program_gate();
  SELECT * INTO v_prog FROM public.programs WHERE id = p_program_id;
  IF v_prog.id IS NULL OR NOT v_prog.is_active THEN RAISE EXCEPTION 'GUARD: program not found or inactive'; END IF;
  IF p_stage IS NULL OR p_stage NOT IN ('received','washer_inserted','sent_plating','returned_plating','assembled') THEN
    RAISE EXCEPTION 'GUARD: unknown stage %', p_stage;
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'GUARD: quantity must be > 0'; END IF;
  SELECT * INTO v_pp FROM public.program_parts WHERE program_id = p_program_id AND part_id = p_part_id;
  IF v_pp.id IS NULL THEN RAISE EXCEPTION 'GUARD: part is not on this program'; END IF;
  IF p_stage <> 'received' AND v_pp.role <> 'nut' THEN
    RAISE EXCEPTION 'GUARD: stage % applies to the steel nut only (part role %)', p_stage, v_pp.role;
  END IF;

  IF p_stage = 'received' THEN
    IF v_lot IS NULL THEN RAISE EXCEPTION 'GUARD: the receiving lot number is required'; END IF;
    IF p_branch_id IS NOT NULL THEN RAISE EXCEPTION 'GUARD: a receipt starts its own lot; do not pass one'; END IF;
    v_row_lot := v_lot;
    IF v_pp.role = 'nut' THEN
      v_new := public._program_new_branch(p_program_id, NULL, 'receipt', NULL, jsonb_build_object('nut_lot', v_lot));
      v_dest := v_new.id;
      v_from := v_new.id;
      v_route := jsonb_build_object('lot_id', v_new.id, 'lot_number', v_new.lot_number, 'split', false, 'new_branch', true);
    END IF;
  ELSE
    IF p_branch_id IS NULL THEN RAISE EXCEPTION 'GUARD: pick the lot these pieces belong to'; END IF;
    SELECT * INTO v_src FROM public.program_final_lots WHERE id = p_branch_id AND program_id = p_program_id;
    IF v_src.id IS NULL THEN RAISE EXCEPTION 'GUARD: lot not found on this program'; END IF;
    v_from := v_src.id;
    IF p_stage = 'washer_inserted' THEN
      IF v_lot IS NULL THEN RAISE EXCEPTION 'GUARD: the nylon insert lot is required'; END IF;
      v_route := public._program_route(v_src.id, p_stage, jsonb_build_object('insert_lot', v_lot));
      v_row_lot := v_lot;
    ELSIF p_stage = 'sent_plating' THEN
      v_route := public._program_route(v_src.id, p_stage, '{}'::jsonb);
      v_row_lot := v_src.nut_lot;
    ELSIF p_stage = 'returned_plating' THEN
      IF v_lot IS NULL THEN RAISE EXCEPTION 'GUARD: the plating lot (assigned by receiving on return) is required'; END IF;
      v_route := public._program_route(v_src.id, p_stage, jsonb_build_object('plating_lot', v_lot));
      v_row_lot := v_lot;
      v_ref := v_src.nut_lot;
    ELSE /* assembled */
      IF v_src.finishing_lot IS NULL THEN RAISE EXCEPTION 'GUARD: lot % has nothing baked yet', v_src.lot_number; END IF;
      IF v_cage IS NULL OR v_ret IS NULL THEN RAISE EXCEPTION 'GUARD: the cage lot and the retainer lot are both required'; END IF;
      v_route := public._program_route(v_src.id, p_stage, jsonb_build_object('cage_lot', v_cage, 'retainer_lot', v_ret));
      v_row_lot := v_src.finishing_lot;
    END IF;
    v_dest := (v_route->>'lot_id')::uuid;
  END IF;

  INSERT INTO public.program_ledger (program_id, part_id, stage, qty, lot_number, ref_lot_number, vendor, po_number,
                                     expected_return, entry_date, final_lot_id, from_lot_id, cage_lot, retainer_lot,
                                     done_by, notes, entered_by)
  VALUES (p_program_id, p_part_id, p_stage, p_qty, v_row_lot, v_ref, nullif(btrim(coalesce(p_vendor, '')), ''),
          nullif(btrim(coalesce(p_po, '')), ''), p_expected_return, coalesce(p_entry_date, current_date), v_dest, v_from,
          CASE WHEN p_stage = 'assembled' THEN v_cage END, CASE WHEN p_stage = 'assembled' THEN v_ret END,
          nullif(btrim(coalesce(p_done_by, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('program_ledger_entry', auth.uid(), jsonb_build_object('entry_id', v_id, 'program', v_prog.code, 'stage', p_stage,
          'qty', p_qty, 'lot', v_row_lot, 'from_lot_id', v_from, 'final_lot_id', v_dest, 'route', v_route));
  RETURN coalesce(v_route, '{}'::jsonb) || jsonb_build_object('entry_id', v_id);
END $$;

/* ---- program_void_entry: soft void; clears an attribute nothing supports any more; voids an empty branch ---- */
CREATE OR REPLACE FUNCTION public.program_void_entry(p_entry_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_e public.program_ledger%ROWTYPE; v_lot public.program_final_lots%ROWTYPE;
BEGIN
  PERFORM public._program_gate();
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'GUARD: a void reason is required'; END IF;
  SELECT * INTO v_e FROM public.program_ledger WHERE id = p_entry_id FOR UPDATE;
  IF v_e.id IS NULL THEN RAISE EXCEPTION 'GUARD: entry not found'; END IF;
  IF v_e.voided_at IS NOT NULL THEN RAISE EXCEPTION 'GUARD: entry already voided'; END IF;
  IF v_e.final_lot_id IS NOT NULL THEN
    SELECT * INTO v_lot FROM public.program_final_lots WHERE id = v_e.final_lot_id FOR UPDATE;
    IF v_lot.status = 'closed' THEN
      RAISE EXCEPTION 'GUARD: lot % is closed; reopen it before voiding its entries', v_lot.lot_number;
    END IF;
  END IF;

  UPDATE public.program_ledger SET voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason) WHERE id = p_entry_id;

  IF v_lot.id IS NOT NULL AND v_lot.status = 'active' THEN
    IF v_e.stage = 'washer_inserted' AND NOT EXISTS (SELECT 1 FROM public.program_ledger WHERE final_lot_id = v_lot.id AND stage = 'washer_inserted' AND voided_at IS NULL)
       AND v_lot.split_reason IS DISTINCT FROM 'nylon_lot' THEN
      UPDATE public.program_final_lots SET insert_lot = NULL, updated_at = now() WHERE id = v_lot.id;
    ELSIF v_e.stage = 'returned_plating' AND NOT EXISTS (SELECT 1 FROM public.program_ledger WHERE final_lot_id = v_lot.id AND stage = 'returned_plating' AND voided_at IS NULL)
       AND v_lot.split_reason IS DISTINCT FROM 'plating_lot' THEN
      UPDATE public.program_final_lots SET plating_lot = NULL, updated_at = now() WHERE id = v_lot.id;
    ELSIF v_e.stage = 'assembled' AND NOT EXISTS (SELECT 1 FROM public.program_ledger WHERE final_lot_id = v_lot.id AND stage = 'assembled' AND voided_at IS NULL)
       AND coalesce(v_lot.split_reason, '') <> ALL (ARRAY['cage_lot','retainer_lot','component_lots','after_close']) THEN
      UPDATE public.program_final_lots SET cage_lot = NULL, retainer_lot = NULL, updated_at = now() WHERE id = v_lot.id;
    END IF;
    /* a lot left with nothing at all (no live moves in or out, no batches, no children) is void */
    IF NOT EXISTS (SELECT 1 FROM public.program_ledger WHERE voided_at IS NULL AND (final_lot_id = v_lot.id OR from_lot_id = v_lot.id))
       AND NOT EXISTS (SELECT 1 FROM public.finishing_sends WHERE program_lot_id = v_lot.id OR program_dest_lot_id = v_lot.id)
       AND NOT EXISTS (SELECT 1 FROM public.program_final_lots WHERE parent_lot_id = v_lot.id AND status <> 'void') THEN
      UPDATE public.program_final_lots SET status = 'void', updated_at = now() WHERE id = v_lot.id;
    END IF;
  END IF;

  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('program_ledger_void', auth.uid(), jsonb_build_object('entry_id', p_entry_id, 'stage', v_e.stage, 'qty', v_e.qty,
          'lot', v_e.lot_number, 'final_lot_id', v_e.final_lot_id, 'reason', btrim(p_reason)));
END $$;

/* ---- assign_dry_film_fln: FLN at bake (unchanged rule) + route the batch to its branch ---- */
CREATE OR REPLACE FUNCTION public.assign_dry_film_fln(p_send_id uuid, p_operator_id uuid DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_send public.finishing_sends%ROWTYPE;
  v_fln text;
  v_src uuid;
  v_route jsonb;
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
   WHERE m.plating_lot_number = btrim(v_send.plating_lot_number) AND m.dry_film_lot_number = btrim(v_send.dry_film_lot_number);
  IF v_fln IS NULL THEN
    v_fln := 'FLN-' || lpad(public.next_finishing_lot_number()::text, 6, '0');
    INSERT INTO public.dry_film_lot_map (plating_lot_number, dry_film_lot_number, finishing_lot_number, created_by)
    VALUES (btrim(v_send.plating_lot_number), btrim(v_send.dry_film_lot_number), v_fln, p_operator_id)
    ON CONFLICT (plating_lot_number, dry_film_lot_number) DO NOTHING;
    SELECT m.finishing_lot_number INTO v_fln FROM public.dry_film_lot_map m
     WHERE m.plating_lot_number = btrim(v_send.plating_lot_number) AND m.dry_film_lot_number = btrim(v_send.dry_film_lot_number);
  END IF;

  UPDATE public.finishing_sends SET finishing_lot_number = v_fln, updated_at = now() WHERE id = p_send_id;
  UPDATE public.jobs SET finishing_lot_number = v_fln, updated_at = now() WHERE id = v_send.job_id;

  /* D-GIZA-24: the batch belongs to the branch it was painted from; a different dry-film lot splits it */
  IF v_send.program_id IS NOT NULL THEN
    v_src := v_send.program_lot_id;
    IF v_src IS NULL THEN   /* a batch created without a branch (typed lot): match on the plating lot */
      SELECT b.id INTO v_src FROM public.program_final_lots b
       WHERE b.program_id = v_send.program_id AND b.plating_lot = btrim(v_send.plating_lot_number) AND b.status IN ('active','closed')
       ORDER BY (b.status = 'active') DESC, (b.lot_number)::int LIMIT 1;
    END IF;
    IF v_src IS NOT NULL THEN
      v_route := public._program_route(v_src, 'bake', jsonb_build_object('dry_film_lot', btrim(v_send.dry_film_lot_number), 'finishing_lot', v_fln));
      UPDATE public.finishing_sends SET program_lot_id = v_src, program_dest_lot_id = (v_route->>'lot_id')::uuid WHERE id = p_send_id;
    END IF;
  END IF;
  RETURN v_fln;
END $$;

/* ---- program_plating_lots: per branch, plated pieces back from Electrolab not yet painted (kiosk picker) ---- */
CREATE OR REPLACE FUNCTION public.program_plating_lots(p_program_id uuid)
RETURNS TABLE (plating_lot_number text, nut_lots text, returned_qty bigint, painted_qty bigint, remaining bigint,
               last_returned date, lot_id uuid, lot_number text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH ret AS (
    SELECT l.final_lot_id, sum(l.qty)::bigint AS returned_qty, max(l.entry_date) AS last_returned
      FROM public.program_ledger l
     WHERE l.program_id = p_program_id AND l.stage = 'returned_plating' AND l.voided_at IS NULL AND l.final_lot_id IS NOT NULL
     GROUP BY l.final_lot_id
  ), painted AS (
    SELECT fs.program_lot_id, coalesce(sum(fs.incoming_count), 0)::bigint AS painted_qty
      FROM public.finishing_sends fs
     WHERE fs.program_id = p_program_id AND fs.standalone_operation_type = 'dry_film' AND fs.program_lot_id IS NOT NULL
     GROUP BY fs.program_lot_id
  )
  SELECT b.plating_lot, b.nut_lot, r.returned_qty, coalesce(p.painted_qty, 0),
         r.returned_qty - coalesce(p.painted_qty, 0), r.last_returned, b.id, b.lot_number
    FROM ret r
    JOIN public.program_final_lots b ON b.id = r.final_lot_id
    LEFT JOIN painted p ON p.program_lot_id = b.id
   WHERE r.returned_qty - coalesce(p.painted_qty, 0) > 0 AND b.status IN ('active','closed')
   ORDER BY r.last_returned, (b.lot_number)::int;
$$;

/* ---- program_close_final_lot: torsion + inspector, quantity frozen, trail copied to the cert arrays ---- */
CREATE OR REPLACE FUNCTION public.program_close_final_lot(p_lot_id uuid, p_torsion jsonb DEFAULT '{}'::jsonb,
                                                          p_inspected_by text DEFAULT NULL, p_notes text DEFAULT NULL)
RETURNS public.program_final_lots LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lot public.program_final_lots%ROWTYPE; v_qty integer;
BEGIN
  PERFORM public._program_gate();
  SELECT * INTO v_lot FROM public.program_final_lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN RAISE EXCEPTION 'GUARD: lot not found'; END IF;
  IF v_lot.status <> 'active' THEN RAISE EXCEPTION 'GUARD: lot % is %, not active', v_lot.lot_number, v_lot.status; END IF;
  SELECT coalesce(sum(qty), 0) INTO v_qty FROM public.program_ledger
   WHERE final_lot_id = p_lot_id AND stage = 'assembled' AND voided_at IS NULL;
  IF v_qty <= 0 THEN RAISE EXCEPTION 'GUARD: lot % has nothing assembled', v_lot.lot_number; END IF;

  UPDATE public.program_final_lots SET
    status = 'closed', closed_at = now(), closed_by = auth.uid(), quantity = v_qty,
    nut_lots = array_remove(ARRAY[nut_lot], NULL),
    plating_lots = array_remove(ARRAY[plating_lot], NULL),
    finishing_lots = array_remove(ARRAY[finishing_lot], NULL),
    torsion_1_qty = (p_torsion->>'t1_qty')::integer, torsion_1_inlbs = (p_torsion->>'t1_inlbs')::numeric,
    torsion_2_qty = (p_torsion->>'t2_qty')::integer, torsion_2_inlbs = (p_torsion->>'t2_inlbs')::numeric,
    inspected_by = nullif(btrim(coalesce(p_inspected_by, '')), ''),
    notes = coalesce(nullif(btrim(coalesce(p_notes, '')), ''), notes),
    updated_at = now()
  WHERE id = p_lot_id RETURNING * INTO v_lot;

  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('program_final_lot_closed', auth.uid(), jsonb_build_object('lot_id', p_lot_id, 'lot_number', v_lot.lot_number, 'quantity', v_qty,
          'nut_lot', v_lot.nut_lot, 'insert_lot', v_lot.insert_lot, 'plating_lot', v_lot.plating_lot, 'finishing_lot', v_lot.finishing_lot,
          'cage_lot', v_lot.cage_lot, 'retainer_lot', v_lot.retainer_lot));
  RETURN v_lot;
END $$;

/* ---- program_reopen_final_lot: admin; refused once its leftovers continued as another lot ---- */
CREATE OR REPLACE FUNCTION public.program_reopen_final_lot(p_lot_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lot public.program_final_lots%ROWTYPE; v_child text;
BEGIN
  PERFORM public._program_gate(ARRAY['admin']);
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'GUARD: a reason is required'; END IF;
  SELECT * INTO v_lot FROM public.program_final_lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN RAISE EXCEPTION 'GUARD: lot not found'; END IF;
  IF v_lot.status <> 'closed' THEN RAISE EXCEPTION 'GUARD: only a closed lot can be reopened'; END IF;
  SELECT lot_number INTO v_child FROM public.program_final_lots
   WHERE parent_lot_id = p_lot_id AND split_reason = 'after_close' AND status <> 'void' ORDER BY (lot_number)::int LIMIT 1;
  IF v_child IS NOT NULL THEN
    RAISE EXCEPTION 'GUARD: lot %''s remaining pieces already continued as lot %', v_lot.lot_number, v_child;
  END IF;
  UPDATE public.program_final_lots SET status = 'active', closed_at = NULL, closed_by = NULL, updated_at = now() WHERE id = p_lot_id;
  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('program_final_lot_reopened', auth.uid(), jsonb_build_object('lot_id', p_lot_id, 'lot_number', v_lot.lot_number, 'reason', btrim(p_reason)));
END $$;

/* ---- program_update_final_lot: historical lots take everything by hand; branch lots only torsion / inspector / notes ---- */
CREATE OR REPLACE FUNCTION public.program_update_final_lot(p_lot_id uuid, p_fields jsonb)
RETURNS public.program_final_lots LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lot public.program_final_lots%ROWTYPE; v_bad text; v_allowed text[];
BEGIN
  PERFORM public._program_gate();
  SELECT * INTO v_lot FROM public.program_final_lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN RAISE EXCEPTION 'GUARD: lot not found'; END IF;
  v_allowed := CASE WHEN v_lot.status = 'historical'
    THEN ARRAY['cage_lot','retainer_lot','insert_lot','nut_lots','plating_lots','finishing_lots','torsion_1_qty','torsion_1_inlbs',
               'torsion_2_qty','torsion_2_inlbs','inspected_by','notes','quantity']
    ELSE ARRAY['torsion_1_qty','torsion_1_inlbs','torsion_2_qty','torsion_2_inlbs','inspected_by','notes'] END;
  SELECT string_agg(k, ', ') INTO v_bad FROM jsonb_object_keys(coalesce(p_fields, '{}'::jsonb)) k WHERE k <> ALL (v_allowed);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'GUARD: not editable on a % lot: % (a branch''s lots are its trail)', v_lot.status, v_bad;
  END IF;
  UPDATE public.program_final_lots SET
    cage_lot        = CASE WHEN p_fields ? 'cage_lot' THEN nullif(btrim(p_fields->>'cage_lot'), '') ELSE cage_lot END,
    retainer_lot    = CASE WHEN p_fields ? 'retainer_lot' THEN nullif(btrim(p_fields->>'retainer_lot'), '') ELSE retainer_lot END,
    insert_lot      = CASE WHEN p_fields ? 'insert_lot' THEN nullif(btrim(p_fields->>'insert_lot'), '') ELSE insert_lot END,
    nut_lots        = CASE WHEN p_fields ? 'nut_lots' THEN ARRAY(SELECT jsonb_array_elements_text(p_fields->'nut_lots')) ELSE nut_lots END,
    plating_lots    = CASE WHEN p_fields ? 'plating_lots' THEN ARRAY(SELECT jsonb_array_elements_text(p_fields->'plating_lots')) ELSE plating_lots END,
    finishing_lots  = CASE WHEN p_fields ? 'finishing_lots' THEN ARRAY(SELECT jsonb_array_elements_text(p_fields->'finishing_lots')) ELSE finishing_lots END,
    torsion_1_qty   = CASE WHEN p_fields ? 'torsion_1_qty' THEN (p_fields->>'torsion_1_qty')::integer ELSE torsion_1_qty END,
    torsion_1_inlbs = CASE WHEN p_fields ? 'torsion_1_inlbs' THEN (p_fields->>'torsion_1_inlbs')::numeric ELSE torsion_1_inlbs END,
    torsion_2_qty   = CASE WHEN p_fields ? 'torsion_2_qty' THEN (p_fields->>'torsion_2_qty')::integer ELSE torsion_2_qty END,
    torsion_2_inlbs = CASE WHEN p_fields ? 'torsion_2_inlbs' THEN (p_fields->>'torsion_2_inlbs')::numeric ELSE torsion_2_inlbs END,
    inspected_by    = CASE WHEN p_fields ? 'inspected_by' THEN nullif(btrim(p_fields->>'inspected_by'), '') ELSE inspected_by END,
    notes           = CASE WHEN p_fields ? 'notes' THEN nullif(btrim(p_fields->>'notes'), '') ELSE notes END,
    quantity        = CASE WHEN p_fields ? 'quantity' THEN (p_fields->>'quantity')::integer ELSE quantity END,
    updated_at = now()
  WHERE id = p_lot_id RETURNING * INTO v_lot;
  INSERT INTO public.audit_logs (event_type, operator_id, details)
  VALUES ('program_final_lot_updated', auth.uid(), jsonb_build_object('lot_id', p_lot_id, 'lot_number', v_lot.lot_number, 'fields', p_fields));
  RETURN v_lot;
END $$;

REVOKE EXECUTE ON FUNCTION public._program_new_branch(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._program_route(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.program_log_entry(uuid, uuid, text, integer, text, uuid, text, text, text, text, date, date, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.program_void_entry(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.assign_dry_film_fln(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.program_plating_lots(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.program_close_final_lot(uuid, jsonb, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.program_reopen_final_lot(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.program_update_final_lot(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._program_new_branch(uuid, uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public._program_route(uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.program_log_entry(uuid, uuid, text, integer, text, uuid, text, text, text, text, date, date, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.program_void_entry(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assign_dry_film_fln(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.program_plating_lots(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.program_close_final_lot(uuid, jsonb, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.program_reopen_final_lot(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.program_update_final_lot(uuid, jsonb) TO authenticated, service_role;


/* ===================================== BLOCK 4 =====================================
   VIEWS. v_program_final_lots carries each branch's own buckets; v_program_pipeline drops Bagged.
   Revoke-then-grant so nothing inherits ALL.
   ================================================================================== */
DROP VIEW IF EXISTS public.v_program_final_lots;
CREATE VIEW public.v_program_final_lots WITH (security_invoker = true) AS
WITH led AS (
  SELECT final_lot_id, from_lot_id, stage, qty FROM public.program_ledger WHERE voided_at IS NULL
), inflow AS (
  SELECT final_lot_id AS lot_id,
         sum(qty) FILTER (WHERE stage = 'received')         AS rec_in,
         sum(qty) FILTER (WHERE stage = 'washer_inserted')  AS ins_in,
         sum(qty) FILTER (WHERE stage = 'sent_plating')     AS sent_in,
         sum(qty) FILTER (WHERE stage = 'returned_plating') AS ret_in,
         sum(qty) FILTER (WHERE stage = 'assembled')        AS asm_in
    FROM led WHERE final_lot_id IS NOT NULL GROUP BY final_lot_id
), outflow AS (
  SELECT from_lot_id AS lot_id,
         sum(qty) FILTER (WHERE stage = 'washer_inserted')  AS ins_out,
         sum(qty) FILTER (WHERE stage = 'sent_plating')     AS sent_out,
         sum(qty) FILTER (WHERE stage = 'returned_plating') AS ret_out,
         sum(qty) FILTER (WHERE stage = 'assembled')        AS asm_out
    FROM led WHERE from_lot_id IS NOT NULL GROUP BY from_lot_id
), fs_from AS (
  SELECT program_lot_id AS lot_id,
         sum(incoming_count) AS painted,
         sum(incoming_count) FILTER (WHERE status = 'in_finishing' AND finishing_stage = 'paint') AS in_paint,
         sum(incoming_count) FILTER (WHERE status = 'in_finishing' AND finishing_stage = 'bake')  AS in_oven
    FROM public.finishing_sends WHERE standalone_operation_type = 'dry_film' AND program_lot_id IS NOT NULL GROUP BY program_lot_id
), fs_dest AS (
  SELECT program_dest_lot_id AS lot_id,
         sum(verified_count) FILTER (WHERE status = 'finishing_complete') AS baked
    FROM public.finishing_sends WHERE standalone_operation_type = 'dry_film' AND program_dest_lot_id IS NOT NULL GROUP BY program_dest_lot_id
)
SELECT f.id, f.program_id, f.lot_number, f.status, f.origin, f.split_reason, f.parent_lot_id, par.lot_number AS parent_lot_number,
       f.opened_at, f.opened_by, f.closed_at, f.closed_by, f.quantity,
       f.nut_lot, f.insert_lot, f.plating_lot, f.dry_film_lot, f.finishing_lot, f.cage_lot, f.retainer_lot,
       f.nut_lots, f.plating_lots, f.finishing_lots,
       f.torsion_1_qty, f.torsion_1_inlbs, f.torsion_2_qty, f.torsion_2_inlbs, f.inspected_by, f.notes, f.updated_at,
       coalesce(i.rec_in, 0)  - coalesce(o.ins_out, 0)  AS waiting_insert,
       coalesce(i.ins_in, 0)  - coalesce(o.sent_out, 0) AS waiting_plating,
       coalesce(i.sent_in, 0) - coalesce(o.ret_out, 0)  AS at_electrolab,
       coalesce(i.ret_in, 0)  - coalesce(ff.painted, 0) AS waiting_paint,
       coalesce(ff.in_paint, 0) AS in_paint,
       coalesce(ff.in_oven, 0)  AS in_oven,
       coalesce(fd.baked, 0)  - coalesce(o.asm_out, 0)  AS waiting_assembly,
       coalesce(i.asm_in, 0) AS assembled_qty,
       (SELECT jsonb_agg(jsonb_build_object('id', l.id, 'date', l.entry_date, 'qty', l.qty, 'done_by', l.done_by,
                                            'cage_lot', l.cage_lot, 'retainer_lot', l.retainer_lot) ORDER BY l.entry_date, l.created_at)
          FROM public.program_ledger l WHERE l.final_lot_id = f.id AND l.stage = 'assembled' AND l.voided_at IS NULL) AS assembled_entries,
       (SELECT max(l.entry_date) FROM public.program_ledger l
         WHERE l.voided_at IS NULL AND (l.final_lot_id = f.id OR l.from_lot_id = f.id)) AS last_move
  FROM public.program_final_lots f
  LEFT JOIN public.program_final_lots par ON par.id = f.parent_lot_id
  LEFT JOIN inflow i   ON i.lot_id = f.id
  LEFT JOIN outflow o  ON o.lot_id = f.id
  LEFT JOIN fs_from ff ON ff.lot_id = f.id
  LEFT JOIN fs_dest fd ON fd.lot_id = f.id;

DROP VIEW IF EXISTS public.v_program_pipeline;
CREATE VIEW public.v_program_pipeline WITH (security_invoker = true) AS
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
), br AS (
  SELECT program_id,
         count(*) FILTER (WHERE status = 'active')::int AS active_lots,
         count(*) FILTER (WHERE status = 'closed')::int AS closed_lots
    FROM public.program_final_lots GROUP BY program_id
), q AS (
  SELECT p.id AS program_id, p.code, p.name, p.fb_product_num, p.oven_load_qty, p.final_lot_next, p.shipped_baseline,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'nut' AND stage = 'received'), 0)         AS nut_received,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'nut' AND stage = 'washer_inserted'), 0)  AS washer_inserted,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'nut' AND stage = 'sent_plating'), 0)     AS sent_plating,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'nut' AND stage = 'returned_plating'), 0) AS returned_plating,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'nut' AND stage = 'assembled'), 0)        AS assembled,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'cage' AND stage = 'received'), 0)        AS cage_received,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'retainer' AND stage = 'received'), 0)    AS retainer_received,
         coalesce((SELECT qty FROM led WHERE led.program_id = p.id AND role = 'insert' AND stage = 'received'), 0)      AS insert_received,
         coalesce((SELECT qty_per FROM public.program_parts WHERE program_id = p.id AND role = 'cage'), 1)     AS cage_per,
         coalesce((SELECT qty_per FROM public.program_parts WHERE program_id = p.id AND role = 'retainer'), 1) AS retainer_per,
         coalesce((SELECT qty_per FROM public.program_parts WHERE program_id = p.id AND role = 'insert'), 1)   AS insert_per,
         coalesce(fs.painted, 0) AS painted, coalesce(fs.in_paint, 0) AS in_paint, coalesce(fs.in_oven, 0) AS in_oven,
         coalesce(fs.completed_in, 0) AS completed_in, coalesce(fs.baked, 0) AS baked, coalesce(fs.active_batches, 0) AS active_batches,
         coalesce(dem.ordered, 0) AS ordered, coalesce(dem.fulfilled, 0) AS fulfilled, coalesce(dem.open_qty, 0) AS open_qty, dem.earliest_due,
         ov.ovens_commissioned, ov.ovens_total,
         coalesce(br.active_lots, 0) AS active_lots, coalesce(br.closed_lots, 0) AS closed_lots
    FROM public.programs p
    LEFT JOIN fs ON fs.program_id = p.id
    LEFT JOIN dem ON dem.program_id = p.id
    LEFT JOIN br ON br.program_id = p.id
    CROSS JOIN ov
   WHERE p.is_active
)
SELECT q.*,
       (fulfilled - shipped_baseline)                  AS shipped_since_start,
       nut_received - washer_inserted                  AS waiting_washer,
       washer_inserted - sent_plating                  AS waiting_plating,
       sent_plating - returned_plating                 AS at_electrolab,
       returned_plating - painted                      AS waiting_paint,
       baked - assembled                               AS waiting_assembly,
       assembled - (fulfilled - shipped_baseline)      AS waiting_ship,
       completed_in - baked                            AS dry_film_loss,
       insert_received - washer_inserted * insert_per  AS insert_on_hand,
       cage_received - assembled * cage_per            AS cage_on_hand,
       retainer_received - assembled * retainer_per    AS retainer_on_hand,
       least(baked - assembled,
             (cage_received - assembled * cage_per) / cage_per,
             (retainer_received - assembled * retainer_per) / retainer_per) AS buildable_sets,
       ovens_commissioned * oven_load_qty              AS oven_load_capacity
  FROM q;

REVOKE ALL ON public.v_program_final_lots, public.v_program_pipeline FROM authenticated, anon, public;
GRANT SELECT ON public.v_program_final_lots, public.v_program_pipeline TO authenticated, service_role;


/* ===================================== BLOCK 5 =====================================
   VERIFY (read-only). Expected values in the header.
   ================================================================================== */
SELECT jsonb_build_object(
  'branch_columns', (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'program_final_lots'
                      AND column_name IN ('parent_lot_id','origin','split_reason','nut_lot','plating_lot','dry_film_lot','finishing_lot')),
  'ledger_columns', (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'program_ledger'
                      AND column_name IN ('from_lot_id','cage_lot','retainer_lot')),
  'send_columns', (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'finishing_sends'
                    AND column_name IN ('program_lot_id','program_dest_lot_id')),
  'open_fn_gone', (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                       WHERE n.nspname = 'public' AND p.proname = 'program_open_final_lot')),
  'fn_count', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname IN ('_program_gate','_program_new_branch','_program_route','assign_dry_film_fln',
                  'program_plating_lots','program_log_entry','program_void_entry','program_close_final_lot','program_reopen_final_lot',
                  'program_update_final_lot')),
  'view_count', (SELECT count(*) FROM pg_views WHERE schemaname = 'public'
                  AND viewname IN ('v_program_demand','v_program_pipeline','v_program_daily','v_program_final_lots')),
  'status_check_has_active', (SELECT bool_or(pg_get_constraintdef(oid) ILIKE '%active%') FROM pg_constraint
                               WHERE conrelid = 'public.program_final_lots'::regclass AND conname = 'program_final_lots_status_check'),
  'stage_check_has_bagged', (SELECT bool_or(pg_get_constraintdef(oid) ILIKE '%bagged%') FROM pg_constraint
                              WHERE conrelid = 'public.program_ledger'::regclass AND conname = 'program_ledger_stage_check'),
  'anon_can_exec', (SELECT bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND (p.proname LIKE 'program\_%' OR p.proname LIKE '\_program\_%')),
  'anon_can_select', (SELECT bool_or(has_table_privilege('anon', 'public.' || v, 'SELECT')) FROM unnest(ARRAY['v_program_final_lots','v_program_pipeline']) v),
  'helpers_private', (SELECT NOT bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE')) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname = 'public' AND p.proname IN ('_program_new_branch','_program_route')),
  'final_lot_next', (SELECT final_lot_next FROM public.programs WHERE code = 'GIZA-21077'),
  'lots_by_status', (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM public.program_final_lots GROUP BY status) x)
) AS verify;
