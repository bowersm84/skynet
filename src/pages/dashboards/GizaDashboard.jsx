// Giza Dashboard — /dashboards/giza (S15, D-GIZA; branch model D-GIZA-21..27).
// Every bag lot is one unbroken trail. A Steel Nut Receipt creates the next lot number; a move that
// would change the trail (nylon, plating, dry-film, cage or retainer lot) lands in a new numbered lot
// automatically. This page shows the pipeline for all lots or one lot ("Branch (3007) Pipeline"),
// demand from the Fishbowl mirror, components, forecast, throughput, the lot register that replaced
// the paper "MS21077 Platenut Assembly" sheet, and the movement ledger. Everyone signed in can view;
// logging, closing and editing are admin + order_processor (canLogProgramTracker), enforced again by
// the RPCs (D-GIZA-08). Painted / Baked come from James's dry-film batches (D-GIZA-09).

import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw, Plus, Printer, Lock, RotateCcw, Pencil, Ban, Thermometer, Paintbrush, AlertTriangle, X, GitBranch, CalendarDays, LayoutGrid } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { FEATURES } from '../../config'
import { canLogProgramTracker, hasRole } from '../../lib/roles'
import {
  GIZA_PROGRAM_CODE, loadProgramBundle, logEntry, voidEntry, closeFinalLot, reopenFinalLot, updateFinalLot,
} from '../../lib/programTracker'
import {
  STAGE_LABELS, SPLIT_REASON_LABELS, FLOW_STAGES, THROUGHPUT_STAGES, isoDay, lastNDays, dailyMatrix, sevenDayRates,
  constrainingStage, forecast, ovenCapacity, inProcess, lotsReadyFor, previewRoute, selectableLots, sortLots, canReopen,
  bucketValues, componentLots, recentInitials, lotLabelHtml,
  lastWorkingDay, dayMovements, movementsReportHtml, PURCHASE_ROLE_LABELS, sortPurchasing, purchasingSummary,
} from '../../lib/programTrackerMath'

const POLL_MS = 60000
const BAKE_MINUTES = 120
const VENDORS = ['Xiamen', 'Maxtrust', 'Electrolab']
const ROLE_LABELS = { nut: 'Steel nut', cage: 'Cage', retainer: 'Retainer', insert: 'Nylon insert' }

const fmt = (v) => Number(v || 0).toLocaleString()
const fmtDate = (iso) => {
  if (!iso) return '—'
  const s = String(iso)
  const d = s.length > 10 ? new Date(s) : new Date(`${s}T12:00:00`)
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' })
}

// Pipeline cards. `log` = the move that brings pieces INTO the card (D-GIZA-26: no Bagged step).
const BUCKETS = [
  { key: 'receipt', label: 'Steel Nut Receipt', sub: 'awaiting nylon insert', log: 'received' },
  { key: 'nylon', label: 'Insert nylon', sub: 'done · awaiting plating', log: 'washer_inserted' },
  { key: 'electrolab', label: 'At Electrolab', sub: 'out for plating', log: 'sent_plating' },
  { key: 'plating', label: 'Back from plating', sub: 'awaiting paint', log: 'returned_plating' },
  { key: 'paint', label: 'Paint', sub: 'Finishing kiosk', kiosk: 'paint' },
  { key: 'oven', label: 'Oven', sub: 'Finishing kiosk', kiosk: 'bake' },
  { key: 'baked', label: 'Baked', sub: 'awaiting assembly' },
  { key: 'assembled', label: 'Assembled & bagged', sub: 'awaiting ship', subLot: 'in this lot', log: 'assembled' },
  { key: 'shipped', label: 'Shipped', sub: 'since tracking · Fishbowl', allOnly: true },
]

const LOG_LABELS = {
  received: 'Log steel nut receipt',
  washer_inserted: 'Log insert nylon',
  sent_plating: 'Log sent to Electrolab',
  returned_plating: 'Log back from Electrolab',
  assembled: 'Log assembled',
}

function Panel({ title, right, children }) {
  return (
    <section className="bg-gray-900 border border-gray-800 rounded-lg">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-gray-800">
        <h2 className="text-white font-semibold text-sm">{title}</h2>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

function Kpi({ label, value, note, tone }) {
  const color = tone === 'alert' ? 'text-red-400' : tone === 'warn' ? 'text-amber-400' : tone === 'good' ? 'text-green-400' : 'text-white'
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
      <div className="text-gray-500 text-xs uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${color}`}>{value}</div>
      {note && <div className="text-gray-500 text-xs mt-1">{note}</div>}
    </div>
  )
}

const Btn = ({ children, onClick, tone = 'gray', disabled, title }) => {
  const tones = {
    gray: 'bg-gray-800 hover:bg-gray-700 text-gray-200 border-gray-700',
    cyan: 'bg-cyan-700 hover:bg-cyan-600 text-white border-cyan-600',
    red: 'bg-red-900/40 hover:bg-red-900/70 text-red-300 border-red-800',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-xs font-medium transition-colors disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  )
}

function Field({ label, children, hint }) {
  return (
    <label className="block">
      <span className="block text-gray-400 text-xs mb-1">{label}</span>
      {children}
      {hint && <span className="block text-gray-600 text-xs mt-1">{hint}</span>}
    </label>
  )
}

const inputCls = 'w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm focus:border-cyan-500 focus:outline-none'

function Modal({ title, onClose, children, footer }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg border border-gray-700 w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h3 className="text-white font-semibold">{title}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-white"><X size={20} /></button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">{children}</div>
        <div className="p-4 border-t border-gray-700 flex justify-end gap-2">{footer}</div>
      </div>
    </div>
  )
}

