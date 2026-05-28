import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { X, Combine, AlertCircle, Clock } from 'lucide-react'

// Local-noon UTC date conversion (matches OutsourcedJobs convention)
const localDateToISO = (yyyymmdd) => {
  if (!yyyymmdd) return null
  const [y, m, d] = yyyymmdd.split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0).toISOString()
}

function deriveOperationType(stepName) {
  const s = (stepName || '').toLowerCase()
  if (s.includes('heat')) return 'heat_treat'
  if (s.includes('plat')) return 'cad_plating'
  if (s.includes('oxide')) return 'black_oxide'
  return 'other'
}

function getVendorSuggestions(stepName) {
  const s = (stepName || '').toLowerCase()
  if (s.includes('heat')) return ['Braddock']
  if (s.includes('plat') || s.includes('oxide')) return ['Electrolab', 'Silverman', 'Pioneer']
  return []
}

function getBatchQty(batch) {
  if (!batch) return 0
  if (batch.compliance_good_qty != null) return batch.compliance_good_qty
  if (batch.compliance_bad_qty != null && batch.verified_count != null) {
    return Math.max(0, batch.verified_count - batch.compliance_bad_qty)
  }
  if (batch.verified_count != null) return batch.verified_count
  return batch.quantity || 0
}

// Eligibility key: part + material lot + operation type. Missing material lot
// = inherently un-combinable (the traceability gate cannot be enforced).
function getGroupKey(row) {
  if (row.sourceKind !== 'finishing') return null
  const partNumber = row.job?.part?.part_number
  const materialLot = row.batch?.material_lot_number
  const opType = deriveOperationType(row.step?.step_name)
  if (!partNumber || !materialLot || !opType) return null
  return `${partNumber}|${materialLot}|${opType}`
}

