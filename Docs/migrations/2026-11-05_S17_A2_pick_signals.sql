-- ============================================================================
-- S17 Batch A2 — Fishbowl pick signals drive Order Queue dispositions
-- 2026-11-05  ·  D-ASM-06, D-ASM-26  ·  web + SQL (no bridge change)
--
-- Applied on TEST by Claude on 2026-11-04 (migrations s17_a2_pick_signals,
-- s17_a2_pick_signals_pending_reapply, s17_a2_pending_reeval_trigger); this
-- file is the PROD copy, run before the A2 deploy. Idempotent.
--
-- What it does: every time the bridge upserts fb_pick_items, the affected SO
-- lines are re-evaluated from v_fb_line_pick_state (A1) and, where Ashley's
-- flag says so, the line's disposition is set — without ever overriding a
-- disposition a person set by hand (D-FB-18 ownership split).
--
--   signal      → disposition          when
--   assembly    → assembly             line is pending, or was last set by Fishbowl
--   purchasing  → purchased            same; components = the whole part (note says so)
--   reserved    → stock                same (Committed in Fishbowl = reserved to ship)
--   picked      → stock                same (Finished)
--   production  → (unchanged)          flag only; the "Needs CO" worklist reads it
--   held        → (unchanged)          flag only (destination still Shipping)
-- A line a person resets to pending is re-evaluated at once, even if the pick
-- signal has not changed (TEST override test, Nov 4).
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Columns on the line mirror
-- ---------------------------------------------------------------------------
ALTER TABLE public.fb_sales_order_lines
  ADD COLUMN IF NOT EXISTS fb_pick_signal      text,
  ADD COLUMN IF NOT EXISTS fb_pick_num         text,
  ADD COLUMN IF NOT EXISTS fb_pick_dest        text,
  ADD COLUMN IF NOT EXISTS fb_pick_status      text,
  ADD COLUMN IF NOT EXISTS fb_pick_signal_at   timestamptz,
  ADD COLUMN IF NOT EXISTS disposition_source  text;

DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fb_sales_order_lines_disposition_source_check') THEN
    ALTER TABLE public.fb_sales_order_lines
      ADD CONSTRAINT fb_sales_order_lines_disposition_source_check
      CHECK (disposition_source IS NULL OR disposition_source IN ('human', 'fishbowl', 'system'));
  END IF;
END
$chk$;

COMMENT ON COLUMN public.fb_sales_order_lines.fb_pick_signal IS
  'Latest v_fb_line_pick_state.signal for the line: assembly / production / purchasing / held / reserved / picked / started / entered (D-ASM-06).';
COMMENT ON COLUMN public.fb_sales_order_lines.disposition_source IS
  'Who set the current disposition: human (Order Queue), fishbowl (pick signal), system (Create CO and other code paths). NULL = set before A2.';

