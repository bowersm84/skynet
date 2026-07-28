import { Info } from 'lucide-react'
import {
  buildBlankNeed,
  neededFor,
  formatWeek,
  weekSortKey,
  weekKey,
  fmtInt,
} from './forecastUtils'

export default function BlanksSection({ demand, onhand }) {
  const { needed, unmapped } = buildBlankNeed(demand)

  const demandRows = [...(demand || [])].sort((a, b) => {
    const w = weekSortKey(a).localeCompare(weekSortKey(b))
    if (w !== 0) return w
    return String(a.part_number || '').localeCompare(String(b.part_number || ''))
  })

  const onhandRows = [...(onhand || [])].sort((a, b) => {
    const s = String(a.stud_series || '').localeCompare(String(b.stud_series || ''))
    if (s !== 0) return s
    const an = parseFloat(a.stud_length)
    const bn = parseFloat(b.stud_length)
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn
    const l = String(a.stud_length || '').localeCompare(String(b.stud_length || ''))
    if (l !== 0) return l
    return String(a.material_type || '').localeCompare(String(b.material_type || ''))
  })

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Demand */}
        <div className="rounded-lg border border-gray-700 bg-gray-900">
          <div className="px-4 py-3 border-b border-gray-800">
            <h4 className="text-sm font-semibold text-gray-200">Blank Demand</h4>
            <p className="text-xs text-gray-500">Scheduled blank consumption by part and week.</p>
          </div>
          {demandRows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-gray-500">No blank demand in the forecast window.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-800/60 text-gray-400 uppercase text-xs">
                  <tr>
                    <th className="px-3 py-2 text-left">Part Number</th>
                    <th className="px-3 py-2 text-left">Dash</th>
                    <th className="px-3 py-2 text-left">Week</th>
                    <th className="px-3 py-2 text-right">Jobs</th>
                    <th className="px-3 py-2 text-right">Pieces</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {demandRows.map((r, i) => (
                    <tr key={`${r.part_number}-${r.blank_dash ?? 'na'}-${weekKey(r)}-${i}`} className="hover:bg-gray-800/40">
                      <td className="px-3 py-2 font-mono text-white">{r.part_number}</td>
                      <td className="px-3 py-2 text-gray-300">{r.blank_dash ?? '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={r.is_unscheduled ? 'text-gray-400 italic' : 'text-gray-300'}>{formatWeek(r)}</span>
                      </td>
                      <td className="px-3 py-2 text-right text-gray-300">{fmtInt(r.jobs)}</td>
                      <td className="px-3 py-2 text-right text-gray-200">{fmtInt(r.pieces)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* On hand */}
        <div className="rounded-lg border border-gray-700 bg-gray-900">
          <div className="px-4 py-3 border-b border-gray-800">
            <h4 className="text-sm font-semibold text-gray-200">Blanks On Hand</h4>
            <p className="text-xs text-gray-500">Needed chips are demand summed by series + dash.</p>
          </div>
          {onhandRows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-gray-500">No blank stock on hand.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-800/60 text-gray-400 uppercase text-xs">
                  <tr>
                    <th className="px-3 py-2 text-left">Series</th>
                    <th className="px-3 py-2 text-left">Material</th>
                    <th className="px-3 py-2 text-left">Length</th>
                    <th className="px-3 py-2 text-right">On Hand</th>
                    <th className="px-3 py-2 text-left">Needed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {onhandRows.map((r, i) => {
                    const need = neededFor(needed, r)
                    const short = need != null && Number(r.pieces_on_hand ?? 0) < need
                    return (
                      <tr key={`${r.stud_series}-${r.material_type}-${r.stud_length}-${i}`} className="hover:bg-gray-800/40">
                        <td className="px-3 py-2 font-mono text-skynet-accent">{r.stud_series}</td>
                        <td className="px-3 py-2 text-gray-300">{r.material_type}</td>
                        <td className="px-3 py-2 text-gray-300">
                          {r.stud_length}
                          {r.is_unmarked && (
                            <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-300 whitespace-nowrap">unmarked</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-200">{fmtInt(r.pieces_on_hand)}</td>
                        <td className="px-3 py-2">
                          {need == null ? (
                            <span className="text-gray-600">—</span>
                          ) : (
                            <span className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${
                              short ? 'bg-red-900/50 text-red-300' : 'bg-amber-900/40 text-amber-300'
                            }`}>
                              Needed {fmtInt(need)}
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="px-4 py-3 border-t border-gray-800 flex items-start gap-2 text-xs text-gray-500">
            <Info size={14} className="shrink-0 mt-0.5" />
            <span>
              Material (Steel vs Stainless) can&apos;t be inferred from the part number, so a series + dash
              demand total shows on both material rows of that length. Treat the chip as the combined
              requirement across the pair, not a per-row net.
            </span>
          </div>
        </div>
      </div>

      {/* Unmapped demand */}
      {unmapped.length > 0 && (
        <div className="rounded-lg border border-amber-800/40 bg-amber-900/10">
          <div className="px-4 py-3 border-b border-amber-800/30">
            <h4 className="text-sm font-semibold text-amber-200">Unmapped demand ({unmapped.length})</h4>
            <p className="text-xs text-amber-200/60">
              These rows have no blank dash or no series prefix match, so they aren&apos;t counted against any on-hand line.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-amber-900/20 text-amber-200/70 uppercase text-xs">
                <tr>
                  <th className="px-3 py-2 text-left">Part Number</th>
                  <th className="px-3 py-2 text-left">Dash</th>
                  <th className="px-3 py-2 text-left">Week</th>
                  <th className="px-3 py-2 text-right">Pieces</th>
                  <th className="px-3 py-2 text-left">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-amber-900/20">
                {unmapped.map((r, i) => (
                  <tr key={`${r.part_number}-${weekKey(r)}-${i}`} className="hover:bg-amber-900/10">
                    <td className="px-3 py-2 font-mono text-white">{r.part_number}</td>
                    <td className="px-3 py-2 text-gray-300">{r.blank_dash ?? '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-300">{formatWeek(r)}</td>
                    <td className="px-3 py-2 text-right text-gray-200">{fmtInt(r.pieces)}</td>
                    <td className="px-3 py-2 text-amber-200/70 text-xs">{r._reason}</td>
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
