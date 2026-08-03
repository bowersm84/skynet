-- =============================================================================
-- Packing-slip capture at ship time (D-KSTC-28)
--
-- The warehouse uploads the Fishbowl packing slip when a kit ships; the slip is
-- extracted, matched to the kit lot(s) by SO, and its component lot numbers are
-- recorded in kit_lot_component_lots. This migration carries everything the
-- database side of that flow needs:
--
--   1. kit_stc_documents.document_type gains 'packing_slip'
--   2. kit_stc_documents INSERT for the bench station (kiosk JWT)
--   3. kit_lot_component_lots UPDATE / DELETE correction policies
--   4. kit_find_lots_by_so   — SO -> candidate kit lots
--   5. kit_record_component_lots — the sole write path for slip-sourced rows
--
-- Run: TEST first, then PROD at promotion. Single transaction.
--   & C:\pgsql\bin\psql.exe $env:TEST_DB_URL -f Docs\migrations\2026-08-03_kit_packing_slip.sql
-- =============================================================================
BEGIN;

-- -----------------------------------------------------------------------------
-- 1. document_type gains 'packing_slip'
-- -----------------------------------------------------------------------------
-- Drop + re-add rather than a new constraint: the CHECK is a single enumeration
-- and every existing value is carried forward verbatim, so no row can be
-- invalidated by the swap.
ALTER TABLE public.kit_stc_documents
  DROP CONSTRAINT IF EXISTS kit_stc_documents_document_type_check;

ALTER TABLE public.kit_stc_documents
  ADD CONSTRAINT kit_stc_documents_document_type_check
  CHECK (document_type = ANY (ARRAY[
    'request_email'::text, 'order_form'::text, 'invoice'::text, 'form_337'::text,
    'photo'::text, 'issued_doc'::text, 'packing_slip'::text, 'other'::text]));

-- -----------------------------------------------------------------------------
-- 2. kit_stc_documents INSERT from the bench station
-- -----------------------------------------------------------------------------
-- The existing INSERT policies both test auth.uid() (workflow role, or
-- is_salesperson). The bench runs on a kiosk JWT whose auth.uid() is the
-- device's anchor operator, not the person at the station — the same reality
-- kit_lots_insert_kiosk records (D-KSTC-07 / D-RLS-DOWNTIME01). Without this the
-- component lots would save (their RPC is SECURITY DEFINER) while the slip
-- itself was silently refused.
--
-- Scoped exactly like kit_lots_insert_kiosk: a narrow WITH CHECK on the row's
-- own content, claiming no identity. A bench station may file a packing slip
-- against a kit lot and nothing else; every other document type stays office
-- work under the policies above.
CREATE POLICY kit_stc_documents_insert_kiosk_slip ON public.kit_stc_documents
  FOR INSERT TO authenticated
  WITH CHECK (document_type = 'packing_slip'::text AND kit_lot_id IS NOT NULL);

-- -----------------------------------------------------------------------------
-- 3. kit_lot_component_lots corrections (D-KSTC-24 deferred these to this round)
-- -----------------------------------------------------------------------------
-- Expression style copied from the registry schema's *_update_master policies.
-- INSERT stays deliberately absent: every write path is RPC- or psql-mediated
-- (the backfill loader, kit_record_component_lots), so a stray client insert has
-- no route in. DELETE is granted to compliance as well as admin here — a
-- mis-transcribed lot number on a shipped kit is compliance's to retract, and
-- the sibling delete-admin-only policies predate this table having a correction
-- story at all.
CREATE POLICY klcl_update_master ON public.kit_lot_component_lots
  FOR UPDATE TO authenticated
  USING (public.user_has_role(auth.uid(), 'admin', 'compliance'))
  WITH CHECK (public.user_has_role(auth.uid(), 'admin', 'compliance'));

CREATE POLICY klcl_delete_master ON public.kit_lot_component_lots
  FOR DELETE TO authenticated
  USING (public.user_has_role(auth.uid(), 'admin', 'compliance'));

