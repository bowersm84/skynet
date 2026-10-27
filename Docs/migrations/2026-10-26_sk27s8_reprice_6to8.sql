/* =====================================================================================
   2026-10-26  Reprice the 27S8-1 Torq-Set studs (steel + stainless) so Tier 3 lands in the $6–8 range   (D-PRICE-72)
   Per Matt / Ned after quote Q-2610-0009: catalog list comes down, Tier 3 = list × 0.60 (rule A):
       band -1 … -5   list $17.54 → $11.50   Tier 3 $10.52 → $6.90
       band -6 … -7   list $21.05 → $12.67   Tier 3 $12.63 → $7.60
       band -8 … -10  list $25.25 → $13.33   Tier 3 $15.15 → $8.00
   Items (ACTIVE book, looked up by status — no UUIDs):
       steel     SK27S8-1-5 (11.50) · SK27S8-1-7 (12.67) · SK27S8-1-8 (13.33)
       stainless SK27S8-1-1S … -5S (11.50) · -6S, -7S (12.67) · -8S … -10S (13.33)
   Not touched: the Simal fixed exceptions ($6.90 / $7.60 / $8.00, through 2027-04-26) — they now equal Tier 3 and
       keep the program price if the book is uplifted later. Rev 81 history untouched. Fishbowl prices follow on the
       next prices push (the three steel items have no Fishbowl product yet).
   Guards: all 13 items present at the CURRENT lists (17.54 / 21.05 / 25.25) — the block is a no-op if it has
       already run or if anything was changed by hand. Each item's notes get a one-line audit trail.
   Run order: BLOCK 1 preflight → BLOCK 2 apply + verify (one run) → BLOCK 3 only to reverse.
   TEST applied 2026-10-26 by Claude; PROD applied by Matt.
   ===================================================================================== */

/* ---------- BLOCK 1 · PREFLIGHT (read-only) — expect items_at_current_lists 13, items_present 13 ---------- */
WITH b AS (SELECT id FROM price_books WHERE status = 'active'),
     p (key, cur, new) AS (VALUES
        ('SK27S8-1-5',  17.54::numeric, 11.50::numeric), ('SK27S8-1-7',  21.05, 12.67), ('SK27S8-1-8',  25.25, 13.33),
        ('SK27S8-1-1S', 17.54, 11.50), ('SK27S8-1-2S', 17.54, 11.50), ('SK27S8-1-3S', 17.54, 11.50),
        ('SK27S8-1-4S', 17.54, 11.50), ('SK27S8-1-5S', 17.54, 11.50),
        ('SK27S8-1-6S', 21.05, 12.67), ('SK27S8-1-7S', 21.05, 12.67),
        ('SK27S8-1-8S', 25.25, 13.33), ('SK27S8-1-9S', 25.25, 13.33), ('SK27S8-1-10S', 25.25, 13.33))
SELECT (SELECT count(*) FROM price_items pi JOIN b ON b.id = pi.book_id JOIN p ON p.key = pi.part_key)                          AS items_present,
       (SELECT count(*) FROM price_items pi JOIN b ON b.id = pi.book_id JOIN p ON p.key = pi.part_key WHERE pi.list_price = p.cur) AS items_at_current_lists,
       (SELECT string_agg(pi.part_number || ':' || pi.list_price, ' | ' ORDER BY pi.part_number)
          FROM price_items pi JOIN b ON b.id = pi.book_id JOIN p ON p.key = pi.part_key)                                          AS current_lists;


/* ---------- BLOCK 2 · APPLY + VERIFY (one run). Expected verify row:
   steel 'SK27S8-1-5:11.50 T3 6.90 | SK27S8-1-7:12.67 T3 7.60 | SK27S8-1-8:13.33 T3 8.00' ·
   stainless '… -1S:11.50 … -5S:11.50 | -6S:12.67 | -7S:12.67 | -8S:13.33 … -10S:13.33' · off_ladder 0 · repriced 13 ---------- */
BEGIN;

