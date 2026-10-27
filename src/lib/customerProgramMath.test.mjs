// Unit test for the Customer Program Dashboard's pure helpers (S16, D-CPROG).
// Run: node src/lib/customerProgramMath.test.mjs
// Fixtures are the Kaytech opening position of 2026-10-27 (PROD numbers).

import assert from 'node:assert/strict'
import {
  moneyPosition, depositForPo, lotTable, stageTotalsByPart, lineView, creditPlan, daysBetween, round2,
} from './customerProgramMath.js'

let n = 0
const ok = (cond, msg) => { assert.ok(cond, msg); n++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++ }

const TODAY = '2026-10-27'
const program = { credit_limit: 50000, past_due_grace_days: 30 }

// --- money
const moneyRows = [
  { id: 'd0', kind: 'deposit_request', amount: 41670, po_number: '165251', txn_date: '2026-10-01', voided_at: '2026-10-27T12:00:00Z' },
  { id: 'd1', kind: 'deposit_request', amount: 41670, po_number: '165251', txn_date: '2026-10-27' },
  { id: 'd2', kind: 'deposit_request', amount: 1359.02, po_number: '165058', txn_date: '2026-10-27' },
  { id: 'd3', kind: 'deposit_request', amount: 16425, po_number: '165184', txn_date: '2026-10-27' },
  { id: 'i1', kind: 'invoice', amount: 2704, po_number: '165240', txn_date: '2026-10-08', due_date: '2026-11-07', reference: 'Shipment Oct 8' },
  { id: 'i2', kind: 'invoice', amount: 572, po_number: '165287', txn_date: '2026-10-15', due_date: '2026-11-14', reference: 'Shipment Oct 15' },
]
const pos = moneyPosition(moneyRows, TODAY)
eq(pos.openAR, 3276, 'open invoices = $3,276.00')
eq(pos.depositsRequested, 59454.02, 'live deposit requests = $59,454.02 (voided Oct 1 row excluded)')
eq(pos.depositsReceived, 0, 'nothing received yet')
eq(pos.pastDue.length, 0, 'nothing past due on Oct 27')
eq(round2(depositForPo(pos, '165251').requested + depositForPo(pos, '165058').requested), 43029.02, 'QL4-21 deposit = $43,029.02')

// a payment applied to an invoice reduces it; a partial deposit shows as received
const pos2 = moneyPosition([...moneyRows,
  { id: 'p1', kind: 'payment', amount: 2704, applies_to: 'i1', txn_date: '2026-11-01' },
  { id: 'p2', kind: 'payment', amount: 10000, applies_to: 'd3', txn_date: '2026-11-01' },
], TODAY)
eq(pos2.openAR, 572, 'paid invoice drops out of open AR')
eq(depositForPo(pos2, '165184'), { requested: 16425, received: 10000, open: 6425, rows: depositForPo(pos2, '165184').rows }, 'partial deposit')

// past due
const late = moneyPosition(moneyRows, '2026-12-20')
eq(late.pastDue.map(i => [i.id, i.daysPastDue]), [['i1', 43], ['i2', 36]], 'days past due')
eq(daysBetween('2026-11-07', '2026-12-20'), 43, 'daysBetween')

// --- lots
const balances = [
  { part_num: 'QL8C78', lot_number: 'JP4146R', stage: 'ready', qty: 700, last_move: TODAY },
  { part_num: 'QL8C78', lot_number: 'JP4147R', stage: 'ready', qty: 400, last_move: TODAY },
  { part_num: 'QL8C78', lot_number: '4142', stage: 'rework', qty: 566, last_move: TODAY },
  { part_num: 'QL8C78', lot_number: '4144', stage: 'rework', qty: 254, last_move: TODAY },
  { part_num: 'QL8C78', lot_number: '4149', stage: 'rework', qty: 830, last_move: TODAY },
]
const lots = lotTable(balances)
eq(lots.map(l => l.lot_number), ['4142', '4144', '4149', 'JP4146R', 'JP4147R'], 'lot order')
eq(lots.reduce((s, l) => s + l.onHand, 0), 2750, 'on hand 1,100 ready + 1,650 rework')
const stagesQL8 = stageTotalsByPart(balances).QL8C78
eq([stagesQL8.ready, stagesQL8.rework], [1100, 1650], 'stage totals')

