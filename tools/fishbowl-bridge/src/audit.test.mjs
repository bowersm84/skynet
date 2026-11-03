// audit.test.mjs — the v1.11 audit-tail registry, its mappers and the per-family guard, no I/O.
// Run: npm test (or node --test src/audit.test.mjs)
// Fixtures are data-query rows read from skybolt_newlive on 2026-11-04 (MO 5853, BOM SK40S5-5S, two open-SO pick
// lines). Descriptions are trimmed; the held line's destination is set to Assembly (it read Shipping), the way
// Ashley flags a line under D-ASM-06; one row gives its values as strings, as older data-query replies do.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  auditWindow, runFamily, FAMILIES, mapPickItem, removedPickItems, mapMo, mapMoItem, mapWorkOrder, mapWoItem,
  mapConsumedLot, moBatches, mapBom, mapBomItem, mapBomInstruction, bomBatches, sweepBoms,
} from './audit.mjs'
import { makeGuard } from './guard.mjs'
import { q } from './queries.mjs'

const family = (name) => FAMILIES.find((f) => f.family === name)

// A Fishbowl stand-in: answers each SQL with the first matching handler and records what it was asked.
function fakeFb(handlers) {
  const asked = []
  return {
    asked,
    query: async (sql) => {
      asked.push(sql)
      for (const [re, rows] of handlers) if (re.test(sql)) return typeof rows === 'function' ? rows(sql) : rows
      return []
    },
  }
}

// A SkyNet stand-in that records every upsert call.
function fakeSky(over = {}) {
  const calls = []
  const rec = (name) => async (...args) => { calls.push({ name, args }); return 1 }
  return {
    calls,
    upsertPickItems: rec('picks'),
    upsertShipments: rec('ships'),
    upsertManufactureOrders: rec('mos'),
    upsertBoms: rec('boms'),
    openPickItemIds: async () => [],
    ...over,
  }
}

const HELD = {
  soId: 5580, slotNum: 1, partId: 10959, pickLastModified: '2026-10-29T10:53:11.260-04', srcLocation: null, pickItemId: 105118,
  pickId: 10025, destLocationId: 3316, destTagNum: 2, pickNum: 'S8291', partNum: 'QL8C78', pickStatusId: 10, soItemId: 80060,
  statusId: 6, srcLocationId: null, qty: 2023, srcTagNum: null, destLocation: 'Assembly', status: 'Hold',
}
const COMMITTED = {
  soId: '9468', slotNum: '1', partId: '8910', pickLastModified: '2026-11-02T09:43:48.353-05', srcLocation: 'Receiving',
  pickItemId: '102574', pickId: '16106', destLocationId: '2', destTagNum: '2', pickNum: 'S15085', partNum: 'SK29667',
  pickStatusId: '30', soItemId: '87269', statusId: '30', srcLocationId: '3', qty: '1.000000000', srcTagNum: '140165',
  destLocation: 'Shipping', status: 'Committed',
}

test('the window starts OVERLAP_REVS below the cursor, never below 0; a NULL cursor means backfill', () => {
  assert.deepEqual(auditWindow(1000, 1500, 200), { from: 800, to: 1500 })
  assert.deepEqual(auditWindow('150', 400, 200), { from: 0, to: 400 })
  assert.equal(auditWindow(null, 400, 200), null)
  assert.equal(auditWindow(undefined, 400, 200), null)
})

test('a pick line maps to the fb_upsert_pick_items keys; the destination is the D-ASM-06 flag', () => {
  const held = mapPickItem(HELD)
  assert.deepEqual(held, {
    pickItemId: 105118, pickId: 10025, pickNum: 'S8291', pickStatusId: 10, pickLastModified: '2026-10-29T10:53:11.260-04:00',
    soId: 5580, soItemId: 80060, partId: 10959, partNum: 'QL8C78', qty: 2023, slotNum: 1, statusId: 6, status: 'Hold',
    srcLocationId: null, srcLocation: null, srcTagNum: null, destLocationId: 3316, destLocation: 'Assembly', destTagNum: 2,
  })
  const c = mapPickItem(COMMITTED)
  assert.equal(c.pickItemId, 102574)
  assert.equal(c.qty, 1)
  assert.equal(c.srcTagNum, 140165)
  assert.equal(c.pickLastModified, '2026-11-02T09:43:48.353-05:00')
  assert.deepEqual(removedPickItems([105118, 999, 102574], [held, c]), [999])
})

