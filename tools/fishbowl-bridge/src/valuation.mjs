// valuation.mjs — bridge v1.8 nightly valuation mirror (D-FB-52).
//
// One row per Fishbowl part with typeId = 10: the opening-valuation query of 2026-10-06 (class from
// part.customFields '$."33".value', quantity = SUM(tag.qty), partcost.avgCost / totalCost / qty), read
// in full every night in the products slot after part costs, and written through fb_upsert_part_valuation
// in batches. fb_finish_part_valuation then retires rows that were not in tonight's read, using the DB
// clock only (max synced_at minus a window), so a bridge PC whose clock is off can never retire fresh rows.
// Every class is mirrored; SkyNet filters to 'Product' (S13 Decision 7).
//
// The mapper is pure so valuation.test.mjs can run it under plain `node --test`.
import { q } from './queries.mjs'
import { chunk, int, num, bool } from './mapper.mjs'

export const UNCLASSIFIED = '(unclassified)'

// Fishbowl's custom field arrives as text; an empty/missing value is the explicit unclassified bucket so
// the Stock Levels QA filter can list product parts nobody has classed yet.
export function normalizeClass(v) {
  const s = v === null || v === undefined ? '' : String(v).trim()
  return s === '' ? UNCLASSIFIED : s
}

// The query emits 'Y'/'N' for the two EXISTS flags (as the opening query did); accept the usual
// Fishbowl boolean spellings too.
function yn(v) {
  if (v === null || v === undefined || v === '') return false
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toUpperCase()
  return s === 'Y' || s === 'YES' || s === '1' || s === 'TRUE' || s === 'T'
}

// Output keys are exactly what fb_upsert_part_valuation reads (camelCase, like fb_upsert_inventory).
export function mapPartValuation(r) {
  return {
    partNum: r.partNum === null || r.partNum === undefined ? '' : String(r.partNum).trim(),
    partId: int(r.partId),
    description: r.description === null || r.description === undefined ? null : String(r.description),
    activeFlag: bool(r.activeFlag) ?? true,
    valuationClass: normalizeClass(r.valuationClass),
    qtyOnHand: num(r.qtyOnHand) ?? 0,
    avgCost: num(r.avgCost),
    totalCost: num(r.totalCost),
    costLayerQty: num(r.costLayerQty),
    hasProduct: yn(r.hasProduct),
    usedInBoms: yn(r.usedInBoms),
  }
}

export function classCounts(rows) {
  const out = {}
  for (const r of rows || []) out[r.valuationClass] = (out[r.valuationClass] || 0) + 1
  return out
}

export async function syncPartValuation(fb, sky, { log, batch = 500 } = {}) {
  const raw = await fb.query(q.partValuation)
  const rows = raw.map(mapPartValuation).filter((r) => r.partNum !== '')
  let upserted = 0
  for (const part of chunk(rows, batch)) upserted += Number(await sky.upsertPartValuation(part)) || 0
  const removed = Number(await sky.finishPartValuation()) || 0
  const by = classCounts(rows)
  log.info(`valuation: ${raw.length} part(s) read, ${upserted} upserted, ${removed} retired`
    + ` · Product ${by.Product || 0} · Non-Product ${by['Non-Product'] || 0} · Tooling - MRO ${by['Tooling - MRO'] || 0}`
    + ` · Raw ${by['Raw - SkyNet Inventory'] || 0} · unclassified ${by[UNCLASSIFIED] || 0}`)
  return { read: raw.length, upserted, removed, byClass: by }
}
