// queries.mjs — every Fishbowl SQL statement the bridge runs, in one place. All read-only.
// Column names verified against Fishbowl 25.9 (Docs/Implementation_Plans/FB1_Implementation_Plan.md §7.6). Do not guess new ones.

const idList = (ids) => ids.map((n) => Number(n)).filter(Number.isFinite).join(',')

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

  // Users (daily): names only — never userPwd / mfaSecret (D-FB-34).
  users: 'SELECT id, userName, firstName, lastName, activeFlag FROM sysuser',

  // Inventory snapshot per part per location group for the parts on open SO lines (D-FB-33).
  inventory: (partIds) => `SELECT q.PARTID AS partId, p.num AS partNum, q.LOCATIONGROUPID AS locationGroupId,
      q.QTYONHAND AS qtyOnHand, q.QTYALLOCATED AS qtyAllocated, q.QTYNOTAVAILABLE AS qtyNotAvailable, q.QTYONORDER AS qtyOnOrder
    FROM qtyinventorytotals q JOIN part p ON p.id = q.PARTID
    WHERE q.PARTID IN (${idList(partIds)})`,

  // Reconciliation and backfill: Issued (20) + In Progress (25) only (D-FB-11 / D-FB-17).
  openSos: 'SELECT id, statusId, dateLastModified FROM so WHERE statusId IN (20,25)',
  statusOf: (ids) => `SELECT id, statusId, dateLastModified FROM so WHERE id IN (${idList(ids)})`,
}
