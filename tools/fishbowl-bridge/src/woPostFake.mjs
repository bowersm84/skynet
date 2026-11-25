// woPostFake.mjs — test support for woPost.test.mjs and push.test.mjs (D-ASM-61): a fake Fishbowl that answers the
// automatic post's own SQL (queries.mjs) and the five REST calls the probes proved, and applies them the way the
// sandbox did in probes 1 and 2. Not a test file itself; no I/O.
import { q } from './queries.mjs'
import { WO_POST_KIND } from './woPost.mjs'

export const quiet = { info: () => {}, warn: () => {}, error: () => {} }
export const PART = 'SKYTEST-STUD-ASSEMBLY'
export const COMPONENTS = ['SKYTEST-CUP', 'SKYTEST-PIN', 'SKYTEST-SPRING', 'SKYTEST-STUD']
export const LOTS = { 'SKYTEST-CUP': '100147', 'SKYTEST-PIN': '58663', 'SKYTEST-SPRING': '100512', 'SKYTEST-STUD': '100452' }
export const TICKET = 'secret-ticket-value'

export const cfg = (mo = {}) => ({ host: 'test', version: 'x',
  mo: { enabled: true, dryRun: false, writePartPrefix: 'SKYTEST-', locationGroupId: 1, postEnabled: true, postMinVersion: '26.11', postTimeoutMs: 120000, ...mo } })
export const payload = (over = {}) => ({
  build_id: 'b21', build_number: 'AB-00021', mo_number: 'SKYTEST-AB-00021', fb_mo_id: 5723,
  part_number: PART, quantity: 10, produced: 10, scrapped: 0, finished_lot: '80004', destination_location_id: 3,
  lots: COMPONENTS.map((part) => ({ part, lot: LOTS[part] })),
  min_version: '26.11', attempt: 1, write_part_prefix: 'SKYTEST-', ...over })
export const cmd = (over = {}) => ({ id: 51, kind: WO_POST_KIND, dry_run: false, payload: payload(over) })
export const ctx = (over = {}) => ({ cfg: cfg(), log: quiet, dryRun: false, fishbowlVersion: '26.11', ...over })

// ── The fake ──────────────────────────────────────────────────────────────────────────────────────────────────
export function world(mut = () => {}) {
  const w = {
    mo: { id: 5723, num: 'SKYTEST-AB-00021', statusId: 20, locationGroupId: 1, bom: PART, parts: [PART, ...COMPONENTS] },
    wos: [{ woId: 9400, woNum: 'SKYTEST-AB-00021:001', statusId: 10, qtyOrdered: 10, qtyTarget: 10, locationGroupId: 1 }],
    woItems: [{ woItemId: 49100, typeId: 10, partId: 11814, partNum: PART, qtyTarget: 10, qtyUsed: 0, qtyScrapped: 0 },
      ...COMPONENTS.map((p, i) => ({ woItemId: 49101 + i, typeId: 20, partId: 11800 + i, partNum: p, qtyTarget: 10, qtyUsed: 0, qtyScrapped: 0 }))],
    picks: [{ pickId: 21700, pickNum: 'WSKYTEST-AB-00021:001', statusId: 10, locationGroupId: 1 }],
    lines: COMPONENTS.map((p, i) => ({ pickItemId: 131700 + i, woItemId: 49101 + i, orderTypeId: 30, partId: 11800 + i, partNum: p, qty: 10,
      statusId: 10, srcLocationId: null, srcTagId: null, srcTagNum: null, lotNumber: null })),
    tags: COMPONENTS.map((p, i) => ({ tagId: 104700 + i, tagNum: String(141300 + i), part: p, lot: LOTS[p], qty: 500, qtyCommitted: 0,
      locationId: 1, locationName: 'Stock', locationGroupId: 1, typeId: 30 })),
    tracking: Object.fromEntries([PART, ...COMPONENTS].map((p) => [p, [1]])),
    locations: { 3: { id: 3, name: 'Receiving', activeFlag: true, locationGroupId: 1 } },
    answers: {},
  }
  mut(w)
  return w
}

