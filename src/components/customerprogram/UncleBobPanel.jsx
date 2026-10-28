// Ask Uncle Bob — customer program dashboard (S16 Batch C, D-CPROG-13, 14, 16).
// Anyone on the roster can ask. Bob answers from the dashboard snapshot and the email trail
// (minus hidden messages and anything kept from him), cites what he used, and can draft a
// reply to copy — he never sends anything. Every question and answer stays in a shared history.

import { useState, useEffect, useCallback } from 'react'
import { Loader2, Brain, Copy, ChevronDown, ChevronRight, AlertTriangle, Mail } from 'lucide-react'
import { askUncleBob, buildBobSnapshot, listBobThreads } from '../../lib/uncleBobProgram'

const starters = (name) => [
  "What's holding up each open order?",
  `What did we last tell ${name} about deposits?`,
  'Which lots are ready to ship, and which are long-stud?',
  'What can ship on terms right now?',
  `What has ${name} asked us that we haven't answered?`,
  `Draft a reply to ${name}'s latest email.`,
]

const fmtWhen = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const CITE_STYLE = {
  email: 'border-amber-800 bg-amber-900/20 text-amber-300',
  order: 'border-cyan-800 bg-cyan-900/20 text-cyan-300',
  money: 'border-green-800 bg-green-900/20 text-green-300',
}

function Answer({ a, onOpenEmail }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    const d = a.draft
    await navigator.clipboard.writeText(`${d.subject ? `Subject: ${d.subject}\n\n` : ''}${d.body}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="space-y-3">
      <div className="text-gray-200 text-sm whitespace-pre-wrap leading-relaxed">{a.answer}</div>
      {(a.citations || []).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {a.citations.map((c, i) => (
            <button key={i} type="button" title={c.label}
              onClick={() => c.kind === 'email' && c.email_id && onOpenEmail(c.email_id)}
              className={`px-1.5 py-0.5 rounded border text-xs ${CITE_STYLE[c.kind] || 'border-gray-700 bg-gray-800 text-gray-400'} ${c.kind === 'email' ? 'hover:underline' : 'cursor-default'}`}>
              {c.kind === 'email' ? <><Mail size={10} className="inline mr-1" />{c.label}</> : c.label || c.ref}
            </button>
          ))}
        </div>
      )}
      {a.draft && (
        <div className="border border-gray-700 rounded p-3 bg-gray-950">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-gray-400">Draft — review before sending. Uncle Bob does not send anything.</div>
            <button type="button" onClick={copy} className="inline-flex items-center gap-1 px-2 py-1 rounded border text-xs bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-700">
              <Copy size={12} />{copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {(a.draft.to || []).length > 0 && <div className="text-xs text-gray-500">To: {a.draft.to.join(', ')}</div>}
          {a.draft.subject && <div className="text-xs text-gray-400 mb-2">Subject: {a.draft.subject}</div>}
          <div className="text-sm text-gray-200 whitespace-pre-wrap">{a.draft.body}</div>
        </div>
      )}
      {(a.data_gaps || []).length > 0 && (
        <div className="text-xs text-gray-500">
          <div className="uppercase mb-1">Couldn&apos;t tell from the data</div>
          <ul className="list-disc ml-4 space-y-0.5">{a.data_gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
        </div>
      )}
    </div>
  )
}

export default function UncleBobPanel({ bundle, model, today, onOpenEmail }) {
  const [question, setQuestion] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [latest, setLatest] = useState(null)
  const [history, setHistory] = useState([])
  const [open, setOpen] = useState(null)

  const loadHistory = useCallback(async () => {
    try { setHistory(await listBobThreads(bundle.program.id)) } catch (err) { setError(err.message) }
  }, [bundle.program.id])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  const ask = async (q) => {
    const text = String(q ?? question).trim()
    if (!text || running) return
    setRunning(true)
    setError(null)
    setLatest(null)
    try {
      const result = await askUncleBob(bundle.program.code, text, buildBobSnapshot(bundle, model, today))
      setLatest({ question: text, ...result })
      setQuestion('')
    } catch (err) {
      setError(err.message)
    } finally {
      setRunning(false)
      loadHistory()
    }
  }

  return (
    <div className="space-y-4">
      <section className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
        <h2 className="text-white font-semibold text-sm flex items-center gap-2"><Brain size={14} />Ask Uncle Bob about {bundle.program.name}</h2>
        <textarea value={question} onChange={e => setQuestion(e.target.value)} rows={3} maxLength={2000}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ask() }}
          placeholder="Ask about orders, deposits, lots, or what Kaytech has said. Ctrl+Enter to ask."
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:border-cyan-500 focus:outline-none" />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => ask()} disabled={running || !question.trim()}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded border text-sm font-medium bg-cyan-700 hover:bg-cyan-600 text-white border-cyan-600 disabled:opacity-40">
            {running ? <Loader2 size={14} className="animate-spin" /> : <Brain size={14} />}{running ? 'Thinking…' : 'Ask'}
          </button>
          {starters(bundle.program.name.split(' ')[0]).map(s => (
            <button key={s} type="button" disabled={running} onClick={() => ask(s)}
              className="px-2 py-1 rounded border border-gray-700 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs disabled:opacity-40">{s}</button>
          ))}
        </div>
        <div className="text-gray-600 text-xs">
          Uncle Bob reads this dashboard and the email trail. He never sees attachments, hidden messages, or anything marked
          ITAR / EAR / CUI or kept from him. He reads and drafts; he never sends or changes anything.
        </div>
        {error && <div className="text-sm text-red-300 flex items-center gap-2"><AlertTriangle size={14} />{error}</div>}
        {latest && (
          <div className="border-t border-gray-800 pt-3">
            <div className="text-white text-sm font-medium mb-2">{latest.question}</div>
            <Answer a={latest} onOpenEmail={onOpenEmail} />
            <div className="text-gray-600 text-xs mt-2">
              Read {latest.email_counts?.included ?? 0} emails{latest.email_counts?.excluded ? `; ${latest.email_counts.excluded} hidden or kept from him` : ''}{latest.email_counts?.truncated ? `; ${latest.email_counts.truncated} oldest left out for length` : ''}.
            </div>
          </div>
        )}
      </section>

      <section className="bg-gray-900 border border-gray-800 rounded-lg">
        <div className="px-4 py-3 border-b border-gray-800 text-white font-semibold text-sm">Questions the team has asked</div>
        {history.length === 0 ? <div className="p-4 text-gray-500 text-sm">None yet.</div> : (
          <ul className="divide-y divide-gray-800">
            {history.map(h => (
              <li key={h.id} className="px-4 py-2">
                <button type="button" onClick={() => setOpen(open === h.id ? null : h.id)} className="w-full text-left flex items-start gap-2">
                  {open === h.id ? <ChevronDown size={14} className="text-gray-500 mt-0.5" /> : <ChevronRight size={14} className="text-gray-500 mt-0.5" />}
                  <span className="text-sm text-gray-200">{h.question}</span>
                  <span className="ml-auto text-xs text-gray-500 whitespace-nowrap">{h.asker?.full_name || '—'} · {fmtWhen(h.created_at)}</span>
                </button>
                {open === h.id && (
                  <div className="ml-6 mt-2">
                    {h.error ? <div className="text-sm text-red-300">{h.error}</div>
                      : h.answer ? <Answer a={h} onOpenEmail={onOpenEmail} />
                        : <div className="text-sm text-gray-500">Still working, or it stopped before answering.</div>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
