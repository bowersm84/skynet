/* ===================================================================================== */
/* 2026-10-28_customer_program_bob.sql — S16 Batch C, Uncle Bob on the customer dashboard */
/* (D-CPROG-13, 14, 16). Run AFTER the Batch B file. Same file on TEST and PROD. */
/* */
/* Matt's ruling, Oct 28 (D-CPROG-16): Uncle Bob may read customer email text, except */
/*   (1) any message carrying an export-control or CUI marking — excluded automatically */
/*       by the trigger below, now and for every message the ingest adds later; */
/*   (2) any message a roster member marks "Keep from Uncle Bob" (cp_email_set_bob); */
/*   (3) attachments, which are never stored (D-CPROG-09). */
/* Ordinary correspondence about Skybolt's own parts (orders, prices, dates, payments, */
/* complaints about Skybolt parts) is not customer-owned technical data. Internal */
/* messages from Matt's Kaytech label stay visible to the roster and readable by Bob. */
/* */
/* What it adds: */
/*   cp_emails.bob_excluded_reason / _by / _at / _auto ... the exclusion, and who set it */
/*   cp_email_markings() .... the marking test (ITAR, EAR, export-controlled, CUI, */
/*                            Distribution Statement, ECCN, USML, EAR99) */
/*   trigger cp_emails_bob_markings .. applies it on insert and on any text change */
/*   cp_email_set_bob() ..... manual keep-from-Bob / give-back, reason required */
/*   cp_ai_threads .......... every question and answer, roster-visible (D-CPROG-14); */
/*                            written only by the uncle-bob-program function */
/* RLS on the new table in this file (D-S7-08). */
/* ===================================================================================== */
BEGIN;

ALTER TABLE public.cp_emails
  ADD COLUMN IF NOT EXISTS bob_excluded_reason text,
  ADD COLUMN IF NOT EXISTS bob_excluded_by     uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS bob_excluded_at     timestamptz,
  ADD COLUMN IF NOT EXISTS bob_excluded_auto   boolean NOT NULL DEFAULT false;

