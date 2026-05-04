import { useState, useEffect, useRef, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { X, Plus, Trash2, ChevronDown, Search, Loader2, AlertTriangle } from 'lucide-react'

// Local copies of the Customer/Part comboboxes used in CreateCustomerOrderModal.
// Duplicated rather than extracted per the brief — keep the create modal untouched.
function CustomerCombobox({ value, onChange, customers, disabled = false }) {
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

  if (disabled) {
    return (
      <div className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-gray-300 text-sm">
        {selected ? (
          <>
            <span className="font-mono">{selected.customer_id}</span>
            <span className="text-gray-400"> — {selected.name}</span>
          </>
        ) : (
          <span className="text-gray-500">—</span>
        )}
      </div>
    )
  }

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

let tempIdSeq = 0
const nextTempId = () => `new-${++tempIdSeq}`

export default function EditCustomerOrderModal({ isOpen, coId, profile, onClose, onSuccess }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const [customers, setCustomers] = useState([])
  const [parts, setParts] = useState([])

  const [coNumber, setCoNumber] = useState('')
  const [coStatus, setCoStatus] = useState(null)

  // Header working state
  const [header, setHeader] = useState({
    customer_id: null,
    po_number: '',
    fishbowl_order_id: '',
    notes: '',
  })
  const [originalHeader, setOriginalHeader] = useState(null)

  // Lines working state. Each row keeps both editable + read-only fields.
  // _tempId is the React key + errors map key (stable across renders for both
  // existing lines and newly-added ones).
  const [lines, setLines] = useState([])
  const [originalLinesById, setOriginalLinesById] = useState(new Map())

  const [errors, setErrors] = useState({ header: null, lines: {} })

  useEffect(() => {
    if (!isOpen || !coId) return
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        // Header + customer
        const { data: co, error: coErr } = await supabase
          .from('customer_orders')
          .select(`
            id, co_number, fishbowl_order_id, po_number, notes, status,
            customer_id,
            customers ( id, customer_id, name )
          `)
          .eq('id', coId)
          .single()
        if (coErr) throw coErr

        // Lines
        const { data: lineRows, error: linesErr } = await supabase
          .from('customer_order_lines')
          .select(`
            id, line_number, quantity_ordered, quantity_fulfilled,
            due_date, priority, status, notes, part_id,
            parts ( id, part_number, description )
          `)
          .eq('customer_order_id', coId)
          .order('line_number', { ascending: true })
        if (linesErr) throw linesErr

        // Active allocation totals per line
        const lineIds = (lineRows || []).map(l => l.id)
        const allocByLine = new Map()
        if (lineIds.length > 0) {
          const { data: allocs, error: aerr } = await supabase
            .from('customer_order_allocations')
            .select('customer_order_line_id, quantity_allocated')
            .in('customer_order_line_id', lineIds)
            .eq('is_active', true)
          if (aerr) throw aerr
          for (const a of allocs || []) {
            allocByLine.set(
              a.customer_order_line_id,
              (allocByLine.get(a.customer_order_line_id) || 0) + (Number(a.quantity_allocated) || 0),
            )
          }
        }

        // Reference data — same loaders as CreateCustomerOrderModal
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
        if (ce) throw ce
        if (pe) throw pe

        if (cancelled) return

        setCoNumber(co.co_number || '')
        setCoStatus(co.status || null)

        const initialHeader = {
          customer_id: co.customer_id || null,
          po_number: co.po_number || '',
          fishbowl_order_id: co.fishbowl_order_id || '',
          notes: co.notes || '',
        }
        setHeader(initialHeader)
        setOriginalHeader(initialHeader)

        const builtLines = (lineRows || []).map(l => ({
          _tempId: `db-${l.id}`,
          _isNew: false,
          id: l.id,
          line_number: l.line_number,
          part_id: l.part_id,
          quantity_ordered: l.quantity_ordered ?? 0,
          due_date: l.due_date || '',
          priority: l.priority || 'normal',
          notes: l.notes || '',
          // read-only refs
          original_part_id: l.part_id,
          original_quantity_ordered: l.quantity_ordered ?? 0,
          quantity_fulfilled: Number(l.quantity_fulfilled) || 0,
          activeAllocated: allocByLine.get(l.id) || 0,
          status: l.status || 'not_started',
          parts: l.parts || null,
        }))
        setLines(builtLines)
        setOriginalLinesById(new Map(builtLines.map(l => [l.id, {
          part_id: l.original_part_id,
          quantity_ordered: l.original_quantity_ordered,
          due_date: l.due_date,
          priority: l.priority,
          notes: l.notes,
        }])))

        setCustomers(cust || [])
        setParts(prt || [])
      } catch (err) {
        if (!cancelled) setError(err.message || String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [isOpen, coId])

  const isCancelled = coStatus === 'cancelled'

  const updateHeader = (patch) => setHeader(prev => ({ ...prev, ...patch }))

  const updateLine = (tempId, patch) => {
    setLines(prev => prev.map(l => l._tempId === tempId ? { ...l, ...patch } : l))
  }

  const addLine = () => {
    const maxLineNumber = lines.reduce((m, l) => Math.max(m, l.line_number || 0), 0)
    setLines(prev => [
      ...prev,
      {
        _tempId: nextTempId(),
        _isNew: true,
        id: null,
        line_number: maxLineNumber + 1,
        part_id: null,
        quantity_ordered: '',
        due_date: '',
        priority: 'normal',
        notes: '',
        original_part_id: null,
        original_quantity_ordered: 0,
        quantity_fulfilled: 0,
        activeAllocated: 0,
        status: 'not_started',
        parts: null,
      },
    ])
  }

  const removeLine = (tempId) => {
    setLines(prev => prev.filter(l => !(l._tempId === tempId && l._isNew)))
  }

  const isRowReadOnly = (line) => line.status === 'complete' || line.status === 'cancelled'

  const partEditable = (line) => {
    if (isRowReadOnly(line)) return false
    if (line._isNew) return true
    return line.activeAllocated === 0 && line.quantity_fulfilled === 0
  }

  const validate = () => {
    const next = { header: null, lines: {} }
    let ok = true

    if (isCancelled) {
      // Read-only — nothing to validate.
      return { ok: true, errors: next }
    }

    if (!header.customer_id) {
      next.header = 'Customer is required.'
      ok = false
    }

    for (const l of lines) {
      if (isRowReadOnly(l)) continue
      const rowErrs = []
      if (!l.part_id) rowErrs.push('Part required.')
      const qty = parseInt(l.quantity_ordered, 10)
      if (!Number.isFinite(qty) || qty <= 0) {
        rowErrs.push('Quantity must be a positive integer.')
      } else {
        const floor = (l.quantity_fulfilled || 0) + (l.activeAllocated || 0)
        if (qty < floor) {
          rowErrs.push(`Quantity cannot drop below fulfilled + allocated (${floor}).`)
        }
      }
      if (l._isNew && !l.due_date) rowErrs.push('Due date required.')
      if (rowErrs.length > 0) {
        next.lines[l._tempId] = rowErrs.join(' ')
        ok = false
      }
    }

    return { ok, errors: next }
  }

  const handleSave = async (e) => {
    e?.preventDefault?.()
    setError(null)

    const { ok, errors: nextErrors } = validate()
    setErrors(nextErrors)
    if (!ok) return

    setSaving(true)
    try {
      // 1. Header — only UPDATE if anything changed.
      if (originalHeader) {
        const headerChanged =
          header.customer_id !== originalHeader.customer_id ||
          (header.po_number || '') !== (originalHeader.po_number || '') ||
          (header.fishbowl_order_id || '') !== (originalHeader.fishbowl_order_id || '') ||
          (header.notes || '') !== (originalHeader.notes || '')

        if (headerChanged && !isCancelled) {
          const { error: hErr } = await supabase
            .from('customer_orders')
            .update({
              customer_id: header.customer_id,
              po_number: header.po_number?.trim() || null,
              fishbowl_order_id: header.fishbowl_order_id?.trim() || null,
              notes: header.notes?.trim() || null,
            })
            .eq('id', coId)
          if (hErr) throw hErr
        }
      }

      // 2. Existing lines — diff each, UPDATE only the changed ones.
      for (const l of lines) {
        if (l._isNew || isRowReadOnly(l)) continue
        const orig = originalLinesById.get(l.id)
        if (!orig) continue
        const qty = parseInt(l.quantity_ordered, 10)
        const patch = {}
        if (l.part_id !== orig.part_id) patch.part_id = l.part_id
        if (qty !== orig.quantity_ordered) patch.quantity_ordered = qty
        if ((l.due_date || null) !== (orig.due_date || null)) patch.due_date = l.due_date || null
        if (l.priority !== orig.priority) patch.priority = l.priority
        if ((l.notes || '') !== (orig.notes || '')) patch.notes = l.notes?.trim() || null

        if (Object.keys(patch).length === 0) continue
        const { error: uErr } = await supabase
          .from('customer_order_lines')
          .update(patch)
          .eq('id', l.id)
        if (uErr) throw uErr
      }

      // 3. New lines — INSERT.
      const newRows = lines
        .filter(l => l._isNew)
        .map(l => ({
          customer_order_id: coId,
          line_number: l.line_number,
          part_id: l.part_id,
          quantity_ordered: parseInt(l.quantity_ordered, 10),
          due_date: l.due_date || null,
          priority: l.priority,
          notes: (l.notes || '').trim() || null,
          status: 'not_started',
        }))
      if (newRows.length > 0) {
        const { error: iErr } = await supabase
          .from('customer_order_lines')
          .insert(newRows)
        if (iErr) throw iErr
      }

      setSaving(false)
      if (onSuccess) onSuccess()
      onClose()
    } catch (err) {
      setError(err.message || String(err))
      setSaving(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-4xl max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-white">Edit Customer Order</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              <span className="font-mono text-purple-300">{coNumber || '—'}</span>
              {coStatus && (
                <span className="ml-2 text-gray-500">· status: {coStatus}</span>
              )}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={22} />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-500">
            <Loader2 size={20} className="animate-spin mr-2" />
            Loading...
          </div>
        ) : (
          <form onSubmit={handleSave} className="overflow-y-auto flex-1">
            <div className="p-6 space-y-6">

              {isCancelled && (
                <div className="p-3 rounded bg-red-900/30 border border-red-800/60 text-red-200 text-xs flex items-start gap-2">
                  <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                  This customer order is cancelled and is read-only.
                </div>
              )}

              {/* Header section */}
              <section className="space-y-4">
                <h3 className="text-sm uppercase tracking-wide text-purple-400 font-semibold border-b border-purple-500/30 pb-1">
                  Order Header
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-gray-400 text-sm mb-1">Customer *</label>
                    <CustomerCombobox
                      value={header.customer_id}
                      onChange={(v) => updateHeader({ customer_id: v })}
                      customers={customers}
                      disabled={isCancelled}
                    />
                  </div>

                  <div>
                    <label className="block text-gray-400 text-sm mb-1">Fishbowl Order ID</label>
                    <input
                      type="text"
                      value={header.fishbowl_order_id}
                      onChange={(e) => updateHeader({ fishbowl_order_id: e.target.value })}
                      disabled={isCancelled}
                      className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white font-mono focus:outline-none focus:border-skynet-accent disabled:bg-gray-800 disabled:text-gray-400"
                    />
                  </div>

                  <div>
                    <label className="block text-gray-400 text-sm mb-1">PO Number</label>
                    <input
                      type="text"
                      value={header.po_number}
                      onChange={(e) => updateHeader({ po_number: e.target.value })}
                      disabled={isCancelled}
                      className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:border-skynet-accent disabled:bg-gray-800 disabled:text-gray-400"
                      placeholder="(optional)"
                    />
                  </div>

                  <div>
                    <label className="block text-gray-400 text-sm mb-1">CO Number</label>
                    <div className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-purple-300 font-mono text-sm">
                      {coNumber || <span className="text-gray-600">—</span>}
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-gray-400 text-sm mb-1">Notes</label>
                  <textarea
                    value={header.notes}
                    onChange={(e) => updateHeader({ notes: e.target.value })}
                    disabled={isCancelled}
                    rows={2}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-skynet-accent disabled:bg-gray-800 disabled:text-gray-400"
                    placeholder="(optional)"
                  />
                </div>

                {errors.header && (
                  <div className="text-xs text-red-300">{errors.header}</div>
                )}
              </section>

              {/* Lines section */}
              <section className="space-y-3">
                <div className="border-b border-purple-500/30 pb-1">
                  <h3 className="text-sm uppercase tracking-wide text-purple-400 font-semibold">
                    Line Items
                  </h3>
                </div>

                <div className="space-y-2">
                  {lines.map((line) => {
                    const readOnly = isRowReadOnly(line) || isCancelled
                    const partLocked = !partEditable(line)
                    const rowError = errors.lines[line._tempId]
                    const floor = (line.quantity_fulfilled || 0) + (line.activeAllocated || 0)
                    return (
                      <div
                        key={line._tempId}
                        className={`grid grid-cols-12 gap-2 items-start border rounded p-2 ${
                          readOnly
                            ? 'bg-gray-900/40 border-gray-800'
                            : line._isNew
                              ? 'bg-purple-900/10 border-purple-700/30'
                              : 'bg-gray-800/40 border-gray-700/50'
                        }`}
                      >
                        <div className="col-span-1 text-center text-gray-500 text-sm pt-2">
                          #{line.line_number}
                        </div>

                        <div className="col-span-4">
                          {partLocked ? (
                            <div className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-gray-300">
                              {line.parts ? (
                                <>
                                  <span className="font-mono">{line.parts.part_number}</span>
                                  <span className="text-gray-500"> — {line.parts.description}</span>
                                </>
                              ) : (
                                <span className="text-gray-500">—</span>
                              )}
                            </div>
                          ) : (
                            <PartCombobox
                              value={line.part_id}
                              onChange={(v) => updateLine(line._tempId, { part_id: v })}
                              parts={parts}
                            />
                          )}
                          {!line._isNew && (line.activeAllocated > 0 || line.quantity_fulfilled > 0) && (
                            <div className="text-[10px] text-gray-500 mt-1 px-1">
                              Fulfilled {line.quantity_fulfilled} · Allocated {line.activeAllocated}
                            </div>
                          )}
                        </div>

                        <div className="col-span-1">
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={line.quantity_ordered}
                            onChange={(e) => updateLine(line._tempId, { quantity_ordered: e.target.value })}
                            disabled={readOnly}
                            className="w-full px-2 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-skynet-accent disabled:bg-gray-800 disabled:text-gray-400"
                            placeholder="Qty"
                          />
                          {floor > 0 && !line._isNew && (
                            <div className="text-[10px] text-gray-500 mt-1 px-1">
                              min {floor}
                            </div>
                          )}
                        </div>

                        <div className="col-span-2">
                          <input
                            type="date"
                            value={line.due_date}
                            onChange={(e) => updateLine(line._tempId, { due_date: e.target.value })}
                            disabled={readOnly}
                            className="w-full px-2 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-skynet-accent disabled:bg-gray-800 disabled:text-gray-400"
                          />
                        </div>

                        <div className="col-span-1">
                          <select
                            value={line.priority}
                            onChange={(e) => updateLine(line._tempId, { priority: e.target.value })}
                            disabled={readOnly}
                            className="w-full px-2 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-skynet-accent disabled:bg-gray-800 disabled:text-gray-400"
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
                            onChange={(e) => updateLine(line._tempId, { notes: e.target.value })}
                            disabled={readOnly}
                            className="w-full px-2 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-skynet-accent disabled:bg-gray-800 disabled:text-gray-400"
                            placeholder="Notes"
                          />
                        </div>

                        <div className="col-span-1 flex justify-end pt-1">
                          {line._isNew ? (
                            <button
                              type="button"
                              onClick={() => removeLine(line._tempId)}
                              className="p-2 text-red-400 hover:bg-red-900/30 rounded"
                              title="Remove line"
                            >
                              <Trash2 size={14} />
                            </button>
                          ) : (
                            <span
                              className="p-2 text-gray-700"
                              title="Existing lines cannot be removed — use Cancel Line"
                            >
                              <Trash2 size={14} />
                            </span>
                          )}
                        </div>

                        {rowError && (
                          <div className="col-span-12 text-xs text-red-300 px-2">
                            {rowError}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                {!isCancelled && (
                  <div>
                    <button
                      type="button"
                      onClick={addLine}
                      className="flex items-center gap-1 px-3 py-1 text-xs bg-purple-900/40 hover:bg-purple-900/60 text-purple-200 border border-purple-500/30 rounded transition-colors"
                    >
                      <Plus size={12} /> Add Line
                    </button>
                  </div>
                )}

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
                disabled={saving || isCancelled}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded disabled:opacity-50 flex items-center gap-2"
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
