// push.test.mjs — the gate and the import mapping, no I/O. Run: node --test src/
import test from 'node:test'
import assert from 'node:assert/strict'
import { canPushFor, importsFor } from './push.mjs'

const names = { product: 'Product', rules: 'Pricing-Rules', treeCategories: 'Product-Tree-Categories', tree: 'Product-Tree', groups: 'Customer-Group-Relations' }
const cfg = (over = {}) => ({ sb: { url: 'https://luzungoqfuplspzbqctb.supabase.co' }, push: { enabled: true, allowedSbHost: 'luzungoqfuplspzbqctb.supabase.co' }, importNames: names, ...over })

test('a real push needs the flag AND the PROD host', () => {
  assert.equal(canPushFor(cfg()).ok, true)
  assert.equal(canPushFor(cfg({ push: { enabled: false, allowedSbHost: 'luzungoqfuplspzbqctb.supabase.co' } })).ok, false)
  const test_ = canPushFor(cfg({ sb: { url: 'https://ylzmyjjqibpbqbwjsnqj.supabase.co' } }))
  assert.equal(test_.ok, false)
  assert.match(test_.why, /ylzmyjjqibpbqbwjsnqj/)
})

test('tree pushes categories before memberships', () => {
  assert.deepEqual(importsFor('tree', cfg()).map((i) => i.name), ['Product-Tree-Categories', 'Product-Tree'])
  assert.deepEqual(importsFor('prices', cfg()).map((i) => i.name), ['Product'])
  assert.throws(() => importsFor('nope', cfg()), /unknown command kind/)
})
