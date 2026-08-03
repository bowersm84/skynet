import { useState, useEffect, useRef } from 'react'
import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react'
import { PAGE_SIZE, TYPEAHEAD_DEBOUNCE, formatLogDate, SOURCE_LABEL, lotLabel } from '../../lib/kitRegistry'

// --- badges -----------------------------------------------------------------

const STATUS_STYLE = {
  active: 'bg-gray-700 text-gray-200',
  void: 'bg-red-900/40 text-red-300',
  no_entry: 'bg-gray-800 text-gray-400',
}

export function StatusBadge({ status }) {
  if (!status) return null
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded ${STATUS_STYLE[status] || 'bg-gray-700 text-gray-300'}`}>
      {status === 'no_entry' ? 'no entry' : status}
    </span>
  )
}

// medium/low transcription confidence is the signal worth colour — high is normal.
const CONFIDENCE_STYLE = {
  high: 'bg-gray-700 text-gray-300',
  medium: 'bg-amber-900/40 text-amber-300',
  low: 'bg-red-900/40 text-red-300',
}

export function ConfidenceBadge({ level }) {
  if (!level) return null
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded ${CONFIDENCE_STYLE[level] || 'bg-gray-700 text-gray-300'}`}>
      {level} confidence
    </span>
  )
}

