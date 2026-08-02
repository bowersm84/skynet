-- =====================================================================
-- Kit & STC Registry — schema
-- Applied to TEST 2026-08-01. Loaded from workbook v5_3 on 2026-08-02
-- (see Docs/migrations/kit_stc_load/).
--
-- PROVENANCE NOTE (2026-08-02): the original hand-written migration file
-- was never committed and was not present in the working tree when the
-- /kits bench station was built. This file was regenerated from the live
-- TEST database (pg_dump --schema-only over the 17 registry tables, plus
-- the two supporting functions, which pg_dump does not carry with -t).
-- It is a faithful record of what is deployed on TEST, not the original
-- artifact — formatting and statement order are pg_dump's, not the
-- author's. Treat TEST as the reference when promoting to PROD.
--
-- 17 tables: kit_books, kit_skus, kit_components, kit_bom_lines,
-- kit_parties, stc_certificates, kit_sku_stc_map, kit_sales,
-- kit_sale_lines, fishbowl_invoices, kit_lots, aircraft,
-- aircraft_registrations, kit_installations, stc_requests,
-- stc_issuances, kit_stc_documents.
--
-- NOTE: kit_lots' INSERT policy was subsequently replaced by
-- Docs/migrations/2026-08-02_kit_lots_kiosk_insert.sql (bench station).
-- The policy below is the post-replacement state as deployed.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Supporting functions
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.kstc_issuance_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$

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

END $function$


CREATE OR REPLACE FUNCTION public.kstc_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$

BEGIN

  NEW.updated_at = now();

  RETURN NEW;

END $function$



-- ---------------------------------------------------------------------
-- Tables, constraints, indexes, triggers, RLS
-- ---------------------------------------------------------------------


--
-- Name: aircraft; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aircraft (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    serial_number text,
    registration text,
    make_model text,
    country text,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ac_identity_check CHECK (((serial_number IS NOT NULL) OR (registration IS NOT NULL)))
);


--
-- Name: aircraft_registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aircraft_registrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    aircraft_id uuid NOT NULL,
    registration text NOT NULL,
    observed_date date,
    source text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: fishbowl_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fishbowl_invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    invoice_number text NOT NULL,
    party_id uuid,
    so_number text,
    first_ship_date date,
    invoice_lines integer,
    salesperson text,
    source text DEFAULT 'workbook_v5_3'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: kit_bom_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kit_bom_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kit_sku_id uuid NOT NULL,
    component_id uuid NOT NULL,
    line_number integer,
    qty_per_kit numeric NOT NULL,
    uom text DEFAULT 'ea'::text NOT NULL,
    source text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: kit_books; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kit_books (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    category text NOT NULL,
    revision text,
    first_lot integer,
    last_lot integer,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kit_books_category_check CHECK ((category = ANY (ARRAY['conversion'::text, 'options'::text, 'experimental'::text])))
);


--
-- Name: kit_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kit_components (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    part_number text NOT NULL,
    description text,
    part_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: kit_installations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kit_installations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kit_lot_id uuid,
    kit_sku_id uuid NOT NULL,
    aircraft_id uuid NOT NULL,
    installer_party_id uuid,
    install_date date,
    status text DEFAULT 'claimed'::text NOT NULL,
    evidence text,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kit_installations_status_check CHECK ((status = ANY (ARRAY['claimed'::text, 'verified'::text])))
);


--
-- Name: kit_lots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kit_lots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
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
    record_status text DEFAULT 'active'::text NOT NULL,
    source text DEFAULT 'skynet'::text NOT NULL,
    source_page text,
    transcription_confidence text,
    transcription_notes text,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kit_lots_record_status_check CHECK ((record_status = ANY (ARRAY['active'::text, 'void'::text, 'no_entry'::text]))),
    CONSTRAINT kit_lots_source_check CHECK ((source = ANY (ARRAY['paper_transcription'::text, 'skynet'::text, 'fishbowl'::text]))),
    CONSTRAINT kit_lots_transcription_confidence_check CHECK ((transcription_confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])))
);


