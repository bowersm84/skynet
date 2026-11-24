// probe-sandbox-fulfill.mjs — S17 D2 probe (2026-11-24): can a finished build be posted to Fishbowl 26.11 with
// nobody keying it? Runs ONLY against the Fishbowl 26.11 sandbox (SKYFB-TEST). Never the live Fishbowl, never SkyNet.
//
//   FB_SANDBOX_URL=http://<sandbox>:2456 node scripts/probe-sandbox-fulfill.mjs <step> [args]
//
// Fences, in the order they apply (D2 prompt §3):
//   1. The target is FB_SANDBOX_URL and nothing else; no default. The bridge's FB_HOST / FB_PORT are never read.
//   2. Before any network call: refuse skyserver, 192.168.1.251, localhost, 127.0.0.1.
//   3. After login, before anything else: the server's version must start with 26. and the company name with SANDBOX.
//   4. Every write names only SKYTEST- parts, asserted in code before the call.
//   5. No SkyNet: this file imports nothing that talks to Supabase.
//   6. No secret is printed or saved: the login goes through the bridge's own client (never logged here), and every
//      saved request and response passes redact().
//   7. Sales orders, shipments, payments and scheduled tasks are never touched.
// Output: logs/<PROBE_LOG_NAME>.jsonl (run log) and logs/<PROBE_LOG_NAME>.state.json (ids between steps); PROBE_LOG_NAME
// defaults to probe-sandbox-fulfill (probe 1); probe 2 runs as probe-sandbox-cost. logs/probe-sandbox-apidocs/ holds the
// server's own docs. logs/ is git-ignored.
// Probe 2 rules (D-ASM-59): never send rawGoods on a fulfill — the finished pick lines decide what is consumed — and
// always send the finished good's destination (Receiving, location 3, unless PROBE_DEST_LOCATION_ID says otherwise).
import fs from 'node:fs'
import http from 'node:http'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Fishbowl } from '../src/fishbowl.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOG_DIR = resolve(ROOT, 'logs')
const LOG_NAME = String(process.env.PROBE_LOG_NAME || 'probe-sandbox-fulfill').replace(/[^A-Za-z0-9._-]/g, '')
const RUN_LOG = resolve(LOG_DIR, `${LOG_NAME}.jsonl`)
const STATE_FILE = resolve(LOG_DIR, `${LOG_NAME}.state.json`)
const DOCS_DIR = resolve(LOG_DIR, 'probe-sandbox-apidocs')
export const PART_PREFIX = 'SKYTEST-'
export const MO_PREFIX = 'SBX-PROBE-'
const RECEIVING = 3
const BOM_NUMBER = 'SKYTEST-STUD-ASSEMBLY'

// ── Fences 1 and 2: the target ────────────────────────────────────────────────────────────────────────────
const FORBIDDEN_HOSTS = ['skyserver', '192.168.1.251', 'localhost', '127.0.0.1']
export function sandboxTarget(env = process.env) {
  const raw = String(env.FB_SANDBOX_URL ?? '').trim()
  if (!raw) throw new Error('FB_SANDBOX_URL is not set — refusing to run (there is no default target)')
  let url
  try { url = new URL(raw) } catch { throw new Error(`FB_SANDBOX_URL is not a URL: ${raw}`) }
  if (url.protocol !== 'http:') throw new Error(`FB_SANDBOX_URL must be http://host:port, not ${url.protocol}`)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (FORBIDDEN_HOSTS.includes(host) || host.startsWith('skyserver') || host === '::1' || host.endsWith('.localhost') || host.startsWith('127.')) {
    throw new Error(`FB_SANDBOX_URL host ${host} is the live Fishbowl or this PC — refusing to run`)
  }
  return { host, port: Number(url.port || 2456), origin: `http://${url.hostname}:${url.port || 2456}` }
}

// ── Credentials: only the bridge's Fishbowl user and integrated-app id; FB_HOST / FB_PORT are never read ──
function bridgeCredentials() {
  const file = resolve(ROOT, '.env')
  const wanted = new Set(['FB_USER', 'FB_PASS', 'FB_APP_ID'])
  const out = {}
  if (fs.existsSync(file)) {
    let text = fs.readFileSync(file)
    text = text[0] === 0xff && text[1] === 0xfe ? text.subarray(2).toString('utf16le') : text.toString('utf8').replace(/^﻿/, '')
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (m && wanted.has(m[1]) && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
  for (const k of wanted) if (process.env[k]) out[k] = process.env[k]
  if (!out.FB_USER || !out.FB_PASS) throw new Error('FB_USER / FB_PASS not found in tools/fishbowl-bridge/.env')
  return { user: out.FB_USER, pass: out.FB_PASS, appId: Number(out.FB_APP_ID || 4350) }
}

// ── Fence 6: nothing secret is saved ───────────────────────────────────────────────────────────────────────
const SECRET_KEY = /pass(word)?|token|authorization|ticket|secret|apikey|api_key|session(id)?$/i
export function redact(v) {
  if (Array.isArray(v)) return v.map(redact)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '<redacted>' : redact(x)]))
  if (typeof v === 'string') return v.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <redacted>')
  return v
}
function record(entry) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.appendFileSync(RUN_LOG, JSON.stringify(redact({ at: new Date().toISOString(), ...entry })) + '\n')
}
const state = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return { mos: {} } } }
const saveState = (s) => { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)) }
const show = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2))
const quiet = { info: (m) => console.error(`[info] ${m}`), warn: (m) => console.error(`[warn] ${m}`), error: (m) => console.error(`[error] ${m}`) }

// ── Fence 4: SKYTEST- parts only ──────────────────────────────────────────────────────────────────────────
export function assertParts(partNums, what) {
  const list = [...new Set((partNums || []).map((p) => (p === null || p === undefined ? '' : String(p))))]
  if (list.length === 0) throw new Error(`parts fence: ${what} names no part — refusing`)
  const off = list.filter((p) => !p.startsWith(PART_PREFIX))
  if (off.length) throw new Error(`parts fence: ${what} involves ${off.join(', ')} — only ${PART_PREFIX} parts may be written`)
  return list
}

