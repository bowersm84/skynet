//
// Pricing Portal — Catalog tab. Section list on the left, the section's item
// grid on the right with Each + the section ladder columns (+ Premier where a
// part carries it). Prices come from the client-side engine mirror so a
// section renders from one price_items query; the Lookup tab's RPC result is
// the authority if the two ever disagree.
//
// Two views (D-PRICE-52): Catalog, and Kits — the same grid over the book's kit
// sections, reading the SCHEDULED book while the book in effect has no kits.
// Whole-book search matches section names as well as parts, and Export… writes
// the whole book in effect to an internal XLSX.
//
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, Search, ChevronRight, Layers, PanelLeftClose, PanelLeftOpen, ImagePlus, X, Package, FileDown, ExternalLink, CalendarClock } from 'lucide-react'
import {
  loadSectionItems, loadItemsByKeys, loadPartImages, loadSectionImages, addImage, deleteImage, searchItems,
  loadBookMeta, loadBookItems, loadKitComponentsForItems, loadSumSectionIds, loadSectionItemCounts, loadFbListPrices,
  bookPricer, sumDetail, itemColumns, money, num, round2, partKey, todayIso,
} from '../../lib/pricing'
import { matchSections, pickKitsBook } from '../../lib/pricingView'
import { catalogColumns, catalogRows, buildCatalogXlsx, catalogFilename } from '../../lib/catalogExport'
import { downloadBytes } from '../../lib/priceListDoc'
import ImageLightbox from './ImageLightbox'

const VIEWS = [{ key: 'catalog', label: 'Catalog', icon: Layers }, { key: 'kits', label: 'Kits', icon: Package }]

// Sidebar width is a per-browser preference (B.1: full section names, drag to resize, collapse).
const SIDEBAR_KEY = 'skynet.pricing.catalog_sidebar'
const SIDEBAR_MIN = 220, SIDEBAR_MAX = 720, SIDEBAR_DEFAULT = 380
function loadSidebar() {
  try { const s = JSON.parse(localStorage.getItem(SIDEBAR_KEY) || '{}'); return { width: Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, s.width || SIDEBAR_DEFAULT)), open: s.open !== false } } catch { return { width: SIDEBAR_DEFAULT, open: true } }
}