--
-- Name: kit_parties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kit_parties (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    normalized_name text NOT NULL,
    fishbowl_customer_number text,
    country text,
    is_distributor boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: kit_sale_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kit_sale_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kit_sale_id uuid NOT NULL,
    kit_sku_id uuid NOT NULL,
    qty_ordered integer,
    qty_shipped integer,
    invoice_numbers text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: kit_sales; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kit_sales (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    so_number text NOT NULL,
    party_id uuid,
    customer_po text,
    order_date date,
    ship_date date,
    so_status text,
    salesperson text,
    source text DEFAULT 'workbook_v5_3'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: kit_sku_stc_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kit_sku_stc_map (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kit_sku_id uuid NOT NULL,
    stc_certificate_id uuid NOT NULL,
    ruled_by uuid,
    ruled_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: kit_skus; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kit_skus (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    part_number text NOT NULL,
    description text,
    kit_scope text DEFAULT 'undetermined'::text NOT NULL,
    stc_applicability text DEFAULT 'undetermined'::text NOT NULL,
    applicability_ruled_by uuid,
    applicability_ruled_at timestamp with time zone,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kit_skus_kit_scope_check CHECK ((kit_scope = ANY (ARRAY['complete'::text, 'partial'::text, 'undetermined'::text]))),
    CONSTRAINT kit_skus_stc_applicability_check CHECK ((stc_applicability = ANY (ARRAY['stc_bearing'::text, 'not_stc'::text, 'undetermined'::text])))
);


--
-- Name: kit_stc_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kit_stc_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    stc_request_id uuid,
    kit_installation_id uuid,
    kit_lot_id uuid,
    document_type text DEFAULT 'other'::text NOT NULL,
    file_name text NOT NULL,
    file_path text NOT NULL,
    file_size bigint,
    mime_type text,
    uploaded_by uuid,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kit_stc_documents_document_type_check CHECK ((document_type = ANY (ARRAY['request_email'::text, 'order_form'::text, 'invoice'::text, 'form_337'::text, 'photo'::text, 'issued_doc'::text, 'other'::text]))),
    CONSTRAINT ksd_link_check CHECK (((stc_request_id IS NOT NULL) OR (kit_installation_id IS NOT NULL) OR (kit_lot_id IS NOT NULL)))
);


--
-- Name: stc_certificates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stc_certificates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    stc_number text NOT NULL,
    description text,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stc_issuances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stc_issuances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
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
    is_voided boolean DEFAULT false NOT NULL,
    voided_reason text,
    voided_by uuid,
    voided_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stc_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stc_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    intake_number integer NOT NULL,
    received_date date,
    channel text DEFAULT 'email'::text NOT NULL,
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
    status text DEFAULT 'new'::text NOT NULL,
    kit_lot_id uuid,
    aircraft_id uuid,
    installation_id uuid,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stc_requests_channel_check CHECK ((channel = ANY (ARRAY['email'::text, 'web_form'::text, 'paper_form'::text, 'phone'::text, 'other'::text]))),
    CONSTRAINT stc_requests_status_check CHECK ((status = ANY (ARRAY['new'::text, 'needs_info'::text, 'matched'::text, 'issued'::text, 'closed'::text, 'unidentifiable'::text])))
);


--
-- Name: aircraft aircraft_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aircraft
    ADD CONSTRAINT aircraft_pkey PRIMARY KEY (id);


--
-- Name: aircraft_registrations aircraft_registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aircraft_registrations
    ADD CONSTRAINT aircraft_registrations_pkey PRIMARY KEY (id);


--
-- Name: aircraft aircraft_serial_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aircraft
    ADD CONSTRAINT aircraft_serial_number_key UNIQUE (serial_number);


--
-- Name: fishbowl_invoices fishbowl_invoices_invoice_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fishbowl_invoices
    ADD CONSTRAINT fishbowl_invoices_invoice_number_key UNIQUE (invoice_number);


--
-- Name: fishbowl_invoices fishbowl_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fishbowl_invoices
    ADD CONSTRAINT fishbowl_invoices_pkey PRIMARY KEY (id);


--
-- Name: kit_bom_lines kbl_sku_component_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_bom_lines
    ADD CONSTRAINT kbl_sku_component_unique UNIQUE (kit_sku_id, component_id);


--
-- Name: kit_bom_lines kit_bom_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_bom_lines
    ADD CONSTRAINT kit_bom_lines_pkey PRIMARY KEY (id);


--
-- Name: kit_books kit_books_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_books
    ADD CONSTRAINT kit_books_code_key UNIQUE (code);


--
-- Name: kit_books kit_books_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_books
    ADD CONSTRAINT kit_books_pkey PRIMARY KEY (id);


--
-- Name: kit_components kit_components_part_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_components
    ADD CONSTRAINT kit_components_part_number_key UNIQUE (part_number);


--
-- Name: kit_components kit_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_components
    ADD CONSTRAINT kit_components_pkey PRIMARY KEY (id);


--
-- Name: kit_installations kit_installations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_installations
    ADD CONSTRAINT kit_installations_pkey PRIMARY KEY (id);


--
-- Name: kit_lots kit_lots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_lots
    ADD CONSTRAINT kit_lots_pkey PRIMARY KEY (id);


--
-- Name: kit_parties kit_parties_normalized_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_parties
    ADD CONSTRAINT kit_parties_normalized_name_key UNIQUE (normalized_name);


--
-- Name: kit_parties kit_parties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_parties
    ADD CONSTRAINT kit_parties_pkey PRIMARY KEY (id);


--
-- Name: kit_sale_lines kit_sale_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_sale_lines
    ADD CONSTRAINT kit_sale_lines_pkey PRIMARY KEY (id);


--
-- Name: kit_sales kit_sales_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_sales
    ADD CONSTRAINT kit_sales_pkey PRIMARY KEY (id);


--
-- Name: kit_sales kit_sales_so_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_sales
    ADD CONSTRAINT kit_sales_so_number_key UNIQUE (so_number);


--
-- Name: kit_sku_stc_map kit_sku_stc_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_sku_stc_map
    ADD CONSTRAINT kit_sku_stc_map_pkey PRIMARY KEY (id);


--
-- Name: kit_skus kit_skus_part_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_skus
    ADD CONSTRAINT kit_skus_part_number_key UNIQUE (part_number);


--
-- Name: kit_skus kit_skus_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_skus
    ADD CONSTRAINT kit_skus_pkey PRIMARY KEY (id);


--
-- Name: kit_stc_documents kit_stc_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_stc_documents
    ADD CONSTRAINT kit_stc_documents_pkey PRIMARY KEY (id);


--
-- Name: kit_lots kl_book_lot_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_lots
    ADD CONSTRAINT kl_book_lot_unique UNIQUE (book_id, lot_number);


--
-- Name: kit_sku_stc_map ksm_sku_cert_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_sku_stc_map
    ADD CONSTRAINT ksm_sku_cert_unique UNIQUE (kit_sku_id, stc_certificate_id);


--
-- Name: stc_certificates stc_certificates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_certificates
    ADD CONSTRAINT stc_certificates_pkey PRIMARY KEY (id);


--
-- Name: stc_certificates stc_certificates_stc_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_certificates
    ADD CONSTRAINT stc_certificates_stc_number_key UNIQUE (stc_number);


--
-- Name: stc_issuances stc_issuances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_issuances
    ADD CONSTRAINT stc_issuances_pkey PRIMARY KEY (id);


--
-- Name: stc_requests stc_requests_intake_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_requests
    ADD CONSTRAINT stc_requests_intake_number_key UNIQUE (intake_number);


--
-- Name: stc_requests stc_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_requests
    ADD CONSTRAINT stc_requests_pkey PRIMARY KEY (id);


--
-- Name: ac_registration_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ac_registration_idx ON public.aircraft USING btree (registration);


--
-- Name: ar_registration_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ar_registration_idx ON public.aircraft_registrations USING btree (registration);


--
-- Name: fbi_so_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fbi_so_idx ON public.fishbowl_invoices USING btree (so_number);


--
-- Name: kbl_component_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX kbl_component_idx ON public.kit_bom_lines USING btree (component_id);


--
-- Name: ki_aircraft_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ki_aircraft_idx ON public.kit_installations USING btree (aircraft_id);


--
-- Name: ki_lot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ki_lot_idx ON public.kit_installations USING btree (kit_lot_id);


--
-- Name: ki_sku_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ki_sku_idx ON public.kit_installations USING btree (kit_sku_id);


--
-- Name: kl_invoice_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX kl_invoice_idx ON public.kit_lots USING btree (invoice_as_written);


--
-- Name: kl_lot_number_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX kl_lot_number_idx ON public.kit_lots USING btree (lot_number);


--
-- Name: kl_party_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX kl_party_idx ON public.kit_lots USING btree (party_id);


--
-- Name: kl_sku_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX kl_sku_idx ON public.kit_lots USING btree (kit_sku_id);


--
-- Name: ksa_party_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ksa_party_idx ON public.kit_sales USING btree (party_id);


--
-- Name: ksl_sale_sku_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ksl_sale_sku_unique ON public.kit_sale_lines USING btree (kit_sale_id, kit_sku_id);


--
-- Name: ksl_sku_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ksl_sku_idx ON public.kit_sale_lines USING btree (kit_sku_id);


--
-- Name: sr_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sr_status_idx ON public.stc_requests USING btree (status);


--
-- Name: aircraft aircraft_touch_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER aircraft_touch_updated BEFORE UPDATE ON public.aircraft FOR EACH ROW EXECUTE FUNCTION public.kstc_touch_updated_at();


--
-- Name: kit_books kit_books_touch_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER kit_books_touch_updated BEFORE UPDATE ON public.kit_books FOR EACH ROW EXECUTE FUNCTION public.kstc_touch_updated_at();


--
-- Name: kit_components kit_components_touch_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER kit_components_touch_updated BEFORE UPDATE ON public.kit_components FOR EACH ROW EXECUTE FUNCTION public.kstc_touch_updated_at();


--
-- Name: kit_installations kit_installations_touch_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER kit_installations_touch_updated BEFORE UPDATE ON public.kit_installations FOR EACH ROW EXECUTE FUNCTION public.kstc_touch_updated_at();


--
-- Name: kit_lots kit_lots_touch_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER kit_lots_touch_updated BEFORE UPDATE ON public.kit_lots FOR EACH ROW EXECUTE FUNCTION public.kstc_touch_updated_at();


--
-- Name: kit_parties kit_parties_touch_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER kit_parties_touch_updated BEFORE UPDATE ON public.kit_parties FOR EACH ROW EXECUTE FUNCTION public.kstc_touch_updated_at();


--
-- Name: kit_sales kit_sales_touch_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER kit_sales_touch_updated BEFORE UPDATE ON public.kit_sales FOR EACH ROW EXECUTE FUNCTION public.kstc_touch_updated_at();


--
-- Name: kit_skus kit_skus_touch_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER kit_skus_touch_updated BEFORE UPDATE ON public.kit_skus FOR EACH ROW EXECUTE FUNCTION public.kstc_touch_updated_at();


--
-- Name: stc_certificates stc_certificates_touch_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER stc_certificates_touch_updated BEFORE UPDATE ON public.stc_certificates FOR EACH ROW EXECUTE FUNCTION public.kstc_touch_updated_at();


--
-- Name: stc_issuances stc_issuances_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER stc_issuances_guard BEFORE DELETE OR UPDATE ON public.stc_issuances FOR EACH ROW EXECUTE FUNCTION public.kstc_issuance_guard();


--
-- Name: stc_requests stc_requests_touch_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER stc_requests_touch_updated BEFORE UPDATE ON public.stc_requests FOR EACH ROW EXECUTE FUNCTION public.kstc_touch_updated_at();


--
-- Name: aircraft ac_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aircraft
    ADD CONSTRAINT ac_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: aircraft ac_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aircraft
    ADD CONSTRAINT ac_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id);


