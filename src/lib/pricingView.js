//
// Pricing Portal — pure view rules. No I/O, no Supabase import, so every rule in
// here can be exercised from Node (`node src/lib/pricingView.test.mjs`); the same
// reason components/pricing/hooks.js is split out for lint (D-RMF-04, D-PRICE-42).
//
// What lives here: the tier vocabulary (levels and the D-PRICE-51 column tiers),
// the quote-deviation filter and summary, the Catalog's section search match, and
// the kit-section partition shared by the Price Books and Catalog Kits tabs.
//
// pricing.js re-exports TIERS / TIER_LABELS / TIER_COLORS, so every existing
// `import { TIER_LABELS } from '../../lib/pricing'` keeps working unchanged.
//

// ---------------------------------------------------------------- tiers
// Two kinds of standing level, and they behave differently:
//   • tier1..3 / premier — customer qualifications, applied to the tier columns.
//   • q100 / q300 / q500 — the customer lives on that QUANTITY column whatever the
//     quantity (D-PRICE-51, Matt: "never worse, never better"), falling back to Each
//     when an item's ladder has no such column.
export const LEVEL_TIERS = ['none', 'tier1', 'tier2', 'tier3', 'premier']
export const COLUMN_TIERS = ['q100', 'q300', 'q500']
export const TIERS = [...LEVEL_TIERS, ...COLUMN_TIERS]
export const TIER_LABELS = {
  none: 'No tier', tier1: 'Tier 1', tier2: 'Tier 2', tier3: 'Tier 3', premier: 'Premier',
  q100: '100 column', q300: '300 column', q500: '500 column',
}
// Column tiers are the amber family like Premier, but ringed and stepped light→dark
// so the three are told apart from each other and from Premier's flat amber.
export const TIER_COLORS = {
  none: 'bg-gray-700 text-gray-300',
  tier1: 'bg-sky-900 text-sky-200',
  tier2: 'bg-indigo-900 text-indigo-200',
  tier3: 'bg-violet-900 text-violet-200',
  premier: 'bg-amber-900 text-amber-200',
  q100: 'bg-amber-950 text-amber-300 ring-1 ring-amber-800',
  q300: 'bg-amber-900/60 text-amber-200 ring-1 ring-amber-700',
  q500: 'bg-amber-800/80 text-amber-100 ring-1 ring-amber-500',
}
export const COLUMN_TIER_NOTE = 'A column customer always gets that column — never worse, never better — regardless of quantity.'
export function isColumnTier(tier) { return COLUMN_TIERS.includes(tier) }

