//
// Pricing Portal — Catalog tab. Section list on the left, the section's item
// grid on the right with Each + the section ladder columns (+ Premier where a
// part carries it). Prices come from the client-side engine mirror so a
// section renders from one price_items query; the Lookup tab's RPC result is
// the authority if the two ever disagree.
//
import { useEffect, useMemo, useState } from 'react'
import { Loader2, Search, ChevronRight, Layers, PanelLeftClose, PanelLeftOpen, ImagePlus, X } from 'lucide-react'
import { loadSectionItems, loadItemsByKeys, loadPartImages, loadSectionImages, addImage, deleteImage, searchItems, columnPrice, itemColumns, money, round2, partKey } from '../../lib/pricing'
import ImageLightbox from './ImageLightbox'

// Sidebar width is a per-browser preference (B.1: full section names, drag to resize, collapse).
const SIDEBAR_KEY = 'skynet.pricing.catalog_sidebar'
const SIDEBAR_MIN = 220, SIDEBAR_MAX = 720, SIDEBAR_DEFAULT = 380
function loadSidebar() {
  try { const s = JSON.parse(localStorage.getItem(SIDEBAR_KEY) || '{}'); return { width: Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, s.width || SIDEBAR_DEFAULT)), open: s.open !== false } } catch { return { width: SIDEBAR_DEFAULT, open: true } }
}

