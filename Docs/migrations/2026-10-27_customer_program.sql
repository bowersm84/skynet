/* ===================================================================================== */
/* 2026-10-27_customer_program.sql — S16 Batch A, Customer Program Dashboard (D-CPROG) */
/* Schema only. The Kaytech rows are in 2026-10-27_customer_program_kaytech_seed.sql. */
/* */
/* Parallel to the Giza program tables, not inside them (D-CPROG-01a): programs carries */
/* NOT NULL product columns, every signed-in user can read it, and the Giza views and RPCs */
/* read every row. Customer programs carry money and the email trail, so they get their own */
/* roster-gated tables. */
/* */
/* Every new table: RLS on in this file (D-S7-08 / D-PRICE-71). Reads = roster members only */
/* (customer_program_access). Writes: moves and lot checks = can_log_moves; money, line */
/* tracking and quotes = can_enter_money. Voids go through SECURITY DEFINER RPCs. */
/* Views are security_invoker, so a non-member reads zero rows through them too. */
/* Run order: TEST (applied by Claude) → verify → PROD (Matt, this same file). */
/* ===================================================================================== */
BEGIN;

/* ---------------------------------------------------------------- programs + roster */
CREATE TABLE public.customer_programs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text NOT NULL UNIQUE,
  name                 text NOT NULL,
  fb_customer_id       integer NOT NULL,
  credit_limit         numeric(12,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  deposit_pct          numeric(5,4)  NOT NULL DEFAULT 0.30 CHECK (deposit_pct >= 0 AND deposit_pct <= 1),
  past_due_grace_days  integer NOT NULL DEFAULT 30 CHECK (past_due_grace_days >= 0),
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.customer_program_access (
  program_id       uuid NOT NULL REFERENCES public.customer_programs(id),
  profile_id       uuid NOT NULL REFERENCES public.profiles(id),
  can_log_moves    boolean NOT NULL DEFAULT false,
  can_enter_money  boolean NOT NULL DEFAULT false,
  added_by         uuid REFERENCES public.profiles(id),
  added_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, profile_id)
);

/* SECURITY DEFINER so policies on the roster itself do not recurse. */
CREATE FUNCTION public.cp_is_member(p_program uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.customer_program_access a
                  WHERE a.program_id = p_program AND a.profile_id = auth.uid());
$$;

CREATE FUNCTION public.cp_can(p_program uuid, p_what text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.customer_program_access a
                  WHERE a.program_id = p_program AND a.profile_id = auth.uid()
                    AND CASE p_what WHEN 'moves' THEN a.can_log_moves
                                    WHEN 'money' THEN a.can_enter_money
                                    ELSE false END);
$$;

/* ---------------------------------------------------------------- per-line tracking */
CREATE TABLE public.cp_line_tracking (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id         uuid NOT NULL REFERENCES public.customer_programs(id),
  fb_soitem_id       integer NOT NULL,
  flow               text NOT NULL CHECK (flow IN ('build','stock','buyin')),
  terms              text NOT NULL CHECK (terms IN ('deposit','net30')),
  drawing_sent_on    date,
  drawing_signed_on  date,
  hold_note          text,
  notes              text,
  updated_by         uuid REFERENCES public.profiles(id) DEFAULT auth.uid(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, fb_soitem_id)
);

/* ---------------------------------------------------------------- quotes (no PO yet) */
CREATE TABLE public.cp_quotes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id         uuid NOT NULL REFERENCES public.customer_programs(id),
  rfq_number         text NOT NULL,
  part_num           text NOT NULL,
  description        text,
  qty                integer NOT NULL CHECK (qty > 0),
  unit_price         numeric(12,4) NOT NULL CHECK (unit_price >= 0),
  quoted_on          date NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost','withdrawn')),
  converted_so_number text,
  notes              text,
  updated_by         uuid REFERENCES public.profiles(id) DEFAULT auth.uid(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, rfq_number, part_num)
);

