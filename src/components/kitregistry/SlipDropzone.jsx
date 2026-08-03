import { useRef } from 'react'
import { Upload, Loader2, X, AlertTriangle, RotateCcw } from 'lucide-react'
import { SLIP_ACCEPT } from '../../lib/packingSlip'

// The one dropzone for packing slips, shared by the Packing Slip tab and the
// Kit Entry form (D-KSTC-29). Presentational only — the caller owns the file
// and the extraction; this owns nothing but the drag state and the hidden input.
//
// Copy is a prop rather than a mode flag: the tab asks for a slip as the whole
// point of the screen, Kit Entry offers one as an optional extra, and those are
// two different sentences rather than two different components.

export default function SlipDropzone({
  title = 'Drop the packing slip here',
  hint = 'PDF from Fishbowl, or a photo of the printed slip (PNG, JPEG, WebP)',
  busy,
  fileName,
  error,
  onFiles,
  onClearError,
  onRemove,
  compact,
  dragging,
  setDragging,
}) {
  const inputRef = useRef(null)

  return (
    <>
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); onFiles(e.dataTransfer?.files) }}
        className={`rounded-xl border-2 border-dashed text-center transition-colors ${
          compact ? 'p-5' : 'p-8'
        } ${dragging ? 'border-skynet-accent bg-skynet-accent/10' : 'border-gray-700 bg-gray-800/50'}`}
      >
        <Upload size={compact ? 24 : 30} className="mx-auto mb-2 text-gray-500" />
        <p className={`text-gray-200 font-medium ${compact ? 'text-sm' : 'text-base'}`}>{title}</p>
        <p className="text-gray-500 text-xs mt-1">{hint}</p>

        {/* The escape hatch stays reachable WHILE the read is in flight — a slip
            that never comes back must not be able to trap the save button. */}
        {fileName ? (
          <div className="mt-3 flex items-center justify-center gap-3 flex-wrap">
            <span className="text-gray-300 text-sm font-mono truncate max-w-[18rem]">{fileName}</span>
            {onRemove && (
              <button
                onClick={onRemove}
                className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs font-medium"
              >
                Remove slip
              </button>
            )}
          </div>
        ) : (
          <button
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className={`mt-3 rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 font-medium ${
              compact ? 'px-4 py-2 text-sm' : 'px-5 py-2.5 text-sm'}`}
          >
            Choose a file
          </button>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={SLIP_ACCEPT}
          onChange={e => { onFiles(e.target.files); e.target.value = '' }}
          className="hidden"
        />

        {busy && (
          <p className="text-gray-400 text-sm mt-3 flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            Reading slip…
          </p>
        )}
      </div>

      {/* Extraction failing is never fatal — it costs typing, not the record. */}
      {error && (
        <div className="mt-3 flex items-start gap-2 bg-amber-900/25 border border-amber-600 rounded-lg px-3 py-2.5">
          <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-amber-100 text-sm">{error}</p>
            <button
              onClick={() => { onClearError?.(); inputRef.current?.click() }}
              className="mt-2 flex items-center gap-1.5 text-amber-300 hover:underline text-xs"
            >
              <RotateCcw size={13} /> Try another file
            </button>
          </div>
          <button onClick={onClearError} className="text-amber-400/60 hover:text-amber-200">
            <X size={14} />
          </button>
        </div>
      )}
    </>
  )
}
