// queries.mjs — every Fishbowl SQL statement the bridge runs, in one place. All read-only.
// Column names verified against Fishbowl 25.9 (Docs/Implementation_Plans/FB1_Implementation_Plan.md §7.6). Do not guess new ones.

const idList = (ids) => ids.map((n) => Number(n)).filter(Number.isFinite).join(',')

// D-FB-40. A MySQL string list. Part numbers carry spaces and slashes ('SK2600FW-SET 2',
// '10RX1/2THBS') and come from SkyNet's own parts table, so they are escaped rather than trusted:
// backslash first, then the quote doubled (''), which is an escape in every sql_mode. An empty list
// becomes NULL so `IN ()` — a MySQL syntax error — can never be emitted.
const strList = (vals) => (vals || [])
  .map((s) => String(s ?? '').trim())
  .filter((s) => s.length > 0)
  .map((s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`)
  .join(',') || 'NULL'

// Bridge v1.11: an id list that can never become `IN ()` (empty -> NULL, which matches nothing).
const inIds = (ids) => idList(ids || []) || 'NULL'

// A revision number from the bridge's own arithmetic, checked anyway before it reaches the SQL.
const rev = (n) => {
  const v = Number(n)
  if (!Number.isInteger(v) || v < 0) throw new Error(`audit window: bad revision ${JSON.stringify(n)}`)
  return v
}

// A Fishbowl local datetime built by fbDateTime(), validated like purchaseChangedIds.
const localDateTime = (s, label) => {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(s))) throw new Error(`${label}: bad datetime ${JSON.stringify(s)}`)
  return s
}

export const q = {
  maxRev: 'SELECT MAX(id) AS maxRev FROM revinfo',

  // SO ids touched in a revision window, with the highest revision that touched each.
  // Estimates (statusId 10) never leave Fishbowl (D-FB-11): the join drops them here so their content is never sent.
  soRevs: (from, to) => `SELECT x.soId, MAX(x.REV) AS rev FROM (
      SELECT soId, REV FROM soitem_aud WHERE REV > ${from} AND REV <= ${to}
      UNION ALL
      SELECT id AS soId, REV FROM so_aud WHERE REV > ${from} AND REV <= ${to}
    ) x JOIN so s ON s.id = x.soId WHERE s.statusId <> 10 GROUP BY x.soId`,

  revInfo: (revs) => `SELECT id, timestamp, modifiedUserId FROM revinfo WHERE id IN (${idList(revs)})`,

  headers: (ids) => `SELECT s.id, s.num, s.customerId, c.name AS customerName, s.customerPO, s.statusId, s.priorityId,
      s.typeId, s.locationGroupId, s.salesman, s.salesmanId, s.username, s.dateCreated, s.dateIssued, s.dateCompleted,
      s.dateLastModified, s.note, s.shipToName, s.customFields
    FROM so s JOIN customer c ON c.id = s.customerId
    WHERE s.id IN (${idList(ids)})`,

  lines: (ids) => `SELECT i.id, i.soId, i.soLineItem, i.typeId, i.statusId, i.productNum, i.productId,
      p.partId AS fbPartId, pt.num AS partNum, pt.typeId AS partTypeId, i.description,
      i.qtyOrdered, i.qtyFulfilled, i.qtyPicked, i.qtyToFulfill, i.uomId, i.unitPrice, i.totalPrice,
      i.dateScheduledFulfillment, JSON_UNQUOTE(JSON_EXTRACT(i.customFields, '$."30".value')) AS remainingPartsShipDate,
      i.revLevel, i.customerPartNum, i.note, i.customFields, i.dateLastModified
    FROM soitem i LEFT JOIN product p ON p.id = i.productId LEFT JOIN part pt ON pt.id = p.partId
    WHERE i.soId IN (${idList(ids)})
    ORDER BY i.soId, i.soLineItem`,

  // Kit definitions for the kit products on a batch of SOs (D-FB-29). kitItemTypeId 10 = product component.
  kitItems: (productIds) => `SELECT kitProductId, productId, kitItemTypeId FROM kititem WHERE kitProductId IN (${idList(productIds)})`,

  // D-FB-59: Fishbowl's own kit link. objecttoobject typeId 30 ties a component soitem (recordId1) to its kit
  // header soitem (recordId2); the D-FB-29 positional rule is only the fallback for a line with no link.
  kitLinks: (soItemIds) => `SELECT recordid1 AS childSoItemId, recordid2 AS headerSoItemId
    FROM objecttoobject WHERE typeid = 30 AND recordid1 IN (${inIds(soItemIds)})`,

  // --- Bridge v1.11 audit-tail families (D-ASM-23 / D-FB-58). Read-only. -----------------------------
  // Columns confirmed against skybolt_newlive (information_schema, 2026-11-04), including the two marked
  // "verify" in the A1 prompt: pickitem_aud.orderTypeId / pickId and carrierservice all exist.
  // Each family's ids touched in a revision window (from, to]; the window is the family's own cursor.

  // Pick ids touched in the window: SO picks only (WO picks belong to the mos family).
  auditPickIds: (from, to) => `SELECT DISTINCT x.pickId FROM (
      SELECT pickId FROM pickitem_aud WHERE REV > ${rev(from)} AND REV <= ${rev(to)} AND orderTypeId = 20
      UNION ALL
      SELECT id AS pickId FROM pick_aud WHERE REV > ${rev(from)} AND REV <= ${rev(to)}
    ) x WHERE x.pickId IS NOT NULL`,

  auditShipIds: (from, to) => `SELECT DISTINCT x.shipId FROM (
      SELECT id AS shipId FROM ship_aud WHERE REV > ${rev(from)} AND REV <= ${rev(to)}
      UNION ALL SELECT shipId FROM shipcarton_aud WHERE REV > ${rev(from)} AND REV <= ${rev(to)}
      UNION ALL SELECT shipId FROM shipitem_aud   WHERE REV > ${rev(from)} AND REV <= ${rev(to)}
    ) x WHERE x.shipId IS NOT NULL`,

  // The MO, its items, its WOs, their items, and WO pick consumption.
  auditMoIds: (from, to) => `SELECT DISTINCT x.moId FROM (
      SELECT id AS moId FROM mo_aud WHERE REV > ${rev(from)} AND REV <= ${rev(to)}
      UNION ALL SELECT moId FROM moitem_aud WHERE REV > ${rev(from)} AND REV <= ${rev(to)}
      UNION ALL SELECT mi.moId FROM wo_aud wa JOIN moitem mi ON mi.id = wa.moItemId WHERE wa.REV > ${rev(from)} AND wa.REV <= ${rev(to)}
      UNION ALL SELECT mi.moId FROM woitem_aud wia JOIN moitem mi ON mi.id = wia.moItemId WHERE wia.REV > ${rev(from)} AND wia.REV <= ${rev(to)}
      UNION ALL SELECT mi.moId FROM pickitem_aud pa JOIN woitem wi ON wi.id = pa.woItemId JOIN moitem mi ON mi.id = wi.moItemId
                WHERE pa.orderTypeId = 30 AND pa.REV > ${rev(from)} AND pa.REV <= ${rev(to)}
    ) x WHERE x.moId IS NOT NULL`,

  auditBomIds: (from, to) => `SELECT DISTINCT x.bomId FROM (
      SELECT id AS bomId FROM bom_aud WHERE REV > ${rev(from)} AND REV <= ${rev(to)}
      UNION ALL SELECT bomId FROM bomitem_aud            WHERE REV > ${rev(from)} AND REV <= ${rev(to)}
      UNION ALL SELECT bomId FROM bominstructionitem_aud WHERE REV > ${rev(from)} AND REV <= ${rev(to)}
    ) x WHERE x.bomId IS NOT NULL`,

  // First run on a database (the family's cursor is NULL): the ids to load instead of a window.
  backfillPickIds: `SELECT DISTINCT pi.pickId FROM pickitem pi JOIN soitem ON soitem.id = pi.soItemId JOIN so ON so.id = soitem.soId
    WHERE pi.orderTypeId = 20 AND so.statusId IN (20, 25)`,
  backfillShipIds: 'SELECT id AS shipId FROM ship WHERE dateCreated >= DATE_SUB(NOW(), INTERVAL 180 DAY)',
  backfillMoIds: 'SELECT id AS moId FROM mo WHERE statusId IN (10, 20, 50) OR dateCreated >= DATE_SUB(NOW(), INTERVAL 180 DAY)',
  backfillBomIds: 'SELECT id AS bomId FROM bom WHERE activeFlag = 1',

  // picks -> fb_upsert_pick_items. destTagId -> tag.locationId -> location is the D-ASM-06 flag.
  pickItems: (pickIds) => `SELECT pi.id AS pickItemId, pi.pickId, pick.num AS pickNum, pick.statusId AS pickStatusId,
      pick.dateLastModified AS pickLastModified,
      soitem.soId AS soId, pi.soItemId, pi.partId, part.num AS partNum, pi.qty, pi.slotNum,
      pi.statusId, pis.name AS status,
      pi.srcLocationId, srcloc.name AS srcLocation, srctag.num AS srcTagNum,
      desttag.locationId AS destLocationId, destloc.name AS destLocation, desttag.num AS destTagNum
    FROM pickitem pi
    JOIN pick                    ON pick.id = pi.pickId
    LEFT JOIN pickitemstatus pis ON pis.id = pi.statusId
    LEFT JOIN part               ON part.id = pi.partId
    LEFT JOIN soitem             ON soitem.id = pi.soItemId
    LEFT JOIN location srcloc    ON srcloc.id = pi.srcLocationId
    LEFT JOIN tag srctag         ON srctag.id = COALESCE(pi.srcTagId, pi.tagId)
    LEFT JOIN tag desttag        ON desttag.id = pi.destTagId
    LEFT JOIN location destloc   ON destloc.id = desttag.locationId
    WHERE pi.orderTypeId = 20 AND pi.pickId IN (${inIds(pickIds)})`,

  // ships -> fb_upsert_shipments (headers, cartons, items). Lots stay with shipmentLots above.
  ships: (shipIds) => `SELECT ship.id AS shipId, ship.num AS shipNum, ship.soId, so.num AS soNumber,
      ship.statusId, shipstatus.name AS status, ship.dateCreated, ship.dateShipped,
      carrier.name AS carrier, carrierservice.name AS carrierService, ship.cartonCount
    FROM ship JOIN shipstatus ON shipstatus.id = ship.statusId
    LEFT JOIN so ON so.id = ship.soId
    LEFT JOIN carrier ON carrier.id = ship.carrierId
    LEFT JOIN carrierservice ON carrierservice.id = ship.carrierServiceId
    WHERE ship.id IN (${inIds(shipIds)})`,

  shipCartons: (shipIds) => `SELECT id AS cartonId, shipId, cartonNum, trackingNum, freightWeight, freightAmount
    FROM shipcarton WHERE shipId IN (${inIds(shipIds)})`,

  shipItems: (shipIds) => `SELECT si.id AS shipItemId, si.shipId, si.shipCartonId AS cartonId, si.soItemId,
      product.num AS productNum, si.qtyShipped
    FROM shipitem si LEFT JOIN soitem ON soitem.id = si.soItemId LEFT JOIN product ON product.id = soitem.productId
    WHERE si.shipId IN (${inIds(shipIds)})`,

  // The ships of a set of SOs: how a SO queued for shipment lots (D-FB-54) also refreshes its ship headers.
  shipIdsForSos: (soIds) => `SELECT id AS shipId FROM ship WHERE soId IN (${inIds(soIds)})`,

  // mos -> fb_upsert_manufacture_orders. The RPC replaces every child of each MO it receives, so the four
  // child reads always cover every MO id of the batch.
  mos: (moIds) => `SELECT mo.id AS moId, mo.num AS moNum, mo.statusId, mostatus.name AS status, mo.soId, mo.locationGroupId,
      mo.dateCreated, mo.dateIssued, mo.dateScheduled, mo.dateCompleted, mo.dateLastModified, mo.note, mo.userId
    FROM mo LEFT JOIN mostatus ON mostatus.id = mo.statusId WHERE mo.id IN (${inIds(moIds)})`,

  moItems: (moIds) => `SELECT mi.id AS moItemId, mi.moId, mi.typeId, mi.parentId, mi.bomId, bom.num AS bomNum, mi.partId, part.num AS partNum,
      mi.description, mi.qtyToFulfill, mi.qtyFulfilled, mi.statusId, mi.stageLevel, mi.sortIdInstruct AS sortId
    FROM moitem mi LEFT JOIN bom ON bom.id = mi.bomId LEFT JOIN part ON part.id = mi.partId WHERE mi.moId IN (${inIds(moIds)})`,

  workOrders: (moIds) => `SELECT wo.id AS woId, wo.num AS woNum, mi.moId, wo.moItemId, wo.statusId, wostatus.name AS status,
      wo.qtyOrdered, wo.qtyTarget, wo.qtyScrapped, wo.locationId, wo.dateCreated, wo.dateStarted, wo.dateFinished,
      wo.note, wo.cost
    FROM wo JOIN moitem mi ON mi.id = wo.moItemId LEFT JOIN wostatus ON wostatus.id = wo.statusId WHERE mi.moId IN (${inIds(moIds)})`,

  woItems: (woIds) => `SELECT wi.id AS woItemId, wi.woId, wi.moItemId, wi.typeId, wi.partId, part.num AS partNum, wi.description,
      wi.qtyTarget, wi.qtyUsed, wi.qtyScrapped, wi.cost, wi.standardCost, wi.sortId
    FROM woitem wi LEFT JOIN part ON part.id = wi.partId WHERE wi.woId IN (${inIds(woIds)})`,

  // Lots a WO consumed: its pick items (orderTypeId 30) with the lot from the pick history (tableId -1515431424).
  woConsumedLots: (woIds) => `SELECT pi.id AS pickItemId, wi.woId, pi.woItemId, pi.partId, part.num AS partNum, pi.qty, pi.statusId,
      loc.name AS srcLocation, tag.num AS srcTagNum, ti.info AS lotNumber
    FROM pickitem pi
    JOIN woitem wi ON wi.id = pi.woItemId
    LEFT JOIN part ON part.id = pi.partId
    LEFT JOIN location loc ON loc.id = pi.srcLocationId
    LEFT JOIN tag ON tag.id = COALESCE(pi.srcTagId, pi.tagId)
    LEFT JOIN trackinginfo ti ON ti.recordId = pi.id AND ti.tableId = -1515431424 AND ti.partTrackingId = 1
    WHERE pi.orderTypeId = 30 AND wi.woId IN (${inIds(woIds)})`,

  // boms -> fb_upsert_boms. Items and instructions are replaced whole per BOM by the RPC.
  boms: (bomIds) => `SELECT bom.id AS bomId, bom.num AS bomNum, bom.description, bom.activeFlag AS active, bom.revision,
      bom.autoCreateTypeId, bom.dateLastModified
    FROM bom WHERE bom.id IN (${inIds(bomIds)})`,

  bomItems: (bomIds) => `SELECT bi.id AS bomItemId, bi.bomId, bi.typeId, bi.partId, part.num AS partNum, part.description AS partDescription,
      bi.quantity, bi.uomId, uom.code AS uom, bi.sortIdConfig AS sortId, bi.stage, bi.stageBomId
    FROM bomitem bi LEFT JOIN part ON part.id = bi.partId LEFT JOIN uom ON uom.id = bi.uomId WHERE bi.bomId IN (${inIds(bomIds)})`,

  bomInstructions: (bomIds) => `SELECT id AS instructionId, bomId, sortOrder, name, description, details
    FROM bominstructionitem WHERE bomId IN (${inIds(bomIds)})`,

  // --- Bridge v1.11 polled mirrors: tag and postso have no Envers table, so they are read by dateLastModified. ---

  // The tags scope: every part on an active BOM, without the Labor line (uomId 4 = hr).
  tagScopeParts: `SELECT DISTINCT bi.partId FROM bomitem bi JOIN bom ON bom.id = bi.bomId
    WHERE bom.activeFlag = 1 AND bi.uomId <> 4`,

  // On-hand lots for a batch of scope parts; `since` (Fishbowl local datetime) for the delta, null for a sweep.
  tags: (partIds, since = null) => `SELECT tag.id AS tagId, tag.num AS tagNum, tag.partId, part.num AS partNum,
      tag.locationId, location.name AS location, location.locationGroupId,
      tag.qty, tag.qtyCommitted, tt.info AS lotNumber, 'Lot Number' AS trackingType, tag.woItemId,
      tag.dateCreated AS tagCreated, tag.dateLastModified AS tagLastModified
    FROM tag
    JOIN part ON part.id = tag.partId
    JOIN location ON location.id = tag.locationId
    LEFT JOIN trackingtext tt ON tt.tagId = tag.id AND tt.partTrackingId = 1
    WHERE tag.partId IN (${inIds(partIds)})${since === null ? '' : ` AND tag.dateLastModified >= '${localDateTime(since, 'tags')}'`}`,

  // postso changed since a Fishbowl local datetime; null = the first load (posted in the last 180 days).
  postings: (since = null) => `SELECT postso.id AS postSoId, postso.soId, so.num AS soNumber, postso.postDate, postso.datePosted, postso.statusId,
      postso.extRefNumber, postso.extTxnId, postso.journalPosted, postso.totalTax
    FROM postso JOIN so ON so.id = postso.soId
    WHERE ${since === null ? 'postso.postDate >= DATE_SUB(NOW(), INTERVAL 180 DAY)' : `postso.dateLastModified >= '${localDateTime(since, 'postings')}'`}`,

  postingItems: (postSoIds) => `SELECT id AS postSoItemId, postSOId AS postSoId, soItemId, shipItemId, qty, totalPrice
    FROM postsoitem WHERE postSOId IN (${inIds(postSoIds)})`,

  // --- Bridge v1.9 shipments poller (D-FB-54 / D-KSTC-37). Read-only. -------------------------------
  // The Fishbowl rev 5 query of 2026-10-09 (Docs/migrations/2026-10-09_FISHBOWL_kit_component_lots_READONLY.sql),
  // scoped by SO id instead of a typed SO list; aliases = mapper fields. A shipped item's lot is in its
  // tracking history (trackinginfo.tableId 1555030112 — shipitem.tagId is cleared once a shipment ships;
  // -1515431424 is the pick history). kitMember = 1 only when kititem lists the part for the nearest kit
  // header above it AND every line in between is a member too — the packing slip's indentation. Calibrated on
  // SO 16373 against the August backfill line for line; do not change the join without re-calibrating.
  shipmentLots: (soIds) => `SELECT so.num AS soNum, so.statusId AS soStatus, si.id AS soItemId, si.soLineItem AS soLine,
      si.typeId AS lineType, si.productNum AS productNum, hdr.soLineItem AS kitLine, hdr.productNum AS kitProductNum,
      hdr.qtyFulfilled AS kitQtyFulfilled,
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
      END AS kitMember,
      ship.num AS shipNum, ss.name AS shipStatus, DATE(ship.dateShipped) AS dateShipped,
      shi.id AS shipItemId, shi.qtyShipped AS qtyShipped,
      pt.name AS trackingName, ti.info AS lotNumber, ti.qty AS lotQty
    FROM so
    JOIN soitem si          ON si.soId = so.id
    JOIN shipitem shi       ON shi.soItemId = si.id
    JOIN ship               ON ship.id = shi.shipId
    LEFT JOIN shipstatus ss ON ss.id = ship.statusId
    LEFT JOIN soitem hdr    ON hdr.id = (
           SELECT h.id FROM soitem h
           WHERE h.soId = si.soId AND h.typeId = 80 AND h.soLineItem < si.soLineItem
           ORDER BY h.soLineItem DESC
           LIMIT 1)
    LEFT JOIN trackinginfo ti ON ti.recordId = shi.id AND ti.tableId = 1555030112
    LEFT JOIN parttracking pt ON pt.id = ti.partTrackingId
    WHERE si.typeId <> 80 AND so.id IN (${idList(soIds)})
    ORDER BY so.id, si.soLineItem, ship.num, shi.id, ti.id`,

  // SO ids with a shipment shipped on or after a local date (the nightly sweep). The date is built by the
  // bridge, never typed, but it is validated anyway so a malformed value can never reach the SQL.
  recentShipmentSoIds: (since) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(since))) throw new Error(`recentShipmentSoIds: bad date ${JSON.stringify(since)}`)
    return `SELECT DISTINCT si.soId AS soId
    FROM ship
    JOIN shipitem shi ON shi.shipId = ship.id
    JOIN soitem si    ON si.id = shi.soItemId
    WHERE ship.dateShipped >= '${since}'`
  },

  // Users (daily): names only — never userPwd / mfaSecret (D-FB-34).
  users: 'SELECT id, userName, firstName, lastName, activeFlag FROM sysuser',

  // Fishbowl part ids for a batch of part numbers (D-FB-40). Case-insensitive through the column's
  // own collation — no BINARY, so 'sk4c13c' still finds SK4C13C. A number with no row here is a
  // number Fishbowl does not know, and the poller gives it no inventory row at all.
  partsByNum: (nums) => `SELECT p.id AS partId, p.num AS partNum FROM part p WHERE p.num IN (${strList(nums)})`,

  // Inventory snapshot per part per location group (D-FB-33), for every part in scope (D-FB-40).
  // D-FB-40 turns the join around: it starts from `part` and LEFT JOINs the totals, so a Fishbowl
  // part with no qtyinventorytotals record comes back as one row with a null locationGroupId and is
  // written as a zero row. Under the old inner join such a part was simply absent from the result and
  // the poller sent nothing for it, so its mirrored row kept its last values for ever (113 of 443 on
  // 2026-09-23). partId now comes from p.id, not q.PARTID, which is null on a miss.
  // Column casing is Fishbowl's own, unchanged from D-FB-33; only FROM/JOIN/WHERE moved.
  inventory: (partIds) => `SELECT p.id AS partId, p.num AS partNum, q.LOCATIONGROUPID AS locationGroupId,
      q.QTYONHAND AS qtyOnHand, q.QTYALLOCATED AS qtyAllocated, q.QTYNOTAVAILABLE AS qtyNotAvailable, q.QTYONORDER AS qtyOnOrder
    FROM part p LEFT JOIN qtyinventorytotals q ON q.PARTID = p.id
    WHERE p.id IN (${idList(partIds)})`,

  // D-FB-52 (bridge 1.8). The opening-valuation query of 2026-10-06, verbatim apart from three things:
  // p.id is added, the on-hand/cost WHERE filter is dropped so every typeId-10 part is mirrored (the class
  // filter happens in SkyNet, S13 Decision 7), and the rounding is left to SkyNet. Aliases = mapper fields.
  partValuation: `SELECT p.id AS partId, p.num AS partNum, p.description, p.activeFlag,
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.customFields, '$."33".value')), '(unclassified)') AS valuationClass,
      COALESCE(oh.qtyOnHand, 0) AS qtyOnHand,
      pc.avgCost, pc.totalCost, pc.qty AS costLayerQty,
      CASE WHEN pr.partId IS NOT NULL THEN 'Y' ELSE 'N' END AS hasProduct,
      CASE WHEN bi.partId IS NOT NULL THEN 'Y' ELSE 'N' END AS usedInBoms
    FROM part p
    LEFT JOIN partcost pc ON pc.partId = p.id
    LEFT JOIN (SELECT t.partId, SUM(t.qty) AS qtyOnHand FROM tag t GROUP BY t.partId) oh ON oh.partId = p.id
    LEFT JOIN (SELECT DISTINCT partId FROM product) pr ON pr.partId = p.id
    LEFT JOIN (SELECT DISTINCT partId FROM bomitem) bi ON bi.partId = p.id
    WHERE p.typeId = 10`,

  // --- Bridge v1.3 pricing mirrors (D-PRICE-26). All read-only, all in Fishbowl's own local time. ---

  // Customers. `since` is a 'YYYY-MM-DD HH:MM:SS' local string, or null for a full backfill.
  // withTerms=false drops the paymentterms join for a Fishbowl build that does not have that table.
  customers: (since, withTerms = true) => {
    const termsCol = withTerms ? ', pt.name AS paymentTerms' : ''
    const termsJoin = withTerms ? `
    LEFT JOIN paymentterms pt ON pt.id = c.defaultPaymentTermsId` : ''
    const where = since ? `
    WHERE c.dateLastModified > '${since}'` : ''
    return `SELECT c.id, c.number, c.name, c.activeFlag, c.accountId,
      c.dateCreated, c.dateLastModified, su.userName AS salesman${termsCol}
    FROM customer c
    LEFT JOIN sysuser su ON su.id = c.defaultSalesmanId${termsJoin}${where}`
  },

  // Account group membership, keyed by customer.accountId (columns confirmed 2026-09-03).
  accountGroups: `SELECT agr.accountId, ag.name FROM accountgrouprelation agr
    JOIN accountgroup ag ON ag.id = agr.groupId`,

  // Full product table (~11k rows) with its part number, nightly.
  products: `SELECT p.id, p.num, pt.num AS partNum, p.description, p.price, p.activeFlag
    FROM product p LEFT JOIN part pt ON pt.id = p.partId`,

  // Latest RECEIVED purchase cost per part (D-PRICE-47). One row per part: the PO line with the most
  // recent dateLastFulfillment. Full read, no cursor — the result is one row per part, like `products`.
  // The price book values kit hardware at 2 x this cost, so a wrong number here becomes a wrong list price.
  //
  // TWO UNVERIFIED ASSUMPTIONS — Matt validates both in Fishbowl's Data module before 1.4.0 runs:
  //   1. po.statusId = 70 means Void. The bridge has never read a PO table and carries no PO-status
  //      constants; FB_SO_STATUS in src/lib/fishbowl.js is the SALES order status set, a different list,
  //      so 70 is expectation, not evidence. If Void is a different id, fix the literal below.
  //   2. part.defaultProductId exists on this Fishbowl version. If it does not, replace the product join
  //      with `LEFT JOIN product pr ON pr.partId = p.id` and collapse to one row per part (MIN(pr.id)).
  // Reserved-word check (MySQL 8): po, poitem, part, product, vendor and every column below are
  // non-reserved; the aliases poi/p/pr/v/x are clear of `rows`, `rank`, `lines`, `system`.
  //
  // Ties: if two PO lines share a part's newest dateLastFulfillment this returns both. That is resolved
  // deterministically in partCosts.mjs before the upsert, because fb_upsert_part_costs sends the whole
  // batch through one ON CONFLICT statement and Postgres errors on a repeated key.
  partCosts: `SELECT p.num            AS partNum,
       pr.num           AS productNum,
       p.id             AS fbPartId,
       poi.unitCost     AS lastCost,
       poi.dateLastFulfillment AS lastCostDate,
       po.num           AS lastPoNumber,
       v.name           AS lastVendor,
       poi.qtyFulfilled AS lastQty,
       p.stdCost        AS stdCost
    FROM poitem poi
    JOIN po      ON po.id = poi.poId
    JOIN part p  ON p.id  = poi.partId
    LEFT JOIN product pr ON pr.id = p.defaultProductId
    LEFT JOIN vendor v   ON v.id  = po.vendorId
    WHERE poi.qtyFulfilled > 0
      AND poi.dateLastFulfillment IS NOT NULL
      AND po.statusId <> 70
      AND poi.dateLastFulfillment = (SELECT MAX(x.dateLastFulfillment) FROM poitem x
                                      WHERE x.partId = poi.partId AND x.qtyFulfilled > 0 AND x.dateLastFulfillment IS NOT NULL)`,

  // One page of SO history: product lines (typeId 10 Sale / 12 Drop Ship — the pair D-FB-08 calls
  // PRODUCT_LINE_TYPES; 30 is Discount %, not drop ship, and was wrong in the Batch A brief) plus 80 Kit,
  // the header line a kit is sold and priced on (D-PRICE-44 — its components ship as type-10 lines at $0,
  // so without the header the whole kit sale was invisible). PRODUCT_LINE_TYPES itself governs open-SO
  // dispositioning and stays [10, 12]. Included from every SO that is not an Estimate (10) or dead
  // (80 Voided / 85 Cancelled / 90 Expired). Open orders are included so the history table is complete;
  // v_customer_purchases de-dupes them against the open mirror by fb_soitem_id.
  soHistory: (since, limit) => `SELECT si.id AS soItemId, s.id AS soId, s.num AS soNum, s.customerId, s.statusId AS soStatusId,
      si.statusId AS lineStatusId, si.typeId, si.productNum, pt.num AS partNum, si.description,
      si.qtyOrdered, si.qtyFulfilled, si.unitPrice, si.totalPrice, s.dateCreated, s.dateCompleted,
      su.userName AS salesman, s.dateLastModified
    FROM soitem si
    JOIN so s ON s.id = si.soId
    LEFT JOIN product p ON p.id = si.productId
    LEFT JOIN part pt ON pt.id = p.partId
    LEFT JOIN sysuser su ON su.id = s.salesmanId
    WHERE si.typeId IN (10, 12, 80) AND s.statusId NOT IN (10, 80, 85, 90)
      AND s.dateLastModified > '${since}'
    ORDER BY s.dateLastModified, si.id
    LIMIT ${Number(limit) || 2000}`,

  // --- Bridge v1.7 pricing link mirrors (D-PRICE-53). Read-only. -----------------------------------
  // Table and column names below were taken from scripts/fb-columns.mjs against Fishbowl 25.9 on the
  // date in the v1.7 Decisions entry. If Fishbowl reports a column differently, fix it HERE (one place).

  // Every category of the product tree; the path is assembled in rulesTree.mjs from parentId.
  productTreeNodes: 'SELECT id, name, parentId FROM producttree',

  // Product <-> category membership with the product number (a product can sit under several nodes).
  productTreeMembers: `SELECT ptt.productId, p.num AS productNum, ptt.productTreeId AS nodeId
    FROM producttotree ptt JOIN product p ON p.id = ptt.productId`,

  // Every pricing rule with its type ids resolved to the names the Pricing Rules import uses. A rule's
  // productInclId is a product id or a tree node id depending on productInclType; customerInclId is a
  // customer id or an account-group id (Fishbowl's "customer groups") depending on customerInclType.
  // patype id 6 is named 'Set price' in the table but 'Fixed price' in the Pricing Rules export/import
  // (6,989 rules each way, 2026-09-25); it is translated so the mirror compares with the expected set.
  // paPercent is stored as a fraction (0.96) but exported and expected as percent points (96%), so it is
  // scaled here in exact decimal arithmetic.
  pricingRules: `SELECT r.id, r.name, r.description, r.isActive,
      pit.name AS productInclType, r.productInclId, CASE WHEN pit.name = 'Product' THEN p.num END AS productNum,
      cit.name AS customerInclType, r.customerInclId,
      CASE WHEN cit.name = 'Customer' THEN c.name WHEN cit.name = 'Customer Group' THEN ag.name END AS customerName,
      r.paApplies, CASE WHEN pat.name = 'Set price' THEN 'Fixed price' ELSE pat.name END AS paType, r.paPercent * 100 AS paPercent, pbat.name AS paBaseAmountType, r.paAmount,
      r.rndApplies, rt.name AS roundType, r.rndToAmount, r.rndIsMinus, r.rndPMAmount,
      r.dateApplies, r.dateBegin, r.dateEnd, r.qtyApplies, r.qtyMin, r.qtyMax, r.isAutoApply, r.isTier2,
      r.dateCreated, r.dateLastModified
    FROM pricingrule r
    LEFT JOIN productincltype pit ON pit.id = r.productInclTypeId
    LEFT JOIN customerincltype cit ON cit.id = r.customerInclTypeId
    LEFT JOIN patype pat ON pat.id = r.paTypeId
    LEFT JOIN pabaseamounttype pbat ON pbat.id = r.paBaseAmountTypeId
    LEFT JOIN rndtype rt ON rt.id = r.rndTypeId
    LEFT JOIN product p ON p.id = r.productInclId AND pit.name = 'Product'
    LEFT JOIN customer c ON c.id = r.customerInclId AND cit.name = 'Customer'
    LEFT JOIN accountgroup ag ON ag.id = r.customerInclId AND cit.name = 'Customer Group'`,

  // --- Bridge v1.10 purchasing mirror (D-FB-55). Read-only. ------------------------------------------
  // Columns from the 2026-10-14 Fishbowl schema check (po, poitem, poitemtype, vendor, receiptitem, trackinginfo,
  // parttracking); aliases = purchasing.mjs mapper fields. A receipt's lot is in trackinginfo with tableId
  // 1259138490 ('ReceiptItem' in tablereference) and recordId = receiptitem.id — the join of the 2026-10-14 Giza
  // receipts pull (35 of 35 lots found). The ids are numeric only (idList); the dates are built by the bridge and
  // validated anyway, like recentShipmentSoIds.
  purchaseOrders: (ids) => `SELECT po.id AS poId, po.num AS poNum, po.statusId, po.typeId, po.vendorId, v.name AS vendorName,
      po.vendorSO AS vendorSo, po.buyer, po.locationGroupId, po.dateCreated, po.dateIssued, po.dateConfirmed,
      po.dateCompleted, po.dateLastModified
    FROM po LEFT JOIN vendor v ON v.id = po.vendorId
    WHERE po.id IN (${idList(ids)})`,

  purchaseOrderLines: (ids) => `SELECT poi.id AS poItemId, poi.poId, po.num AS poNum, poi.poLineItem AS lineNumber, poi.typeId,
      pit.name AS typeName, poi.statusId, poi.partId, poi.partNum, poi.description,
      poi.outsourcedPartNumber AS outsourcedPartNum, poi.outsourcedPartDescription AS outsourcedDescription,
      poi.vendorPartNum, poi.revLevel, poi.qtyToFulfill, poi.qtyFulfilled, poi.qtyPicked, poi.unitCost, poi.totalCost,
      poi.uomId, poi.dateScheduledFulfillment AS dateScheduled, poi.dateLastFulfillment
    FROM poitem poi
    JOIN po ON po.id = poi.poId
    LEFT JOIN poitemtype pit ON pit.id = poi.typeId
    WHERE poi.poId IN (${idList(ids)})
    ORDER BY poi.poId, poi.poLineItem`,

  purchaseReceipts: (ids) => `SELECT ri.id AS receiptItemId, ri.poItemId, poi.poId, po.num AS poNum, ri.partId, pt.num AS partNum,
      ri.qty, ri.statusId, ri.dateReceived, ri.dateLastModified,
      ptk.name AS trackingName, ti.info AS lotNumber, ti.qty AS lotQty
    FROM receiptitem ri
    JOIN poitem poi ON poi.id = ri.poItemId
    JOIN po ON po.id = poi.poId
    LEFT JOIN part pt ON pt.id = ri.partId
    LEFT JOIN trackinginfo ti ON ti.recordId = ri.id AND ti.tableId = 1259138490
    LEFT JOIN parttracking ptk ON ptk.id = ti.partTrackingId
    WHERE poi.poId IN (${idList(ids)})
    ORDER BY ri.id, ti.id`,

  // The window: every PO created or issued on or after a local date, plus every PO not yet completed.
  purchaseWindowIds: (since) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(since))) throw new Error(`purchaseWindowIds: bad date ${JSON.stringify(since)}`)
    return `SELECT po.id AS poId FROM po
    WHERE po.dateCreated >= '${since}' OR po.dateIssued >= '${since}' OR po.dateCompleted IS NULL`
  },

  // POs whose header changed, or that took or lost a receipt, since a Fishbowl local datetime.
  purchaseChangedIds: (since) => {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(since))) throw new Error(`purchaseChangedIds: bad datetime ${JSON.stringify(since)}`)
    return `SELECT po.id AS poId FROM po WHERE po.dateLastModified >= '${since}'
    UNION
    SELECT poi.poId AS poId FROM receiptitem ri JOIN poitem poi ON poi.id = ri.poItemId WHERE ri.dateLastModified >= '${since}'`
  },

  // Status names. Not in the 2026-10-14 schema check: purchasing.mjs reads them once and carries on with ids
  // only if either table is missing.
  poStatuses: 'SELECT id, name FROM postatus',
  poItemStatuses: 'SELECT id, name FROM poitemstatus',

  // Reconciliation and backfill: Issued (20) + In Progress (25) only (D-FB-11 / D-FB-17).
  openSos: 'SELECT id, statusId, dateLastModified FROM so WHERE statusId IN (20,25)',
  statusOf: (ids) => `SELECT id, statusId, dateLastModified FROM so WHERE id IN (${idList(ids)})`,
}
