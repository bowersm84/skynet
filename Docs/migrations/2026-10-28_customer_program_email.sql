/* ===================================================================================== */
/* 2026-10-28_customer_program_email.sql — S16 Batch B, the customer email trail (D-CPROG-07..12) */
/* Run AFTER the Batch A files. Same file on TEST and PROD (no environment values in it). */
/* The cron schedule that calls the function is a separate, per-environment file. */
/* */
/* What it adds: */
/*   customer_programs.email_domains .. the customer's mail domains (Kaytech: kaytech.com) */
/*   cp_email_sources ................. which Skybolt mailboxes are read, and how */
/*   cp_emails ........................ one row per message (RFC822 Message-ID), deduped */
/*                                      across mailboxes; attachments as metadata only */
/*   cp_email_sync_state .............. per mailbox: last run, last success, last error */
/*   cp_email_update() ................ hide / unhide a message or change its tags */
/*   cp_ingest_token_ok() ............. lets the function check the cron's token */
/*   vault secret cp_ingest_token ..... random, created here; cron sends it, function checks it */
/*   pg_net ........................... so pg_cron can call the function */
/* RLS on every new table in this file (D-S7-08). Reads = roster; writes by the function */
/* (service role) only, except cp_email_update for roster members with a write flag. */
/* ===================================================================================== */
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_net;

ALTER TABLE public.customer_programs
  ADD COLUMN IF NOT EXISTS email_domains text[] NOT NULL DEFAULT '{}';

CREATE TABLE public.cp_email_sources (
  program_id   uuid NOT NULL REFERENCES public.customer_programs(id),
  mailbox      text NOT NULL,
  mode         text NOT NULL CHECK (mode IN ('domain','label')),
  label_name   text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, mailbox, mode),
  CHECK (mode = 'domain' OR label_name IS NOT NULL)
);

CREATE TABLE public.cp_emails (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id      uuid NOT NULL REFERENCES public.customer_programs(id),
  rfc822_id       text NOT NULL,
  thread_key      text NOT NULL,
  in_reply_to     text,
  sent_at         timestamptz NOT NULL,
  from_addr       text,
  from_name       text,
  to_addrs        text[] NOT NULL DEFAULT '{}',
  cc_addrs        text[] NOT NULL DEFAULT '{}',
  subject         text,
  snippet         text,
  body_new        text,
  body_full       text,
  attachments     jsonb NOT NULL DEFAULT '[]'::jsonb,
  direction       text NOT NULL CHECK (direction IN ('in','out','internal')),
  refs            text[] NOT NULL DEFAULT '{}',
  refs_edited     boolean NOT NULL DEFAULT false,
  mailboxes       text[] NOT NULL DEFAULT '{}',
  gmail_ids       jsonb NOT NULL DEFAULT '{}'::jsonb,
  hidden_at       timestamptz,
  hidden_by       uuid REFERENCES public.profiles(id),
  hidden_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, rfc822_id)
);
CREATE INDEX cp_emails_program_sent ON public.cp_emails (program_id, sent_at DESC);
CREATE INDEX cp_emails_refs ON public.cp_emails USING gin (refs);

CREATE TABLE public.cp_email_sync_state (
  program_id        uuid NOT NULL REFERENCES public.customer_programs(id),
  mailbox           text NOT NULL,
  backfill_done     boolean NOT NULL DEFAULT false,
  last_run_at       timestamptz,
  last_success_at   timestamptz,
  last_error        text,
  last_new          integer NOT NULL DEFAULT 0,
  total_seen        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (program_id, mailbox)
);

ALTER TABLE public.cp_email_sources     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cp_emails            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cp_email_sync_state  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cp_email_sources, public.cp_emails, public.cp_email_sync_state FROM anon;

CREATE POLICY cp_email_sources_select ON public.cp_email_sources    FOR SELECT TO authenticated USING (public.cp_is_member(program_id));
CREATE POLICY cp_emails_select        ON public.cp_emails           FOR SELECT TO authenticated USING (public.cp_is_member(program_id));
CREATE POLICY cp_email_sync_select    ON public.cp_email_sync_state FOR SELECT TO authenticated USING (public.cp_is_member(program_id));

