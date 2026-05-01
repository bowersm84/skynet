import { useState, useEffect, useRef, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { X, Plus, Trash2, ChevronDown, Search, Loader2 } from 'lucide-react'
import { formatCONumber } from '../lib/customerOrders'

// Customer combobox — searchable picker over public.customers (active only).
// Same UX pattern as ProductCombobox in CreateWorkOrderModal.jsx; duplicated
// inline per Batch B brief (extraction to a shared component is a future cleanup).
function CustomerCombobox({ value, onChange, customers }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const wrapperRef = useRef(null)
  const inputRef = useRef(null)

  const selected = customers.find(c => c.id === value)

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return customers
    return customers.filter(c =>
      (c.customer_id || '').toLowerCase().includes(q) ||
      (c.name || '').toLowerCase().includes(q)
    )
  }, [search, customers])

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen(o => !o)
          setTimeout(() => inputRef.current?.focus(), 10)
        }}
        className="w-full min-w-0 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:border-skynet-accent flex items-center justify-between gap-2 text-left"
      >
        <span className="flex-1 min-w-0 truncate">
          {selected ? (
            <>
              <span className="font-mono">{selected.customer_id}</span>
              <span className="text-gray-400"> — {selected.name}</span>
            </>
          ) : (
            <span className="text-gray-400">-- Select Customer --</span>
          )}
        </span>
        <ChevronDown size={16} className="text-gray-400 flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-gray-800 border border-gray-600 rounded shadow-2xl max-h-80 flex flex-col">
          <div className="relative p-2 border-b border-gray-700 flex-shrink-0">
            <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search customer ID or name..."
              className="w-full pl-8 pr-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-white placeholder-gray-500 text-sm focus:border-skynet-accent focus:outline-none"
            />
          </div>
          <div className="overflow-y-auto flex-1">
            {matches.length === 0 ? (
              <div className="text-gray-500 text-sm text-center py-4">No customers match.</div>
            ) : matches.map(c => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  onChange(c.id)
                  setOpen(false)
                  setSearch('')
                }}
                className={`w-full text-left px-3 py-2 text-sm border-t border-gray-700/50 ${
                  value === c.id
                    ? 'bg-skynet-accent/20 hover:bg-skynet-accent/30'
                    : 'hover:bg-gray-700'
                }`}
              >
                <span className="font-mono text-white">{c.customer_id}</span>
                <span className="text-gray-400"> — {c.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Part picker — same shape as the customer combobox, scoped to the part types
// COs can reference (assemblies / finished goods / manufactured parts).
function PartCombobox({ value, onChange, parts }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const wrapperRef = useRef(null)
  const inputRef = useRef(null)

  const selected = parts.find(p => p.id === value)

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return parts
    return parts.filter(p =>
      (p.part_number || '').toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q)
    )
  }, [search, parts])

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen(o => !o)
          setTimeout(() => inputRef.current?.focus(), 10)
        }}
        className="w-full min-w-0 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:border-skynet-accent flex items-center justify-between gap-2 text-left text-sm"
      >
        <span className="flex-1 min-w-0 truncate">
          {selected ? (
            <>
              <span className="font-mono">{selected.part_number}</span>
              <span className="text-gray-400"> — {selected.description}</span>
            </>
          ) : (
            <span className="text-gray-400">-- Select Part --</span>
          )}
        </span>
        <ChevronDown size={14} className="text-gray-400 flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-gray-800 border border-gray-600 rounded shadow-2xl max-h-72 flex flex-col">
          <div className="relative p-2 border-b border-gray-700 flex-shrink-0">
            <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search part # or description..."
              className="w-full pl-8 pr-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-white placeholder-gray-500 text-sm focus:border-skynet-accent focus:outline-none"
            />
          </div>
          <div className="overflow-y-auto flex-1">
            {matches.length === 0 ? (
              <div className="text-gray-500 text-sm text-center py-4">No parts match.</div>
            ) : matches.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onChange(p.id)
                  setOpen(false)
                  setSearch('')
                }}
                className={`w-full text-left px-3 py-2 text-xs border-t border-gray-700/50 ${
                  value === p.id
                    ? 'bg-skynet-accent/20 hover:bg-skynet-accent/30'
                    : 'hover:bg-gray-700'
                }`}
              >
                <span className="font-mono text-white">{p.part_number}</span>
                <span className="text-gray-400"> — {p.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const PRIORITY_OPTIONS = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
]

const newLine = () => ({
  part_id: null,
  quantity_ordered: '',
  due_date: '',
  priority: 'normal',
  notes: '',
})

