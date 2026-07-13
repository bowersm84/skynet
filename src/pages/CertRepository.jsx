import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Search, FileText, Link2, Upload, Trash2, Check, ChevronRight, ChevronDown,
  Package, Cpu, Loader2, Plus, X, ArrowRight, GitBranch, ShieldCheck, ExternalLink,
  ClipboardList,
} from 'lucide-react'
import { hasRole } from '../lib/roles'
import { getDocumentUrl } from '../lib/s3'
import {
  searchWorkOrders,
  getWorkOrderTraceability,
  computeCertStatus,
  searchLot,
  getComponentLotsForPart,
  createComponentLot,
  linkLotToWorkOrder,
  unlinkLotFromWorkOrder,
  uploadLotDocument,
  deleteLotDocument,
  findJobByLotNumber,
  linkJobToWorkOrder,
  unlinkJobFromWorkOrder,
} from '../lib/certRepository'

// component_lot_documents.document_type CHECK values + labels
const DOC_TYPES = [
  { value: 'packing_slip', label: 'Packing Slip' },
  { value: 'coc', label: 'C of C' },
  { value: 'material_cert', label: 'Material Cert' },
  { value: 'test_report', label: 'Test Report' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'other', label: 'Other' },
]
const docTypeLabel = (v) => DOC_TYPES.find((d) => d.value === v)?.label || v

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—')

// Open an S3-backed document via a signed URL (matches the app-wide pattern).
async function openDoc(filePath) {
  if (!filePath) return
  try {
    const url = await getDocumentUrl(filePath)
    if (url) window.open(url, '_blank')
  } catch (err) {
    console.error('Failed to open document:', err)
    alert('Could not open document.')
  }
}

