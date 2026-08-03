import { useState, useEffect, useCallback } from 'react'
import { Search as SearchIcon, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import {
  searchParties, searchSkus, searchComponents, searchAircraft,
  previewLotByNumber, lookupInvoice, componentRecall, skusByIds,
  loadLots, filteredLotStats, partyLens, skuLens, invoiceLens,
  componentLotLens, componentLotLotIds,
  loadGlobalDashboard, formatLogDate, formatSince, lotLabel, uniq,
  FIELD_DEBOUNCE, PAGE_SIZE,
} from '../../lib/kitRegistry'
import { supabase } from '../../lib/supabase'
import {
  StatCard, Section, Empty, Spinner, LinkText, Pager, LotsTable, Typeahead, Pill,
} from './ui'
import { useAsyncData, usePageReset } from './hooks'
import KitDrawer, { AircraftBody } from './KitDrawer'

export default function KitSearch() {
  // --- field state ----------------------------------------------------------
  const [customerText, setCustomerText] = useState('')
  const [customerPinned, setCustomerPinned] = useState(null)
  const [kitText, setKitText] = useState('')
  const [kitPinned, setKitPinned] = useState(null)
  const [kitNumber, setKitNumber] = useState('')
  const [componentText, setComponentText] = useState('')
  const [componentPinned, setComponentPinned] = useState(null)
  const [componentLotText, setComponentLotText] = useState('')
  const [invoiceText, setInvoiceText] = useState('')
  const [aircraftText, setAircraftText] = useState('')
  const [aircraftPinned, setAircraftPinned] = useState(null)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  // --- previews -------------------------------------------------------------
  const [lotPreview, setLotPreview] = useState(null)
  const [invoiceEcho, setInvoiceEcho] = useState(null)

  // --- result state ---------------------------------------------------------
  const [active, setActive] = useState(null)  // { kind, ...payload }
  const [running, setRunning] = useState(false)
  const [searchError, setSearchError] = useState(null)

  // --- drawer stack ---------------------------------------------------------
  const [stack, setStack] = useState([])
  const push = useCallback((entry) => setStack(s => [...s, entry]), [])
  const pop = useCallback(() => setStack(s => s.slice(0, -1)), [])
  const closeDrawer = useCallback(() => setStack([]), [])

  // --- kit # live preview ---------------------------------------------------
  useEffect(() => {
    setLotPreview(null)
    const raw = kitNumber.trim()
    if (!/^\d+$/.test(raw)) return
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const lot = await previewLotByNumber(raw)
        if (!cancelled) setLotPreview(lot)
      } catch (err) { console.error('Kit # preview failed:', err) }
    }, FIELD_DEBOUNCE)
    return () => { cancelled = true; clearTimeout(t) }
  }, [kitNumber])

  // --- invoice echo ---------------------------------------------------------
  useEffect(() => {
    setInvoiceEcho(null)
    const raw = invoiceText.trim()
    if (!raw) return
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const info = await lookupInvoice(raw)
        if (!cancelled) setInvoiceEcho(info)
      } catch (err) { console.error('Invoice lookup failed:', err) }
    }, FIELD_DEBOUNCE)
    return () => { cancelled = true; clearTimeout(t) }
  }, [invoiceText])

  // --- which fields carry a value ------------------------------------------
  const activeFields = () => {
    const a = []
    if (customerPinned) a.push('customer'); else if (customerText.trim()) a.push('customerText')
    if (kitPinned) a.push('kit'); else if (kitText.trim()) a.push('kitText')
    if (componentPinned) a.push('component'); else if (componentText.trim()) a.push('componentText')
    if (componentLotText.trim()) a.push('componentLot')
    if (aircraftPinned) a.push('aircraft'); else if (aircraftText.trim()) a.push('aircraftText')
    if (invoiceText.trim()) a.push('invoice')
    if (kitNumber.trim()) a.push('kitNumber')
    if (dateFrom) a.push('dateFrom')
    if (dateTo) a.push('dateTo')
    return a
  }

  const clearAll = () => {
    setCustomerText(''); setCustomerPinned(null)
    setKitText(''); setKitPinned(null)
    setKitNumber(''); setLotPreview(null)
    setComponentText(''); setComponentPinned(null)
    setComponentLotText('')
    setInvoiceText(''); setInvoiceEcho(null)
    setAircraftText(''); setAircraftPinned(null)
    setDateFrom(''); setDateTo('')
    setActive(null); setSearchError(null)
  }

  // Aircraft (pinned or free text) constrains lots through installations.
  const lotIdsFromAircraft = async () => {
    let ids = []
    if (aircraftPinned) ids = [aircraftPinned.id]
    else if (aircraftText.trim()) ids = (await searchAircraft(aircraftText)).map(a => a.id)
    if (!ids.length) return []
    const { data } = await supabase
      .from('kit_installations').select('kit_lot_id').in('aircraft_id', ids)
    return uniq((data || []).map(r => r.kit_lot_id))
  }

  const runSearch = async () => {
    const fields = activeFields()
    setSearchError(null)
    if (!fields.length) { setActive(null); return }

    setRunning(true)
    try {
      // 1) A bare kit # with an exact hit opens the lot drawer, no dashboard.
      if (fields.length === 1 && fields[0] === 'kitNumber') {
        if (lotPreview) {
          push({ type: 'lot', id: lotPreview.id, label: lotLabel(lotPreview) })
          setActive(null)
          return
        }
        setSearchError(`No lot numbered ${kitNumber.trim()} in any book.`)
        setActive(null)
        return
      }

      // 2) Exactly one pinned entity, nothing else → that entity's lens.
      if (fields.length === 1) {
        const only = fields[0]
        if (only === 'customer') { setActive({ kind: 'party', party: customerPinned }); return }
        if (only === 'kit') { setActive({ kind: 'sku', sku: kitPinned }); return }
        if (only === 'component') { setActive({ kind: 'component', component: componentPinned }); return }
        if (only === 'aircraft') { setActive({ kind: 'aircraft', aircraft: aircraftPinned }); return }
        if (only === 'invoice') { setActive({ kind: 'invoice', invoiceNumber: invoiceText.trim() }); return }
        if (only === 'componentLot') { setActive({ kind: 'componentLot', lotText: componentLotText.trim() }); return }
      }

      // 3) Everything else → filtered lots lens (AND across every field).
      const filters = {}
      if (customerPinned) filters.partyId = customerPinned.id
      else if (customerText.trim()) {
        filters.customerText = customerText.trim()
        const parties = await searchParties(customerText)
        filters.customerPartyIds = parties.map(p => p.id)
      }
      if (kitPinned) filters.skuId = kitPinned.id
      else if (kitText.trim()) {
        const skus = await searchSkus(kitText)
        filters.skuIds = skus.map(s => s.id)
        if (!filters.skuIds.length) filters.skuIds = ['00000000-0000-0000-0000-000000000000']
      }
      if (invoiceText.trim()) filters.invoiceText = invoiceText.trim()
      if (dateFrom) filters.dateFrom = dateFrom
      if (dateTo) filters.dateTo = dateTo
      if (kitNumber.trim() && /^\d+$/.test(kitNumber.trim())) filters.lotNumber = Number(kitNumber.trim())

      // Id-set constraints: aircraft always, component lot always, component
      // when it must be chunked.
      const idSets = []
      let note = null
      if (aircraftPinned || aircraftText.trim()) idSets.push(await lotIdsFromAircraft())

      if (componentLotText.trim()) {
        const cl = await componentLotLotIds(componentLotText.trim())
        idSets.push(cl.lotIds)
        // A prefix sweep must never read as an exact hit (D-KSTC-26).
        if (cl.rowCount && !cl.exactMatch) {
          note = `No exact component lot "${componentLotText.trim()}" — showing prefix matches.`
        }
      }

      let componentSkuIds = null
      if (componentPinned) componentSkuIds = (await componentRecall(componentPinned.id)).skuIds
      else if (componentText.trim()) {
        const comps = await searchComponents(componentText)
        const sets = await Promise.all(comps.map(c => componentRecall(c.id)))
        componentSkuIds = uniq(sets.flatMap(s => s.skuIds))
      }

      if (componentSkuIds) {
        if (idSets.length) {
          // Combined with another id-set — resolve the component down to lot ids
          // so the intersection is well defined.
          idSets.push(await lotIdsForSkus(componentSkuIds))
        } else {
          filters.skuIds = filters.skuIds
            ? filters.skuIds.filter(id => componentSkuIds.includes(id))
            : componentSkuIds
        }
      }

      if (idSets.length) {
        filters.lotIds = idSets.reduce((acc, set) => acc.filter(id => set.includes(id)))
      }

      setActive({ kind: 'filtered', filters, note })
    } catch (err) {
      console.error('Search failed:', err)
      setSearchError(err.message || 'Search failed.')
    } finally {
      setRunning(false)
    }
  }

  const openLot = (id) => push({ type: 'lot', id })
  const openSku = (id) => push({ type: 'sku', id })
  const openParty = (id) => push({ type: 'party', id })

  return (
    <div className="p-5 max-w-6xl mx-auto">
      <FieldGrid
        {...{
          customerText, setCustomerText, customerPinned, setCustomerPinned,
          kitText, setKitText, kitPinned, setKitPinned,
          kitNumber, setKitNumber, lotPreview,
          componentText, setComponentText, componentPinned, setComponentPinned,
          componentLotText, setComponentLotText,
          invoiceText, setInvoiceText, invoiceEcho,
          aircraftText, setAircraftText, aircraftPinned, setAircraftPinned,
          dateFrom, setDateFrom, dateTo, setDateTo,
        }}
        onSearch={runSearch}
        onClear={clearAll}
        running={running}
        openLot={openLot}
      />

      {searchError && <p className="text-amber-400 text-sm mb-4">{searchError}</p>}

      {running && <Spinner label="Searching…" />}

      {!running && !active && <GlobalDashboard onOpenLot={openLot} onOpenSku={openSku} />}

      {!running && active?.kind === 'filtered' && (
        <FilteredLens filters={active.filters} note={active.note}
          onOpenLot={openLot} onOpenSku={openSku} onOpenParty={openParty} />
      )}
      {!running && active?.kind === 'party' && (
        <PartyLens party={active.party} onOpenLot={openLot} onOpenSku={openSku} onPush={push} />
      )}
      {!running && active?.kind === 'sku' && (
        <SkuLens sku={active.sku} onOpenLot={openLot} onOpenParty={openParty} onPush={push} />
      )}
      {!running && active?.kind === 'component' && (
        <ComponentLens component={active.component} onPush={push} />
      )}
      {!running && active?.kind === 'invoice' && (
        <InvoiceLens invoiceNumber={active.invoiceNumber} onOpenLot={openLot} onOpenSku={openSku} onOpenParty={openParty} />
      )}
      {!running && active?.kind === 'componentLot' && (
        <ComponentLotLens lotText={active.lotText} onOpenLot={openLot} onOpenSku={openSku} onOpenParty={openParty} />
      )}
      {!running && active?.kind === 'aircraft' && (
        <div className="bg-gray-900">
          <h2 className="text-white text-lg font-semibold mb-4">
            {active.aircraft.serial_number || '—'} / {active.aircraft.registration || '—'}
          </h2>
          <AircraftBody id={active.aircraft.id} onPush={push} />
        </div>
      )}

      {stack.length > 0 && (
        <KitDrawer stack={stack} onPush={push} onPop={pop} onClose={closeDrawer} />
      )}
    </div>
  )
}

