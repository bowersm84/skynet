// mo.test.mjs — the MO commands against a fake Fishbowl, no I/O. Run: node --test src/mo.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { runMoCommand, MO_NUMBER_MAX } from './mo.mjs'
import { runPushCommands, resetMoHalt, moHaltState } from './push.mjs'

const quiet = { info: () => {}, warn: () => {}, error: () => {} }
const cfg = (mo = {}) => ({ host: 'test', version: 'x', sb: { url: 'https://ylzmyjjqibpbqbwjsnqj.supabase.co' },
  push: { enabled: false, allowedSbHost: 'luzungoqfuplspzbqctb.supabase.co', kinds: ['mo_create', 'mo_cancel', 'mo_close_short'] },
  mo: { enabled: true, dryRun: false, writePartPrefix: 'SKYTEST-', locationGroupId: 1, ...mo } })

// A fake Fishbowl: the probed BOM 2407 and whatever MOs a test puts in `mos`. Every REST call is recorded.
function fakeFishbowl({ boms, mos = [], answers = {} } = {}) {
  const bomTable = boms ?? [{ id: 2407, num: 'SKYTEST-STUD-ASSEMBLY', activeFlag: true,
    parts: ['SKYTEST-STUD-ASSEMBLY', 'SKYTEST-STUD', 'SKYTEST-SPRING', 'SKYTEST-CUP', 'SKYTEST-PIN'] }]
  const calls = []
  let nextId = 9000
  const fb = {
    calls,
    async query(sql) {
      let m
      if ((m = sql.match(/FROM bom WHERE num = '(.*)'/))) return bomTable.filter((b) => b.num === m[1].replace(/''/g, "'")).map(({ parts, ...b }) => b)
      if ((m = sql.match(/bi\.bomId = (\d+)/))) return (bomTable.find((b) => b.id === Number(m[1]))?.parts ?? []).map((partNum) => ({ partNum }))
      if ((m = sql.match(/mo\.num = '(.*)'/))) return mos.filter((x) => x.num === m[1]).map(({ id, num, statusId }) => ({ id, num, statusId }))
      if ((m = sql.match(/mo\.id = (\d+)/))) return mos.filter((x) => x.id === Number(m[1])).map(({ id, num, statusId }) => ({ id, num, statusId }))
      if ((m = sql.match(/mi\.moId = (\d+)/))) {
        const mo = mos.find((x) => x.id === Number(m[1]))
        if (!mo) return []
        const parts = bomTable.find((b) => b.num === mo.bom)?.parts ?? mo.parts ?? []
        return [{ typeId: 50, qtyFulfilled: 0, bomNum: mo.bom, partNum: null },
          ...parts.map((p, i) => ({ typeId: i === 0 ? 10 : 20, qtyFulfilled: mo.fulfilled && i === 0 ? mo.fulfilled : 0, bomNum: mo.bom, partNum: p }))]
      }
      throw new Error(`fake fishbowl: unexpected query ${sql}`)
    },
    async call(method, path, body) {
      calls.push({ method, path, body })
      const key = `${method} ${path.replace(/\d+/g, ':id')}`
      if (answers[key]) return answers[key](body, path)
      if (key === 'POST /api/manufacture-orders') {
        const mo = { id: nextId++, num: body.number, statusId: 10, bom: bomTable.find((b) => b.id === body.configurations[0].bom.id)?.num }
        mos.push(mo)
        return { status: 200, body: { id: mo.id, number: mo.num, status: 'Entered' } }
      }
      const id = Number(path.match(/manufacture-orders\/(\d+)/)?.[1])
      const mo = mos.find((x) => x.id === id)
      if (key === 'POST /api/manufacture-orders/:id/issue') { mo.statusId = 20; return { status: 200, body: { id, number: mo.num, status: 'Issued' } } }
      if (key === 'POST /api/manufacture-orders/:id/unissue') { mo.statusId = 10; return { status: 200, body: { id, number: mo.num, status: 'Entered' } } }
      if (key === 'POST /api/manufacture-orders/:id/close-short') { mo.statusId = 70; return { status: 200, body: { id, number: mo.num, status: 'Closed Short' } } }
      if (key === 'DELETE /api/manufacture-orders/:id') {
        if (mo.statusId !== 10) return { status: 400, body: { message: 'The manufacture order status must be Entered in order to be deleted.' } }
        mos.splice(mos.indexOf(mo), 1)
        return { status: 200, body: null }
      }
      if (key === 'GET /api/manufacture-orders/:id') return mo ? { status: 200, body: { id, number: mo.num } } : { status: 404, body: null }
      throw new Error(`fake fishbowl: unexpected call ${key}`)
    },
  }
  return fb
}

