//
// Pricing Portal — Customers tab. Pick a customer → tier (with history and, for
// admin, the Set Tier control), customer-part exceptions, and what they have
// bought since Fishbowl go-live with last-paid against today's price.
//
import { useEffect, useMemo, useState } from 'react'
import { Loader2, ShieldCheck, Tag, History, Plus, X, AlertTriangle, TrendingUp, FileText, FileDown } from 'lucide-react'
import {
  loadCustomer, loadTierHistory, setCustomerTier, loadExceptions, upsertException, closeException,
  loadPurchases, loadTopCustomers, loadPriceLists, loadPriceList, loadQuotes, loadQuote, quoteIsExpired, QUOTE_STATUS_LABELS, getPrice, TIERS, TIER_LABELS, money, num, todayIso,
} from '../../lib/pricing'
import { buildQuotePdf, quoteFilename } from '../../lib/quoteDoc'
import { buildPriceListPdf, downloadBytes, priceListFilename } from '../../lib/priceListDoc'
import PriceListBuilder from './PriceListBuilder'
import { CustomerTypeahead, TierBadge } from './PricingTypeaheads'

function SetTierPanel({ customer, onSaved, onCancel }) {
  const [tier, setTier] = useState(customer.tier || 'none')
  const [from, setFrom] = useState(todayIso())
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null)
  const save = async () => {
    setBusy(true); setErr(null)
    try { await setCustomerTier(customer.fb_customer_id, tier, from, note); onSaved() }
    catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
  }
  return (
    <div className="mt-3 bg-gray-900/60 border border-gray-700 rounded-lg p-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        {TIERS.map(t => (
          <button key={t} onClick={() => setTier(t)} className={`px-3 py-1 rounded border text-sm ${tier === t ? 'border-skynet-accent text-white bg-skynet-accent/10' : 'border-gray-700 text-gray-400 hover:text-white'}`}>{TIER_LABELS[t]}</button>
        ))}
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-2 items-center text-sm">
        <label className="text-gray-500 text-xs">Effective</label>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm font-mono outline-none w-44" />
        <label className="text-gray-500 text-xs">Note</label>
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="why (kept in history)" className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm outline-none" />
      </div>
      {err && <div className="text-rose-300 text-xs">{err}</div>}
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-3 py-1 text-sm text-gray-400 hover:text-white">Cancel</button>
        <button onClick={save} disabled={busy} className="px-3 py-1 text-sm rounded bg-skynet-accent text-gray-900 font-medium disabled:opacity-50">{busy ? 'Saving…' : 'Set tier'}</button>
      </div>
    </div>
  )
}

