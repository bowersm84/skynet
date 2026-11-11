// mo.mjs — bridge 1.12 (S17 D1, D-ASM-52…55): the three manufacture-order commands SkyNet queues for assembly
// builds. Each one reads Fishbowl first and writes only through Fishbowl.call(), the request bodies being the ones
// probed on the live Fishbowl on 2026-11-11 (Docs/Fishbowl_Data_Context.md, "Manufacture orders through the REST API").
//
//   mo_create       find the BOM (must exist and be active), reuse an MO that already has the number (created:false),
//                   otherwise create it; issue it when payload.issue is true and it is still Entered.
//   mo_cancel       find the MO by id or number; refuse if anything is fulfilled; unissue if Issued; delete. An MO
//                   that no longer exists counts as deleted.
//   mo_close_short  close an Issued or Partial MO short by id.
//
// The fence (D-ASM-52, the bridge half; the SQL half is _assembly_mo_wanted): FB_WRITE_PART_PREFIX must be set, the
// command must carry the same prefix, the BOM number must start with it, and so must every part on the BOM or the MO.
// A refusal (MoRefusal) writes nothing. Fishbowl answering a write in a way the probe did not (MoUnexpected) also
// stops every later MO command until the bridge is restarted: hard rule 4, never retry blind.

export const MO_KINDS = new Set(['mo_create', 'mo_cancel', 'mo_close_short'])
export const MO_NUMBER_MAX = 25 // mo.num is varchar(25); the API silently cuts a longer number (probe, 2026-11-11)
const NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9 ._\-/#]*$/ // what the bridge will put in a SQL literal or a URL
const STATUS = { 10: 'Entered', 20: 'Issued', 50: 'Partial', 60: 'Fulfilled', 70: 'Closed Short', 80: 'Void' }
const statusName = (id) => STATUS[Number(id)] || `status ${id}`
const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`
const ok2xx = (s) => s >= 200 && s < 300
const message = (body) => (body && typeof body === 'object' ? body.message || JSON.stringify(body) : String(body ?? '')).slice(0, 300)

export class MoRefusal extends Error {
  constructor(msg) { super(msg); this.name = 'MoRefusal'; this.plain = true }
}
export class MoUnexpected extends Error {
  constructor(msg) { super(msg); this.name = 'MoUnexpected'; this.plain = true; this.halt = true }
}
const refuse = (msg) => new MoRefusal(msg)
const unexpected = (msg) => new MoUnexpected(`Fishbowl did something unexpected: ${msg}. MO writes are stopped on this bridge until it is restarted.`)

// The fence's command half: prefix set, the command's prefix equal to it, the BOM number starting with it.
// Returns null when allowed, otherwise the reason.
export function moFenceRefusal(payload, bomNumber, cfg) {
  const prefix = String(cfg.mo?.writePartPrefix ?? '').trim()
  if (!prefix) return 'FB_WRITE_PART_PREFIX is not set on this bridge'
  if (payload?.write_part_prefix !== prefix) return `payload write_part_prefix ${JSON.stringify(payload?.write_part_prefix ?? null)} is not this bridge's ${JSON.stringify(prefix)}`
  if (typeof bomNumber !== 'string' || !bomNumber.startsWith(prefix)) return `BOM ${JSON.stringify(bomNumber ?? null)} does not start with ${JSON.stringify(prefix)}`
  return null
}

// The fence's Fishbowl half: every part on the BOM / MO starts with the prefix.
function partsRefusal(partNums, cfg, what) {
  const prefix = String(cfg.mo?.writePartPrefix ?? '').trim()
  const off = [...new Set(partNums.filter((n) => typeof n !== 'string' || !n.startsWith(prefix)))]
  return off.length ? `${what} has part(s) outside ${JSON.stringify(prefix)}: ${off.slice(0, 5).join(', ')}` : null
}

function checkNumber(label, v, max = null) {
  if (typeof v !== 'string' || v.trim() === '') throw refuse(`${label} is missing`)
  if (max !== null && v.length > max) throw refuse(`${label} ${JSON.stringify(v)} is longer than ${max} characters (Fishbowl would cut it short)`)
  if (!NUMBER_RE.test(v)) throw refuse(`${label} ${JSON.stringify(v)} has characters the bridge will not send`)
}

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true'

