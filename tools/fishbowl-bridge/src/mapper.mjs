// mapper.mjs — turns Fishbowl data-query rows into the payload shape fb_ingest_delta expects.
// Fishbowl returns timestamps like 2026-08-24T11:53:35.812-04 (offset without minutes) and
// decimals like "800.000000000" / "0E-9". Everything is normalised here, nowhere else.

const TZ_SHORT = /([+-]\d{2})$/

export function ts(v) {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  return TZ_SHORT.test(s) ? s.replace(TZ_SHORT, '$1:00') : s
}

export function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function int(v) {
  const n = num(v)
  return n === null ? null : Math.trunc(n)
}

// "Remaining Parts Ship Date" arrives as whatever Fishbowl stores for a Date custom field.
// Accept ISO (2026-09-14, 2026-09-14 00:00:00, 2026-09-14T00:00:00.000-04) and US (09/14/2026); anything else -> null.
export function dateOnly(v) {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return null
}

export function jsonObj(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return { _unparsed: String(v).slice(0, 500) } }
}

export function mapHeader(r) {
  return {
    id: int(r.id),
    num: r.num === null || r.num === undefined ? null : String(r.num),
    customerId: int(r.customerId),
    customerName: r.customerName ?? null,
    customerPO: r.customerPO ?? null,
    statusId: int(r.statusId),
    priorityId: int(r.priorityId),
    typeId: int(r.typeId),
    locationGroupId: int(r.locationGroupId),
    salesman: r.salesman ?? null,
    salesmanId: int(r.salesmanId),
    username: r.username ?? null,
    dateCreated: ts(r.dateCreated),
    dateIssued: ts(r.dateIssued),
    dateCompleted: ts(r.dateCompleted),
    dateLastModified: ts(r.dateLastModified),
    note: r.note ?? null,
    shipToName: r.shipToName ?? null,
    customFields: jsonObj(r.customFields),
  }
}

export function mapLine(r) {
  return {
    id: int(r.id),
    soId: int(r.soId),
    soLineItem: int(r.soLineItem),
    typeId: int(r.typeId),
    statusId: int(r.statusId),
    productNum: r.productNum === null || r.productNum === undefined ? '' : String(r.productNum),
    productId: int(r.productId),
    fbPartId: int(r.fbPartId),
    partNum: r.partNum ?? null,
    partTypeId: int(r.partTypeId),
    description: r.description ?? null,
    qtyOrdered: num(r.qtyOrdered) ?? 0,
    qtyFulfilled: num(r.qtyFulfilled) ?? 0,
    qtyPicked: num(r.qtyPicked),
    qtyToFulfill: num(r.qtyToFulfill),
    uomId: int(r.uomId),
    unitPrice: num(r.unitPrice),
    totalPrice: num(r.totalPrice),
    dateScheduledFulfillment: ts(r.dateScheduledFulfillment),
    remainingPartsShipDate: dateOnly(r.remainingPartsShipDate),
    revLevel: r.revLevel ?? null,
    customerPartNum: r.customerPartNum ?? null,
    note: r.note ?? null,
    customFields: jsonObj(r.customFields),
    dateLastModified: ts(r.dateLastModified),
  }
}

// Groups header + line rows into the orders[] array the RPC consumes. revById: Map(soId -> {rev, userId, ts})
export function buildOrders(headerRows, lineRows, revById = new Map()) {
  const lines = new Map()
  for (const l of lineRows) {
    const m = mapLine(l)
    if (!lines.has(m.soId)) lines.set(m.soId, [])
    lines.get(m.soId).push(m)
  }
  return headerRows.map((h) => {
    const header = mapHeader(h)
    const rev = revById.get(header.id) || {}
    return {
      header,
      lines: lines.get(header.id) || [],
      complete: true,
      rev: rev.rev ?? null,
      revUserId: rev.userId ?? null,
      revTimestamp: rev.ts ?? null,
    }
  })
}

export function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
