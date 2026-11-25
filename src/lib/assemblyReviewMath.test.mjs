// assemblyReviewMath.test.mjs — the release review's rules (D-ASM-63). Run: node --test src/lib/assemblyReviewMath.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewNotes, postSentence, releaseProblems, sendBackProblems, releasedMessage, readingsText, stepState } from './assemblyReviewMath.js'

const when = (iso) => `[${iso}]`
const review = (over = {}, build = {}) => ({
  build: { id: 'b1', build_number: 'AB-00021', part_number: 'SKYTEST-STUD-ASSEMBLY', build_kind: 'stock', status: 'complete',
    quantity: 10, good_quantity: 10, bad_quantity: 0, assembly_lot_number: '80004', wave_count: 1, wave_current: 1,
    sent_back_reason: null, sent_back_at: null, sent_back_by: null, ...build },
  review_required: true, can_release: true, can_send_back: true, can_correct_counts: true,
  post: { mode: 'auto', note: null }, people: [], lots: [],
  steps: [{ wave: 1, order: 2, type: 'pull_check', label: 'Component check', pins_required: 1, signed: true, result: 'pass', signed_before_send_back: false }],
  blockers: [], reviews: [], ...over,
})
const ok = { sampleQty: '1', sampleResult: 'pass' }

test('reviewNotes: nothing on a clean build; each note alone; all four in order', () => {
  assert.deepEqual(reviewNotes(review(), { formatWhen: when }), [])
  assert.deepEqual(reviewNotes(review({}, { sent_back_at: '2026-11-25T15:00:00Z', sent_back_by: 'Jody Smith', sent_back_reason: 'Crimp check not redone' }), { formatWhen: when }),
    ['Sent back by Jody Smith on [2026-11-25T15:00:00Z]: Crimp check not redone'])
  assert.deepEqual(reviewNotes(review({ steps: [{ label: 'Crimp check', signed_before_send_back: true }, { label: 'Inspect', signed_before_send_back: true }, { label: 'Pull', signed_before_send_back: false }] }), { formatWhen: when }),
    ['Signed before the build was sent back: Crimp check, Inspect. Check they were redone if your reason asked for it.'])
  assert.deepEqual(reviewNotes(review({}, { good_quantity: 8, bad_quantity: 2 }), { formatWhen: when }), ['2 rejected of 10.'])
  assert.deepEqual(reviewNotes(review({}, { good_quantity: 9, bad_quantity: 0 }), { formatWhen: when }), ['9 built of 10 ordered.'])
  assert.deepEqual(reviewNotes(review({ steps: [{ label: 'Crimp check', signed_before_send_back: true }] },
    { sent_back_at: 'T', sent_back_by: 'Jody', sent_back_reason: 'Redo crimp', good_quantity: 7, bad_quantity: 1 }), { formatWhen: when }), [
    'Sent back by Jody on [T]: Redo crimp',
    'Signed before the build was sent back: Crimp check. Check they were redone if your reason asked for it.',
    '1 rejected of 8.',
    '8 built of 10 ordered.',
  ])
})

test('postSentence: auto, manual with and without a note, none', () => {
  assert.equal(postSentence({ mode: 'auto', note: null }), 'Releasing posts this build to Fishbowl. Nothing to key.')
  assert.equal(postSentence({ mode: 'manual', note: null }), 'After release this build is posted by hand in Fishbowl.')
  assert.equal(postSentence({ mode: 'manual', note: 'Post by hand: a two-wave build is posted by hand' }),
    'After release this build is posted by hand in Fishbowl. Post by hand: a two-wave build is posted by hand')
  assert.equal(postSentence({ mode: 'none', note: null }), 'This build does not post to Fishbowl from here.')
  assert.equal(postSentence(null), '')
})

