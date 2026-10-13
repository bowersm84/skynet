// purchasing.mjs — bridge v1.10 purchasing mirror (D-FB-55): Fishbowl purchase orders into SkyNet.
//
// Three reads per batch of PO ids: headers (po ⋈ vendor), lines (poitem ⋈ poitemtype) and receipts with their
// lot (receiptitem ⋈ trackinginfo, tableId 1259138490 'ReceiptItem' — the join of the 2026-10-14 Giza receipts
// pull, 35 of 35 lots found). A PO always travels whole — header, every line, every received receipt — so
// fb_upsert_purchasing can mark lines and receipts that left Fishbowl as removed.
//
// Same queue design as the shipments poller (D-FB-54): PO ids are queued by the window read (start-up, nightly
// and the one-shot: every PO created or issued in the last PURCHASING_WINDOW_DAYS, plus every PO not yet
// completed) and by the changed-PO poll (every PURCHASING_MS: POs whose header or receipts changed since the
// previous poll, with an overlap); each cycle reads at most PURCHASING_MAX_POS of them. Every write is an upsert,
// so re-reading is always safe.
//
// Status names come from postatus / poitemstatus. Those two tables are not in the 2026-10-14 schema check, so they
// are read once and, if either read fails, the mirror carries on with ids only (SkyNet's view falls back to the
// ids it knows). The mappers are pure so purchasing.test.mjs runs them under plain `node --test`.
import { q } from './queries.mjs'
import { chunk, int, num, ts, fbDateTime } from './mapper.mjs'
import { LOT_TRACKING_NAME, sweepSince } from './shipments.mjs'

const text = (v) => (v === null || v === undefined ? '' : String(v).trim())
const orNull = (v) => { const s = text(v); return s === '' ? null : s }

// Output keys are exactly what fb_upsert_purchasing reads (camelCase, like the other fb_upsert_* RPCs).
export function mapPurchaseOrder(r, names = new Map()) {
  const statusId = int(r.statusId)
  return {
    poId: int(r.poId),
    poNum: text(r.poNum),
    statusId,
    statusName: names.get(statusId) ?? null,
    typeId: int(r.typeId),
    vendorId: int(r.vendorId),
    vendorName: orNull(r.vendorName),
    vendorSo: orNull(r.vendorSo),
    buyer: orNull(r.buyer),
    locationGroupId: int(r.locationGroupId),
    dateCreated: ts(r.dateCreated),
    dateIssued: ts(r.dateIssued),
    dateConfirmed: ts(r.dateConfirmed),
    dateCompleted: ts(r.dateCompleted),
    dateLastModified: ts(r.dateLastModified),
  }
}

export function mapPurchaseLine(r, names = new Map()) {
  const statusId = int(r.statusId)
  return {
    poItemId: int(r.poItemId),
    poId: int(r.poId),
    poNum: text(r.poNum),
    lineNumber: int(r.lineNumber),
    typeId: int(r.typeId),
    typeName: orNull(r.typeName),
    statusId,
    statusName: names.get(statusId) ?? null,
    partId: int(r.partId),
    partNum: orNull(r.partNum),
    description: orNull(r.description),
    outsourcedPartNum: orNull(r.outsourcedPartNum),
    outsourcedDescription: orNull(r.outsourcedDescription),
    vendorPartNum: orNull(r.vendorPartNum),
    revLevel: orNull(r.revLevel),
    qtyToFulfill: num(r.qtyToFulfill),
    qtyFulfilled: num(r.qtyFulfilled),
    qtyPicked: num(r.qtyPicked),
    unitCost: num(r.unitCost),
    totalCost: num(r.totalCost),
    uomId: int(r.uomId),
    dateScheduled: ts(r.dateScheduled),
    dateLastFulfillment: ts(r.dateLastFulfillment),
  }
}