function ItemGrid({ items, comps, extra, meta, book, sectionKind, kits, fbPrices }) {
  // Sets resolve their components across the whole book (`extra` = component items fetched
  // by key — they live in other sections); anything still missing renders '—', never a partial sum.
  const byKey = useMemo(() => Object.fromEntries([...extra, ...items].map(i => [i.part_key, i])), [items, extra])
  const compsByItem = useMemo(() => {
    const m = {}
    for (const c of comps) (m[c.item_id] ||= []).push(c)
    return m
  }, [comps])
  const enriched = useMemo(() => items.map(i => ({ ...i, _components: compsByItem[i.id] || [] })), [items, compsByItem])
  const price = useMemo(() => bookPricer(meta, book, k => byKey[k] || null), [meta, book, byKey])

  // Columns = union of every item's columns, in ladder order, Premier last.
  const columns = useMemo(() => {
    const seen = new Map()
    for (const it of enriched) for (const c of itemColumns(it, meta.ladders[it.ladder_code])) if (!seen.has(c.key)) seen.set(c.key, c)
    const arr = [...seen.values()]
    const prem = arr.findIndex(c => c.key === 'premier')
    if (prem >= 0) arr.push(arr.splice(prem, 1)[0])
    return arr
  }, [enriched, meta])

  if (!items.length) return <div className="text-gray-500 text-sm p-6">No items in this section.</div>
  return (
    <div className="overflow-auto rounded-xl border border-gray-700">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-800 sticky top-0">
          <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
            <th className="px-3 py-2">Part</th>
            <th className="px-3 py-2">Description</th>
            <th className="px-2 py-2 text-center">DFAR</th>
            {sectionKind !== 'resale' && <th className="px-2 py-2 text-center">Rule</th>}
            {columns.map(c => <th key={c.key} className={`px-3 py-2 text-right whitespace-nowrap ${c.kind === 'tier' ? 'text-violet-300' : ''}`}>{c.label}{c.kind === 'qty' ? '+' : ''}</th>)}
            {fbPrices && <th className="px-3 py-2 text-right whitespace-nowrap text-gray-500">Fishbowl today</th>}
          </tr>
        </thead>
        <tbody>
          {enriched.map(it => {
            // Workings for a set, once per row: what it sums to and, when it does not, why.
            const sum = it.status === 'component_sum' ? sumDetail(it, 'each', k => byKey[k] || null, price) : null
            const sumTitle = sum ? (sum.value !== null ? `Sum of ${sum.total} component${sum.total === 1 ? '' : 's'}`
              : !sum.total ? 'No components on file'
                : `${sum.missing.length} of ${sum.total} components unpriced: ${sum.missing.join(', ')}`) : ''
            return (
              <tr key={it.id} className={`border-t border-gray-800 hover:bg-gray-800/60 ${it.status === 'no_price' ? 'text-gray-500' : ''}`}>
                <td className="px-3 py-1.5 font-mono text-white whitespace-nowrap">
                  {it.part_number}
                  {it.status === 'component_sum' && <span className="ml-2 text-[10px] text-sky-300">{it.kit_sku_id ? 'KIT' : 'SET'}</span>}
                  {it.status === 'component_sum' && it.kit_sku_id && (
                    <Link to={`/kits?sku=${encodeURIComponent(it.part_number)}`} title={`Open ${it.part_number} in the Kit Registry`} className="ml-1 inline-flex align-middle text-gray-500 hover:text-white"><ExternalLink size={13} /></Link>
                  )}
                  {it.range_of && <span className="ml-2 text-[10px] text-gray-500" title={`from range ${it.range_of}`}>range</span>}
                </td>
                <td className="px-3 py-1.5 text-gray-300 max-w-md truncate" title={it.description || ''}>{it.description || ''}</td>
                <td className="px-2 py-1.5 text-center text-xs">{it.dfar ? <span className="text-emerald-300">Y</span> : <span className="text-gray-600">N</span>}</td>
                {sectionKind !== 'resale' && <td className="px-2 py-1.5 text-center text-xs text-gray-400">{it.rule_code || ''}</td>}
                {columns.map(c => {
                  if (it.status === 'no_price') return <td key={c.key} className="px-3 py-1.5 text-right text-xs italic">{c.key === 'each' ? 'No pricing available' : ''}</td>
                  const v = price(it, c.key)
                  if (sum) {
                    // A kit is all-or-nothing: Σ with the number, or Σ — naming what blocks it.
                    return <td key={c.key} className="px-3 py-1.5 text-right font-mono" title={sumTitle}>
                      {v === null ? <span className="text-rose-300">Σ —</span> : <span className={c.kind === 'tier' ? 'text-violet-200' : 'text-gray-200'}>Σ {money(round2(v))}</span>}
                    </td>
                  }
                  if (v === null && c.key !== 'each') return <td key={c.key} className="px-3 py-1.5 text-right text-gray-700">·</td>
                  return <td key={c.key} className={`px-3 py-1.5 text-right font-mono ${c.kind === 'tier' ? 'text-violet-200' : 'text-gray-200'}`}>{v === null ? '—' : money(round2(v))}</td>
                })}
                {fbPrices && <td className="px-3 py-1.5 text-right font-mono text-gray-500">{fbPrices[it.part_key] === undefined || fbPrices[it.part_key] === null ? '—' : money(fbPrices[it.part_key])}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
      {kits && <div className="px-3 py-2 text-[11px] text-gray-500 border-t border-gray-800">Kit price = sum of components at book price · hardware at 2× cost (D-PRICE-46/47). A kit with any unpriced component shows Σ — and never a part price.</div>}
    </div>
  )
}

// Export… — the whole book in effect as one internal XLSX (D-PRICE-52 B). Everything is
// priced by the client engine over one whole-book load; pricing_customer_sheet's `all` mode
// prices 4,800 rows one at a time and is not what this is for.
function ExportDialog({ book, meta, onClose }) {
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState(null)
  const [data, setData] = useState(null)        // { items, price }
  const columns = useMemo(() => catalogColumns(meta), [meta])
  const [picked, setPicked] = useState(() => new Set(columns.map(c => c.key)))
  const [writing, setWriting] = useState(false)

  useEffect(() => {
    if (!book?.id) return
    let cancelled = false
    setBusy(true); setErr(null)
    ;(async () => {
      try {
        const items = await loadBookItems(book.id)
        // loadBookItems returns bare rows: a set with no `_components` sums to 0, not null,
        // so components must be attached before anything prices a kit (D-PRICE-48).
        const sumIds = items.filter(i => i.status === 'component_sum').map(i => i.id)
        const comps = sumIds.length ? await loadKitComponentsForItems(sumIds) : []
        const byItem = new Map()
        for (const c of comps) { const a = byItem.get(c.item_id); if (a) a.push(c); else byItem.set(c.item_id, [c]) }
        const enriched = items.map(i => (i.status === 'component_sum' ? { ...i, _components: byItem.get(i.id) || [] } : i))
        const byKey = new Map(enriched.map(i => [i.part_key, i]))
        if (!cancelled) setData({ items: enriched, price: bookPricer(meta, book, k => byKey.get(k) || null) })
      } catch (e) { if (!cancelled) setErr(e.message || String(e)) } finally { if (!cancelled) setBusy(false) }
    })()
    return () => { cancelled = true }
  }, [book, meta])

  const selected = useMemo(() => columns.filter(c => picked.has(c.key)), [columns, picked])
  const stats = useMemo(() => (data ? catalogRows({ items: data.items, sections: meta.sections, columns: [], price: data.price }).stats : null), [data, meta])
  const toggle = (key) => setPicked(p => { const n = new Set(p); if (n.has(key)) n.delete(key); else n.add(key); return n })

  const go = () => {
    if (!data || !selected.length) return
    setWriting(true); setErr(null)
    try {
      const { rows } = catalogRows({ items: data.items, sections: meta.sections, columns: selected, price: data.price })
      downloadBytes(buildCatalogXlsx({ book, columns: selected, rows }), catalogFilename(book, todayIso()), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      onClose()
    } catch (e) { setErr(e.message || String(e)) } finally { setWriting(false) }
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-2xl p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="text-white font-semibold flex items-center gap-2"><FileDown size={16} className="text-skynet-accent" /> Export the catalog — {book?.rev_label}</div>
        <div className="text-[11px] text-gray-500">Internal working copy: every section of the book in effect, one sheet, no letterhead and no terms. A customer&apos;s document is the price list on the Customers tab.</div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Columns</div>
          <div className="flex flex-wrap gap-2">
            {columns.map(c => (
              <label key={c.key} className={`flex items-center gap-1.5 px-2 py-1 rounded border text-xs cursor-pointer ${picked.has(c.key) ? 'border-skynet-accent text-white bg-skynet-accent/10' : 'border-gray-700 text-gray-400 hover:text-white'}`}>
                <input type="checkbox" checked={picked.has(c.key)} onChange={() => toggle(c.key)} /> {c.label}
              </label>
            ))}
          </div>
          <div className="mt-1 flex gap-3 text-[11px] text-gray-500">
            <button onClick={() => setPicked(new Set(columns.map(c => c.key)))} className="hover:text-white">All</button>
            <button onClick={() => setPicked(new Set(['each']))} className="hover:text-white">Each only</button>
          </div>
        </div>
        {busy && <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 size={15} className="animate-spin" /> Reading {book?.rev_label}…</div>}
        {stats && (
          <div className="text-sm text-gray-300">
            {num(stats.priced)} priced parts · {num(stats.sums)} sets/kits · {num(selected.length)} column{selected.length === 1 ? '' : 's'}
            {stats.skipped ? <span className="text-rose-300"> · {num(stats.skipped)} kit{stats.skipped === 1 ? '' : 's'} skipped (a component has no price)</span> : ''}
            {stats.no_price ? <span className="text-gray-500"> · {num(stats.no_price)} without a price, left out</span> : ''}
          </div>
        )}
        {err && <div className="text-rose-300 text-xs">{err}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button onClick={go} disabled={busy || writing || !selected.length} className="px-3 py-1.5 text-sm rounded bg-skynet-accent text-gray-900 font-medium disabled:opacity-50">{writing ? 'Building…' : 'Export XLSX'}</button>
        </div>
      </div>
    </div>
  )
}

export default function PriceCatalog({ book, meta, nextBook, canEdit }) {
  const [view, setView] = useState('catalog')          // catalog | kits
  const [secByTab, setSecByTab] = useState({ catalog: null, kits: null })
  const [items, setItems] = useState([]); const [comps, setComps] = useState([]); const [extra, setExtra] = useState([])
  const [images, setImages] = useState({}); const [sectionImages, setSectionImages] = useState([])
  const [lightbox, setLightbox] = useState(null)
  const [addTarget, setAddTarget] = useState('section'); const [imgBusy, setImgBusy] = useState(false); const [imgError, setImgError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [sidebar, setSidebar] = useState(loadSidebar)
  useEffect(() => { try { localStorage.setItem(SIDEBAR_KEY, JSON.stringify(sidebar)) } catch { /* ignore */ } }, [sidebar])
  const startDrag = (e) => {
    e.preventDefault()
    const startX = e.clientX, startW = sidebar.width
    const onMove = (ev) => setSidebar(s => ({ ...s, width: Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + (ev.clientX - startX))) }))
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }
  const [term, setTerm] = useState('')
  const [hits, setHits] = useState(null)   // search mode when non-null
  const [filter, setFilter] = useState('')
  const [counts, setCounts] = useState(null)   // { bookId, bySection } — section sizes for the search results

  // ── which book the Kits tab reads ───────────────────────────────────────────────
  // The book in effect as soon as it carries kits (Oct 1); until then the scheduled book,
  // with today's Fishbowl list beside it so a rep can see both numbers (D-PRICE-52 F).
  const [sumIds, setSumIds] = useState(null)   // sum-bearing sections of the book in effect
  const [sched, setSched] = useState(null)     // { book, meta, sumSectionIds } of the scheduled book
  useEffect(() => {
    if (!book?.id) return
    let cancelled = false
    loadSumSectionIds(book.id).then(s => { if (!cancelled) setSumIds(s) }).catch(err => { console.error('catalog kit sections', err); if (!cancelled) setSumIds(new Set()) })
    return () => { cancelled = true }
  }, [book?.id])
  useEffect(() => {
    if (!nextBook?.id) return
    let cancelled = false
    Promise.all([loadBookMeta(nextBook.id), loadSumSectionIds(nextBook.id)])
      .then(([m, s]) => { if (!cancelled) setSched({ book: nextBook, meta: m, sumSectionIds: s }) })
      .catch(err => console.error('catalog scheduled book', err))
    return () => { cancelled = true }
  }, [nextBook?.id, nextBook])
  const kits = useMemo(
    () => pickKitsBook(book && meta && sumIds ? { book, meta, sumSectionIds: sumIds } : null, sched),
    [book, meta, sumIds, sched])

  const onKits = view === 'kits'
  const activeBook = onKits ? kits.book : book
  const activeMeta = onKits ? kits.meta : meta
  // The Catalog keeps every section of the book in effect. Kit sections are withdrawn from it
  // only once the Kits tab is reading that same book — otherwise today's 13 Common Sets would
  // vanish from Rev 81's catalog to make room for a tab showing Rev 82.
  const sections = useMemo(() => {
    const all = meta?.sections || []
    if (onKits) return kits.sections
    if (kits.source !== 'current') return all
    const inKits = new Set(kits.sections.map(s => s.id))
    return all.filter(s => !inKits.has(s.id))
  }, [meta, onKits, kits])
  const sectionId = onKits ? secByTab.kits : secByTab.catalog
  const section = sections.find(s => s.id === sectionId) || null
  useEffect(() => {
    setSecByTab(s => ({
      catalog: s.catalog, kits: s.kits,
      [onKits ? 'kits' : 'catalog']: sections.some(x => x.id === (onKits ? s.kits : s.catalog)) ? (onKits ? s.kits : s.catalog) : (sections[0]?.id || null),
    }))
  }, [sections, onKits])
  const pickSection = (id) => setSecByTab(s => ({ ...s, [onKits ? 'kits' : 'catalog']: id }))

  useEffect(() => {
    if (!activeBook?.id || !sectionId) { setItems([]); setComps([]); setExtra([]); return }
    let cancelled = false
    setBusy(true)
    loadSectionItems(activeBook.id, sectionId)
      .then(async ({ items: its, comps: cs }) => {
        if (cancelled) return
        setItems(its); setComps(cs)
        const have = new Set(its.map(i => i.part_key))
        const missing = cs.map(c => c.component_key).filter(k => !have.has(k))
        const ex = missing.length ? await loadItemsByKeys(activeBook.id, missing) : []
        if (!cancelled) setExtra(ex)
        if (onKits) return
        const imgs = await loadPartImages([...its.map(i => i.part_key), ...its.filter(i => i.range_of).map(i => partKey(i.range_of))]).catch(() => ({}))
        if (!cancelled) setImages(imgs)
        const sec = (meta?.sections || []).find(s => s.id === sectionId)
        const si = await loadSectionImages(sec?.source_row).catch(() => [])
        if (!cancelled) setSectionImages(si)
      })
      .catch(err => console.error('catalog section', err))
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [activeBook?.id, sectionId, onKits, meta])

  // Today's Fishbowl list price, only while the Kits tab is showing a future book.
  const [fbPrices, setFbPrices] = useState(null)
  useEffect(() => {
    if (!onKits || !kits.showFishbowl || !items.length) { setFbPrices(null); return }
    let cancelled = false
    loadFbListPrices(items.map(i => i.part_key)).then(m => { if (!cancelled) setFbPrices(m) }).catch(() => { if (!cancelled) setFbPrices({}) })
    return () => { cancelled = true }
  }, [onKits, kits.showFishbowl, items])

  // Book-wide search → a synthetic "results" grid.
  useEffect(() => {
    if (!activeBook?.id) return
    const t = term.trim()
    if (t.length < 2) { setHits(null); return }
    let cancelled = false
    const h = setTimeout(() => {
      searchItems(activeBook.id, t, 200).then(r => { if (!cancelled) setHits(r) }).catch(err => console.error('catalog search', err))
    }, 250)
    return () => { cancelled = true; clearTimeout(h) }
  }, [activeBook?.id, term])
  // Section sizes, read once per book the first time a search runs.
  useEffect(() => {
    if (!activeBook?.id || hits === null || counts?.bookId === activeBook.id) return
    let cancelled = false
    loadSectionItemCounts(activeBook.id).then(c => { if (!cancelled) setCounts({ bookId: activeBook.id, bySection: c }) }).catch(() => {})
    return () => { cancelled = true }
  }, [activeBook?.id, hits, counts?.bookId])
  // Searching the whole book matches SECTION NAMES as well as parts (D-PRICE-52 A).
  const sectionHits = useMemo(() => matchSections(sections, term.trim().length >= 2 ? term : ''), [sections, term])

  const visible = useMemo(() => {
    const f = partKey(filter)
    return f ? items.filter(i => i.part_key.includes(f) || (i.description || '').toUpperCase().includes(filter.toUpperCase())) : items
  }, [items, filter])

  const sectionIndex = Object.fromEntries((activeMeta?.sections || []).map(s => [s.id, s]))
  // Gallery below the grid: the section drawing first, then one card per part with a picture
  // (parts that share one picture — e.g. a range — collapse into a single card).
  const gallery = useMemo(() => {
    const out = []; const seen = new Set()
    for (const si of sectionImages) { if (!seen.has(si.src)) { seen.add(si.src); out.push({ id: si.id, src: si.src, caption: section?.name || 'Section', scope: 'section' }) } }
    for (const it of items) {
      const im = images[it.part_key] || (it.range_of ? images[partKey(it.range_of)] : null)
      if (!im || seen.has(im.src)) continue
      seen.add(im.src); out.push({ id: im.id, src: im.src, caption: it.range_of || it.part_number, scope: 'part' })
    }
    return out
  }, [items, images, sectionImages, section?.name])
  const reloadImages = async () => {
    const imgs = await loadPartImages([...items.map(i => i.part_key), ...items.filter(i => i.range_of).map(i => partKey(i.range_of))]).catch(() => ({}))
    setImages(imgs); setSectionImages(await loadSectionImages(section?.source_row).catch(() => []))
  }
  const onAddFile = async (file) => {
    if (!file) return
    setImgBusy(true); setImgError(null)
    try {
      if (addTarget === 'section') await addImage(file, { scope: 'section', sectionSourceRow: section?.source_row })
      else await addImage(file, { scope: 'part', part: addTarget })
      await reloadImages()
    } catch (e) { setImgError(e.message || String(e)) } finally { setImgBusy(false) }
  }
  const onDelete = async (g) => {
    if (!confirm(`Remove this picture (${g.caption})?`)) return
    setImgBusy(true); setImgError(null)
    try { await deleteImage(g.id); await reloadImages(); setLightbox(null) } catch (e) { setImgError(e.message || String(e)) } finally { setImgBusy(false) }
  }
  const switchView = (v) => { setView(v); setTerm(''); setFilter(''); setHits(null); setLightbox(null); setAddTarget('section'); setImgError(null) }
  const showPictures = !onKits

  return (
    <div className="space-y-3">
      {showExport && meta && book && <ExportDialog book={book} meta={meta} onClose={() => setShowExport(false)} />}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1">
          {VIEWS.map(v => (
            <button key={v.key} onClick={() => switchView(v.key)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm border ${view === v.key ? 'border-skynet-accent text-white bg-skynet-accent/10' : 'border-gray-700 text-gray-400 hover:text-white'}`}>
              <v.icon size={14} /> {v.label}
            </button>
          ))}
        </div>
        {onKits && kits.source === 'scheduled' && (
          <div className="text-xs text-sky-300 flex items-center gap-1.5"><CalendarClock size={13} /> Effective {kits.book.effective_from} — {kits.book.rev_label} · today&apos;s Fishbowl list shown beside it</div>
        )}
        <button onClick={() => setShowExport(true)} disabled={!meta || !book} className="ml-auto inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-600 text-sm text-gray-200 hover:text-white disabled:opacity-40">
          <FileDown size={14} /> Export…
        </button>
      </div>

      {/* Which book the tab reads is decided from the sum-bearing sections of both books, so
          nothing renders until the book in effect has been read — otherwise the grid would
          show the scheduled book for a moment and then swap underneath the rep. */}
      {onKits && (sumIds === null || kits.source === null) ? (
        <div className="bg-gray-800/40 border border-dashed border-gray-700 rounded-xl p-10 text-center text-gray-500">
          <Package size={26} className="mx-auto mb-3 text-gray-600" />
          {sumIds === null ? 'Reading the book…' : <>No kit sections in {book?.rev_label}{nextBook ? `, and none in ${nextBook.rev_label} either` : ' and no scheduled book'}.</>}
        </div>
      ) : (
        <div className="flex gap-0 items-start">
          <aside className={`space-y-3 shrink-0 ${sidebar.open ? '' : 'hidden'}`} style={{ width: sidebar.width }}>
            <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3">
              <Search size={16} className="text-gray-500" />
              <input value={term} onChange={e => setTerm(e.target.value)} placeholder={onKits ? 'Search the kits…' : 'Search the whole book…'} className="flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-gray-500" />
            </div>
            <div className="bg-gray-800/60 border border-gray-700 rounded-xl max-h-[70vh] overflow-auto">
              {sections.map(s => (
                <button key={s.id} onClick={() => { pickSection(s.id); setTerm(''); setFilter(''); setLightbox(null); setAddTarget('section'); setImgError(null) }}
                  className={`w-full text-left px-3 py-2 text-sm flex items-start gap-2 border-b border-gray-800 ${sectionId === s.id && hits === null ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700/60'}`}>
                  <ChevronRight size={14} className={`shrink-0 mt-0.5 ${sectionId === s.id ? 'text-skynet-accent' : 'text-gray-600'}`} />
                  <span className="whitespace-normal break-words leading-snug">{s.name}</span>
                  {s.kind === 'resale' && <span className="ml-auto text-[10px] text-rose-300 shrink-0">resale</span>}
                </button>
              ))}
            </div>
          </aside>
          {sidebar.open && <div onMouseDown={startDrag} title="Drag to resize" className="w-3 shrink-0 cursor-col-resize group flex justify-center"><div className="w-px h-full min-h-[70vh] bg-gray-700 group-hover:bg-skynet-accent" /></div>}
          <button onClick={() => setSidebar(s => ({ ...s, open: !s.open }))} title={sidebar.open ? 'Hide sections' : 'Show sections'} className="shrink-0 mr-3 mt-1 text-gray-500 hover:text-white">{sidebar.open ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</button>

          <section className="min-w-0 flex-1">
            {hits !== null ? (
              <>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-white font-semibold flex items-center gap-2"><Search size={16} className="text-skynet-accent" /> {sectionHits.hits.length ? `${sectionHits.hits.length} section${sectionHits.hits.length === 1 ? '' : 's'} · ` : ''}{hits.length} part{hits.length === 1 ? '' : 's'} for &quot;{term}&quot;</h2>
                  <button onClick={() => setTerm('')} className="text-xs text-gray-400 hover:text-white">Back to sections</button>
                </div>
                {sectionHits.hits.length > 0 && (
                  <div className="mb-4">
                    <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Sections</div>
                    <div className="rounded-xl border border-gray-700 overflow-hidden">
                      {sectionHits.hits.map(s => (
                        <button key={s.id} onClick={() => { pickSection(s.id); setTerm(''); setFilter('') }} className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 border-b border-gray-800 last:border-b-0 text-gray-200 hover:bg-gray-800/60">
                          <Layers size={13} className="text-skynet-accent shrink-0" />
                          <span className="min-w-0 truncate">{s.name}</span>
                          <span className="ml-auto text-xs text-gray-500 shrink-0">{counts?.bookId === activeBook?.id ? `${num(counts.bySection[s.id] || 0)} items` : '…'}</span>
                        </button>
                      ))}
                      {sectionHits.more > 0 && <div className="px-3 py-1.5 text-xs text-gray-500">+{num(sectionHits.more)} more section{sectionHits.more === 1 ? '' : 's'} match &quot;{term}&quot;</div>}
                    </div>
                  </div>
                )}
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Parts</div>
                {hits.length ? (
                  <div className="overflow-auto rounded-xl border border-gray-700">
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-800"><tr className="text-left text-[11px] uppercase tracking-wide text-gray-400"><th className="px-3 py-2">Part</th><th className="px-3 py-2">Description</th><th className="px-3 py-2">Section</th><th className="px-3 py-2 text-right">Each</th></tr></thead>
                      <tbody>
                        {hits.map(h => (
                          <tr key={h.id} className="border-t border-gray-800 hover:bg-gray-800/60 cursor-pointer" onClick={() => { setTerm(''); pickSection(h.section_id); setFilter(h.part_number) }}>
                            <td className="px-3 py-1.5 font-mono text-white">{h.part_number}</td>
                            <td className="px-3 py-1.5 text-gray-300 truncate max-w-md">{h.description || ''}</td>
                            <td className="px-3 py-1.5 text-gray-500 truncate max-w-xs">{sectionIndex[h.section_id]?.name || ''}</td>
                            <td className="px-3 py-1.5 text-right font-mono text-gray-200">{h.status === 'no_price' ? <span className="italic text-gray-500">no price</span> : h.status === 'component_sum' ? <span className="text-sky-300">Σ set</span> : money(h.list_price, 3)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="text-gray-500 text-sm p-6">No part in {activeBook?.rev_label} matches.</div>}
              </>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 mb-3">
                  <h2 className="text-white font-semibold flex items-center gap-2 min-w-0"><Layers size={16} className="text-skynet-accent shrink-0" /><span className="truncate">{section?.name || '—'}</span></h2>
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <span>{visible.length} of {items.length}</span>
                    <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="filter this section" className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs outline-none w-40" />
                  </div>
                </div>
                {section?.header_note && <div className="text-xs text-gray-400 mb-2">{section.header_note}</div>}
                {busy || !activeMeta ? <div className="p-8 text-center"><Loader2 size={22} className="animate-spin text-gray-500 mx-auto" /></div>
                  : <ItemGrid items={visible} comps={comps} extra={extra} meta={activeMeta} book={activeBook} sectionKind={section?.kind} kits={onKits} fbPrices={onKits && kits.showFishbowl ? (fbPrices || {}) : null} />}
                {showPictures && (gallery.length > 0 || canEdit) && (
                  <div className="mt-4">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <div className="text-[11px] uppercase tracking-wide text-gray-500">Pictures in this section{gallery.length ? ' — click to enlarge' : ''}</div>
                      {canEdit && (
                        <div className="flex items-center gap-2 text-xs">
                          <select value={addTarget} onChange={e => setAddTarget(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 outline-none max-w-[220px]">
                            <option value="section">Section picture</option>
                            {items.map(it => <option key={it.id} value={it.part_number}>{it.part_number}{images[it.part_key] ? ' (replace)' : ''}</option>)}
                          </select>
                          <label className={`inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-600 text-gray-200 hover:text-white cursor-pointer ${imgBusy ? 'opacity-50 pointer-events-none' : ''}`}>
                            {imgBusy ? <Loader2 size={13} className="animate-spin" /> : <ImagePlus size={13} />} Add picture
                            <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={e => { onAddFile(e.target.files?.[0]); e.target.value = '' }} />
                          </label>
                        </div>
                      )}
                    </div>
                    {imgError && <div className="mb-2 text-xs text-rose-300">{imgError}</div>}
                    {gallery.length === 0 && <div className="text-xs text-gray-600">No pictures yet.</div>}
                    <div className="flex flex-wrap gap-3">
                      {gallery.map((g, i) => (
                        <div key={g.src + i} className="relative group">
                          <button onClick={() => setLightbox(i)} className="text-left">
                            <div className="w-44 h-36 rounded-lg bg-white/95 p-1 flex items-center justify-center overflow-hidden border border-gray-700 group-hover:border-skynet-accent">
                              <img loading="lazy" src={g.src} alt={g.caption} className="max-w-full max-h-full object-contain" />
                            </div>
                            <div className="mt-1 font-mono text-xs text-gray-300 truncate w-44">{g.caption}{g.scope === 'section' ? <span className="text-gray-600"> · section</span> : ''}</div>
                          </button>
                          {canEdit && <button onClick={() => onDelete(g)} title="Remove picture" className="absolute -top-2 -right-2 hidden group-hover:flex w-6 h-6 rounded-full bg-gray-900 border border-gray-600 text-gray-300 hover:text-rose-300 items-center justify-center"><X size={12} /></button>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {lightbox !== null && <ImageLightbox images={gallery} index={lightbox} onClose={() => setLightbox(null)} onIndex={setLightbox} />}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