// --- reads ------------------------------------------------------------------------------------------------
async function findBom(fb, num) {
  const rows = await fb.query(`SELECT id, num, activeFlag FROM bom WHERE num = ${sqlStr(num)}`)
  return rows.length ? { id: Number(rows[0].id), num: rows[0].num, active: truthy(rows[0].activeFlag) } : null
}

async function bomPartNums(fb, bomId) {
  const rows = await fb.query(`SELECT part.num AS partNum FROM bomitem bi JOIN part ON part.id = bi.partId WHERE bi.bomId = ${Number(bomId)}`)
  return rows.map((r) => r.partNum)
}

async function findMo(fb, { id = null, num = null }) {
  const where = id !== null && id !== undefined && id !== '' ? `mo.id = ${Number(id)}` : `mo.num = ${sqlStr(num)}`
  const rows = await fb.query(`SELECT mo.id, mo.num, mo.statusId FROM mo WHERE ${where}`)
  return rows.length ? { id: Number(rows[0].id), num: rows[0].num, statusId: Number(rows[0].statusId) } : null
}

async function moItems(fb, moId) {
  const rows = await fb.query(`SELECT mi.typeId, mi.qtyFulfilled, bom.num AS bomNum, part.num AS partNum
    FROM moitem mi LEFT JOIN bom ON bom.id = mi.bomId LEFT JOIN part ON part.id = mi.partId WHERE mi.moId = ${Number(moId)}`)
  return rows.map((r) => ({ typeId: Number(r.typeId), qtyFulfilled: Number(r.qtyFulfilled) || 0, bomNum: r.bomNum ?? null, partNum: r.partNum ?? null }))
}

// The MO's BOM (its configuration row, typeId 50) and parts, through the full fence.
async function fenceExistingMo(fb, mo, payload, cfg) {
  const items = await moItems(fb, mo.id)
  const bomNum = items.find((i) => i.typeId === 50)?.bomNum ?? items.find((i) => i.bomNum)?.bomNum ?? null
  const why = moFenceRefusal(payload, bomNum, cfg) || partsRefusal(items.filter((i) => i.typeId !== 50).map((i) => i.partNum), cfg, `MO ${mo.num}`)
  if (why) throw refuse(why)
  return { items, bomNum }
}

// --- writes -----------------------------------------------------------------------------------------------
function writer(fb, log, cmdId, writes) {
  return async (method, path, body, expect) => {
    const r = await fb.call(method, path, body)
    writes.push({ call: `${method} ${path}`, status: r.status, id: r.body?.id ?? null, number: r.body?.number ?? null, moStatus: r.body?.status ?? null })
    log.info(`push #${cmdId} ${method} ${path} -> ${r.status}${r.body?.id ? ` · MO id ${r.body.id}` : ''}${r.body?.number ? ` ${r.body.number}` : ''}${r.body?.status && typeof r.body.status === 'string' ? ` · ${r.body.status}` : ''}`)
    if (!ok2xx(r.status)) throw unexpected(`${method} ${path} answered ${r.status}: ${message(r.body)}`)
    if (expect) {
      const bad = expect(r.body)
      if (bad) throw unexpected(`${method} ${path}: ${bad}`)
    }
    return r.body
  }
}