test('first run (NULL cursor): the backfill set is loaded and the cursor goes to maxRev on the last call', async () => {
  const fb = fakeFb([[/FROM pickitem pi JOIN soitem/, [{ pickId: 10025 }, { pickId: '16106' }]], [/pi\.pickId IN/, [HELD, COMMITTED]]])
  const sky = fakeSky({ openPickItemIds: async (ids) => { assert.deepEqual(ids, [10025, 16106]); return [105118, 999] } })
  const r = await runFamily(family('picks'), { fb, sky, cursor: null, maxRev: 411523, overlap: 200 })
  assert.equal(r.mode, 'backfill')
  assert.equal(r.ids, 2)
  assert.equal(r.fetched, 2)
  assert.equal(sky.calls.length, 1)
  const [rows, removed, revTo] = sky.calls[0].args
  assert.equal(rows.length, 2)
  assert.deepEqual(removed, [999])
  assert.equal(revTo, 411523)
  assert.match(fb.asked[1], /pi\.pickId IN \(10025,16106\)/)
})

test('a window reads (cursor - overlap, maxRev]; an empty window still makes one call, which moves the cursor', async () => {
  const fb = fakeFb([[/pickitem_aud/, []]])
  const sky = fakeSky()
  const r = await runFamily(family('picks'), { fb, sky, cursor: 5000, maxRev: 5300, overlap: 200 })
  assert.equal(r.mode, 'window')
  assert.match(fb.asked[0], /REV > 4800 AND REV <= 5300 AND orderTypeId = 20/)
  assert.deepEqual(sky.calls.map((c) => [c.name, c.args[0], c.args[2]]), [['picks', [], 5300]])
})

test('no new revisions: no audit read, one empty call that only stamps the clock', async () => {
  const fb = fakeFb([])
  const sky = fakeSky()
  const r = await runFamily(family('mos'), { fb, sky, cursor: 5300, maxRev: 5300 })
  assert.equal(r.mode, 'idle')
  assert.equal(fb.asked.length, 0)
  assert.deepEqual(sky.calls[0].args, [[], [], [], [], [], 5300])
})

test('only the last chunk carries rev_to; a failure part-way leaves the cursor where it was', async () => {
  const ok = fakeFb([[/ship_aud/, [{ shipId: 1 }, { shipId: 2 }]], [/FROM ship JOIN shipstatus/, (sql) => [{ shipId: Number(/IN \((\d+)\)/.exec(sql)[1]), statusId: 30 }]]])
  const sky = fakeSky()
  await runFamily(family('ships'), { fb: ok, sky, cursor: 100, maxRev: 400, chunkSize: 1 })
  assert.deepEqual(sky.calls.map((c) => c.args[3]), [null, 400])

  let n = 0
  const failing = fakeFb([[/ship_aud/, [{ shipId: 1 }, { shipId: 2 }]], [/FROM ship JOIN shipstatus/, () => { if (++n === 2) throw new Error('data-query failed (500)'); return [{ shipId: 1, statusId: 30 }] }]])
  const sky2 = fakeSky()
  await assert.rejects(runFamily(family('ships'), { fb: failing, sky: sky2, cursor: 100, maxRev: 400, chunkSize: 1 }), /500/)
  assert.deepEqual(sky2.calls.map((c) => c.args[3]), [null]) // the one call that landed did not move the cursor
})

