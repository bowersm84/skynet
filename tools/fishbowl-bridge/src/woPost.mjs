// woPost.mjs — bridge 1.13 (S17 D2a, D-ASM-61): the bridge posts a released assembly build to Fishbowl.
//
// One command, kind wo_post, queued by SkyNet at release (migration 2026-11-24_S17_D2a_auto_post.sql). The handler
// finishes the work order's pick lines on the lots the tablet recorded, then fulfills the work order with the good
// count as produced, the bad count as scrapped, the SkyNet finished lot and the destination. It sends only the
// request bodies probes 1 and 2 proved on Fishbowl 26.11 (D-ASM-59, D-ASM-60; Docs/probes/2026-11-24_*):
//
//   POST /api/picks/:id/start                    only while the pick is Entered (probe 1 started it first)
//   POST /api/legacy/external/GetPickRq          { "GetPickRq": { "PickNum": … } }
//   POST /api/legacy/external/SavePickRq         the pick back, each line to finish as probe 1's finish-pick set it
//   GET  /api/work-orders/:id                    the finished-good item id
//   POST /api/work-orders/:id/fulfill            finishedGoods only — rawGoods is never sent (D-ASM-59)
//
// Rules (D2a prompt §3): every check that can refuse runs before the first write, so a refusal (MoRefusal) writes
// nothing. The handler works from the state it reads in Fishbowl and never repeats a step because it failed: a pick
// already finished on the right lots is only fulfilled (resumed), an MO already fulfilled with the finished lot on
// hand is reported as done (already). Anything Fishbowl answers that the probes did not see is MoUnexpected, which
// stops MO and work-order writes on the bridge until it is restarted (push.mjs). One known gap is a refusal instead
// (D-ASM-62): a lot in another location than the one Fishbowl sources the pick line from — refused before any write
// when the line's source is already set, otherwise right after GetPickRq (the pick started, nothing else written). GET /api/picks/:id is never called:
// it can change the pick (D-ASM-59); picks are read by SQL and fetched for saving with GetPickRq only. Every SQL
// statement is in queries.mjs.
import { q } from './queries.mjs'
import { MoRefusal, MoUnexpected, MO_NUMBER_MAX, checkNumber, findMo, fenceExistingMo, moFenceRefusal, statusName, writer } from './mo.mjs'
import { versionAtLeast } from './fbVersion.mjs'

export const WO_POST_KIND = 'wo_post'

// Status ids as the probes read them on 26.11 (mostatus, wostatus, pickstatus, pickitemstatus).
const MO_ISSUED = 20
const MO_FULFILLED = 60
const WO_FULFILLED = 40
const PICK_STATUS = { 10: 'Entered', 20: 'Started', 40: 'Finished' } // 30 Committed: never seen by the probes
const LINE_STATUS = { 10: 'Entered', 20: 'Started', 40: 'Finished' } // 5 Short, 6 Hold, 11 EnteredNew, 30 Committed: never seen
const ENTERED = 10
const STARTED = 20
const FINISHED = 40
const WO_ORDER_TYPE = 30 // pickitem.orderTypeId of a work-order line
const LOT_TRACKING = 1 // part tracking id 1 = Lot Number
const OBJECT_TAG = 30 // Tag.TypeID in probe 1's SavePickRq
const LEGACY = '/api/legacy/external'

const refuse = (msg) => new MoRefusal(msg)
const unexpected = (msg) => new MoUnexpected(`Fishbowl did something unexpected: ${msg}. MO and work-order writes are stopped on this bridge until it is restarted.`)
// After the fulfill went through: a person must check it, and nobody may post it again.
const postedButDiffers = (moNum, what) => new MoUnexpected(
  `The post went through in Fishbowl (MO ${moNum} was fulfilled), but what Fishbowl shows afterwards differs: ${what}. ` +
  'Check the MO in Fishbowl before anything else; do not post this build again. MO and work-order writes are stopped on this bridge until it is restarted.')