const create = (over = {}) => ({ id: 1, kind: 'mo_create', dry_run: false, payload: {
  build_id: 'b1', build_number: 'AB-00015', mo_number: 'SKYTEST-AB-00015', bom_number: 'SKYTEST-STUD-ASSEMBLY',
  quantity: 9, issue: true, note: 'SkyNet assembly build AB-00015 (stock)', write_part_prefix: 'SKYTEST-', ...over } })
const writes = (fb) => fb.calls.filter((c) => c.method !== 'GET')

test('mo_create: no MO yet -> the probed body, then issue; answers id, number, Issued, created', async () => {
  const fb = fakeFishbowl()
  const r = await runMoCommand(fb, create(), { cfg: cfg(), log: quiet, dryRun: false })
  assert.deepEqual(writes(fb).map((c) => `${c.method} ${c.path}`), ['POST /api/manufacture-orders', 'POST /api/manufacture-orders/9000/issue'])
  assert.deepEqual(fb.calls[0].body, { number: 'SKYTEST-AB-00015', locationGroup: { id: 1 }, note: 'SkyNet assembly build AB-00015 (stock)',
    configurations: [{ bom: { id: 2407 }, quantity: '9' }] })
  assert.deepEqual([r.fb_mo_id, r.mo_number, r.status, r.created], [9000, 'SKYTEST-AB-00015', 'Issued', true])
})

test('mo_create: an MO that already has the number is reused, never created twice', async () => {
  const issued = fakeFishbowl({ mos: [{ id: 77, num: 'SKYTEST-AB-00015', statusId: 20, bom: 'SKYTEST-STUD-ASSEMBLY' }] })
  const r1 = await runMoCommand(issued, create(), { cfg: cfg(), log: quiet, dryRun: false })
  assert.equal(writes(issued).length, 0)
  assert.deepEqual([r1.fb_mo_id, r1.status, r1.created], [77, 'Issued', false])
  const entered = fakeFishbowl({ mos: [{ id: 78, num: 'SKYTEST-AB-00015', statusId: 10, bom: 'SKYTEST-STUD-ASSEMBLY' }] })
  const r2 = await runMoCommand(entered, create(), { cfg: cfg(), log: quiet, dryRun: false })
  assert.deepEqual(writes(entered).map((c) => c.path), ['/api/manufacture-orders/78/issue']) // issued, not created
  assert.deepEqual([r2.fb_mo_id, r2.status, r2.created], [78, 'Issued', false])
})

