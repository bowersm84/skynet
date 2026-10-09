/* =====================================================================================
   2026-10-09_kit_fb_shipment_lots_step1_schema.sql  --  PROD step 1 of 3 (run whole file)
   New mirror public.fb_shipment_lots (Fishbowl shipped component lots; the bridge's
   future shipments poller writes here too) and public.kit_attach_fb_shipment_lots
   (p_dry_run DEFAULT true), which attaches those lots to bench-logged kit lots.
   Creates objects only; attaches nothing. Expect: success, no rows.

   TEST (ylzmyjjqibpbqbwjsnqj): applied by Claude 2026-10-09 and proven on a six-SO
   subset -- dry run matched the hand count (15 kit lots, 200 rows), live 200, rerun 0,
   loose parts excluded, gate refuses a machinist, anon cannot execute. Test rows
   removed afterwards (TEST back to 16,977 component-lot rows, empty mirror).
   RLS on the mirror with no policies: only the SECURITY DEFINER function reads it.
   ===================================================================================== */

CREATE TABLE IF NOT EXISTS public.fb_shipment_lots (
  fb_shipitem_id   integer     NOT NULL,
  lot_number       text        NOT NULL,
  so_number        text        NOT NULL,
  fb_soitem_id     integer,
  so_line          integer,
  product_num      text        NOT NULL,
  kit_line         integer,
  kit_product_num  text,
  kit_member       boolean,
  kit_qty_fulfilled numeric,
  ship_number      text,
  ship_status      text,
  date_shipped     date,
  qty_shipped      numeric,
  lot_qty          numeric,
  source           text        NOT NULL DEFAULT 'fishbowl_sql',
  first_loaded_at  timestamptz NOT NULL DEFAULT now(),
  last_loaded_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fb_shipment_lots_pkey PRIMARY KEY (fb_shipitem_id, lot_number)
);
ALTER TABLE public.fb_shipment_lots ADD COLUMN IF NOT EXISTS kit_member boolean;
ALTER TABLE public.fb_shipment_lots ADD COLUMN IF NOT EXISTS kit_qty_fulfilled numeric;
CREATE INDEX IF NOT EXISTS fb_shipment_lots_so_idx ON public.fb_shipment_lots (so_number);

ALTER TABLE public.fb_shipment_lots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fb_shipment_lots FROM PUBLIC;
REVOKE ALL ON public.fb_shipment_lots FROM anon, authenticated;
GRANT ALL ON public.fb_shipment_lots TO service_role;

