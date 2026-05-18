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
