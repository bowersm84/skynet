// index.mjs — SkyNet Fishbowl Bridge. Reads Fishbowl; writes to SkyNet only through fb_* RPCs; writes to
// Fishbowl only through the D-PRICE-53 push queue (push.mjs), and only when FB_PUSH_ENABLED is true on PROD.
//   node src/index.mjs             run forever (this is what the Windows service runs)
//   node src/index.mjs --once      one tail + one reconcile pass, then exit (smoke test)
//   node src/index.mjs --backfill  one full customers + products + part costs + SO history load (v1.4)
//   node src/index.mjs --mirror-rules  one pricing-rules + product-tree mirror pass, then exit (v1.7)
//   node src/index.mjs --mirror-valuation  one valuation mirror pass (fb_part_valuation), then exit (v1.8)
//   node src/index.mjs --mirror-shipments  one shipments pass over the last SHIPMENTS_SWEEP_DAYS + attach, then exit (v1.9)
//   node src/index.mjs --mirror-purchasing  one purchasing pass over the PURCHASING_WINDOW_DAYS window, then exit (v1.10)
//
// v1.11 (D-ASM-23 / D-FB-58): every step runs through guarded() (guard.mjs) — one family's failure never stops
// another; the picks / ships / mos / boms families are audit-tailed on their own cursors (audit.mjs); tags and
// postso are polled (tags.mjs, postings.mjs); BOMs and tags are swept nightly at FB_SWEEP_HOUR.
import { config } from './config.mjs'
import { Fishbowl } from './fishbowl.mjs'
import { SkyNet, makeLogger } from './skynet.mjs'
import { q } from './queries.mjs'
import { ts, chunk, fbDateTime } from './mapper.mjs'
import { ingestIds, revisionMap } from './sync.mjs'
import { syncCustomers, syncProducts, syncHistory, nightlyDue } from './pricing.mjs'
import { syncPartCosts } from './partCosts.mjs'
import { syncPartValuation } from './valuation.mjs'
import { aggregateInventory, countZeroRows } from './inventory.mjs'
import { syncProductTree, syncPricingRules } from './rulesTree.mjs'
import { runPushCommands, canPushFor } from './push.mjs'
import { syncShipmentLots, attachShipmentLots, sweepSince, syncShipsForSos } from './shipments.mjs'
import { syncPurchasing, loadStatusNames, poWindowSince, changedSince } from './purchasing.mjs'
import { FAMILIES, runFamily, sweepBoms, refreshMos } from './audit.mjs'
import { makeGuard } from './guard.mjs'
import { loadTagScope, syncTags, tagSweepDue } from './tags.mjs'
import { syncPostings } from './postings.mjs'

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
const PRICING_RETRY_MS = 900000
let stopping = false
let failures = 0
// D-FB-54: SO ids whose shipment lots still need reading. Filled by the tail, the reconciler and the nightly
// sweep; an id leaves the set only after its read succeeded, so a failed read is retried next cycle. In memory
// on purpose: the first shipments step after start-up queues the SHIPMENTS_SWEEP_DAYS window, so a restart or a
// deploy re-reads everything recent and loses nothing.
const pendingShipmentSos = new Set()
let lastAttachAt = 0
let startupSweepDone = false
const SHIPMENTS_RETRY_MS = 900000
// D-FB-55: PO ids still to read, same queue design as the shipments poller. Filled by the window read (start-up,
// nightly, one-shot) and the changed-PO poll; an id leaves only after its read succeeded. In memory on purpose: the
// start-up window read re-queues everything recent, so a restart or a deploy loses nothing.
const pendingPurchasingPos = new Set()
let purchasingStartupDone = false
let lastPurchasingPollAt = 0   // ms; start of the last successful changed-PO poll
let purchasingNames = null     // { po, line } status-name maps, read once per process
const PURCHASING_RETRY_MS = 900000