test('releaseProblems: empty on a clean build with sample 1 and Pass; one case each', () => {
  assert.deepEqual(releaseProblems({ review: review(), ...ok }), [])
  const first = (args) => releaseProblems(args)[0]
  assert.equal(first({ review: review({ blockers: ['Not signed: Pressure test'] }), ...ok }), 'This build cannot be released yet: Not signed: Pressure test.')
  assert.equal(first({ review: review(), sampleQty: '3', sampleResult: 'fail' }), 'A failed sample cannot be released. Send the build back.')
  assert.equal(first({ review: review(), sampleQty: '0', sampleResult: 'pass' }), 'Enter how many pieces were sampled (at least 1).')
  assert.equal(first({ review: review(), sampleQty: '', sampleResult: 'pass' }), 'Enter how many pieces were sampled (at least 1).')
  assert.equal(first({ review: review(), sampleQty: '11', sampleResult: 'pass' }), 'Sampled 11 of 10 built.')
  assert.equal(first({ review: review(), ...ok, correcting: true, good: '9', bad: '1', countReason: '  ' }), 'Say why the counts are being corrected.')
  assert.equal(first({ review: review(), ...ok, correcting: true, good: '0', bad: '0', countReason: 'miscount' }), 'Good + bad cannot be 0.')
  assert.equal(first({ review: review(), ...ok, correcting: true, good: '10', bad: '1', countReason: 'miscount' }), 'Good + bad (11) exceeds the build quantity (10).')
  assert.equal(first({ review: review({ can_release: false }, { status: 'paused' }), ...ok }), 'Only a completed build can be released (this one is paused).')
  assert.equal(first({ review: review(), sampleQty: '2', sampleResult: null }), 'Record the sample check: Pass or Fail.')
  // correcting to the same counts needs no reason
  assert.deepEqual(releaseProblems({ review: review(), ...ok, correcting: true, good: '10', bad: '0', countReason: '' }), [])
  assert.equal(first({ review: review({ can_correct_counts: false }), ...ok, correcting: true, good: '9', bad: '1', countReason: 'x' }), 'The counts on this build cannot be corrected here.')
})

test('a count correction changes the sample ceiling', () => {
  assert.deepEqual(releaseProblems({ review: review(), sampleQty: '10', sampleResult: 'pass' }), [])
  assert.deepEqual(releaseProblems({ review: review(), sampleQty: '10', sampleResult: 'pass', correcting: true, good: '9', bad: '0', countReason: 'one was never built' }),
    ['Sampled 10 of 9 built.'])
  assert.deepEqual(releaseProblems({ review: review(), sampleQty: '9', sampleResult: 'pass', correcting: true, good: '9', bad: '0', countReason: 'one was never built' }), [])
})

test('sendBackProblems: an empty or spaces-only reason refuses', () => {
  assert.deepEqual(sendBackProblems({ reason: '' }), ['Say why the build is being sent back.'])
  assert.deepEqual(sendBackProblems({ reason: '   ' }), ['Say why the build is being sent back.'])
  assert.deepEqual(sendBackProblems({ reason: null }), ['Say why the build is being sent back.'])
  assert.deepEqual(sendBackProblems({ reason: 'Crimp check failed on 2 of 5' }), [])
})

test('releasedMessage: posting, a hand post with its reason, plain', () => {
  assert.equal(releasedMessage({ build_number: 'AB-00024', fb_post_status: 'posting' }), 'AB-00024 released. The bridge is posting it to Fishbowl.')
  assert.equal(releasedMessage({ build_number: 'AB-00025', fb_post_status: 'ready_to_post', fb_post_error: 'Post by hand: a short build is posted by hand' }),
    'AB-00025 released. Post by hand: a short build is posted by hand')
  assert.equal(releasedMessage({ build_number: 'AB-00026', fb_post_status: 'ready_to_post', fb_post_error: null }), 'AB-00026 released.')
  assert.equal(releasedMessage({ build_number: 'AB-00027', fb_post_status: 'not_applicable' }), 'AB-00027 released.')
})

test('sign-off table helpers: readings in words, and how each step reads', () => {
  assert.equal(readingsText({ readings: [3.2, 3.4], reading_unit: 'lbf', threshold_min: 3 }), '3.2, 3.4 lbf (min 3)')
  assert.equal(readingsText({ readings: null }), '')
  assert.equal(readingsText({ readings: [12], reading_unit: null, threshold_min: null }), '12')
  assert.equal(stepState({ type: 'release', pins_required: 1, signed: false }), 'release')
  assert.equal(stepState({ type: 'instruction', pins_required: 0, signed: false }), 'none')
  assert.equal(stepState({ type: 'pressure_test', pins_required: 2, signed: false }), 'missing')
  assert.equal(stepState({ type: 'pressure_test', pins_required: 2, signed: true, result: 'fail' }), 'failed')
  assert.equal(stepState({ type: 'pull_check', pins_required: 1, signed: true, result: 'pass' }), 'signed')
})
