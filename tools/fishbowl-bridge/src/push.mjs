// push.mjs — the ONLY path that writes to Fishbowl (D-PRICE-53). SkyNet queues import commands in
// fb_push_commands (built server-side by fb_push_enqueue, payload = [[header],[row],...]); every
// cycle the bridge claims the oldest one, posts it to Fishbowl's CSV import endpoint, reports back,
// then refreshes the mirror the push touched so pricing_fb_sync_status is current within the cycle.
//
// Safety: a push is REAL only when FB_PUSH_ENABLED is the literal `true` AND the SkyNet the bridge is
// signed in to is the allowed host (FB_PUSH_SB_HOST, default PROD). Anything else — the PC bridge on
// TEST, a service with the flag missing — executes the command as a forced dry run: the rows are
// counted and logged, nothing is sent, and the command is marked done with result.dry_run = true so
// fb_push_auto never treats it as a real push. A command's own dry_run flag is honoured the same way.
import { syncProducts, syncCustomers } from './pricing.mjs'
import { syncProductTree, syncPricingRules } from './rulesTree.mjs'

// D-ASM-23 dispatch table: kind -> the Fishbowl import name(s) to post, in order (configurable because the names
// are Fishbowl's), and the mirror to re-read after a real push. It is resolved inside the handler's try, so a kind
// this bridge does not know is finished `failed` with a clear error and the executor moves on to the next command.
export const PUSH_KINDS = {
  prices: {
    imports: (cfg) => [{ name: cfg.importNames.product, key: null }],
    remirror: (fb, sky, cfg, log) => syncProducts(fb, sky, { log, batch: cfg.pricingBatch }),
  },
  rules: {
    imports: (cfg) => [{ name: cfg.importNames.rules, key: null }],
    remirror: (fb, sky, cfg, log) => syncPricingRules(fb, sky, { log }),
  },
  tree: {
    imports: (cfg) => [{ name: cfg.importNames.treeCategories, key: 'categories' }, { name: cfg.importNames.tree, key: 'members' }],
    remirror: (fb, sky, cfg, log) => syncProductTree(fb, sky, { log }),
  },
  groups: {
    imports: (cfg) => [{ name: cfg.importNames.groups, key: null }],
    remirror: (fb, sky, cfg, log) => syncCustomers(fb, sky, { since: null, log, batch: cfg.pricingBatch }),
  },
}

export function pushHandler(kind) {
  return Object.hasOwn(PUSH_KINDS, kind) ? PUSH_KINDS[kind] : null
}

export function importsFor(kind, cfg) {
  const handler = pushHandler(kind)
  if (!handler) throw new Error(`unknown push kind: ${kind}`)
  return handler.imports(cfg)
}

export function canPushFor(cfg) {
  if (!cfg.push.enabled) return { ok: false, why: 'FB_PUSH_ENABLED is not true' }
  let host = ''
  try { host = new URL(cfg.sb.url).host } catch { return { ok: false, why: `SB_URL is not a URL: ${cfg.sb.url}` } }
  if (host.toLowerCase() !== String(cfg.push.allowedSbHost).toLowerCase()) return { ok: false, why: `SkyNet host ${host} is not ${cfg.push.allowedSbHost}` }
  return { ok: true, why: null }
}

function rowsOf(payload, key) {
  const table = key ? payload?.[key] : payload
  if (!Array.isArray(table) || table.length === 0 || !Array.isArray(table[0])) throw new Error(`push: payload${key ? '.' + key : ''} is not a header + rows array`)
  return table
}

// Runs at most `max` queued commands. Never throws for a Fishbowl error: that is recorded on the command.
export async function runPushCommands(fb, sky, { cfg, log, max = 3 } = {}) {
  let ran = 0
  for (; ran < max; ran++) {
    const cmd = await sky.pushNext(cfg.host)
    if (!cmd) break
    const gate = canPushFor(cfg)
    const dryRun = Boolean(cmd.dry_run) || !gate.ok
    const forced = !cmd.dry_run && !gate.ok
    const result = { dry_run: dryRun, forced, reason: forced ? gate.why : null, imports: [], rows: 0, host: cfg.host, version: cfg.version }
    let handler = null
    try {
      handler = pushHandler(cmd.kind)
      if (!handler) throw Object.assign(new Error(`unknown push kind: ${cmd.kind}`), { plain: true })
      for (const imp of handler.imports(cfg)) {
        const table = rowsOf(cmd.payload, imp.key)
        const n = table.length - 1
        result.rows += n
        if (n === 0) { result.imports.push({ name: imp.name, rows: 0, skipped: 'no rows' }); continue }
        if (dryRun) {
          log.info(`push #${cmd.id} ${cmd.kind}: DRY RUN${forced ? ` (forced: ${gate.why})` : ''} — ${imp.name} ${n} row(s) not sent; header ${JSON.stringify(table[0])}; first ${JSON.stringify(table[1])}`)
          result.imports.push({ name: imp.name, rows: n, sent: false })
          continue
        }
        const res = await fb.importRows(imp.name, table)
        result.imports.push({ name: imp.name, rows: n, sent: true, status: res.status, body: String(res.body || '').slice(0, 2000) })
        log.info(`push #${cmd.id} ${cmd.kind}: ${imp.name} ${n} row(s) -> ${res.status}`)
      }
      await sky.pushFinish(cmd.id, true, result, null)
    } catch (e) {
      const msg = e.plain ? e.message : `${e.name || 'Error'}: ${e.message}`
      log.error(`push #${cmd.id} ${cmd.kind} failed: ${msg}`)
      try { await sky.pushFinish(cmd.id, false, result, msg.slice(0, 2000)) } catch (e2) { log.error(`push #${cmd.id}: could not record failure: ${e2.message}`) }
      continue
    }
    // Re-mirror what the push touched so the confirmation is true within the cycle (real pushes only).
    if (!dryRun) {
      try {
        await handler.remirror(fb, sky, cfg, log)
      } catch (e) {
        log.error(`push #${cmd.id}: re-mirror after push failed (the nightly poll will catch up): ${e.message}`)
      }
    }
  }
  return ran
}
