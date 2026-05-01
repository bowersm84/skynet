-- ============================================================================
-- Sprint 5 Batch A: Customer Orders & Demand Pool — Schema
-- TEST environment only. DO NOT run on prod until validated.
-- ============================================================================

-- 1. Customers master
CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id text UNIQUE NOT NULL,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_customer_id_format CHECK (customer_id ~ '^[0-9]{1,6}$')
);
CREATE INDEX idx_customers_active ON public.customers(is_active) WHERE is_active;
CREATE INDEX idx_customers_name_lower ON public.customers(lower(name));

-- 2. Customer Orders (header)
CREATE TABLE public.customer_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  co_number text UNIQUE NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  fishbowl_order_id text NOT NULL,
  po_number text,
  notes text,
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started','in_progress','complete','cancelled')),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES public.profiles(id),
  cancel_reason text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_orders_customer ON public.customer_orders(customer_id);
CREATE INDEX idx_customer_orders_status ON public.customer_orders(status);
CREATE INDEX idx_customer_orders_fishbowl ON public.customer_orders(fishbowl_order_id);

-- 3. Customer Order Lines (children)
CREATE TABLE public.customer_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_order_id uuid NOT NULL REFERENCES public.customer_orders(id) ON DELETE CASCADE,
  line_number integer NOT NULL,
  part_id uuid NOT NULL REFERENCES public.parts(id),
  quantity_ordered integer NOT NULL CHECK (quantity_ordered > 0),
  quantity_fulfilled integer NOT NULL DEFAULT 0 CHECK (quantity_fulfilled >= 0),
  due_date date,
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('critical','high','normal','low')),
  notes text,
  status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started','in_progress','complete','cancelled')),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES public.profiles(id),
  cancel_reason text,
  fulfilled_at timestamptz,
  fulfilled_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_order_id, line_number)
);
CREATE INDEX idx_co_lines_part_open ON public.customer_order_lines(part_id, status)
  WHERE status IN ('not_started','in_progress');
CREATE INDEX idx_co_lines_co ON public.customer_order_lines(customer_order_id);

-- 4. Allocations (line ↔ WO junction)
CREATE TABLE public.customer_order_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_order_line_id uuid NOT NULL REFERENCES public.customer_order_lines(id),
  work_order_id uuid NOT NULL REFERENCES public.work_orders(id),
  quantity_allocated integer NOT NULL CHECK (quantity_allocated > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  deactivated_by uuid REFERENCES public.profiles(id)
);
CREATE INDEX idx_co_alloc_line_active ON public.customer_order_allocations(customer_order_line_id) WHERE is_active;
CREATE INDEX idx_co_alloc_wo_active ON public.customer_order_allocations(work_order_id) WHERE is_active;
CREATE UNIQUE INDEX uq_co_alloc_active_pair ON public.customer_order_allocations(customer_order_line_id, work_order_id) WHERE is_active;

-- 5. Work order additions
ALTER TABLE public.work_orders
  ADD COLUMN is_combined boolean NOT NULL DEFAULT false,
  ADD COLUMN has_cancelled_allocation boolean NOT NULL DEFAULT false;

-- 6. Status rollup function — line level
CREATE OR REPLACE FUNCTION public.recalc_co_line_status(line_id uuid)
RETURNS void AS $$
DECLARE
  v_ordered integer;
  v_fulfilled integer;
  v_active_alloc integer;
  v_current_status text;
BEGIN
  SELECT quantity_ordered, quantity_fulfilled, status
    INTO v_ordered, v_fulfilled, v_current_status
    FROM public.customer_order_lines WHERE id = line_id;

  IF v_current_status = 'cancelled' THEN RETURN; END IF;

  SELECT COALESCE(SUM(quantity_allocated), 0)
    INTO v_active_alloc
    FROM public.customer_order_allocations
    WHERE customer_order_line_id = line_id AND is_active;

  UPDATE public.customer_order_lines
    SET status = CASE
      WHEN v_fulfilled >= v_ordered THEN 'complete'
      WHEN v_active_alloc > 0 OR v_fulfilled > 0 THEN 'in_progress'
      ELSE 'not_started'
    END,
    updated_at = now()
  WHERE id = line_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. Status rollup function — parent
CREATE OR REPLACE FUNCTION public.recalc_co_status(co_id uuid)
RETURNS void AS $$
DECLARE
  v_total integer;
  v_complete integer;
  v_cancelled integer;
  v_in_progress integer;
  v_current_status text;