// D-ASM-23 (bridge 1.11): every poller runs through guarded(family, fn, { retryMs }) — it catches, logs, records
// the failure in fb_sync_state.family_errors and stands that family alone down for retryMs (SHIPMENTS_RETRY_MS by
// default). The Order Queue's own feed (SO tail, reconciler, the four audit families) retries after a minute.
// D-FB-61: the steps with no upsert RPC of their own have their family_errors entry cleared by fb_family_ok.
const guard = makeGuard({
  sky, log, defaultRetryMs: SHIPMENTS_RETRY_MS,
  clearFamilies: ['so', 'reconcile', 'users', 'inventory', 'shipments', 'purchasing', 'pricing', 'valuation'],
})
const guarded = guard.guarded
const FEED_RETRY_MS = 60000
const HEARTBEAT_FAMILIES = ['picks', 'ships', 'mos', 'boms', 'tags', 'postings']
// The steps that used to fail the whole cycle: while one of them is failing it still reaches
// fb_sync_state.last_error through the heartbeat, so the banner turns red exactly as before 1.11.
const LAST_ERROR_FAMILIES = ['so', 'reconcile', 'users', 'inventory']
let clocks = null              // the last fb_get_family_cursors() reply: four cursors + tag / posting / sweep clocks
let tagScope = null            // part ids on active BOMs (Labor excluded), refreshed hourly
let tagScopeAt = 0
let lastTagsRunAt = 0          // ms; end of the last successful tag poll (interval clock)
let lastTagsPollAt = null      // ms; start of the last successful tag poll (the next delta's lower bound)
let lastPostingsRunAt = 0
let lastPostingsPollAt = null
const TAG_SCOPE_MS = 3600000
const POLL_OVERLAP_MS = 600000 // tags and postings re-read 10 minutes behind the previous poll
const sweepAt = () => `${String(config.sweepHour).padStart(2, '0')}:00`

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
const INVENTORY_PROBES = ['SK-O', 'SK40S47-13S', 'SK26FB', 'SK4000-3S', 'SK4000CGP81', 'SK4C13C', 'SK4FB13S',
  // S13 / D-FB-52: reorder-point parts that only the widened scope reaches
  'SK2600CGP174', 'SK241-16', 'SK40R17-244', 'SK4FW2SE']

