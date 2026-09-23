// Unit test for summarizeFbInventory (lib/fishbowl.js) — D-FB-39 / D-FB-39a / D-FB-39b.
// Run: node src/lib/fbInventory.test.mjs
//
// The point of the first block is the refactor guarantee: D-FB-39 moved the Order Queue
// Avail cell's reading into summarizeFbInventory, and that cell's tone and tooltip must
// not have moved a byte. The pre-refactor AvailCell computation (SOCard.jsx at af5900d^)
// is embedded below verbatim as the oracle, and the shipped helper is checked against it
// across fixtures shaped like the PROD fb_part_inventory rows the original round used:
// multi-location-group, on-order, negative and positive available, unknown group, no
// by_location, null snapshot. The call shape is AvailCell's — { need } alone.
//
// fishbowl.js imports the Supabase client, which reads import.meta.env and cannot be
// constructed outside Vite, so the module is loaded with that one import stubbed out and
// nothing else changed: the function under test is the shipped one, byte for byte.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const shimPath = path.join(dir, '_fishbowl.undertest.mjs')
const src = fs.readFileSync(path.join(dir, 'fishbowl.js'), 'utf8')
  .replace("import { supabase } from './supabase'", 'const supabase = { from: () => { throw new Error("no I/O in this test") } }')
assert.ok(!src.includes("from './supabase'"), 'the Supabase import was stubbed')
fs.writeFileSync(shimPath, src)

let n = 0
const ok = (cond, msg) => { assert.ok(cond, msg); n++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++ }