async function moCreate(fb, cmd, { cfg, log, dryRun }) {
  const p = cmd.payload || {}
  checkNumber('MO number', p.mo_number, MO_NUMBER_MAX)
  checkNumber('BOM number', p.bom_number)
  const qty = Number(p.quantity)
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) throw refuse(`quantity ${JSON.stringify(p.quantity)} is not a whole number above 0`)
  const fence = moFenceRefusal(p, p.bom_number, cfg)
  if (fence) throw refuse(fence)
  const bom = await findBom(fb, p.bom_number)
  if (!bom) throw refuse(`BOM ${p.bom_number} is not in Fishbowl`)
  if (!bom.active) throw refuse(`BOM ${p.bom_number} is not active in Fishbowl`)
  const parts = await bomPartNums(fb, bom.id)
  if (parts.length === 0) throw refuse(`BOM ${p.bom_number} has no items`)
  const off = partsRefusal(parts, cfg, `BOM ${p.bom_number}`)
  if (off) throw refuse(off)

  const writes = []
  const write = writer(fb, log, cmd.id, writes)
  let mo = await findMo(fb, { num: p.mo_number })
  let created = false
  const would = []
  if (mo) {
    const { bomNum } = await fenceExistingMo(fb, mo, p, cfg)
    if (bomNum !== p.bom_number) throw refuse(`MO ${p.mo_number} already exists in Fishbowl on BOM ${bomNum ?? 'unknown'}, not ${p.bom_number}`)
    if (![10, 20, 50].includes(mo.statusId)) throw refuse(`MO ${p.mo_number} already exists in Fishbowl and is ${statusName(mo.statusId)}`)
    log.info(`push #${cmd.id} mo_create: MO ${p.mo_number} already exists (id ${mo.id}, ${statusName(mo.statusId)}) — reused, not created again`)
  } else {
    const body = {
      number: p.mo_number,
      locationGroup: { id: cfg.mo?.locationGroupId ?? 1 },
      ...(typeof p.note === 'string' && p.note.trim() ? { note: p.note.trim().slice(0, 250) } : {}),
      configurations: [{ bom: { id: bom.id }, quantity: String(qty) }],
    }
    if (dryRun) {
      would.push({ call: 'POST /api/manufacture-orders', body })
      log.info(`push #${cmd.id} mo_create: DRY RUN — would POST /api/manufacture-orders ${JSON.stringify(body)}`)
    } else {
      const res = await write('POST', '/api/manufacture-orders', body,
        (b) => (!b?.id ? 'no MO id in the answer' : b.number !== p.mo_number ? `the MO came back as ${JSON.stringify(b.number)} (id ${b.id}), not ${p.mo_number}` : null))
      mo = { id: Number(res.id), num: res.number, statusId: 10 }
      created = true
    }
  }
  if (p.issue === true && (mo === null || mo.statusId === 10)) {
    if (dryRun || mo === null) {
      would.push({ call: `POST /api/manufacture-orders/${mo?.id ?? '<new id>'}/issue` })
      if (dryRun) log.info(`push #${cmd.id} mo_create: DRY RUN — would issue`)
    } else {
      await write('POST', `/api/manufacture-orders/${mo.id}/issue`, undefined, (b) => (b?.status !== 'Issued' ? `issue left the MO ${JSON.stringify(b?.status)}` : null))
      mo.statusId = 20
    }
  }
  return {
    fb_mo_id: mo ? mo.id : null,
    mo_number: mo ? mo.num : p.mo_number,
    status: mo ? statusName(mo.statusId) : 'not created (dry run)',
    created,
    bom_id: bom.id,
    writes,
    ...(dryRun ? { would } : {}),
  }
}