--
-- Name: aircraft_registrations ar_aircraft_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aircraft_registrations
    ADD CONSTRAINT ar_aircraft_fkey FOREIGN KEY (aircraft_id) REFERENCES public.aircraft(id);


--
-- Name: fishbowl_invoices fbi_party_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fishbowl_invoices
    ADD CONSTRAINT fbi_party_fkey FOREIGN KEY (party_id) REFERENCES public.kit_parties(id);


--
-- Name: kit_bom_lines kbl_component_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_bom_lines
    ADD CONSTRAINT kbl_component_fkey FOREIGN KEY (component_id) REFERENCES public.kit_components(id);


--
-- Name: kit_bom_lines kbl_sku_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_bom_lines
    ADD CONSTRAINT kbl_sku_fkey FOREIGN KEY (kit_sku_id) REFERENCES public.kit_skus(id);


--
-- Name: kit_components kc_part_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_components
    ADD CONSTRAINT kc_part_fkey FOREIGN KEY (part_id) REFERENCES public.parts(id);


--
-- Name: kit_installations ki_aircraft_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_installations
    ADD CONSTRAINT ki_aircraft_fkey FOREIGN KEY (aircraft_id) REFERENCES public.aircraft(id);


--
-- Name: kit_installations ki_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_installations
    ADD CONSTRAINT ki_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: kit_installations ki_installer_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_installations
    ADD CONSTRAINT ki_installer_fkey FOREIGN KEY (installer_party_id) REFERENCES public.kit_parties(id);