CREATE INDEX IF NOT EXISTS fb_sales_order_lines_pick_signal_idx
  ON public.fb_sales_order_lines (fb_pick_signal) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. The apply function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_apply_pick_signals(p_soitem_ids integer[] DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r        record;
  n        integer := 0;
  new_disp text;
BEGIN
  FOR r IN
    SELECT l.fb_soitem_id, l.disposition, l.disposition_source, l.disposition_by, l.customer_order_line_id,
           p.signal, p.dest_location, p.pick_status, p.pick_num, p.pick_last_modified
    FROM public.fb_sales_order_lines l
    JOIN public.fb_sales_orders so ON so.fb_so_id = l.fb_so_id
    JOIN public.v_fb_line_pick_state p ON p.fb_soitem_id = l.fb_soitem_id
    WHERE l.removed_at IS NULL
      AND so.removed_at IS NULL
      AND so.status_id IN (20, 25)
      AND (p_soitem_ids IS NULL OR l.fb_soitem_id = ANY(p_soitem_ids))
      AND (l.fb_pick_signal IS DISTINCT FROM p.signal
           OR l.fb_pick_num IS DISTINCT FROM p.pick_num
           OR l.fb_pick_dest IS DISTINCT FROM p.dest_location
           OR l.fb_pick_status IS DISTINCT FROM p.pick_status
           OR (l.disposition = 'pending' AND p.signal IN ('assembly', 'purchasing', 'reserved', 'picked')))
  LOOP
    -- Always record the flag.
    UPDATE public.fb_sales_order_lines
       SET fb_pick_signal = r.signal, fb_pick_num = r.pick_num, fb_pick_dest = r.dest_location,
           fb_pick_status = r.pick_status, fb_pick_signal_at = now()
     WHERE fb_soitem_id = r.fb_soitem_id;
    n := n + 1;

    -- Decide whether the disposition moves.
    new_disp := CASE r.signal
                  WHEN 'assembly'   THEN 'assembly'
                  WHEN 'purchasing' THEN 'purchased'
                  WHEN 'reserved'   THEN 'stock'
                  WHEN 'picked'     THEN 'stock'
                  ELSE NULL
                END;

    CONTINUE WHEN new_disp IS NULL;
    CONTINUE WHEN r.customer_order_line_id IS NOT NULL;                       -- production path owns it
    CONTINUE WHEN r.disposition IN ('production', 'covered', 'kit_header', 'unlisted', 'ignore');
    CONTINUE WHEN r.disposition = new_disp;
    -- Never override a person: only a pending line, or one Fishbowl itself set last, may move.
    CONTINUE WHEN NOT (r.disposition = 'pending' OR r.disposition_source = 'fishbowl');

    UPDATE public.fb_sales_order_lines
       SET disposition        = new_disp,
           disposition_at     = now(),
           disposition_by     = NULL,
           disposition_source = 'fishbowl',
           disposition_note   = format('Fishbowl pick %s: %s%s', COALESCE(r.pick_num, '?'),
                                       COALESCE(r.pick_status, r.signal),
                                       CASE WHEN r.dest_location IS NOT NULL THEN ' → ' || r.dest_location ELSE '' END)
                                || CASE WHEN new_disp = 'purchased' THEN ' (components: whole part — edit in Purchase Components if needed)' ELSE '' END
     WHERE fb_soitem_id = r.fb_soitem_id;
  END LOOP;

  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.fb_apply_pick_signals(integer[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fb_apply_pick_signals(integer[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.fb_apply_pick_signals(integer[]) TO authenticated, service_role;
COMMENT ON FUNCTION public.fb_apply_pick_signals(integer[]) IS
  'D-ASM-06/26: records the latest pick signal on each open SO line and moves pending (or Fishbowl-set) dispositions per the signal. NULL = all open lines. Returns lines touched.';

-- ---------------------------------------------------------------------------
-- 3. Statement triggers on fb_pick_items (one per event — Postgres does not
--    allow a transition table on a multi-event trigger)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_pick_items_signal_trg()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE ids integer[];
BEGIN
  SELECT array_agg(DISTINCT fb_soitem_id) INTO ids FROM new_rows WHERE fb_soitem_id IS NOT NULL;
  IF ids IS NOT NULL THEN
    PERFORM public.fb_apply_pick_signals(ids);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS fb_pick_items_signal_ins ON public.fb_pick_items;
CREATE TRIGGER fb_pick_items_signal_ins
  AFTER INSERT ON public.fb_pick_items
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.fb_pick_items_signal_trg();

DROP TRIGGER IF EXISTS fb_pick_items_signal_upd ON public.fb_pick_items;
CREATE TRIGGER fb_pick_items_signal_upd
  AFTER UPDATE ON public.fb_pick_items
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.fb_pick_items_signal_trg();

-- ---------------------------------------------------------------------------
-- 4. Human dispositions get a source from now on
-- ---------------------------------------------------------------------------
-- fb_set_disposition was patched in place (D-FB-50); it is NOT redefined here.
-- A row trigger stamps the source instead: a disposition change made with a
-- profile id is 'human'; one made with no profile and no fishbowl stamp is 'system'.
CREATE OR REPLACE FUNCTION public.fb_sales_order_lines_source_trg()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.disposition IS DISTINCT FROM OLD.disposition
     AND NEW.disposition_source IS NOT DISTINCT FROM OLD.disposition_source THEN
    NEW.disposition_source := CASE WHEN NEW.disposition_by IS NOT NULL THEN 'human' ELSE 'system' END;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS fb_sales_order_lines_source ON public.fb_sales_order_lines;
CREATE TRIGGER fb_sales_order_lines_source
  BEFORE UPDATE OF disposition ON public.fb_sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.fb_sales_order_lines_source_trg();

-- ---------------------------------------------------------------------------
-- 4b. Any path that resets a line to pending re-evaluates it at once
--     (AFTER ROW; the function's own update re-fires with a non-pending
--     disposition and stops — no recursion). Applied on TEST Nov 4.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fb_sales_order_lines_pending_trg()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.disposition = 'pending' AND OLD.disposition IS DISTINCT FROM 'pending' THEN
    PERFORM public.fb_apply_pick_signals(ARRAY[NEW.fb_soitem_id]);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS fb_sales_order_lines_pending_reeval ON public.fb_sales_order_lines;
CREATE TRIGGER fb_sales_order_lines_pending_reeval
  AFTER UPDATE OF disposition ON public.fb_sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.fb_sales_order_lines_pending_trg();

-- ---------------------------------------------------------------------------
-- 5. Backfill every open line from the mirror as it stands
-- ---------------------------------------------------------------------------
SELECT public.fb_apply_pick_signals(NULL) AS lines_touched;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
-- SELECT fb_pick_signal, disposition, disposition_source, COUNT(*)
-- FROM fb_sales_order_lines WHERE removed_at IS NULL AND fb_pick_signal IS NOT NULL
-- GROUP BY 1, 2, 3 ORDER BY 1, 2;
--   expect: assembly rows → disposition assembly/fishbowl (unless a human had set the line);
--           purchasing → purchased/fishbowl; reserved/picked → stock/fishbowl; production/held → unchanged
-- SELECT so_number, line_number, product_num, fb_pick_signal, fb_pick_dest, disposition, disposition_note
-- FROM fb_sales_order_lines WHERE fb_pick_signal IN ('assembly','production','purchasing') AND removed_at IS NULL
-- ORDER BY so_number, line_number;
