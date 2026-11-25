// lib/assemblyReviewMath.js — S17 D2b (D-ASM-63): the rules of the release review dialog, pure (no I/O) so they are
// tested (assemblyReviewMath.test.mjs). The review object is assembly_build_review's answer; the server refuses
// anything these rules let through, and its message is shown as it comes — these only keep the dialog honest.

const fmtN = (v) => Number(v).toLocaleString('en-US')
const n0 = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v))

// "2026-11-25 14:05" in local time; the dialog passes the app's own formatter instead.
function defaultWhen(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// A whole number from an input ('' or anything else -> null).
export function wholeNumber(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null
  const s = String(v ?? '').trim()
  return /^\d+$/.test(s) ? Number(s) : null
}

// Good + bad as the tablet recorded them.
export const recordedBuilt = (review) => n0(review?.build?.good_quantity) + n0(review?.build?.bad_quantity)

// The "things to look at" sentences, in order: an earlier send-back, sign-offs made before it, rejects, a short build.
export function reviewNotes(review, { formatWhen = defaultWhen } = {}) {
  const b = review?.build
  if (!b) return []
  const out = []
  if (b.sent_back_at) {
    const who = b.sent_back_by ? ` by ${b.sent_back_by}` : ''
    out.push(`Sent back${who} on ${formatWhen(b.sent_back_at)}: ${b.sent_back_reason || 'no reason recorded'}`)
  }
  const before = (Array.isArray(review.steps) ? review.steps : []).filter((s) => s.signed_before_send_back).map((s) => s.label)
  if (before.length) out.push(`Signed before the build was sent back: ${before.join(', ')}. Check they were redone if your reason asked for it.`)
  const built = recordedBuilt(review)
  const bad = n0(b.bad_quantity)
  if (bad > 0) out.push(`${fmtN(bad)} rejected of ${fmtN(built)}.`)
  const qty = n0(b.quantity)
  if (qty > 0 && built < qty) out.push(`${fmtN(built)} built of ${fmtN(qty)} ordered.`)
  return out
}

// What release will do in Fishbowl (the review's post.mode).
export function postSentence(post) {
  switch (post?.mode) {
    case 'auto': return 'Releasing posts this build to Fishbowl. Nothing to key.'
    case 'manual': return `After release this build is posted by hand in Fishbowl.${post.note ? ` ${post.note}` : ''}`
    case 'none': return 'This build does not post to Fishbowl from here.'
    default: return ''
  }
}

// The counts a release would post: the corrected ones while correcting, else the tablet's.
export function countsToPost({ review, correcting, good, bad }) {
  if (!correcting) return { good: n0(review?.build?.good_quantity), bad: n0(review?.build?.bad_quantity), changed: false, valid: true }
  const g = wholeNumber(good)
  const x = wholeNumber(bad)
  if (g === null || x === null) return { good: g, bad: x, changed: true, valid: false }
  const changed = g !== n0(review?.build?.good_quantity) || x !== n0(review?.build?.bad_quantity)
  return { good: g, bad: x, changed, valid: true }
}

// Why Release is not available yet, as plain sentences. Empty = Release is enabled; the first one is the line shown
// beside the button.
export function releaseProblems({ review, sampleQty, sampleResult, correcting = false, good = null, bad = null, countReason = '' }) {
  const out = []
  if (!review?.build) return ['The review has not loaded.']
  if (sampleResult === 'fail') out.push('A failed sample cannot be released. Send the build back.')
  if (!review.can_release) out.push(`Only a completed build can be released (this one is ${review.build.status || 'not complete'}).`)
  const blockers = Array.isArray(review.blockers) ? review.blockers : []
  if (blockers.length) out.push(`This build cannot be released yet: ${blockers.join('; ')}.`)
  if (sampleResult !== 'pass' && sampleResult !== 'fail') out.push('Record the sample check: Pass or Fail.')

  const c = countsToPost({ review, correcting, good, bad })
  if (correcting) {
    if (!review.can_correct_counts) out.push('The counts on this build cannot be corrected here.')
    else if (!c.valid) out.push('Enter the corrected good and bad counts as whole numbers.')
    else if (c.changed) {
      const total = c.good + c.bad
      const qty = n0(review.build.quantity)
      if (total === 0) out.push('Good + bad cannot be 0.')
      else if (total > qty) out.push(`Good + bad (${fmtN(total)}) exceeds the build quantity (${fmtN(qty)}).`)
      if (!String(countReason ?? '').trim()) out.push('Say why the counts are being corrected.')
    }
  }

  const s = wholeNumber(sampleQty)
  const built = c.valid ? n0(c.good) + n0(c.bad) : recordedBuilt(review)
  if (s === null || s < 1) out.push('Enter how many pieces were sampled (at least 1).')
  else if (s > built) out.push(`Sampled ${fmtN(s)} of ${fmtN(built)} built.`)
  return out
}

export function sendBackProblems({ reason }) {
  return String(reason ?? '').trim() ? [] : ['Say why the build is being sent back.']
}

// The board's message after a release (the RPC's answer).
export function releasedMessage(result) {
  const num = result?.build_number || 'The build'
  if (result?.fb_post_status === 'posting') return `${num} released. The bridge is posting it to Fishbowl.`
  if (result?.fb_post_status === 'ready_to_post' && result?.fb_post_error) return `${num} released. ${result.fb_post_error}`
  return `${num} released.`
}

// A sign-off's readings in words: "3.2, 3.4 lbf (min 3)". Empty when there are none.
export function readingsText(step) {
  const r = step?.readings
  const list = Array.isArray(r) ? r : r && typeof r === 'object' ? Object.values(r) : r === null || r === undefined ? [] : [r]
  const values = list.filter((v) => v !== null && v !== undefined && v !== '').map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)))
  if (!values.length) return ''
  const unit = step.reading_unit ? ` ${step.reading_unit}` : ''
  const min = step.threshold_min !== null && step.threshold_min !== undefined ? ` (min ${step.threshold_min})` : ''
  return `${values.join(', ')}${unit}${min}`
}

// How a step reads in the sign-off table: 'release' is signed by the review; 'none' needs no sign-off;
// 'missing' / 'failed' block release; 'signed' is a pass.
export function stepState(step) {
  if (step?.type === 'release') return 'release'
  if (!(Number(step?.pins_required) > 0)) return step?.signed ? (step.result === 'pass' ? 'signed' : 'failed') : 'none'
  if (!step.signed) return 'missing'
  return step.result === 'pass' ? 'signed' : 'failed'
}
