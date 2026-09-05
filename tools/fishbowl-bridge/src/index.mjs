// index.mjs — SkyNet Fishbowl Bridge. Read-only against Fishbowl; writes to SkyNet only through fb_* RPCs.
//   node src/index.mjs             run forever (this is what the Windows service runs)
//   node src/index.mjs --once      one tail + one reconcile pass, then exit (smoke test)
//   node src/index.mjs --backfill  one full customers + products + SO history load, then exit (v1.3)
import { config } from './config.mjs'
import { Fishbowl } from './fishbowl.mjs'
import { SkyNet, makeLogger } from './skynet.mjs'
import { q } from './queries.mjs'
import { ts, chunk } from './mapper.mjs'
import { ingestIds, revisionMap } from './sync.mjs'
import { syncCustomers, syncProducts, syncHistory, nightlyDue } from './pricing.mjs'

const log = makeLogger(config.logDir)
const fb = new Fishbowl(config.fb, log)
const sky = new SkyNet(config.sb, log)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let lastRev = null          // in-memory copy of fb_sync_state.last_rev
let lastReconcileAt = 0
let lastInventoryAt = 0
let lastUsersAt = 0
let lastCustomersRunAt = 0  // in-process interval clock for the customers poller
let pricing = null          // in-memory copy of fb_sync_state.last_*_at / history_cursor (D-PRICE-26)
let pricingPausedUntil = 0  // set after a pricing failure so a broken poller cannot hot-loop
const PRICING_RETRY_MS = 900000
let stopping = false
let failures = 0

// D-FB-34: Fishbowl user list (names only) so events can say who changed an order.
async function syncUsers() {
  const rows = await fb.query(q.users)
  const n = await sky.upsertUsers(rows.map((r) => ({
    id: r.id, userName: r.userName, firstName: r.firstName, lastName: r.lastName, activeFlag: r.activeFlag,
  })))
  log.info(`users: ${rows.length} read, ${n} upserted`)
  return n
}

// D-FB-33: inventory snapshot for the parts on open SO lines. qtyinventorytotals is per location group;
// "available" sums only the configured groups (default Main + Warehouse) and every group is kept for the tooltip.
async function syncInventory() {
  const partIds = await sky.openPartIds()
  if (partIds.length === 0) return 0
  const avail = new Set(config.availableLocationGroups)
  const byPart = new Map()
  for (const ids of chunk(partIds, 300)) {
    const rows = await fb.query(q.inventory(ids))
    for (const r of rows) {
      const partId = Number(r.partId)
      const lg = Number(r.locationGroupId)
      const onHand = Number(r.qtyOnHand) || 0
      const allocated = Number(r.qtyAllocated) || 0
      const notAvailable = Number(r.qtyNotAvailable) || 0
      const onOrder = Number(r.qtyOnOrder) || 0
      if (!byPart.has(partId)) {
        byPart.set(partId, { partId, partNum: r.partNum, onHand: 0, allocated: 0, notAvailable: 0, onOrder: 0, available: 0, byLocation: {} })
      }
      const p = byPart.get(partId)
      p.onHand += onHand
      p.allocated += allocated
      p.notAvailable += notAvailable
      p.onOrder += onOrder
      if (avail.has(lg)) p.available += onHand - allocated - notAvailable
      p.byLocation[lg] = { onHand, allocated, notAvailable, onOrder }
    }
  }
  let total = 0
  for (const rows of chunk([...byPart.values()], 500)) {
    total += Number(await sky.upsertInventory(rows)) || 0
  }
  log.info(`inventory: ${partIds.length} part(s) on open SOs, ${byPart.size} found in Fishbowl, ${total} upserted`)
  return total
}

// D-PRICE-26: the three pricing mirrors. All three run inside the caller's Fishbowl session — no
// second session is ever opened (D-FB-37) — and each RPC stamps its own fb_sync_state clock, which is
// mirrored into `pricing` so the schedule survives a restart without re-reading the row every cycle.
async function pricingCycle({ force = false } = {}) {
  const now = new Date()

  if (force || Date.now() - lastCustomersRunAt >= config.customersMs) {
    await syncCustomers(fb, sky, {
      since: force ? null : pricing.last_customers_at,
      log,
      batch: config.pricingBatch,
    })
    lastCustomersRunAt = Date.now()
    pricing.last_customers_at = now.toISOString()
  }

  if (force || nightlyDue(pricing.last_products_at, config.productsNightlyAt, now)) {
    await syncProducts(fb, sky, { log, batch: config.pricingBatch })
    pricing.last_products_at = new Date().toISOString()
  }

  if (force || nightlyDue(pricing.last_history_at, config.historyNightlyAt, now)) {
    const cursor = force ? config.historyBackfillFrom : (pricing.history_cursor || config.historyBackfillFrom)
    if (!pricing.history_cursor && !force) log.info(`history: no stored cursor — first load from ${cursor}`)
    const totals = await syncHistory(fb, sky, {
      cursor, log, pageSize: config.historyPage, batch: config.pricingBatch,
    })
    pricing.history_cursor = totals.cursor
    pricing.last_history_at = new Date().toISOString()
  }
}

// The pricing mirrors must never take the Order Queue's feed down with them: a failure is logged and the
// pollers stand down for PRICING_RETRY_MS while the tail keeps running. Standing down matters — a nightly
// job whose clock was not stamped is due again on the very next cycle, so an unguarded failure would
// hot-loop a broken query every 20 s. Staleness surfaces as the three ages on /pricing.
async function pricingCycleGuarded() {
  if (Date.now() < pricingPausedUntil) return
  try {
    await pricingCycle()
  } catch (e) {
    pricingPausedUntil = Date.now() + PRICING_RETRY_MS
    log.error(`pricing cycle failed, retrying in ${PRICING_RETRY_MS / 60000} min: ${e.message}`)
  }
}

