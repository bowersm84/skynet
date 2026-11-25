-- ============================================================================
-- S17 D1e — the tablet lists each component lot once.
-- 2026-11-12
--
-- Found in the Nov 12 demo: the same lot showed as several tiles. Fishbowl can hold one lot in more than one tag
-- (two locations, or part of it moved by a pick), and assembly_kiosk_components listed one entry per tag.
-- It now lists one entry per lot number, with the quantities added up. assembly_build_start already added them up.
--
-- Applied on TEST by Claude on 2026-11-12 (migration s17_d1e_kiosk_lots_grouped_by_lot).
-- This file was rebuilt from TEST's migration record on 2026-11-24, because no copy was found in the
-- context pack of Docs/migrations; the function body below matches TEST byte for byte.
-- PROD: not yet. Run after D1d and before D2a.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.assembly_kiosk_components(p_build_id uuid)
 RETURNS TABLE(component_part_number text, part_description text, qty_per_unit numeric, qty_needed numeric, wave integer, lots jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE b public.assembly_builds%ROWTYPE;
BEGIN
  PERFORM public._fb_gate(ARRAY['admin','assembly']);
  SELECT * INTO b FROM public.assembly_builds WHERE id = p_build_id;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Unknown build'; END IF;

  RETURN QUERY
  SELECT bi.part_num,
         bi.part_description,
         bi.quantity,
         (bi.quantity * b.quantity)::numeric,
         CASE WHEN b.build_kind = 'program' AND bi.part_description ILIKE '%nylon%' THEN 1
              WHEN b.build_kind = 'program' THEN 2 ELSE 1 END AS wave,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('tag_id', g.tag_id, 'lot', g.lot_number, 'qty', g.qty,
                                                       'location', g.location, 'received', g.received)
                                    ORDER BY g.received, g.lot_number)
                   FROM (SELECT min(t.fb_tag_id) AS tag_id, t.lot_number, sum(t.qty) AS qty,
                                string_agg(DISTINCT t.location, ', ' ORDER BY t.location) AS location,
                                min(t.tag_created) AS received
                           FROM public.fb_tags t
                          WHERE t.part_num = bi.part_num AND t.removed_at IS NULL AND t.qty > 0 AND t.lot_number IS NOT NULL
                          GROUP BY t.lot_number) g), '[]'::jsonb)
  FROM public.fb_boms fb
  JOIN public.fb_bom_items bi ON bi.fb_bom_id = fb.fb_bom_id AND bi.type_id = 20 AND COALESCE(bi.uom_id, 0) <> 4
  WHERE fb.bom_num = b.part_number AND fb.active AND fb.removed_at IS NULL
    AND NOT (b.build_kind = 'program' AND EXISTS (
          SELECT 1 FROM public.program_parts pp JOIN public.parts p ON p.id = pp.part_id
          WHERE pp.program_id = b.program_id AND pp.role = 'nut' AND p.part_number = bi.part_num))
  ORDER BY bi.sort_id, bi.part_num;
END $function$;
REVOKE ALL ON FUNCTION public.assembly_kiosk_components(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assembly_kiosk_components(uuid) TO authenticated, service_role;