/* ---------------------------------------------------------------- money (append-only + void) */
/* deposit_request / invoice are amounts owed; payment / credit_memo reduce one of them via */
/* applies_to. source/qb_* are for the QuickBooks round; manual rows leave them null. */
CREATE TABLE public.cp_money (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id   uuid NOT NULL REFERENCES public.customer_programs(id),
  kind         text NOT NULL CHECK (kind IN ('deposit_request','invoice','payment','credit_memo')),
  amount       numeric(12,2) NOT NULL CHECK (amount > 0),
  po_number    text,
  so_number    text,
  reference    text,
  txn_date     date NOT NULL,
  due_date     date,
  applies_to   uuid REFERENCES public.cp_money(id),
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','quickbooks')),
  qb_txn_type  text,
  qb_txn_id    text,
  notes        text,
  entered_by   uuid REFERENCES public.profiles(id) DEFAULT auth.uid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  voided_at    timestamptz,
  voided_by    uuid REFERENCES public.profiles(id),
  void_reason  text,
  CHECK (applies_to IS NULL OR kind IN ('payment','credit_memo')),
  CHECK (source = 'manual' OR qb_txn_id IS NOT NULL),
  UNIQUE (program_id, qb_txn_type, qb_txn_id)
);

/* ---------------------------------------------------------------- lot moves (append-only + void) */
/* Each row moves qty of one lot from one stage to another. from_stage NULL = arrives (opening */
/* count, receipt); to_stage NULL = leaves the program's view. to_lot_number = relabel */
/* (e.g. 4142 → 4142R). Balance per lot and stage = moves in − moves out (cp_v_lot_balances). */
CREATE TABLE public.cp_moves (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id     uuid NOT NULL REFERENCES public.customer_programs(id),
  part_num       text NOT NULL,
  lot_number     text NOT NULL,
  to_lot_number  text,
  from_stage     text CHECK (from_stage IN ('rework','inspection','ready','quarantine','shipped','scrapped')),
  to_stage       text CHECK (to_stage   IN ('rework','inspection','ready','quarantine','shipped','scrapped')),
  qty            integer NOT NULL CHECK (qty > 0),
  po_number      text,
  entry_date     date NOT NULL DEFAULT current_date,
  done_by        text,
  notes          text,
  entered_by     uuid REFERENCES public.profiles(id) DEFAULT auth.uid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  voided_at      timestamptz,
  voided_by      uuid REFERENCES public.profiles(id),
  void_reason    text,
  CHECK (from_stage IS NOT NULL OR to_stage IS NOT NULL),
  CHECK (from_stage IS DISTINCT FROM to_stage OR to_lot_number IS NOT NULL)
);
CREATE INDEX cp_moves_program_lot ON public.cp_moves (program_id, part_num, lot_number);

/* ---------------------------------------------------------------- lot checks (stud length etc.) */
CREATE TABLE public.cp_lot_checks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id      uuid NOT NULL REFERENCES public.customer_programs(id),
  part_num        text NOT NULL,
  lot_number      text NOT NULL,
  check_kind      text NOT NULL CHECK (check_kind IN ('stud_length','visual','count','other')),
  measured_value  numeric(10,4),
  unit            text,
  result          text NOT NULL DEFAULT 'info' CHECK (result IN ('pass','fail','info')),
  checked_on      date NOT NULL DEFAULT current_date,
  done_by         text,
  notes           text,
  entered_by      uuid REFERENCES public.profiles(id) DEFAULT auth.uid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  voided_at       timestamptz,
  voided_by       uuid REFERENCES public.profiles(id),
  void_reason     text
);

/* ---------------------------------------------------------------- RLS */
ALTER TABLE public.customer_programs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_program_access  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cp_line_tracking         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cp_quotes                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cp_money                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cp_moves                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cp_lot_checks            ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.customer_programs, public.customer_program_access, public.cp_line_tracking,
              public.cp_quotes, public.cp_money, public.cp_moves, public.cp_lot_checks FROM anon;

CREATE POLICY cp_programs_select ON public.customer_programs        FOR SELECT TO authenticated USING (public.cp_is_member(id));
CREATE POLICY cp_access_select   ON public.customer_program_access  FOR SELECT TO authenticated USING (public.cp_is_member(program_id));