// D-ASM-62: the lot the tablet recorded is in another location than the one Fishbowl sources the pick line from.
// Not a halt — a case the probes never covered, found by reading before the pick save — so the build is a hand post.
// mismatches: [{ l: the line, tag: where the lot is, srcId / srcName: where Fishbowl sources the line }].
function locationRefusal(mismatches, { started }) {
  const where = (name, id) => `${name || 'location'} (location ${id})`
  const what = mismatches.map(({ l, tag, srcId, srcName }) =>
    `${l.part} lot ${l.lot} is in ${where(tag.locationName, tag.locationId)}, but Fishbowl ${started ? 'sourced' : 'sources'} the pick line from ${where(srcName, srcId)}`).join('; ')
  return refuse(started
    ? `${what}. The pick was started and nothing else was written; post this build by hand`
    : `${what}. Nothing was written; post this build by hand`)
}

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true'
// A whole number from a payload value (a number, or a string of digits). Anything else -> null.
const whole = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
  return null
}
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''
const lineStatusName = (id) => LINE_STATUS[Number(id)] || `status ${id}`

// ── A. The payload, checked with no I/O ─────────────────────────────────────────────────────────────────────
export function checkPayload(payload) {
  const p = payload || {}
  checkNumber('MO number', p.mo_number, MO_NUMBER_MAX)
  const moId = whole(p.fb_mo_id)
  if (moId === null || moId <= 0) throw refuse(`fb_mo_id ${JSON.stringify(p.fb_mo_id ?? null)} is not a whole number above 0`)
  if (!nonEmpty(p.part_number)) throw refuse('part_number is missing')
  const produced = whole(p.produced)
  if (produced === null || produced < 1) throw refuse(`produced ${JSON.stringify(p.produced ?? null)} is not a whole number of 1 or more`)
  const scrapped = whole(p.scrapped)
  if (scrapped === null || scrapped < 0) throw refuse(`scrapped ${JSON.stringify(p.scrapped ?? null)} is not a whole number of 0 or more`)
  const quantity = whole(p.quantity)
  if (quantity === null || quantity !== produced + scrapped) {
    throw refuse(`quantity ${JSON.stringify(p.quantity ?? null)} is not produced + scrapped (${produced} + ${scrapped}); a short build is posted by hand`)
  }
  if (!nonEmpty(p.finished_lot)) throw refuse('finished_lot is missing')
  checkNumber('Finished lot', p.finished_lot)
  const destId = whole(p.destination_location_id)
  if (destId === null || destId <= 0) throw refuse(`destination_location_id ${JSON.stringify(p.destination_location_id ?? null)} is not a whole number above 0`)
  if (!Array.isArray(p.lots) || p.lots.length === 0) throw refuse('lots is empty')
  const lots = new Map()
  for (const l of p.lots) {
    if (!l || !nonEmpty(l.part) || !nonEmpty(l.lot)) throw refuse(`lots has an entry without a part and a lot: ${JSON.stringify(l ?? null).slice(0, 120)}`)
    if (lots.has(l.part)) throw refuse(`lots names ${l.part} twice; a build with split lots is posted by hand`)
    lots.set(l.part, l.lot)
  }
  return {
    raw: p, moNumber: p.mo_number, moId, partNumber: p.part_number, quantity, produced, scrapped,
    finishedLot: p.finished_lot, destId, lots, minVersion: p.min_version ?? null,
  }
}

// ── B. Fence and version ────────────────────────────────────────────────────────────────────────────────────
export function fenceAndVersion(p, cfg, fishbowlVersion) {
  const why = moFenceRefusal(p.raw, p.partNumber, cfg)
  if (why) throw refuse(why)
  const min = cfg.mo?.postMinVersion || '26.11'
  if (!fishbowlVersion) throw refuse(`the Fishbowl server version is not known on this bridge; automatic posting needs ${min} or later`)
  if (!versionAtLeast(fishbowlVersion, min)) throw refuse(`Fishbowl is version ${fishbowlVersion}; automatic posting needs ${min} or later (FB_WO_POST_MIN_VERSION)`)
  if (p.minVersion !== null && p.minVersion !== undefined && p.minVersion !== '' && !versionAtLeast(fishbowlVersion, p.minVersion)) {
    throw refuse(`Fishbowl is version ${fishbowlVersion}; SkyNet asks for ${p.minVersion} or later (fb_auto_post_min_version)`)
  }
}

// ── C. Read Fishbowl (SQL only) and plan ────────────────────────────────────────────────────────────────────
async function finishedLotTags(fb, p) {
  return fb.query(q.woPostFinishedLotTags(p.partNumber, p.finishedLot))
}

