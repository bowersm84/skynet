//
// Price List builder (S11 C1, D-PRICE-21/29). Opens from a customer card, pre-filled
// with everything they have bought (pricing_customer_sheet) at the price the book
// gives them on the chosen date. Reps may add parts — one by typeahead, or a whole
// catalog section at once, bought before or not (D-PRICE-57) — drop rows and change
// prices; a changed price is recorded as a customer-part special when "record specials"
// is on (default), so Quote Builder and the next list honour it. Save issues a
// PL-YYMM-NNNN number; PDF / XLSX are generated from the saved rows.
//
import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, Plus, Trash2, FileDown, FileSpreadsheet, Save, Calendar, AlertTriangle, Check, Layers, Search } from 'lucide-react'
import { loadCustomerSheet, savePriceList, loadPriceList, getPrice, loadBooks, bookContext, loadBookSections, loadSectionItems, searchItemSectionCounts, partKey, money, num, round2, todayIso, TIER_LABELS } from '../../lib/pricing'
import { sectionsForSearch } from '../../lib/pricingView'
import { buildPriceListPdf, buildPriceListXlsx, downloadBytes, priceListFilename } from '../../lib/priceListDoc'
import { PartTypeahead, TierBadge, SortableTh } from './PricingTypeaheads'
import { useSortedRows } from './hooks'

// Sort accessors for the builder table (stable module constant — see useSortedRows). Rows keep the
// sorted order when saved, so the PDF / XLSX print in the order the rep arranged on screen (D-PRICE-42).
const BUILDER_COLS = {
  part: r => r.part_number, description: r => r.description || '', last_paid: r => Number(r.last_paid) > 0 ? Number(r.last_paid) : null,
  each: r => r.each_price ?? null, book: r => r.recommended_price ?? null, yours: r => Number(r.customer_price),
}

const OCT1 = '2026-10-01'