try {
  const { summarizeFbInventory, FB_LOCATION_GROUPS, formatDateTime } = await import(pathToFileURL(shimPath).href)

  // ── the pre-D-FB-39 AvailCell computation, verbatim ────────────────────────────────
  // Only the JSX around it is dropped; every expression on every raw field is unchanged,
  // including the truthiness test on qty_on_order, so a quirk here is a quirk to keep.
  const oracle = (inv, need) => {
    const avail = Number(inv.qty_available ?? 0)
    const tone = avail >= need && need > 0 ? 'text-green-300' : avail > 0 ? 'text-amber-300' : 'text-gray-500'
    const byLoc = Object.entries(inv.by_location || {})
      .map(([lg, v]) => `${FB_LOCATION_GROUPS[lg] || `LG ${lg}`}: ${Number(v.onHand || 0).toLocaleString()} on hand, ${Number(v.allocated || 0).toLocaleString()} allocated`)
      .join('\n')
    const title = `Available ${avail.toLocaleString()} (on hand ${Number(inv.qty_on_hand || 0).toLocaleString()} − allocated ${Number(inv.qty_allocated || 0).toLocaleString()} − not available ${Number(inv.qty_not_available || 0).toLocaleString()}; available location groups only)`
      + (inv.qty_on_order ? `\nOn order ${Number(inv.qty_on_order).toLocaleString()}` : '')
      + (byLoc ? `\n\n${byLoc}` : '')
      + (inv.snapshot_at ? `\n\nsnapshot ${formatDateTime(inv.snapshot_at)}` : '')
    return { tone, title }
  }

  const lg = (onHand, allocated, notAvailable = 0, onOrder = 0) => ({ onHand, allocated, notAvailable, onOrder })
  const SNAP = '2026-09-23T13:05:00Z'

  // Fixtures shaped like real fb_part_inventory rows.
  const fixtures = {
    // SK-O: on hand but wholly allocated and then some — the row that proved a Fishbowl
    // number alone misleads (SkyNet had J-000219 open for 7,550).
    negative:        { qty_on_hand: 874, qty_allocated: 7300, qty_not_available: 0, qty_on_order: 0, qty_available: -6426, by_location: { 1: lg(874, 7300) }, snapshot_at: SNAP },
    // SK40S47-13S: nothing on hand, allocated anyway.
    noneOnHand:      { qty_on_hand: 0, qty_allocated: 100, qty_not_available: 0, qty_on_order: 0, qty_available: -100, by_location: { 1: lg(0, 100) }, snapshot_at: SNAP },
    // Plain positive stock, one group.
    positive:        { qty_on_hand: 1750, qty_allocated: 0, qty_not_available: 0, qty_on_order: 0, qty_available: 1750, by_location: { 1: lg(1750, 0) }, snapshot_at: SNAP },
    // Small positive — the amber/green boundary depends on need.
    small:           { qty_on_hand: 53, qty_allocated: 0, qty_not_available: 0, qty_on_order: 0, qty_available: 53, by_location: { 1: lg(53, 0) }, snapshot_at: SNAP },
    // Main + Warehouse, with not-available held back.
    multiGroup:      { qty_on_hand: 33633, qty_allocated: 1200, qty_not_available: 433, qty_on_order: 0, qty_available: 32000, by_location: { 1: lg(30000, 1200, 433), 6: lg(3633, 0) }, snapshot_at: SNAP },
    // Large on-order — the branch guarded by a truthiness test, not a > 0 test.
    onOrder:         { qty_on_hand: 1107472, qty_allocated: 0, qty_not_available: 0, qty_on_order: 400000, qty_available: 1107472, by_location: { 1: lg(1107472, 0) }, snapshot_at: SNAP },
    // On hand, none free, nothing short — the third text branch.
    exactlyZeroFree: { qty_on_hand: 500, qty_allocated: 500, qty_not_available: 0, qty_on_order: 0, qty_available: 0, by_location: { 1: lg(500, 500) }, snapshot_at: SNAP },
    // A group outside FB_LOCATION_GROUPS falls back to "LG n".
    unknownGroup:    { qty_on_hand: 12, qty_allocated: 0, qty_not_available: 0, qty_on_order: 0, qty_available: 12, by_location: { 99: lg(12, 0) }, snapshot_at: SNAP },
    // by_location empty: the breakdown block drops out entirely.
    noByLocation:    { qty_on_hand: 821492, qty_allocated: 0, qty_not_available: 0, qty_on_order: 0, qty_available: 821492, by_location: {}, snapshot_at: SNAP },
    // No snapshot stamp: the snapshot line drops out.
    noSnapshot:      { qty_on_hand: 7, qty_allocated: 2, qty_not_available: 0, qty_on_order: 0, qty_available: 5, by_location: { 1: lg(7, 2) }, snapshot_at: null },
    // A frozen row — one the bridge stopped refreshing (113 of 443 on 2026-09-23).
    frozen:          { qty_on_hand: 3799, qty_allocated: 0, qty_not_available: 0, qty_on_order: 0, qty_available: 3799, by_location: { 1: lg(3799, 0) }, snapshot_at: '2026-09-02T11:40:00Z' },
  }

  // ── 1. AvailCell equivalence: 11 rows × 5 needs ───────────────────────────────────
  const needs = [0, 1, 53, 874, 100000]
  let pairs = 0
  for (const [name, inv] of Object.entries(fixtures)) {
    for (const need of needs) {
      const want = oracle(inv, need)
      const got = summarizeFbInventory(inv, { need })
      assert.equal(got.tone, want.tone, `${name} @ need ${need}: tone moved`)
      assert.equal(got.title, want.title, `${name} @ need ${need}: tooltip moved`)
      pairs++
    }
  }
  n += 2 * pairs
  eq(pairs, 55, 'every fixture was checked at every need')

  // The equivalence above is only worth something if the fixtures actually exercise all
  // three tones and both optional tooltip blocks.
  const tones = new Set(Object.values(fixtures).flatMap(inv => needs.map(need => oracle(inv, need).tone)))
  eq([...tones].sort(), ['text-amber-300', 'text-gray-500', 'text-green-300'], 'the fixtures reach all three tones')
  ok(oracle(fixtures.onOrder, 1).title.includes('\nOn order 400,000'), 'the on-order line is exercised')
  ok(!oracle(fixtures.noByLocation, 1).title.includes('\n\nMain'), 'and a row with no groups drops the breakdown')
  ok(oracle(fixtures.multiGroup, 1).title.includes('Main: 30,000 on hand') && oracle(fixtures.multiGroup, 1).title.includes('Warehouse: 3,633 on hand'), 'both groups are named')
  ok(oracle(fixtures.unknownGroup, 1).title.includes('LG 99: 12 on hand'), 'an unmapped group falls back to LG n')

  // ── 2. D-FB-39 states ─────────────────────────────────────────────────────────────
  const LAST = '2026-09-23T13:05:00Z'

  const current = summarizeFbInventory(fixtures.positive, { need: 100, lastInventoryAt: LAST })
  eq(current.state, 'current', 'a row stamped with this cycle is current')
  eq(current.tone, 'text-green-300', 'and 1,750 free covers a need of 100')
  eq(current.text, '1,750 free of 1,750 on hand', 'the plain-English line reads as free of on hand')
  eq(current.compactText, '1,750 on hand', 'the compact chip is just the on-hand number')

  const stale = summarizeFbInventory(fixtures.frozen, { need: 100, lastInventoryAt: LAST })
  eq(stale.state, 'stale', 'a row three weeks behind the cycle is stale')
  eq(stale.tone, 'text-gray-500', 'stale never reads as good news, however much stock it claims')
  ok(stale.title.includes('Not refreshed since'), 'and the tooltip says why')
  eq(stale.asOf, fixtures.frozen.snapshot_at, 'asOf carries the frozen stamp for the chip to show')

  // The cycle timestamp is the test, not the row's age: a row stamped with the cycle is
  // current no matter how old the cycle itself is.
  eq(summarizeFbInventory(fixtures.frozen, { need: 0, lastInventoryAt: fixtures.frozen.snapshot_at }).state, 'current', 'a row stamped with its own cycle is current')
  eq(summarizeFbInventory(fixtures.frozen, { need: 0 }).state, 'current', 'with no cycle to compare against, nothing is stale')
  // 10-minute tolerance, either side of it.
  eq(summarizeFbInventory({ ...fixtures.positive, snapshot_at: '2026-09-23T12:56:00Z' }, { lastInventoryAt: LAST }).state, 'current', '9 min behind the cycle is within tolerance')
  eq(summarizeFbInventory({ ...fixtures.positive, snapshot_at: '2026-09-23T12:50:00Z' }, { lastInventoryAt: LAST }).state, 'stale', '15 min behind it is not')

  // D-FB-39a: no row is always "not synced" — never "not in Fishbowl". fb_products
  // cannot prove absence (SK4FB13S: 53 on hand in Main, no Fishbowl product row).
  const missing = summarizeFbInventory(null, { need: 100, lastInventoryAt: LAST })
  eq(missing.state, 'not_synced', 'no row is not_synced')
  eq(missing.text, 'Not synced from Fishbowl', 'and says so in those words')
  eq(missing.compactText, '—', 'the compact chip shows an em dash')
  eq(missing.tone, 'text-gray-500', 'with no colour claim')
  ok(!/not in Fishbowl/i.test(missing.title), 'the tooltip never claims the part is absent from Fishbowl')

  // ── 3. text branches ──────────────────────────────────────────────────────────────
  eq(summarizeFbInventory(fixtures.negative, {}).text, '874 on hand, all allocated · 6,426 short', 'SK-O reads as short, not as 874 available')
  eq(summarizeFbInventory(fixtures.noneOnHand, {}).text, 'None on hand · 100 allocated', 'nothing on hand still reports what is spoken for')
  eq(summarizeFbInventory(fixtures.exactlyZeroFree, {}).text, '500 on hand, none free', 'nothing free is not the same as nothing short')
  eq(summarizeFbInventory(fixtures.onOrder, {}).text, '1,107,472 free of 1,107,472 on hand · 400,000 on order', 'on order is appended, with thousands separators')
  eq(summarizeFbInventory({ ...fixtures.noneOnHand, qty_allocated: 0, qty_available: 0 }, {}).text, 'None on hand', 'and nothing allocated leaves the bare phrase')

  // ── 4. D-FB-39b: open jobs reach the tooltip ──────────────────────────────────────
  const jobs1 = { qty: 7550, jobs: [{ job_number: 'J-000219', status: 'in_progress' }] }
  const withJobs = summarizeFbInventory(fixtures.negative, { need: 7550, lastInventoryAt: LAST, openJobs: jobs1 })
  ok(withJobs.title.endsWith('SkyNet: 7,550 in open jobs — J-000219 (in progress)'), 'the tooltip ends with what SkyNet already has running')
  eq(withJobs.tone, summarizeFbInventory(fixtures.negative, { need: 7550, lastInventoryAt: LAST }).tone, 'open jobs are reported, never scored — the tone is unchanged')
  eq(withJobs.text, summarizeFbInventory(fixtures.negative, { need: 7550, lastInventoryAt: LAST }).text, 'and the visible Fishbowl line is unchanged')

  // A component with no Fishbowl row is the case this was built for: the compact chip
  // shows "—", so without this the tooltip was the only place the open job could appear.
  const jobs2 = { qty: 150, jobs: [{ job_number: 'J-000292', status: 'pending_compliance' }] }
  const missingWithJobs = summarizeFbInventory(null, { need: 150, lastInventoryAt: LAST, openJobs: jobs2 })
  ok(missingWithJobs.title.includes('SkyNet: 150 in open jobs — J-000292 (pending compliance)'), 'a not-synced part still reports its open SkyNet jobs')
  ok(missingWithJobs.title.startsWith('No Fishbowl inventory row for this part'), 'after the not-synced explanation, not instead of it')

  ok(summarizeFbInventory(fixtures.frozen, { lastInventoryAt: LAST, openJobs: jobs2 }).title.includes('SkyNet: 150 in open jobs'), 'a stale row reports them too')

  // At most three jobs, then a count.
  const many = { qty: 900, jobs: [1, 2, 3, 4, 5].map(i => ({ job_number: `J-00030${i}`, status: 'queued' })) }
  const manyTitle = summarizeFbInventory(fixtures.small, { openJobs: many }).title
  ok(manyTitle.includes('J-000301 (queued), J-000302 (queued), J-000303 (queued), +2 more'), 'four or more jobs list three and count the rest')
  ok(!manyTitle.includes('J-000304'), 'the fourth is not spelled out')

  // Quantity with no job list, and the cases that must not add a block at all.
  ok(summarizeFbInventory(fixtures.small, { openJobs: { qty: 40, jobs: [] } }).title.endsWith('SkyNet: 40 in open jobs'), 'a quantity with no job rows still reports the quantity')
  const bare = summarizeFbInventory(fixtures.small, { need: 1 }).title
  eq(summarizeFbInventory(fixtures.small, { need: 1, openJobs: null }).title, bare, 'no open jobs adds nothing')
  eq(summarizeFbInventory(fixtures.small, { need: 1, openJobs: { qty: 0, jobs: [] } }).title, bare, 'and neither does a zero quantity')

  console.log(`fbInventory: ${n} assertions passed`)
} finally {
  fs.rmSync(shimPath, { force: true })
}
