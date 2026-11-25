// woPost.test.mjs — the automatic post (kind wo_post, D-ASM-61) against a fake Fishbowl, no I/O.
// Run: node --test src/woPost.test.mjs
//
// The fake answers the handler's own SQL (queries.mjs) and the five REST calls the probes proved, and applies them
// the way the sandbox did in probes 1 and 2: the start moves the lines to Started from Stock, the pick save finishes
// a line on the tag and lot it is given, the fulfill consumes what the pick lines hold and receives the finished lot.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MoRefusal, MoUnexpected } from './mo.mjs'
import { runWoPost, runWoPostPickOnly, guardFulfillBody, fulfillBody } from './woPost.mjs'
import { PART, COMPONENTS, LOTS, TICKET, cfg, cmd, ctx, ALL, world, fakeFishbowl } from './woPostFake.mjs'

const sent = (fb) => fb.calls.map((c) => `${c.method} ${c.path}`)
const writesOf = (fb) => fb.calls.filter((c) => c.method !== 'GET')

// ── 1. A clean post ───────────────────────────────────────────────────────────────────────────────────────────
test('1. a clean post: start, GetPickRq, SavePickRq, the work-order GET and the fulfill, in that order, with the probed bodies', async () => {
  const fb = fakeFishbowl()
  const r = await runWoPost(fb, cmd(), ctx())
  assert.deepEqual(sent(fb), ['POST /api/picks/21700/start', 'POST /api/legacy/external/GetPickRq', 'POST /api/legacy/external/SavePickRq',
    'GET /api/work-orders/9400', 'POST /api/work-orders/9400/fulfill'])
  assert.deepEqual(fb.calls[1].body, { GetPickRq: { PickNum: 'WSKYTEST-AB-00021:001' } })
  // SavePickRq: the whole pick back; each line Finished on its lot's tag, with the lot as tracking (probe 1's finish-pick)
  const items = fb.calls[2].body.SavePickRq.Pick.PickItems.PickItem
  assert.equal(items.length, 4)
  const cup = items.find((it) => it.Part.Num === 'SKYTEST-CUP')
  const lotTracking = { PartTracking: { PartTrackingID: 1, Name: 'Lot Number', Abbr: 'Lot#' }, TrackingValue: '100147' }
  assert.deepEqual(cup.Tag, { TagID: 104700, Num: '141300', PartNum: 'SKYTEST-CUP', Location: { LocationID: 1, Name: 'Stock', LocationGroupID: 1 },
    Quantity: 500, QuantityCommitted: 0, Tracking: { TrackingItem: lotTracking }, TypeID: 30 })
  assert.deepEqual(cup.Tracking, { TrackingItem: lotTracking })
  assert.equal(cup.Status, 40)
  assert.equal(cup.Quantity, 10) // the rest of the line as Fishbowl returned it
  assert.deepEqual(fb.calls[4].body, {
    finishedGoods: [{ itemId: 49100, quantityUsed: '10', quantityScrapped: '0', destinationLocationId: 3,
      tracking: { trackingItems: [{ partTracking: { id: 1 }, value: '80004' }] } }],
    splitWorkOrder: false,
  })
  assert.ok(writesOf(fb).every((c) => c.timeoutMs === 120000), 'every write carries FB_WO_POST_TIMEOUT_MS')
  assert.deepEqual([r.fb_mo_id, r.mo_number, r.wo_id, r.wo_number, r.pick_id, r.pick_number, r.status, r.produced, r.scrapped, r.finished_lot, r.resumed, r.already],
    [5723, 'SKYTEST-AB-00021', 9400, 'SKYTEST-AB-00021:001', 21700, 'WSKYTEST-AB-00021:001', 'Fulfilled', 10, 0, '80004', false, false])
  assert.deepEqual(r.destination, { id: 3, name: 'Receiving' })
  assert.deepEqual(r.lots[0], { part: 'SKYTEST-CUP', lot: '100147', tag_id: 104700, tag_num: '141300', qty: 10 })
  assert.equal(r.writes.length, 4) // start, GetPickRq, SavePickRq, fulfill (the GET is a read)
  assert.ok(!JSON.stringify(r).includes(TICKET), 'the legacy Ticket never reaches the result')
})