async function moCancel(fb, cmd, { cfg, log, dryRun }) {
  const p = cmd.payload || {}
  if (p.mo_number !== null && p.mo_number !== undefined) checkNumber('MO number', p.mo_number, MO_NUMBER_MAX)
  const hasId = p.fb_mo_id !== null && p.fb_mo_id !== undefined && p.fb_mo_id !== ''
  if (!hasId && !p.mo_number) throw refuse('mo_cancel needs fb_mo_id or mo_number')
  const prefix = String(cfg.mo?.writePartPrefix ?? '').trim()
  if (!prefix || p.write_part_prefix !== prefix) throw refuse(moFenceRefusal(p, prefix, cfg) || 'prefix mismatch')
  const mo = await findMo(fb, hasId ? { id: p.fb_mo_id } : { num: p.mo_number })
  if (!mo) {
    log.info(`push #${cmd.id} mo_cancel: MO ${p.mo_number ?? p.fb_mo_id} is not in Fishbowl — counted as deleted`)
    return { deleted: true, existed: false, fb_mo_id: hasId ? Number(p.fb_mo_id) : null, mo_number: p.mo_number ?? null, writes: [] }
  }
  if (hasId && p.mo_number && mo.num !== p.mo_number) throw refuse(`Fishbowl MO id ${mo.id} is ${mo.num}, not ${p.mo_number}`)
  const { items } = await fenceExistingMo(fb, mo, p, cfg)
  if (items.some((i) => i.qtyFulfilled > 0) || [50, 60, 70].includes(mo.statusId)) {
    throw refuse(`MO ${mo.num} has fulfilled quantity (${statusName(mo.statusId)}) — not unissued or deleted; close it short or handle it in Fishbowl`)
  }
  if (![10, 20].includes(mo.statusId)) throw refuse(`MO ${mo.num} is ${statusName(mo.statusId)} — not deleted`)
  const writes = []
  const would = []
  if (dryRun) {
    if (mo.statusId === 20) would.push({ call: `POST /api/manufacture-orders/${mo.id}/unissue` })
    would.push({ call: `DELETE /api/manufacture-orders/${mo.id}` })
    log.info(`push #${cmd.id} mo_cancel: DRY RUN — would ${would.map((w) => w.call).join(', then ')}`)
    return { deleted: false, existed: true, fb_mo_id: mo.id, mo_number: mo.num, status: statusName(mo.statusId), writes, would }
  }
  const write = writer(fb, log, cmd.id, writes)
  if (mo.statusId === 20) await write('POST', `/api/manufacture-orders/${mo.id}/unissue`, undefined, (b) => (b?.status !== 'Entered' ? `unissue left the MO ${JSON.stringify(b?.status)}` : null))
  await write('DELETE', `/api/manufacture-orders/${mo.id}`)
  const gone = await fb.call('GET', `/api/manufacture-orders/${mo.id}`)
  if (gone.status !== 404) throw unexpected(`MO ${mo.num} (id ${mo.id}) still answers ${gone.status} after the delete`)
  return { deleted: true, existed: true, fb_mo_id: mo.id, mo_number: mo.num, writes }
}

async function moCloseShort(fb, cmd, { cfg, log, dryRun }) {
  const p = cmd.payload || {}
  if (p.mo_number !== null && p.mo_number !== undefined) checkNumber('MO number', p.mo_number, MO_NUMBER_MAX)
  const hasId = p.fb_mo_id !== null && p.fb_mo_id !== undefined && p.fb_mo_id !== ''
  if (!hasId) throw refuse('mo_close_short needs fb_mo_id')
  const mo = await findMo(fb, { id: p.fb_mo_id })
  if (!mo) throw refuse(`MO id ${p.fb_mo_id} is not in Fishbowl`)
  if (p.mo_number && mo.num !== p.mo_number) throw refuse(`Fishbowl MO id ${mo.id} is ${mo.num}, not ${p.mo_number}`)
  await fenceExistingMo(fb, mo, p, cfg)
  if (mo.statusId === 70) return { closed: true, already: true, fb_mo_id: mo.id, mo_number: mo.num, status: 'Closed Short', writes: [] }
  if (![20, 50].includes(mo.statusId)) throw refuse(`MO ${mo.num} is ${statusName(mo.statusId)}; only an Issued or Partial MO is closed short`)
  if (dryRun) {
    log.info(`push #${cmd.id} mo_close_short: DRY RUN — would POST /api/manufacture-orders/${mo.id}/close-short`)
    return { closed: false, fb_mo_id: mo.id, mo_number: mo.num, status: statusName(mo.statusId), writes: [], would: [{ call: `POST /api/manufacture-orders/${mo.id}/close-short` }] }
  }
  const writes = []
  const write = writer(fb, log, cmd.id, writes)
  const b = await write('POST', `/api/manufacture-orders/${mo.id}/close-short`, undefined, (r) => (r?.status !== 'Closed Short' ? `close-short left the MO ${JSON.stringify(r?.status)}` : null))
  return { closed: true, fb_mo_id: mo.id, mo_number: mo.num, status: b.status, writes }
}

const HANDLERS = { mo_create: moCreate, mo_cancel: moCancel, mo_close_short: moCloseShort }

// Runs one claimed MO command. Returns the result for fb_push_finish; throws MoRefusal / MoUnexpected / any read
// error, which the caller records on the command.
export async function runMoCommand(fb, cmd, ctx) {
  const handler = Object.hasOwn(HANDLERS, cmd.kind) ? HANDLERS[cmd.kind] : null
  if (!handler) throw refuse(`no MO handler for kind ${cmd.kind}`)
  return handler(fb, cmd, ctx)
}
