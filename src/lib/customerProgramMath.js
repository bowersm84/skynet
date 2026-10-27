// Customer Program Dashboard — pure helpers (S16, D-CPROG). No Supabase here, so every
// number on the page can be unit-tested: money position, the credit plan against the
// program's line, lot balances, and each order line's stage pipeline with its blocker.
// Run the tests: node src/lib/customerProgramMath.test.mjs

export const LOT_STAGES = ['rework', 'inspection', 'ready', 'quarantine', 'shipped', 'scrapped']
export const LOT_STAGE_LABELS = {
  rework: 'To rework',
  inspection: 'Awaiting inspection',
  ready: 'Ready',
  quarantine: 'Quarantine',
  shipped: 'Shipped',
  scrapped: 'Scrapped',
}
// Stages whose pieces still sit in the building (a lot's "on hand").
export const ON_HAND_STAGES = ['rework', 'inspection', 'ready', 'quarantine']

export const MONEY_KIND_LABELS = {
  deposit_request: 'Deposit requested',
  invoice: 'Invoice',
  payment: 'Payment received',
  credit_memo: 'Credit memo',
}

export const FLOW_LABELS = { build: 'Build', stock: 'Stock / rework', buyin: 'Buy-in' }
export const TERMS_LABELS = { deposit: 'Deposit terms', net30: 'Net 30' }

export const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100
export const isoDay = (d) => {
  const x = d instanceof Date ? d : new Date(d)
  const y = x.getFullYear()
  const m = String(x.getMonth() + 1).padStart(2, '0')
  const dd = String(x.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}
// Whole days from a to b (ISO yyyy-mm-dd strings), b − a.
export const daysBetween = (a, b) => {
  if (!a || !b) return 0
  const t = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)))
  return Math.round((t(String(b)) - t(String(a))) / 86400000)
}
export const money = (n) =>
  Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

// ------------------------------------------------------------------ money
// Rows are cp_money rows. deposit_request / invoice are owed; payment / credit_memo reduce
// the row named in applies_to. Voided rows are ignored everywhere except the history list.
export function moneyPosition(rows, today) {
  const live = (rows || []).filter(r => !r.voided_at)
  const applied = new Map()
  for (const r of live) {
    if (r.applies_to && (r.kind === 'payment' || r.kind === 'credit_memo')) {
      applied.set(r.applies_to, round2((applied.get(r.applies_to) || 0) + Number(r.amount)))
    }
  }
  const owed = live
    .filter(r => r.kind === 'invoice' || r.kind === 'deposit_request')
    .map(r => {
      const a = applied.get(r.id) || 0
      const open = round2(Number(r.amount) - a)
      const daysPastDue = r.due_date && open > 0 ? Math.max(0, daysBetween(r.due_date, today)) : 0
      return { ...r, applied: a, open, daysPastDue }
    })
  const invoices = owed.filter(r => r.kind === 'invoice')
  const deposits = owed.filter(r => r.kind === 'deposit_request')
  const unapplied = live.filter(r => (r.kind === 'payment' || r.kind === 'credit_memo') && !r.applies_to)
  const sum = (xs, k) => round2(xs.reduce((s, x) => s + Number(x[k] || 0), 0))
  return {
    invoices,
    deposits,
    unapplied,
    openAR: sum(invoices, 'open'),
    depositsRequested: sum(deposits, 'amount'),
    depositsReceived: sum(deposits, 'applied'),
    depositsOutstanding: sum(deposits, 'open'),
    pastDue: invoices.filter(i => i.daysPastDue > 0),
  }
}

// Deposit status for one PO: everything requested / received against that PO number.
export function depositForPo(position, poNumber) {
  const ds = position.deposits.filter(d => String(d.po_number || '') === String(poNumber || ''))
  const requested = round2(ds.reduce((s, d) => s + Number(d.amount), 0))
  const received = round2(ds.reduce((s, d) => s + Number(d.applied), 0))
  return { requested, received, open: round2(requested - received), rows: ds }
}

// ------------------------------------------------------------------ lots
// balances = cp_v_lot_balances rows {part_num, lot_number, stage, qty, last_move}.
export function lotTable(balances) {
  const byLot = new Map()
  for (const b of balances || []) {
    const key = `${b.part_num}|${b.lot_number}`
    if (!byLot.has(key)) byLot.set(key, { part_num: b.part_num, lot_number: b.lot_number, byStage: {}, onHand: 0, lastMove: null })
    const row = byLot.get(key)
    row.byStage[b.stage] = (row.byStage[b.stage] || 0) + Number(b.qty)
    if (ON_HAND_STAGES.includes(b.stage)) row.onHand += Number(b.qty)
    if (!row.lastMove || (b.last_move && b.last_move > row.lastMove)) row.lastMove = b.last_move
  }
  return [...byLot.values()].sort((a, b) =>
    a.part_num.localeCompare(b.part_num) || a.lot_number.localeCompare(b.lot_number, undefined, { numeric: true }))
}

