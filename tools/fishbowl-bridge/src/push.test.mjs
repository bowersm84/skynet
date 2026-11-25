// push.test.mjs — the gate, the dispatch table and the executor loop, no I/O. Run: node --test src/
import test from 'node:test'
import assert from 'node:assert/strict'
import { canPushFor, importsFor, runPushCommands, kindEnabled, moFenceRefusal, resetMoHalt, moHaltState, woPostGate } from './push.mjs'
import { fakeFishbowl, world, cmd as woPostCmd } from './woPostFake.mjs'

const names = { product: 'Product-Pricing', rules: 'Pricing-Rules', treeCategories: 'Product-Tree-Categories', tree: 'Product-Tree', groups: 'Customer-Group-Relations' }
const cfg = (over = {}) => ({ sb: { url: 'https://luzungoqfuplspzbqctb.supabase.co' }, push: { enabled: true, allowedSbHost: 'luzungoqfuplspzbqctb.supabase.co' }, importNames: names, host: 'test', version: 'x', ...over })
const quiet = { info: () => {}, warn: () => {}, error: () => {} }

test('a real push needs the flag AND the PROD host', () => {
  assert.equal(canPushFor(cfg()).ok, true)
  assert.equal(canPushFor(cfg({ push: { enabled: false, allowedSbHost: 'luzungoqfuplspzbqctb.supabase.co' } })).ok, false)
  const test_ = canPushFor(cfg({ sb: { url: 'https://ylzmyjjqibpbqbwjsnqj.supabase.co' } }))
  assert.equal(test_.ok, false)
  assert.match(test_.why, /ylzmyjjqibpbqbwjsnqj/)
})

test('the four pricing kinds dispatch to the same import names as before; tree posts categories first', () => {
  assert.deepEqual(importsFor('prices', cfg()).map((i) => i.name), ['Product-Pricing'])
  assert.deepEqual(importsFor('rules', cfg()).map((i) => i.name), ['Pricing-Rules'])
  assert.deepEqual(importsFor('tree', cfg()).map((i) => [i.name, i.key]), [['Product-Tree-Categories', 'categories'], ['Product-Tree', 'members']])
  assert.deepEqual(importsFor('groups', cfg()).map((i) => i.name), ['Customer-Group-Relations'])
  assert.throws(() => importsFor('nope', cfg()), /unknown push kind: nope/)
  assert.throws(() => importsFor('toString', cfg()), /unknown push kind/) // no prototype keys
})

test('an unknown kind is finished failed with a clear error and the executor carries on', async () => {
  const queue = [
    { id: 41, kind: 'mo_note', payload: { num: 'B80001' }, dry_run: false },
    { id: 42, kind: 'prices', payload: [['Product', 'Price'], ['SK4C5P', '1.00']], dry_run: false },
  ]
  const finished = []
  const sky = { pushNext: async () => queue.shift() || null, pushFinish: async (id, ok, result, error) => { finished.push({ id, ok, result, error }) } }
  const fb = { importRows: async () => { throw new Error('must not be called: the TEST host forces a dry run') } }
  const kinds = ['prices', 'rules', 'tree', 'groups', 'mo_note'] // allowed here, but this bridge has no handler for it
  const ran = await runPushCommands(fb, sky, { cfg: cfg({ sb: { url: 'https://ylzmyjjqibpbqbwjsnqj.supabase.co' }, push: { enabled: true, allowedSbHost: 'luzungoqfuplspzbqctb.supabase.co', kinds } }), log: quiet, max: 3 })
  assert.equal(ran, 2)
  assert.deepEqual([finished[0].id, finished[0].ok, finished[0].error], [41, false, 'unknown push kind: mo_note'])
  assert.deepEqual([finished[1].id, finished[1].ok, finished[1].error], [42, true, null])
  assert.deepEqual(finished[1].result.imports, [{ name: 'Product-Pricing', rows: 1, sent: false }])
  assert.equal(finished[1].result.dry_run, true)
})