-- -----------------------------------------------------------------------------
-- 4. kit_find_lots_by_so
-- -----------------------------------------------------------------------------
-- Which kit lots does this packing slip's order number belong to? Same
-- resolution the backfill loader uses (D-KSTC-25 / D-KSTC-27), minus the
-- fishbowl_invoices bridge — the slip hands us the SO directly, so the bridge
-- (invoice number -> SO) has nothing to add:
--
--   'direct'          linked sale's so_number, else so_as_written
--   'invoice_direct'  invoice_as_written read AS the SO, because Fishbowl
--                     invoice numbers inherit the SO number (D-KSTC-27)
--
-- One row per lot, best path winning. Returns ids only; the client hydrates
-- full rows through the existing kitRegistry loaders, so this function never
-- has to know what a lot row looks like on screen.
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
    -- Only where no SO was captured at all: a lot that HAS an SO and disagrees
    -- is a different shipment, not an invoice-numbered match.
    SELECT b.id, 'invoice_direct'::text, 2
    FROM base b WHERE b.so_digits IS NULL AND b.invoice_digits = v_so
  )
  SELECT DISTINCT ON (c.id) c.id, c.via
  FROM candidates c
  ORDER BY c.id, c.prio;
END $function$;

REVOKE ALL ON FUNCTION public.kit_find_lots_by_so(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.kit_find_lots_by_so(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.kit_find_lots_by_so(text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. kit_record_component_lots
-- -----------------------------------------------------------------------------
-- The operator-confirmed grid, written. What arrives here is what a human
-- approved on screen — never the raw extraction (D-KSTC-28).
--
-- Idempotent by the table's own unique key: re-uploading the same slip, or two
-- benches racing on one shipment, inserts nothing the second time and reports it
-- as skipped rather than failing. That makes the whole flow safe to retry.
--
-- p_operator_id follows kit_assign_and_log exactly: the caller resolves the PIN
-- (kiosk) or the session profile (office) and hands the id in, because on a
-- kiosk JWT created_by never equals auth.uid(). The profiles FK is the guard, as
-- it is there — nothing is re-validated here that the constraint already proves.
CREATE OR REPLACE FUNCTION public.kit_record_component_lots(
  p_kit_lot_id uuid,
  p_shipment_number text,
  p_ship_date date,
  p_lines jsonb,
  p_operator_id uuid DEFAULT NULL)
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
    RAISE EXCEPTION 'Kit lot % is % — component lots may only be recorded against an active lot',
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

    -- As-written strings are the record (D-KSTC-24); a line missing either half
    -- of the identity isn't a record, it's a blank row.
    IF v_part = '' OR v_lot_no = '' THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_qty := NULLIF(btrim(COALESCE(v_line->>'qty', '')), '')::numeric;
    v_so_line := NULLIF(regexp_replace(
      COALESCE(v_line->>'so_line_no', ''), '\D', '', 'g'), '')::integer;

    -- The loader's normalization, to the letter: upper + collapsed whitespace,
    -- lowest id wins where kit_components holds duplicates (the loader's
    -- DISTINCT ON (part_norm) ORDER BY part_norm, id guard). A miss is normal —
    -- component_id is a convenience link, not the record.
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

REVOKE ALL ON FUNCTION public.kit_record_component_lots(uuid, text, date, jsonb, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.kit_record_component_lots(uuid, text, date, jsonb, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.kit_record_component_lots(uuid, text, date, jsonb, uuid)
  TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Verification (last statement)
-- -----------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'public.kit_stc_documents'::regclass
      AND conname = 'kit_stc_documents_document_type_check'
      AND pg_get_constraintdef(oid) LIKE '%packing_slip%')            AS doc_type_extended,
  (SELECT count(*) FROM pg_policies
    WHERE tablename = 'kit_stc_documents'
      AND policyname = 'kit_stc_documents_insert_kiosk_slip')          AS kiosk_slip_policy,
  (SELECT count(*) FROM pg_policies
    WHERE tablename = 'kit_lot_component_lots'
      AND policyname IN ('klcl_update_master', 'klcl_delete_master'))  AS klcl_correction_policies,
  (SELECT count(*) FROM pg_proc
    WHERE proname IN ('kit_find_lots_by_so', 'kit_record_component_lots')
      AND prosecdef)                                                   AS secdef_rpcs,
  (SELECT count(*) FROM information_schema.routine_privileges
    WHERE routine_name IN ('kit_find_lots_by_so', 'kit_record_component_lots')
      AND grantee = 'authenticated' AND privilege_type = 'EXECUTE')     AS grants_authenticated,
  (SELECT count(*) FROM information_schema.routine_privileges
    WHERE routine_name IN ('kit_find_lots_by_so', 'kit_record_component_lots')
      AND grantee = 'anon')                                            AS grants_anon_must_be_zero;

COMMIT;