function ItemGrid({ items, comps, extra, meta, book, sectionKind }) {
  // Sets resolve their components across the whole book (`extra` = component items fetched
  // by key — they live in other sections); anything still missing renders '—', never a partial sum.
  const byKey = useMemo(() => Object.fromEntries([...extra, ...items].map(i => [i.part_key, i])), [items, extra])
  const compsByItem = useMemo(() => {
    const m = {}
    for (const c of comps) (m[c.item_id] ||= []).push(c)
    return m
  }, [comps])
  const enriched = useMemo(() => items.map(i => ({ ...i, _components: compsByItem[i.id] || [] })), [items, compsByItem])

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
          </tr>
        </thead>
        <tbody>
          {enriched.map(it => (
            <tr key={it.id} className={`border-t border-gray-800 hover:bg-gray-800/60 ${it.status === 'no_price' ? 'text-gray-500' : ''}`}>
              <td className="px-3 py-1.5 font-mono text-white whitespace-nowrap">
                {it.part_number}
                {it.status === 'component_sum' && <span className="ml-2 text-[10px] text-sky-300">SET</span>}
                {it.range_of && <span className="ml-2 text-[10px] text-gray-500" title={`from range ${it.range_of}`}>range</span>}
              </td>
              <td className="px-3 py-1.5 text-gray-300 max-w-md truncate" title={it.description || ''}>{it.description || ''}</td>
              <td className="px-2 py-1.5 text-center text-xs">{it.dfar ? <span className="text-emerald-300">Y</span> : <span className="text-gray-600">N</span>}</td>
              {sectionKind !== 'resale' && <td className="px-2 py-1.5 text-center text-xs text-gray-400">{it.rule_code || ''}</td>}
              {columns.map(c => {
                if (it.status === 'no_price') return <td key={c.key} className="px-3 py-1.5 text-right text-xs italic">{c.key === 'each' ? 'No pricing available' : ''}</td>
                const has = c.key === 'each' || (c.key === 'premier' ? it.has_premier : (meta.ladders[it.ladder_code]?.columns || []).some(x => x.key === c.key))
                if (!has) return <td key={c.key} className="px-3 py-1.5 text-right text-gray-700">·</td>
                const v = columnPrice(it, c.key, meta, book, k => byKey[k] || null)
                return <td key={c.key} className={`px-3 py-1.5 text-right font-mono ${c.kind === 'tier' ? 'text-violet-200' : 'text-gray-200'}`}>{v === null ? '—' : money(round2(v))}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function PriceCatalog({ book, meta, canEdit }) {
  const [sectionId, setSectionId] = useState(null)
  const [items, setItems] = useState([]); const [comps, setComps] = useState([]); const [extra, setExtra] = useState([])
  const [images, setImages] = useState({}); const [sectionImages, setSectionImages] = useState([])
  const [lightbox, setLightbox] = useState(null)
  const [addTarget, setAddTarget] = useState('section'); const [imgBusy, setImgBusy] = useState(false); const [imgError, setImgError] = useState(null)
  const [busy, setBusy] = useState(false)
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

  const sections = useMemo(() => meta?.sections || [], [meta])
  const section = sections.find(s => s.id === sectionId) || null
  useEffect(() => { if (!sectionId && sections.length) setSectionId(sections[0].id) }, [sections, sectionId])

  useEffect(() => {
    if (!book?.id || !sectionId) return
    let cancelled = false
    setBusy(true)
    loadSectionItems(book.id, sectionId)
      .then(async ({ items: its, comps: cs }) => {
        if (cancelled) return
        setItems(its); setComps(cs)
        const have = new Set(its.map(i => i.part_key))
        const missing = cs.map(c => c.component_key).filter(k => !have.has(k))
        const ex = missing.length ? await loadItemsByKeys(book.id, missing) : []
        if (!cancelled) setExtra(ex)
        const imgs = await loadPartImages([...its.map(i => i.part_key), ...its.filter(i => i.range_of).map(i => partKey(i.range_of))]).catch(() => ({}))
        if (!cancelled) setImages(imgs)
        const sec = sections.find(s => s.id === sectionId)
        const si = await loadSectionImages(sec?.source_row).catch(() => [])
        if (!cancelled) setSectionImages(si)
      })
      .catch(err => console.error('catalog section', err))
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [book?.id, sectionId, sections])

  // Book-wide search → a synthetic "results" grid.
  useEffect(() => {
    if (!book?.id) return
    const t = term.trim()
    if (t.length < 2) { setHits(null); return }
    let cancelled = false
    const h = setTimeout(() => {
      searchItems(book.id, t, 200).then(r => { if (!cancelled) setHits(r) }).catch(err => console.error('catalog search', err))
    }, 250)
    return () => { cancelled = true; clearTimeout(h) }
  }, [book?.id, term])

  const visible = useMemo(() => {
    const f = partKey(filter)
    return f ? items.filter(i => i.part_key.includes(f) || (i.description || '').toUpperCase().includes(filter.toUpperCase())) : items
  }, [items, filter])

  const sectionIndex = Object.fromEntries(sections.map(s => [s.id, s]))
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

  return (
    <div className="flex gap-0 items-start">
      <aside className={`space-y-3 shrink-0 ${sidebar.open ? '' : 'hidden'}`} style={{ width: sidebar.width }}>
        <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3">
          <Search size={16} className="text-gray-500" />
          <input value={term} onChange={e => setTerm(e.target.value)} placeholder="Search the whole book…" className="flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-gray-500" />
        </div>
        <div className="bg-gray-800/60 border border-gray-700 rounded-xl max-h-[70vh] overflow-auto">
          {sections.map(s => (
            <button key={s.id} onClick={() => { setSectionId(s.id); setTerm(''); setFilter(''); setLightbox(null); setAddTarget('section'); setImgError(null) }}
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
              <h2 className="text-white font-semibold flex items-center gap-2"><Search size={16} className="text-skynet-accent" /> {hits.length} match{hits.length === 1 ? '' : 'es'} for "{term}"</h2>
              <button onClick={() => setTerm('')} className="text-xs text-gray-400 hover:text-white">Back to sections</button>
            </div>
            {hits.length ? (
              <div className="overflow-auto rounded-xl border border-gray-700">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-800"><tr className="text-left text-[11px] uppercase tracking-wide text-gray-400"><th className="px-3 py-2">Part</th><th className="px-3 py-2">Description</th><th className="px-3 py-2">Section</th><th className="px-3 py-2 text-right">Each</th></tr></thead>
                  <tbody>
                    {hits.map(h => (
                      <tr key={h.id} className="border-t border-gray-800 hover:bg-gray-800/60 cursor-pointer" onClick={() => { setTerm(''); setSectionId(h.section_id); setFilter(h.part_number) }}>
                        <td className="px-3 py-1.5 font-mono text-white">{h.part_number}</td>
                        <td className="px-3 py-1.5 text-gray-300 truncate max-w-md">{h.description || ''}</td>
                        <td className="px-3 py-1.5 text-gray-500 truncate max-w-xs">{sectionIndex[h.section_id]?.name || ''}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-gray-200">{h.status === 'no_price' ? <span className="italic text-gray-500">no price</span> : money(h.list_price, 3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="text-gray-500 text-sm p-6">Nothing in {book?.rev_label} matches.</div>}
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
            {busy ? <div className="p-8 text-center"><Loader2 size={22} className="animate-spin text-gray-500 mx-auto" /></div>
                  : <ItemGrid items={visible} comps={comps} extra={extra} meta={meta} book={book} sectionKind={section?.kind} />}
            {(gallery.length > 0 || canEdit) && (
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
  )
}
