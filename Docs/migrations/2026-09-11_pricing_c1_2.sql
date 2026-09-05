/* ============================================================================
   S11 Batch C1.2 — admin image management (add / delete pictures per part and section)
   Supabase SQL Editor, TEST first. Idempotent.
   - sections may carry several pictures (unique index dropped); a part keeps one
   - pricing_upsert_image / pricing_delete_image (admin), storage write policies on
     bucket pricing-images for admin; public read is the bucket's own setting
   ============================================================================ */
DROP INDEX IF EXISTS public.price_images_section_uniq;

CREATE OR REPLACE FUNCTION public.pricing_upsert_image(p_scope text, p_part text, p_section_source_row integer, p_storage_path text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_key text := CASE WHEN p_part IS NULL THEN NULL ELSE upper(regexp_replace(p_part, '\s', '', 'g')) END;
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles());
  IF p_scope = 'part' THEN
    IF v_key IS NULL THEN RAISE EXCEPTION 'IMAGE: part required'; END IF;
    INSERT INTO public.price_images (scope, part_key, storage_path) VALUES ('part', v_key, p_storage_path)
    ON CONFLICT (part_key) WHERE scope = 'part' DO UPDATE SET storage_path = EXCLUDED.storage_path, created_at = now()
    RETURNING id INTO v_id;
  ELSIF p_scope = 'section' THEN
    IF p_section_source_row IS NULL THEN RAISE EXCEPTION 'IMAGE: section required'; END IF;
    INSERT INTO public.price_images (scope, section_source_row, storage_path) VALUES ('section', p_section_source_row, p_storage_path) RETURNING id INTO v_id;
  ELSE RAISE EXCEPTION 'IMAGE: scope must be part or section'; END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.pricing_delete_image(p_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_path text;
BEGIN
  PERFORM public._pricing_gate(public._pricing_edit_roles());
  DELETE FROM public.price_images WHERE id = p_id RETURNING storage_path INTO v_path;
  RETURN v_path;   /* the client removes the file from the bucket */
END $$;
REVOKE ALL ON FUNCTION public.pricing_upsert_image(text,text,integer,text), public.pricing_delete_image(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pricing_upsert_image(text,text,integer,text), public.pricing_delete_image(uuid) TO authenticated;

/* sections created later in the Price Books editor get a synthetic source_row so they can carry pictures */
CREATE SEQUENCE IF NOT EXISTS public.price_sections_synthetic_row_seq START 100000;
UPDATE public.price_sections SET source_row = nextval('public.price_sections_synthetic_row_seq') WHERE source_row IS NULL;

/* storage: admin may add / replace / remove objects in pricing-images */
DROP POLICY IF EXISTS pricing_images_admin_insert ON storage.objects;
DROP POLICY IF EXISTS pricing_images_admin_update ON storage.objects;
DROP POLICY IF EXISTS pricing_images_admin_delete ON storage.objects;
CREATE POLICY pricing_images_admin_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'pricing-images' AND public.user_has_role(auth.uid(), 'admin'));
CREATE POLICY pricing_images_admin_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'pricing-images' AND public.user_has_role(auth.uid(), 'admin'));
CREATE POLICY pricing_images_admin_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'pricing-images' AND public.user_has_role(auth.uid(), 'admin'));

/* verify */
SELECT count(*) FILTER (WHERE source_row IS NULL) AS sections_without_row FROM public.price_sections;   /* 0 */
