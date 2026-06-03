import { useState, useEffect } from 'react'
import { loadActiveSalespeople } from '../lib/salespeople'

// Encode a {mode,name} scope into the <select> value.
const enc = (scope) =>
  scope.mode === 'all' ? 'all'
    : scope.mode === 'mine' ? 'mine'
    : `person:${scope.name}`

// Scope dropdown for the Sales Dashboard.
// Emits a {mode, name} object so the page can distinguish "Just mine" (mode
// 'mine' — hides the workload table) from "filter by a specific person" (mode
// 'person' — keeps it). Salesperson list comes from the shared
// loadActiveSalespeople() helper (is_salesperson=true AND is_active=true).
export default function SalesScopeFilter({ profile, scope, onChange }) {
  const [people, setPeople] = useState([])

  useEffect(() => {
    let cancelled = false
    loadActiveSalespeople().then(rows => { if (!cancelled) setPeople(rows || []) })
    return () => { cancelled = true }
  }, [])

  function handle(e) {
    const raw = e.target.value
    if (raw === 'all') onChange({ mode: 'all', name: null })
    else if (raw === 'mine') onChange({ mode: 'mine', name: profile?.full_name || null })
    else onChange({ mode: 'person', name: raw.slice('person:'.length) })
  }

  return (
    <select className="sales-scope" value={enc(scope)} onChange={handle}>
      <option value="all">All sales</option>
      {profile?.is_salesperson && profile?.full_name && (
        <option value="mine">Just mine ({profile.full_name})</option>
      )}
      {people
        .filter(p => p.full_name && p.full_name !== profile?.full_name)
        .map(p => (
          <option key={p.id} value={`person:${p.full_name}`}>{p.full_name}</option>
        ))}
    </select>
  )
}
