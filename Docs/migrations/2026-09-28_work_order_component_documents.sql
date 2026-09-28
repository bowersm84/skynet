-- D-CERT-13: supplementary documents compliance attaches to one component line of a
-- work order in the Cert Repository — not tied to a job or a component lot. Shown in the
-- component's Documents panel and merged into cert packages as "Additional Document".
-- Mirrors component_lot_documents (same document_type set, file_path convention, RLS:
-- any signed-in user reads, admin/compliance write), except anon gets no grants and
-- authenticated gets only SELECT/INSERT/UPDATE/DELETE.
-- Additive only; re-runnable. TEST first, then PROD.
BEGIN;

CREATE TABLE IF NOT EXISTS public.work_order_component_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES public.work_orders(id) ON DELETE CASCADE,
  part_id       uuid NOT NULL REFERENCES public.parts(id),
  document_type text NOT NULL DEFAULT 'other'
                CONSTRAINT work_order_component_documents_document_type_check
                CHECK (document_type = ANY (ARRAY['packing_slip','coc','material_cert','test_report','invoice','other'])),
  file_name     text NOT NULL,
  file_path     text NOT NULL,
  file_size     bigint,
  mime_type     text,
  notes         text,
  uploaded_by   uuid REFERENCES public.profiles(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS work_order_component_documents_wo_part_idx
  ON public.work_order_component_documents (work_order_id, part_id);

ALTER TABLE public.work_order_component_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wocd_select ON public.work_order_component_documents;
CREATE POLICY wocd_select ON public.work_order_component_documents
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS wocd_write ON public.work_order_component_documents;
CREATE POLICY wocd_write ON public.work_order_component_documents
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = auth.uid()
       AND ((p.role)::text = ANY (ARRAY['admin','compliance'])
            OR p.roles && ARRAY['admin','compliance'])))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = auth.uid()
       AND ((p.role)::text = ANY (ARRAY['admin','compliance'])
            OR p.roles && ARRAY['admin','compliance'])));

-- Supabase default privileges hand anon/authenticated ALL (incl. TRUNCATE, which bypasses RLS);
-- reset to exactly the four DML privileges for signed-in users.
REVOKE ALL ON public.work_order_component_documents FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.work_order_component_documents TO authenticated;

COMMIT;

-- Verification (read-only) — expect: rls true | 2 policies | anon grants none |
--   authenticated DELETE,INSERT,SELECT,UPDATE | 1 check constraint
-- select (select relrowsecurity from pg_class where oid = 'public.work_order_component_documents'::regclass) as rls,
--        (select count(*) from pg_policies where schemaname = 'public' and tablename = 'work_order_component_documents') as policies,
--        (select coalesce(string_agg(privilege_type, ','), 'none') from information_schema.role_table_grants
--          where table_schema = 'public' and table_name = 'work_order_component_documents' and grantee = 'anon') as anon_grants,
--        (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
--          where table_schema = 'public' and table_name = 'work_order_component_documents' and grantee = 'authenticated') as auth_grants,
--        (select count(*) from pg_constraint where conrelid = 'public.work_order_component_documents'::regclass and contype = 'c') as checks;