export default function PriceListBuilder({ customer, book, nextBook, profile, partKeys, onClose, onSaved }) {
  // partKeys (optional) = product_keys chosen on the customer page; the sheet is narrowed to them.
  // Compared as a joined string so a fresh array from the parent does not reload the sheet.
  // null = no prop at all (show everything they have bought); '' = a prop that selected
  // nothing, which narrows to nothing rather than silently falling back to the full sheet.
  const keySig = partKeys ? partKeys.join('|') : null
  const [asOf, setAsOf] = useState(todayIso())
  const [rows, setRows] = useState(null)
  const [notes, setNotes] = useState('')
  const [recordSpecials, setRecordSpecials] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(null)      // { id, list_number, specials_recorded, list, lines }
  const [revLabel, setRevLabel] = useState(book?.rev_label || '')

  // The book in effect on the as-of date — bookContext over the published books, the rule
  // pricing_book_for_date applies (D-PRICE-56), so a date before `book` took effect reads the
  // superseded book it really prices from. Its sections feed "Add a section" and its items the
  // part typeahead, so what the rep picks from is the book pricing_get_price will price from
  // (D-PRICE-57). Until the books arrive: nextBook once asOf reaches its date, else book.
  const [books, setBooks] = useState(null)
  useEffect(() => {
    let cancelled = false
    loadBooks().then(b => { if (!cancelled) setBooks(b) }).catch(() => { /* keep the book / nextBook fallback */ })
    return () => { cancelled = true }
  }, [])
  const asOfBook = books ? bookContext(books, asOf).current
    : nextBook?.effective_from && asOf >= nextBook.effective_from ? nextBook : book
  const [sections, setSections] = useState([])
  const [secTerm, setSecTerm] = useState('')
  const [secPick, setSecPick] = useState(null)      // { id, name, kind } chosen from asOfBook's sections
  const [secItems, setSecItems] = useState(null)    // price_items of secPick; null while reading
  const [secFilter, setSecFilter] = useState('')
  const [secBusy, setSecBusy] = useState(false)
  const [secProgress, setSecProgress] = useState(null)   // { done, total } while pricing
  const [secNote, setSecNote] = useState(null)           // amber line under the control
  useEffect(() => {
    let cancelled = false
    setSections([]); setSecPick(null); setSecItems(null); setSecTerm(''); setSecFilter(''); setSecNote(null)
    if (!asOfBook?.id) return
    loadBookSections(asOfBook.id).then(s => { if (!cancelled) setSections(s) }).catch(e => { if (!cancelled) setError(e.message || String(e)) })
    return () => { cancelled = true }
  }, [asOfBook?.id])

  // How many rows the sheet load put on the list — the header's "M of the N parts chosen". Kept apart
  // from rows.length so parts the rep adds or drops afterwards do not change what it says (D-PRICE-59).
  const [prefilled, setPrefilled] = useState(null)

  // Load the customer's purchased parts at the as-of date, then the Each (list) price and the rev
  // label for each — via the RPC with no customer — and set rows ONCE (D-PRICE-59). Until then the
  // Each lookup was a second effect keyed on `rows` that set rows again when it finished; nothing in
  // a row told "looked up, nothing found" from "not yet", so on an empty sheet — or one where no Each
  // resolved — it ran on its own result without end and froze the tab (Northeast Aerospace: 5 parts
  // bought, none in the book, 0 sheet rows).
  useEffect(() => {
    let cancelled = false
    setRows(null); setPrefilled(null); setError(null)
    const keySet = keySig === null ? null : new Set(keySig ? keySig.split('|') : [])
    ;(async () => {
      try {
        const data = await loadCustomerSheet(customer.fb_customer_id, asOf, 'purchased')
        const base = data.filter(r => !keySet || keySet.has(partKey(r.part_number)))
        const eaches = await Promise.all(base.map(r => getPrice(r.part_number, null, 1, asOf).catch(() => null)))
        if (cancelled) return
        setRows(base.map((r, i) => ({
          key: `${r.part_number}-${i}`, part_number: r.part_number, description: r.description || '', dfar: !!r.dfar,
          each_price: eaches[i]?.unit_price_2dp ?? null,
          recommended_price: r.unit_price, customer_price: r.unit_price, basis: r.basis, col_key: r.col_key,
          last_paid: r.last_paid, last_bought: r.last_bought, item_status: r.item_status, section: r.section_name,
        })))
        setPrefilled(base.length)
        const rl = eaches.find(p => p?.rev_label)?.rev_label; if (rl) setRevLabel(rl)
      } catch (e) { if (!cancelled) setError(e.message || String(e)) }
    })()
    return () => { cancelled = true }
  }, [customer.fb_customer_id, asOf, keySig])

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

  // ── Add a section (D-PRICE-57) ──────────────────────────────────────────────────
  // Matching-part counts per section for the typed term, exact over asOfBook, debounced like the
  // Catalog search (D-PRICE-61). Kept with its term so a late response cannot label a newer search.
  const [secCounts, setSecCounts] = useState(null)   // { term, bySection }
  useEffect(() => {
    const t = secTerm.trim()
    if (!asOfBook?.id || t.length < 2) { setSecCounts(null); return }
    let cancelled = false
    const h = setTimeout(() => {
      searchItemSectionCounts(asOfBook.id, t)
        .then(c => { if (!cancelled) setSecCounts({ term: t, bySection: c }) })
        .catch(() => { if (!cancelled) setSecCounts({ term: t, bySection: {} }) })
    }, 250)
    return () => { cancelled = true; clearTimeout(h) }
  }, [asOfBook?.id, secTerm])
  const secHits = useMemo(() => sectionsForSearch(sections, secTerm, secCounts?.term === secTerm.trim() ? secCounts.bySection : null, 12), [sections, secTerm, secCounts])
  const pickSection = async (s) => {
    setSecPick(s); setSecTerm(''); setSecFilter(''); setSecNote(null); setSecItems(null)
    try { const { items } = await loadSectionItems(asOfBook.id, s.id); setSecItems(items) }
    catch (e) { setSecNote(e.message || String(e)); setSecPick(null) }
  }
  const clearSection = () => { setSecPick(null); setSecItems(null); setSecFilter(''); setSecNote(null) }
  // What Add would do right now: the section's items under the part filter, less the ones already on
  // the list and the ones the book carries without a price.
  const secPreview = useMemo(() => {
    if (!secItems) return null
    const have = new Set((rows || []).map(r => partKey(r.part_number)))
    const f = partKey(secFilter)
    const shown = secItems.filter(it => !f || it.part_key.includes(f))
    const noPrice = shown.filter(it => it.status === 'no_price').length
    const dup = shown.filter(it => it.status !== 'no_price' && have.has(it.part_key)).length
    return { shown: shown.length, noPrice, dup, todo: shown.length - noPrice - dup }
  }, [secItems, secFilter, rows])
  // Price every part the preview counts, customer and list, through the same RPC pair addPart uses,
  // 8 at a time. A part the RPC cannot price on this date is left out and named, never added at null.
  const addSection = async () => {
    if (!secPick || !secItems || secBusy) return
    const have = new Set((rows || []).map(r => partKey(r.part_number)))
    const f = partKey(secFilter)
    const todo = secItems.filter(it => it.status !== 'no_price' && !have.has(it.part_key) && (!f || it.part_key.includes(f)))
    if (!todo.length) return
    setSecBusy(true); setError(null); setSecNote(null); setSecProgress({ done: 0, total: todo.length })
    const added = [], skipped = []
    try {
      for (let i = 0; i < todo.length; i += 8) {
        const chunk = todo.slice(i, i + 8)
        const priced = await Promise.all(chunk.map(async it => {
          const [p, e] = await Promise.all([
            getPrice(it.part_number, customer.fb_customer_id, 1, asOf).catch(() => null),
            getPrice(it.part_number, null, 1, asOf).catch(() => null),
          ])
          return { it, p, e }
        }))
        for (const { it, p, e } of priced) {
          if (!p || p.unit_price_2dp === null) { skipped.push(it.part_number); continue }
          added.push({ key: `${it.part_number}-${Date.now()}-${added.length}`, part_number: it.part_number, description: it.description || '', dfar: !!it.dfar,
            each_price: e?.unit_price_2dp ?? null, recommended_price: p.unit_price_2dp, customer_price: p.unit_price_2dp, basis: p.basis, col_key: p.col_key,
            last_paid: null, section: secPick.name, added: true })
        }
        setSecProgress({ done: Math.min(todo.length, i + chunk.length), total: todo.length })
      }
      setRows(rs => [...(rs || []), ...added])
      const name = secPick.name
      clearSection()
      setSecNote(`Added ${num(added.length)} part${added.length === 1 ? '' : 's'} from ${name}` + (skipped.length
        ? ` · ${num(skipped.length)} without a price on ${asOf}, not added: ${skipped.slice(0, 6).join(', ')}${skipped.length > 6 ? '…' : ''}` : ''))
    } catch (e) { setError(e.message || String(e)) } finally { setSecBusy(false); setSecProgress(null) }
  }

  const overrides = useMemo(() => (rows || []).filter(r => Number(r.customer_price) !== Number(r.recommended_price)).length, [rows])
  const { sorted: view, sort, toggle } = useSortedRows(rows, BUILDER_COLS)

  const save = async () => {
    if (!rows?.length) { setError('Add at least one part'); return }
    const bad = rows.find(r => !(Number(r.customer_price) > 0))
    if (bad) { setError(`${bad.part_number}: price must be greater than zero`); return }
    setBusy(true); setError(null)
    try {
      const payload = {
        fb_customer_id: customer.fb_customer_id, customer_name: customer.name_clean, customer_number: customer.customer_number, tier: customer.tier,
        book_id: book?.id, rev_label: revLabel, as_of: asOf, record_specials: recordSpecials, notes: notes || null,
        lines: (view || rows).map(r => ({ part_number: r.part_number, description: r.description, dfar: r.dfar, each_price: r.each_price, customer_price: round2(r.customer_price),
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
            <div className="text-xs text-gray-500">{saved ? <span className="text-emerald-300">Saved as {saved.list_number}{saved.specials_recorded ? ` · ${saved.specials_recorded} special price${saved.specials_recorded === 1 ? '' : 's'} recorded` : ''}</span> : 'Their purchased parts at their pricing level. Change a price, add parts or a whole section, then Save to issue a numbered list.'}</div>
            {!saved && partKeys && <div className="text-[11px] text-gray-500 mt-0.5">{!partKeys.length ? 'No purchased parts matched the range or filter on the customer page — add parts below.'
              : prefilled === 0 ? <span className="text-amber-300">None of the {num(partKeys.length)} part{partKeys.length === 1 ? '' : 's'} chosen on the customer page is in {revLabel || 'the price book'} — add parts below.</span>
              : prefilled !== null && prefilled < partKeys.length ? `Pre-filled with ${num(prefilled)} of the ${num(partKeys.length)} parts chosen on the customer page — the rest are not in ${revLabel || 'the price book'}`
              : `Pre-filled with the ${num(partKeys.length)} part${partKeys.length === 1 ? '' : 's'} chosen on the customer page`}</div>}
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
                  {saved ? <><th className="px-3 py-2">Part</th><th className="px-3 py-2">Description</th></> : <><SortableTh col="part" label="Part" sort={sort} onToggle={toggle} /><SortableTh col="description" label="Description" sort={sort} onToggle={toggle} /></>}<th className="px-2 py-2 text-center" title="Shown here for the rep; not printed on the PDF or XLSX">DFAR</th>
                  {saved ? <><th className="px-3 py-2 text-right">Last paid</th><th className="px-3 py-2 text-right">Each (list)</th><th className="px-3 py-2 text-right">Book price</th><th className="px-3 py-2 text-right">Your price</th></>
                         : <><SortableTh col="last_paid" label="Last paid" sort={sort} onToggle={toggle} className="text-right" /><SortableTh col="each" label="Each (list)" sort={sort} onToggle={toggle} className="text-right" /><SortableTh col="book" label="Book price" sort={sort} onToggle={toggle} className="text-right" /><SortableTh col="yours" label="Your price" sort={sort} onToggle={toggle} className="text-right" /></>}<th className="px-2 py-2"></th>
                </tr></thead>
                <tbody>
                  {(saved ? saved.lines : view).map(r => {
                    const price = saved ? r.customer_price : r.customer_price
                    const rec = saved ? r.recommended_price : r.recommended_price
                    const changed = Number(price) !== Number(rec)
                    return (
                      <tr key={r.key || r.id} className="border-t border-gray-800">
                        <td className="px-3 py-1.5 font-mono text-white whitespace-nowrap">{r.part_number}{r.added && <span className="ml-2 text-[10px] text-sky-300">added</span>}</td>
                        <td className="px-3 py-1.5 text-gray-300 max-w-md truncate" title={r.description}>{r.description}</td>
                        <td className="px-2 py-1.5 text-center text-xs">{r.dfar ? <span className="text-emerald-300">Y</span> : <span className="text-gray-600">N</span>}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-400">{r.last_paid ? money(r.last_paid, 3) : '—'}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-400">{money(r.each_price)}</td>
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
            <div className="mt-3 grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-start">
              <div><div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1 flex items-center gap-1"><Plus size={12} /> Add a part</div><PartTypeahead bookId={asOfBook?.id} onPick={addPart} placeholder="Part number or description…" /></div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1 flex items-center gap-1"><Layers size={12} /> Add a section <span className="normal-case tracking-normal text-gray-600">· a whole series, bought before or not</span></div>
                {secPick ? (
                  <div className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 space-y-2">
                    <div className="flex items-center gap-2 text-sm"><Layers size={13} className="text-skynet-accent shrink-0" /><span className="text-white truncate flex-1" title={secPick.name}>{secPick.name}</span><button onClick={clearSection} disabled={secBusy} className="text-gray-500 hover:text-gray-300" title="Choose another section"><X size={14} /></button></div>
                    <input value={secFilter} onChange={e => setSecFilter(e.target.value)} disabled={secBusy} placeholder="narrow by part number (optional)" className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono outline-none placeholder:font-sans placeholder:text-gray-500" />
                    <div className="flex items-center justify-between gap-2 text-xs text-gray-500">
                      <span>{secItems === null ? 'Reading the section…' : secPreview ? <>{num(secPreview.todo)} to add{secPreview.dup ? ` · ${num(secPreview.dup)} already on the list` : ''}{secPreview.noPrice ? ` · ${num(secPreview.noPrice)} without a price` : ''}</> : ''}</span>
                      <button onClick={addSection} disabled={secBusy || !secPreview?.todo} className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-skynet-accent text-gray-900 font-medium disabled:opacity-50">
                        {secBusy ? <><Loader2 size={12} className="animate-spin" /> {secProgress ? `${secProgress.done} / ${secProgress.total}` : 'Pricing…'}</> : <><Plus size={12} /> Add {secPreview?.todo ? num(secPreview.todo) : ''}</>}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="relative">
                    <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3">
                      <Search size={16} className="text-gray-500 shrink-0" />
                      <input value={secTerm} onChange={e => setSecTerm(e.target.value)} disabled={!asOfBook} placeholder={asOfBook ? `Section of ${asOfBook.rev_label}…` : 'No price book in effect on this date'} className="flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-gray-500" />
                    </div>
                    {secHits.hits.length > 0 && (
                      <div className="absolute z-30 mt-1 w-full max-h-72 overflow-auto bg-gray-800 border border-gray-700 rounded-lg shadow-xl">
                        {secHits.hits.map(s => (
                          <button key={s.id} onClick={() => pickSection(s)} className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 flex items-center gap-2">
                            <Layers size={13} className="text-skynet-accent shrink-0" /><span className="min-w-0 truncate">{s.name}</span>
                            <span className="ml-auto text-[10px] text-gray-500 shrink-0">{s.matching ? `${num(s.matching)} match` : 'name'}</span>
                            {s.kind === 'resale' && <span className="text-[10px] text-rose-300 shrink-0">resale</span>}
                          </button>
                        ))}
                        {secHits.more > 0 && <div className="px-3 py-1.5 text-xs text-gray-500">+{num(secHits.more)} more — keep typing</div>}
                      </div>
                    )}
                  </div>
                )}
                {secNote && <div className="mt-1 text-[11px] text-amber-300">{secNote}</div>}
              </div>
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
