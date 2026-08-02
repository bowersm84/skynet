import { useState, useEffect } from 'react'

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

// Page index that resets when `key` changes, using React's adjust-state-during-
// render pattern rather than a reset effect.
export function usePageReset(key) {
  const [page, setPage] = useState(0)
  const [prevKey, setPrevKey] = useState(key)
  if (prevKey !== key) { setPrevKey(key); setPage(0) }
  return [page, setPage]
}
