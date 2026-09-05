//
// Pricing Portal typeaheads — part (book items + Fishbowl products) and customer
// (fb_customers mirror). Both debounce 250 ms and render as a plain list under the
// input so they work inside cards and modals alike.
//
import { useEffect, useRef, useState } from 'react'
import { Search, Loader2, X } from 'lucide-react'
import { searchItems, searchFbProducts, searchCustomers, TIER_LABELS, TIER_COLORS } from '../../lib/pricing'

const DEBOUNCE = 250

function useDebounced(value, ms) {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

export function TierBadge({ tier, size = 'sm' }) {
  const t = tier || 'none'
  const cls = size === 'lg' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-xs'
  return <span className={`inline-block rounded font-medium ${cls} ${TIER_COLORS[t] || TIER_COLORS.none}`}>{TIER_LABELS[t] || t}</span>
}

// onPick({ kind: 'item' | 'product', part_number, ... })
export function PartTypeahead({ bookId, value, onPick, onClear, placeholder = 'Part number, description, NSN, xref…', autoFocus = false }) {
  const [term, setTerm] = useState(value || '')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [items, setItems] = useState([])
  const [products, setProducts] = useState([])
  const debounced = useDebounced(term, DEBOUNCE)
  const boxRef = useRef(null)

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setTerm(value || '') }, [value])
  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!bookId || debounced.trim().length < 2) { setItems([]); setProducts([]); return }
    setBusy(true)
    Promise.all([searchItems(bookId, debounced), searchFbProducts(debounced)])
      .then(([its, prods]) => {
        if (cancelled) return
        const inBook = new Set(its.map(i => i.part_key))
        setItems(its)
        setProducts(prods.filter(p => !inBook.has(String(p.product_num).replace(/\s+/g, '').toUpperCase())))
      })
      .catch(err => console.error('part typeahead', err))
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [bookId, debounced])
  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc); return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const pick = (row) => { setOpen(false); setTerm(row.part_number); onPick?.(row) }

  return (
    <div ref={boxRef} className="relative">
      <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3">
        <Search size={16} className="text-gray-500 shrink-0" />
        <input
          autoFocus={autoFocus}
          value={term}
          onChange={e => { setTerm(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={e => { if (e.key === 'Enter' && items[0]) pick({ kind: 'item', ...items[0] }); if (e.key === 'Escape') setOpen(false) }}
          placeholder={placeholder}
          className="flex-1 bg-transparent py-2 text-sm font-mono outline-none placeholder:font-sans placeholder:text-gray-500"
        />
        {busy && <Loader2 size={14} className="animate-spin text-gray-500" />}
        {term && !busy && <button onClick={() => { setTerm(''); setItems([]); setProducts([]); onClear?.() }} className="text-gray-500 hover:text-gray-300"><X size={14} /></button>}
      </div>
      {open && (items.length > 0 || products.length > 0) && (
        <div className="absolute z-30 mt-1 w-full max-h-80 overflow-auto bg-gray-800 border border-gray-700 rounded-lg shadow-xl">
          {items.map(i => (
            <button key={i.id} onClick={() => pick({ kind: 'item', ...i })} className="w-full text-left px-3 py-2 hover:bg-gray-700 flex items-baseline gap-3">
              <span className="font-mono text-sm text-white shrink-0">{i.part_number}</span>
              <span className="text-xs text-gray-400 truncate">{i.description || ''}</span>
              {i.status === 'no_price' && <span className="ml-auto text-xs text-amber-400 shrink-0">no price</span>}
              {i.status === 'component_sum' && <span className="ml-auto text-xs text-sky-300 shrink-0">set</span>}
            </button>
          ))}
          {products.length > 0 && (
            <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wide text-gray-500 border-t border-gray-700">In Fishbowl, not in the price book</div>
          )}
          {products.map(p => (
            <button key={p.fb_product_id} onClick={() => pick({ kind: 'product', part_number: p.product_num, description: p.description, fb_list_price: p.list_price })} className="w-full text-left px-3 py-2 hover:bg-gray-700 flex items-baseline gap-3">
              <span className="font-mono text-sm text-gray-300 shrink-0">{p.product_num}</span>
              <span className="text-xs text-gray-500 truncate">{p.description || ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// onPick(customerRow from v_customer_pricing_current)
export function CustomerTypeahead({ value, onPick, onClear, includeInactive = false, placeholder = 'Customer name or number…' }) {
  const [term, setTerm] = useState(value || '')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rows, setRows] = useState([])
  const debounced = useDebounced(term, DEBOUNCE)
  const boxRef = useRef(null)

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setTerm(value || '') }, [value])
  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (debounced.trim().length < 2) { setRows([]); return }
    setBusy(true)
    searchCustomers(debounced, { includeInactive })
      .then(r => { if (!cancelled) setRows(r) })
      .catch(err => console.error('customer typeahead', err))
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [debounced, includeInactive])
  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc); return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const pick = (row) => { setOpen(false); setTerm(row.name_clean); onPick?.(row) }

  return (
    <div ref={boxRef} className="relative">
      <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3">
        <Search size={16} className="text-gray-500 shrink-0" />
        <input
          value={term}
          onChange={e => { setTerm(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={e => { if (e.key === 'Enter' && rows[0]) pick(rows[0]); if (e.key === 'Escape') setOpen(false) }}
          placeholder={placeholder}
          className="flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-gray-500"
        />
        {busy && <Loader2 size={14} className="animate-spin text-gray-500" />}
        {term && !busy && <button onClick={() => { setTerm(''); setRows([]); onClear?.() }} className="text-gray-500 hover:text-gray-300"><X size={14} /></button>}
      </div>
      {open && rows.length > 0 && (
        <div className="absolute z-30 mt-1 w-full max-h-80 overflow-auto bg-gray-800 border border-gray-700 rounded-lg shadow-xl">
          {rows.map(r => (
            <button key={r.fb_customer_id} onClick={() => pick(r)} className="w-full text-left px-3 py-2 hover:bg-gray-700 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className={`text-sm truncate ${r.is_active ? 'text-white' : 'text-gray-500 line-through'}`}>{r.name_clean}</div>
                <div className="text-xs text-gray-500 font-mono">#{r.customer_number || r.fb_customer_id}{r.salesman ? ` · ${r.salesman}` : ''}</div>
              </div>
              <TierBadge tier={r.tier} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