// D-FB-33 / D-FB-40: the inventory snapshot. Scope is the union of the parts on open SO lines, every
// SkyNet part number, and every part already mirrored — about 1,300 parts, resolved to Fishbowl parts
// through part.num. Every in-scope part is sent every cycle, which is what keeps the D-FB-39 stale
// test ("snapshot_at more than 10 min behind last_inventory_at") meaningful: a row only falls behind
// if the poller genuinely stopped covering it. The arithmetic lives in inventory.mjs, with no I/O.
async function syncInventory() {
  const [openIds, skynetNums, mirroredNums, productNums, reorderNums] = await Promise.all([
    sky.openPartIds(),
    sky.skynetPartNums(),
    sky.mirroredPartNums(),
    sky.productClassPartNums(),
    sky.reorderPartNums(),
  ])

  // Numbers are resolved to Fishbowl part ids; ids from the open-SO set are already Fishbowl's own.
  // D-FB-52 adds every Product-class part (last night's valuation mirror) and every reorder-point part.
  const wanted = [...new Set([...skynetNums, ...mirroredNums, ...productNums, ...reorderNums])]
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
  const line = `inventory: scope ${partIds.length} (open-SO ${openIds.length} · skynet ${skynetNums.length} · mirrored ${mirroredNums.length} · product-class ${productNums.length} · reorder ${reorderNums.length}) → rows ${payload.length} (zero ${zero}) · unknown-to-fishbowl ${unknown}`

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
    // D-FB-52, same slot, after part costs: the nightly valuation mirror (every typeId-10 part with its class,
    // tag quantity and partcost average). Logged and swallowed like the kits sync - a Fishbowl schema surprise
    // must not stand the pricing pollers down. D-FB-53: then the month-end snapshot RPC, which decides for itself
    // whether one is due (the 1st of the month, or a month-end that was missed while the bridge was down).
    // v1.11: guarded as its own family, so a failure is recorded in family_errors (and cleared by the next good
    // night, D-FB-61) instead of only logged; like before, it never stands the other pricing pollers down.
    if (config.valuationEnabled) {
      await guarded('valuation', async () => {
        await syncPartValuation(fb, sky, { log, batch: config.pricingBatch })
        pricing.last_valuation_at = new Date().toISOString()
        try {
          const s = await sky.takeInventorySnapshot()
          if (s && s.skipped) log.info(`month-end snapshot: not due (${s.reason || 'no month-end pending'})`)
          else if (s) log.info(`month-end snapshot: ${s.kind || 'month_end'} ${s.period_end || ''} id ${s.id || '?'} · product ${s.product_value ?? '?'} · raw ${s.raw_value ?? '?'}`)
        } catch (e) {
          log.warn(`month-end snapshot skipped: ${e.message}`)
        }
      }, { retryMs: PRICING_RETRY_MS })
    }
    // D-FB-54, same slot: re-queue every SO shipped in the last SHIPMENTS_SWEEP_DAYS, so a shipment the tail
    // missed (bridge down, a failed read) is read tonight. Only queues; the shipments step reads them.
    if (config.shipments.enabled) {
      try {
        await queueShipmentSweep()
      } catch (e) {
        log.error(`shipments sweep failed (other mirrors unaffected): ${e.message}`)
      }
    }
    // D-FB-55, same slot: re-queue the purchasing window, so a change the changed-PO poll missed is read tonight.
    if (config.purchasing.enabled) {
      try {
        await queuePurchasingWindow()
      } catch (e) {
        log.error(`purchasing window failed (other mirrors unaffected): ${e.message}`)
      }
    }
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
    // D-PRICE-53, same slot: the rules + tree mirrors, then the nightly book-change trigger. Each is
    // logged and swallowed like the kits sync — a Fishbowl schema surprise must not stand the pricing
    // pollers down. fb_push_auto only QUEUES; the command runs on the next cycle through runPushCommands.
    if (config.rulesTreeEnabled) {
      try {
        const t = await syncProductTree(fb, sky, { log })
        await syncPricingRules(fb, sky, { log, paths: t.paths })
        pricing.last_tree_at = new Date().toISOString()
        pricing.last_rules_at = pricing.last_tree_at
      } catch (e) {
        log.error(`rules/tree mirror failed (other mirrors unaffected): ${e.message}`)
      }
    }
    if (config.push.autoEnabled) {
      try {
        const a = await sky.pushAuto()
        if (a?.prices_cmd || a?.rules_cmd) log.info(`push auto: book in effect changed -> queued prices #${a.prices_cmd ?? '-'} rules #${a.rules_cmd ?? '-'}`)
      } catch (e) {
        log.error(`push auto failed: ${e.message}`)
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
  await guarded('pricing', () => pricingCycle(), { retryMs: PRICING_RETRY_MS })
}

// D-PRICE-53: claim and run queued import commands. Same stand-down pattern as the pricing pollers:
// a failure that escapes push.mjs (which records per-command failures itself) pauses the executor for
// PUSH_RETRY_MS and never touches the Order Queue's tail.
let pushPausedUntil = 0
const PUSH_RETRY_MS = 900000
async function pushCycleGuarded() {
  if (Date.now() < pushPausedUntil) return
  try {
    await runPushCommands(fb, sky, { cfg: config, log, max: config.push.maxPerCycle, refreshMo: (ids) => refreshMos(fb, sky, ids), removeMo: (ids) => sky.markMosRemoved(ids) })
  } catch (e) {
    pushPausedUntil = Date.now() + PUSH_RETRY_MS
    log.error(`push cycle failed, retrying in ${PUSH_RETRY_MS / 60000} min: ${e.message}`)
  }
}

// D-FB-54: read the queued SOs' shipment lots, then attach. Attach runs after any cycle that wrote rows and at
// least every SHIPMENTS_ATTACH_MS, so a kit logged after its order shipped still picks up its lots. A failure is
// logged, the queue is kept, and the step stands down for SHIPMENTS_RETRY_MS — the Order Queue tail never stops.
async function shipmentsCycle() {
  const sc = config.shipments
  const ids = [...pendingShipmentSos].slice(0, Math.max(1, sc.maxSosPerCycle))
  let upserted = 0
  if (ids.length > 0) {
    const r = await syncShipmentLots(fb, sky, ids, { log, batch: config.pricingBatch, dryRun: sc.dryRun })
    upserted = r.upserted
    // v1.11: the same SOs' ships (header, cartons, items) ride along into the ship mirror.
    await syncShipsForSos(fb, sky, ids, { log, dryRun: sc.dryRun })
    for (const id of ids) pendingShipmentSos.delete(id)
  }
  if (upserted > 0 || Date.now() - lastAttachAt >= sc.attachMs) {
    await attachShipmentLots(sky, { log, dryRun: sc.dryRun })
    lastAttachAt = Date.now()
  }
}

async function shipmentsCycleGuarded() {
  if (!config.shipments.enabled) return
  await guarded('shipments', async () => {
    if (!startupSweepDone) {
      await queueShipmentSweep()
      startupSweepDone = true
    }
    await shipmentsCycle()
  }, { retryMs: SHIPMENTS_RETRY_MS, detail: () => `(${pendingShipmentSos.size} SO(s) kept queued)` })
}

// D-FB-54: queue every SO with a shipment shipped in the last SHIPMENTS_SWEEP_DAYS (nightly, and the one-shot).
async function queueShipmentSweep() {
  const since = sweepSince(new Date(), config.shipments.sweepDays)
  const rows = await fb.query(q.recentShipmentSoIds(since))
  for (const r of rows) {
    const id = Number(r.soId)
    if (Number.isFinite(id)) pendingShipmentSos.add(id)
  }
  log.info(`shipments sweep: ${rows.length} SO(s) shipped since ${since} queued (${pendingShipmentSos.size} pending)`)
  return rows.length
}

// D-FB-55: queue every PO created or issued in the last PURCHASING_WINDOW_DAYS, plus every PO not yet completed.
async function queuePurchasingWindow() {
  const since = poWindowSince(new Date(), config.purchasing.windowDays)
  const rows = await fb.query(q.purchaseWindowIds(since))
  for (const r of rows) {
    const id = Number(r.poId)
    if (Number.isFinite(id)) pendingPurchasingPos.add(id)
  }
  log.info(`purchasing window: ${rows.length} PO(s) since ${since} or still open queued (${pendingPurchasingPos.size} pending)`)
  return rows.length
}

// D-FB-55: every PURCHASING_MS, queue the POs changed since the previous poll (minus PURCHASING_OVERLAP_MS); every
// cycle, read up to PURCHASING_MAX_POS queued POs whole. The poll clock only moves after its query succeeded.
async function purchasingCycle() {
  const pc = config.purchasing
  if (!purchasingNames) purchasingNames = await loadStatusNames(fb, log)
  if (Date.now() - lastPurchasingPollAt >= pc.ms) {
    const started = Date.now()
    const since = changedSince(lastPurchasingPollAt, pc.overlapMs)
    const rows = await fb.query(q.purchaseChangedIds(since))
    for (const r of rows) {
      const id = Number(r.poId)
      if (Number.isFinite(id)) pendingPurchasingPos.add(id)
    }
    if (rows.length > 0) log.info(`purchasing: ${rows.length} PO(s) changed since ${since} queued (${pendingPurchasingPos.size} pending)`)
    lastPurchasingPollAt = started
  }
  const ids = [...pendingPurchasingPos].slice(0, Math.max(1, pc.maxPosPerCycle))
  if (ids.length === 0) return
  await syncPurchasing(fb, sky, ids, { log, names: purchasingNames, batchPos: pc.batchPos, dryRun: pc.dryRun })
  for (const id of ids) pendingPurchasingPos.delete(id)
}

async function purchasingCycleGuarded() {
  if (!config.purchasing.enabled) return
  await guarded('purchasing', async () => {
    if (!purchasingStartupDone) {
      await queuePurchasingWindow()
      purchasingStartupDone = true
      lastPurchasingPollAt = Date.now()
    }
    await purchasingCycle()
  }, { retryMs: PURCHASING_RETRY_MS, detail: () => `(${pendingPurchasingPos.size} PO(s) kept queued)` })
}

// D-ASM-23: the four audit-tailed families, each on its own cursor and behind its own guard. The cursors are read
// once per cycle; if that read fails, every family is marked failed for the cycle (each clears its own
// family_errors key on its next success) and no cursor moves.
async function auditCycle(maxRev) {
  let cursorErr = null
  try { clocks = await sky.familyCursors() } catch (e) { cursorErr = e }
  const out = {}
  for (const entry of FAMILIES) {
    out[entry.family] = await guarded(entry.family, async () => {
      if (cursorErr) throw new Error(`family cursors unavailable: ${cursorErr.message}`)
      const r = await runFamily(entry, { fb, sky, cursor: clocks[entry.cursorKey], maxRev, overlap: config.overlapRevs })
      if (r.mode === 'backfill') log.info(`${entry.family}: first run on this database — ${r.ids} id(s) backfilled, ${r.fetched} read, cursor -> ${maxRev}`)
      if (entry.family === 'boms' && r.mode !== 'backfill' && nightlyDue(clocks.bomsSweepAt, sweepAt())) {
        const s = await sweepBoms(fb, sky)
        log.info(`boms: nightly sweep — ${s.ids} active BOM(s), ${s.fetched} read`)
      }
      return r
    }, { retryMs: FEED_RETRY_MS })
  }
  return out
}

// D-FB-58 tags poller. Due every FB_TAGS_INTERVAL_MS, or when the sweep is (every FB_TAGS_SWEEP_INTERVAL_MS from
// last_tags_sweep_at, D-FB-62 — independent of the 02:00 BOM sweep); the first run on a database (no last_tags_at)
// is a sweep too. The delta reads 10 minutes behind the previous poll's start.
const tagsSweepDue = () => tagSweepDue(clocks?.tagsSweepAt, Date.now(), config.tagsSweepMs)

function tagsDue() {
  return clocks !== null && (Date.now() - lastTagsRunAt >= config.tagsMs || tagsSweepDue())
}

async function tagsStep() {
  if (!clocks) throw new Error('family clocks unavailable (fb_get_family_cursors has not answered yet)')
  if (!tagScope || Date.now() - tagScopeAt >= TAG_SCOPE_MS) {
    tagScope = await loadTagScope(fb)
    tagScopeAt = Date.now()
  }
  const started = Date.now()
  const lastPoll = lastTagsPollAt ?? (clocks.tagsAt ? Date.parse(clocks.tagsAt) : null)
  const sweep = lastPoll === null || tagsSweepDue()
  const r = await syncTags(fb, sky, { scope: tagScope, since: sweep ? null : fbDateTime(new Date(lastPoll - POLL_OVERLAP_MS)), log })
  lastTagsPollAt = started
  lastTagsRunAt = Date.now()
  if (sweep) clocks.tagsSweepAt = new Date().toISOString()
  return r
}

// D-FB-58 postings poller (D-ASM-14 Invoiced). The first run on a database loads the last 180 days.
function postingsDue() {
  return clocks !== null && Date.now() - lastPostingsRunAt >= config.postingsMs
}

async function postingsStep() {
  if (!clocks) throw new Error('family clocks unavailable (fb_get_family_cursors has not answered yet)')
  const started = Date.now()
  const lastPoll = lastPostingsPollAt ?? (clocks.postingsAt ? Date.parse(clocks.postingsAt) : null)
  const r = await syncPostings(fb, sky, { since: lastPoll === null ? null : fbDateTime(new Date(lastPoll - POLL_OVERLAP_MS)), log })
  lastPostingsPollAt = started
  lastPostingsRunAt = Date.now()
  return r
}

async function tail(max) {
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
  // D-FB-54: picking, packing and shipping all touch soitem, so the tail sees every shipment within a cycle.
  if (config.shipments.enabled) for (const id of ids) pendingShipmentSos.add(Number(id))
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
  if (config.shipments.enabled) for (const id of ids) pendingShipmentSos.add(Number(id))
  const totals = await ingestIds(fb, sky, ids, { source: 'reconcile', chunkSize: config.chunk, log })
  return totals.orders
}

// One cycle-log field per family: ids handled ("backfill" on a first run), "-" when it did not run, "failed" /
// "paused" when its guard stood it down.
function familyField(name, r) {
  if (r && typeof r === 'object' && 'ids' in r) return `${name}=${r.ids}${r.mode === 'backfill' ? '(backfill)' : ''}`
  if (r && typeof r === 'object' && 'rows' in r) return `${name}=${r.rows}${r.sweep ? '(sweep)' : ''}`
  if (r && typeof r === 'object' && 'postings' in r) return `${name}=${r.postings}`
  if (guard.isPaused(name)) return `${name}=paused`
  return `${name}=-`
}

async function cycle() {
  const once = process.argv.includes('--once')
  const started = Date.now()
  const result = await fb.withSession(async () => {
    // The cycle's one MAX(revinfo.id) read, shared by the SO tail and every audit family. If Fishbowl cannot
    // answer it, the cycle fails as it always has: last_error, the banner turns red, the loop backs off.
    const [{ maxRev }] = await fb.query(q.maxRev)
    const max = Number(maxRev) || 0
    const t = await guarded('so', () => tail(max), { retryMs: FEED_RETRY_MS })
    const fam = await auditCycle(max)
    let reconciled = null
    if (once || Date.now() - lastReconcileAt >= config.reconcileMs) {
      reconciled = await guarded('reconcile', async () => {
        const n = await reconcile()
        lastReconcileAt = Date.now()
        return n
      }, { retryMs: FEED_RETRY_MS }) ?? null
    }
    if (once || Date.now() - lastUsersAt >= config.usersMs) {
      await guarded('users', async () => { await syncUsers(); lastUsersAt = Date.now() })
    }
    if (once || Date.now() - lastInventoryAt >= config.inventoryMs) {
      await guarded('inventory', async () => { await syncInventory(); lastInventoryAt = Date.now() })
    }
    if (once || tagsDue()) fam.tags = await guarded('tags', tagsStep)
    if (once || postingsDue()) fam.postings = await guarded('postings', postingsStep)
    await shipmentsCycleGuarded()
    await purchasingCycleGuarded()
    await pricingCycleGuarded()
    await pushCycleGuarded()
    return { max, orders: t?.orders ?? 0, reconciled, fam }
  })
  const cycleMs = Date.now() - started
  const lastError = guard.failing(LAST_ERROR_FAMILIES).join(' | ') || null
  await sky.heartbeat({
    last_rev: lastRev, version: config.version, host: config.host, last_error: lastError ? lastError.slice(0, 500) : null,
    reconciled: result.reconciled !== null, cycleMs, families: guard.snapshot(HEARTBEAT_FAMILIES),
  })
  if (result.orders > 0 || result.reconciled) {
    log.info(`tail ok: max_rev=${result.max} orders=${result.orders}${result.reconciled !== null ? ` reconciled=${result.reconciled}` : ''}`)
  }
  const fields = ['picks', 'ships', 'mos', 'boms', 'tags', 'postings'].map((f) => familyField(f, result.fam[f]))
  log.info(`bridge ${config.version} cycle: cycleMs=${cycleMs} max_rev=${result.max} so=${result.orders} ${fields.join(' ')}`)
}

// `--backfill`: one full pass of the v1.4 mirrors from scratch — customers with no `since`,
// the whole product table, history from HISTORY_BACKFILL_FROM whatever the stored cursor says. Idempotent.
async function backfillPricing() {
  log.info(`pricing backfill: customers (full) + products + history from ${config.historyBackfillFrom}`)
  await fb.withSession(() => pricingCycle({ force: true }))
  log.info('pricing backfill complete')
}

// `--mirror-rules`: one rules + tree mirror pass and exit (first load, or after fixing a query). No push.
async function mirrorRulesOnce() {
  await fb.withSession(async () => {
    const t = await syncProductTree(fb, sky, { log })
    await syncPricingRules(fb, sky, { log, paths: t.paths })
  })
  log.info('rules/tree mirror complete')
}

// `--mirror-valuation`: one valuation mirror pass and exit - the first load after the S13 migration, or after
// fixing the query. No snapshot: that stays with the nightly slot (D-FB-53).
async function mirrorValuationOnce() {
  await fb.withSession(() => syncPartValuation(fb, sky, { log, batch: config.pricingBatch }))
  log.info('valuation mirror complete')
}

// `--mirror-shipments`: one sweep over the last SHIPMENTS_SWEEP_DAYS, every queued SO read, one attach, exit.
// The first load after the D-FB-54 migration, or after fixing the query. Honours SHIPMENTS_DRY_RUN.
async function mirrorShipmentsOnce() {
  await fb.withSession(async () => {
    await queueShipmentSweep()
    while (pendingShipmentSos.size > 0) {
      const ids = [...pendingShipmentSos].slice(0, Math.max(1, config.shipments.maxSosPerCycle))
      await syncShipmentLots(fb, sky, ids, { log, batch: config.pricingBatch, dryRun: config.shipments.dryRun })
      for (const id of ids) pendingShipmentSos.delete(id)
    }
  })
  await attachShipmentLots(sky, { log, dryRun: config.shipments.dryRun })
  log.info('shipments mirror complete')
}

// `--mirror-purchasing`: one window read, every queued PO read whole, exit. The first load after the D-FB-55
// migration, or after fixing a query. Honours PURCHASING_DRY_RUN.
async function mirrorPurchasingOnce() {
  await fb.withSession(async () => {
    purchasingNames = await loadStatusNames(fb, log)
    await queuePurchasingWindow()
    while (pendingPurchasingPos.size > 0) {
      const ids = [...pendingPurchasingPos].slice(0, Math.max(1, config.purchasing.maxPosPerCycle))
      await syncPurchasing(fb, sky, ids, { log, names: purchasingNames, batchPos: config.purchasing.batchPos, dryRun: config.purchasing.dryRun })
      for (const id of ids) pendingPurchasingPos.delete(id)
    }
  })
  log.info('purchasing mirror complete')
}

async function main() {
  const once = process.argv.includes('--once')
  const backfill = process.argv.includes('--backfill')
  const mirrorRules = process.argv.includes('--mirror-rules')
  const mirrorValuation = process.argv.includes('--mirror-valuation')
  const mirrorShipments = process.argv.includes('--mirror-shipments')
  const mirrorPurchasing = process.argv.includes('--mirror-purchasing')
  log.info(`SkyNet Fishbowl Bridge v${config.version} starting on ${config.host} → ${config.fb.host}:${config.fb.port} (${config.fb.sessionMode}) → ${config.sb.url}`)
  await sky.signIn()
  pricing = await sky.pricingState()
  log.info(`pricing clocks: customers=${pricing.last_customers_at || 'never'} products=${pricing.last_products_at || 'never'} history=${pricing.last_history_at || 'never'} cursor=${pricing.history_cursor || 'none'} rules=${pricing.last_rules_at || 'never'} tree=${pricing.last_tree_at || 'never'} valuation=${pricing.last_valuation_at || 'never'}`)
  const gate = canPushFor(config)
  log.info(`fishbowl push: ${gate.ok ? 'ENABLED (real writes to Fishbowl)' : `dry run only (${gate.why})`}; auto=${config.push.autoEnabled}`)
  log.info(`push kinds this bridge may execute (FB_PUSH_KINDS): ${config.push.kinds.join(', ') || 'none'} · MO writes (FB_MO_ENABLED): ${config.mo.enabled ? (config.mo.dryRun ? 'on, DRY RUN (FB_MO_DRY_RUN)' : 'ON') : 'off (forced dry run)'} · write prefix (FB_WRITE_PART_PREFIX): ${config.mo.writePartPrefix ? JSON.stringify(config.mo.writePartPrefix) : 'NOT SET — every MO command refused'}`)
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
  if (mirrorRules) {
    try {
      await mirrorRulesOnce()
    } catch (e) {
      log.error(`rules/tree mirror failed: ${e.stack || e.message}`)
      process.exitCode = 1
    } finally {
      await fb.logout()
    }
    return
  }
  log.info(`shipments: ${config.shipments.enabled ? (config.shipments.dryRun ? 'DRY RUN (reads + logs, writes nothing)' : 'on') : 'off'} · sweep ${config.shipments.sweepDays} day(s) · max ${config.shipments.maxSosPerCycle} SO(s)/cycle · attach every ${config.shipments.attachMs / 60000} min`)
  log.info(`purchasing: ${config.purchasing.enabled ? (config.purchasing.dryRun ? 'DRY RUN (reads + logs, writes nothing)' : 'on') : 'off'} · window ${config.purchasing.windowDays} day(s) + open · poll every ${config.purchasing.ms / 60000} min · max ${config.purchasing.maxPosPerCycle} PO(s)/cycle`)
  log.info(`families (1.11): ${FAMILIES.map((f) => f.family).join(', ')} audit-tailed every cycle (own cursors, overlap ${config.overlapRevs} revs) · tags every ${config.tagsMs / 60000} min (sweep every ${config.tagsSweepMs / 60000} min) · postings every ${config.postingsMs / 60000} min · BOM sweep nightly at ${sweepAt()}`)
  if (mirrorPurchasing) {
    try {
      await mirrorPurchasingOnce()
    } catch (e) {
      log.error(`purchasing mirror failed: ${e.stack || e.message}`)
      process.exitCode = 1
    } finally {
      await fb.logout()
    }
    return
  }
  if (mirrorShipments) {
    try {
      await mirrorShipmentsOnce()
    } catch (e) {
      log.error(`shipments mirror failed: ${e.stack || e.message}`)
      process.exitCode = 1
    } finally {
      await fb.logout()
    }
    return
  }
  if (mirrorValuation) {
    try {
      await mirrorValuationOnce()
    } catch (e) {
      log.error(`valuation mirror failed: ${e.stack || e.message}`)
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