// MO 5853 (moId 5351), read 2026-11-04.
const MO = { dateIssued: '2026-10-08T07:56:12.123-04', note: 'lh   rh\n120= lh      124+ sr', soId: null, dateScheduled: '2026-09-25T14:12:17.155-04', userId: 28, moId: 5351, dateCreated: '2026-09-25T14:12:30.330-04', dateLastModified: '2026-10-08T08:00:39.683-04', statusId: 60, dateCompleted: '2026-10-08T07:58:00.000-04', moNum: '5853', status: 'Fulfilled', locationGroupId: 1 }
const MO_ITEMS = [
  [35890, 50, null, null, null, 'SK40S5-5S stud configuration', 1],
  [35891, 10, 35890, 802, 'SK40S5-5S', 'Phillips Stud - Stainless', 1],
  [35892, 20, 35890, 6765, 'SK4C5P', '4000 Series Stud Phillips', 2],
  [35893, 20, 35890, 6559, 'SK4C5C', '-5 Cup Stainless', 3],
  [35894, 20, 35890, 5783, 'SK4000-3S', '4000 Series #3 Spring', 4],
  [35895, 20, 35890, 5784, 'SK4000CGP81', '4000 Series Pin', 5],
  [35896, 20, 35890, 8166, 'Labor', 'Y', 6],
].map(([moItemId, typeId, parentId, partId, partNum, description, sortId]) => ({
  bomId: 1164, qtyFulfilled: 1373, partId, moItemId, description, stageLevel: 1, moId: 5351, parentId, bomNum: 'SK40S5-5S',
  partNum, statusId: 50, sortId, typeId, qtyToFulfill: 1373,
}))
const WO = { note: '', cost: 575.53865717, woId: 8779, qtyScrapped: null, dateFinished: '2026-10-08T07:58:00.000-04', moItemId: 35890, woNum: '5853:001', moId: 5351, dateCreated: '2026-10-08T07:56:12.123-04', statusId: 40, qtyTarget: 1373, dateStarted: '2026-10-08T07:56:00.000-04', qtyOrdered: 1373, locationId: 1, status: 'Fulfilled' }
const WO_ITEMS = [[46679, 802, 'SK40S5-5S', 10, 35891], [46680, 6765, 'SK4C5P', 20, 35892], [46681, 6559, 'SK4C5C', 20, 35893],
  [46682, 5783, 'SK4000-3S', 20, 35894], [46683, 5784, 'SK4000CGP81', 20, 35895], [46684, 8166, 'Labor', 20, 35896]]
  .map(([woItemId, partId, partNum, typeId, moItemId], i) => ({ cost: 1, woId: 8779, woItemId, partId, qtyScrapped: 0, moItemId, description: partNum, partNum, standardCost: 0, qtyUsed: 1373, qtyTarget: 1373, sortId: i + 1, typeId }))
const CONSUMED = [[127508, 46680, 6765, 'SK4C5P', 139390, '100252'], [127509, 46681, 6559, 'SK4C5C', 133618, '303942'],
  [127510, 46682, 5783, 'SK4000-3S', 117174, '303611'], [127511, 46683, 5784, 'SK4000CGP81', 125984, '303798']]
  .map(([pickItemId, woItemId, partId, partNum, srcTagNum, lotNumber]) => ({ woId: 8779, statusId: 40, woItemId, partId, qty: 1373, srcLocation: 'Receiving', pickItemId, srcTagNum, lotNumber, partNum }))

test('MO 5853 maps whole: one MO, 7 items (one configuration), WO 5853:001, 6 WO items, 4 consumed lots', () => {
  const mo = mapMo(MO)
  assert.equal(mo.moNum, '5853')
  assert.equal(mo.statusId, 60)
  assert.equal(mo.soId, null)
  assert.equal(mo.dateCompleted, '2026-10-08T07:58:00.000-04:00')
  const items = MO_ITEMS.map(mapMoItem)
  assert.equal(items.length, 7)
  assert.deepEqual(items.filter((i) => i.typeId === 50).map((i) => i.moItemId), [35890])
  assert.ok(items.filter((i) => i.typeId !== 50).every((i) => i.parentId === 35890))
  const wo = mapWorkOrder(WO)
  assert.deepEqual([wo.woId, wo.woNum, wo.moId, wo.moItemId, wo.qtyOrdered, wo.qtyScrapped], [8779, '5853:001', 5351, 35890, 1373, null])
  assert.equal(WO_ITEMS.map(mapWoItem).length, 6)
  const lots = CONSUMED.map(mapConsumedLot)
  assert.deepEqual(lots.map((l) => l.lotNumber), ['100252', '303942', '303611', '303798'])
  assert.deepEqual(lots[0], { pickItemId: 127508, woId: 8779, woItemId: 46680, partId: 6765, partNum: 'SK4C5P', qty: 1373, statusId: 40, srcLocation: 'Receiving', srcTagNum: 139390, lotNumber: '100252' })
})

