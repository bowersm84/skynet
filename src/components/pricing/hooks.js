//
// Shared hooks for the Pricing Portal components.
//
// Hooks live outside the .jsx so `react-refresh/only-export-components` stays
// clean — the same split D-RMF-04 settled on for usePartDimensionEditor.
//
import { useMemo, useState } from 'react'

// ── Column sorting, shared by the Customers purchase table and the Price List builder (D-PRICE-42) ──
// useSortedRows(rows, cols): cols is { [key]: row => value } and MUST be referentially stable
// (module constant or useMemo). Click cycles asc → desc → off; blanks sort last either way.
export function useSortedRows(rows, cols) {
  const [sort, setSort] = useState(null)   // { key, dir: 'asc' | 'desc' } | null
  const sorted = useMemo(() => {
    if (!sort || !rows) return rows
    const get = cols[sort.key]; if (!get) return rows
    const dir = sort.dir === 'desc' ? -1 : 1
    const blank = v => v === null || v === undefined || v === ''
    return [...rows].sort((a, b) => {
      const va = get(a), vb = get(b)
      if (blank(va) && blank(vb)) return 0
      if (blank(va)) return 1
      if (blank(vb)) return -1
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
      return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * dir
    })
  }, [rows, cols, sort])
  const toggle = (key) => setSort(s => (!s || s.key !== key) ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null)
  return { sorted, sort, toggle }
}
