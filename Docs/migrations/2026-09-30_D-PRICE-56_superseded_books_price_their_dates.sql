/* ============================================================================================
   2026-09-30_D-PRICE-56_superseded_books_price_their_dates.sql   (PROD SQL Editor: paste the whole file, Run)
   At 8:27 pm Eastern on 2026-09-30 the portal's book roll ran on the database date, which is UTC and was
   already Oct 1: Rev 82 became active and Rev 81 superseded. pricing_book_for_date ignored superseded books,
   so the Eastern date 2026-09-30 had no book: the Catalog waited forever and any price asked for "today"
   came back empty.
   1. pricing_book_for_date: a superseded book still prices the dates before its successor took effect.
   2. pricing_roll_books: rolls on the Eastern business date, so a book changes over at local midnight.
   No data changes; grants are kept by CREATE OR REPLACE. Applied and checked on TEST 2026-09-30.
   Expect one row: true | true | 5.28 | 6.07.
   ============================================================================================ */
CREATE OR REPLACE FUNCTION public.pricing_book_for_date(p_as_of date DEFAULT CURRENT_DATE)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  /* The book in effect on a date: the latest published book that took effect on or before it. A superseded
     book still prices the dates before its successor took effect (D-PRICE-56). */
  SELECT id FROM public.price_books
  WHERE status IN ('scheduled','active','superseded') AND effective_from <= p_as_of
  ORDER BY effective_from DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.pricing_roll_books()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE n integer := 0; v_now uuid;
        /* the business date in Leesburg, not the database's UTC date, which turns over at 8 pm Eastern (D-PRICE-56) */
        v_today date := (now() AT TIME ZONE 'America/New_York')::date;
BEGIN
  v_now := public.pricing_book_for_date(v_today);
  IF v_now IS NULL THEN RETURN 0; END IF;
  UPDATE public.price_books SET status = 'active', published_at = COALESCE(published_at, now()) WHERE id = v_now AND status = 'scheduled';
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE public.price_books SET status = 'superseded', superseded_at = now()
   WHERE status = 'active' AND id <> v_now AND effective_from < (SELECT effective_from FROM public.price_books WHERE id = v_now);
  RETURN n;
END $$;

SELECT pricing_book_for_date('2026-09-30') = 'c2deab40-cdbe-4036-8ede-369001c756fa' AS sep30_is_rev81,
       pricing_book_for_date('2026-10-01') = '95b56bae-94ae-4677-b0bf-023d8104a8a5' AS oct1_is_rev82,
       (SELECT unit_price_2dp FROM pricing_get_price('SK2600-1', NULL, 1, '2026-09-30')) AS sk2600_1_sep30,
       (SELECT unit_price_2dp FROM pricing_get_price('SK2600-1', NULL, 1, '2026-10-01')) AS sk2600_1_oct1;
