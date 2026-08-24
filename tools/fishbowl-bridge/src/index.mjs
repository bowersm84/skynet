// index.mjs — SkyNet Fishbowl Bridge. Read-only against Fishbowl; writes to SkyNet only through fb_* RPCs.
//   node src/index.mjs          run forever (this is what the Windows service runs)
//   node src/index.mjs --once   one tail + one reconcile pass, then exit (smoke test)
import { config } from './config.mjs'
import { Fishbowl } from './fishbowl.mjs'
import { SkyNet, makeLogger } from './skynet.mjs'
import { q } from './queries.mjs'
import { ts } from './mapper.mjs'
import { ingestIds, revisionMap } from './sync.mjs'

const log = makeLogger(config.logDir)
const fb = new Fishbowl(config.fb, log)
const sky = new SkyNet(config.sb, log)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let lastRev = null          // in-memory copy of fb_sync_state.last_rev
let lastReconcileAt = 0
let stopping = false
let failures = 0

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

async function main() {
  const once = process.argv.includes('--once')
  log.info(`SkyNet Fishbowl Bridge v${config.version} starting on ${config.host} → ${config.fb.host}:${config.fb.port} (${config.fb.sessionMode}) → ${config.sb.url}`)
  await sky.signIn()
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
