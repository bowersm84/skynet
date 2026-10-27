/* ===================================================================================== */
/* 2026-10-27_customer_program_kaytech_seed.sql — S16 Batch A, Kaytech opening position */
/* Run AFTER 2026-10-27_customer_program.sql. Same file on TEST and PROD: every id is looked */
/* up (fb customer by name, profiles by email, SO lines by SO number + part); no UUIDs. */
/* Idempotent: ON CONFLICT / NOT EXISTS guards, so a second run adds nothing. */
/* */
/* Sources (Matt, Oct 27 2026 Kaytech chat): */
/*   roster ............ Matt (moves + money), Ashley Hall (moves), Ned Bowers, April Braun, */
/*                       Christy Exum (view + ask). Active admins also get both flags so TEST's */
/*                       admin can exercise the page; on PROD that is Matt alone. */
/*   line flows/terms .. the open-order workbook sent to Kaytech Oct 27. */
/*   money ............. deposit requests from the Oct 27 email; the Oct 1 $41,670.00 request */
/*                       voided as superseded; the two open invoices Matt confirmed with */
/*                       Crystalyn ($2,704.00 SK26S8-5, $572.00 SK212-12S). Invoice date is */
/*                       taken as the Fishbowl ship date (Oct 8 / Oct 15) and due date as +30; */
/*                       correct from QuickBooks if they differ. */
/*   lots .............. QL8C78: JP4146R 700 + JP4147R 400 ready (Matt's bag photos); */
/*                       4142 566, 4144 254, 4149 830 to deburr (Deburr.zip + IMG_8075). */
/*                       The IMG_8039 short-pin bag is NOT seeded: no count yet. */
/* ===================================================================================== */
BEGIN;

INSERT INTO public.customer_programs (code, name, fb_customer_id, credit_limit, deposit_pct, past_due_grace_days)
SELECT 'KAYTECH', 'Kaytech', c.fb_customer_id, 50000, 0.30, 30
  FROM public.fb_customers c
 WHERE c.name ILIKE 'KAYTECH INDUSTRIES%' AND c.removed_at IS NULL
 ORDER BY c.fb_customer_id
 LIMIT 1
ON CONFLICT (code) DO NOTHING;

WITH prog AS (SELECT id FROM public.customer_programs WHERE code = 'KAYTECH'),
roster(email, moves, money) AS (VALUES
  ('mbowers@skybolt.com', true,  true),
  ('ahall@skybolt.com',   true,  false),
  ('nbowers@skybolt.com', false, false),
  ('abraun@skybolt.com',  false, false),
  ('cexum@skybolt.com',   false, false)),
picked AS (
  SELECT p.id AS profile_id, r.moves, r.money
    FROM roster r JOIN public.profiles p ON lower(p.email) = r.email AND p.is_active
  UNION
  SELECT p.id, true, true FROM public.profiles p
   WHERE p.is_active AND (p.role = 'admin' OR p.roles && ARRAY['admin'])),
merged AS (
  SELECT profile_id, bool_or(moves) AS moves, bool_or(money) AS money FROM picked GROUP BY profile_id)
INSERT INTO public.customer_program_access (program_id, profile_id, can_log_moves, can_enter_money)
SELECT prog.id, m.profile_id, m.moves, m.money FROM prog, merged m
ON CONFLICT (program_id, profile_id) DO NOTHING;

WITH prog AS (SELECT id, fb_customer_id FROM public.customer_programs WHERE code = 'KAYTECH'),
want(so_number, product_num, flow, terms) AS (VALUES
  ('16182', 'QL4S-RET1', 'buyin', 'deposit'),
  ('15392', 'QL4-21',    'build', 'deposit'),
  ('15968', 'QL4-21',    'build', 'deposit'),
  ('8291',  'QL8C78',    'stock', 'net30'),
  ('15516', 'QL4S-ET2',  'build', 'net30'),
  ('15933', 'SK26S8-5',  'build', 'net30'))
