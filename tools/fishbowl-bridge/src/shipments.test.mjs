// shipments.test.mjs — the shipments mapper, no I/O. Run: npm test (or node --test src/shipments.test.mjs)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mapShipmentLot, isLotRow, toPayload, sweepSince, summarizeAttach, LOT_TRACKING_NAME } from './shipments.mjs'
import { q } from './queries.mjs'

// A real row of the rev 5 pull (SO 18716 line 17), as Fishbowl's data-query returns it.
const RAW = {
  soNum: '18716', soStatus: '60', soItemId: '107329', soLine: '17', lineType: '10', productNum: 'SK40S5-2S',
  kitLine: '14', kitProductNum: 'SK203C172P4', kitQtyFulfilled: '7.000000000', kitMember: '1',
  shipNum: 'S18716', shipStatus: 'Shipped', dateShipped: '2026-08-26', shipItemId: '73919',
  qtyShipped: '182.000000000', trackingName: 'Lot Number', lotNumber: '8105', lotQty: '182.000000000',
}

test('a shipped kit-member lot maps to the RPC keys with Fishbowl strings coerced', () => {
  const m = mapShipmentLot(RAW)
  assert.equal(isLotRow(m), true)
  assert.deepEqual(toPayload(m), {
    shipItemId: 73919, lotNumber: '8105', soNum: '18716', soItemId: 107329, soLine: 17, productNum: 'SK40S5-2S',
    kitLine: 14, kitProductNum: 'SK203C172P4', kitMember: true, kitQtyFulfilled: 7, shipNum: 'S18716',
    shipStatus: 'Shipped', dateShipped: '2026-08-26', qtyShipped: 182, lotQty: 182,
  })
})

test('a loose line has no kit and no membership; an entered shipment keeps its status and no date', () => {
  const loose = mapShipmentLot({ ...RAW, kitLine: null, kitProductNum: null, kitMember: null, kitQtyFulfilled: null })
  assert.equal(loose.kitProductNum, null)
  assert.equal(loose.kitMember, null)
  const notInKit = mapShipmentLot({ ...RAW, kitMember: '0' })
  assert.equal(notInKit.kitMember, false)
  const entered = mapShipmentLot({ ...RAW, shipStatus: 'Entered', dateShipped: null, kitQtyFulfilled: '0E-9' })
  assert.equal(entered.shipStatus, 'Entered')
  assert.equal(entered.dateShipped, null)
  assert.equal(entered.kitQtyFulfilled, 0)
  assert.equal(mapShipmentLot({ ...RAW, dateShipped: '2026-09-15T15:07:49.018-04' }).dateShipped, '2026-09-15')
})

test('only lot-tracking rows with a lot, a ship item, an SO and a part are kept', () => {
  assert.equal(isLotRow(mapShipmentLot({ ...RAW, trackingName: 'Expiration Date' })), false)
  assert.equal(isLotRow(mapShipmentLot({ ...RAW, trackingName: 'lot number' })), true)
  assert.equal(isLotRow(mapShipmentLot({ ...RAW, lotNumber: null, trackingName: null })), false) // CUSTOMER NOTES
  assert.equal(isLotRow(mapShipmentLot({ ...RAW, shipItemId: null })), false)
  assert.equal(isLotRow(mapShipmentLot({ ...RAW, lotNumber: ' 0001 ' })), true)
  assert.equal(mapShipmentLot({ ...RAW, lotNumber: ' 0001 ' }).lotNumber, '0001')
  assert.equal(LOT_TRACKING_NAME, 'Lot Number')
})

test('the sweep window is a local date N days back; nonsense days fall back to 14', () => {
  const now = new Date(2026, 9, 9, 2, 10) // 2026-10-09 02:10 local
  assert.equal(sweepSince(now, 14), '2026-09-25')
  assert.equal(sweepSince(now, 1), '2026-10-08')
  assert.equal(sweepSince(now, 'x'), '2026-09-25')
  assert.equal(sweepSince(new Date(2026, 0, 3), 5), '2025-12-29')
})

test('the shipments query is the proven rev 5 join, scoped by numeric SO ids only', () => {
  const sql = q.shipmentLots([11765, '18716', 'x', null])
  assert.match(sql, /ti\.tableId = 1555030112/)
  assert.match(sql, /FROM kititem ki/)
  assert.match(sql, /so\.id IN \(11765,18716,0\)/)
  assert.doesNotMatch(sql, /'x'/)
  const since = q.recentShipmentSoIds('2026-09-25')
  assert.match(since, /ship\.dateShipped >= '2026-09-25'/)
  assert.throws(() => q.recentShipmentSoIds("2026-09-25' OR 1=1 --"))
})

test('the attach report becomes one log line', () => {
  const line = summarizeAttach({ dry_run: false, inserted_rows: 22, kit_lots_matched: 1, already_present: 2473, off_bom_rows: 0,
    unmatched_bench_lots: { not_shipped_yet: [4864, 4865] }, kits_shipped_vs_logged: ['18716 SK203C172P4: shipped 7, logged 6'] })
  assert.match(line, /22 row\(s\) attached to 1 kit lot\(s\)/)
  assert.match(line, /not_shipped_yet 2/)
  assert.match(line, /shipped-vs-logged lines 1/)
  assert.equal(summarizeAttach(null), 'attach: no report')
})
