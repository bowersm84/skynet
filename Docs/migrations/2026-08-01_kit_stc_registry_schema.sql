-- ============================================================
-- 2026-08-01_kit_stc_registry_schema.sql
-- Kit & STC Registry (D-KSTC series) -- Phase 1 schema
-- As-run artifact: applied to TEST 2026-08-01 (verified 17 tables /
-- 68 policies / 12 trigger events / 4 books / 2 certificates), PROD pending.
-- Includes seed INSERTs (kit_books, stc_certificates) -- required for a
-- fresh replay before the kit_stc_load loader.
-- Policy note: kit_lots INSERT here is the original insert_workflow policy;
-- 2026-08-02_kit_lots_kiosk_insert.sql supersedes it in sequence.
-- ============================================================

BEGIN;

CREATE TABLE public.kit_books (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL CHECK (category = ANY (ARRAY['conversion'::text,'options'::text,'experimental'::text])),
  revision text,
  first_lot integer,
  last_lot integer,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT kit_books_pkey PRIMARY KEY (id)
);

CREATE TABLE public.kit_skus (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  part_number text NOT NULL UNIQUE,
  description text,
  kit_scope text NOT NULL DEFAULT 'undetermined'::text CHECK (kit_scope = ANY (ARRAY['complete'::text,'partial'::text,'undetermined'::text])),
  stc_applicability text NOT NULL DEFAULT 'undetermined'::text CHECK (stc_applicability = ANY (ARRAY['stc_bearing'::text,'not_stc'::text,'undetermined'::text])),
  applicability_ruled_by uuid,
  applicability_ruled_at timestamp with time zone,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT kit_skus_pkey PRIMARY KEY (id),
  CONSTRAINT ks_ruled_by_fkey FOREIGN KEY (applicability_ruled_by) REFERENCES public.profiles(id)
);

CREATE TABLE public.kit_components (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  part_number text NOT NULL UNIQUE,
  description text,
  part_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT kit_components_pkey PRIMARY KEY (id),
  CONSTRAINT kc_part_fkey FOREIGN KEY (part_id) REFERENCES public.parts(id)
);

CREATE TABLE public.kit_bom_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kit_sku_id uuid NOT NULL,
  component_id uuid NOT NULL,
  line_number integer,
  qty_per_kit numeric NOT NULL,
  uom text NOT NULL DEFAULT 'ea'::text,
  source text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT kit_bom_lines_pkey PRIMARY KEY (id),
  CONSTRAINT kbl_sku_fkey FOREIGN KEY (kit_sku_id) REFERENCES public.kit_skus(id),
  CONSTRAINT kbl_component_fkey FOREIGN KEY (component_id) REFERENCES public.kit_components(id),
  CONSTRAINT kbl_sku_component_unique UNIQUE (kit_sku_id, component_id)
);

CREATE TABLE public.stc_certificates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  stc_number text NOT NULL UNIQUE,
  description text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT stc_certificates_pkey PRIMARY KEY (id)
);

CREATE TABLE public.kit_sku_stc_map (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kit_sku_id uuid NOT NULL,
  stc_certificate_id uuid NOT NULL,
  ruled_by uuid,
  ruled_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT kit_sku_stc_map_pkey PRIMARY KEY (id),
  CONSTRAINT ksm_sku_fkey FOREIGN KEY (kit_sku_id) REFERENCES public.kit_skus(id),
  CONSTRAINT ksm_cert_fkey FOREIGN KEY (stc_certificate_id) REFERENCES public.stc_certificates(id),
  CONSTRAINT ksm_ruled_by_fkey FOREIGN KEY (ruled_by) REFERENCES public.profiles(id),
  CONSTRAINT ksm_sku_cert_unique UNIQUE (kit_sku_id, stc_certificate_id)
);

CREATE TABLE public.kit_parties (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  normalized_name text NOT NULL UNIQUE,
  fishbowl_customer_number text,
  country text,
  is_distributor boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT kit_parties_pkey PRIMARY KEY (id)
);

CREATE TABLE public.kit_sales (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  so_number text NOT NULL UNIQUE,
  party_id uuid,
  customer_po text,
  order_date date,
  ship_date date,
  so_status text,
  salesperson text,
  source text NOT NULL DEFAULT 'workbook_v5_3'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT kit_sales_pkey PRIMARY KEY (id),
  CONSTRAINT ksa_party_fkey FOREIGN KEY (party_id) REFERENCES public.kit_parties(id)
);

