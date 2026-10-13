/* =====================================================================================
   2026-10-15_giza_fln_at_start.sql  --  D-GIZA-03a. TEST applied by Claude; PROD by Matt.

   A dry-film batch now gets its finishing lot number (FLN) the moment it starts, not after
   Bake. The rule is unchanged: same plating lot + same dry-film lot = same FLN. The kiosk
   change that calls this at batch start ships in 2026-10-15_D-GIZA_FLN_at_start_CC_Prompt.md.

   BLOCK 2 changes assign_dry_film_fln so that, when a batch already has its FLN, a later call
   still attaches the batch to its Giza lot if it has none yet (a batch started from a typed
   plating lot before that lot was logged back from Electrolab). Nothing else changes.

   BLOCK 3 assigns the FLN now to every dry-film batch that has none, and attaches each to its
   Giza lot. On PROD that is J-FIN-000033 (plating 52035, dry film 52000, 2,016 pcs, Oven 2):
   it gets a new FLN and lands on lot 3009, the lot holding plating lot 52035.

   One block at a time. BLOCK 1 and BLOCK 4 are read-only.
   ===================================================================================== */


/* ===================================== BLOCK 1 =====================================
   PREVIEW. PROD expect: needs_fln 1 (J-FIN-000033), lot_for_52035 "3009", lot_map_rows 0.
   ================================================================================== */
SELECT jsonb_build_object(
  'needs_fln', (SELECT jsonb_agg(jsonb_build_object('job', j.job_number, 'status', fs.status, 'stage', fs.finishing_stage,
                  'plating', fs.plating_lot_number, 'dry_film', fs.dry_film_lot_number, 'qty', fs.incoming_count))
                  FROM public.finishing_sends fs JOIN public.jobs j ON j.id = fs.job_id
                 WHERE fs.standalone_operation_type = 'dry_film'
                   AND (fs.finishing_lot_number IS NULL OR (fs.program_id IS NOT NULL AND fs.program_dest_lot_id IS NULL))),
  'lot_for_52035', (SELECT string_agg(lot_number, ',') FROM public.program_final_lots WHERE plating_lot = '52035' AND status IN ('active','closed')),
  'lot_map_rows', (SELECT count(*) FROM public.dry_film_lot_map)
) AS preview;


/* ===================================== BLOCK 2 =====================================
   FUNCTION: FLN once; attach to a Giza lot whenever the batch has none yet.
   ================================================================================== */
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

  v_fln := v_send.finishing_lot_number;
  IF v_fln IS NULL THEN
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
  END IF;

  /* D-GIZA-24 / 03a: attach to the Giza lot it was painted from; a different dry-film lot splits it.
     Retried on every call until the batch has a lot, so a batch started before its plating lot
     was logged attaches the next time it is touched. */
  IF v_send.program_id IS NOT NULL AND v_send.program_dest_lot_id IS NULL
     AND coalesce(btrim(v_send.dry_film_lot_number), '') <> '' THEN
    v_src := v_send.program_lot_id;
    IF v_src IS NULL AND coalesce(btrim(v_send.plating_lot_number), '') <> '' THEN
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

REVOKE EXECUTE ON FUNCTION public.assign_dry_film_fln(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_dry_film_fln(uuid, uuid) TO authenticated, service_role;


/* ===================================== BLOCK 3 =====================================
   ASSIGN NOW: every dry-film batch without an FLN, or without its Giza lot.
   ================================================================================== */
DO $$
DECLARE r record; v_fln text; n int := 0;
BEGIN
  FOR r IN SELECT fs.id, j.job_number FROM public.finishing_sends fs JOIN public.jobs j ON j.id = fs.job_id
            WHERE fs.standalone_operation_type = 'dry_film'
              AND coalesce(btrim(fs.plating_lot_number), '') <> '' AND coalesce(btrim(fs.dry_film_lot_number), '') <> ''
              AND (fs.finishing_lot_number IS NULL OR (fs.program_id IS NOT NULL AND fs.program_dest_lot_id IS NULL))
            ORDER BY fs.finishing_started_at LOOP
    v_fln := public.assign_dry_film_fln(r.id, NULL);
    n := n + 1;
    RAISE NOTICE '% -> %', r.job_number, v_fln;
  END LOOP;
  RAISE NOTICE 'batches updated: %', n;
END $$;


/* ===================================== BLOCK 4 =====================================
   VERIFY. PROD expect: J-FIN-000033 has an FLN on the batch and the job, lot "3009";
   lot 3009 dry film 52000 and that FLN, waiting_paint 7813, in_oven 2016.
   ================================================================================== */
SELECT jsonb_build_object(
  'batches', (SELECT jsonb_agg(jsonb_build_object('job', j.job_number, 'fln', fs.finishing_lot_number, 'job_fln', j.finishing_lot_number,
                'lot', l.lot_number, 'stage', fs.finishing_stage, 'status', fs.status))
                FROM public.finishing_sends fs JOIN public.jobs j ON j.id = fs.job_id
                LEFT JOIN public.program_final_lots l ON l.id = fs.program_dest_lot_id
               WHERE fs.standalone_operation_type = 'dry_film'),
  'lot_3009', (SELECT jsonb_build_object('dry_film', dry_film_lot, 'fln', finishing_lot, 'waiting_paint', waiting_paint, 'in_oven', in_oven)
                 FROM public.v_program_final_lots WHERE lot_number = '3009'),
  'still_missing', (SELECT count(*) FROM public.finishing_sends WHERE standalone_operation_type = 'dry_film' AND finishing_lot_number IS NULL)
) AS verify;
