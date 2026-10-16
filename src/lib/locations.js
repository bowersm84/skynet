import { FEATURES } from '../config'

// D-LOC-01: the Tavares facility's locations.code. Matched on the stable code,
// never on the display name (D-DATA-03: names change under you).
export const TAVARES_LOCATION_CODE = 'SB-TAV'

// D-LOC-01: true when a machine's location is switched off in config.js
// (FEATURES.TAVARES_LOCATION = false) and must stay out of the Mainframe
// lineup and the Command views. `loc` is the location object joined onto a
// machine row (needs `code`). Kiosks, dashboards, the Bridge and the routing
// pickers never call this.
export function isLocationHidden(loc) {
  if (FEATURES.TAVARES_LOCATION) return false
  return loc?.code === TAVARES_LOCATION_CODE
}
