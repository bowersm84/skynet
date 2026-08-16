// src/components/schedule/AIAdvisorPanel.jsx
// "Uncle Bob" — the AI Schedule Advisor drawer (D-AISCHED-04). Autonomy L0:
// every card is a proposal; Apply routes through the existing ScheduleJobModal
// via onApplyProposal, so the human confirming it is scheduled_by.
// The Edge Function writes nothing; this panel (as the authenticated
// scheduler) owns all schedule_ai_runs / schedule_ai_proposals writes.
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import { getMachineQueue } from '../../lib/scheduling'
import { buildScheduleSnapshot } from '../../lib/scheduleSnapshot'
import {
  Bot, X, Loader2, RefreshCw, AlertTriangle, CheckCircle, Info,
  ChevronDown, ChevronRight, HelpCircle, Plus, Trash2, ExternalLink
} from 'lucide-react'

// Who's Uncle Bob? T2 (1991): the reprogrammed T-800 the kids pass off as
// family. Takes orders from a human, protects the operation, learns as it
// goes. Swap the link here if the upload ever disappears.
const UNCLE_BOB_CLIP_URL = 'https://www.youtube.com/watch?v=bOLGXgZ8ffE'

const ADVISOR_TIMEOUT_MS = 300000 // outer guard; the stream's heartbeats do the real keep-alive

