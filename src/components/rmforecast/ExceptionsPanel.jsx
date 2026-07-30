import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, AlertTriangle, Loader2, Sparkles } from 'lucide-react'
import { formatDay, fmtInt } from './forecastUtils'
import { usePartDimensionEditor } from './usePartDimensionEditor'
import {
  LengthField,
  MaterialField,
  BarSizeField,
  SaveButton,
  EditorError,
  ReadOnlyValue,
} from './PartDimensionEditor'
import {
  findDrawingsForParts,
  fetchDrawingBase64,
  invokeExtraction,
  confidenceStyle,
  needsCarefulReview,
  provenanceLine,
  NO_DRAWING_MESSAGE,
} from '../../lib/dimensionExtraction'

// One row of the Needs-Data panel. Only the missing_* fields are editable;
// anything the part already has is shown read-only as context.
function ExceptionRow({
  row, existing, materialOptions, barSizeOptions, canSave, profile, drawing, onSaved,
}) {
  const editor = usePartDimensionEditor({
    partNumber: row.part_number,
    mode: 'needs_data',
    current: {
      length_in: existing?.length_in,
      material_type: existing?.material_type,
      bar_size: existing?.bar_size,
    },
    existingRow: existing,
    required: {
      length: row.missing_length,
      material: row.missing_material,
      bar_size: row.missing_bar_size,
    },
    materialOptions,
    barSizeOptions,
    profile,
    onSaved,
  })

  const [extracting, setExtracting] = useState(false)
  const [extractError, setExtractError] = useState('')

  const handleExtract = async () => {
    setExtractError('')
    setExtracting(true)
    try {
      const documentBase64 = await fetchDrawingBase64(drawing.file_url)
      const envelope = await invokeExtraction({
        partNumber: row.part_number,
        description: row.description,
        documentBase64,
        fileName: drawing.file_name,
      })
      editor.applySuggestion(envelope)
    } catch (err) {
      // The row stays fully editable — a failed read must never block the human.
      setExtractError(err.message || 'The drawing could not be read.')
    } finally {
      setExtracting(false)
    }
  }

  const suggestion = editor.extraction?.suggestion
  const careful = editor.extraction ? needsCarefulReview(editor.extraction) : false
  const chip = suggestion ? confidenceStyle(suggestion.confidence) : null

  return (
    <>
      <tr className="hover:bg-amber-900/10 align-top">
        <td className="px-3 py-2 font-mono text-white whitespace-nowrap">{row.part_number}</td>
        <td className="px-3 py-2 text-gray-400 text-xs max-w-[16rem] truncate" title={row.description || ''}>
          {row.description || '—'}
        </td>
        <td className="px-3 py-2 text-right text-gray-300">{fmtInt(row.pieces)}</td>
        <td className="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">{formatDay(row.first_scheduled)}</td>

        {/* Length */}
        <td className="px-3 py-2">
          {row.missing_length && canSave
            ? <LengthField editor={editor} />
            : <ReadOnlyValue value={existing?.length_in != null ? `${existing.length_in}"` : null} isMissing={row.missing_length} />}
        </td>

        {/* Material */}
        <td className="px-3 py-2">
          {row.missing_material && canSave
            ? <MaterialField editor={editor} />
            : <ReadOnlyValue value={existing?.material_type} isMissing={row.missing_material} />}
        </td>

        {/* Bar size */}
        <td className="px-3 py-2">
          {row.missing_bar_size && canSave
            ? <BarSizeField editor={editor} />
            : <ReadOnlyValue value={existing?.bar_size} isMissing={row.missing_bar_size} />}
        </td>

        <td className="px-3 py-2 text-center whitespace-nowrap">
          {canSave ? (
            <div className="flex flex-col items-stretch gap-1">
              <button
                type="button"
                onClick={handleExtract}
                disabled={!drawing || extracting || editor.saving}
                title={drawing
                  ? `Read ${drawing.file_name || 'the drawing'}${drawing.job_number ? ` from job ${drawing.job_number}` : ''}`
                  : NO_DRAWING_MESSAGE}
                className="inline-flex items-center justify-center gap-1 text-xs px-3 py-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed border border-gray-600 text-gray-200 rounded transition-colors"
              >
                {extracting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                {extracting ? 'Reading' : 'Extract from drawing'}
              </button>
              <SaveButton editor={editor} className="justify-center" />
            </div>
          ) : (
            <span className="text-xs text-gray-600">Read-only</span>
          )}
          <EditorError editor={editor} />
          {extractError && (
            <div className="text-xs text-red-400 mt-1 max-w-[14rem] whitespace-normal">{extractError}</div>
          )}
        </td>
      </tr>

      {suggestion && (
        <tr className={careful ? 'bg-amber-900/15' : 'bg-gray-900/40'}>
          <td colSpan={8} className="px-3 pb-3 pt-0">
            <div className={`rounded border px-3 py-2 text-xs ${careful ? 'border-amber-700/50' : 'border-gray-700'}`}>
              <div className="flex items-center gap-2 flex-wrap mb-1">
                {chip && (
                  <span className={`px-2 py-0.5 rounded whitespace-nowrap ${chip.className}`}>{chip.label}</span>
                )}
                {careful && (
                  <span className="px-2 py-0.5 rounded bg-amber-900/50 text-amber-300 whitespace-nowrap">
                    Review carefully
                  </span>
                )}
                <span className="text-gray-500">Suggested — nothing is saved until you click Save.</span>
              </div>

              {provenanceLine(editor.extraction, drawing) && (
                <p className="text-gray-400">{provenanceLine(editor.extraction, drawing)}</p>
              )}

              {Array.isArray(suggestion.ambiguities) && suggestion.ambiguities.length > 0 && (
                <ul className="list-disc list-inside mt-1 space-y-0.5 text-amber-300">
                  {suggestion.ambiguities.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              )}

              {suggestion.material_unlisted && (
                <p className="text-amber-300 mt-1">
                  The drawing calls out &ldquo;{suggestion.material_unlisted}&rdquo;, which is not in the
                  material catalog — pick the right one yourself.
                </p>
              )}
              {suggestion.bar_size_unlisted && (
                <p className="text-amber-300 mt-1">
                  The reading suggests bar size &ldquo;{suggestion.bar_size_unlisted}&rdquo;, which is not a
                  stocked size — pick the right one yourself.
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

export default function ExceptionsPanel({
  exceptions,
  dimsByPart,
  materialOptions,
  barSizeOptions,
  canSave,
  profile,
  onSaved,
}) {
  const rows = exceptions || []
  const n = rows.length
  // Collapsed when there is nothing to fix; open when there is.
  const [open, setOpen] = useState(n > 0)
  const [drawings, setDrawings] = useState({})

  // One batched lookup for the whole panel decides which rows can offer Extract.
  const partKey = rows.map(r => r.part_number).join('|')
  useEffect(() => {
    if (!canSave || !rows.length) {
      setDrawings({})
      return undefined
    }
    let cancelled = false
    findDrawingsForParts(rows.map(r => r.part_number))
      .then(map => { if (!cancelled) setDrawings(map) })
      .catch(() => { if (!cancelled) setDrawings({}) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSave, partKey])

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
                    profile={profile}
                    drawing={drawings[row.part_number] || null}
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
