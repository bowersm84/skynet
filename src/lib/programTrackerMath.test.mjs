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
eq(sortLots(lots).map(l => l.lot_number), ['3008', '3009', '3012', '3010', '3007', '3001', '3011'], 'register order')
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

console.log(`programTrackerMath: ${n} assertions passed`)