test('every MO batch carries all of its own children and nothing of another MO', () => {
  const other = { ...MO, moId: 6158, moNum: '6158' }
  const payload = {
    mos: [mapMo(MO), mapMo(other)],
    moItems: [...MO_ITEMS.map(mapMoItem), mapMoItem({ ...MO_ITEMS[0], moItemId: 1, moId: 6158 })],
    wos: [mapWorkOrder(WO), mapWorkOrder({ ...WO, woId: 9000, woNum: '6158:001', moId: 6158 })],
    woItems: [...WO_ITEMS.map(mapWoItem), mapWoItem({ ...WO_ITEMS[0], woItemId: 2, woId: 9000 })],
    consumed: [...CONSUMED.map(mapConsumedLot), mapConsumedLot({ ...CONSUMED[0], pickItemId: 3, woId: 9000 })],
  }
  const [a, b] = moBatches(payload, 1)
  assert.deepEqual([a.mos.length, a.moItems.length, a.wos.length, a.woItems.length, a.consumed.length], [1, 7, 1, 6, 4])
  assert.deepEqual([b.mos.length, b.moItems.length, b.wos.length, b.woItems.length, b.consumed.length], [1, 1, 1, 1, 1])
  assert.equal(moBatches(payload).length, 1)
})

// BOM SK40S5-5S (bomId 1164), read 2026-11-04.
const BOM = { bomId: 1164, dateLastModified: '2025-09-09T13:39:36.340-04', description: 'Phillips Stud - Stainless', active: true, autoCreateTypeId: 10, bomNum: 'SK40S5-5S', revision: '1' }
const BOM_ITEM = { bomId: 1164, uom: 'ea', quantity: 1, stage: false, partId: 6765, sortId: 1, partDescription: '4000 Series Stud Phillips', typeId: 20, uomId: 1, bomItemId: 6817, stageBomId: -1, partNum: 'SK4C5P' }
const INSTRUCTIONS = ['Pulled By:', 'Checked By:', 'Assembled By:', 'Inspected By:', 'CRIMPED BY', 'PRESSURE TEST  BY']
  .map((name, i) => ({ bomId: 1164, sortOrder: i + 1, name, instructionId: [134, 135, 136, 137, 953, 954][i], description: '', details: '' }))

test('BOM SK40S5-5S maps with its six sign-off lines; bit columns become booleans', () => {
  assert.deepEqual(mapBom(BOM), { bomId: 1164, bomNum: 'SK40S5-5S', description: 'Phillips Stud - Stainless', active: true, revision: '1', autoCreateTypeId: 10, dateLastModified: '2025-09-09T13:39:36.340-04:00' })
  assert.equal(mapBom({ ...BOM, active: '1' }).active, true)
  assert.equal(mapBom({ ...BOM, active: 0 }).active, false)
  assert.deepEqual(mapBomItem(BOM_ITEM), { bomItemId: 6817, bomId: 1164, typeId: 20, partId: 6765, partNum: 'SK4C5P', partDescription: '4000 Series Stud Phillips', quantity: 1, uomId: 1, uom: 'ea', sortId: 1, stage: false, stageBomId: -1 })
  const ins = INSTRUCTIONS.map(mapBomInstruction).sort((a, b) => a.sortOrder - b.sortOrder)
  assert.deepEqual(ins.map((i) => i.name), ['Pulled By:', 'Checked By:', 'Assembled By:', 'Inspected By:', 'CRIMPED BY', 'PRESSURE TEST  BY'])
  assert.equal(ins[4].instructionId, 953)
  const [batch] = bomBatches({ boms: [mapBom(BOM)], items: [mapBomItem(BOM_ITEM)], instructions: ins })
  assert.deepEqual([batch.boms.length, batch.items.length, batch.instructions.length], [1, 1, 6])
})

test('the BOM backfill is the sweep (p_sweep on the last call only); the nightly sweep never moves the cursor', async () => {
  const fb = fakeFb([[/FROM bom WHERE activeFlag = 1/, [{ bomId: 1164 }, { bomId: 1165 }]], [/FROM bom WHERE bom\.id IN/, (sql) => [...sql.matchAll(/(\d{4})/g)].map((m) => ({ ...BOM, bomId: Number(m[1]), bomNum: `B${m[1]}` }))]])
  const sky = fakeSky()
  await runFamily(family('boms'), { fb, sky, cursor: null, maxRev: 900, chunkSize: 1 })
  assert.deepEqual(sky.calls.map((c) => [c.args[3], c.args[4]]), [[null, false], [900, true]])
  const sky2 = fakeSky()
  await sweepBoms(fb, sky2, { chunkSize: 1 })
  assert.deepEqual(sky2.calls.map((c) => [c.args[3], c.args[4]]), [[null, false], [null, true]])
})

