// Customer Program Dashboard — /dashboards/program/:code (S16, D-CPROG). Kaytech is the first
// program. One place for a customer's whole story: every open order with its stage pipeline and
// blocker, the money (deposits, invoices, payments, the credit line), lot-level piece tracking,
// the movement ledger and open quotes. Batch B adds the email trail, Batch C Uncle Bob.
// Only the program's roster sees it (customer_program_access, enforced by RLS — D-CPROG-02).
// Writes: lot moves and checks need can_log_moves; money, line tracking and quotes need
// can_enter_money (D-CPROG-03). Pure math is in src/lib/customerProgramMath.js.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  RefreshCw, Plus, AlertTriangle, X, LayoutGrid, Package, DollarSign, Boxes, CalendarDays, FileText,
  ChevronDown, ChevronRight, Ban, Pencil, Ruler, CheckCircle, Clock, Square, XCircle, Mail, Brain,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { FEATURES } from '../../config'
import {
  loadCustomerProgramBundle, logMove, addLotCheck, addMoney, voidRow, saveLineTracking, saveQuote,
} from '../../lib/customerProgram'
import {
  LOT_STAGES, LOT_STAGE_LABELS, MONEY_KIND_LABELS, FLOW_LABELS, TERMS_LABELS,
  moneyPosition, depositForPo, lotTable, stageTotalsByPart, lineView, creditPlan, isoDay, money, round2,
} from '../../lib/customerProgramMath'
import UncleBobPanel from '../../components/customerprogram/UncleBobPanel'
import EmailTrail from '../../components/customerprogram/EmailTrail'
import { emailsForLine } from '../../lib/customerProgramEmail'

const POLL_MS = 60000
const fmt = (v) => Number(v || 0).toLocaleString('en-US')
const fmtDate = (iso) => {
  if (!iso) return '—'
  const s = String(iso)
  const d = s.length > 10 ? new Date(s) : new Date(`${s}T12:00:00`)
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' })
}
const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + n)
  return isoDay(d)
}

// ------------------------------------------------------------------ small UI pieces
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

const STATE_STYLE = {
  done: { cls: 'border-green-800 bg-green-900/30 text-green-300', Icon: CheckCircle },
  active: { cls: 'border-cyan-800 bg-cyan-900/30 text-cyan-300', Icon: Clock },
  todo: { cls: 'border-gray-700 bg-gray-800 text-gray-400', Icon: Square },
  blocked: { cls: 'border-red-800 bg-red-900/30 text-red-300', Icon: XCircle },
}