export default function CreateCustomerOrderModal({ isOpen, onClose, onSuccess, profile }) {
  const [customers, setCustomers] = useState([])
  const [parts, setParts] = useState([])
  const [loadingRefs, setLoadingRefs] = useState(false)

  const [customerId, setCustomerId] = useState(null)
  const [fishbowlOrderId, setFishbowlOrderId] = useState('')
  const [poNumber, setPoNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState([newLine()])

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    const load = async () => {
      setLoadingRefs(true)
      const [{ data: cust, error: ce }, { data: prt, error: pe }] = await Promise.all([
        supabase
          .from('customers')
          .select('id, customer_id, name')
          .eq('is_active', true)
          .order('customer_id', { ascending: true }),
        supabase
          .from('parts')
          .select('id, part_number, description, part_type')
          .eq('is_active', true)
          .in('part_type', ['assembly', 'finished_good'])
          .order('part_number', { ascending: true }),
      ])
      if (cancelled) return
      if (ce) setError(`Failed to load customers: ${ce.message}`)
      if (pe) setError(`Failed to load parts: ${pe.message}`)
      setCustomers(cust || [])
      setParts(prt || [])
      setLoadingRefs(false)
    }
    load()
    return () => { cancelled = true }
  }, [isOpen])

  // Form state resets via parent unmount: the parent conditionally renders
  // <CreateCustomerOrderModal /> only when showCreateModal is true, so closing
  // unmounts this component and the next open starts with fresh useState defaults.

  const selectedCustomer = customers.find(c => c.id === customerId)
  const previewCONumber = useMemo(
    () => formatCONumber(selectedCustomer?.customer_id, fishbowlOrderId),
    [selectedCustomer, fishbowlOrderId]
  )

  const handleFishbowlBlur = () => {
    const cleaned = fishbowlOrderId.replace(/[^A-Z0-9]/gi, '').toUpperCase()
    if (cleaned !== fishbowlOrderId) setFishbowlOrderId(cleaned)
  }

  const updateLine = (idx, patch) => {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l))
  }
  const addLine = () => setLines(prev => [...prev, newLine()])
  const removeLine = (idx) => {
    setLines(prev => prev.length === 1 ? prev : prev.filter((_, i) => i !== idx))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)

    if (!selectedCustomer) {
      setError('Select a customer.')
      return
    }
    const cleanedFb = fishbowlOrderId.replace(/[^A-Z0-9]/gi, '').toUpperCase()
    if (!cleanedFb) {
      setError('Fishbowl Order ID is required (alphanumeric).')
      return
    }
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (!l.part_id) {
        setError(`Line ${i + 1}: select a part.`)
        return
      }
      const qty = parseInt(l.quantity_ordered, 10)
      if (!Number.isFinite(qty) || qty <= 0) {
        setError(`Line ${i + 1}: quantity must be a positive integer.`)
        return
      }
    }

    const coNumber = formatCONumber(selectedCustomer.customer_id, cleanedFb)
    if (!coNumber) {
      setError('Could not compute CO number.')
      return
    }

    setSubmitting(true)
    try {
      const { data: inserted, error: headerErr } = await supabase
        .from('customer_orders')
        .insert({
          co_number: coNumber,
          customer_id: selectedCustomer.id,
          fishbowl_order_id: cleanedFb,
          po_number: poNumber.trim() || null,
          notes: notes.trim() || null,
          created_by: profile?.id || null,
        })
        .select('id')
        .single()

      if (headerErr) {
        if (headerErr.code === '23505' || /duplicate/i.test(headerErr.message)) {
          setError('A customer order already exists for this Fishbowl reference.')
        } else {
          setError(headerErr.message)
        }
        setSubmitting(false)
        return
      }

      const coId = inserted.id
      const lineRows = lines.map((l, i) => ({
        customer_order_id: coId,
        line_number: i + 1,
        part_id: l.part_id,
        quantity_ordered: parseInt(l.quantity_ordered, 10),
        due_date: l.due_date || null,
        priority: l.priority,
        notes: (l.notes || '').trim() || null,
      }))

      const { error: linesErr } = await supabase
        .from('customer_order_lines')
        .insert(lineRows)

      if (linesErr) {
        setError(`Header saved but lines failed: ${linesErr.message}`)
        setSubmitting(false)
        return
      }

      setSubmitting(false)
      if (onSuccess) onSuccess()
      onClose()
    } catch (err) {
      setError(err.message || String(err))
      setSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-4xl max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-white">New Customer Order</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              CO Preview:{' '}
              <span className="font-mono text-purple-300">
                {previewCONumber || '—'}
              </span>
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={22} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="overflow-y-auto flex-1">
          <div className="p-6 space-y-6">

            {/* Header section */}
            <section className="space-y-4">
              <h3 className="text-sm uppercase tracking-wide text-purple-400 font-semibold border-b border-purple-500/30 pb-1">
                Order Header
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Customer *</label>
                  {loadingRefs ? (
                    <div className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-gray-500 text-sm flex items-center gap-2">
                      <Loader2 size={14} className="animate-spin" /> Loading...
                    </div>
                  ) : (
                    <CustomerCombobox
                      value={customerId}
                      onChange={setCustomerId}
                      customers={customers}
                    />
                  )}
                </div>

                <div>
                  <label className="block text-gray-400 text-sm mb-1">
                    Fishbowl Order ID *
                    <span className="text-gray-600"> (alphanumeric only)</span>
                  </label>
                  <input
                    type="text"
                    value={fishbowlOrderId}
                    onChange={(e) => setFishbowlOrderId(e.target.value)}
                    onBlur={handleFishbowlBlur}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white font-mono focus:outline-none focus:border-skynet-accent"
                    placeholder="ABC123"
                  />
                </div>

                <div>
                  <label className="block text-gray-400 text-sm mb-1">PO Number</label>
                  <input
                    type="text"
                    value={poNumber}
                    onChange={(e) => setPoNumber(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:border-skynet-accent"
                    placeholder="(optional)"
                  />
                </div>

                <div>
                  <label className="block text-gray-400 text-sm mb-1">CO Number Preview</label>
                  <div className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-purple-300 font-mono text-sm">
                    {previewCONumber || <span className="text-gray-600">—</span>}
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-gray-400 text-sm mb-1">Notes</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
                  placeholder="(optional)"
                />
              </div>
            </section>

            {/* Lines section */}
            <section className="space-y-3">
              <div className="border-b border-purple-500/30 pb-1">
                <h3 className="text-sm uppercase tracking-wide text-purple-400 font-semibold">
                  Line Items
                </h3>
              </div>

              <div className="space-y-2">
                {lines.map((line, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-12 gap-2 items-start bg-gray-800/40 border border-gray-700/50 rounded p-2"
                  >
                    <div className="col-span-1 text-center text-gray-500 text-sm pt-2">
                      #{idx + 1}
                    </div>
                    <div className="col-span-4">
                      <PartCombobox
                        value={line.part_id}
                        onChange={(v) => updateLine(idx, { part_id: v })}
                        parts={parts}
                      />
                    </div>
                    <div className="col-span-1">
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={line.quantity_ordered}
                        onChange={(e) => updateLine(idx, { quantity_ordered: e.target.value })}
                        className="w-full px-2 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
                        placeholder="Qty"
                      />
                    </div>
                    <div className="col-span-2">
                      <input
                        type="date"
                        value={line.due_date}
                        onChange={(e) => updateLine(idx, { due_date: e.target.value })}
                        className="w-full px-2 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
                      />
                    </div>
                    <div className="col-span-1">
                      <select
                        value={line.priority}
                        onChange={(e) => updateLine(idx, { priority: e.target.value })}
                        className="w-full px-2 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
                      >
                        {PRIORITY_OPTIONS.map(p => (
                          <option key={p.value} value={p.value}>{p.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2">
                      <input
                        type="text"
                        value={line.notes}
                        onChange={(e) => updateLine(idx, { notes: e.target.value })}
                        className="w-full px-2 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
                        placeholder="Notes"
                      />
                    </div>
                    <div className="col-span-1 flex justify-end pt-1">
                      <button
                        type="button"
                        onClick={() => removeLine(idx)}
                        disabled={lines.length === 1}
                        className="p-2 text-red-400 hover:bg-red-900/30 rounded disabled:opacity-30 disabled:cursor-not-allowed"
                        title={lines.length === 1 ? 'At least one line required' : 'Remove line'}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div>
                <button
                  type="button"
                  onClick={addLine}
                  className="flex items-center gap-1 px-3 py-1 text-xs bg-purple-900/40 hover:bg-purple-900/60 text-purple-200 border border-purple-500/30 rounded transition-colors"
                >
                  <Plus size={12} /> Add Line
                </button>
              </div>

              {/* Column legend */}
              <div className="grid grid-cols-12 gap-2 text-[10px] uppercase tracking-wide text-gray-500 px-2">
                <div className="col-span-1 text-center">Line</div>
                <div className="col-span-4">Part</div>
                <div className="col-span-1">Qty</div>
                <div className="col-span-2">Due</div>
                <div className="col-span-1">Priority</div>
                <div className="col-span-2">Notes</div>
                <div className="col-span-1"></div>
              </div>
            </section>

            {error && (
              <div className="p-3 rounded bg-red-900/40 text-red-300 border border-red-800 text-sm">
                {error}
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-gray-800 flex justify-end gap-2 flex-shrink-0 bg-gray-900">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || loadingRefs}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded disabled:opacity-50 flex items-center gap-2"
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {submitting ? 'Creating...' : 'Create Customer Order'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
