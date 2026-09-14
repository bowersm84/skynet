// partCosts.mjs — bridge v1.4 part-cost mirror (D-PRICE-47).
//
// One row per part: the latest RECEIVED purchase-order line (cost, date, PO number, vendor, qty) plus
// Fishbowl's own standard cost. The price book values kit hardware at 2 x this cost (D-PRICE-46/47), so
// a wrong or missing number here shows up as a wrong list price — hence the de-duplication below.
//
// Full read every time: the result is one row per part (a few thousand), so there is no cursor and no
// incremental mode, exactly like the products mirror. Runs inside the caller's Fishbowl session, so no
// second session is ever opened (D-FB-37).
import { q } from './queries.mjs'
import { chunk, mapPartCost } from './mapper.mjs'

// fb_upsert_part_costs derives its primary key server-side as
//   upper(regexp_replace(coalesce(product_num, part_num), '\s', '', 'g'))
// and the whole payload lands in ONE `insert ... on conflict (part_key) do update`. Postgres raises
// "ON CONFLICT DO UPDATE command cannot affect row a second time" if a key appears twice in the same
// statement, so a duplicate would fail the entire batch rather than merely pick a winner. Two Fishbowl
// rows can collide here: PO lines tied on the same dateLastFulfillment for one part, and two parts that
// share a default product. Both are resolved here, deterministically, before anything is sent.
function partKey(r) {
  return String(r.product_num ?? r.part_num ?? '').toUpperCase().replace(/\s/g, '')
}

// Newest cost wins; on an exact date tie the higher fb_part_id wins, purely so the choice is stable
// across runs rather than dependent on MySQL's row order.
function better(a, b) {
  const da = a.last_cost_date || '', db = b.last_cost_date || ''
  if (da !== db) return da > db ? a : b
  return Number(b.fb_part_id ?? 0) > Number(a.fb_part_id ?? 0) ? b : a
}

export function dedupePartCosts(rows) {
  const byKey = new Map()
  let dropped = 0
  for (const r of rows) {
    const k = partKey(r)
    if (!k) continue
    const seen = byKey.get(k)
    if (seen) { dropped++; byKey.set(k, better(seen, r)) } else { byKey.set(k, r) }
  }
  return { rows: [...byKey.values()], dropped }
}

export async function syncPartCosts(fb, sky, { log, batch = 500 } = {}) {
  const raw = await fb.query(q.partCosts)
  const mapped = raw.map(mapPartCost).filter((r) => r.part_num !== null && r.part_num !== '')
  const { rows, dropped } = dedupePartCosts(mapped)
  if (dropped) {
    log.warn(`part costs: ${dropped} duplicate part key(s) collapsed (PO lines tied on the same receipt date, or parts sharing a default product)`)
  }
  let upserted = 0
  for (const part of chunk(rows, batch)) upserted += Number(await sky.upsertPartCosts(part)) || 0
  log.info(`part costs: ${raw.length} part(s) read, ${upserted} upserted`)
  return { read: raw.length, upserted, dropped }
}
