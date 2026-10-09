/* =====================================================================================
   2026-10-09_kit_packing_slip_promotion.sql
   Promotes the packing-slip back end (D-KSTC-28 / D-KSTC-29) to PROD. It was built and
   tested on TEST in August (2026-08-03_kit_packing_slip.sql) but never reached PROD, so
   every slip upload on PROD has failed since: Ashley Hall's report, 2026-10-09.

   WHAT (each item read from TEST's live catalog 2026-10-09; table shapes already match)
     1. kit_stc_documents.document_type CHECK gains 'packing_slip'.
     2. public.kit_record_component_lots(...)  -- records a slip's component lots.
     3. public.kit_find_lots_by_so(text)        -- Packing Slip tab: SO -> kit lots.
        Both bodies are TEST's, with line comments turned into block comments and one
        em dash in an error message made ASCII (SQL Editor paste rules). Behaviour is
        identical. TEST was re-applied with this exact text, so TEST and PROD carry the
        same md5 (BLOCK 3 checks it).
     4. Policies: kit_stc_documents_insert_kiosk_slip (bench slip attach),
        klcl_update_master / klcl_delete_master (admin + compliance corrections).
     Grants per D-KSTC-13: REVOKE PUBLIC and anon; GRANT authenticated, service_role.

   NOT IN THIS FILE: the Edge Function packing-slip-extract (reads the slip). It is not
   deployed on PROD either and must be deployed separately -- see the chat round.

   RUN ORDER (Supabase SQL Editor -- ONE BLOCK PER RUN, never the whole sheet)
     BLOCK 0  preview (read-only)      PROD expect: missing_fns 2, doc_type_has_slip false,
                                       missing_policies 3, slip_docs 0
     -- REVIEW STOP: paste BLOCK 0 output back before BLOCK 1 --
     BLOCK 1  apply                    expect: success, no rows
     BLOCK 2  smoke (writes, then      expect: an ERROR whose text starts SMOKE_OK
              RAISES to roll back)     (SMOKE_FAIL = stop and report)
     BLOCK 3  verify (read-only)       expect: every *_ok true
     The editor runs a sheet as one transaction: BLOCK 2's deliberate RAISE would undo
     BLOCK 1 if run together.

   ENVIRONMENTS
     TEST (ylzmyjjqibpbqbwjsnqj): BLOCK 1 applied by Claude 2026-10-09 (re-applied over
       the August objects to align the text), BLOCKS 2-3 run; results in the conversation.
     PROD (luzungoqfuplspzbqctb): Matt runs BLOCK 0, review stop, then 1, 2, 3.
   ===================================================================================== */


/* ------------------------------- BLOCK 0 : preview --------------------------------- */

SELECT jsonb_build_object(
  'missing_fns', 2 - (SELECT count(*) FROM pg_proc
                      WHERE pronamespace = 'public'::regnamespace
                        AND proname IN ('kit_record_component_lots', 'kit_find_lots_by_so')),
  'doc_type_has_slip', (SELECT pg_get_constraintdef(oid) LIKE '%packing_slip%' FROM pg_constraint
                        WHERE conrelid = 'public.kit_stc_documents'::regclass
                          AND conname = 'kit_stc_documents_document_type_check'),
  'missing_policies', 3 - (SELECT count(*) FROM pg_policies
                           WHERE schemaname = 'public'
                             AND policyname IN ('kit_stc_documents_insert_kiosk_slip',
                                                'klcl_update_master', 'klcl_delete_master')),
  'slip_docs', (SELECT count(*) FROM public.kit_stc_documents WHERE document_type = 'packing_slip'),
  'doc_types_in_use', (SELECT jsonb_object_agg(document_type, n) FROM
                        (SELECT document_type, count(*) n FROM public.kit_stc_documents GROUP BY 1) s),
  'user_has_role_exists', EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                                    AND proname = 'user_has_role')
) AS preview;


/* ------------------------------- BLOCK 1 : apply ----------------------------------- */

ALTER TABLE public.kit_stc_documents
  DROP CONSTRAINT IF EXISTS kit_stc_documents_document_type_check;
ALTER TABLE public.kit_stc_documents
  ADD CONSTRAINT kit_stc_documents_document_type_check
  CHECK (document_type = ANY (ARRAY['request_email'::text, 'order_form'::text, 'invoice'::text,
         'form_337'::text, 'photo'::text, 'issued_doc'::text, 'packing_slip'::text, 'other'::text]));