export async function planPost(fb, p, cfg) {
  // 1. The MO, by id, through the full fence; its BOM and finished good are the build's part.
  const mo = await findMo(fb, { id: p.moId })
  if (!mo) throw refuse(`MO id ${p.moId} is not in Fishbowl`)
  if (mo.num !== p.moNumber) throw refuse(`Fishbowl MO id ${mo.id} is ${mo.num}, not ${p.moNumber}`)
  const { items, bomNum } = await fenceExistingMo(fb, mo, p.raw, cfg)
  if (bomNum !== p.partNumber) throw refuse(`MO ${mo.num} is on BOM ${bomNum ?? 'unknown'}, not ${p.partNumber}`)
  const fgItems = items.filter((i) => i.typeId === 10)
  if (fgItems.length !== 1 || fgItems[0].partNum !== p.partNumber) {
    throw refuse(`MO ${mo.num} has finished good ${fgItems.map((i) => i.partNum).join(', ') || 'none'}, not ${p.partNumber}`)
  }

  // 2. Already fulfilled: done if the finished lot is on hand, otherwise a person looks.
  const lotOnHand = await finishedLotTags(fb, p)
  if (mo.statusId === MO_FULFILLED) {
    if (lotOnHand.length > 0) return { already: true, mo, lotOnHand }
    throw refuse(`MO ${mo.num} is already fulfilled in Fishbowl, but finished lot ${p.finishedLot} of ${p.partNumber} is not on hand — check the MO in Fishbowl`)
  }
  // 3. Otherwise it must be Issued.
  if (mo.statusId !== MO_ISSUED) throw refuse(`MO ${mo.num} is ${statusName(mo.statusId)}; only an Issued MO is posted automatically`)
  const moRow = (await fb.query(q.woPostMo(mo.id)))[0]
  const locationGroupId = Number(moRow?.locationGroupId)
  if (!Number.isFinite(locationGroupId)) throw refuse(`MO ${mo.num} has no location group`)

  // 4. Exactly one work order, not fulfilled, for the build quantity.
  const wos = await fb.query(q.woPostWorkOrders(mo.id))
  if (wos.length !== 1) throw refuse(`MO ${mo.num} has ${wos.length} work orders; an automatic post needs exactly one`)
  const wo = { id: Number(wos[0].woId), num: wos[0].woNum, statusId: Number(wos[0].statusId), qtyOrdered: Number(wos[0].qtyOrdered) }
  if (wo.statusId === WO_FULFILLED) throw refuse(`work order ${wo.num} is already fulfilled`)
  if (wo.qtyOrdered !== p.quantity) throw refuse(`work order ${wo.num} is for ${wos[0].qtyOrdered}, not the build's ${p.quantity}`)
  const woItems = await fb.query(q.woPostWoItems(wo.id))
  const fgWoItems = woItems.filter((wi) => Number(wi.typeId) === 10)
  if (fgWoItems.length !== 1 || fgWoItems[0].partNum !== p.partNumber) throw refuse(`work order ${wo.num} does not have exactly one finished-good line of ${p.partNumber}`)
  const fgWoItemId = Number(fgWoItems[0].woItemId)

  // 5. Exactly one pick, one line per part, and its parts exactly the build's lot parts.
  const picks = await fb.query(q.woPostPicks(wo.id))
  if (picks.length !== 1) throw refuse(`work order ${wo.num} has ${picks.length} picks; an automatic post needs exactly one`)
  const pick = { id: Number(picks[0].pickId), num: picks[0].pickNum, statusId: Number(picks[0].statusId) }
  const rows = await fb.query(q.woPostPickLines(pick.id))
  if (rows.length === 0) throw refuse(`pick ${pick.num} has no lines`)
  const seen = new Set()
  for (const r of rows) {
    if (Number(r.orderTypeId) !== WO_ORDER_TYPE) throw refuse(`pick ${pick.num} has a line (${r.pickItemId}) that is not a work-order line`)
    if (seen.has(r.partNum)) throw refuse(`pick ${pick.num} has ${r.partNum} on more than one line; a split line is posted by hand`)
    seen.add(r.partNum)
  }
  const lineParts = [...seen].sort()
  const lotParts = [...p.lots.keys()].sort()
  if (lineParts.join('|') !== lotParts.join('|')) {
    throw refuse(`pick ${pick.num} has lines for ${lineParts.join(', ')}; the build recorded lots for ${lotParts.join(', ')}`)
  }

  // 6. Statuses: only the ones the probes saw. A line already Finished must be on the build's lot (a resumed post).
  if (!PICK_STATUS[pick.statusId]) throw refuse(`pick ${pick.num} is status ${pick.statusId}, which the probes never saw; post it by hand`)
  const lines = rows.map((r) => ({
    pickItemId: Number(r.pickItemId), woItemId: Number(r.woItemId), part: r.partNum, qty: Number(r.qty), statusId: Number(r.statusId),
    srcLocationId: r.srcLocationId === null || r.srcLocationId === undefined ? null : Number(r.srcLocationId),
    srcLocationName: r.srcLocationName ?? null,
    srcTagId: r.srcTagId ?? null, srcTagNum: r.srcTagNum ?? null, lotNow: r.lotNumber ?? null, lot: p.lots.get(r.partNum),
  }))
  for (const l of lines) {
    if (!LINE_STATUS[l.statusId]) throw refuse(`pick line ${l.pickItemId} (${l.part}) is status ${l.statusId}, which the probes never saw; post it by hand`)
    if (!Number.isFinite(l.qty) || l.qty <= 0) throw refuse(`pick line ${l.pickItemId} (${l.part}) has quantity ${l.qty}`)
    if (l.statusId === FINISHED && l.lotNow !== l.lot) {
      throw refuse(`pick line ${l.pickItemId} (${l.part}) is already finished on lot ${l.lotNow ?? 'none'}, not the build's ${l.lot}`)
    }
  }
  if (pick.statusId === ENTERED && lines.some((l) => l.statusId !== ENTERED)) throw refuse(`pick ${pick.num} is Entered but has lines that are not; post it by hand`)
  if (pick.statusId === STARTED && lines.some((l) => l.statusId === ENTERED)) throw refuse(`pick ${pick.num} is Started but has lines still Entered; post it by hand`)
  if (pick.statusId === FINISHED && lines.some((l) => l.statusId !== FINISHED)) throw refuse(`pick ${pick.num} is Finished but has lines that are not; post it by hand`)
  const toFinish = lines.filter((l) => l.statusId !== FINISHED)

  // 7. A tag for each line still to finish: on hand, that part and lot, in the MO's location group, lowest tag id
  //    first, the first whose available quantity covers the line. One tag per line; a line is never split.
  //    Once Fishbowl has set the line's source location (the pick is started), the tag must be in that location: the
  //    pick save sends the line's own Location with the tag, and probe 1 proved it only with the two the same. A lot
  //    that is only in another location is a hand post (D-ASM-62): refused here, before any write. The handler never
  //    changes a line's location to match the tag; that body is not proven.
  const mismatches = []
  for (const l of toFinish) {
    const tags = (await fb.query(q.woPostLotTags(l.part, l.lot)))
      .map((t) => ({ tagId: Number(t.tagId), tagNum: String(t.tagNum), qty: Number(t.qty), qtyCommitted: Number(t.qtyCommitted || 0),
        locationId: Number(t.locationId), locationName: t.locationName ?? null, locationGroupId: Number(t.locationGroupId) }))
      .filter((t) => t.locationGroupId === locationGroupId)
      .sort((a, b) => a.tagId - b.tagId)
    const avail = (t) => t.qty - t.qtyCommitted
    const known = l.srcLocationId !== null
    const tag = tags.find((t) => (!known || t.locationId === l.srcLocationId) && avail(t) >= l.qty)
    if (!tag) {
      const elsewhere = known ? tags.find((t) => t.locationId !== l.srcLocationId && avail(t) >= l.qty) : null
      if (elsewhere) {
        mismatches.push({ l, tag: elsewhere, srcId: l.srcLocationId, srcName: l.srcLocationName })
        continue
      }
      const best = tags.reduce((m, t) => Math.max(m, avail(t)), 0)
      throw refuse(tags.length === 0
        ? `lot ${l.lot} of ${l.part} is not on hand in the MO's location group; the line needs ${l.qty}`
        : `no single tag of ${l.part} lot ${l.lot} covers the line: the largest available is ${best}, the line needs ${l.qty}`)
    }
    l.tag = tag
  }
  if (mismatches.length) throw locationRefusal(mismatches, { started: false })

  // 8. Tracking: the finished good, and every component the pick save names, tracked by lot number only (as on
  //    the probe), so the bodies are the ones the probes proved.
  const partNums = [p.partNumber, ...lineParts]
  const tracking = await fb.query(q.woPostPartTracking(partNums))
  for (const part of partNums) {
    const ids = tracking.filter((t) => t.partNum === part).map((t) => Number(t.partTrackingId))
    if (ids.length !== 1 || ids[0] !== LOT_TRACKING) {
      throw refuse(`${part} is tracked by ${ids.length ? ids.join(', ') : 'nothing'}; an automatic post needs lot number only (tracking id 1)`)
    }
  }

  // 9. The destination exists and is active.
  const dest = (await fb.query(q.woPostLocation(p.destId)))[0]
  if (!dest) throw refuse(`destination location ${p.destId} is not in Fishbowl`)
  if (!truthy(dest.activeFlag)) throw refuse(`destination location ${p.destId} (${dest.name}) is not active`)

  // 10. The finished lot is not on hand already (a lot is received once).
  if (lotOnHand.length > 0) {
    throw refuse(`finished lot ${p.finishedLot} of ${p.partNumber} is already on hand in Fishbowl (tag ${lotOnHand[0].tagNum} at ${lotOnHand[0].locationName ?? lotOnHand[0].locationId}); a lot is received once`)
  }

  return {
    already: false, mo, locationGroupId, wo, fgWoItemId, pick, lines, toFinish,
    needStart: toFinish.length > 0 && pick.statusId === ENTERED,
    destination: { id: Number(dest.id), name: dest.name },
  }
}

