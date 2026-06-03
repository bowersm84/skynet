import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { canViewSalesDashboard } from '../../lib/roles'
import {
  applyScope, computeKpis, groupByPhase, groupByDueBucket,
  summarizeBySalesperson, selectMts, selectAtRisk,
} from '../../lib/salesMetrics'
import SalesScopeFilter from '../../components/SalesScopeFilter'
import SalesPipelineChart from '../../components/SalesPipelineChart'
import SalesDemandChart from '../../components/SalesDemandChart'

const POLL_MS = 60000
const SCOPE_KEY = 'skynet.sales_dashboard.scope'

const num = (v) => {
  const n = parseInt(String(v ?? '').replace(/[^0-9-]/g, ''), 10)
  return Number.isNaN(n) ? 0 : n
}

function loadScope() {
  try {
    const raw = localStorage.getItem(SCOPE_KEY)
    if (raw) {
      const s = JSON.parse(raw)
      if (s && ['all', 'mine', 'person'].includes(s.mode)) return s
    }
  } catch { /* ignore */ }
  return { mode: 'all', name: null }
}

const authStyle = {
  minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexDirection: 'column', gap: 16, background: '#f4f6f9', color: '#5f6b7a',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontSize: 14, letterSpacing: 1,
}

const chip = (n, color) =>
  n ? <span className={`chip ${color}`}>{n}</span> : <span className="chip zero">0</span>

function pillsFor(row) {
  const out = []
  if (/critical/i.test(row.priority || '')) out.push(<span className="pill critical" key="c">crit</span>)
  if (/STALLED/.test(row.flags_or_notes || '')) out.push(<span className="pill stalled" key="s">stalled</span>)
  if (/COMBINED-WO/.test(row.flags_or_notes || '')) out.push(<span className="pill combined" key="x">comb</span>)
  return out
}

function KpiTile({ label, value, tone = '', note }) {
  return (
    <div className={`kpi ${tone}`}>
      <div className="kpi-bar" />
      <div className="kpi-lbl">{label}</div>
      <div className="kpi-val">{value}</div>
      {note && <div className="kpi-note">{note}</div>}
    </div>
  )
}

function Panel({ title, count, children }) {
  return (
    <div className="panel">
      <h2 className="panel-h2">
        {title}
        {count != null && <span className="panel-count">{count}</span>}
      </h2>
      {children}
    </div>
  )
}

