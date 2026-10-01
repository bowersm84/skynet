//
// Pricing Portal — Fishbowl Sync (D-PRICE-53 Batch B, D-PRICE-55). Whether Fishbowl matches the price
// book in effect, where it does not, and the pushes that fix it.
//
// Everyone with portal access sees the confirmation, the differences and the push history. Pushing
// and cancelling are admin only — the same set fb_push_enqueue / fb_push_cancel enforce server-side.
// A push is queued here and sent by the bridge within one 20 s cycle; the page polls while one is
// queued or running and re-reads the confirmation when it finishes.
//
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw, CheckCircle, AlertTriangle, Upload, X, ChevronDown, ChevronRight } from 'lucide-react'
import { num, todayIso, bookContext, ageLabel } from '../../lib/pricing'
import {
  loadFbSyncStatus, loadFbBridgeState, loadFbPushCommands, enqueueFbPush, cancelFbPush, loadFbDrift, loadProfileNames,
  pushSize, effectiveDryRun, listPrice, DRIFT_LIMIT,
} from '../../lib/fishbowlSync'
import SyncStatusBanner from '../orderqueue/SyncStatusBanner'

const KIND_LABEL = { prices: 'Prices', rules: 'Pricing rules', tree: 'Product tree', groups: 'Customer groups' }
const KIND_NOUN = { prices: 'price', rules: 'rule', tree: 'tree entry', groups: 'group membership' }
const STATE_LABEL = {
  mismatch: 'Different', fb_zero: '$0.00 in Fishbowl', not_in_fishbowl: 'Not a Fishbowl product',
  missing: 'Missing in Fishbowl', inactive_in_fb: 'Switched off in Fishbowl', legacy_active: 'Non-SkyNet rule still on',
  extra_sn_active: 'No longer in the book', extra_in_fb: 'Extra in Fishbowl',
}
const STATUS_CLS = {
  queued: 'bg-sky-900 text-sky-200', running: 'bg-amber-900 text-amber-200', done: 'bg-emerald-900 text-emerald-200',
  failed: 'bg-rose-900 text-rose-200', cancelled: 'bg-gray-700 text-gray-300',
}
const th = 'px-2 py-1.5 text-left text-[10px] uppercase tracking-wide text-gray-400'
const btn2 = 'inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-600 text-gray-200 text-xs hover:text-white disabled:opacity-40 disabled:hover:text-gray-200'

