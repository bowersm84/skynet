// inventory.mjs — D-FB-40. The inventory poller's arithmetic, with no I/O, so it can be run and
// tested under plain `node` (see inventory.test.mjs).
//
// Input is the raw result of `q.inventory`: one row per part per location group, LEFT JOINed from
// `part`, so a Fishbowl part with no `qtyinventorytotals` record comes back as a single row whose
// `locationGroupId` is null. That row is the whole point of D-FB-40 — it becomes a zero row, which
// says "Fishbowl knows this part and it holds nothing". Under D-FB-33 the join was inner, the part
// was simply absent from the result, and the poller sent nothing — so whatever `fb_part_inventory`
// last held for it stayed there for ever (113 of 443 rows on 2026-09-23).
//
// A part number Fishbowl does not know never reaches this function: it is dropped at the
// `q.partsByNum` step, so it gets no row at all and "no row" keeps meaning "not a Fishbowl part".

// Output shape is exactly what fb_upsert_inventory takes, unchanged since D-FB-33.
const emptyPart = (partId, partNum) => ({
  partId, partNum,
  onHand: 0, allocated: 0, notAvailable: 0, onOrder: 0, available: 0,
  byLocation: {},
})

/**
 * Sum Fishbowl's per-location-group rows into one payload row per part.
 * `available` (D-FB-33) counts only the configured groups; every group is kept in `byLocation`
 * for the Order Queue tooltip and the Create WO chips (D-FB-39).
 */
export function aggregateInventory(rows, availableLocationGroups = []) {
  const avail = new Set((availableLocationGroups || []).map(Number).filter(Number.isFinite))
  const byPart = new Map()

  for (const r of rows || []) {
    // Number(null) is 0, so a null id has to be rejected before the coercion or it becomes part 0.
    if (r.partId === null || r.partId === undefined) continue
    const partId = Number(r.partId)
    if (!Number.isFinite(partId)) continue

    if (!byPart.has(partId)) byPart.set(partId, emptyPart(partId, r.partNum))
    const p = byPart.get(partId)
    // partNum comes from `part`, so it is the same on every row of a part; this only fills a null.
    if ((p.partNum === null || p.partNum === undefined) && r.partNum != null) p.partNum = r.partNum

    // The LEFT JOIN miss. The part row is already created above, which is what makes it a zero row.
    if (r.locationGroupId === null || r.locationGroupId === undefined) continue
    const lg = Number(r.locationGroupId)
    if (!Number.isFinite(lg)) continue

    const onHand = Number(r.qtyOnHand) || 0
    const allocated = Number(r.qtyAllocated) || 0
    const notAvailable = Number(r.qtyNotAvailable) || 0
    const onOrder = Number(r.qtyOnOrder) || 0

    p.onHand += onHand
    p.allocated += allocated
    p.notAvailable += notAvailable
    p.onOrder += onOrder
    if (avail.has(lg)) p.available += onHand - allocated - notAvailable
    p.byLocation[lg] = { onHand, allocated, notAvailable, onOrder }
  }

  return [...byPart.values()]
}

// A part Fishbowl holds no stock record for. Counted for the cycle log and for Matt's dry-run check:
// the real run must write the same number of zero rows the dry run reported.
export function countZeroRows(payload) {
  return (payload || []).filter((p) => Object.keys(p.byLocation || {}).length === 0).length
}
