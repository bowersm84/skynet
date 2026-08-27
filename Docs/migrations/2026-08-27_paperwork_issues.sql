-- 2026-08-27_paperwork_issues.sql
-- Paperwork issues (D-PAPERWORK-01): a machinist flags a job's paperwork from the
-- Kiosk with a mandatory description; compliance acknowledges it in Compliance
-- Review; the running log is a registry-driven report. Open issues change
-- nothing on the job. TEST first, then PROD.
-- SQL Editor: run each block on its own (last-result-set rule).

-- ── Block 1 · table + RLS (SELECT for authenticated; writes only via the RPCs) ──
CREATE TABLE public.paperwork_issues (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           uuid NOT NULL REFERENCES public.jobs(id),
  job_document_id  uuid REFERENCES public.job_documents(id) ON DELETE SET NULL,
  document_label   text,                                   -- snapshot: "file (Drawing)" at log time
  machine_id       uuid REFERENCES public.machines(id),
  description      text NOT NULL CHECK (length(btrim(description)) >= 10),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged')),
  logged_by        uuid NOT NULL REFERENCES public.profiles(id),
  logged_at        timestamptz NOT NULL DEFAULT now(),
  acknowledged_by  uuid REFERENCES public.profiles(id),
  acknowledged_at  timestamptz,
  ack_note         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX paperwork_issues_job_idx  ON public.paperwork_issues (job_id);
CREATE INDEX paperwork_issues_open_idx ON public.paperwork_issues (logged_at) WHERE status = 'open';

ALTER TABLE public.paperwork_issues ENABLE ROW LEVEL SECURITY;
CREATE POLICY paperwork_issues_select ON public.paperwork_issues
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.paperwork_issues FROM PUBLIC, anon;
GRANT SELECT ON public.paperwork_issues TO authenticated, service_role;

-- Realtime for the Compliance Review worklist (guarded: no-op if the
-- publication is FOR ALL TABLES or the table is already in it).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime' AND puballtables)
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'paperwork_issues')
     AND EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.paperwork_issues;
  END IF;
END $$;