CREATE POLICY cp_tracking_select ON public.cp_line_tracking FOR SELECT TO authenticated USING (public.cp_is_member(program_id));
CREATE POLICY cp_tracking_insert ON public.cp_line_tracking FOR INSERT TO authenticated WITH CHECK (public.cp_can(program_id, 'money'));
CREATE POLICY cp_tracking_update ON public.cp_line_tracking FOR UPDATE TO authenticated
  USING (public.cp_can(program_id, 'money')) WITH CHECK (public.cp_can(program_id, 'money') AND updated_by = auth.uid());

CREATE POLICY cp_quotes_select ON public.cp_quotes FOR SELECT TO authenticated USING (public.cp_is_member(program_id));
CREATE POLICY cp_quotes_insert ON public.cp_quotes FOR INSERT TO authenticated WITH CHECK (public.cp_can(program_id, 'money'));
CREATE POLICY cp_quotes_update ON public.cp_quotes FOR UPDATE TO authenticated
  USING (public.cp_can(program_id, 'money')) WITH CHECK (public.cp_can(program_id, 'money') AND updated_by = auth.uid());

CREATE POLICY cp_money_select ON public.cp_money FOR SELECT TO authenticated USING (public.cp_is_member(program_id));
CREATE POLICY cp_money_insert ON public.cp_money FOR INSERT TO authenticated
  WITH CHECK (public.cp_can(program_id, 'money') AND entered_by = auth.uid() AND voided_at IS NULL AND source = 'manual');

CREATE POLICY cp_moves_select ON public.cp_moves FOR SELECT TO authenticated USING (public.cp_is_member(program_id));
CREATE POLICY cp_moves_insert ON public.cp_moves FOR INSERT TO authenticated
  WITH CHECK (public.cp_can(program_id, 'moves') AND entered_by = auth.uid() AND voided_at IS NULL);

CREATE POLICY cp_checks_select ON public.cp_lot_checks FOR SELECT TO authenticated USING (public.cp_is_member(program_id));
CREATE POLICY cp_checks_insert ON public.cp_lot_checks FOR INSERT TO authenticated
  WITH CHECK (public.cp_can(program_id, 'moves') AND entered_by = auth.uid() AND voided_at IS NULL);