// ── E. Writes ───────────────────────────────────────────────────────────────────────────────────────────────
// How each answer is recorded in `writes` (never the body: a legacy answer carries the session Ticket).
function describeAnswer(r) {
  const rs = r.body?.FbiJson?.FbiMsgsRs
  if (rs) {
    const inner = Object.keys(rs).find((k) => /Rs$/.test(k))
    const codes = `${rs.statusCode ?? '?'}/${inner ? rs[inner]?.statusCode ?? '?' : '?'}`
    return { entry: { legacy: inner ?? null, fbiStatus: codes }, note: ` · ${inner ?? 'legacy'} ${codes}` }
  }
  const s = typeof r.body?.status === 'string' ? r.body.status : null
  return { entry: { answer: s, number: typeof r.body?.number === 'string' ? r.body.number : null }, note: `${s ? ` · ${s}` : ''}${r.body?.number ? ` ${r.body.number}` : ''}` }
}

// The legacy wrapper answers HTTP 200 even when it fails, so its status codes are the test.
const legacyOk = (name) => (b) => {
  const rs = b?.FbiJson?.FbiMsgsRs
  if (!rs) return 'no FbiJson.FbiMsgsRs in the answer'
  if (Number(rs.statusCode) !== 1000) return `FbiMsgsRs.statusCode ${rs.statusCode}${rs.statusMessage ? ` (${String(rs.statusMessage).slice(0, 200)})` : ''}`
  const inner = rs[name]
  if (!inner) return `no ${name} in the answer`
  if (Number(inner.statusCode) !== 1000) return `${name}.statusCode ${inner.statusCode}${inner.statusMessage ? ` (${String(inner.statusMessage).slice(0, 200)})` : ''}`
  return null
}

