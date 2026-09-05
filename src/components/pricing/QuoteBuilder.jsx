//
// Pricing Portal — Quote Builder (B.1; was Lookup). Part + customer + qty + as-of →
// the authoritative price from pricing_get_price, shown as the RECOMMENDED column.
// The rep may pick any column chip instead (D-PRICE: override recorded, no reason
// required), then Add to Quote. The draft lives in the browser until Batch C
// gives quotes a table, a number and a PDF; its line shape already matches.
//
import { useEffect, useMemo, useState } from 'react'
import { Loader2, Calendar, Hash, Info, AlertTriangle, Plus, Trash2, FileText, Users, Star, Save, FileDown, RotateCcw, Check, XCircle } from 'lucide-react'
import {
  getPrice, loadKitComponents, loadItemsByKeys, loadPartHistory, loadPartCustomers, loadPartImages, partKey, columnPrice, itemColumns, money, num, round2,
  loadDraft, saveDraft, draftTotals, BASIS_LABELS, TIER_LABELS,
  saveQuote, loadQuotes, loadQuote, setQuoteStatus, quoteIsExpired, QUOTE_STATUS_LABELS,
} from '../../lib/pricing'
import { buildQuotePdf, quoteFilename } from '../../lib/quoteDoc'
import { downloadBytes } from '../../lib/priceListDoc'
import { FB_SO_STATUS, FB_LINE_STATUS } from '../../lib/fishbowl'
import { PartTypeahead, CustomerTypeahead, TierBadge } from './PricingTypeaheads'
import ImageLightbox from './ImageLightbox'

const OCT1 = '2026-10-01'

function StatusPill({ soStatus, lineStatus }) {
  const label = FB_LINE_STATUS[lineStatus] || FB_SO_STATUS[soStatus] || '—'
  const good = [50, 60].includes(Number(lineStatus)) || [60, 70].includes(Number(soStatus))
  const bad = [70, 75].includes(Number(lineStatus)) || [80, 85, 90].includes(Number(soStatus))
  return <span className={`px-1.5 py-0.5 rounded text-[10px] ${good ? 'bg-green-900/40 text-green-300' : bad ? 'bg-red-900/40 text-red-300' : 'bg-gray-700 text-gray-300'}`}>{label}</span>
}

