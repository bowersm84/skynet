// SkyNet — sync-kits planning layer (D-PRICE-49).
//
// Pure. No imports, no network, no Deno APIs — index.ts does the I/O and this file decides what
// should happen. Kept separate so the matching and diff rules can be unit-tested from Node without
// a Deno runtime or either database.
//
// The one rule that matters: this module never plans an insert into `kits` and never plans a delete
// of a `kits` or `kit_pricing` row. The site's kit list is the site's; SkyNet only prices it.

export interface RegistryBomLine {
  component: string
  description: string | null
  qty: number
  each: number | null
}

export interface RegistryKit {
  kit_number: string
  description: string | null
  family: string | null
  is_active: boolean
  in_book: boolean
  book_id: string | null
  book_label: string | null
  effective_from: string | null
  list_price: number | null
  resolved: boolean
  component_count: number
  unpriced_count: number
  unpriced_keys: string[] | null
  bom: RegistryBomLine[] | null
}

export interface SiteKit {
  kit_number: string
  description: string | null
  family: string | null
  status: string
}

export interface SitePrice {
  id: number | string
  kit_number: string
  list_price: number | null
  effective_date: string | null
  source: string | null
  is_current: boolean
}

export interface SiteComponent {
  id?: number | string
  kit_number: string
  line: number
  component_number: string
  component_description: string | null
  qty: number
}

export type ActionKind =
  | 'price_write'
  | 'price_unchanged'
  | 'stale_mark'
  | 'discontinue'
  | 'active_not_in_book'
  | 'no_change'

export interface PlannedAction {
  kit_number: string          // the SITE's spelling — that is what we write against
  registry_kit_number: string
  match: 'exact' | 'normalized' | 'sk_prefix'
  action: ActionKind
  site_price: number | null
  book_price: number | null
  effective_date: string | null
  reason: string
  family_update: string | null       // new family value, or null for no change
  components_rewrite: RegistryBomLine[] | null
  supersede_price_ids: (number | string)[]   // current rows to flip is_current = false
  stale_source: string | null        // new source text when marking STALE
}

export interface SyncCounts {
  kits_seen: number
  matched: number
  prices_written: number
  prices_unchanged: number
  stale_marked: number
  discontinued: number
  components_rewritten: number
  active_not_in_book: number
  family_updated: number
}

export interface SyncPlan {
  actions: PlannedAction[]
  counts: SyncCounts
  unmatched_registry_only: string[]
  unmatched_site_only: string[]
}

// Upper-case and drop every whitespace character. Matches the part_key convention used throughout
// the pricing layer (D-PRICE-48) so a kit number spelled with a stray space still lands.
export function normKey(s: unknown): string {
  return String(s ?? '').toUpperCase().replace(/\s+/g, '')
}

// The site carries a handful of historical spellings that differ from kit_skus by a leading "SK"
// — 4P3-T26 on the site against SK4P3-T26 in the registry. Whitespace stripping alone cannot bridge
// those, so a third pass drops a leading SK from both sides. Used ONLY for rows still unmatched
// after the exact and whitespace passes, and only when it resolves to exactly one candidate, so it
// can never quietly re-point a kit that already matched.
export function skKey(s: unknown): string {
  return normKey(s).replace(/^SK/, '')
}

export function round2(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : null
}

// Set comparison on component number + qty, exactly as the brief specifies: line order and
// description drift do not by themselves justify rewriting a kit's component rows.
export function componentsDiffer(siteRows: SiteComponent[], bom: RegistryBomLine[] | null): boolean {
  const a = new Set((siteRows || []).map(r => `${normKey(r.component_number)}|${Number(r.qty)}`))
  const b = new Set((bom || []).map(r => `${normKey(r.component)}|${Number(r.qty)}`))
  if (a.size !== b.size) return true
  for (const k of b) if (!a.has(k)) return true
  return false
}

export const STALE_MARK = 'STALE: SkyNet'

function staleSource(existing: string | null, unpriced: number): string {
  const base = (existing || '').trim()
  const note = `${STALE_MARK}, ${unpriced} component${unpriced === 1 ? '' : 's'} unpriced`
  if (base.includes('STALE')) return base
  return base ? `${base} — ${note}` : note
}

/**
 * Decide every change for one run. Nothing here talks to a database; index.ts applies the result.
 */
