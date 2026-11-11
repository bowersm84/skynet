import { useState, useEffect, useMemo, useCallback } from 'react'
import { RefreshCw, Loader2, X, Plus, Search } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { hasRole } from '../lib/roles'
import {
  listOpenRequests, listBoard, listAssemblers, lastBuildQty, tagLotsForPart,
  searchAssemblyParts, createBuild, assignBuild, releaseBuild, cancelBuild, reworkLot, linkBuildMo, retryBuildMo,
  BUILD_STATUS_LABELS, BUILD_KIND_LABELS, POST_STATUS_LABELS, PRIORITIES, ACTIVE_BUILD_STATUSES,
} from '../lib/assembly'
import { getSettings } from '../lib/appSettings'
import { DEFAULT_AVATAR_COLOR } from '../lib/avatars'
import { Avatar } from '../components/AvatarPicker'
import { formatDateShort, formatDateTime } from '../lib/fishbowl'
import PostCards, { MoChip, LinkMoDialog } from '../components/assembly/PostCards'

// AssemblyBoard — S17 Batch B (D-ASM-04 / D-ASM-20 / D-ASM-31), revised in B2 (D-ASM-32). Jody's office board: Order
// Queue lines dispositioned Assembly arrive as requests grouped by part; a build is created from them (or from
// scratch for stock, special and rework), assigned to an assembler, run at the kiosk (Batch C), then released here.
// One column per assembler (v_assemblers) plus Unassigned, each with the assembler's avatar. The board only shows
// avatars — each assembler picks their own on the kiosk (Batch C, D-ASM-32). Every write is an assembly_* RPC
// (admin / assembly); the RPCs' messages are shown as they are. Labor rate and overhead moved to Armory → Costing
// rules (D-ASM-34).
const SKYBOLT_RED = '#B8222E'

const PRIORITY_STYLE = {
  critical: { className: 'text-white border-transparent', style: { backgroundColor: SKYBOLT_RED } },
  high: { className: 'bg-amber-900/50 text-amber-200 border-amber-700' },
  normal: { className: 'bg-gray-800 text-gray-400 border-gray-700' },
  low: { className: 'bg-gray-900 text-gray-500 border-gray-800' },
}

function Chip({ className = '', style, title, children }) {
  return <span title={title} style={style} className={`inline-flex items-center px-2 py-0.5 rounded text-xs border whitespace-nowrap ${className}`}>{children}</span>
}

