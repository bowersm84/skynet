// Material categories that require passivation chemical lot fields
// (Citric Acid lot + Alkaline Mix lot).
//
// Keep this list aligned with the operational truth: only stainless-based parts
// require the chemicals. Steel and aluminum do not — they skip passivation
// chemicals entirely.

export const REQUIRES_CHEMICALS_CATEGORIES = ['Stainless', 'Pre-Formed']

/**
 * @param {object|null|undefined} part   A part object with a nested material_type, or
 *                                       a denormalized shape with material_category.
 * @returns {boolean} true if this part's material category requires chemical lot tracking.
 *
 * Defensive default: if the category cannot be determined, return TRUE so the
 * operator is prompted to verify rather than the system silently skipping
 * required data.
 */
export function requiresChemicals(part) {
  if (!part) return true
  const category =
    part?.material_type?.category ??
    part?.material_category ??
    null
  if (!category) return true
  return REQUIRES_CHEMICALS_CATEGORIES.includes(category)
}
