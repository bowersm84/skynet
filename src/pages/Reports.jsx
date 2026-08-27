import { useState, useEffect, useCallback } from 'react'
import { FileSpreadsheet, ArrowLeft, Download, AlertTriangle, Info, Play } from 'lucide-react'
import { canExportReports } from '../lib/roles'
import { supabase } from '../lib/supabase'
import ReportAdvisorPanel from '../components/ReportAdvisorPanel'
import { fetchReports, runReport, toCsv, downloadCsv, reportFilename, summarize } from '../lib/reports'

const PREVIEW_CAP = 200

// D-RPT-12: per-slug presentation config for the sales reports.
// CSV headers stay the stable registry column names (wk1..wk8) — the weekly
// automation contract wins; only the on-screen headers show dates.
const WEEK_LABEL_SLUGS = ['drop-calendar-8wk', 'drop-calendar-by-part']
const FILTER_COLUMNS = {
  'drop-calendar-8wk': ['customer', 'salesperson'],
  'drop-calendar-by-part': ['customers'],
  'wip-near-term': ['customer', 'salesperson'],
}
const STANDING_NOTES = {
  'drop-calendar-8wk': 'Dates are off-the-machine, not ship dates.',
  'drop-calendar-by-part': 'Dates are off-the-machine, not ship dates.',
  'wip-near-term': 'Made but not shipped — parts past the machines, still moving through finishing, compliance, or outside vendors.',
}
const ROW_HIGHLIGHTERS = {
  'drop-calendar-8wk': (r) =>
    r.risk ? 'bg-red-900/25' : (r.days_late_vs_customer != null && r.days_late_vs_customer !== '' ? 'bg-amber-900/20' : ''),
  'wip-near-term': (r) =>
    (r.days_past_due != null && r.days_past_due !== '') ? 'bg-red-900/25'
      : (Number(r.days_since_moved) > 30 ? 'bg-amber-900/20' : ''),
}

export default function Reports({ profile }) {
  const [reports, setReports] = useState([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState(null)
  const [active, setActive] = useState(null)
  const [rows, setRows] = useState(null)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState(null)
  // D-RPT-12: presentation state for the sales reports
  const [weekLabels, setWeekLabels] = useState({})
  const [filterText, setFilterText] = useState('')
  const [sortCol, setSortCol] = useState(null)
  const [sortDir, setSortDir] = useState('asc')
  const [ranAt, setRanAt] = useState(null)

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
    setFilterText('')
    setSortCol(null)
    setSortDir('asc')
    setWeekLabels({})
    if (WEEK_LABEL_SLUGS.includes(report.slug)) {
      // Week-ending labels for on-screen headers only; CSV keeps wk1..wk8.
      supabase.from('v_report_week_labels').select('week_no, label').then(({ data: wl }) => {
        if (wl) setWeekLabels(Object.fromEntries(wl.map(w => [`wk${w.week_no}`, `W/E ${w.label}`])))
      })
    }
    try {
      const data = await runReport(report)
      setRows(data)
      setRanAt(new Date())
    } catch (err) {
      setRunError(err.message || String(err))
    } finally {
      setRunning(false)
    }
  }, [])

  const displayRows = (() => {
    if (!rows) return null
    let out = rows
    const cols = FILTER_COLUMNS[active?.slug]
    const ft = filterText.trim().toLowerCase()
    if (cols && ft) {
      out = out.filter(r => cols.some(c => String(r[c] ?? '').toLowerCase().includes(ft)))
    }
    if (sortCol) {
      const dir = sortDir === 'desc' ? -1 : 1
      out = [...out].sort((a, b) => {
        const av = a[sortCol]; const bv = b[sortCol]
        if (av == null && bv == null) return 0
        if (av == null) return 1
        if (bv == null) return -1
        const an = Number(av); const bn = Number(bv)
        if (!Number.isNaN(an) && !Number.isNaN(bn)) return (an - bn) * dir
        return String(av).localeCompare(String(bv)) * dir
      })
    }
    return out
  })()

  const handleDownload = () => {
    if (!active || !displayRows) return
    const filtered = filterText.trim() !== ''
    const name = reportFilename(active.slug).replace(/\.csv$/, filtered ? '_filtered.csv' : '.csv')
    downloadCsv(toCsv(displayRows, active.columns), name)
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

        {rows && (STANDING_NOTES[active.slug] || ranAt) && (
          <div className="flex items-center justify-between gap-3 flex-wrap bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5 mb-4">
            <p className="text-amber-300/90 text-xs font-medium">
              {STANDING_NOTES[active.slug] || ''}
            </p>
            {ranAt && (
              <p className="text-gray-500 text-xs font-mono shrink-0">
                Data pulled {ranAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </p>
            )}
          </div>
        )}

        {rows && FILTER_COLUMNS[active.slug] && rows.length > 0 && (
          <div className="flex items-center gap-3 mb-3">
            <input
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Filter by customer / salesperson..."
              className="w-72 px-3 py-1.5 bg-gray-900 border border-gray-800 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
            />
            {filterText.trim() !== '' && (
              <span className="text-gray-500 text-xs">
                {displayRows.length.toLocaleString()} of {rows.length.toLocaleString()} rows — CSV exports the filtered set
              </span>
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
            {displayRows.length > PREVIEW_CAP && (
              <p className="text-gray-500 text-xs px-4 py-2 border-b border-gray-800">
                Preview capped at {PREVIEW_CAP} rows — the CSV download contains all {displayRows.length.toLocaleString()} rows.
              </p>
            )}
            <div className="overflow-auto max-h-[60vh] pb-4">
              <table className="text-xs w-full">
                <thead className="sticky top-0 bg-gray-800">
                  <tr>
                    {active.columns.map(c => (
                      <th
                        key={c}
                        onClick={() => {
                          if (sortCol === c) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
                          else { setSortCol(c); setSortDir('asc') }
                        }}
                        className="text-left text-gray-400 font-medium px-3 py-2 whitespace-nowrap cursor-pointer hover:text-white select-none"
                        title="Click to sort (preview only — CSV keeps the report's default order unless filtered)"
                      >
                        {weekLabels[c] || c}{sortCol === c ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.slice(0, PREVIEW_CAP).map((row, i) => {
                    const hl = ROW_HIGHLIGHTERS[active.slug] ? ROW_HIGHLIGHTERS[active.slug](row) : ''
                    return (
                      <tr key={i} className={`border-t border-gray-800 hover:bg-gray-800/50 ${hl}`}>
                        {active.columns.map(c => (
                          <td key={c} className="text-gray-300 px-3 py-1.5 whitespace-nowrap">
                            {row[c] === null || row[c] === undefined ? '' : String(row[c])}
                          </td>
                        ))}
                      </tr>
                    )
                  })}
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
