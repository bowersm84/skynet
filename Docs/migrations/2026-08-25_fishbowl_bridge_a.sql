-- ============================================================================
-- FB1 Batch A — Fishbowl Bridge: mirror schema, ingest RPCs, linkage
-- File: Docs/migrations/2026-08-25_fishbowl_bridge_a.sql
-- Apply to TEST (ylzmyjjqibpbqbwjsnqj) first. PROD only after FB1 sign-off.
-- Idempotent: safe to re-run. Runs as ONE statement batch; the final SELECT is the verification.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Role value: integration (bridge service account). order_processor is an ADDITIONAL role held in
--    profiles.roles[] (unconstrained per D-MROLE-02) and needs no DDL.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%role%' AND pg_get_constraintdef(oid) ILIKE '%machinist%'
  LOOP
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role::text = ANY (ARRAY[
  'admin','compliance','machinist','assembly','display','scheduler','customer_service',
  'finishing','president','viewer','purchaser','integration']));

-- ---------------------------------------------------------------------------
-- 2. Customer order lines: live Fishbowl quantities for linked lines (D-FB-12)
-- ---------------------------------------------------------------------------
ALTER TABLE public.customer_order_lines
  ADD COLUMN IF NOT EXISTS fb_qty_ordered numeric,
  ADD COLUMN IF NOT EXISTS fb_qty_fulfilled numeric,
  ADD COLUMN IF NOT EXISTS fb_qty_to_fulfill numeric;

