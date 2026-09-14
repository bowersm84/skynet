//
// Pricing Portal — Price Books (S11 C3, D-PRICE-15/16/22). Admin: list books, open one,
// clone (label / effective date / % uplift), edit a DRAFT (items, sections, rules,
// bulk uplift of the whole book, set one section to a % over the in-effect book), diff
// against another book, schedule / unschedule / publish, export the
// Fishbowl Products CSV. Non-admins see the list and the diff, read-only.
//
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, Copy, CalendarClock, Undo2, Percent, GitCompare, FileDown, Plus, Trash2, Save, AlertTriangle, BookOpen, Check, RefreshCw, ExternalLink } from 'lucide-react'
import {
  loadBooks, loadBookMeta, loadBookItems, cloneBook, publishBook, unpublishBook, upliftBook, setSectionVsBase, upsertItem, deleteItem, upsertRule, upsertSection,
  diffBooks, productsCsv, money, num, columnPrice,
  loadKitComponentsForItems, refreshHardwareCosts, loadHardwareCostDrift,
} from '../../lib/pricing'
import { downloadBytes } from '../../lib/priceListDoc'
import { PartTypeahead } from './PricingTypeaheads'

// Kits tab ordering — Matt's reading order (Common Sets, Cowling, Option, RV, Lancair, Kit Hardware),
// matched on content words so a section rename or a new family does not silently fall to the bottom.
const KIT_HARDWARE_RE = /kit hardware/i
const KIT_ORDER = ['common set', 'cowling', 'option', 'rv kit', 'lancair', 'kit hardware']
const kitRank = (name) => {
  const n = String(name || '').toLowerCase()
  const i = KIT_ORDER.findIndex(k => n.includes(k))
  return i === -1 ? KIT_ORDER.length : i
}

const STATUS_CLS = { active: 'bg-emerald-900 text-emerald-200', scheduled: 'bg-sky-900 text-sky-200', draft: 'bg-gray-700 text-gray-300', superseded: 'bg-gray-800 text-gray-500' }
const OCT1 = '2026-10-01'

function Field({ label, children }) { return <label className="block text-xs"><span className="text-gray-500 uppercase tracking-wide text-[10px]">{label}</span><div className="mt-0.5">{children}</div></label> }
const inp = 'w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm outline-none'

function CloneDialog({ books, onClose, onDone }) {
  const [src, setSrc] = useState(books.find(b => b.status === 'active')?.id || books[0]?.id)
  const [label, setLabel] = useState(''); const [eff, setEff] = useState(''); const [pct, setPct] = useState('0'); const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null)
  const go = async () => {
    if (!label.trim()) { setErr('Label required'); return }
    setBusy(true); setErr(null)
    try { const id = await cloneBook(src, label.trim(), eff || null, Number(pct) / 100, notes); onDone(id) } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
  }
  return (
    <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="text-white font-semibold flex items-center gap-2"><Copy size={16} className="text-skynet-accent" /> Clone a price book</div>
        <Field label="Copy from"><select value={src} onChange={e => setSrc(e.target.value)} className={inp}>{books.map(b => <option key={b.id} value={b.id}>{b.rev_label} ({b.status})</option>)}</select></Field>
        <Field label="Label"><input value={label} onChange={e => setLabel(e.target.value)} placeholder="Rev 83 — Jan 2027" className={inp} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Effective (optional, can set at publish)"><input type="date" value={eff} onChange={e => setEff(e.target.value)} className={inp} /></Field>
          <Field label="Uplift on catalog Each, %"><input type="number" step="0.1" value={pct} onChange={e => setPct(e.target.value)} className={inp} /></Field>
        </div>
        <Field label="Notes"><input value={notes} onChange={e => setNotes(e.target.value)} className={inp} /></Field>
        <div className="text-[11px] text-gray-500">Rules, ladders, sections, items and set components are copied. Resale items are never uplifted (D-PRICE-13). The clone is a draft until you publish it.</div>
        {err && <div className="text-rose-300 text-xs">{err}</div>}
        <div className="flex justify-end gap-2"><button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">Cancel</button><button onClick={go} disabled={busy} className="px-3 py-1.5 text-sm rounded bg-skynet-accent text-gray-900 font-medium disabled:opacity-50">{busy ? 'Cloning…' : 'Clone'}</button></div>
      </div>
    </div>
  )
}