--
-- Name: kit_installations ki_lot_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_installations
    ADD CONSTRAINT ki_lot_fkey FOREIGN KEY (kit_lot_id) REFERENCES public.kit_lots(id);


--
-- Name: kit_installations ki_sku_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_installations
    ADD CONSTRAINT ki_sku_fkey FOREIGN KEY (kit_sku_id) REFERENCES public.kit_skus(id);


--
-- Name: kit_installations ki_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_installations
    ADD CONSTRAINT ki_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id);


--
-- Name: kit_lots kl_book_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_lots
    ADD CONSTRAINT kl_book_fkey FOREIGN KEY (book_id) REFERENCES public.kit_books(id);


--
-- Name: kit_lots kl_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_lots
    ADD CONSTRAINT kl_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: kit_lots kl_party_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_lots
    ADD CONSTRAINT kl_party_fkey FOREIGN KEY (party_id) REFERENCES public.kit_parties(id);


--
-- Name: kit_lots kl_sale_line_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_lots
    ADD CONSTRAINT kl_sale_line_fkey FOREIGN KEY (kit_sale_line_id) REFERENCES public.kit_sale_lines(id);


--
-- Name: kit_lots kl_sku_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_lots
    ADD CONSTRAINT kl_sku_fkey FOREIGN KEY (kit_sku_id) REFERENCES public.kit_skus(id);