async function tail() {
  const [{ maxRev }] = await fb.query(q.maxRev)
  const max = Number(maxRev) || 0
  if (lastRev === null) {
    lastRev = Number(await sky.getCursor()) || 0
    log.info(`cursor loaded from SkyNet: last_rev=${lastRev}`)
    if (lastRev === 0) {
      log.warn('last_rev is 0 — run `npm run backfill` first; refusing to tail from the beginning of history')
      return { max, orders: 0 }
    }
  }
  if (max <= lastRev) return { max, orders: 0 }

  const from = Math.max(lastRev - config.overlapRevs, 0)
  const revById = await revisionMap(fb, from, max)
  const ids = [...revById.keys()]
  const totals = await ingestIds(fb, sky, ids, {
    source: 'tail', revFrom: from, revTo: max, revById, chunkSize: config.chunk, log,
  })
  lastRev = max
  return { max, orders: totals.orders }
}

async function reconcile() {
  const fbOpen = await fb.query(q.openSos)
  const mirror = await sky.openMirrorSos()
  const mirrorById = new Map(mirror.map((r) => [Number(r.fb_so_id), r]))
  const toFetch = new Set()
  for (const r of fbOpen) {
    const id = Number(r.id)
    const m = mirrorById.get(id)
    if (!m) { toFetch.add(id); continue }
    const fbTs = Date.parse(ts(r.dateLastModified) || '') || 0
    const skTs = Date.parse(m.fb_date_last_modified || '') || 0
    if (fbTs > skTs + 1000) toFetch.add(id)
  }
  const fbOpenIds = new Set(fbOpen.map((r) => Number(r.id)))
  for (const m of mirror) if (!fbOpenIds.has(Number(m.fb_so_id))) toFetch.add(Number(m.fb_so_id))
  const ids = [...toFetch]
  if (ids.length === 0) {
    await sky.ingest({ source: 'reconcile', rev_from: null, rev_to: null, orders: [], removed_ids: [] })
    return 0
  }
  log.info(`reconcile: ${ids.length} SO(s) differ → refetch`)
  const totals = await ingestIds(fb, sky, ids, { source: 'reconcile', chunkSize: config.chunk, log })
  return totals.orders
}

async function cycle() {
  const once = process.argv.includes('--once')
  const result = await fb.withSession(async () => {
    const t = await tail()
    let reconciled = null
    if (once || Date.now() - lastReconcileAt >= config.reconcileMs) {
      reconciled = await reconcile()
      lastReconcileAt = Date.now()
    }
    if (once || Date.now() - lastUsersAt >= config.usersMs) {
      await syncUsers()
      lastUsersAt = Date.now()
    }
    if (once || Date.now() - lastInventoryAt >= config.inventoryMs) {
      await syncInventory()
      lastInventoryAt = Date.now()
    }
    await pricingCycleGuarded()
    return { ...t, reconciled }
  })
  await sky.heartbeat({
    last_rev: lastRev, version: config.version, host: config.host, last_error: null,
    reconciled: result.reconciled !== null,
  })
  if (result.orders > 0 || result.reconciled) {
    log.info(`tail ok: max_rev=${result.max} orders=${result.orders}${result.reconciled !== null ? ` reconciled=${result.reconciled}` : ''}`)
  }
}

// `--backfill`: one full pass of the three v1.3 mirrors from scratch — customers with no `since`,
// the whole product table, history from HISTORY_BACKFILL_FROM whatever the stored cursor says. Idempotent.
async function backfillPricing() {
  log.info(`pricing backfill: customers (full) + products + history from ${config.historyBackfillFrom}`)
  await fb.withSession(() => pricingCycle({ force: true }))
  log.info('pricing backfill complete')
}

async function main() {
  const once = process.argv.includes('--once')
  const backfill = process.argv.includes('--backfill')
  log.info(`SkyNet Fishbowl Bridge v${config.version} starting on ${config.host} → ${config.fb.host}:${config.fb.port} (${config.fb.sessionMode}) → ${config.sb.url}`)
  await sky.signIn()
  pricing = await sky.pricingState()
  log.info(`pricing clocks: customers=${pricing.last_customers_at || 'never'} products=${pricing.last_products_at || 'never'} history=${pricing.last_history_at || 'never'} cursor=${pricing.history_cursor || 'none'}`)
  if (backfill) {
    try {
      await backfillPricing()
    } catch (e) {
      log.error(`pricing backfill failed: ${e.stack || e.message}`)
      process.exitCode = 1
    } finally {
      await fb.logout()
    }
    return
  }
  while (!stopping) {
    const started = Date.now()
    try {
      await cycle()
      failures = 0
    } catch (e) {
      failures++
      const msg = `${e.name || 'Error'}: ${e.message}`
      log.error(`cycle failed (${failures}): ${msg}`)
      try { await sky.heartbeat({ last_rev: lastRev, version: config.version, host: config.host, last_error: msg.slice(0, 500) }) } catch { /* ignore */ }
      if (/Fishbowl login failed/.test(msg)) fb.token = null
      if (once) { process.exitCode = 1; break }
      await sleep(Math.min(60000, 5000 * 2 ** Math.min(failures, 4)))
      continue
    }
    if (once) break
    const elapsed = Date.now() - started
    await sleep(Math.max(config.pollMs - elapsed, 1000))
  }
  await fb.logout()
  log.info('bridge stopped')
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log.info(`${sig} received — finishing current cycle`); stopping = true })
}

main().catch((e) => {
  log.error(`fatal: ${e.stack || e.message}`)
  process.exit(1)
})
