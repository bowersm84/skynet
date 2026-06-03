// Read-only roles — see everything, edit nothing
export const READ_ONLY_ROLES = ['president', 'viewer']

export function isReadOnlyRole(role) {
  return READ_ONLY_ROLES.includes(role)
}

// Roles that get the Bridge dashboard
export const BRIDGE_ROLES = ['president', 'admin']

export function canSeeBridge(role) {
  return BRIDGE_ROLES.includes(role)
}

// Roles that can see the Sales Dashboard (SKY S10).
// is_salesperson=true (any base role) OR admin / customer_service / president / viewer.
// Compliance, scheduler, and kiosk roles (machinist, finishing, assembly) are excluded.
// Single source of truth for the /dashboards/sales route guard AND the dropdown entry.
export function canViewSalesDashboard(profile) {
  if (!profile) return false
  const ALLOWED_ROLES = ['admin', 'customer_service', 'president', 'viewer']
  return ALLOWED_ROLES.includes(profile.role) || profile.is_salesperson === true
}