// ---------------------------------------------------------------- quote deviations
// deviation_kind comes from v_quote_deviations (D-PRICE-51); the labels are ours.
export const DEVIATION_KINDS = ['manual', 'special', 'column', 'price']
export const DEVIATION_KIND_LABELS = {
  manual: 'Manual price', special: 'Customer special', column: 'Different column', price: 'Price differs',
}
export const DEVIATION_KIND_COLORS = {
  manual: 'bg-rose-900 text-rose-200', special: 'bg-amber-900 text-amber-200',
  column: 'bg-sky-900 text-sky-200', price: 'bg-gray-700 text-gray-300',
}
// Rep and kind are filtered here rather than in the query so switching either is
// instant and the rep list stays complete (it is built from the rows in range).
export function filterDeviations(rows, { rep = 'all', kind = 'all' } = {}) {
  return (rows || []).filter(r =>
    (rep === 'all' || String(r.created_by ?? '') === String(rep))
    && (kind === 'all' || r.deviation_kind === kind))
}
// "below recommendation" is what the deviations cost, so it counts only the lines
// quoted under the book — lines quoted above are reported separately, never netted.
export function summariseDeviations(rows) {
  let below = 0, above = 0, manual = 0
  const quotes = new Set()
  for (const r of rows || []) {
    const d = Number(r.delta_extended)
    if (Number.isFinite(d)) { if (d < 0) below += -d; else above += d }
    if (r.deviation_kind === 'manual') manual++
    if (r.quote_id) quotes.add(r.quote_id)
  }
  return { lines: (rows || []).length, below, above, manual, quotes: quotes.size }
}
// Distinct reps in a row set, for the filter dropdown.
export function deviationReps(rows) {
  const m = new Map()
  for (const r of rows || []) if (r.created_by && !m.has(r.created_by)) m.set(r.created_by, r.created_by_name || '—')
  return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------- catalog search
// Whole-book search matches section NAMES as well as parts (D-PRICE-52 A): plain
// case-insensitive substring, capped, with the overflow reported so the UI can say
// how many more there are rather than silently truncating.
export function matchSections(sections, term, limit = 8) {
  const t = String(term || '').trim().toLowerCase()
  if (!t) return { hits: [], more: 0 }
  const all = (sections || []).filter(s => String(s.name || '').toLowerCase().includes(t))
  return { hits: all.slice(0, limit), more: Math.max(0, all.length - limit) }
}

// The section of another book that corresponds to `section` (D-PRICE-58 — exporting the open
// section under the next revision). Same book: the section itself. Otherwise `source_row`, which
// a clone carries across (Rev 81 → Rev 82: 196 of 196 matched, 0 renamed), and failing that the
// name — but only when exactly one section of the target carries it, because names repeat
// (Rev 82: Flush Head Buttons ×4, Skybolt CLoc® Tools ×6). No match is null, never a guess.
export function findSectionInBook(section, sections) {
  if (!section) return null
  const list = sections || []
  const same = list.find(s => s.id === section.id)
  if (same) return same
  if (section.source_row !== null && section.source_row !== undefined) {
    const hit = list.find(s => s.source_row === section.source_row)
    if (hit) return hit
  }
  const name = String(section.name || '').trim().toLowerCase()
  if (!name) return null
  const byName = list.filter(s => String(s.name || '').trim().toLowerCase() === name)
  return byName.length === 1 ? byName[0] : null
}

// Sections for a search result (D-PRICE-60/61): the ones whose NAME matches (D-PRICE-52 A) and the
// ones that HOUSE a matching part — reps type part-number stems ("QL"), and the section a stem lives
// in is what they are after. One ranking for both: by matching-part count descending, ties name
// before parts, then book order. A name match that houses no matching part has count 0 and sinks to
// the bottom — a bare "SK" matches 145 "Skybolt…" headings by name, and without this they bury every
// section that actually holds SK parts (D-PRICE-61). `partCounts` is { section_id: matching items }
// from searchItemSectionCounts (exact, whole-book); null while it is still loading, which yields the
// name matches alone in book order. Each hit carries `by` ('name' | 'parts') and `matching`. A
// section absent from `sections` — a kit section withdrawn into the Kits tab — is left out, as
// matchSections left it out. `total_parts` is the exact number of matching items across the book.
export function sectionsForSearch(sections, term, partCounts, limit = 20) {
  const t = String(term || '').trim().toLowerCase()
  if (!t) return { hits: [], more: 0, total_parts: null }
  const counts = partCounts || null
  const list = sections || []
  const all = []
  for (const s of list) {
    const byName = String(s.name || '').toLowerCase().includes(t)
    const matching = counts ? Number(counts[s.id] || 0) : 0
    if (byName) all.push({ ...s, by: 'name', matching })
    else if (matching > 0) all.push({ ...s, by: 'parts', matching })
  }
  all.sort((a, b) => b.matching - a.matching || (a.by === b.by ? 0 : a.by === 'name' ? -1 : 1) || (a.sort ?? 0) - (b.sort ?? 0))
  const total = counts ? Object.values(counts).reduce((a, n) => a + Number(n || 0), 0) : null
  return { hits: all.slice(0, limit), more: Math.max(0, all.length - limit), total_parts: total }
}

// ---------------------------------------------------------------- kit sections
// A section belongs to the Kits tab when it actually HOLDS a component_sum, plus the
// Kit Hardware section (cost rows, not sums — matched by name). Partitioning by
// content means a new kit family needs no rename and no list here (D-PRICE-48 add. 2).
export const KIT_HARDWARE_RE = /kit hardware/i
const KIT_ORDER = ['common set', 'cowling', 'option', 'rv kit', 'lancair', 'kit hardware']
export function kitRank(name) {
  const n = String(name || '').toLowerCase()
  const i = KIT_ORDER.findIndex(k => n.includes(k))
  return i === -1 ? KIT_ORDER.length : i
}
// hasSums(section) -> boolean. Kit sections come back in Matt's reading order.
export function partitionKitSections(sections, hasSums) {
  const kit = [], plain = []
  for (const s of sections || []) {
    if (hasSums(s) || KIT_HARDWARE_RE.test(s.name)) kit.push(s); else plain.push(s)
  }
  kit.sort((a, b) => kitRank(a.name) - kitRank(b.name) || a.sort - b.sort)
  return { kitSections: kit, plainSections: plain }
}

// Which book the Catalog's Kits tab reads (D-PRICE-52 F).
//
// "The book in effect has no kits until Oct 1" is not literally true: Rev 81 already carries
// one sum-bearing section, the 16 CLoc 2000 Common Sets (13 of them registry kits), so
// neither "holds a sum" nor "links to the registry" separates it from Rev 82. What actually
// arrives on Oct 1 is the four kit FAMILIES and Kit Hardware — Rev 81 has 1 kit section,
// Rev 82 has 6 — so the rule is a comparison, and it needs no section names to work:
//
//   the scheduled book wins while it has MORE kit sections than the book in effect;
//   otherwise the book in effect; otherwise there is nothing to show.
//
// It self-corrects on Oct 1 (Rev 82 in effect, nothing scheduled beyond it → current), and
// a later clone with the same families ties rather than wins. A book shown ahead of its
// effective date gets the date in the header and the "Fishbowl today" column beside it.
// Each side is { book, meta, sumSectionIds:Set } or null.
export function pickKitsBook(current, scheduled) {
  // A book counts as carrying kits only when a section actually HOLDS a sum. Kit Hardware
  // alone is not kits — it is the cost-based components kits are built from.
  const sectionsOf = (side) => {
    if (!side?.book || !side?.meta) return []
    const sections = side.meta.sections || []
    if (!sections.some(s => side.sumSectionIds?.has(s.id))) return []
    return partitionKitSections(sections, s => side.sumSectionIds?.has(s.id)).kitSections
  }
  const cur = sectionsOf(current), sch = sectionsOf(scheduled)
  if (sch.length > cur.length) return { source: 'scheduled', book: scheduled.book, meta: scheduled.meta, sections: sch, showFishbowl: true }
  if (cur.length) return { source: 'current', book: current.book, meta: current.meta, sections: cur, showFishbowl: false }
  return { source: null, book: null, meta: null, sections: [], showFishbowl: false }
}
