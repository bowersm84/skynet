// rulesTree.mjs — bridge v1.7 read-only mirrors for the Fishbowl pricing link (D-PRICE-53):
//   pricing rules  nightly, full snapshot of `pricingrule` with its type ids resolved to names
//   product tree   nightly, every category (`producttree`) with its full path plus every membership
//                  row (`producttotree`); paths are built here, in JS, so no recursive SQL is needed
//
// Both run inside the caller's Fishbowl session (index.mjs `withSession`) like the v1.3 mirrors
// (D-FB-37). The table and column names came from the discovery pass in scripts/fb-columns.mjs
// (Fishbowl 25.9, 2026-09-2x) — if a query fails, re-run discovery; do not guess.
import { q } from './queries.mjs'
import { chunk, ts, int, num, bool } from './mapper.mjs'

// Map(nodeId -> full path 'Product:SkyNet:A:standard') from the flat category rows.
export function buildPaths(nodes) {
  const byId = new Map(nodes.map((n) => [Number(n.id), n]))
  const cache = new Map()
  const pathOf = (id, depth = 0) => {
    if (cache.has(id)) return cache.get(id)
    const n = byId.get(id)
    if (!n) return null
    if (depth > 50) throw new Error(`product tree: cycle or depth > 50 at node ${id}`)
    const parent = n.parentId === null || n.parentId === undefined ? null : Number(n.parentId)
    const parentPath = parent === null || parent === id ? null : pathOf(parent, depth + 1)
    const p = parentPath ? `${parentPath}:${n.name}` : String(n.name)
    cache.set(id, p)
    return p
  }
  for (const id of byId.keys()) pathOf(id)
  return cache
}

export function mapRule(r, paths) {
  const inclType = r.productInclType ?? null
  const product = inclType === 'Product' ? (r.productNum ?? null)
    : inclType === 'Product Tree' ? (paths.get(Number(r.productInclId)) ?? null)
    : null
  return {
    id: int(r.id), name: r.name ?? '', description: r.description ?? null, isActive: bool(r.isActive) ?? true,
    productInclType: inclType, product,
    customerInclType: r.customerInclType ?? null, customer: r.customerName ?? null,
    paApplies: bool(r.paApplies), paType: r.paType ?? null, paPercent: num(r.paPercent), paBaseAmountType: r.paBaseAmountType ?? null, paAmount: num(r.paAmount),
    rndApplies: bool(r.rndApplies), roundType: r.roundType ?? null, rndToAmount: num(r.rndToAmount), rndIsMinus: bool(r.rndIsMinus), rndPMAmount: num(r.rndPMAmount),
    dateApplies: bool(r.dateApplies), dateBegin: ts(r.dateBegin), dateEnd: ts(r.dateEnd),
    qtyApplies: bool(r.qtyApplies), qtyMin: num(r.qtyMin), qtyMax: num(r.qtyMax),
    isAutoApply: bool(r.isAutoApply), isTier2: bool(r.isTier2),
    dateCreated: ts(r.dateCreated), dateLastModified: ts(r.dateLastModified),
  }
}

// Full product tree: nodes with paths + memberships. Returns the counts written.
export async function syncProductTree(fb, sky, { log, batch = 500 } = {}) {
  const nodeRows = await fb.query(q.productTreeNodes)
  const paths = buildPaths(nodeRows)
  const nodes = nodeRows.map((n) => ({ id: int(n.id), name: String(n.name ?? ''), parentId: int(n.parentId), path: paths.get(Number(n.id)) }))
    .filter((n) => n.id !== null && n.path)
  const memberRows = await fb.query(q.productTreeMembers)
  const members = memberRows.map((m) => ({
    productId: int(m.productId), productNum: String(m.productNum ?? ''), nodeId: int(m.nodeId), path: paths.get(Number(m.nodeId)) ?? null,
  })).filter((m) => m.productId !== null && m.nodeId !== null && m.path && m.productNum !== '')
  // One RPC call with the whole snapshot: the RPC marks anything absent as removed, so it must see everything at once.
  // ~430 nodes and a few thousand memberships is well inside the PostgREST body limit.
  const n = await sky.upsertProductTree(nodes, members)
  log.info(`product tree: ${nodes.length} node(s), ${members.length} membership row(s) read, ${n} upserted`)
  return { nodes: nodes.length, members: members.length, upserted: n, paths }
}

// Full pricing-rule snapshot. `paths` may be passed from a tree sync in the same slot to save a read.
export async function syncPricingRules(fb, sky, { log, paths = null } = {}) {
  if (!paths) paths = buildPaths(await fb.query(q.productTreeNodes))
  const rows = await fb.query(q.pricingRules)
  const mapped = rows.map((r) => mapRule(r, paths)).filter((r) => r.id !== null && r.name !== '')
  const unresolvedTree = mapped.filter((r) => r.productInclType === 'Product Tree' && !r.product).length
  if (unresolvedTree > 0) log.warn(`pricing rules: ${unresolvedTree} tree rule(s) point at a node the tree read does not contain`)
  const n = await sky.upsertPricingRules(mapped)
  log.info(`pricing rules: ${rows.length} read (${mapped.filter((r) => r.isActive).length} active), ${n} upserted`)
  return { read: rows.length, upserted: n }
}

// unused import guard for chunk (kept for symmetry with pricing.mjs; large snapshots go in one call on purpose)
void chunk
