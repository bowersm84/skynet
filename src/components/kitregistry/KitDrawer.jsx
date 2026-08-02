import { useState } from 'react'
import { X, ChevronLeft, ExternalLink, Paperclip, Loader2 } from 'lucide-react'
import {
  lotDetail, skuDetail, partyDetail, componentDetail, aircraftLens, loadLots,
  formatLogDate, lotLabel,
} from '../../lib/kitRegistry'
import { stcRequestDetail, STATUS_LABEL, DOCUMENT_TYPES } from '../../lib/stcIntake'
import { getDocumentUrl } from '../../lib/s3'
import {
  StatusBadge, ConfidenceBadge, SourceBadge, Pill, Spinner, Empty, LinkText, LotsTable, Pager,
} from './ui'
import { useAsyncData, usePageReset } from './hooks'

// One drawer component for every entity. Navigation is a breadcrumb STACK —
// opening a reference from inside a drawer pushes; Back pops. Keeps deep
// provenance walks (lot → aircraft → installation → lot) from losing the thread.

export default function KitDrawer({ stack, onPush, onPop, onClose }) {
  const top = stack[stack.length - 1]
  if (!top) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative w-full max-w-3xl bg-gray-900 border-l border-gray-700 h-full overflow-y-auto">
        <div className="sticky top-0 z-10 bg-gray-800 border-b border-gray-700 px-5 py-3 flex items-center gap-3">
          {stack.length > 1 && (
            <button onClick={onPop} className="text-gray-400 hover:text-white" title="Back">
              <ChevronLeft size={20} />
            </button>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-gray-500 text-[11px] uppercase tracking-wide">{TITLES[top.type]}</p>
            <p className="text-white font-semibold truncate">{top.label || '…'}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X size={20} /></button>
        </div>
        <div className="p-5">
          {top.type === 'lot' && <LotBody id={top.id} onPush={onPush} />}
          {top.type === 'sku' && <SkuBody id={top.id} onPush={onPush} />}
          {top.type === 'party' && <PartyBody id={top.id} onPush={onPush} />}
          {top.type === 'component' && <ComponentBody id={top.id} onPush={onPush} />}
          {top.type === 'aircraft' && <AircraftBody id={top.id} onPush={onPush} />}
          {top.type === 'request' && <RequestBody id={top.id} onPush={onPush} />}
        </div>
      </div>
    </div>
  )
}

const TITLES = {
  lot: 'Kit lot', sku: 'Kit SKU', party: 'Customer', component: 'Component', aircraft: 'Aircraft',
  request: 'STC request',
}

// Lots list inside a drawer body — server-paged, resets when the entity changes.
function useDrawerLots(filters, key) {
  const [page, setPage] = usePageReset(key)
  const { loading, data } = useAsyncData(() => loadLots(filters, page), `${key}::${page}`)
  return { rows: data?.rows || [], total: data?.total || 0, loading, page, setPage }
}

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-3 py-1.5 border-b border-gray-800 last:border-0">
      <dt className="text-gray-500 text-xs uppercase tracking-wide pt-0.5">{label}</dt>
      <dd className="text-gray-200 text-sm min-w-0">{children ?? <span className="text-gray-600">—</span>}</dd>
    </div>
  )
}

function Block({ title, children }) {
  return (
    <div className="mb-6">
      <h4 className="text-gray-300 text-xs font-semibold uppercase tracking-wide mb-2">{title}</h4>
      {children}
    </div>
  )
}

// --- Lot --------------------------------------------------------------------

