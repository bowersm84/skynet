// Shared part_dimensions editor controls for the RM Forecast section
// (D-RMF-04 / D-RMF-05).
//
// ONE implementation serves both write surfaces:
//   * the "Needs data" exceptions panel, which lays its fields out as cells of
//     an existing table (mode 'needs_data'), and
//   * the "Correct material" action on a forecast part drill-down row, which
//     opens a stacked form in a modal (mode 'correction').
//
// The state and persistence live in usePartDimensionEditor.js; this file is the
// controls, exported individually so either surface can place them where it
// needs them, plus the stacked form and modal the correction path uses. Neither
// surface styles or validates a field of its own.

import { useMemo } from 'react'
import { Loader2, Check, X, AlertTriangle } from 'lucide-react'
import { numericOf } from './forecastUtils'
import { MAX_LENGTH_IN } from './usePartDimensionEditor'

// A select must be able to render the value it is holding even when that string
// came from job history and has never been stored in part_dimensions.
function withCurrentValue(options, value, toOption) {
  if (!value) return options
  return options.some(o => (o.value ?? o) === value) ? options : [...options, toOption(value)]
}

const INPUT_CLASS =
  'px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs focus:outline-none focus:border-skynet-accent disabled:opacity-50'

export function LengthField({ editor, className = 'w-24' }) {
  return (
    <input
      type="number"
      step="0.001"
      min="0"
      max={MAX_LENGTH_IN}
      value={editor.form.length_in}
      disabled={editor.saving}
      onChange={e => editor.set('length_in', e.target.value)}
      placeholder="in."
      className={`${className} ${INPUT_CLASS}`}
    />
  )
}

export function MaterialField({ editor, className = 'w-40' }) {
  const options = useMemo(
    () => withCurrentValue(
      editor.materialOptions.map(m => ({ value: m, label: m })),
      editor.form.material_type,
      v => ({ value: v, label: v }),
    ),
    [editor.materialOptions, editor.form.material_type],
  )
  return (
    <select
      value={editor.form.material_type}
      disabled={editor.saving}
      onChange={e => editor.set('material_type', e.target.value)}
      className={`${className} ${INPUT_CLASS}`}
    >
      <option value="">Select…</option>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

export function BarSizeField({ editor, className = 'w-36' }) {
  const options = useMemo(
    () => withCurrentValue(
      editor.barSizeOptions,
      editor.form.bar_size,
      v => ({ value: v, label: v, num: numericOf(v) }),
    ),
    [editor.barSizeOptions, editor.form.bar_size],
  )
  return (
    <select
      value={editor.form.bar_size}
      disabled={editor.saving}
      onChange={e => editor.set('bar_size', e.target.value)}
      className={`${className} ${INPUT_CLASS}`}
    >
      <option value="">Select…</option>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

export function CorrectionNoteField({ editor, className = 'w-full' }) {
  return (
    <textarea
      rows={2}
      value={editor.form.correction_note}
      disabled={editor.saving}
      onChange={e => editor.set('correction_note', e.target.value)}
      placeholder={'e.g. drawing calls .125 but part is turned from 3/8'}
      className={`${className} ${INPUT_CLASS} resize-none`}
    />
  )
}

export function SaveButton({ editor, label = 'Save', className = '' }) {
  return (
    <button
      type="button"
      onClick={editor.save}
      disabled={editor.saving}
      className={`inline-flex items-center gap-1 text-xs px-3 py-1 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white rounded transition-colors ${className}`}
    >
      {editor.saving ? <Loader2 size={12} className="animate-spin" /> : editor.savedOk ? <Check size={12} /> : null}
      {editor.saving ? 'Saving' : label}
    </button>
  )
}

export function EditorError({ editor, className = 'max-w-[14rem]' }) {
  if (!editor.error) return null
  return (
    <div className={`text-xs text-red-400 mt-1 whitespace-normal ${className}`}>{editor.error}</div>
  )
}

// A field the current role may not write. Purchaser never sees a disabled
// control — it sees the value, or an amber marker where a value is missing.
export function ReadOnlyValue({ value, isMissing = false }) {
  if (value) return <span className="text-gray-400 text-xs">{value}</span>
  if (isMissing) {
    return (
      <span className="text-xs px-2 py-0.5 rounded bg-amber-900/40 text-amber-300 whitespace-nowrap">
        Missing
      </span>
    )
  }
  return <span className="text-gray-600 text-xs">—</span>
}

// The stacked form — used by the correction modal.
export default function PartDimensionEditor({ editor, partNumber }) {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs uppercase text-gray-500 mb-1">Length (in)</label>
        <LengthField editor={editor} className="w-32" />
        <p className="text-xs text-gray-600 mt-1">
          Leave as-is unless the length is wrong too — it drives pieces per bar.
        </p>
      </div>

      <div>
        <label className="block text-xs uppercase text-gray-500 mb-1">Material</label>
        <MaterialField editor={editor} className="w-full" />
      </div>

      <div>
        <label className="block text-xs uppercase text-gray-500 mb-1">Bar Size</label>
        <BarSizeField editor={editor} className="w-full" />
      </div>

      {editor.isCorrection && (
        <div>
          <label className="block text-xs uppercase text-gray-500 mb-1">
            Note <span className="normal-case text-gray-600">(optional)</span>
          </label>
          <CorrectionNoteField editor={editor} />
        </div>
      )}

      {editor.isCorrection && (
        <div className="flex items-start gap-2 text-xs text-amber-200/80 bg-amber-900/15 border border-amber-800/40 rounded p-2">
          <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
          <span>
            Saving marks {partNumber} human-verified. The forecast will bucket it here
            from now on, ahead of anything inferred from job history or a drawing.
          </span>
        </div>
      )}

      <EditorError editor={editor} className="max-w-none" />
    </div>
  )
}

// Modal shell for the correction path.
export function PartDimensionEditorModal({ partNumber, editor, onClose }) {
  const handleSave = async () => {
    const ok = await editor.save()
    if (ok) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <div
        className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-lg shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h3 className="text-white font-semibold">Correct material</h3>
            <p className="text-xs text-gray-500 font-mono mt-0.5">{partNumber}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4">
          <PartDimensionEditor editor={editor} partNumber={partNumber} />
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-800">
          <button
            type="button"
            onClick={onClose}
            disabled={editor.saving}
            className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 border border-gray-700 text-gray-300 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={editor.saving}
            className="inline-flex items-center gap-1 text-xs px-3 py-1.5 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white rounded transition-colors"
          >
            {editor.saving ? <Loader2 size={12} className="animate-spin" /> : null}
            {editor.saving ? 'Saving' : 'Save correction'}
          </button>
        </div>
      </div>
    </div>
  )
}