export const ALL = [] // every fake made, for the "never GET /api/picks/:id" check
export function fakeFishbowl(w = world()) {
  const calls = []
  const queries = []
  const pick = () => w.picks[0]
  const legacyItems = () => w.lines.map((l) => ({
    PickItemID: l.pickItemId, Status: l.statusId,
    Part: { PartID: l.partId, Num: l.partNum, PartTrackingList: { PartTracking: { PartTrackingID: 1, Name: 'Lot Number', Abbr: 'Lot#' } } },
    Tag: { TagID: -1 }, Quantity: l.qty, UOM: { UOMID: 1 }, Tracking: '', DestinationTag: { TagID: 102040 },
    WoItemId: l.woItemId, Location: { LocationID: l.srcLocationId ?? 1, Name: l.srcLocationName ?? 'Stock', LocationGroupID: 1 },
  }))
  const legacy = (name, inner) => ({ status: 200, body: { FbiJson: { Ticket: { Key: TICKET }, FbiMsgsRs: { statusCode: 1000, [name]: inner } } } })
  const fb = {
    calls, queries, w,
    async query(sql) {
      queries.push(sql)
      let m
      const mo = w.mo
      if ((m = sql.match(/^SELECT mo\.id, mo\.num, mo\.statusId FROM mo WHERE mo\.id = (\d+)$/))) return Number(m[1]) === mo.id ? [{ id: mo.id, num: mo.num, statusId: mo.statusId }] : []
      if (sql === q.woPostMo(mo.id)) return [{ id: mo.id, num: mo.num, statusId: mo.statusId, locationGroupId: mo.locationGroupId }]
      if (/FROM moitem mi LEFT JOIN bom/.test(sql)) {
        return [{ typeId: 50, qtyFulfilled: 0, bomNum: mo.bom, partNum: null },
          ...mo.parts.map((p, i) => ({ typeId: i === 0 ? 10 : 20, qtyFulfilled: 0, bomNum: mo.bom, partNum: p }))]
      }
      if (sql === q.woPostWorkOrders(mo.id)) return w.wos.map((x) => ({ ...x }))
      for (const wo of w.wos) {
        if (sql === q.woPostWoItems(wo.woId)) return w.woItems.map((x) => ({ ...x }))
        if (sql === q.woPostPicks(wo.woId)) return w.picks.map((x) => ({ ...x }))
      }
      for (const p of w.picks) if (sql === q.woPostPickLines(p.pickId)) return w.lines.map((x) => ({ ...x }))
      if ((m = sql.match(/WHERE part\.num = '(.*?)' AND tt\.info = '(.*?)' AND tag\.typeId = 30 AND tag\.qty > 0 ORDER BY tag\.id$/))) {
        return w.tags.filter((t) => t.part === m[1] && t.lot === m[2] && t.typeId === 30 && t.qty > 0).sort((a, b) => a.tagId - b.tagId).map((t) => ({ ...t }))
      }
      if ((m = sql.match(/WHERE part\.num = '(.*?)' AND tt\.info = '(.*?)' AND tag\.qty > 0 ORDER BY tag\.id$/))) {
        return w.tags.filter((t) => t.part === m[1] && t.lot === m[2] && t.qty > 0).map((t) => ({ ...t }))
      }
      if ((m = sql.match(/FROM parttotracking ptt .* WHERE part\.num IN \((.*)\) ORDER BY/s))) {
        const nums = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])
        return nums.flatMap((n) => (w.tracking[n] || []).map((id) => ({ partNum: n, partTrackingId: id })))
      }
      if ((m = sql.match(/^SELECT id, name, activeFlag, locationGroupId FROM location WHERE id = (\d+)$/))) return w.locations[m[1]] ? [{ ...w.locations[m[1]] }] : []
      throw new Error(`fake fishbowl: unexpected query ${sql}`)
    },
    async call(method, path, body, timeoutMs) {
      calls.push({ method, path, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)), timeoutMs })
      if (method === 'GET' && /^\/api\/picks\//.test(path)) throw new Error('GET /api/picks/:id must never be called')
      const key = `${method} ${path.replace(/\d+/g, ':id')}`
      if (w.answers[key]) { const r = w.answers[key](body, w); if (r) return r }
      if (key === 'POST /api/picks/:id/start') {
        pick().statusId = 20
        for (const l of w.lines) if (l.statusId === 10) { l.statusId = 20; l.srcLocationId = 1; l.srcLocationName = 'Stock' }
        return { status: 200, body: { id: pick().pickId, status: 'Started' } }
      }
      if (key === 'POST /api/legacy/external/GetPickRq') {
        return legacy('GetPickRs', { statusCode: 1000, Pick: { PickID: pick().pickId, Number: pick().pickNum, Status: 'Started', StatusID: pick().statusId, PickItems: { PickItem: legacyItems() } } })
      }
      if (key === 'POST /api/legacy/external/SavePickRq') {
        for (const it of [].concat(body.SavePickRq.Pick.PickItems.PickItem)) {
          const l = w.lines.find((x) => x.pickItemId === it.PickItemID)
          if (it.Status === 40 && l.statusId !== 40) {
            l.statusId = 40
            l.lotNumber = it.Tracking.TrackingItem.TrackingValue
            l.srcTagId = it.Tag.TagID
            l.srcTagNum = it.Tag.Num
            const t = w.tags.find((x) => x.tagId === it.Tag.TagID)
            if (t) t.qty -= l.qty
          }
        }
        if (w.lines.every((l) => l.statusId === 40)) pick().statusId = 40
        return legacy('SavePickRs', { statusCode: 1000, Pick: body.SavePickRq.Pick })
      }
      if (key === 'GET /api/work-orders/:id') {
        return { status: 200, body: { id: w.wos[0].woId, woItems: w.woItems.map((i) => ({ id: i.woItemId, type: { id: i.typeId, name: i.typeId === 10 ? 'Finished Good' : 'Raw Good' }, part: { name: i.partNum } })) } }
      }
      if (key === 'POST /api/work-orders/:id/fulfill') {
        const fg = body.finishedGoods[0]
        const produced = Number(fg.quantityUsed)
        w.mo.statusId = 60
        w.wos[0].statusId = 40
        const fgItem = w.woItems.find((i) => i.woItemId === fg.itemId)
        fgItem.qtyUsed = produced
        fgItem.qtyScrapped = Number(fg.quantityScrapped)
        for (const l of w.lines) w.woItems.find((i) => i.woItemId === l.woItemId).qtyUsed = l.qty
        w.tags.push({ tagId: 106000, tagNum: '150000', part: PART, lot: fg.tracking.trackingItems[0].value, qty: produced,
          locationId: fg.destinationLocationId, locationName: 'Receiving', locationGroupId: 1, typeId: 30 })
        if (w.afterFulfill) w.afterFulfill(w)
        return { status: 200, body: { id: w.wos[0].woId, number: w.wos[0].woNum, status: 'Fulfilled' } }
      }
      throw new Error(`fake fishbowl: unexpected call ${key}`)
    },
  }
  ALL.push(fb)
  return fb
}