export function stageTotalsByPart(balances) {
  const out = {}
  for (const b of balances || []) {
    out[b.part_num] = out[b.part_num] || {}
    out[b.part_num][b.stage] = (out[b.part_num][b.stage] || 0) + Number(b.qty)
  }
  return out
}

// ------------------------------------------------------------------ order lines
const JOB_DONE = ['complete', 'completed', 'closed', 'cancelled']
const WO_DONE = ['complete', 'completed', 'closed', 'cancelled']

// ctx: {
//   deposit: depositForPo(...) result (deposit-terms lines),
//   lotStages: stageTotalsByPart(...)[part] (stock lines),
//   workOrders: [{ wo_number, status, jobs: [{ job_number, status, quantity, good_pieces }] }],
//   components: [{ part_num, qty_per, on_hand, on_order }],
//   openPoQty: open supplier PO quantity for the line's own part (buy-in lines),
// }
// Returns { stages: [{ key, label, state, detail }], blocker, readyQty, releasableValue }.
// state: 'done' | 'active' | 'todo' | 'blocked' | 'na'
export function lineView(line, ctx = {}) {
  const open = Number(line.qty_open || 0)
  const price = Number(line.unit_price || 0)
  const stages = []
  const add = (key, label, state, detail) => stages.push({ key, label, state, detail })
  const flow = line.flow || 'build'
  const deposit = ctx.deposit || { requested: 0, received: 0, open: 0 }

  const addDeposit = () => {
    if (line.terms !== 'deposit') return
    if (deposit.requested <= 0) add('deposit', 'Deposit', 'todo', 'No deposit requested yet')
    else if (deposit.open <= 0) add('deposit', 'Deposit', 'done', `${money(deposit.received)} received`)
    else if (deposit.received > 0) add('deposit', 'Deposit', 'active', `${money(deposit.received)} of ${money(deposit.requested)} received`)
    else add('deposit', 'Deposit', 'blocked', `Waiting on the ${money(deposit.requested)} deposit`)
  }

  let readyQty = 0

  if (flow === 'build') {
    if (line.drawing_signed_on) add('drawing', 'Drawing sign-off', 'done', `Signed ${line.drawing_signed_on}`)
    else if (line.drawing_sent_on) add('drawing', 'Drawing sign-off', 'active', `Sent ${line.drawing_sent_on}, waiting on sign-off`)
    else add('drawing', 'Drawing sign-off', 'todo', 'Drawing not sent')
    addDeposit()

    const comps = ctx.components || []
    if (comps.length) {
      const short = comps
        .map(c => ({ ...c, need: Math.ceil(open * Number(c.qty_per || 1)) }))
        .filter(c => Number(c.on_hand || 0) < c.need)
      if (!short.length) add('components', 'Components', 'done', 'All components on hand')
      else {
        const covered = short.every(c => Number(c.on_hand || 0) + Number(c.on_order || 0) >= c.need)
        const text = short
          .map(c => `${c.part_num}: ${fmtQty(c.on_hand)} on hand, ${fmtQty(c.on_order)} on order (need ${fmtQty(c.need)})`)
          .join('; ')
        add('components', 'Components', covered ? 'active' : 'blocked', text)
      }
    }

    const wos = ctx.workOrders || []
    if (!wos.length) add('production', 'Production', 'todo', 'No work order yet')
    else {
      const jobs = wos.flatMap(w => w.jobs || [])
      const good = jobs.reduce((s, j) => s + Number(j.good_pieces || 0), 0)
      const allDone = wos.every(w => WO_DONE.includes(String(w.status || '').toLowerCase()))
      const running = jobs.some(j => !JOB_DONE.includes(String(j.status || '').toLowerCase()))
      add('production', 'Production', allDone ? 'done' : 'active',
        `${wos.map(w => w.wo_number).join(', ')} · ${jobs.length} job${jobs.length === 1 ? '' : 's'}${good ? ` · ${fmtQty(good)} good pcs` : ''}${running ? '' : allDone ? '' : ' · waiting to start'}`)
    }

    readyQty = Math.min(open, Math.max(0, Number(line.fb_on_hand || 0)))
    add('ready', 'Ready to ship', readyQty >= open ? 'done' : readyQty > 0 ? 'active' : 'todo',
      `${fmtQty(readyQty)} of ${fmtQty(open)} on hand (Fishbowl)`)
  } else if (flow === 'stock') {
    addDeposit()
    const s = ctx.lotStages || {}
    const rework = Number(s.rework || 0)
    const insp = Number(s.inspection || 0)
    const ready = Number(s.ready || 0)
    readyQty = Math.min(open, Math.max(0, ready))
    if (rework || insp) add('rework', 'Rework', rework ? 'active' : 'done', `${fmtQty(rework)} to rework · ${fmtQty(insp)} awaiting inspection`)
    add('ready', 'Ready to ship', readyQty >= open ? 'done' : readyQty > 0 ? 'active' : 'todo',
      `${fmtQty(readyQty)} of ${fmtQty(open)} ready`)
    if (ready + rework + insp < open) {
      add('coverage', 'Coverage', 'blocked', `${fmtQty(open - ready - rework - insp)} pcs not covered by any lot`)
    }
  } else if (flow === 'buyin') {
    addDeposit()
    const onOrder = Number(ctx.openPoQty || 0)
    const onHand = Math.max(0, Number(line.fb_on_hand || 0))
    if (onHand >= open) add('supplier', 'Supplier PO', 'done', 'Received')
    else if (onOrder > 0) add('supplier', 'Supplier PO', 'active', `${fmtQty(onOrder)} on order`)
    else add('supplier', 'Supplier PO', 'todo', 'Not ordered from the supplier yet')
    readyQty = Math.min(open, onHand)
    add('ready', 'Ready to ship', readyQty >= open ? 'done' : readyQty > 0 ? 'active' : 'todo',
      `${fmtQty(readyQty)} of ${fmtQty(open)} on hand (Fishbowl)`)
  }

  if (line.terms === 'deposit') add('balance', 'Balance by ACH', 'todo', 'Due before shipment')
  add('shipped', 'Shipped', Number(line.qty_fulfilled || 0) > 0 ? 'active' : 'todo',
    `${fmtQty(line.qty_fulfilled)} of ${fmtQty(line.qty_ordered)} shipped`)

  const firstOpen = stages.find(s => s.state === 'blocked') || stages.find(s => s.state === 'todo' || s.state === 'active')
  let blocker = firstOpen ? `${firstOpen.label}: ${firstOpen.detail}` : null
  if (line.hold_note) blocker = `Hold: ${line.hold_note}`
  return { stages, blocker, readyQty, releasableValue: round2(readyQty * price) }
}

