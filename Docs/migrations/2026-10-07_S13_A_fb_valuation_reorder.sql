/* ============================================================================================
   S13 Batch A - Fishbowl inventory module: valuation mirror, reorder points, evaluation, reports
   File: Docs/migrations/2026-10-07_S13_A_fb_valuation_reorder.sql
   Decisions: D-FBINV-01 (class scope + reorder basis), D-FBINV-02 (reorder table + alerts),
              D-FB-52 (bridge 1.8.0 valuation mirror + scope), D-RPT-16 (registry views)

   HOW TO RUN: the Supabase SQL Editor runs a pasted sheet as ONE transaction. Run the blocks one at a
   time, in order. Every block is idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING / CREATE OR REPLACE).
   Block 5 is a READ-ONLY PREVIEW of the seed - paste its rows back before running block 6 on PROD.
   TEST: applied by Claude 2026-10-07 (results in chat). PROD: Matt, before the bridge 1.8.0 deploy.
   ============================================================================================ */


/* ---------- BLOCK 1 : fb_sync_state clock for the valuation mirror ---------- */
ALTER TABLE public.fb_sync_state ADD COLUMN IF NOT EXISTS last_valuation_at timestamptz;


/* ---------- BLOCK 2 : fb_part_valuation - nightly mirror of the opening-valuation query ---------- */
/* One row per Fishbowl part with typeId = 10, keyed by part.num exactly as Fishbowl spells it.
   valuation_class = part.customFields '$."33".value' ('(unclassified)' when missing).
   qty_on_hand = SUM(tag.qty); avg_cost / total_cost / cost_layer_qty from partcost. All classes are
   mirrored; the module and the month-end filter to 'Product' (D-FBINV-01). */
CREATE TABLE IF NOT EXISTS public.fb_part_valuation (
  part_num        text PRIMARY KEY,
  part_key        text GENERATED ALWAYS AS (upper(btrim(part_num))) STORED,
  fb_part_id      integer,
  description     text,
  is_active       boolean NOT NULL DEFAULT true,
  valuation_class text NOT NULL DEFAULT '(unclassified)',
  qty_on_hand     numeric NOT NULL DEFAULT 0,
  avg_cost        numeric,
  total_cost      numeric,
  cost_layer_qty  numeric,
  has_product     boolean NOT NULL DEFAULT false,
  used_in_boms    boolean NOT NULL DEFAULT false,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz
);
CREATE INDEX IF NOT EXISTS fb_part_valuation_key_idx   ON public.fb_part_valuation (part_key);
CREATE INDEX IF NOT EXISTS fb_part_valuation_class_idx ON public.fb_part_valuation (valuation_class) WHERE removed_at IS NULL;
ALTER TABLE public.fb_part_valuation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fbval_select_authenticated ON public.fb_part_valuation;
CREATE POLICY fbval_select_authenticated ON public.fb_part_valuation FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.fb_part_valuation FROM anon, public;
GRANT SELECT ON public.fb_part_valuation TO authenticated;

/* The 5-minute mirror is joined to the reorder rules and the valuation on upper(btrim(part_num)) -
   the same match fb_upsert_inventory already uses against parts.part_number. */
CREATE INDEX IF NOT EXISTS fb_part_inventory_key_idx ON public.fb_part_inventory (upper(btrim(part_num)));