function AddExceptionPanel({ customer, onSaved, onCancel }) {
  const [part, setPart] = useState(''); const [mode, setMode] = useState('pct_of_tier3'); const [value, setValue] = useState('')
  const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null)
  const save = async () => {
    const v = Number(value)
    if (!part.trim() || !(v > 0)) { setErr('Part and a positive value are required'); return }
    setBusy(true); setErr(null)
    try { await upsertException(customer.fb_customer_id, part.trim(), mode, mode === 'pct_of_tier3' ? v / 100 : v, note); onSaved() }
    catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
  }
  return (
    <div className="mt-3 bg-gray-900/60 border border-gray-700 rounded-lg p-3 space-y-2 text-sm">
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2">
        <input value={part} onChange={e => setPart(e.target.value)} placeholder="Part number" className="bg-gray-800 border border-gray-700 rounded px-2 py-1 font-mono outline-none" />
        <select value={mode} onChange={e => setMode(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 outline-none">
          <option value="pct_of_tier3">% of Tier 3</option>
          <option value="fixed">Fixed $</option>
        </select>
        <input value={value} onChange={e => setValue(e.target.value)} placeholder={mode === 'pct_of_tier3' ? 'e.g. 83.3' : 'e.g. 2.523'} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 font-mono outline-none w-28" />
      </div>
      <input value={note} onChange={e => setNote(e.target.value)} placeholder="why" className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 outline-none" />
      <div className="text-[11px] text-gray-500">"% of Tier 3" moves with every price book (the Oct 1 increase included); "Fixed" does not.</div>
      {err && <div className="text-rose-300 text-xs">{err}</div>}
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-3 py-1 text-gray-400 hover:text-white">Cancel</button>
        <button onClick={save} disabled={busy} className="px-3 py-1 rounded bg-skynet-accent text-gray-900 font-medium disabled:opacity-50">{busy ? 'Saving…' : 'Add exception'}</button>
      </div>
    </div>
  )
}

// Landing panel (B.1): the ten biggest customers by trailing-12-month revenue, click to open.
function TopCustomers({ onPick }) {
  const [rows, setRows] = useState(null)
  useEffect(() => { let c = false; loadTopCustomers(10).then(r => { if (!c) setRows(r) }).catch(err => { console.error('top customers', err); setRows([]) }); return () => { c = true } }, [])
  return (
    <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold text-white flex items-center gap-2"><TrendingUp size={15} className="text-skynet-accent" /> Top 10 customers by revenue, trailing 12 months</div>
        <div className="text-[11px] text-gray-500">Fishbowl history since 2023-11-27 · shipped lines · non-sellables excluded</div>
      </div>
      {rows === null ? <div className="p-6 text-center"><Loader2 size={20} className="animate-spin text-gray-500 mx-auto" /></div> : (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-wide text-gray-400"><th className="py-1 pr-2">#</th><th className="py-1 pr-2">Customer</th><th className="py-1 pr-2">Tier</th><th className="py-1 pr-2 text-right">Revenue 12m</th><th className="py-1 pr-2 text-right">Orders 12m</th><th className="py-1 pr-2 text-right">All-time</th><th className="py-1 pr-2 text-right">Parts</th><th className="py-1 text-right">Last order</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.fb_customer_id} onClick={() => onPick(r)} className="border-t border-gray-800 hover:bg-gray-800/60 cursor-pointer">
                <td className="py-1.5 pr-2 text-gray-500">{i + 1}</td>
                <td className="py-1.5 pr-2 text-white">{r.name_clean}<span className="text-gray-600 font-mono text-xs"> #{r.customer_number || r.fb_customer_id}</span></td>
                <td className="py-1.5 pr-2"><TierBadge tier={r.tier} /></td>
                <td className="py-1.5 pr-2 text-right font-mono text-white">{money(r.revenue_12m, 0)}</td>
                <td className="py-1.5 pr-2 text-right font-mono text-gray-300">{num(r.orders_12m)}</td>
                <td className="py-1.5 pr-2 text-right font-mono text-gray-400">{money(r.revenue_all, 0)}</td>
                <td className="py-1.5 pr-2 text-right font-mono text-gray-400">{num(r.parts_all)}</td>
                <td className="py-1.5 text-right text-gray-400">{r.last_order}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default function PriceCustomers({ asOf, canEdit, initialCustomer, book, nextBook, profile }) {
  const [customer, setCustomer] = useState(initialCustomer || null)
  const [priceLists, setPriceLists] = useState([])
  const [quotes, setQuotes] = useState([])
  const [showBuilder, setShowBuilder] = useState(false)
  const [history, setHistory] = useState([])
  const [exceptions, setExceptions] = useState([])
  const [purchases, setPurchases] = useState([])
  const [current, setCurrent] = useState({})      // part_key -> pricing_get_price row
  const [busy, setBusy] = useState(false)
  const [showSetTier, setShowSetTier] = useState(false)
  const [showAddExc, setShowAddExc] = useState(false)
  const [filter, setFilter] = useState('')

  const reload = async (id) => {
    setBusy(true)
    try {
      const [c, h, e, p, pl, qs] = await Promise.all([loadCustomer(id), loadTierHistory(id), loadExceptions(id), loadPurchases(id), loadPriceLists(id), loadQuotes({ fbCustomerId: id, limit: 10 })])
      setCustomer(c); setHistory(h); setExceptions(e); setPurchases(p); setPriceLists(pl); setQuotes(qs)
    } catch (err) { console.error('customer load', err) } finally { setBusy(false) }
  }
  useEffect(() => { if (customer?.fb_customer_id) reload(customer.fb_customer_id) }, [customer?.fb_customer_id])

  // Current price for each purchased part (top 200 by revenue keeps this snappy).
  useEffect(() => {
    if (!customer || !purchases.length) { setCurrent({}); return }
    let cancelled = false
    const top = purchases.slice(0, 200)
    Promise.all(top.map(p => getPrice(p.product_num, customer.fb_customer_id, 1, asOf).then(r => [p.product_key, r]).catch(() => [p.product_key, null])))
      .then(pairs => { if (!cancelled) setCurrent(Object.fromEntries(pairs)) })
    return () => { cancelled = true }
  }, [customer, purchases, asOf])

  const rows = useMemo(() => {
    const f = filter.trim().toUpperCase()
    return f ? purchases.filter(p => p.product_key.includes(f.replace(/\s+/g, '')) || (p.description || '').toUpperCase().includes(f)) : purchases
  }, [purchases, filter])
  const totals = useMemo(() => purchases.reduce((a, p) => ({ rev: a.rev + Number(p.revenue || 0), parts: a.parts + 1 }), { rev: 0, parts: 0 }), [purchases])

  return (
    <div className="space-y-4">
      {showBuilder && customer && <PriceListBuilder customer={customer} book={book} nextBook={nextBook} profile={profile} onClose={() => setShowBuilder(false)} onSaved={() => reload(customer.fb_customer_id)} />}
      <div className="max-w-xl"><CustomerTypeahead includeInactive onPick={setCustomer} onClear={() => { setCustomer(null); setPurchases([]); setHistory([]); setExceptions([]) }} /></div>

      {!customer && (
        <>
          <div className="text-gray-500 text-sm">Pick a customer above, or one of the ten below, to see their tier, special prices and purchase history.</div>
          <TopCustomers onPick={r => setCustomer({ fb_customer_id: r.fb_customer_id, name_clean: r.name_clean, customer_number: r.customer_number, tier: r.tier, salesman: r.salesman, is_active: r.is_active })} />
        </>
      )}

      {customer && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          {/* Tier */}
          <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-white font-semibold truncate">{customer.name_clean}</div>
                <div className="text-xs text-gray-500 font-mono">#{customer.customer_number || customer.fb_customer_id}{customer.salesman ? ` · ${customer.salesman}` : ''}{!customer.is_active ? ' · inactive' : ''}</div>
                {customer.name !== customer.name_clean && <div className="text-[11px] text-gray-600 truncate">Fishbowl: {customer.name}</div>}
              </div>
              <TierBadge tier={customer.tier} size="lg" />
            </div>
            {customer.tier_note && <div className="mt-2 text-xs text-amber-300/90 flex items-start gap-1"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{customer.tier_note}</div>}
            {canEdit && !showSetTier && <button onClick={() => setShowSetTier(true)} className="mt-3 text-sm text-skynet-accent hover:underline flex items-center gap-1"><ShieldCheck size={14} /> Set tier</button>}
            {showSetTier && <SetTierPanel customer={customer} onCancel={() => setShowSetTier(false)} onSaved={() => { setShowSetTier(false); reload(customer.fb_customer_id) }} />}
            {history.length > 0 && (
              <div className="mt-4">
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1 flex items-center gap-1"><History size={12} /> Tier history</div>
                <ul className="text-xs space-y-1">
                  {history.map(h => (
                    <li key={h.id} className="flex items-baseline gap-2 text-gray-400">
                      <span className="font-mono text-gray-300">{h.effective_from}{h.effective_to ? ` → ${h.effective_to}` : ' →'}</span>
                      <TierBadge tier={h.tier} />
                      <span className="truncate">{h.profiles?.full_name || ''} {h.note ? `— ${h.note}` : ''}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Exceptions */}
          <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wide text-gray-500 flex items-center gap-1"><Tag size={12} /> Customer-part special prices</div>
              {canEdit && !showAddExc && <button onClick={() => setShowAddExc(true)} className="text-xs text-skynet-accent hover:underline flex items-center gap-1"><Plus size={12} /> Add</button>}
            </div>
            {exceptions.length === 0 && <div className="text-sm text-gray-500 mt-2">None.</div>}
            <ul className="mt-2 space-y-1 text-sm">
              {exceptions.map(e => (
                <li key={e.id} className="flex items-center gap-2">
                  <span className="font-mono text-white">{e.part_number}</span>
                  <span className="text-gray-300">{e.mode === 'pct_of_tier3' ? `${(Number(e.value) * 100).toFixed(1)}% of Tier 3` : money(e.value, 3)}</span>
                  <span className="text-xs text-gray-500 truncate flex-1" title={e.note || ''}>{e.note || ''}</span>
                  {canEdit && <button onClick={async () => { if (confirm(`End the special price on ${e.part_number} as of today?`)) { await closeException(e.id); reload(customer.fb_customer_id) } }} className="text-gray-500 hover:text-rose-300" title="End"><X size={14} /></button>}
                </li>
              ))}
            </ul>
            {showAddExc && <AddExceptionPanel customer={customer} onCancel={() => setShowAddExc(false)} onSaved={() => { setShowAddExc(false); reload(customer.fb_customer_id) }} />}
          </div>

          {/* Summary + price lists */}
          <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4">
            <div className="text-[11px] uppercase tracking-wide text-gray-500">Since Fishbowl go-live (2023-11-27)</div>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <div><div className="text-2xl font-semibold text-white font-mono">{money(totals.rev, 0)}</div><div className="text-xs text-gray-500">revenue</div></div>
              <div><div className="text-2xl font-semibold text-white font-mono">{num(totals.parts)}</div><div className="text-xs text-gray-500">distinct parts</div></div>
            </div>
            <button onClick={() => setShowBuilder(true)} className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-skynet-accent text-gray-900 font-medium text-sm"><FileText size={15} /> Create Price List</button>
            {quotes.length > 0 && (
              <div className="mt-3">
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Quotes</div>
                <ul className="text-xs space-y-1">
                  {quotes.map(q => (
                    <li key={q.id} className="flex items-center gap-2">
                      <span className="font-mono text-white">{q.quote_number}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${q.status === 'won' ? 'bg-emerald-900 text-emerald-200' : q.status === 'issued' && !quoteIsExpired(q) ? 'bg-sky-900 text-sky-200' : 'bg-gray-700 text-gray-400'}`}>{quoteIsExpired(q) ? 'Expired' : QUOTE_STATUS_LABELS[q.status]}</span>
                      <span className="text-gray-400">{String(q.created_at).slice(0, 10)} · {money(q.subtotal)}</span>
                      <button title="Download PDF" onClick={async () => { const { quote, lines } = await loadQuote(q.id); downloadBytes(await buildQuotePdf(quote, lines), quoteFilename(quote), 'application/pdf') }} className="ml-auto text-gray-400 hover:text-white"><FileDown size={13} /></button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {priceLists.length > 0 && (
              <div className="mt-3">
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Price lists issued</div>
                <ul className="text-xs space-y-1">
                  {priceLists.map(pl => (
                    <li key={pl.id} className="flex items-center gap-2">
                      <span className="font-mono text-white">{pl.list_number}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${pl.status === 'issued' ? 'bg-emerald-900 text-emerald-200' : 'bg-gray-700 text-gray-400'}`}>{pl.status}</span>
                      <span className="text-gray-400">eff. {pl.as_of} · {pl.created_by_name || ''}</span>
                      <button title="Download PDF" onClick={async () => { const { list, lines } = await loadPriceList(pl.id); downloadBytes(await buildPriceListPdf(list, lines), priceListFilename(list, 'pdf'), 'application/pdf') }} className="ml-auto text-gray-400 hover:text-white"><FileDown size={13} /></button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Purchases */}
          <div className="xl:col-span-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-white font-semibold">Purchase history · priced as of {asOf}</h3>
              <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="filter parts" className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs outline-none w-44" />
            </div>
            {busy ? <div className="p-8 text-center"><Loader2 size={22} className="animate-spin text-gray-500 mx-auto" /></div> : (
              <div className="overflow-auto rounded-xl border border-gray-700 max-h-[60vh]">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-800 sticky top-0"><tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
                    <th className="px-3 py-2">Part</th><th className="px-3 py-2">Description</th><th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Revenue</th>
                    <th className="px-3 py-2">First</th><th className="px-3 py-2">Last</th><th className="px-3 py-2 text-right">Last paid</th><th className="px-3 py-2 text-right">Now</th><th className="px-3 py-2 text-right">Δ</th><th className="px-3 py-2">Basis</th>
                  </tr></thead>
                  <tbody>
                    {rows.map(p => {
                      const c = current[p.product_key]
                      const now = c?.unit_price_2dp ?? null
                      const lp = Number(p.last_paid)
                      const delta = now !== null && lp > 0 ? (now - lp) / lp : null
                      return (
                        <tr key={p.product_key} className="border-t border-gray-800 hover:bg-gray-800/60">
                          <td className="px-3 py-1.5 font-mono text-white whitespace-nowrap">{p.product_num}</td>
                          <td className="px-3 py-1.5 text-gray-300 truncate max-w-xs" title={p.description || ''}>{p.description || ''}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-gray-300">{num(p.qty)}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-gray-300">{money(p.revenue, 0)}</td>
                          <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{p.first_bought}</td>
                          <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{p.last_bought}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-gray-300">{lp > 0 ? money(lp, 3) : '—'}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-white">{c === undefined ? <span className="text-gray-600">…</span> : now === null ? <span className="italic text-gray-500 text-xs">{c?.reason || 'no price'}</span> : money(now)}</td>
                          <td className={`px-3 py-1.5 text-right font-mono text-xs ${delta === null ? 'text-gray-600' : delta > 0.005 ? 'text-amber-300' : delta < -0.005 ? 'text-emerald-300' : 'text-gray-500'}`}>{delta === null ? '' : `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(0)}%`}</td>
                          <td className="px-3 py-1.5 text-xs text-gray-500">{c?.basis === 'exception' ? <span className="text-amber-300">special</span> : (c?.col_key || '')}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
