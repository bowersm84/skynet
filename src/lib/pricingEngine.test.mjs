// Unit test for the client engine mirror in pricing.js — columnPrice, bookPricer, sumDetail.
// Run: node src/lib/pricingEngine.test.mjs
//
// pricing.js imports the Supabase client, which reads import.meta.env and cannot be
// constructed outside Vite, so the module is loaded with that one import stubbed out and
// nothing else changed: the functions under test are the shipped ones, byte for byte.
// (The rule they mirror — a kit sums only when EVERY component prices, D-PRICE-50 — is the
// whole point of the test, so testing a copy would prove nothing.)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const shimPath = path.join(dir, '_pricing.undertest.mjs')
const src = fs.readFileSync(path.join(dir, 'pricing.js'), 'utf8')
  .replace("import { supabase } from './supabase'", 'const supabase = { from: () => { throw new Error("no I/O in this test") } }')
  .replaceAll("from './pricingView'", "from './pricingView.js'")   // Vite resolves extensionless, Node does not
assert.ok(!src.includes("from './supabase'"), 'the Supabase import was stubbed')
fs.writeFileSync(shimPath, src)

let n = 0
const ok = (cond, msg) => { assert.ok(cond, msg); n++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++ }

try {
  const { columnPrice, bookPricer, sumDetail, multiplierFor, BASIS_LABELS, TIERS, TIER_LABELS } = await import(pathToFileURL(shimPath).href)

  const book = { id: 'b', rev_label: 'Rev 82', premier_pct: 0.97 }
  const meta = {
    rules: { A: { code: 'A', m_q100: 0.9, m_q300: 0.85, m_q500: 0.8, m_tier1: 0.75, m_tier2: 0.7, m_tier3: 0.65 } },
    ladders: {
      standard: { code: 'standard', columns: [
        { key: 'q100', kind: 'qty', min: 100, label: '100' }, { key: 'q300', kind: 'qty', min: 300, label: '300' },
        { key: 'q500', kind: 'qty', min: 500, label: '500' }, { key: 'tier1', kind: 'tier', label: 'Tier 1' },
        { key: 'tier2', kind: 'tier', label: 'Tier 2' }, { key: 'tier3', kind: 'tier', label: 'Tier 3' }] },
      q100: { code: 'q100', columns: [{ key: 'q100', kind: 'qty', min: 100, label: '100' }] },
      none: { code: 'none', columns: [] },
    },
  }
  const item = (o) => ({ status: 'priced', rule_code: 'A', ladder_code: 'standard', has_premier: false, ...o })

  // ── plain rows ──────────────────────────────────────────────────────────────────
  const stud = item({ part_key: 'SK2600-1', list_price: 10 })
  eq(columnPrice(stud, 'each', meta, book, null), 10, 'Each is the list price')
  eq(columnPrice(stud, 'q100', meta, book, null), 9, 'a quantity column is list × its multiplier')
  eq(columnPrice(stud, 'tier3', meta, book, null), 6.5, 'a tier column is list × its multiplier')
  eq(columnPrice(stud, 'premier', meta, book, null), 10 * 0.65 * 0.97, 'Premier is Tier 3 × the book’s premier_pct')
  eq(columnPrice(item({ list_price: 10, ladder_code: 'q100' }), 'q300', meta, book, null), null, 'a column the ladder does not carry has no price')
  eq(columnPrice(item({ status: 'no_price', list_price: null }), 'each', meta, book, null), null, 'a no_price row never prices')
  eq(multiplierFor(meta.rules.A, meta.ladders.standard, 'q300'), 0.85, 'the Nth quantity column takes the Nth multiplier, positionally')

  // ── kit sums are all-or-nothing (D-PRICE-50) ────────────────────────────────────
  const a = item({ part_key: 'A1', list_price: 25 })
  const b = item({ part_key: 'B2', list_price: 50 })
  const blocked = item({ part_key: 'MS21059L3', status: 'no_price', list_price: null })
  const narrow = item({ part_key: 'N1', list_price: 8, ladder_code: 'q100' })
  const premierPart = item({ part_key: 'P1', list_price: 30, has_premier: true })
  const byKey = new Map([['A1', a], ['B2', b], ['MS21059L3', blocked], ['N1', narrow], ['P1', premierPart]])
  const resolve = (k) => byKey.get(k) || null

  const kit = { status: 'component_sum', part_key: 'AC500-C1', _components: [{ component_key: 'A1', component_part_number: 'A1', qty: 2 }, { component_key: 'B2', component_part_number: 'B2', qty: 1 }] }
  eq(columnPrice(kit, 'each', meta, book, resolve), 100, 'a kit is the sum of its components at that column, times their quantities')
  eq(columnPrice(kit, 'tier3', meta, book, resolve), 65, 'and it sums at every column the same way')

  const withUnpriced = { ...kit, _components: [...kit._components, { component_key: 'MS21059L3', component_part_number: 'MS21059L3', qty: 1 }] }
  eq(columnPrice(withUnpriced, 'each', meta, book, resolve), null, 'ONE component without a price and the whole kit has none — never a partial sum')

  const withMissing = { ...kit, _components: [...kit._components, { component_key: 'NOT-IN-BOOK', component_part_number: 'NOT-IN-BOOK', qty: 1 }] }
  eq(columnPrice(withMissing, 'each', meta, book, resolve), null, 'a component that is not in the book blocks the kit too')

  const withNarrow = { ...kit, _components: [...kit._components, { component_key: 'N1', component_part_number: 'N1', qty: 1 }] }
  eq(columnPrice(withNarrow, 'each', meta, book, resolve), 108, 'a component on a shorter ladder still prices at Each')
  eq(columnPrice(withNarrow, 'q300', meta, book, resolve), null, 'but at a column it does not carry, the kit has no price at that column either')

  // The $0.00 trap (D-PRICE-48): the raw mirror sums an empty component list to 0.
  const bare = { status: 'component_sum', part_key: 'AC500-C1', _components: [] }
  eq(columnPrice(bare, 'each', meta, book, resolve), 0, 'columnPrice still sums NO components to 0 — the documented trap')
  eq(bookPricer(meta, book, resolve)(bare, 'each'), null, 'bookPricer treats a kit with no components as unpriced, never as free')

  // ── bookPricer adds the two guards a grid or a sheet needs ──────────────────────
  const price = bookPricer(meta, book, resolve)
  eq(price(stud, 'premier'), null, 'Premier belongs only to a part flagged for it')
  eq(price(item({ list_price: 10, has_premier: true }), 'premier'), 10 * 0.65 * 0.97, 'and a flagged part gets it')
  eq(price(narrow, 'q300'), null, 'a column the ladder does not carry is blank')
  eq(price(kit, 'each'), 100, 'a kit still sums through the guards')
  eq(price(withUnpriced, 'each'), null, 'and stays all-or-nothing')
  eq(price(kit, 'premier'), null, 'a kit not flagged for Premier has no Premier price either')
  eq(price({ ...kit, has_premier: true }, 'premier'), null, 'and a flagged kit whose components are not flagged is blank, never summed at some other level')
  eq(price({ ...kit, has_premier: true, _components: [{ component_key: 'P1', component_part_number: 'P1', qty: 2 }] }, 'premier'),
    2 * 30 * 0.65 * 0.97, 'a flagged kit over flagged components does sum at Premier')
  // Rev 82's kits sit on the q100/q300/q500 ladder, so pricing_item_prices emits NO tier row
  // for them (verified on TEST: 334 sum rows at q100/q300/q500, 0 at tier1/2/3) — even though
  // every component has a Tier 3 price. The kit's own ladder is checked before the sum.
  const kitOnQtyLadder = { ...kit, ladder_code: 'q100' }
  eq(price(kitOnQtyLadder, 'tier3'), null, 'a kit is judged on its own ladder first: no Tier 3 column, no Tier 3 price')
  eq(price(kitOnQtyLadder, 'q100'), 90, 'and it does sum at a column its ladder carries')
  eq(price(kitOnQtyLadder, 'each'), 100, 'Each is always available')

  // ── sumDetail shows the workings ────────────────────────────────────────────────
  eq(sumDetail(kit, 'each', resolve, price), { value: 100, total: 2, missing: [] }, 'a resolved kit reports its value and component count')
  eq(sumDetail(withUnpriced, 'each', resolve, price), { value: null, total: 3, missing: ['MS21059L3'] }, 'a blocked kit names what blocks it')
  eq(sumDetail(bare, 'each', resolve, price), { value: null, total: 0, missing: [] }, 'a kit with no components on file is unpriced, not free')

  // ── against the deployed engine, on real Rev 82 rows ────────────────────────────
  // Rules, ladders, items, components and expected prices all copied from TEST
  // (pricing_item_prices on Rev 82, 2026-09-16). This is the regression check the Lookup tab
  // gives for one part, done here for the four shapes that matter: a plain part on a short
  // ladder, a set that resolves at every column of its ladder, a kit blocked at the quantity
  // columns by a component on the `none` ladder, and a kit blocked outright by an unpriced
  // component. If the mirror and the RPC ever disagree, this is where it shows.
  const realMeta = {
    rules: {
      A: { m_q100: 0.96, m_q300: 0.9, m_q500: 0.83, m_tier1: 0.64, m_tier2: 0.62, m_tier3: 0.6 },
      B: { m_q100: 0.97, m_q300: 0.9, m_q500: 0.84, m_tier1: 0.65, m_tier2: 0.64, m_tier3: 0.63 },
      C: { m_q100: 0.84, m_q300: 0.79, m_q500: 0.73, m_tier1: 0.56, m_tier2: 0.52, m_tier3: 0.48 },
      J: { m_q100: 0.96, m_q300: 0.9, m_q500: 0.83, m_tier1: 0.64, m_tier2: 0.62, m_tier3: 0.48 },
    },
    ladders: {
      standard: { columns: [{ key: 'q100', kind: 'qty', min: 100 }, { key: 'q300', kind: 'qty', min: 300 }, { key: 'q500', kind: 'qty', min: 500 }, { key: 'tier1', kind: 'tier' }, { key: 'tier2', kind: 'tier' }, { key: 'tier3', kind: 'tier' }] },
      q100_q300_q500: { columns: [{ key: 'q100', kind: 'qty', min: 100 }, { key: 'q300', kind: 'qty', min: 300 }, { key: 'q500', kind: 'qty', min: 500 }] },
      q100: { columns: [{ key: 'q100', kind: 'qty', min: 100 }] },
      none: { columns: [] },
    },
  }
  const realBook = { premier_pct: 0.97 }
  const realItems = [
    { part_key: 'SKFO65-40.25', status: 'priced', list_price: 59.296, rule_code: 'A', ladder_code: 'q100', has_premier: false },
    { part_key: 'MS21059L3', status: 'no_price', list_price: null, rule_code: null, ladder_code: 'none', has_premier: false },
    { part_key: 'SK213-2', status: 'priced', list_price: 8.77, rule_code: 'A', ladder_code: 'standard', has_premier: false },
    { part_key: 'SK2600-1SFW', status: 'priced', list_price: 11.853, rule_code: 'A', ladder_code: 'standard', has_premier: false },
    { part_key: 'SK2600-LWS', status: 'priced', list_price: 0.507, rule_code: 'J', ladder_code: 'standard', has_premier: false },
    // AC500-C1 abbreviated to the two components that decide it: one on `standard`, one on `none`.
    { part_key: 'SK-NS', status: 'priced', list_price: 4.959, rule_code: 'C', ladder_code: 'standard', has_premier: false },
    { part_key: 'MS51957-45', status: 'priced', list_price: 0.3, rule_code: null, ladder_code: 'none', has_premier: false },
    { part_key: 'SK2600FW-SET1', status: 'component_sum', list_price: 21.13, rule_code: null, ladder_code: 'q100_q300_q500', has_premier: false,
      _components: [{ component_key: 'SK213-2', component_part_number: 'SK213-2', qty: 1 }, { component_key: 'SK2600-1SFW', component_part_number: 'SK2600-1SFW', qty: 1 }, { component_key: 'SK2600-LWS', component_part_number: 'SK2600-LWS', qty: 1 }] },
    { part_key: 'AC500-PART', status: 'component_sum', list_price: null, rule_code: null, ladder_code: 'q100_q300_q500', has_premier: false,
      _components: [{ component_key: 'SK-NS', component_part_number: 'SK-NS', qty: 220 }, { component_key: 'MS51957-45', component_part_number: 'MS51957-45', qty: 25 }] },
    { part_key: 'RV1014J-C1P', status: 'component_sum', list_price: null, rule_code: null, ladder_code: 'q100_q300_q500', has_premier: false,
      _components: [{ component_key: 'SK213-2', component_part_number: 'SK213-2', qty: 6 }, { component_key: 'MS21059L3', component_part_number: 'MS21059L3', qty: 10 }] },
  ]
  const realByKey = new Map(realItems.map(i => [i.part_key, i]))
  const realPrice = bookPricer(realMeta, realBook, k => realByKey.get(k) || null)
  const at = (key, col) => realPrice(realByKey.get(key), col)
  const near = (a, b, msg) => { assert.ok(a !== null && Math.abs(a - b) < 1e-6, `${msg} (got ${a}, want ${b})`); n++ }

  near(at('SKFO65-40.25', 'each'), 59.296, 'SKFO65-40.25 Each matches the engine')
  near(at('SKFO65-40.25', 'q100'), 56.92416, 'SKFO65-40.25 at 100+ matches the engine')
  eq(at('SKFO65-40.25', 'q300'), null, 'SKFO65-40.25 is on the q100 ladder, so 300+ is blank — as the engine emits no row for it')
  eq(at('SKFO65-40.25', 'tier3'), null, 'and it has no Tier 3 either')
  eq(at('MS21059L3', 'each'), null, 'MS21059L3 has no price — the component that blocks 25 RV/Lancair kits')

  near(at('SK2600FW-SET1', 'each'), 21.13, 'SK2600FW-SET1 sums to 21.130, the engine’s Each')
  near(at('SK2600FW-SET1', 'q100'), 20.2848, 'and to 20.2848 at 100+')
  near(at('SK2600FW-SET1', 'q300'), 19.017, 'and 19.0170 at 300+')
  near(at('SK2600FW-SET1', 'q500'), 17.5379, 'and 17.5379 at 500+')
  eq(at('SK2600FW-SET1', 'tier3'), null, 'a set on the quantity ladder has no Tier 3 price in the book, though every component does')

  near(at('AC500-PART', 'each'), 220 * 4.959 + 25 * 0.3, 'a kit sums its components at Each')
  eq(at('AC500-PART', 'q100'), null, 'and has NO price at 100+ because one component sits on the `none` ladder — exactly why AC500-C1 prices at Each only')
  eq(at('RV1014J-C1P', 'each'), null, 'RV1014J-C1P is blocked outright by MS21059L3, at every column')
  eq(at('RV1014J-C1P', 'q100'), null, 'including the quantity columns')
  eq(sumDetail(realByKey.get('RV1014J-C1P'), 'each', k => realByKey.get(k) || null, realPrice).missing, ['MS21059L3'], 'and it names MS21059L3 as the reason')

  // ── the vocabulary reaches callers through pricing.js ───────────────────────────
  ok(TIERS.includes('q300') && TIER_LABELS.q300 === '300 column', 'the column tiers are re-exported from pricing.js')
  eq(BASIS_LABELS.manual, 'Manual price', 'a manual line has a label')
  eq(BASIS_LABELS.column, 'Customer column', 'so does a column-tier line')

  console.log(`pricingEngine: ${n} assertions passed`)
} finally {
  fs.rmSync(shimPath, { force: true })
}