const asList = (v) => (v === undefined || v === null ? [] : [].concat(v))

// The pick GetPickRq returned must be the one step C read, each line where step C left it. Anything else Fishbowl
// answers here is MoUnexpected (the halt). A line Fishbowl sourced from another location than the lot's tag is only
// known once the pick is started: that is a refusal (D-ASM-62), raised after every halt check has passed, with the
// pick started and nothing else written.
function checkLegacyPick(pick, plan) {
  if (!pick) throw unexpected(`GetPickRq returned no pick for ${plan.pick.num}`)
  if (Number(pick.PickID) !== plan.pick.id) throw unexpected(`GetPickRq returned pick ${pick.PickID}, not ${plan.pick.id}`)
  const items = asList(pick.PickItems?.PickItem)
  const want = new Map(plan.lines.map((l) => [l.pickItemId, l]))
  if (items.length !== want.size || items.some((it) => !want.has(Number(it.PickItemID)))) {
    throw unexpected(`GetPickRq returned pick lines ${items.map((it) => it.PickItemID).join(', ')}, not ${[...want.keys()].join(', ')}`)
  }
  const mismatches = []
  for (const it of items) {
    const l = want.get(Number(it.PickItemID))
    if (it.Part?.Num !== l.part) throw unexpected(`GetPickRq line ${it.PickItemID} is ${it.Part?.Num}, not ${l.part}`)
    if (!l.tag) {
      if (Number(it.Status) !== FINISHED) throw unexpected(`GetPickRq line ${it.PickItemID} (${l.part}) is status ${it.Status}, not Finished`)
      continue
    }
    if (Number(it.Status) !== STARTED) throw unexpected(`GetPickRq line ${it.PickItemID} (${l.part}) is status ${it.Status}, not Started`)
    const pt = it.Part?.PartTrackingList?.PartTracking
    if (!pt || Array.isArray(pt) || Number(pt.PartTrackingID) !== LOT_TRACKING) {
      throw unexpected(`GetPickRq line ${it.PickItemID} (${l.part}) does not carry lot tracking alone`)
    }
    if (Number(it.Location?.LocationID) !== l.tag.locationId) {
      mismatches.push({ l, tag: l.tag, srcId: it.Location?.LocationID ?? '?', srcName: it.Location?.Name ?? null })
    }
  }
  if (mismatches.length) throw locationRefusal(mismatches, { started: true })
  return items
}

