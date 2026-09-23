// Unit test for the inventory poller's arithmetic (D-FB-40).
// Run: node tools/fishbowl-bridge/src/inventory.test.mjs
//
// inventory.mjs has no imports and no I/O, so unlike pricing.js it loads straight into Node with no
// shim. Fixtures are shaped like `q.inventory` results: one row per part per location group, LEFT
// JOINed from `part`, so a part with no stock record appears once with a null locationGroupId.

import assert from 'node:assert/strict'
import { aggregateInventory, countZeroRows } from './inventory.mjs'

let n = 0
const ok = (cond, msg) => { assert.ok(cond, msg); n++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++ }

const GROUPS = [1, 6]   // AVAILABLE_LOCATION_GROUPS default: Main + Warehouse (D-FB-33)
const row = (partId, partNum, locationGroupId, qtyOnHand = 0, qtyAllocated = 0, qtyNotAvailable = 0, qtyOnOrder = 0) =>
  ({ partId, partNum, locationGroupId, qtyOnHand, qtyAllocated, qtyNotAvailable, qtyOnOrder })

const byNum = (payload) => Object.fromEntries(payload.map(p => [p.partNum, p]))

// ── multi-group sum ─────────────────────────────────────────────────────────────────────────────
{
  const out = aggregateInventory([
    row(10, 'SK26FB', 1, 30000, 1200, 433, 0),
    row(10, 'SK26FB', 6, 3633, 0, 0, 0),
  ], GROUPS)
  eq(out.length, 1, 'two location groups collapse into one payload row')
  const p = out[0]
  eq(p.onHand, 33633, 'on hand sums across groups')
  eq(p.allocated, 1200, 'so does allocated')
  eq(p.notAvailable, 433, 'and not available')
  eq(p.available, 30000 - 1200 - 433 + 3633, 'available is on hand − allocated − not available, per group')
  eq(Object.keys(p.byLocation).sort(), ['1', '6'], 'every group is kept for the tooltip')
  eq(p.byLocation[6], { onHand: 3633, allocated: 0, notAvailable: 0, onOrder: 0 }, 'each group keeps its own numbers')
  eq(p.partId, 10, 'the part id comes through')
}

// ── available is limited to the configured groups ───────────────────────────────────────────────
{
  const rows = [
    row(20, 'SK4C13C', 1, 1750, 0, 0, 0),   // Main — counts
    row(20, 'SK4C13C', 7, 500, 0, 0, 0),    // Material — excluded (raw stock is not finished goods)
    row(20, 'SK4C13C', 8, 250, 0, 0, 0),    // Manufacturing — excluded (WIP)
  ]
  const p = aggregateInventory(rows, GROUPS)[0]
  eq(p.onHand, 2500, 'on hand still sums across every group')
  eq(p.available, 1750, 'but available counts only Main + Warehouse (D-FB-33)')
  eq(Object.keys(p.byLocation).sort(), ['1', '7', '8'], 'the excluded groups are still reported per group')

  // The rule is configuration, not a constant.
  eq(aggregateInventory(rows, [1, 6, 7, 8])[0].available, 2500, 'widening the group list widens available')
  eq(aggregateInventory(rows, [])[0].available, 0, 'and an empty list makes nothing available')
}

// ── on order rides along; it is never part of available ─────────────────────────────────────────
{
  const p = aggregateInventory([row(30, 'SK4000CGP81', 1, 1107472, 0, 0, 400000)], GROUPS)[0]
  eq(p.onOrder, 400000, 'on order is summed')
  eq(p.available, 1107472, 'and never counted as available')
}

// ── negative availability survives (SK-O: on hand but wholly allocated) ─────────────────────────
{
  const p = aggregateInventory([row(40, 'SK-O', 1, 874, 7300, 0, 0)], GROUPS)[0]
  eq(p.available, -6426, 'available goes negative rather than clamping — the Create WO chip says "short"')
}

// ── null group → zero row: the D-FB-40 case ─────────────────────────────────────────────────────
{
  const out = aggregateInventory([row(50, 'SK4FB13S', null)], GROUPS)
  eq(out.length, 1, 'a part with no stock record still produces a row')
  eq(out[0], {
    partId: 50, partNum: 'SK4FB13S',
    onHand: 0, allocated: 0, notAvailable: 0, onOrder: 0, available: 0, byLocation: {},
  }, 'every quantity is zero and byLocation is empty')
  eq(countZeroRows(out), 1, 'and it counts as a zero row')

  // undefined is treated the same as null — a driver that omits the column must not become a group.
  eq(aggregateInventory([row(51, 'SK9', undefined)], GROUPS)[0].byLocation, {}, 'an absent group is not a group')
}

// ── a part Fishbowl does not know is simply not in the input ────────────────────────────────────
{
  // q.partsByNum drops unknown numbers, so they never reach this function. Nothing invents a row.
  const out = aggregateInventory([row(60, 'SK4C13C', 1, 1750)], GROUPS)
  eq(out.map(p => p.partNum), ['SK4C13C'], 'only parts present in the input get a row')
  ok(!out.some(p => p.partNum === 'NOT-A-FISHBOWL-PART'), 'an unknown number is omitted, not zero-filled')
}

// ── mixed batch, the shape of a real cycle ──────────────────────────────────────────────────────
{
  const out = aggregateInventory([
    row(1, 'SK-O', 1, 874, 7300, 0, 0),
    row(2, 'SK40S47-13S', 1, 0, 100, 0, 0),
    row(3, 'SK4C13C', null),
    row(4, 'SK26FB', 1, 30000, 0, 0, 0),
    row(4, 'SK26FB', 6, 3633, 0, 0, 0),
    row(5, 'SK4FB13S', null),
  ], GROUPS)
  eq(out.length, 5, 'five parts in, five rows out')
  eq(countZeroRows(out), 2, 'two of them hold no stock')
  const m = byNum(out)
  eq(m['SK40S47-13S'].available, -100, 'nothing on hand but allocated reads as short')
  eq(m['SK26FB'].onHand, 33633, 'the multi-group part is summed')
  eq(m['SK4C13C'].available, 0, 'and a zero row is zero, not missing')
  ok(out.every(p => typeof p.partNum === 'string' && p.partNum), 'every row carries its part number')
}

// ── defensive: rows the poller should not choke on ──────────────────────────────────────────────
{
  eq(aggregateInventory([], GROUPS), [], 'no rows is an empty payload, not a throw')
  eq(aggregateInventory(null, GROUPS), [], 'and neither is a null result')
  eq(countZeroRows([]), 0, 'counting nothing is zero')
  eq(countZeroRows(null), 0, 'and a null payload does not throw')
  eq(aggregateInventory([row(70, 'SK1', 'x', 5)], GROUPS)[0].byLocation, {}, 'a non-numeric group is ignored')
  ok(!aggregateInventory([{ partId: null, partNum: 'SK2' }], GROUPS).length, 'a row with no part id is dropped')

  // Fishbowl returns DECIMAL as a string through the JSON API; Number() is what makes the sums add up.
  const p = aggregateInventory([row(80, 'SK3', 1, '10.5', '2.5', '0', '4')], GROUPS)[0]
  eq(p.onHand, 10.5, 'string quantities are coerced')
  eq(p.available, 8, 'and arithmetic still works on them')
  eq(p.onOrder, 4, 'including on order')
}

console.log(`inventory: ${n} assertions passed`)