BEGIN
  SELECT status INTO v_current_status FROM public.customer_orders WHERE id = co_id;
  IF v_current_status = 'cancelled' THEN RETURN; END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'complete'),
    COUNT(*) FILTER (WHERE status = 'cancelled'),
    COUNT(*) FILTER (WHERE status = 'in_progress')
  INTO v_total, v_complete, v_cancelled, v_in_progress
  FROM public.customer_order_lines WHERE customer_order_id = co_id;

  UPDATE public.customer_orders
    SET status = CASE
      WHEN v_total = 0 THEN 'not_started'
      WHEN v_complete + v_cancelled = v_total AND v_complete > 0 THEN 'complete'
      WHEN v_cancelled = v_total THEN 'cancelled'
      WHEN v_in_progress > 0 OR v_complete > 0 THEN 'in_progress'
      ELSE 'not_started'
    END,
    updated_at = now()
  WHERE id = co_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8. Triggers
CREATE OR REPLACE FUNCTION public.trg_alloc_recalc()
RETURNS trigger AS $$
DECLARE
  v_line uuid;
  v_co uuid;
BEGIN
  v_line := COALESCE(NEW.customer_order_line_id, OLD.customer_order_line_id);
  PERFORM public.recalc_co_line_status(v_line);
  SELECT customer_order_id INTO v_co FROM public.customer_order_lines WHERE id = v_line;
  PERFORM public.recalc_co_status(v_co);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_alloc_aiud
  AFTER INSERT OR UPDATE OR DELETE ON public.customer_order_allocations
  FOR EACH ROW EXECUTE FUNCTION public.trg_alloc_recalc();

CREATE OR REPLACE FUNCTION public.trg_line_recalc_parent()
RETURNS trigger AS $$
BEGIN
  PERFORM public.recalc_co_status(NEW.customer_order_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_line_au
  AFTER UPDATE OF status, quantity_fulfilled ON public.customer_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.trg_line_recalc_parent();

-- 9. updated_at maintenance (reuse existing function if present, else create)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    CREATE OR REPLACE FUNCTION public.set_updated_at()
    RETURNS trigger AS 'BEGIN NEW.updated_at = now(); RETURN NEW; END;'
    LANGUAGE plpgsql;
  END IF;
END $$;

CREATE TRIGGER trg_customers_uat BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_co_uat BEFORE UPDATE ON public.customer_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_co_lines_uat BEFORE UPDATE ON public.customer_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 10. RLS
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_order_allocations ENABLE ROW LEVEL SECURITY;

-- SELECT for everyone (kiosks need it for traveler)
CREATE POLICY customers_select ON public.customers FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY co_select ON public.customer_orders FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY co_lines_select ON public.customer_order_lines FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY co_alloc_select ON public.customer_order_allocations FOR SELECT TO authenticated, anon USING (true);

-- INSERT/UPDATE/DELETE — split per cmd so the RLS audit query finds them
CREATE POLICY customers_insert ON public.customers FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')));
CREATE POLICY customers_update ON public.customers FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')));
CREATE POLICY customers_delete ON public.customers FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')));

CREATE POLICY co_insert ON public.customer_orders FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')));
CREATE POLICY co_update ON public.customer_orders FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')));
CREATE POLICY co_delete ON public.customer_orders FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')));

CREATE POLICY co_lines_insert ON public.customer_order_lines FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')));
CREATE POLICY co_lines_update ON public.customer_order_lines FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')));
CREATE POLICY co_lines_delete ON public.customer_order_lines FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')));

CREATE POLICY co_alloc_insert ON public.customer_order_allocations FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')));
CREATE POLICY co_alloc_update ON public.customer_order_allocations FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')));
CREATE POLICY co_alloc_delete ON public.customer_order_allocations FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','scheduler','customer_service')));

-- 11. Verification
SELECT 'customers' AS tbl, count(*) FROM public.customers
UNION ALL SELECT 'customer_orders', count(*) FROM public.customer_orders
UNION ALL SELECT 'customer_order_lines', count(*) FROM public.customer_order_lines
UNION ALL SELECT 'customer_order_allocations', count(*) FROM public.customer_order_allocations;

SELECT tablename, polcmd, count(*) FROM pg_policies
  WHERE schemaname='public'
    AND tablename IN ('customers','customer_orders','customer_order_lines','customer_order_allocations')
  GROUP BY 1,2 ORDER BY 1,2;