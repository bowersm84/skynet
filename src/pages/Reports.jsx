import { useState, useEffect, useCallback } from 'react'
import { FileSpreadsheet, ArrowLeft, Download, AlertTriangle, Info, Play } from 'lucide-react'
import { canExportReports } from '../lib/roles'
import ReportAdvisorPanel from '../components/ReportAdvisorPanel'
import { fetchReports, runReport, toCsv, downloadCsv, reportFilename, summarize } from '../lib/reports'

const PREVIEW_CAP = 200

export default function Reports({ profile }) {
  const [reports, setReports] = useState([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState(null)
  const [active, setActive] = useState(null)
  const [rows, setRows] = useState(null)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetchReports(profile)
        if (!cancelled) setReports(r)
      } catch (err) {
        if (!cancelled) setListError(err.message || String(err))
      } finally {
        if (!cancelled) setListLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [profile])

  const openReport = useCallback(async (report) => {
    setActive(report)
    setRows(null)
    setRunError(null)
    setRunning(true)
    try {
      const data = await runReport(report)
      setRows(data)
    } catch (err) {
      setRunError(err.message || String(err))
    } finally {
      setRunning(false)
    }
  }, [])

  const handleDownload = () => {
    if (!active || !rows) return
    downloadCsv(toCsv(rows, active.columns), reportFilename(active.slug))
  }

  // ------------------------------ result view ------------------------------
  if (active) {
    const summary = rows ? summarize(active.slug, rows) : null
    return (
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => { setActive(null); setRows(null); setRunError(null) }}
              className="flex items-center gap-2 px-3 py-2 rounded text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
            >
              <ArrowLeft size={16} />
              <span className="text-sm">All Reports</span>
            </button>
            <h2 className="text-white text-lg font-semibold">{active.name}</h2>
            {rows && (
              <span className="text-gray-500 text-sm">{rows.length.toLocaleString()} rows</span>
            )}
          </div>
          {rows && canExportReports(profile) && (
            <button
              onClick={handleDownload}
              className="flex items-center gap-2 px-4 py-2 rounded bg-skynet-accent text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <Download size={16} />
              Download CSV
            </button>
          )}
        </div>

        {running && (
          <div className="flex items-center gap-3 text-gray-400 py-12 justify-center">
            <div className="w-5 h-5 border-2 border-skynet-accent border-t-transparent rounded-full animate-spin"></div>
            <span className="font-mono text-sm">Running report...</span>
          </div>
        )}

        {runError && (
          <div className="flex items-start gap-3 bg-red-900/30 border border-red-700 rounded-lg p-4 mb-4">
            <AlertTriangle size={18} className="text-red-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-red-300 text-sm font-medium">Report failed</p>
              <p className="text-red-400/80 text-sm mt-1 font-mono">{runError}</p>
            </div>
          </div>
        )}

        {rows && rows.length > 0 && canExportReports(profile) && (
          <ReportAdvisorPanel profile={profile} report={active} rows={rows} />
        )}

        {rows && summary && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
            <div className="flex items-center gap-2 mb-3">
              <Info size={16} className="text-skynet-accent" />
              <h3 className="text-white text-sm font-semibold">What is this telling me</h3>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
              {summary.cards.map(card => (
                <div
                  key={card.label}
                  className={`rounded-lg p-3 border ${card.alert ? 'bg-amber-900/20 border-amber-700/60' : 'bg-gray-800 border-gray-700'}`}
                >
                  <p className={`text-2xl font-semibold ${card.alert ? 'text-amber-300' : 'text-white'}`}>{card.value}</p>
                  <p className="text-gray-500 text-xs mt-1">{card.label}</p>
                </div>
              ))}
            </div>
            <p className="text-gray-300 text-sm leading-relaxed">{summary.narrative}</p>
            {active.explainer && (
              <p className="text-gray-500 text-xs leading-relaxed mt-3 border-t border-gray-800 pt-3">
                {active.explainer}
              </p>
            )}
          </div>
        )}

        {rows && rows.length === 0 && !runError && (
          <div className="text-center py-12 text-gray-500">
            <p className="text-sm">0 rows returned.</p>
            <p className="text-xs mt-1">If a non-empty result was expected, do not use this output — investigate first.</p>
          </div>
        )}

        {rows && rows.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            {rows.length > PREVIEW_CAP && (
              <p className="text-gray-500 text-xs px-4 py-2 border-b border-gray-800">
                Preview capped at {PREVIEW_CAP} rows — the CSV download contains all {rows.length.toLocaleString()} rows.
              </p>
            )}
            <div className="overflow-auto max-h-[60vh]">
              <table className="text-xs w-full">
                <thead className="sticky top-0 bg-gray-800">
                  <tr>
                    {active.columns.map(c => (
                      <th key={c} className="text-left text-gray-400 font-medium px-3 py-2 whitespace-nowrap">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, PREVIEW_CAP).map((row, i) => (
                    <tr key={i} className="border-t border-gray-800 hover:bg-gray-800/50">
                      {active.columns.map(c => (
                        <td key={c} className="text-gray-300 px-3 py-1.5 whitespace-nowrap">
                          {row[c] === null || row[c] === undefined ? '' : String(row[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ------------------------------- list view -------------------------------
  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <FileSpreadsheet size={20} className="text-skynet-accent" />
        <h2 className="text-white text-lg font-semibold">Reports</h2>
      </div>

      {listLoading && (
        <div className="flex items-center gap-3 text-gray-400 py-12 justify-center">
          <div className="w-5 h-5 border-2 border-skynet-accent border-t-transparent rounded-full animate-spin"></div>
          <span className="font-mono text-sm">Loading reports...</span>
        </div>
      )}

      {listError && (
        <div className="flex items-start gap-3 bg-red-900/30 border border-red-700 rounded-lg p-4">
          <AlertTriangle size={18} className="text-red-400 mt-0.5 flex-shrink-0" />
          <p className="text-red-300 text-sm font-mono">{listError}</p>
        </div>
      )}

      {!listLoading && !listError && reports.length === 0 && (
        <p className="text-gray-500 text-sm text-center py-12">No reports available for your role.</p>
      )}

      <div className="space-y-3">
        {reports.map(report => (
          <div
            key={report.id}
            className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex items-center justify-between gap-4"
          >
            <div>
              <h3 className="text-white text-sm font-semibold">{report.name}</h3>
              {report.description && (
                <p className="text-gray-500 text-xs mt-1">{report.description}</p>
              )}
            </div>
            <button
              onClick={() => openReport(report)}
              className="flex items-center gap-2 px-4 py-2 rounded bg-skynet-accent text-white text-sm font-medium hover:opacity-90 transition-opacity flex-shrink-0"
            >
              <Play size={14} />
              Run
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