INSERT INTO public.cp_line_tracking (program_id, fb_soitem_id, flow, terms, updated_by)
SELECT prog.id, l.fb_soitem_id, w.flow, w.terms,
       (SELECT id FROM public.profiles WHERE lower(email) = 'mbowers@skybolt.com' AND is_active LIMIT 1)
  FROM prog
  JOIN public.fb_sales_orders so ON so.fb_customer_id = prog.fb_customer_id AND so.removed_at IS NULL
  JOIN want w ON w.so_number = so.so_number
  JOIN public.fb_sales_order_lines l ON l.fb_so_id = so.fb_so_id AND l.removed_at IS NULL
   AND l.product_num = w.product_num AND l.type_id = 10 AND l.qty_ordered > l.qty_fulfilled
ON CONFLICT (program_id, fb_soitem_id) DO NOTHING;

INSERT INTO public.cp_quotes (program_id, rfq_number, part_num, description, qty, unit_price, quoted_on, notes, updated_by)
SELECT p.id, '371300', 'QL8C10', '1800 Series Stud Nut Receiver, Caged (alternate for CA1810)', 2500, 42.67, DATE '2026-10-07',
       'Lead time about 6 weeks. Drawing goes to Kaytech to verify fit before scheduling. 30% deposit before production, balance before shipment (Matt to Jackie, Oct 22).',
       (SELECT id FROM public.profiles WHERE lower(email) = 'mbowers@skybolt.com' AND is_active LIMIT 1)
  FROM public.customer_programs p WHERE p.code = 'KAYTECH'
ON CONFLICT (program_id, rfq_number, part_num) DO NOTHING;

WITH prog AS (SELECT id FROM public.customer_programs WHERE code = 'KAYTECH'),
matt AS (SELECT id FROM public.profiles WHERE lower(email) = 'mbowers@skybolt.com' AND is_active LIMIT 1),
rows(kind, amount, po_number, so_number, reference, txn_date, due_date, notes) AS (VALUES
  ('deposit_request', 41670.00, '165251', '15968', 'QL4-21 deposit invoice, PO 165251', DATE '2026-10-01', NULL::date,
     'April''s Oct 1 acknowledgment: 30% of $138,900.00.'),
  ('deposit_request', 41670.00, '165251', '15968', 'QL4-21 deposit, 30% of $138,900.00', DATE '2026-10-27', NULL::date,
     'Oct 27 request covering both QL4-21 POs ($43,029.02 total).'),
  ('deposit_request',  1359.02, '165058', '15392', 'QL4-21 deposit, 30% of $4,530.05', DATE '2026-10-27', NULL::date,
     'Oct 27 request covering both QL4-21 POs ($43,029.02 total).'),
  ('deposit_request', 16425.00, '165184', '16182', 'QL4S-RET1 deposit, 30% of $54,750.00', DATE '2026-10-27', NULL::date,
     'Order is above the $50,000 credit line on its own.'),
  ('invoice',          2704.00, '165240', '15933', 'Shipment Oct 8, 800 pcs SK26S8-5', DATE '2026-10-08', DATE '2026-11-07',
     'Amount confirmed with Crystalyn Oct 27. Dates taken from the Fishbowl ship date; invoice number to be filled from QuickBooks.'),
  ('invoice',           572.00, '165287', '16497', 'Shipment Oct 15, 100 pcs SK212-12S', DATE '2026-10-15', DATE '2026-11-14',
     'Amount confirmed with Crystalyn Oct 27. Dates taken from the Fishbowl ship date; invoice number to be filled from QuickBooks.'))
INSERT INTO public.cp_money (program_id, kind, amount, po_number, so_number, reference, txn_date, due_date, notes, entered_by)
SELECT prog.id, r.kind, r.amount, r.po_number, r.so_number, r.reference, r.txn_date, r.due_date, r.notes, (SELECT id FROM matt)
  FROM prog, rows r
 WHERE NOT EXISTS (SELECT 1 FROM public.cp_money m
                    WHERE m.program_id = prog.id AND m.kind = r.kind AND m.amount = r.amount
                      AND m.po_number = r.po_number AND m.txn_date = r.txn_date);