/* Hide / unhide a message, or replace its tags. Any roster member with a write flag. */
CREATE FUNCTION public.cp_email_update(p_id uuid, p_hidden boolean, p_reason text, p_refs text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_program uuid;
BEGIN
  v_program := (SELECT program_id FROM public.cp_emails WHERE id = p_id);
  IF v_program IS NULL THEN RAISE EXCEPTION 'GUARD: message not found'; END IF;
  IF NOT (public.cp_can(v_program, 'moves') OR public.cp_can(v_program, 'money')) THEN
    RAISE EXCEPTION 'Not authorized for this program' USING ERRCODE = '42501';
  END IF;
  IF p_hidden IS TRUE AND coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'GUARD: a reason is required to hide a message';
  END IF;
  UPDATE public.cp_emails
     SET hidden_at     = CASE WHEN p_hidden IS NULL THEN hidden_at     WHEN p_hidden THEN now()       ELSE NULL END,
         hidden_by     = CASE WHEN p_hidden IS NULL THEN hidden_by     WHEN p_hidden THEN auth.uid()  ELSE NULL END,
         hidden_reason = CASE WHEN p_hidden IS NULL THEN hidden_reason WHEN p_hidden THEN btrim(p_reason) ELSE NULL END,
         refs          = CASE WHEN p_refs IS NULL THEN refs ELSE (SELECT coalesce(array_agg(DISTINCT upper(btrim(r))), '{}') FROM unnest(p_refs) r WHERE btrim(r) <> '') END,
         refs_edited   = refs_edited OR p_refs IS NOT NULL,
         updated_at    = now()
   WHERE id = p_id;
END $$;
REVOKE ALL ON FUNCTION public.cp_email_update(uuid, boolean, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cp_email_update(uuid, boolean, text, text[]) TO authenticated;

/* The cron's shared token lives in Vault; only the service role can check it. */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cp_ingest_token') THEN
    PERFORM vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
                                'cp_ingest_token', 'S16 customer email ingest: pg_cron to cp-gmail-ingest');
  END IF;
END $$;

CREATE FUNCTION public.cp_ingest_token_ok(p_token text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(btrim(p_token), '') <> ''
     AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'cp_ingest_token' AND decrypted_secret = p_token);
$$;
REVOKE ALL ON FUNCTION public.cp_ingest_token_ok(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cp_ingest_token_ok(text) TO service_role;

/* Kaytech sources: the five roster mailboxes by domain, plus Matt's "Kaytech" label. */
UPDATE public.customer_programs SET email_domains = ARRAY['kaytech.com'] WHERE code = 'KAYTECH';

INSERT INTO public.cp_email_sources (program_id, mailbox, mode, label_name)
SELECT p.id, s.mailbox, s.mode, s.label_name
  FROM public.customer_programs p,
       (VALUES ('mbowers@skybolt.com', 'domain', NULL),
               ('mbowers@skybolt.com', 'label',  'Kaytech'),
               ('nbowers@skybolt.com', 'domain', NULL),
               ('abraun@skybolt.com',  'domain', NULL),
               ('cexum@skybolt.com',   'domain', NULL),
               ('ahall@skybolt.com',   'domain', NULL)) AS s(mailbox, mode, label_name)
 WHERE p.code = 'KAYTECH'
ON CONFLICT (program_id, mailbox, mode) DO NOTHING;

COMMIT;

/* ---------------------------------------------------------------- verify (single row) */
SELECT
  (SELECT count(*) FROM pg_tables WHERE schemaname = 'public'
     AND tablename IN ('cp_email_sources','cp_emails','cp_email_sync_state') AND rowsecurity) AS tables_with_rls_expect_3,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
     AND tablename IN ('cp_email_sources','cp_emails','cp_email_sync_state')) AS policies_expect_3,
  (SELECT count(*) FROM public.cp_email_sources s JOIN public.customer_programs p ON p.id = s.program_id WHERE p.code = 'KAYTECH') AS kaytech_sources_expect_6,
  (SELECT email_domains::text FROM public.customer_programs WHERE code = 'KAYTECH') AS kaytech_domains,
  (SELECT count(*) FROM vault.secrets WHERE name = 'cp_ingest_token') AS token_expect_1,
  (SELECT count(*) FROM pg_extension WHERE extname = 'pg_net') AS pg_net_expect_1;