export function SourceBadge({ source }) {
  if (!source) return null
  const paper = source === 'paper_transcription'
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded ${paper ? 'bg-purple-900/40 text-purple-300' : 'bg-blue-900/40 text-blue-300'}`}>
      {SOURCE_LABEL[source] || source}
    </span>
  )
}

export function Pill({ children, tone = 'gray' }) {
  const tones = {
    gray: 'bg-gray-700 text-gray-300',
    amber: 'bg-amber-900/40 text-amber-300',
    green: 'bg-green-900/40 text-green-300',
    blue: 'bg-blue-900/40 text-blue-300',
  }
  return <span className={`text-[11px] px-2 py-0.5 rounded ${tones[tone]}`}>{children}</span>
}

// --- layout -----------------------------------------------------------------

export function StatCard({ label, value, sub, tone = 'default' }) {
  const tones = {
    default: 'bg-gray-800 border-gray-700',
    headline: 'bg-amber-900/25 border-amber-600',
  }
  return (
    <div className={`rounded-xl border p-4 ${tones[tone]}`}>
      <p className="text-gray-400 text-xs uppercase tracking-wide">{label}</p>
      <p className={`font-mono font-bold mt-1 ${tone === 'headline' ? 'text-amber-300 text-3xl' : 'text-white text-2xl'}`}>
        {value}
      </p>
      {sub && <p className="text-gray-400 text-xs mt-1">{sub}</p>}
    </div>
  )
}

export function Section({ title, right, children }) {
  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-gray-300 text-sm font-semibold uppercase tracking-wide">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  )
}

export function Empty({ children }) {
  return <p className="text-gray-500 text-sm py-6 text-center">{children}</p>
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="flex items-center gap-2 text-gray-400 text-sm py-6 justify-center">
      <Loader2 size={16} className="animate-spin" /> {label}
    </div>
  )
}

export function LinkText({ children, onClick }) {
  return (
    <button onClick={onClick} className="text-skynet-accent hover:underline text-left">
      {children}
    </button>
  )
}

// --- pagination -------------------------------------------------------------

export function Pager({ page, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  if (total <= PAGE_SIZE) return <span className="text-gray-500 text-xs">{total} total</span>
  return (
    <div className="flex items-center gap-2 text-xs text-gray-400">
      <span>{total} total</span>
      <button
        onClick={() => onPage(page - 1)} disabled={page <= 0}
        className="p-1.5 rounded bg-gray-800 border border-gray-700 disabled:opacity-40 hover:bg-gray-700"
      ><ChevronLeft size={14} /></button>
      <span className="font-mono">{page + 1} / {pages}</span>
      <button
        onClick={() => onPage(page + 1)} disabled={page >= pages - 1}
        className="p-1.5 rounded bg-gray-800 border border-gray-700 disabled:opacity-40 hover:bg-gray-700"
      ><ChevronRight size={14} /></button>
    </div>
  )
}

// --- lots table -------------------------------------------------------------

// void / no_entry rows are DIMMED, never dropped — they prove the book's
// sequence is unbroken (D-KSTC-02 / the paper-ledger rule).
// `lotSub` is an optional { lotId: text } map rendered under the lot number —
// how a lens says WHY each row matched (the component lot's part + qty).
export function LotsTable({ rows, onOpenLot, onOpenSku, onOpenParty, lotSub, emptyText = 'No lots.' }) {
  if (!rows?.length) return <Empty>{emptyText}</Empty>
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-700">
      <table className="w-full text-sm">
        <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Lot</th>
            <th className="text-left px-3 py-2 font-medium">Logged</th>
            <th className="text-left px-3 py-2 font-medium">Kit part</th>
            <th className="text-left px-3 py-2 font-medium">Customer</th>
            <th className="text-left px-3 py-2 font-medium">Invoice</th>
            <th className="text-left px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(l => {
            const dim = l.record_status !== 'active'
            return (
              <tr key={l.id} className={`border-t border-gray-800 ${dim ? 'opacity-45' : ''} hover:bg-gray-800/50`}>
                <td className="px-3 py-2 whitespace-nowrap">
                  <LinkText onClick={() => onOpenLot(l.id)}>
                    <span className="font-mono font-semibold">{lotLabel(l)}</span>
                  </LinkText>
                  {lotSub?.[l.id] && (
                    <span className="block text-[11px] font-mono text-gray-400">{lotSub[l.id]}</span>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-300">{formatLogDate(l.log_date)}</td>
                <td className="px-3 py-2 min-w-[10rem]">
                  {/* as-written always visible; the resolved SKU sits under it */}
                  <span className="text-gray-200">{l.kit_part_as_written || <span className="text-gray-600">—</span>}</span>
                  {l.sku && onOpenSku && (
                    <LinkText onClick={() => onOpenSku(l.kit_sku_id)}>
                      <span className="block text-[11px] font-mono">{l.sku.part_number}</span>
                    </LinkText>
                  )}
                  {!l.kit_sku_id && l.kit_part_as_written && (
                    <span className="block text-[11px] text-gray-500">unresolved</span>
                  )}
                </td>
                <td className="px-3 py-2 min-w-[10rem]">
                  <span className="text-gray-200">{l.customer_as_written || <span className="text-gray-600">—</span>}</span>
                  {l.party && onOpenParty && (
                    <LinkText onClick={() => onOpenParty(l.party_id)}>
                      <span className="block text-[11px]">{l.party.name}</span>
                    </LinkText>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-300">{l.invoice_as_written || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <div className="flex flex-wrap gap-1">
                    <StatusBadge status={l.record_status} />
                    {l.transcription_confidence && l.transcription_confidence !== 'high' && (
                      <ConfidenceBadge level={l.transcription_confidence} />
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// --- typeahead --------------------------------------------------------------

// Shared field for the Search tab. `pinned` is the selected entity (or null);
// free text with nothing pinned falls through to an ilike filter downstream.
export function Typeahead({
  label, value, onChange, pinned, onPin, onUnpin,
  fetcher, renderItem, placeholder, disabled,
}) {
  const [items, setItems] = useState([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const suppressRef = useRef(false)

  useEffect(() => {
    if (suppressRef.current) { suppressRef.current = false; return }
    if (pinned) return
    if (!value || value.trim().length < 2) { setItems([]); return }
    let cancelled = false
    setBusy(true)
    const t = setTimeout(async () => {
      try {
        const rows = await fetcher(value)
        if (!cancelled) { setItems(rows); setOpen(true) }
      } catch (err) {
        console.error(`${label} typeahead failed:`, err)
        if (!cancelled) setItems([])
      } finally {
        if (!cancelled) setBusy(false)
      }
    }, TYPEAHEAD_DEBOUNCE)
    return () => { cancelled = true; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, pinned])

  const pick = (item) => {
    suppressRef.current = true
    onPin(item)
    setItems([])
    setOpen(false)
  }

  return (
    <div>
      <label className="block text-gray-400 text-xs font-medium mb-1.5">{label}</label>
      {pinned ? (
        <div className="flex items-center gap-2 px-3 py-2.5 bg-skynet-accent/15 border border-skynet-accent rounded-lg">
          <span className="flex-1 min-w-0 truncate text-white text-sm">{renderItem(pinned, true)}</span>
          <button onClick={onUnpin} className="text-gray-400 hover:text-white text-xs shrink-0">clear</button>
        </div>
      ) : (
        <div className="relative">
          <input
            value={value}
            onChange={e => onChange(e.target.value)}
            onFocus={() => { if (items.length) setOpen(true) }}
            placeholder={placeholder}
            disabled={disabled}
            className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:border-skynet-accent focus:outline-none disabled:opacity-50"
          />
          {busy && <Loader2 size={14} className="animate-spin text-gray-500 absolute right-3 top-3" />}
          {open && items.length > 0 && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
              <div className="absolute left-0 right-0 top-full mt-1 z-40 bg-gray-800 border border-gray-600 rounded-lg shadow-xl max-h-64 overflow-y-auto">
                {items.map(item => (
                  <button
                    key={item.id}
                    onClick={() => pick(item)}
                    className="w-full text-left px-3 py-2.5 hover:bg-gray-700 border-b border-gray-700 last:border-0"
                  >
                    {renderItem(item, false)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