/* Bridge RPC: upsert a batch (camelCase keys, like fb_upsert_inventory). Stamps the clock. */
CREATE OR REPLACE FUNCTION public.fb_upsert_part_valuation(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration', 'admin']);
  INSERT INTO public.fb_part_valuation
    (part_num, fb_part_id, description, is_active, valuation_class, qty_on_hand, avg_cost, total_cost,
     cost_layer_qty, has_product, used_in_boms, synced_at, removed_at)
  SELECT btrim(r->>'partNum'),
         NULLIF(r->>'partId', '')::integer,
         r->>'description',
         COALESCE((r->>'activeFlag')::boolean, true),
         COALESCE(NULLIF(btrim(r->>'valuationClass'), ''), '(unclassified)'),
         COALESCE(NULLIF(r->>'qtyOnHand', '')::numeric, 0),
         NULLIF(r->>'avgCost', '')::numeric,
         NULLIF(r->>'totalCost', '')::numeric,
         NULLIF(r->>'costLayerQty', '')::numeric,
         COALESCE((r->>'hasProduct')::boolean, false),
         COALESCE((r->>'usedInBoms')::boolean, false),
         now(),
         NULL
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) r
   WHERE COALESCE(btrim(r->>'partNum'), '') <> ''
  ON CONFLICT (part_num) DO UPDATE
     SET fb_part_id = EXCLUDED.fb_part_id, description = EXCLUDED.description, is_active = EXCLUDED.is_active,
         valuation_class = EXCLUDED.valuation_class, qty_on_hand = EXCLUDED.qty_on_hand, avg_cost = EXCLUDED.avg_cost,
         total_cost = EXCLUDED.total_cost, cost_layer_qty = EXCLUDED.cost_layer_qty, has_product = EXCLUDED.has_product,
         used_in_boms = EXCLUDED.used_in_boms, synced_at = now(), removed_at = NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.fb_sync_state SET last_valuation_at = now(), updated_at = now() WHERE id = 1;
  RETURN v_n;