test('audit queries take numeric windows only, and an empty id list is IN (NULL), never IN ()', () => {
  assert.throws(() => q.auditPickIds('1; DROP TABLE pick', 5), /bad revision/)
  assert.throws(() => q.auditBomIds(-1, 5), /bad revision/)
  assert.match(q.auditMoIds(10, 20), /pa\.orderTypeId = 30 AND pa\.REV > 10 AND pa\.REV <= 20/)
  assert.match(q.pickItems([]), /pi\.pickId IN \(NULL\)/)
  assert.match(q.woConsumedLots([8779]), /ti\.tableId = -1515431424 AND ti\.partTrackingId = 1/)
  assert.throws(() => q.tags([1], "2026-11-04' OR 1=1"), /bad datetime/)
  assert.throws(() => q.postings('yesterday'), /bad datetime/)
})

test('a guarded family that fails is recorded, stands down alone, and the next success clears its state', async () => {
  let t = 1000
  const recorded = []
  const errors = []
  const g = makeGuard({ sky: { familyError: async (f, m) => { recorded.push([f, m]) } }, log: { error: (m) => errors.push(m), warn: () => {} }, defaultRetryMs: 900000, now: () => t })
  const out = await g.guarded('picks', async () => { throw new Error('data-query failed (500)') }, { retryMs: 60000 })
  assert.equal(out, undefined)
  assert.deepEqual(recorded, [['picks', 'Error: data-query failed (500)']])
  assert.match(errors[0], /picks failed, retrying in 60 s/)
  assert.equal(await g.guarded('ships', async () => 'ran'), 'ran') // another family is unaffected
  assert.equal(await g.guarded('picks', async () => 'too soon'), undefined)
  assert.equal(g.isPaused('picks'), true)
  assert.deepEqual(g.failing(['so', 'picks']), ['picks: Error: data-query failed (500)'])
  t += 60001
  assert.equal(await g.guarded('picks', async () => 'back'), 'back')
  assert.deepEqual(g.failing(['picks']), [])
  assert.deepEqual(g.snapshot(['picks', 'tags']), { picks: { lastMs: 0, ok: true }, tags: { lastMs: null, ok: null } })
})

test('D-FB-61: a no-RPC family is cleared with fb_family_ok on success, never when the step throws', async () => {
  let t = 0
  const calls = []
  const sky = { familyError: async (f) => { calls.push(['error', f]) }, familyOk: async (f) => { calls.push(['ok', f]) } }
  const g = makeGuard({ sky, log: { error: () => {}, warn: () => {} }, now: () => t, clearFamilies: ['users'] })
  await g.guarded('users', async () => 'ok')
  assert.deepEqual(calls, [['ok', 'users']]) // the first success in a process clears whatever a restart left behind
  calls.length = 0
  await g.guarded('users', async () => 'ok again')
  assert.deepEqual(calls, []) // nothing to clear: no call every cycle
  await g.guarded('users', async () => { throw new Error('Table sysuser_missing does not exist') }, { retryMs: 10 })
  assert.deepEqual(calls, [['error', 'users']]) // a failure records, it never clears
  t += 11
  await g.guarded('users', async () => 'recovered')
  assert.deepEqual(calls, [['error', 'users'], ['ok', 'users']])
  calls.length = 0
  await g.guarded('picks', async () => 'own RPC clears it')
  assert.deepEqual(calls, []) // a family with its own upsert RPC is not in clearFamilies
})

test('a clear that fails is logged, does not fail the step, and is retried on the next success', async () => {
  let fail = true
  const oks = []
  const warns = []
  const sky = { familyError: async () => {}, familyOk: async (f) => { if (fail) throw new Error('fetch failed'); oks.push(f) } }
  const g = makeGuard({ sky, log: { error: () => {}, warn: (m) => warns.push(m) }, clearFamilies: ['so'] })
  assert.equal(await g.guarded('so', async () => 'tail ok'), 'tail ok')
  assert.match(warns[0], /could not clear its family_errors entry/)
  fail = false
  await g.guarded('so', async () => 'tail ok')
  assert.deepEqual(oks, ['so'])
})

test('the guard survives SkyNet being unreachable while it records a failure', async () => {
  const warns = []
  const g = makeGuard({ sky: { familyError: async () => { throw new Error('fetch failed') } }, log: { error: () => {}, warn: (m) => warns.push(m) } })
  assert.equal(await g.guarded('tags', async () => { throw new Error('boom') }), undefined)
  assert.match(warns[0], /could not record the failure/)
})