// Probe 1's finish-pick (probe-sandbox-fulfill.mjs, the SavePickRq body): each line to finish gets Status 40, the
// chosen lot's tag and the lot as tracking; every other line goes back unchanged.
export function pickToSave(pick, plan) {
  const out = JSON.parse(JSON.stringify(pick))
  const byId = new Map(plan.toFinish.map((l) => [l.pickItemId, l]))
  for (const it of asList(out.PickItems?.PickItem)) {
    const l = byId.get(Number(it.PickItemID))
    if (!l) continue
    const trackingItem = { PartTracking: it.Part?.PartTrackingList?.PartTracking, TrackingValue: l.lot }
    it.Status = FINISHED
    it.Tag = { TagID: l.tag.tagId, Num: String(l.tag.tagNum), PartNum: it.Part.Num, Location: it.Location, Quantity: l.tag.qty,
      QuantityCommitted: l.tag.qtyCommitted, Tracking: { TrackingItem: trackingItem }, TypeID: OBJECT_TAG }
    it.Tracking = { TrackingItem: trackingItem }
  }
  return out
}

// The fulfill body, exactly as probe 2 sent it (no rawGoods: the finished pick lines decide what is consumed).
export function fulfillBody(itemId, p) {
  return {
    finishedGoods: [{
      itemId,
      quantityUsed: String(p.produced),
      quantityScrapped: String(p.scrapped),
      destinationLocationId: p.destId,
      tracking: { trackingItems: [{ partTracking: { id: LOT_TRACKING }, value: p.finishedLot }] },
    }],
    splitWorkOrder: false,
  }
}

// Hard rule 3 (D-ASM-59): a fulfill body never carries rawGoods. Checked on the body as it is about to be sent.
export function guardFulfillBody(body) {
  if (body && typeof body === 'object' && Object.hasOwn(body, 'rawGoods')) {
    throw Object.assign(new Error('rule: a work-order fulfill never sends rawGoods (D-ASM-59) — not sent'), { plain: true, halt: true })
  }
  return body
}

function wouldCalls(plan, p) {
  const would = []
  if (plan.toFinish.length > 0) {
    if (plan.needStart) would.push({ call: `POST /api/picks/${plan.pick.id}/start` })
    would.push({ call: `POST ${LEGACY}/GetPickRq`, body: { GetPickRq: { PickNum: plan.pick.num } } })
    would.push({ call: `POST ${LEGACY}/SavePickRq`, lines: plan.toFinish.map((l) => ({ pickItemId: l.pickItemId, part: l.part, qty: l.qty, Status: FINISHED, lot: l.lot, tag_id: l.tag.tagId, tag_num: l.tag.tagNum, location_id: l.tag.locationId })) })
  }
  would.push({ call: `GET /api/work-orders/${plan.wo.id}` })
  would.push({ call: `POST /api/work-orders/${plan.wo.id}/fulfill`, body: fulfillBody(plan.fgWoItemId, p) })
  return would
}