function Modal({ title, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onMouseDown={onClose}>
      <div className={`bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h3 className="text-white font-semibold">{title}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3">{children}</div>
      </div>
    </div>
  )
}

const field = 'w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-skynet-accent'
const btn = 'px-3 py-1.5 rounded text-xs border transition-colors disabled:opacity-50'
const btnPrimary = 'px-3 py-1.5 rounded text-xs bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50 inline-flex items-center gap-1'
const fmtQty = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString())

export default function AssemblyBoard({ profile }) {
  const canAct = hasRole(profile, 'admin', 'assembly')

  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState(null) // { type, message }
  const [requests, setRequests] = useState([])
  const [partInfo, setPartInfo] = useState({}) // { [part_id]: description }
  const [builds, setBuilds] = useState([])
  const [assemblers, setAssemblers] = useState([])
  const [settings, setSettings] = useState({})
  const [busy, setBusy] = useState(false)
  const [createFor, setCreateFor] = useState(null)   // a v_assembly_requests_open row → Create build dialog
  const [assignFor, setAssignFor] = useState(null)   // a build → Assign dialog
  const [cancelFor, setCancelFor] = useState(null)   // a build → Cancel dialog
  const [scratchOpen, setScratchOpen] = useState(false)
  const [postCount, setPostCount] = useState(null)   // S17 D1: cards still waiting for Ashley
  const [linkFor, setLinkFor] = useState(null)       // S17 D1: a build → Link MO dialog
  const [createError, setCreateError] = useState(null) // D-ASM-56: the server's sentence, shown in the New build dialog

  const load = useCallback(async () => {
    try {
      const [rq, bd, as, st] = await Promise.all([listOpenRequests(), listBoard(), listAssemblers(), getSettings()])
      setRequests(rq)
      setBuilds(bd)
      setAssemblers(as)
      setSettings(st)
      const ids = [...new Set(rq.map((r) => r.part_id).filter(Boolean))]
      if (ids.length) {
        const { data } = await supabase.from('parts').select('id, description').in('id', ids)
        setPartInfo(Object.fromEntries((data || []).map((p) => [p.id, p.description])))
      }
    } catch (e) {
      setStatus({ type: 'error', message: `Could not load the board: ${e?.message || e}` })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 60000)
    return () => clearInterval(t)
  }, [load])

  // Creating a build: the server's refusal (no checklist, not approved, unknown part — D-ASM-56) is shown in the
  // dialog itself, where the person is looking, not on the page behind it.
  const create = async (args, okMessage, close) => {
    setBusy(true)
    setCreateError(null)
    try {
      await createBuild(args)
      setStatus({ type: 'success', message: okMessage })
      close()
      await load()
    } catch (e) {
      setCreateError(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  // Runs an RPC, shows its own message on failure, reloads on success.
  const act = async (fn, okMessage) => {
    setBusy(true)
    try {
      await fn()
      setStatus({ type: 'success', message: okMessage })
      await load()
      return true
    } catch (e) {
      setStatus({ type: 'error', message: e?.message || String(e) })
      return false
    } finally {
      setBusy(false)
    }
  }

  const lotPrefix = typeof settings.assembly_lot_prefix_display === 'string' ? settings.assembly_lot_prefix_display : ''
  const floor = useMemo(() => builds.filter((b) => ACTIVE_BUILD_STATUSES.includes(b.status) || b.status === 'released'), [builds])
  // Unassigned, then one column per assembler. A build assigned to someone who is no longer an active assembler
  // keeps a column of its own, so it never drops off the board.
  const columns = useMemo(() => {
    const ids = new Set(assemblers.map((a) => a.id))
    const former = new Map()
    for (const b of floor) {
      if (b.assigned_to && !ids.has(b.assigned_to) && !former.has(b.assigned_to)) {
        former.set(b.assigned_to, { id: b.assigned_to, full_name: b.assigned_name || 'Former assembler', avatar_icon: b.assigned_avatar_icon, avatar_color: b.assigned_avatar_color, former: true })
      }
    }
    return [
      { id: null, person: null, builds: floor.filter((b) => !b.assigned_to) },
      ...[...assemblers, ...former.values()].map((p) => ({ id: p.id, person: p, builds: floor.filter((b) => b.assigned_to === p.id) })),
    ]
  }, [floor, assemblers])
  const awaitingRelease = builds.filter((b) => b.status === 'complete')

  if (!canAct) {
    return <div className="max-w-3xl mx-auto p-6 text-gray-400">The Assembly Board is for the assembly team and admins.</div>
  }

  return (
    <div className="max-w-[1800px] mx-auto p-6 space-y-6 pb-16">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-white">Assembly Board</h2>
          <p className="text-gray-500 text-sm mt-1">Requests from the Order Queue, builds by assembler, release — the kiosk runs the builds (S17)</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setScratchOpen(true)} className={btnPrimary}><Plus size={12} /> Build from scratch</button>
          <button onClick={() => { setLoading(true); load() }} disabled={loading}
            className="flex items-center gap-2 px-3 py-2 rounded text-sm text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {status && (
        <div className={`p-3 rounded text-sm flex justify-between items-center ${status.type === 'success' ? 'bg-green-900/40 text-green-300 border border-green-800' : 'bg-red-900/40 text-red-300 border border-red-800'}`}>
          <span>{status.message}</span>
          <button onClick={() => setStatus(null)}><X size={14} /></button>
        </div>
      )}

      {loading && builds.length === 0 && requests.length === 0 ? (
        <div className="text-center py-16 bg-gray-900 rounded-lg border border-gray-800 text-gray-400 flex items-center justify-center gap-2">
          <Loader2 size={16} className="animate-spin" /> Loading the board...
        </div>
      ) : (
        <>
          {/* 1. Requests */}
          <section className="bg-gray-900 rounded-lg border border-gray-800">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
              <h3 className="text-white font-semibold">Requests</h3>
              <span className="text-xs text-gray-500">Order Queue lines dispositioned Assembly, by part</span>
            </div>
            {requests.length === 0 ? (
              <div className="px-4 py-6 text-sm text-gray-500">No open requests.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-800/60 text-gray-400 text-xs uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">Part</th>
                    <th className="px-3 py-2 text-left hidden lg:table-cell">Description</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Requests</th>
                    <th className="px-3 py-2 text-left">Earliest due</th>
                    <th className="px-3 py-2 text-left">SO lines</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {requests.map((r) => (
                    <tr key={r.part_number}>
                      <td className="px-3 py-2 font-mono text-gray-200">{r.part_number}</td>
                      <td className="px-3 py-2 text-gray-500 text-xs hidden lg:table-cell max-w-[320px] truncate" title={partInfo[r.part_id] || ''}>{partInfo[r.part_id] || ''}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmtQty(r.qty_total)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{r.request_count}</td>
                      <td className="px-3 py-2 font-mono text-xs">{formatDateShort(r.earliest_due)}</td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-400">{r.lines}</td>
                      <td className="px-3 py-2 text-right">
                        <button disabled={busy} onClick={() => setCreateFor(r)} className={btnPrimary}>Create build</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* 2. Builds by assembler */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-white font-semibold">Builds by assembler</h3>
              <span className="text-xs text-gray-500">{floor.length} build{floor.length === 1 ? '' : 's'}</span>
              {assemblers.length === 0 && <span className="text-xs text-amber-300">No active profile has the assembly role yet — give it in Armory → Users.</span>}
            </div>
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, minmax(220px, 1fr))`, overflowX: 'auto' }}>
              {columns.map((col) => (
                <div key={col.id || 'unassigned'} className="bg-gray-900 rounded-lg border border-gray-800 min-h-[160px]">
                  <div className="px-3 py-2 border-b border-gray-800 text-sm text-gray-300 flex items-center gap-2">
                    {col.person ? (
                      <>
                        <Avatar icon={col.person.avatar_icon} color={col.person.avatar_color} name={col.person.full_name} size={28} />
                        <span className="font-medium truncate">{col.person.full_name}</span>
                        {col.person.former && <span className="text-xs text-gray-600">not an assembler now</span>}
                      </>
                    ) : (
                      <span className="font-medium">Unassigned</span>
                    )}
                    <span className="ml-auto text-xs text-gray-600">{col.builds.length}</span>
                  </div>
                  <div className="p-2 space-y-2">
                    {col.builds.map((b) => (
                      <BuildCard key={b.id} build={b} lotPrefix={lotPrefix} busy={busy}
                        onAssign={() => setAssignFor(b)}
                        onCancel={() => setCancelFor(b)}
                        onRelease={() => act(() => releaseBuild(b.id), `${b.build_number} released.`)}
                        onLinkMo={() => setLinkFor(b)}
                        onRetryMo={() => act(() => retryBuildMo(b.id), `${b.build_number}: the MO is queued for the bridge again.`)} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* 4. Awaiting release / Ready to post */}
          <section className="grid md:grid-cols-2 gap-3">
            <ShortList title="Awaiting release" empty="Nothing complete and waiting." rows={awaitingRelease}
              render={(b) => (
                <button disabled={busy} onClick={() => act(() => releaseBuild(b.id), `${b.build_number} released.`)} className={btnPrimary}>Release</button>
              )} />
            {/* S17 D1 (D-ASM-54): the same post cards as the Order Queue's Ready to post tab, compact. */}
            <div className="bg-gray-900 rounded-lg border border-gray-800">
              <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
                <h3 className="text-white font-semibold">Ready to post</h3>
                <span className="text-xs text-gray-600">{postCount ?? '…'}</span>
                <span className="text-xs text-gray-500 ml-auto">Ashley posts these in Fishbowl — Order Queue › Ready to post</span>
              </div>
              <PostCards profile={profile} compact onCount={setPostCount} />
            </div>
          </section>
        </>
      )}

      {createFor && (
        <CreateFromRequestDialog request={createFor} description={partInfo[createFor.part_id]} busy={busy} error={createError}
          onClose={() => { setCreateFor(null); setCreateError(null) }}
          onCreate={(args) => create(args, `Build created for ${args.partNumber}.`, () => setCreateFor(null))} />
      )}
      {scratchOpen && (
        <CreateFromScratchDialog busy={busy} error={createError} onClose={() => { setScratchOpen(false); setCreateError(null) }}
          onCreate={(args) => create(args, `${BUILD_KIND_LABELS[args.buildKind]} build created for ${args.partNumber}.`, () => setScratchOpen(false))} />
      )}
      {assignFor && (
        <AssignDialog build={assignFor} assemblers={assemblers} busy={busy} onClose={() => setAssignFor(null)}
          onAssign={async (person) => { if (await act(() => assignBuild(assignFor.id, person.id), `${assignFor.build_number} assigned to ${person.full_name}.`)) setAssignFor(null) }} />
      )}
      {linkFor && (
        <LinkMoDialog card={linkFor} busy={busy} onClose={() => setLinkFor(null)}
          onLink={async (n) => { if (await act(() => linkBuildMo(linkFor.id, n), `${linkFor.build_number} linked to Fishbowl MO ${n}.`)) setLinkFor(null) }} />
      )}
      {cancelFor && (
        <CancelDialog build={cancelFor} busy={busy} onClose={() => setCancelFor(null)}
          onCancel={async (reason) => { if (await act(() => cancelBuild(cancelFor.id, reason), `${cancelFor.build_number} cancelled.`)) setCancelFor(null) }} />
      )}
    </div>
  )
}

function BuildCard({ build: b, lotPrefix, busy, onAssign, onCancel, onRelease, onLinkMo, onRetryMo }) {
  const p = PRIORITY_STYLE[b.priority] || PRIORITY_STYLE.normal
  const released = b.status === 'released'
  return (
    <div className={`rounded border p-2 text-xs space-y-1 ${released ? 'border-gray-800 bg-gray-950/60 text-gray-500' : 'border-gray-700 bg-gray-800/40 text-gray-300'}`}
      style={!released && b.priority === 'critical' ? { boxShadow: `inset 3px 0 0 ${SKYBOLT_RED}` } : undefined}>
      <div className="flex items-center gap-1 flex-wrap">
        <span className="font-mono text-white">{b.build_number}</span>
        {b.build_kind !== 'order' && <Chip className="bg-gray-900 text-purple-300 border-purple-900">{BUILD_KIND_LABELS[b.build_kind]}</Chip>}
        {b.priority !== 'normal' && <Chip className={p.className} style={p.style}>{b.priority}</Chip>}
      </div>
      <div className="font-mono text-gray-200">{b.part_number} <span className="text-gray-500">× {fmtQty(b.quantity)}</span></div>
      <div className="flex items-center gap-2 flex-wrap text-gray-400">
        <span>{BUILD_STATUS_LABELS[b.status] || b.status}</span>
        {Number(b.minutes_total) > 0 && <span>· {Math.round(Number(b.minutes_total))} min</span>}
      </div>
      {b.assigned_to && (
        <span className="inline-flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 rounded-full text-gray-100 border"
          style={{ borderColor: b.assigned_avatar_color || DEFAULT_AVATAR_COLOR, backgroundColor: `${b.assigned_avatar_color || DEFAULT_AVATAR_COLOR}33` }}>
          <Avatar icon={b.assigned_avatar_icon} color={b.assigned_avatar_color} name={b.assigned_name} size={18} />
          {b.assigned_name}
        </span>
      )}
      {b.assembly_lot_number && <div className="font-mono text-cyan-300">Lot {lotPrefix}{b.assembly_lot_number}</div>}
      {b.build_kind === 'rework' && !b.assembly_lot_number && <div className="font-mono text-gray-500">Rework of {b.rework_source_lot} → {reworkLot(b.rework_source_lot)}</div>}
      {/* S17 D1 (D-ASM-52/55): the build's Fishbowl MO, Retry after an error, Link MO… for a hand-made one. */}
      {(b.fb_mo_num || (b.fb_mo_state && b.fb_mo_state !== 'none')) && <div><MoChip number={b.fb_mo_num} state={b.fb_mo_state} error={b.fb_mo_error} /></div>}
      {b.fb_mo_state === 'error' && (
        <div className="text-red-300 bg-red-950/40 border border-red-900 rounded px-2 py-1 space-y-1">
          <div>{b.fb_mo_error || 'The bridge could not create the MO.'}</div>
          {b.status !== 'cancelled' && <button disabled={busy} onClick={onRetryMo} className={`${btn} bg-gray-800 border-gray-700 text-gray-200 hover:text-white`}>Retry</button>}
        </div>
      )}
      {!b.checklist_template_id && !released && (
        <div className="text-amber-200 bg-amber-950/40 border border-amber-800 rounded px-2 py-1" title="No checklist family was found for this part when the build was made">No checklist — the kiosk has no steps for this build</div>
      )}
      {released ? (
        <Chip className="bg-blue-900/40 text-blue-300 border-blue-800" title={b.released_at ? `Released ${formatDateTime(b.released_at)}` : ''}>{POST_STATUS_LABELS[b.fb_post_status] || b.fb_post_status}</Chip>
      ) : (
        <div className="flex gap-1 pt-1">
          {['requested', 'assigned'].includes(b.status) && (
            <>
              <button disabled={busy} onClick={onAssign} className={`${btn} bg-gray-800 border-gray-700 text-gray-200 hover:text-white`}>Assign</button>
              <button disabled={busy} onClick={onCancel} className={`${btn} bg-gray-900 border-gray-800 text-gray-400 hover:text-red-300`}>Cancel</button>
            </>
          )}
          {b.status === 'paused' && (
            <button disabled={busy} onClick={onCancel} className={`${btn} bg-gray-900 border-gray-800 text-gray-400 hover:text-red-300`}>Cancel</button>
          )}
          {b.status === 'complete' && <button disabled={busy} onClick={onRelease} className={btnPrimary}>Release</button>}
          <button disabled={busy} onClick={onLinkMo} title="Link a Fishbowl MO made by hand" className={`${btn} bg-gray-900 border-gray-800 text-gray-400 hover:text-white ml-auto`}>Link MO…</button>
        </div>
      )}
    </div>
  )
}

function ShortList({ title, rows, empty, note, render }) {
  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800">
      <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
        <h3 className="text-white font-semibold">{title}</h3>
        <span className="text-xs text-gray-600">{rows.length}</span>
        {note && <span className="text-xs text-gray-500 ml-auto">{note}</span>}
      </div>
      {rows.length === 0 ? <div className="px-4 py-4 text-sm text-gray-500">{empty}</div> : (
        <div className="divide-y divide-gray-800">
          {rows.map((b) => (
            <div key={b.id} className="px-4 py-2 flex items-center gap-3 text-sm">
              <span className="font-mono text-white">{b.build_number}</span>
              <span className="font-mono text-gray-300">{b.part_number}</span>
              <span className="text-gray-500 text-xs">× {fmtQty(b.good_quantity ?? b.quantity)}</span>
              {b.assembly_lot_number && <span className="font-mono text-xs text-cyan-300">lot {b.assembly_lot_number}</span>}
              <span className="ml-auto">{render(b)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// D-ASM-56: why the server would not create the build, in its own words.
function CreateError({ message }) {
  return <div role="alert" className="text-sm text-red-300 bg-red-950/40 border border-red-900 rounded px-3 py-2">{message}</div>
}

function PrioritySelect({ value, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={field}>
      {PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
    </select>
  )
}

// Create build from a part's open requests. Quantity starts at the larger of the requests' total and the last
// released build of the part; both are shown so Jody can see where the number came from.
function CreateFromRequestDialog({ request, description, busy, error, onClose, onCreate }) {
  const [last, setLast] = useState(undefined)
  const [qty, setQty] = useState(String(Math.ceil(Number(request.qty_total || 0))))
  const [priority, setPriority] = useState('normal')
  const [note, setNote] = useState('')
  useEffect(() => {
    let alive = true
    lastBuildQty(request.part_number).then((r) => {
      if (!alive) return
      setLast(r)
      setQty(String(Math.max(Math.ceil(Number(request.qty_total || 0)), Number(r?.quantity || 0))))
    }).catch(() => { if (alive) setLast(null) })
    return () => { alive = false }
  }, [request.part_number, request.qty_total])
  const n = Number(qty)
  return (
    <Modal title={`Create build — ${request.part_number}`} onClose={onClose}>
      {description && <p className="text-xs text-gray-500">{description}</p>}
      <label className="block text-xs text-gray-400">Quantity
        <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" className={`${field} mt-1`} />
      </label>
      <p className="text-xs text-gray-500">
        Requests total {fmtQty(request.qty_total)} ({request.request_count} line{request.request_count === 1 ? '' : 's'}: {request.lines})
        {' · '}{last === undefined ? 'last build …' : last ? `last build ${fmtQty(last.quantity)} on ${formatDateTime(last.released_at)}` : 'no earlier build of this part'}
      </p>
      <label className="block text-xs text-gray-400">Priority<div className="mt-1"><PrioritySelect value={priority} onChange={setPriority} /></div></label>
      <label className="block text-xs text-gray-400">Note
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={`${field} mt-1`} />
      </label>
      {error && <CreateError message={error} />}
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onClose} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white">Close</button>
        <button disabled={busy || !(Number.isInteger(n) && n > 0)} className={btnPrimary}
          onClick={() => onCreate({ partNumber: request.part_number, quantity: n, buildKind: 'order', priority, note, requestIds: request.request_ids })}>
          {busy && <Loader2 size={12} className="animate-spin" />} Create build
        </button>
      </div>
    </Modal>
  )
}

// Stock, special and rework builds have no request. A rework build names the lot it reworks; its own lot is that
// lot with R appended (D-ASM-02). Program builds start from the Giza dashboard (Batch C), not here.
function CreateFromScratchDialog({ busy, error, onClose, onCreate }) {
  const [term, setTerm] = useState('')
  const [results, setResults] = useState([])
  const [part, setPart] = useState(null)
  const [qty, setQty] = useState('')
  const [kind, setKind] = useState('stock')
  const [priority, setPriority] = useState('normal')
  const [note, setNote] = useState('')
  const [lots, setLots] = useState(null)
  const [sourceLot, setSourceLot] = useState('')
  useEffect(() => {
    if (part) return undefined
    let alive = true
    const t = setTimeout(() => {
      searchAssemblyParts(term).then((r) => { if (alive) setResults(r) }).catch(() => { if (alive) setResults([]) })
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [term, part])
  // lots is reset to null (reading) wherever the part or kind changes, below.
  useEffect(() => {
    if (!part || kind !== 'rework') return undefined
    let alive = true
    tagLotsForPart(part.part_number).then((r) => { if (alive) setLots(r) }).catch(() => { if (alive) setLots([]) })
    return () => { alive = false }
  }, [part, kind])
  const n = Number(qty)
  const ok = part && Number.isInteger(n) && n > 0 && (kind !== 'rework' || sourceLot)
  return (
    <Modal title="Build from scratch" onClose={onClose} wide>
      {!part ? (
        <>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Assembly part number or description" className={`${field} pl-9`} />
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-gray-800 border border-gray-800 rounded">
            {results.length === 0 ? <div className="px-3 py-3 text-xs text-gray-500">No assembly parts match.</div> : results.map((p) => (
              <button key={p.id} onClick={() => { setLots(null); setPart(p) }} className="w-full text-left px-3 py-2 hover:bg-gray-800 text-sm">
                <span className="font-mono text-gray-200">{p.part_number}</span>
                <span className="text-xs text-gray-500 ml-2">{p.description}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-mono text-white">{part.part_number}</span>
            <span className="text-xs text-gray-500 truncate">{part.description}</span>
            <button onClick={() => { setPart(null); setSourceLot('') }} className="ml-auto text-xs text-gray-400 hover:text-white">Change part</button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="block text-xs text-gray-400">Kind
              <select value={kind} onChange={(e) => { setLots(null); setKind(e.target.value); setSourceLot('') }} className={`${field} mt-1`}>
                <option value="stock">Stock</option>
                <option value="special">Special</option>
                <option value="rework">Rework</option>
              </select>
            </label>
            <label className="block text-xs text-gray-400">Quantity
              <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" className={`${field} mt-1`} />
            </label>
            <label className="block text-xs text-gray-400">Priority<div className="mt-1"><PrioritySelect value={priority} onChange={setPriority} /></div></label>
          </div>
          {kind === 'rework' && (
            <div className="space-y-1">
              <div className="text-xs text-gray-400">Source lot (Fishbowl on hand)</div>
              {lots === null ? <div className="text-xs text-gray-500 flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> Reading lots…</div>
                : lots.length === 0 ? <div className="text-xs text-amber-300">No lot of {part.part_number} is on hand in Fishbowl.</div> : (
                  <div className="max-h-48 overflow-y-auto border border-gray-800 rounded divide-y divide-gray-800">
                    {lots.map((t) => (
                      <label key={t.fb_tag_id} className="flex items-center gap-3 px-3 py-1.5 text-xs cursor-pointer hover:bg-gray-800">
                        <input type="radio" name="sourceLot" checked={sourceLot === t.lot_number} onChange={() => setSourceLot(t.lot_number)} disabled={!t.lot_number} className="accent-purple-500" />
                        <span className="font-mono text-gray-200 w-24">{t.lot_number || '(no lot)'}</span>
                        <span className="font-mono text-gray-400 w-20 text-right">{fmtQty(t.qty)}</span>
                        <span className="text-gray-500">{t.location}</span>
                        <span className="text-gray-600 ml-auto">tag {t.tag_num}</span>
                      </label>
                    ))}
                  </div>
                )}
              {sourceLot && <div className="text-xs text-gray-400">This build's lot will be <span className="font-mono text-cyan-300">{reworkLot(sourceLot)}</span></div>}
            </div>
          )}
          <label className="block text-xs text-gray-400">Note
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={`${field} mt-1`} />
          </label>
          {error && <CreateError message={error} />}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white">Close</button>
            <button disabled={busy || !ok} className={btnPrimary}
              onClick={() => onCreate({ partNumber: part.part_number, quantity: n, buildKind: kind, priority, note, reworkSourceLot: kind === 'rework' ? sourceLot : null })}>
              {busy && <Loader2 size={12} className="animate-spin" />} Create build
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

// D-ASM-32: a build goes to an assembler; benches are not on the board.
function AssignDialog({ build, assemblers, busy, onClose, onAssign }) {
  const [profileId, setProfileId] = useState(build.assigned_to || '')
  const person = assemblers.find((p) => p.id === profileId)
  return (
    <Modal title={`Assign ${build.build_number} — ${build.part_number}`} onClose={onClose}>
      {assemblers.length === 0 ? (
        <p className="text-xs text-amber-300">No active profile has the assembly role yet — give it in Armory → Users, then assign.</p>
      ) : (
        <div className="space-y-1">
          <div className="text-xs text-gray-400">Assembler</div>
          {assemblers.map((p) => (
            <label key={p.id} className={`flex items-center gap-3 px-3 py-2 rounded border cursor-pointer text-sm ${profileId === p.id ? 'border-purple-500 bg-purple-900/20 text-white' : 'border-gray-800 text-gray-300 hover:bg-gray-800'}`}>
              <input type="radio" name="assembler" checked={profileId === p.id} onChange={() => setProfileId(p.id)} className="accent-purple-500" />
              <Avatar icon={p.avatar_icon} color={p.avatar_color} name={p.full_name} size={24} />
              {p.full_name}
            </label>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onClose} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white">Close</button>
        <button disabled={busy || !person || profileId === build.assigned_to} onClick={() => onAssign(person)} className={btnPrimary}>
          {busy && <Loader2 size={12} className="animate-spin" />} Assign
        </button>
      </div>
    </Modal>
  )
}

function CancelDialog({ build, busy, onClose, onCancel }) {
  const [reason, setReason] = useState('')
  return (
    <Modal title={`Cancel ${build.build_number} — ${build.part_number}`} onClose={onClose}>
      <p className="text-xs text-gray-400">Its requests go back to the Requests list.</p>
      <label className="block text-xs text-gray-400">Reason (required)
        <textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className={`${field} mt-1`} />
      </label>
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onClose} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white">Keep the build</button>
        <button disabled={busy || !reason.trim()} onClick={() => onCancel(reason.trim())}
          className="px-3 py-1.5 rounded text-xs text-white disabled:opacity-50 inline-flex items-center gap-1" style={{ backgroundColor: SKYBOLT_RED }}>
          {busy && <Loader2 size={12} className="animate-spin" />} Cancel build
        </button>
      </div>
    </Modal>
  )
}
