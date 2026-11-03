// postings.test.mjs — the v1.11 posting mirror (D-ASM-14 Invoiced), no I/O.
// Run: npm test (or node --test src/postings.test.mjs)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mapPosting, mapPostingItem, syncPostings } from './postings.mjs'
import { q } from './queries.mjs'

// SO 18934's posting as data-query returned it on 2026-11-04: postDate is the ship instant.
const POSTING = { totalTax: 0, soId: 11689, statusId: 50, journalPosted: false, extRefNumber: '', extTxnId: '', postSoId: 13124, postDate: '2026-10-08T08:45:34.477-04', datePosted: null, soNumber: '18934' }
const ITEMS = [
  { postSoItemId: 98174, soItemId: 108410, totalPrice: 1572, qty: 300, postSoId: 13124, shipItemId: 76375 },
  { postSoItemId: '98176', soItemId: '108409', totalPrice: '5166.000000000', qty: '422.000000000', postSoId: '13124', shipItemId: '76381' },
]
const log = { info: () => {}, warn: () => {}, error: () => {} }

test('a posting maps to the fb_upsert_postings keys; journalPosted is a boolean, blank refs are null', () => {
  assert.deepEqual(mapPosting(POSTING), {
    postSoId: 13124, soId: 11689, soNumber: '18934', postDate: '2026-10-08T08:45:34.477-04:00', datePosted: null,
    statusId: 50, extRefNumber: null, extTxnId: null, journalPosted: false, totalTax: 0,
  })
  assert.equal(mapPosting({ ...POSTING, journalPosted: 1 }).journalPosted, true)
  assert.deepEqual(ITEMS.map(mapPostingItem), [
    { postSoItemId: 98174, postSoId: 13124, soItemId: 108410, shipItemId: 76375, qty: 300, totalPrice: 1572 },
    { postSoItemId: 98176, postSoId: 13124, soItemId: 108409, shipItemId: 76381, qty: 422, totalPrice: 5166 },
  ])
})

test('each posting travels with its items; an empty poll still calls the RPC so the clock means "last polled"', async () => {
  const calls = []
  const sky = { upsertPostings: async (...a) => { calls.push(a); return a[0].length } }
  const fb = { query: async (sql) => (/FROM postsoitem/.test(sql) ? ITEMS : [POSTING]) }
  const r = await syncPostings(fb, sky, { since: '2026-11-04 08:00:00', log })
  assert.deepEqual(r, { postings: 1, items: 2, upserted: 1 })
  assert.deepEqual(calls.map((c) => [c[0].length, c[1].length]), [[1, 2]])
  calls.length = 0
  await syncPostings({ query: async () => [] }, sky, { since: '2026-11-04 08:00:00', log })
  assert.deepEqual(calls, [[[], []]])
})

test('the postings query: delta by dateLastModified, first load by postDate over 180 days', () => {
  assert.match(q.postings('2026-11-04 08:00:00'), /postso\.dateLastModified >= '2026-11-04 08:00:00'/)
  assert.match(q.postings(null), /postso\.postDate >= DATE_SUB\(NOW\(\), INTERVAL 180 DAY\)/)
  assert.match(q.postingItems([13124]), /postSOId AS postSoId/)
})