function resultOf(plan, p, { writes, resumed = false, status = null, would = null }) {
  return {
    fb_mo_id: plan.mo.id, mo_number: plan.mo.num,
    wo_id: plan.wo?.id ?? null, wo_number: plan.wo?.num ?? null, pick_id: plan.pick?.id ?? null, pick_number: plan.pick?.num ?? null,
    status: status ?? statusName(plan.mo.statusId),
    produced: p.produced, scrapped: p.scrapped, finished_lot: p.finishedLot,
    destination: plan.destination ?? { id: p.destId, name: null },
    lots: (plan.lines || []).map((l) => (l.tag
      ? { part: l.part, lot: l.lot, tag_id: l.tag.tagId, tag_num: l.tag.tagNum, qty: l.qty }
      : { part: l.part, lot: l.lot, tag_id: l.srcTagId === null ? null : Number(l.srcTagId), tag_num: l.srcTagNum, qty: l.qty })),
    resumed, already: Boolean(plan.already), writes,
    ...(would ? { would } : {}),
  }
}

// Steps E1–E4: finish the pick lines, then read them back. Returns nothing; throws MoUnexpected on any surprise.
async function finishPick(fb, plan, write, log, cmdId) {
  if (plan.toFinish.length === 0) return
  if (plan.needStart) {
    await write('POST', `/api/picks/${plan.pick.id}/start`, undefined, (b) => (b?.status !== 'Started' ? `the start left the pick ${JSON.stringify(b?.status ?? null)}` : null))
  }
  const g = await write('POST', `${LEGACY}/GetPickRq`, { GetPickRq: { PickNum: plan.pick.num } }, legacyOk('GetPickRs'))
  const pick = g.FbiJson.FbiMsgsRs.GetPickRs.Pick
  checkLegacyPick(pick, plan)
  await write('POST', `${LEGACY}/SavePickRq`, { SavePickRq: { Pick: pickToSave(pick, plan) } }, legacyOk('SavePickRs'))
  const after = await fb.query(q.woPostPickLines(plan.pick.id))
  const off = plan.lines.filter((l) => {
    const r = after.find((x) => Number(x.pickItemId) === l.pickItemId)
    return !r || Number(r.statusId) !== FINISHED || r.lotNumber !== l.lot
  }).map((l) => {
    const r = after.find((x) => Number(x.pickItemId) === l.pickItemId)
    return `${l.part} line ${l.pickItemId} is ${r ? lineStatusName(r.statusId) : 'gone'} on lot ${r?.lotNumber ?? 'none'} (expected Finished on ${l.lot})`
  })
  if (off.length) throw unexpected(`after SavePickRq, ${off.join('; ')}`)
  log.info(`push #${cmdId} wo_post: pick ${plan.pick.num} finished on ${plan.lines.map((l) => `${l.part} ${l.lot}`).join(', ')}`)
}

