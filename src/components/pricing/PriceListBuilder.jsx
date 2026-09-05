//
// Price List builder (S11 C1, D-PRICE-21/29). Opens from a customer card, pre-filled
// with everything they have bought (pricing_customer_sheet) at the price the book
// gives them on the chosen date. Reps may add parts, drop rows and change prices;
// a changed price is recorded as a customer-part special when "record specials"
// is on (default), so Quote Builder and the next list honour it. Save issues a
// PL-YYMM-NNNN number; PDF / XLSX are generated from the saved rows.
//
import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, Plus, Trash2, FileDown, FileSpreadsheet, Save, Calendar, AlertTriangle, Check } from 'lucide-react'
import { loadCustomerSheet, savePriceList, loadPriceList, getPrice, money, num, round2, todayIso, TIER_LABELS } from '../../lib/pricing'
import { buildPriceListPdf, buildPriceListXlsx, downloadBytes, priceListFilename } from '../../lib/priceListDoc'
import { PartTypeahead, TierBadge } from './PricingTypeaheads'

const OCT1 = '2026-10-01'

export default function PriceListBuilder({ customer, book, nextBook, profile, onClose, onSaved }) {
  const [asOf, setAsOf] = useState(todayIso())
  const [rows, setRows] = useState(null)
  const [notes, setNotes] = useState('')
  const [recordSpecials, setRecordSpecials] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(null)      // { id, list_number, specials_recorded, list, lines }
  const [revLabel, setRevLabel] = useState(book?.rev_label || '')

  // Load the customer's purchased parts at the as-of date.
  useEffect(() => {
    let cancelled = false
    setRows(null); setError(null)
    loadCustomerSheet(customer.fb_customer_id, asOf, 'purchased')
      .then(data => {
        if (cancelled) return
        setRows(data.map((r, i) => ({
          key: `${r.part_number}-${i}`, part_number: r.part_number, description: r.description || '', dfar: !!r.dfar,
          each_price: null,                                                     // filled below (list price on the date)
          recommended_price: r.unit_price, customer_price: r.unit_price, basis: r.basis, col_key: r.col_key,
          last_paid: r.last_paid, last_bought: r.last_bought, item_status: r.item_status, section: r.section_name,
        })))
      })
      .catch(e => { if (!cancelled) setError(e.message || String(e)) })
    return () => { cancelled = true }
  }, [customer.fb_customer_id, asOf])

  // Each (list) per row and the rev label for the date, via the RPC with no customer.
  useEffect(() => {
    if (!rows || rows.some(r => r.each_price !== null)) return
    let cancelled = false
    Promise.all(rows.map(r => getPrice(r.part_number, null, 1, asOf).then(p => p).catch(() => null))).then(ps => {
      if (cancelled) return
      setRows(rs => rs.map((r, i) => ({ ...r, each_price: ps[i]?.unit_price_2dp ?? null })))
      const rl = ps.find(p => p?.rev_label)?.rev_label; if (rl) setRevLabel(rl)
    })
    return () => { cancelled = true }
  }, [rows, asOf])

  const setPrice = (key, v) => setRows(rs => rs.map(r => r.key === key ? { ...r, customer_price: v } : r))
  const removeRow = (key) => setRows(rs => rs.filter(r => r.key !== key))
  const addPart = async (pick) => {
    if (!pick || rows?.some(r => r.part_number.toUpperCase() === pick.part_number.toUpperCase())) return
    const p = await getPrice(pick.part_number, customer.fb_customer_id, 1, asOf).catch(() => null)
    const e = await getPrice(pick.part_number, null, 1, asOf).catch(() => null)
    if (!p || p.unit_price_2dp === null) { setError(`${pick.part_number}: ${p?.reason || 'no pricing available'}`); return }
    setRows(rs => [...(rs || []), { key: `${pick.part_number}-${Date.now()}`, part_number: pick.part_number, description: pick.description || '', dfar: !!pick.dfar,
      each_price: e?.unit_price_2dp ?? null, recommended_price: p.unit_price_2dp, customer_price: p.unit_price_2dp, basis: p.basis, col_key: p.col_key, last_paid: null, added: true }])
  }

  const overrides = useMemo(() => (rows || []).filter(r => Number(r.customer_price) !== Number(r.recommended_price)).length, [rows])

  const save = async () => {
    if (!rows?.length) { setError('Add at least one part'); return }
    const bad = rows.find(r => !(Number(r.customer_price) > 0))
    if (bad) { setError(`${bad.part_number}: price must be greater than zero`); return }
    setBusy(true); setError(null)
    try {
      const payload = {
        fb_customer_id: customer.fb_customer_id, customer_name: customer.name_clean, customer_number: customer.customer_number, tier: customer.tier,
        book_id: book?.id, rev_label: revLabel, as_of: asOf, record_specials: recordSpecials, notes: notes || null,
        lines: rows.map(r => ({ part_number: r.part_number, description: r.description, dfar: r.dfar, each_price: r.each_price, customer_price: round2(r.customer_price),
          recommended_price: r.recommended_price, basis: r.basis, col_key: r.col_key, is_override: Number(r.customer_price) !== Number(r.recommended_price), last_paid: r.last_paid })),
      }
      const res = await savePriceList(payload)
      const full = await loadPriceList(res.id)
      setSaved({ ...res, ...full })
      onSaved?.(res)
    } catch (e) { setError(e.message || String(e)) } finally { setBusy(false) }
  }
  const dl = async (kind) => {
    if (!saved) return
    if (kind === 'pdf') downloadBytes(await buildPriceListPdf(saved.list, saved.lines), priceListFilename(saved.list, 'pdf'), 'application/pdf')
    else downloadBytes(buildPriceListXlsx(saved.list, saved.lines), priceListFilename(saved.list, 'xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/70 flex items-start justify-center overflow-auto p-4 md:p-8">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-6xl shadow-2xl">
        <div className="px-5 py-4 border-b border-gray-700 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-white font-semibold">Price list · {customer.name_clean} <TierBadge tier={customer.tier} /></div>
            <div className="text-xs text-gray-500">{saved ? <span className="text-emerald-300">Saved as {saved.list_number}{saved.specials_recorded ? ` · ${saved.specials_recorded} special price${saved.specials_recorded === 1 ? '' : 's'} recorded` : ''}</span> : 'Their purchased parts at their pricing level. Change a price or add parts, then Save to issue a numbered list.'}</div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={20} /></button>
        </div>

        {!saved && (
          <div className="px-5 py-3 border-b border-gray-800 flex flex-wrap items-center gap-3 text-sm">
            <label className="text-xs uppercase tracking-wide text-gray-500">Effective</label>
            <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3"><Calendar size={14} className="text-gray-500" /><input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} className="bg-transparent py-1.5 text-sm font-mono outline-none" /></div>
            <button onClick={() => setAsOf(todayIso())} className="px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-white text-xs">Today</button>
            {nextBook && <button onClick={() => setAsOf(nextBook.effective_from)} className={`px-2 py-1 rounded border text-xs ${asOf === nextBook.effective_from ? 'border-skynet-accent text-skynet-accent' : 'border-gray-700 text-gray-400 hover:text-white'}`}>{nextBook.effective_from === OCT1 ? 'Oct 1' : nextBook.effective_from} · {nextBook.rev_label}</button>}
            <span className="text-xs text-gray-500 ml-2">{revLabel}</span>
            <label className="ml-auto flex items-center gap-2 text-xs text-gray-300 cursor-pointer"><input type="checkbox" checked={recordSpecials} onChange={e => setRecordSpecials(e.target.checked)} /> Record changed prices as customer specials</label>
          </div>
        )}

        <div className="px-5 py-3">
          {error && <div className="mb-3 flex items-center gap-2 text-sm text-rose-300 bg-rose-950/40 border border-rose-900 rounded px-3 py-2"><AlertTriangle size={14} /> {error}</div>}
          {rows === null ? <div className="p-10 text-center"><Loader2 size={22} className="animate-spin text-gray-500 mx-auto" /></div> : (
            <div className="overflow-auto rounded-xl border border-gray-700 max-h-[55vh]">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-800 sticky top-0"><tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
                  <th className="px-3 py-2">Part</th><th className="px-3 py-2">Description</th><th className="px-2 py-2 text-center">DFAR</th>
                  <th className="px-3 py-2 text-right">Last paid</th><th className="px-3 py-2 text-right">Each (list)</th><th className="px-3 py-2 text-right">Book price</th><th className="px-3 py-2 text-right">Your price</th><th className="px-2 py-2"></th>
                </tr></thead>
                <tbody>
                  {(saved ? saved.lines : rows).map(r => {
                    const price = saved ? r.customer_price : r.customer_price
                    const rec = saved ? r.recommended_price : r.recommended_price
                    const changed = Number(price) !== Number(rec)
                    return (
                      <tr key={r.key || r.id} className="border-t border-gray-800">
                        <td className="px-3 py-1.5 font-mono text-white whitespace-nowrap">{r.part_number}{r.added && <span className="ml-2 text-[10px] text-sky-300">added</span>}</td>
                        <td className="px-3 py-1.5 text-gray-300 max-w-md truncate" title={r.description}>{r.description}</td>
                        <td className="px-2 py-1.5 text-center text-xs">{r.dfar ? <span className="text-emerald-300">Y</span> : <span className="text-gray-600">N</span>}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-400">{r.last_paid ? money(r.last_paid, 3) : '—'}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-400">{r.each_price === null || r.each_price === undefined ? '…' : money(r.each_price)}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-300">{money(rec)}<span className="text-[10px] text-gray-600 ml-1">{r.col_key}</span></td>
                        <td className="px-3 py-1.5 text-right">
                          {saved ? <span className={`font-mono ${changed ? 'text-amber-300' : 'text-white'}`}>{money(price)}</span>
                                 : <input type="number" step="0.01" min="0" value={price} onChange={e => setPrice(r.key, e.target.value)} className={`w-24 text-right bg-gray-800 border rounded px-2 py-1 font-mono outline-none ${changed ? 'border-amber-500 text-amber-200' : 'border-gray-700 text-white'}`} />}
                        </td>
                        <td className="px-2 py-1.5 text-right">{!saved && <button onClick={() => removeRow(r.key)} className="text-gray-500 hover:text-rose-300"><Trash2 size={14} /></button>}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!saved && rows !== null && (
            <div className="mt-3 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-start">
              <div><div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1 flex items-center gap-1"><Plus size={12} /> Add a part</div><PartTypeahead bookId={book?.id} onPick={addPart} placeholder="Part number or description…" /></div>
              <div className="text-xs text-gray-500 pt-5">{num(rows.length)} part{rows.length === 1 ? '' : 's'}{overrides ? <span className="text-amber-300"> · {overrides} changed price{overrides === 1 ? '' : 's'}</span> : ''}</div>
            </div>
          )}
          {!saved && <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes printed under the header (optional)" rows={2} className="mt-3 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm outline-none" />}
        </div>

        <div className="px-5 py-4 border-t border-gray-700 flex items-center justify-between gap-3">
          <div className="text-xs text-gray-500">{saved ? `Issued ${String(saved.list.created_at).slice(0, 10)} by ${saved.list.created_by_name || profile?.full_name || ''} · ${TIER_LABELS[saved.list.tier] || 'list'} · effective ${saved.list.as_of}` : recordSpecials ? 'Changed prices become customer specials the moment you save.' : 'Changed prices stay on this document only.'}</div>
          <div className="flex items-center gap-2">
            {saved ? (
              <>
                <button onClick={() => dl('pdf')} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-skynet-accent text-gray-900 font-medium text-sm"><FileDown size={16} /> PDF</button>
                <button onClick={() => dl('xlsx')} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-600 text-gray-200 text-sm hover:text-white"><FileSpreadsheet size={16} /> Excel</button>
                <button onClick={onClose} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-600 text-gray-200 text-sm hover:text-white"><Check size={16} /> Done</button>
              </>
            ) : (
              <>
                <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
                <button onClick={save} disabled={busy || !rows?.length} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-skynet-accent text-gray-900 font-medium text-sm disabled:opacity-50">{busy ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save &amp; issue</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