function StageChip({ stage }) {
  const st = STATE_STYLE[stage.state] || STATE_STYLE.todo
  const Icon = st.Icon
  return (
    <span title={stage.detail} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs ${st.cls}`}>
      <Icon size={12} />{stage.label}
    </span>
  )
}

const CREDIT_STYLE = {
  can_ship: 'border-green-800 bg-green-900/30 text-green-300',
  building: 'border-gray-700 bg-gray-800 text-gray-400',
  hold: 'border-red-800 bg-red-900/30 text-red-300',
  deposit: 'border-amber-800 bg-amber-900/30 text-amber-300',
  untracked: 'border-gray-700 bg-gray-800 text-gray-500',
}
const CREDIT_LABEL = { can_ship: 'Can ship on terms', building: 'Net 30 · nothing ready', hold: 'Hold', deposit: 'Deposit terms', untracked: 'Not set up' }

function CreditChip({ plan }) {
  if (!plan) return null
  return <span title={plan.reason} className={`px-2 py-0.5 rounded border text-xs ${CREDIT_STYLE[plan.status]}`}>{CREDIT_LABEL[plan.status]}</span>
}

// ------------------------------------------------------------------ derived model
function useModel(bundle, today) {
  return useMemo(() => {
    if (!bundle?.program) return null
    const position = moneyPosition(bundle.money, today)
    const stagesByPart = stageTotalsByPart(bundle.balances)
    const allocByCoLine = {}
    for (const a of bundle.allocations || []) {
      if (!a.work_order) continue
      ;(allocByCoLine[a.customer_order_line_id] = allocByCoLine[a.customer_order_line_id] || []).push(a.work_order)
    }
    const poQtyByPart = {}
    for (const p of bundle.openPos || []) poQtyByPart[p.part_num] = (poQtyByPart[p.part_num] || 0) + p.qty_open
    const views = {}
    const ctxByLine = {}
    for (const l of bundle.lines) {
      const part = l.part_num || l.product_num
      const comps = (bundle.bomByPart[part] || []).map(c => ({
        ...c,
        on_hand: Number(bundle.inventory[c.part_num]?.qty_on_hand || 0),
        on_order: Math.max(Number(bundle.inventory[c.part_num]?.qty_on_order || 0), poQtyByPart[c.part_num] || 0),
      }))
      const ctx = {
        deposit: depositForPo(position, l.customer_po),
        lotStages: stagesByPart[part] || {},
        workOrders: l.customer_order_line_id ? allocByCoLine[l.customer_order_line_id] || [] : [],
        components: comps,
        openPoQty: poQtyByPart[part] || 0,
      }
      ctxByLine[l.fb_soitem_id] = ctx
      views[l.fb_soitem_id] = lineView(l, ctx)
    }
    const plan = creditPlan(bundle.lines, views, position, bundle.program)
    const openValue = round2(bundle.lines.reduce((s, l) => s + Number(l.open_value || 0), 0))
    return { position, plan, views, ctxByLine, openValue, lots: lotTable(bundle.balances) }
  }, [bundle, today])
}

// ------------------------------------------------------------------ Overview
function CreditBar({ plan }) {
  const limit = plan.limit || 1
  const ar = Math.min(plan.openAR, limit)
  const released = Math.max(0, Math.min(plan.afterReleases, limit) - ar)
  const pct = (v) => `${Math.max(0, (v / limit) * 100)}%`
  return (
    <div>
      <div className="h-4 w-full bg-gray-800 rounded overflow-hidden flex">
        <div className="bg-amber-600 h-full" style={{ width: pct(ar) }} title={`Open invoices ${money(plan.openAR)}`} />
        <div className="bg-cyan-600 h-full" style={{ width: pct(released) }} title={`Ready to ship on terms ${money(plan.afterReleases - plan.openAR)}`} />
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-gray-400 mt-2">
        <span><span className="inline-block w-2 h-2 bg-amber-600 rounded-sm mr-1" />Open invoices {money(plan.openAR)}</span>
        <span><span className="inline-block w-2 h-2 bg-cyan-600 rounded-sm mr-1" />Ready to ship on terms {money(plan.afterReleases - plan.openAR)}</span>
        <span><span className="inline-block w-2 h-2 bg-gray-700 rounded-sm mr-1" />Room left {money(plan.limit - plan.afterReleases)}</span>
        <span className="text-gray-500">Line {money(plan.limit)} · if every net 30 order shipped at once: {money(plan.exposureIfAllShipped)}</span>
      </div>
    </div>
  )
}

function Overview({ bundle, model, onOpenLine, onOpenEmails }) {
  const { position, plan, views } = model
  const attention = bundle.lines
    .map(l => ({ l, v: views[l.fb_soitem_id], c: plan.byLine[l.fb_soitem_id] }))
    .filter(x => x.v?.blocker || x.c?.status === 'hold')
  const termsLines = bundle.lines.filter(l => l.terms === 'net30')
  const depositLines = bundle.lines.filter(l => l.terms === 'deposit')
  const sum = (xs) => round2(xs.reduce((s, l) => s + Number(l.open_value || 0), 0))
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi label="Open orders" value={money(model.openValue)} note={`${bundle.lines.length} lines`} />
        <Kpi label="On net 30 terms" value={money(sum(termsLines))} note={`${termsLines.length} lines`} />
        <Kpi label="On deposit terms" value={money(sum(depositLines))} note={`${depositLines.length} lines`} />
        <Kpi label="Open invoices" value={money(position.openAR)} tone={position.pastDue.length ? 'alert' : undefined}
          note={position.pastDue.length ? `${position.pastDue.length} past due` : 'none past due'} />
        <Kpi label="Deposits" value={`${money(position.depositsReceived)} / ${money(position.depositsRequested)}`}
          tone={position.depositsOutstanding > 0 ? 'warn' : 'good'} note="received / requested" />
      </div>

      <Panel title={`Credit line — ${money(plan.limit)} net 30`}>
        <CreditBar plan={plan} />
        {plan.overdue.length > 0 && (
          <div className="mt-3 text-sm text-red-300 flex items-center gap-2">
            <AlertTriangle size={14} /> Net 30 releases are on hold: {plan.overdue.map(i => `${i.reference || 'invoice'} (${i.daysPastDue} days past due)`).join(', ')}.
          </div>
        )}
      </Panel>

      <Panel title="Needs attention">
        {attention.length === 0 ? <div className="text-gray-500 text-sm">Nothing blocked.</div> : (
          <ul className="divide-y divide-gray-800">
            {attention.map(({ l, v, c }) => (
              <li key={l.fb_soitem_id} className="py-2 flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => onOpenLine(l.fb_soitem_id)} className="text-cyan-400 hover:underline text-sm font-mono">
                  PO {l.customer_po} · {l.product_num}
                </button>
                <span className="text-gray-300 text-sm">{c?.status === 'hold' ? c.reason : v?.blocker}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {(bundle.emails || []).some(e => e.direction === 'in' && !e.hidden_at) && (
        <Panel title="Latest from the customer" right={<Btn onClick={onOpenEmails}><Mail size={12} />Email trail</Btn>}>
          <ul className="divide-y divide-gray-800 text-sm">
            {bundle.emails.filter(e => e.direction === 'in' && !e.hidden_at).slice(0, 5).map(e => (
              <li key={e.id} className="py-2">
                <div className="text-gray-300"><span className="text-gray-500">{fmtDate(e.sent_at)}</span> · {e.from_name || e.from_addr} · <span className="text-white">{e.subject}</span></div>
                <div className="text-gray-500 text-xs truncate">{e.snippet || e.body_new}</div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {bundle.quotes.filter(q => q.status === 'open').length > 0 && (
        <Panel title="Open quotes">
          <ul className="text-sm text-gray-300 space-y-1">
            {bundle.quotes.filter(q => q.status === 'open').map(q => (
              <li key={q.id}>RFQ {q.rfq_number} · {q.part_num} · {fmt(q.qty)} pcs at {money(q.unit_price)} = {money(q.qty * q.unit_price)} · quoted {fmtDate(q.quoted_on)}</li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ Orders
function LineDetail({ bundle, line, view, ctx, onOpenEmail }) {
  const lineEmails = emailsForLine(bundle.emails || [], line)
  const poMoney = bundle.money.filter(m => String(m.po_number || '') === String(line.customer_po || ''))
  const part = line.part_num || line.product_num
  const partMoves = bundle.moves.filter(m => m.part_num === part).slice(0, 15)
  const pos = (bundle.openPos || []).filter(p => p.part_num === part || (ctx.components || []).some(c => c.part_num === p.part_num))
  return (
    <div className="mt-3 grid lg:grid-cols-2 gap-4 text-sm">
      <div>
        <div className="text-gray-500 text-xs uppercase mb-1">Stages</div>
        <ul className="space-y-1">
          {view.stages.map(s => (
            <li key={s.key} className="flex gap-2"><StageChip stage={s} /><span className="text-gray-300">{s.detail}</span></li>
          ))}
        </ul>
        {line.tracking_notes && <div className="mt-2 text-gray-400">Notes: {line.tracking_notes}</div>}
      </div>
      <div className="space-y-3">
        {(ctx.components || []).length > 0 && (
          <div>
            <div className="text-gray-500 text-xs uppercase mb-1">Components for {fmt(line.qty_open)} open</div>
            <table className="w-full text-xs">
              <thead><tr className="text-gray-500"><th className="text-left">Part</th><th className="text-right">Need</th><th className="text-right">On hand</th><th className="text-right">On order</th></tr></thead>
              <tbody>
                {ctx.components.map(c => {
                  const need = Math.ceil(Number(line.qty_open) * c.qty_per)
                  return (
                    <tr key={c.part_num} className={c.on_hand < need ? 'text-red-300' : 'text-gray-300'}>
                      <td className="font-mono">{c.part_num}</td><td className="text-right">{fmt(need)}</td><td className="text-right">{fmt(c.on_hand)}</td><td className="text-right">{fmt(c.on_order)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {(ctx.workOrders || []).length > 0 && (
          <div>
            <div className="text-gray-500 text-xs uppercase mb-1">Work orders</div>
            {ctx.workOrders.map(w => (
              <div key={w.id} className="text-gray-300">
                {w.wo_number} · {w.status} · due {fmtDate(w.due_date)}
                <div className="text-gray-500 text-xs">{(w.jobs || []).map(j => `${j.job_number} ${j.status} ${fmt(j.good_pieces)}/${fmt(j.quantity)}`).join(' · ') || 'no jobs'}</div>
              </div>
            ))}
          </div>
        )}
        {pos.length > 0 && (
          <div>
            <div className="text-gray-500 text-xs uppercase mb-1">Open supplier POs</div>
            {pos.map((p, i) => (
              <div key={i} className="text-gray-300 text-xs">PO {p.po?.po_number} · {p.po?.vendor_name} · {p.part_num} · {fmt(p.qty_open)} open · sched {fmtDate(p.date_scheduled)}</div>
            ))}
          </div>
        )}
        <div>
          <div className="text-gray-500 text-xs uppercase mb-1">Money on PO {line.customer_po}</div>
          {poMoney.length === 0 ? <div className="text-gray-500 text-xs">None</div> : poMoney.map(m => (
            <div key={m.id} className={`text-xs ${m.voided_at ? 'line-through text-gray-600' : 'text-gray-300'}`}>
              {fmtDate(m.txn_date)} · {MONEY_KIND_LABELS[m.kind]} · {money(m.amount)} · {m.reference || ''}
            </div>
          ))}
        </div>
        <div>
          <div className="text-gray-500 text-xs uppercase mb-1 flex items-center gap-2">
            Emails about PO {line.customer_po} ({lineEmails.length})
            {lineEmails.length > 0 && <button type="button" onClick={() => onOpenEmail([`PO:${line.customer_po}`, `SO:${line.so_number}`])} className="normal-case text-cyan-400 hover:underline">Open in Email</button>}
          </div>
          {lineEmails.length === 0 ? <div className="text-gray-500 text-xs">None tagged</div> : lineEmails.slice(0, 5).map(e => (
            <div key={e.id} className="text-xs text-gray-300 truncate">{fmtDate(e.sent_at)} · {e.from_name || e.from_addr} · {e.subject}</div>
          ))}
        </div>
        {partMoves.length > 0 && (
          <div>
            <div className="text-gray-500 text-xs uppercase mb-1">Recent lot moves · {part}</div>
            {partMoves.map(m => (
              <div key={m.id} className={`text-xs ${m.voided_at ? 'line-through text-gray-600' : 'text-gray-300'}`}>
                {fmtDate(m.entry_date)} · lot {m.lot_number}{m.to_lot_number ? ` → ${m.to_lot_number}` : ''} · {fmt(m.qty)} · {m.from_stage ? LOT_STAGE_LABELS[m.from_stage] : 'arrives'} → {m.to_stage ? LOT_STAGE_LABELS[m.to_stage] : 'leaves'}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Orders({ bundle, model, openLine, setOpenLine, canMoney, onEditLine, onOpenEmail }) {
  return (
    <div className="space-y-3">
      {bundle.lines.length === 0 && <div className="text-gray-500 text-sm">No open orders in Fishbowl for this customer.</div>}
      {bundle.lines.map(l => {
        const v = model.views[l.fb_soitem_id]
        const c = model.plan.byLine[l.fb_soitem_id]
        const isOpen = openLine === l.fb_soitem_id
        return (
          <div key={l.fb_soitem_id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" onClick={() => setOpenLine(isOpen ? null : l.fb_soitem_id)} className="flex items-center gap-2 text-left">
                {isOpen ? <ChevronDown size={16} className="text-gray-500" /> : <ChevronRight size={16} className="text-gray-500" />}
                <span className="text-white font-semibold font-mono">{l.product_num}</span>
                <span className="text-gray-400 text-sm">PO {l.customer_po} · SO {l.so_number}{l.co_number ? ` · ${l.co_number}` : ''}</span>
              </button>
              <div className="flex flex-wrap items-center gap-2">
                {l.flow && <span className="text-xs text-gray-400">{FLOW_LABELS[l.flow]}</span>}
                <CreditChip plan={c} />
                {canMoney && <Btn onClick={() => onEditLine(l)}><Pencil size={12} />Line</Btn>}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-300">
              <span>{fmt(l.qty_open)} open of {fmt(l.qty_ordered)}</span>
              <span>{money(l.open_value)}</span>
              <span>Due {fmtDate(l.effective_due_date)}{l.due_date_is_default ? ' (Fishbowl default)' : ''}</span>
              {l.terms && <span>{TERMS_LABELS[l.terms]}</span>}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">{v.stages.map(s => <StageChip key={s.key} stage={s} />)}</div>
            {(v.blocker || c?.status === 'hold') && (
              <div className="mt-2 text-sm text-amber-300">{c?.status === 'hold' ? c.reason : v.blocker}</div>
            )}
            {isOpen && <LineDetail bundle={bundle} line={l} view={v} ctx={model.ctxByLine[l.fb_soitem_id]} onOpenEmail={onOpenEmail} />}
          </div>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------ Lots
function Lots({ bundle, model, canMoves, onLog, onCheck }) {
  const latestCheck = (lot) => bundle.checks.find(c => !c.voided_at && c.lot_number === lot.lot_number && c.part_num === lot.part_num)
  return (
    <Panel title="Lots" right={canMoves && (
      <div className="flex gap-2"><Btn tone="cyan" onClick={() => onLog({})}><Plus size={12} />Log move</Btn><Btn onClick={() => onCheck({})}><Ruler size={12} />Lot check</Btn></div>
    )}>
      {model.lots.length === 0 ? <div className="text-gray-500 text-sm">No lots logged yet.</div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 text-xs border-b border-gray-800">
                <th className="text-left py-2">Part</th><th className="text-left">Lot</th>
                {LOT_STAGES.map(s => <th key={s} className="text-right">{LOT_STAGE_LABELS[s]}</th>)}
                <th className="text-right">On hand</th><th className="text-left pl-4">Latest check</th><th className="text-left">Last move</th><th />
              </tr>
            </thead>
            <tbody>
              {model.lots.map(lot => {
                const chk = latestCheck(lot)
                return (
                  <tr key={`${lot.part_num}|${lot.lot_number}`} className="border-b border-gray-800/60 text-gray-300">
                    <td className="py-2 font-mono">{lot.part_num}</td>
                    <td className="font-mono text-white">{lot.lot_number}</td>
                    {LOT_STAGES.map(s => {
                      const q = lot.byStage[s] || 0
                      return <td key={s} className={`text-right ${q < 0 ? 'text-red-400' : q ? '' : 'text-gray-600'}`}>{q ? fmt(q) : '—'}</td>
                    })}
                    <td className="text-right font-semibold">{fmt(lot.onHand)}</td>
                    <td className="pl-4 text-xs">{chk ? `${chk.check_kind.replace('_', ' ')} ${chk.measured_value ?? ''}${chk.unit ? ` ${chk.unit}` : ''} · ${chk.result}` : '—'}</td>
                    <td className="text-xs">{fmtDate(lot.lastMove)}</td>
                    <td className="text-right whitespace-nowrap">
                      {canMoves && <Btn onClick={() => onLog({ part_num: lot.part_num, lot_number: lot.lot_number })}><Plus size={12} />Move</Btn>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="text-gray-600 text-xs mt-3">A red number means more pieces were moved out of that stage than were logged in. Check the ledger.</div>
    </Panel>
  )
}

// ------------------------------------------------------------------ Money
function Money({ bundle, model, canMoney, onAdd, onVoid }) {
  const { position } = model
  const owed = [...position.deposits, ...position.invoices].sort((a, b) => String(b.txn_date).localeCompare(String(a.txn_date)))
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Open invoices" value={money(position.openAR)} tone={position.pastDue.length ? 'alert' : undefined} />
        <Kpi label="Deposits requested" value={money(position.depositsRequested)} />
        <Kpi label="Deposits received" value={money(position.depositsReceived)} tone={position.depositsReceived ? 'good' : undefined} />
        <Kpi label="Deposits outstanding" value={money(position.depositsOutstanding)} tone={position.depositsOutstanding ? 'warn' : undefined} />
      </div>
      <Panel title="Owed by the customer" right={canMoney && <Btn tone="cyan" onClick={onAdd}><Plus size={12} />Add entry</Btn>}>
        <table className="w-full text-sm">
          <thead><tr className="text-gray-500 text-xs border-b border-gray-800">
            <th className="text-left py-2">Date</th><th className="text-left">Kind</th><th className="text-left">PO</th><th className="text-left">Reference</th>
            <th className="text-right">Amount</th><th className="text-right">Received</th><th className="text-right">Open</th><th className="text-right">Due</th>
          </tr></thead>
          <tbody>
            {owed.map(r => (
              <tr key={r.id} className="border-b border-gray-800/60 text-gray-300">
                <td className="py-2">{fmtDate(r.txn_date)}</td><td>{MONEY_KIND_LABELS[r.kind]}</td><td className="font-mono">{r.po_number || '—'}</td>
                <td>{r.reference || '—'}</td><td className="text-right">{money(r.amount)}</td><td className="text-right">{money(r.applied)}</td>
                <td className={`text-right ${r.open > 0 ? 'text-white' : 'text-gray-500'}`}>{money(r.open)}</td>
                <td className={`text-right ${r.daysPastDue > 0 ? 'text-red-400' : ''}`}>{r.due_date ? `${fmtDate(r.due_date)}${r.daysPastDue > 0 ? ` (${r.daysPastDue}d late)` : ''}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="text-gray-600 text-xs mt-3">Entered by hand until the QuickBooks link lands. Payments and credits reduce the row they are applied to.</div>
      </Panel>
      <Panel title="History">
        <ul className="divide-y divide-gray-800 text-sm">
          {bundle.money.map(m => (
            <li key={m.id} className={`py-2 flex flex-wrap items-center gap-3 ${m.voided_at ? 'text-gray-600' : 'text-gray-300'}`}>
              <span className={m.voided_at ? 'line-through' : ''}>{fmtDate(m.txn_date)} · {MONEY_KIND_LABELS[m.kind]} · {money(m.amount)} · PO {m.po_number || '—'} · {m.reference || ''}</span>
              <span className="text-xs text-gray-500">by {m.entered?.full_name || '—'}</span>
              {m.voided_at && <span className="text-xs">voided by {m.voider?.full_name || '—'}: {m.void_reason}</span>}
              {m.notes && <span className="text-xs text-gray-500">{m.notes}</span>}
              {canMoney && !m.voided_at && <Btn tone="red" onClick={() => onVoid('cp_money', m, `${MONEY_KIND_LABELS[m.kind]} ${money(m.amount)}`)}><Ban size={12} />Void</Btn>}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  )
}

// ------------------------------------------------------------------ Movements
function Movements({ bundle, canMoves, onVoid }) {
  const [filter, setFilter] = useState('')
  const f = filter.trim().toLowerCase()
  const rows = bundle.moves.filter(m => !f || [m.part_num, m.lot_number, m.to_lot_number, m.po_number, m.done_by, m.notes].some(x => String(x || '').toLowerCase().includes(f)))
  return (
    <div className="space-y-4">
      <Panel title="Lot moves" right={<input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter part, lot, PO, person" className={`${inputCls} w-64`} />}>
        <table className="w-full text-sm">
          <thead><tr className="text-gray-500 text-xs border-b border-gray-800">
            <th className="text-left py-2">Date</th><th className="text-left">Part</th><th className="text-left">Lot</th><th className="text-left">From → To</th>
            <th className="text-right">Qty</th><th className="text-left pl-4">PO</th><th className="text-left">By</th><th className="text-left">Notes</th><th />
          </tr></thead>
          <tbody>
            {rows.map(m => (
              <tr key={m.id} className={`border-b border-gray-800/60 ${m.voided_at ? 'text-gray-600 line-through' : 'text-gray-300'}`}>
                <td className="py-2">{fmtDate(m.entry_date)}</td><td className="font-mono">{m.part_num}</td>
                <td className="font-mono">{m.lot_number}{m.to_lot_number ? ` → ${m.to_lot_number}` : ''}</td>
                <td>{m.from_stage ? LOT_STAGE_LABELS[m.from_stage] : 'Arrives'} → {m.to_stage ? LOT_STAGE_LABELS[m.to_stage] : 'Leaves'}</td>
                <td className="text-right">{fmt(m.qty)}</td><td className="pl-4 font-mono">{m.po_number || '—'}</td>
                <td>{m.done_by || m.entered?.full_name || '—'}</td>
                <td className="text-xs">{m.voided_at ? `Voided: ${m.void_reason}` : m.notes || ''}</td>
                <td className="text-right">{canMoves && !m.voided_at && <Btn tone="red" onClick={() => onVoid('cp_moves', m, `${fmt(m.qty)} of lot ${m.lot_number}`)}><Ban size={12} /></Btn>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <Panel title="Lot checks">
        {bundle.checks.length === 0 ? <div className="text-gray-500 text-sm">No checks logged.</div> : (
          <ul className="divide-y divide-gray-800 text-sm">
            {bundle.checks.map(c => (
              <li key={c.id} className={`py-2 flex flex-wrap gap-3 ${c.voided_at ? 'text-gray-600 line-through' : 'text-gray-300'}`}>
                <span>{fmtDate(c.checked_on)} · {c.part_num} lot {c.lot_number} · {c.check_kind.replace('_', ' ')} {c.measured_value ?? ''}{c.unit ? ` ${c.unit}` : ''} · {c.result}</span>
                <span className="text-xs text-gray-500">{c.done_by || c.entered?.full_name || ''} {c.notes || ''}</span>
                {canMoves && !c.voided_at && <Btn tone="red" onClick={() => onVoid('cp_lot_checks', c, `check on lot ${c.lot_number}`)}><Ban size={12} /></Btn>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

// ------------------------------------------------------------------ Quotes
function Quotes({ bundle, canMoney, onEdit }) {
  return (
    <Panel title="Quotes awaiting a PO" right={canMoney && <Btn tone="cyan" onClick={() => onEdit({})}><Plus size={12} />Add quote</Btn>}>
      {bundle.quotes.length === 0 ? <div className="text-gray-500 text-sm">No quotes.</div> : (
        <table className="w-full text-sm">
          <thead><tr className="text-gray-500 text-xs border-b border-gray-800">
            <th className="text-left py-2">RFQ</th><th className="text-left">Part</th><th className="text-right">Qty</th><th className="text-right">Unit</th>
            <th className="text-right">Value</th><th className="text-left pl-4">Quoted</th><th className="text-left">Status</th><th className="text-left">Notes</th><th />
          </tr></thead>
          <tbody>
            {bundle.quotes.map(q => (
              <tr key={q.id} className="border-b border-gray-800/60 text-gray-300">
                <td className="py-2 font-mono">{q.rfq_number}</td><td className="font-mono">{q.part_num}<div className="text-xs text-gray-500 font-sans">{q.description}</div></td>
                <td className="text-right">{fmt(q.qty)}</td><td className="text-right">{money(q.unit_price)}</td><td className="text-right">{money(q.qty * q.unit_price)}</td>
                <td className="pl-4">{fmtDate(q.quoted_on)}</td><td>{q.status}{q.converted_so_number ? ` · SO ${q.converted_so_number}` : ''}</td>
                <td className="text-xs max-w-md">{q.notes}</td>
                <td>{canMoney && <Btn onClick={() => onEdit(q)}><Pencil size={12} /></Btn>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}

// ------------------------------------------------------------------ modals
function MoveModal({ bundle, preset, today, onClose, onSave }) {
  const lots = lotTable(bundle.balances)
  const [f, setF] = useState({
    part_num: preset.part_num || lots[0]?.part_num || '',
    lot_number: preset.lot_number || '',
    from_stage: preset.lot_number ? 'rework' : '',
    to_stage: 'inspection',
    to_lot_number: '',
    qty: '',
    po_number: '',
    entry_date: today,
    done_by: '',
    notes: '',
  })
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }))
  const lot = lots.find(l => l.part_num === f.part_num && l.lot_number === f.lot_number)
  const available = lot && f.from_stage ? lot.byStage[f.from_stage] || 0 : null
  const qty = Number(f.qty)
  const valid = f.part_num.trim() && f.lot_number.trim() && qty > 0 && (f.from_stage || f.to_stage) && (f.from_stage !== f.to_stage || f.to_lot_number.trim())
  return (
    <Modal title="Log lot move" onClose={onClose} footer={<>
      <Btn onClick={onClose}>Cancel</Btn>
      <Btn tone="cyan" disabled={!valid} onClick={() => onSave({
        part_num: f.part_num.trim(), lot_number: f.lot_number.trim(), to_lot_number: f.to_lot_number.trim() || null,
        from_stage: f.from_stage || null, to_stage: f.to_stage || null, qty, po_number: f.po_number.trim() || null,
        entry_date: f.entry_date, done_by: f.done_by.trim() || null, notes: f.notes.trim() || null,
      })}>Save</Btn>
    </>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Part"><input className={inputCls} value={f.part_num} onChange={set('part_num')} /></Field>
        <Field label="Lot">
          <input className={inputCls} list="cp-lots" value={f.lot_number} onChange={set('lot_number')} />
          <datalist id="cp-lots">{lots.filter(l => l.part_num === f.part_num).map(l => <option key={l.lot_number} value={l.lot_number} />)}</datalist>
        </Field>
        <Field label="From">
          <select className={inputCls} value={f.from_stage} onChange={set('from_stage')}>
            <option value="">Arrives (new count or receipt)</option>
            {LOT_STAGES.map(s => <option key={s} value={s}>{LOT_STAGE_LABELS[s]}</option>)}
          </select>
        </Field>
        <Field label="To">
          <select className={inputCls} value={f.to_stage} onChange={set('to_stage')}>
            <option value="">Leaves (out of this view)</option>
            {LOT_STAGES.map(s => <option key={s} value={s}>{LOT_STAGE_LABELS[s]}</option>)}
          </select>
        </Field>
        <Field label="Quantity" hint={available !== null ? `${fmt(available)} in ${LOT_STAGE_LABELS[f.from_stage]}` : null}>
          <input className={inputCls} type="number" min="1" value={f.qty} onChange={set('qty')} />
        </Field>
        <Field label="New lot number (relabel)" hint="e.g. 4142 → 4142R. Leave blank to keep the lot.">
          <input className={inputCls} value={f.to_lot_number} onChange={set('to_lot_number')} />
        </Field>
        <Field label="For PO"><input className={inputCls} value={f.po_number} onChange={set('po_number')} /></Field>
        <Field label="Date"><input className={inputCls} type="date" value={f.entry_date} onChange={set('entry_date')} /></Field>
        <Field label="Done by"><input className={inputCls} value={f.done_by} onChange={set('done_by')} placeholder="e.g. Jody" /></Field>
      </div>
      <Field label="Notes"><textarea className={inputCls} rows={2} value={f.notes} onChange={set('notes')} /></Field>
      {available !== null && qty > available && <div className="text-amber-300 text-xs">More than the {fmt(available)} logged in that stage. It will save, and the lot will show red until it's reconciled.</div>}
    </Modal>
  )
}

function CheckModal({ bundle, preset, today, onClose, onSave }) {
  const lots = lotTable(bundle.balances)
  const [f, setF] = useState({ part_num: preset.part_num || lots[0]?.part_num || '', lot_number: preset.lot_number || '', check_kind: 'stud_length', measured_value: '', unit: 'in', result: 'info', checked_on: today, done_by: '', notes: '' })
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }))
  const valid = f.part_num.trim() && f.lot_number.trim()
  return (
    <Modal title="Log lot check" onClose={onClose} footer={<>
      <Btn onClick={onClose}>Cancel</Btn>
      <Btn tone="cyan" disabled={!valid} onClick={() => onSave({
        part_num: f.part_num.trim(), lot_number: f.lot_number.trim(), check_kind: f.check_kind,
        measured_value: f.measured_value === '' ? null : Number(f.measured_value), unit: f.unit.trim() || null,
        result: f.result, checked_on: f.checked_on, done_by: f.done_by.trim() || null, notes: f.notes.trim() || null,
      })}>Save</Btn>
    </>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Part"><input className={inputCls} value={f.part_num} onChange={set('part_num')} /></Field>
        <Field label="Lot">
          <input className={inputCls} list="cp-lots-check" value={f.lot_number} onChange={set('lot_number')} />
          <datalist id="cp-lots-check">{lots.filter(l => l.part_num === f.part_num).map(l => <option key={l.lot_number} value={l.lot_number} />)}</datalist>
        </Field>
        <Field label="Check">
          <select className={inputCls} value={f.check_kind} onChange={set('check_kind')}>
            <option value="stud_length">Stud length</option><option value="visual">Visual</option><option value="count">Count</option><option value="other">Other</option>
          </select>
        </Field>
        <Field label="Result">
          <select className={inputCls} value={f.result} onChange={set('result')}>
            <option value="info">Info</option><option value="pass">Pass</option><option value="fail">Fail</option>
          </select>
        </Field>
        <Field label="Measured"><input className={inputCls} type="number" step="0.0001" value={f.measured_value} onChange={set('measured_value')} /></Field>
        <Field label="Unit"><input className={inputCls} value={f.unit} onChange={set('unit')} /></Field>
        <Field label="Date"><input className={inputCls} type="date" value={f.checked_on} onChange={set('checked_on')} /></Field>
        <Field label="Done by"><input className={inputCls} value={f.done_by} onChange={set('done_by')} /></Field>
      </div>
      <Field label="Notes"><textarea className={inputCls} rows={2} value={f.notes} onChange={set('notes')} /></Field>
    </Modal>
  )
}

function MoneyModal({ model, today, onClose, onSave }) {
  const [f, setF] = useState({ kind: 'payment', amount: '', po_number: '', so_number: '', reference: '', txn_date: today, due_date: '', applies_to: '', notes: '' })
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }))
  const applying = f.kind === 'payment' || f.kind === 'credit_memo'
  const targets = [...model.position.deposits, ...model.position.invoices].filter(r => r.open > 0)
  const target = targets.find(t => t.id === f.applies_to)
  const amt = Number(f.amount)
  const valid = amt > 0 && f.txn_date && (!applying || f.applies_to || f.notes.trim())
  return (
    <Modal title="Add money entry" onClose={onClose} footer={<>
      <Btn onClick={onClose}>Cancel</Btn>
      <Btn tone="cyan" disabled={!valid} onClick={() => onSave({
        kind: f.kind, amount: round2(amt), po_number: (f.po_number || target?.po_number || '').trim() || null,
        so_number: (f.so_number || target?.so_number || '').trim() || null, reference: f.reference.trim() || null,
        txn_date: f.txn_date, due_date: f.kind === 'invoice' ? (f.due_date || addDays(f.txn_date, 30)) : (f.due_date || null),
        applies_to: applying && f.applies_to ? f.applies_to : null, notes: f.notes.trim() || null,
      })}>Save</Btn>
    </>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Kind">
          <select className={inputCls} value={f.kind} onChange={set('kind')}>
            {Object.entries(MONEY_KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Amount ($)"><input className={inputCls} type="number" step="0.01" min="0" value={f.amount} onChange={set('amount')} /></Field>
        {applying && (
          <div className="col-span-2">
            <Field label="Applies to" hint={target ? `${money(target.open)} open on that row` : 'Pick the deposit request or invoice this pays. Unapplied needs a note.'}>
              <select className={inputCls} value={f.applies_to} onChange={set('applies_to')}>
                <option value="">— not applied —</option>
                {targets.map(t => <option key={t.id} value={t.id}>{MONEY_KIND_LABELS[t.kind]} · PO {t.po_number || '—'} · {t.reference || ''} · {money(t.open)} open</option>)}
              </select>
            </Field>
          </div>
        )}
        <Field label="PO"><input className={inputCls} value={f.po_number} onChange={set('po_number')} placeholder={target?.po_number || ''} /></Field>
        <Field label="SO"><input className={inputCls} value={f.so_number} onChange={set('so_number')} placeholder={target?.so_number || ''} /></Field>
        <Field label="Reference" hint="Invoice number, check / ACH reference"><input className={inputCls} value={f.reference} onChange={set('reference')} /></Field>
        <Field label="Date"><input className={inputCls} type="date" value={f.txn_date} onChange={set('txn_date')} /></Field>
        {f.kind === 'invoice' && <Field label="Due" hint="Blank = date + 30"><input className={inputCls} type="date" value={f.due_date} onChange={set('due_date')} /></Field>}
      </div>
      <Field label="Notes"><textarea className={inputCls} rows={2} value={f.notes} onChange={set('notes')} /></Field>
      {target && amt > target.open && <div className="text-amber-300 text-xs">More than the {money(target.open)} open on that row.</div>}
    </Modal>
  )
}

function LineModal({ line, onClose, onSave }) {
  const [f, setF] = useState({
    flow: line.flow || 'build', terms: line.terms || 'net30',
    drawing_sent_on: line.drawing_sent_on || '', drawing_signed_on: line.drawing_signed_on || '',
    hold_note: line.hold_note || '', notes: line.tracking_notes || '',
  })
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }))
  return (
    <Modal title={`PO ${line.customer_po} · ${line.product_num}`} onClose={onClose} footer={<>
      <Btn onClick={onClose}>Cancel</Btn>
      <Btn tone="cyan" onClick={() => onSave({
        flow: f.flow, terms: f.terms, drawing_sent_on: f.drawing_sent_on || null, drawing_signed_on: f.drawing_signed_on || null,
        hold_note: f.hold_note.trim() || null, notes: f.notes.trim() || null,
      })}>Save</Btn>
    </>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Flow">
          <select className={inputCls} value={f.flow} onChange={set('flow')}>{Object.entries(FLOW_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
        <Field label="Terms">
          <select className={inputCls} value={f.terms} onChange={set('terms')}>{Object.entries(TERMS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
        <Field label="Drawing sent"><input className={inputCls} type="date" value={f.drawing_sent_on} onChange={set('drawing_sent_on')} /></Field>
        <Field label="Drawing signed off"><input className={inputCls} type="date" value={f.drawing_signed_on} onChange={set('drawing_signed_on')} /></Field>
      </div>
      <Field label="Hold note" hint="Shown as the line's blocker, e.g. 'Confirm stud configuration'"><input className={inputCls} value={f.hold_note} onChange={set('hold_note')} /></Field>
      <Field label="Notes"><textarea className={inputCls} rows={2} value={f.notes} onChange={set('notes')} /></Field>
    </Modal>
  )
}

function QuoteModal({ quote, today, onClose, onSave }) {
  const isNew = !quote.id
  const [f, setF] = useState({
    rfq_number: quote.rfq_number || '', part_num: quote.part_num || '', description: quote.description || '',
    qty: quote.qty ?? '', unit_price: quote.unit_price ?? '', quoted_on: quote.quoted_on || today,
    status: quote.status || 'open', converted_so_number: quote.converted_so_number || '', notes: quote.notes || '',
  })
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }))
  const valid = f.rfq_number.trim() && f.part_num.trim() && Number(f.qty) > 0 && Number(f.unit_price) >= 0 && f.quoted_on
  return (
    <Modal title={isNew ? 'Add quote' : `RFQ ${quote.rfq_number}`} onClose={onClose} footer={<>
      <Btn onClick={onClose}>Cancel</Btn>
      <Btn tone="cyan" disabled={!valid} onClick={() => onSave({
        rfq_number: f.rfq_number.trim(), part_num: f.part_num.trim(), description: f.description.trim() || null,
        qty: Number(f.qty), unit_price: Number(f.unit_price), quoted_on: f.quoted_on, status: f.status,
        converted_so_number: f.converted_so_number.trim() || null, notes: f.notes.trim() || null,
      })}>Save</Btn>
    </>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="RFQ"><input className={inputCls} value={f.rfq_number} onChange={set('rfq_number')} disabled={!isNew} /></Field>
        <Field label="Part"><input className={inputCls} value={f.part_num} onChange={set('part_num')} disabled={!isNew} /></Field>
        <Field label="Qty"><input className={inputCls} type="number" value={f.qty} onChange={set('qty')} /></Field>
        <Field label="Unit price"><input className={inputCls} type="number" step="0.01" value={f.unit_price} onChange={set('unit_price')} /></Field>
        <Field label="Quoted"><input className={inputCls} type="date" value={f.quoted_on} onChange={set('quoted_on')} /></Field>
        <Field label="Status">
          <select className={inputCls} value={f.status} onChange={set('status')}>
            <option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option><option value="withdrawn">Withdrawn</option>
          </select>
        </Field>
        {f.status === 'won' && <Field label="Became SO"><input className={inputCls} value={f.converted_so_number} onChange={set('converted_so_number')} /></Field>}
      </div>
      <Field label="Description"><input className={inputCls} value={f.description} onChange={set('description')} /></Field>
      <Field label="Notes"><textarea className={inputCls} rows={3} value={f.notes} onChange={set('notes')} /></Field>
    </Modal>
  )
}

// ------------------------------------------------------------------ page shell
const TABS = [
  { key: 'overview', label: 'Overview', Icon: LayoutGrid },
  { key: 'orders', label: 'Orders', Icon: Package },
  { key: 'lots', label: 'Lots', Icon: Boxes },
  { key: 'money', label: 'Money', Icon: DollarSign },
  { key: 'movements', label: 'Movements', Icon: CalendarDays },
  { key: 'quotes', label: 'Quotes', Icon: FileText },
  { key: 'email', label: 'Email', Icon: Mail },
  { key: 'bob', label: 'Uncle Bob', Icon: Brain },
]

export default function CustomerProgramDashboard() {
  const navigate = useNavigate()
  const { code } = useParams()
  const programCode = String(code || '').toUpperCase()
  const [phase, setPhase] = useState('auth')
  const [profile, setProfile] = useState(null)
  const [bundle, setBundle] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [tab, setTab] = useState('overview')
  const [openLine, setOpenLine] = useState(null)
  const [emailRef, setEmailRef] = useState('') // preset filter when the Email tab is opened from an order (a tag, or the order's tags)
  const [modal, setModal] = useState(null) // { kind, data }
  const [notice, setNotice] = useState(null)
  const today = isoDay(new Date())

  useEffect(() => {
    let mounted = true
    async function checkAuth() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.user) { navigate('/'); return }
      const { data: prof, error } = await supabase.from('profiles').select('id, full_name, role, roles, email').eq('id', session.user.id).single()
      if (!mounted) return
      if (error || !prof) { navigate('/'); return }
      setProfile(prof)
      setPhase('ready')
    }
    checkAuth()
    return () => { mounted = false }
  }, [navigate])

  const load = useCallback(async () => {
    if (!profile) return
    try {
      const b = await loadCustomerProgramBundle(programCode, profile.id)
      setBundle(b)
      setLoadError(null)
      setLastUpdated(new Date())
    } catch (err) {
      console.error('[CustomerProgramDashboard] load failed:', err)
      setLoadError(err.message)
    }
  }, [programCode, profile])

  useEffect(() => {
    if (phase !== 'ready' || !FEATURES.CUSTOMER_PROGRAMS) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [phase, load])

  useEffect(() => {
    if (!notice) return
    const id = setTimeout(() => setNotice(null), 8000)
    return () => clearTimeout(id)
  }, [notice])

  const model = useModel(bundle, today)
  const canMoves = !!bundle?.me?.can_log_moves
  const canMoney = !!bundle?.me?.can_enter_money

  const run = async (fn, msg) => {
    try {
      await fn()
      setModal(null)
      setNotice(msg)
      await load()
    } catch (err) {
      alert(err.message)
    }
  }

  const handleVoid = (table, row, label) => {
    const reason = window.prompt(`Void ${label}? Reason (required):`)
    if (!reason || !reason.trim()) return
    run(() => voidRow(table, row.id, reason.trim()), 'Voided')
  }

  if (phase === 'auth') return <div className="min-h-screen bg-gray-950 text-gray-400 flex items-center justify-center">Loading…</div>

  if (!FEATURES.CUSTOMER_PROGRAMS) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-400 flex items-center justify-center">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center">
          <div className="text-white font-semibold mb-1">Customer program dashboards are not enabled</div>
          <div className="text-sm">FEATURES.CUSTOMER_PROGRAMS is off.</div>
        </div>
      </div>
    )
  }

  if (bundle && !bundle.program) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-400 flex items-center justify-center">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center">
          <div className="text-white font-semibold mb-1">No access</div>
          <div className="text-sm">This dashboard is limited to the program's roster. Ask Matt if you need it.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200">
      <div className="max-w-[1600px] mx-auto p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-white text-xl font-semibold">{bundle?.program ? `${bundle.program.name} Dashboard` : 'Customer Dashboard'}</h1>
            <div className="text-gray-500 text-sm">
              {bundle?.program ? `${bundle.access.length} people on the roster · ${bundle.access.map(a => a.profile?.full_name).filter(Boolean).join(', ')}` : 'Loading program…'}
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            {bundle?.sync?.last_rev_at && <span>Fishbowl synced {new Date(bundle.sync.last_rev_at).toLocaleString()}</span>}
            <span>As of {lastUpdated ? lastUpdated.toLocaleTimeString() : '—'}</span>
            {bundle?.me && !canMoves && !canMoney && <span className="text-gray-600">view only</span>}
            <Btn onClick={load}><RefreshCw size={12} />Refresh</Btn>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {TABS.map(t => {
            const { key, label, Icon } = t
            return <Btn key={key} tone={tab === key ? 'cyan' : 'gray'} onClick={() => setTab(key)}><Icon size={12} />{label}</Btn>
          })}
        </div>

        {notice && <div className="bg-green-900/30 border border-green-800 text-green-300 text-sm rounded px-3 py-2">{notice}</div>}
        {loadError && (
          <div className="bg-red-900/30 border border-red-800 text-red-300 text-sm rounded px-3 py-2 flex items-center gap-2">
            <AlertTriangle size={14} /> {loadError}
          </div>
        )}

        {bundle?.program && model && (
          <>
            {tab === 'overview' && (
              <Overview bundle={bundle} model={model} onOpenLine={(id) => { setOpenLine(id); setTab('orders') }}
                onOpenEmails={() => { setEmailRef(''); setTab('email') }} />
            )}
            {tab === 'orders' && (
              <Orders bundle={bundle} model={model} openLine={openLine} setOpenLine={setOpenLine} canMoney={canMoney}
                onEditLine={(line) => setModal({ kind: 'line', data: line })}
                onOpenEmail={(ref) => { setEmailRef(ref); setTab('email') }} />
            )}
            {tab === 'lots' && (
              <Lots bundle={bundle} model={model} canMoves={canMoves}
                onLog={(preset) => setModal({ kind: 'move', data: preset })} onCheck={(preset) => setModal({ kind: 'check', data: preset })} />
            )}
            {tab === 'money' && <Money bundle={bundle} model={model} canMoney={canMoney} onAdd={() => setModal({ kind: 'money' })} onVoid={handleVoid} />}
            {tab === 'movements' && <Movements bundle={bundle} canMoves={canMoves} onVoid={handleVoid} />}
            {tab === 'quotes' && <Quotes bundle={bundle} canMoney={canMoney} onEdit={(q) => setModal({ kind: 'quote', data: q })} />}
            {tab === 'bob' && (
              <UncleBobPanel bundle={bundle} model={model} today={today}
                onOpenEmail={(id) => {
                  const e = (bundle.emails || []).find(x => x.id === id)
                  if (e) window.open(`https://mail.google.com/mail/u/0/#search/rfc822msgid%3A${encodeURIComponent(e.rfc822_id)}`, '_blank', 'noopener')
                }} />
            )}
            {tab === 'email' && (
              <EmailTrail key={(Array.isArray(emailRef) ? emailRef.join('|') : emailRef) || 'all'} program={bundle.program} emails={bundle.emails || []} syncState={bundle.emailSync || []}
                canWrite={canMoves || canMoney} presetRef={emailRef} onChanged={(msg) => { setNotice(msg); load() }} />
            )}
          </>
        )}
      </div>

      {modal?.kind === 'move' && bundle && (
        <MoveModal bundle={bundle} preset={modal.data || {}} today={today} onClose={() => setModal(null)}
          onSave={(row) => run(() => logMove(bundle.program.id, profile.id, row), 'Move logged')} />
      )}
      {modal?.kind === 'check' && bundle && (
        <CheckModal bundle={bundle} preset={modal.data || {}} today={today} onClose={() => setModal(null)}
          onSave={(row) => run(() => addLotCheck(bundle.program.id, profile.id, row), 'Check logged')} />
      )}
      {modal?.kind === 'money' && model && (
        <MoneyModal model={model} today={today} onClose={() => setModal(null)}
          onSave={(row) => run(() => addMoney(bundle.program.id, profile.id, row), 'Money entry saved')} />
      )}
      {modal?.kind === 'line' && (
        <LineModal line={modal.data} onClose={() => setModal(null)}
          onSave={(fields) => run(() => saveLineTracking(bundle.program.id, profile.id, modal.data.fb_soitem_id, fields), 'Line saved')} />
      )}
      {modal?.kind === 'quote' && (
        <QuoteModal quote={modal.data || {}} today={today} onClose={() => setModal(null)}
          onSave={(q) => run(() => saveQuote(bundle.program.id, profile.id, q), 'Quote saved')} />
      )}
    </div>
  )
}