export function planSync(input: {
  registry: RegistryKit[]
  siteKits: SiteKit[]
  sitePrices: SitePrice[]
  siteComponents: SiteComponent[]
}): SyncPlan {
  const registry = input.registry || []
  const siteKits = input.siteKits || []
  const sitePrices = input.sitePrices || []
  const siteComponents = input.siteComponents || []

  // --- match ---------------------------------------------------------------------------------
  const byExact = new Map<string, SiteKit>()
  const byNorm = new Map<string, SiteKit[]>()
  const bySk = new Map<string, SiteKit[]>()
  for (const s of siteKits) {
    byExact.set(s.kit_number, s)
    const n = normKey(s.kit_number); const k = skKey(s.kit_number)
    byNorm.set(n, [...(byNorm.get(n) || []), s])
    bySk.set(k, [...(bySk.get(k) || []), s])
  }

  const pairs: { reg: RegistryKit; site: SiteKit; match: PlannedAction['match'] }[] = []
  const unmatchedRegistry: string[] = []
  const usedSite = new Set<string>()

  for (const reg of registry) {
    const exact = byExact.get(reg.kit_number)
    if (exact && !usedSite.has(exact.kit_number)) {
      pairs.push({ reg, site: exact, match: 'exact' }); usedSite.add(exact.kit_number); continue
    }
    const norm = (byNorm.get(normKey(reg.kit_number)) || []).filter(s => !usedSite.has(s.kit_number))
    if (norm.length === 1) {
      pairs.push({ reg, site: norm[0], match: 'normalized' }); usedSite.add(norm[0].kit_number); continue
    }
    const sk = (bySk.get(skKey(reg.kit_number)) || []).filter(s => !usedSite.has(s.kit_number))
    if (sk.length === 1) {
      pairs.push({ reg, site: sk[0], match: 'sk_prefix' }); usedSite.add(sk[0].kit_number); continue
    }
    unmatchedRegistry.push(reg.kit_number)
  }
  const unmatchedSite = siteKits.filter(s => !usedSite.has(s.kit_number)).map(s => s.kit_number)

  // --- index the site's current state ---------------------------------------------------------
  const currentByKit = new Map<string, SitePrice[]>()
  for (const p of sitePrices) {
    if (!p.is_current) continue
    currentByKit.set(p.kit_number, [...(currentByKit.get(p.kit_number) || []), p])
  }
  const compsByKit = new Map<string, SiteComponent[]>()
  for (const c of siteComponents) {
    compsByKit.set(c.kit_number, [...(compsByKit.get(c.kit_number) || []), c])
  }

  // --- decide ---------------------------------------------------------------------------------
  const actions: PlannedAction[] = []
  const counts: SyncCounts = {
    kits_seen: registry.length, matched: pairs.length, prices_written: 0, prices_unchanged: 0,
    stale_marked: 0, discontinued: 0, components_rewritten: 0, active_not_in_book: 0, family_updated: 0,
  }

  for (const { reg, site, match } of pairs) {
    const current = currentByKit.get(site.kit_number) || []
    const sitePrice = round2(current[0]?.list_price ?? null)
    const bookPrice = round2(reg.list_price)
    const familyUpdate = reg.family && reg.family !== site.family ? reg.family : null

    const base = {
      kit_number: site.kit_number,
      registry_kit_number: reg.kit_number,
      match,
      site_price: sitePrice,
      book_price: bookPrice,
      effective_date: reg.effective_from,
      family_update: familyUpdate,
      components_rewrite: null as RegistryBomLine[] | null,
      supersede_price_ids: [] as (number | string)[],
      stale_source: null as string | null,
    }
    if (familyUpdate) counts.family_updated++

    // A kit retired in the registry must never take a new price, even if it is still in the book.
    if (!reg.is_active) {
      actions.push({ ...base, action: 'discontinue', reason: 'registry kit is inactive',
        supersede_price_ids: current.map(p => p.id) })
      counts.discontinued++
      continue
    }

    if (!reg.in_book) {
      actions.push({ ...base, action: 'active_not_in_book', reason: 'active but not in the book in effect' })
      counts.active_not_in_book++
      continue
    }

    // Components follow the book for every kit that is in it, priced or not.
    const siteComps = compsByKit.get(site.kit_number) || []
    const rewrite = componentsDiffer(siteComps, reg.bom) ? (reg.bom || []) : null
    if (rewrite) counts.components_rewritten++

    if (!reg.resolved) {
      const existing = current[0]?.source ?? null
      const next = staleSource(existing, reg.unpriced_count)
      const already = (existing || '').includes('STALE')
      if (!already) counts.stale_marked++
      actions.push({
        ...base, action: 'stale_mark', components_rewrite: rewrite,
        reason: `${reg.unpriced_count} of ${reg.component_count} components unpriced${reg.unpriced_keys?.length ? `: ${reg.unpriced_keys.join(', ')}` : ''}`,
        stale_source: already ? null : next,
      })
      continue
    }

    const changed = sitePrice !== bookPrice || (current[0]?.effective_date ?? null) !== (reg.effective_from ?? null)
    if (!changed && current.length === 1) {
      actions.push({ ...base, action: 'price_unchanged', components_rewrite: rewrite, reason: 'price and effective date already match' })
      counts.prices_unchanged++
      continue
    }
    actions.push({
      ...base, action: 'price_write', components_rewrite: rewrite,
      reason: current.length ? 'book price differs from the current row' : 'no current price on file',
      supersede_price_ids: current.map(p => p.id),
    })
    counts.prices_written++
  }

  return {
    actions,
    counts,
    unmatched_registry_only: unmatchedRegistry,
    unmatched_site_only: unmatchedSite,
  }
}