CREATE TABLE public.kit_sale_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kit_sale_id uuid NOT NULL,
  kit_sku_id uuid NOT NULL,
  qty_ordered integer,
  qty_shipped integer,
  invoice_numbers text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT kit_sale_lines_pkey PRIMARY KEY (id),
  CONSTRAINT ksl_sale_fkey FOREIGN KEY (kit_sale_id) REFERENCES public.kit_sales(id),
  CONSTRAINT ksl_sku_fkey FOREIGN KEY (kit_sku_id) REFERENCES public.kit_skus(id)
);

CREATE TABLE public.fishbowl_invoices (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL UNIQUE,
  party_id uuid,
  so_number text,
  first_ship_date date,
  invoice_lines integer,
  salesperson text,
  source text NOT NULL DEFAULT 'workbook_v5_3'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT fishbowl_invoices_pkey PRIMARY KEY (id),
  CONSTRAINT fbi_party_fkey FOREIGN KEY (party_id) REFERENCES public.kit_parties(id)
);

CREATE TABLE public.kit_lots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL,
  lot_number integer NOT NULL,
  kit_sku_id uuid,
  log_date date,
  kit_part_as_written text,
  customer_as_written text,
  party_id uuid,
  invoice_as_written text,
  kit_sale_line_id uuid,
  stud_number text,
  rec_platemount_number text,
  record_status text NOT NULL DEFAULT 'active'::text CHECK (record_status = ANY (ARRAY['active'::text,'void'::text,'no_entry'::text])),
  source text NOT NULL DEFAULT 'skynet'::text CHECK (source = ANY (ARRAY['paper_transcription'::text,'skynet'::text,'fishbowl'::text])),
  source_page text,
  transcription_confidence text CHECK (transcription_confidence = ANY (ARRAY['high'::text,'medium'::text,'low'::text])),
  transcription_notes text,
  notes text,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT kit_lots_pkey PRIMARY KEY (id),
  CONSTRAINT kl_book_fkey FOREIGN KEY (book_id) REFERENCES public.kit_books(id),
  CONSTRAINT kl_sku_fkey FOREIGN KEY (kit_sku_id) REFERENCES public.kit_skus(id),
  CONSTRAINT kl_party_fkey FOREIGN KEY (party_id) REFERENCES public.kit_parties(id),
  CONSTRAINT kl_sale_line_fkey FOREIGN KEY (kit_sale_line_id) REFERENCES public.kit_sale_lines(id),
  CONSTRAINT kl_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id),
  CONSTRAINT kl_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id),
  CONSTRAINT kl_book_lot_unique UNIQUE (book_id, lot_number)
);

CREATE TABLE public.aircraft (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  serial_number text UNIQUE,
  registration text,
  make_model text,
  country text,
  notes text,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT aircraft_pkey PRIMARY KEY (id),
  CONSTRAINT ac_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id),
  CONSTRAINT ac_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id),
  CONSTRAINT ac_identity_check CHECK (serial_number IS NOT NULL OR registration IS NOT NULL)
);

CREATE TABLE public.aircraft_registrations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  aircraft_id uuid NOT NULL,
  registration text NOT NULL,
  observed_date date,
  source text,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT aircraft_registrations_pkey PRIMARY KEY (id),
  CONSTRAINT ar_aircraft_fkey FOREIGN KEY (aircraft_id) REFERENCES public.aircraft(id)
);

CREATE TABLE public.kit_installations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kit_lot_id uuid,
  kit_sku_id uuid NOT NULL,
  aircraft_id uuid NOT NULL,
  installer_party_id uuid,
  install_date date,
  status text NOT NULL DEFAULT 'claimed'::text CHECK (status = ANY (ARRAY['claimed'::text,'verified'::text])),
  evidence text,
  notes text,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT kit_installations_pkey PRIMARY KEY (id),
  CONSTRAINT ki_lot_fkey FOREIGN KEY (kit_lot_id) REFERENCES public.kit_lots(id),
  CONSTRAINT ki_sku_fkey FOREIGN KEY (kit_sku_id) REFERENCES public.kit_skus(id),
  CONSTRAINT ki_aircraft_fkey FOREIGN KEY (aircraft_id) REFERENCES public.aircraft(id),
  CONSTRAINT ki_installer_fkey FOREIGN KEY (installer_party_id) REFERENCES public.kit_parties(id),
  CONSTRAINT ki_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id),
  CONSTRAINT ki_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id)
);

