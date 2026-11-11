// push.test.mjs — the gate, the dispatch table and the executor loop, no I/O. Run: node --test src/
import test from 'node:test'
import assert from 'node:assert/strict'
import { canPushFor, importsFor, runPushCommands, kindEnabled, moFenceRefusal } from './push.mjs'

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
