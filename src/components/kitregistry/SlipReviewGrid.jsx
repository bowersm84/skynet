import { useState } from 'react'
import { Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import { savableLines, CONFIDENCE_TONE, CONFIDENCE_LABEL } from '../../lib/packingSlip'
import { Pill, Empty } from './ui'

// The operator's confirmation grid — the one place a slip's component lines are
// edited, shared by the Packing Slip tab and Kit Entry (D-KSTC-29).
//
// SUGGEST, NEVER COMMIT: what this grid holds is what saves. The extraction only
// seeded it, and every confidence chip retires the moment a human types over the
// row it describes.

export function GridInput({ value, onChange, inputMode, placeholder }) {
  return (
    <input
      value={value ?? ''}
      onChange={e => onChange(e.target.value)}
      inputMode={inputMode}
      placeholder={placeholder}
      className="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded text-white text-sm font-mono placeholder-gray-600 focus:border-skynet-accent focus:outline-none"
    />
  )
}

// One editable row, used both inside the table and standalone in Kit Entry's
// attention list — so a line looks and behaves the same wherever it is read.
export function SlipLineRow({ line, onEdit, onDrop }) {
  return (
    <tr className="border-t border-gray-800">
      <td className="px-2 py-1.5 text-gray-500 font-mono text-xs">{line.line_no ?? '—'}</td>
      <td className="px-2 py-1.5">
        <GridInput value={line.part_number} onChange={v => onEdit(line.key, 'part_number', v)} />
      </td>
      <td className="px-2 py-1.5">
        <GridInput
          value={line.lot_number || ''}
          onChange={v => onEdit(line.key, 'lot_number', v)}
          placeholder="lot #"
        />
      </td>
      <td className="px-2 py-1.5">
        <GridInput
          value={line.qty_shipped ?? ''}
          onChange={v => onEdit(line.key, 'qty_shipped', v)}
          inputMode="decimal"
        />
      </td>
      <td className="px-2 py-1.5">
        <div className="flex items-center justify-end gap-1.5">
          {!line.edited && (
            <Pill tone={CONFIDENCE_TONE[line.confidence]}>{CONFIDENCE_LABEL[line.confidence]}</Pill>
          )}
          <button
            onClick={() => onDrop(line.key)}
            className="text-gray-500 hover:text-red-400 shrink-0"
            title="Remove this line"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </td>
    </tr>
  )
}

export function SlipLineTable({ lines, onEdit, onDrop, emptyText = 'No component lines left to record for this kit.' }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-700">
      <table className="w-full text-sm">
        <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
          <tr>
            <th className="text-left px-2 py-2 font-medium w-12">Line</th>
            <th className="text-left px-2 py-2 font-medium">Part #</th>
            <th className="text-left px-2 py-2 font-medium">Lot #</th>
            <th className="text-left px-2 py-2 font-medium w-20">Qty</th>
            <th className="text-left px-2 py-2 font-medium w-24"> </th>
          </tr>
        </thead>
        <tbody>
          {lines.map(l => (
            <SlipLineRow key={l.key} line={l} onEdit={onEdit} onDrop={onDrop} />
          ))}
          {!lines.length && (
            <tr><td colSpan={5}><Empty>{emptyText}</Empty></td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The full grid: recordable lines in the table, then the lot-less remainder
 * behind a disclosure. A line with no lot is not dropped — nothing read off a
 * slip is ever silently discarded — it simply does not record until someone
 * types the lot from the paper, at which point it joins the table above.
 */
export default function SlipReviewGrid({ lines, onEdit, onDrop }) {
  const [showExcluded, setShowExcluded] = useState(false)
  const included = savableLines(lines)
  const excluded = (lines || []).filter(l => !String(l.lot_number || '').trim())

  return (
    <>
      <SlipLineTable lines={included} onEdit={onEdit} onDrop={onDrop} />

      {excluded.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowExcluded(e => !e)}
            className="flex items-center gap-2 text-gray-400 hover:text-gray-200 text-xs"
          >
            {showExcluded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {excluded.length} line{excluded.length === 1 ? '' : 's'} with no lot number — excluded
          </button>
          {showExcluded && (
            <div className="mt-2 rounded-lg border border-gray-700 bg-gray-900/60 p-3 space-y-2">
              <p className="text-gray-500 text-[11px]">
                Nothing was read after &ldquo;Lot#:&rdquo; on these. Type the lot from the paper
                and the line joins the grid above; leave it blank and it is not recorded.
              </p>
              {excluded.map(l => (
                <div key={l.key} className="flex items-center gap-2">
                  <span className="text-gray-400 text-xs font-mono w-8 shrink-0">{l.line_no ?? '—'}</span>
                  <span className="text-gray-300 text-xs font-mono flex-1 min-w-0 truncate">{l.part_number}</span>
                  <GridInput
                    value={l.lot_number || ''}
                    onChange={v => onEdit(l.key, 'lot_number', v)}
                    placeholder="lot #"
                  />
                  <button
                    onClick={() => onDrop(l.key)}
                    className="text-gray-500 hover:text-red-400 shrink-0"
                    title="Remove this line"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
