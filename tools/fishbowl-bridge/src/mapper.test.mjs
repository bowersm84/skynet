// mapper.test.mjs — kit membership (D-FB-29 positional rule, D-FB-59 objecttoobject link), no I/O.
// Run: npm test (or node --test src/mapper.test.mjs)
import test from 'node:test'
import assert from 'node:assert/strict'
import { tagKitChildren, applyKitLinks } from './mapper.mjs'
import { q } from './queries.mjs'

const line = (id, soLineItem, typeId, productId) => ({ id, soLineItem, typeId, productId, parentId: null })

// Kit 900 (header line 1) is products 11 + 12; kit 901 (header line 3) is product 21. Kit 900's product 12 sits on
// line 5, after kit 901's header, so the positional rule (which follows the nearest header above) cannot place it;
// Fishbowl's link can. Line 6 is a loose line.
function order() {
  return [
    line(1001, 1, 80, 900),
    line(1002, 2, 10, 11),
    line(1003, 3, 80, 901),
    line(1004, 4, 10, 21),
    line(1005, 5, 10, 12),
    line(1006, 6, 10, 50),
  ]
}
const kitDefs = new Map([[900, new Map([[11, 1], [12, 1]])], [901, new Map([[21, 1]])]])
const parentOf = (lines, id) => lines.find((l) => l.id === id).parentId

test('a kit with a non-contiguous component gets the right header from objecttoobject', () => {
  const lines = order()
  tagKitChildren(lines, kitDefs)
  assert.equal(parentOf(lines, 1005), null) // the positional rule alone misses it
  assert.equal(applyKitLinks(lines, new Map([[1002, 1001], [1004, 1003], [1005, 1001]])), 3)
  assert.equal(parentOf(lines, 1005), 1001)
  assert.equal(parentOf(lines, 1002), 1001)
  assert.equal(parentOf(lines, 1004), 1003)
  assert.equal(parentOf(lines, 1006), null) // the loose line stays loose
})

test('a line without a link keeps the positional result', () => {
  const positional = order()
  tagKitChildren(positional, kitDefs)
  const linked = order()
  tagKitChildren(linked, kitDefs)
  applyKitLinks(linked, new Map([[1005, 1001]]))
  for (const id of [1002, 1004, 1006]) assert.equal(parentOf(linked, id), parentOf(positional, id))
  assert.equal(parentOf(linked, 1002), 1001)
  assert.equal(parentOf(linked, 1004), 1003)
})

test('a link to something that is not a kit header of the same order is ignored', () => {
  const lines = order()
  tagKitChildren(lines, kitDefs)
  assert.equal(applyKitLinks(lines, new Map([[1006, 1002], [1004, 77777]])), 0)
  assert.equal(parentOf(lines, 1006), null)
  assert.equal(parentOf(lines, 1004), 1003)
})

test('the link query reads objecttoobject typeId 30 for the batch lines only', () => {
  assert.match(q.kitLinks([111101, 111102]), /typeid = 30 AND recordid1 IN \(111101,111102\)/)
  assert.match(q.kitLinks([]), /IN \(NULL\)/)
})