CREATE OR REPLACE FUNCTION public.kit_record_component_lots(
  p_kit_lot_id uuid, p_shipment_number text, p_ship_date date, p_lines jsonb,
  p_operator_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lot record;
  v_line jsonb;
  v_part text;
  v_lot_no text;
  v_qty numeric;
  v_so_line integer;
  v_component_id uuid;
  v_shipment text;
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_rows integer;
BEGIN
  SELECT kl.id, kl.record_status INTO v_lot
  FROM public.kit_lots kl WHERE kl.id = p_kit_lot_id;

  IF v_lot.id IS NULL THEN
    RAISE EXCEPTION 'Unknown kit lot %', p_kit_lot_id;
  END IF;
  IF v_lot.record_status <> 'active'::text THEN
    RAISE EXCEPTION 'Kit lot % is % - component lots may only be recorded against an active lot',
      p_kit_lot_id, v_lot.record_status;
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'p_lines must be a JSON array of component lines';
  END IF;

  v_shipment := NULLIF(btrim(COALESCE(p_shipment_number, '')), '')::text;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    v_part   := btrim(COALESCE(v_line->>'part_number', ''))::text;
    v_lot_no := btrim(COALESCE(v_line->>'lot_number', ''))::text;

    /* As-written strings are the record (D-KSTC-24); a line missing either half
       of the identity isn't a record, it's a blank row. */
    IF v_part = '' OR v_lot_no = '' THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_qty := NULLIF(btrim(COALESCE(v_line->>'qty', '')), '')::numeric;
    v_so_line := NULLIF(regexp_replace(
      COALESCE(v_line->>'so_line_no', ''), '\D', '', 'g'), '')::integer;

    /* The loader's normalization, to the letter: upper + collapsed whitespace,
       lowest id wins where kit_components holds duplicates (the loader's
       DISTINCT ON (part_norm) ORDER BY part_norm, id guard). A miss is normal -
       component_id is a convenience link, not the record. */
    SELECT kc.id INTO v_component_id
    FROM public.kit_components kc
    WHERE upper(regexp_replace(kc.part_number, '\s+', ' ', 'g'))
        = upper(regexp_replace(v_part, '\s+', ' ', 'g'))
    ORDER BY kc.id
    LIMIT 1;

    INSERT INTO public.kit_lot_component_lots
      (kit_lot_id, component_id, part_number_as_written, lot_number_as_written,
       qty_shipped, ship_date, shipment_number, so_line_no, source, created_by)
    VALUES (p_kit_lot_id, v_component_id, v_part::text, v_lot_no::text,
            v_qty::numeric, p_ship_date, v_shipment, v_so_line,
            'packing_slip'::text, p_operator_id)
    ON CONFLICT ON CONSTRAINT klcl_unique DO NOTHING;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      v_inserted := v_inserted + 1;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('inserted', v_inserted, 'skipped', v_skipped);
END $function$;

CREATE OR REPLACE FUNCTION public.kit_find_lots_by_so(p_so text)
 RETURNS TABLE(kit_lot_id uuid, matched_via text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_so text;
BEGIN
  v_so := NULLIF(regexp_replace(COALESCE(p_so, ''), '\D', '', 'g'), '')::text;
  IF v_so IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT kl.id,
           NULLIF(regexp_replace(
             COALESCE(ks.so_number, kl.so_as_written, ''), '\D', '', 'g'), '')::text AS so_digits,
           NULLIF(regexp_replace(
             COALESCE(kl.invoice_as_written, ''), '\D', '', 'g'), '')::text AS invoice_digits
    FROM public.kit_lots kl
    LEFT JOIN public.kit_sale_lines ksl ON ksl.id = kl.kit_sale_line_id
    LEFT JOIN public.kit_sales ks       ON ks.id  = ksl.kit_sale_id
    WHERE kl.record_status = 'active'::text
  ),
  candidates AS (
    SELECT b.id, 'direct'::text AS via, 1 AS prio
    FROM base b WHERE b.so_digits = v_so
    UNION ALL
    /* Only where no SO was captured at all: a lot that HAS an SO and disagrees
       is a different shipment, not an invoice-numbered match. */
    SELECT b.id, 'invoice_direct'::text, 2
    FROM base b WHERE b.so_digits IS NULL AND b.invoice_digits = v_so
  )
  SELECT DISTINCT ON (c.id) c.id, c.via
  FROM candidates c
  ORDER BY c.id, c.prio;
END $function$;

REVOKE ALL ON FUNCTION public.kit_record_component_lots(uuid, text, date, jsonb, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.kit_record_component_lots(uuid, text, date, jsonb, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.kit_record_component_lots(uuid, text, date, jsonb, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.kit_find_lots_by_so(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.kit_find_lots_by_so(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.kit_find_lots_by_so(text) TO authenticated, service_role;

DROP POLICY IF EXISTS kit_stc_documents_insert_kiosk_slip ON public.kit_stc_documents;
CREATE POLICY kit_stc_documents_insert_kiosk_slip ON public.kit_stc_documents
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((document_type = 'packing_slip'::text) AND (kit_lot_id IS NOT NULL));

DROP POLICY IF EXISTS klcl_update_master ON public.kit_lot_component_lots;
CREATE POLICY klcl_update_master ON public.kit_lot_component_lots
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text]))
  WITH CHECK (user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text]));

DROP POLICY IF EXISTS klcl_delete_master ON public.kit_lot_component_lots;
CREATE POLICY klcl_delete_master ON public.kit_lot_component_lots
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text]));


