// StockLevelsTab — S13 D-FBINV-03. Armory › Fishbowl Inventory › Stock Levels.
// Every Fishbowl part classed Product (D-FBINV-01): on hand, allocated, available and on order
// from the bridge's 5-minute mirror; Fishbowl's average cost from the nightly valuation read.
// Read-only. One reading with the Reports module: both read v_report_fb_stock_on_hand.
// Exports: CSV (the registry's columns) and Excel (D-FBINV-04) — the rows on screen, every one.
// Layout fits the Armory's max-w-7xl content box at 1280 px: part numbers wrap, descriptions
// truncate (full text on hover), the rule's minimum rides in the Reorder cell, flags stack.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Search, RefreshCw, Loader2, Download, AlertTriangle, Clock, ArrowUp, ArrowDown, LayoutGrid, FileSpreadsheet } from 'lucide-react'
import { canViewFbInventory, canExportFbInventory } from '../../lib/roles'
import { formatDateTime, formatAge } from '../../lib/fishbowl'
import { toCsv, downloadCsv, reportFilename } from '../../lib/reports'
import {
  STOCK_FILTERS, filterStockRows, stockFilterCounts, sortRows, stockTotals, parseFlags, isStale, freshness, reorderView,
} from '../../lib/fbStock'
import { buildStockXlsx, stockXlsxFilename, todayIso, XLSX_MIME } from '../../lib/fbStockExport'
import { downloadBytes } from '../../lib/priceListDoc'
import { loadStockLevels, STOCK_CSV_COLUMNS } from './fbInventoryData'

const PAGE = 250

const fmtQty = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }))
const fmtCost = (v) => (v === null || v === undefined ? '—' : `$${Number(v).toFixed(4)}`)
const fmtMoney = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' }))

const COLUMNS = [
  { key: 'part_number', label: 'Part #', align: 'left' },
  { key: 'description', label: 'Description', align: 'left' },
  { key: 'on_hand', label: 'On Hand', align: 'right' },
  { key: 'allocated', label: 'Allocated', align: 'right' },
  { key: 'available', label: 'Available', align: 'right' },
  { key: 'on_order', label: 'On Order', align: 'right' },
  { key: 'avg_cost', label: 'Avg Cost', align: 'right' },
  { key: 'est_value', label: 'Est. Value', align: 'right' },
  { key: 'reorder_status', label: 'Reorder', align: 'left' },
  { key: 'flags', label: 'Flags', align: 'left', sortable: false },
]

const FLAG_CHIPS = {
  zero_cost: { label: '$0 cost', tone: 'bg-amber-900/40 text-amber-300', title: 'Fishbowl holds this part at a $0.00 average cost — its value is understated here and in the month-end.' },
  inactive: { label: 'Inactive', tone: 'bg-gray-700 text-gray-400', title: 'The part is inactive in Fishbowl.' },
  count_first: { label: 'Count first', tone: 'bg-sky-900/40 text-sky-300', title: '100,000+ pieces — count before trusting the value.' },
  nightly_qty: { label: 'Nightly qty', tone: 'bg-gray-700 text-gray-300', title: 'No 5-minute row yet; on hand is last night\u2019s tag quantity.' },
}

