// Unit test for src/lib/fbStock.js — S13 D-FBINV-03.
// Run: node src/lib/fbStock.test.mjs
//
// Fixtures are shaped like v_report_fb_stock_on_hand / v_report_fb_reorder_status rows and
// taken from PROD on 2026-10-06 after bridge 1.8.0: SK2600CGP174 is the one rule below its
// minimum (126,985 on hand, min 150,000, 100,000 on order); SK2FW2SE is parked with no min.

import assert from 'node:assert/strict'
import {
  REORDER_CATEGORIES, isStale, freshness, parseFlags, STOCK_FILTERS, matchesStockFilter, filterStockRows,
  stockFilterCounts, sortRows, stockTotals, reorderView, groupByCategory, partKey, parseMinQty, likePattern,
} from './fbStock.js'

let n = 0
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++ }
const ok = (c, msg) => { assert.ok(c, msg); n++ }

const LAST = '2026-10-06T20:37:49Z'
const rows = [
  { part_number: 'SK2600CGP174', description: 'SK2600 SERIES PIN 17-4', on_hand: 126985, allocated: 1370, available: 125615, on_order: 100000, avg_cost: 0.0505, est_value: 6412.74, min_qty: 150000, reorder_status: 'below', flags: 'count_first', inventory_as_of: '2026-10-06T20:37:40Z' },
  { part_number: 'SK4000-3S', description: '4000 Series #3 Spring', on_hand: 813104, allocated: 160, available: 812944, on_order: 0, avg_cost: 0.0381, est_value: 30979.26, min_qty: 200000, reorder_status: 'ok', flags: 'count_first', inventory_as_of: '2026-10-06T20:37:40Z' },
  { part_number: 'SK2FW2SE', description: 'Wing Enhanced', on_hand: 9625, allocated: 0, available: 9625, on_order: 0, avg_cost: 0.0892, est_value: 858.55, min_qty: null, reorder_status: 'no_min', flags: '', inventory_as_of: '2026-10-06T20:37:40Z' },
  { part_number: 'SK4CWING3', description: '4000 SERIES WING - STAINLESS', on_hand: 23552, allocated: 0, available: 23552, on_order: 0, avg_cost: 0, est_value: 0, min_qty: 5000, reorder_status: 'ok', flags: 'zero_cost', inventory_as_of: '2026-10-06T20:37:40Z' },
  { part_number: 'QL10C-0PH', description: 'Quad Lead', on_hand: 0, allocated: 0, available: 0, on_order: 0, avg_cost: null, est_value: 0, min_qty: null, reorder_status: null, flags: '', inventory_as_of: '2026-10-06T20:37:40Z' },
  { part_number: 'SK244-16SENC', description: 'old', on_hand: 0, allocated: 0, available: 0, on_order: 0, avg_cost: null, est_value: 0, min_qty: null, reorder_status: null, flags: 'inactive', inventory_as_of: '2026-10-06T14:56:04Z' },
]

// --- staleness and freshness
eq(isStale('2026-10-06T14:56:04Z', LAST), true, 'a row hours behind the cycle is stale')
eq(isStale('2026-10-06T20:37:40Z', LAST), false, 'a row from the same cycle is current')
eq(isStale('2026-10-06T20:28:00Z', LAST), false, 'under 10 minutes behind is still current')
eq(isStale(null, LAST), false, 'no snapshot is "nightly", not stale')
eq(isStale('2026-10-06T14:56:04Z', null), false, 'no cycle clock means nothing can be called stale')
const fr = freshness({ last_inventory_at: LAST, last_valuation_at: '2026-10-06T06:10:00Z' }, Date.parse(LAST) + 4 * 60000)
eq([fr.ageMs, fr.amber], [4 * 60000, false], '4 minutes old is fine')
eq(freshness({ last_inventory_at: LAST }, Date.parse(LAST) + 16 * 60000).amber, true, '16 minutes old is amber')
eq(freshness(null).amber, true, 'no sync state is amber')

// --- flags and filters
eq(parseFlags('zero_cost  count_first'), ['zero_cost', 'count_first'], 'flags split on whitespace')
eq(parseFlags(null), [], 'null flags are none')
eq(STOCK_FILTERS[0].key, 'in_stock', 'in stock is the default filter')
eq(filterStockRows(rows).map(r => r.part_number), ['SK2600CGP174', 'SK4000-3S', 'SK2FW2SE', 'SK4CWING3'], 'default view hides zero stock')
eq(filterStockRows(rows, { filter: 'below' }).map(r => r.part_number), ['SK2600CGP174'], 'below min')
eq(filterStockRows(rows, { filter: 'critical' }).length, 4, 'critical = any row carrying a rule, no_min included')
eq(filterStockRows(rows, { filter: 'zero' }).map(r => r.part_number), ['QL10C-0PH', 'SK244-16SENC'], 'zero stock')
eq(filterStockRows(rows, { filter: 'no_cost' }).map(r => r.part_number), ['SK4CWING3'], '$0 cost')
eq(filterStockRows(rows, { filter: 'all', search: 'wing' }).map(r => r.part_number), ['SK2FW2SE', 'SK4CWING3'], 'search hits description and part number')
eq(filterStockRows(rows, { filter: 'all', search: 'sk2600' }).length, 1, 'search is case-insensitive')
const counts = stockFilterCounts(rows)
eq([counts.in_stock, counts.all, counts.critical, counts.below, counts.zero, counts.no_cost], [4, 6, 4, 1, 2, 1], 'filter chip counts')
eq(stockFilterCounts(rows, 'spring').all, 1, 'chip counts follow the search box')
ok(matchesStockFilter({ on_hand: '12.5' }, 'in_stock'), 'string quantities from PostgREST numeric still filter')

