// Unit test for the Giza program tracker's pure helpers (S15, D-GIZA; branch model).
// Run: node src/lib/programTrackerMath.test.mjs

import assert from 'node:assert/strict'
import {
  FLOW_STAGES, THROUGHPUT_STAGES, STAGE_LABELS, addDays, lastNDays, ageDays, dailyMatrix, sevenDayRates, constrainingStage,
  forecast, ovenCapacity, inProcess, lotsReadyFor, previewRoute, selectableLots, sortLots, canReopen, bucketValues,
  componentLots, recentInitials, escapeHtml, lotLabelHtml,
} from './programTrackerMath.js'

let n = 0
const ok = (cond, msg) => { assert.ok(cond, msg); n++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++ }

// --- labels and stages
ok(!FLOW_STAGES.includes('bagged') && FLOW_STAGES.at(-1) === 'assembled', 'no bagged stage')
eq(STAGE_LABELS.washer_inserted, 'Insert nylon', 'Insert nylon label')
eq(STAGE_LABELS.received_nut, 'Steel nut receipt', 'Steel nut receipt label')
ok(THROUGHPUT_STAGES[0] === 'received_nut' && THROUGHPUT_STAGES.length === 7, 'throughput rows')

// --- dates, rates, forecast
eq(addDays('2026-10-31', 1), '2026-11-01', 'addDays month')
eq(lastNDays('2026-10-12', 3), ['2026-10-10', '2026-10-11', '2026-10-12'], 'lastNDays')
eq(ageDays('2026-10-01', '2026-10-12'), 11, 'ageDays')
const daily = [
  { d: '2026-10-12', stage: 'painted', qty: 618 }, { d: '2026-10-11', stage: 'painted', qty: 1236 },
  { d: '2026-10-01', stage: 'painted', qty: 9999 }, { d: '2026-10-12', stage: 'baked', qty: '700' },
]
eq(dailyMatrix(daily, ['painted', 'baked'], lastNDays('2026-10-12', 3)), { painted: [0, 1236, 618], baked: [0, 0, 700] }, 'dailyMatrix')
ok(Math.abs(sevenDayRates(daily, '2026-10-12').painted - 1854 / 7) < 1e-9, '7-day rate')
eq(constrainingStage({ washer_inserted: 500, sent_plating: 400, returned_plating: 300, painted: 265, baked: 100, assembled: 10 }), { stage: 'assembled', rate: 10 }, 'constraint')
eq(forecast(1000, 100, '2026-10-12'), { days: 10, date: '2026-10-22' }, 'forecast')
eq(forecast(500, 0, '2026-10-12'), null, 'no rate → null')
eq(ovenCapacity(2, 618, 4), 4944, 'oven capacity')

// --- lots
const L = (no, extra) => ({ id: `id${no}`, lot_number: String(no), status: 'active', waiting_insert: 0, waiting_plating: 0, at_electrolab: 0,
  waiting_paint: 0, in_paint: 0, in_oven: 0, waiting_assembly: 0, assembled_qty: 0, ...extra })
const lots = [
  L(3007, { status: 'closed', nut_lot: '51999', insert_lot: '51853', plating_lot: '52030', finishing_lot: 'FLN-100263', cage_lot: '51889', retainer_lot: '51873', assembled_qty: 298, waiting_assembly: 12 }),
  L(3008, { nut_lot: '51999', insert_lot: '51854', waiting_plating: 400 }),
  L(3009, { nut_lot: '51999', insert_lot: '51853', plating_lot: '52031', waiting_paint: 150, in_oven: 50 }),
  L(3010, { status: 'closed', assembled_qty: 100 }),
  L(3011, { status: 'void' }),
  L(3012, { status: 'active', parent_lot_id: 'id3010', split_reason: 'after_close' }),
  L(3001, { status: 'historical', quantity: 835 }),
]
eq(inProcess(lots[2]), 200, 'inProcess sums the upstream buckets')
eq(lotsReadyFor(lots, 'sent_plating').map(x => [x.lot, x.qty]), [['3008', 400]], 'ready to send')
eq(lotsReadyFor(lots, 'assembled').map(x => [x.lot, x.qty]), [['3007', 12]], 'closed lot with leftovers is ready (continues as a new lot)')
eq(lotsReadyFor(lots, 'painted'), [], 'kiosk stages are not logged here')
eq(selectableLots(lots).map(l => l.lot_number), ['3007', '3008', '3009', '3012'], 'selector: active + closed with pieces in process')
eq(sortLots(lots).map(l => l.lot_number), ['3012', '3010', '3009', '3008', '3007', '3001', '3011'], 'register order: newest first, void last')
eq(sortLots([{ lot_number: '3005', status: 'historical' }, { lot_number: '3007', status: 'active' }, { lot_number: '3005-2', status: 'historical' },
              { lot_number: '3007-VOID', status: 'void' }, { lot_number: '3006', status: 'active' }, { lot_number: '3001', status: 'historical' }]).map(l => l.lot_number),
   ['3007', '3006', '3005-2', '3005', '3001', '3007-VOID'], 'register order: PROD today')