test('FB_PUSH_KINDS: without it, only the four pricing kinds; with the TEST MO list, no pricing kind', () => {
  for (const k of ['prices', 'rules', 'tree', 'groups']) assert.equal(kindEnabled(k, cfg()), true)
  for (const k of ['mo_create', 'mo_cancel', 'mo_close_short', 'toString', '', null]) assert.equal(kindEnabled(k, cfg()), false)
  const moOnly = cfg({ push: { enabled: false, allowedSbHost: 'luzungoqfuplspzbqctb.supabase.co', kinds: ['mo_create', 'mo_cancel', 'mo_close_short'] } })
  for (const k of ['prices', 'rules', 'tree', 'groups']) assert.equal(kindEnabled(k, moOnly), false)
  for (const k of ['mo_create', 'mo_cancel', 'mo_close_short']) assert.equal(kindEnabled(k, moOnly), true)
  assert.equal(kindEnabled('prices', cfg({ push: { kinds: [] } })), false) // FB_PUSH_KINDS set to nothing: nothing runs
})

test('a kind not on the allowlist is finished failed and never executed, even with every write switch on', async () => {
  const queue = [
    { id: 51, kind: 'prices', payload: [['Product', 'Price'], ['SK4C5P', '1.00']], dry_run: false },
    { id: 52, kind: 'rules', payload: [['name'], ['SN x']], dry_run: false },
  ]
  const finished = []
  const sky = { pushNext: async () => queue.shift() || null, pushFinish: async (id, ok, result, error) => { finished.push({ id, ok, result, error }) } }
  const fb = { importRows: async () => { throw new Error('must not be called: the kind is not enabled') } }
  const on = cfg({ push: { enabled: true, allowedSbHost: 'luzungoqfuplspzbqctb.supabase.co', kinds: ['mo_create', 'mo_cancel', 'mo_close_short'] } })
  assert.equal(canPushFor(on).ok, true) // the pricing gate would allow a real push here; the allowlist still refuses
  const ran = await runPushCommands(fb, sky, { cfg: on, log: quiet, max: 3 })
  assert.equal(ran, 2)
  assert.deepEqual(finished.map((f) => [f.id, f.ok, f.error, f.result.executed]), [
    [51, false, 'kind not enabled on this bridge: prices', false],
    [52, false, 'kind not enabled on this bridge: rules', false],
  ])
})

test('the MO write fence: prefix set, payload prefix equal, BOM starts with it', () => {
  const c = (p) => ({ mo: { writePartPrefix: p } })
  assert.equal(moFenceRefusal({ write_part_prefix: 'SKYTEST-' }, 'SKYTEST-STUD-ASSEMBLY', c('SKYTEST-')), null)
  assert.match(moFenceRefusal({ write_part_prefix: 'SKYTEST-' }, 'SK4C5P-ASSY', c('SKYTEST-')), /BOM "SK4C5P-ASSY" does not start with "SKYTEST-"/)
  assert.match(moFenceRefusal({ write_part_prefix: 'SK' }, 'SKYTEST-STUD-ASSEMBLY', c('SKYTEST-')), /payload write_part_prefix "SK" is not/)
  assert.match(moFenceRefusal({}, 'SKYTEST-STUD-ASSEMBLY', c('SKYTEST-')), /payload write_part_prefix null/)
  assert.match(moFenceRefusal({ write_part_prefix: '' }, 'SKYTEST-STUD-ASSEMBLY', c('')), /FB_WRITE_PART_PREFIX is not set/)
  assert.match(moFenceRefusal({ write_part_prefix: 'SKYTEST-' }, null, c('SKYTEST-')), /BOM null/)
})

// ── S17 D2a (D-ASM-61): wo_post through the executor ─────────────────────────────────────────────────────────
const postCfg = (mo = {}, kinds = ['mo_create', 'mo_cancel', 'mo_close_short', 'wo_post']) => cfg({
  sb: { url: 'https://ylzmyjjqibpbqbwjsnqj.supabase.co' }, push: { enabled: false, allowedSbHost: 'luzungoqfuplspzbqctb.supabase.co', kinds },
  mo: { enabled: true, dryRun: false, writePartPrefix: 'SKYTEST-', locationGroupId: 1, postEnabled: true, postMinVersion: '26.11', postTimeoutMs: 120000, ...mo },
})
const queueOf = (cmds, finished) => ({ pushNext: async () => cmds.shift() || null, pushFinish: async (id, ok, result, error) => { finished.push({ id, ok, result, error }) } })

