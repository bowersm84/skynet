// purchasing.test.mjs — the purchasing mappers and query builders, no I/O. Run: npm test (or node --test src/purchasing.test.mjs)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mapPurchaseOrder, mapPurchaseLine, mapReceipts, poWindowSince, changedSince, syncPurchasing } from './purchasing.mjs'
import { q } from './queries.mjs'

// Real rows of the 2026-10-14 Giza pull (PO 260602-20 line 3, PO 4248), as Fishbowl's data-query returns them.
const PO = {
  poId: '4511', poNum: '260602-20', statusId: '40', typeId: '10', vendorId: '88', vendorName: 'Maxtrust Industries',
  vendorSo: '', buyer: 'nbowers', locationGroupId: '1', dateCreated: '2026-06-02T00:00:00.000-04',
  dateIssued: '2026-06-02T10:04:11.200-04', dateConfirmed: null, dateCompleted: '2026-10-07T11:37:19.430-04',
  dateLastModified: '2026-10-09T11:59:53.131-04',
}
const LINE = {
  poItemId: '9921', poId: '4511', poNum: '260602-20', lineNumber: '3', typeId: '10', typeName: 'Purchase', statusId: '10',
  partId: '7310', partNum: 'SK21077-5-3', description: 'Steel Nut Plate', outsourcedPartNum: null, outsourcedDescription: null,
  vendorPartNum: '', revLevel: 'E', qtyToFulfill: '30000.000000000', qtyFulfilled: '0E-9', qtyPicked: '0E-9',
  unitCost: '1.200000000', totalCost: '36000.000000000', uomId: '1',
  dateScheduled: '2027-01-08T11:59:21.192-05', dateLastFulfillment: null,
}
const RECEIPT = {
  receiptItemId: '30155', poItemId: '9990', poId: '4580', poNum: '4248', partId: '7400', partNum: 'MS21077-5',
  qty: '9829.000000000', statusId: '40', dateReceived: '2026-10-12T10:21:20.294-04', dateLastModified: '2026-10-12T10:21:20.294-04',
  trackingName: 'Lot Number', lotNumber: '52035', lotQty: '9829.000000000',
}

test('a PO header maps to the RPC keys, with the status name from postatus when known', () => {
  const m = mapPurchaseOrder(PO, new Map([[40, 'Partial']]))
  assert.equal(m.poId, 4511)
  assert.equal(m.poNum, '260602-20')
  assert.equal(m.statusId, 40)
  assert.equal(m.statusName, 'Partial')
  assert.equal(m.vendorName, 'Maxtrust Industries')
  assert.equal(m.vendorSo, null)
  assert.equal(m.dateIssued, '2026-06-02T10:04:11.200-04:00')
  assert.equal(m.dateConfirmed, null)
  assert.equal(mapPurchaseOrder(PO).statusName, null)
})

test('a PO line maps quantities as numbers and keeps the outsourced part when there is one', () => {
  const m = mapPurchaseLine(LINE, new Map([[10, 'Entered']]))
  assert.equal(m.poItemId, 9921)
  assert.equal(m.lineNumber, 3)
  assert.equal(m.qtyToFulfill, 30000)
  assert.equal(m.qtyFulfilled, 0)
  assert.equal(m.statusName, 'Entered')
  assert.equal(m.dateScheduled, '2027-01-08T11:59:21.192-05:00')
  assert.equal(m.outsourcedPartNum, null)
  const out = mapPurchaseLine({ ...LINE, typeId: '30', typeName: 'Out Sourced', partNum: 'MS21077-5', outsourcedPartNum: 'MS21077-5' })
  assert.equal(out.typeName, 'Out Sourced')
  assert.equal(out.outsourcedPartNum, 'MS21077-5')
})

