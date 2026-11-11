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
import { MO_KINDS, runMoCommand } from './mo.mjs'

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

// S17 D1 (D-ASM-52): FB_PUSH_KINDS, the kinds this bridge may execute. Checked before anything else: a claimed
// command of another kind is finished failed and never executed. Without the key: the four pricing kinds.
export const DEFAULT_PUSH_KINDS = ['prices', 'rules', 'tree', 'groups']
export function kindEnabled(kind, cfg) {
  const kinds = Array.isArray(cfg.push?.kinds) ? cfg.push.kinds : DEFAULT_PUSH_KINDS
  return typeof kind === 'string' && kinds.includes(kind)
}

// S17 D1 (D-ASM-52): the MO commands. Their own write gate — FB_MO_ENABLED, FB_MO_DRY_RUN — not the pricing one, and
// the fence in mo.mjs. After Fishbowl answers one of them in a way the probe did not, every later MO command is
// failed unexecuted until the bridge restarts (hard rule 4).
export { moFenceRefusal } from './mo.mjs'
let moHalt = null
export function moHaltState() { return moHalt }
export function resetMoHalt() { moHalt = null }

export function moGate(cfg) {
  if (!cfg.mo?.enabled) return { write: false, why: 'FB_MO_ENABLED is not true' }
  if (cfg.mo?.dryRun) return { write: false, why: 'FB_MO_DRY_RUN is true' }
  return { write: true, why: null }
}

async function runMo(fb, sky, cmd, { cfg, log, refreshMo, removeMo }) {
  const gate = moGate(cfg)
  const dryRun = Boolean(cmd.dry_run) || !gate.write
  const base = { dry_run: dryRun, forced: !cmd.dry_run && !gate.write, reason: !cmd.dry_run && !gate.write ? gate.why : null, host: cfg.host, version: cfg.version }
  if (moHalt) {
    const msg = `MO writes are stopped on this bridge since command #${moHalt.id} (${moHalt.message.slice(0, 200)}) — restart it after checking Fishbowl`
    log.warn(`push #${cmd.id} ${cmd.kind}: ${msg}`)
    await sky.pushFinish(cmd.id, false, { ...base, executed: false }, msg.slice(0, 2000))
    return
  }
  let result
  try {
    result = { ...(await runMoCommand(fb, cmd, { cfg, log, dryRun })), ...base }
  } catch (e) {
    if (e.halt) moHalt = { id: cmd.id, message: e.message }
    const msg = e.plain ? e.message : `${e.name || 'Error'}: ${e.message}`
    log.error(`push #${cmd.id} ${cmd.kind} failed: ${msg}`)
    try { await sky.pushFinish(cmd.id, false, { ...base, halted: Boolean(e.halt) }, msg.slice(0, 2000)) } catch (e2) { log.error(`push #${cmd.id}: could not record failure: ${e2.message}`) }
    return
  }
  log.info(`push #${cmd.id} ${cmd.kind}: ${dryRun ? `DRY RUN${base.forced ? ` (forced: ${base.reason})` : ''}` : 'done'} — MO ${result.mo_number ?? '?'}${result.fb_mo_id ? ` (id ${result.fb_mo_id})` : ''}${result.status ? ` · ${result.status}` : ''}${'created' in result ? ` · created ${result.created}` : ''}${'deleted' in result ? ` · deleted ${result.deleted}` : ''}${'closed' in result ? ` · closed ${result.closed}` : ''}`)
  await sky.pushFinish(cmd.id, true, result, null)
  // Fresh read-back: the MO's mirror rows are re-read in the same cycle (real writes only). An MO this command
  // deleted is marked removed in the mirror instead (D-ASM-57): the audit tail would re-read it, find nothing and
  // leave it as last seen.
  if (!dryRun && result.fb_mo_id && result.deleted === true && result.existed === true && removeMo) {
    try {
      const n = await removeMo([result.fb_mo_id])
      log.info(`push #${cmd.id}: MO ${result.mo_number} (id ${result.fb_mo_id}) marked removed in the mirror (${n} row)`)
    } catch (e) {
      log.warn(`push #${cmd.id}: MO ${result.fb_mo_id} could not be marked removed in the mirror (${e.message}) — it is gone from Fishbowl; the mirror keeps it as last seen`)
    }
  } else if (!dryRun && refreshMo && result.fb_mo_id && result.deleted !== true) {
    try { await refreshMo([result.fb_mo_id]) } catch (e) { log.error(`push #${cmd.id}: MO mirror refresh failed (the audit tail will catch up): ${e.message}`) }
  }
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
export async function runPushCommands(fb, sky, { cfg, log, max = 3, refreshMo = null, removeMo = null } = {}) {
  let ran = 0
  for (; ran < max; ran++) {
    const cmd = await sky.pushNext(cfg.host)
    if (!cmd) break
    if (!kindEnabled(cmd.kind, cfg)) {
      const msg = `kind not enabled on this bridge: ${cmd.kind}`
      log.warn(`push #${cmd.id} ${cmd.kind}: ${msg} — finished failed, not executed`)
      try { await sky.pushFinish(cmd.id, false, { executed: false, host: cfg.host, version: cfg.version }, msg) } catch (e2) { log.error(`push #${cmd.id}: could not record failure: ${e2.message}`) }
      continue
    }
    if (MO_KINDS.has(cmd.kind)) {
      await runMo(fb, sky, cmd, { cfg, log, refreshMo, removeMo })
      continue
    }
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
