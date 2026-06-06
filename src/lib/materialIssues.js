// src/lib/materialIssues.js
// Pure helpers for the Raw Material Checkout Kiosk. No DB calls — unit-testable.
// Mirrors the lib/machineStatus.js / lib/salesMetrics.js pattern.

/** Bars consumed = loaded minus remnants; null remnants count as 0. */
export function deriveConsumed(row) {
  const loaded = Number(row?.bars_loaded) || 0
  const remaining = row?.bars_remaining == null ? 0 : (Number(row.bars_remaining) || 0)
  return Math.max(0, loaded - remaining)
}

/** Derived staging state (no status column): 'finalized' | 'loaded' | 'empty'. */
export function materialStage(row) {
  if (!row) return 'empty'
  if (row.completed_at) return 'finalized'
  if (row.loaded_by || (Number(row.bars_loaded) || 0) > 0) return 'loaded'
  return 'empty'
}

/** Validate a remnant entry against bars loaded. -> { ok, error? } */
export function validateRemnant(barsLoaded, barsRemaining) {
  const loaded = Number(barsLoaded)
  const remaining = Number(barsRemaining)
  if (!Number.isFinite(remaining) || remaining < 0) {
    return { ok: false, error: 'Bars remaining cannot be negative.' }
  }
  if (Number.isFinite(loaded) && remaining > loaded) {
    return { ok: false, error: `Bars remaining (${remaining}) cannot exceed bars loaded (${loaded}).` }
  }
  return { ok: true }
}

/** Label a materials-master row: { material_types:{name}, bar_size_inches } -> '17-4PH · 0.500"'. */
export function formatMaterialLabel(materialRow) {
  if (!materialRow) return ''
  const type = materialRow.material_types?.name || materialRow.material_type || ''
  const size = materialRow.bar_size_inches != null
    ? `${Number(materialRow.bar_size_inches).toFixed(3)}"`
    : (materialRow.bar_size || '')
  return [type, size].filter(Boolean).join(' · ')
}

/** One-lot-per-job (mirrors kiosk B1 guard). true = new lot allowed. */
export function lotAllowed(existingLot, newLot) {
  const a = (existingLot || '').trim().toLowerCase()
  const b = (newLot || '').trim().toLowerCase()
  if (!a || !b) return true
  return a === b
}
