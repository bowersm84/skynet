// lib/fishbowlHealth.js — per-family bridge health for the Order Queue banner (S17 A2, D-FB-63).
// Pure: no Supabase import, so `node --test src/lib/fishbowlHealth.test.mjs` runs it as is.
//
// Each bridge family stamps its own fb_sync_state column when it runs (bridge 1.11, D-FB-58), and a failure is
// recorded in fb_sync_state.family_errors as { [family]: { at, message } } (fb_family_error). An entry is cleared on
// recovery (D-FB-61), and as a second guard it only counts while its `at` is newer than that family's own stamp: a
// family that has run since the failure is healthy whatever the entry says. The heartbeat payload is not read here —
// fb_heartbeat drops keys it does not know (bridge audit §1.4).

// family -> the fb_sync_state column its last run stamps.
export const FAMILY_STAMPS = {
  so: 'last_rev_at',
  picks: 'last_picks_at',
  ships: 'last_shipments_at',
  mos: 'last_mos_at',
  boms: 'last_boms_at',
  tags: 'last_tags_at',
  postings: 'last_postings_at',
  inventory: 'last_inventory_at',
  users: 'last_users_at',
  purchasing: 'last_purchasing_at',
  pricing: 'last_rules_at',
  valuation: 'last_valuation_at',
}

export const FAMILY_LABELS = {
  so: 'SO', picks: 'Picks', ships: 'Ships', mos: 'MOs', boms: 'BOMs', tags: 'Tags', postings: 'Postings',
  inventory: 'Inventory', users: 'Users', purchasing: 'Purchasing', pricing: 'Pricing', valuation: 'Valuation',
}

// Always on the banner, in this order; every other family appears only while it is in error.
export const BANNER_FAMILIES = ['so', 'picks', 'ships', 'mos', 'tags', 'postings', 'boms']

const ms = (v) => {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

// → [{ family, label, lastAt, ageMs, error }] for every mapped family, then any family_errors entry whose family has
// no stamp mapping (shown as-is). error = { at, message } or null.
export function familyHealth(syncState, nowMs = Date.now()) {
  const errors = (syncState && typeof syncState.family_errors === 'object' && syncState.family_errors) || {}
  const out = []
  for (const [family, column] of Object.entries(FAMILY_STAMPS)) {
    const lastAt = syncState?.[column] || null
    const last = ms(lastAt)
    const entry = errors[family] || null
    const at = ms(entry?.at)
    // Shown only when it is newer than the family's last run; an entry with no readable `at`, or a family that has
    // never stamped, cannot be judged and is shown.
    const error = entry && (last === null || at === null || at > last) ? { at: entry.at || null, message: entry.message || '' } : null
    out.push({ family, label: FAMILY_LABELS[family] || family, lastAt, ageMs: last === null ? null : Math.max(0, nowMs - last), error })
  }
  for (const [family, entry] of Object.entries(errors)) {
    if (FAMILY_STAMPS[family]) continue
    out.push({ family, label: FAMILY_LABELS[family] || family, lastAt: null, ageMs: null, error: { at: entry?.at || null, message: entry?.message || '' } })
  }
  return out
}

// The banner row: the always-shown families in their order, then any other family that is in error.
export function bannerFamilies(health) {
  const byFamily = new Map(health.map((h) => [h.family, h]))
  const shown = BANNER_FAMILIES.map((f) => byFamily.get(f)).filter(Boolean)
  return [...shown, ...health.filter((h) => !BANNER_FAMILIES.includes(h.family) && h.error)]
}

// "12 s" · "3 m" · "6 h" · "2 d"; "—" when the family has never run.
export function formatFamilyAge(ageMs) {
  if (ageMs === null || ageMs === undefined) return '—'
  const s = Math.round(ageMs / 1000)
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.round(s / 60)} m`
  if (s < 86400) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400)} d`
}