// --- lines (PROD open lines)
const lines = [
  { fb_soitem_id: 1, so_number: '16182', customer_po: '165184', product_num: 'QL4S-RET1', qty_ordered: 25000, qty_fulfilled: 0, qty_open: 25000, unit_price: 2.19, open_value: 54750, flow: 'buyin', terms: 'deposit', fb_on_hand: 0, effective_due_date: '2026-12-01' },
  { fb_soitem_id: 2, so_number: '15392', customer_po: '165058', product_num: 'QL4-21', qty_ordered: 1000, qty_fulfilled: 699, qty_open: 301, unit_price: 15.05, open_value: 4530.05, flow: 'build', terms: 'deposit', fb_on_hand: 0, effective_due_date: '2026-12-30' },
  { fb_soitem_id: 3, so_number: '15968', customer_po: '165251', product_num: 'QL4-21', qty_ordered: 10000, qty_fulfilled: 0, qty_open: 10000, unit_price: 13.89, open_value: 138900, flow: 'build', terms: 'deposit', fb_on_hand: 0, effective_due_date: '2026-04-01' },
  { fb_soitem_id: 4, so_number: '8291', customer_po: '162948', product_num: 'QL8C78', qty_ordered: 2500, qty_fulfilled: 477, qty_open: 2023, unit_price: 20.15, open_value: 40763.45, flow: 'stock', terms: 'net30', fb_on_hand: 2807, effective_due_date: '2025-04-07' },
  { fb_soitem_id: 5, so_number: '15516', customer_po: '165128', product_num: 'QL4S-ET2', qty_ordered: 1000, qty_fulfilled: 0, qty_open: 1000, unit_price: 11.34, open_value: 11340, flow: 'build', terms: 'net30', fb_on_hand: 0, effective_due_date: '2026-12-09' },
  { fb_soitem_id: 6, so_number: '15933', customer_po: '165240', product_num: 'SK26S8-5', qty_ordered: 1000, qty_fulfilled: 800, qty_open: 200, unit_price: 3.38, open_value: 676, flow: 'build', terms: 'net30', fb_on_hand: 0, effective_due_date: '2026-03-31' },
]
const ql4Components = [
  { part_num: 'QL4C-CAGE', qty_per: 1, on_hand: 0, on_order: 0 },
  { part_num: 'QL4-BASE', qty_per: 1, on_hand: 10344, on_order: 0 },
  { part_num: 'QL4-NUT', qty_per: 1, on_hand: 8474, on_order: 0 },
]
const views = {}
for (const l of lines) {
  views[l.fb_soitem_id] = lineView(l, {
    deposit: depositForPo(pos, l.customer_po),
    lotStages: l.flow === 'stock' ? stagesQL8 : undefined,
    components: l.product_num === 'QL4-21' ? ql4Components : [],
    workOrders: [],
    openPoQty: 0,
  })
}
ok(views[3].blocker.startsWith('Deposit: Waiting on the $41,670.00 deposit'), `QL4-21 10k blocker is the deposit: ${views[3].blocker}`)
const comp3 = views[3].stages.find(s => s.key === 'components')
ok(comp3.state === 'blocked' && comp3.detail.startsWith('QL4C-CAGE: 0 on hand, 0 on order (need 10,000)'), 'cage shortage shown')
ok(comp3.detail.includes('QL4-NUT: 8,474 on hand') && !comp3.detail.includes('QL4-BASE'), 'nut short for 10k, base covers')
eq(views[3].stages.map(s => s.key), ['drawing', 'deposit', 'components', 'production', 'ready', 'balance', 'shipped'], 'build stage order')
eq(views[4].readyQty, 1100, 'QL8C78 ready = 1,100 from lots, not Fishbowl on hand')
eq(views[4].releasableValue, 22165, 'QL8C78 releasable $22,165.00')
eq(views[4].stages.find(s => s.key === 'coverage'), undefined, 'QL8C78 fully covered by lots')
ok(views[1].blocker.startsWith('Deposit: Waiting on the $16,425.00 deposit'), 'RET1 blocker is the deposit')
eq(views[1].stages.find(s => s.key === 'supplier').state, 'todo', 'RET1 not ordered from the supplier')

// a hold note overrides the derived blocker
eq(lineView({ ...lines[3], hold_note: 'Confirm stud configuration' }, { lotStages: stagesQL8 }).blocker, 'Hold: Confirm stud configuration', 'hold note')

// --- credit plan
const plan = creditPlan(lines, views, pos, program)
eq(plan.openAR, 3276, 'plan AR')
eq(plan.totalOnTerms, 52779.45, 'orders on terms total (workbook)')
eq(plan.exposureIfAllShipped, 56055.45, 'exposure if everything shipped at once (workbook)')
eq(plan.byLine[4].status, 'can_ship', 'QL8C78 1,100 can ship')
eq(plan.afterReleases, 25441, 'open balance after the 1,100 ship = $25,441.00')
eq(plan.byLine[5].status, 'building', 'QL4S-ET2 nothing ready')
eq(plan.byLine[3].status, 'deposit', 'deposit lines never draw on the line')

// all 2,023 ready → $40,763.45 still fits ($44,039.45)
const allReady = { ...stagesQL8, ready: 2023, rework: 0 }
const v4b = lineView(lines[3], { lotStages: allReady })
const plan2 = creditPlan(lines, { ...views, 4: v4b }, pos, program)
eq(plan2.afterReleases, 44039.45, 'all QL8C78 fits at $44,039.45')

// a past-due invoice beyond grace holds every net 30 line
const plan3 = creditPlan(lines, views, moneyPosition(moneyRows, '2026-12-20'), program)
eq(plan3.byLine[4].status, 'hold', 'over-grace invoice holds QL8C78')
ok(plan3.byLine[4].reason.includes('43 days past due'), 'hold names the worst invoice')

// over the line
const bigAR = moneyPosition([...moneyRows, { id: 'i3', kind: 'invoice', amount: 40000, txn_date: TODAY, due_date: '2026-11-26' }], TODAY)
const plan4 = creditPlan(lines, views, bigAR, program)
eq(plan4.byLine[4].status, 'hold', 'release over the line waits for payment')

console.log(`customerProgramMath: ${n} assertions passed`)