WITH b AS (SELECT id FROM price_books WHERE status = 'active'),
     p (key, cur, new) AS (VALUES
        ('SK27S8-1-5',  17.54::numeric, 11.50::numeric), ('SK27S8-1-7',  21.05, 12.67), ('SK27S8-1-8',  25.25, 13.33),
        ('SK27S8-1-1S', 17.54, 11.50), ('SK27S8-1-2S', 17.54, 11.50), ('SK27S8-1-3S', 17.54, 11.50),
        ('SK27S8-1-4S', 17.54, 11.50), ('SK27S8-1-5S', 17.54, 11.50),
        ('SK27S8-1-6S', 21.05, 12.67), ('SK27S8-1-7S', 21.05, 12.67),
        ('SK27S8-1-8S', 25.25, 13.33), ('SK27S8-1-9S', 25.25, 13.33), ('SK27S8-1-10S', 25.25, 13.33)),
     g AS (SELECT b.id AS book_id FROM b
            WHERE (SELECT count(*) FROM price_items pi JOIN p ON p.key = pi.part_key
                     WHERE pi.book_id = b.id AND pi.list_price = p.cur) = 13),
     upd AS (
        UPDATE price_items pi
           SET list_price = p.new,
               notes = concat_ws(' ', pi.notes,
                        'Repriced 2026-10-26 (D-PRICE-72): list ' || p.cur || ' → ' || p.new
                        || ' so Tier 3 sits in the $6–8 range (Matt/Ned, after quote Q-2610-0009; steel floor $1.47/unit).'),
               updated_at = now()
          FROM g, p
         WHERE pi.book_id = g.book_id AND pi.part_key = p.key AND pi.list_price = p.cur
        RETURNING pi.id)
SELECT (SELECT count(*) FROM upd) AS repriced;

WITH b AS (SELECT id FROM price_books WHERE status = 'active')
SELECT (SELECT string_agg(pi.part_number || ':' || pi.list_price || ' T3 ' || round(pi.list_price * pr.m_tier3, 2), ' | ' ORDER BY pi.sort)
          FROM price_items pi JOIN b ON b.id = pi.book_id JOIN price_rules pr ON pr.book_id = pi.book_id AND pr.code = pi.rule_code
         WHERE pi.part_key IN ('SK27S8-1-5','SK27S8-1-7','SK27S8-1-8'))                                                           AS steel,
       (SELECT string_agg(pi.part_number || ':' || pi.list_price, ' | ' ORDER BY pi.sort)
          FROM price_items pi JOIN b ON b.id = pi.book_id WHERE pi.part_key LIKE 'SK27S8-1-%S')                                    AS stainless,
       (SELECT count(*) FROM price_items pi JOIN b ON b.id = pi.book_id
          WHERE pi.part_key LIKE 'SK27S8-1-%' AND pi.list_price NOT IN (11.50, 12.67, 13.33))                                      AS off_ladder,
       (SELECT count(*) FROM price_items pi JOIN b ON b.id = pi.book_id
          WHERE pi.part_key LIKE 'SK27S8-1-%' AND pi.notes LIKE '%Repriced 2026-10-26 (D-PRICE-72)%')                              AS repriced,
       (SELECT string_agg(x.part_number || ':' || x.value, ' | ' ORDER BY x.part_number)
          FROM price_exceptions x WHERE x.part_key LIKE 'SK27S8-1-%' AND x.closed_at IS NULL)                                      AS simal_exceptions_unchanged;

COMMIT;


/* ---------- BLOCK 3 · REVERSE (only if needed — puts the old lists back and drops the audit sentence) ---------- */
/*
BEGIN;
WITH b AS (SELECT id FROM price_books WHERE status = 'active'),
     p (key, cur, new) AS (VALUES
        ('SK27S8-1-5',  17.54::numeric, 11.50::numeric), ('SK27S8-1-7',  21.05, 12.67), ('SK27S8-1-8',  25.25, 13.33),
        ('SK27S8-1-1S', 17.54, 11.50), ('SK27S8-1-2S', 17.54, 11.50), ('SK27S8-1-3S', 17.54, 11.50),
        ('SK27S8-1-4S', 17.54, 11.50), ('SK27S8-1-5S', 17.54, 11.50),
        ('SK27S8-1-6S', 21.05, 12.67), ('SK27S8-1-7S', 21.05, 12.67),
        ('SK27S8-1-8S', 25.25, 13.33), ('SK27S8-1-9S', 25.25, 13.33), ('SK27S8-1-10S', 25.25, 13.33)),
     u AS (UPDATE price_items pi
              SET list_price = p.cur,
                  notes = nullif(trim(regexp_replace(pi.notes, '\s*Repriced 2026-10-26 \(D-PRICE-72\):.*?\$1\.47/unit\)\.', '')), ''),
                  updated_at = now()
             FROM b, p WHERE pi.book_id = b.id AND pi.part_key = p.key AND pi.list_price = p.new RETURNING pi.id)
SELECT (SELECT count(*) FROM u) AS reverted;
COMMIT;
*/