// ── 2. rawGoods ───────────────────────────────────────────────────────────────────────────────────────────────
test('2. the fulfill body has no rawGoods, and the guard throws if one is forced in', async () => {
  const fb = fakeFishbowl()
  await runWoPost(fb, cmd({ produced: 9, scrapped: 1 }), ctx())
  const ful = fb.calls.find((c) => c.path.endsWith('/fulfill'))
  assert.equal(Object.hasOwn(ful.body, 'rawGoods'), false)
  const body = fulfillBody(49100, { produced: 9, scrapped: 1, destId: 3, finishedLot: '80004' })
  assert.equal(guardFulfillBody(body), body)
  assert.throws(() => guardFulfillBody({ ...body, rawGoods: [] }), (e) => /never sends rawGoods/.test(e.message) && e.halt === true)
})

// ── 4. Refusals: each writes nothing ──────────────────────────────────────────────────────────────────────────
const REFUSALS = [
  // A. the payload
  ['A mo_number too long', { cmd: cmd({ mo_number: 'SKYTEST-' + 'X'.repeat(20) }) }, /longer than 25 characters/],
  ['A fb_mo_id not a whole number above 0', { cmd: cmd({ fb_mo_id: 0 }) }, /fb_mo_id 0 is not a whole number above 0/],
  ['A part_number missing', { cmd: cmd({ part_number: '' }) }, /part_number is missing/],
  ['A produced below 1', { cmd: cmd({ produced: 0, quantity: 0 }) }, /produced 0 is not a whole number of 1 or more/],
  ['A scrapped below 0', { cmd: cmd({ scrapped: -1 }) }, /scrapped -1 is not a whole number of 0 or more/],
  ['A quantity not produced + scrapped', { cmd: cmd({ quantity: 11 }) }, /quantity 11 is not produced \+ scrapped/],
  ['A finished_lot missing', { cmd: cmd({ finished_lot: '' }) }, /finished_lot is missing/],
  ['A finished_lot with a quote', { cmd: cmd({ finished_lot: "80'04" }) }, /characters the bridge will not send/],
  ['A destination not a whole number above 0', { cmd: cmd({ destination_location_id: 0 }) }, /destination_location_id 0/],
  ['A lots empty', { cmd: cmd({ lots: [] }) }, /lots is empty/],
  ['A lots without a lot', { cmd: cmd({ lots: [{ part: 'SKYTEST-CUP', lot: '' }] }) }, /without a part and a lot/],
  ['A lots name a part twice', { cmd: cmd({ lots: [{ part: 'SKYTEST-CUP', lot: '1' }, { part: 'SKYTEST-CUP', lot: '2' }] }) }, /names SKYTEST-CUP twice/],
  // B. fence and version
  ['B payload prefix differs', { cmd: cmd({ write_part_prefix: 'SK' }) }, /payload write_part_prefix "SK" is not this bridge's "SKYTEST-"/],
  ['B part outside the prefix', { cmd: cmd({ part_number: 'SK40S5-12S' }) }, /BOM "SK40S5-12S" does not start with "SKYTEST-"/],
  ['B empty prefix', { ctx: ctx({ cfg: cfg({ writePartPrefix: '' }) }) }, /FB_WRITE_PART_PREFIX is not set/],
  ['B version below the minimum', { ctx: ctx({ fishbowlVersion: '25.9' }) }, /Fishbowl is version 25\.9; automatic posting needs 26\.11 or later/],
  ['B version unknown', { ctx: ctx({ fishbowlVersion: null }) }, /server version is not known/],
  ['B below the payload minimum', { cmd: cmd({ min_version: '27.1' }) }, /SkyNet asks for 27\.1 or later/],
  // C. what Fishbowl holds
  ['C1 MO not in Fishbowl', { cmd: cmd({ fb_mo_id: 9999 }) }, /MO id 9999 is not in Fishbowl/],
  ['C1 MO number differs', { cmd: cmd({ mo_number: 'SKYTEST-AB-00099' }) }, /is SKYTEST-AB-00021, not SKYTEST-AB-00099/],
  ['C1 MO on another BOM', { world: (w) => { w.mo.bom = 'SKYTEST-OTHER' } }, /is on BOM SKYTEST-OTHER, not SKYTEST-STUD-ASSEMBLY/],
  ['C1 MO part outside the fence', { world: (w) => { w.mo.parts = [PART, 'SKYTEST-CUP', 'SK4C12P'] } }, /part\(s\) outside "SKYTEST-": SK4C12P/],
  ['C2 fulfilled without the lot on hand', { world: (w) => { w.mo.statusId = 60 } }, /already fulfilled in Fishbowl, but finished lot 80004/],
  ['C3 MO not Issued', { world: (w) => { w.mo.statusId = 10 } }, /is Entered; only an Issued MO/],
  ['C4 two work orders', { world: (w) => { w.wos.push({ ...w.wos[0], woId: 9401, woNum: 'X:002' }) } }, /has 2 work orders/],
  ['C4 work order fulfilled', { world: (w) => { w.wos[0].statusId = 40 } }, /is already fulfilled/],
  ['C4 work order quantity differs', { world: (w) => { w.wos[0].qtyOrdered = 12 } }, /is for 12, not the build's 10/],
  ['C5 two picks', { world: (w) => { w.picks.push({ ...w.picks[0], pickId: 21701 }) } }, /has 2 picks/],
  ['C5 line parts differ from the lots', { cmd: cmd({ lots: [...COMPONENTS.slice(0, 3), 'SKYTEST-NUT'].map((part) => ({ part, lot: '1' })) }) }, /has lines for .* recorded lots for/],
  ['C5 a part on two lines', { world: (w) => { w.lines.push({ ...w.lines[0], pickItemId: 131799 }) } }, /SKYTEST-CUP on more than one line/],
  ['C6 a line status the probes never saw', { world: (w) => { w.lines[1].statusId = 30 } }, /status 30, which the probes never saw/],
  ['C6 a pick status the probes never saw', { world: (w) => { w.picks[0].statusId = 30 } }, /pick WSKYTEST-AB-00021:001 is status 30/],
  ['C7 no tag of the lot', { world: (w) => { w.tags = w.tags.filter((t) => t.part !== 'SKYTEST-PIN') } }, /lot 58663 of SKYTEST-PIN is not on hand/],
  ['C7 tag in another location group', { world: (w) => { w.tags[3].locationGroupId = 6 } }, /lot 100452 of SKYTEST-STUD is not on hand in the MO's location group/],
  ['C8 finished good not tracked by lot alone', { world: (w) => { w.tracking[PART] = [1, 4] } }, /SKYTEST-STUD-ASSEMBLY is tracked by 1, 4/],
  ['C9 destination missing', { cmd: cmd({ destination_location_id: 77 }) }, /destination location 77 is not in Fishbowl/],
  ['C9 destination inactive', { world: (w) => { w.locations[3].activeFlag = false } }, /destination location 3 \(Receiving\) is not active/],
  ['C10 finished lot already on hand', { world: (w) => { w.tags.push({ tagId: 105999, tagNum: '149999', part: PART, lot: '80004', qty: 3, locationId: 3, locationName: 'Receiving', locationGroupId: 1, typeId: 30 }) } }, /finished lot 80004 of SKYTEST-STUD-ASSEMBLY is already on hand/],
]
for (const [name, setup, re] of REFUSALS) {
  test(`4. refusal, nothing written — ${name}`, async () => {
    const fb = fakeFishbowl(world(setup.world || (() => {})))
    await assert.rejects(runWoPost(fb, setup.cmd || cmd(), setup.ctx || ctx()), (e) => e instanceof MoRefusal && re.test(e.message) && !e.halt)
    assert.equal(fb.calls.length, 0, 'a refusal sends no REST call at all')
  })
}

// ── 5. Dry run ────────────────────────────────────────────────────────────────────────────────────────────────
test('5. dry run: SQL reads only, nothing sent (not even GetPickRq); `would` lists the calls', async () => {
  const fb = fakeFishbowl()
  const r = await runWoPost(fb, cmd(), ctx({ dryRun: true }))
  assert.equal(fb.calls.length, 0)
  assert.deepEqual(r.would.map((x) => x.call), ['POST /api/picks/21700/start', 'POST /api/legacy/external/GetPickRq', 'POST /api/legacy/external/SavePickRq',
    'GET /api/work-orders/9400', 'POST /api/work-orders/9400/fulfill'])
  assert.deepEqual(r.would[2].lines.map((l) => [l.part, l.lot, l.tag_id]), COMPONENTS.map((p, i) => [p, LOTS[p], 104700 + i]))
  assert.deepEqual(r.would[4].body.finishedGoods[0].itemId, 49100)
  assert.deepEqual(r.writes, [])
})

// ── 6. Resume ─────────────────────────────────────────────────────────────────────────────────────────────────
const finishedOnBuildLots = (w) => {
  w.picks[0].statusId = 40
  w.lines.forEach((l, i) => Object.assign(l, { statusId: 40, srcLocationId: 1, srcTagId: 104700 + i, srcTagNum: String(141300 + i), lotNumber: LOTS[l.partNum] }))
}
test('6. resume: lines already finished on the right lots -> no pick calls, one fulfill; resumed is true', async () => {
  const fb = fakeFishbowl(world(finishedOnBuildLots))
  const r = await runWoPost(fb, cmd(), ctx())
  assert.deepEqual(sent(fb), ['GET /api/work-orders/9400', 'POST /api/work-orders/9400/fulfill'])
  assert.equal(r.resumed, true)
  assert.deepEqual(r.lots[3], { part: 'SKYTEST-STUD', lot: '100452', tag_id: 104703, tag_num: '141303', qty: 10 })
})

test('6b. pick only (the sandbox script), then the full post resumes', async () => {
  const w = world()
  const fb = fakeFishbowl(w)
  const r1 = await runWoPostPickOnly(fb, cmd(), ctx())
  assert.equal(r1.pick_only, true)
  assert.deepEqual(sent(fb), ['POST /api/picks/21700/start', 'POST /api/legacy/external/GetPickRq', 'POST /api/legacy/external/SavePickRq'])
  assert.equal(w.mo.statusId, 20)
  const fb2 = fakeFishbowl(w)
  const r2 = await runWoPost(fb2, cmd(), ctx())
  assert.deepEqual(sent(fb2), ['GET /api/work-orders/9400', 'POST /api/work-orders/9400/fulfill'])
  assert.equal(r2.resumed, true)
})

// ── 7. A line finished on another lot ─────────────────────────────────────────────────────────────────────────
test('7. a line already finished on another lot refuses, nothing written', async () => {
  const fb = fakeFishbowl(world((w) => { w.picks[0].statusId = 20; w.lines.forEach((l) => { l.statusId = 20 }); Object.assign(w.lines[0], { statusId: 40, lotNumber: '100583' }) }))
  await assert.rejects(runWoPost(fb, cmd(), ctx()), (e) => e instanceof MoRefusal && /already finished on lot 100583, not the build's 100147/.test(e.message))
  assert.equal(fb.calls.length, 0)
})

// ── 8. Already fulfilled ──────────────────────────────────────────────────────────────────────────────────────
test('8. already fulfilled with the lot on hand -> already: true, nothing sent; without the lot it refuses', async () => {
  const done = fakeFishbowl(world((w) => {
    w.mo.statusId = 60
    w.tags.push({ tagId: 106000, tagNum: '150000', part: PART, lot: '80004', qty: 10, locationId: 3, locationName: 'Receiving', locationGroupId: 1, typeId: 30 })
  }))
  const r = await runWoPost(done, cmd(), ctx())
  assert.deepEqual([r.already, r.status, r.writes], [true, 'Fulfilled', []])
  assert.equal(done.calls.length, 0)
  const lost = fakeFishbowl(world((w) => { w.mo.statusId = 60 }))
  await assert.rejects(runWoPost(lost, cmd(), ctx()), (e) => e instanceof MoRefusal && /already fulfilled in Fishbowl, but finished lot 80004/.test(e.message))
  assert.equal(lost.calls.length, 0)
})

// ── 9. The legacy wrapper's own failure ───────────────────────────────────────────────────────────────────────
test('9. SavePickRq answering HTTP 200 with a status code other than 1000 -> MoUnexpected (halts), no fulfill, no Ticket in the message', async () => {
  const fb = fakeFishbowl(world((w) => {
    w.answers['POST /api/legacy/external/SavePickRq'] = () => ({ status: 200,
      body: { FbiJson: { Ticket: { Key: TICKET }, FbiMsgsRs: { statusCode: 1000, SavePickRs: { statusCode: 2100, statusMessage: 'Pick item could not be saved' } } } } })
  }))
  await assert.rejects(runWoPost(fb, cmd(), ctx()), (e) => e instanceof MoUnexpected && e.halt === true
    && /SavePickRs\.statusCode 2100 \(Pick item could not be saved\)/.test(e.message) && !e.message.includes(TICKET))
  assert.deepEqual(sent(fb), ['POST /api/picks/21700/start', 'POST /api/legacy/external/GetPickRq', 'POST /api/legacy/external/SavePickRq'])
})

test('9b. GetPickRq with an outer status code other than 1000 -> MoUnexpected before any save', async () => {
  const fb = fakeFishbowl(world((w) => {
    w.answers['POST /api/legacy/external/GetPickRq'] = () => ({ status: 200, body: { FbiJson: { Ticket: { Key: TICKET }, FbiMsgsRs: { statusCode: 900, statusMessage: 'No unmarshaller' } } } })
  }))
  await assert.rejects(runWoPost(fb, cmd(), ctx()), (e) => e instanceof MoUnexpected && /FbiMsgsRs\.statusCode 900/.test(e.message))
  assert.ok(!sent(fb).includes('POST /api/legacy/external/SavePickRq'))
})

// ── 10. The fulfill went through but reads back differently ───────────────────────────────────────────────────
test('10. a fulfill that answers 200 but reads back differently -> MoUnexpected that says the post went through', async () => {
  const fb = fakeFishbowl(world((w) => { w.afterFulfill = (x) => { x.woItems[0].qtyScrapped = 0 } }))
  await assert.rejects(runWoPost(fb, cmd({ produced: 9, scrapped: 1 }), ctx()), (e) => e instanceof MoUnexpected && e.halt === true
    && /The post went through in Fishbowl \(MO SKYTEST-AB-00021 was fulfilled\)/.test(e.message)
    && /the finished good shows 0 scrapped, not 1/.test(e.message) && /do not post this build again/.test(e.message))
  assert.equal(sent(fb).filter((c) => c.endsWith('/fulfill')).length, 1)
})

// ── 11. Version ───────────────────────────────────────────────────────────────────────────────────────────────
test('11. version below the minimum, and version unknown, both refuse with nothing read or sent', async () => {
  for (const v of ['25.9', '26.9', null, '']) {
    const fb = fakeFishbowl()
    await assert.rejects(runWoPost(fb, cmd(), ctx({ fishbowlVersion: v })), (e) => e instanceof MoRefusal)
    assert.equal(fb.calls.length + fb.queries.length, 0)
  }
  const raised = fakeFishbowl()
  await assert.rejects(runWoPost(raised, cmd(), ctx({ cfg: cfg({ postMinVersion: '27.1' }) })), /needs 27\.1 or later/)
})

// ── 12. Tag choice ────────────────────────────────────────────────────────────────────────────────────────────
test('12. tag choice: the lowest tag id that covers the line wins; none covering refuses with the quantities', async () => {
  const studTags = (rows) => (w) => {
    w.tags = w.tags.filter((t) => t.part !== 'SKYTEST-STUD').concat(rows.map(([tagId, qty, qtyCommitted]) => ({ tagId, tagNum: `T${tagId}`, part: 'SKYTEST-STUD', lot: '100452',
      qty, qtyCommitted, locationId: 1, locationName: 'Stock', locationGroupId: 1, typeId: 30 })))
  }
  const fb = fakeFishbowl(world(studTags([[104804, 50, 0], [104801, 5, 0], [104802, 20, 15], [104803, 30, 0]])))
  const r = await runWoPost(fb, cmd(), ctx({ dryRun: true }))
  assert.equal(r.would[2].lines.find((l) => l.part === 'SKYTEST-STUD').tag_id, 104803) // 104801 holds 5, 104802 has 5 free
  const short = fakeFishbowl(world(studTags([[104801, 6, 0], [104802, 6, 0]])))
  await assert.rejects(runWoPost(short, cmd(), ctx()), (e) => e instanceof MoRefusal
    && /no single tag of SKYTEST-STUD lot 100452 covers the line: the largest available is 6, the line needs 10/.test(e.message))
  assert.equal(short.calls.length, 0)
})

// ── 13. A lot in another location than the pick line's source: a hand post, not a halt (D-ASM-62) ─────────────────
// Fishbowl sources the PIN line from location 5 ("Shelf B"); lot 58663 is only in Stock (location 1).
const pinFromShelfB = (l) => { l.statusId = 20; l.srcLocationId = l.partNum === 'SKYTEST-PIN' ? 5 : 1; l.srcLocationName = l.partNum === 'SKYTEST-PIN' ? 'Shelf B' : 'Stock' }

test('13a. location mismatch known before the start (the pick already started): MoRefusal, zero writes, no halt', async () => {
  const fb = fakeFishbowl(world((w) => { w.picks[0].statusId = 20; w.lines.forEach(pinFromShelfB) }))
  await assert.rejects(runWoPost(fb, cmd(), ctx()), (e) => e instanceof MoRefusal && !e.halt
    && /SKYTEST-PIN lot 58663 is in Stock \(location 1\), but Fishbowl sources the pick line from Shelf B \(location 5\)\. Nothing was written; post this build by hand$/.test(e.message))
  assert.equal(fb.calls.length, 0)
  assert.ok(!sent(fb).includes('POST /api/legacy/external/SavePickRq') && !sent(fb).some((c) => c.endsWith('/fulfill')))
})

test('13b. location mismatch known only after the start: MoRefusal; only the start and GetPickRq were sent; the message says the pick was started', async () => {
  const fb = fakeFishbowl(world((w) => {
    w.answers['POST /api/picks/:id/start'] = (b, x) => {
      x.picks[0].statusId = 20
      x.lines.forEach(pinFromShelfB)
      return { status: 200, body: { status: 'Started' } }
    }
  }))
  await assert.rejects(runWoPost(fb, cmd(), ctx()), (e) => e instanceof MoRefusal && !e.halt
    && /SKYTEST-PIN lot 58663 is in Stock \(location 1\), but Fishbowl sourced the pick line from Shelf B \(location 5\)\. The pick was started and nothing else was written; post this build by hand$/.test(e.message))
  assert.deepEqual(sent(fb), ['POST /api/picks/21700/start', 'POST /api/legacy/external/GetPickRq'])
  assert.ok(!sent(fb).includes('POST /api/legacy/external/SavePickRq') && !sent(fb).some((c) => c.endsWith('/fulfill')))
})

test('13c. a retry after 13b refuses before any write: the started line now says where it is sourced from', async () => {
  const w = world((x) => { x.picks[0].statusId = 20; x.lines.forEach(pinFromShelfB) })
  const retry = fakeFishbowl(w)
  await assert.rejects(runWoPost(retry, cmd({ attempt: 2 }), ctx()), (e) => e instanceof MoRefusal && /Nothing was written; post this build by hand$/.test(e.message))
  assert.equal(retry.calls.length, 0)
})

test('13d. a lot in the source location wins over a lower tag id elsewhere', async () => {
  const fb = fakeFishbowl(world((w) => {
    w.picks[0].statusId = 20
    w.lines.forEach(pinFromShelfB)
    w.tags.push({ tagId: 104600, tagNum: '141200', part: 'SKYTEST-PIN', lot: '58663', qty: 50, qtyCommitted: 0, locationId: 1, locationName: 'Stock', locationGroupId: 1, typeId: 30 })
    w.tags.push({ tagId: 104799, tagNum: '141399', part: 'SKYTEST-PIN', lot: '58663', qty: 50, qtyCommitted: 0, locationId: 5, locationName: 'Shelf B', locationGroupId: 1, typeId: 30 })
  }))
  const r = await runWoPost(fb, cmd(), ctx({ dryRun: true }))
  assert.deepEqual(r.would.find((x) => x.lines).lines.find((l) => l.part === 'SKYTEST-PIN').tag_id, 104799)
})

// ── 3. Never GET /api/picks/:id — checked over every fake every test made (runs last) ─────────────────────────
test('3. no test sent GET /api/picks/<id>', () => {
  assert.ok(ALL.length > 40)
  const bad = ALL.flatMap((fb) => fb.calls).filter((c) => c.method === 'GET' && /^\/api\/picks\//.test(c.path))
  assert.deepEqual(bad, [])
})
