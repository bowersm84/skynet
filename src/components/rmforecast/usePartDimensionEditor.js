// Shared part_dimensions editing logic for the RM Forecast section
// (D-RMF-04 / D-RMF-05).
//
// The hook lives here, apart from the controls in PartDimensionEditor.jsx, so
// that file exports components only (react-refresh/only-export-components).
// Both write surfaces — the "Needs data" exceptions panel and the "Correct
// material" action on a forecast part drill-down row — drive this one hook, so
// validation, the store-what-exists string rule, the upsert shape, and the
// audit write are never forked between them.

import { useCallback, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { numericOf } from './forecastUtils'

// Finished lengths at Skybolt are sub-6"; anything larger is a misread, not a
// part. Same bound the extraction Edge Function enforces server-side.
export const MAX_LENGTH_IN = 6

// ---------------------------------------------------------------------------
// Store-what-exists (D-RMF-01 implementation note)
//
// The option lists handed in are already rendered in whatever string format
// part_dimensions uses for a comparable material / size, with catalog text only
// as the fallback. These two helpers snap an incoming value (a prefill from the
// RPCs, or an AI suggestion) onto that same list, so a save can never mint a
// phantom second material/size group next to the one it should have joined.
// ---------------------------------------------------------------------------
export function matchMaterialOption(options, value) {
  if (!value) return ''
  const hit = (options || []).find(o => o.toLowerCase() === String(value).toLowerCase())
  return hit || String(value)
}

export function matchBarSizeOption(options, value) {
  if (!value) return ''
  const list = options || []
  const exact = list.find(o => o.value === value)
  if (exact) return exact.value
  const n = numericOf(value)
  const byNum = n == null ? null : list.find(o => o.num === n)
  return byNum ? byNum.value : String(value)
}

const trimOrNull = (v) => {
  const s = String(v ?? '').trim()
  return s === '' ? null : s
}

export function usePartDimensionEditor({
  partNumber,
  mode = 'needs_data',
  // Currently resolved values, used as prefill. For a correction these are the
  // values the forecast is bucketing on right now (which may have come from job
  // history rather than part_dimensions).
  current = {},
  // The part_dimensions row as it stands, if any. Needed so a save never
  // overwrites a source_file it did not author.
  existingRow = null,
  // Which fields this surface insists on. The exceptions panel sets the ones the
  // RPC flagged missing; a correction always requires material + bar size.
  required = {},
  materialOptions = [],
  barSizeOptions = [],
  profile = null,
  onSaved,
}) {
  const isCorrection = mode === 'correction'

  const [form, setForm] = useState(() => ({
    length_in: current.length_in != null ? String(current.length_in) : '',
    material_type: matchMaterialOption(materialOptions, current.material_type),
    bar_size: matchBarSizeOption(barSizeOptions, current.bar_size),
    correction_note: '',
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedOk, setSavedOk] = useState(false)
  // Set by applySuggestion() when an AI extraction pre-fills this row (D-RMF-05).
  const [extraction, setExtraction] = useState(null)

  const set = useCallback((field, value) => {
    setForm(f => ({ ...f, [field]: value }))
    setError('')
    setSavedOk(false)
  }, [])

  // Pre-fill from a validated suggestion envelope. Unlisted values are NEVER
  // pre-selected — they are surfaced as a warning instead, so the human picks.
  const applySuggestion = useCallback((envelope) => {
    const s = envelope?.suggestion || {}
    setExtraction(envelope)
    setError('')
    setSavedOk(false)
    setForm(f => ({
      ...f,
      length_in: s.length_in != null ? String(s.length_in) : f.length_in,
      material_type: s.material_type
        ? matchMaterialOption(materialOptions, s.material_type)
        : f.material_type,
      bar_size: s.bar_size
        ? matchBarSizeOption(barSizeOptions, s.bar_size)
        : f.bar_size,
    }))
  }, [materialOptions, barSizeOptions])

  const clearExtraction = useCallback(() => setExtraction(null), [])

  const validate = useCallback(() => {
    const lengthRaw = String(form.length_in ?? '').trim()
    let length = null
    if (lengthRaw !== '') {
      const n = parseFloat(lengthRaw)
      if (!Number.isFinite(n) || n <= 0) return { error: 'Length must be a number greater than 0.' }
      if (n >= MAX_LENGTH_IN) return { error: `Length must be less than ${MAX_LENGTH_IN}".` }
      length = n
    } else if (required.length) {
      return { error: 'Length must be a number greater than 0.' }
    }

    const material = trimOrNull(form.material_type)
    if (!material && (required.material || isCorrection)) return { error: 'Pick a material.' }

    const barSize = trimOrNull(form.bar_size)
    if (!barSize && (required.bar_size || isCorrection)) return { error: 'Pick a bar size.' }

    return { values: { length_in: length, material_type: material, bar_size: barSize } }
  }, [form, required, isCorrection])

  const save = useCallback(async () => {
    setError('')
    const { error: validationError, values } = validate()
    if (validationError) {
      setError(validationError)
      return false
    }

    const nowIso = new Date().toISOString()
    // Only what we actually know goes on the wire — a field with no value is
    // omitted so PostgREST cannot null a column it was never given (D-RMF-01).
    const payload = {
      part_number: partNumber,
      family: 'component',
      updated_at: nowIso,
    }
    if (values.length_in != null) payload.length_in = values.length_in
    if (values.material_type) payload.material_type = values.material_type
    if (values.bar_size) payload.bar_size = values.bar_size

    // Which of the AI's values actually survived to the save decides whether this
    // is an AI-assisted commit or just a manual one that happened to start there.
    const suggested = extraction?.suggestion || null
    const keptFromAi = !suggested ? 0 : [
      suggested.length_in != null && values.length_in != null
        && Number(suggested.length_in) === Number(values.length_in),
      !!suggested.material_type && !!values.material_type
        && matchMaterialOption(materialOptions, suggested.material_type) === values.material_type,
      !!suggested.bar_size && !!values.bar_size
        && matchBarSizeOption(barSizeOptions, suggested.bar_size) === values.bar_size,
    ].filter(Boolean).length
    const aiAssisted = keptFromAi > 0

    let auditRow = null

    if (isCorrection) {
      payload.material_locked = true
      payload.corrected_by = profile?.id ?? null
      payload.corrected_at = nowIso
      const note = trimOrNull(form.correction_note)
      if (note) payload.correction_note = note
      // Never overwrite a catalog provenance that is already recorded.
      if (!existingRow?.source_file) payload.source_file = 'manual'

      auditRow = {
        event_type: 'rm_material_corrected',
        operator_id: profile?.id ?? null,
        details: {
          part_number: partNumber,
          from: {
            length_in: current.length_in ?? null,
            material_type: current.material_type ?? null,
            bar_size: current.bar_size ?? null,
          },
          to: {
            length_in: values.length_in,
            material_type: values.material_type,
            bar_size: values.bar_size,
          },
          note,
        },
      }
    } else if (aiAssisted) {
      payload.source_file = 'drawing_ai'
      payload.extraction_meta = {
        envelope: extraction,
        suggested: {
          length_in: suggested.length_in ?? null,
          material_type: suggested.material_type ?? null,
          bar_size: suggested.bar_size ?? null,
        },
        saved: {
          length_in: values.length_in,
          material_type: values.material_type,
          bar_size: values.bar_size,
        },
      }
      payload.confirmed_by = profile?.id ?? null
      payload.confirmed_at = nowIso

      auditRow = {
        event_type: 'dimension_ai_confirmed',
        operator_id: profile?.id ?? null,
        details: {
          part_number: partNumber,
          suggested: payload.extraction_meta.suggested,
          saved: payload.extraction_meta.saved,
          edited: keptFromAi < 3,
          confidence: suggested.confidence ?? null,
        },
      }
    } else {
      // Phase 1 behaviour, unchanged: a hand-entered exception row is 'manual'.
      payload.source_file = 'manual'
    }

    setSaving(true)
    try {
      const { error: upsertError } = await supabase
        .from('part_dimensions')
        .upsert(payload, { onConflict: 'part_number' })
      if (upsertError) throw upsertError

      if (auditRow) {
        // Audit is a record of the commit, not a gate on it — a failure here is
        // logged but must not strand a save that already landed.
        const { error: auditError } = await supabase.from('audit_logs').insert(auditRow)
        if (auditError) console.error('audit_logs insert failed:', auditError)
      }

      setSavedOk(true)
      if (onSaved) await onSaved()
      return true
    } catch (err) {
      setError(err.message || 'Save failed.')
      return false
    } finally {
      setSaving(false)
    }
  }, [
    validate, partNumber, isCorrection, profile, form.correction_note, existingRow,
    current, extraction, materialOptions, barSizeOptions, onSaved,
  ])

  return {
    mode, isCorrection, form, set, save, saving, error, savedOk,
    extraction, applySuggestion, clearExtraction,
    materialOptions, barSizeOptions, required,
  }
}
