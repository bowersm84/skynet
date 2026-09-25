// rulesTree.test.mjs — pure-function tests for the v1.7 mirrors (no I/O). Run: node --test src/
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPaths, mapRule } from './rulesTree.mjs'

const nodes = [
  { id: 1, name: 'Product', parentId: null },
  { id: 2, name: 'SkyNet', parentId: 1 },
  { id: 3, name: 'A', parentId: 2 },
  { id: 4, name: 'standard', parentId: 3 },
  { id: 5, name: 'Premier', parentId: 4 },
  { id: 9, name: 'Orphan', parentId: 77 }, // parent missing: path is just the name
]

test('buildPaths joins names with colons from the root', () => {
  const p = buildPaths(nodes)
  assert.equal(p.get(1), 'Product')
  assert.equal(p.get(4), 'Product:SkyNet:A:standard')
  assert.equal(p.get(5), 'Product:SkyNet:A:standard:Premier')
  assert.equal(p.get(9), 'Orphan')
})

test('buildPaths refuses a cycle instead of hanging', () => {
  assert.throws(() => buildPaths([{ id: 1, name: 'a', parentId: 2 }, { id: 2, name: 'b', parentId: 1 }]), /cycle/)
})

test('mapRule resolves a tree rule to its path and a product rule to its number', () => {
  const paths = buildPaths(nodes)
  const tree = mapRule({ id: '10', name: 'SN A std Q100', isActive: 1, productInclType: 'Product Tree', productInclId: '4', customerInclType: 'All',
    paApplies: 1, paType: 'Percent', paPercent: '96.0000', qtyApplies: 1, qtyMin: '100.000000000', qtyMax: '299.000000000' }, paths)
  assert.equal(tree.product, 'Product:SkyNet:A:standard')
  assert.equal(tree.paPercent, 96)
  assert.equal(tree.qtyMax, 299)
  assert.equal(tree.isActive, true)
  const prod = mapRule({ id: 11, name: 'SN K SK2600FW-SET1 T3', productInclType: 'Product', productInclId: 500, productNum: 'SK2600FW-SET1',
    customerInclType: 'Customer Group', customerName: 'SkyNet Tier 3', paType: 'Fixed price', paAmount: '10.97' }, paths)
  assert.equal(prod.product, 'SK2600FW-SET1')
  assert.equal(prod.customer, 'SkyNet Tier 3')
  assert.equal(prod.paAmount, 10.97)
  assert.equal(prod.isActive, true) // missing flag defaults to active, like Fishbowl's export
})