eq(canReopen(lots[0], lots), true, '3007 reopenable')
eq(canReopen(lots[3], lots), false, '3010 not reopenable once its leftovers continued as 3012')
eq(canReopen(lots[1], lots), false, 'active lot is not reopened')

// --- previewRoute mirrors _program_route
eq(previewRoute(lots[1], 'washer_inserted', { insert_lot: '51854' }), { split: false }, 'same nylon lot stays')
eq(previewRoute(lots[1], 'washer_inserted', { insert_lot: '51853' }), { split: true, reason: 'nylon_lot' }, 'other nylon lot splits')
eq(previewRoute(lots[1], 'returned_plating', { plating_lot: '52040' }), { split: false }, 'first plating lot fills the lot')
eq(previewRoute(lots[2], 'returned_plating', { plating_lot: '52030' }), { split: true, reason: 'plating_lot' }, 'other plating lot splits')
eq(previewRoute(lots[2], 'assembled', { cage_lot: 'A', retainer_lot: 'B' }), { split: false }, 'first cage/retainer fill the lot')
eq(previewRoute({ ...lots[2], cage_lot: 'A', retainer_lot: 'B' }, 'assembled', { cage_lot: 'C', retainer_lot: 'B' }), { split: true, reason: 'cage_lot' }, 'cage split')
eq(previewRoute({ ...lots[2], cage_lot: 'A', retainer_lot: 'B' }, 'assembled', { cage_lot: 'C', retainer_lot: 'D' }), { split: true, reason: 'component_lots' }, 'both split')
eq(previewRoute(lots[0], 'sent_plating', {}), { split: true, reason: 'after_close' }, 'closed lot continues as new')
eq(previewRoute(null, 'sent_plating', {}), { split: false }, 'no lot → no preview')

// --- buckets
eq(bucketValues({ waiting_washer: 5, waiting_ship: 70, shipped_since_start: 30 }, null).assembled, 70, 'All view: assembled awaiting ship')
eq(bucketValues({}, lots[2]), { receipt: 0, nylon: 0, electrolab: 0, plating: 150, paint: 0, oven: 50, baked: 0, assembled: 0, shipped: null }, 'lot view buckets')

// --- components, initials, label
const ledger = [
  { stage: 'received', part_id: 'cage', lot_number: '51889', qty: 2000, entry_date: '2026-10-01' },
  { stage: 'received', part_id: 'cage', lot_number: '51900', qty: 500, entry_date: '2026-10-08' },
  { stage: 'received', part_id: 'cage', lot_number: 'X', qty: 5, entry_date: '2026-10-09', voided_at: '2026-10-09T00:00:00Z' },
  { stage: 'washer_inserted', done_by: 'ncb' }, { stage: 'assembled', done_by: 'DD' },
]
eq(componentLots(ledger, 'cage').map(x => [x.lot, x.qty]), [['51900', 500], ['51889', 2000]], 'component lots newest first, voids excluded')
eq(recentInitials(ledger), ['NCB', 'DD'], 'initials')
eq(escapeHtml('<b>&'), '&lt;b&gt;&amp;', 'escape')
const html = lotLabelHtml({ lotNumber: '3007', partLabel: 'MS21077-5', qty: 1570, dateText: '10/12/26' })
ok(html.includes('>3007<') && html.includes('1,570') && html.includes('#B8222E') && html.includes('Arial'), 'label')