--
-- Name: kit_lots kl_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_lots
    ADD CONSTRAINT kl_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id);


--
-- Name: kit_skus ks_ruled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_skus
    ADD CONSTRAINT ks_ruled_by_fkey FOREIGN KEY (applicability_ruled_by) REFERENCES public.profiles(id);


--
-- Name: kit_sales ksa_party_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_sales
    ADD CONSTRAINT ksa_party_fkey FOREIGN KEY (party_id) REFERENCES public.kit_parties(id);


--
-- Name: kit_stc_documents ksd_installation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_stc_documents
    ADD CONSTRAINT ksd_installation_fkey FOREIGN KEY (kit_installation_id) REFERENCES public.kit_installations(id);


--
-- Name: kit_stc_documents ksd_lot_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_stc_documents
    ADD CONSTRAINT ksd_lot_fkey FOREIGN KEY (kit_lot_id) REFERENCES public.kit_lots(id);


--
-- Name: kit_stc_documents ksd_request_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_stc_documents
    ADD CONSTRAINT ksd_request_fkey FOREIGN KEY (stc_request_id) REFERENCES public.stc_requests(id);


--
-- Name: kit_stc_documents ksd_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_stc_documents
    ADD CONSTRAINT ksd_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.profiles(id);


--
-- Name: kit_sale_lines ksl_sale_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_sale_lines
    ADD CONSTRAINT ksl_sale_fkey FOREIGN KEY (kit_sale_id) REFERENCES public.kit_sales(id);


--
-- Name: kit_sale_lines ksl_sku_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_sale_lines
    ADD CONSTRAINT ksl_sku_fkey FOREIGN KEY (kit_sku_id) REFERENCES public.kit_skus(id);


--
-- Name: kit_sku_stc_map ksm_cert_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_sku_stc_map
    ADD CONSTRAINT ksm_cert_fkey FOREIGN KEY (stc_certificate_id) REFERENCES public.stc_certificates(id);


