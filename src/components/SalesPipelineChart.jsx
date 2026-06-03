// Production pipeline — horizontal CSS bars (no charting library, matching the
// Bridge/Production dashboards' approach). Receives groupByPhase() output:
//   [{ phase, count }, ...]  (only phases with count > 0)
// Colors/labels mirror SkyNet_Sales_Dashboard.html.

const PHASE_SHORT = {
  '1. Waiting to Run': 'Waiting',
  '2. In Machining': 'Machining',
  '3. Finishing / QC': 'Finishing/QC',
  '4. Outsourced': 'Outsourced',
  '5. Assembly': 'Assembly',
  '6. Pending TCO': 'Pending TCO',
}

const PHASE_COLOR = {
  '1. Waiting to Run': '#888780',
  '2. In Machining': '#378ADD',
  '3. Finishing / QC': '#1D9E75',
  '4. Outsourced': '#EF9F27',
  '5. Assembly': '#7F77DD',
  '6. Pending TCO': '#D4537E',
}

export default function SalesPipelineChart({ phases }) {
  if (!phases || phases.length === 0) {
    return <div className="sales-empty">No active production in scope.</div>
  }
  const max = Math.max(...phases.map(p => p.count), 1)
  return (
    <div>
      <div className="sales-legend">
        {phases.map(p => (
          <span key={p.phase}>
            <i style={{ background: PHASE_COLOR[p.phase] || '#888' }} />
            {PHASE_SHORT[p.phase] || p.phase} {p.count}
          </span>
        ))}
      </div>
      <div className="hbar-chart">
        {phases.map(p => (
          <div className="hbar-row" key={p.phase}>
            <div className="hbar-label">{PHASE_SHORT[p.phase] || p.phase}</div>
            <div className="hbar-track">
              <div
                className="hbar-fill"
                style={{ width: `${(p.count / max) * 100}%`, background: PHASE_COLOR[p.phase] || '#888' }}
              />
            </div>
            <div className="hbar-val">{p.count}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