export default function CombineLikeProductsModal({ readySteps, profile, onClose, onSuccess }) {
  const [selected, setSelected] = useState({})
  const [forms, setForms] = useState({})
  const [submitting, setSubmitting] = useState(null)

  const { groups, uncombinable } = useMemo(() => {
    const finishingRows = readySteps.filter(r => r.sourceKind === 'finishing')
    const byKey = {}
    const noKey = []
    for (const row of finishingRows) {
      const key = getGroupKey(row)
      if (!key) { noKey.push(row); continue }
      if (!byKey[key]) byKey[key] = []
      byKey[key].push(row)
    }
    const realGroups = Object.entries(byKey)
      .filter(([, rows]) => rows.length >= 2)
      .map(([key, rows]) => ({ key, rows }))
    const singletons = Object.entries(byKey)
      .filter(([, rows]) => rows.length < 2)
      .flatMap(([, rows]) => rows)
    return { groups: realGroups, uncombinable: [...noKey, ...singletons] }
  }, [readySteps])

  // Seed selection (all checked) + form defaults for any new group key
  useEffect(() => {
    setSelected(prev => {
      const next = { ...prev }
      for (const g of groups) {
        if (!(g.key in next)) next[g.key] = new Set(g.rows.map(r => r.rowKey))
      }
      return next
    })
    setForms(prev => {
      const next = { ...prev }
      for (const g of groups) {
        if (!(g.key in next)) {
          const stepName = g.rows[0]?.step?.step_name || ''
          next[g.key] = {
            vendor_name: getVendorSuggestions(stepName)[0] || '',
            sent_date: new Date().toISOString().split('T')[0],
            expected_return: '',
            notes: '',
          }
        }
      }
      return next
    })
  }, [groups])

  const toggleRow = (groupKey, rowKey) => {
    setSelected(prev => {
      const set = new Set(prev[groupKey] || [])
      if (set.has(rowKey)) set.delete(rowKey); else set.add(rowKey)
      return { ...prev, [groupKey]: set }
    })
  }

  const updateForm = (groupKey, field, value) => {
    setForms(prev => ({ ...prev, [groupKey]: { ...(prev[groupKey] || {}), [field]: value } }))
  }

  const handleSubmitGroup = async (group) => {
    const form = forms[group.key] || {}
    if (!form.vendor_name?.trim()) { alert('Vendor name is required'); return }
    const sel = selected[group.key] || new Set()
    const rows = group.rows.filter(r => sel.has(r.rowKey))
    if (rows.length < 2) { alert('Select at least 2 items to combine'); return }

    // Defense-in-depth client gate (DB trigger is the final wall)
    const refMat  = rows[0].batch?.material_lot_number
    const refPart = rows[0].job?.part?.part_number
    const refOp   = deriveOperationType(rows[0].step?.step_name)
    const mismatch = rows.some(r =>
      r.batch?.material_lot_number !== refMat ||
      r.job?.part?.part_number !== refPart ||
      deriveOperationType(r.step?.step_name) !== refOp
    )
    if (mismatch) {
      alert('Selected items must share part, material lot, and operation type.')
      return
    }

    setSubmitting(group.key)
    try {
      const groupId = crypto.randomUUID()
      const sentAt = form.sent_date ? localDateToISO(form.sent_date) : new Date().toISOString()
      const inserts = rows.map(row => ({
        source_type: 'finishing_send',
        source_id: row.batch.id,
        routing_step_id: row.step.id,
        job_id: row.job.id,
        work_order_id: row.job.work_order?.id || null,
        job_routing_step_id: row.step.id,
        finishing_send_id: row.batch.id,
        operation_type: deriveOperationType(row.step.step_name),
        vendor_name: form.vendor_name.trim(),
        quantity: getBatchQty(row.batch),
        sent_at: sentAt,
        sent_by: profile.id,
        expected_return_at: form.expected_return || null,
        notes: form.notes?.trim() || null,
        consolidation_group_id: groupId,
      }))

      const { error } = await supabase.from('outbound_sends').insert(inserts)
      if (error) throw error

      onSuccess?.()
    } catch (err) {
      console.error('Combine submit failed:', err)
      alert('Failed to create consolidated send: ' + err.message)
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Combine size={20} className="text-skynet-accent" />
            <h3 className="text-lg font-semibold text-white">Combine Like Products</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {groups.length === 0 && (
            <p className="text-gray-500 text-sm italic text-center py-4">
              {uncombinable.length === 0
                ? 'No ready-to-send items to combine.'
                : 'No items can be combined — no group of 2+ shares the same part, material lot, and operation type.'}
            </p>
          )}

          {groups.map(group => {
            const ref = group.rows[0]
            const partNumber = ref.job?.part?.part_number
            const materialLot = ref.batch?.material_lot_number
            const stepName = ref.step?.step_name
            const sel = selected[group.key] || new Set()
            const form = forms[group.key] || {}
            const suggestions = getVendorSuggestions(stepName)
            const isSubmitting = submitting === group.key
            const totalQty = group.rows
              .filter(r => sel.has(r.rowKey))
              .reduce((acc, r) => acc + getBatchQty(r.batch), 0)

            return (
              <div key={group.key} className="bg-gray-800/40 border border-gray-700 rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm flex-wrap">
                  <span className="text-skynet-accent font-mono">{partNumber}</span>
                  <span className="text-gray-500">·</span>
                  <span className="text-cyan-400 font-mono">Material Lot: {materialLot}</span>
                  <span className="text-gray-500">·</span>
                  <span className="text-orange-400">{stepName}</span>
                </div>

                <div className="space-y-1.5">
                  {group.rows.map(row => {
                    const checked = sel.has(row.rowKey)
                    const batchQty = getBatchQty(row.batch)
                    return (
                      <label
                        key={row.rowKey}
                        className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer border ${
                          checked ? 'bg-skynet-accent/10 border-skynet-accent/40' : 'bg-gray-900/40 border-gray-800'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleRow(group.key, row.rowKey)}
                          className="w-4 h-4 accent-skynet-accent"
                        />
                        <span className="text-xs text-white font-mono">{row.job?.job_number}</span>
                        <span className="text-xs px-1.5 py-0.5 rounded font-mono bg-cyan-900/40 text-cyan-300">
                          Batch {row.batchLetter}
                        </span>
                        <span className="text-xs text-cyan-400 font-mono">
                          FLN: {row.batch?.finishing_lot_number || '—'}
                        </span>
                        <span className="text-xs text-gray-400 ml-auto">{batchQty} pcs</span>
                      </label>
                    )
                  })}
                </div>

                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-gray-700">
                  <div>
                    <label className="block text-gray-500 text-[10px] mb-1">Vendor Name *</label>
                    <input
                      type="text"
                      list={`vendor-list-${group.key}`}
                      value={form.vendor_name || ''}
                      onChange={e => updateForm(group.key, 'vendor_name', e.target.value)}
                      placeholder="Vendor"
                      className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none"
                    />
                    <datalist id={`vendor-list-${group.key}`}>
                      {suggestions.map(v => <option key={v} value={v} />)}
                    </datalist>
                  </div>
                  <div>
                    <label className="block text-gray-500 text-[10px] mb-1">Total</label>
                    <input
                      type="text"
                      value={`${totalQty} pcs (${sel.size} items)`}
                      readOnly
                      className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-gray-400 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-gray-500 text-[10px] mb-1">Date Sent</label>
                    <input
                      type="date"
                      value={form.sent_date || ''}
                      onChange={e => updateForm(group.key, 'sent_date', e.target.value)}
                      className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-gray-500 text-[10px] mb-1">Expected Return</label>
                    <input
                      type="date"
                      value={form.expected_return || ''}
                      onChange={e => updateForm(group.key, 'expected_return', e.target.value)}
                      className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-gray-500 text-[10px] mb-1">Notes</label>
                    <textarea
                      rows={2}
                      value={form.notes || ''}
                      onChange={e => updateForm(group.key, 'notes', e.target.value)}
                      placeholder="Optional notes..."
                      className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-white text-xs focus:border-skynet-accent focus:outline-none resize-none"
                    />
                  </div>
                </div>

                <div className="flex justify-end pt-2">
                  <button
                    onClick={() => handleSubmitGroup(group)}
                    disabled={isSubmitting || sel.size < 2 || !form.vendor_name?.trim()}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-skynet-accent hover:bg-blue-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
                  >
                    {isSubmitting ? <Clock size={13} className="animate-spin" /> : <Combine size={13} />}
                    Combine {sel.size} items
                  </button>
                </div>
              </div>
            )
          })}

          {uncombinable.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wide flex items-center gap-1.5">
                <AlertCircle size={12} /> Not combinable
              </h4>
              <div className="space-y-1.5">
                {uncombinable.map(row => {
                  const reason = !row.batch?.material_lot_number
                    ? 'no material lot recorded'
                    : 'no matching items (singleton group)'
                  return (
                    <div
                      key={row.rowKey}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-900/40 border border-gray-800 opacity-60"
                    >
                      <span className="text-xs text-white font-mono">{row.job?.job_number}</span>
                      <span className="text-xs text-skynet-accent font-mono">{row.job?.part?.part_number}</span>
                      {row.batch?.material_lot_number && (
                        <span className="text-xs text-cyan-400 font-mono">Mat: {row.batch.material_lot_number}</span>
                      )}
                      <span className="text-xs text-gray-500 italic ml-auto">{reason}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-3 border-t border-gray-800 flex justify-end">
          <button onClick={onClose} className="px-4 py-1.5 text-sm text-gray-400 hover:text-white">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