-- ── Block 2 · log_paperwork_issue — machinist / admin ────────────────────────
-- Inserts the issue, audits it, and notifies every active compliance-role
-- holder through user_notifications (D-NOTIF-01). Returns the issue id.
CREATE OR REPLACE FUNCTION public.log_paperwork_issue(
  p_job_id          uuid,
  p_description     text,
  p_job_document_id uuid DEFAULT NULL,
  p_machine_id      uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_desc         text := btrim(coalesce(p_description, ''));
  v_job_number   text;
  v_job_machine  uuid;
  v_component    uuid;
  v_doc_id       uuid;
  v_doc_name     text;
  v_doc_type     text;
  v_label        text;
  v_machine      uuid;
  v_machine_code text;
  v_part         text;
  v_id           uuid;
BEGIN
  IF v_uid IS NULL OR NOT user_has_role(v_uid, 'machinist', 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF length(v_desc) < 10 THEN
    RAISE EXCEPTION 'Describe the issue in at least 10 characters';
  END IF;

  SELECT j.job_number, j.assigned_machine_id, j.component_id
    INTO v_job_number, v_job_machine, v_component
  FROM jobs j WHERE j.id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found';
  END IF;

  IF p_job_document_id IS NOT NULL THEN
    SELECT d.id, d.file_name, dt.name
      INTO v_doc_id, v_doc_name, v_doc_type
    FROM job_documents d
    LEFT JOIN document_types dt ON dt.id = d.document_type_id
    WHERE d.id = p_job_document_id AND d.job_id = p_job_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Document does not belong to this job';
    END IF;
    v_label := coalesce(v_doc_name, 'Unnamed document')
               || coalesce(' (' || v_doc_type || ')', '');
  END IF;

  v_machine := coalesce(p_machine_id, v_job_machine);

  INSERT INTO paperwork_issues (job_id, job_document_id, document_label, machine_id, description, logged_by)
  VALUES (p_job_id, v_doc_id, v_label, v_machine, v_desc, v_uid)
  RETURNING id INTO v_id;

  SELECT p.part_number::text INTO v_part FROM parts p WHERE p.id = v_component;
  SELECT m.code::text INTO v_machine_code FROM machines m WHERE m.id = v_machine;

  INSERT INTO audit_logs (event_type, job_id, machine_id, operator_id, details)
  VALUES ('paperwork_issue_logged', p_job_id, v_machine, v_uid,
          jsonb_build_object('issue_id', v_id, 'job_document_id', v_doc_id,
                             'document', v_label, 'description', v_desc));

  INSERT INTO user_notifications (recipient_id, type, title, body, payload, created_by)
  SELECT pr.id,
         'paperwork_issue',
         'Paperwork issue on ' || v_job_number,
         concat_ws(' · ', v_part, v_machine_code, left(v_desc, 140)),
         jsonb_build_object('issue_id', v_id, 'job_id', p_job_id, 'job_number', v_job_number),
         v_uid
  FROM profiles pr
  WHERE pr.is_active
    AND (pr.role = 'compliance' OR 'compliance' = ANY (pr.roles));

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.log_paperwork_issue(uuid, text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_paperwork_issue(uuid, text, uuid, uuid) TO authenticated, service_role;

-- ── Block 3 · ack_paperwork_issue — compliance / admin ───────────────────────
CREATE OR REPLACE FUNCTION public.ack_paperwork_issue(
  p_issue_id uuid,
  p_note     text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_job     uuid;
  v_machine uuid;
  v_status  text;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF v_uid IS NULL OR NOT user_has_role(v_uid, 'compliance', 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT job_id, machine_id, status INTO v_job, v_machine, v_status
  FROM paperwork_issues WHERE id = p_issue_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Issue not found';
  END IF;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'Issue already acknowledged';
  END IF;

  UPDATE paperwork_issues
     SET status = 'acknowledged',
         acknowledged_by = v_uid,
         acknowledged_at = now(),
         ack_note = v_note
   WHERE id = p_issue_id;

  INSERT INTO audit_logs (event_type, job_id, machine_id, operator_id, details)
  VALUES ('paperwork_issue_acknowledged', v_job, v_machine, v_uid,
          jsonb_build_object('issue_id', p_issue_id, 'note', v_note));
END;
$$;

REVOKE ALL ON FUNCTION public.ack_paperwork_issue(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ack_paperwork_issue(uuid, text) TO authenticated, service_role;

-- ── Block 4 · report view + registry row (Reports module, D-RPT-01) ──────────
-- Times are text in local shop time so the CSV keeps them (bare ISO datetimes
-- get trimmed to dates by the D-RPT-02 serializer). issue_id is the pagination
-- tie-break and stays out of the column list.
CREATE OR REPLACE VIEW public.v_report_paperwork_issues
WITH (security_invoker = on) AS
SELECT
  pi.id                                                                              AS issue_id,
  to_char(pi.logged_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI')        AS logged_at,
  pi.status,
  j.job_number::text                                                                 AS job_number,
  p.part_number::text                                                                AS part_number,
  m.code::text                                                                       AS machine,
  pi.document_label                                                                  AS document,
  pi.description,
  lb.full_name::text                                                                 AS logged_by,
  to_char(pi.acknowledged_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI')  AS acknowledged_at,
  ab.full_name::text                                                                 AS acknowledged_by,
  pi.ack_note,
  CASE WHEN pi.status = 'open'
       THEN (now()::date - pi.logged_at::date)
       ELSE (pi.acknowledged_at::date - pi.logged_at::date) END                      AS days_open
FROM public.paperwork_issues pi
JOIN public.jobs j        ON j.id = pi.job_id
LEFT JOIN public.parts p    ON p.id = j.component_id
LEFT JOIN public.machines m ON m.id = pi.machine_id
LEFT JOIN public.profiles lb ON lb.id = pi.logged_by
LEFT JOIN public.profiles ab ON ab.id = pi.acknowledged_by;

REVOKE ALL ON public.v_report_paperwork_issues FROM PUBLIC, anon;
GRANT SELECT ON public.v_report_paperwork_issues TO authenticated, service_role;

INSERT INTO public.reports
  (slug, name, description, explainer, source_object, columns, order_by, view_roles, export_roles, sort_order)
VALUES (
  'paperwork-issues',
  'Paperwork Issues Log',
  'Every paperwork issue flagged from the Machinist Kiosk — open and acknowledged — with the job, part, document, who flagged it, and compliance''s acknowledgement.',
  'A machinist flags a job''s paperwork from the Kiosk when it does not match (drawing vs production sheet is the usual case). Compliance acknowledges after checking the mistake was not on their side and passes the fix to R&D. Open issues change nothing on the job. days_open counts calendar days from the flag to the acknowledgement, or to today while open.',
  'v_report_paperwork_issues',
  ARRAY['logged_at', 'status', 'job_number', 'part_number', 'machine', 'document', 'description', 'logged_by', 'acknowledged_at', 'acknowledged_by', 'ack_note', 'days_open'],
  '[{"column": "logged_at", "ascending": false}, {"column": "issue_id", "ascending": true}]'::jsonb,
  '{}'::text[],
  ARRAY['admin', 'president', 'scheduler', 'compliance'],
  60
);

-- ── Block 5 · verify ─────────────────────────────────────────────────────────
SELECT 'table' AS what, relrowsecurity::text AS detail
FROM pg_class WHERE relname = 'paperwork_issues'
UNION ALL
SELECT 'policies', string_agg(policyname || ':' || cmd, ', ')
FROM pg_policies WHERE tablename = 'paperwork_issues'
UNION ALL
SELECT 'fn ' || proname, proacl::text
FROM pg_proc WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('log_paperwork_issue', 'ack_paperwork_issue')
UNION ALL
SELECT 'view', reloptions::text FROM pg_class WHERE relname = 'v_report_paperwork_issues'
UNION ALL
SELECT 'report row', slug || ' · ' || source_object || ' · export ' || array_to_string(export_roles, '/')
FROM public.reports WHERE slug = 'paperwork-issues'
UNION ALL
SELECT 'realtime', coalesce(string_agg(tablename, ','), 'not in publication')
FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'paperwork_issues';