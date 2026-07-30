import { useState } from 'react'
import { ChevronDown, ChevronRight, AlertTriangle, Package, Lock, Pencil } from 'lucide-react'
import MachinesCell from './MachinesCell'
import { usePartDimensionEditor } from './usePartDimensionEditor'
import { PartDimensionEditorModal } from './PartDimensionEditor'
import {
  buildBarGroups,
  indexBarParts,
  barPartsFor,
  formatWeek,
  weekKey,
  fmtInt,
  fmtBars,
  isFullyStaged,
} from './forecastUtils'

// Basis badges. Weekly rows key off has_estimates; part rows off basis.
function EstimateBadge({ hasEstimates }) {
  return hasEstimates ? (
    <span className="text-xs px-2 py-0.5 rounded bg-amber-900/50 text-amber-300 whitespace-nowrap">Incl. estimates</span>
  ) : (
    <span className="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-300 whitespace-nowrap">Actuals</span>
  )
}

function BasisBadge({ basis }) {
  return basis === 'geometric' ? (
    <span className="text-xs px-2 py-0.5 rounded bg-amber-900/50 text-amber-300 whitespace-nowrap">Estimated</span>
  ) : (
    <span className="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-300 whitespace-nowrap">Actuals</span>
  )
}

// bars_needed = 0 with pieces > 0 is a fully staged in-progress job, not a gap.
function BarsNeededCell({ row }) {
  if (isFullyStaged(row)) {
    return (
      <span className="text-xs px-2 py-0.5 rounded bg-cyan-900/50 text-cyan-300 whitespace-nowrap">Fully staged</span>
    )
  }
  return <span className="text-gray-200">{fmtBars(row.bars_needed)}</span>
}

function RemainingCell({ value }) {
  if (value == null) return <span className="text-gray-500">—</span>
  const v = Number(value)
  return (
    <span className={v < 0 ? 'text-red-400 font-semibold' : 'text-gray-200'}>{fmtBars(v)}</span>
  )
}

function lockTooltip(lock) {
  if (!lock) return 'Human-verified material and bar size.'
  const bits = ['Human-verified material and bar size.']
  const when = lock.corrected_at
    ? new Date(lock.corrected_at).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    })
    : null
  if (lock.corrected_by_name || when) {
    bits.push(`Corrected by ${lock.corrected_by_name || 'unknown'}${when ? ` on ${when}` : ''}.`)
  }
  if (lock.correction_note) bits.push(`Note: ${lock.correction_note}`)
  if (lock.history) {
    bits.push(`history: ${lock.history.bar_size} (${lock.history.jobs} job${lock.history.jobs === 1 ? '' : 's'})`)
  }
  return bits.join('\n')
}

// A part inside a week's drill-down. Owns its own correction modal so the
// editor is scoped to exactly the part whose row was clicked.
function PartRow({
  part, dims, lock, materialOptions, barSizeOptions, canCorrect, profile, onCorrected,
}) {
  const [open, setOpen] = useState(false)

  // Prefilled with what the forecast is bucketing on RIGHT NOW — which for an
  // empirical part comes from job history, not part_dimensions.
  const current = {
    length_in: dims?.length_in,
    material_type: part.material_type,
    bar_size: part.bar_size,
  }

  const editor = usePartDimensionEditor({
    partNumber: part.part_number,
    mode: 'correction',
    current,
    existingRow: dims,
    materialOptions,
    barSizeOptions,
    profile,
    onSaved: async () => {
      const { material_type: material, bar_size: barSize } = editor.form
      await onCorrected(`${part.part_number} moved to ${barSize} ${material}`)
    },
  })

  return (
    <>
      <tr className="hover:bg-gray-800/40">
        <td className="px-3 py-2 font-mono text-white whitespace-nowrap">
          <span className="inline-flex items-center gap-1.5">
            {part.part_number}
            {lock && (
              <span
                title={lockTooltip(lock)}
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-sky-900/50 text-sky-300 cursor-help"
              >
                <Lock size={10} />
                Verified
              </span>
            )}
          </span>
        </td>
        <td className="px-3 py-2"><MachinesCell machines={part.machines} /></td>
        <td className="px-3 py-2 text-right text-gray-300">{fmtInt(part.pieces)}</td>
        <td className="px-3 py-2 text-right">
          {isFullyStaged(part)
            ? <span className="text-xs px-2 py-0.5 rounded bg-cyan-900/50 text-cyan-300 whitespace-nowrap">Fully staged</span>
            : <span className="text-gray-300">{fmtBars(part.bars_needed)}</span>}
        </td>
        <td className="px-3 py-2"><BasisBadge basis={part.basis} /></td>
        <td className="px-3 py-2 text-center">
          {canCorrect ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              title={`Correct the material or bar size for ${part.part_number}`}
              aria-label={`Correct material for ${part.part_number}`}
              className="inline-flex items-center justify-center p-1 rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
            >
              <Pencil size={13} />
            </button>
          ) : (
            <span className="text-gray-700">—</span>
          )}
        </td>
      </tr>

      {open && (
        <tr>
          <td colSpan={6} className="p-0">
            <PartDimensionEditorModal
              partNumber={part.part_number}
              editor={editor}
              onClose={() => setOpen(false)}
            />
          </td>
        </tr>
      )}
    </>
  )
}

