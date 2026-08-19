// Reports Advisor data layer (D-RPT-06/07).
// Builds the bounded envelope sent to the report-advisor Edge Function and
// parses its SSE stream. Deliberately imports NOTHING from ./reports beyond
// summarize() — the CSV output contract (D-RPT-02) must stay independent of
// anything the advisor does.
import { supabase } from './supabase'
import { summarize } from './reports'

const ADVISOR_TIMEOUT_MS = 300000 // outer guard; heartbeats do the keep-alive
const SAMPLE_SIZE = 40            // D-RPT-07: bounded payload, never all rows

// Columns worth sampling per report, in priority order. Unknown slugs fall
// back to the registry's first eight columns.
const SAMPLE_COLUMNS = {
  'job-efficiency': [
    'part_number', 'job_number', 'machine_name', 'status', 'quantity',
    'pieces_done', 'elapsed_hours', 'current_parts_per_day',
    'hist_parts_per_day', 'hist_runs', 'variance_pct',
  ],
  'open-demand': [
    'part_number', 'co_number', 'customer_name', 'qty_open', 'due_date',
    'line_status', 'wo_count', 'wo_statuses', 'job_statuses', 'scheduled_finish',
  ],
}

const num = (v) => Number(v) || 0

// Report-specific aggregate blocks. Keyed by slug; unknown slugs get the
// generic shape (row count + deterministic summary only).
const AGGREGATORS = {
  'job-efficiency': (rows) => {
    const val = (v) => (v === null || v === undefined || v === '') ? null : Number(v)
    const line = (r) => ({
      part_number: r.part_number, job_number: r.job_number,
      machine_name: r.machine_name, status: r.status,
      quantity: val(r.quantity), pieces_done: val(r.pieces_done),
      current_parts_per_day: val(r.current_parts_per_day),
      hist_parts_per_day: val(r.hist_parts_per_day),
      hist_runs: val(r.hist_runs), variance_pct: val(r.variance_pct),
      scheduled_end: r.scheduled_end, due_date: r.due_date,
    })

    const running = rows.filter(r => !r.actual_end && r.status === 'in_progress')
    const completed = rows.filter(r => r.actual_end)
    const comparable = rows.filter(r => val(r.variance_pct) !== null)
    const behind = comparable.filter(r => val(r.variance_pct) <= -10)
    const ahead = comparable.filter(r => val(r.variance_pct) >= 25)
    const thinHistory = comparable.filter(r => val(r.hist_runs) === 1)
    const noHistory = rows.filter(r => !val(r.hist_runs))
    const noHistObserved = noHistory.filter(r => val(r.current_parts_per_day) !== null)
    const histNoCurrent = rows.filter(r => (val(r.hist_runs) || 0) > 0 && val(r.variance_pct) === null)

    const vs = comparable.map(r => val(r.variance_pct)).sort((a, b) => a - b)
    const median = vs.length === 0 ? null
      : vs.length % 2 === 1 ? vs[(vs.length - 1) / 2]
      : (vs[vs.length / 2 - 1] + vs[vs.length / 2]) / 2

    return {
      running_jobs: running.length,
      completed_last_7_days: completed.length,
      comparable_count: comparable.length,
      variance: {
        median_pct: median,
        min_pct: vs.length ? vs[0] : null,
        max_pct: vs.length ? vs[vs.length - 1] : null,
        single_run_history_count: thinHistory.length,
      },
      behind_pace_10pct_plus: {
        count: behind.length,
        jobs: behind.slice(0, 15).map(line),
      },
      well_ahead_25pct_plus: {
        count: ahead.length,
        jobs: ahead.slice(0, 10).map(line),
      },
      no_history: {
        count: noHistory.length,
        with_observed_current_rate: noHistObserved.length,
        note: 'Machinist-estimate candidates. Where an observed current rate exists, it is the natural estimate seed.',
        jobs: noHistory.slice(0, 15).map(line),
      },
      history_but_no_current_rate: histNoCurrent.slice(0, 10).map(line),
    }
  },
  'open-demand': (rows, today) => {
    const byCustomer = {}
    const byPart = {}
    for (const r of rows) {
      const c = r.customer_name || '(unknown)'
      const p = r.part_number || '(unknown)'
      byCustomer[c] = (byCustomer[c] || 0) + num(r.qty_open)
      byPart[p] = (byPart[p] || 0) + num(r.qty_open)
    }
    const top = (obj, n) => Object.entries(obj)
      .sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([name, qty_open]) => ({ name, qty_open }))

    const pastDue = rows.filter(r => r.due_date && r.due_date < today)
    const uncovered = rows.filter(r => num(r.wo_count) === 0)
    const statusCounts = {}
    for (const r of rows) {
      const s = r.line_status || '(none)'
      statusCounts[s] = (statusCounts[s] || 0) + 1
    }

    return {
      total_open_pieces: rows.reduce((s, r) => s + num(r.qty_open), 0),
      distinct_customers: Object.keys(byCustomer).length,
      distinct_parts: Object.keys(byPart).length,
      past_due: {
        line_count: pastDue.length,
        pieces: pastDue.reduce((s, r) => s + num(r.qty_open), 0),
        lines: pastDue.slice(0, 15).map(r => ({
          part_number: r.part_number, co_number: r.co_number,
          customer_name: r.customer_name, qty_open: num(r.qty_open),
          due_date: r.due_date, wo_count: num(r.wo_count),
        })),
      },
      no_work_order: {
        line_count: uncovered.length,
        pieces: uncovered.reduce((s, r) => s + num(r.qty_open), 0),
        lines: uncovered.slice(0, 15).map(r => ({
          part_number: r.part_number, co_number: r.co_number,
          customer_name: r.customer_name, qty_open: num(r.qty_open),
          due_date: r.due_date,
        })),
      },
      line_status_counts: statusCounts,
      top_customers_by_open_qty: top(byCustomer, 10),
      top_parts_by_open_qty: top(byPart, 10),
    }
  },
}