UPDATE public.cp_money m
   SET voided_at = now(),
       voided_by = (SELECT id FROM public.profiles WHERE lower(email) = 'mbowers@skybolt.com' AND is_active LIMIT 1),
       void_reason = 'Superseded Oct 27 by the 30% request on both QL4-21 POs ($43,029.02)'
 WHERE m.program_id = (SELECT id FROM public.customer_programs WHERE code = 'KAYTECH')
   AND m.kind = 'deposit_request' AND m.po_number = '165251' AND m.txn_date = DATE '2026-10-01'
   AND m.voided_at IS NULL;

WITH prog AS (SELECT id FROM public.customer_programs WHERE code = 'KAYTECH'),
matt AS (SELECT id FROM public.profiles WHERE lower(email) = 'mbowers@skybolt.com' AND is_active LIMIT 1),
rows(lot_number, to_stage, qty, po_number, notes) AS (VALUES
  ('JP4146R', 'ready',  700, '162948', '14 bags x 50, packed (photo IMG_8073).'),
  ('JP4147R', 'ready',  400, '162948', '8 bags x 50, packed (photo IMG_8074).'),
  ('4142',    'rework', 566, NULL,     'Returned under RMA 261007-20 in original bags; burrs (Deburr.zip).'),
  ('4144',    'rework', 254, NULL,     'Returned under RMA 261007-20 in original bags; burrs (Deburr.zip).'),
  ('4149',    'rework', 830, NULL,     'Bulk bag, 830 pcs; to deburr (IMG_8075).'))
INSERT INTO public.cp_moves (program_id, part_num, lot_number, from_stage, to_stage, qty, po_number, entry_date, done_by, notes, entered_by)
SELECT prog.id, 'QL8C78', r.lot_number, NULL, r.to_stage, r.qty, r.po_number, DATE '2026-10-27', 'Opening count', r.notes, (SELECT id FROM matt)
  FROM prog, rows r
 WHERE NOT EXISTS (SELECT 1 FROM public.cp_moves m
                    WHERE m.program_id = prog.id AND m.part_num = 'QL8C78' AND m.lot_number = r.lot_number
                      AND m.from_stage IS NULL AND m.done_by = 'Opening count');

COMMIT;

/* ---------------------------------------------------------------- verify (single row) */
/* PROD expects: roster 5, lines 6, quotes 1, money live 5 (+1 void), open invoices 3276.00, */
/* deposits requested 59454.02, lots: ready 1100 / rework 1650. */
SELECT
  (SELECT count(*) FROM public.customer_program_access a JOIN public.customer_programs p ON p.id = a.program_id WHERE p.code = 'KAYTECH') AS roster,
  (SELECT count(*) FROM public.cp_line_tracking t JOIN public.customer_programs p ON p.id = t.program_id WHERE p.code = 'KAYTECH') AS lines_tracked,
  (SELECT count(*) FROM public.cp_quotes q JOIN public.customer_programs p ON p.id = q.program_id WHERE p.code = 'KAYTECH') AS quotes,
  (SELECT count(*) FILTER (WHERE m.voided_at IS NULL) || ' live / ' || count(*) FILTER (WHERE m.voided_at IS NOT NULL) || ' void'
     FROM public.cp_money m JOIN public.customer_programs p ON p.id = m.program_id WHERE p.code = 'KAYTECH') AS money_rows,
  (SELECT sum(m.amount) FROM public.cp_money m JOIN public.customer_programs p ON p.id = m.program_id
    WHERE p.code = 'KAYTECH' AND m.kind = 'invoice' AND m.voided_at IS NULL) AS open_invoices,
  (SELECT sum(m.amount) FROM public.cp_money m JOIN public.customer_programs p ON p.id = m.program_id
    WHERE p.code = 'KAYTECH' AND m.kind = 'deposit_request' AND m.voided_at IS NULL) AS deposits_requested,
  (SELECT 'ready ' || coalesce(sum(qty) FILTER (WHERE to_stage = 'ready'), 0) || ' / rework ' || coalesce(sum(qty) FILTER (WHERE to_stage = 'rework'), 0)
     FROM public.cp_moves m JOIN public.customer_programs p ON p.id = m.program_id WHERE p.code = 'KAYTECH' AND m.voided_at IS NULL) AS lots;
