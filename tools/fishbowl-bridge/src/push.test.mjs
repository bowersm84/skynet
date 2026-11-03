// push.test.mjs — the gate, the dispatch table and the executor loop, no I/O. Run: node --test src/
import test from 'node:test'
import assert from 'node:assert/strict'
import { canPushFor, importsFor, runPushCommands } from './push.mjs'

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
    { id: 41, kind: 'mo_create', payload: { num: 'B80001' }, dry_run: false },
    { id: 42, kind: 'prices', payload: [['Product', 'Price'], ['SK4C5P', '1.00']], dry_run: false },
  ]
  const finished = []
  const sky = { pushNext: async () => queue.shift() || null, pushFinish: async (id, ok, result, error) => { finished.push({ id, ok, result, error }) } }
  const fb = { importRows: async () => { throw new Error('must not be called: the TEST host forces a dry run') } }
  const ran = await runPushCommands(fb, sky, { cfg: cfg({ sb: { url: 'https://ylzmyjjqibpbqbwjsnqj.supabase.co' } }), log: quiet, max: 3 })
  assert.equal(ran, 2)
  assert.deepEqual([finished[0].id, finished[0].ok, finished[0].error], [41, false, 'unknown push kind: mo_create'])
  assert.deepEqual([finished[1].id, finished[1].ok, finished[1].error], [42, true, null])
  assert.deepEqual(finished[1].result.imports, [{ name: 'Product-Pricing', rows: 1, sent: false }])
  assert.equal(finished[1].result.dry_run, true)
})
