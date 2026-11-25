// try-wo-post.mjs — S17 D2a (D-ASM-61): drive the bridge's own MO and wo_post handlers against the Fishbowl 26.11
// sandbox, with no SkyNet involved (D2a VERIFY 6–11). It builds each command by hand and calls mo.mjs / woPost.mjs.
//
//   FB_SANDBOX_URL=http://<sandbox>:2456 node scripts/try-wo-post.mjs <step> [args]
//     mo     <number> <qty>                                             create and issue an MO of SKYTEST-STUD-ASSEMBLY
//     post   <number> <produced> <scrapped> <finished lot> PART=LOT …   [--dry-run] [--pick-only]
//     cancel <number>                                                   unissue and delete the MO (mo_cancel)
//     facts  <number>                                                   read-only: MO, work order, pick lines, finished lot
//
// Fences (the probe's, D-ASM-59; sandboxGuard.mjs): the target is FB_SANDBOX_URL only and never the live server;
// after login the server must be 26.x and the company SANDBOX before anything else; only SKYTEST- parts and only MO
// numbers starting SBX-D2A-; only the write calls the handlers make are let through, never GET /api/picks/:id, never
// a fulfill with rawGoods. Run log: logs/try-wo-post.jsonl (redacted); ids between steps: logs/try-wo-post.state.json.
import fs from 'node:fs'
import { resolve } from 'node:path'
import { Fishbowl } from '../src/fishbowl.mjs'
import { q } from '../src/queries.mjs'
import { runMoCommand, findMo } from '../src/mo.mjs'
import { runWoPost, runWoPostPickOnly, WO_POST_KIND } from '../src/woPost.mjs'
import { ROOT, sandboxTarget, assertSandboxServer, bridgeCredentials, redact } from './sandboxGuard.mjs'

const LOG_DIR = resolve(ROOT, 'logs')
const RUN_LOG = resolve(LOG_DIR, 'try-wo-post.jsonl')
const STATE_FILE = resolve(LOG_DIR, 'try-wo-post.state.json')
const PART = 'SKYTEST-STUD-ASSEMBLY'
const PART_PREFIX = 'SKYTEST-'
const MO_PREFIX = 'SBX-D2A-'
const RECEIVING = 3
const cfg = { host: 'try-wo-post', version: 'sandbox',
  mo: { enabled: true, dryRun: false, writePartPrefix: PART_PREFIX, locationGroupId: 1, postEnabled: true, postMinVersion: '26.11', postTimeoutMs: 120000 } }

const show = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(redact(x), null, 2))
const log = { info: (m) => console.error(`[info] ${m}`), warn: (m) => console.error(`[warn] ${m}`), error: (m) => console.error(`[error] ${m}`) }
function record(entry) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.appendFileSync(RUN_LOG, JSON.stringify(redact({ at: new Date().toISOString(), ...entry })) + '\n')
}
const state = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return { mos: {} } } }
const saveState = (s) => { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)) }

function moNumber(n) {
  const v = String(n ?? '')
  if (!v.startsWith(MO_PREFIX) || !/^[A-Z0-9-]+$/.test(v) || v.length > 25) throw new Error(`MO number ${JSON.stringify(v)}: it must start ${MO_PREFIX} (letters, digits, dashes, 25 at most)`)
  return v
}