function LotBody({ id, onPush }) {
  const { loading, data, error } = useAsyncData(() => lotDetail(id), id)
  if (loading) return <Spinner />
  if (error) return <Empty>{error}</Empty>
  if (!data) return <Empty>Lot not found.</Empty>
  const { lot, saleLine, sale, invoices, requests, installations, issuances } = data

  return (
    <>
      <div className="flex flex-wrap gap-2 mb-4">
        <StatusBadge status={lot.record_status} />
        <SourceBadge source={lot.source} />
        <ConfidenceBadge level={lot.transcription_confidence} />
        {lot.book?.category && <Pill tone="blue">{lot.book.category}</Pill>}
      </div>

      <Block title="Provenance — as written in the book">
        <dl>
          <Row label="Kit part">
            <span>{lot.kit_part_as_written || <span className="text-gray-600">—</span>}</span>
            {lot.sku && (
              <LinkText onClick={() => onPush({ type: 'sku', id: lot.kit_sku_id, label: lot.sku.part_number })}>
                <span className="block text-xs font-mono mt-0.5">→ {lot.sku.part_number}</span>
              </LinkText>
            )}
            {!lot.kit_sku_id && lot.kit_part_as_written && (
              <span className="block text-xs text-gray-500 mt-0.5">unresolved — office will resolve</span>
            )}
          </Row>
          <Row label="Customer">
            <span>{lot.customer_as_written || <span className="text-gray-600">—</span>}</span>
            {lot.party && (
              <LinkText onClick={() => onPush({ type: 'party', id: lot.party_id, label: lot.party.name })}>
                <span className="block text-xs mt-0.5">→ {lot.party.name}</span>
              </LinkText>
            )}
          </Row>
          <Row label="Invoice">{lot.invoice_as_written}</Row>
          <Row label="Sales order">{lot.so_as_written}</Row>
          <Row label="Log date">{formatLogDate(lot.log_date)}</Row>
          <Row label="Stud #">{lot.stud_number}</Row>
          <Row label="Rec / platemount #">{lot.rec_platemount_number}</Row>
          <Row label="Source page">{lot.source_page}</Row>
          <Row label="Transcription notes">{lot.transcription_notes}</Row>
          <Row label="Notes">{lot.notes}</Row>
        </dl>
      </Block>

      <Block title="Sale line / order">
        {!saleLine ? <Empty>No sale line linked.</Empty> : (
          <dl>
            <Row label="SO">{sale?.so_number}</Row>
            <Row label="Customer PO">{sale?.customer_po}</Row>
            <Row label="Ordered / shipped">{`${saleLine.qty_ordered ?? '—'} / ${saleLine.qty_shipped ?? '—'}`}</Row>
            <Row label="Invoices">
              {invoices.length
                ? invoices.map(i => i.invoice_number).join(', ')
                : (saleLine.invoice_numbers || null)}
            </Row>
          </dl>
        )}
      </Block>

      <Block title={`STC requests (${requests.length})`}>
        {!requests.length ? <Empty>No STC request references this lot.</Empty> : (
          <div className="space-y-2">
            {requests.map(r => (
              <div key={r.id} className="bg-gray-800 border border-gray-700 rounded-lg p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-white">intake #{r.intake_number}</span>
                  <Pill tone={r.status === 'issued' ? 'green' : 'amber'}>{r.status}</Pill>
                  <span className="text-gray-400 text-xs">{formatLogDate(r.received_date)}</span>
                </div>
                <p className="text-gray-300 text-sm mt-1">
                  {r.requester_name || '—'}{r.requester_company ? ` · ${r.requester_company}` : ''}
                </p>
                <p className="text-gray-500 text-xs mt-1">
                  claimed kit {r.claimed_kit_number || '—'} · reg {r.claimed_registration || '—'} · serial {r.claimed_aircraft_serial || '—'}
                </p>
                {r.aircraft && (
                  <LinkText onClick={() => onPush({ type: 'aircraft', id: r.aircraft_id, label: r.aircraft.registration || r.aircraft.serial_number })}>
                    <span className="text-xs">→ {r.aircraft.serial_number} / {r.aircraft.registration}</span>
                  </LinkText>
                )}
                {r.notes && <p className="text-gray-400 text-xs mt-1 whitespace-pre-wrap">{r.notes}</p>}
              </div>
            ))}
          </div>
        )}
      </Block>

      <Block title={`Installations (${installations.length})`}>
        {!installations.length ? <Empty>No installation recorded for this lot.</Empty> : (
          <div className="space-y-2">
            {installations.map(i => (
              <div key={i.id} className="bg-gray-800 border border-gray-700 rounded-lg p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <Pill tone={i.status === 'verified' ? 'green' : 'amber'}>{i.status}</Pill>
                  <span className="text-gray-400 text-xs">{formatLogDate(i.install_date)}</span>
                </div>
                {i.aircraft && (
                  <LinkText onClick={() => onPush({ type: 'aircraft', id: i.aircraft_id, label: i.aircraft.registration || i.aircraft.serial_number })}>
                    <span className="block font-mono text-sm mt-1">
                      {i.aircraft.serial_number || '—'} / {i.aircraft.registration || '—'}
                    </span>
                  </LinkText>
                )}
                {i.evidence && <p className="text-gray-400 text-xs mt-1">evidence: {i.evidence}</p>}
                {i.notes && <p className="text-gray-400 text-xs mt-1">{i.notes}</p>}
              </div>
            ))}
          </div>
        )}
      </Block>

      <Block title={`STC issuances (${issuances.length})`}>
        {!issuances.length ? (
          <Empty>
            No issuance recorded. Issuance is derived through installations, never a column (D-KSTC-01).
          </Empty>
        ) : (
          <div className="space-y-2">
            {issuances.map(s => (
              <div key={s.id} className="bg-gray-800 border border-gray-700 rounded-lg p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-white">{s.certificate?.stc_number || '—'}</span>
                  {s.doc_version && <Pill>{s.doc_version}</Pill>}
                  {s.is_voided && <Pill tone="amber">voided</Pill>}
                </div>
                <p className="text-gray-400 text-xs mt-1">
                  sent {formatLogDate(s.sent_date)}{s.sent_to_name ? ` to ${s.sent_to_name}` : ''}{s.method ? ` · ${s.method}` : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </Block>
    </>
  )
}

// --- SKU --------------------------------------------------------------------

function SkuBody({ id, onPush }) {
  const { loading, data, error } = useAsyncData(() => skuDetail(id), id)
  const lots = useDrawerLots({ skuId: id }, id)

  if (loading) return <Spinner />
  if (error) return <Empty>{error}</Empty>
  if (!data?.sku) return <Empty>SKU not found.</Empty>
  const { sku, bom, byBook, installCount } = data

  return (
    <>
      <div className="flex flex-wrap gap-2 mb-4">
        <Pill tone="blue">scope: {sku.kit_scope}</Pill>
        <Pill tone={sku.stc_applicability === 'stc_bearing' ? 'green' : 'amber'}>
          STC: {sku.stc_applicability}
        </Pill>
        {!sku.is_active && <Pill tone="amber">inactive</Pill>}
      </div>
      <Block title="Detail">
        <dl>
          <Row label="Part number"><span className="font-mono">{sku.part_number}</span></Row>
          <Row label="Description">{sku.description}</Row>
          <Row label="Lots">{lots.total}</Row>
          <Row label="By book">{byBook.map(r => `${r.book.code} ${r.count}`).join(' · ') || null}</Row>
          <Row label="Known installations">{installCount}</Row>
          <Row label="Notes">{sku.notes}</Row>
        </dl>
      </Block>

      <Block title={`BOM (${bom.length} lines)`}>
        {!bom.length ? <Empty>No BOM lines — this SKU is in exception queue 4.</Empty> : (
          <div className="overflow-x-auto rounded-lg border border-gray-700">
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
                {bom.map(l => (
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
      </Block>

      <Block title="Lots">
        <div className="flex justify-end mb-2"><Pager page={lots.page} total={lots.total} onPage={lots.setPage} /></div>
        <LotsTable
          rows={lots.rows}
          onOpenLot={(lotId) => onPush({ type: 'lot', id: lotId })}
          onOpenParty={(pid) => onPush({ type: 'party', id: pid })}
        />
      </Block>
    </>
  )
}

// --- Party ------------------------------------------------------------------

function PartyBody({ id, onPush }) {
  const { loading, data, error } = useAsyncData(() => partyDetail(id), id)
  const lots = useDrawerLots({ partyId: id }, id)

  if (loading) return <Spinner />
  if (error) return <Empty>{error}</Empty>
  if (!data?.party) return <Empty>Customer not found.</Empty>
  const { party, sales } = data

  return (
    <>
      <Block title="Detail">
        <dl>
          <Row label="Name">{party.name}</Row>
          <Row label="Normalized"><span className="font-mono text-xs">{party.normalized_name}</span></Row>
          <Row label="Fishbowl #">{party.fishbowl_customer_number}</Row>
          <Row label="Country">{party.country}</Row>
          <Row label="Distributor">{party.is_distributor ? 'Yes' : 'No'}</Row>
          <Row label="Kit lots">{lots.total}</Row>
          <Row label="Notes">{party.notes}</Row>
        </dl>
      </Block>

      <Block title={`Sales orders (${sales.length})`}>
        {!sales.length ? <Empty>No sales orders in the Fishbowl mirror.</Empty> : (
          <div className="overflow-x-auto rounded-lg border border-gray-700">
            <table className="w-full text-sm">
              <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">SO</th>
                  <th className="text-left px-3 py-2 font-medium">PO</th>
                  <th className="text-left px-3 py-2 font-medium">Ordered</th>
                  <th className="text-left px-3 py-2 font-medium">Shipped</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {sales.map(s => (
                  <tr key={s.id} className="border-t border-gray-800">
                    <td className="px-3 py-2 font-mono text-gray-200">{s.so_number}</td>
                    <td className="px-3 py-2 text-gray-300">{s.customer_po || '—'}</td>
                    <td className="px-3 py-2 text-gray-300">{formatLogDate(s.order_date)}</td>
                    <td className="px-3 py-2 text-gray-300">{formatLogDate(s.ship_date)}</td>
                    <td className="px-3 py-2 text-gray-400">{s.so_status || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>

      <Block title="Lots">
        <div className="flex justify-end mb-2"><Pager page={lots.page} total={lots.total} onPage={lots.setPage} /></div>
        <LotsTable
          rows={lots.rows}
          onOpenLot={(lotId) => onPush({ type: 'lot', id: lotId })}
          onOpenSku={(sid) => onPush({ type: 'sku', id: sid })}
        />
      </Block>
    </>
  )
}

// --- Component --------------------------------------------------------------

function ComponentBody({ id, onPush }) {
  const { loading, data, error } = useAsyncData(() => componentDetail(id), id)
  if (loading) return <Spinner />
  if (error) return <Empty>{error}</Empty>
  if (!data?.component) return <Empty>Component not found.</Empty>
  const { component, mesPart, skus } = data

  return (
    <>
      <Block title="Detail">
        <dl>
          <Row label="Part number"><span className="font-mono">{component.part_number}</span></Row>
          <Row label="Description">{component.description}</Row>
          <Row label="MES part">
            {mesPart ? (
              <span className="flex items-center gap-2">
                <span className="font-mono">{mesPart.part_number}</span>
                <ExternalLink size={12} className="text-gray-500" />
                <span className="text-gray-400 text-xs">{mesPart.part_type}</span>
              </span>
            ) : <span className="text-gray-600">not linked to public.parts</span>}
          </Row>
          <Row label="Used in SKUs">{skus.length}</Row>
        </dl>
      </Block>

      <Block title={`Kit SKUs containing this component (${skus.length})`}>
        {!skus.length ? <Empty>No BOM references.</Empty> : (
          <div className="overflow-x-auto rounded-lg border border-gray-700 max-h-96">
            <table className="w-full text-sm">
              <thead className="bg-gray-800 text-gray-400 text-xs uppercase sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">SKU</th>
                  <th className="text-left px-3 py-2 font-medium">Description</th>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>
    </>
  )
}

// --- STC request ------------------------------------------------------------

const DOC_TYPE_LABEL = Object.fromEntries(DOCUMENT_TYPES.map(d => [d.value, d.label]))

// Signed URLs expire (1h), so one is minted on click rather than at render —
// a drawer left open all afternoon would otherwise hand out dead links.
function DocumentLink({ doc }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const open = async () => {
    setBusy(true)
    setError(null)
    try {
      const url = await getDocumentUrl(doc.file_path)
      if (!url) throw new Error('No file path recorded.')
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      console.error('Could not open kit-STC document:', err)
      setError('Could not open this file.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-start gap-3 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
      <Paperclip size={14} className="text-gray-500 shrink-0 mt-1" />
      <div className="min-w-0 flex-1">
        <LinkText onClick={open}>
          <span className="text-sm break-all">{doc.file_name}</span>
        </LinkText>
        <p className="text-gray-500 text-[11px]">
          {DOC_TYPE_LABEL[doc.document_type] || doc.document_type}
          {doc.file_size ? ` · ${(doc.file_size / 1024).toFixed(0)} KB` : ''}
          {doc.uploaded_at ? ` · ${formatLogDate(String(doc.uploaded_at).slice(0, 10))}` : ''}
        </p>
        {error && <p className="text-red-400 text-[11px] mt-0.5">{error}</p>}
      </div>
      {busy && <Loader2 size={14} className="animate-spin text-gray-500 shrink-0 mt-1" />}
    </div>
  )
}

// Claims sit beside what they resolved to, never instead of them: the customer's
// words are the audit record and stay visible even once the office has bound
// the request to a real lot or airframe (D-KSTC-07).
function ClaimRow({ label, claim, resolved }) {
  return (
    <Row label={label}>
      <span>{claim || <span className="text-gray-600">—</span>}</span>
      {resolved}
    </Row>
  )
}

export function RequestBody({ id, onPush }) {
  const { loading, data, error } = useAsyncData(() => stcRequestDetail(id), id)
  if (loading) return <Spinner />
  if (error) return <Empty>{error}</Empty>
  if (!data) return <Empty>Request not found.</Empty>
  const { request: r, lot, aircraft, installation, requesterParty, purchasedFromParty, documents, author } = data

  return (
    <>
      <div className="flex flex-wrap gap-2 mb-4">
        <Pill tone={r.status === 'issued' ? 'green' : r.status === 'unidentifiable' ? 'amber' : 'blue'}>
          {STATUS_LABEL[r.status] || r.status}
        </Pill>
        <Pill>{r.channel}</Pill>
        <Pill>received {formatLogDate(r.received_date)}</Pill>
      </div>

      <Block title="Requester">
        <dl>
          <Row label="Name">{r.requester_name}</Row>
          <Row label="Company">
            <span>{r.requester_company || <span className="text-gray-600">—</span>}</span>
            {requesterParty && (
              <LinkText onClick={() => onPush({ type: 'party', id: requesterParty.id, label: requesterParty.name })}>
                <span className="block text-xs mt-0.5">→ {requesterParty.name}</span>
              </LinkText>
            )}
          </Row>
          <Row label="Email">{r.requester_email}</Row>
          <Row label="Purchased from">
            <span>{r.purchased_from_text || <span className="text-gray-600">—</span>}</span>
            {purchasedFromParty && (
              <LinkText onClick={() => onPush({ type: 'party', id: purchasedFromParty.id, label: purchasedFromParty.name })}>
                <span className="block text-xs mt-0.5">→ {purchasedFromParty.name}</span>
              </LinkText>
            )}
          </Row>
        </dl>
      </Block>

      <Block title="Claimed — as the customer wrote it">
        <dl>
          <ClaimRow
            label="Kit #"
            claim={<span className="font-mono">{r.claimed_kit_number}</span>}
            resolved={lot && (
              <LinkText onClick={() => onPush({ type: 'lot', id: lot.id, label: lotLabel(lot) })}>
                <span className="block text-xs font-mono mt-0.5">
                  → {lotLabel(lot)}{lot.customer_as_written ? ` — ${lot.customer_as_written}` : ''}
                </span>
              </LinkText>
            )}
          />
          <ClaimRow label="Kit part" claim={r.claimed_kit_part} />
          <ClaimRow
            label="Aircraft serial"
            claim={<span className="font-mono">{r.claimed_aircraft_serial}</span>}
            resolved={aircraft && (
              <LinkText onClick={() => onPush({ type: 'aircraft', id: aircraft.id, label: aircraft.registration || aircraft.serial_number })}>
                <span className="block text-xs font-mono mt-0.5">→ {aircraft.serial_number || '—'}</span>
              </LinkText>
            )}
          />
          <ClaimRow
            label="Registration"
            claim={<span className="font-mono">{r.claimed_registration}</span>}
            resolved={aircraft && (
              <span className="block text-xs font-mono text-gray-400 mt-0.5">
                → {aircraft.registration || '—'}{aircraft.make_model ? ` · ${aircraft.make_model}` : ''}
              </span>
            )}
          />
          <ClaimRow label="Order #" claim={<span className="font-mono">{r.claimed_order_number}</span>} />
        </dl>
        {!lot && !aircraft && (
          <p className="text-gray-500 text-xs mt-2">
            Nothing resolved yet — claims stay as written until the office binds them.
          </p>
        )}
      </Block>

      {installation && (
        <Block title="Installation">
          <dl>
            <Row label="Status"><Pill tone={installation.status === 'verified' ? 'green' : 'amber'}>{installation.status}</Pill></Row>
            <Row label="Install date">{formatLogDate(installation.install_date)}</Row>
            <Row label="Evidence">{installation.evidence}</Row>
          </dl>
        </Block>
      )}

      <Block title="Notes">
        {r.notes
          ? <p className="text-gray-300 text-sm whitespace-pre-wrap">{r.notes}</p>
          : <Empty>No notes.</Empty>}
      </Block>

      <Block title={`Documents (${documents.length})`}>
        {!documents.length ? <Empty>No files attached to this intake.</Empty> : (
          <div className="space-y-2">
            {documents.map(d => <DocumentLink key={d.id} doc={d} />)}
          </div>
        )}
      </Block>

      <Block title="Record">
        <dl>
          <Row label="Intake #"><span className="font-mono">{r.intake_number}</span></Row>
          <Row label="Logged by">{author?.full_name || author?.username}</Row>
          <Row label="Logged at">{r.created_at ? new Date(r.created_at).toLocaleString() : null}</Row>
        </dl>
      </Block>
    </>
  )
}

// --- Aircraft ---------------------------------------------------------------

export function AircraftBody({ id, onPush }) {
  const { loading, data, error } = useAsyncData(() => aircraftLens(id), id)
  if (loading) return <Spinner />
  if (error) return <Empty>{error}</Empty>
  if (!data?.aircraft) return <Empty>Aircraft not found.</Empty>
  const { aircraft, history, installations, requests } = data

  return (
    <>
      <Block title="Airframe">
        <dl>
          <Row label="Serial"><span className="font-mono">{aircraft.serial_number}</span></Row>
          <Row label="Registration"><span className="font-mono">{aircraft.registration}</span></Row>
          <Row label="Make / model">{aircraft.make_model}</Row>
          <Row label="Country">{aircraft.country}</Row>
          <Row label="Notes">{aircraft.notes}</Row>
        </dl>
      </Block>

      <Block title={`Registration history (${history.length})`}>
        {!history.length ? <Empty>No registration history recorded.</Empty> : (
          <div className="space-y-1.5">
            {history.map(h => (
              <div key={h.id} className="flex items-center gap-3 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
                <span className="font-mono text-white text-sm">{h.registration}</span>
                <span className="text-gray-400 text-xs">{formatLogDate(h.observed_date)}</span>
                {h.source && <span className="text-gray-500 text-xs">{h.source}</span>}
              </div>
            ))}
          </div>
        )}
      </Block>

      <Block title={`Installations (${installations.length})`}>
        {!installations.length ? <Empty>No installations recorded.</Empty> : (
          <div className="space-y-2">
            {installations.map(i => (
              <div key={i.id} className="bg-gray-800 border border-gray-700 rounded-lg p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <Pill tone={i.status === 'verified' ? 'green' : 'amber'}>{i.status}</Pill>
                  <span className="text-gray-400 text-xs">{formatLogDate(i.install_date)}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {i.lot ? (
                    <LinkText onClick={() => onPush({ type: 'lot', id: i.kit_lot_id, label: lotLabel(i.lot) })}>
                      <span className="font-mono">{lotLabel(i.lot)}</span>
                    </LinkText>
                  ) : (
                    // NULLABLE by design — an install can be evidenced with no
                    // recoverable lot (D-KSTC-01).
                    <span className="text-gray-500 text-xs">no lot recovered</span>
                  )}
                  {i.sku && (
                    <LinkText onClick={() => onPush({ type: 'sku', id: i.kit_sku_id, label: i.sku.part_number })}>
                      <span className="font-mono text-xs">{i.sku.part_number}</span>
                    </LinkText>
                  )}
                </div>
                {i.evidence && <p className="text-gray-400 text-xs mt-1">evidence: {i.evidence}</p>}
              </div>
            ))}
          </div>
        )}
      </Block>

      <Block title={`STC requests (${requests.length})`}>
        {!requests.length ? <Empty>No STC requests resolved to this airframe.</Empty> : (
          <div className="space-y-2">
            {requests.map(r => (
              <div key={r.id} className="bg-gray-800 border border-gray-700 rounded-lg p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-white">intake #{r.intake_number}</span>
                  <Pill tone={r.status === 'issued' ? 'green' : 'amber'}>{r.status}</Pill>
                  <span className="text-gray-400 text-xs">{formatLogDate(r.received_date)}</span>
                </div>
                <p className="text-gray-300 text-sm mt-1">
                  {r.requester_name || '—'}{r.requester_company ? ` · ${r.requester_company}` : ''}
                </p>
                {r.kit_lot_id && (
                  <LinkText onClick={() => onPush({ type: 'lot', id: r.kit_lot_id })}>
                    <span className="text-xs">→ resolved lot</span>
                  </LinkText>
                )}
              </div>
            ))}
          </div>
        )}
      </Block>
    </>
  )
}