const fmtQty = (n) => Number(n || 0).toLocaleString('en-US')

// ------------------------------------------------------------------ credit plan
// Net 30 lines release in due-date order while open invoices + what has been released stays
// within the program's credit line (D-CPROG-05). Any invoice past due by more than the grace
// days puts every net 30 line on hold. Deposit lines never draw on the line.
export function creditPlan(lines, views, position, program) {
  const limit = Number(program?.credit_limit || 0)
  const grace = Number(program?.past_due_grace_days ?? 30)
  const overdue = position.invoices.filter(i => i.daysPastDue > grace)
  const net = (lines || [])
    .filter(l => l.terms === 'net30')
    .slice()
    .sort((a, b) => String(a.effective_due_date || '').localeCompare(String(b.effective_due_date || ''))
      || String(a.so_number).localeCompare(String(b.so_number), undefined, { numeric: true }))
  let running = position.openAR
  const byLine = {}
  for (const l of net) {
    const v = views[l.fb_soitem_id] || { releasableValue: 0 }
    if (overdue.length) {
      const worst = overdue.slice().sort((a, b) => b.daysPastDue - a.daysPastDue)[0]
      byLine[l.fb_soitem_id] = { status: 'hold', reason: `${worst.reference || 'An invoice'} is ${worst.daysPastDue} days past due` }
    } else if (v.releasableValue <= 0) {
      byLine[l.fb_soitem_id] = { status: 'building', reason: 'Nothing ready to ship yet' }
    } else if (round2(running + v.releasableValue) <= limit) {
      running = round2(running + v.releasableValue)
      byLine[l.fb_soitem_id] = { status: 'can_ship', reason: `${money(v.releasableValue)} can ship on terms` }
    } else {
      byLine[l.fb_soitem_id] = {
        status: 'hold',
        reason: `Would take the open balance to ${money(running + v.releasableValue)}, over the ${money(limit)} line. Waits for payment.`,
      }
    }
  }
  for (const l of lines || []) {
    if (l.terms === 'deposit') byLine[l.fb_soitem_id] = { status: 'deposit', reason: 'Deposit terms; balance by ACH before shipment' }
    else if (!l.terms) byLine[l.fb_soitem_id] = { status: 'untracked', reason: 'Flow and terms not set' }
  }
  const totalOnTerms = round2(net.reduce((s, l) => s + Number(l.open_value || 0), 0))
  return {
    limit,
    openAR: position.openAR,
    headroom: round2(limit - position.openAR),
    afterReleases: running,
    totalOnTerms,
    exposureIfAllShipped: round2(position.openAR + totalOnTerms),
    overdue,
    byLine,
  }
}