--
-- Name: kit_sku_stc_map ksm_ruled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_sku_stc_map
    ADD CONSTRAINT ksm_ruled_by_fkey FOREIGN KEY (ruled_by) REFERENCES public.profiles(id);


--
-- Name: kit_sku_stc_map ksm_sku_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kit_sku_stc_map
    ADD CONSTRAINT ksm_sku_fkey FOREIGN KEY (kit_sku_id) REFERENCES public.kit_skus(id);


--
-- Name: stc_issuances si_cert_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_issuances
    ADD CONSTRAINT si_cert_fkey FOREIGN KEY (stc_certificate_id) REFERENCES public.stc_certificates(id);


--
-- Name: stc_issuances si_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_issuances
    ADD CONSTRAINT si_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: stc_issuances si_installation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_issuances
    ADD CONSTRAINT si_installation_fkey FOREIGN KEY (installation_id) REFERENCES public.kit_installations(id);


--
-- Name: stc_issuances si_request_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_issuances
    ADD CONSTRAINT si_request_fkey FOREIGN KEY (stc_request_id) REFERENCES public.stc_requests(id);


--
-- Name: stc_issuances si_sent_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_issuances
    ADD CONSTRAINT si_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES public.profiles(id);


--
-- Name: stc_issuances si_voided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_issuances
    ADD CONSTRAINT si_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES public.profiles(id);


--
-- Name: stc_requests sr_aircraft_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_requests
    ADD CONSTRAINT sr_aircraft_fkey FOREIGN KEY (aircraft_id) REFERENCES public.aircraft(id);


--
-- Name: stc_requests sr_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_requests
    ADD CONSTRAINT sr_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: stc_requests sr_installation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_requests
    ADD CONSTRAINT sr_installation_fkey FOREIGN KEY (installation_id) REFERENCES public.kit_installations(id);


--
-- Name: stc_requests sr_lot_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_requests
    ADD CONSTRAINT sr_lot_fkey FOREIGN KEY (kit_lot_id) REFERENCES public.kit_lots(id);


--
-- Name: stc_requests sr_purchased_from_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_requests
    ADD CONSTRAINT sr_purchased_from_fkey FOREIGN KEY (purchased_from_party_id) REFERENCES public.kit_parties(id);


--
-- Name: stc_requests sr_requester_party_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_requests
    ADD CONSTRAINT sr_requester_party_fkey FOREIGN KEY (requester_party_id) REFERENCES public.kit_parties(id);


--
-- Name: stc_requests sr_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stc_requests
    ADD CONSTRAINT sr_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id);


--
-- Name: aircraft; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.aircraft ENABLE ROW LEVEL SECURITY;

--
-- Name: aircraft aircraft_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY aircraft_delete_admin ON public.aircraft FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: aircraft aircraft_insert_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY aircraft_insert_workflow ON public.aircraft FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: aircraft_registrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.aircraft_registrations ENABLE ROW LEVEL SECURITY;

--
-- Name: aircraft_registrations aircraft_registrations_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY aircraft_registrations_delete_admin ON public.aircraft_registrations FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: aircraft_registrations aircraft_registrations_insert_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY aircraft_registrations_insert_workflow ON public.aircraft_registrations FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: aircraft_registrations aircraft_registrations_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY aircraft_registrations_select_authenticated ON public.aircraft_registrations FOR SELECT TO authenticated USING (true);


--
-- Name: aircraft_registrations aircraft_registrations_update_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY aircraft_registrations_update_workflow ON public.aircraft_registrations FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: aircraft aircraft_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY aircraft_select_authenticated ON public.aircraft FOR SELECT TO authenticated USING (true);


--
-- Name: aircraft aircraft_update_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY aircraft_update_workflow ON public.aircraft FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: fishbowl_invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fishbowl_invoices ENABLE ROW LEVEL SECURITY;

--
-- Name: fishbowl_invoices fishbowl_invoices_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fishbowl_invoices_delete_admin ON public.fishbowl_invoices FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: fishbowl_invoices fishbowl_invoices_insert_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fishbowl_invoices_insert_workflow ON public.fishbowl_invoices FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: fishbowl_invoices fishbowl_invoices_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fishbowl_invoices_select_authenticated ON public.fishbowl_invoices FOR SELECT TO authenticated USING (true);


