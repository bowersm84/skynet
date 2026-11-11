// lib/assemblyPostMath.js — S17 D1 (D-ASM-54): the words on Ashley's post card and on the MO chip, from the
// v_assembly_post_cards / v_assembly_builds_board columns. Pure (no I/O) so the wording is tested
// (assemblyPostMath.test.mjs).

const fmt = (v) => Number(v).toLocaleString('en-US')

// "lot 58663" / "lots 58663 and 58664" / "lots 1, 2 and 3"
function lots(list) {
  const xs = [...new Set(list.map(String))]
  if (xs.length === 1) return `lot ${xs[0]}`
  return `lots ${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}

// The MO's state in words (fb_mo_state); null when there is no MO to speak of.
export const MO_STATE_WORDS = {
  queued: 'queued', issued: 'issued', linked: 'linked by hand', error: 'error', cancelled: 'cancelled', closed_short: 'closed short',
}
export const moStateWords = (state) => MO_STATE_WORDS[state] ?? null

// The post card's status line.
export function postStatusText(card) {
  const posted = Number(card?.fb_posted_qty) || 0
  const good = Number(card?.good_quantity) || 0
  switch (card?.fb_post_status) {
    case 'ready_to_post': return posted > 0 ? `Posted ${fmt(posted)} of ${fmt(good)}` : 'Ready to post'
    case 'posted': return 'Posted, waiting for the lot to show'
    case 'verified': return 'Verified'
    case 'mismatch': return 'Mismatch'
    case 'not_posted': return 'Not posted'
    default: return card?.fb_post_status || '—'
  }
}

// One of ready | partial | posted | verified | mismatch — for the colour.
export function postTone(card) {
  if (card?.fb_post_status === 'ready_to_post') return (Number(card?.fb_posted_qty) || 0) > 0 ? 'partial' : 'ready'
  return ['posted', 'verified', 'mismatch'].includes(card?.fb_post_status) ? card.fb_post_status : 'ready'
}

// What differs, in plain sentences, from fb_post_diff.
export function mismatchSentences(diff) {
  if (!diff || typeof diff !== 'object') return []
  const out = []
  const missing = Array.isArray(diff.lots_missing) ? diff.lots_missing : []
  const unexpected = Array.isArray(diff.lots_unexpected) ? diff.lots_unexpected : []
  const parts = [...new Set([...missing, ...unexpected].map((x) => x.part))].sort()
  for (const part of parts) {
    const m = missing.filter((x) => x.part === part).map((x) => x.lot)
    const u = unexpected.filter((x) => x.part === part).map((x) => x.lot)
    if (m.length && u.length) out.push(`Fishbowl shows ${part} ${lots(u)}; SkyNet recorded ${m.length === 1 ? m[0] : lots(m).replace(/^lots /, '')}`)
    else if (u.length) out.push(`Fishbowl shows ${part} ${lots(u)}, which SkyNet did not record`)
    else out.push(`SkyNet recorded ${part} ${lots(m)}; Fishbowl did not use it`)
  }
  const posted = Number(diff.posted_qty)
  const expected = Number(diff.expected_qty)
  if (Number.isFinite(posted) && Number.isFinite(expected) && posted > expected) out.push(`Posted ${fmt(posted)}, expected ${fmt(expected)}`)
  const seen = Array.isArray(diff.finished_lots_seen) ? diff.finished_lots_seen : []
  if (diff.finished_lot_found === false && diff.finished_lot_expected && seen.length) {
    out.push(`Finished lot ${diff.finished_lot_expected} not found; ${seen.length === 1 ? seen[0] : lots(seen).replace(/^lots /, '')} appeared`)
  }
  return out
}

// Cards that still need Ashley (the tab's count): everything but verified.
export const needsPosting = (card) => ['ready_to_post', 'posted', 'mismatch'].includes(card?.fb_post_status)