test('mo_create fence: a BOM outside SKYTEST-, a payload prefix that differs, or an off-prefix part -> refused, nothing written', async () => {
  const fb = fakeFishbowl({ boms: [
    { id: 1095, num: 'SK40S5-12S', activeFlag: true, parts: ['SK40S5-12S', 'SK4C12P'] },
    { id: 3000, num: 'SKYTEST-MIXED', activeFlag: true, parts: ['SKYTEST-MIXED', 'SK4C12P'] },
  ] })
  await assert.rejects(runMoCommand(fb, create({ bom_number: 'SK40S5-12S' }), { cfg: cfg(), log: quiet, dryRun: false }), /BOM "SK40S5-12S" does not start with "SKYTEST-"/)
  await assert.rejects(runMoCommand(fb, create({ write_part_prefix: 'SK' }), { cfg: cfg(), log: quiet, dryRun: false }), /payload write_part_prefix "SK" is not this bridge's "SKYTEST-"/)
  await assert.rejects(runMoCommand(fb, create({ bom_number: 'SKYTEST-MIXED' }), { cfg: cfg(), log: quiet, dryRun: false }), /part\(s\) outside "SKYTEST-": SK4C12P/)
  await assert.rejects(runMoCommand(fb, create(), { cfg: cfg({ writePartPrefix: '' }), log: quiet, dryRun: false }), /FB_WRITE_PART_PREFIX is not set/)
  assert.equal(fb.calls.length, 0)
})

test('mo_create refuses a number Fishbowl would cut short, an inactive or missing BOM, a bad quantity', async () => {
  const fb = fakeFishbowl({ boms: [{ id: 5, num: 'SKYTEST-OLD', activeFlag: false, parts: ['SKYTEST-OLD'] }] })
  const long = 'SKYTEST-' + 'X'.repeat(MO_NUMBER_MAX - 7)
  await assert.rejects(runMoCommand(fb, create({ mo_number: long }), { cfg: cfg(), log: quiet, dryRun: false }), /longer than 25 characters/)
  await assert.rejects(runMoCommand(fb, create({ bom_number: 'SKYTEST-OLD' }), { cfg: cfg(), log: quiet, dryRun: false }), /is not active/)
  await assert.rejects(runMoCommand(fb, create({ bom_number: 'SKYTEST-NONE' }), { cfg: cfg(), log: quiet, dryRun: false }), /is not in Fishbowl/)
  await assert.rejects(runMoCommand(fb, create({ quantity: 0 }), { cfg: cfg(), log: quiet, dryRun: false }), /not a whole number above 0/)
  await assert.rejects(runMoCommand(fb, create({ mo_number: "SKYTEST-1'; DROP" }), { cfg: cfg(), log: quiet, dryRun: false }), /characters the bridge will not send/)
  assert.equal(fb.calls.length, 0)
})

test('mo_create dry run: reads, logs the body, writes nothing', async () => {
  const fb = fakeFishbowl()
  const r = await runMoCommand(fb, create(), { cfg: cfg(), log: quiet, dryRun: true })
  assert.equal(fb.calls.length, 0)
  assert.equal(r.fb_mo_id, null)
  assert.deepEqual(r.would.map((w) => w.call), ['POST /api/manufacture-orders', 'POST /api/manufacture-orders/<new id>/issue'])
})

test('mo_cancel: gone already -> deleted; Issued -> unissue then delete; anything fulfilled -> refused', async () => {
  const cancel = (over = {}) => ({ id: 2, kind: 'mo_cancel', dry_run: false, payload: { build_id: 'b1', build_number: 'AB-00015', mo_number: 'SKYTEST-AB-00015', fb_mo_id: 77, write_part_prefix: 'SKYTEST-', ...over } })
  const none = fakeFishbowl()
  assert.deepEqual((await runMoCommand(none, cancel(), { cfg: cfg(), log: quiet, dryRun: false })).deleted, true)
  assert.equal(none.calls.length, 0)

  const issued = fakeFishbowl({ mos: [{ id: 77, num: 'SKYTEST-AB-00015', statusId: 20, bom: 'SKYTEST-STUD-ASSEMBLY' }] })
  const r = await runMoCommand(issued, cancel(), { cfg: cfg(), log: quiet, dryRun: false })
  assert.deepEqual(issued.calls.map((c) => `${c.method} ${c.path}`), ['POST /api/manufacture-orders/77/unissue', 'DELETE /api/manufacture-orders/77', 'GET /api/manufacture-orders/77'])
  assert.deepEqual([r.deleted, r.existed], [true, true])

  const fulfilled = fakeFishbowl({ mos: [{ id: 77, num: 'SKYTEST-AB-00015', statusId: 50, fulfilled: 4, bom: 'SKYTEST-STUD-ASSEMBLY' }] })
  await assert.rejects(runMoCommand(fulfilled, cancel(), { cfg: cfg(), log: quiet, dryRun: false }), /has fulfilled quantity/)
  assert.equal(fulfilled.calls.length, 0)

  const other = fakeFishbowl({ mos: [{ id: 77, num: 'SKYTEST-AB-00099', statusId: 20, bom: 'SKYTEST-STUD-ASSEMBLY' }] })
  await assert.rejects(runMoCommand(other, cancel(), { cfg: cfg(), log: quiet, dryRun: false }), /is SKYTEST-AB-00099, not SKYTEST-AB-00015/)
  const outside = fakeFishbowl({ mos: [{ id: 77, num: 'SKYTEST-AB-00015', statusId: 20, bom: 'SK40S5-12S', parts: ['SK40S5-12S'] }] })
  await assert.rejects(runMoCommand(outside, cancel(), { cfg: cfg(), log: quiet, dryRun: false }), /does not start with "SKYTEST-"/)
  assert.equal(other.calls.length + outside.calls.length, 0)
})

test('mo_close_short closes an Issued MO by id', async () => {
  const fb = fakeFishbowl({ mos: [{ id: 77, num: 'SKYTEST-AB-00015', statusId: 50, bom: 'SKYTEST-STUD-ASSEMBLY' }] })
  const r = await runMoCommand(fb, { id: 3, kind: 'mo_close_short', payload: { fb_mo_id: 77, mo_number: 'SKYTEST-AB-00015', write_part_prefix: 'SKYTEST-' } }, { cfg: cfg(), log: quiet, dryRun: false })
  assert.deepEqual(fb.calls.map((c) => c.path), ['/api/manufacture-orders/77/close-short'])
  assert.deepEqual([r.closed, r.status], [true, 'Closed Short'])
})

test('executor: FB_MO_ENABLED off -> forced dry run; an unexpected answer stops every later MO command; the MO is re-read', async () => {
  resetMoHalt()
  const finished = []
  const queue = (cmds) => ({ pushNext: async () => cmds.shift() || null, pushFinish: async (id, ok, result, error) => { finished.push({ id, ok, result, error }) } })

  const off = fakeFishbowl()
  await runPushCommands(off, queue([create()]), { cfg: cfg({ enabled: false }), log: quiet, max: 3 })
  assert.equal(off.calls.length, 0)
  assert.deepEqual([finished[0].ok, finished[0].result.dry_run, finished[0].result.forced, finished[0].result.reason], [true, true, true, 'FB_MO_ENABLED is not true'])

  finished.length = 0
  const refreshed = []
  const good = fakeFishbowl()
  await runPushCommands(good, queue([create()]), { cfg: cfg(), log: quiet, max: 3, refreshMo: async (ids) => { refreshed.push(...ids) } })
  assert.deepEqual([finished[0].ok, finished[0].result.fb_mo_id, finished[0].result.dry_run], [true, 9000, false])
  assert.deepEqual(refreshed, [9000])

  finished.length = 0
  refreshed.length = 0
  const removed = []
  const toCancel = fakeFishbowl({ mos: [{ id: 77, num: 'SKYTEST-AB-00015', statusId: 20, bom: 'SKYTEST-STUD-ASSEMBLY' }] })
  const cancelCmd = { id: 9, kind: 'mo_cancel', dry_run: false, payload: { mo_number: 'SKYTEST-AB-00015', fb_mo_id: 77, write_part_prefix: 'SKYTEST-' } }
  await runPushCommands(toCancel, queue([cancelCmd]), { cfg: cfg(), log: quiet, max: 3,
    refreshMo: async (ids) => { refreshed.push(...ids) }, removeMo: async (ids) => { removed.push(...ids); return ids.length } })
  assert.deepEqual([finished[0].ok, finished[0].result.deleted, removed, refreshed], [true, true, [77], []]) // marked removed, not re-read

  finished.length = 0
  const bad = fakeFishbowl({ answers: { 'POST /api/manufacture-orders': () => ({ status: 200, body: { id: 5, number: 'SKYTEST-AB-0001', status: 'Entered' } }) } })
  await runPushCommands(bad, queue([create({ mo_number: 'SKYTEST-AB-00015' }), create({ mo_number: 'SKYTEST-AB-00016' })]), { cfg: cfg(), log: quiet, max: 3 })
  assert.equal(finished[0].ok, false)
  assert.match(finished[0].error, /came back as "SKYTEST-AB-0001".*stopped on this bridge/)
  assert.equal(finished[1].ok, false)
  assert.match(finished[1].error, /MO writes are stopped on this bridge since command #1/)
  assert.equal(bad.calls.length, 1) // the second command never reached Fishbowl
  assert.equal(moHaltState().id, 1)
  resetMoHalt()
})