--
-- Name: fishbowl_invoices fishbowl_invoices_update_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fishbowl_invoices_update_workflow ON public.fishbowl_invoices FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: kit_bom_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kit_bom_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: kit_bom_lines kit_bom_lines_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_bom_lines_delete_admin ON public.kit_bom_lines FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: kit_bom_lines kit_bom_lines_insert_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_bom_lines_insert_master ON public.kit_bom_lines FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text]));


--
-- Name: kit_bom_lines kit_bom_lines_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_bom_lines_select_authenticated ON public.kit_bom_lines FOR SELECT TO authenticated USING (true);


--
-- Name: kit_bom_lines kit_bom_lines_update_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_bom_lines_update_master ON public.kit_bom_lines FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text]));


--
-- Name: kit_books; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kit_books ENABLE ROW LEVEL SECURITY;

--
-- Name: kit_books kit_books_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_books_delete_admin ON public.kit_books FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: kit_books kit_books_insert_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_books_insert_master ON public.kit_books FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text]));


--
-- Name: kit_books kit_books_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_books_select_authenticated ON public.kit_books FOR SELECT TO authenticated USING (true);


--
-- Name: kit_books kit_books_update_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_books_update_master ON public.kit_books FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text]));


--
-- Name: kit_components; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kit_components ENABLE ROW LEVEL SECURITY;

--
-- Name: kit_components kit_components_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_components_delete_admin ON public.kit_components FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: kit_components kit_components_insert_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_components_insert_master ON public.kit_components FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text]));


--
-- Name: kit_components kit_components_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_components_select_authenticated ON public.kit_components FOR SELECT TO authenticated USING (true);


--
-- Name: kit_components kit_components_update_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_components_update_master ON public.kit_components FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text]));


--
-- Name: kit_installations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kit_installations ENABLE ROW LEVEL SECURITY;

--
-- Name: kit_installations kit_installations_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_installations_delete_admin ON public.kit_installations FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: kit_installations kit_installations_insert_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_installations_insert_workflow ON public.kit_installations FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: kit_installations kit_installations_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_installations_select_authenticated ON public.kit_installations FOR SELECT TO authenticated USING (true);


--
-- Name: kit_installations kit_installations_update_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_installations_update_workflow ON public.kit_installations FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: kit_lots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kit_lots ENABLE ROW LEVEL SECURITY;

--
-- Name: kit_lots kit_lots_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_lots_delete_admin ON public.kit_lots FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: kit_lots kit_lots_insert_kiosk; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_lots_insert_kiosk ON public.kit_lots FOR INSERT TO authenticated WITH CHECK ((source = 'skynet'::text));


--
-- Name: kit_lots kit_lots_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_lots_select_authenticated ON public.kit_lots FOR SELECT TO authenticated USING (true);


--
-- Name: kit_lots kit_lots_update_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_lots_update_workflow ON public.kit_lots FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: kit_parties; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kit_parties ENABLE ROW LEVEL SECURITY;

--
-- Name: kit_parties kit_parties_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_parties_delete_admin ON public.kit_parties FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: kit_parties kit_parties_insert_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_parties_insert_workflow ON public.kit_parties FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: kit_parties kit_parties_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_parties_select_authenticated ON public.kit_parties FOR SELECT TO authenticated USING (true);


--
-- Name: kit_parties kit_parties_update_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_parties_update_workflow ON public.kit_parties FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: kit_sale_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kit_sale_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: kit_sale_lines kit_sale_lines_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_sale_lines_delete_admin ON public.kit_sale_lines FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: kit_sale_lines kit_sale_lines_insert_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_sale_lines_insert_workflow ON public.kit_sale_lines FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: kit_sale_lines kit_sale_lines_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_sale_lines_select_authenticated ON public.kit_sale_lines FOR SELECT TO authenticated USING (true);


--
-- Name: kit_sale_lines kit_sale_lines_update_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_sale_lines_update_workflow ON public.kit_sale_lines FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: kit_sales; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kit_sales ENABLE ROW LEVEL SECURITY;

