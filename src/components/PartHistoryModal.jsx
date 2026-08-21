import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { X, Loader2, Printer, History, AlertTriangle } from 'lucide-react'
import { computePartsPerDaySuggestion, effectiveTimePerUnit } from '../lib/scheduling'
import { PRODUCTION_DONE_STATUSES, IN_FLIGHT_STATUSES, EXCLUDED_STATUSES } from '../lib/jobs'

// Most-recent jobs fetched per part. Exact count is still reported so the UI
// and print output can flag truncation.
const JOB_FETCH_LIMIT = 300

// Production-history status basis and the minutes-per-piece helper are shared
// with the scheduler's machine picker (D-SCHED-19) — see lib/jobs.js and
// lib/scheduling.js. Do not redefine them here.

const STATUS_BADGES = {
  complete: 'bg-green-900/50 text-green-300 border-green-700/50',
  manufacturing_complete: 'bg-purple-900/50 text-purple-300 border-purple-700/50',
  pending_tco: 'bg-teal-900/50 text-teal-300 border-teal-700/50',
  in_progress: 'bg-blue-900/50 text-blue-300 border-blue-700/50',
  in_setup: 'bg-blue-900/50 text-blue-300 border-blue-700/50',
  assigned: 'bg-sky-900/50 text-sky-300 border-sky-700/50',
  cancelled: 'bg-red-900/50 text-red-300 border-red-700/50',
  merged: 'bg-gray-700/50 text-gray-300 border-gray-600/50',
  incomplete: 'bg-amber-900/50 text-amber-300 border-amber-700/50'
}

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—')
const humanStatus = (s) => (s || '').replace(/_/g, ' ')
const _esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

// Pieces basis, matching computePartsPerDaySuggestion in lib/scheduling.js.
const piecesFor = (j) => {
  const good = j.good_pieces || 0
  return good > 0 ? good : (j.quantity || 0)
}


// Per-run parts/day for display. Summary rates use the shared D-SCHED-13
// weighted basis instead of averaging these.
const runRate = (j) => {
  const eff = effectiveTimePerUnit(j)
  if (!eff) return null
  return { rate: Math.max(1, Math.round(1440 / eff.tpu)), derived: eff.derived }
}

