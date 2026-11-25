import { useState, useEffect, useCallback } from 'react'
import { Loader2, X, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { getBuildReview, releaseBuildReviewed, sendBuildBack, BUILD_KIND_LABELS } from '../../lib/assembly'
import {
  reviewNotes, postSentence, releaseProblems, sendBackProblems, countsToPost, wholeNumber, readingsText, stepState, recordedBuilt,
} from '../../lib/assemblyReviewMath'
import { formatDateTime } from '../../lib/fishbowl'
import { MoChip } from './PostCards'

// ReleaseReviewDialog — S17 D2b (D-ASM-63). Release on the Assembly Board opens this review: the build, who built
// it, the lots pulled, every sign-off, earlier reviews and what release will do in Fishbowl. The lead records a
// sample check and releases (assembly_build_release_reviewed — the only release the app makes) or sends the build
// back to the tablet with a reason (assembly_build_send_back). The rules live in lib/assemblyReviewMath.js; the
// server refuses anything they miss, and its message is shown here as it comes. canAct: the board's own check
// (admin / assembly); anyone else sees the review without Release or Send back.

const fmtQty = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString())
const field = 'px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-skynet-accent'
const btn = 'px-3 py-1.5 rounded text-xs border transition-colors disabled:opacity-50 inline-flex items-center gap-1'
const btnPrimary = 'px-3 py-2 rounded text-sm bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50 disabled:hover:bg-purple-600 inline-flex items-center gap-1'
const th = 'py-1.5 pr-3 text-left font-medium'

function Section({ title, children, extra }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold text-gray-200">{title}</h4>
        {extra}
      </div>
      {children}
    </section>
  )
}

const STEP_RESULT = {
  signed: { text: 'Pass', className: 'text-green-300' },
  failed: { text: 'Failed', className: 'text-red-300 font-semibold' },
  missing: { text: 'Not signed', className: 'text-red-300 font-semibold' },
  none: { text: 'No sign-off needed', className: 'text-gray-600' },
  release: { text: 'Signed at release', className: 'text-gray-500' },
}