CREATE OR REPLACE FUNCTION public.kit_attach_fb_shipment_lots(p_dry_run boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_planned integer;
  v_inserted integer := 0;
  v_off_bom integer;
  v_lots integer;
  v_report jsonb;
BEGIN
  /* NULL uid = SQL Editor / service; otherwise admin, compliance or the bridge user. */
  IF v_uid IS NOT NULL
     AND NOT public.user_has_role(v_uid, 'admin', 'compliance', 'integration') THEN
    RAISE EXCEPTION 'Not authorized to attach Fishbowl shipment lots';
  END IF;

  DROP TABLE IF EXISTS _kfsl_lots;
  DROP TABLE IF EXISTS _kfsl_plan;

  /* Bench-logged kit lots, keyed the way the August loader keyed them: SO digits from
     the linked sale, else as written; kit key = catalog part number, else as written. */
  CREATE TEMP TABLE _kfsl_lots ON COMMIT DROP AS
  SELECT kl.id AS kit_lot_id, kl.lot_number, kl.kit_sku_id,
         NULLIF(regexp_replace(COALESCE(ks.so_number, kl.so_as_written, ''), '\D', '', 'g'), '') AS so_digits,
         upper(btrim(COALESCE(sku.part_number, kl.kit_part_as_written, ''))) AS kit_key,
         EXISTS (SELECT 1 FROM public.kit_lot_component_lots c WHERE c.kit_lot_id = kl.id) AS had_rows
  FROM public.kit_lots kl
  LEFT JOIN public.kit_sale_lines ksl ON ksl.id = kl.kit_sale_line_id
  LEFT JOIN public.kit_sales ks       ON ks.id  = ksl.kit_sale_id
  LEFT JOIN public.kit_skus sku       ON sku.id = kl.kit_sku_id
  WHERE kl.record_status = 'active' AND kl.source = 'skynet';

  /* Every kit of one type on one SO receives that kit group's full component-lot set
     (D-KSTC-24). Membership is Fishbowl's own (kititem, contiguous under the kit header),
     so loose parts sold after a kit are never attached to it. A part+lot shipped on
     several items collapses to one row, qty summed (the order line's qty, not per kit). */
  CREATE TEMP TABLE _kfsl_plan ON COMMIT DROP AS
  WITH ship AS (
    SELECT NULLIF(regexp_replace(s.so_number, '\D', '', 'g'), '') AS so_digits,
           upper(btrim(s.kit_product_num)) AS kit_key,
           s.product_num, s.lot_number, s.lot_qty, s.date_shipped, s.ship_number, s.so_line
    FROM public.fb_shipment_lots s
    WHERE s.ship_status = 'Shipped' AND s.kit_member IS TRUE
  )
  SELECT l.kit_lot_id, l.kit_sku_id, sh.product_num, sh.lot_number,
         sum(sh.lot_qty) AS qty,
         min(sh.date_shipped) AS ship_date,
         (array_agg(sh.ship_number ORDER BY sh.date_shipped, sh.ship_number))[1] AS ship_number,
         min(sh.so_line) AS so_line,
         false AS off_bom
  FROM _kfsl_lots l
  JOIN ship sh ON sh.so_digits = l.so_digits AND sh.kit_key = l.kit_key
  GROUP BY l.kit_lot_id, l.kit_sku_id, sh.product_num, sh.lot_number;

  /* Flag, never drop: a part Fishbowl ships in the kit but the registry's kit BOM does
     not list (BOM drift). Kits with no BOM are not flagged (the no-BOM queue covers them). */
  UPDATE _kfsl_plan p SET off_bom = true
  WHERE p.kit_sku_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.kit_bom_lines b WHERE b.kit_sku_id = p.kit_sku_id)
    AND NOT EXISTS (
      SELECT 1 FROM public.kit_bom_lines b
      JOIN public.kit_components kc ON kc.id = b.component_id
      WHERE b.kit_sku_id = p.kit_sku_id
        AND upper(regexp_replace(kc.part_number, '\s+', ' ', 'g'))
          = upper(regexp_replace(p.product_num, '\s+', ' ', 'g')));

  v_planned := (SELECT count(*) FROM _kfsl_plan);
  v_off_bom := (SELECT count(*) FROM _kfsl_plan WHERE off_bom);
  v_lots    := (SELECT count(DISTINCT kit_lot_id) FROM _kfsl_plan);

  /* The writes run in both modes; a dry run then raises inside this block so they roll
     back, and only the counts survive (PL/pgSQL variables are not rolled back). */
  BEGIN
    INSERT INTO public.kit_lot_component_lots
      (kit_lot_id, component_id, part_number_as_written, lot_number_as_written,
       qty_shipped, ship_date, shipment_number, so_line_no, source,
       needs_review, review_reason, created_by)
    SELECT p.kit_lot_id,
           (SELECT kc.id FROM public.kit_components kc
             WHERE upper(regexp_replace(kc.part_number, '\s+', ' ', 'g'))
                 = upper(regexp_replace(p.product_num, '\s+', ' ', 'g'))
             ORDER BY kc.id LIMIT 1),
           p.product_num, p.lot_number, p.qty, p.ship_date, p.ship_number, p.so_line,
           'fishbowl_backfill', p.off_bom,
           CASE WHEN p.off_bom THEN 'Not on the kit BOM (Fishbowl shipment)' END,
           NULL
    FROM _kfsl_plan p
    ON CONFLICT ON CONSTRAINT klcl_unique DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF p_dry_run THEN
      RAISE EXCEPTION 'KFSL_DRY_RUN';
    END IF;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'KFSL_DRY_RUN' THEN RAISE; END IF;
  END;

  v_report := jsonb_build_object(
    'dry_run', p_dry_run,
    'mirror_rows', (SELECT count(*) FROM public.fb_shipment_lots),
    'mirror_shipped_kit_rows', (SELECT count(*) FROM public.fb_shipment_lots
                                WHERE ship_status = 'Shipped' AND kit_member IS TRUE),
    'loose_rows_after_a_kit', (SELECT count(*) FROM public.fb_shipment_lots
                               WHERE ship_status = 'Shipped' AND kit_member IS FALSE),
    'bench_lots', (SELECT count(*) FROM _kfsl_lots),
    'kit_lots_matched', v_lots,
    'planned_rows', v_planned,
    'inserted_rows', v_inserted,
    'already_present', v_planned - v_inserted,
    'off_bom_rows', v_off_bom,
    'off_bom_parts', (SELECT COALESCE(jsonb_object_agg(product_num, n), '{}'::jsonb) FROM
                       (SELECT product_num, count(*) n FROM _kfsl_plan WHERE off_bom GROUP BY 1) x),
    'unmatched_bench_lots', (SELECT COALESCE(jsonb_object_agg(reason, lots), '{}'::jsonb) FROM (
        SELECT reason, jsonb_agg(lot_number ORDER BY lot_number) AS lots FROM (
          SELECT l.lot_number,
                 CASE
                   WHEN NOT EXISTS (SELECT 1 FROM public.fb_shipment_lots s
                                    WHERE regexp_replace(s.so_number, '\D', '', 'g') = l.so_digits)
                     THEN 'so_not_in_mirror'
                   WHEN NOT EXISTS (SELECT 1 FROM public.fb_shipment_lots s
                                    WHERE regexp_replace(s.so_number, '\D', '', 'g') = l.so_digits
                                      AND s.ship_status = 'Shipped')
                     THEN 'not_shipped_yet'
                   ELSE 'kit_not_shipped_on_so'
                 END AS reason
          FROM _kfsl_lots l
          WHERE NOT l.had_rows
            AND NOT EXISTS (SELECT 1 FROM _kfsl_plan p WHERE p.kit_lot_id = l.kit_lot_id)
        ) u GROUP BY reason) r),
    'kits_shipped_vs_logged', (SELECT COALESCE(jsonb_agg(
          g.so_number || ' ' || g.kit_product_num || ': shipped ' || COALESCE(g.kits_shipped::text, '?')
          || ', logged ' || g.lots_logged || ' (first ship ' || g.first_ship || ')'
          ORDER BY g.so_number, g.kit_product_num), '[]'::jsonb)
        FROM (
          SELECT k.so_number, k.kit_product_num,
                 (SELECT sum(q) FROM (SELECT DISTINCT s2.kit_line, s2.kit_qty_fulfilled AS q
                                      FROM public.fb_shipment_lots s2
                                      WHERE s2.so_number = k.so_number
                                        AND s2.kit_product_num = k.kit_product_num) d)::integer AS kits_shipped,
                 min(k.date_shipped) AS first_ship,
                 (SELECT count(*) FROM public.kit_lots kl
                   LEFT JOIN public.kit_sale_lines ksl ON ksl.id = kl.kit_sale_line_id
                   LEFT JOIN public.kit_sales ks       ON ks.id  = ksl.kit_sale_id
                   LEFT JOIN public.kit_skus sku       ON sku.id = kl.kit_sku_id
                   WHERE kl.record_status = 'active'
                     AND upper(btrim(COALESCE(sku.part_number, kl.kit_part_as_written, '')))
                         = upper(btrim(k.kit_product_num))
                     AND NULLIF(regexp_replace(k.so_number, '\D', '', 'g'), '') IN (
                           NULLIF(regexp_replace(COALESCE(ks.so_number, kl.so_as_written, ''), '\D', '', 'g'), ''),
                           NULLIF(regexp_replace(COALESCE(kl.invoice_as_written, ''), '\D', '', 'g'), ''))
                 ) AS lots_logged
          FROM public.fb_shipment_lots k
          WHERE k.ship_status = 'Shipped' AND k.kit_member IS TRUE
          GROUP BY k.so_number, k.kit_product_num
        ) g
        WHERE g.lots_logged < COALESCE(g.kits_shipped, 1))
  );
  RETURN v_report;
END
$function$;

REVOKE ALL ON FUNCTION public.kit_attach_fb_shipment_lots(boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.kit_attach_fb_shipment_lots(boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.kit_attach_fb_shipment_lots(boolean) TO authenticated, service_role;
