// index.mjs — SkyNet Fishbowl Bridge. Read-only against Fishbowl; writes to SkyNet only through fb_* RPCs.
//   node src/index.mjs             run forever (this is what the Windows service runs)
//   node src/index.mjs --once      one tail + one reconcile pass, then exit (smoke test)
//   node src/index.mjs --backfill  one full customers + products + part costs + SO history load (v1.4)
import { config } from './config.mjs'
import { Fishbowl } from './fishbowl.mjs'
import { SkyNet, makeLogger } from './skynet.mjs'
import { q } from './queries.mjs'
import { ts, chunk } from './mapper.mjs'
import { ingestIds, revisionMap } from './sync.mjs'
import { syncCustomers, syncProducts, syncHistory, nightlyDue } from './pricing.mjs'
import { syncPartCosts } from './partCosts.mjs'
import { aggregateInventory, countZeroRows } from './inventory.mjs'

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

// The parts Matt reads back against Fishbowl on a dry run before the first real write (D-FB-40).
const INVENTORY_PROBES = ['SK-O', 'SK40S47-13S', 'SK26FB', 'SK4000-3S', 'SK4000CGP81', 'SK4C13C', 'SK4FB13S']

// D-FB-33 / D-FB-40: the inventory snapshot. Scope is the union of the parts on open SO lines, every
// SkyNet part number, and every part already mirrored — about 1,300 parts, resolved to Fishbowl parts
// through part.num. Every in-scope part is sent every cycle, which is what keeps the D-FB-39 stale
// test ("snapshot_at more than 10 min behind last_inventory_at") meaningful: a row only falls behind
// if the poller genuinely stopped covering it. The arithmetic lives in inventory.mjs, with no I/O.
async function syncInventory() {
  const [openIds, skynetNums, mirroredNums] = await Promise.all([
    sky.openPartIds(),
    sky.skynetPartNums(),
    sky.mirroredPartNums(),
  ])

  // Numbers are resolved to Fishbowl part ids; ids from the open-SO set are already Fishbowl's own.
  const wanted = [...new Set([...skynetNums, ...mirroredNums])]
  const ids = new Set(openIds.map(Number).filter(Number.isFinite))
  const known = new Set()
  for (const nums of chunk(wanted, 300)) {
    for (const r of await fb.query(q.partsByNum(nums))) {
      if (r.partId === null || r.partId === undefined) continue
      const id = Number(r.partId)
      if (!Number.isFinite(id)) continue
      ids.add(id)
      known.add(String(r.partNum ?? '').trim().toUpperCase())
    }
  }
  // A number Fishbowl does not know gets no row at all, so "no row" keeps meaning "not a Fishbowl part".
  // The numbers themselves are logged on a dry run only — on TEST they are mostly parts a refreshed
  // copy of `parts` has and Fishbowl does not, which is worth reading once, not every 5 minutes.
  const unknownNums = wanted.filter((nm) => !known.has(nm)).sort()
  const unknown = unknownNums.length

  const partIds = [...ids]
  if (partIds.length === 0) return 0

  const rows = []
  for (const batch of chunk(partIds, 300)) rows.push(...await fb.query(q.inventory(batch)))

  const payload = aggregateInventory(rows, config.availableLocationGroups)
  const zero = countZeroRows(payload)
  const line = `inventory: scope ${partIds.length} (open-SO ${openIds.length} · skynet ${skynetNums.length} · mirrored ${mirroredNums.length}) → rows ${payload.length} (zero ${zero}) · unknown-to-fishbowl ${unknown}`

  if (config.inventoryDryRun) {
    log.info(`${line} · DRY RUN — nothing written`)
    const found = new Map(payload.map((p) => [String(p.partNum ?? '').toUpperCase(), p]))
    for (const probe of INVENTORY_PROBES) {
      const p = found.get(probe)
      if (!p) { log.info(`  probe ${probe}: NO ROW — not in scope, or Fishbowl does not know the number`); continue }
      const groups = Object.keys(p.byLocation).join(',') || 'none'
      log.info(`  probe ${p.partNum}: on hand ${p.onHand} · allocated ${p.allocated} · not available ${p.notAvailable} · on order ${p.onOrder} · available ${p.available} · groups ${groups}`)
    }
    if (unknown > 0) {
      const shown = unknownNums.slice(0, 100)
      const more = unknown > shown.length ? ` +${unknown - shown.length} more` : ''
      log.info(`  unknown to Fishbowl (${unknown}): ${shown.join(', ')}${more}`)
    }
    return 0
  }

  let total = 0
  for (const batch of chunk(payload, 500)) total += Number(await sky.upsertInventory(batch)) || 0
  log.info(`${line} · ${total} upserted`)
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
    // Stamped before part costs runs, on purpose: fb_upsert_products has already moved the real clock in
    // fb_sync_state, so if part costs then throws we must not leave the in-memory clock behind and make
    // the products poll look due again on the very next cycle.
    pricing.last_products_at = new Date().toISOString()
    // D-PRICE-47 rides this slot rather than getting its own. fb_upsert_part_costs stamps no clock and
    // fb_sync_state has no last_part_costs_at column, so nightlyDue() has nothing to read — it would
    // return true on every 20 s cycle after the target time and re-read the whole PO history each pass.
    if (config.partCostsEnabled) await syncPartCosts(fb, sky, { log, batch: config.pricingBatch })
    // D-PRICE-49, last in the nightly slot: costs are in, so the book's kit sums are final for today.
    // A failure here is logged and swallowed — the mirrors are the bridge's job, and the kits site
    // going a night without an update must not stand the pricing pollers down for 15 minutes.
    if (config.kitsSyncEnabled) {
      try {
        const r = await sky.syncKitsSite('nightly')
        log.info(`kits site: ${r?.prices_written ?? 0} price(s) written, ${r?.stale_marked ?? 0} stale, ${r?.discontinued ?? 0} discontinued${r?.book_label ? ` (${r.book_label})` : ''}`)
      } catch (e) {
        log.error(`kits site sync failed (mirrors unaffected): ${e.message}`)
      }
    }
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

// `--backfill`: one full pass of the v1.4 mirrors from scratch — customers with no `since`,
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