CREATE TABLE public.stc_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  intake_number integer NOT NULL UNIQUE,
  received_date date,
  channel text NOT NULL DEFAULT 'email'::text CHECK (channel = ANY (ARRAY['email'::text,'web_form'::text,'paper_form'::text,'phone'::text,'other'::text])),
  requester_name text,
  requester_company text,
  requester_email text,
  requester_party_id uuid,
  claimed_kit_number text,
  claimed_kit_part text,
  claimed_aircraft_serial text,
  claimed_registration text,
  claimed_order_number text,
  purchased_from_text text,
  purchased_from_party_id uuid,
  status text NOT NULL DEFAULT 'new'::text CHECK (status = ANY (ARRAY['new'::text,'needs_info'::text,'matched'::text,'issued'::text,'closed'::text,'unidentifiable'::text])),
  kit_lot_id uuid,
  aircraft_id uuid,
  installation_id uuid,
  notes text,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT stc_requests_pkey PRIMARY KEY (id),
  CONSTRAINT sr_requester_party_fkey FOREIGN KEY (requester_party_id) REFERENCES public.kit_parties(id),
  CONSTRAINT sr_purchased_from_fkey FOREIGN KEY (purchased_from_party_id) REFERENCES public.kit_parties(id),
  CONSTRAINT sr_lot_fkey FOREIGN KEY (kit_lot_id) REFERENCES public.kit_lots(id),
  CONSTRAINT sr_aircraft_fkey FOREIGN KEY (aircraft_id) REFERENCES public.aircraft(id),
  CONSTRAINT sr_installation_fkey FOREIGN KEY (installation_id) REFERENCES public.kit_installations(id),
  CONSTRAINT sr_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id),
  CONSTRAINT sr_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id)
);

CREATE TABLE public.stc_issuances (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  stc_request_id uuid,
  installation_id uuid NOT NULL,
  stc_certificate_id uuid NOT NULL,
  doc_version text,
  sent_to_name text,
  sent_to_email text,
  sent_date date NOT NULL,
  sent_by uuid,
  method text,
  notes text,
  is_voided boolean NOT NULL DEFAULT false,
  voided_reason text,
  voided_by uuid,
  voided_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT stc_issuances_pkey PRIMARY KEY (id),
  CONSTRAINT si_request_fkey FOREIGN KEY (stc_request_id) REFERENCES public.stc_requests(id),
  CONSTRAINT si_installation_fkey FOREIGN KEY (installation_id) REFERENCES public.kit_installations(id),
  CONSTRAINT si_cert_fkey FOREIGN KEY (stc_certificate_id) REFERENCES public.stc_certificates(id),
  CONSTRAINT si_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES public.profiles(id),
  CONSTRAINT si_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES public.profiles(id),
  CONSTRAINT si_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id)
);

CREATE TABLE public.kit_stc_documents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  stc_request_id uuid,
  kit_installation_id uuid,
  kit_lot_id uuid,
  document_type text NOT NULL DEFAULT 'other'::text CHECK (document_type = ANY (ARRAY['request_email'::text,'order_form'::text,'invoice'::text,'form_337'::text,'photo'::text,'issued_doc'::text,'other'::text])),
  file_name text NOT NULL,
  file_path text NOT NULL,
  file_size bigint,
  mime_type text,
  uploaded_by uuid,
  uploaded_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT kit_stc_documents_pkey PRIMARY KEY (id),
  CONSTRAINT ksd_request_fkey FOREIGN KEY (stc_request_id) REFERENCES public.stc_requests(id),
  CONSTRAINT ksd_installation_fkey FOREIGN KEY (kit_installation_id) REFERENCES public.kit_installations(id),
  CONSTRAINT ksd_lot_fkey FOREIGN KEY (kit_lot_id) REFERENCES public.kit_lots(id),
  CONSTRAINT ksd_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.profiles(id),
  CONSTRAINT ksd_link_check CHECK (stc_request_id IS NOT NULL OR kit_installation_id IS NOT NULL OR kit_lot_id IS NOT NULL)
);

CREATE INDEX kl_lot_number_idx ON public.kit_lots (lot_number);
CREATE INDEX kl_sku_idx ON public.kit_lots (kit_sku_id);
CREATE INDEX kl_party_idx ON public.kit_lots (party_id);
CREATE INDEX kl_invoice_idx ON public.kit_lots (invoice_as_written);
CREATE INDEX kbl_component_idx ON public.kit_bom_lines (component_id);
CREATE INDEX ki_aircraft_idx ON public.kit_installations (aircraft_id);
CREATE INDEX ki_lot_idx ON public.kit_installations (kit_lot_id);
CREATE INDEX ki_sku_idx ON public.kit_installations (kit_sku_id);
CREATE INDEX ac_registration_idx ON public.aircraft (registration);
CREATE INDEX ar_registration_idx ON public.aircraft_registrations (registration);
CREATE INDEX sr_status_idx ON public.stc_requests (status);
CREATE INDEX ksl_sku_idx ON public.kit_sale_lines (kit_sku_id);
CREATE INDEX ksa_party_idx ON public.kit_sales (party_id);
CREATE INDEX fbi_so_idx ON public.fishbowl_invoices (so_number);