// D-AISCHED-07: Fable 5 thinks for minutes; a buffered invoke outlives the
// gateway window (observed: browser 502 + worker EarlyDrop at ~200s with
// 44ms CPU — pure network wait). The function now streams SSE: heartbeat
// comments while the model generates, then exactly one `result` event with
// the same { model, envelope, usage } shape invoke used to return, or one
// `error` event. Fast-path failures (401/403/400) still arrive as plain
// non-2xx JSON and are surfaced from the !resp.ok branch.
async function invokeAdvisorStream(snapshot) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('No active session — sign in again.')

  const controller = new AbortController()
  const kill = setTimeout(() => controller.abort(), ADVISOR_TIMEOUT_MS)
  try {
    const resp = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/schedule-advisor`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ snapshot }),
        signal: controller.signal,
      }
    )

    if (!resp.ok) {
      let msg = `schedule-advisor HTTP ${resp.status}`
      try {
        const j = await resp.json()
        if (j?.error) msg = j.error
      } catch { /* body wasn't JSON; keep the status message */ }
      throw new Error(msg)
    }

    const contentType = resp.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
      // Fast-path 200 (e.g. empty pool) still returns plain JSON.
      const j = await resp.json()
      if (j?.error) throw new Error(j.error)
      return j
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const frame of frames) {
        const lines = frame.split('\n')
        const event = (lines.find(l => l.startsWith('event: ')) || '').slice(7).trim()
        const dataLine = lines.find(l => l.startsWith('data: '))
        if (!dataLine) continue // heartbeat comment
        let payload
        try { payload = JSON.parse(dataLine.slice(6)) } catch { continue }
        if (event === 'error') throw new Error(payload.error || 'schedule-advisor failed')
        if (event === 'result') return payload
      }
    }
    throw new Error('Uncle Bob\u0027s stream ended without a result — try again.')
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error('Uncle Bob timed out after 5 minutes. Try again.')
    }
    throw e
  } finally {
    clearTimeout(kill)
  }
}

const startOfTodayIso = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

const confidenceBadge = (c) =>
  c === 'high'   ? 'bg-green-900/60 text-green-300 border border-green-700' :
  c === 'medium' ? 'bg-yellow-900/60 text-yellow-300 border border-yellow-700' :
                   'bg-gray-700 text-gray-300 border border-gray-600'

export default function AIAdvisorPanel({
  open, onClose, profile,
  machines, scheduledJobs, unassignedJobs, ongoingDowntimes,
  getMachineOptionsForPart, getScaledDuration, projectedSpans,
  onApplyProposal, refreshKey,
}) {
  const [running, setRunning] = useState(false)
  const [loadingLatest, setLoadingLatest] = useState(false)
  const [error, setError] = useState(null)
  const [run, setRun] = useState(null)              // latest schedule_ai_runs row
  const [proposals, setProposals] = useState([])
  const [whyOpenId, setWhyOpenId] = useState(null)
  const [dismissingId, setDismissingId] = useState(null)
  const [dismissReason, setDismissReason] = useState('')
  const [showAbout, setShowAbout] = useState(false)
  const [policies, setPolicies] = useState([])
  const [showPolicies, setShowPolicies] = useState(false)
  const [newPolicy, setNewPolicy] = useState('')

  const machineById = useCallback(
    (id) => (machines || []).find(m => m.id === id) || null,
    [machines]
  )

  // ── Load latest run + proposals; sweep yesterday's leftovers to 'expired'.
  // No wall-clock expiry inside a day: April gets interrupted constantly and
  // must find her suggestions waiting when she gets back (D-AISCHED-02).
  const loadLatest = useCallback(async () => {
    if (!profile?.id) return
    setLoadingLatest(true)
    setError(null)
    try {
      await supabase
        .from('schedule_ai_proposals')
        .update({ status: 'expired' })
        .eq('status', 'open')
        .lt('created_at', startOfTodayIso())

      const { data: runs, error: runErr } = await supabase
        .from('schedule_ai_runs')
        .select('*')
        .eq('run_by', profile.id)
        .order('run_at', { ascending: false })
        .limit(1)
      if (runErr) throw new Error(runErr.message)
      const latest = runs?.[0] || null
      setRun(latest)

      if (latest) {
        const { data: props, error: propErr } = await supabase
          .from('schedule_ai_proposals')
          .select('*')
          .eq('run_id', latest.id)
          .order('created_at', { ascending: true })
        if (propErr) throw new Error(propErr.message)
        setProposals(props || [])
      } else {
        setProposals([])
      }

      const { data: pols } = await supabase
        .from('scheduler_policies')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: true })
      setPolicies(pols || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoadingLatest(false)
    }
  }, [profile?.id])

  useEffect(() => {
    if (open) loadLatest()
  }, [open, refreshKey, loadLatest])

  // ── Run the advisor ──────────────────────────────────────────────────────
  const runAdvisor = async () => {
    if (running || !profile?.id) return
    setRunning(true)
    setError(null)
    try {
      // Supersede this user's still-open proposals from prior runs: one live
      // proposal set at a time, history preserved (D-AISCHED-02).
      const { data: priorRuns } = await supabase
        .from('schedule_ai_runs')
        .select('id')
        .eq('run_by', profile.id)
      const priorIds = (priorRuns || []).map(r => r.id)
      if (priorIds.length) {
        await supabase
          .from('schedule_ai_proposals')
          .update({ status: 'superseded' })
          .eq('status', 'open')
          .in('run_id', priorIds)
      }

      const snapshot = await buildScheduleSnapshot({
        machines, scheduledJobs, unassignedJobs, ongoingDowntimes,
        getMachineOptionsForPart, getScaledDuration, projectedSpans,
      })

      const data = await invokeAdvisorStream(snapshot)

      const envelope = data?.envelope
      if (!envelope) throw new Error('Empty envelope from schedule-advisor')

      // Audit trail: the exact input and output of this run.
      const { data: runRow, error: runInsErr } = await supabase
        .from('schedule_ai_runs')
        .insert({
          run_by: profile.id,
          model: data.model || 'unknown',
          snapshot,
          briefing: envelope.briefing || null,
          risks: envelope.risks || [],
          data_gaps: envelope.data_gaps || [],
          usage: data.usage || null,
        })
        .select()
        .single()
      if (runInsErr) throw new Error(runInsErr.message)

      const placements = Array.isArray(envelope.placements) ? envelope.placements : []
      if (placements.length) {
        // queue_fp: the target machine's queue (ordered job ids) at snapshot
        // time — the staleness fingerprint. Greying is presentational only;
        // Apply always re-validates through the modal's live math.
        const fpFor = (machineId) => {
          const mb = snapshot.machines.find(m => m.machine_id === machineId)
          return (mb?.queue || []).map(q => q.job_id)
        }
        const rows = placements.map(p => ({
          run_id: runRow.id,
          job_id: p.job_id,
          machine_id: p.machine_id,
          insert_after_job_id: p.insert_after_job_id || null,
          proposed_start: p.proposed_start,
          proposed_end: p.proposed_end,
          estimated_minutes: p.estimated_minutes || null,
          confidence: p.confidence || 'low',
          rationale: p.rationale || '',
          evidence: { ...(p.evidence || {}), queue_fp: fpFor(p.machine_id) },
        }))
        const { error: propInsErr } = await supabase
          .from('schedule_ai_proposals')
          .insert(rows)
        if (propInsErr) throw new Error(propInsErr.message)
      }

      await loadLatest()
    } catch (e) {
      setError(e.message)
      // Record the failed run for the audit trail (best-effort).
      try {
        await supabase.from('schedule_ai_runs').insert({
          run_by: profile.id,
          model: 'claude-fable-5',
          snapshot: { note: 'run failed before/at invoke; snapshot omitted' },
          error: String(e.message || e),
        })
      } catch { /* best-effort only */ }
    } finally {
      setRunning(false)
    }
  }

  // ── Staleness: the board moved under this proposal ───────────────────────
  const isStale = (p) => {
    const fp = p?.evidence?.queue_fp
    if (!Array.isArray(fp)) return false
    const live = getMachineQueue(scheduledJobs, p.machine_id).map(j => j.id)
    if (live.length !== fp.length) return true
    return live.some((id, i) => id !== fp[i])
  }

  const jobStillUnassigned = (p) =>
    (unassignedJobs || []).some(j => j.id === p.job_id)

  // ── Apply / dismiss ──────────────────────────────────────────────────────
  const handleApply = (p) => {
    const ok = onApplyProposal(p)
    if (!ok) setError(`${jobNumberFor(p)} is no longer in the unassigned pool — re-run Uncle Bob.`)
  }

  const jobNumberFor = (p) => {
    const j = (unassignedJobs || []).find(x => x.id === p.job_id)
    return j?.job_number || 'This job'
  }

  const confirmDismiss = async (p) => {
    const { error: dErr } = await supabase
      .from('schedule_ai_proposals')
      .update({
        status: 'dismissed',
        dismissed_by: profile?.id ?? null,
        dismissed_at: new Date().toISOString(),
        dismissal_reason: dismissReason.trim() || null,
      })
      .eq('id', p.id)
    if (dErr) { setError(dErr.message); return }
    setDismissingId(null)
    setDismissReason('')
    await loadLatest()
  }

  // ── Standing rules (scheduler_policies) ──────────────────────────────────
  const addPolicy = async () => {
    const text = newPolicy.trim()
    if (!text || !profile?.id) return
    const { error: pErr } = await supabase
      .from('scheduler_policies')
      .insert({ policy_text: text, created_by: profile.id, source: 'manual' })
    if (pErr) { setError(pErr.message); return }
    setNewPolicy('')
    await loadLatest()
  }

  const deactivatePolicy = async (id) => {
    const { error: pErr } = await supabase
      .from('scheduler_policies')
      .update({ is_active: false })
      .eq('id', id)
    if (pErr) { setError(pErr.message); return }
    await loadLatest()
  }

  if (!open) return null

  const openProposals = proposals.filter(p => p.status === 'open')
  const settledProposals = proposals.filter(p => p.status !== 'open')

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full sm:w-[540px] h-full bg-gray-900 border-l border-gray-700 flex flex-col shadow-2xl">

        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-700 bg-gray-800">
          <Bot size={20} className="text-skynet-accent" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <h2 className="text-white font-semibold leading-tight">Uncle Bob</h2>
              <button
                onClick={() => setShowAbout(v => !v)}
                className="text-gray-400 hover:text-white"
                title="Who's Uncle Bob?"
              >
                <HelpCircle size={14} />
              </button>
            </div>
            <p className="text-xs text-gray-400 leading-tight">
              Schedule Advisor — proposes, never applies
            </p>
          </div>
          <button
            onClick={runAdvisor}
            disabled={running}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {running ? 'Thinking…' : (run ? 'Re-run' : 'Run')}
          </button>
          <button onClick={onClose} className="text-gray-400 hover:text-white ml-1">
            <X size={18} />
          </button>
        </div>

        {showAbout && (
          <div className="px-4 py-3 border-b border-gray-700 bg-gray-800/60 text-sm text-gray-300">
            <p>
              In <span className="italic">Terminator 2</span>, John passes the reprogrammed
              T-800 off to family as “Uncle Bob”: a machine on our side that takes orders
              from a human, protects the operation, and learns as it goes. Same deal here —
              every placement below is a proposal, and a human applies it.
            </p>
            <a
              href={UNCLE_BOB_CLIP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mt-2 text-skynet-accent hover:underline"
            >
              Watch the scene <ExternalLink size={12} />
            </a>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {error && (
            <div className="flex items-start gap-2 p-2.5 bg-red-900/40 border border-red-700 rounded-lg text-sm text-red-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loadingLatest && !run && (
            <div className="flex items-center gap-2 text-gray-400 text-sm">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          )}

          {!loadingLatest && !run && !error && (
            <div className="text-sm text-gray-400 pt-6 text-center">
              <Bot size={28} className="mx-auto mb-2 text-gray-600" />
              No runs yet. Hit <span className="text-white">Run</span> and Uncle Bob will read
              the board, the unassigned pool, and every part's run history, then propose
              placements with the evidence behind each one.
            </div>
          )}

          {run && (
            <>
              <div className="text-[11px] text-gray-500">
                Last run {new Date(run.run_at).toLocaleString()} · {run.model}
                {run.error ? ' · failed' : ''}
              </div>

              {run.briefing && (
                <div className="p-3 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 whitespace-pre-wrap">
                  {run.briefing}
                </div>
              )}

              {Array.isArray(run.risks) && run.risks.length > 0 && (
                <div className="space-y-1.5">
                  {run.risks.map((r, i) => (
                    <div key={i} className="flex items-start gap-2 p-2 bg-amber-900/30 border border-amber-800 rounded-lg text-xs text-amber-200">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                      <span>
                        <span className="font-semibold">{r.job_number || r.wo_number || 'Risk'}</span>
                        {r.severity ? ` (${r.severity})` : ''} — {r.issue}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Placement proposals */}
              {openProposals.map(p => {
                const m = machineById(p.machine_id)
                const stale = isStale(p)
                const gone = !jobStillUnassigned(p)
                const ev = p.evidence || {}
                return (
                  <div
                    key={p.id}
                    className={`p-3 rounded-lg border ${stale || gone
                      ? 'bg-gray-800/40 border-gray-700 opacity-70'
                      : 'bg-gray-800 border-gray-600'}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-white text-sm font-semibold">{jobNumberFor(p)}</span>
                      <span className="text-gray-400 text-xs">→</span>
                      <span className="text-skynet-accent text-sm font-medium">
                        {m ? `${m.code} · ${m.name}` : p.machine_id}
                      </span>
                      <span className={`ml-auto px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${confidenceBadge(p.confidence)}`}>
                        {p.confidence}
                      </span>
                    </div>
                    <div className="text-xs text-gray-400 mt-1">
                      {new Date(p.proposed_start).toLocaleString()} → {new Date(p.proposed_end).toLocaleString()}
                      {p.estimated_minutes ? ` · ${p.estimated_minutes} min` : ''}
                    </div>
                    <p className="text-xs text-gray-300 mt-1.5">{p.rationale}</p>
                    <div className="text-[11px] text-gray-500 mt-1">
                      {ev.basis === 'part_history' && ev.runs
                        ? `${ev.runs} runs · ${ev.actual_pcs_per_hour ?? '—'} pcs/hr actual · last ${ev.last_run_at ? new Date(ev.last_run_at).toLocaleDateString() : '—'}`
                        : ev.basis === 'family_history'
                          ? `family evidence · ${ev.runs ?? '—'} runs · ${ev.actual_pcs_per_hour ?? '—'} pcs/hr`
                          : 'no run history — estimate only, your call; the first run creates the history'}
                    </div>

                    {(stale || gone) && (
                      <div className="flex items-center gap-1.5 mt-2 text-[11px] text-amber-300">
                        <Info size={12} />
                        {gone ? 'Job already scheduled — proposal is moot.'
                              : 'Board moved under this one (queue changed). Re-run, or apply with care.'}
                      </div>
                    )}

                    <div className="flex items-center gap-2 mt-2.5">
                      <button
                        onClick={() => handleApply(p)}
                        disabled={gone}
                        className="flex items-center gap-1 px-2.5 py-1 bg-green-700 hover:bg-green-600 disabled:opacity-40 text-white rounded text-xs"
                      >
                        <CheckCircle size={12} /> Apply
                      </button>
                      <button
                        onClick={() => { setDismissingId(p.id); setDismissReason('') }}
                        className="px-2.5 py-1 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded text-xs"
                      >
                        Dismiss
                      </button>
                      <button
                        onClick={() => setWhyOpenId(whyOpenId === p.id ? null : p.id)}
                        className="flex items-center gap-0.5 ml-auto text-xs text-gray-400 hover:text-white"
                      >
                        {whyOpenId === p.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        Why?
                      </button>
                    </div>

                    {dismissingId === p.id && (
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          value={dismissReason}
                          onChange={e => setDismissReason(e.target.value)}
                          placeholder="Why not? (optional — Bob learns from this)"
                          className="flex-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white placeholder-gray-500"
                        />
                        <button
                          onClick={() => confirmDismiss(p)}
                          className="px-2 py-1 bg-red-800 hover:bg-red-700 text-white rounded text-xs"
                        >
                          Confirm
                        </button>
                      </div>
                    )}

                    {whyOpenId === p.id && (
                      <pre className="mt-2 p-2 bg-gray-950 border border-gray-700 rounded text-[10px] text-gray-400 overflow-x-auto">
{JSON.stringify(ev, null, 2)}
                      </pre>
                    )}
                  </div>
                )
              })}

              {Array.isArray(run.data_gaps) && run.data_gaps.length > 0 && (
                <div className="p-2.5 bg-gray-800/60 border border-gray-700 rounded-lg">
                  <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Data gaps</div>
                  {run.data_gaps.map((g, i) => (
                    <div key={i} className="text-xs text-gray-400">• {g}</div>
                  ))}
                </div>
              )}

              {settledProposals.length > 0 && (
                <div className="text-[11px] text-gray-500 pt-1">
                  {settledProposals.filter(p => p.status === 'applied').length} applied ·{' '}
                  {settledProposals.filter(p => p.status === 'dismissed').length} dismissed ·{' '}
                  {settledProposals.filter(p => p.status === 'superseded').length} superseded ·{' '}
                  {settledProposals.filter(p => p.status === 'expired').length} expired
                </div>
              )}
            </>
          )}
        </div>

        {/* Standing rules footer */}
        <div className="border-t border-gray-700 bg-gray-800/60">
          <button
            onClick={() => setShowPolicies(v => !v)}
            className="w-full flex items-center gap-1.5 px-4 py-2 text-xs text-gray-400 hover:text-white"
          >
            {showPolicies ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Standing rules ({policies.length})
          </button>
          {showPolicies && (
            <div className="px-4 pb-3 space-y-1.5">
              {policies.map(pol => (
                <div key={pol.id} className="flex items-start gap-2 text-xs text-gray-300">
                  <span className="flex-1">{pol.policy_text}</span>
                  <button
                    onClick={() => deactivatePolicy(pol.id)}
                    className="text-gray-500 hover:text-red-400 shrink-0"
                    title="Retire this rule"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <input
                  value={newPolicy}
                  onChange={e => setNewPolicy(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addPolicy() }}
                  placeholder='e.g. "Keep PB09 free on Fridays for short runs"'
                  className="flex-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-white placeholder-gray-500"
                />
                <button
                  onClick={addPolicy}
                  className="flex items-center gap-1 px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs"
                >
                  <Plus size={12} /> Add
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
