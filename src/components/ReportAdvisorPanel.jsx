// Uncle Bob — Reports Advisor panel (D-RPT-06). Read-only commentary on the
// report the user just ran. Proposes nothing, applies nothing, and never
// touches the CSV export path (D-RPT-02).
import { useState } from 'react'
import { Loader2, RefreshCw, AlertTriangle, ChevronDown, ChevronRight, Eye, HelpCircle } from 'lucide-react'
import { buildReportEnvelope, invokeReportAdvisor, recordAdvisorRun } from '../lib/reportAdvisor'

const confidenceBadge = (c) =>
  c === 'high'   ? 'bg-green-900/60 text-green-300 border border-green-700' :
  c === 'medium' ? 'bg-yellow-900/60 text-yellow-300 border border-yellow-700' :
                   'bg-gray-700 text-gray-300 border border-gray-600'

export default function ReportAdvisorPanel({ profile, report, rows }) {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [expanded, setExpanded] = useState(true)
  const [showAbout, setShowAbout] = useState(false)

  const run = async () => {
    if (running || !profile?.id || !rows) return
    setRunning(true)
    setError(null)
    const envelope = buildReportEnvelope(report, rows)
    try {
      const data = await invokeReportAdvisor(envelope)
      if (!data?.envelope) throw new Error('Empty envelope from report-advisor')
      setResult(data)
      setExpanded(true)
      await recordAdvisorRun({ profile, report, envelope, result: data })
    } catch (e) {
      setError(e.message || String(e))
      await recordAdvisorRun({ profile, report, envelope, error: e })
    } finally {
      setRunning(false)
    }
  }

  const reading = result?.envelope
  const observations = Array.isArray(reading?.observations) ? reading.observations : []
  const watchItems = Array.isArray(reading?.watch_items) ? reading.watch_items : []
  const dataGaps = Array.isArray(reading?.data_gaps) ? reading.data_gaps : []

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg mb-4">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
        <span className="text-lg leading-none select-none" role="img" aria-label="Uncle Bob">🤔</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <h3 className="text-white text-sm font-semibold leading-tight">Uncle Bob&apos;s Read</h3>
            <button
              onClick={() => setShowAbout(v => !v)}
              className="text-gray-400 hover:text-white"
              title="What is this?"
            >
              <HelpCircle size={13} />
            </button>
          </div>
          <p className="text-xs text-gray-500 leading-tight">
            AI commentary — reads the report, changes nothing
          </p>
        </div>
        {result && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="text-gray-400 hover:text-white mr-1"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        )}
        <button
          onClick={run}
          disabled={running || !rows?.length}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
        >
          {running ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {running ? 'Thinking…' : (result ? 'Re-run' : 'Ask Uncle Bob')}
        </button>
      </div>

      {showAbout && (
        <div className="px-4 py-3 border-b border-gray-800 bg-gray-800/60 text-xs text-gray-400 leading-relaxed">
          Uncle Bob reads a summarized version of this report — totals, groupings, and an
          evenly-spaced sample of rows — and tells you what he notices. He works from the
          same numbers shown above, he never sees the whole result set, and he cannot change
          any data. The figures and the CSV are produced without him; this is commentary on
          top of them.
        </div>
      )}

      <div className="px-4 py-3">
        {error && (
          <div className="flex items-start gap-2 p-2.5 bg-red-900/40 border border-red-700 rounded-lg text-sm text-red-200 mb-3">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <div>
              <p>{error}</p>
              <p className="text-red-300/70 text-xs mt-1">
                The report and its CSV export are unaffected — this is commentary only.
              </p>
            </div>
          </div>
        )}

        {!result && !running && !error && (
          <p className="text-gray-500 text-sm">
            Ask Uncle Bob for a plain-English read of what this report is showing.
          </p>
        )}

        {running && (
          <p className="text-gray-400 text-sm font-mono">
            Reading {rows.length.toLocaleString()} rows…
          </p>
        )}

        {result && expanded && (
          <div className="space-y-3">
            {reading?.reading && (
              <p className="text-gray-200 text-sm leading-relaxed">{reading.reading}</p>
            )}

            {observations.length > 0 && (
              <div className="space-y-2">
                {observations.map((o, i) => (
                  <div key={i} className="bg-gray-800 border border-gray-700 rounded-lg p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-gray-200 text-sm leading-relaxed flex-1">{o.text}</p>
                      {o.confidence && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${confidenceBadge(o.confidence)}`}>
                          {o.confidence}
                        </span>
                      )}
                    </div>
                    {o.evidence && (
                      <p className="text-gray-500 text-xs mt-1.5 font-mono">{o.evidence}</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {watchItems.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Eye size={13} className="text-gray-400" />
                  <p className="text-gray-400 text-xs font-medium">Worth a look</p>
                </div>
                <ul className="list-disc list-inside space-y-0.5">
                  {watchItems.map((w, i) => (
                    <li key={i} className="text-gray-300 text-sm">{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {dataGaps.length > 0 && (
              <div className="border-t border-gray-800 pt-2.5">
                <p className="text-gray-500 text-xs font-medium mb-1">Couldn&apos;t determine from this data</p>
                <ul className="list-disc list-inside space-y-0.5">
                  {dataGaps.map((g, i) => (
                    <li key={i} className="text-gray-500 text-xs">{g}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