function when(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
function plural(n, noun) { return `${num(n)} ${noun}${Number(n) === 1 ? '' : 's'}` }
function signed(v) {
  if (v === null || v === undefined) return '—'
  const x = Number(v)
  return `${x > 0 ? '+' : x < 0 ? '−' : ''}${listPrice(Math.abs(x))}`
}
function ruleSummary(type, pct, amount, qmin, qmax) {
  if (!type) return '—'
  const adj = type === 'Percent' ? `${Number(pct)}%` : `${listPrice(amount)}`
  const q = qmin || qmax ? ` · qty ${num(qmin)}${Number(qmax) ? `–${num(qmax)}` : '+'}` : ''
  return `${type === 'Percent' ? 'Percent' : type} ${adj}${q}`
}

// The differences for one row of the status table (prices, rules, tree or groups).
function differences(kind, s) {
  if (!s) return []
  const out = []
  const add = (n, text) => { if (Number(n) > 0) out.push(`${num(n)} ${text}`) }
  if (kind === 'prices') { add(s.products.mismatched, 'different'); add(s.products.fb_zero, 'at $0.00') }
  if (kind === 'rules') {
    add(s.rules.missing, 'missing'); add(s.rules.mismatched, 'different'); add(s.rules.inactive_in_fb, 'switched off in Fishbowl')
    add(s.rules.extra_sn_active, 'no longer in the book'); add(s.rules.legacy_active, 'non-SkyNet rules still on')
  }
  if (kind === 'tree') { add(s.tree.missing, 'products not filed'); add(s.tree.categories_missing, 'categories missing') }
  if (kind === 'groups') { add(s.groups.missing, 'customers not in their group'); add(s.groups.extra_in_fb, 'extra in Fishbowl') }
  return out
}
function matching(kind, s) {
  if (!s) return '—'
  const p = kind === 'prices' ? s.products : s[kind]
  return `${num(p?.in_sync)} of ${num(p?.expected)}`
}

function ConfirmPush({ kind, size, dryRun, bookLabel, warning, onCancel, onConfirm, busy }) {
  return (
    <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-5 space-y-3">
        <div className="text-white font-semibold flex items-center gap-2"><Upload size={16} className="text-skynet-accent" /> Push {KIND_LABEL[kind].toLowerCase()} to Fishbowl</div>
        <p className="text-sm text-gray-300">
          {dryRun
            ? <>Dry run: the bridge logs the {plural(size, KIND_NOUN[kind])} it would send for {bookLabel} and sends nothing.</>
            : <>Sends {plural(size, KIND_NOUN[kind])} for {bookLabel}. The bridge picks this up within 20 seconds, and Fishbowl applies the file as a whole or rejects it.</>}
        </p>
        {warning && <div className="text-xs text-amber-300 bg-amber-950/40 border border-amber-900 rounded px-3 py-2">{warning}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button onClick={onConfirm} disabled={busy} className="px-3 py-1.5 text-sm rounded bg-skynet-accent text-gray-900 font-medium disabled:opacity-50">
            {busy ? 'Queuing…' : dryRun ? 'Run dry' : `Push ${plural(size, KIND_NOUN[kind])}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function DriftTable({ kind, rows }) {
  if (!rows.length) return <div className="px-3 py-4 text-sm text-gray-500">Nothing to show — this area matches.</div>
  const cell = 'px-2 py-1'
  let head, body
  if (kind === 'prices') {
    head = ['Product', 'Kind', 'SkyNet list', 'Fishbowl list', 'Difference', 'State']
    body = rows.map(r => [<span key="p" className="font-mono text-white">{r.product_num}</span>, r.kind, <span key="b" className="font-mono">{listPrice(r.book_price)}</span>,
      <span key="f" className="font-mono">{r.fb_price === null ? '—' : listPrice(r.fb_price)}</span>, <span key="d" className="font-mono">{signed(r.delta)}</span>, STATE_LABEL[r.state] || r.state])
  } else if (kind === 'rules') {
    head = ['Rule', 'State', 'SkyNet', 'Fishbowl', 'Applies to']
    body = rows.map(r => [<span key="n" className="font-mono text-white">{r.name}</span>, STATE_LABEL[r.state] || r.state,
      ruleSummary(r.expected_pa_type, r.expected_pct, r.expected_amount, r.expected_qty_min, r.expected_qty_max),
      ruleSummary(r.fb_pa_type, r.fb_pct, r.fb_amount, r.fb_qty_min, r.fb_qty_max),
      <span key="a" className="text-gray-400">{[r.expected_product || r.fb_product, r.expected_customer || r.fb_customer].filter(Boolean).join(' · ')}</span>])
  } else if (kind === 'tree') {
    head = ['Product', 'Belongs under', 'SkyNet categories in Fishbowl now']
    body = rows.map(r => [<span key="p" className="font-mono text-white">{r.product_num}</span>, <span key="e" className="font-mono text-gray-300">{r.expected_path}</span>,
      <span key="f" className="font-mono text-gray-500">{r.fb_skynet_paths || 'none'}</span>])
  } else {
    head = ['Customer', 'Belongs in', 'In Fishbowl', 'State']
    body = rows.map(r => [<span key="c" className="text-white">{r.customer_name}</span>, r.expected_group || '—', r.fb_group || '—', STATE_LABEL[r.state] || r.state])
  }
  return (
    <div className="max-h-[50vh] overflow-auto">
      <table className="min-w-full text-xs">
        <thead className="bg-gray-800 sticky top-0"><tr>{head.map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
        <tbody>{body.map((cells, i) => <tr key={i} className="border-t border-gray-800">{cells.map((c, j) => <td key={j} className={`${cell} ${j === 0 ? 'whitespace-nowrap' : ''} text-gray-300`}>{c}</td>)}</tr>)}</tbody>
      </table>
      {rows.length >= DRIFT_LIMIT && <div className="px-3 py-2 text-[11px] text-gray-500">Showing the first {num(DRIFT_LIMIT)}.</div>}
    </div>
  )
}

export default function FishbowlSync({ canPush = false, books = [] }) {
  const today = todayIso()
  const { current: todayBook, next } = bookContext(books, today)
  const [asOf, setAsOf] = useState(today)
  const previewing = asOf !== today
  const [status, setStatus] = useState(null)
  const [bridge, setBridge] = useState(null)
  const [cmds, setCmds] = useState([])
  const [names, setNames] = useState({})
  const [loading, setLoading] = useState(true)
  const [checkedAt, setCheckedAt] = useState(null)
  const [error, setError] = useState(null)
  const [flash, setFlash] = useState(null)
  const [open, setOpen] = useState(null)            // drift kind being shown
  const [drift, setDrift] = useState({ kind: null, rows: [], loading: false, error: null })
  const [dryRun, setDryRun] = useState(false)
  const [includeResale, setIncludeResale] = useState(false)
  const [retireLegacy, setRetireLegacy] = useState(false)
  const [confirm, setConfirm] = useState(null)      // { kind, size, warning }
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [s, b, c] = await Promise.all([loadFbSyncStatus(asOf), loadFbBridgeState(), loadFbPushCommands(20)])
      setStatus(s); setBridge(b); setCmds(c); setCheckedAt(new Date().toISOString()); setError(null)
      setNames(await loadProfileNames(c.map(x => x.requested_by)))
    } catch (e) { setError(e.message || String(e)) } finally { setLoading(false) }
  }, [asOf])
  useEffect(() => { setLoading(true); load() }, [load])

  // Poll while a push is queued or running; stop as soon as none is.
  const active = cmds.some(c => c.status === 'queued' || c.status === 'running')
  useEffect(() => {
    if (!active) return undefined
    const t = setInterval(load, 20000)
    return () => clearInterval(t)
  }, [active, load])

  const openDrift = async (kind) => {
    if (open === kind) { setOpen(null); return }
    setOpen(kind); setDrift({ kind, rows: [], loading: true, error: null })
    try { setDrift({ kind, rows: await loadFbDrift(kind), loading: false, error: null }) }
    catch (e) { setDrift({ kind, rows: [], loading: false, error: e.message || String(e) }) }
  }

  const busyKinds = useMemo(() => new Set(cmds.filter(c => c.status === 'queued' || c.status === 'running').map(c => c.kind)), [cmds])
  const bookLabel = status?.book?.rev_label || todayBook?.rev_label || 'the book in effect'

  const askPush = (kind) => {
    const size = pushSize(kind, status, { includeResale, retireLegacy })
    let warning = null
    if (kind === 'rules' && Number(status?.groups?.missing) > 0) warning = 'Push customer groups first. Rules for a new group are only built once the group exists in Fishbowl, so they would follow on the next rules push.'
    if (kind === 'rules' && retireLegacy) warning = [warning, `Also switches off ${plural(status?.rules?.legacy_active, 'rule')} that SkyNet does not own.`].filter(Boolean).join(' ')
    if (kind === 'prices' && includeResale) warning = 'Includes resale items, whose prices Fishbowl normally owns.'
    setConfirm({ kind, size, warning })
  }
  const doPush = async () => {
    const { kind } = confirm
    const options = kind === 'prices' && includeResale ? { include_resale: true } : kind === 'rules' && retireLegacy ? { retire_legacy: true } : {}
    setBusy(true)
    try {
      const id = await enqueueFbPush(kind, { options, dryRun, note: `Portal: ${KIND_LABEL[kind].toLowerCase()}${dryRun ? ' (dry run)' : ''}` })
      setFlash(`Queued push #${id}. The bridge picks it up within 20 seconds.`)
      setConfirm(null); setRetireLegacy(false); setIncludeResale(false)
      await load()
    } catch (e) { setError(e.message || String(e)); setConfirm(null) } finally { setBusy(false) }
  }
  const doCancel = async (id) => {
    try { await cancelFbPush(id); setFlash(`Cancelled push #${id}.`); await load() } catch (e) { setError(e.message || String(e)) }
  }

  if (loading && !status) return <div className="p-8 text-center"><Loader2 size={22} className="animate-spin text-gray-500 mx-auto" /></div>

  const inSync = status?.in_sync === true
  const s = status
  const notes = []
  if (s && Number(s.products?.not_in_fishbowl) > 0) notes.push(`${plural(s.products.not_in_fishbowl, 'book item')} ${Number(s.products.not_in_fishbowl) === 1 ? 'has' : 'have'} no Fishbowl product, so nothing can be pushed for them.`)
  if (s && Number(s.products?.resale_drift) > 0) notes.push(`${plural(s.products.resale_drift, 'resale item')} ${Number(s.products.resale_drift) === 1 ? 'differs' : 'differ'} from the book. Fishbowl owns resale prices; tick "include resale" to push them anyway.`)
  if (s && Number(s.products?.kits_unresolved) > 0) notes.push(`${plural(s.products.kits_unresolved, 'set or kit')} ${Number(s.products.kits_unresolved) === 1 ? 'has' : 'have'} an unpriced component and ${Number(s.products.kits_unresolved) === 1 ? 'is' : 'are'} left out.`)
  if (s && Number(s.groups?.extra_in_fb) > 0) notes.push(`${plural(s.groups.extra_in_fb, 'customer')} ${Number(s.groups.extra_in_fb) === 1 ? 'is' : 'are'} in a SkyNet group they no longer belong to. The import only adds members, so remove them in Fishbowl.`)
  if (s && s.rules && !s.rules.loaded) notes.push("Fishbowl's rules have not been read yet; the bridge reads them at 02:10 and after every rules push.")

  return (
    <div className="space-y-4 max-w-6xl">
      <SyncStatusBanner state={bridge} compact />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-400">Compare Fishbowl with</span>
          <select value={asOf} onChange={e => { setAsOf(e.target.value); setOpen(null) }} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm outline-none">
            <option value={today}>{todayBook ? `${todayBook.rev_label}, in effect today` : 'the book in effect today'}</option>
            {next && <option value={next.effective_from}>{`${next.rev_label}, from ${next.effective_from} (preview)`}</option>}
          </select>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {checkedAt && <span>Checked {ageLabel(checkedAt)}</span>}
          <button onClick={() => { setLoading(true); load() }} className="text-gray-400 hover:text-white" title="Check again"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button>
        </div>
      </div>

      {error && <div className="flex items-center gap-2 text-sm text-rose-300 bg-rose-950/40 border border-rose-900 rounded px-3 py-2"><AlertTriangle size={14} /> {error}</div>}
      {flash && <div className="text-sm text-emerald-300">{flash}</div>}

      <div className={`rounded-lg border px-4 py-3 flex items-start gap-3 ${inSync ? 'border-emerald-800 bg-emerald-950/30' : 'border-amber-800 bg-amber-950/30'}`}>
        {inSync ? <CheckCircle size={22} className="text-emerald-400 shrink-0 mt-0.5" /> : <AlertTriangle size={22} className="text-amber-400 shrink-0 mt-0.5" />}
        <div>
          <div className={`font-semibold ${inSync ? 'text-emerald-200' : 'text-amber-200'}`}>
            {inSync ? `Fishbowl matches ${bookLabel}` : `Fishbowl does not yet match ${bookLabel}`}
          </div>
          <div className="text-xs text-gray-400 mt-0.5">
            {previewing
              ? `Preview of the book that takes effect ${asOf}. The bridge pushes it on its own at 02:10 that morning.`
              : 'Prices, pricing rules, the product tree and customer groups, checked against what the bridge last read from Fishbowl.'}
          </div>
        </div>
      </div>

      <div className="border border-gray-700 rounded-lg overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-800">
            <tr><th className={th}>Area</th><th className={th}>Matching</th><th className={th}>Differences</th><th className={th}>Last push</th><th className={th}>Last read from Fishbowl</th>{canPush && !previewing && <th className={th} />}</tr>
          </thead>
          <tbody>
            {['prices', 'rules', 'tree', 'groups'].map(kind => {
              const diffs = differences(kind, s)
              const lp = s?.last_push?.[kind]
              const readAt = { prices: s?.mirrors?.products_at, rules: s?.mirrors?.rules_at, tree: s?.mirrors?.tree_at, groups: s?.mirrors?.customers_at }[kind]
              const size = pushSize(kind, s, { includeResale, retireLegacy })
              return (
                <tr key={kind} className="border-t border-gray-800 align-top">
                  <td className="px-2 py-2 text-white whitespace-nowrap">{KIND_LABEL[kind]}</td>
                  <td className="px-2 py-2 font-mono text-gray-300 whitespace-nowrap">{matching(kind, s)}</td>
                  <td className="px-2 py-2">
                    {diffs.length === 0
                      ? <span className="text-emerald-300 text-xs">None</span>
                      : <button onClick={() => openDrift(kind)} className="text-left text-amber-200 text-xs hover:text-white inline-flex items-start gap-1" disabled={previewing} title={previewing ? 'The difference lists are for the book in effect today' : 'Show the list'}>
                          {!previewing && (open === kind ? <ChevronDown size={13} className="mt-px" /> : <ChevronRight size={13} className="mt-px" />)}
                          <span>{diffs.join(' · ')}</span>
                        </button>}
                  </td>
                  <td className="px-2 py-2 text-xs text-gray-400 whitespace-nowrap">
                    {lp ? <span title={when(lp.finished_at)}>#{lp.id} · {ageLabel(lp.finished_at)}{lp.status === 'failed' && <span className="ml-1 text-rose-300">failed</span>}</span> : 'none yet'}
                  </td>
                  <td className="px-2 py-2 text-xs text-gray-500 whitespace-nowrap" title={when(readAt)}>{ageLabel(readAt)}</td>
                  {canPush && !previewing && (
                    <td className="px-2 py-2 text-right whitespace-nowrap">
                      <div className="flex flex-col items-end gap-1">
                        <button onClick={() => askPush(kind)} disabled={size === 0 || busyKinds.has(kind)} className={btn2}
                          title={busyKinds.has(kind) ? 'A push of this kind is already queued or running' : size === 0 ? 'Nothing to push' : ''}>
                          <Upload size={12} /> {busyKinds.has(kind) ? 'In progress' : size === 0 ? 'Up to date' : `Push ${num(size)}`}
                        </button>
                        {kind === 'prices' && Number(s?.products?.resale_drift) > 0 && (
                          <label className="text-[11px] text-gray-400 flex items-center gap-1"><input type="checkbox" checked={includeResale} onChange={e => setIncludeResale(e.target.checked)} /> include resale</label>
                        )}
                        {kind === 'rules' && Number(s?.rules?.legacy_active) > 0 && (
                          <label className="text-[11px] text-gray-400 flex items-center gap-1"><input type="checkbox" checked={retireLegacy} onChange={e => setRetireLegacy(e.target.checked)} /> also switch off non-SkyNet rules</label>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
        {canPush && !previewing && (
          <div className="border-t border-gray-800 px-3 py-2 flex items-center justify-between text-xs text-gray-400">
            <label className="flex items-center gap-2"><input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} /> Dry run: the bridge logs what it would send and sends nothing</label>
            <span className="text-gray-500">Order that works: groups, then tree, then rules, then prices.</span>
          </div>
        )}
      </div>

      {notes.length > 0 && <ul className="text-xs text-gray-400 space-y-1 list-disc pl-5">{notes.map(n => <li key={n}>{n}</li>)}</ul>}

      {open && (
        <div className="border border-gray-700 rounded-lg">
          <div className="px-3 py-2 bg-gray-800 flex items-center justify-between">
            <span className="text-sm text-white">{KIND_LABEL[open]}: differences</span>
            <button onClick={() => setOpen(null)} className="text-gray-400 hover:text-white" title="Close"><X size={14} /></button>
          </div>
          {drift.loading ? <div className="p-6 text-center"><Loader2 size={18} className="animate-spin text-gray-500 mx-auto" /></div>
            : drift.error ? <div className="px-3 py-3 text-sm text-rose-300">{drift.error}</div>
              : <DriftTable kind={open} rows={drift.rows} />}
        </div>
      )}

      <div className="border border-gray-700 rounded-lg">
        <div className="px-3 py-2 bg-gray-800 text-sm text-white flex items-center justify-between">
          <span>Push history</span>
          {active && <span className="text-xs text-amber-300 flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> checking every 20 s</span>}
        </div>
        <div className="max-h-[40vh] overflow-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-800/60 sticky top-0">
              <tr><th className={th}>#</th><th className={th}>What</th><th className={th}>Rows</th><th className={th}>Result</th><th className={th}>Requested</th><th className={th}>Finished</th><th className={th}>Note / Fishbowl&apos;s reply</th>{canPush && <th className={th} />}</tr>
            </thead>
            <tbody>
              {cmds.length === 0 && <tr><td colSpan={8} className="px-2 py-3 text-gray-500">No pushes yet.</td></tr>}
              {cmds.map(c => {
                const dry = effectiveDryRun(c)
                const forced = !!c.result?.forced
                const who = c.requested_by ? (names[c.requested_by] || 'someone') : (String(c.note || '').startsWith('auto:') ? 'Automatic' : 'SQL Editor')
                const label = c.status === 'done' && dry ? (forced ? 'dry run (forced)' : 'dry run') : c.status
                return (
                  <tr key={c.id} className="border-t border-gray-800 align-top">
                    <td className="px-2 py-1 font-mono text-gray-400">{c.id}</td>
                    <td className="px-2 py-1 text-white whitespace-nowrap">{KIND_LABEL[c.kind] || c.kind}</td>
                    <td className="px-2 py-1 font-mono text-gray-300">{num(c.row_count)}</td>
                    <td className="px-2 py-1"><span className={`px-1.5 py-0.5 rounded text-[10px] ${dry && c.status === 'done' ? 'bg-gray-700 text-gray-300' : STATUS_CLS[c.status] || ''}`} title={forced ? c.result?.reason || '' : ''}>{label}</span></td>
                    <td className="px-2 py-1 text-gray-400 whitespace-nowrap">{who} · {when(c.requested_at)}</td>
                    <td className="px-2 py-1 text-gray-500 whitespace-nowrap" title={when(c.finished_at)}>{c.finished_at ? ageLabel(c.finished_at) : '—'}</td>
                    <td className="px-2 py-1 max-w-md">
                      {c.error ? <span className="text-rose-300 break-words" title={c.error}>{c.error.length > 220 ? `${c.error.slice(0, 220)}…` : c.error}</span> : <span className="text-gray-500">{c.note || ''}</span>}
                    </td>
                    {canPush && <td className="px-2 py-1 text-right">{c.status === 'queued' && <button onClick={() => doCancel(c.id)} className="text-gray-400 hover:text-rose-300" title="Cancel before the bridge picks it up">Cancel</button>}</td>}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {confirm && (
        <ConfirmPush kind={confirm.kind} size={confirm.size} dryRun={dryRun} bookLabel={bookLabel} warning={confirm.warning} busy={busy}
          onCancel={() => setConfirm(null)} onConfirm={doPush} />
      )}
    </div>
  )
}