CREATE OR REPLACE FUNCTION public.kstc_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kit_books','kit_skus','kit_components','kit_parties','kit_sales',
    'kit_lots','aircraft','kit_installations','stc_requests','stc_certificates']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_touch_updated BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.kstc_touch_updated_at()', t, t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.kstc_issuance_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stc_issuances is append-only: rows cannot be deleted. Void instead.';
  END IF;
  IF NEW.stc_request_id      IS DISTINCT FROM OLD.stc_request_id
  OR NEW.installation_id     IS DISTINCT FROM OLD.installation_id
  OR NEW.stc_certificate_id  IS DISTINCT FROM OLD.stc_certificate_id
  OR NEW.doc_version         IS DISTINCT FROM OLD.doc_version
  OR NEW.sent_to_name        IS DISTINCT FROM OLD.sent_to_name
  OR NEW.sent_to_email       IS DISTINCT FROM OLD.sent_to_email
  OR NEW.sent_date           IS DISTINCT FROM OLD.sent_date
  OR NEW.sent_by             IS DISTINCT FROM OLD.sent_by
  OR NEW.method              IS DISTINCT FROM OLD.method
  OR NEW.created_by          IS DISTINCT FROM OLD.created_by
  OR NEW.created_at          IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'stc_issuances rows are immutable once created; only notes and void fields may change.';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER stc_issuances_guard
  BEFORE UPDATE OR DELETE ON public.stc_issuances
  FOR EACH ROW EXECUTE FUNCTION public.kstc_issuance_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kit_books','kit_skus','kit_components','kit_bom_lines',
    'stc_certificates','kit_sku_stc_map','kit_parties','kit_sales','kit_sale_lines',
    'fishbowl_invoices','kit_lots','aircraft','aircraft_registrations',
    'kit_installations','stc_requests','stc_issuances','kit_stc_documents']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I_select_authenticated ON public.%I FOR SELECT TO authenticated USING (true)', t, t);
    EXECUTE format('CREATE POLICY %I_delete_admin ON public.%I FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), ''admin''))', t, t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['kit_books','kit_skus','kit_components','kit_bom_lines',
    'stc_certificates','kit_sku_stc_map']
  LOOP
    EXECUTE format('CREATE POLICY %I_insert_master ON public.%I FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), ''admin'', ''compliance''))', t, t);
    EXECUTE format('CREATE POLICY %I_update_master ON public.%I FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), ''admin'', ''compliance'')) WITH CHECK (public.user_has_role(auth.uid(), ''admin'', ''compliance''))', t, t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['kit_parties','kit_sales','kit_sale_lines','fishbowl_invoices',
    'kit_lots','aircraft','aircraft_registrations','kit_installations','stc_requests',
    'stc_issuances','kit_stc_documents']
  LOOP
    EXECUTE format('CREATE POLICY %I_insert_workflow ON public.%I FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), ''admin'', ''compliance'', ''customer_service'', ''scheduler''))', t, t);
    EXECUTE format('CREATE POLICY %I_update_workflow ON public.%I FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), ''admin'', ''compliance'', ''customer_service'', ''scheduler'')) WITH CHECK (public.user_has_role(auth.uid(), ''admin'', ''compliance'', ''customer_service'', ''scheduler''))', t, t);
  END LOOP;
END $$;

INSERT INTO public.kit_books (code, name, category, revision, first_lot, last_lot, notes) VALUES
  ('SK203',  'SK203 / C2800 Kit Sales Log',   'conversion',   'Rev 2 (2-6-2015)',    98843, 100074, 'STC-bearing conversion book. 45 pages, ~1,232 records.'),
  ('BEECH',  'Beech Bonanza Conversion Kits', 'conversion',   'Rev 002 (9-17-2010)', 76926, 77541,  'STC-bearing conversion book. 22 pages, ~616 records.'),
  ('TRIM',   'Trim Kit Log',                  'options',      'Rev 003 (15-Aug-18)', 6787,  8270,   'Options book, not STC-bearing. PDF 1 (6787-7206) not yet supplied.'),
  ('RV',     'RV Kit Construction Log',       'experimental', '12-23-2008',          3845,  4779,   'Amateur-built/experimental; no STC. No customer column in the paper book.');

INSERT INTO public.stc_certificates (stc_number, description, notes) VALUES
  ('SA3285SO', 'Observed on 172-family STC requests', 'Basis unconfirmed - Roger Danforth to rule before any kit mapping is entered.'),
  ('SA3287SO', 'Observed on 182-family STC requests', 'Basis unconfirmed - Roger Danforth to rule before any kit mapping is entered.');

COMMIT;