--
-- Name: kit_sales kit_sales_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_sales_delete_admin ON public.kit_sales FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: kit_sales kit_sales_insert_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_sales_insert_workflow ON public.kit_sales FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: kit_sales kit_sales_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_sales_select_authenticated ON public.kit_sales FOR SELECT TO authenticated USING (true);


--
-- Name: kit_sales kit_sales_update_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_sales_update_workflow ON public.kit_sales FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: kit_sku_stc_map; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kit_sku_stc_map ENABLE ROW LEVEL SECURITY;

--
-- Name: kit_sku_stc_map kit_sku_stc_map_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_sku_stc_map_delete_admin ON public.kit_sku_stc_map FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: kit_sku_stc_map kit_sku_stc_map_insert_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_sku_stc_map_insert_master ON public.kit_sku_stc_map FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text]));


--
-- Name: kit_sku_stc_map kit_sku_stc_map_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_sku_stc_map_select_authenticated ON public.kit_sku_stc_map FOR SELECT TO authenticated USING (true);


--
-- Name: kit_sku_stc_map kit_sku_stc_map_update_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_sku_stc_map_update_master ON public.kit_sku_stc_map FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text]));


--
-- Name: kit_skus; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kit_skus ENABLE ROW LEVEL SECURITY;

--
-- Name: kit_skus kit_skus_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_skus_delete_admin ON public.kit_skus FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: kit_skus kit_skus_insert_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_skus_insert_master ON public.kit_skus FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text]));


--
-- Name: kit_skus kit_skus_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_skus_select_authenticated ON public.kit_skus FOR SELECT TO authenticated USING (true);


--
-- Name: kit_skus kit_skus_update_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_skus_update_master ON public.kit_skus FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text]));


--
-- Name: kit_stc_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kit_stc_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: kit_stc_documents kit_stc_documents_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_stc_documents_delete_admin ON public.kit_stc_documents FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: kit_stc_documents kit_stc_documents_insert_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_stc_documents_insert_workflow ON public.kit_stc_documents FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: kit_stc_documents kit_stc_documents_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_stc_documents_select_authenticated ON public.kit_stc_documents FOR SELECT TO authenticated USING (true);


--
-- Name: kit_stc_documents kit_stc_documents_update_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kit_stc_documents_update_workflow ON public.kit_stc_documents FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: stc_certificates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stc_certificates ENABLE ROW LEVEL SECURITY;

--
-- Name: stc_certificates stc_certificates_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stc_certificates_delete_admin ON public.stc_certificates FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: stc_certificates stc_certificates_insert_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stc_certificates_insert_master ON public.stc_certificates FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text]));


--
-- Name: stc_certificates stc_certificates_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stc_certificates_select_authenticated ON public.stc_certificates FOR SELECT TO authenticated USING (true);


--
-- Name: stc_certificates stc_certificates_update_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stc_certificates_update_master ON public.stc_certificates FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text]));


--
-- Name: stc_issuances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stc_issuances ENABLE ROW LEVEL SECURITY;

--
-- Name: stc_issuances stc_issuances_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stc_issuances_delete_admin ON public.stc_issuances FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: stc_issuances stc_issuances_insert_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stc_issuances_insert_workflow ON public.stc_issuances FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: stc_issuances stc_issuances_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stc_issuances_select_authenticated ON public.stc_issuances FOR SELECT TO authenticated USING (true);


--
-- Name: stc_issuances stc_issuances_update_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stc_issuances_update_workflow ON public.stc_issuances FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: stc_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stc_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: stc_requests stc_requests_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stc_requests_delete_admin ON public.stc_requests FOR DELETE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text]));


--
-- Name: stc_requests stc_requests_insert_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stc_requests_insert_workflow ON public.stc_requests FOR INSERT TO authenticated WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
-- Name: stc_requests stc_requests_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stc_requests_select_authenticated ON public.stc_requests FOR SELECT TO authenticated USING (true);


--
-- Name: stc_requests stc_requests_update_workflow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stc_requests_update_workflow ON public.stc_requests FOR UPDATE TO authenticated USING (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text])) WITH CHECK (public.user_has_role(auth.uid(), VARIADIC ARRAY['admin'::text, 'compliance'::text, 'customer_service'::text, 'scheduler'::text]));


--
--



