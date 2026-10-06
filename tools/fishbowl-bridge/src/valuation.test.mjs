// valuation.test.mjs — the valuation mapper, no I/O. Run: npm test (or node --test src/valuation.test.mjs)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mapPartValuation, normalizeClass, classCounts, UNCLASSIFIED } from './valuation.mjs'

test('a Product row maps to the RPC keys with Fishbowl strings coerced', () => {
  const m = mapPartValuation({
    partId: '1234', partNum: ' SK2600CGP174 ', description: 'SK2600 SERIES PIN 17-4', activeFlag: 1,
    valuationClass: 'Product', qtyOnHand: '126985.000000000', avgCost: '0.050500000', totalCost: '6412.74',
    costLayerQty: '126985.000000000', hasProduct: 'Y', usedInBoms: 'N',
  })
  assert.deepEqual(m, {
    partNum: 'SK2600CGP174', partId: 1234, description: 'SK2600 SERIES PIN 17-4', activeFlag: true,
    valuationClass: 'Product', qtyOnHand: 126985, avgCost: 0.0505, totalCost: 6412.74, costLayerQty: 126985,
    hasProduct: true, usedInBoms: false,
  })
})

test('a part Fishbowl has never classed or costed lands as unclassified with nulls, not NaN', () => {
  const m = mapPartValuation({ partId: 7, partNum: 'SK26CWING3', description: null, activeFlag: '0', valuationClass: '', qtyOnHand: null, avgCost: null, totalCost: '0E-9', costLayerQty: null, hasProduct: 'N', usedInBoms: 'Y' })
  assert.equal(m.valuationClass, UNCLASSIFIED)
  assert.equal(m.qtyOnHand, 0)
  assert.equal(m.avgCost, null)
  assert.equal(m.totalCost, 0)
  assert.equal(m.activeFlag, false)
  assert.equal(m.hasProduct, false)
  assert.equal(m.usedInBoms, true)
  assert.equal(normalizeClass('  Tooling - MRO '), 'Tooling - MRO')
  assert.equal(normalizeClass(undefined), UNCLASSIFIED)
})

test('rows without a part number are the caller\'s to drop; class counts add up', () => {
  const rows = [
    mapPartValuation({ partNum: 'A', valuationClass: 'Product' }),
    mapPartValuation({ partNum: 'B', valuationClass: 'Product' }),
    mapPartValuation({ partNum: 'C', valuationClass: 'Non-Product' }),
    mapPartValuation({ partNum: null, valuationClass: 'Product' }),
  ]
  assert.equal(rows[3].partNum, '')
  assert.deepEqual(classCounts(rows.filter((r) => r.partNum !== '')), { Product: 2, 'Non-Product': 1 })
  assert.deepEqual(classCounts(null), {})
})
