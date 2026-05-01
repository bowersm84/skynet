import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { Plus, Upload, Search, Edit2, X, Check, Loader2 } from 'lucide-react'

const CUSTOMER_ID_RE = /^[0-9]{1,6}$/

export default function CustomersTab({ profile }) {
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeFilter, setActiveFilter] = useState('active') // 'all' | 'active' | 'inactive'
  const [actionStatus, setActionStatus] = useState(null) // { type: 'success'|'error', message }
  const [showAddModal, setShowAddModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editingName, setEditingName] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

  useEffect(() => {
    loadCustomers()
  }, [])

  const loadCustomers = async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('customers')
      .select('id, customer_id, name, is_active, notes, created_at')
      .order('customer_id', { ascending: true })
    if (error) {
      setActionStatus({ type: 'error', message: `Failed to load customers: ${error.message}` })
    } else {
      setCustomers(data || [])
    }
    setLoading(false)
  }

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return customers.filter(c => {
      if (activeFilter === 'active' && !c.is_active) return false
      if (activeFilter === 'inactive' && c.is_active) return false
      if (!q) return true
      return (
        (c.customer_id || '').toLowerCase().includes(q) ||
        (c.name || '').toLowerCase().includes(q)
      )
    })
  }, [customers, searchQuery, activeFilter])

  const handleAdd = async (form) => {
    const customerId = (form.customer_id || '').trim()
    const name = (form.name || '').trim()
    const notes = (form.notes || '').trim() || null

    if (!CUSTOMER_ID_RE.test(customerId)) {
      return { ok: false, error: 'Customer ID must be 1–6 digits.' }
    }
    if (!name) {
      return { ok: false, error: 'Name is required.' }
    }

    const { error } = await supabase
      .from('customers')
      .insert({ customer_id: customerId, name, notes })

    if (error) {
      if (error.code === '23505' || /duplicate/i.test(error.message)) {
        return { ok: false, error: `Customer ID "${customerId}" already exists.` }
      }
      return { ok: false, error: error.message }
    }

    setActionStatus({ type: 'success', message: `Customer "${name}" added.` })
    setShowAddModal(false)
    await loadCustomers()
    return { ok: true }
  }

  const handleStartEdit = (customer) => {
    setEditingId(customer.id)
    setEditingName(customer.name)
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditingName('')
  }

  const handleSaveEdit = async (customer) => {
    const name = editingName.trim()
    if (!name) {
      setActionStatus({ type: 'error', message: 'Name cannot be empty.' })
      return
    }
    if (name === customer.name) {
      handleCancelEdit()
      return
    }
    setSavingEdit(true)
    const { error } = await supabase
      .from('customers')
      .update({ name })
      .eq('id', customer.id)
    setSavingEdit(false)
    if (error) {
      setActionStatus({ type: 'error', message: `Failed to update: ${error.message}` })
      return
    }
    setActionStatus({ type: 'success', message: `Updated "${customer.customer_id}".` })
    handleCancelEdit()
    await loadCustomers()
  }

  const handleToggleActive = async (customer) => {
    const newValue = !customer.is_active
    // Optimistic update
    setCustomers(prev => prev.map(c => c.id === customer.id ? { ...c, is_active: newValue } : c))
    const { error } = await supabase
      .from('customers')
      .update({ is_active: newValue })
      .eq('id', customer.id)
    if (error) {
      // Revert
      setCustomers(prev => prev.map(c => c.id === customer.id ? { ...c, is_active: !newValue } : c))
      setActionStatus({ type: 'error', message: `Failed to toggle: ${error.message}` })
    }
  }

  const handleImport = async (text) => {
    const existingIds = new Set(customers.map(c => c.customer_id))
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    const errors = []
    const valid = []
    const seenInBatch = new Set()
    let skipped = 0

    lines.forEach((line, idx) => {
      const rowNum = idx + 1
      const firstComma = line.indexOf(',')
      if (firstComma === -1) {
        errors.push(`Row ${rowNum}: missing comma — expected "customer_id,name"`)
        return
      }
      const cid = line.slice(0, firstComma).trim()
      const name = line.slice(firstComma + 1).trim()
      if (!CUSTOMER_ID_RE.test(cid)) {
        errors.push(`Row ${rowNum}: invalid customer_id "${cid}" (must be 1–6 digits)`)
        return
      }
      if (!name) {
        errors.push(`Row ${rowNum}: missing name`)
        return
      }
      if (existingIds.has(cid) || seenInBatch.has(cid)) {
        skipped += 1
        return
      }
      seenInBatch.add(cid)
      valid.push({ customer_id: cid, name })
    })

    let added = 0
    if (valid.length > 0) {
      const { data, error } = await supabase
        .from('customers')
        .insert(valid)
        .select('id')
      if (error) {
        return {
          summary: `0 added · ${skipped} skipped (already exist) · ${errors.length + valid.length} errors`,
          errors: [...errors, `Insert failed: ${error.message}`],
        }
      }
      added = data?.length || valid.length
    }

    await loadCustomers()
    return {
      summary: `${added} added · ${skipped} skipped (already exist) · ${errors.length} errors`,
      errors,
    }
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Customers</h2>
          <p className="text-gray-500 text-sm mt-1">Customer master — used for Customer Orders</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowImportModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 rounded transition-colors"
          >
            <Upload size={16} /> Import CSV
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white rounded transition-colors"
          >
            <Plus size={16} /> Add Customer
          </button>
        </div>
      </div>

      {actionStatus && (
        <div className={`mb-4 p-3 rounded text-sm flex justify-between items-center ${
          actionStatus.type === 'success'
            ? 'bg-green-900/40 text-green-300 border border-green-800'
            : 'bg-red-900/40 text-red-300 border border-red-800'
        }`}>
          <span>{actionStatus.message}</span>
          <button onClick={() => setActionStatus(null)}><X size={14} /></button>
        </div>
      )}

      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search customer ID or name..."
            className="w-full pl-9 pr-3 py-2 bg-gray-900 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
          />
        </div>
        <div className="flex gap-1">
          {['all', 'active', 'inactive'].map(f => (
            <button
              key={f}
              onClick={() => setActiveFilter(f)}
              className={`px-3 py-1.5 text-xs rounded capitalize transition-colors ${
                activeFilter === f
                  ? 'bg-skynet-accent text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-white border border-gray-700'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 size={20} className="animate-spin mr-2" />
          Loading customers...
        </div>
      ) : (
        <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-4 py-3 text-left">Customer ID</th>
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Notes</th>
                <th className="px-4 py-3 text-left">Active</th>
                <th className="px-4 py-3 text-left">Created</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(customer => (
                <tr key={customer.id} className="border-t border-gray-800 hover:bg-gray-800/40">
                  <td className="px-4 py-3 text-white font-mono">{customer.customer_id}</td>
                  <td className="px-4 py-3 text-gray-200">
                    {editingId === customer.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveEdit(customer)
                            if (e.key === 'Escape') handleCancelEdit()
                          }}
                          className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
                        />
                        <button
                          onClick={() => handleSaveEdit(customer)}
                          disabled={savingEdit}
                          className="p-1 text-green-400 hover:bg-green-900/30 rounded disabled:opacity-50"
                          title="Save"
                        >
                          {savingEdit ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                        </button>
                        <button
                          onClick={handleCancelEdit}
                          className="p-1 text-gray-400 hover:bg-gray-700 hover:text-white rounded"
                          title="Cancel"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleStartEdit(customer)}
                        className="flex items-center gap-2 group text-left"
                        title="Click to edit"
                      >
                        <span>{customer.name}</span>
                        <Edit2 size={12} className="text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-sm max-w-xs truncate" title={customer.notes || ''}>
                    {customer.notes || <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <ActiveToggle
                      checked={customer.is_active}
                      onChange={() => handleToggleActive(customer)}
                    />
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {customer.created_at ? new Date(customer.created_at).toLocaleDateString() : '—'}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                    {customers.length === 0 ? 'No customers yet — add one or import a CSV' : 'No matches'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showAddModal && (
        <AddCustomerModal
          onSubmit={handleAdd}
          onClose={() => setShowAddModal(false)}
        />
      )}

      {showImportModal && (
        <ImportCsvModal
          onSubmit={handleImport}
          onClose={() => setShowImportModal(false)}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function ActiveToggle({ checked, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        checked ? 'bg-skynet-accent' : 'bg-gray-700'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

function AddCustomerModal({ onSubmit, onClose }) {
  const [form, setForm] = useState({ customer_id: '', name: '', notes: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)

    const cid = form.customer_id.trim()
    const name = form.name.trim()
    if (!CUSTOMER_ID_RE.test(cid)) {
      setError('Customer ID must be 1–6 digits.')
      return
    }
    if (!name) {
      setError('Name is required.')
      return
    }

    setSubmitting(true)
    const result = await onSubmit({ customer_id: cid, name, notes: form.notes })
    setSubmitting(false)
    if (!result.ok) setError(result.error)
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-md">
        <div className="flex justify-between items-center p-5 border-b border-gray-800">
          <h3 className="text-lg font-semibold text-white">Add Customer</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Customer ID <span className="text-gray-600">(1–6 digits, from Fishbowl)</span></label>
            <input
              type="text"
              value={form.customer_id}
              onChange={(e) => setForm({ ...form, customer_id: e.target.value })}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white font-mono focus:outline-none focus:border-skynet-accent"
              placeholder="1234"
              autoFocus
              required
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-skynet-accent"
              placeholder="Acme Corp"
              required
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Notes <span className="text-gray-600">(optional)</span></label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={3}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
            />
          </div>

          {error && (
            <div className="p-2 rounded bg-red-900/40 text-red-300 border border-red-800 text-sm">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-3 border-t border-gray-800">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white">
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white rounded disabled:opacity-50 flex items-center gap-2"
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {submitting ? 'Saving...' : 'Add Customer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function ImportCsvModal({ onSubmit, onClose }) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null) // { summary, errors }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!text.trim()) return
    setSubmitting(true)
    const r = await onSubmit(text)
    setSubmitting(false)
    setResult(r)
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-xl">
        <div className="flex justify-between items-center p-5 border-b border-gray-800">
          <h3 className="text-lg font-semibold text-white">Import Customers (CSV)</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              Paste rows — one per line, format <span className="font-mono text-gray-300">customer_id,name</span>
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm font-mono focus:outline-none focus:border-skynet-accent"
              placeholder={'1234,Acme Corp\n5678,Beta Industries'}
              autoFocus
            />
          </div>

          {result && (
            <div className="p-3 rounded bg-gray-800 border border-gray-700 text-sm space-y-2">
              <div className="text-gray-200 font-medium">{result.summary}</div>
              {result.errors.length > 0 && (
                <ul className="text-red-300 text-xs list-disc pl-5 max-h-40 overflow-auto space-y-1">
                  {result.errors.map((err, i) => <li key={i}>{err}</li>)}
                </ul>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-3 border-t border-gray-800">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white">
              {result ? 'Close' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={submitting || !text.trim()}
              className="px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white rounded disabled:opacity-50 flex items-center gap-2"
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {submitting ? 'Importing...' : 'Import'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
