//
// Pricing Portal — Deviations (D-PRICE-52 E). Every quote line priced away from the
// book's recommendation: a manual price, another column, or a customer special.
//
// Read-only, and narrower than the rest of the portal: admin and pricing_manager only
// (canSeePricingDeviations), because it names reps and what they quoted. The view
// v_quote_deviations does the classification and the arithmetic (D-PRICE-51); this
// screen filters a date range, adds them up, and opens the quote behind a row.
//
import { useEffect, useMemo, useState } from 'react'
import { Loader2, Scale, X, FileDown, AlertTriangle } from 'lucide-react'
import { loadQuoteDeviations, loadQuote, money, num, todayIso, QUOTE_STATUS_LABELS } from '../../lib/pricing'
import { filterDeviations, summariseDeviations, deviationReps, DEVIATION_KINDS, DEVIATION_KIND_LABELS, DEVIATION_KIND_COLORS } from '../../lib/pricingView'
import { buildQuotePdf, quoteFilename } from '../../lib/quoteDoc'
import { downloadBytes } from '../../lib/priceListDoc'
import { TierBadge, SortableTh } from './PricingTypeaheads'
import { useSortedRows } from './hooks'

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// The quote behind a row, read-only. Reopening a quote is the Quote Builder's job — this
// screen never writes, so it shows the saved lines and offers the PDF, nothing else.
function QuotePanel({ quoteId, onClose }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let cancelled = false
    loadQuote(quoteId).then(d => { if (!cancelled) setData(d) }).catch(e => { if (!cancelled) setErr(e.message || String(e)) })
    return () => { cancelled = true }
  }, [quoteId])
  const q = data?.quote
  return (
    <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-4xl p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-white font-semibold font-mono">{q?.quote_number || 'Quote'}</div>
            {q && <div className="text-xs text-gray-400 truncate">{q.customer_name}{q.customer_number ? ` · #${q.customer_number}` : ''} · {QUOTE_STATUS_LABELS[q.status] || q.status} · issued {q.issued_on} · valid until {q.valid_until} · {q.created_by_name || ''} · {q.rev_label || ''}</div>}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {q && <button onClick={async () => downloadBytes(await buildQuotePdf(q, data.lines), quoteFilename(q), 'application/pdf')} className="text-gray-400 hover:text-white inline-flex items-center gap-1 text-xs"><FileDown size={13} /> PDF</button>}
            <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={16} /></button>
          </div>
        </div>
        {err && <div className="text-rose-300 text-xs">{err}</div>}
        {!data && !err && <div className="p-8 text-center"><Loader2 size={20} className="animate-spin text-gray-500 mx-auto" /></div>}
        {data && (
          <div className="overflow-auto rounded-lg border border-gray-700 max-h-[60vh]">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-800 sticky top-0"><tr className="text-left text-[10px] uppercase tracking-wide text-gray-400">
                <th className="px-2 py-1.5">Part</th><th className="px-2 py-1.5">Description</th><th className="px-2 py-1.5 text-right">Qty</th>
                <th className="px-2 py-1.5 text-right">Unit</th><th className="px-2 py-1.5 text-right">Extended</th><th className="px-2 py-1.5">Basis</th><th className="px-2 py-1.5">Reason</th>
              </tr></thead>
              <tbody>
                {data.lines.map(l => (
                  <tr key={l.id} className={`border-t border-gray-800 ${l.basis === 'manual' ? 'bg-rose-950/20' : ''}`}>
                    <td className="px-2 py-1 font-mono text-white whitespace-nowrap">{l.part_number}</td>
                    <td className="px-2 py-1 text-gray-400 truncate max-w-xs">{l.description || ''}</td>
                    <td className="px-2 py-1 text-right font-mono text-gray-300">{num(l.qty)}</td>
                    <td className="px-2 py-1 text-right font-mono text-white">{money(l.unit_price, 3)}</td>
                    <td className="px-2 py-1 text-right font-mono text-gray-300">{money(l.extended)}</td>
                    <td className="px-2 py-1 text-gray-400">{l.basis === 'manual' ? <span className="text-rose-300">manual</span> : (l.col_key || l.basis || '')}</td>
                    <td className="px-2 py-1 text-gray-500 truncate max-w-xs" title={l.note || ''}>{l.note || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {q?.notes && <div className="text-[11px] text-gray-500">Printed notes: {q.notes}</div>}
      </div>
    </div>
  )
}

export default function PriceDeviations() {
  const [range, setRange] = useState({ from: daysAgo(30), to: todayIso() })
  const [rep, setRep] = useState('all')
  const [kind, setKind] = useState('all')
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState(null)
  const [openQuote, setOpenQuote] = useState(null)

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRows(null); setErr(null)
    loadQuoteDeviations({ from: range.from, to: range.to })
      .then(r => { if (!cancelled) setRows(r) })
      .catch(e => { if (!cancelled) { setErr(e.message || String(e)); setRows([]) } })
    return () => { cancelled = true }
  }, [range.from, range.to])

  // Rep and kind narrow the loaded range rather than the query, so the dropdowns stay
  // complete and switching one does not cost a round trip.
  const reps = useMemo(() => deviationReps(rows || []), [rows])
  const shownRows = useMemo(() => filterDeviations(rows || [], { rep, kind }), [rows, rep, kind])
  const summary = useMemo(() => summariseDeviations(shownRows), [shownRows])
  const cols = useMemo(() => ({
    issued: r => r.issued_on || '', quote: r => r.quote_number || '', customer: r => r.customer_name || '',
    tier: r => r.customer_tier || '', rep: r => r.created_by_name || '', part: r => r.part_number || '',
    qty: r => Number(r.qty || 0), rec: r => (r.recommended_price === null ? null : Number(r.recommended_price)),
    quoted: r => Number(r.unit_price || 0), delta: r => (r.delta_unit === null ? null : Number(r.delta_unit)),
    pct: r => (r.delta_pct === null ? null : Number(r.delta_pct)), kind: r => r.deviation_kind || '',
  }), [])
  const { sorted, sort, toggle } = useSortedRows(shownRows, cols)

  return (
    <div className="space-y-4">
      {openQuote && <QuotePanel quoteId={openQuote} onClose={() => setOpenQuote(null)} />}

      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-white font-semibold flex items-center gap-2 mr-auto"><Scale size={16} className="text-skynet-accent" /> Quote lines priced away from the book</h2>
        <label className="text-[11px] uppercase tracking-wide text-gray-500">Issued</label>
        <input type="date" value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono outline-none" />
        <span className="text-gray-600 text-xs">to</span>
        <input type="date" value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono outline-none" />
        <button onClick={() => setRange({ from: daysAgo(30), to: todayIso() })} className="text-xs text-gray-400 hover:text-white">last 30 days</button>
        <select value={rep} onChange={e => setRep(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs outline-none">
          <option value="all">Every rep</option>
          {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <select value={kind} onChange={e => setKind(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs outline-none">
          <option value="all">Every kind</option>
          {DEVIATION_KINDS.map(k => <option key={k} value={k}>{DEVIATION_KIND_LABELS[k]}</option>)}
        </select>
      </div>

      {err && <div className="flex items-center gap-2 text-sm text-rose-300 bg-rose-950/40 border border-rose-900 rounded px-3 py-2"><AlertTriangle size={14} /> {err}</div>}

      <div className="bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-3 flex flex-wrap gap-x-10 gap-y-2">
        <div><div className="text-xl font-semibold text-white font-mono">{num(summary.lines)}</div><div className="text-xs text-gray-500">line{summary.lines === 1 ? '' : 's'} on {num(summary.quotes)} quote{summary.quotes === 1 ? '' : 's'}</div></div>
        <div><div className="text-xl font-semibold text-rose-300 font-mono">{money(summary.below, 0)}</div><div className="text-xs text-gray-500">below recommendation</div></div>
        {summary.above > 0 && <div><div className="text-xl font-semibold text-emerald-300 font-mono">{money(summary.above, 0)}</div><div className="text-xs text-gray-500">above recommendation</div></div>}
        <div><div className="text-xl font-semibold text-white font-mono">{num(summary.manual)}</div><div className="text-xs text-gray-500">manual price{summary.manual === 1 ? '' : 's'}</div></div>
      </div>

      {rows === null ? <div className="p-8 text-center"><Loader2 size={22} className="animate-spin text-gray-500 mx-auto" /></div> : (
        <div className="overflow-auto rounded-xl border border-gray-700 max-h-[65vh]">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-800 sticky top-0"><tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
              <SortableTh col="issued" label="Issued" sort={sort} onToggle={toggle} />
              <SortableTh col="quote" label="Quote" sort={sort} onToggle={toggle} />
              <SortableTh col="customer" label="Customer" sort={sort} onToggle={toggle} />
              <SortableTh col="tier" label="Tier" sort={sort} onToggle={toggle} />
              <SortableTh col="rep" label="Rep" sort={sort} onToggle={toggle} />
              <SortableTh col="part" label="Part" sort={sort} onToggle={toggle} />
              <SortableTh col="qty" label="Qty" sort={sort} onToggle={toggle} className="text-right" />
              <SortableTh col="rec" label="Recommended" sort={sort} onToggle={toggle} className="text-right" />
              <SortableTh col="quoted" label="Quoted" sort={sort} onToggle={toggle} className="text-right" />
              <SortableTh col="delta" label="Δ unit" sort={sort} onToggle={toggle} className="text-right" />
              <SortableTh col="pct" label="Δ %" sort={sort} onToggle={toggle} className="text-right" />
              <SortableTh col="kind" label="Kind" sort={sort} onToggle={toggle} />
              <th className="px-3 py-2">Reason</th>
            </tr></thead>
            <tbody>
              {sorted.length === 0 && <tr><td colSpan={13} className="px-3 py-6 text-center text-gray-500">No quote line in this range left the recommendation.</td></tr>}
              {sorted.map(r => {
                const d = r.delta_unit === null ? null : Number(r.delta_unit)
                return (
                  <tr key={r.line_id} onClick={() => setOpenQuote(r.quote_id)} className="border-t border-gray-800 hover:bg-gray-800/60 cursor-pointer">
                    <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{r.issued_on}</td>
                    <td className="px-3 py-1.5 font-mono text-white whitespace-nowrap">{r.quote_number}</td>
                    <td className="px-3 py-1.5 text-gray-300 truncate max-w-[200px]" title={r.customer_name || ''}>{r.customer_name}</td>
                    <td className="px-3 py-1.5"><TierBadge tier={r.customer_tier} /></td>
                    <td className="px-3 py-1.5 text-gray-400 truncate max-w-[140px]">{r.created_by_name || ''}</td>
                    <td className="px-3 py-1.5 font-mono text-gray-200 whitespace-nowrap">{r.part_number}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-300">{num(r.qty)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-400 whitespace-nowrap">{r.recommended_price === null ? '—' : money(r.recommended_price, 3)}<span className="text-gray-600 text-xs"> {r.recommended_col || ''}</span></td>
                    <td className="px-3 py-1.5 text-right font-mono text-white whitespace-nowrap">{money(r.unit_price, 3)}<span className="text-gray-600 text-xs"> {r.col_key || ''}</span></td>
                    <td className={`px-3 py-1.5 text-right font-mono ${d === null ? 'text-gray-600' : d < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{d === null ? '' : `${d > 0 ? '+' : ''}${money(d, 3)}`}</td>
                    <td className={`px-3 py-1.5 text-right font-mono text-xs ${r.delta_pct === null ? 'text-gray-600' : Number(r.delta_pct) < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>{r.delta_pct === null ? '' : `${Number(r.delta_pct) > 0 ? '+' : ''}${Number(r.delta_pct).toFixed(1)}%`}</td>
                    <td className="px-3 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[10px] ${DEVIATION_KIND_COLORS[r.deviation_kind] || 'bg-gray-700 text-gray-300'}`}>{DEVIATION_KIND_LABELS[r.deviation_kind] || r.deviation_kind}</span></td>
                    <td className="px-3 py-1.5 text-xs text-gray-500 truncate max-w-[220px]" title={r.note || ''}>{r.note || ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="text-[11px] text-gray-600">
        A line appears here when it was quoted at a different column, at a manual price, at a customer special, or simply at a price that is not the recommendation. The classification is the database view&apos;s, not this screen&apos;s. Nothing here writes — click a row to read the quote.
      </div>
    </div>
  )
}