END;
$function$;
REVOKE ALL ON FUNCTION public.fb_upsert_part_valuation(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fb_upsert_part_valuation(jsonb) TO authenticated;

/* Bridge RPC, called once after the last batch of a full nightly read: a part that was not in tonight's
   payload has left typeId 10 or Fishbowl - stamp removed_at so views and the month-end drop it.
   The cutoff is derived from the DB clock only (the newest synced_at of the run, minus a window that
   comfortably covers one run), so a bridge PC whose clock is off can never retire fresh rows. Idempotent. */
DROP FUNCTION IF EXISTS public.fb_finish_part_valuation(timestamptz);
CREATE OR REPLACE FUNCTION public.fb_finish_part_valuation(p_window interval DEFAULT interval '15 minutes')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
  v_cutoff timestamptz;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration', 'admin']);
  v_cutoff := (SELECT max(synced_at) FROM public.fb_part_valuation) - COALESCE(p_window, interval '15 minutes');
  IF v_cutoff IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE public.fb_part_valuation
     SET removed_at = now()
   WHERE removed_at IS NULL
     AND synced_at < v_cutoff;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;
REVOKE ALL ON FUNCTION public.fb_finish_part_valuation(interval) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fb_finish_part_valuation(interval) TO authenticated;


/* ---------- BLOCK 3 : fb_reorder_points - SkyNet-owned minimums (D-FBINV-02) ---------- */
/* Keyed by the Fishbowl part number as Fishbowl spells it; part_key matches fb_part_inventory the same
   way fb_upsert_inventory matches parts. min_qty NULL = rule parked ("No min set"), never alerts.
   RLS is FOR ALL TO authenticated like material_replenishment_rules (D-PURCH-02): write authority is
   enforced in the UI (admin + purchaser); alert columns are written only by fb_reorder_evaluate(). */
CREATE TABLE IF NOT EXISTS public.fb_reorder_points (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_num          text NOT NULL,
  part_key          text GENERATED ALWAYS AS (upper(btrim(part_num))) STORED,
  category          text NOT NULL DEFAULT 'Misc.',
  min_qty           numeric CHECK (min_qty IS NULL OR min_qty >= 0),
  vendor            text,
  notes             text,
  is_active         boolean NOT NULL DEFAULT true,
  alert_state       text NOT NULL DEFAULT 'ok' CHECK (alert_state IN ('ok', 'below', 'no_min', 'no_row')),
  alert_changed_at  timestamptz,
  last_notified_at  timestamptz,
  created_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fb_reorder_points_part_key_uniq UNIQUE (part_key)
);
ALTER TABLE public.fb_reorder_points ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fbreorder_authenticated_all ON public.fb_reorder_points;
CREATE POLICY fbreorder_authenticated_all ON public.fb_reorder_points FOR ALL TO authenticated USING (true) WITH CHECK (true);
REVOKE ALL ON public.fb_reorder_points FROM anon, public;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fb_reorder_points TO authenticated;


/* ---------- BLOCK 4 : _notify_roles + fb_reorder_evaluate ---------- */
/* _notify_compliance is untouched; this is the same insert for any role list. */
CREATE OR REPLACE FUNCTION public._notify_roles(p_roles text[], p_type text, p_title text, p_body text, p_payload jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO public.user_notifications (recipient_id, type, title, body, payload, created_by)
  SELECT p.id, p_type, p_title, p_body, p_payload, auth.uid()
    FROM public.profiles p
   WHERE COALESCE(p.is_active, true)
     AND public.user_has_role(p.id, VARIADIC p_roles);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;
REVOKE ALL ON FUNCTION public._notify_roles(text[], text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

/* Re-evaluates every active rule against the 5-minute mirror (basis: qty_on_hand, all location groups -
   D-FBINV-01). State changes are written only on change; the ok/no_min/no_row -> below crossing notifies
   every active purchaser + admin once (D-FBINV-02). Returns counts. Called by fb_upsert_inventory after
   each batch and by the Reorder Points tab (Re-evaluate). NULL uid (SQL Editor) passes the gate. */
CREATE OR REPLACE FUNCTION public.fb_reorder_evaluate()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_evaluated integer := 0;
  v_below     integer := 0;
  v_newly     integer := 0;
  v_notified  integer := 0;
  v_state     text;
  v_sent      integer;
  r           record;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration', 'admin', 'purchaser']);
  FOR r IN
    SELECT rp.id, rp.part_num, rp.min_qty, rp.alert_state,
           i.qty_on_hand, i.qty_on_order, i.qty_available,
           (i.part_num IS NOT NULL) AS has_row
      FROM public.fb_reorder_points rp
      LEFT JOIN public.fb_part_inventory i ON upper(btrim(i.part_num)) = rp.part_key
     WHERE rp.is_active
     ORDER BY rp.part_key
  LOOP
    v_evaluated := v_evaluated + 1;
    v_state := CASE WHEN r.min_qty IS NULL THEN 'no_min'
                    WHEN NOT r.has_row THEN 'no_row'
                    WHEN COALESCE(r.qty_on_hand, 0) < r.min_qty THEN 'below'
                    ELSE 'ok' END;
    IF v_state = 'below' THEN
      v_below := v_below + 1;
    END IF;
    IF v_state IS DISTINCT FROM r.alert_state THEN
      UPDATE public.fb_reorder_points
         SET alert_state = v_state, alert_changed_at = now()
       WHERE id = r.id;
      IF v_state = 'below' THEN
        v_newly := v_newly + 1;
        v_sent := public._notify_roles(
          ARRAY['purchaser', 'admin'],
          'reorder_below_min',
          r.part_num || ' below minimum',
          to_char(round(COALESCE(r.qty_on_hand, 0)), 'FM999,999,999,990') || ' on hand'
            || ' - min ' || to_char(round(r.min_qty), 'FM999,999,999,990')
            || CASE WHEN COALESCE(r.qty_on_order, 0) > 0
                    THEN ' - ' || to_char(round(r.qty_on_order), 'FM999,999,999,990') || ' on order'
                    ELSE '' END,
          jsonb_build_object('part_num', r.part_num, 'on_hand', r.qty_on_hand, 'min_qty', r.min_qty,
                             'on_order', r.qty_on_order, 'available', r.qty_available, 'armory_tab', 'fb_reorder'));
        v_notified := v_notified + COALESCE(v_sent, 0);
        UPDATE public.fb_reorder_points SET last_notified_at = now() WHERE id = r.id;
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('evaluated', v_evaluated, 'below', v_below, 'newly_below', v_newly, 'notified', v_notified);
END;
$function$;
REVOKE ALL ON FUNCTION public.fb_reorder_evaluate() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fb_reorder_evaluate() TO authenticated;

/* fb_upsert_inventory (D-FB-33/40) unchanged except the final PERFORM: every batch re-evaluates the rules.
   The evaluation is fenced so a notification problem can never fail the mirror write. */
CREATE OR REPLACE FUNCTION public.fb_upsert_inventory(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration', 'admin']);
  INSERT INTO public.fb_part_inventory
    (part_num, fb_part_id, qty_on_hand, qty_allocated, qty_not_available, qty_available, qty_on_order, by_location, part_id, snapshot_at)
  SELECT r->>'partNum',
         NULLIF(r->>'partId', '')::integer,
         NULLIF(r->>'onHand', '')::numeric,
         NULLIF(r->>'allocated', '')::numeric,
         NULLIF(r->>'notAvailable', '')::numeric,
         NULLIF(r->>'available', '')::numeric,
         NULLIF(r->>'onOrder', '')::numeric,
         r->'byLocation',
         (SELECT p.id FROM public.parts p WHERE upper(btrim(p.part_number)) = upper(btrim(r->>'partNum')) LIMIT 1),
         now()
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) r
   WHERE COALESCE(r->>'partNum', '') <> ''
  ON CONFLICT (part_num) DO UPDATE
     SET fb_part_id = EXCLUDED.fb_part_id, qty_on_hand = EXCLUDED.qty_on_hand, qty_allocated = EXCLUDED.qty_allocated,
         qty_not_available = EXCLUDED.qty_not_available, qty_available = EXCLUDED.qty_available,
         qty_on_order = EXCLUDED.qty_on_order, by_location = EXCLUDED.by_location,
         part_id = COALESCE(EXCLUDED.part_id, public.fb_part_inventory.part_id), snapshot_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.fb_sync_state SET last_inventory_at = now(), updated_at = now() WHERE id = 1;
  /* S13 D-FBINV-02: reorder evaluation rides every inventory write. Fenced: never fails the mirror. */
  BEGIN
    PERFORM public.fb_reorder_evaluate();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fb_reorder_evaluate skipped: %', SQLERRM;
  END;
  RETURN v_n;
END;
$function$;


/* ---------- BLOCK 5 : SEED PREVIEW (read-only) - the 55 rules against the mirror as it stands ---------- */
/* Expect on PROD before bridge 1.8.0: most rows found, SK4FW2SE / SK241-16 / SK242-16 / SK40R17-244
   possibly "no row yet" (they enter the scope with 1.8.0); exactly one BELOW: SK2600CGP174. */
WITH seed(category, part_num, min_qty, vendor) AS (VALUES
  ('Cups','SK26C',15000,'LEELYND MFG. CO'),('Cups','SK26C1',20000,'LEELYND MFG. CO'),
  ('Cups','SK27C',20000,'LEELYND MFG. CO'),('Cups','SK27C1',10000,'LEELYND MFG. CO'),
  ('Cups','SK4C2',7500,'LEELYND MFG. CO'),('Cups','SK4C2C',10000,'LEELYND MFG. CO'),
  ('Cups','SK4C4',5000,'LEELYND MFG. CO'),('Cups','SK4C4C',20000,'LEELYND MFG. CO'),
  ('Pins','SK2600CGP174',150000,'GROOV-PIN'),('Pins','SK4000CGP81',200000,'LA GOUPILLE / GROOV-PIN'),
  ('Pins','SK99836S',5000,'GROOV-PIN'),
  ('Springs','SK4000-3S',200000,'TOLLMAN SPRING COMPANY, INC.'),('Springs','SK4000-3',15000,'TOLLMAN SPRING COMPANY, INC.'),
  ('Springs','SK4000-3IN',5000,'TOLLMAN SPRING COMPANY, INC.'),('Springs','SK4000-2S',25000,'TOLLMAN SPRING COMPANY, INC.'),
  ('Springs','SK4000-2',10000,NULL),('Springs','SK35-SPRING',25000,NULL),
  ('Springs','SK2600-1C',25000,'MURPHY & READ SPRING MFG'),('Springs','SK2600-1S1',15000,'MURPHY & READ SPRING MFG'),
  ('Springs','SK2600-2C',25000,'MURPHY & READ SPRING MFG'),('Springs','SK2600-2S1',25000,'TOLLMAN / MURPHY AND READ'),
  ('Rings','SK-R4G',50000,'AMERICAN RING'),('Rings','SK-R4GS',75000,'AMERICAN RING'),
  ('Rings','SK-R4T',5000,'AMERICAN RING'),('Rings','SK-R4TS',7500,'AMERICAN RING'),
  ('Rings','SK2600-LW',40000,'AMERICAN RING'),('Rings','SK2600-LWS',75000,'AMERICAN RING'),
  ('Rings','SK26R',10000,'AMERICAN RING'),
  ('Clips','SK213-CLIP',10000,'CENTURY SPRING MFG CO'),('Clips','SK245-CLIP',15000,'CENTURY SPRING MFG CO'),
  ('Clips','SK244-161-CLIP',15000,'XIAMEN / RPM ENGINEERING CORP'),('Clips','SK201/203 Clip',10000,'XIAMEN'),
  ('Wings','SK4CWING3',5000,'Maxtrust Industries'),('Wings','SK4-WING3',5000,'Maxtrust Industries'),
  ('Wings','SK26CWING3',5000,'Maxtrust Industries'),('Wings','SK26-WING3',5000,'Maxtrust Industries'),
  ('Wings','SK26AWING3',2500,'Maxtrust Industries'),('Wings','SK2FW2SE',NULL,'Maxtrust Industries'),
  ('Wings','SK4FW2SE',NULL,NULL),
  ('Sandwich','SK241C16',7500,'Maxtrust Industries'),('Sandwich','SK242C16',7500,'Maxtrust Industries'),
  ('Sandwich','SK40R17C244',7500,'Maxtrust Industries'),('Sandwich','SK241-16',7500,'Maxtrust Industries'),
  ('Sandwich','SK242-16',7500,'Maxtrust Industries'),('Sandwich','SK40R17-244',7500,'Maxtrust Industries'),
  ('Cages','SK244-461',15000,'Maxtrust Industries'),('Cages','SK245C161 CAGE',15000,'Maxtrust Industries'),
  ('Cages','SK245A161 CAGE',15000,'WRICO'),('Cages','SK245B161 CAGE',7500,'Maxtrust Industries'),
  ('Cages','SK203C-CAGE',15000,'Maxtrust Industries'),
  ('Misc.','SK40R17-2',20000,'Maxtrust Industries'),('Misc.','SK40R17-1',12000,'Maxtrust Industries'),
  ('Misc.','SK21R17-1',5000,'Maxtrust Industries'),('Misc.','SK21R17-2',5000,'Maxtrust Industries'),
  ('Misc.','SK-T26P',250,'ALLGLIDES')
)
SELECT s.category, s.part_num, s.min_qty, s.vendor,
       i.qty_on_hand, i.qty_on_order,
       CASE WHEN s.min_qty IS NULL THEN 'no min'
            WHEN i.part_num IS NULL THEN 'no row yet'
            WHEN i.qty_on_hand < s.min_qty THEN 'BELOW'
            ELSE 'ok' END AS status,
       (SELECT count(*) FROM seed) AS seed_rows,
       (SELECT count(DISTINCT upper(btrim(part_num))) FROM seed) AS distinct_keys
  FROM seed s
  LEFT JOIN public.fb_part_inventory i ON upper(btrim(i.part_num)) = upper(btrim(s.part_num))
 ORDER BY s.category, s.part_num;


/* ---------- BLOCK 6 : SEED (idempotent - an existing key is left alone) ---------- */
INSERT INTO public.fb_reorder_points (part_num, category, min_qty, vendor, notes, is_active, alert_state)
SELECT part_num, category, min_qty, vendor,
       'Seeded 2026-10-07 from Purchasing critical inventory sheet (Critical_Parts_Reorder_Seed_v0_1)',
       true,
       CASE WHEN min_qty IS NULL THEN 'no_min' ELSE 'ok' END
  FROM (VALUES
  ('Cups','SK26C',15000,'LEELYND MFG. CO'),('Cups','SK26C1',20000,'LEELYND MFG. CO'),
  ('Cups','SK27C',20000,'LEELYND MFG. CO'),('Cups','SK27C1',10000,'LEELYND MFG. CO'),
  ('Cups','SK4C2',7500,'LEELYND MFG. CO'),('Cups','SK4C2C',10000,'LEELYND MFG. CO'),
  ('Cups','SK4C4',5000,'LEELYND MFG. CO'),('Cups','SK4C4C',20000,'LEELYND MFG. CO'),
  ('Pins','SK2600CGP174',150000,'GROOV-PIN'),('Pins','SK4000CGP81',200000,'LA GOUPILLE / GROOV-PIN'),
  ('Pins','SK99836S',5000,'GROOV-PIN'),
  ('Springs','SK4000-3S',200000,'TOLLMAN SPRING COMPANY, INC.'),('Springs','SK4000-3',15000,'TOLLMAN SPRING COMPANY, INC.'),
  ('Springs','SK4000-3IN',5000,'TOLLMAN SPRING COMPANY, INC.'),('Springs','SK4000-2S',25000,'TOLLMAN SPRING COMPANY, INC.'),
  ('Springs','SK4000-2',10000,NULL),('Springs','SK35-SPRING',25000,NULL),
  ('Springs','SK2600-1C',25000,'MURPHY & READ SPRING MFG'),('Springs','SK2600-1S1',15000,'MURPHY & READ SPRING MFG'),
  ('Springs','SK2600-2C',25000,'MURPHY & READ SPRING MFG'),('Springs','SK2600-2S1',25000,'TOLLMAN / MURPHY AND READ'),
  ('Rings','SK-R4G',50000,'AMERICAN RING'),('Rings','SK-R4GS',75000,'AMERICAN RING'),
  ('Rings','SK-R4T',5000,'AMERICAN RING'),('Rings','SK-R4TS',7500,'AMERICAN RING'),
  ('Rings','SK2600-LW',40000,'AMERICAN RING'),('Rings','SK2600-LWS',75000,'AMERICAN RING'),
  ('Rings','SK26R',10000,'AMERICAN RING'),
  ('Clips','SK213-CLIP',10000,'CENTURY SPRING MFG CO'),('Clips','SK245-CLIP',15000,'CENTURY SPRING MFG CO'),
  ('Clips','SK244-161-CLIP',15000,'XIAMEN / RPM ENGINEERING CORP'),('Clips','SK201/203 Clip',10000,'XIAMEN'),
  ('Wings','SK4CWING3',5000,'Maxtrust Industries'),('Wings','SK4-WING3',5000,'Maxtrust Industries'),
  ('Wings','SK26CWING3',5000,'Maxtrust Industries'),('Wings','SK26-WING3',5000,'Maxtrust Industries'),
  ('Wings','SK26AWING3',2500,'Maxtrust Industries'),('Wings','SK2FW2SE',NULL,'Maxtrust Industries'),
  ('Wings','SK4FW2SE',NULL,NULL),
  ('Sandwich','SK241C16',7500,'Maxtrust Industries'),('Sandwich','SK242C16',7500,'Maxtrust Industries'),
  ('Sandwich','SK40R17C244',7500,'Maxtrust Industries'),('Sandwich','SK241-16',7500,'Maxtrust Industries'),
  ('Sandwich','SK242-16',7500,'Maxtrust Industries'),('Sandwich','SK40R17-244',7500,'Maxtrust Industries'),
  ('Cages','SK244-461',15000,'Maxtrust Industries'),('Cages','SK245C161 CAGE',15000,'Maxtrust Industries'),
  ('Cages','SK245A161 CAGE',15000,'WRICO'),('Cages','SK245B161 CAGE',7500,'Maxtrust Industries'),
  ('Cages','SK203C-CAGE',15000,'Maxtrust Industries'),
  ('Misc.','SK40R17-2',20000,'Maxtrust Industries'),('Misc.','SK40R17-1',12000,'Maxtrust Industries'),
  ('Misc.','SK21R17-1',5000,'Maxtrust Industries'),('Misc.','SK21R17-2',5000,'Maxtrust Industries'),
  ('Misc.','SK-T26P',250,'ALLGLIDES')
  ) AS seed(category, part_num, min_qty, vendor)
ON CONFLICT (part_key) DO NOTHING;


/* ---------- BLOCK 7 : first evaluation (notifies purchaser + admin for anything already below) ---------- */
/* KNOCK-ON on PROD: this is the moment April, Sawyer and Matt get the SK2600CGP174 bell. Tell them first. */
SELECT public.fb_reorder_evaluate() AS first_evaluation;


/* ---------- BLOCK 8 : registry views (D-RPT-16) ---------- */
/* Views run as owner: revoke first, then grant SELECT to authenticated only (cheatsheet section 6). */
CREATE OR REPLACE VIEW public.v_report_fb_stock_on_hand AS
SELECT v.part_num                                   AS part_number,
       v.description,
       rp.category,
       COALESCE(i.qty_on_hand, v.qty_on_hand)       AS on_hand,
       i.qty_allocated                              AS allocated,
       i.qty_available                              AS available,
       i.qty_on_order                               AS on_order,
       v.avg_cost,
       round(COALESCE(i.qty_on_hand, v.qty_on_hand) * COALESCE(v.avg_cost, 0), 2) AS est_value,
       rp.min_qty,
       CASE WHEN rp.id IS NULL THEN NULL
            WHEN NOT rp.is_active THEN 'inactive rule'
            ELSE rp.alert_state END                 AS reorder_status,
       array_to_string(ARRAY[
         CASE WHEN COALESCE(v.avg_cost, 0) = 0 AND COALESCE(i.qty_on_hand, v.qty_on_hand) <> 0 THEN 'zero_cost' END,
         CASE WHEN NOT v.is_active THEN 'inactive' END,
         CASE WHEN COALESCE(i.qty_on_hand, v.qty_on_hand) >= 100000 THEN 'count_first' END,
         CASE WHEN i.part_num IS NULL THEN 'nightly_qty' END
       ]::text[], ' ')                              AS flags,
       i.snapshot_at                                AS inventory_as_of,
       v.synced_at                                  AS cost_as_of
  FROM public.fb_part_valuation v
  LEFT JOIN public.fb_part_inventory i ON upper(btrim(i.part_num)) = v.part_key
  LEFT JOIN public.fb_reorder_points rp ON rp.part_key = v.part_key
 WHERE v.removed_at IS NULL
   AND v.valuation_class = 'Product';
REVOKE ALL ON public.v_report_fb_stock_on_hand FROM authenticated, anon, public;
GRANT SELECT ON public.v_report_fb_stock_on_hand TO authenticated;

CREATE OR REPLACE VIEW public.v_report_fb_reorder_status AS
SELECT rp.category,
       rp.part_num                                  AS part_number,
       v.description,
       rp.min_qty,
       i.qty_on_hand                                AS on_hand,
       i.qty_available                              AS available,
       i.qty_on_order                               AS on_order,
       CASE WHEN NOT rp.is_active THEN 'inactive' ELSE rp.alert_state END AS status,
       CASE WHEN rp.min_qty IS NOT NULL AND i.qty_on_hand IS NOT NULL AND i.qty_on_hand < rp.min_qty
            THEN rp.min_qty - i.qty_on_hand ELSE 0 END AS shortfall,
       CASE WHEN rp.min_qty IS NOT NULL AND i.qty_on_hand IS NOT NULL AND i.qty_on_hand < rp.min_qty
                 AND COALESCE(i.qty_on_order, 0) >= rp.min_qty - i.qty_on_hand
            THEN 'yes' ELSE 'no' END                AS on_order_covers,
       rp.vendor,
       rp.notes,
       rp.alert_changed_at,
       i.snapshot_at                                AS inventory_as_of
  FROM public.fb_reorder_points rp
  LEFT JOIN public.fb_part_inventory i ON upper(btrim(i.part_num)) = rp.part_key
  LEFT JOIN public.fb_part_valuation v ON v.part_key = rp.part_key AND v.removed_at IS NULL;
REVOKE ALL ON public.v_report_fb_reorder_status FROM authenticated, anon, public;
GRANT SELECT ON public.v_report_fb_reorder_status TO authenticated;

INSERT INTO public.reports (slug, name, description, explainer, source_object, columns, order_by, view_roles, export_roles, sort_order, is_active, report_kind)
SELECT 'fb-stock-on-hand',
       'Fishbowl Stock on Hand (Product parts)',
       'Every Fishbowl part classed Product with on hand, allocated, available, on order, the nightly average cost and the estimated value, plus its reorder minimum where one exists.',
       'On hand / allocated / available / on order come from the bridge''s 5-minute mirror of Fishbowl (available = Main + Warehouse, D-FB-33). avg_cost is Fishbowl''s partcost.avgCost read nightly at 02:10; est_value = on hand x avg_cost and is an estimate, not the month-end valuation. flags: zero_cost (quantity at $0 cost - understated), inactive, count_first (100,000+ pieces), nightly_qty (no 5-minute row yet; on_hand is last night''s tag quantity). reorder_status is the rule state: ok, below, no_min, no_row.',
       'v_report_fb_stock_on_hand',
       ARRAY['part_number','description','category','on_hand','allocated','available','on_order','avg_cost','est_value','min_qty','reorder_status','flags','inventory_as_of','cost_as_of'],
       '[{"column":"est_value","ascending":false},{"column":"part_number","ascending":true}]'::jsonb,
       ARRAY['admin','compliance','purchaser','president','viewer','customer_service','scheduler'],
       ARRAY['admin','president','scheduler','compliance','purchaser'],
       130, true, NULL
 WHERE NOT EXISTS (SELECT 1 FROM public.reports WHERE slug = 'fb-stock-on-hand');

INSERT INTO public.reports (slug, name, description, explainer, source_object, columns, order_by, view_roles, export_roles, sort_order, is_active, report_kind)
SELECT 'fb-reorder-status',
       'Fishbowl Reorder Status',
       'Every reorder rule with its minimum, current on hand / available / on order, status and shortfall - the critical-parts sheet, live.',
       'Rules live in SkyNet (Armory > Fishbowl Inventory > Reorder Points), seeded from Purchasing''s critical inventory sheet. status: ok, below (on hand < min), no_min (rule parked until a minimum is entered), no_row (Fishbowl has no part with this number), inactive. shortfall = min - on hand when below. on_order_covers = yes when the open purchase quantity is at least the shortfall. Evaluated after every 5-minute inventory refresh; a bell goes to purchasers and admins when a part first drops below its minimum.',
       'v_report_fb_reorder_status',
       ARRAY['category','part_number','description','min_qty','on_hand','available','on_order','status','shortfall','on_order_covers','vendor','notes','alert_changed_at','inventory_as_of'],
       '[{"column":"status","ascending":true},{"column":"category","ascending":true},{"column":"part_number","ascending":true}]'::jsonb,
       ARRAY['admin','compliance','purchaser','president','viewer','customer_service','scheduler'],
       ARRAY['admin','president','scheduler','compliance','purchaser'],
       131, true, NULL
 WHERE NOT EXISTS (SELECT 1 FROM public.reports WHERE slug = 'fb-reorder-status');


/* ---------- BLOCK 9 : VERIFY (its own statement) ---------- */
SELECT jsonb_build_object(
  'valuation_rows',        (SELECT count(*) FROM public.fb_part_valuation),
  'reorder_rules',         (SELECT count(*) FROM public.fb_reorder_points),
  'reorder_states',        (SELECT jsonb_object_agg(alert_state, n) FROM (SELECT alert_state, count(*) n FROM public.fb_reorder_points GROUP BY 1) s),
  'below_parts',           (SELECT jsonb_agg(part_num ORDER BY part_num) FROM public.fb_reorder_points WHERE alert_state = 'below'),
  'reorder_notifications', (SELECT count(*) FROM public.user_notifications WHERE type = 'reorder_below_min'),
  'registry_rows',         (SELECT jsonb_agg(slug ORDER BY sort_order) FROM public.reports WHERE slug IN ('fb-stock-on-hand','fb-reorder-status')),
  'view_grants',           (SELECT jsonb_object_agg(table_name, grantees) FROM (
                              SELECT table_name, string_agg(grantee || ':' || privilege_type, ',' ORDER BY grantee) grantees
                                FROM information_schema.role_table_grants
                               WHERE table_schema = 'public' AND table_name IN ('v_report_fb_stock_on_hand','v_report_fb_reorder_status','fb_part_valuation','fb_reorder_points')
                               GROUP BY table_name) g),
  'sync_state_col',        (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fb_sync_state' AND column_name = 'last_valuation_at')
) AS verify;
