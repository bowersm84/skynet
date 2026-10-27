/* =====================================================================================
   2026-10-26  SK27S8-1-5 / -7 / -8 (steel, cad plated, Torq-Set head) into the active price book
   Decision: D-PRICE-71 (run the collision check against Docs/Decisions.md before appending)

   What this does (all in the ACTIVE book, looked up by status — no hardcoded UUIDs):
     1. Opens a slot for a new catalog section directly BEFORE
        "Skybolt Cloc® 27S8-1 Torx-Set Series - Stainless" (sort 33 today):
        every section with sort >= 33 moves +1. Item sorts are per-section (the book already has 200+ shared
        item sort values across sections), so no item rows are touched; the new items take 743-745 inside their own section.
     2. Inserts the section "Skybolt Cloc® 27S8-1 Torq-Set Series - Steel" at that slot (kind = catalog).
     3. Inserts three priced items, rule A / ladder standard, list = the existing SK27S8-1-(x)S ladder:
           SK27S8-1-5   $17.54   xref 27S8-5-1AA
           SK27S8-1-7   $21.05   xref 27S8-7-1AA
           SK27S8-1-8   $25.25   xref 27S8-8-1AA
        (Tier 3 falls out of rule A at 0.60: $10.52 / $12.63 / $15.15)
     4. Inserts three FIXED customer price exceptions for SIMAL/ AB (fb_customer 14867, looked up by name):
           $6.90 / $7.60 / $8.00  — the 40,000-pc program price, valid through 2027-04-26.

   Guards: exactly one active book · stainless 27S8-1 section present · steel section absent ·
           none of the three part numbers present · Simal found. If any guard fails the statement
           inserts/updates NOTHING (every write is joined to the guard row) and the result shows zeros.

   Run order in the SQL Editor:  BLOCK 1 (preflight)  →  BLOCK 2 (apply + verify, one run)  →  BLOCK 3 only to reverse.
   TEST applied 2026-10-26 by Claude (ylzmyjjqibpbqbwjsnqj) — results in the chat. PROD (luzungoqfuplspzbqctb) is applied by Matt.
   ===================================================================================== */


/* ---------- BLOCK 1 · PREFLIGHT (read-only) — expect: active_books 1, stainless_section_found 1,
   stainless_section_sort 33, first_stainless_item_sort 743, already_present 0, steel_section_present 0,
   simal_id 14867, simal_exceptions_present 0. Note sections_to_shift (PROD count may differ from TEST). ---------- */
WITH b  AS (SELECT id FROM price_books WHERE status = 'active'),
     ss AS (SELECT s.id, s.sort FROM price_sections s JOIN b ON b.id = s.book_id
            WHERE s.name = 'Skybolt Cloc® 27S8-1 Torx-Set Series - Stainless'),
     fi AS (SELECT min(pi.sort) AS sort FROM price_items pi JOIN ss ON ss.id = pi.section_id)
SELECT (SELECT count(*) FROM b)                                                             AS active_books,
       (SELECT count(*) FROM ss)                                                            AS stainless_section_found,
       (SELECT sort FROM ss)                                                                AS stainless_section_sort,
       (SELECT sort FROM fi)                                                                AS first_stainless_item_sort,
       (SELECT count(*) FROM price_sections s JOIN b ON b.id = s.book_id
          WHERE s.sort >= (SELECT sort FROM ss))                                            AS sections_to_shift,
       (SELECT count(*) FROM price_items pi JOIN b ON b.id = pi.book_id
          WHERE pi.part_key IN ('SK27S8-1-5','SK27S8-1-7','SK27S8-1-8'))                    AS already_present,
       (SELECT count(*) FROM price_sections s JOIN b ON b.id = s.book_id
          WHERE s.name = 'Skybolt Cloc® 27S8-1 Torq-Set Series - Steel')                   AS steel_section_present,
       (SELECT fb_customer_id FROM fb_customers WHERE name = 'SIMAL/ AB')                   AS simal_id,
       (SELECT count(*) FROM price_exceptions WHERE part_number ILIKE 'SK27S8-1-%'
          AND closed_at IS NULL)                                                            AS simal_exceptions_present,
       (SELECT md5(string_agg(s.name || ':' || s.sort, '|' ORDER BY s.sort))
          FROM price_sections s JOIN b ON b.id = s.book_id)                                 AS sections_fingerprint;


