import { Loader2, ExternalLink, ShoppingCart, Wrench } from 'lucide-react'
import { formatDateShort, prodDueForLine } from '../../lib/fishbowl'

// LineDetailPanel — D-FB-44. The dropdown under an Order Queue line.
//  - a line linked to a CO line: the CO line's dates (target / FB due / Prod Due), the work orders
//    its demand is allocated to, and every component with its jobs — the ones the order processor
//    asked for (D-FB-42) plus any the WO makes that nobody asked for. Each component's date is the
//    latest scheduled end of its jobs; the line's Prod Due is the latest of those (the last
//    component off the machine). Assembly, plating and finishing are not in it.
//  - a purchased line on a BOM part: the components the order processor said are being bought.
// Read-only — Customer Service sees exactly what the warehouse sees.

const STATE_LABEL = {
  no_job: 'no job yet', unscheduled: 'not scheduled', scheduled: 'scheduled', running: 'running', made: 'made',
}
const STATE_CLASS = {
  no_job: 'bg-gray-800 text-gray-400 border-gray-700',
  unscheduled: 'bg-amber-900/40 text-amber-300 border-amber-800',
  scheduled: 'bg-blue-900/40 text-blue-300 border-blue-800',
  running: 'bg-cyan-900/40 text-cyan-300 border-cyan-800',
  made: 'bg-green-900/40 text-green-300 border-green-800',
}
const JOB_STATUS_LABEL = (s) => String(s || '').replace(/_/g, ' ')

function ProdDue({ dates }) {
  const pd = prodDueForLine(dates)
  if (!pd) return <span className="text-gray-500">—</span>
  if (pd.kind === 'unsched') return <span className="text-amber-300">unsched.</span>
  if (pd.kind === 'target') return <span className="text-gray-400" title="No work order yet — SkyNet target shown">T {formatDateShort(pd.date)}</span>
  return (
    <span className={pd.late ? 'text-red-300' : 'text-gray-200'} title={pd.late ? 'Scheduled finish is after the SkyNet target' : 'Latest scheduled job end on the allocated work orders'}>
      {formatDateShort(pd.date)}{pd.partial && <span className="text-amber-300" title="Some allocated work is not scheduled yet">+</span>}
    </span>
  )
}

