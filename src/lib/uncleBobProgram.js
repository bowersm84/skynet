// Uncle Bob on a customer program dashboard — client side (S16 Batch C, D-CPROG-13, 14, 16).
// The page builds a snapshot of what it already computed (lines with stages and blockers, the
// credit plan, money, lots, quotes) and sends it with the question. The email trail is NOT sent
// from here: uncle-bob-program loads it server-side so hidden and excluded messages can never
// reach the model, whatever the page does. SSE parse mirrors invokeReportAdvisor().

import { supabase } from './supabase'
import { lotTable } from './customerProgramMath'

const BOB_TIMEOUT_MS = 5 * 60 * 1000

export function buildBobSnapshot(bundle, model, today) {
  const { position, plan, views } = model
  return {
    generated_on: today,
    program: {
      name: bundle.program.name,
      credit_limit: Number(bundle.program.credit_limit),
      deposit_pct: Number(bundle.program.deposit_pct),
      past_due_grace_days: bundle.program.past_due_grace_days,
      roster: (bundle.access || []).map(a => a.profile?.full_name).filter(Boolean),
    },
    open_lines: bundle.lines.map(l => {
      const v = views[l.fb_soitem_id] || {}
      return {
        part: l.product_num,
        description: l.description,
        po: l.customer_po,
        so: l.so_number,
        co: l.co_number || null,
        qty_ordered: Number(l.qty_ordered),
        qty_shipped: Number(l.qty_fulfilled),
        qty_open: Number(l.qty_open),
        unit_price: Number(l.unit_price),
        open_value: Number(l.open_value),
        due: l.effective_due_date,
        due_is_fishbowl_default: !!l.due_date_is_default,
        flow: l.flow,
        terms: l.terms,
        drawing_sent: l.drawing_sent_on,
        drawing_signed: l.drawing_signed_on,
        hold_note: l.hold_note,
        notes: l.tracking_notes,
        stages: (v.stages || []).map(s => ({ stage: s.label, state: s.state, detail: s.detail })),
        blocker: v.blocker || null,
        ready_to_ship_qty: v.readyQty ?? null,
        credit_status: plan.byLine[l.fb_soitem_id] || null,
      }
    }),
    credit: {
      limit: plan.limit,
      open_invoices: plan.openAR,
      open_balance_after_ready_releases: plan.afterReleases,
      if_every_net30_order_shipped_at_once: plan.exposureIfAllShipped,
      overdue_invoices: plan.overdue.map(i => ({ reference: i.reference, days_past_due: i.daysPastDue, open: i.open })),
    },
    money: {
      open_invoices: position.invoices.map(i => ({ po: i.po_number, so: i.so_number, reference: i.reference, date: i.txn_date, due: i.due_date, amount: i.amount, open: i.open })),
      deposits: position.deposits.map(d => ({ po: d.po_number, reference: d.reference, date: d.txn_date, requested: d.amount, received: d.applied, open: d.open })),
      deposits_requested: position.depositsRequested,
      deposits_received: position.depositsReceived,
      voided: bundle.money.filter(m => m.voided_at).map(m => ({ kind: m.kind, amount: m.amount, po: m.po_number, reference: m.reference, void_reason: m.void_reason })),
    },
    lots: lotTable(bundle.balances).map(l => ({ part: l.part_num, lot: l.lot_number, by_stage: l.byStage, on_hand: l.onHand, last_move: l.lastMove })),
    lot_checks: bundle.checks.filter(c => !c.voided_at).map(c => ({ part: c.part_num, lot: c.lot_number, check: c.check_kind, value: c.measured_value, unit: c.unit, result: c.result, date: c.checked_on })),
    recent_moves: bundle.moves.filter(m => !m.voided_at).slice(0, 40).map(m => ({ date: m.entry_date, part: m.part_num, lot: m.lot_number, to_lot: m.to_lot_number, from: m.from_stage, to: m.to_stage, qty: m.qty, po: m.po_number, by: m.done_by })),
    open_quotes: bundle.quotes.filter(q => q.status === 'open').map(q => ({ rfq: q.rfq_number, part: q.part_num, description: q.description, qty: q.qty, unit_price: Number(q.unit_price), quoted_on: q.quoted_on, notes: q.notes })),
  }
}

export async function askUncleBob(programCode, question, snapshot) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('No active session — sign in again.')
  const controller = new AbortController()
  const kill = setTimeout(() => controller.abort(), BOB_TIMEOUT_MS)
  try {
    const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/uncle-bob-program`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ program_code: programCode, question, snapshot }),
      signal: controller.signal,
    })
    if (!resp.ok) {
      let msg = `uncle-bob-program HTTP ${resp.status}`
      try { const j = await resp.json(); if (j?.error) msg = j.error } catch { /* not JSON */ }
      throw new Error(msg)
    }
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const frame of frames) {
        const lines = frame.split('\n')
        const event = (lines.find(l => l.startsWith('event: ')) || '').slice(7).trim()
        const dataLine = lines.find(l => l.startsWith('data: '))
        if (!dataLine) continue // heartbeat
        let payload
        try { payload = JSON.parse(dataLine.slice(6)) } catch { continue }
        if (event === 'error') throw new Error(payload.error || 'Uncle Bob failed')
        if (event === 'result') return payload
      }
    }
    throw new Error('Uncle Bob\u0027s answer ended early — try again.')
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('Uncle Bob timed out after 5 minutes. Try again.')
    throw e
  } finally {
    clearTimeout(kill)
  }
}

export async function listBobThreads(programId, limit = 50) {
  const { data, error } = await supabase
    .from('cp_ai_threads')
    .select('id, question, answer, citations, draft, data_gaps, emails_in_context, emails_excluded, error, created_at, finished_at, asker:profiles!cp_ai_threads_asked_by_fkey(full_name)')
    .eq('program_id', programId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`Uncle Bob history: ${error.message}`)
  return data || []
}

// "Keep from Uncle Bob" switch on a message (D-CPROG-16). Reason required to exclude.
export async function setEmailForBob(emailId, excluded, reason) {
  const { error } = await supabase.rpc('cp_email_set_bob', { p_id: emailId, p_excluded: excluded, p_reason: reason || null })
  if (error) throw new Error(`Uncle Bob switch: ${error.message}`)
}