export default function CertRepository({ profile }) {
  const canWrite = hasRole(profile, 'admin', 'compliance')
  const [view, setView] = useState('wo') // 'wo' | 'lot'

  return (
    <div className="max-w-7xl mx-auto pb-24">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <ShieldCheck size={24} className="text-skynet-accent" />
            Cert Repository
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Traceability &amp; certification records — chain of custody by work order and by lot.
            {!canWrite && <span className="ml-1 text-gray-600">(read-only)</span>}
          </p>
        </div>
        <div className="flex rounded-lg overflow-hidden border border-gray-700">
          <button
            onClick={() => setView('wo')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${view === 'wo' ? 'bg-skynet-accent text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
          >
            Work Order
          </button>
          <button
            onClick={() => setView('lot')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${view === 'lot' ? 'bg-skynet-accent text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
          >
            Lot Search
          </button>
        </div>
      </div>

      {view === 'wo'
        ? <WorkOrderView canWrite={canWrite} profile={profile} />
        : <LotSearchView canWrite={canWrite} profile={profile} />}
    </div>
  )
}

// ===========================================================================
// WO VIEW
// ===========================================================================
function WorkOrderView({ canWrite, profile, initialWoId }) {
  const [term, setTerm] = useState('')
  const [results, setResults] = useState(null) // null = not searched yet
  const [searching, setSearching] = useState(false)
  const [selectedWoId, setSelectedWoId] = useState(initialWoId || null)
  const [trace, setTrace] = useState(null)
  const [loadingTrace, setLoadingTrace] = useState(false)

  const runSearch = async (e) => {
    e?.preventDefault()
    if (!term.trim()) return
    setSearching(true)
    try {
      const rows = await searchWorkOrders(term)
      setResults(rows)
      // auto-select a single exact-ish hit
      if (rows.length === 1) loadWO(rows[0].id)
    } finally {
      setSearching(false)
    }
  }

  const loadWO = useCallback(async (woId) => {
    setSelectedWoId(woId)
    setLoadingTrace(true)
    try {
      const data = await getWorkOrderTraceability(woId)
      setTrace(data)
    } finally {
      setLoadingTrace(false)
    }
  }, [])

  const refreshTrace = useCallback(() => {
    if (selectedWoId) loadWO(selectedWoId)
  }, [selectedWoId, loadWO])

  useEffect(() => {
    if (initialWoId) loadWO(initialWoId)
  }, [initialWoId, loadWO])

  return (
    <div className="space-y-5">
      <form onSubmit={runSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search by WO number or part number (includes closed WOs)…"
            className="w-full pl-9 pr-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-skynet-accent"
          />
        </div>
        <button type="submit" disabled={searching || !term.trim()} className="px-5 py-2.5 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white text-sm font-medium rounded-lg flex items-center gap-2">
          {searching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
          Search
        </button>
      </form>

      {results && !selectedWoId && (
        <div className="border border-gray-800 rounded-lg divide-y divide-gray-800 overflow-hidden">
          {results.length === 0 && (
            <div className="p-4 text-gray-500 text-sm">No work orders match "{term}".</div>
          )}
          {results.map((w) => (
            <button key={w.id} onClick={() => loadWO(w.id)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/60 transition-colors text-left">
              <div>
                <span className="text-white font-mono text-sm font-semibold">{w.wo_number}</span>
                {w.products?.length > 0 && <span className="ml-3 text-gray-400 text-sm">{w.products.join(', ')}</span>}
                <span className="ml-3 text-gray-600 text-xs">{w.customer}</span>
              </div>
              <div className="flex items-center gap-3">
                <StatusPill status={w.status} />
                <ChevronRight size={16} className="text-gray-600" />
              </div>
            </button>
          ))}
        </div>
      )}

      {selectedWoId && (
        <div>
          <button onClick={() => { setSelectedWoId(null); setTrace(null) }} className="text-gray-400 hover:text-white text-sm mb-3 flex items-center gap-1">
            <ArrowRight size={14} className="rotate-180" /> Back to results
          </button>
          {loadingTrace || !trace ? (
            <div className="flex items-center justify-center py-20 text-gray-500"><Loader2 size={22} className="animate-spin mr-2" /> Loading traceability…</div>
          ) : (
            <TraceabilityReport trace={trace} canWrite={canWrite} profile={profile} onChanged={refreshTrace} />
          )}
        </div>
      )}
    </div>
  )
}

function StatusPill({ status }) {
  const closed = ['complete', 'closed', 'cancelled', 'shipped'].includes(status)
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${closed ? 'bg-gray-700 text-gray-300' : 'bg-skynet-green/20 text-skynet-green'}`}>
      {status?.replace(/_/g, ' ')}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Traceability report: header block (+ cert-package pill) + component-rollup
// table + per-component document sections
// ---------------------------------------------------------------------------
function TraceabilityReport({ trace, canWrite, profile, onChanged }) {
  const { header, components } = trace
  const certStatus = computeCertStatus(trace)
  const statusByPart = {}
  certStatus.components.forEach((r) => { statusByPart[r.part_id] = r.status })

  return (
    <div className="space-y-6">
      {/* Header block */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xl font-bold text-white font-mono">{header.wo_number}</span>
              <StatusPill status={header.status} />
              <CertPackagePill certStatus={certStatus} />
            </div>
            {header.part && (
              <div className="mt-1 text-gray-300">
                <span className="font-semibold">{header.part.part_number}</span>
                {header.part.description && <span className="text-gray-500"> — {header.part.description}</span>}
              </div>
            )}
            <div className="mt-1 text-xs text-gray-500 flex flex-wrap gap-x-4 gap-y-0.5">
              {header.part?.drawing_revision && <span>Drawing Rev: <span className="text-gray-300">{header.part.drawing_revision}</span></span>}
              {header.part?.specification && <span>Spec: <span className="text-gray-300">{header.part.specification}</span></span>}
              <span>Customer: <span className="text-gray-300">{header.customer || '—'}</span></span>
              {header.po_number && <span>PO: <span className="text-gray-300">{header.po_number}</span></span>}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            <Metric label="Order" value={header.order_quantity ?? '—'} />
            <Metric label="Stock" value={header.stock_quantity ?? '—'} />
            <Metric label="Good" value={header.good_qty ?? '—'} />
            <Metric label="Bad" value={header.bad_qty ?? '—'} />
          </div>
        </div>

        {header.assemblies?.length > 0 && (
          <div className="mt-4 pt-4 border-t border-gray-800">
            <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">Assembly Lots</div>
            <div className="flex flex-wrap gap-2">
              {header.assemblies.map((a) => (
                <div key={a.id} className="bg-gray-800 rounded-lg px-3 py-2 text-sm">
                  <span className="text-gray-300 font-medium">{a.part_number}</span>
                  {a.assembly_lot_number
                    ? <span className="ml-2 text-skynet-accent font-mono">{a.assembly_lot_number}</span>
                    : <span className="ml-2 text-gray-600">no lot</span>}
                  {a.assembly_completed_at && (
                    <span className="ml-2 text-xs text-gray-500">✓ {fmtDate(a.assembly_completed_at)}{a.assembly_completed_by_name ? ` · ${a.assembly_completed_by_name}` : ''}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Traceability table — one row per BOM component, expandable per source */}
      <div>
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-2">Traceability</h2>
        <div className="overflow-x-auto border border-gray-800 rounded-xl">
          <table className="w-full text-sm min-w-[960px]">
            <thead>
              <tr className="bg-gray-800/60 text-gray-400 text-xs uppercase tracking-wide">
                <th className="text-left px-3 py-2 font-medium">Part Number</th>
                <th className="text-left px-3 py-2 font-medium">Description</th>
                <th className="text-left px-3 py-2 font-medium">Source</th>
                <th className="text-left px-3 py-2 font-medium">Material + Heat/Lot #</th>
                <th className="text-left px-3 py-2 font-medium">PLN</th>
                <th className="text-left px-3 py-2 font-medium">FLN</th>
                <th className="text-left px-3 py-2 font-medium">Vendor Process Lots</th>
                <th className="text-right px-3 py-2 font-medium">Qty</th>
                <th className="text-center px-3 py-2 font-medium">Docs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {components.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-500">No components on this work order.</td></tr>
              )}
              {components.map((c) => <ComponentRow key={c.key} c={c} status={statusByPart[c.part_id]} />)}
            </tbody>
          </table>
        </div>
      </div>

      {/* Documents — one collapsible section per BOM component, sources grouped inside */}
      <div>
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-2">Documents</h2>
        <div className="space-y-3">
          {components.map((c) => (
            <ComponentDocGroup
              key={c.key}
              c={c}
              status={statusByPart[c.part_id]}
              canWrite={canWrite}
              profile={profile}
              workOrderId={header.id}
              onChanged={onChanged}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value }) {
  return (
    <div className="bg-gray-800 rounded-lg px-3 py-2 min-w-[64px]">
      <div className="text-lg font-bold text-white leading-none">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mt-1">{label}</div>
    </div>
  )
}

// Green/amber/red readiness dot for a component.
function StatusDot({ status }) {
  const color = status === 'ready' ? 'bg-skynet-green' : status === 'partial' ? 'bg-amber-400' : 'bg-red-500'
  const title = status === 'ready' ? 'All sources documented' : status === 'partial' ? 'Documentation gap' : 'No source linked'
  return <span title={title} className={`inline-block w-2 h-2 rounded-full shrink-0 ${color}`} />
}

// Cert-package status pill + click-to-open gap popover.
function CertPackagePill({ certStatus }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const ready = certStatus.overall === 'complete' && certStatus.totalCount > 0
  const nonReady = certStatus.components.filter((c) => c.status !== 'ready')

  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs font-medium ${ready ? 'bg-skynet-green/20 text-skynet-green' : 'bg-amber-500/20 text-amber-300'}`}
      >
        {ready ? <ShieldCheck size={13} /> : <ClipboardList size={13} />}
        {ready
          ? 'Cert Package Ready'
          : `Cert Package Incomplete — ${certStatus.readyCount} of ${certStatus.totalCount} components ready`}
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-80 max-h-96 overflow-y-auto bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 p-3">
          {nonReady.length === 0 ? (
            <div className="text-sm text-skynet-green flex items-center gap-2"><Check size={14} /> Every component has a documented source.</div>
          ) : (
            <div className="space-y-2.5">
              <div className="text-xs uppercase tracking-wide text-gray-500">Components not ready ({nonReady.length})</div>
              {nonReady.map((c) => (
                <div key={c.part_id} className="text-sm">
                  <div className="flex items-center gap-2">
                    <StatusDot status={c.status} />
                    <span className="text-white font-medium">{c.part_number}</span>
                  </div>
                  <ul className="mt-0.5 ml-4 list-disc text-xs text-gray-400 space-y-0.5">
                    {c.gaps.map((g, i) => <li key={i}>{g}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Source-cell content (icon + label) for a single source.
function SourceLabel({ s }) {
  if (s.kind === 'lot') {
    return (
      <span className="inline-flex items-center gap-1 text-amber-300">
        <Package size={13} /> {s.vendor ? `Purchased — ${s.vendor}` : 'Manual lot'}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      <span className="inline-flex items-center gap-1 text-sky-300"><Cpu size={13} /> Machined{s.machine_code ? ` — ${s.machine_code}` : ''}</span>
      {!s.native && s.linked_from_wo && (
        <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 text-[10px] font-medium">from {s.linked_from_wo}</span>
      )}
    </span>
  )
}

// The six detail <td>s shared by inline single-source rows and expanded sub-rows.
function SourceDetailCells({ s }) {
  const dash = <span className="text-gray-600">—</span>
  return (
    <>
      <td className="px-3 py-2">
        {s.kind === 'lot'
          ? <span className="font-mono text-gray-200">{s.lot_number}</span>
          : (
            <span>
              {s.material_type && <span className="text-gray-400">{s.material_type}{s.bar_size ? ` ${s.bar_size}` : ''} </span>}
              {s.materialLots?.length ? <span className="font-mono text-gray-200">{s.materialLots.join(', ')}</span> : dash}
            </span>
          )}
      </td>
      <td className="px-3 py-2 font-mono text-xs">{s.kind === 'job' && s.pln?.length ? s.pln.join(', ') : dash}</td>
      <td className="px-3 py-2 font-mono text-xs">{s.kind === 'job' && s.fln?.length ? s.fln.join(', ') : dash}</td>
      <td className="px-3 py-2 text-xs">
        {s.kind === 'job' && s.vendorProcessLots?.length
          ? s.vendorProcessLots.map((v, i) => (
              <div key={i} className="whitespace-nowrap">
                <span className="text-gray-400 capitalize">{v.operation_type?.replace(/_/g, ' ')}</span>
                {v.vendor_name && <span className="text-gray-500"> · {v.vendor_name}</span>}
                {v.vendor_lot_number && <span className="text-gray-200 font-mono"> · {v.vendor_lot_number}</span>}
              </div>
            ))
          : dash}
      </td>
      <td className="px-3 py-2 text-right">{s.qty ?? '—'}</td>
      <td className="px-3 py-2 text-center whitespace-nowrap">
        <span className={`inline-flex items-center gap-1 ${s.hasDocs ? 'text-skynet-green' : 'text-gray-500'}`}>
          {s.hasDocs && <Check size={13} />}{s.docCount}
        </span>
      </td>
    </>
  )
}

// One BOM component = a main row (aggregate when multi-source, inline when
// single) + expandable per-source sub-rows.
function ComponentRow({ c, status }) {
  const [open, setOpen] = useState(false)
  const multi = c.sourceCount > 1
  const sole = c.sourceCount === 1 ? c.sources[0] : null

  return (
    <>
      <tr className="text-gray-300 hover:bg-gray-800/30">
        <td className="px-3 py-2 font-medium text-white whitespace-nowrap">
          <div className="flex items-center gap-2">
            <StatusDot status={status} />
            {multi ? (
              <button onClick={() => setOpen((o) => !o)} className="text-gray-500 hover:text-white">
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            ) : (
              <span className="inline-block w-[14px]" />
            )}
            {c.part_number}
          </div>
        </td>
        <td className="px-3 py-2 text-gray-400 max-w-[220px] truncate" title={c.description}>{c.description || '—'}</td>
        {sole ? (
          <>
            <td className="px-3 py-2 whitespace-nowrap">
              <span className="flex items-center gap-2"><SourceLabel s={sole} /><SourceChip c={c} /></span>
            </td>
            <SourceDetailCells s={sole} />
          </>
        ) : (
          <>
            <td className="px-3 py-2 whitespace-nowrap">
              <button onClick={() => setOpen((o) => !o)} className="hover:opacity-80"><SourceChip c={c} /></button>
            </td>
            <td className="px-3 py-2"><span className="text-gray-600">—</span></td>
            <td className="px-3 py-2"><span className="text-gray-600">—</span></td>
            <td className="px-3 py-2"><span className="text-gray-600">—</span></td>
            <td className="px-3 py-2"><span className="text-gray-600">—</span></td>
            <td className="px-3 py-2 text-right">{c.aggregateQty || (c.sourceCount ? 0 : '—')}</td>
            <td className="px-3 py-2 text-center whitespace-nowrap">
              {c.sourceCount === 0
                ? <span className="text-gray-600">—</span>
                : (
                  <span className={`inline-flex items-center gap-1 ${c.docsComplete ? 'text-skynet-green' : 'text-gray-400'}`}>
                    {c.docsComplete && <Check size={13} />}{c.documentedSourceCount}/{c.sourceCount}
                  </span>
                )}
            </td>
          </>
        )}
      </tr>
      {multi && open && c.sources.map((s) => (
        <tr key={s.key} className="bg-gray-900/40 text-gray-300">
          <td className="px-3 py-2 pl-10 whitespace-nowrap text-xs">
            {s.kind === 'lot'
              ? <span className="font-mono text-skynet-accent">Lot {s.lot_number}</span>
              : <span className="font-mono text-gray-400">{s.job_number}</span>}
          </td>
          <td></td>
          <td className="px-3 py-2 whitespace-nowrap"><SourceLabel s={s} /></td>
          <SourceDetailCells s={s} />
        </tr>
      ))}
    </>
  )
}

function SourceChip({ c }) {
  return (
    <span className="px-2 py-0.5 rounded bg-gray-700/60 text-gray-300 text-xs whitespace-nowrap">{c.sourceSummary}</span>
  )
}

function DocLink({ label, sublabel, filePath, onDelete }) {
  return (
    <div className="flex items-center justify-between gap-2 bg-gray-800/60 rounded px-3 py-2">
      <button onClick={() => openDoc(filePath)} className="flex items-center gap-2 text-left text-sky-300 hover:text-sky-200 min-w-0">
        <FileText size={14} className="shrink-0" />
        <span className="truncate text-sm">{label}</span>
        <ExternalLink size={12} className="shrink-0 opacity-60" />
      </button>
      <div className="flex items-center gap-2 shrink-0">
        {sublabel && <span className="text-xs text-gray-500">{sublabel}</span>}
        {onDelete && (
          <button onClick={onDelete} className="text-gray-500 hover:text-red-400"><Trash2 size={13} /></button>
        )}
      </div>
    </div>
  )
}

function DocSection({ title, count, children }) {
  if (!count) return null
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-gray-500 mb-1.5">{title} ({count})</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

// The document chain for one job source (read-only — these docs live on the job).
function JobDocs({ docs }) {
  const { jobDocs, materialCertDocs, outboundCerts } = docs
  const nothing = jobDocs.length + materialCertDocs.length + outboundCerts.length === 0
  return (
    <div className="space-y-3">
      {nothing && <div className="text-sm text-gray-600">No documents recorded on this job.</div>}
      <DocSection title="Job Documents" count={jobDocs.length}>
        {jobDocs.map((d) => <DocLink key={d.id} label={d.file_name || 'Document'} sublabel={d.status} filePath={d.file_path} />)}
      </DocSection>
      <DocSection title="Material Cert Documents" count={materialCertDocs.length}>
        {materialCertDocs.map((d) => <DocLink key={d.id} label={d.file_name || 'Material Cert'} sublabel={d.lot_number ? `Lot ${d.lot_number}` : docTypeLabel(d.document_type)} filePath={d.file_path} />)}
      </DocSection>
      <DocSection title="Outbound Vendor Certs" count={outboundCerts.length}>
        {outboundCerts.map((d, i) => <DocLink key={i} label={d.file_name} sublabel={d.operation_type?.replace(/_/g, ' ')} filePath={d.file_path} />)}
      </DocSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-component document section (collapsible) — sources grouped inside
// ---------------------------------------------------------------------------
function ComponentDocGroup({ c, status, canWrite, profile, workOrderId, onChanged }) {
  const [open, setOpen] = useState(false)
  const isPurchased = c.part_type === 'purchased'
  const totalDocs = c.sources.reduce((n, s) => n + (s.docCount || 0), 0)

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-4 py-3 bg-gray-900 hover:bg-gray-800/60 transition-colors">
        <div className="flex items-center gap-2 text-left">
          {open ? <ChevronDown size={16} className="text-gray-500" /> : <ChevronRight size={16} className="text-gray-500" />}
          <StatusDot status={status} />
          {isPurchased ? <Package size={15} className="text-amber-300" /> : <Cpu size={15} className="text-sky-300" />}
          <span className="text-white font-medium">{c.part_number}</span>
          <span className="text-gray-500 text-sm">{c.description}</span>
        </div>
        <div className="flex items-center gap-2">
          <SourceChip c={c} />
          <span className={`text-xs ${c.docsComplete ? 'text-skynet-green' : 'text-gray-500'}`}>
            {c.docsComplete && <Check size={12} className="inline mr-0.5" />}{c.documentedSourceCount}/{c.sourceCount} documented
          </span>
          <span className="text-xs text-gray-500">{totalDocs} doc{totalDocs === 1 ? '' : 's'}</span>
        </div>
      </button>

      {open && (
        <div className="px-4 py-3 border-t border-gray-800 space-y-3">
          {c.sources.length === 0 && (
            <div className="text-sm text-gray-600">No sources linked to this component yet.</div>
          )}
          {c.sources.map((s) => (
            s.kind === 'job'
              ? <JobSourceBlock key={s.key} s={s} canWrite={canWrite} onChanged={onChanged} />
              : <LotCard key={s.key} lot={s} canWrite={canWrite} profile={profile} workOrderId={workOrderId} onChanged={onChanged} />
          ))}

          {canWrite && (
            <ComponentLinkArea c={c} profile={profile} workOrderId={workOrderId} onChanged={onChanged} />
          )}
        </div>
      )}
    </div>
  )
}

// An unlabeled lot list (PLN/FLN) for a job source header. Values are comma-joined
// and already deduplicated upstream. No text label — color alone identifies the
// lot type (cyan = production, emerald = finishing). Renders nothing when absent.
function JobLotPiece({ values, colorClass }) {
  if (!values?.length) return null
  return <span className={`text-xs font-medium ${colorClass}`}>{values.join(', ')}</span>
}

// A job source's read-only doc chain, with a header (+ linked/unlink controls).
function JobSourceBlock({ s, canWrite, onChanged }) {
  const handleUnlink = async () => {
    if (!confirm(`Unlink job ${s.job_number} (from ${s.linked_from_wo || 'another WO'}) from this cert package?`)) return
    const { error } = await unlinkJobFromWorkOrder(s.link_id)
    if (error) { alert('Unlink failed: ' + error.message); return }
    onChanged()
  }
  return (
    <div className="bg-gray-800/40 border border-gray-800 rounded-lg p-3">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <div className="flex items-center gap-2 text-sm">
          <Cpu size={14} className="text-sky-300" />
          <span className="font-mono text-gray-200">{s.job_number}</span>
          {s.machine_code && <span className="text-gray-500 text-xs">{s.machine_code}</span>}
          {!s.native && s.linked_from_wo && (
            <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 text-[10px] font-medium">from {s.linked_from_wo}</span>
          )}
          <span className="text-gray-600 text-xs">qty {s.qty ?? '—'}</span>
          <JobLotPiece values={s.pln} colorClass="text-cyan-300" />
          <JobLotPiece values={s.fln} colorClass="text-emerald-300" />
        </div>
        {canWrite && !s.native && s.link_id && (
          <button onClick={handleUnlink} className="text-xs text-gray-500 hover:text-red-400 inline-flex items-center gap-1">
            <X size={12} /> Unlink job
          </button>
        )}
      </div>
      <JobDocs docs={s.docs} />
    </div>
  )
}

// Link controls that appear on every component. Purchased → lot linking only.
// Manufactured → "Link SkyNet Job" (cross-WO) + "Manual Lot Record" (legacy).
function ComponentLinkArea({ c, profile, workOrderId, onChanged }) {
  const linkedLotIds = c.sources.filter((s) => s.kind === 'lot').map((s) => s.lot_id)

  if (c.part_type === 'purchased') {
    return (
      <LotLinkerToggle
        partId={c.part_id}
        partNumber={c.part_number}
        workOrderId={workOrderId}
        profile={profile}
        linkedLotIds={linkedLotIds}
        onChanged={onChanged}
      />
    )
  }
  return (
    <ManufacturedLinkPanel
      c={c}
      profile={profile}
      workOrderId={workOrderId}
      linkedLotIds={linkedLotIds}
      onChanged={onChanged}
    />
  )
}

function LotLinkerToggle({ partId, partNumber, workOrderId, profile, linkedLotIds, onChanged, label = 'Link Lot', legacy = false }) {
  const [show, setShow] = useState(false)
  if (show) {
    return (
      <LotLinker
        partId={partId}
        partNumber={partNumber}
        workOrderId={workOrderId}
        profile={profile}
        linkedLotIds={linkedLotIds}
        legacy={legacy}
        onClose={() => setShow(false)}
        onLinked={() => { setShow(false); onChanged() }}
      />
    )
  }
  return (
    <button onClick={() => setShow(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-gray-200">
      <Link2 size={14} /> {label}
    </button>
  )
}

// Manufactured component: two sourcing paths.
function ManufacturedLinkPanel({ c, profile, workOrderId, linkedLotIds, onChanged }) {
  const [mode, setMode] = useState(null) // null | 'job' | 'lot'

  if (mode === 'job') {
    return (
      <JobLinker
        component={c}
        workOrderId={workOrderId}
        profile={profile}
        onClose={() => setMode(null)}
        onLinked={() => { setMode(null); onChanged() }}
      />
    )
  }
  if (mode === 'lot') {
    return (
      <LotLinker
        partId={c.part_id}
        partNumber={c.part_number}
        workOrderId={workOrderId}
        profile={profile}
        linkedLotIds={linkedLotIds}
        legacy
        onClose={() => setMode(null)}
        onLinked={() => { setMode(null); onChanged() }}
      />
    )
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button onClick={() => setMode('job')} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-gray-200">
        <Link2 size={14} /> Link SkyNet Job
      </button>
      <button onClick={() => setMode('lot')} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-gray-200">
        <ClipboardList size={14} /> Manual Lot Record
      </button>
    </div>
  )
}

// Search a job by lot number, confirm, and link it into this WO's cert package.
function JobLinker({ component, workOrderId, profile, onClose, onLinked }) {
  const [term, setTerm] = useState('')
  const [results, setResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const runSearch = async (e) => {
    e?.preventDefault()
    if (!term.trim()) return
    setSearching(true); setError('')
    try {
      setResults(await findJobByLotNumber(term))
    } finally {
      setSearching(false)
    }
  }

  const doLink = async (jobId) => {
    setBusy(true); setError('')
    try {
      const { error } = await linkJobToWorkOrder(workOrderId, jobId, null, profile?.id)
      if (error && !String(error.message).includes('duplicate')) throw error
      onLinked()
    } catch (err) {
      setError('Link failed: ' + (err.message || err))
    } finally {
      setBusy(false)
    }
  }

  // Only jobs that actually produced THIS component can be linked here.
  const matching = (results || []).filter((r) => r.component_id === component.part_id)
  const otherPartCount = (results || []).length - matching.length

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white">Link a SkyNet job — {component.part_number}</span>
        <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={16} /></button>
      </div>

      {error && <div className="text-xs text-red-300 bg-red-900/20 border border-red-800/50 rounded p-2">{error}</div>}

      <form onSubmit={runSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search by production, finishing, or material lot #…" className="w-full pl-8 pr-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-skynet-accent" />
        </div>
        <button type="submit" disabled={searching || !term.trim()} className="px-3 py-2 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white text-xs rounded inline-flex items-center gap-1">
          {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Search
        </button>
      </form>

      {results !== null && (
        <div className="space-y-2">
          {matching.length === 0 && (
            <div className="text-sm text-gray-600">
              No jobs producing {component.part_number} matched "{term}".
              {otherPartCount > 0 && <span className="text-gray-500"> ({otherPartCount} job{otherPartCount === 1 ? '' : 's'} matched other parts.)</span>}
            </div>
          )}
          {matching.map((r) => (
            <div key={r.job_id} className="border border-gray-800 rounded-lg p-3 bg-gray-800/40">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="text-sm">
                  <span className="font-mono text-gray-200 font-semibold">{r.job_number}</span>
                  {r.wo_number && <span className="ml-2 text-sky-300">{r.wo_number}</span>}
                  <span className="ml-2 text-gray-400">{r.part_number}</span>
                </div>
                <button disabled={busy} onClick={() => doLink(r.job_id)} className="px-2.5 py-1 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white text-xs rounded inline-flex items-center gap-1">
                  <Link2 size={12} /> Link
                </button>
              </div>
              <div className="mt-1 text-xs text-gray-500 flex flex-wrap gap-x-3 gap-y-0.5">
                {r.production_lot_number && <span>PLN {r.production_lot_number}</span>}
                {r.finishing_lot_number && <span>FLN {r.finishing_lot_number}</span>}
                {r.materialLots?.length > 0 && <span>Material {r.materialLots.join(', ')}</span>}
                {r.matched_lot && <span className="text-gray-600">matched {r.matched_on}: {r.matched_lot}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function LotCard({ lot, canWrite, profile, workOrderId, onChanged }) {
  const [uploading, setUploading] = useState(false)
  const [file, setFile] = useState(null)
  const [docType, setDocType] = useState('coc')

  const handleUnlink = async () => {
    if (!confirm(`Unlink lot ${lot.lot_number} from this work order? (The lot and its documents are kept.)`)) return
    const { error } = await unlinkLotFromWorkOrder(workOrderId, lot.lot_id)
    if (error) { alert('Unlink failed: ' + error.message); return }
    onChanged()
  }

  const handleUpload = async () => {
    if (!file) return
    setUploading(true)
    try {
      const { error } = await uploadLotDocument(lot.lot_id, file, docType, profile?.id)
      if (error) throw error
      setFile(null)
      onChanged()
    } catch (err) {
      alert('Upload failed: ' + (err.message || err))
    } finally {
      setUploading(false)
    }
  }

  const handleDeleteDoc = async (doc) => {
    if (!confirm(`Remove "${doc.file_name}"?`)) return
    const { error } = await deleteLotDocument(doc.id, doc.file_path)
    if (error) { alert('Delete failed: ' + error.message); return }
    onChanged()
  }

  return (
    <div className="bg-gray-800/40 border border-gray-800 rounded-lg p-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm">
          <Package size={13} className="inline text-amber-300 mr-1" />
          <span className="font-mono text-skynet-accent font-semibold">{lot.lot_number}</span>
          {lot.vendor ? <span className="ml-2 text-gray-400">{lot.vendor}</span> : <span className="ml-2 text-gray-600 text-xs italic">manual/legacy lot</span>}
          {lot.po_number && <span className="ml-2 text-gray-600 text-xs">PO {lot.po_number}</span>}
          {lot.quantity != null && <span className="ml-2 text-gray-600 text-xs">qty {lot.quantity}</span>}
          {lot.received_at && <span className="ml-2 text-gray-600 text-xs">rcvd {fmtDate(lot.received_at)}</span>}
        </div>
        <div className="flex items-center gap-3">
          {(lot.documents || []).length === 0 && <span className="text-xs text-amber-400">no documents</span>}
          {canWrite && (
            <button onClick={handleUnlink} className="text-xs text-gray-500 hover:text-red-400 inline-flex items-center gap-1">
              <X size={12} /> Unlink
            </button>
          )}
        </div>
      </div>

      {lot.parent_lot_id && lot.process_description && (
        <div className="mt-1 text-xs text-gray-500 flex items-center gap-1"><GitBranch size={11} /> {lot.process_description}</div>
      )}

      <div className="mt-2 space-y-1.5">
        {(lot.documents || []).map((d) => (
          <DocLink
            key={d.id}
            label={d.file_name}
            sublabel={docTypeLabel(d.document_type)}
            filePath={d.file_path}
            onDelete={canWrite ? () => handleDeleteDoc(d) : null}
          />
        ))}
      </div>

      {canWrite && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <select value={docType} onChange={(e) => setDocType(e.target.value)} className="px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-xs text-white focus:outline-none focus:border-skynet-accent">
            {DOC_TYPES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} className="text-xs text-gray-400 file:mr-2 file:px-2 file:py-1 file:bg-gray-700 file:text-white file:border-0 file:rounded file:cursor-pointer" />
          <button onClick={handleUpload} disabled={!file || uploading} className="inline-flex items-center gap-1 px-3 py-1.5 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white text-xs rounded">
            {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} Upload
          </button>
        </div>
      )}
    </div>
  )
}

// Link an existing lot OR receive a new one, then link it to the WO.
function LotLinker({ partId, partNumber, workOrderId, profile, linkedLotIds, legacy = false, onClose, onLinked }) {
  const [lots, setLots] = useState(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [showReceive, setShowReceive] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    ;(async () => setLots(await getComponentLotsForPart(partId)))()
  }, [partId])

  const linkedSet = new Set(linkedLotIds)
  const filtered = (lots || []).filter((l) =>
    !search.trim() || l.lot_number?.toLowerCase().includes(search.trim().toLowerCase())
  )

  const doLink = async (lotId) => {
    setBusy(true); setError('')
    try {
      const { error } = await linkLotToWorkOrder(workOrderId, lotId, profile?.id)
      if (error && !String(error.message).includes('duplicate')) throw error
      onLinked()
    } catch (err) {
      setError('Link failed: ' + (err.message || err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white">{legacy ? 'Manual / legacy lot record' : 'Link a lot'} — {partNumber}</span>
        <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={16} /></button>
      </div>
      {legacy && !showReceive && (
        <div className="text-xs text-gray-500">Pre-SkyNet or legacy production: link an existing manual lot record or create a new one.</div>
      )}

      {error && <div className="text-xs text-red-300 bg-red-900/20 border border-red-800/50 rounded p-2">{error}</div>}

      {!showReceive && (
        <>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter existing lots…" className="w-full pl-8 pr-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-skynet-accent" />
          </div>
          <div className="max-h-52 overflow-y-auto divide-y divide-gray-800 border border-gray-800 rounded">
            {lots === null && <div className="p-3 text-gray-500 text-sm flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading lots…</div>}
            {lots !== null && filtered.length === 0 && <div className="p-3 text-gray-600 text-sm">No lots for this part yet — {legacy ? 'create a manual record' : 'receive a new one'} below.</div>}
            {filtered.map((l) => {
              const already = linkedSet.has(l.id)
              return (
                <div key={l.id} className="flex items-center justify-between px-3 py-2">
                  <div className="text-sm">
                    <span className="font-mono text-gray-200">{l.lot_number}</span>
                    {l.vendor && <span className="ml-2 text-gray-500 text-xs">{l.vendor}</span>}
                    {l.parent_lot_number && <span className="ml-2 text-gray-600 text-xs">← {l.parent_lot_number}</span>}
                    <span className="ml-2 text-gray-600 text-xs">{l.documentCount} doc{l.documentCount === 1 ? '' : 's'}</span>
                  </div>
                  {already
                    ? <span className="text-xs text-gray-600">linked</span>
                    : <button disabled={busy} onClick={() => doLink(l.id)} className="px-2.5 py-1 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white text-xs rounded inline-flex items-center gap-1"><Link2 size={12} /> Link</button>}
                </div>
              )
            })}
          </div>
          <button onClick={() => setShowReceive(true)} className="inline-flex items-center gap-1.5 text-sm text-skynet-accent hover:text-skynet-accent/80">
            <Plus size={14} /> {legacy ? 'New Manual Lot Record' : 'Receive New Lot'}
          </button>
        </>
      )}

      {showReceive && (
        <ReceiveLotForm
          partId={partId}
          profile={profile}
          existingLots={lots || []}
          legacy={legacy}
          onCancel={() => setShowReceive(false)}
          onCreated={async (newLotId) => { await doLink(newLotId) }}
        />
      )}
    </div>
  )
}

function ReceiveLotForm({ partId, profile, existingLots, legacy = false, onCancel, onCreated }) {
  const [form, setForm] = useState({
    lot_number: '', vendor: '', po_number: '', quantity: '', received_at: '',
    parent_lot_id: '', process_description: '', notes: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  const submit = async () => {
    if (!form.lot_number.trim()) { setError('Lot number is required.'); return }
    setSaving(true); setError('')
    try {
      const { data, error } = await createComponentLot({ ...form, part_id: partId }, profile?.id)
      if (error) throw error
      await onCreated(data.id)
    } catch (err) {
      setError('Create failed: ' + (err.message || err))
      setSaving(false)
    }
  }

  const input = 'w-full px-2.5 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-skynet-accent'

  return (
    <div className="space-y-2.5">
      {legacy && <div className="text-xs text-gray-500">Recording a manual lot for pre-SkyNet / legacy production. Attach its documents after saving.</div>}
      {error && <div className="text-xs text-red-300 bg-red-900/20 border border-red-800/50 rounded p-2">{error}</div>}
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className="text-[10px] uppercase tracking-wide text-gray-500">Lot Number *</label>
          <input value={form.lot_number} onChange={(e) => set('lot_number', e.target.value)} className={input} />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wide text-gray-500">Vendor</label>
          <input value={form.vendor} onChange={(e) => set('vendor', e.target.value)} className={input} />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wide text-gray-500">PO Number</label>
          <input value={form.po_number} onChange={(e) => set('po_number', e.target.value)} className={input} />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wide text-gray-500">Quantity</label>
          <input type="number" value={form.quantity} onChange={(e) => set('quantity', e.target.value)} className={input} />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wide text-gray-500">{legacy ? 'Production Date' : 'Received Date'}</label>
          <input type="date" value={form.received_at} onChange={(e) => set('received_at', e.target.value)} className={input} />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wide text-gray-500">Parent Lot (optional)</label>
          <select value={form.parent_lot_id} onChange={(e) => set('parent_lot_id', e.target.value)} className={input}>
            <option value="">— none —</option>
            {existingLots.map((l) => <option key={l.id} value={l.id}>{l.lot_number}</option>)}
          </select>
        </div>
      </div>
      {form.parent_lot_id && (
        <div>
          <label className="text-[10px] uppercase tracking-wide text-gray-500">Process (parent → this lot)</label>
          <input value={form.process_description} onChange={(e) => set('process_description', e.target.value)} placeholder="e.g. cad plating, passivation…" className={input} />
        </div>
      )}
      <div>
        <label className="text-[10px] uppercase tracking-wide text-gray-500">Notes</label>
        <input value={form.notes} onChange={(e) => set('notes', e.target.value)} className={input} />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} disabled={saving} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">Cancel</button>
        <button onClick={submit} disabled={saving} className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white text-sm rounded">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {legacy ? 'Save & Link' : 'Receive & Link'}
        </button>
      </div>
    </div>
  )
}

// ===========================================================================
// LOT SEARCH VIEW
// ===========================================================================
function LotSearchView({ canWrite, profile }) {
  const [term, setTerm] = useState('')
  const [result, setResult] = useState(null)
  const [searching, setSearching] = useState(false)
  const [jumpWoId, setJumpWoId] = useState(null)

  const run = async (e) => {
    e?.preventDefault()
    if (!term.trim()) return
    setSearching(true)
    try {
      setResult(await searchLot(term))
    } finally {
      setSearching(false)
    }
  }

  // Jumping to a WO swaps this view into an embedded WO report.
  if (jumpWoId) {
    return (
      <div>
        <button onClick={() => setJumpWoId(null)} className="text-gray-400 hover:text-white text-sm mb-3 flex items-center gap-1">
          <ArrowRight size={14} className="rotate-180" /> Back to lot search
        </button>
        <WorkOrderView canWrite={canWrite} profile={profile} initialWoId={jumpWoId} />
      </div>
    )
  }

  const grouped = groupHits(result?.hits || [])

  return (
    <div className="space-y-5">
      <form onSubmit={run} className="flex gap-2">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Enter a lot number (component, material, production, finishing, vendor, assembly)…"
            className="w-full pl-9 pr-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-skynet-accent"
          />
        </div>
        <button type="submit" disabled={searching || !term.trim()} className="px-5 py-2.5 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white text-sm font-medium rounded-lg flex items-center gap-2">
          {searching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />} Search
        </button>
      </form>

      {result && (
        <div className="space-y-5">
          <div className="text-sm text-gray-500">{result.hits.length} hit{result.hits.length === 1 ? '' : 's'} for "{result.query}"</div>
          {result.hits.length === 0 && (
            <div className="text-gray-500 text-sm py-8 text-center border border-gray-800 rounded-lg">No lots found matching "{result.query}".</div>
          )}
          {grouped.map(([typeLabel, hits]) => (
            <div key={typeLabel}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">{typeLabel} ({hits.length})</h3>
              <div className="space-y-2">
                {hits.map((h, i) => <LotHitCard key={i} hit={h} onJumpWO={setJumpWoId} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function groupHits(hits) {
  const map = new Map()
  for (const h of hits) {
    const key = h.typeLabel
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(h)
  }
  return [...map.entries()]
}

function LotHitCard({ hit, onJumpWO }) {
  const isComponentLot = hit.type === 'component_lot'
  return (
    <div className="border border-gray-800 rounded-lg p-3 bg-gray-900">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-skynet-accent font-semibold">{hit.lot_number}</span>
          {hit.exact && <span className="text-[10px] px-1.5 py-0.5 rounded bg-skynet-green/20 text-skynet-green">exact</span>}
          {hit.part_number && <span className="text-gray-300 text-sm">{hit.part_number}</span>}
        </div>
        {hit.wo_number && (
          <button onClick={() => hit.work_order_id && onJumpWO(hit.work_order_id)} className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200 text-sm">
            {hit.wo_number} <ArrowRight size={13} />
          </button>
        )}
      </div>

      <div className="mt-1 text-xs text-gray-500 flex flex-wrap gap-x-3 gap-y-0.5">
        {hit.job_number && <span>Job {hit.job_number}</span>}
        {hit.customer && <span>{hit.customer}</span>}
        {hit.vendor && <span>Vendor: {hit.vendor}</span>}
        {hit.po_number && <span>PO {hit.po_number}</span>}
        {hit.material_type && <span>{hit.material_type}{hit.bar_size ? ` ${hit.bar_size}` : ''}</span>}
        {hit.received_at && <span>rcvd {fmtDate(hit.received_at)}</span>}
      </div>

      {/* Component-lot lineage strip + WO links */}
      {isComponentLot && hit.lineage?.length > 0 && (
        <div className="mt-2">
          <div className="flex items-center flex-wrap gap-1.5">
            {[...hit.lineage]
              .sort((a, b) => (a.parent_lot_id ? 1 : 0) - (b.parent_lot_id ? 1 : 0))
              .map((l, idx, arr) => (
                <span key={l.id} className="flex items-center gap-1.5">
                  <span className={`px-2 py-1 rounded text-xs font-mono ${l.id === hit.lot_id ? 'bg-skynet-accent/20 text-skynet-accent border border-skynet-accent/40' : 'bg-gray-800 text-gray-300'}`}>
                    {l.lot_number}
                    {l.documentCount > 0 && <span className="ml-1 text-gray-500">({l.documentCount})</span>}
                  </span>
                  {idx < arr.length - 1 && <ArrowRight size={12} className="text-gray-600" />}
                </span>
              ))}
          </div>
          {hit.workOrders?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {hit.workOrders.map((w) => (
                <button key={w.id} onClick={() => onJumpWO(w.id)} className="inline-flex items-center gap-1 px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-xs text-sky-300">
                  {w.wo_number} <ArrowRight size={11} />
                </button>
              ))}
            </div>
          )}
          {hit.documents?.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {hit.documents.map((d) => (
                <DocLink key={d.id} label={d.file_name} sublabel={docTypeLabel(d.document_type)} filePath={d.file_path} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