/* Returns the first marking found, or NULL. Case rules: ITAR / EAR / CUI / ECCN / USML must */
/* be capitals as whole words (so "ear" and "cuisine" never match); the long forms are */
/* case-insensitive. */
CREATE FUNCTION public.cp_email_markings(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_text ~ '\mITAR\M'                                   THEN 'ITAR'
    WHEN p_text ~* 'international traffic in arms'             THEN 'ITAR'
    WHEN p_text ~ '\mEAR99\M'                                  THEN 'EAR99'
    WHEN p_text ~ '\mEAR\M'                                    THEN 'EAR'
    WHEN p_text ~* 'export administration regulations'         THEN 'EAR'
    WHEN p_text ~* 'export[- ]controlled'                      THEN 'Export-controlled'
    WHEN p_text ~ '\mCUI\M'                                    THEN 'CUI'
    WHEN p_text ~* 'controlled unclassified'                   THEN 'CUI'
    WHEN p_text ~* 'distribution statement [a-f]\M'            THEN 'Distribution statement'
    WHEN p_text ~ '\mECCN\M'                                   THEN 'ECCN'
    WHEN p_text ~ '\mUSML\M'                                   THEN 'USML'
    ELSE NULL END;
$$;

/* Auto exclusion. A manual exclusion (bob_excluded_auto = false with a reason) is never */
/* overwritten; a manual give-back is overridden only if a marking is present. */
CREATE FUNCTION public.cp_emails_bob_markings()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_mark text;
BEGIN
  v_mark := public.cp_email_markings(coalesce(NEW.subject, '') || ' ' || coalesce(NEW.body_full, '') || ' ' || coalesce(NEW.attachments::text, ''));
  IF v_mark IS NOT NULL THEN
    IF NEW.bob_excluded_reason IS NULL OR NEW.bob_excluded_auto THEN
      NEW.bob_excluded_reason := 'Marking: ' || v_mark;
      NEW.bob_excluded_auto   := true;
      NEW.bob_excluded_by     := NULL;
      NEW.bob_excluded_at     := coalesce(NEW.bob_excluded_at, now());
    END IF;
  ELSIF NEW.bob_excluded_auto THEN
    NEW.bob_excluded_reason := NULL;
    NEW.bob_excluded_auto   := false;
    NEW.bob_excluded_at     := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cp_emails_bob_markings
  BEFORE INSERT OR UPDATE OF subject, body_full, attachments ON public.cp_emails
  FOR EACH ROW EXECUTE FUNCTION public.cp_emails_bob_markings();

/* Backfill the messages already loaded. */
UPDATE public.cp_emails
   SET bob_excluded_reason = 'Marking: ' || public.cp_email_markings(coalesce(subject, '') || ' ' || coalesce(body_full, '') || ' ' || coalesce(attachments::text, '')),
       bob_excluded_auto   = true,
       bob_excluded_at     = now()
 WHERE bob_excluded_reason IS NULL
   AND public.cp_email_markings(coalesce(subject, '') || ' ' || coalesce(body_full, '') || ' ' || coalesce(attachments::text, '')) IS NOT NULL;

/* Manual keep-from-Bob. Any roster member with a write flag; a reason is required to */
/* exclude. Giving back a message that carries a marking is refused. */
CREATE FUNCTION public.cp_email_set_bob(p_id uuid, p_excluded boolean, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_program uuid;
  v_auto boolean;
BEGIN
  v_program := (SELECT program_id FROM public.cp_emails WHERE id = p_id);
  v_auto    := (SELECT bob_excluded_auto FROM public.cp_emails WHERE id = p_id);
  IF v_program IS NULL THEN RAISE EXCEPTION 'GUARD: message not found'; END IF;
  IF NOT (public.cp_can(v_program, 'moves') OR public.cp_can(v_program, 'money')) THEN
    RAISE EXCEPTION 'Not authorized for this program' USING ERRCODE = '42501';
  END IF;
  IF p_excluded THEN
    IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'GUARD: a reason is required'; END IF;
    UPDATE public.cp_emails
       SET bob_excluded_reason = btrim(p_reason), bob_excluded_auto = false,
           bob_excluded_by = auth.uid(), bob_excluded_at = now(), updated_at = now()
     WHERE id = p_id;
  ELSE
    IF v_auto THEN RAISE EXCEPTION 'GUARD: this message carries an export-control or CUI marking and stays excluded'; END IF;
    UPDATE public.cp_emails
       SET bob_excluded_reason = NULL, bob_excluded_by = NULL, bob_excluded_at = NULL, updated_at = now()
     WHERE id = p_id;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.cp_email_set_bob(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cp_email_set_bob(uuid, boolean, text) TO authenticated;
REVOKE ALL ON FUNCTION public.cp_email_markings(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cp_email_markings(text) TO authenticated, service_role;

/* Q&A history (D-CPROG-14). Written by the uncle-bob-program function (service role). */
CREATE TABLE public.cp_ai_threads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id        uuid NOT NULL REFERENCES public.customer_programs(id),
  asked_by          uuid NOT NULL REFERENCES public.profiles(id),
  question          text NOT NULL,
  answer            text,
  citations         jsonb NOT NULL DEFAULT '[]'::jsonb,
  draft             jsonb,
  data_gaps         jsonb NOT NULL DEFAULT '[]'::jsonb,
  emails_in_context integer,
  emails_excluded   integer,
  model             text,
  usage             jsonb,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);
CREATE INDEX cp_ai_threads_program_created ON public.cp_ai_threads (program_id, created_at DESC);
ALTER TABLE public.cp_ai_threads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cp_ai_threads FROM anon;
CREATE POLICY cp_ai_threads_select ON public.cp_ai_threads FOR SELECT TO authenticated USING (public.cp_is_member(program_id));

COMMIT;

/* ---------------------------------------------------------------- verify (single row) */
SELECT
  (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = 'cp_ai_threads' AND rowsecurity) AS ai_table_rls_expect_1,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cp_ai_threads') AS ai_policies_expect_1,
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'cp_emails_bob_markings') AS trigger_expect_1,
  (SELECT count(*) FROM public.cp_emails WHERE bob_excluded_auto) AS auto_excluded_messages,
  (SELECT string_agg(DISTINCT bob_excluded_reason, ', ') FROM public.cp_emails WHERE bob_excluded_auto) AS markings_found,
  (SELECT public.cp_email_markings('ear wax and cuisine') IS NULL AND public.cp_email_markings('This drawing is ITAR controlled') = 'ITAR') AS marking_test_expect_true;
