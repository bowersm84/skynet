// sync.mjs — shared "fetch full current state of these SOs" step used by the tail, the reconciler and the backfill.
import { q } from './queries.mjs'
import { buildOrders, chunk, int, ts } from './mapper.mjs'

// Returns { orders, missingIds }. missingIds = ids that no longer exist in Fishbowl (hard-deleted SO).
export async function fetchOrders(fb, ids, revById = new Map()) {
  if (ids.length === 0) return { orders: [], missingIds: [] }
  const headers = await fb.query(q.headers(ids))
  const lines = headers.length ? await fb.query(q.lines(headers.map((h) => h.id))) : []
  const orders = buildOrders(headers, lines, revById)
  const found = new Set(orders.map((o) => o.header.id))
  const missingIds = ids.map(Number).filter((id) => !found.has(id))
  return { orders, missingIds }
}

// Fetches + ingests a list of SO ids in chunks. Only the LAST chunk carries rev_to so the cursor
// cannot advance past work that has not been ingested yet. Returns totals.
export async function ingestIds(fb, sky, ids, { source, revFrom = null, revTo = null, revById = new Map(), chunkSize = 50, log }) {
  const parts = chunk(ids, chunkSize)
  const totals = { orders: 0, missing: 0, result: null }
  if (parts.length === 0) {
    totals.result = await sky.ingest({ source, rev_from: revFrom, rev_to: revTo, orders: [], removed_ids: [] })
    return totals
  }
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1
    const { orders, missingIds } = await fetchOrders(fb, parts[i], revById)
    const res = await sky.ingest({
      source,
      rev_from: last ? revFrom : null,
      rev_to: last ? revTo : null,
      orders,
      removed_ids: missingIds,
    })
    totals.orders += orders.length
    totals.missing += missingIds.length
    totals.result = res
    if (log) log.info(`${source}: chunk ${i + 1}/${parts.length} orders=${orders.length} missing=${missingIds.length} → ${JSON.stringify(res)}`)
  }
  return totals
}

// Builds Map(soId -> {rev, userId, ts}) for a revision window so events carry who/when from Fishbowl.
export async function revisionMap(fb, from, to) {
  const rows = await fb.query(q.soRevs(from, to))
  const revs = [...new Set(rows.map((r) => Number(r.rev)))]
  const info = revs.length ? await fb.query(q.revInfo(revs)) : []
  const byRev = new Map(info.map((r) => [Number(r.id), r]))
  const map = new Map()
  for (const r of rows) {
    const i = byRev.get(Number(r.rev)) || {}
    map.set(Number(r.soId), { rev: Number(r.rev), userId: int(i.modifiedUserId), ts: ts(i.timestamp) })
  }
  return map
}