export default function BarForecastTable({
  bars,
  barParts,
  dimsByPart = {},
  lockContext = {},
  materialOptions = [],
  barSizeOptions = [],
  canCorrect = false,
  profile = null,
  onCorrected,
}) {
  const groups = buildBarGroups(bars)
  const partIndex = indexBarParts(barParts)

  // Groups that run short open expanded — the shortfall is the reason to look.
  const [expandedGroups, setExpandedGroups] = useState(
    () => new Set(groups.filter(g => g.hasShortfall).map(g => g.key))
  )
  const [expandedWeeks, setExpandedWeeks] = useState(() => new Set())

  const toggleGroup = (key) => setExpandedGroups(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  const toggleWeek = (key) => setExpandedWeeks(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  if (groups.length === 0) {
    return (
      <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-12 text-center">
        <Package size={40} className="mx-auto text-gray-600 mb-3" />
        <p className="text-gray-400">No bar-stock demand in the forecast window.</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {groups.map(group => {
        const isOpen = expandedGroups.has(group.key)
        return (
          <div
            key={group.key}
            className={`rounded-lg border ${group.hasShortfall ? 'border-red-800/60 bg-red-950/20' : 'border-gray-700 bg-gray-900'}`}
          >
            {/* Group header */}
            <button
              type="button"
              onClick={() => toggleGroup(group.key)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-800/40 transition-colors rounded-lg"
            >
              {isOpen ? <ChevronDown size={16} className="text-gray-400 shrink-0" /> : <ChevronRight size={16} className="text-gray-400 shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-white font-semibold">{group.material_type || '—'}</span>
                  <span className="font-mono text-skynet-accent">{group.bar_size || '—'}</span>
                  {group.hasShortfall && (
                    <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-red-900/60 text-red-300 whitespace-nowrap">
                      <AlertTriangle size={12} />
                      {group.firstShortfall}
                    </span>
                  )}
                  {group.hasEstimates && <EstimateBadge hasEstimates />}
                </div>
              </div>
              <div className="flex items-center gap-6 shrink-0 text-sm">
                <div className="text-right">
                  <div className="text-xs text-gray-500 uppercase">On hand</div>
                  <div className="text-gray-200">{fmtBars(group.bars_on_hand)}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-gray-500 uppercase">Bars needed</div>
                  <div className="text-gray-200">{fmtBars(group.totalBarsNeeded)}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-gray-500 uppercase">Worst remaining</div>
                  <div className={group.worstRemaining != null && group.worstRemaining < 0 ? 'text-red-400 font-semibold' : 'text-gray-200'}>
                    {group.worstRemaining == null ? '—' : fmtBars(group.worstRemaining)}
                  </div>
                </div>
              </div>
            </button>

            {/* Weekly rows */}
            {isOpen && (
              <div className="border-t border-gray-800 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-800/60 text-gray-400 uppercase text-xs">
                    <tr>
                      <th className="px-3 py-2 text-left w-8"></th>
                      <th className="px-3 py-2 text-left">Week</th>
                      <th className="px-3 py-2 text-right">Jobs</th>
                      <th className="px-3 py-2 text-right">Pieces</th>
                      <th className="px-3 py-2 text-right">Bars Needed</th>
                      <th className="px-3 py-2 text-left">Basis</th>
                      <th className="px-3 py-2 text-right">Cum. Bars</th>
                      <th className="px-3 py-2 text-right">Projected Remaining</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {group.rows.map(row => {
                      const wKey = `${group.key}|||${weekKey(row)}`
                      const parts = barPartsFor(partIndex, row)
                      const weekOpen = expandedWeeks.has(wKey)
                      return [
                        <tr
                          key={wKey}
                          onClick={() => parts.length > 0 && toggleWeek(wKey)}
                          className={`${parts.length > 0 ? 'cursor-pointer hover:bg-gray-800/40' : ''} ${Number(row.projected_remaining ?? 0) < 0 ? 'bg-red-950/20' : ''}`}
                        >
                          <td className="px-3 py-2 text-gray-500">
                            {parts.length > 0 && (weekOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span className={row.is_unscheduled ? 'text-gray-400 italic' : 'text-gray-200'}>{formatWeek(row)}</span>
                          </td>
                          <td className="px-3 py-2 text-right text-gray-300">{fmtInt(row.jobs)}</td>
                          <td className="px-3 py-2 text-right text-gray-300">{fmtInt(row.pieces)}</td>
                          <td className="px-3 py-2 text-right"><BarsNeededCell row={row} /></td>
                          <td className="px-3 py-2"><EstimateBadge hasEstimates={row.has_estimates} /></td>
                          <td className="px-3 py-2 text-right text-gray-300">{fmtBars(row.cum_bars)}</td>
                          <td className="px-3 py-2 text-right"><RemainingCell value={row.projected_remaining} /></td>
                        </tr>,

                        weekOpen && parts.length > 0 && (
                          <tr key={`${wKey}-parts`} className="bg-gray-950/60">
                            <td colSpan={8} className="px-3 py-3">
                              <div className="rounded border border-gray-800 overflow-x-auto">
                                <table className="w-full text-xs">
                                  <thead className="bg-gray-900 text-gray-500 uppercase">
                                    <tr>
                                      <th className="px-3 py-2 text-left">Part Number</th>
                                      <th className="px-3 py-2 text-left">Machines</th>
                                      <th className="px-3 py-2 text-right">Pieces</th>
                                      <th className="px-3 py-2 text-right">Bars Needed</th>
                                      <th className="px-3 py-2 text-left">Basis</th>
                                      <th className="px-3 py-2 text-center">Action</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-800">
                                    {parts.map((p, i) => (
                                      <PartRow
                                        key={`${p.part_number}-${i}`}
                                        part={p}
                                        dims={dimsByPart[p.part_number]}
                                        lock={lockContext[p.part_number] || null}
                                        materialOptions={materialOptions}
                                        barSizeOptions={barSizeOptions}
                                        canCorrect={canCorrect}
                                        profile={profile}
                                        onCorrected={onCorrected}
                                      />
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        ),
                      ]
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