// Receipt rows arrive one per tracking value. Keep the lot rows of a received receipt item; a received item with
// no lot becomes one row with lotNumber ''. Items not yet received (no dateReceived) are not sent.
export function mapReceipts(rows) {
  const byItem = new Map()
  for (const r of rows || []) {
    const id = int(r.receiptItemId)
    if (id === null) continue
    if (!byItem.has(id)) byItem.set(id, [])
    byItem.get(id).push(r)
  }
  const out = []
  for (const [id, items] of byItem) {
    const first = items[0]
    const dateReceived = ts(first.dateReceived)
    if (!dateReceived) continue
    const base = {
      receiptItemId: id,
      poItemId: int(first.poItemId),
      poId: int(first.poId),
      poNum: text(first.poNum),
      partId: int(first.partId),
      partNum: orNull(first.partNum),
      qty: num(first.qty),
      statusId: int(first.statusId),
      dateReceived,
      dateLastModified: ts(first.dateLastModified),
    }
    const lots = items.filter((r) => text(r.trackingName).toLowerCase() === LOT_TRACKING_NAME.toLowerCase() && text(r.lotNumber) !== '')
    if (lots.length === 0) out.push({ ...base, lotNumber: '', lotQty: null })
    else for (const r of lots) out.push({ ...base, lotNumber: text(r.lotNumber), lotQty: num(r.lotQty) })
  }
  return out
}

// The window start as a local 'YYYY-MM-DD' (the bridge host's clock is Fishbowl's clock).
export function poWindowSince(now = new Date(), days = 365) {
  return sweepSince(now, Number(days) > 0 ? days : 365)
}

// The changed-PO poll's lower bound: the previous poll's start minus the overlap, as Fishbowl local time.
export function changedSince(prevStartMs, overlapMs = 1800000) {
  return fbDateTime(new Date(Number(prevStartMs) - Math.max(0, Number(overlapMs) || 0)))
}

// postatus / poitemstatus -> Map(id -> name). A table that cannot be read gives an empty map and one warning.
export async function loadStatusNames(fb, log) {
  const read = async (sql, label) => {
    try {
      const rows = await fb.query(sql)
      return new Map(rows.map((r) => [int(r.id), text(r.name)]).filter(([id, name]) => id !== null && name !== ''))
    } catch (e) {
      log.warn(`purchasing: ${label} names unavailable, mirroring ids only (${e.message})`)
      return new Map()
    }
  }
  const po = await read(q.poStatuses, 'PO status')
  const line = await read(q.poItemStatuses, 'PO line status')
  log.info(`purchasing: ${po.size} PO status name(s), ${line.size} line status name(s)`)
  return { po, line }
}

// Reads a set of PO ids whole and upserts them, batchPos POs per RPC call. Returns totals.
// dryRun: read and log (with five sample lines), write nothing.
export async function syncPurchasing(fb, sky, poIds, { log, names = { po: new Map(), line: new Map() }, batchPos = 100, dryRun = false } = {}) {
  const ids = [...new Set((poIds || []).map(Number).filter(Number.isFinite))]
  const totals = { pos: 0, lines: 0, receipts: 0, upserted: { orders: 0, lines: 0, receipts: 0, removed_lines: 0, removed_receipts: 0 } }
  if (ids.length === 0) return totals
  const samples = []
  for (const part of chunk(ids, Math.max(1, batchPos))) {
    const orders = (await fb.query(q.purchaseOrders(part))).map((r) => mapPurchaseOrder(r, names.po)).filter((o) => o.poId !== null && o.poNum !== '')
    const lines = (await fb.query(q.purchaseOrderLines(part))).map((r) => mapPurchaseLine(r, names.line)).filter((l) => l.poItemId !== null)
    const receipts = mapReceipts(await fb.query(q.purchaseReceipts(part)))
    totals.pos += orders.length
    totals.lines += lines.length
    totals.receipts += receipts.length
    if (dryRun) { if (samples.length < 5) samples.push(...lines.slice(0, 5 - samples.length)); continue }
    if (orders.length === 0) continue
    const r = await sky.upsertPurchasing(orders, lines, receipts)
    for (const k of Object.keys(totals.upserted)) totals.upserted[k] += Number(r?.[k]) || 0
  }
  const line = `purchasing: ${ids.length} PO(s) queued · ${totals.pos} read · ${totals.lines} line(s) · ${totals.receipts} receipt lot row(s)`
  if (dryRun) {
    log.info(`${line} · DRY RUN — nothing written`)
    for (const l of samples) log.info(`  e.g. PO ${l.poNum} line ${l.lineNumber} ${l.partNum || '-'} ${l.qtyFulfilled ?? 0}/${l.qtyToFulfill ?? 0} due ${l.dateScheduled || '-'} · ${l.typeName || l.typeId}`)
  } else {
    const u = totals.upserted
    log.info(`${line} · upserted ${u.orders} PO(s), ${u.lines} line(s), ${u.receipts} receipt row(s); marked removed ${u.removed_lines} line(s), ${u.removed_receipts} receipt row(s)`)
  }
  return totals
}