// Lot ids for a (possibly large) SKU id set.
async function lotIdsForSkus(skuIds) {
  const out = []
  for (let i = 0; i < skuIds.length; i += 100) {
    const { data } = await supabase.from('kit_lots').select('id').in('kit_sku_id', skuIds.slice(i, i + 100))
    out.push(...(data || []).map(r => r.id))
  }
  return uniq(out)
}

// ---------------------------------------------------------------------------
// Field grid
// ---------------------------------------------------------------------------

function FieldGrid(p) {
  return (
    <div className="bg-gray-800/60 border border-gray-700 rounded-2xl p-4 mb-6">
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <Typeahead
            label="Customer"
            value={p.customerText} onChange={p.setCustomerText}
            pinned={p.customerPinned} onPin={p.setCustomerPinned} onUnpin={() => { p.setCustomerPinned(null); p.setCustomerText('') }}
            fetcher={searchParties}
            placeholder="Name…"
            renderItem={(x, isPinned) => isPinned ? x.name : (
              <>
                <span className="block text-white text-sm">{x.name}</span>
                {x.fishbowl_customer_number && <span className="block text-gray-500 text-[11px]">Fishbowl {x.fishbowl_customer_number}</span>}
              </>
            )}
          />
        </div>

        <div>
          <Typeahead
            label="Kit"
            value={p.kitText} onChange={p.setKitText}
            pinned={p.kitPinned} onPin={p.setKitPinned} onUnpin={() => { p.setKitPinned(null); p.setKitText('') }}
            fetcher={searchSkus}
            placeholder="Kit part # or description…"
            renderItem={(x, isPinned) => isPinned ? x.part_number : (
              <>
                <span className="block font-mono text-white text-sm">{x.part_number}</span>
                {x.description && <span className="block text-gray-400 text-[11px] truncate">{x.description}</span>}
              </>
            )}
          />
        </div>

        <div>
          <label className="block text-gray-400 text-xs font-medium mb-1.5">Kit #</label>
          <input
            value={p.kitNumber} onChange={e => p.setKitNumber(e.target.value)}
            inputMode="numeric" placeholder="e.g. 99000"
            className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm font-mono placeholder-gray-500 focus:border-skynet-accent focus:outline-none"
          />
          {p.lotPreview && (
            <LinkText onClick={() => p.openLot(p.lotPreview.id)}>
              <span className="block text-xs mt-1.5">
                <span className="font-mono font-semibold">{lotLabel(p.lotPreview)}</span>
                {p.lotPreview.customer_as_written ? ` — ${p.lotPreview.customer_as_written}` : ''}
              </span>
            </LinkText>
          )}
          {!p.lotPreview && /^\d+$/.test(p.kitNumber.trim()) && (
            <p className="text-gray-500 text-xs mt-1.5">No lot with that number.</p>
          )}
        </div>

        <div>
          <Typeahead
            label="Component part #"
            value={p.componentText} onChange={p.setComponentText}
            pinned={p.componentPinned} onPin={p.setComponentPinned} onUnpin={() => { p.setComponentPinned(null); p.setComponentText('') }}
            fetcher={searchComponents}
            placeholder="Component part # or description…"
            renderItem={(x, isPinned) => isPinned ? x.part_number : (
              <>
                <span className="block font-mono text-white text-sm">{x.part_number}</span>
                {x.description && <span className="block text-gray-400 text-[11px] truncate">{x.description}</span>}
              </>
            )}
          />
        </div>

        <div>
          <label className="block text-gray-400 text-xs font-medium mb-1.5">Component Lot #</label>
          <input
            value={p.componentLotText} onChange={e => p.setComponentLotText(e.target.value)}
            placeholder="Shipped component lot #…"
            className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm font-mono placeholder-gray-500 focus:border-skynet-accent focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-gray-400 text-xs font-medium mb-1.5">Invoice #</label>
          <input
            value={p.invoiceText} onChange={e => p.setInvoiceText(e.target.value)}
            placeholder="Exact invoice number…"
            className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:border-skynet-accent focus:outline-none"
          />
          {p.invoiceEcho?.found && (
            <p className="text-green-400 text-xs mt-1.5">
              ✓ {p.invoiceEcho.partyName || 'Unknown customer'}
              {p.invoiceEcho.so_number ? ` — SO ${p.invoiceEcho.so_number}` : ''}
            </p>
          )}
          {p.invoiceEcho && !p.invoiceEcho.found && (
            <p className="text-gray-500 text-xs mt-1.5">Not found in Fishbowl window (pre-2025 invoices are normal).</p>
          )}
        </div>

        <div>
          <Typeahead
            label="Aircraft"
            value={p.aircraftText} onChange={p.setAircraftText}
            pinned={p.aircraftPinned} onPin={p.setAircraftPinned} onUnpin={() => { p.setAircraftPinned(null); p.setAircraftText('') }}
            fetcher={searchAircraft}
            placeholder="Serial or registration…"
            renderItem={(x, isPinned) => isPinned ? `${x.serial_number || '—'} / ${x.registration || '—'}` : (
              <>
                <span className="block font-mono text-white text-sm">{x.serial_number || '—'} / {x.registration || '—'}</span>
                <span className="block text-gray-500 text-[11px]">
                  {x.make_model || 'unknown type'}{x._viaHistory ? ' · matched a previous registration' : ''}
                </span>
              </>
            )}
          />
        </div>

        <div className="sm:col-span-2 lg:col-span-2">
          <label className="block text-gray-400 text-xs font-medium mb-1.5">Log date range</label>
          <div className="flex items-center gap-2">
            <input type="date" value={p.dateFrom} onChange={e => p.setDateFrom(e.target.value)}
              style={{ colorScheme: 'dark' }}
              className="flex-1 px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:border-skynet-accent focus:outline-none" />
            <span className="text-gray-500 text-sm">to</span>
            <input type="date" value={p.dateTo} onChange={e => p.setDateTo(e.target.value)}
              style={{ colorScheme: 'dark' }}
              className="flex-1 px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:border-skynet-accent focus:outline-none" />
          </div>
        </div>

        <div className="flex items-end gap-2">
          <button
            onClick={p.onSearch} disabled={p.running}
            className="flex-1 h-[42px] rounded-lg bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 text-white text-sm font-semibold flex items-center justify-center gap-2"
          >
            <SearchIcon size={16} /> Search
          </button>
          <button
            onClick={p.onClear}
            className="h-[42px] px-4 rounded-lg bg-gray-800 border border-gray-700 hover:bg-gray-700 text-gray-300 text-sm"
          >
            Clear
          </button>
        </div>
      </div>
      <p className="text-gray-500 text-xs mt-3">
        All fields optional and combined with AND. One entity on its own opens its dashboard; a kit # on
        its own opens that lot.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filtered lots lens
// ---------------------------------------------------------------------------

// `key` is the filter identity; changing it resets to page 0 and refetches.
function usePagedLots(filters, key) {
  const [page, setPage] = usePageReset(key)
  const { loading, data } = useAsyncData(() => loadLots(filters, page), `${key}::${page}`)
  return { rows: data?.rows || [], total: data?.total || 0, loading, page, setPage }
}

function FilteredLens({ filters, note, onOpenLot, onOpenSku, onOpenParty }) {
  const key = JSON.stringify(filters)
  const lots = usePagedLots(filters, key)
  const { data: stats } = useAsyncData(() => filteredLotStats(filters), key)

  return (
    <>
      {note && <PrefixNote>{note}</PrefixNote>}
      <Section title="Matching lots">
        {!stats ? <Spinner /> : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Total lots" value={stats.total} />
            <StatCard
              label="By book"
              value={stats.byBook.length || '—'}
              sub={stats.byBook.map(r => `${r.book.code} ${r.count}`).join(' · ') || 'none'}
            />
            <StatCard
              label="By status"
              value={stats.byStatus.active}
              sub={`active · ${stats.byStatus.void} void · ${stats.byStatus.no_entry} no entry`}
            />
            <StatCard
              label="SKU resolved"
              value={stats.skuResolvedPct == null ? '—' : `${stats.skuResolvedPct}%`}
              sub="lots with a matched kit SKU"
            />
          </div>
        )}
      </Section>

      <Section title="Lots" right={<Pager page={lots.page} total={lots.total} onPage={lots.setPage} />}>
        {lots.loading ? <Spinner /> : (
          <LotsTable rows={lots.rows} onOpenLot={onOpenLot} onOpenSku={onOpenSku} onOpenParty={onOpenParty}
            emptyText="No lots match these filters." />
        )}
      </Section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Customer lens
// ---------------------------------------------------------------------------

function PartyLens({ party, onOpenLot, onOpenSku, onPush }) {
  const lots = usePagedLots({ partyId: party.id }, party.id)
  const { data: lens } = useAsyncData(() => partyLens(party.id), party.id)

  return (
    <>
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-white text-lg font-semibold">{party.name}</h2>
        <LinkText onClick={() => onPush({ type: 'party', id: party.id, label: party.name })}>
          <span className="text-xs">open detail</span>
        </LinkText>
      </div>

      {!lens ? <Spinner /> : (
        <Section title="Overview">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Kit lots" value={lens.total} />
            <StatCard label="By book" value={lens.byBook.length || '—'}
              sub={lens.byBook.map(r => `${r.book.code} ${r.count}`).join(' · ') || 'none'} />
            <StatCard label="First / last logged" value={formatLogDate(lens.dates.first)}
              sub={`through ${formatLogDate(lens.dates.last)}`} />
            <StatCard label="Distinct kit SKUs" value={lens.distinctSkus} />
            <StatCard label="Sales orders" value={lens.salesCount} />
            <StatCard label="Open STC requests" value={lens.openRequests}
              sub="new / needs info / matched" />
            <StatCard
              label="STC coverage"
              value={lens.coverage.pct == null ? '—' : `${lens.coverage.pct}%`}
              sub={lens.coverage.denominator
                ? `${lens.coverage.numerator} of ${lens.coverage.denominator} conversion lots issued`
                : 'no conversion-book lots'}
            />
          </div>
        </Section>
      )}

      <Section title="Lots" right={<Pager page={lots.page} total={lots.total} onPage={lots.setPage} />}>
        {lots.loading ? <Spinner /> : (
          <LotsTable rows={lots.rows} onOpenLot={onOpenLot} onOpenSku={onOpenSku} />
        )}
      </Section>

      {lens && (
        <Section title={`Sales orders (${lens.sales.length})`}>
          {!lens.sales.length ? <Empty>No sales orders in the Fishbowl mirror.</Empty> : (
            <div className="overflow-x-auto rounded-xl border border-gray-700">
              <table className="w-full text-sm">
                <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">SO</th>
                    <th className="text-left px-3 py-2 font-medium">Customer PO</th>
                    <th className="text-left px-3 py-2 font-medium">Ordered</th>
                    <th className="text-left px-3 py-2 font-medium">Shipped</th>
                    <th className="text-left px-3 py-2 font-medium">Salesperson</th>
                  </tr>
                </thead>
                <tbody>
                  {lens.sales.map(s => (
                    <tr key={s.id} className="border-t border-gray-800">
                      <td className="px-3 py-2 font-mono text-gray-200">{s.so_number}</td>
                      <td className="px-3 py-2 text-gray-300">{s.customer_po || '—'}</td>
                      <td className="px-3 py-2 text-gray-300">{formatLogDate(s.order_date)}</td>
                      <td className="px-3 py-2 text-gray-300">{formatLogDate(s.ship_date)}</td>
                      <td className="px-3 py-2 text-gray-400">{s.salesperson || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Kit (SKU) lens
// ---------------------------------------------------------------------------

function SkuLens({ sku, onOpenLot, onOpenParty, onPush }) {
  const lots = usePagedLots({ skuId: sku.id }, sku.id)
  const { data: lens } = useAsyncData(() => skuLens(sku.id), sku.id)

  return (
    <>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h2 className="text-white text-lg font-semibold font-mono">{sku.part_number}</h2>
        <span className="text-gray-400 text-sm">{sku.description}</span>
        <LinkText onClick={() => onPush({ type: 'sku', id: sku.id, label: sku.part_number })}>
          <span className="text-xs">open detail</span>
        </LinkText>
      </div>

      {!lens ? <Spinner /> : (
        <Section title="Overview">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Total lots" value={lens.total} />
            <StatCard label="By book" value={lens.byBook.length || '—'}
              sub={lens.byBook.map(r => `${r.book.code} ${r.count}`).join(' · ') || 'none'} />
            <StatCard label="First / last logged" value={formatLogDate(lens.dates.first)}
              sub={`through ${formatLogDate(lens.dates.last)}`} />
            <StatCard label="BOM lines" value={lens.bomCount} />
            <StatCard label="Known installations" value={lens.installCount} />
          </div>
        </Section>
      )}

      <Section title="Lots" right={<Pager page={lots.page} total={lots.total} onPage={lots.setPage} />}>
        {lots.loading ? <Spinner /> : (
          <LotsTable rows={lots.rows} onOpenLot={onOpenLot} onOpenParty={onOpenParty} />
        )}
      </Section>

      {lens && (
        <Section title={`BOM components (${lens.bom.length})`}>
          {!lens.bom.length ? <Empty>No BOM lines recorded for this SKU.</Empty> : (
            <div className="overflow-x-auto rounded-xl border border-gray-700">
              <table className="w-full text-sm">
                <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">#</th>
                    <th className="text-left px-3 py-2 font-medium">Component</th>
                    <th className="text-left px-3 py-2 font-medium">Description</th>
                    <th className="text-right px-3 py-2 font-medium">Qty</th>
                    <th className="text-left px-3 py-2 font-medium">UoM</th>
                  </tr>
                </thead>
                <tbody>
                  {lens.bom.map(l => (
                    <tr key={l.id} className="border-t border-gray-800 hover:bg-gray-800/50">
                      <td className="px-3 py-2 text-gray-500">{l.line_number ?? '—'}</td>
                      <td className="px-3 py-2">
                        <LinkText onClick={() => onPush({ type: 'component', id: l.component_id, label: l.component?.part_number })}>
                          <span className="font-mono">{l.component?.part_number || '—'}</span>
                        </LinkText>
                      </td>
                      <td className="px-3 py-2 text-gray-300">{l.component?.description || '—'}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-200">{l.qty_per_kit}</td>
                      <td className="px-3 py-2 text-gray-400">{l.uom}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Component lens — the recall trio
// ---------------------------------------------------------------------------

function ComponentLens({ component, onPush }) {
  const { data } = useAsyncData(async () => {
    const r = await componentRecall(component.id)
    const rows = await skusByIds(r.skuIds)
    rows.sort((a, b) =>
      (r.lotCountBySku[b.id] || 0) - (r.lotCountBySku[a.id] || 0) ||
      (a.part_number || '').localeCompare(b.part_number || ''))
    return { recall: r, skus: rows }
  }, component.id)
  const recall = data?.recall || null
  const skus = data?.skus || null

  return (
    <>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h2 className="text-white text-lg font-semibold font-mono">{component.part_number}</h2>
        <span className="text-gray-400 text-sm">{component.description}</span>
        <LinkText onClick={() => onPush({ type: 'component', id: component.id, label: component.part_number })}>
          <span className="text-xs">open detail</span>
        </LinkText>
      </div>

      {!recall ? <Spinner label="Walking the recall chain…" /> : (
        <Section title="Recall reach">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatCard label="Kit SKUs containing it" value={recall.skuCount} />
            <StatCard label="Affected active lots" value={recall.activeLotCount} />
            <StatCard label="Known airframes" value={recall.airframeCount}
              sub="reachable through installations" />
          </div>
        </Section>
      )}

      <Section title={skus ? `Kit SKUs (${skus.length})` : 'Kit SKUs'}>
        {!skus ? <Spinner /> : !skus.length ? <Empty>No BOM references.</Empty> : (
          <div className="overflow-x-auto rounded-xl border border-gray-700 max-h-[32rem]">
            <table className="w-full text-sm">
              <thead className="bg-gray-800 text-gray-400 text-xs uppercase sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">SKU</th>
                  <th className="text-left px-3 py-2 font-medium">Description</th>
                  <th className="text-right px-3 py-2 font-medium">Lots</th>
                </tr>
              </thead>
              <tbody>
                {skus.map(s => (
                  <tr key={s.id} className="border-t border-gray-800 hover:bg-gray-800/50">
                    <td className="px-3 py-2">
                      <LinkText onClick={() => onPush({ type: 'sku', id: s.id, label: s.part_number })}>
                        <span className="font-mono">{s.part_number}</span>
                      </LinkText>
                    </td>
                    <td className="px-3 py-2 text-gray-300">{s.description || '—'}</td>
                    <td className="px-3 py-2 text-right font-mono text-gray-200">
                      {recall?.lotCountBySku[s.id] || 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Invoice lens
// ---------------------------------------------------------------------------

function InvoiceLens({ invoiceNumber, onOpenLot, onOpenSku, onOpenParty }) {
  const { data } = useAsyncData(() => invoiceLens(invoiceNumber), invoiceNumber)
  const lotIds = data?.lotIds || []
  const lots = usePagedLots({ lotIds }, `${invoiceNumber}::${lotIds.length}`)

  if (!data) return <Spinner />
  const inv = data.invoice

  return (
    <>
      <Section title="Invoice">
        {!inv?.found ? (
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
            <p className="text-gray-300">
              <span className="font-mono">{invoiceNumber}</span> is not in the Fishbowl window
              (pre-2025 invoices are normal).
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Invoice" value={inv.invoice_number} />
            <StatCard label="Customer" value={inv.partyName || '—'} />
            <StatCard label="Sales order" value={inv.so_number || '—'} />
            <StatCard label="First ship" value={formatLogDate(inv.first_ship_date)}
              sub={inv.salesperson ? `sold by ${inv.salesperson}` : null} />
          </div>
        )}
      </Section>

      <Section title="Lots referencing this invoice"
        right={<Pager page={lots.page} total={lots.total} onPage={lots.setPage} />}>
        {lots.loading ? <Spinner /> : (
          <LotsTable rows={lots.rows} onOpenLot={onOpenLot} onOpenSku={onOpenSku} onOpenParty={onOpenParty}
            emptyText="No kit lot references this invoice yet — transcribed rows are 2023–24 and the invoice window starts 2025-07-30." />
        )}
      </Section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Component lot lens
// ---------------------------------------------------------------------------

function PrefixNote({ children }) {
  return (
    <p className="text-amber-400 text-xs mb-3">{children}</p>
  )
}

function ComponentLotLens({ lotText, onOpenLot, onOpenSku, onOpenParty }) {
  const { data } = useAsyncData(() => componentLotLens(lotText), lotText)
  const lotIds = data?.lotIds || []
  // The id set is already ordered newest-kit-first; loadLots pages it as given.
  const lots = usePagedLots({ lotIds }, `${lotText}::${lotIds.length}`)

  if (!data) return <Spinner label="Tracing the component lot…" />

  const partsSub = data.byPart.map(g => `${g.part} — ${g.kits} kit${g.kits === 1 ? '' : 's'}`).join(' · ')

  return (
    <>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h2 className="text-white text-lg font-semibold font-mono">{lotText}</h2>
        <span className="text-gray-400 text-sm">shipped component lot</span>
      </div>

      {data.rows.length > 0 && !data.exactMatch && (
        <PrefixNote>
          No exact match — showing prefix matches on “{lotText}”.
        </PrefixNote>
      )}

      <Section title="Reach">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Kit lots" value={data.kitLotCount}
            sub="kits shipped containing this lot" />
          <StatCard label="Part numbers" value={data.byPart.length || '—'}
            sub={partsSub || 'none'} />
          <StatCard label="Shipped" value={formatLogDate(data.shipDates.first)}
            sub={`through ${formatLogDate(data.shipDates.last)}`} />
          <StatCard label="Total qty shipped" value={data.totalQty} />
        </div>
      </Section>

      <Section title="Kit lots" right={<Pager page={lots.page} total={lots.total} onPage={lots.setPage} />}>
        {lots.loading ? <Spinner /> : (
          <LotsTable rows={lots.rows} lotSub={data.subByLot}
            onOpenLot={onOpenLot} onOpenSku={onOpenSku} onOpenParty={onOpenParty}
            emptyText="No shipped component lot matches that number — the backfill covers lots whose SO resolves inside the Fishbowl export window." />
        )}
      </Section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Global dashboard (the empty state)
// ---------------------------------------------------------------------------

function GlobalDashboard({ onOpenLot, onOpenSku }) {
  const { data, error } = useAsyncData(() => loadGlobalDashboard(), 'global')
  const [open, setOpen] = useState(null)

  if (error) return <Empty>{error}</Empty>
  if (!data) return <Spinner label="Loading the registry dashboard…" />

  const { pulse, totals, queues } = data
  const q2Awaiting = queues.claimedUnresolved.filter(r => r.split === 'awaiting_transcription')
  const q2Unmatched = queues.claimedUnresolved.filter(r => r.split === 'unmatched')

  const toggle = (key) => setOpen(o => (o === key ? null : key))

  // When the queues are scoped to a baseline, every card says so — the screen
  // must never read as more complete than it is (D-KSTC-12).
  const sinceLabel = formatSince(data.exceptionsSince)
  const sinceSuffix = sinceLabel ? `since ${sinceLabel}` : null
  const withSince = (base) => {
    if (!sinceSuffix) return base || undefined
    return base ? `${base} · ${sinceSuffix}` : sinceSuffix
  }

  return (
    <>
      <Section title="Entry pulse">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Logged last 7 days" value={pulse.last7}
            sub={pulse.byBook.map(r => `${r.book.code} ${r.count}`).join(' · ') || 'nothing logged at the bench yet'} />
          <StatCard label="Logged last 30 days" value={pulse.last30} sub="SkyNet-native rows" />
        </div>
      </Section>

      <Section title="Registry totals">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {totals.map(t => (
            <StatCard key={t.book.id} label={t.book.code} value={t.all}
              sub={`${t.paper} transcribed · ${t.native} SkyNet`} />
          ))}
        </div>
      </Section>

      <Section title="Exception queues">
        {/* The headline number this module exists to burn down (D-KSTC-08). */}
        <button onClick={() => toggle('q5')} className="w-full text-left mb-3">
          <div className="rounded-xl border border-amber-600 bg-amber-900/25 p-4 hover:bg-amber-900/35 transition-colors">
            <div className="flex items-center gap-3">
              <AlertTriangle size={22} className="text-amber-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-amber-200 text-sm font-semibold">Conversion kits with no STC activity</p>
                <p className="text-amber-300/70 text-xs mt-0.5">
                  active conversion-book lots with no STC request and no installation
                  {' '}· of {queues.conversionTotal} conversion lots
                  {sinceSuffix ? ` · ${sinceSuffix}` : ''}
                </p>
              </div>
              <span className="font-mono font-bold text-amber-300 text-4xl">{queues.conversionNoStc.length}</span>
              {open === 'q5' ? <ChevronDown size={18} className="text-amber-400" /> : <ChevronRight size={18} className="text-amber-400" />}
            </div>
          </div>
        </button>
        {open === 'q5' && (
          <div className="mb-4">
            <ClientPagedLots rows={queues.conversionNoStc} onOpenLot={onOpenLot} onOpenSku={onOpenSku} />
          </div>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <QueueCard label="Requests with no aircraft serial" count={queues.noAircraftSerial.length}
            sub={withSince(null)}
            active={open === 'q1'} onClick={() => toggle('q1')} />
          <QueueCard label="Claimed kit # unresolved" count={queues.claimedUnresolved.length}
            sub={withSince(`${q2Awaiting.length} awaiting transcription · ${q2Unmatched.length} unmatched`)}
            active={open === 'q2'} onClick={() => toggle('q2')} />
          <QueueCard label="Active lots with no SKU" count={queues.lotsWithoutSku.length}
            sub={withSince(null)}
            active={open === 'q3'} onClick={() => toggle('q3')} />
          <QueueCard label="Referenced SKUs with no BOM" count={queues.skusWithoutBom.length}
            sub={withSince(null)}
            active={open === 'q4'} onClick={() => toggle('q4')} />
        </div>

        {open === 'q1' && <div className="mt-4"><RequestsTable rows={queues.noAircraftSerial} onOpenLot={onOpenLot} /></div>}
        {open === 'q2' && (
          <div className="mt-4 space-y-5">
            <div>
              <h4 className="text-gray-300 text-xs font-semibold uppercase tracking-wide mb-2">
                Awaiting transcription ({q2Awaiting.length}) — claimed number falls inside a seeded book range
              </h4>
              <RequestsTable rows={q2Awaiting} onOpenLot={onOpenLot} />
            </div>
            <div>
              <h4 className="text-gray-300 text-xs font-semibold uppercase tracking-wide mb-2">
                Unmatched ({q2Unmatched.length}) — outside every book range
              </h4>
              <RequestsTable rows={q2Unmatched} onOpenLot={onOpenLot} />
            </div>
          </div>
        )}
        {open === 'q3' && (
          <div className="mt-4">
            <ClientPagedLots rows={queues.lotsWithoutSku} onOpenLot={onOpenLot} onOpenSku={onOpenSku}
              emptyText="No active lot is missing a kit SKU. (The registry's one null-SKU row, RV 3931, is a void row — a struck-through book entry legitimately has no part.)" />
          </div>
        )}
        {open === 'q4' && (
          <div className="mt-4 overflow-x-auto rounded-xl border border-gray-700">
            <table className="w-full text-sm">
              <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">SKU</th>
                  <th className="text-left px-3 py-2 font-medium">Description</th>
                  <th className="text-left px-3 py-2 font-medium">STC applicability</th>
                </tr>
              </thead>
              <tbody>
                {queues.skusWithoutBom.map(s => (
                  <tr key={s.id} className="border-t border-gray-800 hover:bg-gray-800/50">
                    <td className="px-3 py-2">
                      <LinkText onClick={() => onOpenSku(s.id)}><span className="font-mono">{s.part_number}</span></LinkText>
                    </td>
                    <td className="px-3 py-2 text-gray-300">{s.description || '—'}</td>
                    <td className="px-3 py-2"><Pill>{s.stc_applicability}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  )
}

function QueueCard({ label, count, sub, active, onClick }) {
  return (
    <button onClick={onClick}
      className={`rounded-xl border p-4 text-left transition-colors ${
        active ? 'bg-gray-700 border-skynet-accent' : 'bg-gray-800 border-gray-700 hover:bg-gray-700'}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-gray-400 text-xs uppercase tracking-wide flex-1">{label}</p>
        {active ? <ChevronDown size={16} className="text-gray-400 shrink-0" /> : <ChevronRight size={16} className="text-gray-500 shrink-0" />}
      </div>
      <p className="text-white font-mono font-bold text-2xl mt-1">{count}</p>
      {sub && <p className="text-gray-400 text-xs mt-1">{sub}</p>}
    </button>
  )
}

// Queue tables already hold every row, so page them client-side.
function ClientPagedLots({ rows, onOpenLot, onOpenSku, emptyText }) {
  const [page, setPage] = usePageReset(rows)
  const slice = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
  return (
    <>
      <div className="flex justify-end mb-2"><Pager page={page} total={rows.length} onPage={setPage} /></div>
      <LotsTable rows={slice} onOpenLot={onOpenLot} onOpenSku={onOpenSku} emptyText={emptyText || 'Queue is clear.'} />
    </>
  )
}

function RequestsTable({ rows, onOpenLot }) {
  if (!rows.length) return <Empty>Queue is clear.</Empty>
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-700">
      <table className="w-full text-sm">
        <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Intake</th>
            <th className="text-left px-3 py-2 font-medium">Received</th>
            <th className="text-left px-3 py-2 font-medium">Requester</th>
            <th className="text-left px-3 py-2 font-medium">Claimed kit #</th>
            <th className="text-left px-3 py-2 font-medium">Claimed reg / serial</th>
            <th className="text-left px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className="border-t border-gray-800 hover:bg-gray-800/50">
              <td className="px-3 py-2 font-mono text-gray-200">#{r.intake_number}</td>
              <td className="px-3 py-2 text-gray-300 whitespace-nowrap">{formatLogDate(r.received_date)}</td>
              <td className="px-3 py-2 text-gray-300">
                {r.requester_name || '—'}
                {r.requester_company && <span className="block text-gray-500 text-[11px]">{r.requester_company}</span>}
              </td>
              <td className="px-3 py-2 font-mono text-gray-300">
                {r.claimed_kit_number || '—'}
                {r.kit_lot_id && (
                  <LinkText onClick={() => onOpenLot(r.kit_lot_id)}>
                    <span className="block text-[11px]">→ resolved lot</span>
                  </LinkText>
                )}
              </td>
              <td className="px-3 py-2 text-gray-300">
                {r.claimed_registration || '—'} / {r.claimed_aircraft_serial || '—'}
              </td>
              <td className="px-3 py-2"><Pill tone={r.status === 'issued' ? 'green' : 'amber'}>{r.status}</Pill></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
