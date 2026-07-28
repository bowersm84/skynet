// Renders the `machines` string returned by forecast_rm_bar_parts /
// forecast_blank_demand — a comma-separated list of distinct machine names for
// the jobs behind that part/week bucket, where pre-schedule jobs contribute
// "Unassigned".
//
// Unassigned tokens are muted so a row that is partly unplanned reads at a
// glance. The list truncates to keep the drill-down tables at their existing
// width; the full list is always available via the title tooltip.
export default function MachinesCell({ machines, maxWidth = 'max-w-[14rem]' }) {
  const raw = String(machines ?? '').trim()
  if (!raw) return <span className="text-gray-600">—</span>

  const tokens = raw.split(',').map(t => t.trim()).filter(Boolean)

  return (
    <span className={`block truncate ${maxWidth}`} title={raw}>
      {tokens.map((token, i) => (
        <span key={`${token}-${i}`}>
          {i > 0 && <span className="text-gray-600">, </span>}
          <span className={token.toLowerCase() === 'unassigned' ? 'text-gray-500' : 'text-gray-300'}>
            {token}
          </span>
        </span>
      ))}
    </span>
  )
}