function WorkloadTable({ rows }) {
  if (!rows.length) return <div className="sales-empty">No salespeople with active work in scope.</div>
  return (
    <table className="sales-tbl">
      <thead>
        <tr>
          <th>Salesperson</th>
          <th className="num">Active WOs</th>
          <th className="num">Past Due</th>
          <th className="num">Stalled</th>
          <th className="num">Demand Lines</th>
          <th className="num">Demand Qty</th>
          <th className="num">Earliest Late</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.salesperson}>
            <td className="sp-name">{r.salesperson}</td>
            <td className="num">{r.activeWos}</td>
            <td className="num">{chip(r.pastDue, 'red')}</td>
            <td className="num">{chip(r.stalled, 'amber')}</td>
            <td className="num">{r.demandLines}</td>
            <td className="num">{r.demandQty.toLocaleString()}</td>
            <td className="num">
              {r.earliestLateDays != null
                ? <span className="days-late">{Math.abs(r.earliestLateDays)}d late</span>
                : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function AtRiskTable({ rows }) {
  if (!rows.length) return <div className="sales-empty">No past-due, stalled, or critical items in scope.</div>
  return (
    <table className="sales-tbl">
      <thead>
        <tr>
          <th>Type</th><th>Salesperson</th><th>Customer</th><th>Reference</th><th>Part</th>
          <th className="num">Days Late</th><th className="num">Qty</th><th>Flags</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const days = r.days_to_due
          const ref = r.wo_numbers || r.co_number || '—'
          const qty = num(r.qty_this_row) || num(r.co_qty_ordered)
          return (
            <tr key={`${r._kind}-${ref}-${r.part_number}-${i}`}>
              <td><span className={`pill ${r._kind === 'WO' ? 'combined' : 'high'}`}>{r._kind}</span></td>
              <td>{r.salesperson_name}</td>
              <td>{r.customer || '—'}</td>
              <td className="mono">{ref}</td>
              <td className="mono">{r.part_number || '—'}</td>
              <td className="num">
                {days != null && days < 0
                  ? <span className="days-late">{Math.abs(days)}d</span>
                  : (days == null ? '—' : `${days}d`)}
              </td>
              <td className="num">{qty.toLocaleString()}</td>
              <td>{pillsFor(r)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function MtsPanel({ rows }) {
  if (!rows.length) return null
  return (
    <Panel title="Make to Stock (MTS)" count={rows.length}>
      <table className="sales-tbl">
        <thead>
          <tr>
            <th>WO</th><th>Part</th><th>Phase</th><th>Due Bucket</th>
            <th className="num">Qty</th><th className="num">Good</th><th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.wo_numbers}>
              <td className="mono">{r.wo_numbers}</td>
              <td>{r.part_number || '—'}</td>
              <td>{r.production_phase}</td>
              <td>{r.due_bucket}</td>
              <td className="num">{num(r.qty_this_row).toLocaleString()}</td>
              <td className="num">{num(r.good_pieces).toLocaleString()}</td>
              <td>{pillsFor(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

const styles = `
.sales-dashboard { --ink:#0f1b2d; --paper:#ffffff; --surface:#f4f6f9; --line:#dde3ea; --muted:#5f6b7a; --blue:#185FA5; --red:#A32D2D; --red-bg:#FCEBEB; --amber:#854F0B; --amber-bg:#FAEEDA;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--surface); color:var(--ink); min-height:100vh; padding:24px; line-height:1.4; -webkit-font-smoothing:antialiased; }
.sales-dashboard * { box-sizing:border-box; }
.sales-wrap { max-width:1180px; margin:0 auto; }
.sales-top { display:flex; align-items:center; justify-content:space-between; border-bottom:2px solid var(--ink); padding-bottom:14px; margin-bottom:22px; gap:16px; flex-wrap:wrap; }
.sales-brand h1 { font-size:22px; font-weight:700; letter-spacing:-0.3px; margin:0; }
.sales-brand .sub { font-size:13px; color:var(--muted); }
.sales-controls { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.sales-asof { font-size:12px; color:var(--muted); }
.sales-btn { font-size:13px; font-weight:500; border:1px solid var(--line); background:var(--paper); color:var(--ink); padding:7px 13px; border-radius:7px; cursor:pointer; }
.sales-btn:hover { border-color:var(--blue); color:var(--blue); }
.sales-btn.primary { background:var(--blue); color:#fff; border-color:var(--blue); }
.sales-scope { font-size:13px; border:1px solid var(--line); background:var(--paper); color:var(--ink); padding:7px 10px; border-radius:7px; }
.kpis { display:grid; grid-template-columns:repeat(6,1fr); gap:12px; margin-bottom:22px; }
.kpi { position:relative; overflow:hidden; background:var(--paper); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
.kpi-bar { position:absolute; top:0; left:0; width:4px; height:100%; background:var(--blue); }
.kpi.alert { border-color:var(--red); } .kpi.alert .kpi-val { color:var(--red); } .kpi.alert .kpi-bar { background:var(--red); }
.kpi.warn { border-color:var(--amber); } .kpi.warn .kpi-val { color:var(--amber); } .kpi.warn .kpi-bar { background:var(--amber); }
.kpi-lbl { font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:var(--muted); font-weight:600; }
.kpi-val { font-size:27px; font-weight:700; letter-spacing:-1px; margin-top:4px; }
.kpi-note { font-size:11px; color:var(--muted); margin-top:2px; }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-bottom:18px; }
.panel { background:var(--paper); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin-bottom:18px; }
.panel-h2 { font-size:15px; font-weight:600; margin:0 0 14px; display:flex; align-items:center; gap:8px; }
.panel-count { font-size:12px; font-weight:600; color:var(--muted); background:var(--surface); padding:2px 8px; border-radius:10px; }
.sales-legend { display:flex; flex-wrap:wrap; gap:14px; margin-bottom:12px; font-size:12px; color:var(--muted); }
.sales-legend span { display:flex; align-items:center; gap:5px; }
.sales-legend i { width:10px; height:10px; border-radius:2px; display:inline-block; }
.sales-tbl { width:100%; border-collapse:collapse; font-size:13px; }
.sales-tbl th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.4px; color:var(--muted); font-weight:600; padding:6px 8px; border-bottom:1px solid var(--line); }
.sales-tbl th.num, .sales-tbl td.num { text-align:right; }
.sales-tbl td { padding:8px; border-bottom:1px solid var(--surface); }
.sales-tbl tr:hover td { background:var(--surface); }
.sp-name { font-weight:600; }
.mono { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:12px; }
.chip { display:inline-block; font-size:11px; font-weight:600; padding:1px 7px; border-radius:9px; }
.chip.red { background:var(--red-bg); color:var(--red); } .chip.amber { background:var(--amber-bg); color:var(--amber); } .chip.zero { color:var(--muted); }
.days-late { font-weight:700; color:var(--red); }
.pill { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.3px; padding:2px 6px; border-radius:4px; margin-right:4px; }
.pill.stalled { background:var(--red-bg); color:var(--red); } .pill.critical { background:#3b0a0a; color:#fff; } .pill.combined { background:#F1EFE8; color:#5F5E5A; } .pill.high { background:var(--amber-bg); color:var(--amber); }
.sales-empty { color:var(--muted); font-size:13px; padding:20px; text-align:center; }
.hbar-chart { display:flex; flex-direction:column; gap:10px; padding:4px 0; }
.hbar-row { display:flex; align-items:center; gap:10px; }
.hbar-label { width:90px; font-size:12px; color:var(--muted); text-align:right; flex-shrink:0; }
.hbar-track { flex:1; background:var(--surface); border-radius:4px; height:22px; overflow:hidden; }
.hbar-fill { height:100%; border-radius:4px; min-width:2px; }
.hbar-val { width:36px; font-size:13px; font-weight:600; flex-shrink:0; }
.vbar-chart { display:flex; align-items:flex-end; gap:10px; height:240px; padding-top:18px; }
.vbar-col { flex:1; display:flex; flex-direction:column; align-items:center; height:100%; }
.vbar-val { font-size:12px; font-weight:600; margin-bottom:4px; }
.vbar-track { flex:1; width:100%; display:flex; align-items:flex-end; }
.vbar-fill { width:100%; border-radius:4px 4px 0 0; min-height:2px; }
.vbar-label { font-size:11px; color:var(--muted); margin-top:6px; text-align:center; }
@media print {
  .sales-dashboard { background:#fff; padding:0; }
  .sales-controls { display:none; }
  .panel, .kpi { border-color:#ccc; }
  .panel { break-inside:avoid; }
  .sales-tbl tr { break-inside:avoid; }
  .grid2 { break-inside:avoid; }
}
`

export default function SalesDashboard() {
  const navigate = useNavigate()
  const [phase, setPhase] = useState('auth') // 'auth' | 'authorized' | 'denied'
  const [profile, setProfile] = useState(null)
  const [rows, setRows] = useState([])
  const [lastUpdated, setLastUpdated] = useState(null)
  const [scope, setScope] = useState(loadScope)

  // Auth + role gate (mirrors PresidentsBridge; standalone route, self-gating).
  useEffect(() => {
    let mounted = true
    async function checkAuth() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.user) { navigate('/'); return }
      const { data: prof, error } = await supabase
        .from('profiles')
        .select('id, full_name, role, email, is_salesperson')
        .eq('id', session.user.id)
        .single()
      if (!mounted) return
      if (error || !prof) { navigate('/'); return }
      if (!canViewSalesDashboard(prof)) { setPhase('denied'); return }
      setProfile(prof)
      setPhase('authorized')
    }
    checkAuth()
    return () => { mounted = false }
  }, [navigate])

  // Sticky scope preference.
  useEffect(() => {
    try { localStorage.setItem(SCOPE_KEY, JSON.stringify(scope)) } catch { /* ignore */ }
  }, [scope])

  // 60s poll: v3 (Production + Open Demand) and the standalone MTS view.
  useEffect(() => {
    if (phase !== 'authorized') return
    let cancelled = false
    async function load() {
      const [rep, mtsRes] = await Promise.all([
        supabase.from('v_sales_weekly_report_v3').select('*').in('section', ['B. Production', 'C. Open Demand']),
        supabase.from('v_sales_mts_production').select('*'),
      ])
      if (cancelled) return
      setRows([...(rep.data || []), ...(mtsRes.data || [])])
      setLastUpdated(new Date())
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [phase])

  if (phase === 'auth') return <div style={authStyle}>Loading sales data…</div>
  if (phase === 'denied') {
    return (
      <div style={authStyle}>
        <div>You do not have access to the Sales Dashboard.</div>
        <button
          onClick={() => navigate('/')}
          style={{ background: 'transparent', border: '1px solid #5f6b7a', color: '#5f6b7a', padding: '8px 16px', cursor: 'pointer', borderRadius: 7 }}
        >
          Return
        </button>
      </div>
    )
  }

  const scopeName = scope.mode === 'all'
    ? 'all'
    : (scope.mode === 'mine' ? (profile?.full_name || 'all') : scope.name)
  const scoped = applyScope(rows, scopeName)
  const kpis = computeKpis(scoped, rows)
  const phases = groupByPhase(scoped)
  const buckets = groupByDueBucket(scoped)
  const workload = summarizeBySalesperson(scoped)
  const atRisk = selectAtRisk(scoped)
  const mts = selectMts(rows) // MTS panel is always org-wide (unscoped)
  const showWorkload = scope.mode !== 'mine'
  const prodLines = scoped.filter(r => r.section === 'B. Production').length

  return (
    <>
      <style>{styles}</style>
      <div className="sales-dashboard">
        <div className="sales-wrap">
          <div className="sales-top">
            <div className="sales-brand">
              <h1>Sales Dashboard</h1>
              <div className="sub">Weekly Orders &amp; Demand Review</div>
            </div>
            <div className="sales-controls">
              <span className="sales-asof">As of {lastUpdated ? lastUpdated.toLocaleTimeString() : '—'}</span>
              <SalesScopeFilter profile={profile} scope={scope} onChange={setScope} />
              <button className="sales-btn primary" onClick={() => window.print()}>Print</button>
            </div>
          </div>

          <div className="kpis">
            <KpiTile label="Active WOs" value={kpis.activeWos} note={`${prodLines} CO lines`} />
            <KpiTile label="Past Due" value={kpis.pastDue} tone={kpis.pastDue ? 'alert' : ''} note="production" />
            <KpiTile label="Stalled" value={kpis.stalled} tone={kpis.stalled ? 'warn' : ''} note=">7 days no move" />
            <KpiTile label="Demand Lines" value={kpis.demandLines} note="awaiting schedule" />
            <KpiTile label="Demand Qty" value={kpis.demandQty.toLocaleString()} note="pieces open" />
            <KpiTile label="Unassigned" value={kpis.unassigned} tone={kpis.unassigned ? 'warn' : ''} note="org-wide · need owner" />
          </div>

          <div className="grid2">
            <Panel title="Production pipeline" count={`${prodLines} CO lines`}>
              <SalesPipelineChart phases={phases} />
            </Panel>
            <Panel title="Open demand by due window" count={`${kpis.demandQty.toLocaleString()} pcs`}>
              <SalesDemandChart buckets={buckets} />
            </Panel>
          </div>

          {showWorkload && (
            <Panel title="Workload by salesperson">
              <WorkloadTable rows={workload} />
            </Panel>
          )}

          <Panel title="Past due &amp; at-risk" count={atRisk.length}>
            <AtRiskTable rows={atRisk} />
          </Panel>

          <MtsPanel rows={mts} />
        </div>
      </div>
    </>
  )
}
