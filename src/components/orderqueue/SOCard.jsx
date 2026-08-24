import { useMemo } from 'react'
import { ChevronRight, Loader2, ExternalLink, AlertTriangle } from 'lucide-react'
import {
  FB_SO_STATUS, FB_SO_STATUS_COLORS, FB_LINE_STATUS, FB_LINE_TYPE, FB_PRIORITY, FB_PRIORITY_COLORS,
  DISPOSITION_LABELS, DISPOSITION_COLORS, RESOLUTION_LABELS, RESOLUTION_COLORS, MANUAL_DISPOSITIONS,
  PRODUCT_LINE_TYPES, formatDate, formatDateShort, formatDateTime, isSuspectDate, isSelectableLine, convertBlocker,
  coQtyForLine, displayPartNumber,
} from '../../lib/fishbowl'

function Chip({ className = '', children, title }) {
  return (
    <span title={title} className={`inline-flex items-center px-2 py-0.5 rounded text-xs border whitespace-nowrap ${className}`}>
      {children}
    </span>
  )
}

function CountChip({ n, label, className }) {
  if (!n) return null
  return <Chip className={className}>{n} {label}</Chip>
}

const fmtQty = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString())

// SOCard — one Fishbowl sales order in the Order Queue.
// `order` is a v_fb_order_queue row; `lines` are fb_sales_order_lines for it (null until expanded).
export default function SOCard({
  order, lines, linesLoading, expanded, onToggle,
  selected, onToggleLine, onSelectAll, onClearSelection,
  canAct, busy, onBulkDisposition, onConvert, onOpenCO,
}) {
  const selectableLines = useMemo(() => (lines || []).filter(isSelectableLine), [lines])
  const selectedLines = useMemo(
    () => (lines || []).filter((l) => selected.has(l.fb_soitem_id)),
    [lines, selected],
  )
  const convertibleSelected = selectedLines.filter((l) => !convertBlocker(l))
  const allSelected = selectableLines.length > 0 && selectableLines.every((l) => selected.has(l.fb_soitem_id))

  const suspect = order.suspect_dates
  const dueClass = suspect ? 'text-red-300' : order.earliest_due && order.earliest_due < new Date().toISOString().slice(0, 10) ? 'text-amber-300' : 'text-gray-200'

  return (
    <div className={`bg-gray-900 rounded-lg border ${order.pending_lines > 0 ? 'border-amber-900/60' : 'border-gray-800'} overflow-hidden`}>
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-gray-800/40 transition-colors"
      >
        <ChevronRight size={16} className={`text-gray-500 transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''}`} />
        <span className="font-mono text-white text-sm w-16 flex-shrink-0">SO {order.so_number}</span>
        <Chip className={FB_SO_STATUS_COLORS[order.status_id] || FB_SO_STATUS_COLORS[95]}>
          {FB_SO_STATUS[order.status_id] || order.status_id}
        </Chip>
        <span className="text-gray-200 text-sm truncate flex-1 min-w-0" title={order.customer_name}>
          {order.customer_name}
          {order.customer_po ? <span className="text-gray-500 font-mono text-xs ml-2">PO {order.customer_po}</span> : null}
        </span>
        {order.salesman && <span className="text-gray-500 text-xs hidden lg:inline">{order.salesman}</span>}
        {order.priority_id && order.priority_id !== 30 && (
          <span className={`text-xs ${FB_PRIORITY_COLORS[order.priority_id] || 'text-gray-500'}`}>{FB_PRIORITY[order.priority_id]}</span>
        )}
        <span className={`font-mono text-xs w-20 text-right flex-shrink-0 ${dueClass}`} title="Earliest effective due date">
          {formatDateShort(order.earliest_due)}
          {order.has_default_dates && <span className="text-amber-400" title="Some lines have no real date entered">*</span>}
        </span>
        <div className="flex items-center gap-1 flex-shrink-0">
          {suspect && <Chip className="bg-red-900/40 text-red-300 border-red-800" title="A line carries an impossible year — fix it in Fishbowl"><AlertTriangle size={11} /></Chip>}
          <CountChip n={order.pending_lines} label="pending" className={DISPOSITION_COLORS.pending} />
          <CountChip n={order.production_lines} label="prod" className={DISPOSITION_COLORS.production} />
          <CountChip n={order.stock_lines} label="stock" className={DISPOSITION_COLORS.stock} />
          <CountChip n={order.purchased_lines} label="buy" className={DISPOSITION_COLORS.purchased} />
          <CountChip n={order.covered_lines} label="covered" className={DISPOSITION_COLORS.covered} />
          {order.open_exceptions > 0 && (
            <Chip className="bg-red-900/40 text-red-300 border-red-800">{order.open_exceptions} exception{order.open_exceptions === 1 ? '' : 's'}</Chip>
          )}
        </div>
        {order.linked_co_number && (
          <span
            role="link"
            onClick={(e) => { e.stopPropagation(); onOpenCO?.(order.linked_co_number) }}
            className="font-mono text-xs text-purple-300 hover:text-purple-200 inline-flex items-center gap-1 flex-shrink-0"
            title="Open in Customer Orders"
          >
            {order.linked_co_number} <ExternalLink size={11} />
          </span>
        )}
      </button>

      {/* Lines */}
      {expanded && (
        <div className="border-t border-gray-800">
          {linesLoading || !lines ? (
            <div className="px-4 py-6 text-gray-500 text-sm flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Loading lines...
            </div>
          ) : lines.length === 0 ? (
            <div className="px-4 py-6 text-gray-500 text-sm">No lines.</div>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead className="bg-gray-800/60 text-gray-400 text-xs uppercase">
                  <tr>
                    {canAct && (
                      <th className="px-3 py-2 w-8">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={(e) => (e.target.checked ? onSelectAll(selectableLines.map((l) => l.fb_soitem_id)) : onClearSelection())}
                          disabled={selectableLines.length === 0}
                          className="accent-purple-500"
                        />
                      </th>
                    )}
                    <th className="px-2 py-2 text-left w-10">#</th>
                    <th className="px-2 py-2 text-left">Part</th>
                    <th className="px-2 py-2 text-left hidden xl:table-cell">Description</th>
                    <th className="px-2 py-2 text-right">Ordered</th>
                    <th className="px-2 py-2 text-right">Shipped</th>
                    <th className="px-2 py-2 text-right">To fulfill</th>
                    <th className="px-2 py-2 text-left">Due</th>
                    <th className="px-2 py-2 text-left">FB status</th>
                    <th className="px-2 py-2 text-left">Disposition</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {lines.map((l) => {
                    const isProduct = PRODUCT_LINE_TYPES.includes(l.type_id)
                    const selectable = isSelectableLine(l)
                    const muted = !isProduct && l.type_id !== 80
                    const coNumber = l.co_line?.customer_order?.co_number
                    return (
                      <tr key={l.fb_soitem_id} className={`${muted ? 'text-gray-600' : ''} ${selected.has(l.fb_soitem_id) ? 'bg-purple-900/10' : ''}`}>
                        {canAct && (
                          <td className="px-3 py-2">
                            {selectable && (
                              <input
                                type="checkbox"
                                checked={selected.has(l.fb_soitem_id)}
                                onChange={() => onToggleLine(l.fb_soitem_id)}
                                className="accent-purple-500"
                              />
                            )}
                          </td>
                        )}
                        <td className="px-2 py-2 font-mono text-xs text-gray-500">{l.line_number}</td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`font-mono ${muted ? '' : 'text-gray-200'}`}>{displayPartNumber(l)}</span>
                            {l.type_id === 80 && <Chip className="bg-gray-800 text-purple-300 border-purple-900">Kit</Chip>}
                            {l.type_id === 12 && <Chip className="bg-gray-800 text-gray-400 border-gray-700">Drop ship</Chip>}
                            {muted && <span className="text-xs">{FB_LINE_TYPE[l.type_id] || l.type_id}</span>}
                            {!muted && l.resolution && RESOLUTION_LABELS[l.resolution] && (
                              <span className={`text-xs ${RESOLUTION_COLORS[l.resolution]}`}>{RESOLUTION_LABELS[l.resolution]}</span>
                            )}
                            {l.part && l.part.is_active === false && <span className="text-xs text-red-400">inactive part</span>}
                            {l.customer_part_num && <span className="text-xs text-gray-500">cust {l.customer_part_num}</span>}
                            {l.rev_level && <span className="text-xs text-gray-500">rev {l.rev_level}</span>}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-gray-500 text-xs hidden xl:table-cell max-w-[260px] truncate" title={l.description || ''}>{l.description || ''}</td>
                        <td className="px-2 py-2 text-right font-mono text-xs">{fmtQty(l.qty_ordered)}</td>
                        <td className="px-2 py-2 text-right font-mono text-xs text-gray-400">{fmtQty(l.qty_fulfilled)}</td>
                        <td className={`px-2 py-2 text-right font-mono text-xs ${isProduct ? 'text-gray-200' : ''}`}>{isProduct ? fmtQty(coQtyForLine(l)) : ''}</td>
                        <td className={`px-2 py-2 font-mono text-xs whitespace-nowrap ${isSuspectDate(l.effective_due_date) ? 'text-red-300' : ''}`} title={l.remaining_parts_ship_date ? `Remaining Parts Ship Date ${formatDate(l.remaining_parts_ship_date)}` : 'Date Scheduled'}>
                          {isProduct || l.type_id === 80 ? formatDateShort(l.effective_due_date) : ''}
                          {l.due_date_is_default && (isProduct || l.type_id === 80) && <span className="text-amber-400" title="No real date entered in Fishbowl">*</span>}
                          {l.remaining_parts_ship_date && <span className="text-cyan-400 ml-1" title="Remaining Parts Ship Date">R</span>}
                        </td>
                        <td className="px-2 py-2 text-xs whitespace-nowrap">{FB_LINE_STATUS[l.status_id] || l.status_id}</td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Chip className={DISPOSITION_COLORS[l.disposition] || DISPOSITION_COLORS.ignore}
                              title={[l.disposition_by_profile?.full_name, l.disposition_at ? formatDateTime(l.disposition_at) : null, l.disposition_note].filter(Boolean).join(' · ')}>
                              {DISPOSITION_LABELS[l.disposition] || l.disposition}
                            </Chip>
                            {coNumber && (
                              <span
                                role="link"
                                onClick={() => onOpenCO?.(coNumber)}
                                className="font-mono text-xs text-purple-300 hover:text-purple-200 inline-flex items-center gap-1"
                                title={`CO line ${l.co_line?.line_number} · ${l.co_line?.status}`}
                              >
                                {coNumber} #{l.co_line?.line_number} <ExternalLink size={10} />
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {/* Bulk action bar */}
              {canAct && selectedLines.length > 0 && (
                <div className="px-4 py-3 bg-gray-800/60 border-t border-gray-800 flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-gray-400 mr-2">{selectedLines.length} selected</span>
                  {MANUAL_DISPOSITIONS.map((d) => (
                    <button
                      key={d.value}
                      disabled={busy}
                      onClick={() => onBulkDisposition(d.value)}
                      className={`px-3 py-1.5 rounded text-xs border transition-colors disabled:opacity-50 ${DISPOSITION_COLORS[d.value]} hover:brightness-125`}
                    >
                      {d.label}
                    </button>
                  ))}
                  <button
                    disabled={busy || convertibleSelected.length === 0}
                    onClick={onConvert}
                    title={convertibleSelected.length === 0 ? 'None of the selected lines can become a CO line (part not in SkyNet, closed, or already linked)' : ''}
                    className="ml-auto px-3 py-1.5 rounded text-xs bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50 flex items-center gap-1"
                  >
                    {busy && <Loader2 size={12} className="animate-spin" />}
                    Create CO ({convertibleSelected.length})
                  </button>
                  <button onClick={onClearSelection} className="px-2 py-1.5 text-xs text-gray-400 hover:text-white">Clear</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