export default function QuoteBuilder({ book, meta, asOf, setAsOf, todayIso: today, nextBook, canEdit, profile }) {
  const uid = profile?.id
  const [part, setPart] = useState(null)
  const [customer, setCustomer] = useState(null)
  const [qty, setQty] = useState(1)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [components, setComponents] = useState([])
  const [compItems, setCompItems] = useState({})
  const [history, setHistory] = useState([])
  const [buyers, setBuyers] = useState([])
  const [chosen, setChosen] = useState(null)          // col key the rep picked; null = follow the recommendation
  const [draft, setDraft] = useState(() => loadDraft(uid))
  const [flash, setFlash] = useState(null)
  const [image, setImage] = useState(null)
  const [zoom, setZoom] = useState(false)
  const [quotes, setQuotes] = useState([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [justSaved, setJustSaved] = useState(null)   // { id, quote_number }
  const reloadQuotes = () => loadQuotes({ limit: 12 }).then(setQuotes).catch(() => {})
  useEffect(() => { reloadQuotes() }, [])

  useEffect(() => { setDraft(loadDraft(uid)) }, [uid])
  useEffect(() => { saveDraft(uid, draft) }, [uid, draft])

  // Authoritative price.
  useEffect(() => {
    if (!part) { setResult(null); return }
    let cancelled = false
    setBusy(true); setError(null); setChosen(null)
    getPrice(part.part_number, customer?.fb_customer_id ?? null, Number(qty) || 1, asOf)
      .then(r => { if (!cancelled) setResult(r) })
      .catch(err => { if (!cancelled) setError(err.message || String(err)) })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [part, customer, qty, asOf])

  // Components (sets), this customer's last lines, who buys this part.
  useEffect(() => {
    let cancelled = false
    setComponents([]); setCompItems({}); setHistory([]); setBuyers([]); setImage(null)
    if (!part) return
    loadPartImages([partKey(part.part_number), part.range_of ? partKey(part.range_of) : null]).then(m => { if (!cancelled) setImage((m[partKey(part.part_number)] || (part.range_of ? m[partKey(part.range_of)] : null))?.src || null) }).catch(() => {})
    if (part.kind === 'item' && part.status === 'component_sum' && book?.id) {
      loadKitComponents(part.id).then(async cs => {
        if (cancelled) return
        setComponents(cs)
        const items = await loadItemsByKeys(book.id, cs.map(c => c.component_key))
        if (!cancelled) setCompItems(Object.fromEntries(items.map(i => [i.part_key, i])))
      }).catch(() => {})
    }
    if (customer) loadPartHistory(customer.fb_customer_id, part.part_number).then(h => { if (!cancelled) setHistory(h) }).catch(() => {})
    loadPartCustomers(part.part_number, 8).then(b => { if (!cancelled) setBuyers(b) }).catch(() => {})
    return () => { cancelled = true }
  }, [part, customer, book?.id])

  // Every column, client mirror (sets resolved from the fetched components).
  const ladderRows = useMemo(() => {
    if (!part || part.kind !== 'item' || !meta) return []
    const ladder = meta.ladders[part.ladder_code]
    const item = { ...part, _components: components }
    return itemColumns(item, ladder).map(c => ({ ...c, price: columnPrice(item, c.key, meta, book, k => compItems[k] || null) }))
  }, [part, meta, book, components, compItems])

  const recommendedCol = result?.col_key === 'exception' ? 'exception' : result?.col_key || null
  const recommendedPrice = result?.unit_price_2dp ?? null
  const chosenRow = chosen ? ladderRows.find(r => r.key === chosen) : null
  const unitPrice = chosenRow ? round2(chosenRow.price) : recommendedPrice
  const isOverride = !!chosen && chosen !== recommendedCol
  const tier = result?.tier || customer?.tier || 'none'

  const addToQuote = () => {
    if (!part || unitPrice === null) return
    const line = {
      key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      part_number: part.part_number, description: part.description || part.fb_description || '',
      qty: Number(qty) || 1, col_key: chosen || recommendedCol, unit_price: unitPrice,
      recommended_col: recommendedCol, recommended_price: recommendedPrice, basis: result?.basis, is_override: isOverride,
      dfar: !!part.dfar,
    }
    setDraft(d => {
      const sameCustomer = d && ((d.customer?.fb_customer_id ?? null) === (customer?.fb_customer_id ?? null))
      const base = sameCustomer ? d : { customer: customer ? { fb_customer_id: customer.fb_customer_id, name_clean: customer.name_clean, customer_number: customer.customer_number, tier: customer.tier } : null, as_of: asOf, rev_label: result?.rev_label, lines: [] }
      return { ...base, as_of: asOf, rev_label: result?.rev_label || base.rev_label, lines: [...base.lines, line] }
    })
    setFlash(`${part.part_number} × ${num(qty)} added`); setTimeout(() => setFlash(null), 1800)
  }
  const setHead = (k, v) => setDraft(d => ({ ...(d || { lines: [] }), head: { ...(d?.head || {}), [k]: v } }))
  const saveTheQuote = async () => {
    if (!draft?.lines?.length) return
    setSaving(true); setSaveError(null)
    try {
      const head = draft.head || {}
      const res = await saveQuote({
        fb_customer_id: draft.customer?.fb_customer_id ?? null, customer_name: draft.customer?.name_clean || head.walkin_name || 'Walk-in',
        customer_number: draft.customer?.customer_number || null, tier: draft.customer?.tier || 'none',
        contact_name: head.contact_name || null, contact_email: head.contact_email || null, customer_po: head.customer_po || null,
        book_id: book?.id || null, rev_label: draft.rev_label || book?.rev_label || null, as_of: draft.as_of || asOf,
        payment_terms: head.payment_terms || null, notes: head.notes || null, supersedes: draft.supersedes || null,
        lines: draft.lines.map(l => ({ part_number: l.part_number, description: l.description, dfar: !!l.dfar, qty: l.qty, unit_price: l.unit_price,
          col_key: l.col_key, recommended_col: l.recommended_col, recommended_price: l.recommended_price, basis: l.basis, is_override: !!l.is_override })),
      })
      // The quote is saved and numbered at this point: clear the draft first so a PDF
      // hiccup can never lead to a second Save (and a second number) for the same quote.
      setJustSaved({ id: res.id, quote_number: res.quote_number, valid_until: res.valid_until })
      setDraft(null); reloadQuotes()
      try {
        const { quote, lines } = await loadQuote(res.id)
        downloadBytes(await buildQuotePdf(quote, lines), quoteFilename(quote), 'application/pdf')
      } catch (e) { setSaveError(`${res.quote_number} is saved, but the PDF failed to render: ${e.message || e}. Use PDF on the quote below to try again.`) }
    } catch (e) { setSaveError(e.message || String(e)) } finally { setSaving(false) }
  }
  const reopenQuote = async (q) => {
    const { quote, lines } = await loadQuote(q.id)
    setDraft({
      customer: quote.fb_customer_id ? { fb_customer_id: quote.fb_customer_id, name_clean: quote.customer_name, customer_number: quote.customer_number, tier: quote.tier } : null,
      as_of: asOf, rev_label: book?.rev_label, supersedes: quote.status === 'issued' ? quote.id : null,
      head: { contact_name: quote.contact_name, contact_email: quote.contact_email, customer_po: quote.customer_po, payment_terms: quote.payment_terms, notes: quote.notes, walkin_name: quote.fb_customer_id ? null : quote.customer_name },
      lines: lines.map(l => ({ key: `${Date.now()}-${l.id}`, part_number: l.part_number, description: l.description, qty: Number(l.qty), col_key: l.col_key, unit_price: Number(l.unit_price),
        recommended_col: l.recommended_col, recommended_price: l.recommended_price === null ? null : Number(l.recommended_price), basis: l.basis, is_override: l.is_override, dfar: l.dfar })),
    })
    setJustSaved(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const dlQuote = async (q) => { const { quote, lines } = await loadQuote(q.id); downloadBytes(await buildQuotePdf(quote, lines), quoteFilename(quote), 'application/pdf') }
  const markQuote = async (q, status) => {
    let so = null
    if (status === 'won') { so = prompt('Fishbowl SO number (optional):') ; if (so === null) return }
    await setQuoteStatus(q.id, status, so || null, null); reloadQuotes()
  }
  const draftMismatch = draft && draft.lines?.length > 0 && (draft.customer?.fb_customer_id ?? null) !== (customer?.fb_customer_id ?? null)
  const totals = draftTotals(draft)

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
      {/* Inputs */}
      <div className="xl:col-span-3 space-y-4">
        <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4 space-y-3">
          <label className="block text-xs uppercase tracking-wide text-gray-500">Customer <span className="normal-case text-gray-600">(blank = walk-in / list)</span></label>
          <CustomerTypeahead value={customer?.name_clean} onPick={setCustomer} onClear={() => setCustomer(null)} />
          <label className="block text-xs uppercase tracking-wide text-gray-500 pt-2">Part</label>
          <PartTypeahead bookId={book?.id} value={part?.part_number} onPick={setPart} onClear={() => setPart(null)} autoFocus />
          <div className="grid grid-cols-2 gap-3 pt-2">
            <div>
              <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Quantity</label>
              <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3"><Hash size={14} className="text-gray-500" />
                <input type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} className="w-full bg-transparent py-2 text-sm font-mono outline-none" /></div>
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">As of</label>
              <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3"><Calendar size={14} className="text-gray-500" />
                <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} className="w-full bg-transparent py-2 text-sm font-mono outline-none" /></div>
            </div>
          </div>
          <div className="flex gap-2 text-xs">
            <button onClick={() => setAsOf(today)} className={`px-2 py-1 rounded border ${asOf === today ? 'border-skynet-accent text-skynet-accent' : 'border-gray-700 text-gray-400 hover:text-white'}`}>Today</button>
            {nextBook && <button onClick={() => setAsOf(nextBook.effective_from)} className={`px-2 py-1 rounded border ${asOf === nextBook.effective_from ? 'border-skynet-accent text-skynet-accent' : 'border-gray-700 text-gray-400 hover:text-white'}`}>{nextBook.effective_from === OCT1 ? 'Oct 1' : nextBook.effective_from} · {nextBook.rev_label}</button>}
          </div>
        </div>

        {customer && (
          <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-white truncate">{customer.name_clean}</div>
                <div className="text-xs text-gray-500 font-mono">#{customer.customer_number || customer.fb_customer_id}{customer.salesman ? ` · ${customer.salesman}` : ''}</div>
              </div>
              <TierBadge tier={customer.tier} size="lg" />
            </div>
            {part && (
              <div className="mt-3">
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Their last {history.length || ''} sales-order lines of {part.part_number}</div>
                {history.length === 0 ? <div className="text-xs text-gray-600">No Fishbowl history for this part.</div> : (
                  <table className="w-full text-xs">
                    <thead><tr className="text-[10px] uppercase text-gray-500"><th className="text-left py-1">SO #</th><th className="text-left py-1">Ordered</th><th className="text-right py-1">Shipped</th><th className="text-right py-1">Unit price</th><th className="text-right py-1">Status</th></tr></thead>
                    <tbody>
                      {history.map((h, i) => (
                        <tr key={i} className="border-t border-gray-700/60">
                          <td className="py-1 font-mono text-gray-300">{h.so_number}</td>
                          <td className="py-1 text-gray-400">{String(h.fb_date_created || '').slice(0, 10)}</td>
                          <td className="py-1 text-right font-mono text-gray-300">{num(h.qty_fulfilled ?? 0)}<span className="text-gray-600">/{num(h.qty_ordered)}</span></td>
                          <td className="py-1 text-right font-mono text-white">{money(h.unit_price, 4)}</td>
                          <td className="py-1 text-right"><StatusPill soStatus={h.so_status_id} lineStatus={h.line_status_id} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Result */}
      <div className="xl:col-span-6 space-y-4">
        {!part && (
          <div className="bg-gray-800/40 border border-dashed border-gray-700 rounded-xl p-10 text-center text-gray-500">
            <Info size={28} className="mx-auto mb-3 text-gray-600" />
            Pick a customer (optional) and a part. The book's recommendation is highlighted; pick any other column to quote it instead, then Add to Quote.
          </div>
        )}
        {part && (
          <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-5">
            <div className="flex items-start justify-between gap-4">
              {image && <button onClick={() => setZoom(true)} title="Enlarge" className="shrink-0"><img src={image} alt="" className="w-24 h-24 object-contain rounded-lg bg-white/90 hover:ring-2 hover:ring-skynet-accent" /></button>}
              {zoom && image && <ImageLightbox images={[{ src: image, caption: part.part_number }]} index={0} onClose={() => setZoom(false)} />}
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xl text-white">{part.part_number}</div>
                <div className="text-sm text-gray-400">{part.description || part.fb_description || ''}</div>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
                  {part.kind === 'item' && part.rule_code && <span className="px-2 py-0.5 rounded bg-gray-700 text-gray-300">Rule {part.rule_code}</span>}
                  {part.kind === 'item' && <span className="px-2 py-0.5 rounded bg-gray-700 text-gray-300">{part.ladder_code}</span>}
                  {part.kind === 'item' && part.dfar && <span className="px-2 py-0.5 rounded bg-emerald-900 text-emerald-200">DFAR</span>}
                  {part.kind === 'item' && part.has_premier && <span className="px-2 py-0.5 rounded bg-amber-900 text-amber-200">Premier column</span>}
                  {part.kind === 'item' && part.range_of && <span className="px-2 py-0.5 rounded bg-gray-700 text-gray-400">from range "{part.range_of}"</span>}
                  {part.kind === 'product' && <span className="px-2 py-0.5 rounded bg-rose-900 text-rose-200">Not in the price book</span>}
                </div>
                {(part.xref_arconic || part.xref_lisi || part.nsn || part.cessna) && (
                  <div className="mt-2 text-xs text-gray-500 space-x-3">
                    {part.xref_arconic && <span>Arconic {part.xref_arconic}</span>}{part.xref_lisi && <span>LISI {part.xref_lisi}</span>}{part.nsn && <span>NSN {part.nsn}</span>}{part.cessna && <span>Cessna {part.cessna}</span>}
                  </div>
                )}
              </div>
              <div className="text-right shrink-0">
                {busy && <Loader2 size={22} className="animate-spin text-gray-500 ml-auto" />}
                {!busy && result && recommendedPrice !== null && (
                  <>
                    <div className="text-3xl font-semibold text-white font-mono">{money(unitPrice)}</div>
                    {isOverride
                      ? <div className="text-xs text-amber-300 mt-1">Override · {chosenRow?.label}{chosenRow?.kind === 'qty' ? '+' : ''} — recommended {money(recommendedPrice)} ({BASIS_LABELS[result.basis] || result.basis})</div>
                      : <div className="text-xs text-gray-400 mt-1"><Star size={11} className="inline -mt-0.5 text-skynet-accent" /> Recommended · {BASIS_LABELS[result.basis] || result.basis}{result.col_key && result.col_key !== 'exception' ? ` · ${result.col_key}` : ''}</div>}
                    <div className="text-xs text-gray-500">{TIER_LABELS[tier]} · {result.rev_label}</div>
                    <div className="text-sm text-gray-300 mt-2 font-mono">{num(qty)} × {money(unitPrice)} = <span className="text-white">{money(round2(Number(qty) * Number(unitPrice)))}</span></div>
                    <button onClick={addToQuote} className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-skynet-accent text-gray-900 font-medium text-sm hover:opacity-90">
                      <Plus size={16} /> Add to Quote
                    </button>
                    {flash && <div className="text-xs text-emerald-300 mt-1">{flash}</div>}
                  </>
                )}
                {!busy && result && recommendedPrice === null && <div className="flex items-center gap-2 text-amber-300 text-sm"><AlertTriangle size={16} />{result.reason || 'No pricing available'}</div>}
                {!busy && error && <div className="text-rose-300 text-sm">{error}</div>}
              </div>
            </div>
            {result?.basis === 'exception' && (
              <div className="mt-3 text-xs text-amber-300 bg-amber-950/40 border border-amber-900 rounded px-3 py-2">Customer-specific price for {customer?.name_clean}. Other customers do not get this number.</div>
            )}

            {ladderRows.length > 0 && (
              <div className="mt-5">
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">Every column — click one to quote it instead of the recommendation</div>
                <div className="grid grid-flow-col auto-cols-fr gap-2 overflow-x-auto">
                  {ladderRows.map(c => {
                    const rec = recommendedCol === c.key
                    const sel = chosen ? chosen === c.key : rec
                    return (
                      <button key={c.key} disabled={c.price === null} onClick={() => setChosen(rec ? null : c.key)}
                        className={`text-left rounded-lg border px-3 py-2 min-w-[92px] transition-colors disabled:opacity-40 ${sel ? 'border-skynet-accent bg-skynet-accent/10' : 'border-gray-700 bg-gray-900/40 hover:border-gray-500'}`}>
                        <div className="text-[11px] text-gray-500 flex items-center gap-1">{c.label}{c.kind === 'qty' ? '+' : ''}{rec && <Star size={10} className="text-skynet-accent" />}</div>
                        <div className={`font-mono text-sm ${sel ? 'text-white' : 'text-gray-300'}`}>{c.price === null ? '—' : money(round2(c.price))}</div>
                      </button>
                    )
                  })}
                </div>
                <div className="mt-2 text-[11px] text-gray-600">★ = the book's recommendation for this customer and quantity. 100 / 300 / 500 are quantity breaks for everyone; Tier 1–3 and Premier are customer qualifications and never depend on quantity (D-PRICE-03).</div>
              </div>
            )}

            {components.length > 0 && (
              <div className="mt-4">
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Set components</div>
                <ul className="text-sm font-mono text-gray-300 flex flex-wrap gap-x-4 gap-y-1">{components.map(c => <li key={c.component_key}>{c.component_part_number}{Number(c.qty) !== 1 ? ` ×${c.qty}` : ''}</li>)}</ul>
              </div>
            )}
            {part.kind === 'product' && <div className="mt-4 text-sm text-gray-400">Fishbowl list price {money(part.fb_list_price)}. Not in {book?.rev_label}; it can be added on the Price Books tab{canEdit ? '' : ' by an admin'}.</div>}

            {/* Who buys this part */}
            {buyers.length > 0 && (
              <div className="mt-5">
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1 flex items-center gap-1"><Users size={12} /> Who buys {part.part_number} (since 2023-11-27)</div>
                <table className="w-full text-xs">
                  <thead><tr className="text-[10px] uppercase text-gray-500"><th className="text-left py-1">Customer</th><th className="text-left py-1">Tier</th><th className="text-right py-1">Qty</th><th className="text-right py-1">Revenue</th><th className="text-right py-1">Orders</th><th className="text-right py-1">Last paid</th><th className="text-right py-1">Last</th></tr></thead>
                  <tbody>
                    {buyers.map(b => (
                      <tr key={b.fb_customer_id} className={`border-t border-gray-700/60 ${customer?.fb_customer_id === b.fb_customer_id ? 'bg-skynet-accent/10' : ''}`}>
                        <td className="py-1 text-gray-200 truncate max-w-[220px]">{b.name_clean}</td>
                        <td className="py-1"><TierBadge tier={b.tier} /></td>
                        <td className="py-1 text-right font-mono text-gray-300">{num(b.qty)}</td>
                        <td className="py-1 text-right font-mono text-gray-300">{money(b.revenue, 0)}</td>
                        <td className="py-1 text-right font-mono text-gray-400">{num(b.orders)}</td>
                        <td className="py-1 text-right font-mono text-white">{b.last_paid ? money(b.last_paid, 3) : '—'}</td>
                        <td className="py-1 text-right text-gray-400">{b.last_bought}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Quote draft */}
      <div className="xl:col-span-3">
        <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-white flex items-center gap-2"><FileText size={15} className="text-skynet-accent" /> Quote draft</div>
            {draft?.lines?.length > 0 && <button onClick={() => { if (confirm('Clear the draft?')) setDraft(null) }} className="text-xs text-gray-500 hover:text-rose-300">Clear</button>}
          </div>
          {draft?.customer ? <div className="text-xs text-gray-400 mt-1 truncate">{draft.customer.name_clean} <TierBadge tier={draft.customer.tier} /></div> : draft?.lines?.length > 0 ? <div className="text-xs text-gray-400 mt-1">Walk-in / list</div> : null}
          {draft?.as_of && <div className="text-[11px] text-gray-500">Priced as of {draft.as_of} · {draft.rev_label}</div>}
          {draftMismatch && <div className="mt-2 text-[11px] text-amber-300 bg-amber-950/40 border border-amber-900 rounded px-2 py-1">This draft is for {draft.customer?.name_clean || 'walk-in'}. Adding a line for a different customer starts a new draft.</div>}
          {!draft?.lines?.length && <div className="text-xs text-gray-600 mt-3">No lines yet.</div>}
          {draft?.lines?.length > 0 && (
            <div className="mt-3 space-y-2 max-h-[50vh] overflow-auto">
              {draft.lines.map(l => (
                <div key={l.key} className="border border-gray-700 rounded-lg p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-white">{l.part_number}</span>
                    <button onClick={() => setDraft(d => ({ ...d, lines: d.lines.filter(x => x.key !== l.key) }))} className="text-gray-500 hover:text-rose-300"><Trash2 size={13} /></button>
                  </div>
                  <div className="text-gray-500 truncate">{l.description}</div>
                  <div className="mt-1 flex items-center gap-2">
                    <input type="number" min="1" value={l.qty} onChange={e => setDraft(d => ({ ...d, lines: d.lines.map(x => x.key === l.key ? { ...x, qty: Number(e.target.value) || 1 } : x) }))} className="w-16 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 font-mono outline-none" />
                    <span className="text-gray-400">× {money(l.unit_price)}</span>
                    <span className="ml-auto font-mono text-white">{money(round2(l.qty * l.unit_price))}</span>
                  </div>
                  <div className="mt-1 text-[10px] text-gray-500">{l.col_key}{l.is_override ? <span className="text-amber-300"> · override (rec. {money(l.recommended_price)} {l.recommended_col})</span> : ' · recommended'}{l.dfar ? ' · DFAR' : ''}</div>
                </div>
              ))}
            </div>
          )}
          {draft?.lines?.length > 0 && (
            <div className="mt-3 border-t border-gray-700 pt-2 text-sm flex items-center justify-between">
              <span className="text-gray-400">{totals.lines} line{totals.lines === 1 ? '' : 's'}{totals.overrides ? ` · ${totals.overrides} override${totals.overrides === 1 ? '' : 's'}` : ''}</span>
              <span className="font-mono text-white">{money(totals.subtotal)}</span>
            </div>
          )}
          {draft?.lines?.length > 0 && (
            <div className="mt-3 border-t border-gray-700 pt-3 space-y-2 text-xs">
              {!draft.customer && <input value={draft.head?.walkin_name || ''} onChange={e => setHead('walkin_name', e.target.value)} placeholder="Customer name (walk-in)" className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 outline-none" />}
              <div className="grid grid-cols-2 gap-2">
                <input value={draft.head?.contact_name || ''} onChange={e => setHead('contact_name', e.target.value)} placeholder="Contact" className="bg-gray-800 border border-gray-700 rounded px-2 py-1 outline-none" />
                <input value={draft.head?.contact_email || ''} onChange={e => setHead('contact_email', e.target.value)} placeholder="Email" className="bg-gray-800 border border-gray-700 rounded px-2 py-1 outline-none" />
                <input value={draft.head?.customer_po || ''} onChange={e => setHead('customer_po', e.target.value)} placeholder="Customer PO / RFQ" className="bg-gray-800 border border-gray-700 rounded px-2 py-1 outline-none" />
                <input value={draft.head?.payment_terms || ''} onChange={e => setHead('payment_terms', e.target.value)} placeholder="Payment terms (Per account terms)" className="bg-gray-800 border border-gray-700 rounded px-2 py-1 outline-none" />
              </div>
              <textarea value={draft.head?.notes || ''} onChange={e => setHead('notes', e.target.value)} placeholder="Notes printed on the quote (lead time, etc.)" rows={2} className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 outline-none" />
              {draft.supersedes && <div className="text-[11px] text-amber-300 flex items-center gap-1"><RotateCcw size={11} /> Saving will issue a new number and supersede the reopened quote.</div>}
              {saveError && <div className="text-rose-300">{saveError}</div>}
              <button onClick={saveTheQuote} disabled={saving} className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-skynet-accent text-gray-900 font-medium text-sm disabled:opacity-50">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save quote &amp; download PDF
              </button>
              <div className="text-[11px] text-gray-600">Prices lock for 14 days from today (D-PRICE-23). The PDF is regenerated from the saved quote any time.</div>
            </div>
          )}
          {justSaved && !draft?.lines?.length && (
            <div className="mt-3 text-xs text-emerald-300 bg-emerald-950/40 border border-emerald-900 rounded px-3 py-2 flex items-center gap-2"><Check size={14} /> Saved {justSaved.quote_number} · valid until {justSaved.valid_until}</div>
          )}
        </div>

        {/* Recent quotes */}
        <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4 mt-4">
          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">Recent quotes</div>
          {quotes.length === 0 && <div className="text-xs text-gray-600">None yet.</div>}
          <ul className="space-y-1.5 text-xs">
            {quotes.map(q => {
              const expired = quoteIsExpired(q)
              return (
                <li key={q.id} className="border border-gray-700/70 rounded-lg px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-white">{q.quote_number}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${q.status === 'won' ? 'bg-emerald-900 text-emerald-200' : q.status === 'issued' && !expired ? 'bg-sky-900 text-sky-200' : 'bg-gray-700 text-gray-400'}`}>{expired ? 'Expired' : QUOTE_STATUS_LABELS[q.status] || q.status}</span>
                    <span className="ml-auto font-mono text-gray-300">{money(q.subtotal)}</span>
                  </div>
                  <div className="text-gray-400 truncate">{q.customer_name} · {q.line_count} line{q.line_count === 1 ? '' : 's'} · {q.created_by_name || ''} · {String(q.created_at).slice(0, 10)}{q.fb_so_number ? ` · SO ${q.fb_so_number}` : ''}</div>
                  <div className="mt-1 flex items-center gap-3 text-gray-400">
                    <button onClick={() => dlQuote(q)} className="hover:text-white inline-flex items-center gap-1"><FileDown size={12} /> PDF</button>
                    <button onClick={() => reopenQuote(q)} className="hover:text-white inline-flex items-center gap-1"><RotateCcw size={12} /> Reopen</button>
                    {q.status === 'issued' && <button onClick={() => markQuote(q, 'won')} className="hover:text-emerald-300 inline-flex items-center gap-1"><Check size={12} /> Won</button>}
                    {q.status === 'issued' && <button onClick={() => markQuote(q, 'lost')} className="hover:text-rose-300 inline-flex items-center gap-1"><XCircle size={12} /> Lost</button>}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </div>
  )
}
