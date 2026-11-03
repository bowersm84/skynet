// tags.test.mjs — the v1.11 tag mirror: mapper, sweep removals and batching, no I/O.
// Run: npm test (or node --test src/tags.test.mjs)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mapTag, removedTags, syncTags, tagSweepDue } from './tags.mjs'
import { q } from './queries.mjs'

// SK4C5P's tag 139390 (lot 100252) as data-query returned it on 2026-11-04.
const TAG = {
  trackingType: 'Lot Number', tagId: 101180, partId: 6765, woItemId: null, tagLastModified: '2026-10-26T08:38:18.767-04',
  lotNumber: '100252', partNum: 'SK4C5P', qtyCommitted: 0, tagNum: 139390, locationId: 3, qty: 3156, location: 'Receiving',
  tagCreated: '2025-09-25T11:46:42.546-04', locationGroupId: 1,
}
const log = { info: () => {}, warn: () => {}, error: () => {} }

test('a tag maps to the fb_upsert_tags keys with its lot; a tag with no lot has no tracking type', () => {
  assert.deepEqual(mapTag(TAG), {
    tagId: 101180, tagNum: 139390, partId: 6765, partNum: 'SK4C5P', locationId: 3, location: 'Receiving', locationGroupId: 1,
    qty: 3156, qtyCommitted: 0, lotNumber: '100252', trackingType: 'Lot Number', woItemId: null,
    tagCreated: '2025-09-25T11:46:42.546-04:00', tagLastModified: '2026-10-26T08:38:18.767-04:00',
  })
  const bare = mapTag({ ...TAG, lotNumber: null, qty: '12.000000000', qtyCommitted: null })
  assert.equal(bare.lotNumber, null)
  assert.equal(bare.trackingType, null)
  assert.equal(bare.qty, 12)
  assert.equal(bare.qtyCommitted, 0)
})

test('a sweep removes only live in-scope mirror tags it did not see', () => {
  const open = [{ fb_tag_id: 101180, fb_part_id: 6765 }, { fb_tag_id: 5, fb_part_id: 6765 }, { fb_tag_id: 6, fb_part_id: 42 }]
  assert.deepEqual(removedTags(open, [101180], [6765]), [5]) // part 42 is out of scope: left alone
})

test('a sweep sends its removals and p_sweep on the last call only; a delta sends neither', async () => {
  const calls = []
  const rows = Array.from({ length: 3 }, (_, i) => ({ ...TAG, tagId: 100 + i, tagNum: 200 + i }))
  const fb = { query: async () => rows }
  const sky = { openTags: async () => [{ fb_tag_id: 7, fb_part_id: 6765 }], upsertTags: async (...a) => { calls.push(a); return a[0].length } }
  const r = await syncTags(fb, sky, { scope: [6765], since: null, log })
  assert.equal(r.sweep, true)
  assert.equal(r.removed, 1)
  assert.deepEqual(calls.map((c) => [c[0].length, c[1], c[2]]), [[3, [7], true]])

  calls.length = 0
  await syncTags(fb, sky, { scope: [6765], since: '2026-11-04 08:00:00', log })
  assert.deepEqual(calls.map((c) => [c[0].length, c[1], c[2]]), [[3, null, false]])
})

test('an empty delta still stamps the clock; an empty sweep over a full mirror is refused', async () => {
  const calls = []
  const sky = { openTags: async () => [{ fb_tag_id: 7, fb_part_id: 6765 }], upsertTags: async (...a) => { calls.push(a); return 0 } }
  await syncTags({ query: async () => [] }, sky, { scope: [6765], since: '2026-11-04 08:00:00', log })
  assert.deepEqual(calls, [[[], null, false]])
  await assert.rejects(syncTags({ query: async () => [] }, sky, { scope: [6765], since: null, log }), /refusing to mark the mirror removed/)
})

test('D-FB-62: the tag sweep is due when the stamp is older than the interval, and not otherwise', () => {
  const now = Date.parse('2026-11-04T15:00:00Z')
  assert.equal(tagSweepDue('2026-11-04T13:00:00+00:00', now, 3600000), true)  // two hours old
  assert.equal(tagSweepDue('2026-11-04T14:00:00+00:00', now, 3600000), true)  // exactly one interval
  assert.equal(tagSweepDue('2026-11-04T14:30:00+00:00', now, 3600000), false) // 30 min old
  assert.equal(tagSweepDue('2026-11-04 14:59:00+00', now, 3600000), false)    // Postgres text form
  assert.equal(tagSweepDue(null, now, 3600000), true)                         // never swept
  assert.equal(tagSweepDue('not a date', now, 3600000), true)
})

test('the tags query: delta by dateLastModified, sweep without it, lot from trackingtext partTrackingId 1', () => {
  assert.match(q.tags([6765], '2026-11-04 08:00:00'), /tag\.partId IN \(6765\) AND tag\.dateLastModified >= '2026-11-04 08:00:00'/)
  assert.doesNotMatch(q.tags([6765]), /dateLastModified >=/)
  assert.match(q.tags([6765]), /tt\.tagId = tag\.id AND tt\.partTrackingId = 1/)
  assert.match(q.tagScopeParts, /bi\.uomId <> 4/)
})