/* ---------- BLOCK 2 · APPLY + VERIFY (one run). Expected result row:
   sections_shifted = preflight sections_to_shift ·
   section_added 1 · items_added 3 · exceptions_added 3 · then the verify columns:
   steel_section_sort 33 · stainless_section_sort 34 · new_items 'SK27S8-1-5:743:17.54 | SK27S8-1-7:744:21.05 | SK27S8-1-8:745:25.25' ·
   exceptions 'SK27S8-1-5:6.90 | SK27S8-1-7:7.60 | SK27S8-1-8:8.00' · items_in_steel_section 3 · dup_section_sorts 0 ---------- */
BEGIN;

WITH b  AS (SELECT id FROM price_books WHERE status = 'active'),
     g  AS (SELECT b.id AS book_id
              FROM b
             WHERE (SELECT count(*) FROM price_books WHERE status = 'active') = 1
               AND EXISTS (SELECT 1 FROM price_sections s WHERE s.book_id = b.id
                             AND s.name = 'Skybolt Cloc® 27S8-1 Torx-Set Series - Stainless')
               AND NOT EXISTS (SELECT 1 FROM price_sections s WHERE s.book_id = b.id
                             AND s.name = 'Skybolt Cloc® 27S8-1 Torq-Set Series - Steel')
               AND NOT EXISTS (SELECT 1 FROM price_items pi WHERE pi.book_id = b.id
                             AND pi.part_key IN ('SK27S8-1-5','SK27S8-1-7','SK27S8-1-8'))
               AND EXISTS (SELECT 1 FROM fb_customers WHERE name = 'SIMAL/ AB')),
     ss AS (SELECT s.id, s.sort, s.book_id FROM price_sections s JOIN g ON g.book_id = s.book_id
             WHERE s.name = 'Skybolt Cloc® 27S8-1 Torx-Set Series - Stainless'),
     fi AS (SELECT min(pi.sort) AS sort FROM price_items pi JOIN ss ON ss.id = pi.section_id),
     shift_sections AS (
        UPDATE price_sections s SET sort = s.sort + 1
          FROM ss WHERE s.book_id = ss.book_id AND s.sort >= ss.sort
        RETURNING s.id),
     new_sec AS (
        INSERT INTO price_sections (book_id, name, sort, kind)
        SELECT ss.book_id, 'Skybolt Cloc® 27S8-1 Torq-Set Series - Steel', ss.sort, 'catalog' FROM ss
        RETURNING id, book_id),
     v (pn, descr, lp, xa, off, note) AS (VALUES
        ('SK27S8-1-5', 'Flush Head Stud - Torq-Set - Steel - Cad Plated', 17.54::numeric, '27S8-5-1AA', 0,
         'Steel cad-plated stud with the MS33781 offset-cruciform (Torq-Set) head; blank SK27S8B cold-headed by AJ Fasteners (4037 DFARS). Added 2026-10-26 for the Simal International RFQ (4,000 pc). List = the SK27S8-1-(x)S stainless ladder; Simal program price carried as a fixed price exception. NSN per AeroBase/PartTarget, unverified against FLIS: 5325-00-917-7877. LISI xref likely 1127010-5 (unverified).'),
        ('SK27S8-1-7', 'Flush Head Stud - Torq-Set - Steel - Cad Plated', 21.05::numeric, '27S8-7-1AA', 1,
         'Steel cad-plated stud with the MS33781 offset-cruciform (Torq-Set) head; blank SK27S8B cold-headed by AJ Fasteners (4037 DFARS). Added 2026-10-26 for the Simal International RFQ (34,000 pc). List = the SK27S8-1-(x)S stainless ladder; Simal program price carried as a fixed price exception. NSN per AeroBase/PartTarget, unverified against FLIS: 5325-00-959-0040. LISI xref likely 1127010-7 (unverified).'),
        ('SK27S8-1-8', 'Flush Head Stud - Torq-Set - Steel - Cad Plated', 25.25::numeric, '27S8-8-1AA', 2,
         'Steel cad-plated stud with the MS33781 offset-cruciform (Torq-Set) head; blank SK27S8B cold-headed by AJ Fasteners (4037 DFARS). Added 2026-10-26 for the Simal International RFQ (2,000 pc). List = the SK27S8-1-(x)S stainless ladder; Simal program price carried as a fixed price exception. NSN per AeroBase/PartTarget, unverified against FLIS: 5325-00-985-3801. LISI xref likely 1127010-8 (unverified).')),
     new_items AS (
        INSERT INTO price_items (book_id, section_id, part_number, description, list_price, rule_code, ladder_code,
                                 has_premier, dfar, xref_arconic, sort, status, notes)
        SELECT ns.book_id, ns.id, v.pn, v.descr, v.lp, 'A', 'standard', false, false, v.xa, fi.sort + v.off, 'priced', v.note
          FROM new_sec ns, fi, v
        RETURNING id, part_number),
     e (pn, px) AS (VALUES ('SK27S8-1-5', 6.90::numeric), ('SK27S8-1-7', 7.60::numeric), ('SK27S8-1-8', 8.00::numeric)),
     new_exc AS (
        INSERT INTO price_exceptions (fb_customer_id, part_number, mode, value, note, effective_from, effective_to)
        SELECT c.fb_customer_id, e.pn, 'fixed', e.px,
               'Simal International 27S8 program (4,000 / 34,000 / 2,000 pc, RFQ Oct 2026): fixed program price = 2x the SK27S3 Rev 82 Tier 3; floor $1.47; D-PRICE-71. Expires 2027-04-26 unless renewed.',
               DATE '2026-10-26', DATE '2027-04-26'
          FROM e, new_items ni, fb_customers c
         WHERE ni.part_number = e.pn AND c.name = 'SIMAL/ AB'
        RETURNING id)