export default function ReleaseReviewDialog({ build, lotPrefix = '', canAct, onClose, onReleased, onSentBack }) {
  const [review, setReview] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [sampleQty, setSampleQty] = useState('')
  const [sampleResult, setSampleResult] = useState(null) // 'pass' | 'fail' | null
  const [note, setNote] = useState('')
  const [correcting, setCorrecting] = useState(false)
  const [good, setGood] = useState('')
  const [bad, setBad] = useState('')
  const [countReason, setCountReason] = useState('')
  const [sendingBack, setSendingBack] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      setReview(await getBuildReview(build.id))
    } catch (e) {
      setLoadError(e?.message || String(e))
    }
  }, [build.id])
  useEffect(() => { load() }, [load])

  const startCorrecting = () => {
    setCorrecting(true)
    setGood(String(review?.build?.good_quantity ?? ''))
    setBad(String(review?.build?.bad_quantity ?? 0))
  }

  const release = async () => {
    setBusy(true)
    setActionError(null)
    try {
      const c = countsToPost({ review, correcting, good, bad })
      const result = await releaseBuildReviewed(build.id, {
        sampleQty: wholeNumber(sampleQty), note: note.trim() || null,
        good: c.changed ? c.good : null, bad: c.changed ? c.bad : null, countReason: c.changed ? countReason.trim() : null,
      })
      onReleased(result)
    } catch (e) {
      setActionError(e?.message || String(e))
      await load()
    } finally {
      setBusy(false)
    }
  }

  const sendBack = async () => {
    setBusy(true)
    setActionError(null)
    try {
      await sendBuildBack(build.id, {
        reason: reason.trim(), sampleQty: wholeNumber(sampleQty), sampleResult: sampleResult || null, note: note.trim() || null,
      })
      onSentBack(review?.build?.build_number || build.build_number)
    } catch (e) {
      setActionError(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const b = review?.build
  const twoWaves = Number(b?.wave_count) === 2
  const blockers = Array.isArray(review?.blockers) ? review.blockers : []
  const notes = review ? reviewNotes(review, { formatWhen: formatDateTime }) : []
  const problems = review ? releaseProblems({ review, sampleQty, sampleResult, correcting, good, bad, countReason }) : []
  const backProblems = sendBackProblems({ reason })
  const people = Array.isArray(review?.people) ? review.people : []
  const totalMinutes = people.reduce((s, p) => s + (Number(p.minutes) || 0), 0)
  const lots = Array.isArray(review?.lots) ? review.lots : []
  const steps = Array.isArray(review?.steps) ? review.steps : []
  const reviews = Array.isArray(review?.reviews) ? review.reviews : []
  const releaseLabel = review?.post?.mode === 'auto' ? 'Release and post to Fishbowl' : 'Release'

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full max-w-5xl max-h-[92vh] flex flex-col" role="dialog" aria-label={`Review ${build.build_number}`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h3 className="text-white font-semibold">Review before release — {build.build_number}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white" aria-label="Close"><X size={16} /></button>
        </div>

        <div className="p-4 space-y-5 overflow-y-auto">
          {!review && !loadError && <div className="text-sm text-gray-400 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading the review…</div>}
          {loadError && <div role="alert" className="text-sm text-red-300 bg-red-950/40 border border-red-900 rounded px-3 py-2">Could not load the review: {loadError}</div>}

          {review && (
            <>
              {/* 1. Header */}
              <div className="flex items-start gap-3 flex-wrap">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-white text-lg">{b.build_number}</span>
                    <span className="font-mono text-gray-200">{b.part_number}</span>
                    <span className="text-xs px-2 py-0.5 rounded border bg-gray-900 text-purple-300 border-purple-900">{BUILD_KIND_LABELS[b.build_kind] || b.build_kind}</span>
                  </div>
                  {b.part_description && <div className="text-xs text-gray-500">{b.part_description}</div>}
                  <div className="text-sm text-gray-400">
                    Quantity <span className="font-mono text-gray-200">{fmtQty(b.quantity)}</span>
                    {b.assembly_lot_number && <> · finished lot <span className="font-mono text-cyan-300">{lotPrefix}{b.assembly_lot_number}</span></>}
                    {twoWaves && <> · wave {b.wave_current} of 2</>}
                  </div>
                </div>
                <span className="ml-auto"><MoChip number={b.fb_mo_num} state={b.fb_mo_state} /></span>
              </div>

              {/* 2. Blockers */}
              {blockers.length > 0 && (
                <div role="alert" className="text-sm text-red-300 bg-red-950/40 border border-red-900 rounded px-3 py-2 space-y-1">
                  <div className="font-semibold flex items-center gap-2"><AlertTriangle size={14} /> This build cannot be released yet:</div>
                  <ul className="list-disc ml-6 space-y-0.5">{blockers.map((x) => <li key={x}>{x}</li>)}</ul>
                </div>
              )}

              {/* 3. Things to look at */}
              {notes.length > 0 && (
                <ul className="text-sm text-amber-200 bg-amber-950/40 border border-amber-800 rounded px-3 py-2 space-y-1">
                  {notes.map((x) => <li key={x}>{x}</li>)}
                </ul>
              )}

              {/* 4. What release will do */}
              {postSentence(review.post) && (
                <div className="text-sm text-gray-200 bg-gray-800/60 border border-gray-700 rounded px-3 py-2">{postSentence(review.post)}</div>
              )}

              {/* 5. Who built it */}
              <Section title="Who built it">
                {people.length === 0 ? <div className="text-xs text-gray-500">No sessions were recorded.</div> : (
                  <div className="text-sm text-gray-300 flex flex-wrap gap-x-4 gap-y-1">
                    {people.map((p) => <span key={p.name}>{p.name} <span className="font-mono text-gray-400">{Number(p.minutes || 0).toFixed(1)} min</span></span>)}
                    <span className="text-gray-500">Total <span className="font-mono">{totalMinutes.toFixed(1)} min</span></span>
                  </div>
                )}
              </Section>

              {/* 6. Lots pulled */}
              <Section title="Lots pulled">
                {lots.length === 0 ? <div className="text-xs text-amber-300">No lots were recorded for this build.</div> : (
                  <table className="w-full text-sm">
                    <thead className="text-gray-500 text-xs uppercase">
                      <tr>
                        {twoWaves && <th className={th}>Wave</th>}
                        <th className={th}>Component</th><th className={`${th} hidden md:table-cell`}>Description</th><th className={th}>Lot</th>
                        <th className={`${th} text-right`}>Qty</th><th className={th}>Pulled by</th><th className={th}>Checked by</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {lots.map((l) => (
                        <tr key={`${l.wave}|${l.part}|${l.lot}`}>
                          {twoWaves && <td className="py-1 pr-3 text-gray-400">{l.wave}</td>}
                          <td className="py-1 pr-3 font-mono text-gray-200">{l.part}</td>
                          <td className="py-1 pr-3 text-xs text-gray-500 hidden md:table-cell">{l.description || '—'}</td>
                          <td className="py-1 pr-3 font-mono text-cyan-300">{l.lot}</td>
                          <td className="py-1 pr-3 text-right font-mono text-gray-300">{fmtQty(l.qty)}</td>
                          <td className="py-1 pr-3 text-gray-300">{l.picked_by || '—'}{l.picked_at && <span className="block text-xs text-gray-600">{formatDateTime(l.picked_at)}</span>}</td>
                          <td className="py-1 pr-3 text-gray-300">{l.checked_by || <span className="text-gray-600">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>

              {/* 7. Sign-offs */}
              <Section title="Sign-offs">
                {steps.length === 0 ? <div className="text-xs text-amber-300">This build has no checklist steps.</div> : (
                  <table className="w-full text-sm">
                    <thead className="text-gray-500 text-xs uppercase">
                      <tr>
                        {twoWaves && <th className={th}>Wave</th>}
                        <th className={th}>Step</th><th className={th}>Signed by</th><th className={th}>When</th>
                        <th className={th}>Readings</th><th className={th}>Result</th><th className={th}>Note</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {steps.map((s) => {
                        const state = stepState(s)
                        const muted = state === 'none' || state === 'release'
                        const blocked = state === 'missing' || state === 'failed'
                        const r = STEP_RESULT[state]
                        return (
                          <tr key={`${s.wave}|${s.order}|${s.label}`} className={blocked ? 'bg-red-950/30' : muted ? 'text-gray-600' : ''}>
                            {twoWaves && <td className="py-1 pr-3">{s.wave}</td>}
                            <td className={`py-1 pr-3 ${muted ? '' : 'text-gray-200'}`}>
                              {s.label}
                              {s.signed_before_send_back && <span className="block text-xs text-amber-300">signed before the send-back</span>}
                            </td>
                            <td className="py-1 pr-3">{Array.isArray(s.signed_by) && s.signed_by.length ? s.signed_by.join(' / ') : (muted ? '' : '—')}</td>
                            <td className="py-1 pr-3 text-xs">{s.signed_at ? formatDateTime(s.signed_at) : ''}</td>
                            <td className="py-1 pr-3 font-mono text-xs">{readingsText(s)}</td>
                            <td className={`py-1 pr-3 text-xs ${r.className}`}>
                              <span className="inline-flex items-center gap-1">
                                {state === 'signed' && <CheckCircle2 size={12} />}{blocked && <XCircle size={12} />}{r.text}
                              </span>
                            </td>
                            <td className="py-1 pr-3 text-xs text-gray-400">{s.note || ''}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </Section>

              {/* 8. Earlier reviews */}
              {reviews.length > 0 && (
                <Section title="Earlier reviews">
                  <table className="w-full text-sm">
                    <thead className="text-gray-500 text-xs uppercase">
                      <tr><th className={th}>Action</th><th className={th}>Who</th><th className={th}>When</th><th className={th}>Sample</th><th className={th}>Reason or note</th><th className={th}>Counts</th></tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {reviews.map((r) => (
                        <tr key={`${r.action}|${r.reviewed_at}`}>
                          <td className={`py-1 pr-3 ${r.action === 'sent_back' ? 'text-amber-300' : 'text-green-300'}`}>{r.action === 'sent_back' ? 'Sent back' : 'Released'}</td>
                          <td className="py-1 pr-3 text-gray-300">{r.reviewed_by || '—'}</td>
                          <td className="py-1 pr-3 text-xs text-gray-400">{formatDateTime(r.reviewed_at)}</td>
                          <td className="py-1 pr-3 text-xs text-gray-300">{r.sample_qty !== null && r.sample_qty !== undefined ? `${r.sample_qty}${r.sample_result ? `, ${r.sample_result}` : ''}` : (r.sample_result || '—')}</td>
                          <td className="py-1 pr-3 text-xs text-gray-300">{[r.reason, r.note].filter(Boolean).join(' · ') || '—'}</td>
                          <td className="py-1 pr-3 text-xs text-gray-300">
                            {r.good_after !== null && r.good_after !== undefined && (r.good_after !== r.good_before || r.bad_after !== r.bad_before)
                              ? <>{r.good_before}/{r.bad_before} → {r.good_after}/{r.bad_after}{r.count_reason ? ` (${r.count_reason})` : ''}</>
                              : <span className="text-gray-600">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Section>
              )}

              {/* 9. Counts */}
              <Section title="Counts">
                <div className="text-sm text-gray-300">
                  As the tablet recorded them: good <span className="font-mono text-white">{fmtQty(b.good_quantity)}</span>, bad <span className="font-mono text-white">{fmtQty(b.bad_quantity ?? 0)}</span>
                  <span className="text-gray-500"> ({fmtQty(recordedBuilt(review))} built of {fmtQty(b.quantity)})</span>
                  {review.can_correct_counts && canAct && !correcting && (
                    <button type="button" onClick={startCorrecting} className={`${btn} ml-3 bg-gray-800 border-gray-700 text-gray-200 hover:text-white`}>Correct the counts</button>
                  )}
                </div>
                {correcting && (
                  <div className="space-y-2 bg-gray-950/50 border border-gray-800 rounded p-3">
                    <div className="flex items-center gap-3 flex-wrap text-sm text-gray-300">
                      <label className="flex items-center gap-2">Good <input value={good} onChange={(e) => setGood(e.target.value)} inputMode="numeric" className={`${field} w-24 font-mono`} /></label>
                      <label className="flex items-center gap-2">Bad <input value={bad} onChange={(e) => setBad(e.target.value)} inputMode="numeric" className={`${field} w-24 font-mono`} /></label>
                      <button type="button" onClick={() => { setCorrecting(false); setCountReason('') }} className="text-xs text-gray-400 hover:text-white">Keep the tablet's counts</button>
                    </div>
                    <input value={countReason} onChange={(e) => setCountReason(e.target.value)} placeholder="Why the counts are being corrected (required)" className={`${field} w-full`} />
                    <div className="text-xs text-gray-500">The corrected counts are what posts to Fishbowl. The original counts are kept in the record.</div>
                  </div>
                )}
              </Section>

              {/* 10. Sample check */}
              <Section title="Sample check">
                <div className="flex items-center gap-3 flex-wrap text-sm text-gray-300">
                  <label className="flex items-center gap-2">Pieces sampled <input value={sampleQty} onChange={(e) => setSampleQty(e.target.value)} inputMode="numeric" className={`${field} w-24 font-mono`} /></label>
                  <div className="flex items-center gap-1" role="radiogroup" aria-label="Sample result">
                    <button type="button" role="radio" aria-checked={sampleResult === 'pass'} onClick={() => setSampleResult('pass')}
                      className={`${btn} ${sampleResult === 'pass' ? 'bg-green-900/60 border-green-700 text-green-200' : 'bg-gray-800 border-gray-700 text-gray-300 hover:text-white'}`}>Pass</button>
                    <button type="button" role="radio" aria-checked={sampleResult === 'fail'} onClick={() => setSampleResult('fail')}
                      className={`${btn} ${sampleResult === 'fail' ? 'bg-red-900/60 border-red-700 text-red-200' : 'bg-gray-800 border-gray-700 text-gray-300 hover:text-white'}`}>Fail</button>
                  </div>
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className={`${field} flex-1 min-w-[220px]`} />
                </div>
              </Section>

              {actionError && <div role="alert" className="text-sm text-red-300 bg-red-950/40 border border-red-900 rounded px-3 py-2">{actionError}</div>}

              {/* Send back: the reason, in the same dialog */}
              {sendingBack && (
                <div className="space-y-2 bg-amber-950/30 border border-amber-800 rounded p-3">
                  <div className="text-sm text-amber-200">Send {b.build_number} back to the tablet. It returns paused; the lots, sign-offs and finished lot stay, and the good and bad counts are cleared.</div>
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} autoFocus placeholder="What needs fixing (required) — the assembler sees this"
                    className={`${field} w-full`} />
                  <div className="flex items-center gap-2">
                    <button type="button" disabled={busy || backProblems.length > 0} onClick={sendBack}
                      className="px-3 py-2 rounded text-sm bg-amber-700 hover:bg-amber-600 text-white disabled:opacity-50 inline-flex items-center gap-1">
                      {busy && <Loader2 size={14} className="animate-spin" />} Send back to the tablet
                    </button>
                    <button type="button" onClick={() => setSendingBack(false)} className="text-xs text-gray-400 hover:text-white">Not now</button>
                    {backProblems.length > 0 && <span className="text-xs text-gray-400">{backProblems[0]}</span>}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* 11. Buttons */}
        <div className="px-4 py-3 border-t border-gray-800 flex items-center gap-3 flex-wrap">
          {review && canAct && (
            <>
              <button type="button" disabled={busy || problems.length > 0} onClick={release} className={btnPrimary}>
                {busy && !sendingBack && <Loader2 size={14} className="animate-spin" />} {releaseLabel}
              </button>
              {problems.length > 0 && <span className="text-xs text-gray-400 max-w-md">{problems[0]}</span>}
              {review.can_send_back && !sendingBack && (
                <button type="button" disabled={busy} onClick={() => setSendingBack(true)} className={`${btn} bg-gray-800 border-amber-800 text-amber-200 hover:text-white`}>Send back…</button>
              )}
            </>
          )}
          {review && !canAct && <span className="text-xs text-gray-500">Only the assembly team and admins release or send back a build.</span>}
          <button type="button" onClick={onClose} className="ml-auto px-3 py-2 text-sm text-gray-400 hover:text-white">Close</button>
        </div>
      </div>
    </div>
  )
}