/* ---------------------------------------------------------------- void RPCs */
CREATE FUNCTION public.cp_void(p_table text, p_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_program uuid;
  v_voided timestamptz;
  v_need text;
BEGIN
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'GUARD: a void reason is required'; END IF;
  IF p_table = 'cp_money' THEN
    v_need := 'money';
    v_program := (SELECT program_id FROM public.cp_money WHERE id = p_id);
    v_voided  := (SELECT voided_at  FROM public.cp_money WHERE id = p_id);
  ELSIF p_table = 'cp_moves' THEN
    v_need := 'moves';
    v_program := (SELECT program_id FROM public.cp_moves WHERE id = p_id);
    v_voided  := (SELECT voided_at  FROM public.cp_moves WHERE id = p_id);
  ELSIF p_table = 'cp_lot_checks' THEN
    v_need := 'moves';
    v_program := (SELECT program_id FROM public.cp_lot_checks WHERE id = p_id);
    v_voided  := (SELECT voided_at  FROM public.cp_lot_checks WHERE id = p_id);
  ELSE
    RAISE EXCEPTION 'GUARD: unknown table %', p_table;
  END IF;
  IF v_program IS NULL THEN RAISE EXCEPTION 'GUARD: row not found'; END IF;
  IF v_voided IS NOT NULL THEN RAISE EXCEPTION 'GUARD: already voided'; END IF;
  IF NOT public.cp_can(v_program, v_need) THEN
    RAISE EXCEPTION 'Not authorized for this program' USING ERRCODE = '42501';
  END IF;
  IF p_table = 'cp_money' THEN
    IF EXISTS (SELECT 1 FROM public.cp_money WHERE applies_to = p_id AND voided_at IS NULL) THEN
      RAISE EXCEPTION 'GUARD: void the payments or credits applied to this row first';
    END IF;
    UPDATE public.cp_money SET voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason) WHERE id = p_id;
  ELSIF p_table = 'cp_moves' THEN
    UPDATE public.cp_moves SET voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason) WHERE id = p_id;
  ELSE
    UPDATE public.cp_lot_checks SET voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason) WHERE id = p_id;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.cp_void(text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cp_void(text, uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.cp_is_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cp_can(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cp_is_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cp_can(uuid, text) TO authenticated;

/* ---------------------------------------------------------------- views (security_invoker) */
/* Open product lines of the program's customer, straight from the Fishbowl mirror. Product = */
/* Fishbowl part type 10 (Inventory); DEPOSIT (20), MFG CERTS / notes (30) and freight / UPS (60) */
/* drop out. Not filtered on the Order Queue disposition: 'ignore' there means no SkyNet action, */
/* and an ignored line is still an open Kaytech order (seen on TEST, 2026-10-27). */
CREATE VIEW public.cp_v_lines WITH (security_invoker = true) AS
SELECT cp.id                     AS program_id,
       so.fb_so_id, so.so_number, so.customer_po, so.status_id AS so_status_id,
       so.fb_date_created::date  AS so_created,
       l.fb_soitem_id, l.line_number, l.product_num, l.part_num, l.description,
       l.qty_ordered, l.qty_fulfilled,
       greatest(l.qty_ordered - l.qty_fulfilled, 0)                          AS qty_open,
       l.unit_price,
       round(greatest(l.qty_ordered - l.qty_fulfilled, 0) * l.unit_price, 2) AS open_value,
       l.effective_due_date, l.due_date_is_default, l.disposition,
       l.customer_order_line_id, col.status AS co_line_status, co.co_number,
       t.id AS tracking_id, t.flow, t.terms, t.drawing_sent_on, t.drawing_signed_on,
       t.hold_note, t.notes AS tracking_notes,
       inv.qty_on_hand AS fb_on_hand, inv.qty_on_order AS fb_on_order
  FROM public.customer_programs cp
  JOIN public.fb_sales_orders so
    ON so.fb_customer_id = cp.fb_customer_id AND so.removed_at IS NULL AND so.status_id IN (20, 25)
  JOIN public.fb_sales_order_lines l
    ON l.fb_so_id = so.fb_so_id AND l.removed_at IS NULL AND l.type_id = 10
   AND l.fb_part_type_id = 10
   AND l.qty_ordered > l.qty_fulfilled
  LEFT JOIN public.cp_line_tracking t     ON t.program_id = cp.id AND t.fb_soitem_id = l.fb_soitem_id
  LEFT JOIN public.customer_order_lines col ON col.id = l.customer_order_line_id
  LEFT JOIN public.customer_orders co       ON co.id = col.customer_order_id
  LEFT JOIN public.fb_part_inventory inv    ON inv.part_num = l.part_num
 WHERE public.cp_is_member(cp.id);

CREATE VIEW public.cp_v_lot_balances WITH (security_invoker = true) AS
WITH legs AS (
  SELECT program_id, part_num, coalesce(to_lot_number, lot_number) AS lot_number, to_stage AS stage, qty, entry_date
    FROM public.cp_moves WHERE voided_at IS NULL AND to_stage IS NOT NULL
  UNION ALL
  SELECT program_id, part_num, lot_number, from_stage, -qty, entry_date
    FROM public.cp_moves WHERE voided_at IS NULL AND from_stage IS NOT NULL
)
SELECT program_id, part_num, lot_number, stage, sum(qty)::integer AS qty, max(entry_date) AS last_move
  FROM legs
 GROUP BY program_id, part_num, lot_number, stage;

REVOKE ALL ON public.cp_v_lines, public.cp_v_lot_balances FROM anon;
GRANT SELECT ON public.cp_v_lines, public.cp_v_lot_balances TO authenticated;

COMMIT;

/* ---------------------------------------------------------------- verify (single row) */
SELECT
  (SELECT count(*) FROM pg_tables WHERE schemaname = 'public'
     AND tablename IN ('customer_programs','customer_program_access','cp_line_tracking','cp_quotes','cp_money','cp_moves','cp_lot_checks')
     AND rowsecurity) AS tables_with_rls_expect_7,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
     AND tablename IN ('customer_programs','customer_program_access','cp_line_tracking','cp_quotes','cp_money','cp_moves','cp_lot_checks')) AS policies_expect_14,
  (SELECT count(*) FROM pg_views WHERE schemaname = 'public' AND viewname IN ('cp_v_lines','cp_v_lot_balances')) AS views_expect_2,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('cp_is_member','cp_can','cp_void')) AS functions_expect_3;
