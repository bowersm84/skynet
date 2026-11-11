import { useState, useEffect, useCallback, useRef } from 'react'
import { RefreshCw, Loader2, Copy, Check, X, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import { listPostCards, verifyPosts, linkBuildMo, retryBuildMo, BUILD_KIND_LABELS } from '../../lib/assembly'
import { postStatusText, postTone, mismatchSentences, moStateWords, needsPosting } from '../../lib/assemblyPostMath'
import { hasRole, isReadOnlyRole } from '../../lib/roles'
import { formatDateTime } from '../../lib/fishbowl'

// PostCards — S17 D1 (D-ASM-54 / D-ASM-55). Ashley's "Ready to post" cards: for each released build, what she keys
// into Fishbowl's Quick Fulfill, in order — the MO number, the quantity to post, the finished lot — then the component
// lots in BOM order and the sales order lines the build serves. SkyNet reads the post back from the bridge's mirrors
// and says Verified, or Mismatch with what differs. Rows come from v_assembly_post_cards; the list polls every 12 s
// (TEST's realtime publication does not carry these tables). Used as the Order Queue's "Ready to post" tab and as the
// Assembly Board's Ready to post list (compact). Actions are server-gated to admin / assembly / order processor.
const POLL_MS = 12000

const TONE = {
  ready: 'bg-blue-900/40 text-blue-300 border-blue-800',
  partial: 'bg-amber-900/40 text-amber-200 border-amber-700',
  posted: 'bg-cyan-900/40 text-cyan-200 border-cyan-800',
  verified: 'bg-green-900/40 text-green-300 border-green-800',
  mismatch: 'bg-red-900/40 text-red-300 border-red-800',
}
const fmtQty = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString())
const btn = 'px-3 py-1.5 rounded text-xs border transition-colors disabled:opacity-50 inline-flex items-center gap-1'

function canActOnPosts(profile) {
  return hasRole(profile, 'admin', 'assembly', 'order_processor') && !isReadOnlyRole(profile?.role) && profile?.kiosk_only !== true
}

async function copyText(value) {
  const text = String(value ?? '')
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  }
}

