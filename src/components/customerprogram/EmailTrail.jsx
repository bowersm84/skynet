// Email trail for a customer program (S16 Batch B, D-CPROG-07..12). Threads of every message
// to or from the customer's domain, read from the roster's mailboxes by cp-gmail-ingest, plus
// whatever Matt files under his Gmail label. Attachments are listed by name only — their contents
// are never stored (D-CPROG-09). Roster members with a write flag can hide a message (with a
// reason) or fix its tags; everyone on the roster can run "Sync now".

import { useState, useMemo } from 'react'
import { Mail, RefreshCw, Paperclip, ExternalLink, EyeOff, Eye, Tag, ChevronDown, ChevronRight, Search } from 'lucide-react'
import { loadEmailBody, syncEmails, updateEmail } from '../../lib/customerProgram'
import BobSwitch from './BobSwitch'
import { groupThreads } from '../../lib/customerProgramEmail'

const DIR_STYLE = {
  in: 'border-amber-800 bg-amber-900/30 text-amber-300',
  out: 'border-cyan-800 bg-cyan-900/30 text-cyan-300',
  internal: 'border-gray-700 bg-gray-800 text-gray-400',
}
const DIR_LABEL = { in: 'From customer', out: 'To customer', internal: 'Internal' }

const fmtWhen = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' })
const fmtSize = (n) => (n == null ? '' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const refLabel = (r) => r.replace(':', ' ')
const ORDER_REF = '__order__' // the ref filter's "This order" option: any of the order's tags
const gmailLink = (rfc) => `https://mail.google.com/mail/u/0/#search/rfc822msgid%3A${encodeURIComponent(rfc)}`

function Message({ m, canWrite, onChanged }) {
  const [full, setFull] = useState(null)
  const [busy, setBusy] = useState(false)
  const showFull = async () => {
    if (full !== null) { setFull(null); return }
    setBusy(true)
    try { setFull(await loadEmailBody(m.id)) } catch (err) { alert(err.message) } finally { setBusy(false) }
  }
  const hide = async () => {
    if (m.hidden_at) {
      try { await updateEmail(m.id, { hidden: false }); onChanged('Message shown again') } catch (err) { alert(err.message) }
      return
    }
    const reason = window.prompt('Hide this message from the trail? Reason (required):')
    if (!reason || !reason.trim()) return
    try { await updateEmail(m.id, { hidden: true, reason: reason.trim() }); onChanged('Message hidden') } catch (err) { alert(err.message) }
  }
  const retag = async () => {
    const next = window.prompt('Tags, comma-separated (e.g. PO:165251, PART:QL4-21, SO:15968, RFQ:371300, RMA:261007-20):', (m.refs || []).join(', '))
    if (next === null) return
    try { await updateEmail(m.id, { refs: next.split(',').map(s => s.trim()).filter(Boolean) }); onChanged('Tags saved') } catch (err) { alert(err.message) }
  }
  return (
    <div className={`border-l-2 pl-3 py-2 ${m.hidden_at ? 'border-gray-700 opacity-50' : m.direction === 'in' ? 'border-amber-600' : m.direction === 'out' ? 'border-cyan-600' : 'border-gray-600'}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-white font-medium">{m.from_name || m.from_addr}</span>
        {m.from_name && <span className="text-gray-500">{m.from_addr}</span>}
        <span className={`px-1.5 py-0.5 rounded border ${DIR_STYLE[m.direction]}`}>{DIR_LABEL[m.direction]}</span>
        <span className="text-gray-500">{fmtWhen(m.sent_at)}</span>
        <a href={gmailLink(m.rfc822_id)} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-cyan-400 inline-flex items-center gap-1"><ExternalLink size={11} />Gmail</a>
      </div>
      <div className="text-xs text-gray-500 mt-0.5">
        To {(m.to_addrs || []).join(', ') || '—'}{(m.cc_addrs || []).length ? ` · Cc ${m.cc_addrs.join(', ')}` : ''}
      </div>
      <div className="text-sm text-gray-200 whitespace-pre-wrap mt-2 leading-relaxed">{full ?? (m.body_new || m.snippet || '')}</div>
      {(m.attachments || []).length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {m.attachments.map((a, i) => (
            <span key={i} title="Attachments are listed by name only; open the message in Gmail to see them" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-gray-700 bg-gray-800 text-gray-400 text-xs">
              <Paperclip size={11} />{a.filename}{a.size ? ` · ${fmtSize(a.size)}` : ''}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
        {(m.refs || []).map(r => <span key={r} className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300 font-mono">{refLabel(r)}</span>)}
        <button type="button" onClick={showFull} disabled={busy} className="text-gray-500 hover:text-white">{full !== null ? 'Show new text only' : busy ? 'Loading…' : 'Show whole message'}</button>
        {canWrite && <button type="button" onClick={retag} className="text-gray-500 hover:text-white inline-flex items-center gap-1"><Tag size={11} />Tags</button>}
        {canWrite && <button type="button" onClick={hide} className="text-gray-500 hover:text-white inline-flex items-center gap-1">{m.hidden_at ? <><Eye size={11} />Show</> : <><EyeOff size={11} />Hide</>}</button>}
        {canWrite && <BobSwitch m={m} onChanged={onChanged} />}
        {m.bob_excluded_reason && <span className="text-amber-400/80">Kept from Uncle Bob: {m.bob_excluded_reason}</span>}
        {m.hidden_at && <span className="text-gray-500">Hidden: {m.hidden_reason}</span>}
        <span className="text-gray-600">seen in {(m.mailboxes || []).map(x => x.split('@')[0]).join(', ')}</span>
      </div>
    </div>
  )
}

// presetRef: one tag ('PO:165058'), or an order's tags (['PO:165058', 'SO:15392']) when opened
// from an order, which the ref filter offers as "This order" and matches on any of them.
export default function EmailTrail({ program, emails, syncState, canWrite, presetRef, onChanged }) {
  const orderRefs = Array.isArray(presetRef) ? presetRef : null
  const [q, setQ] = useState('')
  const [ref, setRef] = useState(orderRefs ? ORDER_REF : presetRef || '')
  const [dir, setDir] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [open, setOpen] = useState(() => new Set())
  const [syncing, setSyncing] = useState(false)

  const allRefs = useMemo(() => [...new Set(emails.flatMap(e => e.refs || []))].sort(), [emails])
  const threads = useMemo(() => {
    const term = q.trim().toLowerCase()
    const visible = emails.filter(e =>
      (showHidden || !e.hidden_at) &&
      (!dir || e.direction === dir) &&
      (!ref || (ref === ORDER_REF ? (e.refs || []).some(r => orderRefs.includes(r)) : (e.refs || []).includes(ref))) &&
      (!term || [e.subject, e.body_new, e.from_name, e.from_addr, ...(e.to_addrs || []), ...(e.attachments || []).map(a => a.filename)]
        .some(x => String(x || '').toLowerCase().includes(term))))
    return groupThreads(visible)
  }, [emails, q, ref, dir, showHidden, orderRefs])

  const toggle = (k) => setOpen(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const lastOk = syncState.map(s => s.last_success_at).filter(Boolean).sort().at(-1)
  const errors = syncState.filter(s => s.last_error)
  const backfilling = syncState.some(s => !s.backfill_done)

  const sync = async () => {
    setSyncing(true)
    try {
      const r = await syncEmails(program.code)
      const added = (r.results || []).reduce((s, x) => s + (x.added || 0), 0)
      onChanged(`Email sync done: ${added} new message${added === 1 ? '' : 's'}`)
    } catch (err) { alert(err.message) } finally { setSyncing(false) }
  }

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-lg">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-gray-800">
        <h2 className="text-white font-semibold text-sm flex items-center gap-2"><Mail size={14} />Email trail · {emails.filter(e => !e.hidden_at).length} messages</h2>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          <span>{lastOk ? `Last synced ${fmtWhen(lastOk)}` : 'Not synced yet'}{backfilling ? ' · still loading history' : ''}</span>
          <button type="button" onClick={sync} disabled={syncing}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border text-xs font-medium bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-700 disabled:opacity-40">
            <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />{syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </div>
      <div className="p-4 space-y-3">
        {errors.length > 0 && (
          <div className="text-xs text-red-300 bg-red-900/20 border border-red-900 rounded px-3 py-2">
            {errors.map(s => <div key={s.mailbox}>{s.mailbox}: {s.last_error}</div>)}
          </div>
        )}
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative">
            <Search size={14} className="absolute left-2 top-2.5 text-gray-500" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search subject, text, people, attachments"
              className="pl-7 pr-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm w-80 focus:border-cyan-500 focus:outline-none" />
          </div>
          <select value={ref} onChange={e => setRef(e.target.value)} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm">
            {orderRefs && <option value={ORDER_REF}>This order ({orderRefs.map(refLabel).join(' or ')})</option>}
            <option value="">All orders and parts</option>
            {allRefs.map(r => <option key={r} value={r}>{refLabel(r)}</option>)}
          </select>
          <select value={dir} onChange={e => setDir(e.target.value)} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm">
            <option value="">All directions</option>
            <option value="in">From customer</option><option value="out">To customer</option><option value="internal">Internal</option>
          </select>
          <label className="text-xs text-gray-400 flex items-center gap-1">
            <input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} />Show hidden
          </label>
        </div>

        {threads.length === 0 ? <div className="text-gray-500 text-sm">No messages match.</div> : (
          <ul className="divide-y divide-gray-800">
            {threads.map(t => {
              const isOpen = open.has(t.key)
              return (
                <li key={t.key} className="py-2">
                  <button type="button" onClick={() => toggle(t.key)} className="w-full text-left flex flex-wrap items-center gap-2">
                    {isOpen ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
                    <span className="text-white text-sm font-medium">{t.subject}</span>
                    <span className="text-gray-500 text-xs">{t.msgs.length} message{t.msgs.length === 1 ? '' : 's'} · {fmtWhen(t.last.sent_at)} · {t.last.from_name || t.last.from_addr}</span>
                    {t.refs.slice(0, 6).map(r => <span key={r} className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 text-xs font-mono">{refLabel(r)}</span>)}
                  </button>
                  {!isOpen && <div className="text-gray-500 text-xs mt-1 ml-6 truncate">{t.last.snippet || t.last.body_new}</div>}
                  {isOpen && (
                    <div className="mt-2 ml-6 space-y-2">
                      {t.msgs.map(m => <Message key={m.id} m={m} canWrite={canWrite} onChanged={onChanged} />)}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <div className="text-gray-600 text-xs">Read-only copies from Gmail, refreshed every 10 minutes. Attachments are listed by name; open the message in Gmail to see them.</div>
      </div>
    </section>
  )
}