export default function StockLevelsTab({ profile }) {
  const canView = canViewFbInventory(profile)
  const canExport = canExportFbInventory(profile)

  const [rows, setRows] = useState([])
  const [sync, setSync] = useState(null)
  const [unclassified, setUnclassified] = useState({ count: 0, parts: [] })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('in_stock')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ key: 'est_value', dir: 'desc' })
  const [showAll, setShowAll] = useState(false)

  // Silent refresh keeps the table on screen while the data swaps (RM Forecast pattern).
  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true)
    setError('')
    try {
      const data = await loadStockLevels()
      setRows(data.rows)
      setSync(data.sync)
      setUnclassified(data.unclassified)
    } catch (e) {
      console.error('Stock Levels load failed:', e)
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { if (canView) load() }, [canView, load])
  useEffect(() => { setShowAll(false) }, [filter, search, sort])

  const counts = useMemo(() => stockFilterCounts(rows, search), [rows, search])
  const filtered = useMemo(() => sortRows(filterStockRows(rows, { filter, search }), sort.key, sort.dir), [rows, filter, search, sort])
  const totals = useMemo(() => stockTotals(filtered), [filtered])
  const shown = showAll ? filtered : filtered.slice(0, PAGE)
  const fresh = freshness(sync)

  const toggleSort = (key) => setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: ['part_number', 'description', 'reorder_status'].includes(key) ? 'asc' : 'desc' }))

  const exportCsv = () => {
    const csv = toCsv(filtered, STOCK_CSV_COLUMNS)
    downloadCsv(csv, reportFilename('fb-stock-on-hand'))
  }

  const exportXlsx = () => {
    try {
      const view = STOCK_FILTERS.find(f => f.key === filter)?.label || filter
      const col = COLUMNS.find(c => c.key === sort.key)?.label || sort.key
      const bytes = buildStockXlsx({ rows: filtered, viewLabel: `${view}, sorted by ${col} ${sort.dir === 'asc' ? 'ascending' : 'descending'}`, search, sync })
      downloadBytes(bytes, stockXlsxFilename(todayIso()), XLSX_MIME)
    } catch (e) {
      console.error('Stock Levels Excel export failed:', e)
      setError(`Excel export failed: ${e?.message || String(e)}`)
    }
  }

  if (!canView) return null

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2"><LayoutGrid size={18} /> Stock Levels</h2>
          <p className="text-sm text-gray-500">Every Fishbowl part classed Product. Quantities refresh every 5 minutes from Fishbowl; average cost is read nightly.</p>
        </div>
        <div className="flex items-center gap-2">
          {canExport && (
            <>
              <button
                onClick={exportXlsx}
                disabled={loading || filtered.length === 0}
                title="The rows on screen — every one, in this order — as an Excel workbook"
                className="inline-flex items-center gap-2 px-3 py-2 bg-gray-800 border border-gray-700 hover:border-gray-500 text-gray-200 text-sm rounded-lg disabled:opacity-50"
              >
                <FileSpreadsheet size={15} /> Excel
              </button>
              <button
                onClick={exportCsv}
                disabled={loading || filtered.length === 0}
                className="inline-flex items-center gap-2 px-3 py-2 bg-gray-800 border border-gray-700 hover:border-gray-500 text-gray-200 text-sm rounded-lg disabled:opacity-50"
              >
                <Download size={15} /> CSV
              </button>
            </>
          )}
          <button
            onClick={() => load(true)}
            disabled={loading || refreshing}
            className="inline-flex items-center gap-2 px-3 py-2 bg-gray-800 border border-gray-700 hover:border-gray-500 text-gray-200 text-sm rounded-lg disabled:opacity-50"
          >
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      <div className={`text-xs flex items-center gap-2 ${fresh.amber ? 'text-amber-300' : 'text-gray-500'}`}>
        <Clock size={13} />
        Fishbowl inventory as of {formatDateTime(fresh.inventoryAt)}
        {fresh.ageMs !== null && ` (${formatAge(Math.round(fresh.ageMs / 1000))} ago)`}
        {' · refreshed every 5 min · costs as of '}{formatDateTime(fresh.valuationAt)}
        {fresh.amber && ' · the bridge may be behind'}
      </div>

      {unclassified.count > 0 && (
        <div className="flex items-start gap-2 text-sm bg-amber-900/10 border border-amber-800/40 rounded-lg px-3 py-2">
          <AlertTriangle size={15} className="text-amber-400 mt-0.5 flex-shrink-0" />
          <span className="text-amber-200">
            {unclassified.count} Fishbowl part{unclassified.count === 1 ? ' has' : 's have'} stock but no valuation class, so {unclassified.count === 1 ? 'it is' : 'they are'} left out of Stock Levels and the month-end until classed in Fishbowl:{' '}
            <span className="font-mono text-amber-100">{unclassified.parts.slice(0, 12).join(', ')}{unclassified.count > 12 ? `, +${unclassified.count - 12} more` : ''}</span>
          </span>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[16rem] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Part # or description"
            className="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
          />
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {STOCK_FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
                filter === f.key ? 'bg-skynet-accent/20 border-skynet-accent text-skynet-accent' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              {f.label} <span className="opacity-70">{(counts[f.key] || 0).toLocaleString()}</span>
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-300 bg-red-900/20 border border-red-800/50 rounded-lg px-3 py-2">Could not load Stock Levels: {error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-gray-400"><Loader2 size={18} className="animate-spin" /> Loading Fishbowl inventory…</div>
      ) : (
        <>
          <div className="text-xs text-gray-400" title="Est. value = on hand × Fishbowl average cost (nightly). An estimate for the screen — the month-end valuation is frozen separately.">
            {totals.parts.toLocaleString()} part{totals.parts === 1 ? '' : 's'} · est. value {fmtMoney(totals.value)}
            {totals.zeroCost > 0 && <span className="text-amber-300"> · {totals.zeroCost.toLocaleString()} at $0 cost</span>}
          </div>
          <div className="overflow-x-auto rounded-lg border border-gray-700">
            <table className="w-full text-sm">
              <thead className="bg-gray-800 text-gray-400 uppercase text-xs">
                <tr>
                  {COLUMNS.map(c => (
                    <th key={c.key} className={`px-2 py-2.5 whitespace-nowrap ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                      {c.sortable === false ? c.label : (
                        <button onClick={() => toggleSort(c.key)} className="inline-flex items-center gap-1 uppercase hover:text-white">
                          {c.label}
                          {sort.key === c.key && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                        </button>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {shown.length === 0 ? (
                  <tr><td colSpan={COLUMNS.length} className="px-3 py-10 text-center text-gray-500">No parts match.</td></tr>
                ) : shown.map(r => {
                  const stale = isStale(r.inventory_as_of, fresh.inventoryAt)
                  const flags = parseFlags(r.flags)
                  const qtyTone = stale ? 'text-gray-500' : 'text-white'
                  const rv = r.reorder_status ? reorderView({ is_active: r.reorder_status !== 'inactive rule', alert_state: r.reorder_status, min_qty: r.min_qty }, r) : null
                  return (
                    <tr key={r.part_number} className="bg-gray-900 hover:bg-gray-800/70">
                      <td className="px-2 py-2 font-mono text-gray-200 max-w-[11rem] break-words">
                        {r.part_number}
                        {stale && (
                          <span title={`Fishbowl snapshot ${formatDateTime(r.inventory_as_of)} — older than the bridge's last cycle`}>
                            <Clock size={12} className="inline ml-1 text-gray-500" />
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-gray-400 max-w-[13rem] truncate" title={r.description || ''}>{r.description || '—'}</td>
                      <td className={`px-2 py-2 text-right font-mono whitespace-nowrap ${qtyTone}`}>{fmtQty(r.on_hand)}</td>
                      <td className="px-2 py-2 text-right font-mono whitespace-nowrap text-gray-400">{fmtQty(r.allocated)}</td>
                      <td className={`px-2 py-2 text-right font-mono whitespace-nowrap ${Number(r.available) < 0 ? 'text-amber-300' : 'text-gray-300'}`}>{fmtQty(r.available)}</td>
                      <td className="px-2 py-2 text-right font-mono whitespace-nowrap text-gray-400">{Number(r.on_order) > 0 ? fmtQty(r.on_order) : '—'}</td>
                      <td className="px-2 py-2 text-right font-mono whitespace-nowrap text-gray-400">{fmtCost(r.avg_cost)}</td>
                      <td className="px-2 py-2 text-right font-mono whitespace-nowrap text-gray-200">{fmtMoney(r.est_value)}</td>
                      <td className="px-2 py-2">
                        {rv ? (
                          <>
                            <span className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${rv.tone}`}>{rv.label}</span>
                            <div className="text-[11px] text-gray-500 mt-0.5 whitespace-nowrap">{r.min_qty === null || r.min_qty === undefined ? 'no min' : `min ${fmtQty(r.min_qty)}`}</div>
                          </>
                        ) : <span className="text-gray-600">—</span>}
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex flex-col items-start gap-0.5">
                          {flags.map(f => FLAG_CHIPS[f] ? (
                            <span key={f} title={FLAG_CHIPS[f].title} className={`text-[11px] px-1.5 py-0.5 rounded whitespace-nowrap ${FLAG_CHIPS[f].tone}`}>{FLAG_CHIPS[f].label}</span>
                          ) : null)}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {!showAll && filtered.length > PAGE && (
            <div className="text-center">
              <button onClick={() => setShowAll(true)} className="text-sm text-skynet-accent hover:underline">
                Showing {PAGE.toLocaleString()} of {filtered.length.toLocaleString()} — show all
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
