// Unit test for the Pricing Portal's pure view rules (D-PRICE-51 / D-PRICE-52).
// Run: node src/lib/pricingView.test.mjs

import assert from 'node:assert/strict'
import {
  TIERS, LEVEL_TIERS, COLUMN_TIERS, TIER_LABELS, TIER_COLORS, isColumnTier,
  filterDeviations, summariseDeviations, deviationReps, DEVIATION_KINDS, DEVIATION_KIND_LABELS,
  matchSections, partitionKitSections, pickKitsBook, kitRank,
} from './pricingView.js'

let n = 0
const ok = (cond, msg) => { assert.ok(cond, msg); n++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++ }

// ── tiers ─────────────────────────────────────────────────────────────────────────
eq(TIERS, ['none', 'tier1', 'tier2', 'tier3', 'premier', 'q100', 'q300', 'q500'], 'the column tiers join the vocabulary after the levels')
eq(COLUMN_TIERS.map(t => TIER_LABELS[t]), ['100 column', '300 column', '500 column'], 'column tiers read as columns, not as quantities')
eq(LEVEL_TIERS.map(t => TIER_LABELS[t]), ['No tier', 'Tier 1', 'Tier 2', 'Tier 3', 'Premier'], 'the level labels are unchanged')
ok(TIERS.every(t => TIER_LABELS[t] && TIER_COLORS[t]), 'every tier has a label and a badge colour')
ok(COLUMN_TIERS.every(t => TIER_COLORS[t] !== TIER_COLORS.premier), 'a column tier never wears the Premier badge')
eq(new Set(COLUMN_TIERS.map(t => TIER_COLORS[t])).size, 3, 'the three column tiers are told apart from each other')
ok(COLUMN_TIERS.every(t => /amber/.test(TIER_COLORS[t])), 'column tiers are the amber family')
ok(isColumnTier('q300') && !isColumnTier('tier3') && !isColumnTier('premier') && !isColumnTier(null), 'isColumnTier only recognises the three columns')

// ── deviations ────────────────────────────────────────────────────────────────────
const dev = (o) => ({ quote_id: 'q1', created_by: 'u1', created_by_name: 'April', deviation_kind: 'column', delta_extended: -10, ...o })
const rows = [
  dev({ line_id: 'l1' }),
  dev({ line_id: 'l2', created_by: 'u2', created_by_name: 'Christy', deviation_kind: 'manual', delta_extended: -250.5 }),
  dev({ line_id: 'l3', created_by: 'u2', created_by_name: 'Christy', deviation_kind: 'special', delta_extended: 40 }),
  dev({ line_id: 'l4', quote_id: 'q2', deviation_kind: 'manual', delta_extended: null }),
]
eq(filterDeviations(rows, {}).length, 4, 'no filter keeps every line')
eq(filterDeviations(rows, { rep: 'all', kind: 'all' }).length, 4, '"all" is not a rep and not a kind')
eq(filterDeviations(rows, { rep: 'u2' }).map(r => r.line_id), ['l2', 'l3'], 'the rep filter picks by profile id, not by name')
eq(filterDeviations(rows, { kind: 'manual' }).map(r => r.line_id), ['l2', 'l4'], 'the kind filter picks by deviation_kind')
eq(filterDeviations(rows, { rep: 'u2', kind: 'manual' }).map(r => r.line_id), ['l2'], 'rep and kind are combined')
eq(filterDeviations(null, { rep: 'u1' }), [], 'no rows is not an error')

const sum = summariseDeviations(rows)
eq(sum.lines, 4, 'every deviation line counts')
eq(Math.round(sum.below * 100) / 100, 260.5, 'only the lines under the book add up to "below recommendation"')
eq(sum.above, 40, 'a line quoted above the book is reported separately, never netted off')
eq(sum.manual, 2, 'manual lines are counted whether or not they carry a delta')
eq(sum.quotes, 2, 'quotes are counted distinctly')
eq(summariseDeviations([]), { lines: 0, below: 0, above: 0, manual: 0, quotes: 0 }, 'an empty range summarises to zeroes')
eq(deviationReps(rows).map(r => r.name), ['April', 'Christy'], 'the rep list is distinct and alphabetical')
ok(DEVIATION_KINDS.every(k => DEVIATION_KIND_LABELS[k]), 'every kind the view can emit has a label')

// ── catalog section search ────────────────────────────────────────────────────────
const sections = [
  { id: 's1', name: 'Skybolt CLoc® 2600 Protruding Head Series - Steel', sort: 3 },
  { id: 's2', name: 'Skybolt CLoc® 2600 Protruding Head Series - Stainless', sort: 4 },
  { id: 's3', name: 'Skybolt Kits — Cowling', sort: 90 },
  { id: 's4', name: 'Kit Hardware (cost-based)', sort: 95 },
  { id: 's5', name: 'Resale Items', sort: 99 },
]
eq(matchSections(sections, 'protruding').hits.map(s => s.id), ['s1', 's2'], 'matching is case-insensitive substring on the section name')
eq(matchSections(sections, 'STAINLESS').hits.map(s => s.id), ['s2'], 'case does not matter either way')
eq(matchSections(sections, '  ').hits, [], 'whitespace is not a search')
eq(matchSections(sections, 'zzz'), { hits: [], more: 0 }, 'no match is empty, not an error')
const capped = matchSections(sections, 'e', 2)
eq(capped.hits.length, 2, 'the group is capped')
ok(capped.more > 0, 'the overflow is reported rather than silently dropped')