// --- sorting
eq(sortRows(rows, 'est_value', 'desc').slice(0, 3).map(r => r.part_number), ['SK4000-3S', 'SK2600CGP174', 'SK2FW2SE'], 'value descending')
eq(sortRows(rows, 'avg_cost', 'asc').slice(-2).map(r => r.part_number), ['QL10C-0PH', 'SK244-16SENC'], 'null costs sort last ascending')
eq(sortRows(rows, 'avg_cost', 'desc').slice(-2).map(r => r.part_number), ['QL10C-0PH', 'SK244-16SENC'], 'and last descending')
eq(sortRows(rows, 'part_number', 'asc')[0].part_number, 'QL10C-0PH', 'text sort')
eq(sortRows([{ part_number: 'SK4C10', on_hand: 1 }, { part_number: 'SK4C2', on_hand: 1 }], 'on_hand').map(r => r.part_number), ['SK4C2', 'SK4C10'], 'ties fall back to natural part order')

// --- totals
eq(stockTotals(filterStockRows(rows)), { parts: 4, value: 38250.55, zeroCost: 1 }, 'totals of the in-stock view')
eq(stockTotals([]), { parts: 0, value: 0, zeroCost: 0 }, 'empty totals')

// --- reorder view
const below = reorderView({ is_active: true, alert_state: 'below', min_qty: 150000 }, { on_hand: 126985, on_order: 100000 })
eq([below.state, below.label, below.shortfall, below.onOrderCovers], ['below', 'Below min', 23015, true], 'SK2600CGP174: short 23,015, covered by the 100,000 on order')
const shortNoPo = reorderView({ is_active: true, alert_state: 'below', min_qty: 25000 }, { on_hand: 2967, on_order: 0 })
eq([shortNoPo.shortfall, shortNoPo.onOrderCovers], [22033, false], 'below with nothing on order')
eq(reorderView({ is_active: true, alert_state: 'no_min', min_qty: null }, { on_hand: 9625 }).label, 'No min set', 'parked rule')
eq(reorderView({ is_active: false, alert_state: 'below', min_qty: 10 }, { on_hand: 1 }).state, 'inactive', 'inactive wins over the stored state')
eq(reorderView({ is_active: true, alert_state: 'ok', min_qty: 5000 }, { on_hand: 1 }).shortfall, 0, 'the UI never re-derives below: alert_state is authoritative')
eq(reorderView({ is_active: true, alert_state: 'no_row', min_qty: 10 }, null).label, 'Not in Fishbowl', 'no 5-minute row')

// --- grouping
const groups = groupByCategory([
  { part_num: 'SK26C1', category: 'Cups' }, { part_num: 'SK-T26P', category: 'Misc.' }, { part_num: 'SK26C', category: 'Cups' },
  { part_num: 'X1', category: 'Zebra' }, { part_num: 'SK4000CGP81', category: 'Pins' }, { part_num: 'A', category: null },
])
eq(groups.map(g => g.category), ['Cups', 'Pins', 'Misc.', 'Zebra'], 'sheet order, unknown categories after, null filed as Misc.')
eq(groups[0].items.map(r => r.part_num), ['SK26C', 'SK26C1'], 'parts natural-sorted in a category')
eq(groups[2].items.length, 2, 'null category joins Misc.')
eq(REORDER_CATEGORIES.length, 9, 'nine sheet categories')

// --- small parsers
eq(partKey('  sk201/203 Clip '), 'SK201/203 CLIP', 'part key = upper(btrim()) as the generated column')
eq(parseMinQty(''), { ok: true, value: null }, 'blank min parks the rule')
eq(parseMinQty('150,000'), { ok: true, value: 150000 }, 'commas allowed')
eq(parseMinQty('-1').ok, false, 'negative refused')
eq(parseMinQty('abc').ok, false, 'text refused')
eq(likePattern('SK244_16%'), '%SK244\\_16\\%%', 'ilike wildcards are escaped')

console.log(`fbStock: ${n} assertions passed`)
