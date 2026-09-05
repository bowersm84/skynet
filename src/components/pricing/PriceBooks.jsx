//
// Pricing Portal — Price Books (S11 C3, D-PRICE-15/16/22). Admin: list books, open one,
// clone (label / effective date / % uplift), edit a DRAFT (items, sections, rules,
// bulk uplift), diff against another book, schedule / unschedule / publish, export the
// Fishbowl Products CSV. Non-admins see the list and the diff, read-only.
//
import { useEffect, useMemo, useState } from 'react'
import { Loader2, Copy, CalendarClock, Undo2, Percent, GitCompare, FileDown, Plus, Trash2, Save, AlertTriangle, BookOpen, Check } from 'lucide-react'
import {
  loadBooks, loadBookMeta, loadBookItems, cloneBook, publishBook, unpublishBook, upliftBook, upsertItem, deleteItem, upsertRule, upsertSection,
  diffBooks, productsCsv, money, num,
} from '../../lib/pricing'
import { downloadBytes } from '../../lib/priceListDoc'
import { PartTypeahead } from './PricingTypeaheads'

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

function ItemRow({ it, meta, editable, onSave, onDelete }) {
  const [v, setV] = useState(it); const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false)
  useEffect(() => { setV(it); setDirty(false) }, [it])
  const set = (k, val) => { setV(x => ({ ...x, [k]: val })); setDirty(true) }
  const save = async () => { setBusy(true); try { await onSave({ ...v, list_price: v.list_price === '' ? null : v.list_price, status: v.status === 'component_sum' ? 'component_sum' : (v.list_price === '' || v.list_price === null ? 'no_price' : 'priced') }); setDirty(false) } finally { setBusy(false) } }
  const cell = 'bg-transparent border-b border-transparent focus:border-skynet-accent outline-none w-full'
  return (
    <tr className={`border-t border-gray-800 ${dirty ? 'bg-amber-950/20' : ''}`}>
      <td className="px-2 py-1 font-mono text-white whitespace-nowrap">{editable ? <input value={v.part_number} onChange={e => set('part_number', e.target.value)} className={`${cell} font-mono`} /> : it.part_number}{it.status === 'component_sum' && <span className="ml-1 text-[10px] text-sky-300">SET</span>}</td>
      <td className="px-2 py-1 text-gray-300 min-w-[260px]">{editable ? <input value={v.description || ''} onChange={e => set('description', e.target.value)} className={cell} /> : it.description}</td>
      <td className="px-2 py-1 text-right font-mono">{editable && it.status !== 'component_sum' ? <input type="number" step="0.001" value={v.list_price ?? ''} onChange={e => set('list_price', e.target.value)} className={`${cell} text-right w-24`} /> : it.status === 'component_sum' ? <span className="text-gray-500">Σ</span> : it.list_price === null ? <span className="text-gray-500 italic text-xs">no price</span> : money(it.list_price, 3)}</td>
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
  const [sectionId, setSectionId] = useState(null)
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null); const [flash, setFlash] = useState(null)
  const [showClone, setShowClone] = useState(false)
  const [view, setView] = useState('items')          // items | rules | diff
  const [diffAgainst, setDiffAgainst] = useState(null); const [diffRows, setDiffRows] = useState(null)
  const [uplift, setUplift] = useState('15'); const [pubDate, setPubDate] = useState(OCT1)
  const [newSection, setNewSection] = useState('')

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
    try { const [m, its] = await Promise.all([loadBookMeta(bookId), loadBookItems(bookId)]); setMeta(m); setItems(its); setSectionId(s => s && m.sections.some(x => x.id === s) ? s : m.sections[0]?.id || null) }
    catch (e) { setError(e.message || String(e)) } finally { setBusy(false) }
  }
  useEffect(() => { loadBook() }, [bookId]) // eslint-disable-line react-hooks/exhaustive-deps
  const note = (t) => { setFlash(t); setTimeout(() => setFlash(null), 2500) }
  const run = async (fn, ok) => { setBusy(true); setError(null); try { await fn(); if (ok) note(ok) } catch (e) { setError(e.message || String(e)) } finally { setBusy(false) } }

  const sectionItems = useMemo(() => items.filter(i => i.section_id === sectionId), [items, sectionId])
  const counts = useMemo(() => ({ items: items.length, priced: items.filter(i => i.status === 'priced').length, noprice: items.filter(i => i.status === 'no_price').length }), [items])
  const runDiff = async (otherId) => {
    setDiffAgainst(otherId); setDiffRows(null)
    if (!otherId) return
    const base = await loadBookItems(otherId); setDiffRows(diffBooks(base, items))
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
                <td className="pr-4 py-1.5 text-white">{b.rev_label}</td>
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
              </>
            )}
            {canEdit && book.status === 'scheduled' && <button onClick={() => { if (confirm(`Take ${book.rev_label} back to draft?`)) run(async () => { await unpublishBook(book.id); await refreshBooks() }, 'Back to draft') }} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-600 text-gray-200 text-xs hover:text-white"><Undo2 size={13} /> Unschedule (edit)</button>}
            <button onClick={() => downloadBytes(new TextEncoder().encode(productsCsv(items)), `Fishbowl_Products_${book.rev_label.replace(/[^A-Za-z0-9]+/g, '_')}.csv`, 'text/csv')} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-600 text-gray-200 text-xs hover:text-white" title="Fishbowl Products import (ProductNumber, Price) — interim write-back (D-PRICE-22)"><FileDown size={13} /> Fishbowl Products CSV</button>
          </div>
          {error && <div className="mb-3 flex items-center gap-2 text-sm text-rose-300 bg-rose-950/40 border border-rose-900 rounded px-3 py-2"><AlertTriangle size={14} /> {error}</div>}
          {flash && <div className="mb-3 flex items-center gap-2 text-sm text-emerald-300"><Check size={14} /> {flash}</div>}
          {book.status === 'scheduled' && <div className="mb-3 text-xs text-sky-300 bg-sky-950/40 border border-sky-900 rounded px-3 py-2">Scheduled — activates by date on {book.effective_from}, no deploy needed. To change anything, Unschedule first (D-PRICE-16).</div>}
          {book.status === 'active' && canEdit && <div className="mb-3 text-xs text-gray-400">The active book is read-only. Clone it to make changes, then schedule the clone.</div>}

          <nav className="flex gap-1 border-b border-gray-700 mb-3">
            {[['items', 'Sections & items'], ['rules', 'Rules & ladders'], ['diff', 'Diff']].map(([k, l]) => <button key={k} onClick={() => setView(k)} className={`px-3 py-1.5 text-sm border-b-2 -mb-px ${view === k ? 'border-skynet-accent text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>{l}</button>)}
          </nav>

          {busy && <div className="p-6 text-center"><Loader2 size={20} className="animate-spin text-gray-500 mx-auto" /></div>}

          {!busy && view === 'items' && meta && (
            <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
              <aside>
                <div className="max-h-[60vh] overflow-auto border border-gray-700 rounded-lg">
                  {meta.sections.map(s => <button key={s.id} onClick={() => setSectionId(s.id)} className={`w-full text-left px-3 py-1.5 text-xs border-b border-gray-800 ${sectionId === s.id ? 'bg-gray-700 text-white' : 'text-gray-300 hover:bg-gray-700/60'}`}>{s.name}{s.kind === 'resale' ? <span className="ml-1 text-rose-300">· resale</span> : ''}</button>)}
                </div>
                {editable && (
                  <div className="mt-2 flex gap-1">
                    <input value={newSection} onChange={e => setNewSection(e.target.value)} placeholder="New section name" className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs outline-none" />
                    <button onClick={() => { if (!newSection.trim()) return; run(async () => { await upsertSection(book.id, { name: newSection.trim(), sort: (meta.sections.length ? Math.max(...meta.sections.map(s => s.sort)) : 0) + 1 }); setNewSection(''); await loadBook() }, 'Section added') }} className="px-2 py-1 rounded border border-gray-600 text-gray-200 text-xs hover:text-white"><Plus size={12} /></button>
                  </div>
                )}
              </aside>
              <div className="min-w-0">
                <div className="overflow-auto border border-gray-700 rounded-lg max-h-[60vh]">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-800 sticky top-0"><tr className="text-left text-[11px] uppercase tracking-wide text-gray-400"><th className="px-2 py-2">Part</th><th className="px-2 py-2">Description</th><th className="px-2 py-2 text-right">Each</th><th className="px-2 py-2 text-center">Rule</th><th className="px-2 py-2 text-center">Ladder</th><th className="px-2 py-2 text-center">Premier</th><th className="px-2 py-2 text-center">DFAR</th><th></th></tr></thead>
                    <tbody>
                      {sectionItems.map(it => <ItemRow key={it.id} it={it} meta={meta} editable={editable} onSave={(v) => run(async () => { await upsertItem(book.id, { ...v, section_id: sectionId }); await loadBook() }, `${v.part_number} saved`)} onDelete={(x) => { if (confirm(`Remove ${x.part_number} from ${book.rev_label}?`)) run(async () => { await deleteItem(book.id, x.id); await loadBook() }, 'Removed') }} />)}
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
                            <td className="px-2 py-1 text-right font-mono text-gray-400">{d.from?.list_price != null ? money(d.from.list_price, 3) : ''}</td>
                            <td className="px-2 py-1 text-right font-mono text-white">{d.to?.list_price != null ? money(d.to.list_price, 3) : ''}</td>
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