// ── A session on the sandbox, fence 3 checked before anything else ────────────────────────────────────────
const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`
async function openSandbox() {
  const target = sandboxTarget()
  const cred = bridgeCredentials()
  const fb = new Fishbowl({
    host: target.host, port: target.port, user: cred.user, pass: cred.pass, appId: cred.appId,
    appName: 'SkyNet Bridge', appDescription: 'SkyNet MES sales order sync (read-only)',
    sessionMode: 'per_cycle', timeoutMs: 125000, importTimeoutMs: 300000,
  }, quiet)
  await fb.login()
  const q = async (sql) => { const rows = await fb.query(sql); record({ kind: 'query', sql, rows: rows.length }); return rows }
  const ver = await q('SELECT version, alterCommand FROM databaseversion ORDER BY version DESC LIMIT 1')
  const m = String(ver[0]?.alterCommand || '').match(/(\d{2,4})\.(\d+)/)
  const version = m ? `${m[1].length === 4 ? m[1].slice(2) : m[1]}.${m[2]}` : null
  const company = await q('SELECT id, name FROM company ORDER BY id LIMIT 5')
  const name = String(company[0]?.name || '')
  const sandbox = { version, versionRow: ver[0]?.alterCommand ?? null, company: name, companies: company.map((c) => `${c.id}:${c.name}`) }
  record({ kind: 'sandbox-check', ...sandbox })
  if (!version || !version.startsWith('26.') || !name.startsWith('SANDBOX')) {
    await fb.logout()
    throw new Error(`fence 3: this server is version ${version ?? '?'} ("${sandbox.versionRow}"), company "${name}" — not the 26.x SANDBOX; refusing`)
  }
  let writes = 0
  // Every write goes through here: parts fence, then the call, then the run log.
  const write = async (method, path, body, { parts, what }) => {
    assertParts(parts, what || `${method} ${path}`)
    if (path.endsWith('/fulfill') && body && Object.hasOwn(body, 'rawGoods')) throw new Error('rule: a fulfill never sends rawGoods (D-ASM-59) — refusing')
    const r = await fb.call(method, path, body)
    writes++
    record({ kind: 'write', method, path, parts, body: body ?? null, status: r.status, response: r.body })
    return r
  }
  const read = async (path) => {
    const r = await fb.call('GET', path)
    record({ kind: 'read', method: 'GET', path, status: r.status, response: r.body })
    return r
  }
  return { fb, q, write, read, sandbox, target, writes: () => writes, close: () => fb.logout() }
}

// ── Helpers for the steps ─────────────────────────────────────────────────────────────────────────────────
function need(n) {
  const m = state().mos[n]
  if (!m) throw new Error(`no MO "${n}" in ${STATE_FILE} — run "mo ${n}" first`)
  return m
}
function moNumber(key) {
  const k = String(key ?? '')
  const number = /^\d{1,3}$/.test(k) ? `${MO_PREFIX}${k}` : k
  if (!/^SBX-[A-Z0-9-]+$/.test(number)) throw new Error(`MO key ${k}: use a number or a name starting SBX- (letters, digits, dashes)`)
  if (number.length > 25) throw new Error(`${number} is over 25 characters`)
  return number
}
async function moIds(s, moId) {
  const wo = await s.q(`SELECT wo.id AS woId, wo.num AS woNum FROM wo JOIN moitem mi ON mi.id = wo.moItemId WHERE mi.moId = ${Number(moId)}`)
  const pick = wo.length ? await s.q(`SELECT DISTINCT pi.pickId, pick.num AS pickNum FROM pickitem pi JOIN woitem wi ON wi.id = pi.woItemId JOIN pick ON pick.id = pi.pickId WHERE wi.woId = ${Number(wo[0].woId)}`) : []
  return { woId: wo[0]?.woId ?? null, woNum: wo[0]?.woNum ?? null, pickId: pick[0]?.pickId ?? null, pickNum: pick[0]?.pickNum ?? null }
}
async function pickPartNums(s, pickId) {
  return (await s.q(`SELECT DISTINCT p.num AS partNum FROM pickitem pi JOIN part p ON p.id = pi.partId WHERE pi.pickId = ${Number(pickId)}`)).map((r) => r.partNum)
}
async function pickRows(s, pickId) {
  return s.q(`SELECT pi.id, p.num AS partNum, pi.qty, pi.statusId, pis.name AS status, pi.srcLocationId, pi.srcTagId, pi.tagId, pi.destTagId,
      srcT.info AS srcTagLot, curT.info AS tagLot, ti.info AS trackingInfoLot
    FROM pickitem pi JOIN part p ON p.id = pi.partId LEFT JOIN pickitemstatus pis ON pis.id = pi.statusId
    LEFT JOIN trackingtext srcT ON srcT.tagId = pi.srcTagId AND srcT.partTrackingId = 1
    LEFT JOIN trackingtext curT ON curT.tagId = pi.tagId AND curT.partTrackingId = 1
    LEFT JOIN trackinginfo ti ON ti.recordId = pi.id AND ti.tableId = -1515431424 AND ti.partTrackingId = 1
    WHERE pi.pickId = ${Number(pickId)} ORDER BY p.num`)
}
function pickLines(body) {
  return (body?.pickItems || []).map((pi) => ({
    id: pi.id, part: pi.part?.name, status: pi.status, qty: pi.quantity, finishable: pi.finishable,
    source: pi.sourceTag ? `tag ${pi.sourceTag.number} @ ${pi.sourceTag.location?.name}` : pi.sourceLocation ? `loc ${pi.sourceLocation.location?.name}` : null,
    currentTag: pi.currentTag ? `tag ${pi.currentTag.number} @ ${pi.currentTag.location?.name}` : null,
    lot: (pi.tracking?.trackingItems || []).map((t) => t.value).join(',') || null,
  }))
}

// ── Probe 2: one build's facts, and the differences between two builds ───────────────────────────────────
// Fishbowl's table ids, as seen in inventorylog / costlayer / trackinginfo rows on this server (probe 1).
const T_PICKITEM = -1515431424
const T_WOITEM = -355941248
const T_INVLOG = -1081854656
const COST_LOTS = [
  ['SKYTEST-STUD', '2.00', ['SBX-CA-STUD', 'SBX-CB-STUD']],
  ['SKYTEST-SPRING', '0.50', ['SBX-CA-SPRING', 'SBX-CB-SPRING']],
  ['SKYTEST-CUP', '0.75', ['SBX-CA-CUP', 'SBX-CB-CUP']],
  ['SKYTEST-PIN', '0.25', ['SBX-CA-PIN', 'SBX-CB-PIN']],
]
const inList = (xs) => (xs.length ? xs.map(Number).join(',') : '0')
async function buildFacts(s, m) {
  const moId = Number(m.moId)
  const woId = Number(m.woId)
  const mo = (await s.q(`SELECT mo.id, mo.num, ms.name AS status, mo.dateIssued, mo.dateCompleted, mo.userId FROM mo LEFT JOIN mostatus ms ON ms.id = mo.statusId WHERE mo.id = ${moId}`))[0] ?? null
  const moItems = await s.q(`SELECT mi.id, p.num AS partNum, mi.typeId, mi.qtyToFulfill, mi.qtyFulfilled, mi.totalCost, mi.statusId FROM moitem mi JOIN part p ON p.id = mi.partId
    WHERE mi.moId = ${moId} ORDER BY mi.typeId, p.num`)
  const wo = (await s.q(`SELECT wo.id, wo.num, ws.name AS status, wo.qtyOrdered, wo.qtyTarget, wo.qtyScrapped, wo.cost, wo.locationId, wo.dateStarted, wo.dateFinished, wo.userId
    FROM wo LEFT JOIN wostatus ws ON ws.id = wo.statusId WHERE wo.id = ${woId}`))[0] ?? null
  const woItems = await s.q(`SELECT wi.id, wi.typeId, p.num AS partNum, wi.qtyTarget, wi.qtyUsed, wi.qtyScrapped, wi.cost, wi.standardCost FROM woitem wi JOIN part p ON p.id = wi.partId
    WHERE wi.woId = ${woId} ORDER BY wi.typeId, p.num`)
  const wiList = inList(woItems.map((w) => w.id))
  const pickItems = await s.q(`SELECT pi.id, p.num AS partNum, pi.qty, pis.name AS status, pi.srcLocationId, ti.info AS lot FROM pickitem pi JOIN part p ON p.id = pi.partId
    LEFT JOIN pickitemstatus pis ON pis.id = pi.statusId LEFT JOIN trackinginfo ti ON ti.recordId = pi.id AND ti.tableId = ${T_PICKITEM} AND ti.partTrackingId = 1
    WHERE pi.woItemId IN (${wiList}) ORDER BY p.num, ti.info`)
  const piList = inList(pickItems.map((p) => p.id))
  // the work order's tracking: the finished good's lot and each component's consumed lot, on the woitem rows
  const tracking = await s.q(`SELECT ti.id, p.num AS partNum, wi.typeId, ti.info AS lot, ti.qty FROM trackinginfo ti JOIN woitem wi ON wi.id = ti.recordId JOIN part p ON p.id = wi.partId
    WHERE ti.tableId = ${T_WOITEM} AND ti.recordId IN (${wiList}) ORDER BY wi.typeId, p.num, ti.info`)
  const inventoryLog = await s.q(`SELECT il.id, ilt.name AS type, p.num AS partNum, il.changeQty, il.cost, il.info, il.begLocationId, il.endLocationId, il.tableId, il.userId, il.dateCreated,
      (SELECT GROUP_CONCAT(ts.TRACKVALUE ORDER BY ts.TRACKVALUE) FROM invlogtrackingsummary ts WHERE ts.INVLOGID = il.id) AS lots
    FROM inventorylog il JOIN part p ON p.id = il.partId LEFT JOIN inventorylogtype ilt ON ilt.id = il.typeId
    WHERE (il.tableId = ${T_WOITEM} AND il.recordId IN (${wiList})) OR (il.tableId = ${T_PICKITEM} AND il.recordId IN (${piList})) ORDER BY il.id`)
  const ilList = inList(inventoryLog.map((r) => r.id))
  // which cost layer each inventory-log row drew on, and where that layer came from (an add's note, or a build)
  const layerUse = await s.q(`SELECT x.id, x.inventoryLogId, il.typeId AS logTypeId, p.num AS partNum, x.qty, ROUND(cl.orgTotalCost / NULLIF(cl.orgQty, 0), 4) AS layerUnitCost,
      cl.tableId AS layerTableId, src.info AS layerSource, (SELECT GROUP_CONCAT(ts.TRACKVALUE) FROM invlogtrackingsummary ts WHERE ts.INVLOGID = src.id) AS layerLot
    FROM inventorylogtocostlayer x JOIN costlayer cl ON cl.id = x.costLayerId JOIN part p ON p.id = cl.partId JOIN inventorylog il ON il.id = x.inventoryLogId
    LEFT JOIN inventorylog src ON cl.tableId = ${T_INVLOG} AND src.id = cl.recordId
    WHERE x.inventoryLogId IN (${ilList}) ORDER BY p.num, x.inventoryLogId`)
  const layers = await s.q(`SELECT cl.id, p.num AS partNum, cls.name AS status, cl.orgQty, cl.orgTotalCost, ROUND(cl.orgTotalCost / NULLIF(cl.orgQty, 0), 4) AS unitCost, cl.qty, cl.totalCost, cl.tableId
    FROM costlayer cl JOIN part p ON p.id = cl.partId LEFT JOIN costlayerstatus cls ON cls.id = cl.statusId
    WHERE (cl.tableId = ${T_WOITEM} AND cl.recordId IN (${wiList})) OR (cl.tableId = ${T_INVLOG} AND cl.recordId IN (${ilList})) ORDER BY p.num`)
  const fgLot = tracking.find((t) => Number(t.typeId) === 10)?.lot ?? null
  const finishedLot = fgLot ? await s.q(`SELECT tag.id, tag.num, tag.qty, tag.qtyCommitted, loc.name AS location FROM tag JOIN part p ON p.id = tag.partId JOIN location loc ON loc.id = tag.locationId
    JOIN trackingtext tt ON tt.tagId = tag.id AND tt.partTrackingId = 1 WHERE p.num = ${sqlStr(BOM_NUMBER)} AND tt.info = ${sqlStr(fgLot)}`) : []
  const postwo = await s.q(`SELECT pw.id, pw.statusId, pw.postDate, pw.datePosted, pw.extTxnNumber, pw.extRefNumber FROM postwo pw WHERE pw.woId = ${woId} ORDER BY pw.id`)
  const postwoItems = postwo.length ? await s.q(`SELECT pwi.id, pwi.postWoId, p.num AS partNum, wi.typeId, pwi.postedTotalCost, pwi.extTxnLineId FROM postwoitem pwi
    JOIN woitem wi ON wi.id = pwi.woItemId JOIN part p ON p.id = wi.partId WHERE pwi.postWoId IN (${inList(postwo.map((p) => p.id))}) ORDER BY wi.typeId, p.num`) : []
  // post rows written while the build's inventory moved (five seconds either side). Not matched by id: an Adjust
  // post's refId is a part id, so an id match pulls in unrelated rows.
  const posts = await s.q(`SELECT po.id, pt.name AS type, po.amount, po.quantity, po.postedTotalCost, po.orderTypeId, po.orderId, po.refId, po.refItemId, po.refNumber, po.statusId, po.dateCreated
    FROM post po LEFT JOIN posttype pt ON pt.id = po.typeId
    WHERE po.dateCreated BETWEEN (SELECT DATE_SUB(MIN(dateCreated), INTERVAL 5 SECOND) FROM inventorylog WHERE id IN (${ilList}))
      AND (SELECT DATE_ADD(MAX(dateCreated), INTERVAL 5 SECOND) FROM inventorylog WHERE id IN (${ilList})) ORDER BY po.id`)
  return { mo, moItems, wo, woItems, pickItems, tracking, inventoryLog, layerUse, layers, finishedLot, postwo, postwoItems, posts,
    placeholders: { [mo?.num ?? '-']: '<MO>', [wo?.num ?? '-']: '<WO>', [fgLot ?? '-']: '<finished lot>' } }
}
// Drop what is expected to differ (ids, order numbers, timestamps, user) and name the MO, WO and finished lot alike.
const KEEP_ID = new Set(['typeId', 'statusId', 'begLocationId', 'endLocationId', 'srcLocationId', 'locationId', 'tableId', 'orderTypeId', 'logTypeId', 'layerTableId', 'partTrackingId'])
function normalRow(row, ph) {
  const out = {}
  for (const [k, v] of Object.entries(row || {})) {
    if (k === 'id' || k === 'num' || k === 'userId' || /^date/i.test(k) || k === 'postDate' || (/Id$/.test(k) && !KEEP_ID.has(k))) continue
    let x = v
    if (typeof x === 'string') for (const [from, to] of Object.entries(ph)) if (from !== '-') x = x.split(from).join(to)
    out[k] = x
  }
  return JSON.stringify(out, Object.keys(out).sort())
}
function diffBuilds(A, B) {
  const sections = ['mo', 'moItems', 'wo', 'woItems', 'pickItems', 'tracking', 'inventoryLog', 'layerUse', 'layers', 'finishedLot', 'postwo', 'postwoItems', 'posts']
  const out = {}
  for (const sec of sections) {
    const rows = (F) => [].concat(F[sec] ?? []).map((r) => normalRow(r, F.placeholders))
    const a = rows(A)
    const b = rows(B)
    const onlyA = [...a]
    const onlyB = []
    for (const r of b) { const i = onlyA.indexOf(r); if (i >= 0) onlyA.splice(i, 1); else onlyB.push(r) }
    out[sec] = onlyA.length || onlyB.length ? { onlyA, onlyB } : 'same'
  }
  return out
}

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────────────────
const steps = {
  // Fences only, then the sandbox check. Read-only.
  async check() {
    const s = await openSandbox()
    try { show({ target: s.target.origin, ...s.sandbox }) } finally { await s.close() }
  },

  // T1: preflight, read-only. The test BOM, its parts and their lot tracking, and every SKYTEST- lot on hand.
  async preflight() {
    const s = await openSandbox()
    try {
      const bom = await s.q(`SELECT b.id, b.num, b.activeFlag FROM bom b WHERE b.num = ${sqlStr(BOM_NUMBER)}`)
      const items = bom.length ? await s.q(`SELECT bi.id AS bomItemId, bi.typeId, bi.quantity, p.id AS partId, p.num AS partNum, p.trackingFlag,
          (SELECT GROUP_CONCAT(CONCAT(pt.id, ':', pt.name, IF(ptt.primaryFlag=1,'*','')) SEPARATOR ', ') FROM parttotracking ptt
             JOIN parttracking pt ON pt.id = ptt.partTrackingId WHERE ptt.partId = p.id) AS tracking
        FROM bomitem bi JOIN part p ON p.id = bi.partId WHERE bi.bomId = ${Number(bom[0].id)} ORDER BY bi.typeId, bi.sortIdConfig`) : []
      const lots = await s.q(`SELECT p.num AS partNum, tt.info AS lot, tag.id AS tagId, tag.num AS tagNum, tag.qty, tag.qtyCommitted,
          loc.id AS locationId, loc.name AS location, lg.name AS locationGroup
        FROM tag JOIN part p ON p.id = tag.partId JOIN location loc ON loc.id = tag.locationId LEFT JOIN locationgroup lg ON lg.id = loc.locationGroupId
        LEFT JOIN trackingtext tt ON tt.tagId = tag.id AND tt.partTrackingId = 1
        WHERE p.num LIKE 'SKYTEST-%' AND tag.qty > 0 ORDER BY p.num, tt.info`)
      const mos = await s.q(`SELECT id, num, statusId FROM mo WHERE num LIKE 'SBX-%' OR num LIKE 'SKYTEST-%' ORDER BY id`)
      const components = items.filter((i) => Number(i.typeId) === 20)
      const short = components.filter((c) => lots.filter((l) => l.partNum === c.partNum && Number(l.qty) - Number(l.qtyCommitted || 0) >= 2).length < 2).map((c) => c.partNum)
      show({ sandbox: s.sandbox, bom: bom[0] ?? null, items, lots, existingMos: mos, componentsShortOfTwoLots: short })
    } finally { await s.close() }
  },

  // T2: create and issue an MO for the test BOM, quantity 2 (or the second argument). The key is a number (probe 1:
  // SBX-PROBE-<n>) or a full name starting SBX- (probe 2: SBX-COST-API, SBX-COST-HAND); either is the state key.
  async mo(n, qty = '2') {
    const number = moNumber(n)
    const s = await openSandbox()
    try {
      if ((await s.q(`SELECT id FROM mo WHERE num = ${sqlStr(number)}`)).length) throw new Error(`${number} already exists in the sandbox`)
      const bom = (await s.q(`SELECT id FROM bom WHERE num = ${sqlStr(BOM_NUMBER)} AND activeFlag = 1`))[0]
      if (!bom) throw new Error(`BOM ${BOM_NUMBER} is not active in the sandbox`)
      const parts = (await s.q(`SELECT p.num AS partNum FROM bomitem bi JOIN part p ON p.id = bi.partId WHERE bi.bomId = ${Number(bom.id)}`)).map((r) => r.partNum)
      const body = { number, locationGroup: { id: 1 }, configurations: [{ bom: { id: Number(bom.id) }, quantity: String(qty) }] }
      const c = await s.write('POST', '/api/manufacture-orders', body, { parts, what: `create MO ${number}` })
      show({ create: c.status, id: c.body?.id, number: c.body?.number, status: c.body?.status })
      if (c.status !== 200 || c.body?.number !== number) throw new Error(`create answered ${c.status}: ${JSON.stringify(c.body).slice(0, 400)}`)
      const i = await s.write('POST', `/api/manufacture-orders/${c.body.id}/issue`, undefined, { parts, what: `issue MO ${number}` })
      show({ issue: i.status, status: i.body?.status })
      const ids = await moIds(s, c.body.id)
      const st = state(); st.mos[n] = { number, moId: c.body.id, ...ids, qty: Number(qty) }; saveState(st)
      show({ recorded: st.mos[n] })
    } finally { await s.close() }
  },

  // T3: the full work order and pick (the pick GET may source and save lines, so it is fenced as a write).
  async read(n) {
    const m = need(n)
    const s = await openSandbox()
    try {
      const wo = await s.read(`/api/work-orders/${m.woId}`)
      const pickParts = await pickPartNums(s, m.pickId)
      const pick = await s.write('GET', `/api/picks/${m.pickId}`, undefined, { parts: pickParts, what: `read pick ${m.pickId} (may source and save lines)` })
      const consume = (wo.body?.woItems || []).flatMap((it) => (it.consumeItems || []).map((ci) => ({ part: ci.part?.name, qty: ci.quantity, pickItemId: ci.pickItemId ?? null, pickItemStatus: ci.pickItemStatus?.name ?? null })))
      show({ wo: wo.status, woStatus: wo.body?.status, items: (wo.body?.woItems || []).map((it) => ({ id: it.id, part: it.part?.name, type: it.type?.name, qty: it.quantity, destLocation: it.destLocation ?? null })), consumeItems: consume, pickItemIdPresent: consume.some((c) => c.pickItemId !== null) })
      show({ pick: pick.status, pickStatus: pick.body?.status, items: pickLines(pick.body) })
      const st = state(); st.mos[n].fgItemId = (wo.body?.woItems || []).find((it) => it.type?.id === 10 || it.type?.name === 'Finished Good')?.id ?? null
      st.mos[n].fgDestLocationId = (wo.body?.woItems || []).find((it) => it.type?.id === 10 || it.type?.name === 'Finished Good')?.destLocation?.id ?? null
      saveState(st)
    } finally { await s.close() }
  },

  // T4: start the pick through REST; then each line's status, source, tag and lot.
  async 'start-pick'(n) {
    const m = need(n)
    const s = await openSandbox()
    try {
      const parts = await pickPartNums(s, m.pickId)
      const r = await s.write('POST', `/api/picks/${m.pickId}/start`, undefined, { parts, what: `start pick ${m.pickId}` })
      show({ start: r.status, pickStatus: r.body?.status, items: pickLines(r.body), error: r.status >= 300 ? r.body : undefined })
      show({ pickItemRows: await pickRows(s, m.pickId) })
    } finally { await s.close() }
  },

  // Fulfill: produced and scrapped quantities and the finished lot as given; the destination always sent (Receiving
  // unless PROBE_DEST_LOCATION_ID); rawGoods never sent (D-ASM-59), so the finished pick lines decide what is consumed.
  // Probe 1's "rawgoods" and "override" runs are recorded in its results file; they are not repeatable from here.
  async fulfill(n, produced = '1', scrapped = '1', lot = 'SBX-80001') {
    const m = need(n)
    if (!/^\d+$/.test(String(produced)) || !/^\d+$/.test(String(scrapped))) throw new Error('usage: fulfill <key> <produced> <scrapped> <finished lot>')
    const s = await openSandbox()
    try {
      const wo = await s.read(`/api/work-orders/${m.woId}`)
      const items = wo.body?.woItems || []
      const fg = items.find((it) => it.type?.id === 10 || it.type?.name === 'Finished Good')
      if (!fg) throw new Error('no finished-good item on the work order')
      const dest = Number(process.env.PROBE_DEST_LOCATION_ID || RECEIVING)
      const body = {
        finishedGoods: [{ itemId: fg.id, quantityUsed: String(produced), quantityScrapped: String(scrapped), destinationLocationId: dest,
          tracking: { trackingItems: [{ partTracking: { id: 1 }, value: lot }] } }],
        splitWorkOrder: false,
      }
      const parts = items.map((it) => it.part?.name).filter(Boolean)
      const r = await s.write('POST', `/api/work-orders/${m.woId}/fulfill`, body, { parts, what: `fulfill WO ${m.woId}` })
      show({ request: body, status: r.status, response: r.status >= 300 ? r.body : { status: r.body?.status, number: r.body?.number } })
    } finally { await s.close() }
  },

  // Probe 2 T1 (and after T2 and each build), read-only: the costing method and accounting settings, then every
  // SKYTEST- part's cost, on-hand, open cost layers and recent cost history, and the probe-2 lots.
  async costing() {
    const s = await openSandbox()
    try {
      const settings = (await s.q(`SELECT sysKey, sysValue FROM sysproperties WHERE sysKey LIKE 'Acct%' OR sysKey LIKE '%Cost%' OR sysKey LIKE '%Accounting%' ORDER BY sysKey`))
        .map((r) => (/pass|token|secret|ticket|session|user|login|key$|path|file|url|host/i.test(r.sysKey) ? { sysKey: r.sysKey, sysValue: '<not shown>' } : r))
      const parts = await s.q(`SELECT p.id, p.num, p.stdCost, p.inventoryAccountId, p.cogsAccountId, p.adjustmentAccountId, p.scrapAccountId, p.varianceAccountId,
          pc.avgCost, pc.qty AS costQty, pc.totalCost, (SELECT COALESCE(SUM(tag.qty), 0) FROM tag WHERE tag.partId = p.id) AS onHand
        FROM part p LEFT JOIN partcost pc ON pc.partId = p.id WHERE p.num LIKE 'SKYTEST-%' ORDER BY p.num`)
      const openLayers = await s.q(`SELECT p.num AS partNum, cl.id, cls.name AS status, cl.orgQty, cl.orgTotalCost, ROUND(cl.orgTotalCost / NULLIF(cl.orgQty, 0), 4) AS unitCost, cl.qty, cl.totalCost,
          cl.tableId, cl.recordId, src.info AS source, cl.dateCreated
        FROM costlayer cl JOIN part p ON p.id = cl.partId LEFT JOIN costlayerstatus cls ON cls.id = cl.statusId LEFT JOIN inventorylog src ON cl.tableId = ${T_INVLOG} AND src.id = cl.recordId
        WHERE p.num LIKE 'SKYTEST-%' AND cl.qty <> 0 ORDER BY p.num, cl.id`)
      const history = await s.q(`SELECT p.num AS partNum, h.dateCaptured, h.avgCost, h.stdCost, h.nextCost, h.quantity, h.totalCost FROM partcosthistory h JOIN part p ON p.id = h.partId
        WHERE p.num LIKE 'SKYTEST-%' ORDER BY h.dateCaptured DESC, p.num LIMIT 12`)
      const lots = COST_LOTS.flatMap(([, , l]) => l)
      const costLots = await s.q(`SELECT p.num AS partNum, tt.info AS lot, tag.qty, tag.qtyCommitted, loc.name AS location FROM tag JOIN part p ON p.id = tag.partId JOIN location loc ON loc.id = tag.locationId
        JOIN trackingtext tt ON tt.tagId = tag.id AND tt.partTrackingId = 1 WHERE p.num LIKE 'SKYTEST-%' AND tt.info IN (${lots.map(sqlStr).join(',')}) ORDER BY p.num, tt.info, loc.name`)
      show({ sandbox: s.sandbox, settings, parts, openLayers, history, costLots })
    } finally { await s.close() }
  },

  // Probe 2 T2: costed stock. 20 of each lot into Stock (location 1) at the entered unit cost, one add per lot, in
  // the table's order. Refuses if any of the lots already exists; stops at the first refusal (no retry). Then every
  // posting, inventory-log and cost-layer row the adds wrote.
  async 'add-stock'() {
    const QTY = '20'
    const STOCK = 1
    const NOTE = 'SBX probe 2 cost control (S17 D2) - sandbox only'
    const s = await openSandbox()
    try {
      const lots = COST_LOTS.flatMap(([, , l]) => l)
      const existing = await s.q(`SELECT DISTINCT info FROM trackingtext WHERE info IN (${lots.map(sqlStr).join(',')})
        UNION SELECT DISTINCT info FROM trackinginfo WHERE info IN (${lots.map(sqlStr).join(',')})`)
      if (existing.length) throw new Error(`lot(s) ${existing.map((r) => r.info).join(', ')} already in the sandbox — refusing a second add`)
      const ids = Object.fromEntries((await s.q(`SELECT id, num FROM part WHERE num IN (${COST_LOTS.map((a) => sqlStr(a[0])).join(',')})`)).map((r) => [r.num, Number(r.id)]))
      const before = { post: (await s.q('SELECT MAX(id) AS m FROM post'))[0].m, invlog: (await s.q('SELECT MAX(id) AS m FROM inventorylog'))[0].m, layer: (await s.q('SELECT MAX(id) AS m FROM costlayer'))[0].m }
      const calls = []
      for (const [part, unitCost, partLots] of COST_LOTS) {
        if (!ids[part]) throw new Error(`${part} is not in the sandbox`)
        for (const lot of partLots) {
          const body = { location: { id: STOCK }, quantity: QTY, uom: { id: 1 }, unitCost, note: NOTE, trackingItems: [{ partTracking: { id: 1 }, value: lot }] }
          const r = await s.write('POST', `/api/parts/${ids[part]}/inventory/add`, body, { parts: [part], what: `add ${QTY} ${part} lot ${lot} at ${unitCost}` })
          calls.push({ part, lot, unitCost, status: r.status, response: r.status >= 300 ? r.body : undefined })
          if (r.status >= 300) { show({ calls }); throw new Error(`add ${part} lot ${lot} answered ${r.status} — stopping here, no retry`) }
        }
      }
      const posts = await s.q(`SELECT po.id, pt.name AS type, po.amount, po.quantity, po.postedTotalCost, po.orderTypeId, po.refId, po.refItemId, po.refNumber, po.statusId
        FROM post po LEFT JOIN posttype pt ON pt.id = po.typeId WHERE po.id > ${Number(before.post)} ORDER BY po.id`)
      const invlog = await s.q(`SELECT il.id, ilt.name AS type, p.num AS partNum, il.changeQty, il.cost, il.info, il.begLocationId, il.endLocationId, il.tableId, il.recordId
        FROM inventorylog il JOIN part p ON p.id = il.partId LEFT JOIN inventorylogtype ilt ON ilt.id = il.typeId WHERE il.id > ${Number(before.invlog)} ORDER BY il.id`)
      const layers = await s.q(`SELECT cl.id, p.num AS partNum, cl.orgQty, cl.orgTotalCost, ROUND(cl.orgTotalCost / NULLIF(cl.orgQty, 0), 4) AS unitCost, cl.qty, cl.totalCost, cl.tableId, cl.recordId
        FROM costlayer cl JOIN part p ON p.id = cl.partId WHERE cl.id > ${Number(before.layer)} ORDER BY cl.id`)
      show({ before, calls, posts, invlog, layers })
    } finally { await s.close() }
  },

  // Probe 2 T6, read-only: both builds side by side, then every difference once ids, order numbers, timestamps and
  // the user are set aside (the MO, WO and finished lot are named <MO>, <WO>, <finished lot> in both). The full read
  // is saved under logs/ for the results file.
  async compare(a = 'SBX-COST-API', b = 'SBX-COST-HAND') {
    const ma = need(a)
    const mb = need(b)
    const s = await openSandbox()
    try {
      const builds = { [a]: await buildFacts(s, ma), [b]: await buildFacts(s, mb) }
      const statuses = { postStatus: await s.q('SELECT id, name FROM poststatus ORDER BY id'), postOrderStatus: await s.q('SELECT id, name FROM postorderstatus ORDER BY id'),
        costLayerStatus: await s.q('SELECT id, name FROM costlayerstatus ORDER BY id') }
      const diff = diffBuilds(builds[a], builds[b])
      const file = resolve(LOG_DIR, `${LOG_NAME}-compare-${Date.now()}.json`)
      fs.writeFileSync(file, JSON.stringify(redact({ a, b, builds, statuses, diff }), null, 2))
      show({ builds, statuses, diff, saved: file })
    } finally { await s.close() }
  },

  // T7 verification, read-only: MO and WO status, the finished lot, and which lots were consumed.
  async verify(n) {
    const m = need(n)
    const s = await openSandbox()
    try {
      const mo = await s.q(`SELECT mo.id, mo.num, mo.statusId, ms.name AS status FROM mo LEFT JOIN mostatus ms ON ms.id = mo.statusId WHERE mo.id = ${Number(m.moId)}`)
      const wo = await s.q(`SELECT wo.id, wo.num, wo.statusId, ws.name AS status, wo.qtyTarget, wo.qtyScrapped, wo.cost FROM wo LEFT JOIN wostatus ws ON ws.id = wo.statusId WHERE wo.id = ${Number(m.woId)}`)
      const woItems = await s.q(`SELECT wi.id, wi.typeId, p.num AS partNum, wi.qtyTarget, wi.qtyUsed, wi.qtyScrapped, wi.cost FROM woitem wi JOIN part p ON p.id = wi.partId WHERE wi.woId = ${Number(m.woId)} ORDER BY wi.typeId, wi.id`)
      const consumed = await s.q(`SELECT pi.id AS pickItemId, p.num AS partNum, pi.qty, pi.statusId, ti.info AS lot FROM pickitem pi JOIN woitem wi ON wi.id = pi.woItemId
        JOIN part p ON p.id = pi.partId LEFT JOIN trackinginfo ti ON ti.recordId = pi.id AND ti.tableId = -1515431424 AND ti.partTrackingId = 1
        WHERE wi.woId = ${Number(m.woId)} ORDER BY p.num`)
      const since = process.env.PROBE_SINCE_MIN || '20'
      const invlog = await s.q(`SELECT il.id, il.typeId, ilt.name AS type, p.num AS partNum, il.changeQty, il.cost, il.info AS lot, il.begLocationId, il.endLocationId,
          il.tableId, il.recordId, il.dateCreated FROM inventorylog il JOIN part p ON p.id = il.partId LEFT JOIN inventorylogtype ilt ON ilt.id = il.typeId
        WHERE p.num LIKE 'SKYTEST-%' AND il.dateCreated >= DATE_SUB(NOW(), INTERVAL ${Number(since)} MINUTE) ORDER BY il.id`)
      const fgLots = await s.q(`SELECT tag.id AS tagId, tag.num AS tagNum, tt.info AS lot, tag.qty, tag.locationId, p.num AS partNum
        FROM tag JOIN part p ON p.id = tag.partId LEFT JOIN trackingtext tt ON tt.tagId = tag.id AND tt.partTrackingId = 1 WHERE p.num = ${sqlStr(BOM_NUMBER)} AND tt.info LIKE 'SBX-%'`)
      const layers = await s.q(`SELECT cl.id, p.num AS partNum, cl.orgQty, cl.orgTotalCost, ROUND(cl.orgTotalCost / NULLIF(cl.orgQty, 0), 4) AS unitCost, cl.qty, cl.totalCost, cl.tableId, cl.recordId, cl.dateCreated
        FROM costlayer cl JOIN part p ON p.id = cl.partId WHERE p.num LIKE 'SKYTEST-%' AND cl.dateCreated >= DATE_SUB(NOW(), INTERVAL ${Number(since)} MINUTE) ORDER BY cl.id`)
      const postwo = await s.q(`SELECT pw.id, pw.statusId, pw.postDate, pwi.woItemId, pwi.postedTotalCost FROM postwo pw LEFT JOIN postwoitem pwi ON pwi.postWoId = pw.id WHERE pw.woId = ${Number(m.woId)}`)
      show({ mo, wo, woItems, consumed, inventorylog: invlog, finishedLots: fgLots, costLayers: layers, postwo })
    } finally { await s.close() }
  },

  // T6b: a legacy request through the REST legacy wrapper, POST /api/legacy/external/<request>. Only GetPickRq and
  // SavePickRq, only for this probe's pick: the body (inline JSON or @file) must name the probe's pick, and every part
  // number in it must start with SKYTEST-. The full answer is saved under logs/ for the results file.
  async legacy(rq, n, ...json) {
    const ALLOWED = ['GetPickRq', 'SavePickRq']
    if (!ALLOWED.includes(rq)) throw new Error(`legacy: only ${ALLOWED.join(', ')}`)
    const m = need(n)
    const text = json.join(' ').trim()
    const body = JSON.parse(text.startsWith('@') ? fs.readFileSync(text.slice(1), 'utf8') : text)
    const flat = JSON.stringify(body)
    if (!flat.includes(m.pickNum) && !flat.includes(`:${m.pickId}`) && !flat.includes(`"${m.pickId}"`)) {
      throw new Error(`legacy: the body does not name this probe's pick (${m.pickNum} / ${m.pickId}) — refusing`)
    }
    const namedParts = [...flat.matchAll(/"(?:Num|Number|PartNum|PartNumber)"\s*:\s*"([^"]+)"/g)].map((x) => x[1]).filter((v) => !v.startsWith('W') && !/^\d+$/.test(v) && !v.startsWith('SBX-'))
    const s = await openSandbox()
    try {
      const parts = await pickPartNums(s, m.pickId)
      if (namedParts.length) assertParts(namedParts, `${rq} body`)
      const r = await s.write('POST', `/api/legacy/external/${rq}`, body, { parts, what: `${rq} on pick ${m.pickNum}` })
      const file = resolve(LOG_DIR, `probe-legacy-${rq}-${n}-${Date.now()}.json`)
      fs.writeFileSync(file, JSON.stringify(redact({ request: body, status: r.status, response: r.body }), null, 2))
      show({ status: r.status, saved: file, response: JSON.stringify(redact(r.body)).slice(0, 2500) })
    } finally { await s.close() }
  },

  // T6b: finish chosen pick lines with chosen lots through the legacy wrapper: GetPickRq for the current pick, then
  // SavePickRq with each named line given its lot's tag, the lot as tracking, and the status (40 Finished, or
  // --status=30 for Committed). Args: PART=LOT ... ; lines not named are sent back unchanged.
  async 'finish-pick'(n, ...args) {
    const m = need(n)
    const status = Number((args.find((a) => a.startsWith('--status=')) || '--status=40').slice(9))
    const wanted = Object.fromEntries(args.filter((a) => a.includes('=') && !a.startsWith('--')).map((a) => a.split('=')))
    if (!Object.keys(wanted).length) throw new Error('usage: finish-pick <n> PART=LOT [PART=LOT ...] [--status=30|40]')
    assertParts(Object.keys(wanted), 'finish-pick arguments')
    const s = await openSandbox()
    try {
      const parts = await pickPartNums(s, m.pickId)
      const g = await s.write('POST', '/api/legacy/external/GetPickRq', { GetPickRq: { PickNum: m.pickNum } }, { parts, what: `GetPickRq ${m.pickNum}` })
      const pick = g.body?.FbiJson?.FbiMsgsRs?.GetPickRs?.Pick
      if (!pick) throw new Error(`GetPickRq gave no pick: ${JSON.stringify(redact(g.body)).slice(0, 400)}`)
      const items = [].concat(pick.PickItems?.PickItem || [])
      assertParts(items.map((it) => it.Part?.Num), `pick ${m.pickNum} lines`)
      const chosen = []
      for (const it of items) {
        const lot = wanted[it.Part?.Num]
        if (!lot) continue
        const tag = (await s.q(`SELECT tag.id, tag.num, tag.qty, tag.qtyCommitted, tag.locationId FROM tag JOIN part p ON p.id = tag.partId
          JOIN trackingtext tt ON tt.tagId = tag.id AND tt.partTrackingId = 1 WHERE p.num = ${sqlStr(it.Part.Num)} AND tt.info = ${sqlStr(lot)} AND tag.qty > 0 ORDER BY tag.id`))[0]
        if (!tag) throw new Error(`no on-hand tag of ${it.Part.Num} lot ${lot}`)
        const trackingItem = { PartTracking: it.Part?.PartTrackingList?.PartTracking, TrackingValue: lot }
        it.Status = status
        it.Tag = { TagID: Number(tag.id), Num: String(tag.num), PartNum: it.Part.Num, Location: it.Location, Quantity: Number(tag.qty),
          QuantityCommitted: Number(tag.qtyCommitted || 0), Tracking: { TrackingItem: trackingItem }, TypeID: 30 }
        it.Tracking = { TrackingItem: trackingItem }
        chosen.push({ part: it.Part.Num, lot, tagId: Number(tag.id), tagNum: String(tag.num) })
      }
      if (chosen.length !== Object.keys(wanted).length) throw new Error(`not every named part is a line of ${m.pickNum}: ${JSON.stringify(chosen)}`)
      const body = { SavePickRq: { Pick: pick } }
      const r = await s.write('POST', '/api/legacy/external/SavePickRq', body, { parts: chosen.map((c) => c.part), what: `SavePickRq ${m.pickNum} (${status})` })
      const file = resolve(LOG_DIR, `probe-legacy-SavePickRq-${n}-${Date.now()}.json`)
      fs.writeFileSync(file, JSON.stringify(redact({ chosen, request: body, status: r.status, response: r.body }), null, 2))
      const rs = r.body?.FbiJson?.FbiMsgsRs
      show({ chosen, httpStatus: r.status, fbiStatus: rs?.statusCode, savePickRs: rs?.SavePickRs ? { statusCode: rs.SavePickRs.statusCode, statusMessage: rs.SavePickRs.statusMessage } : JSON.stringify(redact(r.body)).slice(0, 600), saved: file })
      show({ pickItemRows: await pickRows(s, m.pickId) })
    } finally { await s.close() }
  },

  // T8: route B — no MO. Add 1 of the assembly in lot SBX-B-0001 at an explicit unit cost (Receiving), then remove 1 of
  // each component from a named lot (scrap, Stock). Then every posting, inventory-log and cost-layer row it created.
  async 'route-b'(unitCost = '1.25') {
    const NAMED = { 'SKYTEST-STUD': '100452', 'SKYTEST-SPRING': '100746', 'SKYTEST-CUP': '100583', 'SKYTEST-PIN': '58663' }
    const s = await openSandbox()
    try {
      const before = { post: (await s.q('SELECT MAX(id) AS m FROM post'))[0].m, invlog: (await s.q('SELECT MAX(id) AS m FROM inventorylog'))[0].m, layer: (await s.q('SELECT MAX(id) AS m FROM costlayer'))[0].m }
      const ids = Object.fromEntries((await s.q(`SELECT id, num FROM part WHERE num IN (${[BOM_NUMBER, ...Object.keys(NAMED)].map(sqlStr).join(',')})`)).map((r) => [r.num, Number(r.id)]))
      const calls = []
      const addBody = { location: { id: 3 }, quantity: '1', uom: { id: 1 }, unitCost: String(unitCost), note: 'SBX probe route B (S17 D2) - sandbox only',
        trackingItems: [{ partTracking: { id: 1 }, value: 'SBX-B-0001' }] }
      const a = await s.write('POST', `/api/parts/${ids[BOM_NUMBER]}/inventory/add`, addBody, { parts: [BOM_NUMBER], what: 'route B add' })
      calls.push({ call: `POST /api/parts/${ids[BOM_NUMBER]}/inventory/add`, part: BOM_NUMBER, body: addBody, status: a.status, response: a.body })
      for (const [part, lot] of Object.entries(NAMED)) {
        const body = { location: { id: 1 }, quantity: '1', uom: { id: 1 }, note: 'SBX probe route B (S17 D2) - sandbox only', trackingItems: [{ partTracking: { id: 1 }, value: lot }] }
        const r = await s.write('POST', `/api/parts/${ids[part]}/inventory/scrap`, body, { parts: [part], what: `route B scrap ${part} lot ${lot}` })
        calls.push({ call: `POST /api/parts/${ids[part]}/inventory/scrap`, part, body, status: r.status, response: r.body })
      }
      const posts = await s.q(`SELECT po.id, pt.name AS type, po.amount, po.quantity, po.postedTotalCost, po.orderTypeId, po.orderId, po.refId, po.refItemId, po.refNumber, po.statusId, po.dateCreated
        FROM post po LEFT JOIN posttype pt ON pt.id = po.typeId WHERE po.id > ${Number(before.post)} ORDER BY po.id`)
      const invlog = await s.q(`SELECT il.id, ilt.name AS type, p.num AS partNum, il.changeQty, il.cost, il.info, il.begLocationId, il.endLocationId, il.tableId, il.recordId
        FROM inventorylog il JOIN part p ON p.id = il.partId LEFT JOIN inventorylogtype ilt ON ilt.id = il.typeId WHERE il.id > ${Number(before.invlog)} ORDER BY il.id`)
      const layers = await s.q(`SELECT cl.id, p.num AS partNum, cl.orgQty, cl.orgTotalCost, cl.qty, cl.totalCost, cl.tableId, cl.recordId, cl.statusId
        FROM costlayer cl JOIN part p ON p.id = cl.partId WHERE cl.id > ${Number(before.layer)} OR (p.num LIKE 'SKYTEST-%' AND cl.dateLastModified >= DATE_SUB(NOW(), INTERVAL 3 MINUTE)) ORDER BY cl.id`)
      const tag = await s.q(`SELECT tag.id, tag.num, tag.qty, tag.locationId FROM tag JOIN trackingtext tt ON tt.tagId = tag.id AND tt.partTrackingId = 1 WHERE tt.info = 'SBX-B-0001'`)
      show({ before, calls: calls.map((c) => ({ call: c.call, part: c.part, status: c.status, response: c.status >= 300 ? c.response : (typeof c.response === 'object' ? JSON.stringify(c.response).slice(0, 300) : c.response) })), posts, invlog, layers, newTag: tag })
    } finally { await s.close() }
  },

  // Route discovery: GET only, signed in, each path's status and the start of its answer.
  async routes(...paths) {
    const s = await openSandbox()
    try {
      for (const p of paths) {
        if (!p.startsWith('/api/')) { show(`skip ${p} (not /api/)`); continue }
        const r = await s.read(p)
        show(`GET ${p} -> ${r.status} ${typeof r.body === 'string' ? r.body.replace(/\s+/g, ' ').slice(0, 220) : JSON.stringify(r.body).slice(0, 300)}`)
      }
    } finally { await s.close() }
  },

  // Read-only diagnostics: one SELECT, nothing else.
  async sql(...words) {
    const text = words.join(' ').trim()
    if (!/^select\s/i.test(text) || /;\s*\S/.test(text) || /\b(insert|update|delete|replace|alter|drop|create|truncate|grant|call|into\s+outfile)\b/i.test(text)) {
      throw new Error('sql: one SELECT only')
    }
    const s = await openSandbox()
    try { show(await s.q(text)) } finally { await s.close() }
  },

  // T0: the docs the server carries (no login needed), saved under logs/probe-sandbox-apidocs/.
  async docs() {
    const t = sandboxTarget()
    fs.mkdirSync(DOCS_DIR, { recursive: true })
    const get = (path) => new Promise((res, rej) => {
      const req = http.request({ host: t.host, port: t.port, path, method: 'GET', timeout: 30000 }, (r) => {
        const chunks = []
        r.on('data', (c) => chunks.push(c))
        r.on('end', () => res({ status: r.statusCode, type: r.headers['content-type'] || '', body: Buffer.concat(chunks).toString('utf8'), location: r.headers.location }))
      })
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', rej)
      req.end()
    })
    const seen = new Set()
    const queue = [process.argv[3] || '/apidocs']
    while (queue.length && seen.size < 60) {
      const path = queue.shift()
      if (seen.has(path)) continue
      seen.add(path)
      const r = await get(path)
      const file = resolve(DOCS_DIR, (path.replace(/^\//, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'root') + (/\.html?$/.test(path) ? '' : '.html'))
      fs.writeFileSync(file, r.body)
      show(`${r.status} ${path} (${r.body.length} bytes, ${r.type})${r.location ? ` -> ${r.location}` : ''}`)
      if (r.location && !seen.has(r.location)) queue.push(r.location.replace(/^https?:\/\/[^/]+/, ''))
      if (!/html/.test(r.type)) continue
      const base = path.endsWith('/') ? path : path.replace(/[^/]*$/, '')
      for (const mm of r.body.matchAll(/href="([^"#?]+)(?:[#?][^"]*)?"/g)) {
        const href = mm[1]
        if (/^(https?:|mailto:|javascript:)/.test(href) || /\.(css|js|png|svg|ico|woff2?)$/.test(href)) continue
        const next = href.startsWith('/') ? href : base + href
        if (next.startsWith('/apidocs') && !seen.has(next)) queue.push(next)
      }
    }
  },
}

const name = process.argv[2]
if (!name || !steps[name]) {
  console.error(`usage: FB_SANDBOX_URL=http://host:2456 node scripts/probe-sandbox-fulfill.mjs <${Object.keys(steps).join('|')}> [args]`)
  process.exit(2)
}
try {
  sandboxTarget() // fences 1 and 2, before anything touches the network
  await steps[name](...process.argv.slice(3))
} catch (e) {
  console.error(`probe-sandbox-fulfill: ${e.message}`)
  process.exitCode = 1
}