function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// D-RPT-07: what leaves the browser. Aggregates + a bounded sample, never the
// full result set — bounded cost, bounded exposure, and it keeps the model
// reasoning over computed truth rather than re-deriving it from raw rows.
export function buildReportEnvelope(report, rows) {
  const today = localToday()
  const sampleCols = SAMPLE_COLUMNS[report.slug] || (report.columns || []).slice(0, 8)
  const step = Math.max(1, Math.ceil(rows.length / SAMPLE_SIZE))
  const sample = rows
    .filter((_, i) => i % step === 0)
    .slice(0, SAMPLE_SIZE)
    .map(r => Object.fromEntries(sampleCols.map(c => [c, r[c] ?? null])))

  return {
    report: {
      slug: report.slug,
      name: report.name,
      description: report.description || null,
      explainer: report.explainer || null,
      columns: report.columns || [],
    },
    generated_on: today,
    row_count: rows.length,
    deterministic_summary: summarize(report.slug, rows),
    aggregates: AGGREGATORS[report.slug]
      ? AGGREGATORS[report.slug](rows, today)
      : null,
    sample: {
      note: `Evenly-spaced sample of ${sample.length} of ${rows.length} rows, ordered as the report is ordered. Not the full result set.`,
      rows: sample,
    },
  }
}

// SSE parse mirrors invokeAdvisorStream() in AIAdvisorPanel.jsx (D-AISCHED-07).
export async function invokeReportAdvisor(envelope) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('No active session — sign in again.')

  const controller = new AbortController()
  const kill = setTimeout(() => controller.abort(), ADVISOR_TIMEOUT_MS)
  try {
    const resp = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/report-advisor`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ envelope }),
        signal: controller.signal,
      }
    )

    if (!resp.ok) {
      let msg = `report-advisor HTTP ${resp.status}`
      try {
        const j = await resp.json()
        if (j?.error) msg = j.error
      } catch { /* body wasn't JSON; keep the status message */ }
      throw new Error(msg)
    }

    const contentType = resp.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
      const j = await resp.json()   // fast path (e.g. zero rows)
      if (j?.error) throw new Error(j.error)
      return j
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
        if (!dataLine) continue // heartbeat comment
        let payload
        try { payload = JSON.parse(dataLine.slice(6)) } catch { continue }
        if (event === 'error') throw new Error(payload.error || 'report-advisor failed')
        if (event === 'result') return payload
      }
    }
    throw new Error('Uncle Bob\u0027s stream ended without a result — try again.')
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error('Uncle Bob timed out after 5 minutes. Try again.')
    }
    throw e
  } finally {
    clearTimeout(kill)
  }
}

// Audit trail (D-RPT-06): the client writes, mirroring schedule_ai_runs.
export async function recordAdvisorRun({ profile, report, envelope, result, error }) {
  const row = {
    run_by: profile.id,
    report_slug: report.slug,
    model: result?.model || 'claude-fable-5',
    envelope,
    row_count: envelope?.row_count ?? null,
    reading: result?.envelope?.reading || null,
    observations: result?.envelope?.observations || null,
    watch_items: result?.envelope?.watch_items || null,
    data_gaps: result?.envelope?.data_gaps || null,
    usage: result?.usage || null,
    error: error ? String(error.message || error) : null,
  }
  const { error: insErr } = await supabase.from('report_ai_runs').insert(row)
  if (insErr) console.warn('report_ai_runs insert failed:', insErr.message)
}