function CopyButton({ value, label }) {
  const [done, setDone] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  if (value === null || value === undefined || value === '') return null
  return (
    <button type="button" title={`Copy ${label}`} aria-label={`Copy ${label}`}
      onClick={async () => { if (await copyText(value)) { setDone(true); clearTimeout(timer.current); timer.current = setTimeout(() => setDone(false), 1500) } }}
      className={`p-1.5 rounded border ${done ? 'border-green-700 text-green-300' : 'border-gray-700 text-gray-400 hover:text-white hover:border-gray-500'}`}>
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

function KeyField({ step, label, value, hint }) {
  return (
    <div className="flex items-center gap-3 bg-gray-950/60 border border-gray-800 rounded px-3 py-2">
      <span className="w-6 h-6 shrink-0 rounded-full bg-gray-800 text-gray-300 text-xs flex items-center justify-center">{step}</span>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
        <div className="font-mono text-lg text-white truncate">{value === null || value === undefined || value === '' ? <span className="text-amber-300 text-sm">{hint}</span> : value}</div>
      </div>
      <span className="ml-auto"><CopyButton value={value} label={label.toLowerCase()} /></span>
    </div>
  )
}

export function MoChip({ number, state, error }) {
  const words = moStateWords(state)
  if (!number && !words) return null
  const tone = state === 'error' ? 'bg-red-900/40 text-red-300 border-red-800'
    : state === 'cancelled' ? 'bg-gray-900 text-gray-500 border-gray-800'
      : 'bg-gray-800 text-gray-200 border-gray-700'
  return (
    <span title={state === 'error' && error ? error : undefined}
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs border whitespace-nowrap font-mono ${tone}`}>
      MO {number || '—'}{words ? <span className="font-sans ml-1">· {words}</span> : null}
    </span>
  )
}

export function LinkMoDialog({ card, busy, onClose, onLink }) {
  const [num, setNum] = useState(card.fb_mo_num && card.fb_mo_state === 'linked' ? card.fb_mo_num : '')
  const n = num.trim()
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onMouseDown={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full max-w-md" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h3 className="text-white font-semibold">Link MO — {card.build_number}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-xs text-gray-400">The Fishbowl MO number made by hand for this build. SkyNet stops waiting for the bridge and reads this MO back instead.</p>
          <input autoFocus value={num} onChange={(e) => setNum(e.target.value)} maxLength={25} placeholder="Fishbowl MO number"
            onKeyDown={(e) => { if (e.key === 'Enter' && n && !busy) onLink(n) }}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm font-mono focus:outline-none focus:border-skynet-accent" />
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white">Close</button>
            <button disabled={busy || !n} onClick={() => onLink(n)} className="px-3 py-1.5 rounded text-xs bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50 inline-flex items-center gap-1">
              {busy && <Loader2 size={12} className="animate-spin" />} Link MO
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function PostCard({ card: c, canAct, busy, onRecheck, onLink, onRetry }) {
  const tone = postTone(c)
  const sentences = c.fb_post_status === 'mismatch' ? mismatchSentences(c.fb_post_diff) : []
  const components = Array.isArray(c.component_lots) ? c.component_lots : []
  return (
    <div className={`bg-gray-900 rounded-lg border ${tone === 'mismatch' ? 'border-red-800' : tone === 'verified' ? 'border-green-900' : 'border-gray-800'}`}>
      <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2 flex-wrap">
        <span className="font-mono text-white">{c.build_number}</span>
        <span className="font-mono text-gray-200">{c.part_number}</span>
        {c.build_kind !== 'order' && <span className="text-xs text-purple-300">{BUILD_KIND_LABELS[c.build_kind] || c.build_kind}</span>}
        <span className="text-xs text-gray-500 truncate max-w-[280px]" title={c.part_description || ''}>{c.part_description}</span>
        <span className="ml-auto flex items-center gap-2">
          <MoChip number={c.fb_mo_num} state={c.fb_mo_state} error={c.fb_mo_error} />
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs border whitespace-nowrap ${TONE[tone]}`}>{postStatusText(c)}</span>
        </span>
      </div>

      <div className="p-4 space-y-4">
        {c.fb_mo_state === 'error' && (
          <div className="text-xs text-red-300 bg-red-950/40 border border-red-900 rounded px-3 py-2 flex items-center gap-2">
            <AlertTriangle size={14} className="shrink-0" /> <span>{c.fb_mo_error || 'The bridge could not create the MO.'}</span>
            {canAct && <button disabled={busy} onClick={onRetry} className={`${btn} ml-auto bg-gray-800 border-gray-700 text-gray-200 hover:text-white`}>Retry</button>}
          </div>
        )}

        {sentences.length > 0 && (
          <ul className="text-sm text-red-300 bg-red-950/30 border border-red-900 rounded px-3 py-2 space-y-1">
            {sentences.map((s) => <li key={s}>{s}</li>)}
          </ul>
        )}
        {c.fb_post_status === 'mismatch' && sentences.length === 0 && (
          <div className="text-sm text-red-300">Fishbowl does not match what SkyNet recorded. Re-check, or open the MO in Fishbowl.</div>
        )}

        <div>
          <div className="text-xs text-gray-400 mb-2">Key into Fishbowl Quick Fulfill, in this order</div>
          <div className="grid gap-2 md:grid-cols-3">
            <KeyField step={1} label="MO number" value={c.fb_mo_num} hint="No MO yet — link one" />
            <KeyField step={2} label="Quantity to post" value={c.good_quantity === null || c.good_quantity === undefined ? null : String(c.good_quantity)} hint="No good count yet" />
            <KeyField step={3} label="Finished lot" value={c.assembly_lot_number} hint="No lot yet" />
          </div>
        </div>

        <div>
          <div className="text-xs text-gray-400 mb-1">Component lots (BOM order)</div>
          {components.length === 0 ? <div className="text-xs text-amber-300">No component lots were recorded for this build.</div> : (
            <table className="w-full text-sm">
              <thead className="text-gray-500 text-xs uppercase">
                <tr><th className="py-1 text-left">Part</th><th className="py-1 text-left hidden md:table-cell">Description</th><th className="py-1 text-left">Lot</th><th className="py-1 text-right">Qty</th></tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {components.map((x) => (
                  <tr key={`${x.part}|${x.lot}`}>
                    <td className="py-1 font-mono text-gray-200">{x.part}</td>
                    <td className="py-1 text-xs text-gray-500 hidden md:table-cell">{x.description || ''}</td>
                    <td className="py-1 font-mono text-cyan-300"><span className="inline-flex items-center gap-2">{x.lot}<CopyButton value={x.lot} label={`${x.part} lot`} /></span></td>
                    <td className="py-1 text-right font-mono text-gray-300">{fmtQty(x.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="text-xs text-gray-400">
          Sales order lines: <span className="font-mono text-gray-200">{c.so_lines || (c.build_kind === 'order' ? '—' : 'none (not built for an order)')}</span>
        </div>

        <div className="flex items-center gap-2 flex-wrap text-xs text-gray-500 pt-1 border-t border-gray-800">
          <span className="pt-2">Released {formatDateTime(c.released_at)}{c.released_by_name ? ` by ${c.released_by_name}` : ''}</span>
          {c.fb_posted_at && <span className="pt-2">· posted {formatDateTime(c.fb_posted_at)}</span>}
          {c.fb_verified_at && <span className="pt-2">· verified {formatDateTime(c.fb_verified_at)}</span>}
          {c.mo_status && <span className="pt-2">· Fishbowl MO {c.mo_status}</span>}
          {canAct && (
            <span className="ml-auto flex gap-2 pt-2">
              {c.fb_post_status !== 'verified' && <button disabled={busy} onClick={onLink} className={`${btn} bg-gray-800 border-gray-700 text-gray-200 hover:text-white`}>Link MO…</button>}
              <button disabled={busy} onClick={onRecheck} className={`${btn} bg-gray-800 border-gray-700 text-gray-200 hover:text-white`}>
                {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Re-check now
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export default function PostCards({ profile, compact = false, onCount }) {
  const canAct = canActOnPosts(profile)
  const [cards, setCards] = useState(null)
  const [error, setError] = useState(null)
  const [status, setStatus] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [linkFor, setLinkFor] = useState(null)
  const [open, setOpen] = useState(() => new Set())
  const onCountRef = useRef(onCount)
  useEffect(() => { onCountRef.current = onCount }, [onCount])

  const load = useCallback(async () => {
    try {
      const rows = await listPostCards()
      setCards(rows)
      setError(null)
      onCountRef.current?.(rows.filter(needsPosting).length)
    } catch (e) {
      setError(e?.message || String(e))
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const act = async (card, fn, ok) => {
    setBusyId(card.id)
    try {
      await fn()
      setStatus({ type: 'success', message: ok })
      await load()
      return true
    } catch (e) {
      setStatus({ type: 'error', message: e?.message || String(e) })
      return false
    } finally {
      setBusyId(null)
    }
  }
  const recheck = (c) => act(c, () => verifyPosts([c.id]), `${c.build_number} re-checked against Fishbowl.`)
  const retry = (c) => act(c, () => retryBuildMo(c.id), `${c.build_number}: the MO is queued for the bridge again.`)

  const banner = status && (
    <div className={`p-3 rounded text-sm flex justify-between items-center ${status.type === 'success' ? 'bg-green-900/40 text-green-300 border border-green-800' : 'bg-red-900/40 text-red-300 border border-red-800'}`}>
      <span>{status.message}</span>
      <button onClick={() => setStatus(null)}><X size={14} /></button>
    </div>
  )
  const dialog = linkFor && (
    <LinkMoDialog card={linkFor} busy={busyId === linkFor.id} onClose={() => setLinkFor(null)}
      onLink={async (n) => { if (await act(linkFor, () => linkBuildMo(linkFor.id, n), `${linkFor.build_number} linked to Fishbowl MO ${n}.`)) setLinkFor(null) }} />
  )

  if (cards === null) {
    return error
      ? <div className="p-4 text-sm text-red-300">Could not load the post cards: {error}</div>
      : <div className="p-6 text-sm text-gray-400 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading post cards…</div>
  }

  if (compact) {
    return (
      <div>
        {banner && <div className="p-2">{banner}</div>}
        {cards.length === 0 ? <div className="px-4 py-4 text-sm text-gray-500">Nothing waiting for Fishbowl.</div> : (
          <div className="divide-y divide-gray-800">
            {cards.map((c) => {
              const isOpen = open.has(c.id)
              return (
                <div key={c.id}>
                  <button onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n })}
                    className="w-full px-4 py-2 flex items-center gap-3 text-sm hover:bg-gray-800/40 text-left">
                    {isOpen ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
                    <span className="font-mono text-white">{c.build_number}</span>
                    <span className="font-mono text-gray-300">{c.part_number}</span>
                    <span className="text-gray-500 text-xs">× {fmtQty(c.good_quantity ?? c.quantity)}</span>
                    <MoChip number={c.fb_mo_num} state={c.fb_mo_state} error={c.fb_mo_error} />
                    <span className={`ml-auto inline-flex items-center px-2 py-0.5 rounded text-xs border whitespace-nowrap ${TONE[postTone(c)]}`}>{postStatusText(c)}</span>
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3">
                      <PostCard card={c} canAct={canAct} busy={busyId === c.id} onRecheck={() => recheck(c)} onLink={() => setLinkFor(c)} onRetry={() => retry(c)} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {dialog}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {banner}
      {error && <div className="text-xs text-amber-300">Last refresh failed: {error}</div>}
      {cards.length === 0 ? (
        <div className="text-center py-16 bg-gray-900 rounded-lg border border-gray-800 text-gray-400">Nothing waiting to post. Released assembly builds appear here.</div>
      ) : cards.map((c) => (
        <PostCard key={c.id} card={c} canAct={canAct} busy={busyId === c.id}
          onRecheck={() => recheck(c)} onLink={() => setLinkFor(c)} onRetry={() => retry(c)} />
      ))}
      {dialog}
    </div>
  )
}
