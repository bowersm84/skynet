import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import {
  AlertTriangle, Loader2, CheckCircle, Package,
  ChevronDown, ChevronUp, Check, Cpu
} from 'lucide-react'
import { getWOFulfillmentSummary } from '../lib/woFulfillment'
import AllocationResolutionModal from './AllocationResolutionModal'

const PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 }

// Format a date-only 'YYYY-MM-DD' value in local TZ without UTC drift.
// (Same pattern as Mainframe.jsx / OutsourcedJobs.jsx.)
function formatDateOnly(dateStr) {
  if (!dateStr) return '—'
  const [y, m, d] = String(dateStr).split('-').map(Number)
  if (!y || !m || !d) return '—'
  const localDate = new Date(y, m - 1, d)
  return localDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function renderPriorityPill(priority) {
  const styles = {
    critical: 'bg-red-950/60 text-red-300 border-red-700',
    high: 'bg-orange-950/60 text-orange-300 border-orange-700',
    normal: 'bg-gray-800 text-gray-300 border-gray-600',
    low: 'bg-gray-900 text-gray-500 border-gray-700',
  }
  const cls = styles[priority] || styles.normal
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] border ${cls}`}>
      {priority || 'normal'}
    </span>
  )
}

// One-line CO impact summary like "2 of 3 CO lines short by 391".
function buildImpactSummary(rows) {
  if (!rows || rows.length === 0) return 'No CO allocations on this WO'
  const short = rows.filter(r => r.remaining > 0)
  const totalShort = short.reduce((acc, r) => acc + r.remaining, 0)
  return `${short.length} of ${rows.length} CO lines short by ${totalShort}`
}

/**
 * Per-job shortfalls list. Loads open rows from job_shortfall_resolutions
 * and renders one card per job. CO impact context still surfaces from the
 * job's parent WO via getWOFulfillmentSummary.
 */
export default function WOLookupShortfalls({ profile, onNavigateToWO, onResolved }) {
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState([])
  const [fulfillmentCache, setFulfillmentCache] = useState({}) // woId -> rows
  const [stockVariancesOpen, setStockVariancesOpen] = useState(false)
  const [expandedRows, setExpandedRows] = useState({}) // shortfall row id -> bool

  // Resolution modal state.
  const [modalCtx, setModalCtx] = useState(null) // { row, initialResolution }
  const [submitting, setSubmitting] = useState(false) // for plan-only Acknowledge

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('job_shortfall_resolutions')
        .select(`
          id, job_id, work_order_id, job_quantity,
          produced_quantity, shortfall_quantity, status, created_at,
          job:jobs!job_id (
            id, job_number, quantity,
            assigned_machine:machines!assigned_machine_id ( id, name ),
            component:parts!component_id ( id, part_number )
          ),
          work_order:work_orders ( id, wo_number )
        `)
        .eq('status', 'open')
        .order('created_at', { ascending: false })

      if (error) throw error
      setRows(data || [])

      // Load CO fulfillment per WO (used for both the impact summary and
      // the per-card detail table + modal). De-duplicate WO ids.
      const woIds = Array.from(new Set((data || []).map(r => r.work_order_id))).filter(Boolean)
      const next = {}
      await Promise.all(woIds.map(async woId => {
        next[woId] = await getWOFulfillmentSummary(woId)
      }))
      setFulfillmentCache(prev => ({ ...prev, ...next }))
    } catch (err) {
      console.error('Failed to load shortfalls:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const openResolutionModal = (row, initialResolution) => {
    setModalCtx({ row, initialResolution })
  }
  const closeResolutionModal = () => setModalCtx(null)

  // Plan-only one-click: close the shortfall as acknowledged. CO allocations
  // untouched because by definition there's no customer demand on this WO.
  const submitAcknowledgePlan = async (row) => {
    setSubmitting(true)
    try {
      const now = new Date().toISOString()
      const { error: updErr } = await supabase
        .from('job_shortfall_resolutions')
        .update({
          resolution: 'acknowledge_plan',
          status: 'resolved',
          resolved_by: profile?.id ?? null,
          resolved_at: now,
        })
        .eq('id', row.id)
      if (updErr) throw updErr

      await supabase
        .from('jobs')
        .update({ has_open_shortfall: false })
        .eq('id', row.job_id)

      try {
        await supabase.from('audit_logs').insert({
          event_type: 'shortfall_acknowledged',
          operator_id: profile?.id ?? null,
          details: {
            job_id: row.job_id,
            work_order_id: row.work_order_id,
            resolution_id: row.id,
            shortfall_qty: row.shortfall_quantity,
          },
        })
      } catch (auditErr) {
        console.error('Audit log write failed (non-blocking):', auditErr)
      }
      await load()
      onResolved?.()
    } catch (err) {
      console.error('acknowledge_plan failed:', err)
      alert('Failed to acknowledge: ' + err.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={32} className="animate-spin text-skynet-accent" />
      </div>
    )
  }

  // Each job-row card is "demand" if any CO line on its parent WO still has
  // remaining > 0; otherwise "plan_only". Compute at render time from
  // already-loaded fulfillment data.
  const isDemandRow = (row) => {
    const ful = fulfillmentCache[row.work_order_id]
    return (ful || []).some(r => r.remaining > 0)
  }
  const demandRows = rows.filter(isDemandRow)
  const planRows = rows.filter(r => !isDemandRow(r))

  const partForRow = (row) => row.job?.component || null

  const toggleExpanded = (rowId) => {
    setExpandedRows(prev => ({ ...prev, [rowId]: !prev[rowId] }))
  }

  // CO detail table — data source is the eagerly-loaded fulfillmentCache.
  const renderCODetailTable = (ful) => {
    if (!ful) {
      return (
        <div className="mt-3 p-3 bg-gray-900/40 border border-gray-800 rounded text-xs text-gray-500 flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" />
          Loading CO detail…
        </div>
      )
    }
    if (ful.length === 0) {
      return (
        <div className="mt-3 p-3 bg-gray-900/40 border border-gray-800 rounded text-xs text-gray-500">
          No active CO allocations on this WO.
        </div>
      )
    }
    const sortedRows = [...ful].sort((a, b) => {
      const aDue = a.due_date || '9999-12-31'
      const bDue = b.due_date || '9999-12-31'
      if (aDue !== bDue) return aDue.localeCompare(bDue)
      return (PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99)
    })
    return (
      <div className="mt-3 overflow-x-auto border border-gray-800 rounded">
        <table className="w-full text-xs table-fixed">
          <colgroup>
            <col style={{ width: '25%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '13%' }} />
          </colgroup>
          <thead className="bg-gray-900/60 text-gray-500">
            <tr className="border-b border-gray-800">
              <th className="text-left font-medium px-2 py-1">Customer</th>
              <th className="text-left font-medium px-2 py-1">PO #</th>
              <th className="text-left font-medium px-2 py-1">Line</th>
              <th className="text-right font-medium px-2 py-1">Ordered</th>
              <th className="text-right font-medium px-2 py-1">Fulfilled</th>
              <th className="text-right font-medium px-2 py-1">Remaining</th>
              <th className="text-left font-medium px-2 py-1">Due</th>
              <th className="text-left font-medium px-2 py-1">Priority</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map(r => {
              const cancelled = r.status === 'cancelled'
              const atRisk = !cancelled && r.remaining > 0
              const baseTextCls = cancelled ? 'text-gray-500 line-through' : 'text-gray-300'
              const rowBgCls = cancelled
                ? 'bg-gray-900/40'
                : atRisk
                  ? 'bg-amber-950/30'
                  : ''
              const remainingCls = cancelled
                ? 'text-gray-500 line-through'
                : atRisk
                  ? 'text-amber-300 font-medium'
                  : 'text-gray-300'
              return (
                <tr
                  key={r.allocation_id}
                  title={cancelled ? 'CO line cancelled' : undefined}
                  className={`border-b border-gray-800/60 last:border-b-0 ${rowBgCls}`}
                >
                  <td className={`px-2 py-1 truncate ${baseTextCls}`}>{r.customer_name || '—'}</td>
                  <td className={`px-2 py-1 truncate ${baseTextCls}`}>{r.po_number || '—'}</td>
                  <td className={`px-2 py-1 ${baseTextCls}`}>#{r.line_number}</td>
                  <td className={`px-2 py-1 text-right ${baseTextCls}`}>{r.ordered}</td>
                  <td className={`px-2 py-1 text-right ${baseTextCls}`}>{r.fulfilled}</td>
                  <td className={`px-2 py-1 text-right ${remainingCls}`}>
                    {r.satisfied
                      ? <span className="inline-flex items-center gap-1 text-green-400"><Check size={12} /> 0</span>
                      : r.remaining}
                  </td>
                  <td className={`px-2 py-1 ${baseTextCls}`}>{formatDateOnly(r.due_date)}</td>
                  <td className="px-2 py-1">
                    {cancelled
                      ? <span className="text-gray-500 line-through">{r.priority || 'normal'}</span>
                      : renderPriorityPill(r.priority)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      {rows.length === 0 ? (
        <div className="text-center py-12">
          <CheckCircle size={48} className="mx-auto text-emerald-500 mb-3" />
          <p className="text-gray-400">No open shortfalls</p>
        </div>
      ) : (
        <>
          {/* Customer Impact section */}
          <section>
            <h3 className="text-sm font-semibold text-red-300 flex items-center gap-2 mb-3">
              <AlertTriangle size={16} className="text-red-400" />
              Customer Impact ({demandRows.length})
            </h3>
            {demandRows.length === 0 ? (
              <p className="text-gray-500 text-sm">No demand-type shortfalls.</p>
            ) : (
              <div className="space-y-2">
                {demandRows.map(row => {
                  const part = partForRow(row)
                  const ful = fulfillmentCache[row.work_order_id]
                  const isExpanded = !!expandedRows[row.id]
                  const machineName = row.job?.assigned_machine?.name
                  return (
                    <div key={row.id} className="bg-red-950/20 border border-red-800/50 rounded-lg p-3">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="text-white font-mono text-sm">
                              {row.job?.job_number || '—'}
                            </span>
                            {part && (
                              <span className="text-gray-300 font-mono text-sm flex items-center gap-1">
                                <Package size={12} className="text-gray-500" />
                                {part.part_number}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 mb-1 flex items-center gap-3 flex-wrap">
                            {machineName && (
                              <span className="flex items-center gap-1">
                                <Cpu size={11} className="text-gray-600" />
                                {machineName}
                              </span>
                            )}
                            <span className="text-gray-600">·</span>
                            <span>
                              WO:{' '}
                              <button
                                onClick={() => onNavigateToWO?.(row.work_order?.wo_number)}
                                className="text-skynet-accent hover:underline font-mono"
                              >
                                {row.work_order?.wo_number}
                              </button>
                            </span>
                          </div>
                          <button
                            onClick={() => toggleExpanded(row.id)}
                            className="text-xs text-gray-400 hover:text-gray-200 mb-1 flex items-center gap-1"
                            aria-expanded={isExpanded}
                            title={isExpanded ? 'Hide CO detail' : 'Show CO detail'}
                          >
                            {buildImpactSummary(ful)}
                            {isExpanded
                              ? <ChevronUp size={12} className="text-gray-500" />
                              : <ChevronDown size={12} className="text-gray-500" />}
                          </button>
                          <div className="text-xs flex items-center gap-3 flex-wrap text-gray-400">
                            <span>Target: <span className="text-gray-200">{row.job_quantity}</span></span>
                            <span>Produced: <span className="text-gray-200">{row.produced_quantity}</span></span>
                            <span className="text-red-300 font-medium">Short by {row.shortfall_quantity}</span>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => openResolutionModal(row, 'accept_short')}
                            className="px-3 py-1.5 text-xs bg-blue-900/40 hover:bg-blue-900/60 text-blue-300 border border-blue-800 rounded flex items-center gap-1.5"
                          >
                            <Package size={12} /> Allocate
                          </button>
                        </div>
                      </div>
                      {isExpanded && renderCODetailTable(ful)}
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* Stock Build Variances section — collapsed by default */}
          <section>
            <button
              onClick={() => setStockVariancesOpen(o => !o)}
              className="w-full text-left text-sm font-semibold text-gray-300 flex items-center gap-2 mb-2 hover:text-white"
            >
              <span className={`inline-block transition-transform ${stockVariancesOpen ? 'rotate-90' : ''}`}>▶</span>
              Stock Build Variances ({planRows.length})
            </button>
            {stockVariancesOpen && (
              planRows.length === 0 ? (
                <p className="text-gray-500 text-sm pl-5">No stock-build variances.</p>
              ) : (
                <div className="space-y-2 pl-5">
                  {planRows.map(row => {
                    const part = partForRow(row)
                    const machineName = row.job?.assigned_machine?.name
                    return (
                      <div key={row.id} className="bg-gray-800/50 border border-gray-700 rounded-lg p-3">
                        <div className="flex items-start justify-between gap-3 flex-wrap">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <span className="text-white font-mono text-sm">
                                {row.job?.job_number || '—'}
                              </span>
                              {part && (
                                <span className="text-gray-300 font-mono text-sm flex items-center gap-1">
                                  <Package size={12} className="text-gray-500" />
                                  {part.part_number}
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 mb-1 flex items-center gap-3 flex-wrap">
                              {machineName && (
                                <span className="flex items-center gap-1">
                                  <Cpu size={11} className="text-gray-600" />
                                  {machineName}
                                </span>
                              )}
                              <span className="text-gray-600">·</span>
                              <span>
                                WO:{' '}
                                <button
                                  onClick={() => onNavigateToWO?.(row.work_order?.wo_number)}
                                  className="text-skynet-accent hover:underline font-mono"
                                >
                                  {row.work_order?.wo_number}
                                </button>
                              </span>
                            </div>
                            <div className="text-xs flex items-center gap-3 flex-wrap text-gray-400">
                              <span>Target: <span className="text-gray-200">{row.job_quantity}</span></span>
                              <span>Produced: <span className="text-gray-200">{row.produced_quantity}</span></span>
                              <span className="text-amber-300">Short by {row.shortfall_quantity}</span>
                            </div>
                          </div>
                          <button
                            onClick={() => submitAcknowledgePlan(row)}
                            disabled={submitting}
                            className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded flex items-center gap-1 disabled:opacity-50"
                          >
                            {submitting && <Loader2 size={12} className="animate-spin" />}
                            Acknowledge
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            )}
          </section>
        </>
      )}

      {/* Unified allocation + resolution modal */}
      <AllocationResolutionModal
        isOpen={!!modalCtx}
        shortfall={modalCtx?.row || null}
        workOrder={modalCtx ? {
          id: modalCtx.row?.work_order?.id,
          wo_number: modalCtx.row?.work_order?.wo_number,
          part_number: partForRow(modalCtx.row)?.part_number || null,
        } : null}
        job={modalCtx ? modalCtx.row?.job : null}
        coRows={modalCtx ? (fulfillmentCache[modalCtx.row?.work_order_id] || []) : []}
        producedQuantity={modalCtx?.row?.produced_quantity ?? 0}
        jobQuantity={modalCtx?.row?.job_quantity ?? 0}
        initialResolution={modalCtx?.initialResolution || 'accept_short'}
        profile={profile}
        onClose={closeResolutionModal}
        onSuccess={async () => {
          closeResolutionModal()
          await load()
          onResolved?.()
        }}
      />
    </div>
  )
}
