// assemblyPostMath.test.mjs — the post card's words. Run: node --test src/lib/assemblyPostMath.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { postStatusText, postTone, mismatchSentences, moStateWords, needsPosting, postNote } from './assemblyPostMath.js'

test('status in words: ready, partly posted, posted, verified, mismatch', () => {
  assert.equal(postStatusText({ fb_post_status: 'ready_to_post', fb_posted_qty: 0, good_quantity: 9 }), 'Ready to post')
  assert.equal(postStatusText({ fb_post_status: 'ready_to_post', fb_posted_qty: 5, good_quantity: 9 }), 'Posted 5 of 9')
  assert.equal(postStatusText({ fb_post_status: 'posted', fb_posted_qty: 9, good_quantity: 9 }), 'Posted, waiting for the lot to show')
  assert.equal(postStatusText({ fb_post_status: 'verified' }), 'Verified')
  assert.equal(postStatusText({ fb_post_status: 'mismatch' }), 'Mismatch')
  assert.deepEqual(['ready', 'partial', 'posted', 'verified', 'mismatch'],
    [{ fb_post_status: 'ready_to_post' }, { fb_post_status: 'ready_to_post', fb_posted_qty: 2 }, { fb_post_status: 'posted' },
      { fb_post_status: 'verified' }, { fb_post_status: 'mismatch' }].map(postTone))
})

test('mismatch sentences: a wrong component lot, an extra lot, a missing lot, over-posting, a wrong finished lot', () => {
  assert.deepEqual(mismatchSentences({
    lots_missing: [{ part: 'SKYTEST-PIN', lot: '54285' }, { part: 'SKYTEST-CUP', lot: '100147' }],
    lots_unexpected: [{ part: 'SKYTEST-PIN', lot: '58663' }, { part: 'SKYTEST-STUD', lot: '100452' }],
    posted_qty: 10, expected_qty: 9,
    finished_lot_expected: '80003', finished_lot_found: false, finished_lots_seen: ['80004'],
  }), [
    'SkyNet recorded SKYTEST-CUP lot 100147; Fishbowl did not use it',
    'Fishbowl shows SKYTEST-PIN lot 58663; SkyNet recorded 54285',
    'Fishbowl shows SKYTEST-STUD lot 100452, which SkyNet did not record',
    'Posted 10, expected 9',
    'Finished lot 80003 not found; 80004 appeared',
  ])
  assert.deepEqual(mismatchSentences({ lots_missing: [], lots_unexpected: [], posted_qty: 9, expected_qty: 9, finished_lot_found: true }), [])
  assert.deepEqual(mismatchSentences(null), [])
  assert.deepEqual(mismatchSentences({ lots_unexpected: [{ part: 'P', lot: '1' }, { part: 'P', lot: '2' }], lots_missing: [{ part: 'P', lot: '3' }] }),
    ['Fishbowl shows P lots 1 and 2; SkyNet recorded 3'])
})

test('MO state words and the tab count rule', () => {
  assert.equal(moStateWords('linked'), 'linked by hand')
  assert.equal(moStateWords('closed_short'), 'closed short')
  assert.equal(moStateWords('none'), null)
  assert.deepEqual(['ready_to_post', 'posted', 'mismatch', 'verified'].map((s) => needsPosting({ fb_post_status: s })), [true, true, true, false])
})

// S17 D2a (D-ASM-61): the automatic post
test('the two new states: words, tone, the tab count, and the card note', () => {
  assert.equal(postStatusText({ fb_post_status: 'posting' }), 'Posting to Fishbowl')
  assert.equal(postStatusText({ fb_post_status: 'post_failed' }), 'Automatic post failed')
  assert.deepEqual(['posting', 'post_failed'], [{ fb_post_status: 'posting' }, { fb_post_status: 'post_failed' }].map(postTone))
  // a build the bridge is posting is not waiting for Ashley; a failed automatic post is
  assert.deepEqual(['posting', 'post_failed', 'ready_to_post', 'verified'].map((s) => needsPosting({ fb_post_status: s })), [false, true, true, false])
  assert.equal(postNote({ fb_post_status: 'post_failed', fb_post_error: 'Fishbowl is version 25.9; automatic posting needs 26.11 or later' }), 'Fishbowl is version 25.9; automatic posting needs 26.11 or later')
  assert.equal(postNote({ fb_post_status: 'ready_to_post', fb_post_error: 'Post by hand: a two-wave build is posted by hand' }), 'Post by hand: a two-wave build is posted by hand')
  assert.equal(postNote({ fb_post_status: 'ready_to_post', fb_post_error: null }), null)
  assert.equal(postNote({ fb_post_status: 'posting', fb_post_error: 'stale' }), null)
  assert.equal(postNote({ fb_post_status: 'verified', fb_post_error: 'stale' }), null)
  assert.equal(postNote(null), null)
})

test('mismatch sentences: quantity used per component, and scrap only when compared', () => {
  const base = { lots_missing: [], lots_unexpected: [], posted_qty: 9, expected_qty: 9, finished_lot_found: true }
  assert.deepEqual(mismatchSentences({ ...base, qty_used_off: [{ part: 'SKYTEST-PIN', expected: 10, used: 9 }], scrap_compared: true, scrap_expected: 1, scrap_posted: 0 }), [
    'Fishbowl used 9 of SKYTEST-PIN; the build used 10',
    'Fishbowl shows 0 scrapped; SkyNet recorded 1',
  ])
  // a hand post cannot record scrap: not compared, not mentioned
  assert.deepEqual(mismatchSentences({ ...base, qty_used_off: [], scrap_compared: false, scrap_expected: 1, scrap_posted: 0 }), [])
  assert.deepEqual(mismatchSentences({ ...base, scrap_compared: true, scrap_expected: 1, scrap_posted: 1 }), [])
})
