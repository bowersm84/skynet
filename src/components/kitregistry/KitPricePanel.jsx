//
// Kit Registry — read-only Pricing card for a kit SKU (D-PRICE-48).
//
// The registry does not store a kit price. It asks the price book, through the same
// `pricing_get_price` RPC every other surface uses, so there is one source of truth and the
// answer here can never drift from a quote (D-PRICE-46/47). Nothing in this file writes.
//
import { Loader2 } from 'lucide-react'
import {
  getPrice, loadBooks as loadPriceBooks, loadItemsByKeys, partKey, todayIso, money, num,
} from '../../lib/pricing'
import { Empty } from './ui'
import { useAsyncData } from './hooks'

// Families Matt retired in D-PRICE-46 — discontinued, so deliberately not priced.
const RETIRED_FAMILIES = ['Trim Kit', 'Fuel Tank Kit']
function isDiscontinued(sku) {
  return !sku?.is_active || RETIRED_FAMILIES.includes(sku?.family)
}

// One getPrice per BOM line (BOMs run 2–14 lines), in parallel. No bulk book load: the drawer is a
// lookup surface, not the catalog grid.
async function loadKitPricing(sku, bom) {
  const today = todayIso()
  const books = await loadPriceBooks()
  const draft = books.find(b => b.status === 'draft') || null
  const activeId = books.find(b => b.status === 'active')?.id || null

  const [now, next, comps] = await Promise.all([
    getPrice(sku.part_number, null, 1, today).catch(() => null),
    draft?.effective_from ? getPrice(sku.part_number, null, 1, draft.effective_from).catch(() => null) : Promise.resolve(null),
    Promise.all((bom || []).map(async (l) => {
      const part = l.component?.part_number || null
      const price = part ? await getPrice(part, null, 1, today).catch(() => null) : null
      return { line: l, part, price }
    })),
  ])

  // `cost` tags come from one light price_items read over the component keys of the in-effect book —
  // a single request for the whole BOM, so it costs less than the per-line getPrice calls above.
  let costPlus = new Set()
  const keys = comps.map(c => c.part).filter(Boolean).map(partKey)
  if (activeId && keys.length) {
    const rows = await loadItemsByKeys(activeId, keys).catch(() => [])
    costPlus = new Set(rows.filter(r => r.cost_plus).map(r => r.part_key))
  }
  return { now, next, draft, comps, costPlus }
}

function Money({ v }) {
  return v === null || v === undefined
    ? <span className="text-rose-300 text-xs">no price</span>
    : <span className="font-mono">{money(v)}</span>
}

export default function KitPricePanel({ sku, bom }) {
  const discontinued = isDiscontinued(sku)
  const { loading, data, error } = useAsyncData(
    () => (discontinued ? Promise.resolve(null) : loadKitPricing(sku, bom)),
    discontinued ? null : sku.id,
  )

  if (discontinued) return <Empty>Discontinued — not priced.</Empty>
  if (!bom?.length) return <Empty>No BOM on file — nothing to price.</Empty>
  if (loading) return <div className="py-4 text-gray-500 text-sm flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Pricing…</div>
  if (error) return <Empty>{error}</Empty>
  if (!data) return <Empty>No pricing.</Empty>

  const { now, next, draft, comps, costPlus } = data
  const eachOf = (c) => (c.price?.unit_price_2dp ?? null)
  const unpriced = comps.filter(c => eachOf(c) === null)
  const sumExt = comps.reduce((a, c) => {
    const each = eachOf(c)
    return each === null ? a : a + Number(each) * Number(c.line.qty_per_kit || 1)
  }, 0)
  const bookEach = now?.unit_price_2dp ?? null
  const gap = bookEach === null || unpriced.length ? null : Number(bookEach) - sumExt
  const nextEach = next?.unit_price_2dp ?? null
  const pct = bookEach !== null && nextEach !== null && Number(bookEach) !== 0
    ? (Number(nextEach) - Number(bookEach)) / Number(bookEach)
    : null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-6">
        <div>
          <div className="text-gray-500 text-xs uppercase tracking-wide">Book price today</div>
          {bookEach === null
            ? <div className="text-rose-300 text-sm mt-0.5">No book price — {num(unpriced.length)} of {num(comps.length)} components unpriced</div>
            : <div className="text-white text-lg font-mono mt-0.5">{money(bookEach)}{now?.rev_label ? <span className="text-gray-500 text-xs font-sans ml-2">{now.rev_label}</span> : null}</div>}
        </div>
        {draft && (
          <div>
            <div className="text-gray-500 text-xs uppercase tracking-wide">Next book · {draft.rev_label}{draft.effective_from ? ` · ${draft.effective_from}` : ''}</div>
            {nextEach === null
              ? <div className="text-gray-500 text-sm mt-0.5">Not priced in the draft</div>
              : <div className="text-white text-lg font-mono mt-0.5">{money(nextEach)}{pct !== null && <span className={`ml-2 text-xs font-sans ${pct > 0 ? 'text-amber-300' : pct < 0 ? 'text-emerald-300' : 'text-gray-500'}`}>{pct > 0 ? '+' : ''}{(pct * 100).toFixed(1)}%</span>}</div>}
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-700">
        <table className="w-full text-sm">
          <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Component</th>
              <th className="text-left px-3 py-2 font-medium">Description</th>
              <th className="text-right px-3 py-2 font-medium">Qty</th>
              <th className="text-right px-3 py-2 font-medium">Each</th>
              <th className="text-right px-3 py-2 font-medium">Extended</th>
            </tr>
          </thead>
          <tbody>
            {comps.map(({ line, part, price }) => {
              const each = price?.unit_price_2dp ?? null
              const qty = Number(line.qty_per_kit || 1)
              return (
                <tr key={line.id} className="border-t border-gray-800">
                  <td className="px-3 py-2 font-mono text-gray-200 whitespace-nowrap">{part || '—'}
                    {part && costPlus.has(partKey(part)) && <span className="ml-2 px-1.5 py-0.5 rounded bg-gray-700 text-gray-300 text-[10px] font-sans" title="Priced from the latest received purchase cost (D-PRICE-47)">cost</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-300">{line.component?.description || '—'}</td>
                  <td className="px-3 py-2 text-right font-mono text-gray-200">{qty}</td>
                  <td className="px-3 py-2 text-right"><Money v={each} /></td>
                  <td className="px-3 py-2 text-right font-mono text-gray-200">{each === null ? '—' : money(Number(each) * qty)}</td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-gray-700 bg-gray-800/60">
              <td className="px-3 py-2 text-gray-400" colSpan={4}>Σ extended{unpriced.length ? ` · ${num(unpriced.length)} component${unpriced.length === 1 ? '' : 's'} with no price` : ''}</td>
              <td className="px-3 py-2 text-right font-mono text-white">{money(sumExt)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {gap !== null && Math.abs(gap) > 0.01 && (
        <div className="text-xs text-amber-300">
          Σ components is {money(Math.abs(gap))} {gap > 0 ? 'below' : 'above'} the book price — the book rounds each Each to 3 dp before summing, so a small difference is expected.
        </div>
      )}
      <div className="text-[11px] text-gray-500">Read-only — prices come from the price book via pricing_get_price; the Kit Registry stores no price of its own.</div>
    </div>
  )
}
