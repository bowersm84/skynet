// Shared by Customer Orders, the Command page's Demand tab and the Order Queue's Stock requests panel — moved out of
// CustomerOrders.jsx unchanged when Demand and Stock Requests left that page (S17 B2, D-ASM-33).

export function formatDate(dateStr) {
  if (!dateStr) return '—'
  // dateStr is a YYYY-MM-DD from the DB; render in local TZ without
  // re-parsing through midnight UTC (Decisions.md "Date/timezone — local-noon UTC").
  const [y, m, d] = dateStr.split('-')
  if (!y || !m || !d) return dateStr
  const dt = new Date(Number(y), Number(m) - 1, Number(d), 12)
  return dt.toLocaleDateString()
}

// Compact M/D/YY for tight columns inside the expanded line sub-table.
export function formatDateShort(dateStr) {
  if (!dateStr) return '—'
  const [y, m, d] = dateStr.split('-')
  if (!y || !m || !d) return dateStr
  return `${Number(m)}/${Number(d)}/${String(y).slice(-2)}`
}

export const PRIORITY_BADGE = {
  critical: 'bg-red-900/50 text-red-300 border border-red-700/50',
  high: 'bg-amber-900/50 text-amber-300 border border-amber-700/50',
  normal: 'bg-gray-700 text-gray-300 border border-gray-600',
  low: 'bg-gray-800 text-gray-500 border border-gray-700',
}