SELECT (SELECT count(*) FROM shift_sections) AS sections_shifted,
       (SELECT count(*) FROM new_sec)        AS section_added,
       (SELECT count(*) FROM new_items)      AS items_added,
       (SELECT count(*) FROM new_exc)        AS exceptions_added;

/* verify (same run — this is the result set the editor shows) */
WITH b AS (SELECT id FROM price_books WHERE status = 'active')
SELECT (SELECT sort FROM price_sections s JOIN b ON b.id = s.book_id WHERE s.name = 'Skybolt Cloc® 27S8-1 Torq-Set Series - Steel')     AS steel_section_sort,
       (SELECT sort FROM price_sections s JOIN b ON b.id = s.book_id WHERE s.name = 'Skybolt Cloc® 27S8-1 Torx-Set Series - Stainless') AS stainless_section_sort,
       (SELECT string_agg(pi.part_number || ':' || pi.sort || ':' || pi.list_price, ' | ' ORDER BY pi.sort)
          FROM price_items pi JOIN b ON b.id = pi.book_id WHERE pi.part_key IN ('SK27S8-1-5','SK27S8-1-7','SK27S8-1-8'))                 AS new_items,
       (SELECT string_agg(x.part_number || ':' || x.value, ' | ' ORDER BY x.part_number)
          FROM price_exceptions x WHERE x.part_number IN ('SK27S8-1-5','SK27S8-1-7','SK27S8-1-8') AND x.closed_at IS NULL)              AS exceptions,
       (SELECT count(*) FROM price_items pi JOIN price_sections s ON s.id = pi.section_id JOIN b ON b.id = s.book_id
          WHERE s.name = 'Skybolt Cloc® 27S8-1 Torq-Set Series - Steel')                                                              AS items_in_steel_section,
       (SELECT count(*) FROM (SELECT sort FROM price_sections s JOIN b ON b.id = s.book_id GROUP BY sort HAVING count(*) > 1) d)       AS dup_section_sorts,
       (SELECT string_agg(s.name || ':' || s.sort, ' | ' ORDER BY s.sort)
          FROM price_sections s JOIN b ON b.id = s.book_id WHERE s.sort BETWEEN 31 AND 35)                                             AS neighborhood;

COMMIT;


/* ---------- BLOCK 3 · REVERSE (only if needed — exact inverse, one run) ---------- */
/*
BEGIN;
WITH b  AS (SELECT id FROM price_books WHERE status = 'active'),
     st AS (SELECT s.id, s.sort, s.book_id FROM price_sections s JOIN b ON b.id = s.book_id
             WHERE s.name = 'Skybolt Cloc® 27S8-1 Torq-Set Series - Steel'),
     del_exc   AS (DELETE FROM price_exceptions WHERE part_number IN ('SK27S8-1-5','SK27S8-1-7','SK27S8-1-8') RETURNING id),
     del_items AS (DELETE FROM price_items pi USING st WHERE pi.section_id = st.id RETURNING pi.id),
     del_sec   AS (DELETE FROM price_sections s USING st WHERE s.id = st.id RETURNING s.id),
     unshift_sections AS (UPDATE price_sections s SET sort = s.sort - 1 FROM st
                        WHERE s.book_id = st.book_id AND s.sort > st.sort RETURNING s.id)
SELECT (SELECT count(*) FROM del_exc) AS exceptions_deleted, (SELECT count(*) FROM del_items) AS items_deleted,
       (SELECT count(*) FROM del_sec) AS sections_deleted, (SELECT count(*) FROM unshift_sections) AS sections_unshifted;
COMMIT;
*/