export default function LineDetailPanel({ line, detail, purchaseComponents, colSpan, onOpenCO }) {
  const coLine = line.co_line
  const coNumber = coLine?.customer_order?.co_number
  // D-FB-48: pieces on the CO line that no work order is making yet — typically a Fishbowl quantity
  // increase, which SkyNet adds to the CO line but never to a WO on its own.
  const allocatedQty = (detail?.allocations || []).reduce((s, a) => s + Number(a.quantity_allocated || 0), 0)
  const unallocated = Math.max(Number(coLine?.quantity_ordered || 0) - Number(coLine?.quantity_fulfilled || 0) - allocatedQty, 0)

  return (
    <tr className="bg-gray-950/70">
      <td colSpan={colSpan} className="px-4 py-3">
        {line.customer_order_line_id ? (
          !detail ? (
            <div className="text-xs text-gray-500 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading production detail…</div>
          ) : detail.error ? (
            <div className="text-xs text-red-300">Production detail could not be loaded: {detail.error}. Refresh the page; if it persists, check the console.</div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
                {coNumber && (
                  <span role="link" onClick={() => onOpenCO?.(coNumber)} className="font-mono text-purple-300 hover:text-purple-200 inline-flex items-center gap-1 cursor-pointer">
                    {coNumber} #{coLine?.line_number} <ExternalLink size={10} />
                  </span>
                )}
                <span className="text-gray-400">CO line <span className="text-gray-200 capitalize">{String(coLine?.status || '').replace('_', ' ')}</span> · <span className="font-mono text-gray-200">{Number(coLine?.quantity_ordered || 0).toLocaleString()}</span> pcs</span>
                <span className="text-gray-400" title="Later of entered + 45 business days and the Fishbowl due date">Target <span className="font-mono text-gray-200">{formatDateShort(detail.dates?.target_date)}</span></span>
                <span className="text-gray-400">FB due <span className="font-mono text-gray-200">{formatDateShort(detail.dates?.fb_due_date)}</span></span>
                <span className="text-gray-400">Prod Due <span className="font-mono"><ProdDue dates={detail.dates} /></span></span>
                {detail.allocations.length > 0 ? (
                  <span className="text-gray-400 flex items-center gap-1 flex-wrap">WO
                    {detail.allocations.map((a) => (
                      <span key={a.work_order?.id || a.work_order?.wo_number} className="font-mono text-gray-200 px-1.5 py-0.5 rounded border border-gray-700 bg-gray-800" title={`${a.work_order?.status || ''} · ${Number(a.quantity_allocated).toLocaleString()} pcs allocated`}>
                        {a.work_order?.wo_number} <span className="text-gray-500">{Number(a.quantity_allocated).toLocaleString()}</span>
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="text-amber-300/80">no work order yet</span>
                )}
                {detail.allocations.length > 0 && unallocated > 0 && (
                  <span className="text-amber-300" title="On the CO line but not allocated to any work order — add it to a WO (Edit WO) or create one from Demand">
                    +{unallocated.toLocaleString()} pcs not on a WO yet
                  </span>
                )}
              </div>

              {detail.components.length === 0 ? (
                <div className="text-xs text-gray-500">No components recorded for this line{coLine?.components_needed ? ` — note: ${coLine.components_needed}` : ''}.</div>
              ) : (
                <table className="text-xs w-full max-w-4xl">
                  <thead className="text-gray-500 uppercase text-[10px]">
                    <tr>
                      <th className="text-left px-2 py-1">Component</th>
                      <th className="text-left px-2 py-1">Type</th>
                      <th className="text-left px-2 py-1">Status</th>
                      <th className="text-left px-2 py-1">Jobs</th>
                      <th className="text-left px-2 py-1" title="Latest scheduled end across this component's jobs">Ready by</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/60">
                    {detail.components.map((c) => (
                      <tr key={c.component_id}>
                        <td className="px-2 py-1">
                          <span className="font-mono text-gray-200">{c.part_number}</span>
                          {!c.requested && <span className="ml-2 text-[10px] text-gray-500" title="On the work order, but not in the CO line's Components Needed">on WO only</span>}
                          {c.description && <span className="ml-2 text-gray-500 hidden xl:inline">{c.description}</span>}
                        </td>
                        <td className="px-2 py-1 text-gray-500 capitalize">{String(c.part_type || '').replace('_', ' ')}</td>
                        <td className="px-2 py-1">
                          <span className={`inline-flex px-1.5 py-0.5 rounded border ${STATE_CLASS[c.state] || STATE_CLASS.no_job}`}>{STATE_LABEL[c.state] || c.state}</span>
                        </td>
                        <td className="px-2 py-1 text-gray-400">
                          {(c.jobs || []).length === 0 ? <span className="text-gray-600">—</span> : (c.jobs || []).map((j) => (
                            <span key={j.job_number} className="inline-block mr-2 whitespace-nowrap" title={`${j.wo_number || ''} · ${JOB_STATUS_LABEL(j.status)}${j.merged_into ? ` · merged into ${j.merged_into}` : ''}`}>
                              <span className="font-mono text-gray-200">{j.job_number}</span>
                              <span className="text-gray-500"> {JOB_STATUS_LABEL(j.status)}{j.machine ? ` · ${j.machine}` : ''} · {Number(j.quantity || 0).toLocaleString()}</span>
                            </span>
                          ))}
                        </td>
                        <td className="px-2 py-1 font-mono">
                          {c.latest_scheduled_end ? <span className={c.has_unscheduled ? 'text-amber-300' : 'text-gray-200'}>{formatDateShort(c.latest_scheduled_end)}{c.has_unscheduled ? '+' : ''}</span>
                            : c.state === 'no_job' ? <span className="text-gray-600">—</span> : <span className="text-amber-300">unsched.</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {coLine?.components_needed && detail.components.length > 0 && (
                <div className="text-xs text-gray-400"><span className="text-gray-600">Note:</span> {coLine.components_needed}</div>
              )}
              <div className="text-[11px] text-gray-600 flex items-center gap-1"><Wrench size={10} /> Prod Due is the last component off the machine — assembly, plating and finishing are not included.</div>
            </div>
          )
        ) : (
          <div className="text-xs text-gray-400 flex items-center gap-2 flex-wrap">
            <ShoppingCart size={12} className="text-blue-300" /> Purchasing:
            {(purchaseComponents || []).length === 0 ? <span className="text-gray-500">whole part</span>
              : (purchaseComponents || []).map((c) => (
                <span key={c.component_id} className="font-mono text-blue-200 px-1.5 py-0.5 rounded border border-blue-900 bg-blue-900/20">{c.component?.part_number || c.part_number}</span>
              ))}
          </div>
        )}
      </td>
    </tr>
  )
}