// Every write the handlers may make, and nothing else. GET /api/picks/:id is refused outright.
function guardCall(method, path, body, parts) {
  if (method === 'GET' && /^\/api\/picks\//.test(path)) throw new Error('GET /api/picks/:id is never called (D-ASM-59) — refused')
  if (method === 'GET') return
  const bad = (parts || []).filter((p) => !String(p).startsWith(PART_PREFIX))
  if (!parts?.length || bad.length) throw new Error(`parts fence: ${method} ${path} involves ${bad.join(', ') || 'no named part'} — refused`)
  const ok = [
    /^POST \/api\/manufacture-orders$/, /^POST \/api\/manufacture-orders\/\d+\/(issue|unissue)$/, /^DELETE \/api\/manufacture-orders\/\d+$/,
    /^POST \/api\/picks\/\d+\/start$/, /^POST \/api\/legacy\/external\/(GetPickRq|SavePickRq)$/, /^POST \/api\/work-orders\/\d+\/fulfill$/,
  ].some((re) => re.test(`${method} ${path}`))
  if (!ok) throw new Error(`${method} ${path} is not a call this script makes — refused`)
  if (path === '/api/manufacture-orders' && !String(body?.number ?? '').startsWith(MO_PREFIX)) throw new Error(`an MO made here must be numbered ${MO_PREFIX}… — refused`)
  if (path.endsWith('/fulfill') && body && Object.hasOwn(body, 'rawGoods')) throw new Error('a fulfill never sends rawGoods (D-ASM-59) — refused')
  if (path.endsWith('/SavePickRq')) {
    const nums = [...JSON.stringify(body).matchAll(/"(?:Num|PartNum)"\s*:\s*"([^"]+)"/g)].map((m) => m[1]).filter((n) => !/^\d+$/.test(n) && !n.startsWith('W'))
    const off = nums.filter((n) => !n.startsWith(PART_PREFIX))
    if (off.length) throw new Error(`parts fence: SavePickRq names ${[...new Set(off)].join(', ')} — refused`)
  }
}

// The handlers see this instead of the client: every query and call is fenced and written to the run log.
function fenced(fb, parts) {
  return {
    async query(sql) {
      const rows = await fb.query(sql)
      record({ kind: 'query', sql, rows: rows.length })
      return rows
    },
    async call(method, path, body, timeoutMs) {
      guardCall(method, path, body, parts)
      const r = timeoutMs ? await fb.call(method, path, body, timeoutMs) : await fb.call(method, path, body)
      record({ kind: method === 'GET' ? 'read' : 'write', method, path, parts: method === 'GET' ? undefined : parts, body: body ?? null, status: r.status, response: r.body })
      return r
    },
  }
}

async function openSandbox() {
  const target = sandboxTarget()
  const cred = bridgeCredentials()
  const fb = new Fishbowl({ host: target.host, port: target.port, user: cred.user, pass: cred.pass, appId: cred.appId,
    appName: 'SkyNet Bridge', appDescription: 'SkyNet MES sales order sync (read-only)', sessionMode: 'per_cycle', timeoutMs: 125000, importTimeoutMs: 300000 }, log)
  await fb.login()
  let sandbox
  try { sandbox = await assertSandboxServer(fb) } catch (e) { await fb.logout(); throw e }
  record({ kind: 'sandbox-check', target: target.origin, ...sandbox })
  return { fb, sandbox, target, close: () => fb.logout() }
}

const steps = {
  async check() {
    const s = await openSandbox()
    try { show({ target: s.target.origin, ...s.sandbox }) } finally { await s.close() }
  },

  async mo(n, qty) {
    const number = moNumber(n)
    const quantity = Number(qty)
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('usage: mo <number> <qty>')
    const s = await openSandbox()
    try {
      const parts = [PART, 'SKYTEST-STUD', 'SKYTEST-SPRING', 'SKYTEST-CUP', 'SKYTEST-PIN']
      const cmd = { id: `try-${number}`, kind: 'mo_create', dry_run: false, payload: { build_number: number, mo_number: number, bom_number: PART,
        quantity, issue: true, note: 'SBX D2a try (S17) - sandbox only', write_part_prefix: PART_PREFIX } }
      const r = await runMoCommand(fenced(s.fb, parts), cmd, { cfg, log, dryRun: false })
      const st = state(); st.mos[number] = { moId: r.fb_mo_id, qty: quantity }; saveState(st)
      show(r)
    } finally { await s.close() }
  },

  async post(n, produced, scrapped, lot, ...rest) {
    const number = moNumber(n)
    const dryRun = rest.includes('--dry-run')
    const pickOnly = rest.includes('--pick-only')
    const lots = rest.filter((a) => a.includes('=') && !a.startsWith('--')).map((a) => { const [part, l] = a.split('='); return { part, lot: l } })
    if (!lots.length) throw new Error('usage: post <number> <produced> <scrapped> <finished lot> PART=LOT … [--dry-run] [--pick-only]')
    const off = lots.filter((l) => !l.part.startsWith(PART_PREFIX))
    if (off.length) throw new Error(`parts fence: ${off.map((l) => l.part).join(', ')} — only ${PART_PREFIX} parts`)
    const s = await openSandbox()
    try {
      const mo = state().mos[number] ?? null
      const found = mo ?? await (async () => { const m = await findMo(s.fb, { num: number }); return m ? { moId: m.id, qty: null } : null })()
      if (!found) throw new Error(`${number} is not in Fishbowl`)
      let quantity = found.qty
      if (!quantity) quantity = Number((await s.fb.query(q.woPostWorkOrders(found.moId)))[0]?.qtyOrdered)
      const payload = { build_id: `try-${number}`, build_number: number, mo_number: number, fb_mo_id: found.moId, part_number: PART, quantity,
        produced: Number(produced), scrapped: Number(scrapped), finished_lot: lot, destination_location_id: RECEIVING,
        lots, min_version: '26.11', attempt: 1, write_part_prefix: PART_PREFIX }
      const cmd = { id: `try-${number}`, kind: WO_POST_KIND, dry_run: false, payload }
      const fishbowlVersion = s.sandbox.version
      const parts = [PART, ...lots.map((l) => l.part)]
      const run = pickOnly ? runWoPostPickOnly : runWoPost
      const r = await run(fenced(s.fb, parts), cmd, { cfg, log, dryRun, fishbowlVersion })
      record({ kind: 'result', step: pickOnly ? 'post --pick-only' : dryRun ? 'post --dry-run' : 'post', number, result: r })
      show(r)
    } catch (e) {
      record({ kind: 'refused-or-failed', number, name: e.name, message: e.message, halt: Boolean(e.halt) })
      throw e
    } finally { await s.close() }
  },

  async cancel(n) {
    const number = moNumber(n)
    const s = await openSandbox()
    try {
      const m = state().mos[number] ?? null
      const parts = [PART, 'SKYTEST-STUD', 'SKYTEST-SPRING', 'SKYTEST-CUP', 'SKYTEST-PIN']
      const cmd = { id: `try-${number}`, kind: 'mo_cancel', dry_run: false, payload: { mo_number: number, fb_mo_id: m?.moId ?? null, write_part_prefix: PART_PREFIX } }
      const r = await runMoCommand(fenced(s.fb, parts), cmd, { cfg, log, dryRun: false })
      show(r)
      show({ afterwards: (await findMo(s.fb, { num: number })) ?? 'not in Fishbowl' })
    } finally { await s.close() }
  },

  async facts(n) {
    const number = moNumber(n)
    const s = await openSandbox()
    try {
      const m = await findMo(s.fb, { num: number })
      if (!m) { show({ mo: `${number} is not in Fishbowl` }); return }
      const mo = (await s.fb.query(q.woPostMo(m.id)))[0]
      const wos = await s.fb.query(q.woPostWorkOrders(m.id))
      const out = { mo: { id: mo.id, num: mo.num, statusId: mo.statusId }, workOrders: [] }
      for (const wo of wos) {
        const items = await s.fb.query(q.woPostWoItems(wo.woId))
        const picks = await s.fb.query(q.woPostPicks(wo.woId))
        const lines = []
        for (const p of picks) lines.push(...(await s.fb.query(q.woPostPickLines(p.pickId))).map((l) => ({ pick: p.pickNum, pickStatusId: p.statusId, part: l.partNum, qty: l.qty, statusId: l.statusId, lot: l.lotNumber, srcTagNum: l.srcTagNum })))
        const lots = await s.fb.query(q.woFinishedLots(wo.woId))
        const finished = []
        for (const l of lots) finished.push({ lot: l.lotNumber, trackingQty: l.qty, tags: (await s.fb.query(q.woPostFinishedLotTags(PART, l.lotNumber))).map((t) => ({ tagNum: t.tagNum, qty: t.qty, location: t.locationName })) })
        out.workOrders.push({ wo: { id: wo.woId, num: wo.woNum, statusId: wo.statusId, qtyOrdered: wo.qtyOrdered },
          items: items.map((i) => ({ part: i.partNum, typeId: i.typeId, used: i.qtyUsed, scrapped: i.qtyScrapped })), pickLines: lines, finishedLots: finished })
      }
      show(out)
    } finally { await s.close() }
  },
}

const name = process.argv[2]
if (!name || !steps[name]) {
  console.error(`usage: FB_SANDBOX_URL=http://host:2456 node scripts/try-wo-post.mjs <${Object.keys(steps).join('|')}> [args]`)
  process.exit(2)
}
try {
  sandboxTarget() // fences 1 and 2, before anything touches the network
  await steps[name](...process.argv.slice(3))
} catch (e) {
  console.error(`try-wo-post: ${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}`)
  process.exitCode = 1
}
