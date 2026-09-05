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

// Reports module (D-RPT-01) — every authenticated role can VIEW reports;
// CSV export is restricted to these roles. Effective role set: role ∪ roles[].
export const REPORT_EXPORT_ROLES = ['admin', 'president', 'scheduler']

export function canExportReports(profile) {
  return hasRole(profile, ...REPORT_EXPORT_ROLES)
}

// Order Queue (FB1, D-FB-13). Read: broad visibility — Customer Service sees every
// Fishbowl order; act (disposition, Create CO, exception ack): admin or the
// `order_processor` ADDITIONAL role (profiles.roles[], assigned in Armory → Users).
// `integration` is the bridge's service-account role; it has no UI.
export const ORDER_QUEUE_READ_ROLES = ['admin', 'customer_service', 'scheduler', 'president', 'viewer', 'assembly', 'order_processor']

export function canAccessOrderQueue(profile) {
  if (!profile) return false
  return hasRole(profile, ...ORDER_QUEUE_READ_ROLES) || profile.is_salesperson === true
}

export function canActOnOrderQueue(profile) {
  return hasRole(profile, 'admin', 'order_processor') && !isReadOnlyRole(profile?.role)
}

// Pricing Portal (S11, D-PRICE-17). View — everything in the portal, tiers included:
// admin, customer_service (April, Christy, Sawyer, Peyton), president, viewer.
// Edit (books, items, rules, tiers, exceptions): admin only. Office session only —
// the page itself bounces kiosk JWTs. Same gate lives server-side in _pricing_gate().
export const PRICING_VIEW_ROLES = ['admin', 'customer_service', 'president', 'viewer']

export function canViewPricing(profile) {
  if (!profile) return false
  return hasRole(profile, ...PRICING_VIEW_ROLES)
}

export function canEditPricing(profile) {
  return hasRole(profile, 'admin') && !isReadOnlyRole(profile?.role)
}