-- ---------------------------------------------------------------------------
-- 3. Mirror tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fb_sync_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_rev bigint NOT NULL DEFAULT 0,
  last_rev_at timestamptz,
  last_heartbeat_at timestamptz,
  last_backfill_at timestamptz,
  last_reconcile_at timestamptz,
  last_inventory_at timestamptz,
  bridge_version text,
  bridge_host text,
  last_error text,
  last_error_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.fb_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.fb_users (
  fb_user_id integer PRIMARY KEY,
  username text NOT NULL,
  full_name text,
  is_active boolean NOT NULL DEFAULT true,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fb_sales_orders (
  fb_so_id integer PRIMARY KEY,
  so_number text NOT NULL,
  fb_customer_id integer NOT NULL,
  customer_name text,
  customer_po text,
  status_id smallint NOT NULL,
  priority_id smallint,
  type_id smallint,
  location_group_id smallint,
  salesman text,
  salesman_id integer,
  created_by_username text,
  fb_date_created timestamptz,
  fb_date_issued timestamptz,
  fb_date_completed timestamptz,
  fb_date_last_modified timestamptz,
  note text,
  ship_to_name text,
  custom_fields jsonb,
  raw jsonb NOT NULL,
  fingerprint text NOT NULL,
  last_rev bigint,
  first_synced_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  -- SkyNet-owned (never written by ingest except customer_id on first sight)
  customer_id uuid REFERENCES public.customers(id),
  customer_order_id uuid REFERENCES public.customer_orders(id)
);
CREATE INDEX IF NOT EXISTS idx_fbso_number ON public.fb_sales_orders (so_number);
CREATE INDEX IF NOT EXISTS idx_fbso_open ON public.fb_sales_orders (status_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fbso_co ON public.fb_sales_orders (customer_order_id);

CREATE TABLE IF NOT EXISTS public.fb_sales_order_lines (
  fb_soitem_id integer PRIMARY KEY,
  fb_so_id integer NOT NULL REFERENCES public.fb_sales_orders(fb_so_id),
  line_number integer NOT NULL,
  type_id smallint NOT NULL,
  status_id smallint NOT NULL,
  product_num text NOT NULL,
  part_num text,
  fb_product_id integer,
  fb_part_id integer,
  fb_part_type_id smallint,
  description text,
  qty_ordered numeric NOT NULL,
  qty_fulfilled numeric NOT NULL DEFAULT 0,
  qty_picked numeric,
  qty_to_fulfill numeric,
  uom_id integer,
  unit_price numeric,
  total_price numeric,
  date_scheduled_fulfillment timestamptz,
  remaining_parts_ship_date date,
  effective_due_date date,
  due_date_is_default boolean NOT NULL DEFAULT false,
  rev_level text,
  customer_part_num text,
  note text,
  custom_fields jsonb,
  raw jsonb NOT NULL,
  fingerprint text NOT NULL,
  last_rev bigint,
  first_synced_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  -- SkyNet-owned
  part_id uuid REFERENCES public.parts(id),
  kit_sku_id uuid REFERENCES public.kit_skus(id),
  resolution text CHECK (resolution IN ('part','kit','unlisted_skybolt','unlisted','n_a')),
  disposition text NOT NULL DEFAULT 'pending'
    CHECK (disposition IN ('pending','production','stock','purchased','kit_header','ignore','unlisted')),
  disposition_by uuid REFERENCES public.profiles(id),
  disposition_at timestamptz,
  disposition_note text,
  customer_order_line_id uuid REFERENCES public.customer_order_lines(id)
);
CREATE INDEX IF NOT EXISTS idx_fbsol_so ON public.fb_sales_order_lines (fb_so_id);
CREATE INDEX IF NOT EXISTS idx_fbsol_part ON public.fb_sales_order_lines (part_id);
CREATE INDEX IF NOT EXISTS idx_fbsol_disp ON public.fb_sales_order_lines (disposition) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fbsol_col ON public.fb_sales_order_lines (customer_order_line_id);

CREATE TABLE IF NOT EXISTS public.fb_sync_events (
  id bigserial PRIMARY KEY,
  fb_so_id integer NOT NULL,
  fb_soitem_id integer,
  event_type text NOT NULL CHECK (event_type IN (
    'so_created','so_changed','so_status_changed','so_removed',
    'line_added','line_changed','line_status_changed','line_removed')),
  changes jsonb,
  fb_rev bigint,
  fb_modified_user_id integer,
  fb_username text,
  fb_timestamp timestamptz,
  affects_co boolean NOT NULL DEFAULT false,
  requires_ack boolean NOT NULL DEFAULT false,
  acknowledged_by uuid REFERENCES public.profiles(id),
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fbev_so ON public.fb_sync_events (fb_so_id);
CREATE INDEX IF NOT EXISTS idx_fbev_open ON public.fb_sync_events (requires_ack) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fbev_created ON public.fb_sync_events (created_at DESC);

CREATE TABLE IF NOT EXISTS public.fb_part_inventory (
  part_num text PRIMARY KEY,
  fb_part_id integer,
  qty_on_hand numeric,
  qty_allocated numeric,
  qty_available numeric,
  qty_on_order numeric,
  snapshot_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 4. RLS: SELECT for authenticated, no direct writes (D-FB-18, stock_requests precedent)
-- ---------------------------------------------------------------------------
ALTER TABLE public.fb_sync_state        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_sales_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_sales_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_sync_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_part_inventory    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fbst_select_authenticated  ON public.fb_sync_state;
DROP POLICY IF EXISTS fbus_select_authenticated  ON public.fb_users;
DROP POLICY IF EXISTS fbso_select_authenticated  ON public.fb_sales_orders;
DROP POLICY IF EXISTS fbsol_select_authenticated ON public.fb_sales_order_lines;
DROP POLICY IF EXISTS fbev_select_authenticated  ON public.fb_sync_events;
DROP POLICY IF EXISTS fbinv_select_authenticated ON public.fb_part_inventory;

CREATE POLICY fbst_select_authenticated  ON public.fb_sync_state        FOR SELECT TO authenticated USING (true);
CREATE POLICY fbus_select_authenticated  ON public.fb_users             FOR SELECT TO authenticated USING (true);
CREATE POLICY fbso_select_authenticated  ON public.fb_sales_orders      FOR SELECT TO authenticated USING (true);
CREATE POLICY fbsol_select_authenticated ON public.fb_sales_order_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY fbev_select_authenticated  ON public.fb_sync_events       FOR SELECT TO authenticated USING (true);
CREATE POLICY fbinv_select_authenticated ON public.fb_part_inventory    FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.fb_sync_state, public.fb_users, public.fb_sales_orders, public.fb_sales_order_lines,
  public.fb_sync_events, public.fb_part_inventory TO authenticated;
REVOKE ALL ON public.fb_sync_state, public.fb_users, public.fb_sales_orders, public.fb_sales_order_lines,
  public.fb_sync_events, public.fb_part_inventory FROM anon;

-- ---------------------------------------------------------------------------
-- 5. Gate (NULL-uid SQL-Editor passthrough, user_has_role otherwise — _job_merge_gate pattern)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._fb_gate(p_roles text[])
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;
  IF NOT public.user_has_role(v_uid, VARIADIC p_roles) THEN
    RAISE EXCEPTION 'Not authorized: requires one of %', array_to_string(p_roles, ', ') USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._fb_gate(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._fb_gate(text[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Cursor + heartbeat
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_get_cursor()
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_rev bigint;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration', 'admin']);
  SELECT last_rev INTO v_rev FROM public.fb_sync_state WHERE id = 1;
  RETURN COALESCE(v_rev, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.fb_set_cursor(p_rev bigint)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_state public.fb_sync_state%ROWTYPE;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration', 'admin']);
  UPDATE public.fb_sync_state
     SET last_rev = GREATEST(last_rev, COALESCE(p_rev, 0)), last_rev_at = now(), updated_at = now()
   WHERE id = 1
   RETURNING * INTO v_state;
  RETURN jsonb_build_object('last_rev', v_state.last_rev, 'last_rev_at', v_state.last_rev_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.fb_heartbeat(p_state jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public._fb_gate(ARRAY['integration', 'admin']);
  UPDATE public.fb_sync_state
     SET last_heartbeat_at = now(),
         bridge_version    = COALESCE(p_state->>'version', bridge_version),
         bridge_host       = COALESCE(p_state->>'host', bridge_host),
         last_error        = p_state->>'last_error',
         last_error_at     = CASE WHEN p_state->>'last_error' IS NULL THEN last_error_at ELSE now() END,
         updated_at        = now()
   WHERE id = 1;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Ingest (D-FB-02 … D-FB-16)
-- Payload: { source: 'tail'|'reconcile'|'backfill', rev_from, rev_to,
--            orders: [ { header:{...}, lines:[{...}], complete:true, rev, revUserId, revTimestamp } ],
--            removed_ids: [fb_so_id, ...] }
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_ingest_delta(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_source        text := COALESCE(p_payload->>'source', 'tail');
  v_rev_to        bigint := NULLIF(p_payload->>'rev_to', '')::bigint;
  v_emit          boolean;
  v_order         jsonb;
  v_h             jsonb;
  v_l             jsonb;
  v_so_id         integer;
  v_status        smallint;
  v_fp            text;
  v_old           public.fb_sales_orders%ROWTYPE;
  v_new_so        boolean;
  v_customer_id   uuid;
  v_changes       jsonb;
  v_rev           bigint;
  v_rev_user      integer;
  v_rev_ts        timestamptz;
  v_rev_username  text;
  v_line_old      public.fb_sales_order_lines%ROWTYPE;
  v_line_id       integer;
  v_lfp           text;
  v_part_id       uuid;
  v_part_type     text;
  v_kit_id        uuid;
  v_resolution    text;
  v_disposition   text;
  v_key           text;
  v_part_num      text;
  v_product_num   text;
  v_type          smallint;
  v_lstatus       smallint;
  v_dsf           timestamptz;
  v_rpsd          date;
  v_eff           date;
  v_default       boolean;
  v_qty_ordered   numeric;
  v_qty_fulfilled numeric;
  v_qty_to_fulfill numeric;
  v_ids           integer[];
  v_removed_id    integer;
  v_col           record;
  v_alloc         numeric;
  v_delta         numeric;
  v_ack           boolean;
  c_ins  integer := 0;  c_upd  integer := 0;  c_same integer := 0;  c_skip integer := 0;  c_gone integer := 0;
  c_lins integer := 0;  c_lupd integer := 0;  c_lrem integer := 0;  c_ev   integer := 0;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration', 'admin']);
  v_emit := v_source <> 'backfill';

  FOR v_order IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload->'orders', '[]'::jsonb)) LOOP
    v_h      := v_order->'header';
    v_so_id  := (v_h->>'id')::integer;
    v_status := (v_h->>'statusId')::smallint;
    v_rev      := NULLIF(v_order->>'rev', '')::bigint;
    v_rev_user := NULLIF(v_order->>'revUserId', '')::integer;
    v_rev_ts   := NULLIF(v_order->>'revTimestamp', '')::timestamptz;
    v_rev_username := NULL;
    IF v_rev_user IS NOT NULL THEN
      SELECT username INTO v_rev_username FROM public.fb_users WHERE fb_user_id = v_rev_user;
    END IF;
    v_fp := md5((v_h - 'dateLastModified')::text);

    SELECT * INTO v_old FROM public.fb_sales_orders WHERE fb_so_id = v_so_id FOR UPDATE;
    v_new_so := NOT FOUND;

    -- D-FB-11: only Issued / In Progress orders enter SkyNet; anything already mirrored keeps updating.
    IF v_new_so AND v_status NOT IN (20, 25) THEN
      c_skip := c_skip + 1;
      CONTINUE;
    END IF;

    -- Customer resolve (customers.customer_id is the Fishbowl id as text); auto-create from Fishbowl data.
    v_customer_id := NULL;
    SELECT id INTO v_customer_id FROM public.customers WHERE customer_id = (v_h->>'customerId');
    IF v_customer_id IS NULL AND (v_h->>'customerId') ~ '^[0-9]{1,6}$' AND COALESCE(v_h->>'customerName', '') <> '' THEN
      INSERT INTO public.customers (customer_id, name, is_active, notes)
      VALUES (v_h->>'customerId', v_h->>'customerName', true,
              'Auto-created by Fishbowl Bridge from SO ' || COALESCE(v_h->>'num', ''))
      RETURNING id INTO v_customer_id;
    END IF;

    IF v_new_so THEN
      INSERT INTO public.fb_sales_orders (
        fb_so_id, so_number, fb_customer_id, customer_name, customer_po, status_id, priority_id, type_id,
        location_group_id, salesman, salesman_id, created_by_username, fb_date_created, fb_date_issued,
        fb_date_completed, fb_date_last_modified, note, ship_to_name, custom_fields, raw, fingerprint, last_rev, customer_id)
      VALUES (
        v_so_id, COALESCE(v_h->>'num', ''), (v_h->>'customerId')::integer, v_h->>'customerName', v_h->>'customerPO',
        v_status, NULLIF(v_h->>'priorityId', '')::smallint, NULLIF(v_h->>'typeId', '')::smallint,
        NULLIF(v_h->>'locationGroupId', '')::smallint, v_h->>'salesman', NULLIF(v_h->>'salesmanId', '')::integer,
        v_h->>'username', NULLIF(v_h->>'dateCreated', '')::timestamptz, NULLIF(v_h->>'dateIssued', '')::timestamptz,
        NULLIF(v_h->>'dateCompleted', '')::timestamptz, NULLIF(v_h->>'dateLastModified', '')::timestamptz,
        v_h->>'note', v_h->>'shipToName', v_h->'customFields', v_h, v_fp, v_rev, v_customer_id);
      c_ins := c_ins + 1;
      IF v_emit THEN
        INSERT INTO public.fb_sync_events (fb_so_id, event_type, changes, fb_rev, fb_modified_user_id, fb_username, fb_timestamp)
        VALUES (v_so_id, 'so_created', jsonb_build_object('status_id', v_status, 'so_number', v_h->>'num'), v_rev, v_rev_user, v_rev_username, v_rev_ts);
        c_ev := c_ev + 1;
      END IF;

    ELSIF v_old.fingerprint IS DISTINCT FROM v_fp OR v_old.removed_at IS NOT NULL THEN
      v_changes := '{}'::jsonb;
      IF v_old.status_id IS DISTINCT FROM v_status THEN
        v_changes := v_changes || jsonb_build_object('status_id', jsonb_build_object('old', v_old.status_id, 'new', v_status));
      END IF;
      IF v_old.customer_po IS DISTINCT FROM (v_h->>'customerPO') THEN
        v_changes := v_changes || jsonb_build_object('customer_po', jsonb_build_object('old', v_old.customer_po, 'new', v_h->>'customerPO'));
      END IF;
      IF v_old.priority_id IS DISTINCT FROM NULLIF(v_h->>'priorityId', '')::smallint THEN
        v_changes := v_changes || jsonb_build_object('priority_id', jsonb_build_object('old', v_old.priority_id, 'new', NULLIF(v_h->>'priorityId', '')::smallint));
      END IF;
      IF v_old.salesman IS DISTINCT FROM (v_h->>'salesman') THEN
        v_changes := v_changes || jsonb_build_object('salesman', jsonb_build_object('old', v_old.salesman, 'new', v_h->>'salesman'));
      END IF;
      IF v_old.customer_name IS DISTINCT FROM (v_h->>'customerName') THEN
        v_changes := v_changes || jsonb_build_object('customer_name', jsonb_build_object('old', v_old.customer_name, 'new', v_h->>'customerName'));
      END IF;
      IF v_old.note IS DISTINCT FROM (v_h->>'note') THEN
        v_changes := v_changes || jsonb_build_object('note', jsonb_build_object('old', left(v_old.note, 200), 'new', left(v_h->>'note', 200)));
      END IF;
      IF v_old.removed_at IS NOT NULL THEN
        v_changes := v_changes || jsonb_build_object('reappeared', jsonb_build_object('old', true, 'new', false));
      END IF;

      UPDATE public.fb_sales_orders SET
        so_number = COALESCE(v_h->>'num', so_number),
        fb_customer_id = (v_h->>'customerId')::integer,
        customer_name = v_h->>'customerName',
        customer_po = v_h->>'customerPO',
        status_id = v_status,
        priority_id = NULLIF(v_h->>'priorityId', '')::smallint,
        type_id = NULLIF(v_h->>'typeId', '')::smallint,
        location_group_id = NULLIF(v_h->>'locationGroupId', '')::smallint,
        salesman = v_h->>'salesman',
        salesman_id = NULLIF(v_h->>'salesmanId', '')::integer,
        created_by_username = v_h->>'username',
        fb_date_created = NULLIF(v_h->>'dateCreated', '')::timestamptz,
        fb_date_issued = NULLIF(v_h->>'dateIssued', '')::timestamptz,
        fb_date_completed = NULLIF(v_h->>'dateCompleted', '')::timestamptz,
        fb_date_last_modified = NULLIF(v_h->>'dateLastModified', '')::timestamptz,
        note = v_h->>'note',
        ship_to_name = v_h->>'shipToName',
        custom_fields = v_h->'customFields',
        raw = v_h,
        fingerprint = v_fp,
        last_rev = COALESCE(v_rev, last_rev),
        last_synced_at = now(),
        removed_at = NULL,
        customer_id = COALESCE(customer_id, v_customer_id)
      WHERE fb_so_id = v_so_id;
      c_upd := c_upd + 1;

      IF v_emit AND v_changes <> '{}'::jsonb THEN
        INSERT INTO public.fb_sync_events (fb_so_id, event_type, changes, fb_rev, fb_modified_user_id, fb_username, fb_timestamp, affects_co, requires_ack)
        VALUES (v_so_id,
                CASE WHEN v_changes ? 'status_id' THEN 'so_status_changed' ELSE 'so_changed' END,
                v_changes, v_rev, v_rev_user, v_rev_username, v_rev_ts,
                v_old.customer_order_id IS NOT NULL,
                v_old.customer_order_id IS NOT NULL AND v_status IN (80, 85, 90));
        c_ev := c_ev + 1;
      END IF;

      -- D-FB-14: PO number is a safe field on the linked CO.
      IF v_old.customer_order_id IS NOT NULL AND v_changes ? 'customer_po' THEN
        UPDATE public.customer_orders SET po_number = v_h->>'customerPO', updated_at = now()
         WHERE id = v_old.customer_order_id;
      END IF;

    ELSE
      UPDATE public.fb_sales_orders
         SET last_rev = COALESCE(v_rev, last_rev), last_synced_at = now(),
             fb_date_last_modified = COALESCE(NULLIF(v_h->>'dateLastModified', '')::timestamptz, fb_date_last_modified)
       WHERE fb_so_id = v_so_id;
      c_same := c_same + 1;
    END IF;

    -- ----- lines -----
    v_ids := ARRAY[]::integer[];
    FOR v_l IN SELECT * FROM jsonb_array_elements(COALESCE(v_order->'lines', '[]'::jsonb)) LOOP
      v_line_id := (v_l->>'id')::integer;
      v_ids := v_ids || v_line_id;
      v_lfp := md5((v_l - 'dateLastModified')::text);
      v_type := (v_l->>'typeId')::smallint;
      v_lstatus := (v_l->>'statusId')::smallint;
      v_product_num := COALESCE(v_l->>'productNum', '');
      v_part_num := NULLIF(v_l->>'partNum', '');
      v_dsf := NULLIF(v_l->>'dateScheduledFulfillment', '')::timestamptz;
      v_rpsd := NULLIF(v_l->>'remainingPartsShipDate', '')::date;
      v_eff := COALESCE(v_rpsd, (v_dsf AT TIME ZONE 'America/New_York')::date);
      v_default := v_rpsd IS NULL AND v_dsf IS NOT NULL
                   AND (v_dsf AT TIME ZONE 'America/New_York')::time <> TIME '00:00:00';
      v_qty_ordered := COALESCE(NULLIF(v_l->>'qtyOrdered', '')::numeric, 0);
      v_qty_fulfilled := COALESCE(NULLIF(v_l->>'qtyFulfilled', '')::numeric, 0);
      v_qty_to_fulfill := NULLIF(v_l->>'qtyToFulfill', '')::numeric;

      SELECT * INTO v_line_old FROM public.fb_sales_order_lines WHERE fb_soitem_id = v_line_id FOR UPDATE;

      IF NOT FOUND THEN
        -- D-FB-08 resolution, D-FB-09 auto-disposition (first sight only)
        v_part_id := NULL; v_part_type := NULL; v_kit_id := NULL;
        v_key := upper(btrim(COALESCE(v_part_num, v_product_num)));
        IF v_type = 80 THEN
          SELECT id INTO v_kit_id FROM public.kit_skus WHERE upper(btrim(part_number)) = upper(btrim(v_product_num)) LIMIT 1;
          v_resolution := CASE WHEN v_kit_id IS NOT NULL THEN 'kit' ELSE 'unlisted_skybolt' END;
          v_disposition := 'kit_header';
        ELSIF v_type IN (10, 12) THEN
          SELECT id, part_type INTO v_part_id, v_part_type FROM public.parts WHERE upper(btrim(part_number)) = v_key LIMIT 1;
          IF v_part_id IS NULL AND v_part_num IS NOT NULL THEN
            SELECT id, part_type INTO v_part_id, v_part_type FROM public.parts WHERE upper(btrim(part_number)) = upper(btrim(v_product_num)) LIMIT 1;
          END IF;
          IF v_part_id IS NOT NULL THEN
            v_resolution := 'part';
            v_disposition := CASE WHEN v_part_type = 'purchased' THEN 'purchased' ELSE 'pending' END;
          ELSIF v_key ~ '^(SK|ZG|QL)' THEN
            v_resolution := 'unlisted_skybolt';
            v_disposition := 'pending';
          ELSE
            v_resolution := 'unlisted';
            v_disposition := 'unlisted';
          END IF;
        ELSE
          v_resolution := 'n_a';
          v_disposition := 'ignore';
        END IF;

        INSERT INTO public.fb_sales_order_lines (
          fb_soitem_id, fb_so_id, line_number, type_id, status_id, product_num, part_num, fb_product_id, fb_part_id,
          fb_part_type_id, description, qty_ordered, qty_fulfilled, qty_picked, qty_to_fulfill, uom_id, unit_price,
          total_price, date_scheduled_fulfillment, remaining_parts_ship_date, effective_due_date, due_date_is_default,
          rev_level, customer_part_num, note, custom_fields, raw, fingerprint, last_rev,
          part_id, kit_sku_id, resolution, disposition)
        VALUES (
          v_line_id, v_so_id, COALESCE((v_l->>'soLineItem')::integer, 0), v_type, v_lstatus, v_product_num, v_part_num,
          NULLIF(v_l->>'productId', '')::integer, NULLIF(v_l->>'fbPartId', '')::integer,
          NULLIF(v_l->>'partTypeId', '')::smallint, v_l->>'description', v_qty_ordered, v_qty_fulfilled,
          NULLIF(v_l->>'qtyPicked', '')::numeric, v_qty_to_fulfill, NULLIF(v_l->>'uomId', '')::integer,
          NULLIF(v_l->>'unitPrice', '')::numeric, NULLIF(v_l->>'totalPrice', '')::numeric, v_dsf, v_rpsd, v_eff, v_default,
          v_l->>'revLevel', v_l->>'customerPartNum', v_l->>'note', v_l->'customFields', v_l, v_lfp, v_rev,
          v_part_id, v_kit_id, v_resolution, v_disposition);
        c_lins := c_lins + 1;
        IF v_emit AND NOT v_new_so THEN
          INSERT INTO public.fb_sync_events (fb_so_id, fb_soitem_id, event_type, changes, fb_rev, fb_modified_user_id, fb_username, fb_timestamp)
          VALUES (v_so_id, v_line_id, 'line_added',
                  jsonb_build_object('product_num', v_product_num, 'qty_ordered', v_qty_ordered, 'disposition', v_disposition),
                  v_rev, v_rev_user, v_rev_username, v_rev_ts);
          c_ev := c_ev + 1;
        END IF;

      ELSIF v_line_old.fingerprint IS DISTINCT FROM v_lfp OR v_line_old.removed_at IS NOT NULL THEN
        v_changes := '{}'::jsonb;
        IF v_line_old.qty_ordered IS DISTINCT FROM v_qty_ordered THEN
          v_changes := v_changes || jsonb_build_object('qty_ordered', jsonb_build_object('old', v_line_old.qty_ordered, 'new', v_qty_ordered));
        END IF;
        IF v_line_old.qty_fulfilled IS DISTINCT FROM v_qty_fulfilled THEN
          v_changes := v_changes || jsonb_build_object('qty_fulfilled', jsonb_build_object('old', v_line_old.qty_fulfilled, 'new', v_qty_fulfilled));
        END IF;
        IF v_line_old.qty_to_fulfill IS DISTINCT FROM v_qty_to_fulfill THEN
          v_changes := v_changes || jsonb_build_object('qty_to_fulfill', jsonb_build_object('old', v_line_old.qty_to_fulfill, 'new', v_qty_to_fulfill));
        END IF;
        IF v_line_old.status_id IS DISTINCT FROM v_lstatus THEN
          v_changes := v_changes || jsonb_build_object('status_id', jsonb_build_object('old', v_line_old.status_id, 'new', v_lstatus));
        END IF;
        IF v_line_old.effective_due_date IS DISTINCT FROM v_eff THEN
          v_changes := v_changes || jsonb_build_object('effective_due_date', jsonb_build_object('old', v_line_old.effective_due_date, 'new', v_eff));
        END IF;
        IF v_line_old.product_num IS DISTINCT FROM v_product_num THEN
          v_changes := v_changes || jsonb_build_object('product_num', jsonb_build_object('old', v_line_old.product_num, 'new', v_product_num));
        END IF;
        IF v_line_old.removed_at IS NOT NULL THEN
          v_changes := v_changes || jsonb_build_object('reappeared', jsonb_build_object('old', true, 'new', false));
        END IF;

        UPDATE public.fb_sales_order_lines SET
          line_number = COALESCE((v_l->>'soLineItem')::integer, line_number),
          type_id = v_type,
          status_id = v_lstatus,
          product_num = v_product_num,
          part_num = v_part_num,
          fb_product_id = NULLIF(v_l->>'productId', '')::integer,
          fb_part_id = NULLIF(v_l->>'fbPartId', '')::integer,
          fb_part_type_id = NULLIF(v_l->>'partTypeId', '')::smallint,
          description = v_l->>'description',
          qty_ordered = v_qty_ordered,
          qty_fulfilled = v_qty_fulfilled,
          qty_picked = NULLIF(v_l->>'qtyPicked', '')::numeric,
          qty_to_fulfill = v_qty_to_fulfill,
          uom_id = NULLIF(v_l->>'uomId', '')::integer,
          unit_price = NULLIF(v_l->>'unitPrice', '')::numeric,
          total_price = NULLIF(v_l->>'totalPrice', '')::numeric,
          date_scheduled_fulfillment = v_dsf,
          remaining_parts_ship_date = v_rpsd,
          effective_due_date = v_eff,
          due_date_is_default = v_default,
          rev_level = v_l->>'revLevel',
          customer_part_num = v_l->>'customerPartNum',
          note = v_l->>'note',
          custom_fields = v_l->'customFields',
          raw = v_l,
          fingerprint = v_lfp,
          last_rev = COALESCE(v_rev, last_rev),
          last_synced_at = now(),
          removed_at = NULL
        WHERE fb_soitem_id = v_line_id;
        c_lupd := c_lupd + 1;

        -- D-FB-14 / D-FB-15: propagate to the linked CO line
        v_ack := false;
        IF v_line_old.customer_order_line_id IS NOT NULL THEN
          SELECT id, status, quantity_ordered, quantity_fulfilled, due_date INTO v_col
            FROM public.customer_order_lines WHERE id = v_line_old.customer_order_line_id;
          IF FOUND THEN
            UPDATE public.customer_order_lines
               SET fb_qty_ordered = v_qty_ordered, fb_qty_fulfilled = v_qty_fulfilled, fb_qty_to_fulfill = v_qty_to_fulfill
             WHERE id = v_col.id;
            IF v_col.status IN ('not_started', 'in_progress') THEN
              IF v_changes ? 'qty_ordered' THEN
                v_delta := v_qty_ordered - v_line_old.qty_ordered;
                SELECT COALESCE(SUM(quantity_allocated), 0) INTO v_alloc
                  FROM public.customer_order_allocations
                 WHERE customer_order_line_id = v_col.id AND is_active;
                IF v_delta > 0
                   OR ((v_col.quantity_ordered + v_delta) >= (v_alloc + v_col.quantity_fulfilled)
                       AND (v_col.quantity_ordered + v_delta) > 0) THEN
                  UPDATE public.customer_order_lines
                     SET quantity_ordered = quantity_ordered + round(v_delta)::integer
                   WHERE id = v_col.id;
                ELSE
                  v_ack := true;
                END IF;
              END IF;
              IF v_changes ? 'effective_due_date' AND v_eff IS NOT NULL THEN
                UPDATE public.customer_order_lines SET due_date = v_eff WHERE id = v_col.id;
              END IF;
              IF v_lstatus IN (70, 75) THEN
                v_ack := true;
              END IF;
            END IF;
          END IF;
        END IF;

        IF v_emit AND v_changes <> '{}'::jsonb THEN
          INSERT INTO public.fb_sync_events (fb_so_id, fb_soitem_id, event_type, changes, fb_rev, fb_modified_user_id, fb_username, fb_timestamp, affects_co, requires_ack)
          VALUES (v_so_id, v_line_id,
                  CASE WHEN v_changes ? 'status_id' THEN 'line_status_changed' ELSE 'line_changed' END,
                  v_changes, v_rev, v_rev_user, v_rev_username, v_rev_ts,
                  v_line_old.customer_order_line_id IS NOT NULL, v_ack);
          c_ev := c_ev + 1;
        END IF;

      ELSE
        UPDATE public.fb_sales_order_lines
           SET last_rev = COALESCE(v_rev, last_rev), last_synced_at = now()
         WHERE fb_soitem_id = v_line_id;
      END IF;
    END LOOP;

    -- D-FB-05: lines no longer on the SO
    IF COALESCE((v_order->>'complete')::boolean, true) THEN
      FOR v_line_old IN
        SELECT * FROM public.fb_sales_order_lines
         WHERE fb_so_id = v_so_id AND removed_at IS NULL AND NOT (fb_soitem_id = ANY (v_ids))
      LOOP
        UPDATE public.fb_sales_order_lines
           SET removed_at = now(), last_rev = COALESCE(v_rev, last_rev), last_synced_at = now()
         WHERE fb_soitem_id = v_line_old.fb_soitem_id;
        c_lrem := c_lrem + 1;
        IF v_emit THEN
          v_ack := false;
          IF v_line_old.customer_order_line_id IS NOT NULL THEN
            SELECT (status IN ('not_started', 'in_progress')) INTO v_ack
              FROM public.customer_order_lines WHERE id = v_line_old.customer_order_line_id;
          END IF;
          INSERT INTO public.fb_sync_events (fb_so_id, fb_soitem_id, event_type, changes, fb_rev, fb_modified_user_id, fb_username, fb_timestamp, affects_co, requires_ack)
          VALUES (v_so_id, v_line_old.fb_soitem_id, 'line_removed',
                  jsonb_build_object('product_num', v_line_old.product_num, 'qty_ordered', v_line_old.qty_ordered),
                  v_rev, v_rev_user, v_rev_username, v_rev_ts,
                  v_line_old.customer_order_line_id IS NOT NULL, COALESCE(v_ack, false));
          c_ev := c_ev + 1;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- SOs that no longer exist in Fishbowl
  FOR v_removed_id IN
    SELECT value::integer FROM jsonb_array_elements_text(COALESCE(p_payload->'removed_ids', '[]'::jsonb))
  LOOP
    SELECT * INTO v_old FROM public.fb_sales_orders WHERE fb_so_id = v_removed_id AND removed_at IS NULL FOR UPDATE;
    IF FOUND THEN
      UPDATE public.fb_sales_orders SET removed_at = now(), last_synced_at = now() WHERE fb_so_id = v_removed_id;
      c_gone := c_gone + 1;
      IF v_emit THEN
        INSERT INTO public.fb_sync_events (fb_so_id, event_type, changes, affects_co, requires_ack)
        VALUES (v_removed_id, 'so_removed', jsonb_build_object('so_number', v_old.so_number),
                v_old.customer_order_id IS NOT NULL, v_old.customer_order_id IS NOT NULL);
        c_ev := c_ev + 1;
      END IF;
    END IF;
  END LOOP;

  -- cursor / state
  IF v_source = 'tail' AND v_rev_to IS NOT NULL THEN
    UPDATE public.fb_sync_state
       SET last_rev = GREATEST(last_rev, v_rev_to), last_rev_at = now(), updated_at = now()
     WHERE id = 1;
  ELSIF v_source = 'reconcile' THEN
    UPDATE public.fb_sync_state SET last_reconcile_at = now(), updated_at = now() WHERE id = 1;
  ELSIF v_source = 'backfill' THEN
    UPDATE public.fb_sync_state SET last_backfill_at = now(), updated_at = now() WHERE id = 1;
  END IF;

  RETURN jsonb_build_object(
    'orders_inserted', c_ins, 'orders_updated', c_upd, 'orders_unchanged', c_same, 'orders_skipped', c_skip,
    'orders_removed', c_gone, 'lines_inserted', c_lins, 'lines_updated', c_lupd, 'lines_removed', c_lrem, 'events', c_ev);
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Link the COs created by hand before the bridge (one-shot, re-runnable)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_link_existing_cos()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r       record;
  l       record;
  cand    record;
  v_n     integer;
  v_linked_orders integer := 0;
  v_linked_lines  integer := 0;
  v_ambiguous jsonb := '[]'::jsonb;
  v_unmatched jsonb := '[]'::jsonb;
  v_unlinked  jsonb := '[]'::jsonb;
BEGIN
  PERFORM public._fb_gate(ARRAY['integration', 'admin']);

  FOR r IN
    SELECT co.id, co.co_number, co.fishbowl_order_id,
           (SELECT s.fb_so_id FROM public.fb_sales_orders s
             WHERE s.removed_at IS NULL
               AND upper(regexp_replace(s.so_number, '[^A-Za-z0-9]', '', 'g'))
                 = upper(regexp_replace(co.fishbowl_order_id, '[^A-Za-z0-9]', '', 'g'))
             ORDER BY s.fb_so_id DESC LIMIT 1) AS fb_so_id
      FROM public.customer_orders co
     WHERE co.status IN ('not_started', 'in_progress') AND co.fishbowl_order_id IS NOT NULL
     ORDER BY co.co_number
  LOOP
    IF r.fb_so_id IS NULL THEN
      v_unmatched := v_unmatched || jsonb_build_object('co_number', r.co_number, 'fishbowl_order_id', r.fishbowl_order_id);
      CONTINUE;
    END IF;

    UPDATE public.fb_sales_orders SET customer_order_id = r.id
     WHERE fb_so_id = r.fb_so_id AND customer_order_id IS NULL;
    IF FOUND THEN
      v_linked_orders := v_linked_orders + 1;
    END IF;

    FOR l IN
      SELECT id, line_number, part_id, quantity_ordered
        FROM public.customer_order_lines
       WHERE customer_order_id = r.id AND status IN ('not_started', 'in_progress')
       ORDER BY line_number
    LOOP
      IF EXISTS (SELECT 1 FROM public.fb_sales_order_lines WHERE customer_order_line_id = l.id) THEN
        CONTINUE;
      END IF;
      SELECT count(*) INTO v_n
        FROM public.fb_sales_order_lines f
       WHERE f.fb_so_id = r.fb_so_id AND f.removed_at IS NULL AND f.customer_order_line_id IS NULL
         AND f.part_id = l.part_id AND f.type_id IN (10, 12);
      IF v_n = 0 THEN
        v_unlinked := v_unlinked || jsonb_build_object('co_number', r.co_number, 'line_number', l.line_number);
        CONTINUE;
      END IF;
      SELECT f.fb_soitem_id, f.qty_ordered, f.qty_fulfilled, f.qty_to_fulfill INTO cand
        FROM public.fb_sales_order_lines f
       WHERE f.fb_so_id = r.fb_so_id AND f.removed_at IS NULL AND f.customer_order_line_id IS NULL
         AND f.part_id = l.part_id AND f.type_id IN (10, 12)
       ORDER BY (f.qty_ordered = l.quantity_ordered) DESC, f.line_number
       LIMIT 1;
      UPDATE public.fb_sales_order_lines
         SET customer_order_line_id = l.id, disposition = 'production', disposition_at = now(),
             disposition_note = 'Linked to existing CO by fb_link_existing_cos'
       WHERE fb_soitem_id = cand.fb_soitem_id;
      UPDATE public.customer_order_lines
         SET fb_qty_ordered = cand.qty_ordered, fb_qty_fulfilled = cand.qty_fulfilled, fb_qty_to_fulfill = cand.qty_to_fulfill
       WHERE id = l.id;
      v_linked_lines := v_linked_lines + 1;
      IF v_n > 1 THEN
        v_ambiguous := v_ambiguous || jsonb_build_object('co_number', r.co_number, 'line_number', l.line_number,
                                                         'candidates', v_n, 'picked_fb_soitem_id', cand.fb_soitem_id);
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'linked_orders', v_linked_orders, 'linked_lines', v_linked_lines,
    'ambiguous', v_ambiguous, 'unmatched_open_cos', v_unmatched, 'co_lines_without_fb_line', v_unlinked);
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants on RPCs
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fb_get_cursor()            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fb_set_cursor(bigint)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fb_heartbeat(jsonb)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fb_ingest_delta(jsonb)     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fb_link_existing_cos()     FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fb_get_cursor()         TO authenticated;
GRANT EXECUTE ON FUNCTION public.fb_set_cursor(bigint)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.fb_heartbeat(jsonb)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.fb_ingest_delta(jsonb)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fb_link_existing_cos()  TO authenticated;

-- ---------------------------------------------------------------------------
-- 10. Queue view (SO-level rollup for the Order Queue page)
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_fb_order_queue;
CREATE VIEW public.v_fb_order_queue WITH (security_invoker = true) AS
SELECT s.fb_so_id, s.so_number, s.fb_customer_id, s.customer_id, s.customer_name, s.customer_po,
       s.status_id, s.priority_id, s.salesman, s.location_group_id,
       s.fb_date_created, s.fb_date_issued, s.fb_date_last_modified, s.last_synced_at,
       s.customer_order_id, co.co_number AS linked_co_number,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL)                                   AS line_count,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'pending')     AS pending_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'production')  AS production_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'stock')       AS stock_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'purchased')   AS purchased_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition = 'unlisted')    AS unlisted_lines,
       count(l.fb_soitem_id) FILTER (WHERE l.removed_at IS NULL AND l.disposition IN ('ignore','kit_header')) AS ignored_lines,
       min(l.effective_due_date) FILTER (WHERE l.removed_at IS NULL AND l.type_id IN (10, 12))     AS earliest_due,
       COALESCE(bool_or(l.due_date_is_default) FILTER (WHERE l.removed_at IS NULL AND l.type_id IN (10, 12)), false) AS has_default_dates,
       (SELECT count(*) FROM public.fb_sync_events e
         WHERE e.fb_so_id = s.fb_so_id AND e.requires_ack AND e.acknowledged_at IS NULL)          AS open_exceptions
  FROM public.fb_sales_orders s
  LEFT JOIN public.customer_orders co ON co.id = s.customer_order_id
  LEFT JOIN public.fb_sales_order_lines l ON l.fb_so_id = s.fb_so_id
 WHERE s.removed_at IS NULL
 GROUP BY s.fb_so_id, co.co_number;

GRANT SELECT ON public.v_fb_order_queue TO authenticated;
REVOKE ALL ON public.v_fb_order_queue FROM anon;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification (last result set)
-- ---------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'fb\_%')                       AS fb_tables,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'fb\_%')                     AS fb_policies,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('_fb_gate','fb_get_cursor','fb_set_cursor','fb_heartbeat','fb_ingest_delta','fb_link_existing_cos')) AS fb_functions,
  (SELECT pg_get_constraintdef(oid) LIKE '%integration%'
     FROM pg_constraint WHERE conname = 'profiles_role_check')                                                  AS roles_ok,
  (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.profiles'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%machinist%')                                                          AS role_checks,
  (SELECT count(*) FROM information_schema.columns WHERE table_name = 'customer_order_lines'
     AND column_name IN ('fb_qty_ordered','fb_qty_fulfilled','fb_qty_to_fulfill'))                              AS co_line_cols,
  (SELECT last_rev FROM public.fb_sync_state WHERE id = 1)                                                      AS last_rev;
-- Expected: fb_tables 6 · fb_policies 6 · fb_functions 6 · roles_ok true · role_checks 1 · co_line_cols 3 · last_rev 0
