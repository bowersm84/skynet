import { useState, useEffect } from 'react'
import { Search, Loader2, AlertTriangle, ChevronDown } from 'lucide-react'
import { FIELD_DEBOUNCE, formatLogDate, lotLabel, searchParties } from '../../lib/kitRegistry'
import { searchKitLots, KIT_SEARCH_LIMIT } from '../../lib/stcIntake'
import { SourceBadge, Empty, Typeahead } from './ui'

// Step 1 of New Request (D-KSTC-19). The kit log entry is found FIRST, before
// any paperwork is touched, so the request is born linked and lands as 'matched'
// instead of joining the resolution backlog.
//
// The escape hatch exists because roughly four fifths of the paper books are
// still untranscribed — a customer can legitimately reference a kit SkyNet has
// never seen. It is deliberately secondary, and it costs a typed reason: an
// unlinked request goes into the exception queue with an explanation attached,
// which is the difference between a queue and an inbox.

export default function StcFindKit({ onSelect, onSkip, onCancel }) {
  const [customerText, setCustomerText] = useState('')
  const [party, setParty] = useState(null)          // pinned kit_parties row
  const [soText, setSoText] = useState('')
  const [kitNumber, setKitNumber] = useState('')

  const [result, setResult] = useState(null)        // { rows, truncated, kitNotNumeric }
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState(null)

  const [escapeOpen, setEscapeOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState(null)

  const hasCriteria = !!party || !!customerText.trim() || !!soText.trim() || !!kitNumber.trim()

  // Debounced on every field — three inputs that all narrow the same list read
  // better as one live result set than as a form with a Search button.
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      if (!hasCriteria) {
        if (!cancelled) { setResult(null); setSearching(false); setError(null) }
        return
      }
      if (!cancelled) setSearching(true)
      try {
        const found = await searchKitLots({
          customerText, customerPartyId: party?.id || null, soText, kitNumber,
        })
        if (!cancelled) { setResult(found); setError(null) }
      } catch (err) {
        console.error('Kit search failed:', err)
        if (!cancelled) { setResult(null); setError('The kit search failed. Try again.') }
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, FIELD_DEBOUNCE)
    return () => { cancelled = true; clearTimeout(t) }
  }, [customerText, party, soText, kitNumber, hasCriteria])

  const continueUnlinked = () => {
    const trimmed = reason.trim()
    if (!trimmed) { setReasonError('Say why the kit could not be found.'); return }
    onSkip(trimmed)
  }

  const rows = result?.rows || []

  return (
    <div className="p-5 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-white text-lg font-semibold">New STC request — find the kit</h2>
        <button onClick={onCancel} className="text-gray-400 hover:text-white text-sm">
          Back to worklist
        </button>
      </div>
      <p className="text-gray-400 text-sm mb-5">
        Find the kit log entry this request is about. Search by any combination — every
        field you fill narrows the list.
      </p>

      <div className="grid sm:grid-cols-3 gap-4 mb-5">
        <Typeahead
          label="Customer"
          value={customerText}
          onChange={setCustomerText}
          pinned={party}
          onPin={setParty}
          onUnpin={() => setParty(null)}
          fetcher={searchParties}
          renderItem={p => <span>{p.name}</span>}
          placeholder="Customer name"
        />
        <div>
          <label className="block text-gray-400 text-xs font-medium mb-1.5">Sales Order #</label>
          <input
            value={soText}
            onChange={e => setSoText(e.target.value)}
            placeholder="e.g. 11356"
            className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:border-skynet-accent focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-gray-400 text-xs font-medium mb-1.5">Kit #</label>
          <input
            value={kitNumber}
            onChange={e => setKitNumber(e.target.value)}
            placeholder="e.g. 99000"
            inputMode="numeric"
            className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm font-mono placeholder-gray-500 focus:border-skynet-accent focus:outline-none"
          />
        </div>
      </div>

      {/* ---- Results ---- */}
      {!hasCriteria ? (
        <div className="rounded-xl border border-gray-700 bg-gray-800/40 p-8 text-center">
          <Search size={26} className="mx-auto mb-2 text-gray-600" />
          <p className="text-gray-400 text-sm">Start typing to find the kit.</p>
        </div>
      ) : searching ? (
        <div className="flex items-center gap-2 text-gray-400 text-sm py-8 justify-center">
          <Loader2 size={16} className="animate-spin" /> Searching kit logs…
        </div>
      ) : error ? (
        <Empty>{error}</Empty>
      ) : result?.kitNotNumeric ? (
        <Empty>Kit # is a plain number in the books — try just the digits.</Empty>
      ) : !rows.length ? (
        <Empty>No kit log entry matches. Widen the search, or use the escape below.</Empty>
      ) : (
        <>
          {result.truncated && (
            <p className="text-amber-300 text-xs mb-2">
              More than {KIT_SEARCH_LIMIT} matches — showing the first {KIT_SEARCH_LIMIT}. Add
              another field to narrow.
            </p>
          )}
          <div className="overflow-x-auto rounded-xl border border-gray-700">
            <table className="w-full text-sm">
              <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Kit</th>
                  <th className="text-left px-3 py-2 font-medium">Logged</th>
                  <th className="text-left px-3 py-2 font-medium">Kit name</th>
                  <th className="text-left px-3 py-2 font-medium">Customer</th>
                  <th className="text-left px-3 py-2 font-medium">SO</th>
                  <th className="text-left px-3 py-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(l => (
                  <tr
                    key={l.id}
                    onClick={() => onSelect(l)}
                    className={`border-t border-gray-800 hover:bg-gray-800/60 cursor-pointer ${
                      l.record_status !== 'active' ? 'opacity-50' : ''
                    }`}
                  >
                    <td className="px-3 py-2 whitespace-nowrap font-mono font-semibold text-skynet-accent">
                      {lotLabel(l)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-300">{formatLogDate(l.log_date)}</td>
                    <td className="px-3 py-2 text-gray-200 min-w-[10rem]">
                      {/* As-written leads; the catalog description is the tooltip,
                          so the row reads like the book but still explains itself. */}
                      <span title={l.sku?.description || l.sku?.part_number || undefined}>
                        {l.kit_part_as_written || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-gray-300 min-w-[10rem]">
                      {l.customer_as_written || l.party?.name || '—'}
                    </td>
                    <td className="px-3 py-2 text-gray-300 whitespace-nowrap">{l.so_as_written || '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap"><SourceBadge source={l.source} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ---- Escape hatch: present, but never the easy path ---- */}
      <div className="mt-8 pt-5 border-t border-gray-800">
        {!escapeOpen ? (
          <button
            onClick={() => setEscapeOpen(true)}
            className="flex items-center gap-1.5 text-gray-500 hover:text-gray-300 text-sm"
          >
            <ChevronDown size={14} /> Can&rsquo;t find this kit?
          </button>
        ) : (
          <div className="rounded-xl border border-amber-700/60 bg-amber-900/15 p-4">
            <div className="flex items-start gap-2">
              <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-amber-100 text-sm font-medium">Continue without a kit log entry</p>
                <p className="text-amber-200/70 text-xs mt-1">
                  Most of the paper books are not transcribed yet, so a real kit may genuinely
                  not be here. Saying so is fine — but the request goes to the office&rsquo;s
                  exception queue, and they will need to know what you already tried.
                </p>
                <label className="block text-amber-100/80 text-xs font-medium mt-3 mb-1.5">
                  Why can&rsquo;t it be found? <span className="text-red-400">*</span>
                </label>
                <textarea
                  value={reason}
                  onChange={e => { setReason(e.target.value); setReasonError(null) }}
                  rows={2}
                  placeholder="e.g. customer cites kit 78210 — Beech book page not transcribed yet"
                  className={`w-full px-3 py-2.5 bg-gray-900 border rounded-lg text-white text-sm placeholder-gray-600 focus:border-amber-500 focus:outline-none resize-none ${
                    reasonError ? 'border-red-500' : 'border-amber-800'
                  }`}
                />
                {reasonError && <p className="text-red-400 text-xs mt-1.5">{reasonError}</p>}
                <div className="flex flex-wrap gap-3 mt-3">
                  <button
                    onClick={continueUnlinked}
                    className="px-4 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 text-white text-sm font-medium"
                  >
                    Continue without linking
                  </button>
                  <button
                    onClick={() => { setEscapeOpen(false); setReason(''); setReasonError(null) }}
                    className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm font-medium"
                  >
                    Keep looking
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