// Steps E5–E7: the work order's finished-good item, the fulfill, and the read-back.
async function fulfill(fb, plan, p, write, timeoutMs) {
  const w = timeoutMs ? await fb.call('GET', `/api/work-orders/${plan.wo.id}`, undefined, timeoutMs) : await fb.call('GET', `/api/work-orders/${plan.wo.id}`)
  if (w.status !== 200) throw unexpected(`GET /api/work-orders/${plan.wo.id} answered ${w.status}`)
  const fgs = asList(w.body?.woItems).filter((it) => it?.type?.id === 10 || it?.type?.name === 'Finished Good')
  if (fgs.length !== 1) throw unexpected(`work order ${plan.wo.num} shows ${fgs.length} finished-good items over the REST API`)
  if (Number(fgs[0].id) !== plan.fgWoItemId) throw unexpected(`work order ${plan.wo.num}'s finished-good item is ${fgs[0].id} over the REST API and ${plan.fgWoItemId} in the database`)
  if (fgs[0].part?.name && fgs[0].part.name !== p.partNumber) throw unexpected(`work order ${plan.wo.num}'s finished good is ${fgs[0].part.name}, not ${p.partNumber}`)

  const body = guardFulfillBody(fulfillBody(plan.fgWoItemId, p))
  await write('POST', `/api/work-orders/${plan.wo.id}/fulfill`, body, (b) => (b?.status !== 'Fulfilled' ? `the fulfill left the work order ${JSON.stringify(b?.status ?? null)}` : null))

  // E7: read back by SQL. Any difference: the post went through, a person checks it, nobody posts it again.
  const diffs = []
  const mo = (await fb.query(q.woPostMo(plan.mo.id)))[0]
  if (Number(mo?.statusId) !== MO_FULFILLED) diffs.push(`the MO is ${statusName(mo?.statusId)}, not Fulfilled`)
  const items = await fb.query(q.woPostWoItems(plan.wo.id))
  const fg = items.find((i) => Number(i.woItemId) === plan.fgWoItemId)
  if (!fg) diffs.push('the finished-good line is gone')
  else {
    if (Number(fg.qtyUsed) !== p.produced) diffs.push(`the finished good shows ${fg.qtyUsed} made, not ${p.produced}`)
    if (Number(fg.qtyScrapped || 0) !== p.scrapped) diffs.push(`the finished good shows ${fg.qtyScrapped ?? 0} scrapped, not ${p.scrapped}`)
  }
  for (const l of plan.lines) {
    const used = items.filter((i) => Number(i.typeId) === 20 && i.partNum === l.part).reduce((s, i) => s + Number(i.qtyUsed || 0), 0)
    if (used !== l.qty) diffs.push(`${l.part} shows ${used} used, not the pick line's ${l.qty}`)
  }
  const lotTags = await fb.query(q.woPostFinishedLotTags(p.partNumber, p.finishedLot))
  const atDest = lotTags.filter((t) => Number(t.locationId) === p.destId).reduce((s, t) => s + Number(t.qty || 0), 0)
  if (atDest !== p.produced) diffs.push(`lot ${p.finishedLot} holds ${atDest} at location ${p.destId}, not ${p.produced}`)
  if (diffs.length) throw postedButDiffers(plan.mo.num, diffs.join('; '))
}

async function runSteps(fb, cmd, { cfg, log, dryRun, fishbowlVersion }, { pickOnly = false } = {}) {
  const p = checkPayload(cmd.payload)
  fenceAndVersion(p, cfg, fishbowlVersion)
  const plan = await planPost(fb, p, cfg)
  if (plan.already) {
    log.info(`push #${cmd.id} wo_post: MO ${plan.mo.num} is already fulfilled with lot ${p.finishedLot} on hand — nothing sent`)
    return resultOf(plan, p, { writes: [], status: 'Fulfilled' })
  }
  const resumed = plan.toFinish.length === 0
  if (dryRun) {
    const would = wouldCalls(plan, p)
    log.info(`push #${cmd.id} wo_post: DRY RUN — would ${would.map((w) => w.call).join(', then ')}`)
    return resultOf(plan, p, { writes: [], resumed, would })
  }
  const writes = []
  const timeoutMs = cfg.mo?.postTimeoutMs || null
  const write = writer(fb, log, cmd.id, writes, { timeoutMs, describe: describeAnswer })
  await finishPick(fb, plan, write, log, cmd.id)
  if (pickOnly) return { ...resultOf(plan, p, { writes, resumed, status: statusName(plan.mo.statusId) }), pick_only: true }
  await fulfill(fb, plan, p, write, timeoutMs)
  return resultOf(plan, p, { writes, resumed, status: 'Fulfilled' })
}

// Runs one claimed wo_post command to the end. Returns the result for fb_push_finish; throws MoRefusal (nothing
// written by this run), MoUnexpected (the existing halt applies) or a read error, which the caller records.
export async function runWoPost(fb, cmd, ctx) {
  if (cmd?.kind !== WO_POST_KIND) throw refuse(`runWoPost: not a ${WO_POST_KIND} command (${cmd?.kind})`)
  return runSteps(fb, cmd, ctx)
}

// For scripts/try-wo-post.mjs only (D2a VERIFY 10, the resume test): every check, then steps E1–E4 — the pick lines
// finished, no fulfill. The bridge never calls this; runWoPost always runs to the end.
export async function runWoPostPickOnly(fb, cmd, ctx) {
  if (cmd?.kind !== WO_POST_KIND) throw refuse(`runWoPostPickOnly: not a ${WO_POST_KIND} command (${cmd?.kind})`)
  return runSteps(fb, cmd, ctx, { pickOnly: true })
}
