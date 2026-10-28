/* ===================================================================================== */
/* 2026-10-28_customer_program_itar_text.sql — S16 Batch C follow-up (D-CPROG-18) */
/* Export-marked email text is not stored in SkyNet. */
/* */
/* For any message whose subject, text or attachment names carry an export-control or */
/* CUI marking (cp_email_markings: ITAR, EAR, EAR99, export-controlled, CUI, Distribution */
/* Statement A-F, ECCN, USML), SkyNet keeps the header (date, people, subject), the */
/* attachment names, the tags and the Gmail link, and drops the text: body_full and */
/* snippet become NULL, body_new becomes a one-line note. The message stays excluded from */
/* Uncle Bob. Gmail keeps the original; nothing changes there. */
/* */
/* Works by replacing the trigger function, so the ingest needs no redeploy: new marked */
/* messages lose their text on the way in. The UPDATE at the end clears the ones already */
/* stored (PROD: 2). The exclusion now stays on once the text is gone. */
/* Same file on TEST and PROD. */
/* ===================================================================================== */
BEGIN;

CREATE OR REPLACE FUNCTION public.cp_emails_bob_markings()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_mark text;
BEGIN
  v_mark := public.cp_email_markings(coalesce(NEW.subject, '') || ' ' || coalesce(NEW.body_full, '') || ' ' || coalesce(NEW.attachments::text, ''));
  IF v_mark IS NOT NULL THEN
    NEW.bob_excluded_reason := 'Marking: ' || v_mark;
    NEW.bob_excluded_auto   := true;
    NEW.bob_excluded_by     := NULL;
    NEW.bob_excluded_at     := coalesce(NEW.bob_excluded_at, now());
    NEW.body_full := NULL;
    NEW.snippet   := NULL;
    NEW.body_new  := 'Text not stored in SkyNet: this message carries an export-control or CUI marking (' || v_mark || '). Open it in Gmail.';
  ELSIF NEW.bob_excluded_auto AND NEW.body_full IS NOT NULL THEN
    NEW.bob_excluded_reason := NULL;
    NEW.bob_excluded_auto   := false;
    NEW.bob_excluded_at     := NULL;
  END IF;
  RETURN NEW;
END $$;

/* Clear the text of marked messages already stored. Setting body_full fires the trigger, */
/* which finds the marking and blanks the text in the same row update. */
UPDATE public.cp_emails
   SET body_full = body_full
 WHERE bob_excluded_auto AND body_full IS NOT NULL;

COMMIT;

/* ---------------------------------------------------------------- verify (single row) */
SELECT
  (SELECT count(*) FROM public.cp_emails WHERE bob_excluded_auto) AS marked_messages,
  (SELECT count(*) FROM public.cp_emails WHERE bob_excluded_auto AND (body_full IS NOT NULL OR snippet IS NOT NULL)) AS marked_with_text_left_expect_0,
  (SELECT count(*) FROM public.cp_emails WHERE bob_excluded_auto AND body_new LIKE 'Text not stored in SkyNet:%') AS marked_with_note;
