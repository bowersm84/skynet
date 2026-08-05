import { useState, useEffect, useCallback } from 'react'
import { FIELD_DEBOUNCE } from '../../lib/kitRegistry'
import { matchClaimedKit, matchAircraftClaim, matchCompany } from '../../lib/stcIntake'
import { extractPackingSlip, seedLines, compressImageForExtraction } from '../../lib/packingSlip'

// Hooks live outside the .jsx so `react-refresh/only-export-components` stays
// clean — the same split D-RMF-04 settled on for usePartDimensionEditor.

// Loads `loader()` whenever `key` changes. State is only ever set from the
// async callback — never synchronously inside the effect body — and freshness
// is derived at render by comparing the stored key, so a stale result can't
// flash while a new key is in flight. (react-hooks/set-state-in-effect.)
export function useAsyncData(loader, key) {
  const [state, setState] = useState({ key: undefined, data: null, error: null })
  useEffect(() => {
    let cancelled = false
    Promise.resolve().then(loader)
      .then(data => { if (!cancelled) setState({ key, data, error: null }) })
      .catch(err => {
        console.error('Kit registry load failed:', err)
        if (!cancelled) setState({ key, data: null, error: err.message || 'Load failed' })
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const fresh = state.key === key
  return { loading: !fresh, data: fresh ? state.data : null, error: fresh ? state.error : null }
}

// Live match hints for the STC claim fields, shared by the intake form and the
// drawer's edit mode so both derive them one way (D-KSTC-21).
//
// Purely informational: nothing here writes a foreign key. Binding a request to
// a lot, an airframe or a party is Round C2 resolution work. Each field debounces
// independently — correcting a serial shouldn't re-query the company.
export function useStcMatchHints({
  claimedKitNumber, claimedAircraftSerial, claimedRegistration, requesterCompany,
}) {
  const [hints, setHints] = useState({ kit: null, aircraft: null, company: null })

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const kit = await matchClaimedKit(claimedKitNumber)
        if (!cancelled) setHints(prev => ({ ...prev, kit }))
      } catch (err) {
        console.error('Kit-number hint failed:', err)
        if (!cancelled) setHints(prev => ({ ...prev, kit: null }))
      }
    }, FIELD_DEBOUNCE)
    return () => { cancelled = true; clearTimeout(t) }
  }, [claimedKitNumber])

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const aircraft = await matchAircraftClaim({
          serial: claimedAircraftSerial, registration: claimedRegistration,
        })
        if (!cancelled) setHints(prev => ({ ...prev, aircraft }))
      } catch (err) {
        console.error('Aircraft hint failed:', err)
        if (!cancelled) setHints(prev => ({ ...prev, aircraft: null }))
      }
    }, FIELD_DEBOUNCE)
    return () => { cancelled = true; clearTimeout(t) }
  }, [claimedAircraftSerial, claimedRegistration])

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const company = await matchCompany(requesterCompany)
        if (!cancelled) setHints(prev => ({ ...prev, company }))
      } catch (err) {
        console.error('Company hint failed:', err)
        if (!cancelled) setHints(prev => ({ ...prev, company: null }))
      }
    }, FIELD_DEBOUNCE)
    return () => { cancelled = true; clearTimeout(t) }
  }, [requesterCompany])

  return hints
}

// The packing-slip read, owned in one place so the Packing Slip tab and the
// Kit Entry form can't drift on what "the slip says" means (D-KSTC-29).
//
// This hook owns exactly the file → extraction → editable-lines cycle. What each
// surface then DOES with a slip differs — the tab matches it against every kit
// lot on the order, Kit Entry matches it against the one kit being logged — so
// `ingest` hands the envelope back and lets the caller take it from there.
export function useSlipExtraction() {
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [slip, setSlip] = useState(null)
  const [lines, setLines] = useState({})   // group index → editable line rows

  // Returns the envelope, or null when nothing was read. Never throws: a failed
  // extraction costs typing, never the ability to save (D-KSTC-28).
  const ingest = useCallback(async (files) => {
    const picked = [...(files || [])][0]
    if (!picked) return null

    // The ORIGINAL file is what is held and later attached to the lot — it is
    // the evidence. Only the copy sent to the extractor is shrunk (D-KSTC-31).
    setFile(picked)
    setError(null)
    setSlip(null)
    setLines({})
    setBusy(true)
    try {
      const forExtraction = await compressImageForExtraction(picked)
      const envelope = await extractPackingSlip(forExtraction)
      setSlip(envelope)
      setLines(seedLines(envelope))
      return envelope
    } catch (err) {
      console.error('Packing-slip extraction failed:', err)
      setError(err.message || 'That slip could not be read.')
      return null
    } finally {
      setBusy(false)
    }
  }, [])

  const reset = useCallback(() => {
    setFile(null); setBusy(false); setError(null); setSlip(null); setLines({})
  }, [])

  // `edited` retires the confidence chip: the value is the human's now.
  const editLine = useCallback((groupIndex, key, field, value) => {
    setLines(prev => ({
      ...prev,
      [groupIndex]: (prev[groupIndex] || []).map(
        l => (l.key === key ? { ...l, [field]: value, edited: true } : l)),
    }))
  }, [])

  const dropLine = useCallback((groupIndex, key) => {
    setLines(prev => ({
      ...prev,
      [groupIndex]: (prev[groupIndex] || []).filter(l => l.key !== key),
    }))
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return {
    file, busy, error, slip, lines,
    hasFile: !!file,
    ingest, reset, editLine, dropLine, clearError,
  }
}

// Page index that resets when `key` changes, using React's adjust-state-during-
// render pattern rather than a reset effect.
export function usePageReset(key) {
  const [page, setPage] = useState(0)
  const [prevKey, setPrevKey] = useState(key)
  if (prevKey !== key) { setPrevKey(key); setPage(0) }
  return [page, setPage]
}
