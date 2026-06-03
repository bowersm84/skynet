// Open demand by due window — vertical CSS bars (no charting library).
// Receives groupByDueBucket() output:
//   [{ bucket, lines, qty }, ...]  (only buckets with qty > 0)
// Colors/labels mirror SkyNet_Sales_Dashboard.html.

const BUCKET_SHORT = {
  '1. PAST DUE': 'Past Due',
  '2. Due This Week': 'This Week',
  '3. Due Next Week': 'Next Week',
  '4. Due in 2-4 Weeks': '2-4 Wks',
  '5. 4+ Weeks Out': '4+ Wks',
  '0. No Due Date': 'No Date',
}

const BUCKET_COLOR = {
  '1. PAST DUE': '#A32D2D',
  '2. Due This Week': '#EF9F27',
  '3. Due Next Week': '#BA7517',
  '4. Due in 2-4 Weeks': '#378ADD',
  '5. 4+ Weeks Out': '#185FA5',
  '0. No Due Date': '#888780',
}

const fmtK = (v) =>
  v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(v)

export default function SalesDemandChart({ buckets }) {
  if (!buckets || buckets.length === 0) {
    return <div className="sales-empty">No open demand in scope.</div>
  }
  const max = Math.max(...buckets.map(b => b.qty), 1)
  return (
    <div>
      <div className="sales-legend">
        {buckets.map(b => (
          <span key={b.bucket}>
            <i style={{ background: BUCKET_COLOR[b.bucket] || '#888' }} />
            {BUCKET_SHORT[b.bucket] || b.bucket} ({b.lines})
          </span>
        ))}
      </div>
      <div className="vbar-chart">
        {buckets.map(b => (
          <div className="vbar-col" key={b.bucket}>
            <div className="vbar-val">{fmtK(b.qty)}</div>
            <div className="vbar-track">
              <div
                className="vbar-fill"
                style={{ height: `${(b.qty / max) * 100}%`, background: BUCKET_COLOR[b.bucket] || '#888' }}
              />
            </div>
            <div className="vbar-label">{BUCKET_SHORT[b.bucket] || b.bucket}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
