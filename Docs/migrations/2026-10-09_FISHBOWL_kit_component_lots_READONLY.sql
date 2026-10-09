/* =====================================================================================
   2026-10-09_FISHBOWL_kit_component_lots_READONLY.sql   (rev 5 -- final pull, with kit membership)
   READ-ONLY. Run against the Fishbowl database (MySQL). Nothing here writes.

   THE JOIN (proven by Q3, ShippedLotsLive.csv, 2026-10-09)
     A shipped item's lot lives in Fishbowl's tracking history:
       trackinginfo.recordId = shipitem.id AND trackinginfo.tableId = 1555030112
     On SO 16373 that returned all 21 component lots the August backfill recorded from
     the curated report -- same line, lot and quantity -- plus the SK-4P3 / SK-T26 tool
     set on lines 24-25; trackinginfo.qty equals qty_shipped on every line. (tableId
     -1515431424 is the pick history, identical here; the ship record is the authority.)
     shipitem.tagId is cleared once a shipment ships, which is why rev 2 found nothing.
     Rev 1-4 queries are retired.

   KIT MEMBERSHIP (added in rev 5)
     The nearest kit header above a line is not enough: SO 19400 has kit RV-OD1 (4 parts)
     followed by 14 loose parts, which rev 4 grouped under the kit. kit_member = 1 only
     when Fishbowl's own kit definition (kititem) lists the part for that kit AND every
     line between the header and this one is also in the kit -- the kit block exactly as
     the packing slip indents it (the bridge applies the same rule, D-FB-29).
     kit_qty_fulfilled = kits shipped on that header line, for a shipped-vs-logged check.

   SCOPE
     The 107 SOs behind PROD's 233 bench-logged kit lots (source 'skynet', 2026-08-05 ..
     2026-10-09). One row per shipped item per lot; a shipped item split across two lots
     returns two rows, each with its own lot_qty. Shipments still 'Entered' come back
     with no lot yet -- SkyNet takes shipped rows only and picks those up later.

   RUN
     Q2 -> export CSV, send to Claude. Same query as rev 4 plus two columns
     (kit_qty_fulfilled, kit_member). Claude turns it into the PROD load file.
   ===================================================================================== */


/* ------------------------------- Q2 : the pull ------------------------------------- */

SELECT so.num              AS so_num,
       so.statusId         AS so_status,
       si.id               AS soitem_id,
       si.soLineItem       AS so_line,
       si.typeId           AS line_type,
       si.productNum       AS product_num,
       hdr.soLineItem      AS kit_line,
       hdr.productNum      AS kit_product_num,
       hdr.qtyFulfilled    AS kit_qty_fulfilled,
       CASE
         WHEN hdr.id IS NULL THEN NULL
         WHEN EXISTS (SELECT 1 FROM kititem ki
                      WHERE ki.kitProductId = hdr.productId AND ki.productId = si.productId)
          AND NOT EXISTS (SELECT 1 FROM soitem x
                          WHERE x.soId = si.soId
                            AND x.soLineItem > hdr.soLineItem
                            AND x.soLineItem < si.soLineItem
                            AND NOT EXISTS (SELECT 1 FROM kititem k2
                                            WHERE k2.kitProductId = hdr.productId
                                              AND k2.productId = x.productId))
         THEN 1 ELSE 0
       END                 AS kit_member,
       ship.num            AS ship_num,
       ss.name             AS ship_status,
       DATE(ship.dateShipped) AS date_shipped,
       shi.id              AS shipitem_id,
       shi.qtyShipped      AS qty_shipped,
       pt.name             AS tracking_name,
       ti.info             AS lot_number,
       ti.qty              AS lot_qty
FROM so
JOIN soitem si             ON si.soId = so.id
JOIN shipitem shi          ON shi.soItemId = si.id
JOIN ship                  ON ship.id = shi.shipId
LEFT JOIN shipstatus ss    ON ss.id = ship.statusId
LEFT JOIN soitem hdr       ON hdr.id = (
       SELECT h.id FROM soitem h
       WHERE h.soId = si.soId AND h.typeId = 80 AND h.soLineItem < si.soLineItem
       ORDER BY h.soLineItem DESC
       LIMIT 1)
LEFT JOIN trackinginfo ti  ON ti.recordId = shi.id AND ti.tableId = 1555030112
LEFT JOIN parttracking pt  ON pt.id = ti.partTrackingId
WHERE si.typeId <> 80
  AND so.num IN ('17367','17737','17756','17826','17831','17850','17981','17982','18059',
    '18121','18124','18126','18127','18144','18164','18190','18191','18240','18247','18248',
    '18277','18283','18312','18339','18345','18351','18352','18362','18384','18390','18422',
    '18423','18429','18440','18445','18507','18528','18566','18572','18586','18592SG','18642',
    '18684','18688','18704','18716','18718','18719','18720','18727','18727-03','18802','18803',
    '18804','18817','18820','18821','18830','18837','18870','18872','18873','18899','18928',
    '18951','18956','18962','18963','18968','19018','19019','19022','19024','19025','19027',
    '19029','19047','19062','19066','19100','19108','19123','19127','19133','19134','19164',
    '19165','19190','19194','19215','19223','19236','19251','19263','19265','19276','19277',
    '19285','19301','19333','19345','19352','19369','19400','19425','19467','19490')
ORDER BY so.num, si.soLineItem, ship.num, shi.id, ti.id;