test('wo_post not in FB_PUSH_KINDS is finished failed, never executed', async () => {
  resetMoHalt()
  const finished = []
  const fb = fakeFishbowl()
  await runPushCommands(fb, queueOf([woPostCmd()], finished), { cfg: postCfg({}, ['mo_create', 'mo_cancel', 'mo_close_short']), log: quiet, max: 3, fishbowlVersion: '26.11' })
  assert.deepEqual([finished[0].ok, finished[0].error, finished[0].result.executed], [false, 'kind not enabled on this bridge: wo_post', false])
  assert.equal(fb.calls.length + fb.queries.length, 0)
})

test('FB_WO_POST_ENABLED off -> a forced dry run with the reason, finished done with dry_run true; nothing sent', async () => {
  resetMoHalt()
  assert.deepEqual(woPostGate(postCfg({ postEnabled: false })), { write: false, why: 'FB_WO_POST_ENABLED is not true' })
  assert.deepEqual(woPostGate(postCfg({ enabled: false })), { write: false, why: 'FB_MO_ENABLED is not true' })
  assert.deepEqual(woPostGate(postCfg()), { write: true, why: null })
  const finished = []
  const fb = fakeFishbowl()
  const tagsRuns = []
  await runPushCommands(fb, queueOf([woPostCmd()], finished), { cfg: postCfg({ postEnabled: false }), log: quiet, max: 3, fishbowlVersion: '26.11',
    refreshMo: async () => { throw new Error('a dry run refreshes nothing') }, refreshTags: async () => { tagsRuns.push(1) } })
  assert.deepEqual([finished[0].ok, finished[0].result.dry_run, finished[0].result.forced, finished[0].result.reason], [true, true, true, 'FB_WO_POST_ENABLED is not true'])
  assert.ok(Array.isArray(finished[0].result.would) && finished[0].result.would.length === 5)
  assert.equal(fb.calls.length, 0)
  assert.deepEqual(tagsRuns, [])
})

test('a real post re-reads the MO and polls the tags once; the Fishbowl version reaches the handler', async () => {
  resetMoHalt()
  const finished = []
  const refreshed = []
  const tagsRuns = []
  const fb = fakeFishbowl()
  await runPushCommands(fb, queueOf([woPostCmd()], finished), { cfg: postCfg(), log: quiet, max: 3, fishbowlVersion: '26.11',
    refreshMo: async (ids) => { refreshed.push(...ids) }, refreshTags: async () => { tagsRuns.push(1) } })
  assert.deepEqual([finished[0].ok, finished[0].result.dry_run, finished[0].result.status, finished[0].result.finished_lot], [true, false, 'Fulfilled', '80004'])
  assert.deepEqual([refreshed, tagsRuns.length], [[5723], 1])
  finished.length = 0
  await runPushCommands(fakeFishbowl(), queueOf([woPostCmd()], finished), { cfg: postCfg(), log: quiet, max: 3, fishbowlVersion: '25.9' })
  assert.deepEqual([finished[0].ok, /Fishbowl is version 25\.9/.test(finished[0].error)], [false, true])
})

