import { useState } from 'react'
import { ChevronDown, ChevronRight, AlertTriangle, Check, Loader2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { formatDay, fmtInt } from './forecastUtils'

// One row of the Needs-Data panel. Only the missing_* fields are editable;
// anything the part already has is shown read-only as context.
function ExceptionRow({ row, existing, materialOptions, barSizeOptions, canSave, onSaved }) {
  const [form, setForm] = useState({
    length_in: existing?.length_in != null ? String(existing.length_in) : '',
    material: existing?.material || '',
    bar_size: existing?.bar_size || '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedOk, setSavedOk] = useState(false)

  const set = (field, value) => {
    setForm(f => ({ ...f, [field]: value }))
    setError('')
    setSavedOk(false)
  }

  const handleSave = async () => {
    setError('')

    const payload = {
      part_number: row.part_number,
      source_file: 'manual',
      family: 'component',
      updated_at: new Date().toISOString(),
    }

    if (row.missing_length) {
      const len = parseFloat(form.length_in)
      if (!Number.isFinite(len) || len <= 0) {
        setError('Length must be a number greater than 0.')
        return
      }
      payload.length_in = len
    } else if (existing?.length_in != null) {
      payload.length_in = existing.length_in
    }

    if (row.missing_material) {
      if (!form.material) {
        setError('Pick a material.')
        return
      }
      payload.material = form.material
    } else if (existing?.material) {
      payload.material = existing.material
    }

    if (row.missing_bar_size) {
      if (!form.bar_size) {
        setError('Pick a bar size.')
        return
      }
      payload.bar_size = form.bar_size
    } else if (existing?.bar_size) {
      payload.bar_size = existing.bar_size
    }

    setSaving(true)
    try {
      const { error: upsertError } = await supabase
        .from('part_dimensions')
        .upsert(payload, { onConflict: 'part_number' })
      if (upsertError) throw upsertError
      setSavedOk(true)
      // Refresh every forecast dataset so the part leaves this panel and lands in
      // the bar table in one visible motion.
      await onSaved()
    } catch (err) {
      setError(err.message || 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  // Existing values render as plain text. A field that is still missing renders
  // as an amber marker — that is what a read-only viewer (purchaser) sees in
  // place of the editor, since there is no value to show yet.
  const readOnlyCell = (value, isMissing = false) => {
    if (value) return <span className="text-gray-400 text-xs">{value}</span>
    if (isMissing) return <span className="text-xs px-2 py-0.5 rounded bg-amber-900/40 text-amber-300 whitespace-nowrap">Missing</span>
    return <span className="text-gray-600 text-xs">—</span>
  }

  return (
    <tr className="hover:bg-amber-900/10 align-top">
      <td className="px-3 py-2 font-mono text-white whitespace-nowrap">{row.part_number}</td>
      <td className="px-3 py-2 text-gray-400 text-xs max-w-[16rem] truncate" title={row.description || ''}>
        {row.description || '—'}
      </td>
      <td className="px-3 py-2 text-right text-gray-300">{fmtInt(row.pieces)}</td>
      <td className="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">{formatDay(row.first_scheduled)}</td>

      {/* Length */}
      <td className="px-3 py-2">
        {row.missing_length && canSave ? (
          <input
            type="number"
            step="0.001"
            min="0"
            value={form.length_in}
            disabled={saving}
            onChange={e => set('length_in', e.target.value)}
            placeholder="in."
            className="w-24 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs focus:outline-none focus:border-skynet-accent disabled:opacity-50"
          />
        ) : readOnlyCell(existing?.length_in != null ? `${existing.length_in}"` : null, row.missing_length)}
      </td>

      {/* Material */}
      <td className="px-3 py-2">
        {row.missing_material && canSave ? (
          <select
            value={form.material}
            disabled={saving}
            onChange={e => set('material', e.target.value)}
            className="w-40 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs focus:outline-none focus:border-skynet-accent disabled:opacity-50"
          >
            <option value="">Select…</option>
            {materialOptions.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : readOnlyCell(existing?.material, row.missing_material)}
      </td>

      {/* Bar size */}
      <td className="px-3 py-2">
        {row.missing_bar_size && canSave ? (
          <select
            value={form.bar_size}
            disabled={saving}
            onChange={e => set('bar_size', e.target.value)}
            className="w-36 px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs focus:outline-none focus:border-skynet-accent disabled:opacity-50"
          >
            <option value="">Select…</option>
            {barSizeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : readOnlyCell(existing?.bar_size, row.missing_bar_size)}
      </td>

      <td className="px-3 py-2 text-center whitespace-nowrap">
        {canSave ? (
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1 text-xs px-3 py-1 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white rounded transition-colors"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : savedOk ? <Check size={12} /> : null}
            {saving ? 'Saving' : 'Save'}
          </button>
        ) : (
          <span className="text-xs text-gray-600">Read-only</span>
        )}
        {error && <div className="text-xs text-red-400 mt-1 max-w-[14rem] whitespace-normal">{error}</div>}
      </td>
    </tr>
  )
}

export default function ExceptionsPanel({
  exceptions,
  dimsByPart,
  materialOptions,
  barSizeOptions,
  canSave,
  onSaved,
}) {
  const rows = exceptions || []
  const n = rows.length
  // Collapsed when there is nothing to fix; open when there is.
  const [open, setOpen] = useState(n > 0)

  return (
    <div className="rounded-lg border border-amber-800/40 bg-amber-900/10">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-amber-900/15 transition-colors rounded-lg"
      >
        {open ? <ChevronDown size={16} className="text-amber-400" /> : <ChevronRight size={16} className="text-amber-400" />}
        <AlertTriangle size={16} className="text-amber-400" />
        <h3 className="text-sm font-semibold text-amber-200">Needs data ({n})</h3>
        <span className="text-xs text-amber-200/60 ml-2">
          Parts with scheduled demand that can&apos;t be forecast until their dimensions are known.
        </span>
      </button>

      {open && (
        n === 0 ? (
          <p className="px-4 pb-4 text-sm text-amber-200/60">
            Every scheduled part has the dimension data the forecast needs.
          </p>
        ) : (
          <div className="border-t border-amber-800/30 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-amber-900/20 text-amber-200/70 uppercase text-xs">
                <tr>
                  <th className="px-3 py-2 text-left">Part Number</th>
                  <th className="px-3 py-2 text-left">Description</th>
                  <th className="px-3 py-2 text-right">Pieces</th>
                  <th className="px-3 py-2 text-left">First Scheduled</th>
                  <th className="px-3 py-2 text-left">Length (in)</th>
                  <th className="px-3 py-2 text-left">Material</th>
                  <th className="px-3 py-2 text-left">Bar Size</th>
                  <th className="px-3 py-2 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-amber-900/20">
                {rows.map(row => (
                  <ExceptionRow
                    // Remount on refresh so the editors reload from fresh prefill.
                    key={`${row.part_number}-${row.missing_length ? 'L' : ''}${row.missing_material ? 'M' : ''}${row.missing_bar_size ? 'S' : ''}`}
                    row={row}
                    existing={dimsByPart?.[row.part_number]}
                    materialOptions={materialOptions}
                    barSizeOptions={barSizeOptions}
                    canSave={canSave}
                    onSaved={onSaved}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  )
}