test('receipts: one row per lot, a lot-less receipt becomes one row with an empty lot, unreceived items are dropped', () => {
  const rows = mapReceipts([
    RECEIPT,
    { ...RECEIPT, receiptItemId: '30156', trackingName: null, lotNumber: null, lotQty: null },
    { ...RECEIPT, receiptItemId: '30157', trackingName: 'Expiration Date', lotNumber: '2027-01-01' },
    { ...RECEIPT, receiptItemId: '30158', dateReceived: null },
    { ...RECEIPT, receiptItemId: '30159', lotNumber: 'A1', lotQty: '100' },
    { ...RECEIPT, receiptItemId: '30159', lotNumber: 'A2', lotQty: '50' },
  ])
  assert.deepEqual(rows.map((r) => [r.receiptItemId, r.lotNumber, r.lotQty]), [
    [30155, '52035', 9829], [30156, '', null], [30157, '', null], [30159, 'A1', 100], [30159, 'A2', 50],
  ])
  assert.equal(rows[0].dateReceived, '2026-10-12T10:21:20.294-04:00')
  assert.equal(rows[0].poNum, '4248')
})

test('the window is a local date N days back; the changed-PO bound is Fishbowl local time minus the overlap', () => {
  assert.equal(poWindowSince(new Date(2026, 9, 15, 2, 10), 365), '2025-10-15')
  assert.equal(poWindowSince(new Date(2026, 9, 15), 0), '2025-10-15')
  const since = changedSince(Date.UTC(2026, 9, 15, 14, 0, 0), 1800000)
  assert.equal(since, '2026-10-15 09:30:00') // 14:00 UTC = 10:00 EDT, minus 30 min
})

test('the queries are scoped by numeric ids only, use the proven receipt join, and refuse malformed dates', () => {
  const ids = [4511, '4580', 'x', null]
  assert.match(q.purchaseOrders(ids), /po\.id IN \(4511,4580,0\)/)
  assert.match(q.purchaseOrderLines(ids), /poi\.poId IN \(4511,4580,0\)/)
  const rec = q.purchaseReceipts(ids)
  assert.match(rec, /ti\.tableId = 1259138490/)
  assert.match(rec, /ti\.recordId = ri\.id/)
  assert.doesNotMatch(rec, /'x'/)
  assert.match(q.purchaseWindowIds('2025-10-15'), /po\.dateCompleted IS NULL/)
  assert.throws(() => q.purchaseWindowIds("2025-10-15' OR 1=1 --"))
  assert.match(q.purchaseChangedIds('2026-10-15 09:30:00'), /ri\.dateLastModified >= '2026-10-15 09:30:00'/)
  assert.throws(() => q.purchaseChangedIds('2026-10-15; DROP TABLE po'))
})

test('sync sends whole POs per call and adds up the RPC counts; a dry run writes nothing', async () => {
  const queries = []
  const fb = {
    query: async (sql) => {
      queries.push(sql)
      if (sql.includes('FROM po LEFT JOIN vendor')) return [PO]
      if (sql.includes('FROM poitem poi')) return [LINE]
      if (sql.includes('FROM receiptitem ri')) return [{ ...RECEIPT, poId: '4511', poItemId: '9921' }]
      return []
    },
  }
  const calls = []
  const sky = { upsertPurchasing: async (o, l, r) => { calls.push([o.length, l.length, r.length]); return { orders: 1, lines: 1, receipts: 1, removed_lines: 0, removed_receipts: 0 } } }
  const log = { info: () => {}, warn: () => {} }
  const t = await syncPurchasing(fb, sky, [4511], { log })
  assert.deepEqual(calls, [[1, 1, 1]])
  assert.deepEqual(t.upserted, { orders: 1, lines: 1, receipts: 1, removed_lines: 0, removed_receipts: 0 })
  calls.length = 0
  const d = await syncPurchasing(fb, sky, [4511], { log, dryRun: true })
  assert.equal(calls.length, 0)
  assert.equal(d.lines, 1)
  assert.equal(queries.length, 6)
})
