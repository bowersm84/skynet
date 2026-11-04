-- ============================================================================
-- S17 Batch B2 — assemblers not benches, avatar + colour per assembler,
--                 app_settings categories for the Costing rules tab
-- 2026-11-05  ·  D-ASM-32, D-ASM-34
--
-- Applied on TEST by Claude on 2026-11-04 (migration
-- s17_b2_assemblers_avatars_settings); this file is the PROD copy, run after
-- the B1 migration and before the Batch B2 deploy. Idempotent.
-- ============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_icon  text,
  ADD COLUMN IF NOT EXISTS avatar_color text;
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_avatar_color_check') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_avatar_color_check
      CHECK (avatar_color IS NULL OR avatar_color ~ '^#[0-9A-Fa-f]{6}$');
  END IF;
END
$chk$;

-- Self-service (own profile) or admin.
CREATE OR REPLACE FUNCTION public.profile_set_avatar(p_profile_id uuid, p_icon text, p_color text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NOT NULL AND v_uid <> p_profile_id AND NOT public.user_has_role(v_uid, 'admin') THEN
    RAISE EXCEPTION 'Not permitted: you can only change your own avatar';
  END IF;
  UPDATE public.profiles SET avatar_icon = NULLIF(btrim(p_icon), ''), avatar_color = NULLIF(btrim(p_color), ''), updated_at = now()
   WHERE id = p_profile_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown profile'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.profile_set_avatar(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_set_avatar(uuid, text, text) TO authenticated, service_role;

-- Settings get a category, a label, a unit and an order so the Costing rules
-- tab can list its own keys; future costing rules land here with category 'costing'.
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS category   text NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS label      text,
  ADD COLUMN IF NOT EXISTS unit       text,
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
UPDATE public.app_settings SET category = 'costing',  label = 'Assembly labor rate',                unit = '$/hour',         sort_order = 10 WHERE key = 'assembly_labor_rate';
UPDATE public.app_settings SET category = 'costing',  label = 'Manufacturing-support overhead',     unit = '% of conversion', sort_order = 20 WHERE key = 'mfg_support_overhead_pct';
UPDATE public.app_settings SET category = 'assembly', label = 'Assembly lot display prefix',        unit = NULL,             sort_order = 10 WHERE key = 'assembly_lot_prefix_display';
UPDATE public.app_settings SET category = 'assembly', label = 'Second PIN on a new lot combination', unit = NULL,             sort_order = 20 WHERE key = 'assembly_lot_new_set_second_pin';

-- Board view: assignee avatar and colour (benches stay in the table, off the board).
DROP VIEW IF EXISTS public.v_assembly_builds_board;
CREATE VIEW public.v_assembly_builds_board WITH (security_invoker = true) AS
SELECT b.*,
       p.description AS part_description, p.assembly_family,
       bn.name AS bench_name,
       pa.full_name AS assigned_name, pa.avatar_icon AS assigned_avatar_icon, pa.avatar_color AS assigned_avatar_color,
       t.name AS template_name, t.status AS template_status,
       (SELECT COUNT(*)::int FROM public.assembly_requests r WHERE r.build_id = b.id) AS request_count,
       (SELECT COUNT(*)::int FROM public.assembly_sessions s WHERE s.build_id = b.id AND s.clock_out IS NULL) AS open_sessions,
       (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(s.clock_out, now()) - s.clock_in)) / 60), 0)::numeric(10,1)
          FROM public.assembly_sessions s WHERE s.build_id = b.id) AS minutes_total,
       (SELECT COUNT(*)::int FROM public.assembly_component_lots cl WHERE cl.build_id = b.id) AS lots_recorded
FROM public.assembly_builds b
LEFT JOIN public.parts p ON p.id = b.part_id
LEFT JOIN public.assembly_benches bn ON bn.id = b.bench_id
LEFT JOIN public.profiles pa ON pa.id = b.assigned_to
LEFT JOIN public.assembly_checklist_templates t ON t.id = b.checklist_template_id;
GRANT SELECT ON public.v_assembly_builds_board TO authenticated;

-- Assemblers for the board columns and the kiosk.
CREATE OR REPLACE VIEW public.v_assemblers WITH (security_invoker = true) AS
SELECT id, full_name, username, avatar_icon, avatar_color, is_active
FROM public.profiles
WHERE is_active AND (role = 'assembly' OR 'assembly' = ANY(COALESCE(roles, '{}')))
ORDER BY full_name;
GRANT SELECT ON public.v_assemblers TO authenticated;
