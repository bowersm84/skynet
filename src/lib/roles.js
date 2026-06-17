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
// Effective role set: primary `role` ∪ additional `roles[]`.
// Single-role users (everyone pre-multi-role) get just [role] since roles defaults to {}.
export function userRoles(profile) {
  return [...new Set([profile?.role, ...(profile?.roles || [])].filter(Boolean))]
}

// True if the profile holds ANY of the given roles (primary or additional).
export function hasRole(profile, ...roles) {
  return userRoles(profile).some(r => roles.includes(r))
}

// Master-data + finished-goods writes (Material Types/Catalog, Bar Sizes, Products, Parts, Routing).
export function canWriteMasterData(profile) {
  return hasRole(profile, 'admin', 'compliance')
}

// Receiving writes (Log Receipt). Keeps finishing's existing access; excludes purchaser.
export function canReceive(profile) {
  return hasRole(profile, 'admin', 'compliance', 'finishing')
}

export function canViewSalesDashboard(profile) {
  if (!profile) return false
  return hasRole(profile, 'admin', 'customer_service', 'president', 'viewer') || profile.is_salesperson === true
}