// One line of a lot's trail: nut / nylon / plating / dry film / FLN / cage / retainer.
function Trail({ lot }) {
  const parts = [
    ['Nut', lot.nut_lot], ['Nylon', lot.insert_lot], ['Plating', lot.plating_lot], ['Dry film', lot.dry_film_lot],
    ['FLN', lot.finishing_lot], ['Cage', lot.cage_lot], ['Retainer', lot.retainer_lot],
  ]
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-mono">
      {parts.map(([k, v]) => (
        <span key={k}><span className="text-gray-500 font-sans">{k}</span> <span className={v ? 'text-gray-200' : 'text-gray-600'}>{v || '—'}</span></span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- Entry modal (one ledger move)
export function EntryModal({ bundle, preset, today, onClose, onSaved }) {
  const { program, parts, ledger, lots } = bundle
  const partByRole = Object.fromEntries(parts.map(p => [p.role, p]))
  const nutId = partByRole.nut?.part_id
  const [stage, setStage] = useState(preset.stage || 'received')
  const [role, setRole] = useState(preset.role || 'nut')
  const [branchId, setBranchId] = useState(preset.lotId || '')
  const [lot, setLot] = useState('')
  const [cageLot, setCageLot] = useState('')
  const [retainerLot, setRetainerLot] = useState('')
  const [qty, setQty] = useState('')
  const [vendor, setVendor] = useState('')
  const [po, setPo] = useState('')
  const [expectedReturn, setExpectedReturn] = useState('')
  const [entryDate, setEntryDate] = useState(today)
  const [doneBy, setDoneBy] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const ready = lotsReadyFor(lots, stage)
  const chosen = ready.find(r => r.id === branchId) || null
  const initials = recentInitials(ledger)
  const nylonLots = partByRole.insert ? componentLots(ledger, partByRole.insert.part_id) : []
  const cageLots = partByRole.cage ? componentLots(ledger, partByRole.cage.part_id) : []
  const retainerLots = partByRole.retainer ? componentLots(ledger, partByRole.retainer.part_id) : []

  // Stage change: keep a preset lot if it can make this move, else clear; default the vendor.
  useEffect(() => {
    setLot(''); setCageLot(''); setRetainerLot('')
    setBranchId(prev => (lotsReadyFor(lots, stage).some(r => r.id === prev) ? prev : ''))
    if (stage === 'sent_plating' || stage === 'returned_plating') setVendor('Electrolab')
    else if (stage !== 'received') setVendor('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage])

  // Picking a lot defaults the quantity to what it has waiting for this move.
  useEffect(() => {
    if (chosen) setQty(String(chosen.qty))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId])

  const qtyNum = parseInt(qty, 10)
  const overMove = chosen && qtyNum > chosen.qty
  const preview = stage === 'received' ? null : previewRoute(chosen?.row, stage, { insert_lot: lot, plating_lot: lot, cage_lot: cageLot, retainer_lot: retainerLot })

  const save = async () => {
    const partId = stage === 'received' ? partByRole[role]?.part_id : nutId
    if (!partId) { alert('That part is not set up on this program.'); return }
    if (!(qtyNum > 0)) { alert('Enter a quantity greater than zero.'); return }
    if (stage !== 'received' && !branchId) { alert('Pick the lot these pieces belong to.'); return }
    setSaving(true)
    try {
      const r = await logEntry({
        programId: program.id, partId, stage, qty: qtyNum, lot, branchId: stage === 'received' ? null : branchId,
        cageLot, retainerLot, vendor, po, expectedReturn, entryDate, doneBy, notes,
      })
      let msg = `${STAGE_LABELS[stage]}: ${fmt(qtyNum)} logged`
      if (r?.new_branch) msg = `Steel nut receipt logged — lot ${r.lot_number} created`
      else if (r?.split) msg = `${msg} — continued as lot ${r.lot_number} (${SPLIT_REASON_LABELS[r.reason] || r.reason})`
      else if (r?.lot_number) msg = `${msg} on lot ${r.lot_number}`
      onSaved(msg)
    } catch (err) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  const datalist = (id, opts) => (
    <datalist id={id}>{opts.map(o => <option key={o.lot} value={o.lot}>{`${fmt(o.qty)} received ${fmtDate(o.date)}`}</option>)}</datalist>
  )

  return (
    <Modal
      title={LOG_LABELS[stage]}
      onClose={onClose}
      footer={<>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="cyan" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn>
      </>}
    >
      <Field label="Stage">
        <select value={stage} onChange={(e) => setStage(e.target.value)} className={inputCls}>
          {Object.keys(LOG_LABELS).map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
        </select>
      </Field>

      {stage === 'received' && (
        <>
          <Field label="Part">
            <select value={role} onChange={(e) => setRole(e.target.value)} className={inputCls}>
              {['nut', 'cage', 'retainer', 'insert'].filter(r => partByRole[r]).map(r => (
                <option key={r} value={r}>{ROLE_LABELS[r]} — {partByRole[r].part?.part_number}</option>
              ))}
            </select>
          </Field>
          <Field label="Receiving lot #" hint={role === 'nut' ? `A steel nut receipt starts a new lot — it will be ${program.final_lot_next}.` : 'Component stock — no lot number is created.'}>
            <input value={lot} onChange={(e) => setLot(e.target.value)} className={`${inputCls} font-mono`} />
          </Field>
        </>
      )}

      {stage !== 'received' && (
        <Field label="Lot" hint={ready.length === 0 ? 'No lot has pieces waiting for this step.' : null}>
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={inputCls}>
            <option value="">— Pick the lot —</option>
            {ready.map(r => (
              <option key={r.id} value={r.id}>
                {`Lot ${r.lot} — ${fmt(r.qty)} waiting · nut ${r.row.nut_lot || '?'}${r.row.status === 'closed' ? ' · closed' : ''}`}
              </option>
            ))}
          </select>
        </Field>
      )}

      {chosen && <div className="bg-gray-800/60 rounded p-2"><Trail lot={chosen.row} /></div>}

      {stage === 'washer_inserted' && (
        <Field label="Nylon insert lot">
          <input list="giza-nylon-lots" value={lot} onChange={(e) => setLot(e.target.value)} className={`${inputCls} font-mono`} />
          {datalist('giza-nylon-lots', nylonLots)}
        </Field>
      )}

      {stage === 'returned_plating' && (
        <Field label="Plating lot # (assigned by receiving on return)">
          <input value={lot} onChange={(e) => setLot(e.target.value)} className={`${inputCls} font-mono`} />
        </Field>
      )}

      {stage === 'assembled' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cage lot">
            <input list="giza-cage-lots" value={cageLot} onChange={(e) => setCageLot(e.target.value)} className={`${inputCls} font-mono`} />
            {datalist('giza-cage-lots', cageLots)}
          </Field>
          <Field label="Retainer lot">
            <input list="giza-retainer-lots" value={retainerLot} onChange={(e) => setRetainerLot(e.target.value)} className={`${inputCls} font-mono`} />
            {datalist('giza-retainer-lots', retainerLots)}
          </Field>
        </div>
      )}

      {preview?.split && (
        <p className="text-amber-300 text-xs flex items-start gap-1 bg-amber-950/30 border border-amber-800 rounded p-2">
          <GitBranch size={12} className="mt-0.5 shrink-0" />
          {preview.reason === 'after_close'
            ? `Lot ${chosen?.lot} is closed — these pieces will continue as a new lot (${program.final_lot_next}).`
            : `${SPLIT_REASON_LABELS[preview.reason]} from lot ${chosen?.lot} — these pieces will become a new lot (${program.final_lot_next}).`}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Quantity">
          <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} className={`${inputCls} font-mono`} />
        </Field>
        <Field label="Date">
          <input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} className={inputCls} />
        </Field>
      </div>
      {overMove && (
        <p className="text-amber-400 text-xs flex items-center gap-1">
          <AlertTriangle size={12} /> More than the {fmt(chosen.qty)} lot {chosen.lot} has waiting — check the count. It will still save.
        </p>
      )}

      {['received', 'sent_plating', 'returned_plating'].includes(stage) && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vendor">
            <input list="giza-vendors" value={vendor} onChange={(e) => setVendor(e.target.value)} className={inputCls} />
            <datalist id="giza-vendors">{VENDORS.map(v => <option key={v} value={v} />)}</datalist>
          </Field>
          {stage === 'received'
            ? <Field label="PO #"><input value={po} onChange={(e) => setPo(e.target.value)} className={inputCls} /></Field>
            : stage === 'sent_plating'
              ? <Field label="Expected back"><input type="date" value={expectedReturn} onChange={(e) => setExpectedReturn(e.target.value)} className={inputCls} /></Field>
              : <div />}
        </div>
      )}

      {['washer_inserted', 'assembled'].includes(stage) && (
        <Field label="Done by (initials)">
          <input value={doneBy} onChange={(e) => setDoneBy(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} />
          {initials.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">{initials.map(i => <Btn key={i} onClick={() => setDoneBy(i)}>{i}</Btn>)}</div>
          )}
        </Field>
      )}

      <Field label="Notes">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
      </Field>
    </Modal>
  )
}

// ---------------------------------------------------------------- Close / edit a lot
export function LotModal({ lot, mode, onClose, onSaved }) {
  const isHistorical = lot.status === 'historical'
  const [f, setF] = useState({
    t1Qty: lot.torsion_1_qty ?? '', t1Inlbs: lot.torsion_1_inlbs ?? '', t2Qty: lot.torsion_2_qty ?? '', t2Inlbs: lot.torsion_2_inlbs ?? '',
    inspectedBy: lot.inspected_by || '', notes: mode === 'edit' ? (lot.notes || '') : '',
    quantity: lot.quantity ?? '', nutLots: (lot.nut_lots || []).join(', '),
    cageLot: lot.cage_lot || '', retainerLot: lot.retainer_lot || '', insertLot: lot.insert_lot || '',
  })
  const set = (k) => (e) => setF(prev => ({ ...prev, [k]: e.target.value }))
  const [saving, setSaving] = useState(false)
  const stillInProcess = inProcess(lot)

  const save = async () => {
    setSaving(true)
    try {
      if (mode === 'close') {
        await closeFinalLot({ lotId: lot.id, ...f })
        onSaved(`Lot ${lot.lot_number} closed — ${fmt(lot.assembled_qty)} pieces`)
      } else {
        await updateFinalLot(lot.id, f, isHistorical)
        onSaved(`Lot ${lot.lot_number} updated`)
      }
    } catch (err) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={mode === 'close' ? `Close lot ${lot.lot_number}` : `Edit lot ${lot.lot_number}${isHistorical ? ' (from the paper sheet)' : ''}`}
      onClose={onClose}
      footer={<>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn tone="cyan" onClick={save} disabled={saving}>{saving ? 'Saving…' : mode === 'close' ? 'Close lot' : 'Save'}</Btn>
      </>}
    >
      {!isHistorical && <div className="bg-gray-800/60 rounded p-2"><Trail lot={lot} /></div>}

      {mode === 'close' && (
        <div className="bg-gray-800/60 rounded p-3 text-sm">
          <div className="text-gray-400 text-xs mb-1">Assembled into this lot</div>
          {(lot.assembled_entries || []).map(e => (
            <div key={e.id} className="text-gray-200 font-mono text-xs">{fmtDate(e.date)} · {fmt(e.qty)} · {e.done_by || '—'}</div>
          ))}
          <div className="text-white font-semibold mt-1">Quantity at close: {fmt(lot.assembled_qty)}</div>
          {stillInProcess > 0 && (
            <div className="text-amber-300 text-xs mt-2 flex items-start gap-1">
              <GitBranch size={12} className="mt-0.5 shrink-0" />
              {fmt(stillInProcess)} pieces of this lot are still in process — anything moved after close continues as a new lot.
            </div>
          )}
        </div>
      )}

      {isHistorical && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity"><input type="number" value={f.quantity} onChange={set('quantity')} className={`${inputCls} font-mono`} /></Field>
            <Field label="Nut lots (comma-separated)"><input value={f.nutLots} onChange={set('nutLots')} className={`${inputCls} font-mono`} /></Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Cage SK#"><input value={f.cageLot} onChange={set('cageLot')} className={`${inputCls} font-mono`} /></Field>
            <Field label="Retainer SK#"><input value={f.retainerLot} onChange={set('retainerLot')} className={`${inputCls} font-mono`} /></Field>
            <Field label="Nylon"><input value={f.insertLot} onChange={set('insertLot')} className={`${inputCls} font-mono`} /></Field>
          </div>
        </>
      )}

      <div className="text-gray-400 text-xs">Torsion test (in-lbs)</div>
      <div className="grid grid-cols-4 gap-3">
        <Field label="#1 qty"><input type="number" value={f.t1Qty} onChange={set('t1Qty')} className={`${inputCls} font-mono`} /></Field>
        <Field label="#1 in-lbs"><input type="number" value={f.t1Inlbs} onChange={set('t1Inlbs')} className={`${inputCls} font-mono`} /></Field>
        <Field label="#2 qty"><input type="number" value={f.t2Qty} onChange={set('t2Qty')} className={`${inputCls} font-mono`} /></Field>
        <Field label="#2 in-lbs"><input type="number" value={f.t2Inlbs} onChange={set('t2Inlbs')} className={`${inputCls} font-mono`} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Inspected by (initials)"><input value={f.inspectedBy} onChange={(e) => setF(p => ({ ...p, inspectedBy: e.target.value.toUpperCase() }))} className={`${inputCls} font-mono`} /></Field>
        <Field label="Notes"><input value={f.notes} onChange={set('notes')} className={inputCls} /></Field>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------- The board (presentational)
export function GizaBoard({ bundle, today, now, canWrite, isAdmin, selectedLotId, onSelectLot, onLog, onCloseLot, onEditLot, onReopenLot, onPrintLot, onVoid }) {
  const { program, parts, pipeline: p, demand, daily, lots, ledger, sends } = bundle
  const [stageFilter, setStageFilter] = useState('')
  const [search, setSearch] = useState('')
  const [poShowAll, setPoShowAll] = useState(false)
  const partByRole = Object.fromEntries(parts.map(x => [x.role, x]))

  const selectable = selectableLots(lots)
  const lot = lots.find(l => l.id === selectedLotId) || null
  const values = bucketValues(p, lot)
  const rates = sevenDayRates(daily, today)
  const constraint = constrainingStage(rates)
  const projection = forecast(p.open_qty, constraint.rate, today)
  const capacity = ovenCapacity(p.ovens_commissioned, p.oven_load_qty, FEATURES.PROGRAM_OVEN_LOADS_PER_DAY)
  const pastDue = demand.filter(d => Number(d.open_qty) > 0 && Number(d.days_late) > 0)
  const latest = pastDue.length ? Math.max(...pastDue.map(d => Number(d.days_late))) : 0
  const days14 = lastNDays(today, 14)
  const matrix = dailyMatrix(daily, THROUGHPUT_STAGES, days14)
  const maxCell = Math.max(1, ...Object.values(matrix).flat())
  const activeSends = sends.filter(s => s.status === 'in_finishing' && (!lot || s.program_lot_id === lot.id))
  const register = sortLots(lots).filter(l => l.status !== 'void')
  const voidCount = lots.filter(l => l.status === 'void').length

  const filteredLedger = ledger.filter(e => {
    if (lot && e.final_lot_id !== lot.id && e.from_lot_id !== lot.id) return false
    if (stageFilter && e.stage !== stageFilter) return false
    if (!search.trim()) return true
    const q = search.trim().toLowerCase()
    return [e.lot_number, e.ref_lot_number, e.notes, e.to_lot?.lot_number, e.from_lot?.lot_number, e.vendor, e.po_number, e.cage_lot, e.retainer_lot]
      .some(v => String(v || '').toLowerCase().includes(q))
  }).slice(0, 300)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Kpi label="Open" value={fmt(p.open_qty)} note={`of ${fmt(p.ordered)} ordered`} />
        <Kpi label="Shipped since tracking" value={fmt(p.shipped_since_start)} note={`${fmt(p.fulfilled)} all-time`} />
        <Kpi label="Past due lines" value={pastDue.length} tone={pastDue.length ? 'alert' : 'good'} note={pastDue.length ? `up to ${latest} days late` : 'none'} />
        <Kpi
          label="Projected finish"
          value={projection ? fmtDate(projection.date) : '—'}
          tone={projection ? (p.earliest_due && projection.date > p.earliest_due ? 'alert' : 'good') : 'warn'}
          note={projection ? `${projection.days} days at ${STAGE_LABELS[constraint.stage]} rate` : 'not enough movement in 7 days'}
        />
        <Kpi label="Buildable now" value={fmt(Math.max(0, p.buildable_sets))} note="baked nuts × cages × retainers" />
        <Kpi label="Lots" value={`${p.active_lots} active`} note={`${p.closed_lots} closed · next number ${program.final_lot_next}`} />
      </div>

      <Panel
        title={lot ? `Branch (${lot.lot_number}) Pipeline` : 'All lots — Pipeline'}
        right={
          <div className="flex items-center gap-2">
            <GitBranch size={14} className="text-gray-500" />
            <select value={selectedLotId} onChange={(e) => onSelectLot(e.target.value)} className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-white text-xs">
              <option value="">All lots</option>
              {selectable.map(l => (
                <option key={l.id} value={l.id}>{`Lot ${l.lot_number} · ${l.status}${inProcess(l) ? ` · ${fmt(inProcess(l))} in process` : ''}`}</option>
              ))}
            </select>
          </div>
        }
      >
        {lot && (
          <div className="mb-3 space-y-1">
            <Trail lot={lot} />
            <div className="text-gray-500 text-xs">
              {lot.origin === 'receipt' ? `Started by steel nut receipt ${lot.nut_lot}` : `Split from lot ${lot.parent_lot_number} — ${SPLIT_REASON_LABELS[lot.split_reason] || lot.split_reason}`}
              {lot.status === 'closed' && ` · closed ${fmtDate(lot.closed_at)} at ${fmt(lot.quantity)}`}
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
          {BUCKETS.filter(b => !(b.allOnly && lot)).map(b => {
            const val = values[b.key] ?? 0
            const negative = val < 0
            const batches = b.kiosk ? activeSends.filter(s => s.finishing_stage === b.kiosk) : []
            const showLog = b.log && canWrite && !(b.log === 'received' && lot)
            return (
              <div key={b.key} className={`rounded-lg border p-3 ${negative ? 'border-red-700 bg-red-950/30' : 'border-gray-800 bg-gray-950/40'}`}>
                <div className="text-gray-300 text-sm font-medium flex items-center gap-1">
                  {b.kiosk === 'paint' && <Paintbrush size={13} className="text-orange-400" />}
                  {b.kiosk === 'bake' && <Thermometer size={13} className="text-orange-400" />}
                  {b.label}
                </div>
                <div className="text-gray-500 text-xs">{lot && b.subLot ? b.subLot : b.sub}</div>
                <div className={`text-2xl font-semibold mt-2 ${negative ? 'text-red-400' : 'text-white'}`}>{fmt(val)}</div>
                {negative && <div className="text-red-400 text-xs">over-moved — check the entries</div>}
                {batches.map(s => {
                  const started = s.stage_started_at ? new Date(s.stage_started_at).getTime() : null
                  const left = started ? BAKE_MINUTES - Math.floor((now - started) / 60000) : null
                  const from = lots.find(l => l.id === s.program_lot_id)
                  return (
                    <div key={s.id} className="mt-2 text-xs text-gray-400 font-mono">
                      {s.job?.job_number || 'J-FIN'} · {fmt(s.incoming_count)}{!lot && from ? ` · lot ${from.lot_number}` : ''}
                      {b.kiosk === 'bake' && (
                        <span className={left != null && left <= 0 ? 'text-green-400' : 'text-orange-300'}>
                          {' · '}{s.machine?.name || 'oven'} · {left == null ? '—' : left <= 0 ? 'cure done' : `${left} min`}
                        </span>
                      )}
                    </div>
                  )
                })}
                {showLog && (
                  <div className="mt-2"><Btn onClick={() => onLog({ stage: b.log, lotId: lot?.id })}><Plus size={12} />{LOG_LABELS[b.log]}</Btn></div>
                )}
              </div>
            )
          })}
        </div>
        {!lot && Number(p.dry_film_loss) > 0 && (
          <div className="text-gray-500 text-xs mt-3">Dry-film count loss so far: {fmt(p.dry_film_loss)} (painted in minus verified out on completed batches).</div>
        )}
      </Panel>

      <Panel
        title="Lots — bag lot register"
        right={<span className="text-gray-500 text-xs">a steel nut receipt starts a lot; a changed nylon, plating, dry-film, cage or retainer lot starts the next one{voidCount ? ` · ${voidCount} void` : ''}</span>}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-gray-500 uppercase">
              <tr>
                <th className="text-left py-1">Lot</th><th className="text-left">Status</th><th className="text-left">From</th>
                <th className="text-left">Nut</th><th className="text-left">Nylon</th><th className="text-left">Plating</th><th className="text-left">FLN</th>
                <th className="text-left">Cage</th><th className="text-left">Retainer</th><th className="text-right">In process</th>
                <th className="text-right">Qty</th><th className="text-right">Torsion</th><th className="text-left pl-2">Insp</th><th />
              </tr>
            </thead>
            <tbody>
              {register.map(l => {
                const hist = l.status === 'historical'
                const qty = l.status === 'active' ? l.assembled_qty : l.quantity
                const torsion = [[l.torsion_1_qty, l.torsion_1_inlbs], [l.torsion_2_qty, l.torsion_2_inlbs]]
                  .filter(([q, v]) => q != null || v != null).map(([q, v]) => `${q ?? '—'}/${v ?? '—'}`).join('  ')
                const tone = l.status === 'active' ? 'text-cyan-400' : l.status === 'closed' ? 'text-green-400' : 'text-gray-500'
                const busy = inProcess(l)
                return (
                  <tr
                    key={l.id}
                    onClick={() => !hist && onSelectLot(l.id)}
                    className={`border-t border-gray-800 text-gray-200 align-top ${!hist ? 'cursor-pointer hover:bg-gray-800/40' : ''} ${l.id === selectedLotId ? 'bg-cyan-950/30' : ''}`}
                  >
                    <td className="py-1 font-mono text-sm text-white">{l.lot_number}</td>
                    <td className={tone}>{l.status}</td>
                    <td className="text-gray-400">
                      {hist ? 'paper sheet' : l.origin === 'receipt' ? 'receipt' : `${l.parent_lot_number} · ${SPLIT_REASON_LABELS[l.split_reason] || l.split_reason}`}
                    </td>
                    <td className="font-mono">{hist ? ((l.nut_lots || []).join(', ') || '—') : (l.nut_lot || '—')}</td>
                    <td className="font-mono">{l.insert_lot || '—'}</td>
                    <td className="font-mono">{l.plating_lot || (l.plating_lots || []).join(', ') || '—'}</td>
                    <td className="font-mono text-cyan-500">{l.finishing_lot || (l.finishing_lots || []).join(', ') || '—'}</td>
                    <td className="font-mono">{l.cage_lot || '—'}</td>
                    <td className="font-mono">{l.retainer_lot || '—'}</td>
                    <td className="text-right font-mono">{busy ? fmt(busy) : '—'}</td>
                    <td className="text-right font-mono">{qty == null ? '—' : fmt(qty)}</td>
                    <td className="text-right font-mono whitespace-nowrap">{torsion || '—'}</td>
                    <td className="pl-2 font-mono">{l.inspected_by || '—'}</td>
                    <td className="pl-2 whitespace-nowrap space-x-1 text-right" onClick={(e) => e.stopPropagation()}>
                      {canWrite && l.status === 'active' && <Btn tone="cyan" disabled={!(Number(l.assembled_qty) > 0)} onClick={() => onCloseLot(l)}><Lock size={12} />Close</Btn>}
                      {l.status === 'closed' && <Btn onClick={() => onPrintLot(l)}><Printer size={12} />Label</Btn>}
                      {canWrite && (l.status === 'closed' || hist) && <Btn onClick={() => onEditLot(l)}><Pencil size={12} />Edit</Btn>}
                      {isAdmin && canReopen(l, lots) && <Btn tone="red" onClick={() => onReopenLot(l)}><RotateCcw size={12} />Reopen</Btn>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="Purchase orders"
        right={
          <div className="flex items-center gap-3 text-xs text-gray-500">
            {bundle.sync?.last_purchasing_at && <span>Fishbowl POs synced {new Date(bundle.sync.last_purchasing_at).toLocaleString()}</span>}
            <label className="flex items-center gap-1 cursor-pointer">
              <input type="checkbox" checked={poShowAll} onChange={(e) => setPoShowAll(e.target.checked)} />
              show received / closed (12 months)
            </label>
          </div>
        }
      >
        {bundle.purchasing === null && (
          <div className="text-gray-500 text-sm">The Fishbowl purchasing mirror is not available yet (needs the D-FB-55 migration and bridge 1.10).</div>
        )}
        {bundle.purchasing !== null && (() => {
          const rows = sortPurchasing(bundle.purchasing, poShowAll)
          const summary = purchasingSummary(bundle.purchasing)
          return (
            <>
              {summary.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {summary.map(s => (
                    <div key={s.role} className={`rounded border px-3 py-1.5 text-xs ${s.late ? 'border-red-800 bg-red-950/30' : 'border-gray-800 bg-gray-950/40'}`}>
                      <span className="text-gray-300">{PURCHASE_ROLE_LABELS[s.role] || s.role}</span>
                      <span className="text-white font-mono ml-2">{fmt(s.remaining)}</span>
                      <span className="text-gray-500"> to come · {s.lines} line{s.lines === 1 ? '' : 's'} · next due {fmtDate(s.nextDue)}</span>
                      {s.late > 0 && <span className="text-red-400"> · {s.late} late</span>}
                    </div>
                  ))}
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-gray-500 uppercase">
                    <tr>
                      <th className="text-left py-1">PO</th><th className="text-left">Vendor</th><th className="text-left">Part</th>
                      <th className="text-right">Ordered</th><th className="text-right">Received</th><th className="text-right">Remaining</th>
                      <th className="text-right">Due</th><th className="text-right">Last received</th><th className="text-left pl-3">Lots received (SB#)</th>
                      <th className="text-left">SkyNet lots sent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(l => (
                      <tr key={l.fb_poitem_id} className={`border-t border-gray-800 align-top ${l.is_open ? 'text-gray-200' : 'text-gray-500'}`}>
                        <td className="py-1 font-mono text-white">{l.po_number}<span className="text-gray-500"> / {l.line_number}</span></td>
                        <td>{l.vendor_name}{l.type_name && l.type_name !== 'Purchase' ? <span className="text-gray-500"> · {l.type_name}</span> : null}</td>
                        <td>
                          <span className="font-mono">{l.part_num}</span>
                          <span className="text-gray-500"> · {PURCHASE_ROLE_LABELS[l.role] || l.role}{l.is_plating ? ' · plating' : ''}</span>
                        </td>
                        <td className="text-right font-mono">{fmt(l.qty_ordered)}</td>
                        <td className="text-right font-mono">{fmt(l.qty_received)}</td>
                        <td className={`text-right font-mono ${l.is_open ? 'text-white' : ''}`}>{l.is_open ? fmt(l.qty_remaining) : '—'}</td>
                        <td className={`text-right ${l.is_late ? 'text-red-400' : ''}`}>{fmtDate(l.due_date)}{l.is_late ? ' · late' : ''}</td>
                        <td className="text-right">{fmtDate(l.last_received_date)}</td>
                        <td className="pl-3 font-mono">{(l.receipts || []).map(r => `${r.lot || '—'} (${fmt(r.qty)}, ${fmtDate(r.date)})`).join('; ') || '—'}</td>
                        <td className="font-mono">{(l.tracker_sent || []).map(t => `${t.lot} · ${fmt(t.qty)}`).join('; ') || (l.is_plating ? '—' : '')}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr><td colSpan={10} className="py-3 text-gray-500">{poShowAll ? 'No purchase orders for these parts in the last 12 months.' : 'Nothing on order for these parts.'}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )
        })()}
      </Panel>

      <Panel title={`Demand — ${program.fb_product_num}`} right={<span className="text-gray-500 text-xs">from the Fishbowl mirror</span>}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-gray-500 text-xs uppercase">
              <tr><th className="text-left py-1">Part</th><th className="text-left">SO</th><th className="text-left">Line</th><th className="text-right">Ordered</th><th className="text-right">Shipped</th><th className="text-right">Open</th><th className="text-right">Due</th><th className="text-right">Days late</th></tr>
            </thead>
            <tbody>
              {demand.map(d => (
                <tr key={`${d.so_number}-${d.line_number}`} className="border-t border-gray-800 text-gray-200">
                  <td className="py-1 font-mono">{d.product_num}</td>
                  <td>{d.so_number}</td>
                  <td>{d.line_number}</td>
                  <td className="text-right font-mono">{fmt(d.qty_ordered)}</td>
                  <td className="text-right font-mono">{fmt(d.qty_fulfilled)}</td>
                  <td className="text-right font-mono">{fmt(d.open_qty)}</td>
                  <td className="text-right">{fmtDate(d.effective_due_date)}</td>
                  <td className={`text-right font-mono ${Number(d.days_late) > 0 && Number(d.open_qty) > 0 ? 'text-red-400' : 'text-gray-500'}`}>{Number(d.open_qty) > 0 && Number(d.days_late) > 0 ? d.days_late : '—'}</td>
                </tr>
              ))}
              {demand.length === 0 && <tr><td colSpan={8} className="py-3 text-gray-500">No open sales-order lines for {program.fb_product_num}.</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel
          title="Components"
          right={canWrite && <Btn onClick={() => onLog({ stage: 'received', role: 'cage' })}><Plus size={12} />Log component receipt</Btn>}
        >
          <table className="w-full text-sm">
            <thead className="text-gray-500 text-xs uppercase">
              <tr><th className="text-left py-1">Part</th><th className="text-right">Received</th><th className="text-right">Used</th><th className="text-right">On hand</th></tr>
            </thead>
            <tbody>
              {[
                ['cage', p.cage_received, Number(p.assembled) * Number(p.cage_per), p.cage_on_hand],
                ['retainer', p.retainer_received, Number(p.assembled) * Number(p.retainer_per), p.retainer_on_hand],
                ['insert', p.insert_received, Number(p.washer_inserted) * Number(p.insert_per), p.insert_on_hand],
              ].map(([role, rec, used, onHand]) => (
                <tr key={role} className="border-t border-gray-800 text-gray-200">
                  <td className="py-1">{ROLE_LABELS[role]} <span className="text-gray-500 font-mono text-xs">{partByRole[role]?.part?.part_number}</span></td>
                  <td className="text-right font-mono">{fmt(rec)}</td>
                  <td className="text-right font-mono">{fmt(used)}</td>
                  <td className={`text-right font-mono ${Number(onHand) < 0 ? 'text-red-400' : ''}`}>{fmt(onHand)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-gray-400 text-xs mt-3 space-y-1">
            <div>Buildable sets now: <span className="text-white font-mono">{fmt(Math.max(0, p.buildable_sets))}</span> (baked nuts waiting, limited by cages and retainers on hand)</div>
            <div>Nylon inserts on hand <span className="text-white font-mono">{fmt(p.insert_on_hand)}</span> vs nuts awaiting nylon insert <span className="text-white font-mono">{fmt(p.waiting_washer)}</span>
              {Number(p.insert_on_hand) < Number(p.waiting_washer) && <span className="text-amber-400"> — short</span>}</div>
          </div>
        </Panel>

        <Panel title="Forecast & capacity">
          <table className="w-full text-sm">
            <thead className="text-gray-500 text-xs uppercase"><tr><th className="text-left py-1">Stage</th><th className="text-right">7-day avg / day</th></tr></thead>
            <tbody>
              {FLOW_STAGES.map(s => (
                <tr key={s} className={`border-t border-gray-800 ${s === constraint.stage ? 'text-amber-300' : 'text-gray-200'}`}>
                  <td className="py-1">{STAGE_LABELS[s]}{s === constraint.stage && ' — constraint'}</td>
                  <td className="text-right font-mono">{fmt(Math.round(rates[s] || 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-gray-400 text-xs mt-3 space-y-1">
            <div>Open {fmt(p.open_qty)} ÷ constraint {fmt(Math.round(constraint.rate))}/day → {projection ? `${projection.days} days, ${fmtDate(projection.date)}` : 'no projection (no movement at the constraint in 7 days)'}; earliest due {fmtDate(p.earliest_due)}.</div>
            <div>Oven capacity ≈ <span className="text-white font-mono">{fmt(capacity)}</span>/day ({p.ovens_commissioned} oven{Number(p.ovens_commissioned) === 1 ? '' : 's'} × {fmt(p.oven_load_qty)} × {FEATURES.PROGRAM_OVEN_LOADS_PER_DAY} loads) vs baked <span className="text-white font-mono">{fmt(Math.round(rates.baked || 0))}</span>/day.</div>
            <div className="text-gray-600">Assumptions: loads per oven per day is a setting (config PROGRAM_OVEN_LOADS_PER_DAY), not a measurement; the projection ignores pieces already downstream of the constraint.</div>
          </div>
        </Panel>
      </div>

      <Panel title="Throughput — last 14 days">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-gray-500">
              <tr>
                <th className="text-left py-1 pr-2">Stage</th>
                {days14.map(d => <th key={d} className="px-1 font-normal">{d.slice(5).replace('-', '/')}</th>)}
                <th className="text-right pl-2">7-day avg</th>
              </tr>
            </thead>
            <tbody>
              {THROUGHPUT_STAGES.map(s => (
                <tr key={s} className="border-t border-gray-800">
                  <td className="py-1 pr-2 text-gray-300 whitespace-nowrap">{STAGE_LABELS[s]}</td>
                  {matrix[s].map((v, i) => (
                    <td key={days14[i]} className="px-1 text-center font-mono text-gray-100" style={{ backgroundColor: v ? `rgba(8, 145, 178, ${0.15 + 0.6 * (v / maxCell)})` : 'transparent' }}>
                      {v ? fmt(v) : ''}
                    </td>
                  ))}
                  <td className="text-right pl-2 font-mono text-gray-300">{fmt(Math.round(rates[s] || 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="text-gray-600 text-xs mt-2">Shipments are not shown per day — the Fishbowl mirror carries the running total only.</div>
      </Panel>

      <Panel
        title={lot ? `Ledger — lot ${lot.lot_number}` : 'Ledger'}
        right={
          <div className="flex items-center gap-2">
            <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-white text-xs">
              <option value="">All stages</option>
              {Object.keys(LOG_LABELS).map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
            </select>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Lot, PO, notes…" className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-white text-xs w-40" />
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-gray-500 uppercase">
              <tr>
                <th className="text-left py-1">Date</th><th className="text-left">Stage</th><th className="text-left">Lot</th><th className="text-left">Part</th>
                <th className="text-right">Qty</th><th className="text-left pl-3">Lot #</th><th className="text-left">Cage / retainer</th>
                <th className="text-left">Vendor / PO</th><th className="text-left">By</th><th className="text-left">Notes</th><th />
              </tr>
            </thead>
            <tbody>
              {filteredLedger.map(e => {
                const voided = !!e.voided_at
                const split = e.from_lot_id && e.final_lot_id && e.from_lot_id !== e.final_lot_id
                return (
                  <tr key={e.id} className={`border-t border-gray-800 align-top ${voided ? 'text-gray-600 line-through' : 'text-gray-200'}`}>
                    <td className="py-1">{fmtDate(e.entry_date)}</td>
                    <td>{STAGE_LABELS[e.stage]}</td>
                    <td className="font-mono">{split ? `${e.from_lot?.lot_number} → ${e.to_lot?.lot_number}` : (e.to_lot?.lot_number || '—')}</td>
                    <td className="font-mono">{e.part?.part_number}</td>
                    <td className="text-right font-mono">{fmt(e.qty)}</td>
                    <td className="pl-3 font-mono">{e.lot_number || '—'}</td>
                    <td className="font-mono">{[e.cage_lot, e.retainer_lot].filter(Boolean).join(' / ')}</td>
                    <td>{[e.vendor, e.po_number].filter(Boolean).join(' · ')}{e.expected_return ? ` · back ${fmtDate(e.expected_return)}` : ''}</td>
                    <td>{e.done_by || e.entered?.full_name || '—'}</td>
                    <td>
                      {e.notes}
                      {/* inline-block stops the row's line-through from reaching the void note */}
                      {voided && <div className="inline-block text-gray-500" style={{ textDecoration: 'none' }}>Voided by {e.voider?.full_name || '—'}: {e.void_reason}</div>}
                    </td>
                    <td className="text-right">
                      {canWrite && !voided && <Btn tone="red" onClick={() => onVoid(e)}><Ban size={12} />Void</Btn>}
                    </td>
                  </tr>
                )
              })}
              {filteredLedger.length === 0 && <tr><td colSpan={11} className="py-3 text-gray-500">No entries yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}

// ---------------------------------------------------------------- Movements (D-GIZA-29)
function MovementRows({ title, head, rows }) {
  if (rows.length === 0) return null
  return (
    <Panel title={title}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-gray-500 uppercase"><tr>{head.map(h => <th key={h} className="text-left py-1 pr-3">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-gray-800 text-gray-200 align-top">{r.map((c, j) => <td key={j} className="py-1 pr-3 font-mono">{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

// Everything that happened on one day, defaulting to the last working day, with a printable report.
export function MovementsView({ bundle, today }) {
  const [day, setDay] = useState(() => lastWorkingDay(today))
  const nutPartId = bundle.parts.find(p => p.role === 'nut')?.part_id
  const data = dayMovements(bundle, day, nutPartId)
  const lotOf = (m) => (m.from_lot?.lot_number && m.to_lot?.lot_number && m.from_lot.lot_number !== m.to_lot.lot_number
    ? `${m.from_lot.lot_number} → ${m.to_lot.lot_number}` : (m.to_lot?.lot_number || '—'))

  const print = () => {
    const win = window.open('', '_blank')
    if (!win) { alert('Allow pop-ups for SkyNet to print the report.'); return }
    win.document.write(movementsReportHtml({ programName: bundle.program.name, data, generatedAt: new Date().toLocaleString() }))
    win.document.close()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <CalendarDays size={16} className="text-gray-400" />
        <input type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-white text-sm" />
        <Btn onClick={() => setDay(lastWorkingDay(today))}>Last working day</Btn>
        <Btn onClick={() => setDay(today)}>Today so far</Btn>
        <div className="flex-1" />
        <Btn tone="cyan" onClick={print}><Printer size={12} />Print report</Btn>
      </div>

      <Panel title={`Movements — ${new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`}>
        {data.empty ? (
          <div className="text-gray-500 text-sm">Nothing was logged for this day.</div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
            {data.summary.map(s => (
              <div key={s.key} className={`rounded-lg border p-3 ${s.count ? 'border-gray-700 bg-gray-950/40' : 'border-gray-900 bg-gray-950/20'}`}>
                <div className="text-gray-400 text-xs">{s.label}</div>
                <div className={`text-xl font-semibold mt-1 ${s.count ? 'text-white' : 'text-gray-700'}`}>{s.count ? fmt(s.qty) : '—'}</div>
                {s.count > 0 && <div className="text-gray-500 text-xs">{s.count} entr{s.count === 1 ? 'y' : 'ies'}</div>}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <MovementRows title="Tracker entries" head={['Step', 'Lot', 'Part', 'Qty', 'Lot #', 'Cage / retainer', 'Vendor / PO', 'By', 'Notes']}
        rows={data.moves.map(m => [STAGE_LABELS[m.stage] || m.stage, lotOf(m), m.part?.part_number, fmt(m.qty), m.lot_number || '—',
          [m.cage_lot, m.retainer_lot].filter(Boolean).join(' / ') || '—', [m.vendor, m.po_number].filter(Boolean).join(' · ') || '—',
          m.done_by || m.entered?.full_name || '—', m.notes || ''])} />
      <MovementRows title="Dry-film batches started (painted)" head={['Job', 'Plating lot', 'Dry film', 'FLN', 'Pieces in']}
        rows={data.painted.map(s => [s.job?.job_number, s.plating_lot_number || '—', s.dry_film_lot_number || '—', s.finishing_lot_number || '—', fmt(s.incoming_count)])} />
      <MovementRows title="Dry-film batches completed (baked)" head={['Job', 'Oven', 'FLN', 'Pieces in', 'Verified out']}
        rows={data.baked.map(s => [s.job?.job_number, s.machine?.name || '—', s.finishing_lot_number || '—', fmt(s.incoming_count), s.verified_count == null ? '—' : fmt(s.verified_count)])} />
      <MovementRows title="Shipped to Giza" head={['Shipment', 'SO / line', 'Bag lot', 'Pieces']}
        rows={data.shipped.map(s => [s.ship_number || '—', `${s.so_number} / ${s.so_line ?? ''}`, s.lot_number || '—', fmt(s.lot_qty ?? s.qty_shipped)])} />
      <MovementRows title="Received on Fishbowl POs" head={['PO', 'Vendor', 'Part', 'Pieces', 'Lot (SB#)']}
        rows={data.received.map(r => [r.po, r.vendor || '—', r.part || '—', fmt(r.qty), r.lot || '—'])} />
      <MovementRows title="Voided that day" head={['Entry date', 'Step', 'Lot', 'Qty', 'Voided by', 'Reason']}
        rows={data.voids.map(m => [fmtDate(m.entry_date), STAGE_LABELS[m.stage] || m.stage, lotOf(m), fmt(m.qty), m.voider?.full_name || '—', m.void_reason || ''])} />
      <MovementRows title="Logged that day for an earlier date" head={['Entry date', 'Step', 'Lot', 'Qty', 'By']}
        rows={data.late.map(m => [fmtDate(m.entry_date), STAGE_LABELS[m.stage] || m.stage, lotOf(m), fmt(m.qty), m.done_by || m.entered?.full_name || '—'])} />
    </div>
  )
}

// ---------------------------------------------------------------- Page shell (auth, data, actions)
export default function GizaDashboard() {
  const navigate = useNavigate()
  const [phase, setPhase] = useState('auth') // 'auth' | 'ready'
  const [profile, setProfile] = useState(null)
  const [bundle, setBundle] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const [selectedLotId, setSelectedLotId] = useState('')
  const [entryPreset, setEntryPreset] = useState(null)
  const [lotModal, setLotModal] = useState(null) // { lot, mode: 'close' | 'edit' }
  const [notice, setNotice] = useState(null)
  const [view, setView] = useState('board') // 'board' | 'movements' (D-GIZA-29)

  useEffect(() => {
    let mounted = true
    async function checkAuth() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.user) { navigate('/'); return }
      const { data: prof, error } = await supabase
        .from('profiles')
        .select('id, full_name, role, roles, email')
        .eq('id', session.user.id)
        .single()
      if (!mounted) return
      if (error || !prof) { navigate('/'); return }
      setProfile(prof)
      setPhase('ready')
    }
    checkAuth()
    return () => { mounted = false }
  }, [navigate])

  const load = useCallback(async () => {
    try {
      const b = await loadProgramBundle(GIZA_PROGRAM_CODE)
      setBundle(b)
      setLoadError(null)
      setLastUpdated(new Date())
    } catch (err) {
      console.error('[GizaDashboard] load failed:', err)
      setLoadError(err.message)
    }
  }, [])

  useEffect(() => {
    if (phase !== 'ready' || !FEATURES.PROGRAM_TRACKER) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [phase, load])

  // 30 s tick for the oven countdowns.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!notice) return
    const id = setTimeout(() => setNotice(null), 8000)
    return () => clearTimeout(id)
  }, [notice])

  const canWrite = canLogProgramTracker(profile)
  const isAdmin = hasRole(profile, 'admin')
  const today = isoDay(new Date(now))

  const afterWrite = async (msg) => {
    setEntryPreset(null)
    setLotModal(null)
    if (msg) setNotice(msg)
    await load()
  }

  const handleReopenLot = async (lot) => {
    const reason = window.prompt(`Reopen lot ${lot.lot_number}? Reason (required):`)
    if (!reason || !reason.trim()) return
    try {
      await reopenFinalLot(lot.id, reason.trim())
      await afterWrite(`Lot ${lot.lot_number} reopened`)
    } catch (err) {
      alert(err.message)
    }
  }

  const handleVoid = async (entry) => {
    const reason = window.prompt(`Void ${STAGE_LABELS[entry.stage]} ${fmt(entry.qty)} (lot ${entry.to_lot?.lot_number || '—'})? Reason (required):`)
    if (!reason || !reason.trim()) return
    try {
      await voidEntry(entry.id, reason.trim())
      await afterWrite('Entry voided')
    } catch (err) {
      alert(err.message)
    }
  }

  const handlePrintLot = (lot) => {
    const win = window.open('', '_blank')
    if (!win) { alert('Allow pop-ups for SkyNet to print the label.'); return }
    win.document.write(lotLabelHtml({
      lotNumber: lot.lot_number,
      partLabel: bundle.program.final_lot_label || bundle.program.fb_product_num,
      qty: lot.quantity,
      dateText: fmtDate(lot.closed_at),
    }))
    win.document.close()
  }

  if (phase === 'auth') return <div className="min-h-screen bg-gray-950 text-gray-400 flex items-center justify-center">Loading…</div>

  if (!FEATURES.PROGRAM_TRACKER) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-400 flex items-center justify-center">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center">
          <div className="text-white font-semibold mb-1">Giza Dashboard is not enabled</div>
          <div className="text-sm">FEATURES.PROGRAM_TRACKER is off.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200">
      <div className="max-w-[1600px] mx-auto p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-white text-xl font-semibold">Giza Dashboard</h1>
            <div className="text-gray-500 text-sm">{bundle ? `${bundle.program.name} · SK21077-5 program` : 'Loading program…'}</div>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            {bundle?.sync?.last_rev_at && <span>Fishbowl synced {new Date(bundle.sync.last_rev_at).toLocaleString()}</span>}
            <span>As of {lastUpdated ? lastUpdated.toLocaleTimeString() : '—'}</span>
            {!canWrite && <span className="text-gray-600">view only</span>}
            <Btn onClick={load}><RefreshCw size={12} />Refresh</Btn>
          </div>
        </div>

        <div className="flex gap-2">
          <Btn tone={view === 'board' ? 'cyan' : 'gray'} onClick={() => setView('board')}><LayoutGrid size={12} />Dashboard</Btn>
          <Btn tone={view === 'movements' ? 'cyan' : 'gray'} onClick={() => setView('movements')}><CalendarDays size={12} />Movements</Btn>
        </div>

        {notice && <div className="bg-green-900/30 border border-green-800 text-green-300 text-sm rounded px-3 py-2">{notice}</div>}
        {loadError && (
          <div className="bg-red-900/30 border border-red-800 text-red-300 text-sm rounded px-3 py-2 flex items-center gap-2">
            <AlertTriangle size={14} /> {loadError}
          </div>
        )}

        {bundle && bundle.pipeline && view === 'movements' && <MovementsView bundle={bundle} today={today} />}
        {bundle && bundle.pipeline && view === 'board' && (
          <GizaBoard
            bundle={bundle}
            today={today}
            now={now}
            canWrite={canWrite}
            isAdmin={isAdmin}
            selectedLotId={selectedLotId}
            onSelectLot={setSelectedLotId}
            onLog={(preset) => setEntryPreset(preset)}
            onCloseLot={(lot) => setLotModal({ lot, mode: 'close' })}
            onEditLot={(lot) => setLotModal({ lot, mode: 'edit' })}
            onReopenLot={handleReopenLot}
            onPrintLot={handlePrintLot}
            onVoid={handleVoid}
          />
        )}
        {bundle && !bundle.pipeline && <div className="text-gray-500">The program is inactive.</div>}
      </div>

      {entryPreset && bundle && (
        <EntryModal bundle={bundle} preset={entryPreset} today={today} onClose={() => setEntryPreset(null)} onSaved={afterWrite} />
      )}
      {lotModal && bundle && (
        <LotModal lot={lotModal.lot} mode={lotModal.mode} onClose={() => setLotModal(null)} onSaved={afterWrite} />
      )}
    </div>
  )
}
