import { useState, useEffect } from 'react'
import { FIELD_DEBOUNCE } from '../../lib/kitRegistry'
import { matchClaimedKit, matchAircraftClaim, matchCompany } from '../../lib/stcIntake'

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

// Page index that resets when `key` changes, using React's adjust-state-during-
// render pattern rather than a reset effect.
export function usePageReset(key) {
  const [page, setPage] = useState(0)
  const [prevKey, setPrevKey] = useState(key)
  if (prevKey !== key) { setPrevKey(key); setPage(0) }
  return [page, setPage]
}
