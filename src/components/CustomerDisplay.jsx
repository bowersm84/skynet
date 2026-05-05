import { useState, useEffect, useRef } from 'react'

// Click-to-expand customer label for WOs with multiple CO allocations.
// Pass the result of summarizeWOAllocations(allocations) and an optional
// fallback for the no-allocations case.
export default function CustomerDisplay({ summary, fallback = null, className = '' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (!summary?.hasAllocations) {
    return <span className={className}>{fallback ?? <span className="text-gray-600">—</span>}</span>
  }
  if (summary.customerCount === 1) {
    return <span className={className}>{summary.customerList[0]}</span>
  }

  return (
    <span ref={ref} className={`relative inline-block ${className}`}>
      <span>{summary.customerList[0]}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          setOpen((o) => !o)
        }}
        className="ml-1 text-xs text-purple-300 hover:text-purple-200 underline cursor-pointer"
      >
        +{summary.customerCount - 1} more
      </button>
      {open && (
        <div
          className="absolute z-50 mt-1 left-0 bg-gray-800 border border-gray-700 rounded shadow-xl p-2 min-w-[220px]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5 px-1">
            Customers ({summary.customerCount})
          </div>
          <ul className="text-sm space-y-0.5">
            {summary.customerList.map((name) => (
              <li key={name} className="text-gray-200 px-1 py-0.5">{name}</li>
            ))}
          </ul>
        </div>
      )}
    </span>
  )
}
