// Unit test for the sync-kits planning layer (D-PRICE-49).
// Run: node supabase/functions/sync-kits/plan.test.mjs
// Node 24 strips the types from plan.ts on import, so no build step and no Deno needed.

import { planSync, componentsDiffer, normKey, skKey, round2, STALE_MARK } from './plan.ts'

const reg = (o) => ({
  kit_number: 'X', description: 'd', family: 'Cowling Kit', is_active: true, in_book: true,
  book_id: 'b1', book_label: 'Rev 82 — Oct 2026', effective_from: '2026-10-01',
  list_price: 100, resolved: true, component_count: 2, unpriced_count: 0, unpriced_keys: [],
  bom: [{ component: 'A1', description: 'a', qty: 2, each: 25 }, { component: 'B2', description: 'b', qty: 1, each: 50 }],
  ...o,
})
const site = (o) => ({ kit_number: 'X', description: 'd', family: 'Cowling Kit', status: 'active', ...o })
const price = (o) => ({ id: 1, kit_number: 'X', list_price: 100, effective_date: '2026-10-01', source: 'July workbook', is_current: true, ...o })
const comp = (o) => ({ id: 1, kit_number: 'X', line: 1, component_number: 'A1', component_description: 'a', qty: 2, ...o })

const registry = [
  reg({ kit_number: 'AC500-C1', list_price: 3380.44 }),                                    // exact, price changed
  reg({ kit_number: 'SK4P3-T26', list_price: 12.5 }),                                      // SK-prefix match
  reg({ kit_number: 'UNCHANGED-1', list_price: 100 }),                                     // exact, no change
  reg({ kit_number: 'RV1014J-C1P', resolved: false, list_price: null, unpriced_count: 1,   // unresolved -> STALE
        component_count: 18, unpriced_keys: ['MS21059L3'] }),
  reg({ kit_number: 'TRIM-9', is_active: false, family: 'Trim Kit' }),                      // inactive -> discontinued
  reg({ kit_number: 'NOTINBOOK-1', in_book: false, list_price: null, resolved: false }),    // active, not in book
  reg({ kit_number: 'REGISTRY-ONLY-1' }),                                                   // no site row
]
const siteKits = [
  site({ kit_number: 'AC500-C1' }),
  site({ kit_number: '4P3-T26', family: 'Option Kit' }),        // historical spelling + stale family
  site({ kit_number: 'UNCHANGED-1' }),
  site({ kit_number: 'RV1014J-C1P' }),
  site({ kit_number: 'TRIM-9', family: 'Trim Kit' }),
  site({ kit_number: 'NOTINBOOK-1' }),
  site({ kit_number: 'SITE-ONLY-1' }),                          // site has it, registry does not
]
const sitePrices = [
  price({ id: 10, kit_number: 'AC500-C1', list_price: 3100.00 }),
  price({ id: 11, kit_number: '4P3-T26', list_price: 12.5, effective_date: '2026-06-01' }),  // same price, older date
  price({ id: 12, kit_number: 'UNCHANGED-1', list_price: 100 }),
  price({ id: 13, kit_number: 'RV1014J-C1P', list_price: 900 }),
  price({ id: 14, kit_number: 'TRIM-9', list_price: 55 }),
  price({ id: 15, kit_number: 'NOTINBOOK-1', list_price: 44 }),
]
const siteComponents = [
  comp({ id: 100, kit_number: 'AC500-C1', component_number: 'A1', qty: 2 }),
  comp({ id: 101, kit_number: 'AC500-C1', line: 2, component_number: 'B2', qty: 1 }),
  comp({ id: 102, kit_number: 'UNCHANGED-1', component_number: 'A1', qty: 2 }),
  comp({ id: 103, kit_number: 'UNCHANGED-1', line: 2, component_number: 'B2', qty: 1 }),
  comp({ id: 104, kit_number: '4P3-T26', component_number: 'A1', qty: 9 }),                 // qty drift -> rewrite
]

const plan = planSync({ registry, siteKits, sitePrices, siteComponents })
const by = (k) => plan.actions.find(a => a.registry_kit_number === k)