export default function PartHistoryModal({ part, onClose }) {
  const [loading, setLoading] = useState(true)
  const [jobs, setJobs] = useState([])
  const [totalCount, setTotalCount] = useState(0)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setLoadError(null)
      const { data, error, count } = await supabase
        .from('jobs')
        .select(`
          id, job_number, quantity, good_pieces, bad_pieces, status,
          assigned_machine_id, scheduled_start, scheduled_end,
          actual_start, actual_end, production_start, time_per_unit,
          production_lot_number, is_standalone_finishing, created_at,
          assigned_machine:machines!assigned_machine_id(name, code),
          work_order:work_orders!work_order_id(wo_number, customer, po_number, due_date, status, order_type)
        `, { count: 'exact' })
        .eq('component_id', part.id)
        .order('created_at', { ascending: false })
        .limit(JOB_FETCH_LIMIT)
      if (cancelled) return
      if (error) {
        setLoadError(error.message)
        setJobs([])
        setTotalCount(0)
      } else {
        setJobs(data || [])
        setTotalCount(count ?? (data || []).length)
      }
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [part.id])

  const summary = useMemo(() => {
    const done = jobs.filter(j => PRODUCTION_DONE_STATUSES.includes(j.status))
    const inFlight = jobs.filter(j => IN_FLIGHT_STATUSES.includes(j.status))
    const excluded = jobs.filter(j => EXCLUDED_STATUSES.includes(j.status))

    const totalGood = done.reduce((s, j) => s + (j.good_pieces || 0), 0)
    const totalBad = done.reduce((s, j) => s + (j.bad_pieces || 0), 0)
    const scrapPct = (totalGood + totalBad) > 0
      ? (totalBad / (totalGood + totalBad)) * 100
      : null

    // Runs that yield a usable rate. Standalone finishing jobs never touched a
    // machine, so they carry no machining rate.
    const rateRuns = []
    let derivedCount = 0
    const noRate = []
    for (const j of done) {
      if (j.is_standalone_finishing) continue
      const eff = effectiveTimePerUnit(j)
      if (!eff) { noRate.push(j); continue }
      if (eff.derived) derivedCount += 1
      // Feed the shared helper a normalised run so the weighted average stays
      // single-source-of-truth (D-SCHED-13).
      rateRuns.push({ ...j, time_per_unit: eff.tpu })
    }

    const overall = computePartsPerDaySuggestion(rateRuns, null)

    // Per-machine breakdown, same piece-weighted math as the shared helper.
    const byMachine = new Map()
    for (const r of rateRuns) {
      const key = r.assigned_machine?.name || 'Unassigned'
      if (!byMachine.has(key)) {
        byMachine.set(key, {
          machine: key,
          code: r.assigned_machine?.code || '',
          pieces: 0, minutes: 0, runs: 0, lastRun: null
        })
      }
      const m = byMachine.get(key)
      const pieces = piecesFor(r)
      const tpu = Number(r.time_per_unit)
      if (pieces <= 0 || !(tpu > 0)) continue
      m.pieces += pieces
      m.minutes += pieces * tpu
      m.runs += 1
      const end = r.actual_end ? new Date(r.actual_end) : null
      if (end && (!m.lastRun || end > m.lastRun)) m.lastRun = end
    }
    const machineRows = [...byMachine.values()]
      .map(m => ({
        ...m,
        rate: m.minutes > 0 ? Math.max(1, Math.round(m.pieces / (m.minutes / 1440))) : null
      }))
      .sort((a, b) => (b.rate || 0) - (a.rate || 0))

    const ends = done.map(j => j.actual_end).filter(Boolean).sort()
    return {
      doneCount: done.length,
      inFlightCount: inFlight.length,
      excludedCount: excluded.length,
      totalGood,
      totalBad,
      scrapPct,
      overall,
      machineRows,
      rateRunCount: rateRuns.length,
      derivedCount,
      noRateCount: noRate.length,
      firstRun: ends[0] || null,
      lastRun: ends[ends.length - 1] || null
    }
  }, [jobs])

  const truncated = totalCount > jobs.length
  const basisNote = summary.overall
    ? `weighted over ${summary.rateRunCount} run${summary.rateRunCount === 1 ? '' : 's'}${summary.derivedCount > 0 ? `, ${summary.derivedCount} derived` : ''}`
    : 'no runs with a usable time/unit'

  const handlePrint = () => {
    const now = new Date().toLocaleString()
    const tileCSS = 'border:1px solid #ccc; border-radius:6px; padding:10px 14px; min-width:120px;'
    const thCSS = 'background:#1e293b; color:#fff; padding:6px 8px; text-align:left; font-size:12px; border:1px solid #334155;'
    const tdCSS = 'padding:5px 8px; font-size:12px; border:1px solid #cbd5e1;'

    const summaryTiles = `
      <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px;">
        <div style="${tileCSS}"><div style="font-size:11px; color:#64748b;">Jobs (all time)</div><div style="font-size:20px; font-weight:700;">${totalCount}</div></div>
        <div style="${tileCSS}"><div style="font-size:11px; color:#64748b;">Runs Complete</div><div style="font-size:20px; font-weight:700;">${summary.doneCount}</div></div>
        <div style="${tileCSS}"><div style="font-size:11px; color:#64748b;">In Flight</div><div style="font-size:20px; font-weight:700;">${summary.inFlightCount}</div></div>
        <div style="${tileCSS}"><div style="font-size:11px; color:#64748b;">Good Pieces</div><div style="font-size:20px; font-weight:700;">${summary.totalGood.toLocaleString()}</div></div>
        <div style="${tileCSS}"><div style="font-size:11px; color:#64748b;">Scrap</div><div style="font-size:20px; font-weight:700;">${summary.totalBad.toLocaleString()}${summary.scrapPct != null ? ` <span style="font-size:12px; color:#64748b;">(${summary.scrapPct.toFixed(1)}%)</span>` : ''}</div></div>
        <div style="${tileCSS}"><div style="font-size:11px; color:#64748b;">Historic Run Rate</div><div style="font-size:20px; font-weight:700;">${summary.overall ? `${summary.overall.rate.toLocaleString()} parts/day` : '—'}</div><div style="font-size:10px; color:#94a3b8;">${_esc(basisNote)}</div></div>
      </div>`

    const machineTable = summary.machineRows.length === 0 ? '' : `
      <h3 style="font-size:14px; margin:16px 0 6px;">Run Rate by Machine</h3>
      <table style="border-collapse:collapse; width:100%; margin-bottom:16px;">
        <thead><tr>
          <th style="${thCSS}">Machine</th><th style="${thCSS}">Runs</th>
          <th style="${thCSS}">Pieces</th><th style="${thCSS}">Parts/Day</th>
          <th style="${thCSS}">Last Run</th>
        </tr></thead>
        <tbody>${summary.machineRows.map(m => `
          <tr>
            <td style="${tdCSS}">${_esc(m.machine)}${m.code ? ` (${_esc(m.code)})` : ''}</td>
            <td style="${tdCSS}">${m.runs}</td>
            <td style="${tdCSS}">${m.pieces.toLocaleString()}</td>
            <td style="${tdCSS}">${m.rate != null ? m.rate.toLocaleString() : '—'}</td>
            <td style="${tdCSS}">${m.lastRun ? m.lastRun.toLocaleDateString() : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`

    const historyTable = `
      <h3 style="font-size:14px; margin:16px 0 6px;">Job History${truncated ? ` <span style="font-weight:400; font-size:11px; color:#b45309;">(showing most recent ${jobs.length} of ${totalCount} jobs)</span>` : ''}</h3>
      <table style="border-collapse:collapse; width:100%;">
        <thead><tr>
          <th style="${thCSS}">Job #</th><th style="${thCSS}">WO #</th>
          <th style="${thCSS}">Customer</th><th style="${thCSS}">Machine</th>
          <th style="${thCSS}">Qty</th><th style="${thCSS}">Good</th>
          <th style="${thCSS}">Bad</th><th style="${thCSS}">Status</th>
          <th style="${thCSS}">Prod Start</th><th style="${thCSS}">Completed</th>
          <th style="${thCSS}">Parts/Day</th>
        </tr></thead>
        <tbody>${jobs.map(j => {
          const rr = runRate(j)
          const rateCell = rr ? `${rr.derived ? '~' : ''}${rr.rate.toLocaleString()}` : '—'
          return `
          <tr>
            <td style="${tdCSS}">${_esc(j.job_number)}</td>
            <td style="${tdCSS}">${_esc(j.work_order?.wo_number || '—')}${j.work_order?.order_type === 'make_to_stock' ? ' (MTS)' : ''}</td>
            <td style="${tdCSS}">${_esc(j.work_order?.customer || '—')}</td>
            <td style="${tdCSS}">${_esc(j.assigned_machine?.name || '—')}</td>
            <td style="${tdCSS}">${j.quantity ?? '—'}</td>
            <td style="${tdCSS}">${j.good_pieces ?? 0}</td>
            <td style="${tdCSS}">${j.bad_pieces ?? 0}</td>
            <td style="${tdCSS}">${_esc(humanStatus(j.status))}</td>
            <td style="${tdCSS}">${fmtDate(j.production_start)}</td>
            <td style="${tdCSS}">${fmtDate(j.actual_end)}</td>
            <td style="${tdCSS}">${rateCell}</td>
          </tr>`
        }).join('')}
        </tbody>
      </table>
      <p style="font-size:11px; color:#64748b; margin-top:6px;">
        ~ rate derived from production start → completion because time/unit was not recorded on the run.
        ${summary.noRateCount === 1 ? '1 completed run carries no rate at all (no production start recorded).' : summary.noRateCount > 1 ? `${summary.noRateCount} completed runs carry no rate at all (no production start recorded).` : ''}
      </p>`

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Part History — ${_esc(part.part_number)}</title>
  <style>
    body { margin:0; padding:24px; font-family:Arial,Helvetica,sans-serif; color:#000; background:#fff; }
    @media print { @page { size: landscape; margin: 0.5in; } body { padding:0; } .no-print { display:none; } }
    .toolbar { background:#1e293b; color:#e2e8f0; padding:12px 16px; margin:-24px -24px 24px -24px; display:flex; justify-content:space-between; align-items:center; }
    .toolbar button { background:#2563eb; color:#fff; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-size:13px; font-weight:500; }
  </style>
</head>
<body>
  <div class="toolbar no-print">
    <span>Part History — ${_esc(part.part_number)}</span>
    <button onclick="window.print()">Print</button>
  </div>
  <h2 style="margin:0 0 2px; font-size:20px;">${_esc(part.part_number)}</h2>
  <p style="margin:0 0 4px; color:#475569; font-size:13px;">${_esc(part.description || 'No description')}</p>
  <p style="margin:0 0 16px; color:#94a3b8; font-size:11px;">
    ${summary.firstRun ? `First recorded completion ${fmtDate(summary.firstRun)} — last ${fmtDate(summary.lastRun)}. ` : ''}Rate basis: runs at or past manufacturing complete with a usable time/unit (D-SCHED-13 shared basis).${summary.excludedCount > 0 ? ` ${summary.excludedCount} cancelled/merged job${summary.excludedCount === 1 ? '' : 's'} excluded from totals.` : ''}
  </p>
  ${summaryTiles}
  ${machineTable}
  ${historyTable}
  <div style="border-top:1px solid #999; margin-top:16px; padding-top:8px; display:flex; justify-content:space-between; font-size:12px; color:#666;">
    <span>Generated from SkyNet MES &mdash; ${_esc(now)}</span><span>Skybolt Aeromotive Corp</span>
  </div>
</body>
</html>`

    const win = window.open('', '_blank')
    if (!win) return
    win.document.write(html)
    win.document.close()
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 border border-gray-700 rounded-lg w-full max-w-5xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
          <div className="flex items-center gap-3 min-w-0">
            <History size={20} className="text-cyan-400 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-white font-semibold truncate">
                Part History — <span className="font-mono text-skynet-accent">{part.part_number}</span>
              </h2>
              <p className="text-gray-400 text-sm truncate">{part.description || 'No description'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handlePrint}
              disabled={loading || jobs.length === 0}
              className="flex items-center gap-2 px-3 py-1.5 bg-skynet-accent hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Printer size={16} />
              Print
            </button>
            <button
              onClick={onClose}
              className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {part.part_type === 'purchased' && (
            <div className="flex items-start gap-2 bg-amber-900/20 border border-amber-700/40 rounded-lg p-3">
              <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
              <p className="text-amber-300 text-sm">
                This is a purchased part. Purchase-order and receiving history is planned for a
                future round — this view currently shows manufacturing job history only.
              </p>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16 text-gray-400">
              <Loader2 size={24} className="animate-spin mr-2" /> Loading history…
            </div>
          ) : loadError ? (
            <div className="bg-red-900/20 border border-red-700/40 rounded-lg p-4 text-red-300 text-sm">
              Failed to load history: {loadError}
            </div>
          ) : jobs.length === 0 ? (
            <div className="text-center py-16">
              <History size={40} className="mx-auto text-gray-600 mb-3" />
              <p className="text-gray-400">No jobs have been created for this part yet</p>
            </div>
          ) : (
            <>
              {/* Summary tiles */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-3">
                  <p className="text-gray-500 text-xs">Jobs (all time)</p>
                  <p className="text-white text-xl font-semibold">{totalCount}</p>
                </div>
                <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-3">
                  <p className="text-gray-500 text-xs">Runs Complete</p>
                  <p className="text-green-300 text-xl font-semibold">{summary.doneCount}</p>
                  <p className="text-gray-600 text-[10px] leading-tight">machining done or later</p>
                </div>
                <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-3">
                  <p className="text-gray-500 text-xs">In Flight</p>
                  <p className="text-blue-300 text-xl font-semibold">{summary.inFlightCount}</p>
                </div>
                <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-3">
                  <p className="text-gray-500 text-xs">Good Pieces</p>
                  <p className="text-white text-xl font-semibold">{summary.totalGood.toLocaleString()}</p>
                </div>
                <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-3">
                  <p className="text-gray-500 text-xs">Scrap</p>
                  <p className="text-amber-300 text-xl font-semibold">
                    {summary.totalBad.toLocaleString()}
                    {summary.scrapPct != null && (
                      <span className="text-xs text-gray-500 ml-1">({summary.scrapPct.toFixed(1)}%)</span>
                    )}
                  </p>
                </div>
                <div className="bg-gray-900/60 border border-cyan-800/50 rounded-lg p-3">
                  <p className="text-gray-500 text-xs">Historic Run Rate</p>
                  <p className="text-cyan-300 text-xl font-semibold">
                    {summary.overall ? `${summary.overall.rate.toLocaleString()}/day` : '—'}
                  </p>
                  <p className="text-gray-600 text-[10px] leading-tight">{basisNote}</p>
                </div>
              </div>

              {(summary.noRateCount > 0 || summary.excludedCount > 0) && (
                <p className="text-gray-500 text-xs">
                  {summary.noRateCount > 0 && (
                    <>
                      {summary.noRateCount === 1
                        ? '1 completed run carries no rate (no production start recorded) — it can be repaired from the kiosk job-history admin edit.'
                        : `${summary.noRateCount} completed runs carry no rate (no production start recorded) — they can be repaired from the kiosk job-history admin edit.`}
                    </>
                  )}
                  {summary.noRateCount > 0 && summary.excludedCount > 0 && ' '}
                  {summary.excludedCount > 0 && (
                    <>
                      {summary.excludedCount} cancelled/merged job{summary.excludedCount === 1 ? '' : 's'} shown below but excluded from totals.
                    </>
                  )}
                </p>
              )}

              {/* Per-machine breakdown */}
              {summary.machineRows.length > 0 && (
                <div>
                  <h3 className="text-gray-300 text-sm font-medium mb-2">Run Rate by Machine</h3>
                  <div className="overflow-x-auto border border-gray-700 rounded-lg">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-900/60">
                        <tr className="text-gray-400 text-xs">
                          <th className="text-left px-3 py-2">Machine</th>
                          <th className="text-right px-3 py-2">Runs</th>
                          <th className="text-right px-3 py-2">Pieces</th>
                          <th className="text-right px-3 py-2">Parts/Day</th>
                          <th className="text-right px-3 py-2">Last Run</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.machineRows.map(m => (
                          <tr key={m.machine} className="border-t border-gray-700/60">
                            <td className="px-3 py-2 text-gray-200">
                              {m.machine}{m.code ? <span className="text-gray-500"> ({m.code})</span> : null}
                            </td>
                            <td className="px-3 py-2 text-right text-gray-300">{m.runs}</td>
                            <td className="px-3 py-2 text-right text-gray-300">{m.pieces.toLocaleString()}</td>
                            <td className="px-3 py-2 text-right text-cyan-300 font-medium">
                              {m.rate != null ? m.rate.toLocaleString() : '—'}
                            </td>
                            <td className="px-3 py-2 text-right text-gray-400">
                              {m.lastRun ? m.lastRun.toLocaleDateString() : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Job history table */}
              <div>
                <h3 className="text-gray-300 text-sm font-medium mb-2">
                  Job History
                  {truncated && (
                    <span className="text-amber-400/80 text-xs font-normal ml-2">
                      showing most recent {jobs.length} of {totalCount} jobs
                    </span>
                  )}
                </h3>
                <div className="overflow-x-auto border border-gray-700 rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-900/60">
                      <tr className="text-gray-400 text-xs">
                        <th className="text-left px-3 py-2">Job #</th>
                        <th className="text-left px-3 py-2">WO #</th>
                        <th className="text-left px-3 py-2">Customer</th>
                        <th className="text-left px-3 py-2">Machine</th>
                        <th className="text-right px-3 py-2">Qty</th>
                        <th className="text-right px-3 py-2">Good</th>
                        <th className="text-right px-3 py-2">Bad</th>
                        <th className="text-left px-3 py-2">Status</th>
                        <th className="text-left px-3 py-2">Prod Start</th>
                        <th className="text-left px-3 py-2">Completed</th>
                        <th className="text-right px-3 py-2">Parts/Day</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobs.map(j => {
                        const rr = runRate(j)
                        return (
                          <tr key={j.id} className="border-t border-gray-700/60">
                            <td className="px-3 py-2 font-mono text-skynet-accent">{j.job_number}</td>
                            <td className="px-3 py-2 text-gray-300">
                              {j.work_order?.wo_number || '—'}
                              {j.work_order?.order_type === 'make_to_stock' && (
                                <span className="text-emerald-400/70 text-xs ml-1">MTS</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-gray-400">{j.work_order?.customer || '—'}</td>
                            <td className="px-3 py-2 text-gray-300">{j.assigned_machine?.name || '—'}</td>
                            <td className="px-3 py-2 text-right text-gray-300">{j.quantity ?? '—'}</td>
                            <td className="px-3 py-2 text-right text-green-300">{j.good_pieces ?? 0}</td>
                            <td className="px-3 py-2 text-right text-amber-300">{j.bad_pieces ?? 0}</td>
                            <td className="px-3 py-2">
                              <span className={`text-xs px-2 py-0.5 rounded border capitalize ${STATUS_BADGES[j.status] || 'bg-gray-700/50 text-gray-300 border-gray-600/50'}`}>
                                {humanStatus(j.status)}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-gray-400">{fmtDate(j.production_start)}</td>
                            <td className="px-3 py-2 text-gray-400">{fmtDate(j.actual_end)}</td>
                            <td className="px-3 py-2 text-right text-cyan-300">
                              {rr ? (
                                <span title={rr.derived ? 'Derived from production start → completion; time/unit not recorded on this run' : 'Recorded at completion'}>
                                  {rr.derived && <span className="text-gray-500">~</span>}
                                  {rr.rate.toLocaleString()}
                                </span>
                              ) : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-gray-600 text-xs mt-2">
                  ~ rate derived from production start → completion because time/unit was not recorded on the run.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
