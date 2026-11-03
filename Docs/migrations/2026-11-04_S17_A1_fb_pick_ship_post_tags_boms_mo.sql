-- ============================================================================
-- S17 Batch A1 — Fishbowl mirrors for picks, shipments, postings, tags, BOMs
--                 and manufacture orders; per-family cursors; line-state views
-- 2026-11-04  ·  D-ASM-06, D-ASM-23, D-FB-57/58  ·  bridge 1.11
--
-- Run on TEST (ylzmyjjqibpbqbwjsnqj) first, PROD (luzungoqfuplspzbqctb) after
-- bridge 1.11 has passed its PC-against-TEST run. Idempotent: every statement
-- is IF NOT EXISTS / OR REPLACE / ADD COLUMN IF NOT EXISTS.
--
-- Conventions (bridge audit §5): RLS on, ONE SELECT policy for authenticated,
-- GRANT SELECT to authenticated, REVOKE ALL from anon, writes only through
-- SECURITY DEFINER fb_upsert_* gated by _fb_gate(ARRAY['integration','admin']).
-- Payload keys are camelCase and match the bridge mappers exactly.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. fb_sync_state: per-family cursors (D-ASM-23) and stamps
-- ---------------------------------------------------------------------------
ALTER TABLE public.fb_sync_state
  ADD COLUMN IF NOT EXISTS last_picks_rev     bigint,
  ADD COLUMN IF NOT EXISTS last_picks_at      timestamptz,
  ADD COLUMN IF NOT EXISTS last_ships_rev     bigint,
  ADD COLUMN IF NOT EXISTS last_mos_rev       bigint,
  ADD COLUMN IF NOT EXISTS last_mos_at        timestamptz,
  ADD COLUMN IF NOT EXISTS last_boms_rev      bigint,
  ADD COLUMN IF NOT EXISTS last_boms_at       timestamptz,
  ADD COLUMN IF NOT EXISTS last_boms_sweep_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_tags_at       timestamptz,
  ADD COLUMN IF NOT EXISTS last_tags_sweep_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_postings_at   timestamptz,
  ADD COLUMN IF NOT EXISTS family_errors      jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.fb_sync_state.family_errors IS
  'Bridge 1.11: {family: {at, message}} for the last failure of each guarded poller; cleared by that family''s next success.';

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fb_pick_items (
  fb_pickitem_id      bigint PRIMARY KEY,
  fb_pick_id          bigint NOT NULL,
  pick_num            text,
  pick_status_id      integer,
  fb_so_id            integer,
  fb_soitem_id        integer,
  fb_part_id          integer,
  part_num            text,
  qty                 numeric,
  slot_num            integer,
  status_id           integer NOT NULL,
  status              text,
  src_location_id     integer,
  src_location        text,
  src_tag_num         bigint,
  dest_location_id    integer,
  dest_location       text,
  dest_tag_num        bigint,
  pick_last_modified  timestamptz,
  removed_at          timestamptz,
  mirrored_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_pick_items_soitem_idx ON public.fb_pick_items (fb_soitem_id);
CREATE INDEX IF NOT EXISTS fb_pick_items_so_idx     ON public.fb_pick_items (fb_so_id);
CREATE INDEX IF NOT EXISTS fb_pick_items_pick_idx   ON public.fb_pick_items (fb_pick_id);
COMMENT ON TABLE public.fb_pick_items IS
  'Fishbowl pickitem mirror for SALES-ORDER picks only (orderTypeId 20). dest_location is the D-ASM-06 flag: Assembly / Production / Purchasing on a held line. Status ids: 5 Short, 6 Hold, 10 Entered, 11 Entered New, 20 Started, 30 Committed, 40 Finished.';

CREATE TABLE IF NOT EXISTS public.fb_shipments (
  fb_ship_id        integer PRIMARY KEY,
  ship_num          text,
  fb_so_id          integer,
  so_number         text,
  status_id         integer NOT NULL,
  status            text,
  date_created      timestamptz,
  date_shipped      timestamptz,
  carrier           text,
  carrier_service   text,
  carton_count      integer,
  removed_at        timestamptz,
  mirrored_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_shipments_so_idx ON public.fb_shipments (fb_so_id);
COMMENT ON TABLE public.fb_shipments IS 'Fishbowl ship header mirror. Status ids: 10 Entered, 20 Packed, 30 Shipped, 40 Cancelled.';

CREATE TABLE IF NOT EXISTS public.fb_ship_cartons (
  fb_carton_id     integer PRIMARY KEY,
  fb_ship_id       integer NOT NULL,
  carton_num       integer,
  tracking_num     text,
  freight_weight   numeric,
  freight_amount   numeric,
  mirrored_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_ship_cartons_ship_idx ON public.fb_ship_cartons (fb_ship_id);

CREATE TABLE IF NOT EXISTS public.fb_ship_items (
  fb_shipitem_id   integer PRIMARY KEY,
  fb_ship_id       integer NOT NULL,
  fb_carton_id     integer,
  fb_soitem_id     integer,
  product_num      text,
  qty_shipped      numeric,
  mirrored_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_ship_items_soitem_idx ON public.fb_ship_items (fb_soitem_id);
CREATE INDEX IF NOT EXISTS fb_ship_items_ship_idx   ON public.fb_ship_items (fb_ship_id);

CREATE TABLE IF NOT EXISTS public.fb_postings (
  fb_postso_id     integer PRIMARY KEY,
  fb_so_id         integer,
  so_number        text,
  post_date        timestamptz,
  date_posted      timestamptz,
  status_id        integer,
  ext_ref_number   text,
  ext_txn_id       text,
  journal_posted   boolean,
  total_tax        numeric,
  mirrored_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_postings_so_idx ON public.fb_postings (fb_so_id);
COMMENT ON TABLE public.fb_postings IS 'Fishbowl postso mirror: post_date is written at ship time and is the Order Queue''s Invoiced stamp (D-ASM-14). journal_posted / ext_txn_id are the later QuickBooks-posted phase.';

CREATE TABLE IF NOT EXISTS public.fb_posting_items (
  fb_postsoitem_id  integer PRIMARY KEY,
  fb_postso_id      integer NOT NULL,
  fb_soitem_id      integer,
  fb_shipitem_id    integer,
  qty               numeric,
  total_price       numeric,
  mirrored_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_posting_items_soitem_idx ON public.fb_posting_items (fb_soitem_id);

CREATE TABLE IF NOT EXISTS public.fb_tags (
  fb_tag_id          bigint PRIMARY KEY,
  tag_num            bigint,
  fb_part_id         integer NOT NULL,
  part_num           text,
  location_id        integer,
  location           text,
  location_group_id  integer,
  qty                numeric NOT NULL DEFAULT 0,
  qty_committed      numeric NOT NULL DEFAULT 0,
  lot_number         text,
  tracking_type      text,
  fb_woitem_id       integer,
  tag_created        timestamptz,
  tag_last_modified  timestamptz,
  removed_at         timestamptz,
  mirrored_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_tags_part_idx ON public.fb_tags (part_num) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS fb_tags_lot_idx  ON public.fb_tags (lot_number) WHERE removed_at IS NULL;
COMMENT ON TABLE public.fb_tags IS 'Fishbowl tag mirror (on-hand lots) for parts in the assembly scope. lot_number from trackingtext (partTrackingId 1). fb_woitem_id = tag.woItemId: the work-order item that produced this tag (finished-good lot of a posted MO).';

CREATE TABLE IF NOT EXISTS public.fb_boms (
  fb_bom_id            integer PRIMARY KEY,
  bom_num              text NOT NULL,
  description          text,
  active               boolean NOT NULL DEFAULT true,
  revision             text,
  auto_create_type_id  integer,
  date_last_modified   timestamptz,
  removed_at           timestamptz,
  mirrored_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_boms_num_idx ON public.fb_boms (bom_num);

CREATE TABLE IF NOT EXISTS public.fb_bom_items (
  fb_bomitem_id     integer PRIMARY KEY,
  fb_bom_id         integer NOT NULL,
  type_id           integer NOT NULL,        -- 10 finished good, 20 raw good
  fb_part_id        integer,
  part_num          text,
  part_description  text,
  quantity          numeric,
  uom_id            integer,
  uom               text,
  sort_id           integer,
  stage             boolean,
  stage_bom_id      integer,
  mirrored_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_bom_items_bom_idx  ON public.fb_bom_items (fb_bom_id);
CREATE INDEX IF NOT EXISTS fb_bom_items_part_idx ON public.fb_bom_items (part_num);

CREATE TABLE IF NOT EXISTS public.fb_bom_instructions (
  fb_bominstructionitem_id  bigint PRIMARY KEY,
  fb_bom_id                 integer NOT NULL,
  sort_order                integer,
  name                      text,
  description               text,
  details                   text,
  mirrored_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_bom_instructions_bom_idx ON public.fb_bom_instructions (fb_bom_id);
COMMENT ON TABLE public.fb_bom_instructions IS 'Fishbowl bominstructionitem mirror — the sign-off lines the traveler prints; the seed for SkyNet assembly checklists (D-ASM-07).';

CREATE TABLE IF NOT EXISTS public.fb_manufacture_orders (
  fb_mo_id           integer PRIMARY KEY,
  mo_num             text NOT NULL,
  status_id          integer NOT NULL,
  status             text,
  fb_so_id           integer,
  location_group_id  integer,
  date_created       timestamptz,
  date_issued        timestamptz,
  date_scheduled     timestamptz,
  date_completed     timestamptz,
  date_last_modified timestamptz,
  note               text,
  fb_user_id         integer,
  removed_at         timestamptz,
  mirrored_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_manufacture_orders_num_idx ON public.fb_manufacture_orders (mo_num);
COMMENT ON TABLE public.fb_manufacture_orders IS 'Fishbowl mo mirror. Status ids: 10 Entered, 20 Issued, 50 Partial, 60 Fulfilled, 70 Closed Short, 80 Void. Bridge-created MOs carry the SkyNet build number as mo_num (D-ASM-10).';

CREATE TABLE IF NOT EXISTS public.fb_mo_items (
  fb_moitem_id        integer PRIMARY KEY,
  fb_mo_id            integer NOT NULL,
  type_id             integer NOT NULL,        -- 50 configuration, 10 finished good, 20 raw good
  parent_fb_moitem_id integer,
  fb_bom_id           integer,
  bom_num             text,
  fb_part_id          integer,
  part_num            text,
  description         text,
  qty_to_fulfill      numeric,
  qty_fulfilled       numeric,
  status_id           integer,
  stage_level         integer,
  sort_id             integer,
  mirrored_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_mo_items_mo_idx ON public.fb_mo_items (fb_mo_id);

CREATE TABLE IF NOT EXISTS public.fb_work_orders (
  fb_wo_id        integer PRIMARY KEY,
  wo_num          text NOT NULL,
  fb_mo_id        integer,
  fb_moitem_id    integer,
  status_id       integer NOT NULL,
  status          text,
  qty_ordered     integer,
  qty_target      integer,
  qty_scrapped    integer,
  location_id     integer,
  date_created    timestamptz,
  date_started    timestamptz,
  date_finished   timestamptz,
  note            text,
  cost            numeric,
  mirrored_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_work_orders_mo_idx ON public.fb_work_orders (fb_mo_id);
COMMENT ON TABLE public.fb_work_orders IS 'Fishbowl wo mirror. Status ids: 10 Entered, 30 Started, 40 Fulfilled. wo_num is "5853:001".';

CREATE TABLE IF NOT EXISTS public.fb_wo_items (
  fb_woitem_id    integer PRIMARY KEY,
  fb_wo_id        integer NOT NULL,
  fb_moitem_id    integer,
  type_id         integer NOT NULL,        -- 10 finished good, 20 raw good
  fb_part_id      integer,
  part_num        text,
  description     text,
  qty_target      numeric,
  qty_used        numeric,
  qty_scrapped    numeric,
  cost            numeric,
  standard_cost   numeric,
  sort_id         integer,
  mirrored_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_wo_items_wo_idx ON public.fb_wo_items (fb_wo_id);

CREATE TABLE IF NOT EXISTS public.fb_wo_consumed_lots (
  fb_pickitem_id  bigint PRIMARY KEY,
  fb_wo_id        integer NOT NULL,
  fb_woitem_id    integer,
  fb_part_id      integer,
  part_num        text,
  qty             numeric,
  status_id       integer,
  src_location    text,
  src_tag_num     bigint,
  lot_number      text,
  mirrored_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fb_wo_consumed_lots_wo_idx ON public.fb_wo_consumed_lots (fb_wo_id);
COMMENT ON TABLE public.fb_wo_consumed_lots IS 'Lots a Fishbowl work order consumed: the WO''s pick items (orderTypeId 30) with the lot from trackinginfo tableId -1515431424. The read-back source for D-ASM-01 verification.';

-- RLS: the existing convention, one SELECT policy for authenticated.
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fb_pick_items','fb_shipments','fb_ship_cartons','fb_ship_items',
                           'fb_postings','fb_posting_items','fb_tags','fb_boms','fb_bom_items',
                           'fb_bom_instructions','fb_manufacture_orders','fb_mo_items',
                           'fb_work_orders','fb_wo_items','fb_wo_consumed_lots'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', t || '_read', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
  END LOOP;
END
$rls$;

-- ---------------------------------------------------------------------------
-- 2. Upsert RPCs — one per family; p_rev_to advances that family's cursor
-- ---------------------------------------------------------------------------

-- 2.1 Picks ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_upsert_pick_items(
  p_rows jsonb, p_removed_ids jsonb DEFAULT NULL, p_rev_to bigint DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration','admin']);
  IF jsonb_typeof(p_rows) <> 'array' THEN RAISE EXCEPTION 'p_rows must be a jsonb array'; END IF;

  INSERT INTO public.fb_pick_items AS t (
    fb_pickitem_id, fb_pick_id, pick_num, pick_status_id, fb_so_id, fb_soitem_id, fb_part_id, part_num,
    qty, slot_num, status_id, status, src_location_id, src_location, src_tag_num,
    dest_location_id, dest_location, dest_tag_num, pick_last_modified, removed_at, mirrored_at)
  SELECT DISTINCT ON ((r->>'pickItemId')::bigint)
    (r->>'pickItemId')::bigint, (r->>'pickId')::bigint, r->>'pickNum', (r->>'pickStatusId')::integer,
    (r->>'soId')::integer, (r->>'soItemId')::integer, (r->>'partId')::integer, r->>'partNum',
    (r->>'qty')::numeric, (r->>'slotNum')::integer, (r->>'statusId')::integer, r->>'status',
    (r->>'srcLocationId')::integer, r->>'srcLocation', (r->>'srcTagNum')::bigint,
    (r->>'destLocationId')::integer, r->>'destLocation', (r->>'destTagNum')::bigint,
    (r->>'pickLastModified')::timestamptz, NULL, now()
  FROM jsonb_array_elements(p_rows) r
  ON CONFLICT (fb_pickitem_id) DO UPDATE SET
    fb_pick_id = EXCLUDED.fb_pick_id, pick_num = EXCLUDED.pick_num, pick_status_id = EXCLUDED.pick_status_id,
    fb_so_id = EXCLUDED.fb_so_id, fb_soitem_id = EXCLUDED.fb_soitem_id, fb_part_id = EXCLUDED.fb_part_id,
    part_num = EXCLUDED.part_num, qty = EXCLUDED.qty, slot_num = EXCLUDED.slot_num,
    status_id = EXCLUDED.status_id, status = EXCLUDED.status,
    src_location_id = EXCLUDED.src_location_id, src_location = EXCLUDED.src_location, src_tag_num = EXCLUDED.src_tag_num,
    dest_location_id = EXCLUDED.dest_location_id, dest_location = EXCLUDED.dest_location, dest_tag_num = EXCLUDED.dest_tag_num,
    pick_last_modified = EXCLUDED.pick_last_modified, removed_at = NULL, mirrored_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;

  IF p_removed_ids IS NOT NULL AND jsonb_typeof(p_removed_ids) = 'array' THEN
    UPDATE public.fb_pick_items SET removed_at = COALESCE(removed_at, now()), mirrored_at = now()
    WHERE fb_pickitem_id IN (SELECT x.v::bigint FROM jsonb_array_elements_text(p_removed_ids) AS x(v));
  END IF;

  UPDATE public.fb_sync_state
     SET last_picks_at = now(),
         last_picks_rev = CASE WHEN p_rev_to IS NULL THEN last_picks_rev ELSE GREATEST(COALESCE(last_picks_rev, 0), p_rev_to) END,
         family_errors = family_errors - 'picks'
   WHERE id = 1;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.fb_upsert_pick_items(jsonb, jsonb, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fb_upsert_pick_items(jsonb, jsonb, bigint) FROM anon;
GRANT EXECUTE ON FUNCTION public.fb_upsert_pick_items(jsonb, jsonb, bigint) TO authenticated, service_role;

-- 2.2 Shipments (headers, cartons, items; lots keep fb_upsert_shipment_lots) --
CREATE OR REPLACE FUNCTION public.fb_upsert_shipments(
  p_ships jsonb, p_cartons jsonb, p_items jsonb, p_rev_to bigint DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0; m integer := 0;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration','admin']);
  IF jsonb_typeof(p_ships) <> 'array' THEN RAISE EXCEPTION 'p_ships must be a jsonb array'; END IF;

  INSERT INTO public.fb_shipments AS t (
    fb_ship_id, ship_num, fb_so_id, so_number, status_id, status, date_created, date_shipped,
    carrier, carrier_service, carton_count, removed_at, mirrored_at)
  SELECT DISTINCT ON ((r->>'shipId')::integer)
    (r->>'shipId')::integer, r->>'shipNum', (r->>'soId')::integer, r->>'soNumber',
    (r->>'statusId')::integer, r->>'status', (r->>'dateCreated')::timestamptz, (r->>'dateShipped')::timestamptz,
    r->>'carrier', r->>'carrierService', (r->>'cartonCount')::integer, NULL, now()
  FROM jsonb_array_elements(p_ships) r
  ON CONFLICT (fb_ship_id) DO UPDATE SET
    ship_num = EXCLUDED.ship_num, fb_so_id = EXCLUDED.fb_so_id, so_number = EXCLUDED.so_number,
    status_id = EXCLUDED.status_id, status = EXCLUDED.status, date_created = EXCLUDED.date_created,
    date_shipped = EXCLUDED.date_shipped, carrier = EXCLUDED.carrier, carrier_service = EXCLUDED.carrier_service,
    carton_count = EXCLUDED.carton_count, removed_at = NULL, mirrored_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;

  IF p_cartons IS NOT NULL AND jsonb_typeof(p_cartons) = 'array' THEN
    INSERT INTO public.fb_ship_cartons AS t (fb_carton_id, fb_ship_id, carton_num, tracking_num, freight_weight, freight_amount, mirrored_at)
    SELECT DISTINCT ON ((r->>'cartonId')::integer)
      (r->>'cartonId')::integer, (r->>'shipId')::integer, (r->>'cartonNum')::integer, r->>'trackingNum',
      (r->>'freightWeight')::numeric, (r->>'freightAmount')::numeric, now()
    FROM jsonb_array_elements(p_cartons) r
    ON CONFLICT (fb_carton_id) DO UPDATE SET
      fb_ship_id = EXCLUDED.fb_ship_id, carton_num = EXCLUDED.carton_num, tracking_num = EXCLUDED.tracking_num,
      freight_weight = EXCLUDED.freight_weight, freight_amount = EXCLUDED.freight_amount, mirrored_at = now();
  END IF;

  IF p_items IS NOT NULL AND jsonb_typeof(p_items) = 'array' THEN
    INSERT INTO public.fb_ship_items AS t (fb_shipitem_id, fb_ship_id, fb_carton_id, fb_soitem_id, product_num, qty_shipped, mirrored_at)
    SELECT DISTINCT ON ((r->>'shipItemId')::integer)
      (r->>'shipItemId')::integer, (r->>'shipId')::integer, (r->>'cartonId')::integer, (r->>'soItemId')::integer,
      r->>'productNum', (r->>'qtyShipped')::numeric, now()
    FROM jsonb_array_elements(p_items) r
    ON CONFLICT (fb_shipitem_id) DO UPDATE SET
      fb_ship_id = EXCLUDED.fb_ship_id, fb_carton_id = EXCLUDED.fb_carton_id, fb_soitem_id = EXCLUDED.fb_soitem_id,
      product_num = EXCLUDED.product_num, qty_shipped = EXCLUDED.qty_shipped, mirrored_at = now();
    GET DIAGNOSTICS m = ROW_COUNT;
  END IF;

  UPDATE public.fb_sync_state
     SET last_shipments_at = now(),
         last_ships_rev = CASE WHEN p_rev_to IS NULL THEN last_ships_rev ELSE GREATEST(COALESCE(last_ships_rev, 0), p_rev_to) END,
         family_errors = family_errors - 'ships'
   WHERE id = 1;
  RETURN n + m;
END $$;
REVOKE ALL ON FUNCTION public.fb_upsert_shipments(jsonb, jsonb, jsonb, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fb_upsert_shipments(jsonb, jsonb, jsonb, bigint) FROM anon;
GRANT EXECUTE ON FUNCTION public.fb_upsert_shipments(jsonb, jsonb, jsonb, bigint) TO authenticated, service_role;

-- 2.3 Postings (polled, no cursor) -------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_upsert_postings(p_postings jsonb, p_items jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration','admin']);
  IF jsonb_typeof(p_postings) <> 'array' THEN RAISE EXCEPTION 'p_postings must be a jsonb array'; END IF;

  INSERT INTO public.fb_postings AS t (
    fb_postso_id, fb_so_id, so_number, post_date, date_posted, status_id, ext_ref_number, ext_txn_id,
    journal_posted, total_tax, mirrored_at)
  SELECT DISTINCT ON ((r->>'postSoId')::integer)
    (r->>'postSoId')::integer, (r->>'soId')::integer, r->>'soNumber', (r->>'postDate')::timestamptz,
    (r->>'datePosted')::timestamptz, (r->>'statusId')::integer, r->>'extRefNumber', r->>'extTxnId',
    (r->>'journalPosted')::boolean, (r->>'totalTax')::numeric, now()
  FROM jsonb_array_elements(p_postings) r
  ON CONFLICT (fb_postso_id) DO UPDATE SET
    fb_so_id = EXCLUDED.fb_so_id, so_number = EXCLUDED.so_number, post_date = EXCLUDED.post_date,
    date_posted = EXCLUDED.date_posted, status_id = EXCLUDED.status_id, ext_ref_number = EXCLUDED.ext_ref_number,
    ext_txn_id = EXCLUDED.ext_txn_id, journal_posted = EXCLUDED.journal_posted, total_tax = EXCLUDED.total_tax,
    mirrored_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;

  IF p_items IS NOT NULL AND jsonb_typeof(p_items) = 'array' THEN
    INSERT INTO public.fb_posting_items AS t (fb_postsoitem_id, fb_postso_id, fb_soitem_id, fb_shipitem_id, qty, total_price, mirrored_at)
    SELECT DISTINCT ON ((r->>'postSoItemId')::integer)
      (r->>'postSoItemId')::integer, (r->>'postSoId')::integer, (r->>'soItemId')::integer, (r->>'shipItemId')::integer,
      (r->>'qty')::numeric, (r->>'totalPrice')::numeric, now()
    FROM jsonb_array_elements(p_items) r
    ON CONFLICT (fb_postsoitem_id) DO UPDATE SET
      fb_postso_id = EXCLUDED.fb_postso_id, fb_soitem_id = EXCLUDED.fb_soitem_id, fb_shipitem_id = EXCLUDED.fb_shipitem_id,
      qty = EXCLUDED.qty, total_price = EXCLUDED.total_price, mirrored_at = now();
  END IF;

  UPDATE public.fb_sync_state SET last_postings_at = now(), family_errors = family_errors - 'postings' WHERE id = 1;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.fb_upsert_postings(jsonb, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fb_upsert_postings(jsonb, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.fb_upsert_postings(jsonb, jsonb) TO authenticated, service_role;

-- 2.4 Tags (polled; p_sweep marks tags absent from a full in-scope sweep) ----
CREATE OR REPLACE FUNCTION public.fb_upsert_tags(p_rows jsonb, p_removed_ids jsonb DEFAULT NULL, p_sweep boolean DEFAULT false)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration','admin']);
  IF jsonb_typeof(p_rows) <> 'array' THEN RAISE EXCEPTION 'p_rows must be a jsonb array'; END IF;

  INSERT INTO public.fb_tags AS t (
    fb_tag_id, tag_num, fb_part_id, part_num, location_id, location, location_group_id, qty, qty_committed,
    lot_number, tracking_type, fb_woitem_id, tag_created, tag_last_modified, removed_at, mirrored_at)
  SELECT DISTINCT ON ((r->>'tagId')::bigint)
    (r->>'tagId')::bigint, (r->>'tagNum')::bigint, (r->>'partId')::integer, r->>'partNum',
    (r->>'locationId')::integer, r->>'location', (r->>'locationGroupId')::integer,
    COALESCE((r->>'qty')::numeric, 0), COALESCE((r->>'qtyCommitted')::numeric, 0),
    r->>'lotNumber', r->>'trackingType', (r->>'woItemId')::integer,
    (r->>'tagCreated')::timestamptz, (r->>'tagLastModified')::timestamptz, NULL, now()
  FROM jsonb_array_elements(p_rows) r
  ON CONFLICT (fb_tag_id) DO UPDATE SET
    tag_num = EXCLUDED.tag_num, fb_part_id = EXCLUDED.fb_part_id, part_num = EXCLUDED.part_num,
    location_id = EXCLUDED.location_id, location = EXCLUDED.location, location_group_id = EXCLUDED.location_group_id,
    qty = EXCLUDED.qty, qty_committed = EXCLUDED.qty_committed, lot_number = EXCLUDED.lot_number,
    tracking_type = EXCLUDED.tracking_type, fb_woitem_id = EXCLUDED.fb_woitem_id,
    tag_created = EXCLUDED.tag_created, tag_last_modified = EXCLUDED.tag_last_modified,
    removed_at = NULL, mirrored_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;

  IF p_removed_ids IS NOT NULL AND jsonb_typeof(p_removed_ids) = 'array' THEN
    UPDATE public.fb_tags SET removed_at = COALESCE(removed_at, now()), mirrored_at = now()
    WHERE fb_tag_id IN (SELECT x.v::bigint FROM jsonb_array_elements_text(p_removed_ids) AS x(v));
  END IF;

  UPDATE public.fb_sync_state
     SET last_tags_at = now(),
         last_tags_sweep_at = CASE WHEN p_sweep THEN now() ELSE last_tags_sweep_at END,
         family_errors = family_errors - 'tags'
   WHERE id = 1;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.fb_upsert_tags(jsonb, jsonb, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fb_upsert_tags(jsonb, jsonb, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.fb_upsert_tags(jsonb, jsonb, boolean) TO authenticated, service_role;

-- 2.5 BOMs (audit-tailed + nightly sweep) ------------------------------------
CREATE OR REPLACE FUNCTION public.fb_upsert_boms(
  p_boms jsonb, p_items jsonb, p_instructions jsonb, p_rev_to bigint DEFAULT NULL, p_sweep boolean DEFAULT false)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0; ids integer[];
BEGIN
  PERFORM public._fb_gate(ARRAY['integration','admin']);
  IF jsonb_typeof(p_boms) <> 'array' THEN RAISE EXCEPTION 'p_boms must be a jsonb array'; END IF;

  INSERT INTO public.fb_boms AS t (fb_bom_id, bom_num, description, active, revision, auto_create_type_id, date_last_modified, removed_at, mirrored_at)
  SELECT DISTINCT ON ((r->>'bomId')::integer)
    (r->>'bomId')::integer, r->>'bomNum', r->>'description', COALESCE((r->>'active')::boolean, true),
    r->>'revision', (r->>'autoCreateTypeId')::integer, (r->>'dateLastModified')::timestamptz, NULL, now()
  FROM jsonb_array_elements(p_boms) r
  ON CONFLICT (fb_bom_id) DO UPDATE SET
    bom_num = EXCLUDED.bom_num, description = EXCLUDED.description, active = EXCLUDED.active,
    revision = EXCLUDED.revision, auto_create_type_id = EXCLUDED.auto_create_type_id,
    date_last_modified = EXCLUDED.date_last_modified, removed_at = NULL, mirrored_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;

  SELECT array_agg(DISTINCT (r->>'bomId')::integer) INTO ids FROM jsonb_array_elements(p_boms) r;

  -- Items and instructions are replaced whole for the BOMs in this payload
  -- (a removed line must disappear, and Fishbowl does not soft-delete them).
  IF ids IS NOT NULL THEN
    DELETE FROM public.fb_bom_items        WHERE fb_bom_id = ANY(ids);
    DELETE FROM public.fb_bom_instructions WHERE fb_bom_id = ANY(ids);
  END IF;

  IF p_items IS NOT NULL AND jsonb_typeof(p_items) = 'array' THEN
    INSERT INTO public.fb_bom_items (fb_bomitem_id, fb_bom_id, type_id, fb_part_id, part_num, part_description,
                                     quantity, uom_id, uom, sort_id, stage, stage_bom_id, mirrored_at)
    SELECT DISTINCT ON ((r->>'bomItemId')::integer)
      (r->>'bomItemId')::integer, (r->>'bomId')::integer, (r->>'typeId')::integer, (r->>'partId')::integer,
      r->>'partNum', r->>'partDescription', (r->>'quantity')::numeric, (r->>'uomId')::integer, r->>'uom',
      (r->>'sortId')::integer, (r->>'stage')::boolean, (r->>'stageBomId')::integer, now()
    FROM jsonb_array_elements(p_items) r
    ON CONFLICT (fb_bomitem_id) DO UPDATE SET
      fb_bom_id = EXCLUDED.fb_bom_id, type_id = EXCLUDED.type_id, fb_part_id = EXCLUDED.fb_part_id,
      part_num = EXCLUDED.part_num, part_description = EXCLUDED.part_description, quantity = EXCLUDED.quantity,
      uom_id = EXCLUDED.uom_id, uom = EXCLUDED.uom, sort_id = EXCLUDED.sort_id, stage = EXCLUDED.stage,
      stage_bom_id = EXCLUDED.stage_bom_id, mirrored_at = now();
  END IF;

  IF p_instructions IS NOT NULL AND jsonb_typeof(p_instructions) = 'array' THEN
    INSERT INTO public.fb_bom_instructions (fb_bominstructionitem_id, fb_bom_id, sort_order, name, description, details, mirrored_at)
    SELECT DISTINCT ON ((r->>'instructionId')::bigint)
      (r->>'instructionId')::bigint, (r->>'bomId')::integer, (r->>'sortOrder')::integer,
      r->>'name', r->>'description', r->>'details', now()
    FROM jsonb_array_elements(p_instructions) r
    ON CONFLICT (fb_bominstructionitem_id) DO UPDATE SET
      fb_bom_id = EXCLUDED.fb_bom_id, sort_order = EXCLUDED.sort_order, name = EXCLUDED.name,
      description = EXCLUDED.description, details = EXCLUDED.details, mirrored_at = now();
  END IF;

  UPDATE public.fb_sync_state
     SET last_boms_at = now(),
         last_boms_rev = CASE WHEN p_rev_to IS NULL THEN last_boms_rev ELSE GREATEST(COALESCE(last_boms_rev, 0), p_rev_to) END,
         last_boms_sweep_at = CASE WHEN p_sweep THEN now() ELSE last_boms_sweep_at END,
         family_errors = family_errors - 'boms'
   WHERE id = 1;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.fb_upsert_boms(jsonb, jsonb, jsonb, bigint, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fb_upsert_boms(jsonb, jsonb, jsonb, bigint, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.fb_upsert_boms(jsonb, jsonb, jsonb, bigint, boolean) TO authenticated, service_role;

-- 2.6 Manufacture orders (audit-tailed) --------------------------------------
CREATE OR REPLACE FUNCTION public.fb_upsert_manufacture_orders(
  p_mos jsonb, p_mo_items jsonb, p_wos jsonb, p_wo_items jsonb, p_consumed jsonb, p_rev_to bigint DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0; mo_ids integer[]; wo_ids integer[];
BEGIN
  PERFORM public._fb_gate(ARRAY['integration','admin']);
  IF jsonb_typeof(p_mos) <> 'array' THEN RAISE EXCEPTION 'p_mos must be a jsonb array'; END IF;

  INSERT INTO public.fb_manufacture_orders AS t (
    fb_mo_id, mo_num, status_id, status, fb_so_id, location_group_id, date_created, date_issued,
    date_scheduled, date_completed, date_last_modified, note, fb_user_id, removed_at, mirrored_at)
  SELECT DISTINCT ON ((r->>'moId')::integer)
    (r->>'moId')::integer, r->>'moNum', (r->>'statusId')::integer, r->>'status', (r->>'soId')::integer,
    (r->>'locationGroupId')::integer, (r->>'dateCreated')::timestamptz, (r->>'dateIssued')::timestamptz,
    (r->>'dateScheduled')::timestamptz, (r->>'dateCompleted')::timestamptz, (r->>'dateLastModified')::timestamptz,
    r->>'note', (r->>'userId')::integer, NULL, now()
  FROM jsonb_array_elements(p_mos) r
  ON CONFLICT (fb_mo_id) DO UPDATE SET
    mo_num = EXCLUDED.mo_num, status_id = EXCLUDED.status_id, status = EXCLUDED.status, fb_so_id = EXCLUDED.fb_so_id,
    location_group_id = EXCLUDED.location_group_id, date_created = EXCLUDED.date_created, date_issued = EXCLUDED.date_issued,
    date_scheduled = EXCLUDED.date_scheduled, date_completed = EXCLUDED.date_completed,
    date_last_modified = EXCLUDED.date_last_modified, note = EXCLUDED.note, fb_user_id = EXCLUDED.fb_user_id,
    removed_at = NULL, mirrored_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;

  SELECT array_agg(DISTINCT (r->>'moId')::integer) INTO mo_ids FROM jsonb_array_elements(p_mos) r;

  -- Children are replaced whole per MO (Fishbowl deletes MO/WO items outright).
  IF mo_ids IS NOT NULL THEN
    SELECT array_agg(fb_wo_id) INTO wo_ids FROM public.fb_work_orders WHERE fb_mo_id = ANY(mo_ids);
    DELETE FROM public.fb_mo_items WHERE fb_mo_id = ANY(mo_ids);
    IF wo_ids IS NOT NULL THEN
      DELETE FROM public.fb_wo_consumed_lots WHERE fb_wo_id = ANY(wo_ids);
      DELETE FROM public.fb_wo_items         WHERE fb_wo_id = ANY(wo_ids);
      DELETE FROM public.fb_work_orders      WHERE fb_wo_id = ANY(wo_ids);
    END IF;
  END IF;

  IF p_mo_items IS NOT NULL AND jsonb_typeof(p_mo_items) = 'array' THEN
    INSERT INTO public.fb_mo_items (fb_moitem_id, fb_mo_id, type_id, parent_fb_moitem_id, fb_bom_id, bom_num, fb_part_id,
                                    part_num, description, qty_to_fulfill, qty_fulfilled, status_id, stage_level, sort_id, mirrored_at)
    SELECT DISTINCT ON ((r->>'moItemId')::integer)
      (r->>'moItemId')::integer, (r->>'moId')::integer, (r->>'typeId')::integer, (r->>'parentId')::integer,
      (r->>'bomId')::integer, r->>'bomNum', (r->>'partId')::integer, r->>'partNum', r->>'description',
      (r->>'qtyToFulfill')::numeric, (r->>'qtyFulfilled')::numeric, (r->>'statusId')::integer,
      (r->>'stageLevel')::integer, (r->>'sortId')::integer, now()
    FROM jsonb_array_elements(p_mo_items) r
    ON CONFLICT (fb_moitem_id) DO UPDATE SET
      fb_mo_id = EXCLUDED.fb_mo_id, type_id = EXCLUDED.type_id, parent_fb_moitem_id = EXCLUDED.parent_fb_moitem_id,
      fb_bom_id = EXCLUDED.fb_bom_id, bom_num = EXCLUDED.bom_num, fb_part_id = EXCLUDED.fb_part_id,
      part_num = EXCLUDED.part_num, description = EXCLUDED.description, qty_to_fulfill = EXCLUDED.qty_to_fulfill,
      qty_fulfilled = EXCLUDED.qty_fulfilled, status_id = EXCLUDED.status_id, stage_level = EXCLUDED.stage_level,
      sort_id = EXCLUDED.sort_id, mirrored_at = now();
  END IF;

  IF p_wos IS NOT NULL AND jsonb_typeof(p_wos) = 'array' THEN
    INSERT INTO public.fb_work_orders (fb_wo_id, wo_num, fb_mo_id, fb_moitem_id, status_id, status, qty_ordered, qty_target,
                                       qty_scrapped, location_id, date_created, date_started, date_finished, note, cost, mirrored_at)
    SELECT DISTINCT ON ((r->>'woId')::integer)
      (r->>'woId')::integer, r->>'woNum', (r->>'moId')::integer, (r->>'moItemId')::integer, (r->>'statusId')::integer,
      r->>'status', (r->>'qtyOrdered')::integer, (r->>'qtyTarget')::integer, (r->>'qtyScrapped')::integer,
      (r->>'locationId')::integer, (r->>'dateCreated')::timestamptz, (r->>'dateStarted')::timestamptz,
      (r->>'dateFinished')::timestamptz, r->>'note', (r->>'cost')::numeric, now()
    FROM jsonb_array_elements(p_wos) r
    ON CONFLICT (fb_wo_id) DO UPDATE SET
      wo_num = EXCLUDED.wo_num, fb_mo_id = EXCLUDED.fb_mo_id, fb_moitem_id = EXCLUDED.fb_moitem_id,
      status_id = EXCLUDED.status_id, status = EXCLUDED.status, qty_ordered = EXCLUDED.qty_ordered,
      qty_target = EXCLUDED.qty_target, qty_scrapped = EXCLUDED.qty_scrapped, location_id = EXCLUDED.location_id,
      date_created = EXCLUDED.date_created, date_started = EXCLUDED.date_started, date_finished = EXCLUDED.date_finished,
      note = EXCLUDED.note, cost = EXCLUDED.cost, mirrored_at = now();
  END IF;

  IF p_wo_items IS NOT NULL AND jsonb_typeof(p_wo_items) = 'array' THEN
    INSERT INTO public.fb_wo_items (fb_woitem_id, fb_wo_id, fb_moitem_id, type_id, fb_part_id, part_num, description,
                                    qty_target, qty_used, qty_scrapped, cost, standard_cost, sort_id, mirrored_at)
    SELECT DISTINCT ON ((r->>'woItemId')::integer)
      (r->>'woItemId')::integer, (r->>'woId')::integer, (r->>'moItemId')::integer, (r->>'typeId')::integer,
      (r->>'partId')::integer, r->>'partNum', r->>'description', (r->>'qtyTarget')::numeric, (r->>'qtyUsed')::numeric,
      (r->>'qtyScrapped')::numeric, (r->>'cost')::numeric, (r->>'standardCost')::numeric, (r->>'sortId')::integer, now()
    FROM jsonb_array_elements(p_wo_items) r
    ON CONFLICT (fb_woitem_id) DO UPDATE SET
      fb_wo_id = EXCLUDED.fb_wo_id, fb_moitem_id = EXCLUDED.fb_moitem_id, type_id = EXCLUDED.type_id,
      fb_part_id = EXCLUDED.fb_part_id, part_num = EXCLUDED.part_num, description = EXCLUDED.description,
      qty_target = EXCLUDED.qty_target, qty_used = EXCLUDED.qty_used, qty_scrapped = EXCLUDED.qty_scrapped,
      cost = EXCLUDED.cost, standard_cost = EXCLUDED.standard_cost, sort_id = EXCLUDED.sort_id, mirrored_at = now();
  END IF;

  IF p_consumed IS NOT NULL AND jsonb_typeof(p_consumed) = 'array' THEN
    INSERT INTO public.fb_wo_consumed_lots (fb_pickitem_id, fb_wo_id, fb_woitem_id, fb_part_id, part_num, qty, status_id,
                                            src_location, src_tag_num, lot_number, mirrored_at)
    SELECT DISTINCT ON ((r->>'pickItemId')::bigint)
      (r->>'pickItemId')::bigint, (r->>'woId')::integer, (r->>'woItemId')::integer, (r->>'partId')::integer, r->>'partNum',
      (r->>'qty')::numeric, (r->>'statusId')::integer, r->>'srcLocation', (r->>'srcTagNum')::bigint, r->>'lotNumber', now()
    FROM jsonb_array_elements(p_consumed) r
    ON CONFLICT (fb_pickitem_id) DO UPDATE SET
      fb_wo_id = EXCLUDED.fb_wo_id, fb_woitem_id = EXCLUDED.fb_woitem_id, fb_part_id = EXCLUDED.fb_part_id,
      part_num = EXCLUDED.part_num, qty = EXCLUDED.qty, status_id = EXCLUDED.status_id, src_location = EXCLUDED.src_location,
      src_tag_num = EXCLUDED.src_tag_num, lot_number = EXCLUDED.lot_number, mirrored_at = now();
  END IF;

  UPDATE public.fb_sync_state
     SET last_mos_at = now(),
         last_mos_rev = CASE WHEN p_rev_to IS NULL THEN last_mos_rev ELSE GREATEST(COALESCE(last_mos_rev, 0), p_rev_to) END,
         family_errors = family_errors - 'mos'
   WHERE id = 1;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.fb_upsert_manufacture_orders(jsonb, jsonb, jsonb, jsonb, jsonb, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fb_upsert_manufacture_orders(jsonb, jsonb, jsonb, jsonb, jsonb, bigint) FROM anon;
GRANT EXECUTE ON FUNCTION public.fb_upsert_manufacture_orders(jsonb, jsonb, jsonb, jsonb, jsonb, bigint) TO authenticated, service_role;

-- 2.7 Family error stamp (called by the bridge's guard on failure) -----------
CREATE OR REPLACE FUNCTION public.fb_family_error(p_family text, p_message text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public._fb_gate(ARRAY['integration','admin']);
  UPDATE public.fb_sync_state
     SET family_errors = family_errors || jsonb_build_object(p_family, jsonb_build_object('at', now(), 'message', left(COALESCE(p_message, ''), 500)))
   WHERE id = 1;
END $$;
REVOKE ALL ON FUNCTION public.fb_family_error(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fb_family_error(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fb_family_error(text, text) TO authenticated, service_role;

-- 2.8 Family cursors read in one call --------------------------------------
CREATE OR REPLACE FUNCTION public.fb_get_family_cursors()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT jsonb_build_object(
    'so',    last_rev,
    'picks', last_picks_rev,
    'ships', last_ships_rev,
    'mos',   last_mos_rev,
    'boms',  last_boms_rev,
    'tagsAt', last_tags_at,
    'tagsSweepAt', last_tags_sweep_at,
    'bomsSweepAt', last_boms_sweep_at,
    'postingsAt', last_postings_at)
  FROM public.fb_sync_state WHERE id = 1;
$$;
REVOKE ALL ON FUNCTION public.fb_get_family_cursors() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fb_get_family_cursors() FROM anon;
GRANT EXECUTE ON FUNCTION public.fb_get_family_cursors() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Line-state views (D-ASM-06) — read by the Order Queue in Batch A2
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_fb_line_pick_state WITH (security_invoker = true) AS
SELECT DISTINCT ON (p.fb_soitem_id)
       p.fb_soitem_id,
       p.fb_so_id,
       p.fb_pickitem_id,
       p.pick_num,
       p.status_id        AS pick_status_id,
       p.status           AS pick_status,
       p.dest_location,
       p.src_tag_num,
       p.qty              AS pick_qty,
       p.pick_last_modified,
       CASE
         WHEN p.status_id IN (5, 6) AND p.dest_location = 'Assembly'   THEN 'assembly'
         WHEN p.status_id IN (5, 6) AND p.dest_location = 'Production' THEN 'production'
         WHEN p.status_id IN (5, 6) AND p.dest_location = 'Purchasing' THEN 'purchasing'
         WHEN p.status_id IN (5, 6)                                      THEN 'held'
         WHEN p.status_id = 30                                           THEN 'reserved'
         WHEN p.status_id = 40                                           THEN 'picked'
         WHEN p.status_id = 20                                           THEN 'started'
         ELSE 'entered'
       END AS signal
FROM public.fb_pick_items p
WHERE p.removed_at IS NULL AND p.fb_soitem_id IS NOT NULL
ORDER BY p.fb_soitem_id, p.pick_last_modified DESC NULLS LAST, p.fb_pickitem_id DESC;
GRANT SELECT ON public.v_fb_line_pick_state TO authenticated;
REVOKE ALL ON public.v_fb_line_pick_state FROM anon;
COMMENT ON VIEW public.v_fb_line_pick_state IS
  'Latest Fishbowl pick line per SO line and the D-ASM-06 signal: assembly / production / purchasing when held with that destination; held (destination still Shipping) otherwise; reserved = Committed; picked = Finished.';

CREATE OR REPLACE VIEW public.v_fb_line_ship_state WITH (security_invoker = true) AS
WITH shipped AS (
  SELECT si.fb_soitem_id,
         SUM(si.qty_shipped) FILTER (WHERE s.status_id = 30)              AS qty_shipped,
         MAX(s.date_shipped)  FILTER (WHERE s.status_id = 30)              AS last_shipped_at,
         MIN(s.date_shipped)  FILTER (WHERE s.status_id = 30)              AS first_shipped_at,
         string_agg(DISTINCT s.carrier, ', ')                              AS carriers,
         string_agg(DISTINCT c.tracking_num, ', ') FILTER (WHERE c.tracking_num <> '') AS tracking_nums,
         string_agg(DISTINCT s.ship_num, ', ')                             AS ship_nums,
         BOOL_OR(s.status_id = 20)                                         AS any_packed
  FROM public.fb_ship_items si
  JOIN public.fb_shipments s ON s.fb_ship_id = si.fb_ship_id AND s.removed_at IS NULL
  LEFT JOIN public.fb_ship_cartons c ON c.fb_carton_id = si.fb_carton_id
  WHERE si.fb_soitem_id IS NOT NULL
  GROUP BY si.fb_soitem_id
),
posted AS (
  SELECT pi.fb_soitem_id,
         MIN(p.post_date)       AS first_posted_at,
         MAX(p.post_date)       AS last_posted_at,
         BOOL_OR(COALESCE(p.journal_posted, false)) AS any_journal_posted
  FROM public.fb_posting_items pi
  JOIN public.fb_postings p ON p.fb_postso_id = pi.fb_postso_id
  WHERE pi.fb_soitem_id IS NOT NULL
  GROUP BY pi.fb_soitem_id
)
SELECT COALESCE(sh.fb_soitem_id, po.fb_soitem_id) AS fb_soitem_id,
       sh.qty_shipped, sh.first_shipped_at, sh.last_shipped_at, sh.carriers, sh.tracking_nums, sh.ship_nums, sh.any_packed,
       po.first_posted_at AS invoiced_at, po.last_posted_at, po.any_journal_posted
FROM shipped sh
FULL OUTER JOIN posted po ON po.fb_soitem_id = sh.fb_soitem_id;
GRANT SELECT ON public.v_fb_line_ship_state TO authenticated;
REVOKE ALL ON public.v_fb_line_ship_state FROM anon;
COMMENT ON VIEW public.v_fb_line_ship_state IS
  'Per SO line: shipped quantity, dates, carriers and tracking numbers from the ship mirror; invoiced_at = earliest postso.postDate (D-ASM-14); any_journal_posted is the later QuickBooks phase.';

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification (run after the bridge's first cycle against this database)
-- ---------------------------------------------------------------------------
-- SELECT COUNT(*) FROM fb_pick_items WHERE removed_at IS NULL;              -- ≈ 1,078 on open SOs (probe, Nov 3)
-- SELECT signal, COUNT(*) FROM v_fb_line_pick_state GROUP BY 1;             -- 'held' ≈ 80 until Ashley sets destinations
-- SELECT * FROM v_fb_line_ship_state WHERE fb_soitem_id IN (108409, 108410, 108411);  -- SO 18934: shipped 2026-10-08 08:45, UPS, 1Z…7341, invoiced same instant
-- SELECT part_num, lot_number, qty, location FROM fb_tags WHERE part_num = 'SK4C5P' AND removed_at IS NULL;  -- 5 tags; 139390 = lot 100252
-- SELECT * FROM fb_wo_consumed_lots WHERE fb_wo_id = 8779;                  -- 4 rows: 100252, 303942, 303611, 303798
-- SELECT bom_num, COUNT(*) FROM fb_bom_instructions b JOIN fb_boms m USING (fb_bom_id) GROUP BY 1 ORDER BY 2 DESC LIMIT 5;
-- SELECT last_picks_rev, last_ships_rev, last_mos_rev, last_boms_rev, last_tags_at, last_postings_at, family_errors FROM fb_sync_state WHERE id = 1;