// --- Movements report (D-GIZA-29)
{
  const { lastWorkingDay, dayMovements, movementsReportHtml, MOVEMENT_STEPS } = await import('./programTrackerMath.js')
  eq(lastWorkingDay('2026-10-14'), '2026-10-13', 'Wednesday -> Tuesday')
  eq(lastWorkingDay('2026-10-12'), '2026-10-09', 'Monday -> Friday')
  eq(lastWorkingDay('2026-10-11'), '2026-10-09', 'Sunday -> Friday')
  const day = '2026-10-13'
  const NUT = 'nut-id'
  const ledger = [
    { id: 'a', stage: 'received', part_id: NUT, qty: 11100, entry_date: '2026-10-13', created_at: '2026-10-13T15:19:00Z', to_lot: { lot_number: '3007' }, from_lot: { lot_number: '3007' } },
    { id: 'b', stage: 'received', part_id: 'cage-id', qty: 5011, entry_date: '2026-10-13', created_at: '2026-10-13T18:00:00Z' },
    { id: 'c', stage: 'washer_inserted', part_id: NUT, qty: 11126, entry_date: '2026-10-13', created_at: '2026-10-13T16:23:00Z' },
    { id: 'd', stage: 'washer_inserted', part_id: NUT, qty: 10825, entry_date: '2026-10-13', created_at: '2026-10-13T15:19:00Z', voided_at: '2026-10-13T16:20:00Z', void_reason: 'WRONG COUNT' },
    { id: 'e', stage: 'sent_plating', part_id: NUT, qty: 9829, entry_date: '2026-10-02', created_at: '2026-10-13T12:24:00Z' },
    { id: 'f', stage: 'assembled', part_id: NUT, qty: 500, entry_date: '2026-10-12', created_at: '2026-10-12T20:00:00Z' },
  ]
  const sends = [
    { id: 's1', status: 'complete', finishing_started_at: '2026-10-13T11:46:00Z', finishing_completed_at: '2026-10-13T16:10:00Z', incoming_count: 2016, verified_count: 2010 },
    { id: 's2', status: 'in_finishing', finishing_started_at: '2026-10-13T19:00:00Z', incoming_count: 1200 },
  ]
  const shipments = [{ date_shipped: '2026-10-13', ship_status: 'Shipped', lot_qty: 300, lot_number: '3006', so_number: '15548', so_line: 3, ship_number: 'S15548-06' },
                     { date_shipped: '2026-10-13', ship_status: 'Entered', lot_qty: 50 }]
  const purchasing = [{ po_number: '260602-20', vendor_name: 'Maxtrust Industries', part_num: 'SK21077-5-3', role: 'nut',
                        receipts: [{ date: '2026-10-13', qty: 10000, lot: '52029' }, { date: '2026-10-09', qty: 1, lot: 'x' }] }]
  const m = dayMovements({ ledger, sends, shipments, purchasing }, day, NUT)
  const s = Object.fromEntries(m.summary.map(x => [x.key, [x.count, x.qty]]))
  eq(m.summary.map(x => x.key), MOVEMENT_STEPS.map(x => x[0]), 'summary has every step in order')
  eq(s.received_nut, [1, 11100], 'nut receipt')
  eq(s.received_component, [1, 5011], 'component receipt')
  eq(s.washer_inserted, [1, 11126], 'voided entry not counted')
  eq(s.sent_plating, [0, 0], 'move dated earlier is not that day')
  eq(s.painted, [2, 3216], 'painted = batches started, pieces in')
  eq(s.baked, [1, 2010], 'baked = completed batches, verified out')
  eq(s.shipped, [1, 300], 'only Shipped shipments')
  eq(s.po_received, [1, 10000], 'PO receipts that day')
  eq(m.voids.map(v => v.id), ['d'], 'void listed on the day it was voided')
  eq(m.late.map(v => v.id), ['e'], 'logged that day for an earlier date')
  eq(m.empty, false, 'not empty')
  eq(dayMovements({ ledger, sends, shipments, purchasing }, '2026-10-10', NUT).empty, true, 'empty day')
  const html = movementsReportHtml({ programName: 'Giza - MS21077-5 nutplate', data: m, generatedAt: '10/14/2026 7:00 AM' })
  ok(html.includes('Tuesday, October 13, 2026') && html.includes('#B8222E') && html.includes('Arial') && html.includes('WRONG COUNT')
     && html.includes('S15548-06') && html.includes('52029') && html.includes('11,126'), 'report html')
  ok(!html.includes('<script'), 'report has no script tags')
  ok(movementsReportHtml({ data: dayMovements({}, '2026-10-10', NUT) }).includes('Nothing was logged'), 'empty report')
}

// --- Purchasing (D-GIZA-30)
{
  const { sortPurchasing, purchasingSummary } = await import('./programTrackerMath.js')
  const lines = [
    { po_number: '4207', line_number: 1, role: 'cage', is_open: false, last_received_date: '2026-10-01', qty_remaining: 0 },
    { po_number: '260602-20', line_number: 3, role: 'nut', is_open: true, is_late: false, due_date: '2027-01-08', qty_remaining: 30000 },
    { po_number: '4260', line_number: 1, role: 'assembly', is_open: true, is_late: true, due_date: '2026-10-10', qty_remaining: 11126 },
    { po_number: '4300', line_number: 1, role: 'nut', is_open: true, is_late: false, due_date: '2026-11-01', qty_remaining: 5000 },
  ]
  eq(sortPurchasing(lines).map(l => l.po_number), ['4260', '4300', '260602-20'], 'open only: late first, then by due date')
  eq(sortPurchasing(lines, true).map(l => l.po_number), ['4260', '4300', '260602-20', '4207'], 'all: closed last')
  eq(purchasingSummary(lines), [
    { role: 'assembly', remaining: 11126, lines: 1, late: 1, nextDue: '2026-10-10' },
    { role: 'nut', remaining: 35000, lines: 2, late: 0, nextDue: '2026-11-01' },
  ], 'summary by role, open lines only')
}

console.log(`programTrackerMath: ${n} assertions passed`)
