import { useState, useEffect, useRef, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { X, ChevronDown, Search, Loader2 } from 'lucide-react'
import { createStockRequest } from '../lib/customerOrders'

// Part picker — same pattern as CreateCustomerOrderModal's PartCombobox,
// scoped to the part types the warehouse can hold as finished stock.
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
              {selected.is_active === false && (
                <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-amber-900/50 text-amber-300 rounded border border-amber-700/50">
                  Inactive — Pending Activation
                </span>
              )}
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
                {p.is_active === false && (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-amber-900/50 text-amber-300 rounded border border-amber-700/50">
                    Inactive — Pending Activation
                  </span>
                )}
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

// D-STKREQ-01 — the warehouse asks for a stock build of a part it has run out
// of. Not a customer order: no Fishbowl SO, never ships. The reason is
// mandatory here AND in create_stock_request; the database does not trust the
// form (same discipline as kit_assign_and_log).
export default function StockRequestModal({ isOpen, onClose, onSuccess, profile }) {
  const [parts, setParts] = useState([])
  const [loadingParts, setLoadingParts] = useState(false)

  const [partId, setPartId] = useState(null)
  const [quantity, setQuantity] = useState('')
  const [priority, setPriority] = useState('normal')
  const [reason, setReason] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  // Fresh form on every open — the parent may keep this mounted.
  useEffect(() => {
    if (!isOpen) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPartId(null)
    setQuantity('')
    setPriority('normal')
    setReason('')
    setError(null)
    setSubmitting(false)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    const load = async () => {
      setLoadingParts(true)
      const { data, error: pe } = await supabase
        .from('parts')
        .select('id, part_number, description, part_type, is_active')
        .in('part_type', ['assembly', 'finished_good', 'manufactured'])
        .order('part_number', { ascending: true })
      if (cancelled) return
      if (pe) setError(`Failed to load parts: ${pe.message}`)
      setParts(data || [])
      setLoadingParts(false)
    }
    load()
    return () => { cancelled = true }
  }, [isOpen])

  const qtyNum = parseInt(quantity, 10)
  const isValid = !!partId && Number.isFinite(qtyNum) && qtyNum >= 1 && reason.trim().length > 0

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)

    if (!partId) {
      setError('Select a part.')
      return
    }
    if (!Number.isFinite(qtyNum) || qtyNum < 1) {
      setError('Quantity must be a positive whole number.')
      return
    }
    if (!reason.trim()) {
      setError('A reason is required on every stock request.')
      return
    }

    setSubmitting(true)
    try {
      await createStockRequest(supabase, {
        partId,
        quantity: qtyNum,
        priority,
        reason: reason.trim(),
      })
      onSuccess?.()
      onClose()
    } catch (err) {
      setError(err?.message || String(err))
      setSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-white">New Stock Request</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Request a stock build for a part the warehouse has run out of.
            </p>
            {profile?.full_name && (
              <p className="text-xs text-gray-600 mt-0.5">
                Logged as <span className="text-gray-400">{profile.full_name}</span>
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X size={22} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="overflow-y-auto flex-1">
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-gray-400 text-sm mb-1">
                Part <span className="text-red-400">*</span>
              </label>
              {loadingParts ? (
                <div className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-gray-500 text-sm flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" /> Loading...
                </div>
              ) : (
                <PartCombobox value={partId} onChange={setPartId} parts={parts} />
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-gray-400 text-sm mb-1">
                  Quantity <span className="text-red-400">*</span>
                </label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="0"
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white font-mono focus:outline-none focus:border-skynet-accent"
                />
              </div>

              <div>
                <label className="block text-gray-400 text-sm mb-1">Priority</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:border-skynet-accent"
                >
                  {PRIORITY_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-gray-400 text-sm mb-1">
                Reason <span className="text-red-400">*</span>
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder={'Why is this needed? e.g. "Bin empty, 3 kits waiting on it"'}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
              />
              <p className="text-xs text-gray-500 mt-1">
                A reason is required on every stock request.
              </p>
            </div>

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
              disabled={submitting || loadingParts || !isValid}
              className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded disabled:opacity-50 flex items-center gap-2"
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {submitting ? 'Submitting...' : 'Submit Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