/* ------------------------------- BLOCK 2 : smoke ----------------------------------- */
/* Records a fake two-line slip against the newest active bench lot that has an SO,
   re-records it (must be idempotent), finds the lot by its SO, files a packing_slip
   document row, then RAISES so everything rolls back. Assignments only (no SELECT INTO)
   for the SQL Editor DO-block rewrite. */

DO $smoke$
DECLARE
  v_lot uuid;
  v_so text;
  v_first jsonb;
  v_second jsonb;
  v_found integer;
  v_doc uuid;
  v_verdict text;
BEGIN
  v_lot := (SELECT id FROM public.kit_lots
            WHERE record_status = 'active' AND source = 'skynet' AND so_as_written ~ '[0-9]'
            ORDER BY created_at DESC LIMIT 1);
  IF v_lot IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no active bench lot with an SO to test against';
  END IF;
  v_so := (SELECT so_as_written FROM public.kit_lots WHERE id = v_lot);

  v_first := public.kit_record_component_lots(v_lot, 'SMOKE-PROMO', CURRENT_DATE,
    '[{"part_number":"SMOKE-PART-PROMO","lot_number":"SMOKE-LOT-1","qty":"5","so_line_no":"L3"},
      {"part_number":"","lot_number":"blank row"}]'::jsonb, NULL);
  v_second := public.kit_record_component_lots(v_lot, 'SMOKE-PROMO', CURRENT_DATE,
    '[{"part_number":"SMOKE-PART-PROMO","lot_number":"SMOKE-LOT-1","qty":"5","so_line_no":"L3"}]'::jsonb, NULL);

  v_found := (SELECT count(*) FROM public.kit_find_lots_by_so(v_so) f WHERE f.kit_lot_id = v_lot);

  INSERT INTO public.kit_stc_documents (kit_lot_id, document_type, file_name, file_path)
  VALUES (v_lot, 'packing_slip', 'smoke.pdf', 'kit-stc/lots/smoke/packing-slips/smoke.pdf')
  RETURNING id INTO v_doc;

  v_verdict := CASE
    WHEN (v_first->>'inserted')::int = 1 AND (v_first->>'skipped')::int = 1
     AND (v_second->>'inserted')::int = 0 AND (v_second->>'skipped')::int = 1
     AND v_found = 1 AND v_doc IS NOT NULL
    THEN 'SMOKE_OK' ELSE 'SMOKE_FAIL' END;

  RAISE EXCEPTION '%: lot_so=% first=% second=% found_by_so=% slip_doc_row=% (all rolled back)',
    v_verdict, v_so, v_first::text, v_second::text, v_found, (v_doc IS NOT NULL);
END
$smoke$;


/* ------------------------------- BLOCK 3 : verify ---------------------------------- */
/* Read-only. The md5 references are TEST's after this file's BLOCK 1 (2026-10-09), taken
   with carriage returns stripped so a paste's line endings cannot fail the check.
   Expect smoke_rows_left 0. */

SELECT jsonb_build_object(
  'record_md5_ok', (SELECT md5(replace(pg_get_functiondef(oid), chr(13), '')) FROM pg_proc
                    WHERE pronamespace = 'public'::regnamespace AND proname = 'kit_record_component_lots')
                   = 'cda66c2f98b1c2f5aa23436634dfeedf',
  'find_md5_ok', (SELECT md5(replace(pg_get_functiondef(oid), chr(13), '')) FROM pg_proc
                  WHERE pronamespace = 'public'::regnamespace AND proname = 'kit_find_lots_by_so')
                 = 'e45d51c65b027637c26114450c8f4ceb',
  'anon_blocked_ok', NOT has_function_privilege('anon',
                       'public.kit_record_component_lots(uuid,text,date,jsonb,uuid)', 'EXECUTE')
                     AND NOT has_function_privilege('anon', 'public.kit_find_lots_by_so(text)', 'EXECUTE'),
  'authenticated_ok', has_function_privilege('authenticated',
                        'public.kit_record_component_lots(uuid,text,date,jsonb,uuid)', 'EXECUTE')
                      AND has_function_privilege('authenticated', 'public.kit_find_lots_by_so(text)', 'EXECUTE'),
  'doc_type_ok', (SELECT pg_get_constraintdef(oid) LIKE '%packing_slip%' FROM pg_constraint
                  WHERE conrelid = 'public.kit_stc_documents'::regclass
                    AND conname = 'kit_stc_documents_document_type_check'),
  'policies_ok', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
                  AND policyname IN ('kit_stc_documents_insert_kiosk_slip',
                                     'klcl_update_master', 'klcl_delete_master')) = 3,
  'smoke_rows_left', (SELECT count(*) FROM public.kit_lot_component_lots
                      WHERE part_number_as_written = 'SMOKE-PART-PROMO')
                   + (SELECT count(*) FROM public.kit_stc_documents WHERE file_name = 'smoke.pdf')
) AS verify;