test('a halt set by an MO command also stops wo_post', async () => {
  resetMoHalt()
  const finished = []
  const fb = fakeFishbowl()
  const badCreate = { id: 61, kind: 'mo_create', dry_run: false, payload: { mo_number: 'SKYTEST-AB-00030', bom_number: 'SKYTEST-STUD-ASSEMBLY', quantity: 2, issue: true, write_part_prefix: 'SKYTEST-' } }
  // the MO command meets an answer the probe never saw (the BOM read fails as Fishbowl would not) -> halt
  const moFb = {
    calls: [],
    async query(sql) {
      if (/FROM bom WHERE num/.test(sql)) return [{ id: 2407, num: 'SKYTEST-STUD-ASSEMBLY', activeFlag: true }]
      if (/bi\.bomId = 2407/.test(sql)) return [{ partNum: 'SKYTEST-STUD-ASSEMBLY' }, { partNum: 'SKYTEST-STUD' }]
      if (/mo\.num = /.test(sql)) return []
      return fb.query(sql)
    },
    async call(method, path, body, t) {
      this.calls.push({ method, path })
      if (path === '/api/manufacture-orders') return { status: 500, body: { message: 'boom' } }
      return fb.call(method, path, body, t)
    },
  }
  await runPushCommands(moFb, queueOf([badCreate, woPostCmd()], finished), { cfg: postCfg(), log: quiet, max: 3, fishbowlVersion: '26.11' })
  assert.equal(finished[0].ok, false)
  assert.equal(moHaltState().id, 61)
  assert.equal(finished[1].ok, false)
  assert.match(finished[1].error, /MO writes are stopped on this bridge since command #61/)
  assert.deepEqual(moFb.calls.map((c) => c.path), ['/api/manufacture-orders']) // wo_post sent nothing
  resetMoHalt()
})

test('D-ASM-62: a wo_post refused for a lot in another location sets no halt; the next MO command in the same run executes', async () => {
  resetMoHalt()
  const finished = []
  // the post: Fishbowl sources the PIN line from location 5 once the pick is started; lot 58663 is only in Stock
  const fb = fakeFishbowl(world((w) => {
    w.answers['POST /api/picks/:id/start'] = (b, x) => {
      x.picks[0].statusId = 20
      x.lines.forEach((l) => { l.statusId = 20; l.srcLocationId = l.partNum === 'SKYTEST-PIN' ? 5 : 1; l.srcLocationName = l.partNum === 'SKYTEST-PIN' ? 'Shelf B' : 'Stock' })
      return { status: 200, body: { status: 'Started' } }
    }
  }))
  // the MO command after it: a new MO on the test BOM
  const both = {
    calls: [],
    async query(sql) {
      if (/FROM bom WHERE num/.test(sql)) return [{ id: 2407, num: 'SKYTEST-STUD-ASSEMBLY', activeFlag: true }]
      if (/bi\.bomId = 2407/.test(sql)) return [{ partNum: 'SKYTEST-STUD-ASSEMBLY' }, { partNum: 'SKYTEST-STUD' }]
      if (/mo\.num = 'SKYTEST-AB-00031'/.test(sql)) return []
      return fb.query(sql)
    },
    async call(method, path, body, t) {
      this.calls.push(`${method} ${path}`)
      if (path === '/api/manufacture-orders') return { status: 200, body: { id: 5800, number: body.number, status: 'Entered' } }
      if (path === '/api/manufacture-orders/5800/issue') return { status: 200, body: { id: 5800, number: 'SKYTEST-AB-00031', status: 'Issued' } }
      return fb.call(method, path, body, t)
    },
  }
  const nextMo = { id: 72, kind: 'mo_create', dry_run: false, payload: { mo_number: 'SKYTEST-AB-00031', bom_number: 'SKYTEST-STUD-ASSEMBLY', quantity: 2, issue: true, write_part_prefix: 'SKYTEST-' } }
  await runPushCommands(both, queueOf([woPostCmd(), nextMo], finished), { cfg: postCfg(), log: quiet, max: 3, fishbowlVersion: '26.11' })
  assert.equal(finished[0].ok, false)
  assert.match(finished[0].error, /SKYTEST-PIN lot 58663 is in Stock \(location 1\), but Fishbowl sourced the pick line from Shelf B \(location 5\)\. The pick was started and nothing else was written; post this build by hand/)
  assert.equal(finished[0].result.halted, false)
  assert.equal(moHaltState(), null)
  assert.deepEqual([finished[1].id, finished[1].ok, finished[1].result.fb_mo_id, finished[1].result.status], [72, true, 5800, 'Issued'])
  assert.deepEqual(both.calls, ['POST /api/picks/21700/start', 'POST /api/legacy/external/GetPickRq',
    'POST /api/manufacture-orders', 'POST /api/manufacture-orders/5800/issue'])
  resetMoHalt()
})