// `sum` is the precomputed { each, total, missing[] } for a component_sum row (D-PRICE-48 addendum).
// Precomputed on purpose: resolving a sum needs a part_key map over the whole book, and building
// that per row would be quadratic across a 4,500-item book.
function ItemRow({ it, meta, editable, sum, onSave, onDelete }) {
  const [v, setV] = useState(it); const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false)
  useEffect(() => { setV(it); setDirty(false) }, [it])
  const set = (k, val) => { setV(x => ({ ...x, [k]: val })); setDirty(true) }
  const save = async () => { setBusy(true); try { await onSave({ ...v, list_price: v.list_price === '' ? null : v.list_price, status: v.status === 'component_sum' ? 'component_sum' : (v.list_price === '' || v.list_price === null ? 'no_price' : 'priced') }); setDirty(false) } finally { setBusy(false) } }
  const cell = 'bg-transparent border-b border-transparent focus:border-skynet-accent outline-none w-full'
  return (
    <tr className={`border-t border-gray-800 ${dirty ? 'bg-amber-950/20' : ''}`}>
      <td className="px-2 py-1 font-mono text-white whitespace-nowrap">{editable ? <input value={v.part_number} onChange={e => set('part_number', e.target.value)} className={`${cell} font-mono`} /> : it.part_number}{it.status === 'component_sum' && <span className="ml-1 text-[10px] text-sky-300">{it.kit_sku_id ? 'KIT' : 'SET'}</span>}{it.status === 'component_sum' && it.kit_sku_id && (
        <Link to={`/kits?sku=${encodeURIComponent(it.part_number)}`} title={`Open ${it.part_number} in the Kit Registry`} className="ml-1 inline-flex align-middle text-gray-500 hover:text-white"><ExternalLink size={13} /></Link>
      )}</td>
      <td className="px-2 py-1 text-gray-300 min-w-[260px]">{editable ? <input value={v.description || ''} onChange={e => set('description', e.target.value)} className={cell} /> : it.description}</td>
      <td className="px-2 py-1 text-right font-mono">{editable && it.status !== 'component_sum' ? <input type="number" step="0.001" value={v.list_price ?? ''} onChange={e => set('list_price', e.target.value)} className={`${cell} text-right w-24`} /> : it.status === 'component_sum' ? (
        sum && sum.each !== null
          ? <span title={`Sum of ${sum.total} components`}>Σ {money(sum.each)}</span>
          : <span className="text-rose-300" title={!sum || !sum.total ? 'No components on file' : `${sum.missing.length} of ${sum.total} components unpriced: ${sum.missing.join(', ')}`}>Σ —</span>
      ) : it.list_price === null ? <span className="text-gray-500 italic text-xs">no price</span> : money(it.list_price, 3)}</td>
      <td className="px-2 py-1 text-center">{editable && it.status !== 'component_sum' ? <select value={v.rule_code || ''} onChange={e => set('rule_code', e.target.value || null)} className="bg-gray-800 border border-gray-700 rounded px-1 text-xs"><option value="">—</option>{Object.keys(meta.rules).sort().map(c => <option key={c} value={c}>{c}</option>)}</select> : <span className="text-xs text-gray-400">{it.rule_code || ''}</span>}</td>
      <td className="px-2 py-1 text-center">{editable ? <select value={v.ladder_code} onChange={e => set('ladder_code', e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-1 text-xs">{Object.keys(meta.ladders).sort().map(c => <option key={c} value={c}>{c}</option>)}</select> : <span className="text-xs text-gray-400">{it.ladder_code}</span>}</td>
      <td className="px-2 py-1 text-center"><input type="checkbox" checked={!!v.has_premier} disabled={!editable} onChange={e => set('has_premier', e.target.checked)} /></td>
      <td className="px-2 py-1 text-center"><input type="checkbox" checked={!!v.dfar} disabled={!editable} onChange={e => set('dfar', e.target.checked)} /></td>
      <td className="px-2 py-1 text-right whitespace-nowrap">
        {editable && dirty && <button onClick={save} disabled={busy} className="text-skynet-accent hover:text-white mr-2" title="Save"><Save size={14} /></button>}
        {editable && <button onClick={() => onDelete(it)} className="text-gray-500 hover:text-rose-300" title="Remove"><Trash2 size={14} /></button>}
      </td>
    </tr>
  )
}

export default function PriceBooks({ canEdit, onBooksChanged }) {
  const [books, setBooks] = useState([])
  const [bookId, setBookId] = useState(null)
  const [meta, setMeta] = useState(null); const [items, setItems] = useState([])
  // Selected section per tab: Sections & items and Kits each keep their own place (addendum 2).
  const [secByTab, setSecByTab] = useState({ items: null, kits: null })
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null); const [flash, setFlash] = useState(null)
  const [showClone, setShowClone] = useState(false)
  const [view, setView] = useState('items')          // items | rules | diff
  const [diffAgainst, setDiffAgainst] = useState(null); const [diffRows, setDiffRows] = useState(null)
  const [uplift, setUplift] = useState('15'); const [pubDate, setPubDate] = useState(OCT1)
  const [newSection, setNewSection] = useState('')
  const [comps, setComps] = useState([])            // price_kit_components for this book's sets and kits (D-PRICE-48)
  const [drift, setDrift] = useState([])            // v_hardware_cost_drift, loaded once per mount (D-PRICE-48)
  // Section to select once the next book's meta lands — set by the drift pill, consumed in loadBook().
  // A ref, not state, so it cannot re-trigger the load effect it is read inside.
  const pendingSection = useRef(null)
  const [sectionTarget, setSectionTarget] = useState('')   // total % over the in-effect book for the selected section (D-PRICE-39)
  const [baseBook, setBaseBook] = useState(null)   // { bookId, items } of the in-effect book — the per-section "vs" figure (D-PRICE-38)

  const book = books.find(b => b.id === bookId) || null
  const editable = canEdit && book?.status === 'draft'
  const refreshBooks = async () => { const b = await loadBooks(); setBooks(b); onBooksChanged?.(); if (!bookId && b.length) setBookId((b.find(x => x.status === 'active') || b[0]).id); return b }
  useEffect(() => { refreshBooks().catch(e => setError(e.message || String(e))) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const loadBook = async () => {
    if (!bookId) return
    setBusy(true)
    // The diff is computed from `items`, so any reload — a different book, or an edit to this
    // one — invalidates it. Without this a stale diff stays on screen under the new book's name.
    setDiffAgainst(null); setDiffRows(null)
    try {
      const [m, its] = await Promise.all([loadBookMeta(bookId), loadBookItems(bookId)])
      // Sets and kits price as the sum of their components, so the book's components are loaded
      // alongside its items — without them productsCsv would value every kit at zero (D-PRICE-48).
      const kitIds = its.filter(i => i.status === 'component_sum').map(i => i.id)
      const kc = kitIds.length ? await loadKitComponentsForItems(kitIds) : []
      setMeta(m); setItems(its); setComps(kc)
      // Kit Hardware lives on the Kits tab, so the drift pill lands there rather than on Sections & items.
      const want = pendingSection.current; pendingSection.current = null
      const hit = want ? m.sections.find(s => s.name.toLowerCase().includes(want)) : null
      if (hit) { setView('kits'); setSecByTab(s => ({ ...s, kits: hit.id })) }
    }
    catch (e) { setError(e.message || String(e)) } finally { setBusy(false) }
  }
  // Cost drift on the in-effect book. Read once per mount, never polled.
  useEffect(() => { loadHardwareCostDrift().then(setDrift).catch(() => {}) }, [])
  useEffect(() => { loadBook() }, [bookId]) // eslint-disable-line react-hooks/exhaustive-deps
  // The section header shows how far the open book has moved from the in-effect book, so a second
  // uplift on one family is judged against the real base (Rev 81), not the draft (D-PRICE-38).
  // Loaded once per active book; state is set only in the promise callback.
  const activeId = books.find(b => b.status === 'active')?.id || null
  useEffect(() => {
    if (!activeId || activeId === bookId || baseBook?.bookId === activeId) return
    let live = true
    loadBookItems(activeId).then(its => { if (live) setBaseBook({ bookId: activeId, items: its }) }).catch(() => {})
    return () => { live = false }
  }, [bookId, activeId]) // eslint-disable-line react-hooks/exhaustive-deps
  const note = (t) => { setFlash(t); setTimeout(() => setFlash(null), 2500) }
  // One handler, two buttons: the draft toolbar at the top and the Kit Hardware section on the Kits
  // tab. Kept in both places on purpose — the top one is where it shipped and where a reprice is
  // reached without first finding the right section (addendum 2).
  const doRefreshCosts = () => {
    if (!book) return
    if (!confirm(`Reprice cost-based hardware in "${book.rev_label}" at 2 × latest received Fishbowl cost, and add any kit component that now has a cost on file? Published books are never changed.`)) return
    run(async () => {
      const r = await refreshHardwareCosts(book.id, 1.0)
      await loadBook()
      note(`Costs refreshed: ${num(r.updated)} repriced, ${num(r.added)} added for kit sums, ${num(r.no_cost_on_file)} still without a cost on file`)
    })
  }
  const run = async (fn, ok) => { setBusy(true); setError(null); try { await fn(); if (ok) note(ok) } catch (e) { setError(e.message || String(e)) } finally { setBusy(false) } }

  // Items carrying their components, which is what productsCsv and any set/kit pricing needs.
  const compsByItem = useMemo(() => {
    const m = new Map()
    for (const c of comps) { const a = m.get(c.item_id); if (a) a.push(c); else m.set(c.item_id, [c]) }
    return m
  }, [comps])
  const enriched = useMemo(() => items.map(i => (i.status === 'component_sum' ? { ...i, _components: compsByItem.get(i.id) || [] } : i)), [items, compsByItem])
  const itemsByKey = useMemo(() => new Map(enriched.map(i => [i.part_key, i])), [enriched])
  // Book-wide, not per section: the Kits tab's section list needs resolved / unresolved counts for
  // every kit section at once, and 331 sums over ~10 components each is trivial to do in one pass.
  const sumsByItem = useMemo(() => {
    const resolve = (k) => itemsByKey.get(k) || null
    const m = new Map()
    for (const it of enriched) {
      if (it.status !== 'component_sum') continue
      const comps = it._components || []
      const missing = []
      for (const kc of comps) {
        const c = resolve(kc.component_key)
        const v = c ? columnPrice(c, 'each', meta, book, null) : null
        if (v === null || !Number.isFinite(Number(v))) missing.push(kc.component_part_number || kc.component_key)
      }
      const each = comps.length && !missing.length ? columnPrice(it, 'each', meta, book, resolve) : null
      m.set(it.id, { each: each === null || !Number.isFinite(Number(each)) ? null : Number(each), total: comps.length, missing })
    }
    return m
  }, [enriched, itemsByKey, meta, book])
  // Per section: how many items, how many of its sums resolve, and whether it holds any sum at all —
  // the last is what decides which tab the section belongs to.
  const sectionCounts = useMemo(() => {
    const m = new Map()
    for (const i of enriched) {
      const e = m.get(i.section_id) || { items: 0, sums: 0, resolved: 0, unresolved: 0 }
      e.items++
      if (i.status === 'component_sum') {
        e.sums++
        if (sumsByItem.get(i.id)?.each != null) e.resolved++; else e.unresolved++
      }
      m.set(i.section_id, e)
    }
    return m
  }, [enriched, sumsByItem])
  // Kits tab = every section that actually holds a sum, plus Kit Hardware. Partitioned by CONTENT,
  // so a future kit family needs no rename and no list here (addendum 2). Kit Hardware is matched by
  // name because it holds cost rows, not sums. Order is Matt's reading order, not the book's sort.
  const { kitSections, plainSections } = useMemo(() => {
    const kit = [], plain = []
    for (const s of meta?.sections || []) {
      if ((sectionCounts.get(s.id)?.sums || 0) > 0 || KIT_HARDWARE_RE.test(s.name)) kit.push(s); else plain.push(s)
    }
    kit.sort((a, b) => kitRank(a.name) - kitRank(b.name) || a.sort - b.sort)
    return { kitSections: kit, plainSections: plain }
  }, [meta, sectionCounts])
  const visibleSections = view === 'kits' ? kitSections : plainSections
  const sectionId = view === 'kits' ? secByTab.kits : secByTab.items
  const pickSection = (id) => setSecByTab(s => ({ ...s, [view === 'kits' ? 'kits' : 'items']: id }))
  // Keep each tab pointed at a section that exists in it, without losing the other tab's place.
  useEffect(() => {
    setSecByTab(s => ({
      items: s.items && plainSections.some(x => x.id === s.items) ? s.items : (plainSections[0]?.id || null),
      kits: s.kits && kitSections.some(x => x.id === s.kits) ? s.kits : (kitSections[0]?.id || null),
    }))
  }, [plainSections, kitSections])
  const sectionItems = useMemo(() => enriched.filter(i => i.section_id === sectionId), [enriched, sectionId])
  // Cost-based rows are priced from purchase cost (D-PRICE-47), so a percentage reprice is meaningless
  // for them — the section is tagged and Set section is withdrawn.
  const sectionHasCostPlus = useMemo(() => sectionItems.some(i => i.cost_plus), [sectionItems])
  const section = meta?.sections.find(s => s.id === sectionId) || null
  // What a section uplift touches — priced catalog rows (sets are Σ of their components and follow
  // them; resale is never uplifted, D-PRICE-13) — and their average Each movement vs the in-effect book.
  const sectionStats = useMemo(() => {
    const rows = sectionItems.filter(i => i.status === 'priced' && i.list_price != null)
    const baseMap = baseBook && baseBook.bookId !== bookId ? new Map(baseBook.items.filter(b => b.status === 'priced' && b.list_price != null).map(b => [b.part_key, Number(b.list_price)])) : null
    let sum = 0, n = 0
    if (baseMap) for (const r of rows) { const b = baseMap.get(r.part_key); if (b) { sum += Number(r.list_price) / b - 1; n++ } }
    // Sets and kits are counted separately: they carry no list_price, so they never take part in the
    // "vs in-effect book" average (unchanged), but they do belong in the section count.
    let resolvedSums = 0, unresolvedSums = 0
    for (const i of sectionItems) {
      if (i.status !== 'component_sum') continue
      if (sumsByItem.get(i.id)?.each != null) resolvedSums++
      else unresolvedSums++
    }
    return { priced: rows.length, resolvedSums, unresolvedSums, matched: n, unmatched: baseMap ? rows.length - n : null, avgPct: n ? sum / n : null, baseId: baseMap ? baseBook.bookId : null, baseLabel: baseMap ? (books.find(b => b.id === baseBook.bookId)?.rev_label || 'in-effect book') : null }
  }, [sectionItems, sumsByItem, baseBook, bookId, books])
  const fmtPct = (p) => `${p > 0 ? '+' : ''}${(p * 100).toFixed(1)}%`
  const counts = useMemo(() => ({ items: items.length, priced: items.filter(i => i.status === 'priced').length, noprice: items.filter(i => i.status === 'no_price').length }), [items])
  const runDiff = async (otherId) => {
    setDiffAgainst(otherId); setDiffRows(null)
    if (!otherId) return
    // Both sides need components and meta: a set Each is resolved inside its own book.
    const [bm, base] = await Promise.all([loadBookMeta(otherId), loadBookItems(otherId)])
    const baseKitIds = base.filter(i => i.status === 'component_sum').map(i => i.id)
    const bc = baseKitIds.length ? await loadKitComponentsForItems(baseKitIds) : []
    const byItem = new Map()
    for (const c of bc) { const a = byItem.get(c.item_id); if (a) a.push(c); else byItem.set(c.item_id, [c]) }
    const baseEnriched = base.map(i => (i.status === 'component_sum' ? { ...i, _components: byItem.get(i.id) || [] } : i))
    setDiffRows(diffBooks(baseEnriched, enriched, { baseMeta: bm, baseBook: books.find(x => x.id === otherId) || null, newMeta: meta, newBook: book }))
  }

  return (
    <div className="space-y-4">
      {showClone && <CloneDialog books={books} onClose={() => setShowClone(false)} onDone={async (id) => { setShowClone(false); await refreshBooks(); setBookId(id); note('Draft created') }} />}
      {/* Books list */}
      <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-white font-semibold flex items-center gap-2"><BookOpen size={16} className="text-skynet-accent" /> Price books</h2>
          {canEdit && <button onClick={() => setShowClone(true)} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-600 text-gray-200 text-sm hover:text-white"><Copy size={14} /> Clone…</button>}
        </div>
        <table className="text-sm w-full">
          <thead><tr className="text-left text-[11px] uppercase tracking-wide text-gray-400"><th className="pr-4 py-1">Book</th><th className="pr-4 py-1">Effective</th><th className="pr-4 py-1">Status</th><th className="pr-4 py-1">Uplift</th><th className="pr-4 py-1">Premier</th><th className="pr-4 py-1">Created</th><th></th></tr></thead>
          <tbody>
            {books.map(b => (
              <tr key={b.id} onClick={() => setBookId(b.id)} className={`border-t border-gray-800 cursor-pointer ${bookId === b.id ? 'bg-gray-700/50' : 'hover:bg-gray-800/60'}`}>
                <td className="pr-4 py-1.5 text-white">{b.rev_label}
                  {b.status === 'active' && drift.length > 0 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); pendingSection.current = 'kit hardware'; if (bookId === b.id) { const hit = meta?.sections.find(s => s.name.toLowerCase().includes('kit hardware')); pendingSection.current = null; if (hit) { setView('kits'); setSecByTab(s => ({ ...s, kits: hit.id })) } } else setBookId(b.id) }}
                      title={drift.slice(0, 5).map(d => `${d.part_number} (${money(d.book_each)} → ${money(d.cost_plus_now)})`).join('\n')}
                      className="ml-2 align-middle px-2 py-0.5 rounded text-[11px] bg-amber-900/50 text-amber-200 border border-amber-800 hover:text-white">
                      {num(drift.length)} hardware cost{drift.length === 1 ? '' : 's'} drifted &gt;10%
                    </button>
                  )}
                </td>
                <td className="pr-4 py-1.5 font-mono text-gray-300">{b.effective_from || '—'}</td>
                <td className="pr-4 py-1.5"><span className={`px-2 py-0.5 rounded text-xs ${STATUS_CLS[b.status] || ''}`}>{b.status}</span></td>
                <td className="pr-4 py-1.5 font-mono text-gray-300">{b.uplift_pct ? `${(Number(b.uplift_pct) * 100).toFixed(1)}%` : ''}</td>
                <td className="pr-4 py-1.5 font-mono text-gray-300">{(Number(b.premier_pct) * 100).toFixed(0)}% of T3</td>
                <td className="pr-4 py-1.5 text-gray-500 text-xs">{String(b.created_at).slice(0, 10)}</td>
                <td className="py-1.5 text-xs text-gray-500">{b.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {book && (
        <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4">
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <div className="min-w-0 flex-1">
              <div className="text-white font-semibold">{book.rev_label} <span className={`ml-2 px-2 py-0.5 rounded text-xs ${STATUS_CLS[book.status]}`}>{book.status}</span></div>
              <div className="text-xs text-gray-500">{num(counts.items)} items · {num(counts.priced)} priced · {num(counts.noprice)} no price · {meta?.sections.length || 0} sections · {Object.keys(meta?.rules || {}).length} rules{book.effective_from ? ` · effective ${book.effective_from}` : ''}</div>
            </div>
            {/* actions */}
            {canEdit && book.status === 'draft' && (
              <>
                <div className="flex items-center gap-1 text-xs"><Percent size={13} className="text-gray-500" /><input type="number" step="0.1" value={uplift} onChange={e => setUplift(e.target.value)} className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 font-mono outline-none" />
                  <button onClick={() => { if (confirm(`Raise every catalog Each in ${book.rev_label} by ${uplift}%?`)) run(async () => { const n = await upliftBook(book.id, Number(uplift) / 100); await loadBook(); return n }, `Uplifted ${uplift}%`) }} className="px-2 py-1 rounded border border-gray-600 text-gray-200 hover:text-white">Uplift all</button></div>
                <div className="flex items-center gap-1 text-xs"><CalendarClock size={13} className="text-gray-500" /><input type="date" value={pubDate} onChange={e => setPubDate(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 font-mono outline-none" />
                  <button onClick={() => { if (confirm(`Publish ${book.rev_label} effective ${pubDate}?`)) run(async () => { await publishBook(book.id, pubDate); await refreshBooks() }, 'Published') }} className="px-2 py-1 rounded bg-skynet-accent text-gray-900 font-medium">Schedule / publish</button></div>
                <button onClick={doRefreshCosts} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-600 text-gray-200 text-xs hover:text-white" title="Set every cost-based hardware Each to 2 × the latest received purchase cost, and add kit components that now have a cost (D-PRICE-47)"><RefreshCw size={13} /> Refresh costs</button>
              </>
            )}
            {canEdit && book.status === 'scheduled' && <button onClick={() => { if (confirm(`Take ${book.rev_label} back to draft?`)) run(async () => { await unpublishBook(book.id); await refreshBooks() }, 'Back to draft') }} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-600 text-gray-200 text-xs hover:text-white"><Undo2 size={13} /> Unschedule (edit)</button>}
            <button onClick={() => {
              const stats = {}
              const csv = productsCsv(enriched, meta, book, { stats })
              downloadBytes(new TextEncoder().encode(csv), `Fishbowl_Products_${book.rev_label.replace(/[^A-Za-z0-9]+/g, '_')}.csv`, 'text/csv')
              note(`Fishbowl Products CSV: ${num(stats.priced)} priced + ${num(stats.sums)} sets/kits${stats.skipped_sums ? ` (${num(stats.skipped_sums)} kits skipped — sum unresolved)` : ''}`)
            }} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-600 text-gray-200 text-xs hover:text-white" title="Fishbowl Products import (ProductNumber, Price) — priced parts plus every set and kit whose component sum resolves (D-PRICE-22/48)"><FileDown size={13} /> Fishbowl Products CSV</button>
          </div>
          {error && <div className="mb-3 flex items-center gap-2 text-sm text-rose-300 bg-rose-950/40 border border-rose-900 rounded px-3 py-2"><AlertTriangle size={14} /> {error}</div>}
          {flash && <div className="mb-3 flex items-center gap-2 text-sm text-emerald-300"><Check size={14} /> {flash}</div>}
          {book.status === 'scheduled' && <div className="mb-3 text-xs text-sky-300 bg-sky-950/40 border border-sky-900 rounded px-3 py-2">Scheduled — activates by date on {book.effective_from}, no deploy needed. To change anything, Unschedule first (D-PRICE-16).</div>}
          {book.status === 'active' && canEdit && <div className="mb-3 text-xs text-gray-400">The active book is read-only. Clone it to make changes, then schedule the clone.</div>}

          <nav className="flex gap-1 border-b border-gray-700 mb-3">
            {[['items', 'Sections & items'], ['kits', 'Kits'], ['rules', 'Rules & ladders'], ['diff', 'Diff']].map(([k, l]) => <button key={k} onClick={() => setView(k)} className={`px-3 py-1.5 text-sm border-b-2 -mb-px ${view === k ? 'border-skynet-accent text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>{l}</button>)}
          </nav>

          {busy && <div className="p-6 text-center"><Loader2 size={20} className="animate-spin text-gray-500 mx-auto" /></div>}

          {!busy && (view === 'items' || view === 'kits') && meta && (
            <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
              <aside>
                <div className="max-h-[60vh] overflow-auto border border-gray-700 rounded-lg">
                  {visibleSections.map(s => {
                    const c = sectionCounts.get(s.id) || { items: 0, resolved: 0, unresolved: 0 }
                    return (
                      <button key={s.id} onClick={() => { pickSection(s.id); setSectionTarget('') }} className={`w-full text-left px-3 py-1.5 text-xs border-b border-gray-800 ${sectionId === s.id ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700/60'}`}>
                        {s.name}{s.kind === 'resale' ? <span className="ml-1 text-rose-300">· resale</span> : ''}
                        {view === 'kits' && <span className="block text-[10px] text-gray-500 mt-0.5">{num(c.items)} items · {num(c.resolved)} resolved{c.unresolved ? <span className="text-rose-300"> · {num(c.unresolved)} unresolved</span> : ''}</span>}
                      </button>
                    )
                  })}
                </div>
                {editable && view === 'items' && (
                  <div className="mt-2 flex gap-1">
                    <input value={newSection} onChange={e => setNewSection(e.target.value)} placeholder="New section name" className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs outline-none" />
                    <button onClick={() => { if (!newSection.trim()) return; run(async () => { await upsertSection(book.id, { name: newSection.trim(), sort: (meta.sections.length ? Math.max(...meta.sections.map(s => s.sort)) : 0) + 1 }); setNewSection(''); await loadBook() }, 'Section added') }} className="px-2 py-1 rounded border border-gray-600 text-gray-200 text-xs hover:text-white"><Plus size={12} /></button>
                  </div>
                )}
              </aside>
              <div className="min-w-0">
                {section && (
                  <div className="flex flex-wrap items-center gap-3 mb-2 text-xs">
                    <div className="min-w-0 flex-1 text-gray-400 truncate" title={section.name}><span className="text-white">{section.name}</span>{sectionHasCostPlus && <span className="ml-2 px-1.5 py-0.5 rounded bg-gray-700 text-gray-300 text-[10px] align-middle" title="Priced from the latest received purchase cost (D-PRICE-47) — use Refresh costs, not a percentage">cost-based</span>} · {num(sectionItems.length)} items · {num(sectionStats.priced + sectionStats.resolvedSums)} priced{sectionStats.unresolvedSums > 0 ? <span className="text-rose-300"> · {num(sectionStats.unresolvedSums)} unresolved</span> : ''}{section.kind === 'resale' ? <span className="text-rose-300"> · resale — never uplifted (D-PRICE-13)</span> : ''}</div>
                    {sectionStats.avgPct != null && (
                      <div className="font-mono text-gray-400 whitespace-nowrap" title={`Average Each change of the ${sectionStats.matched} parts in this section that are also in ${sectionStats.baseLabel}${sectionStats.unmatched ? `; ${sectionStats.unmatched} not in it` : ''}`}>vs {sectionStats.baseLabel}: <span className={sectionStats.avgPct > 0 ? 'text-amber-300' : sectionStats.avgPct < 0 ? 'text-rose-300' : 'text-gray-300'}>{fmtPct(sectionStats.avgPct)}</span></div>
                    )}
                    {view === 'kits' && <div className="text-[11px] text-gray-500 whitespace-nowrap">Kit price = sum of components at book price · hardware at 2× cost (D-PRICE-46/47)</div>}
                    {view === 'kits' && editable && sectionHasCostPlus && (
                      <button onClick={doRefreshCosts} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-600 text-gray-200 hover:text-white whitespace-nowrap" title="Set every cost-based hardware Each to 2 × the latest received purchase cost, and add kit components that now have a cost (D-PRICE-47)"><RefreshCw size={13} /> Refresh costs</button>
                    )}
                    {view !== 'kits' && editable && section.kind !== 'resale' && sectionStats.baseId && !sectionHasCostPlus && (
                      <div className="flex items-center gap-1 whitespace-nowrap"><span className="text-gray-500">→ set to</span><input type="number" step="0.1" value={sectionTarget} onChange={e => setSectionTarget(e.target.value)} placeholder={sectionStats.avgPct != null ? (sectionStats.avgPct * 100).toFixed(1) : ''} className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 font-mono outline-none" /><Percent size={13} className="text-gray-500" />
                        <button disabled={sectionTarget === '' || !sectionStats.matched} onClick={() => {
                          const t = Number(sectionTarget)
                          if (!Number.isFinite(t) || t <= -100) return
                          const skipped = sectionStats.unmatched ? ` ${num(sectionStats.unmatched)} part${sectionStats.unmatched === 1 ? ' has' : 's have'} no ${sectionStats.baseLabel} price and will be left unchanged.` : ''
                          if (confirm(`Set the ${num(sectionStats.matched)} priced Each in "${section.name}" to ${fmtPct(t / 100)} over ${sectionStats.baseLabel} (currently ${fmtPct(sectionStats.avgPct)})? Each becomes the ${sectionStats.baseLabel} Each × ${(1 + t / 100).toFixed(3)}, rounded to 3 dp.${skipped}`)) run(async () => { const r = await setSectionVsBase(book.id, section.id, sectionStats.baseId, t / 100); await loadBook(); setSectionTarget(''); note(`${section.name}: ${num(r.updated)} Each set to ${fmtPct(t / 100)} vs ${sectionStats.baseLabel}${r.unmatched ? ` (${num(r.unmatched)} without a base price left unchanged)` : ''}`) })
                        }} className="px-2 py-1 rounded border border-gray-600 text-gray-200 hover:text-white disabled:opacity-40 disabled:hover:text-gray-200" title="Reprice every part in this section as a percentage over the in-effect book — absolute, so running it again with the same number changes nothing">Set section</button></div>
                    )}
                  </div>
                )}
                <div className="overflow-auto border border-gray-700 rounded-lg max-h-[60vh]">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-800 sticky top-0"><tr className="text-left text-[11px] uppercase tracking-wide text-gray-400"><th className="px-2 py-2">Part</th><th className="px-2 py-2">Description</th><th className="px-2 py-2 text-right">Each</th><th className="px-2 py-2 text-center">Rule</th><th className="px-2 py-2 text-center">Ladder</th><th className="px-2 py-2 text-center">Premier</th><th className="px-2 py-2 text-center">DFAR</th><th></th></tr></thead>
                    <tbody>
                      {sectionItems.map(it => <ItemRow key={it.id} it={it} meta={meta} editable={editable} sum={sumsByItem.get(it.id)} onSave={(v) => run(async () => { await upsertItem(book.id, { ...v, section_id: sectionId }); await loadBook() }, `${v.part_number} saved`)} onDelete={(x) => { if (confirm(`Remove ${x.part_number} from ${book.rev_label}?`)) run(async () => { await deleteItem(book.id, x.id); await loadBook() }, 'Removed') }} />)}
                    </tbody>
                  </table>
                </div>
                {editable && (
                  <div className="mt-2">
                    <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1 flex items-center gap-1"><Plus size={12} /> Add a part to this section (type a Fishbowl product or a new number)</div>
                    <PartTypeahead bookId={book.id} placeholder="Part number…" onPick={(p) => run(async () => { await upsertItem(book.id, { section_id: sectionId, sort: (sectionItems.length ? Math.max(...sectionItems.map(i => i.sort)) : 0) + 1, part_number: p.part_number, description: p.description || '', list_price: p.fb_list_price ?? null, rule_code: meta.sections.find(s => s.id === sectionId)?.kind === 'resale' ? null : 'A', ladder_code: meta.sections.find(s => s.id === sectionId)?.kind === 'resale' ? 'none' : 'standard', status: p.fb_list_price ? 'priced' : 'no_price' }); await loadBook() }, `${p.part_number} added — set its Each and rule`)} />
                  </div>
                )}
              </div>
            </div>
          )}

          {!busy && view === 'rules' && meta && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Rules (× Each) — Premier = Tier 3 × {(Number(book.premier_pct) * 100).toFixed(0)}%</div>
                <table className="text-sm w-full border border-gray-700 rounded-lg">
                  <thead className="bg-gray-800"><tr className="text-[11px] uppercase text-gray-400"><th className="px-2 py-1 text-left">Rule</th>{['100', '300', '500', 'T1', 'T2', 'T3'].map(h => <th key={h} className="px-2 py-1 text-right">{h}</th>)}<th></th></tr></thead>
                  <tbody>
                    {Object.values(meta.rules).sort((a, b) => a.code.localeCompare(b.code)).map(r => <RuleRow key={r.code} r={r} editable={editable} onSave={(v) => run(async () => { await upsertRule(book.id, v); await loadBook() }, `Rule ${v.code} saved`)} />)}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Ladders (which columns a section shows)</div>
                <table className="text-sm w-full border border-gray-700 rounded-lg">
                  <thead className="bg-gray-800"><tr className="text-[11px] uppercase text-gray-400"><th className="px-2 py-1 text-left">Code</th><th className="px-2 py-1 text-left">Columns</th><th className="px-2 py-1 text-right">Items</th></tr></thead>
                  <tbody>
                    {Object.values(meta.ladders).sort((a, b) => a.code.localeCompare(b.code)).map(l => <tr key={l.code} className="border-t border-gray-800"><td className="px-2 py-1 font-mono text-white">{l.code}</td><td className="px-2 py-1 text-gray-300 text-xs">{(l.columns || []).map(c => c.label + (c.kind === 'qty' ? '+' : '')).join(' | ') || '(list only)'}</td><td className="px-2 py-1 text-right font-mono text-gray-400">{num(items.filter(i => i.ladder_code === l.code).length)}</td></tr>)}
                  </tbody>
                </table>
                <div className="mt-1 text-[11px] text-gray-600">Ladder columns are data (D-PRICE-08); editing them is a SQL change for now — ask Matt.</div>
              </div>
            </div>
          )}

          {!busy && view === 'diff' && (
            <div>
              <div className="flex items-center gap-2 text-sm mb-2"><GitCompare size={14} className="text-gray-500" /> Compare <span className="text-white">{book.rev_label}</span> against
                <select value={diffAgainst || ''} onChange={e => runDiff(e.target.value || null)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm"><option value="">— pick a book —</option>{books.filter(b => b.id !== book.id).map(b => <option key={b.id} value={b.id}>{b.rev_label}</option>)}</select>
              </div>
              {diffAgainst && diffRows === null && <div className="p-6 text-center"><Loader2 size={20} className="animate-spin text-gray-500 mx-auto" /></div>}
              {diffRows && (
                <>
                  <div className="text-xs text-gray-400 mb-2">{diffRows.filter(d => d.kind === 'changed').length} changed · {diffRows.filter(d => d.kind === 'added').length} added · {diffRows.filter(d => d.kind === 'removed').length} removed</div>
                  <div className="overflow-auto border border-gray-700 rounded-lg max-h-[60vh]">
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-800 sticky top-0"><tr className="text-left text-[11px] uppercase tracking-wide text-gray-400"><th className="px-2 py-2">Part</th><th className="px-2 py-2">Change</th><th className="px-2 py-2 text-right">Each before</th><th className="px-2 py-2 text-right">Each after</th><th className="px-2 py-2 text-right">Δ</th><th className="px-2 py-2">Rule / ladder</th></tr></thead>
                      <tbody>
                        {diffRows.slice(0, 2000).map((d, i) => (
                          <tr key={i} className="border-t border-gray-800">
                            <td className="px-2 py-1 font-mono text-white">{d.part_number}</td>
                            <td className={`px-2 py-1 text-xs ${d.kind === 'added' ? 'text-emerald-300' : d.kind === 'removed' ? 'text-rose-300' : 'text-amber-300'}`}>{d.kind}</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-400">{d.fromEach != null ? money(d.fromEach, 3) : d.from?.status === 'component_sum' ? <span className="text-rose-300">Σ —</span> : ''}</td>
                            <td className="px-2 py-1 text-right font-mono text-white">{d.toEach != null ? money(d.toEach, 3) : d.to?.status === 'component_sum' ? <span className="text-rose-300">Σ —</span> : ''}</td>
                            <td className="px-2 py-1 text-right font-mono text-xs text-gray-300">{d.pct != null ? `${d.pct > 0 ? '+' : ''}${(d.pct * 100).toFixed(1)}%` : ''}</td>
                            <td className="px-2 py-1 text-xs text-gray-400">{d.from && d.to && (d.from.rule_code !== d.to.rule_code || d.from.ladder_code !== d.to.ladder_code) ? `${d.from.rule_code || '—'}/${d.from.ladder_code} → ${d.to.rule_code || '—'}/${d.to.ladder_code}` : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function RuleRow({ r, editable, onSave }) {
  const [v, setV] = useState(r); const [dirty, setDirty] = useState(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setV(r); setDirty(false) }, [r])
  const keys = ['m_q100', 'm_q300', 'm_q500', 'm_tier1', 'm_tier2', 'm_tier3']
  return (
    <tr className={`border-t border-gray-800 ${dirty ? 'bg-amber-950/20' : ''}`}>
      <td className="px-2 py-1 font-mono text-white">{r.code}</td>
      {keys.map(k => <td key={k} className="px-2 py-1 text-right font-mono">{editable ? <input type="number" step="0.001" value={v[k] ?? ''} onChange={e => { setV(x => ({ ...x, [k]: e.target.value === '' ? null : Number(e.target.value) })); setDirty(true) }} className="w-16 bg-transparent border-b border-transparent focus:border-skynet-accent outline-none text-right" /> : (r[k] ?? '—')}</td>)}
      <td className="px-2 py-1 text-right">{editable && dirty && <button onClick={() => onSave(v)} className="text-skynet-accent hover:text-white" title="Save"><Save size={14} /></button>}</td>
    </tr>
  )
}