const t = []
const eq = (label, got, want) => t.push([`${label} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want)])

// --- helpers -------------------------------------------------------------------------------
t.push(['normKey strips space and upper-cases', normKey(' ac500 c1 ') === 'AC500C1'])
t.push(['skKey drops a leading SK', skKey('SK4P3-T26') === '4P3-T26' && skKey('4P3-T26') === '4P3-T26'])
t.push(['round2 halves up', round2(3380.435) === 3380.44 && round2(null) === null])
t.push(['componentsDiffer is a set compare, order-insensitive',
  componentsDiffer([comp({ component_number: 'B2', qty: 1 }), comp({ component_number: 'A1', qty: 2 })],
    [{ component: 'A1', qty: 2 }, { component: 'B2', qty: 1 }]) === false])
t.push(['componentsDiffer catches a qty change',
  componentsDiffer([comp({ component_number: 'A1', qty: 3 })], [{ component: 'A1', qty: 2 }]) === true])

// --- matching ------------------------------------------------------------------------------
eq('AC500-C1 matches exactly', by('AC500-C1')?.match, 'exact')
eq('SK4P3-T26 matches the site 4P3-T26 by SK prefix', by('SK4P3-T26')?.match, 'sk_prefix')
eq('SK4P3-T26 writes against the SITE spelling', by('SK4P3-T26')?.kit_number, '4P3-T26')
eq('registry-only kit reported', plan.unmatched_registry_only, ['REGISTRY-ONLY-1'])
eq('site-only kit reported', plan.unmatched_site_only, ['SITE-ONLY-1'])

// --- actions -------------------------------------------------------------------------------
eq('changed price writes', by('AC500-C1')?.action, 'price_write')
eq('changed price supersedes the old row', by('AC500-C1')?.supersede_price_ids, [10])
eq('changed price carries the book price', by('AC500-C1')?.book_price, 3380.44)
eq('same price but older effective date still writes', by('SK4P3-T26')?.action, 'price_write')
eq('unchanged price is left alone', by('UNCHANGED-1')?.action, 'price_unchanged')
eq('unchanged kit supersedes nothing', by('UNCHANGED-1')?.supersede_price_ids, [])
eq('unresolved kit is marked stale', by('RV1014J-C1P')?.action, 'stale_mark')
t.push(['stale source names the count and keeps the old source',
  by('RV1014J-C1P')?.stale_source?.includes(STALE_MARK) && by('RV1014J-C1P')?.stale_source?.includes('July workbook')])
eq('unresolved kit does not supersede its price', by('RV1014J-C1P')?.supersede_price_ids, [])
eq('inactive kit is discontinued', by('TRIM-9')?.action, 'discontinue')
eq('discontinued kit loses its current price', by('TRIM-9')?.supersede_price_ids, [14])
eq('active but not in book is reported only', by('NOTINBOOK-1')?.action, 'active_not_in_book')
eq('not-in-book kit changes no price', by('NOTINBOOK-1')?.supersede_price_ids, [])

// --- family + components -------------------------------------------------------------------
eq('family follows the registry', by('SK4P3-T26')?.family_update, 'Cowling Kit')
t.push(['matching family is left alone', by('AC500-C1')?.family_update === null])
t.push(['BOM drift triggers a rewrite', Array.isArray(by('SK4P3-T26')?.components_rewrite)])
t.push(['matching BOM does not', by('AC500-C1')?.components_rewrite === null])
t.push(['a not-in-book kit never rewrites components', by('NOTINBOOK-1')?.components_rewrite === null])

// --- counts --------------------------------------------------------------------------------
eq('counts', plan.counts, {
  kits_seen: 7, matched: 6, prices_written: 2, prices_unchanged: 1, stale_marked: 1,
  discontinued: 1, components_rewritten: 2, active_not_in_book: 1, family_updated: 1,
})

// --- the two hard rules ----------------------------------------------------------------------
t.push(['no action ever targets a site-only kit',
  plan.actions.every(a => a.kit_number !== 'SITE-ONLY-1')])
t.push(['no action is planned for an unmatched registry kit',
  plan.actions.every(a => a.registry_kit_number !== 'REGISTRY-ONLY-1')])

let bad = 0
for (const [label, ok] of t) { if (!ok) bad++; console.log((ok ? 'PASS  ' : 'FAIL  ') + label) }
console.log(`\n${t.length - bad}/${t.length} passed`)
process.exit(bad ? 1 : 0)