// ── kit sections ──────────────────────────────────────────────────────────────────
const sumSections = new Set(['s3'])
const part = partitionKitSections(sections, s => sumSections.has(s.id))
eq(part.kitSections.map(s => s.id), ['s3', 's4'], 'a section holding a sum, plus Kit Hardware by name, move to Kits')
eq(part.plainSections.map(s => s.id), ['s1', 's2', 's5'], 'Resale Items stays on the catalog side — it carries cost rows but no sums')
ok(kitRank('Skybolt Kits — Cowling') < kitRank('Kit Hardware (cost-based)'), 'Kit Hardware sorts last of the kit sections')
ok(kitRank('Something else') >= kitRank('Kit Hardware (cost-based)'), 'an unknown family falls to the bottom, never to the top')

// ── which book the Catalog Kits tab reads ─────────────────────────────────────────
// PROD shape, 2026-09-16: Rev 81 (active) carries ONE sum-bearing section — the 16 CLoc 2000
// Common Sets — and Rev 82 (scheduled 2026-10-01) carries five plus Kit Hardware.
const bookSections = [
  { id: 'common', name: 'Skybolt CLoc® 2000 Series Common Sets', sort: 2 },
  { id: 'plain', name: 'Skybolt CLoc® 2600 Protruding Head Series - Steel', sort: 3 },
  { id: 'hardware', name: 'Kit Hardware (cost-based)', sort: 198 },
  { id: 'cowling', name: 'Skybolt Kits — Cowling Kit', sort: 199 },
  { id: 'option', name: 'Skybolt Kits — Option Kit', sort: 200 },
  { id: 'rv', name: 'Skybolt Kits — RV Kit', sort: 201 },
  { id: 'lancair', name: 'Skybolt Kits — Lancair Kit', sort: 202 },
]
const rev81 = { book: { id: 'b81', rev_label: 'Rev 81 — Jun 2026' }, meta: { sections: bookSections.filter(s => ['common', 'plain'].includes(s.id)) }, sumSectionIds: new Set(['common']) }
const rev82 = { book: { id: 'b82', rev_label: 'Rev 82 — Oct 2026', effective_from: '2026-10-01' }, meta: { sections: bookSections }, sumSectionIds: new Set(['common', 'cowling', 'option', 'rv', 'lancair']) }

const today = pickKitsBook(rev81, rev82)
eq(today.source, 'scheduled', 'Rev 81 already holds the Common Sets, so the tab follows the book with MORE kit sections — the scheduled one')
eq(today.book.id, 'b82', 'and it reads the scheduled book itself, not the one in effect')
ok(today.showFishbowl, 'a book shown ahead of its date is shown beside what Fishbowl lists today')
eq(today.sections.map(s => s.id), ['common', 'cowling', 'option', 'rv', 'lancair', 'hardware'], 'the kit sections in Matt’s reading order, Kit Hardware last')

const oct1 = pickKitsBook(rev82, null)
eq(oct1.source, 'current', 'once Rev 82 is the book in effect the tab reads it like every other Catalog tab')
ok(!oct1.showFishbowl, 'and the Fishbowl column is dropped')

const rev83 = { book: { id: 'b83', rev_label: 'Rev 83' }, meta: { sections: bookSections }, sumSectionIds: rev82.sumSectionIds }
eq(pickKitsBook(rev82, rev83).book.id, 'b82', 'a later clone with the same families ties, and a tie goes to the book in effect')
eq(pickKitsBook(rev81, rev81).source, 'current', 'a tie at one section is still the book in effect')

const noKits = { ...rev81, meta: { sections: [{ id: 'plain', name: 'Plain', sort: 1 }] }, sumSectionIds: new Set() }
eq(pickKitsBook(noKits, null), { source: null, book: null, meta: null, sections: [], showFishbowl: false }, 'no kits anywhere is an empty state, not a blank grid')
eq(pickKitsBook(null, null).source, null, 'no book at all does not throw')
eq(pickKitsBook(noKits, { book: { id: 'b84' }, meta: null, sumSectionIds: new Set(['cowling']) }).source, null, 'a scheduled book whose meta has not loaded yet is not a source')
eq(pickKitsBook({ ...noKits, meta: { sections: [{ id: 'hardware', name: 'Kit Hardware (cost-based)', sort: 1 }] } }, null).source, null, 'Kit Hardware on its own is not kits — it is what kits are built from')

console.log(`pricingView: ${n} assertions passed`)
