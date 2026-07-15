//
// Cert Repository — query + write layer for component-lot traceability
// (SKY64 + SKY67, Phase 1). See Decisions.md D-CERT-01..05.
//
// Two audiences:
//   • getWorkOrderTraceability(woId) powers the WO VIEW — the full chain of
//     custody for one work order (header + one row per component + doc tree).
//   • searchLot(lotNumber) powers the LOT SEARCH VIEW — a universal lot lookup
//     that resolves component_lot parent/child chains both directions.
//
// New tables (deployed outside the schema dump; see task schema):
//   component_lots(id, part_id, lot_number UNIQUE, parent_lot_id self-FK, vendor,
//     po_number, quantity, received_at, received_by, process_description, notes,
//     created_by, created_at)
//   component_lot_documents(id, component_lot_id, document_type, file_name,
//     file_path, file_size, mime_type, uploaded_by, uploaded_at)
//   work_order_component_lots(id, work_order_id, component_lot_id, linked_by,
//     notes, created_at)
//
// Conventions honoured:
//   • jobs.component_id is the part actually being made (D-S8-10). machines.code
//     is the machine code. material_documents.file_path / component_lot_documents
//     .file_path (NOT file_url — that is job_documents/part_documents).
//   • Never use .not(col,'in',...) — Supabase gotcha. Only .in()/.eq() filters.
//   • No embed nested deeper than 2 levels; wide walks fetch flat + merge here.
//
import { supabase } from './supabase'
import { uploadDocument, deleteDocument } from './s3'

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const uniq = (arr) => [...new Set(arr.filter(Boolean))]

// Resolve a set of profile ids to { id: full_name }. Empty-safe.
async function fetchProfileNames(ids) {
  const clean = uniq(ids)
  if (clean.length === 0) return {}
  const { data } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in('id', clean)
  const map = {}
  ;(data || []).forEach((p) => { map[p.id] = p.full_name })
  return map
}

// Group an array of rows by a key field into { key: [rows] }.
function groupBy(rows, key) {
  const out = {}
  for (const r of rows || []) {
    const k = r[key]
    if (!out[k]) out[k] = []
    out[k].push(r)
  }
  return out
}

// ---------------------------------------------------------------------------
// Component lot chain resolution (used by both views)
// ---------------------------------------------------------------------------

// Walk the parent_lot_id chain in BOTH directions from a seed lot and return
// every lot in the connected lineage, each decorated with its documents and
// linked work orders. Cycle-guarded via a visited set. `lotsById` may be
// pre-seeded to avoid refetching.
export async function resolveLotLineage(seedLotId) {
  if (!seedLotId) return { lots: [], rootId: null }
  const visited = new Map() // id -> lot row
  const queue = [seedLotId]

  while (queue.length) {
    const id = queue.shift()
    if (visited.has(id)) continue

    const { data: lot } = await supabase
      .from('component_lots')
      .select('id, part_id, lot_number, parent_lot_id, vendor, po_number, quantity, received_at, received_by, process_description, notes, created_by, created_at')
      .eq('id', id)
      .maybeSingle()
    if (!lot) { visited.set(id, null); continue }
    visited.set(id, lot)

    // up: this lot's parent
    if (lot.parent_lot_id && !visited.has(lot.parent_lot_id)) queue.push(lot.parent_lot_id)

    // down: children pointing at this lot
    const { data: children } = await supabase
      .from('component_lots')
      .select('id')
      .eq('parent_lot_id', id)
    for (const c of children || []) {
      if (!visited.has(c.id)) queue.push(c.id)
    }
  }

  const lots = [...visited.values()].filter(Boolean)
  if (lots.length === 0) return { lots: [], rootId: null }

  // decorate with part, documents, and linked WOs
  const lotIds = lots.map((l) => l.id)
  const partIds = uniq(lots.map((l) => l.part_id))

  const [{ data: parts }, { data: docs }, { data: links }] = await Promise.all([
    supabase.from('parts').select('id, part_number, description, part_type').in('id', partIds.length ? partIds : ['00000000-0000-0000-0000-000000000000']),
    supabase.from('component_lot_documents').select('*').in('component_lot_id', lotIds),
    supabase.from('work_order_component_lots').select('id, work_order_id, component_lot_id, notes, linked_by').in('component_lot_id', lotIds),
  ])
  const partsById = {}
  ;(parts || []).forEach((p) => { partsById[p.id] = p })
  const docsByLot = groupBy(docs, 'component_lot_id')
  const linksByLot = groupBy(links, 'component_lot_id')

  // resolve linked WO numbers
  const woIds = uniq((links || []).map((l) => l.work_order_id))
  let woById = {}
  if (woIds.length) {
    const { data: wos } = await supabase
      .from('work_orders')
      .select('id, wo_number, customer, status')
      .in('id', woIds)
    ;(wos || []).forEach((w) => { woById[w.id] = w })
  }

  const namesMap = await fetchProfileNames(lots.map((l) => l.received_by).concat(lots.map((l) => l.created_by)))

  const decorated = lots.map((l) => ({
    ...l,
    part: partsById[l.part_id] || null,
    received_by_name: namesMap[l.received_by] || null,
    documents: docsByLot[l.id] || [],
    workOrders: (linksByLot[l.id] || [])
      .map((lk) => woById[lk.work_order_id])
      .filter(Boolean),
  }))

  // root = the lot with no parent in the set (topmost purchase lot)
  const idSet = new Set(decorated.map((l) => l.id))
  const root = decorated.find((l) => !l.parent_lot_id || !idSet.has(l.parent_lot_id))
  return { lots: decorated, rootId: root ? root.id : decorated[0].id }
}

// ---------------------------------------------------------------------------
// WO VIEW — search + full traceability
// ---------------------------------------------------------------------------

// Search work orders by WO number OR part number. Includes closed / cancelled
// WOs — retroactive cert loading is a hard requirement. Returns a lightweight
// list for the picker; the full walk happens in getWorkOrderTraceability.
export async function searchWorkOrders(term) {
  const q = (term || '').trim()
  if (!q) return []

  const like = `%${q}%`
  const woIds = new Set()

  // 1. direct WO number match
  const { data: byNumber } = await supabase
    .from('work_orders')
    .select('id')
    .ilike('wo_number', like)
  ;(byNumber || []).forEach((w) => woIds.add(w.id))

  // 2. by part number → jobs.component_id and work_order_assemblies.assembly_id
  const { data: parts } = await supabase
    .from('parts')
    .select('id')
    .ilike('part_number', like)
  const partIds = (parts || []).map((p) => p.id)
  if (partIds.length) {
    const [{ data: jobs }, { data: woas }] = await Promise.all([
      supabase.from('jobs').select('work_order_id').in('component_id', partIds),
      supabase.from('work_order_assemblies').select('work_order_id').in('assembly_id', partIds),
    ])
    ;(jobs || []).forEach((j) => j.work_order_id && woIds.add(j.work_order_id))
    ;(woas || []).forEach((a) => a.work_order_id && woIds.add(a.work_order_id))
  }

  if (woIds.size === 0) return []

  const { data: wos } = await supabase
    .from('work_orders')
    .select('id, wo_number, customer, po_number, status, due_date, order_quantity, stock_quantity, created_at, closed_at')
    .in('id', [...woIds])
    .order('created_at', { ascending: false })

  // attach top-level product part numbers for display
  const ids = (wos || []).map((w) => w.id)
  let productsByWo = {}
  if (ids.length) {
    const { data: woas } = await supabase
      .from('work_order_assemblies')
      .select('work_order_id, assembly_id')
      .in('work_order_id', ids)
    const aIds = uniq((woas || []).map((a) => a.assembly_id))
    let partById = {}
    if (aIds.length) {
      const { data: aparts } = await supabase.from('parts').select('id, part_number').in('id', aIds)
      ;(aparts || []).forEach((p) => { partById[p.id] = p.part_number })
    }
    for (const a of woas || []) {
      if (!productsByWo[a.work_order_id]) productsByWo[a.work_order_id] = []
      const pn = partById[a.assembly_id]
      if (pn && !productsByWo[a.work_order_id].includes(pn)) productsByWo[a.work_order_id].push(pn)
    }
  }

  return (wos || []).map((w) => ({ ...w, products: productsByWo[w.id] || [] }))
}

// Full traceability payload for one work order:
//   { header, components: [...] }
// header — WO fields, primary part, assemblies (lot #s, completed date/by, status)
// components — ONE entry per BOM component (assembly_bom order), each carrying a
//   sources[] array: native jobs on this WO, jobs linked from other WOs
//   (work_order_component_jobs), and manual/purchased component_lots. Extra
//   components discovered only via native/linked jobs or lots (not in any BOM)
//   are appended after the ordered BOM components.
export async function getWorkOrderTraceability(workOrderId) {
  if (!workOrderId) return null

  // --- WO header ---
  const { data: wo, error: woErr } = await supabase
    .from('work_orders')
    .select('id, wo_number, customer, po_number, status, order_quantity, stock_quantity, due_date, notes, created_at, closed_at')
    .eq('id', workOrderId)
    .maybeSingle()
  if (woErr || !wo) return null

  // --- assemblies (all levels) ---
  const { data: woas } = await supabase
    .from('work_order_assemblies')
    .select('id, assembly_id, status, quantity, good_quantity, bad_quantity, order_quantity, stock_quantity, assembly_lot_number, assembly_completed_at, assembly_completed_by, parent_work_order_assembly_id')
    .eq('work_order_id', workOrderId)

  const assemblyPartIds = uniq((woas || []).map((a) => a.assembly_id))

  const JOB_COLS = 'id, job_number, component_id, part_id, assigned_machine_id, status, quantity, good_pieces, bad_pieces, post_mfg_good_qty, qty_override, production_lot_number, finishing_lot_number, work_order_id, work_order_assembly_id'

  // --- native jobs on this WO ---
  const { data: jobs } = await supabase
    .from('jobs')
    .select(JOB_COLS)
    .eq('work_order_id', workOrderId)

  // --- jobs linked in from OTHER work orders / stock runs (cross-WO sourcing) ---
  const { data: wcjRows } = await supabase
    .from('work_order_component_jobs')
    .select('id, job_id, notes')
    .eq('work_order_id', workOrderId)
  const linkedJobIds = uniq((wcjRows || []).map((r) => r.job_id))
  let linkedJobs = []
  const linkIdByJob = {}
  const sourceWoNumberByJob = {}
  ;(wcjRows || []).forEach((r) => { linkIdByJob[r.job_id] = r.id })
  if (linkedJobIds.length) {
    const { data: lj } = await supabase.from('jobs').select(JOB_COLS).in('id', linkedJobIds)
    linkedJobs = lj || []
    const srcWoIds = uniq(linkedJobs.map((j) => j.work_order_id))
    if (srcWoIds.length) {
      const { data: srcWos } = await supabase.from('work_orders').select('id, wo_number').in('id', srcWoIds)
      const m = {}
      ;(srcWos || []).forEach((w) => { m[w.id] = w.wo_number })
      linkedJobs.forEach((j) => { sourceWoNumberByJob[j.id] = m[j.work_order_id] || null })
    }
  }

  const allJobs = [...(jobs || []), ...linkedJobs]
  const allJobIds = allJobs.map((j) => j.id)
  const jobComponentIds = uniq(allJobs.map((j) => j.component_id || j.part_id).filter(Boolean))
  const machineIds = uniq(allJobs.map((j) => j.assigned_machine_id))

  // --- BOM of every assembly on this WO ---
  let bomRows = []
  if (assemblyPartIds.length) {
    const { data } = await supabase
      .from('assembly_bom')
      .select('assembly_id, component_id, quantity, sort_order')
      .in('assembly_id', assemblyPartIds)
    bomRows = data || []
  }

  // --- purchased/manual component lots linked to this WO (any part type) ---
  const { data: wclRows } = await supabase
    .from('work_order_component_lots')
    .select('id, component_lot_id, notes')
    .eq('work_order_id', workOrderId)
  const linkedLotIds = uniq((wclRows || []).map((l) => l.component_lot_id))

  let lotsById = {}
  let lotDocsByLot = {}
  if (linkedLotIds.length) {
    const [{ data: lots }, { data: lotDocs }] = await Promise.all([
      supabase.from('component_lots').select('id, part_id, lot_number, parent_lot_id, vendor, po_number, quantity, received_at, received_by, process_description, notes').in('id', linkedLotIds),
      supabase.from('component_lot_documents').select('*').in('component_lot_id', linkedLotIds),
    ])
    ;(lots || []).forEach((l) => { lotsById[l.id] = l })
    lotDocsByLot = groupBy(lotDocs, 'component_lot_id')
  }

  // --- gather all part records we need to name ---
  const allPartIds = uniq([
    ...assemblyPartIds,
    ...jobComponentIds,
    ...bomRows.map((b) => b.component_id),
    ...Object.values(lotsById).map((l) => l.part_id),
  ])
  let partsById = {}
  if (allPartIds.length) {
    const { data: parts } = await supabase
      .from('parts')
      .select('id, part_number, description, part_type, drawing_revision, specification')
      .in('id', allPartIds)
    ;(parts || []).forEach((p) => { partsById[p.id] = p })
  }

  // machines
  let machinesById = {}
  if (machineIds.length) {
    const { data: machines } = await supabase.from('machines').select('id, code, name').in('id', machineIds)
    ;(machines || []).forEach((m) => { machinesById[m.id] = m })
  }

  // --- per-job material, finishing, outbound, docs (batched over native + linked) ---
  const [jm, ml, mu, fs, os, jd] = allJobIds.length
    ? await Promise.all([
        supabase.from('job_materials').select('job_id, lot_number, material_type, bar_size, material_master_id').in('job_id', allJobIds),
        supabase.from('material_loads').select('job_id, lot_number, material_type, bar_size').in('job_id', allJobIds),
        supabase.from('material_usage').select('id, job_id, material_receiving_id, lot_number').in('job_id', allJobIds),
        supabase.from('finishing_sends').select('job_id, production_lot_number, finishing_lot_number, material_lot_number, chemical_lot_number, chemical_lot_number_2').in('job_id', allJobIds),
        supabase.from('outbound_sends').select('job_id, operation_type, vendor_name, vendor_lot_number, cert_document_path, quantity_returned, returned_at').in('job_id', allJobIds),
        supabase.from('job_documents').select('id, job_id, document_type_id, file_name, file_url, uploaded_at:created_at, status').in('job_id', allJobIds),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }]

  const jmByJob = groupBy(jm.data, 'job_id')
  const mlByJob = groupBy(ml.data, 'job_id')
  const muByJob = groupBy(mu.data, 'job_id')
  const fsByJob = groupBy(fs.data, 'job_id')
  const osByJob = groupBy(os.data, 'job_id')
  const jdByJob = groupBy(jd.data, 'job_id')

  // material cert docs: material_usage.material_receiving_id → material_documents
  const receivingIds = uniq((mu.data || []).map((u) => u.material_receiving_id))
  let matDocsByReceiving = {}
  if (receivingIds.length) {
    const { data: matDocs } = await supabase
      .from('material_documents')
      .select('id, material_receiving_id, document_type, file_name, file_path, uploaded_at')
      .in('material_receiving_id', receivingIds)
    matDocsByReceiving = groupBy(matDocs, 'material_receiving_id')
  }

  // --- profile names (assembly completed_by, lot received_by) ---
  const namesMap = await fetchProfileNames([
    ...(woas || []).map((a) => a.assembly_completed_by),
    ...Object.values(lotsById).map((l) => l.received_by),
  ])

  // ---- build header ----
  const topWoa = (woas || []).find((a) => !a.parent_work_order_assembly_id) || (woas || [])[0]
  const primaryPart = topWoa ? partsById[topWoa.assembly_id] : null

  // WO-level good/bad rollup: prefer assembly good/bad when the WO has assembled
  // products; otherwise sum the (native) component jobs' produced/scrap counts.
  const woaHasQty = (woas || []).some((a) => a.good_quantity != null || a.bad_quantity != null)
  const goodQty = woaHasQty
    ? (woas || []).reduce((n, a) => n + (a.good_quantity || 0), 0)
    : (jobs || []).reduce((n, j) => n + (j.post_mfg_good_qty ?? j.good_pieces ?? 0), 0)
  const badQty = woaHasQty
    ? (woas || []).reduce((n, a) => n + (a.bad_quantity || 0), 0)
    : (jobs || []).reduce((n, j) => n + (j.bad_pieces || 0), 0)

  const header = {
    id: wo.id,
    wo_number: wo.wo_number,
    customer: wo.customer,
    po_number: wo.po_number,
    status: wo.status,
    order_quantity: wo.order_quantity,
    stock_quantity: wo.stock_quantity,
    good_qty: goodQty,
    bad_qty: badQty,
    due_date: wo.due_date,
    notes: wo.notes,
    created_at: wo.created_at,
    closed_at: wo.closed_at,
    part: primaryPart
      ? {
          part_number: primaryPart.part_number,
          description: primaryPart.description,
          drawing_revision: primaryPart.drawing_revision,
          specification: primaryPart.specification,
        }
      : null,
    assemblies: (woas || []).map((a) => {
      const p = partsById[a.assembly_id]
      return {
        id: a.id,
        part_number: p?.part_number || '—',
        description: p?.description || '',
        status: a.status,
        assembly_lot_number: a.assembly_lot_number,
        assembly_completed_at: a.assembly_completed_at,
        assembly_completed_by_name: namesMap[a.assembly_completed_by] || null,
        parent_work_order_assembly_id: a.parent_work_order_assembly_id,
      }
    }),
  }

  // ---- per-job source builder (identical chain for native + linked jobs) ----
  const buildJobSource = (job, { native, linkedFromWo, linkId }) => {
    const machine = machinesById[job.assigned_machine_id]
    const jobMaterials = jmByJob[job.id] || []
    const loads = mlByJob[job.id] || []
    const usages = muByJob[job.id] || []
    const sends = fsByJob[job.id] || []
    const outbounds = osByJob[job.id] || []
    const jobDocsRaw = jdByJob[job.id] || []

    const materialLots = uniq([
      ...jobMaterials.map((m) => m.lot_number),
      ...loads.map((m) => m.lot_number),
    ])
    const materialType = jobMaterials[0]?.material_type || loads[0]?.material_type || null
    const barSize = jobMaterials[0]?.bar_size || loads[0]?.bar_size || null

    // Material certs are keyed by DISTINCT material_receiving lot, not per usage
    // event: a job has one material_usage row per issue/send, so the same
    // receiving's documents would otherwise repeat once per usage event (J-000043:
    // Lot 2610's cert rendered 9x). Reduce usages to a distinct receiving-id set
    // first, keeping the receiving lot label; dedupe by document id as a safety net.
    const receivingLotById = {}
    for (const u of usages) {
      if (u.material_receiving_id && !(u.material_receiving_id in receivingLotById)) {
        receivingLotById[u.material_receiving_id] = u.lot_number
      }
    }
    const seenMatDocId = new Set()
    const materialCertDocs = []
    for (const rid of uniq(usages.map((u) => u.material_receiving_id))) {
      for (const d of matDocsByReceiving[rid] || []) {
        if (seenMatDocId.has(d.id)) continue
        seenMatDocId.add(d.id)
        materialCertDocs.push({
          id: d.id, file_name: d.file_name, file_path: d.file_path,
          document_type: d.document_type, lot_number: receivingLotById[rid],
        })
      }
    }
    const plnSet = uniq([job.production_lot_number, ...sends.map((s) => s.production_lot_number)])
    const flnSet = uniq([job.finishing_lot_number, ...sends.map((s) => s.finishing_lot_number)])
    const vendorProcessLots = outbounds
      .filter((o) => o.vendor_lot_number || o.vendor_name)
      .map((o) => ({
        operation_type: o.operation_type, vendor_name: o.vendor_name,
        vendor_lot_number: o.vendor_lot_number, cert_document_path: o.cert_document_path,
        quantity_returned: o.quantity_returned,
      }))
    const outboundCerts = outbounds
      .filter((o) => o.cert_document_path)
      .map((o) => ({
        file_path: o.cert_document_path,
        file_name: `${o.vendor_name || 'Vendor'} cert${o.vendor_lot_number ? ` — ${o.vendor_lot_number}` : ''}`,
        operation_type: o.operation_type,
      }))
    const jobDocs = jobDocsRaw.map((d) => ({ id: d.id, file_name: d.file_name, file_path: d.file_url, status: d.status }))
    const docCount = jobDocs.length + materialCertDocs.length + outboundCerts.length
    const qty = job.qty_override ?? job.post_mfg_good_qty ?? job.good_pieces ?? job.quantity

    return {
      kind: 'job',
      key: `job:${job.id}`,
      native,
      linked_from_wo: linkedFromWo || null,
      link_id: linkId || null,
      job_id: job.id,
      job_number: job.job_number,
      component_id: job.component_id || job.part_id,
      machine_code: machine?.code || null,
      status: job.status,
      material_type: materialType,
      bar_size: barSize,
      materialLots,
      pln: plnSet,
      fln: flnSet,
      chemicalLots: uniq(sends.flatMap((s) => [s.chemical_lot_number, s.chemical_lot_number_2])),
      vendorProcessLots,
      qty,
      docs: { jobDocs, materialCertDocs, outboundCerts },
      docCount,
      hasDocs: docCount > 0,
    }
  }

  const buildLotSource = (lot) => {
    const documents = lotDocsByLot[lot.id] || []
    return {
      kind: 'lot',
      key: `lot:${lot.id}`,
      lot_id: lot.id,
      lot_number: lot.lot_number,
      part_id: lot.part_id,
      vendor: lot.vendor,
      po_number: lot.po_number,
      quantity: lot.quantity,
      qty: lot.quantity ?? 0,
      received_at: lot.received_at,
      received_by_name: namesMap[lot.received_by] || null,
      parent_lot_id: lot.parent_lot_id,
      process_description: lot.process_description,
      documents,
      docCount: documents.length,
      hasDocs: documents.length > 0,
    }
  }

  const nativeJobSources = (jobs || []).map((j) => buildJobSource(j, { native: true }))
  const linkedJobSources = linkedJobs.map((j) => buildJobSource(j, {
    native: false, linkedFromWo: sourceWoNumberByJob[j.id], linkId: linkIdByJob[j.id],
  }))

  const lotSourcesByPart = {}
  for (const lotId of linkedLotIds) {
    const lot = lotsById[lotId]
    if (!lot) continue
    if (!lotSourcesByPart[lot.part_id]) lotSourcesByPart[lot.part_id] = []
    lotSourcesByPart[lot.part_id].push(buildLotSource(lot))
  }

  // ---- component set + ordering (BOM order first, then extras) ----
  const bomAgg = {} // partId -> { sortOrder, qty }
  for (const b of bomRows) {
    const cur = bomAgg[b.component_id]
    if (cur) {
      cur.sortOrder = Math.min(cur.sortOrder, b.sort_order ?? 0)
      cur.qty += (b.quantity || 0)
    } else {
      bomAgg[b.component_id] = { sortOrder: b.sort_order ?? 0, qty: b.quantity || 0 }
    }
  }
  const orderedBomPartIds = Object.keys(bomAgg).sort((a, b) =>
    (bomAgg[a].sortOrder - bomAgg[b].sortOrder) ||
    (partsById[a]?.part_number || '').localeCompare(partsById[b]?.part_number || '')
  )

  const componentPartIds = []
  const seenPart = new Set()
  // BOM entries that are themselves assemblies / finished goods are structural
  // (sub-assemblies / products) — tracked via work_order_assemblies and shown in
  // the header's Assembly Lots. They never carry a job/lot cert source, so they
  // are excluded from the component rollup; their machined/purchased leaves come
  // in via each assembly's own BOM rows.
  for (const pid of orderedBomPartIds) {
    const pt = partsById[pid]?.part_type
    if (pt === 'assembly' || pt === 'finished_good') continue
    componentPartIds.push(pid)
    seenPart.add(pid)
  }
  for (const s of [...nativeJobSources, ...linkedJobSources]) {
    if (s.component_id && !seenPart.has(s.component_id)) { componentPartIds.push(s.component_id); seenPart.add(s.component_id) }
  }
  for (const pid of Object.keys(lotSourcesByPart)) {
    if (!seenPart.has(pid)) { componentPartIds.push(pid); seenPart.add(pid) }
  }

  const components = componentPartIds.map((partId) => {
    const part = partsById[partId]
    const nativeSrcs = nativeJobSources.filter((s) => s.component_id === partId)
    const linkedSrcs = linkedJobSources.filter((s) => s.component_id === partId)
    const lotSrcs = lotSourcesByPart[partId] || []
    const sources = [...nativeSrcs, ...linkedSrcs, ...lotSrcs]
    const jobCount = nativeSrcs.length + linkedSrcs.length
    const lotCount = lotSrcs.length
    const sourceCount = sources.length
    const aggregateQty = sources.reduce((n, s) => n + (s.qty || 0), 0)
    const documentedSourceCount = sources.filter((s) => s.hasDocs).length

    const summaryParts = []
    if (jobCount) summaryParts.push(`${jobCount} job${jobCount > 1 ? 's' : ''}`)
    if (lotCount) summaryParts.push(`${lotCount} lot${lotCount > 1 ? 's' : ''}`)

    return {
      key: `comp:${partId}`,
      part_id: partId,
      part_number: part?.part_number || '—',
      description: part?.description || '',
      part_type: part?.part_type || 'manufactured',
      bom_quantity: bomAgg[partId]?.qty ?? null,
      sources,
      jobCount,
      lotCount,
      sourceCount,
      aggregateQty,
      documentedSourceCount,
      sourceSummary: summaryParts.join(' + ') || 'no source',
      docsComplete: sourceCount > 0 && documentedSourceCount === sourceCount,
    }
  })

  return { header, components }
}

// Derive cert-package readiness from a traceability payload (client-side only —
// no stored status column). Per BOM component: 'ready' when it has >=1 source AND
// every lot source has >=1 document AND every job source has >=1 document
// somewhere in its chain; 'partial' when it has a source but a documentation gap;
// 'missing' when it has no source at all. Overall 'complete' iff every component
// is ready. `components[].gaps` drive the header popover.
export function computeCertStatus(traceability) {
  const comps = traceability?.components || []
  const results = comps.map((c) => {
    const gaps = []
    if (c.sourceCount === 0) {
      gaps.push(c.part_type === 'purchased' ? 'no lot linked' : 'no source linked')
      return { part_id: c.part_id, part_number: c.part_number, status: 'missing', gaps }
    }
    for (const s of c.sources) {
      if (s.hasDocs) continue
      if (s.kind === 'lot') gaps.push(`lot ${s.lot_number} has no documents`)
      else gaps.push(`job ${s.job_number} has no documents`)
    }
    return {
      part_id: c.part_id,
      part_number: c.part_number,
      status: gaps.length === 0 ? 'ready' : 'partial',
      gaps,
    }
  })
  const readyCount = results.filter((r) => r.status === 'ready').length
  const totalCount = results.length
  return {
    overall: totalCount > 0 && readyCount === totalCount ? 'complete' : 'incomplete',
    readyCount,
    totalCount,
    components: results,
  }
}

// ---------------------------------------------------------------------------
// LOT SEARCH VIEW — universal lot lookup
// ---------------------------------------------------------------------------

// Search a lot number across every lot-bearing surface. Exact matches first,
// then ILIKE-partial. Returns an array of typed hits. For component_lots hits
// the full parent/child lineage is resolved (both directions) and linked WOs
// included. Only .eq()/.ilike()/.in() filters are used.
export async function searchLot(lotNumber) {
  const raw = (lotNumber || '').trim()
  if (!raw) return { query: '', hits: [] }
  const like = `%${raw}%`

  const hits = []

  // --- component_lots (exact + partial) ---
  const { data: clExact } = await supabase
    .from('component_lots')
    .select('id, part_id, lot_number, parent_lot_id')
    .eq('lot_number', raw)
  const { data: clLike } = await supabase
    .from('component_lots')
    .select('id, part_id, lot_number, parent_lot_id')
    .ilike('lot_number', like)
  const clSeen = new Set()
  const clRows = [...(clExact || []), ...(clLike || [])].filter((r) => {
    if (clSeen.has(r.id)) return false
    clSeen.add(r.id)
    return true
  })
  for (const row of clRows) {
    const lineage = await resolveLotLineage(row.id)
    const self = lineage.lots.find((l) => l.id === row.id)
    hits.push({
      type: 'component_lot',
      typeLabel: 'Component Lot',
      exact: row.lot_number === raw,
      lot_number: row.lot_number,
      lot_id: row.id,
      part_number: self?.part?.part_number || null,
      part_id: row.part_id,
      lineage: lineage.lots.map((l) => ({
        id: l.id,
        lot_number: l.lot_number,
        part_number: l.part?.part_number || null,
        parent_lot_id: l.parent_lot_id,
        vendor: l.vendor,
        received_at: l.received_at,
        documentCount: (l.documents || []).length,
      })),
      rootId: lineage.rootId,
      documents: self?.documents || [],
      workOrders: uniq(lineage.lots.flatMap((l) => (l.workOrders || []).map((w) => JSON.stringify(w)))).map((s) => JSON.parse(s)),
    })
  }

  // --- helper for the flat lot surfaces: fetch matches, resolve job/WO context ---
  async function jobLotHits(table, columns, typeLabel, jobIdField = 'job_id') {
    // build an OR-free query: run one query per column with .ilike
    const rows = []
    for (const col of columns) {
      const { data } = await supabase.from(table).select(`${jobIdField}, ${col}`).ilike(col, like)
      for (const r of data || []) {
        if (r[col]) rows.push({ jobId: r[jobIdField], lot: r[col], col })
      }
    }
    if (rows.length === 0) return
    const jobIds = uniq(rows.map((r) => r.jobId))
    const { data: jobs } = await supabase
      .from('jobs')
      .select('id, job_number, work_order_id, component_id')
      .in('id', jobIds.length ? jobIds : ['00000000-0000-0000-0000-000000000000'])
    const jobById = {}
    ;(jobs || []).forEach((j) => { jobById[j.id] = j })
    const woIds = uniq((jobs || []).map((j) => j.work_order_id))
    const partIds = uniq((jobs || []).map((j) => j.component_id))
    const [{ data: wos }, { data: parts }] = await Promise.all([
      supabase.from('work_orders').select('id, wo_number, customer').in('id', woIds.length ? woIds : ['00000000-0000-0000-0000-000000000000']),
      supabase.from('parts').select('id, part_number').in('id', partIds.length ? partIds : ['00000000-0000-0000-0000-000000000000']),
    ])
    const woById = {}; (wos || []).forEach((w) => { woById[w.id] = w })
    const partById = {}; (parts || []).forEach((p) => { partById[p.id] = p })

    for (const r of rows) {
      const job = jobById[r.jobId]
      const wo = job ? woById[job.work_order_id] : null
      hits.push({
        type: table,
        typeLabel: `${typeLabel}${columns.length > 1 ? ` (${r.col})` : ''}`,
        exact: r.lot === raw,
        lot_number: r.lot,
        job_number: job?.job_number || null,
        job_id: job?.id || null,
        work_order_id: wo?.id || null,
        wo_number: wo?.wo_number || null,
        customer: wo?.customer || null,
        part_number: job ? partById[job.component_id]?.part_number || null : null,
      })
    }
  }

  // material_receiving has no job link — handled directly (exact + partial).
  const [{ data: mrExact }, { data: mrLike }] = await Promise.all([
    supabase.from('material_receiving').select('id, lot_number, material_type, bar_size, vendor, received_at, po_number').eq('lot_number', raw),
    supabase.from('material_receiving').select('id, lot_number, material_type, bar_size, vendor, received_at, po_number').ilike('lot_number', like),
  ])
  const mrSeen = new Set()
  for (const r of [...(mrExact || []), ...(mrLike || [])]) {
    if (mrSeen.has(r.id)) continue
    mrSeen.add(r.id)
    hits.push({
      type: 'material_receiving',
      typeLabel: 'Raw Material Receipt',
      exact: r.lot_number === raw,
      lot_number: r.lot_number,
      material_type: r.material_type,
      bar_size: r.bar_size,
      vendor: r.vendor,
      po_number: r.po_number,
      received_at: r.received_at,
      receiving_id: r.id,
    })
  }

  await jobLotHits('job_materials', ['lot_number'], 'Job Material Lot')
  await jobLotHits('material_loads', ['lot_number'], 'Material Load Lot')
  await jobLotHits(
    'finishing_sends',
    ['production_lot_number', 'finishing_lot_number', 'material_lot_number', 'chemical_lot_number', 'chemical_lot_number_2'],
    'Finishing Send'
  )
  await jobLotHits('outbound_sends', ['vendor_lot_number'], 'Outbound Vendor Lot')

  // --- work_order_assemblies.assembly_lot_number ---
  const [{ data: alnExact }, { data: alnLike }] = await Promise.all([
    supabase.from('work_order_assemblies').select('id, work_order_id, assembly_id, assembly_lot_number').eq('assembly_lot_number', raw),
    supabase.from('work_order_assemblies').select('id, work_order_id, assembly_id, assembly_lot_number').ilike('assembly_lot_number', like),
  ])
  const alnSeen = new Set()
  const alnRows = [...(alnExact || []), ...(alnLike || [])].filter((r) => {
    if (alnSeen.has(r.id)) return false
    alnSeen.add(r.id)
    return true
  })
  if (alnRows.length) {
    const woIds = uniq(alnRows.map((r) => r.work_order_id))
    const partIds = uniq(alnRows.map((r) => r.assembly_id))
    const [{ data: wos }, { data: parts }] = await Promise.all([
      supabase.from('work_orders').select('id, wo_number, customer').in('id', woIds),
      supabase.from('parts').select('id, part_number').in('id', partIds),
    ])
    const woById = {}; (wos || []).forEach((w) => { woById[w.id] = w })
    const partById = {}; (parts || []).forEach((p) => { partById[p.id] = p })
    for (const r of alnRows) {
      const wo = woById[r.work_order_id]
      hits.push({
        type: 'work_order_assemblies',
        typeLabel: 'Assembly Lot',
        exact: r.assembly_lot_number === raw,
        lot_number: r.assembly_lot_number,
        work_order_id: r.work_order_id,
        wo_number: wo?.wo_number || null,
        customer: wo?.customer || null,
        part_number: partById[r.assembly_id]?.part_number || null,
      })
    }
  }

  // exact hits first
  hits.sort((a, b) => (b.exact === true) - (a.exact === true))
  return { query: raw, hits }
}

// ---------------------------------------------------------------------------
// Component-lot management (admin/compliance write path)
// ---------------------------------------------------------------------------

// All component_lots for a part, with document counts — powers the Link Lot picker.
export async function getComponentLotsForPart(partId) {
  if (!partId) return []
  const { data: lots } = await supabase
    .from('component_lots')
    .select('id, part_id, lot_number, parent_lot_id, vendor, po_number, quantity, received_at, received_by, process_description, notes')
    .eq('part_id', partId)
    .order('received_at', { ascending: false })
  if (!lots || lots.length === 0) return []

  const lotIds = lots.map((l) => l.id)
  const [{ data: docs }, { data: parents }] = await Promise.all([
    supabase.from('component_lot_documents').select('id, component_lot_id').in('component_lot_id', lotIds),
    supabase.from('component_lots').select('id, lot_number').in('id', uniq(lots.map((l) => l.parent_lot_id))),
  ])
  const docCountByLot = {}
  ;(docs || []).forEach((d) => { docCountByLot[d.component_lot_id] = (docCountByLot[d.component_lot_id] || 0) + 1 })
  const parentLotNumberById = {}
  ;(parents || []).forEach((p) => { parentLotNumberById[p.id] = p.lot_number })

  return lots.map((l) => ({
    ...l,
    documentCount: docCountByLot[l.id] || 0,
    parent_lot_number: l.parent_lot_id ? parentLotNumberById[l.parent_lot_id] || null : null,
  }))
}

// Create (receive) a new component lot. `payload` = { part_id, lot_number,
// vendor, po_number, quantity, received_at, parent_lot_id, process_description,
// notes }. received_by/created_by set from profileId.
export async function createComponentLot(payload, profileId) {
  // User-picked dates store at local-noon UTC (Decisions.md date/timezone note):
  // a bare 'YYYY-MM-DD' would parse at midnight UTC and display a day early.
  const receivedAt = payload.received_at
    ? new Date(`${payload.received_at}T12:00:00`).toISOString()
    : null
  const insert = {
    part_id: payload.part_id,
    lot_number: (payload.lot_number || '').trim(),
    vendor: payload.vendor || null,
    po_number: payload.po_number || null,
    quantity: payload.quantity === '' || payload.quantity == null ? null : Number(payload.quantity),
    received_at: receivedAt,
    parent_lot_id: payload.parent_lot_id || null,
    process_description: payload.parent_lot_id ? payload.process_description || null : null,
    notes: payload.notes || null,
    received_by: profileId || null,
    created_by: profileId || null,
  }
  const { data, error } = await supabase
    .from('component_lots')
    .insert(insert)
    .select('id, lot_number, part_id')
    .single()
  return { data, error }
}

// Link an existing lot to a work order (idempotent via the UNIQUE pair — a
// duplicate returns a handled error the caller can surface).
export async function linkLotToWorkOrder(workOrderId, componentLotId, profileId, notes) {
  const { data, error } = await supabase
    .from('work_order_component_lots')
    .insert({
      work_order_id: workOrderId,
      component_lot_id: componentLotId,
      linked_by: profileId || null,
      notes: notes || null,
    })
    .select('id')
    .single()
  return { data, error }
}

export async function unlinkLotFromWorkOrder(workOrderId, componentLotId) {
  const { error } = await supabase
    .from('work_order_component_lots')
    .delete()
    .eq('work_order_id', workOrderId)
    .eq('component_lot_id', componentLotId)
  return { error }
}

// ---------------------------------------------------------------------------
// Cross-WO job sourcing (link a job produced on a DIFFERENT WO / stock run)
// ---------------------------------------------------------------------------

// Find a job by any of its lot numbers so the user can confirm before linking.
// Searches finishing_sends (production + finishing lot), job_materials.lot_number,
// and material_loads.lot_number. Exact matches sort first. Only .eq()/.ilike()/
// .in() filters. Returns [{ job_id, job_number, work_order_id, wo_number,
// component_id, part_number, part_description, production_lot_number,
// finishing_lot_number, materialLots, matched_on, matched_lot }].
export async function findJobByLotNumber(lotNumber) {
  const raw = (lotNumber || '').trim()
  if (!raw) return []
  const like = `%${raw}%`

  const matchInfo = {} // jobId -> { matched_on, matched_lot }
  const noteMatch = (jobId, on, lot) => {
    if (!jobId) return
    if (!matchInfo[jobId] || (lot === raw && matchInfo[jobId].matched_lot !== raw)) {
      matchInfo[jobId] = { matched_on: on, matched_lot: lot }
    }
  }

  const fsCols = [
    ['production_lot_number', 'production lot'],
    ['finishing_lot_number', 'finishing lot'],
  ]
  for (const [col, label] of fsCols) {
    const { data } = await supabase.from('finishing_sends').select(`job_id, ${col}`).ilike(col, like)
    for (const r of data || []) noteMatch(r.job_id, label, r[col])
  }
  {
    const { data } = await supabase.from('job_materials').select('job_id, lot_number').ilike('lot_number', like)
    for (const r of data || []) noteMatch(r.job_id, 'material lot', r.lot_number)
  }
  {
    const { data } = await supabase.from('material_loads').select('job_id, lot_number').ilike('lot_number', like)
    for (const r of data || []) noteMatch(r.job_id, 'material lot', r.lot_number)
  }

  const jobIds = Object.keys(matchInfo)
  if (jobIds.length === 0) return []

  const { data: jobs } = await supabase
    .from('jobs')
    .select('id, job_number, work_order_id, component_id, part_id, production_lot_number, finishing_lot_number')
    .in('id', jobIds)
  if (!jobs || jobs.length === 0) return []

  const woIds = uniq(jobs.map((j) => j.work_order_id))
  const partIds = uniq(jobs.map((j) => j.component_id || j.part_id))
  const jobIdList = jobs.map((j) => j.id)
  const [{ data: wos }, { data: parts }, { data: jmats }] = await Promise.all([
    supabase.from('work_orders').select('id, wo_number').in('id', woIds.length ? woIds : ['00000000-0000-0000-0000-000000000000']),
    supabase.from('parts').select('id, part_number, description').in('id', partIds.length ? partIds : ['00000000-0000-0000-0000-000000000000']),
    supabase.from('job_materials').select('job_id, lot_number').in('job_id', jobIdList),
  ])
  const woById = {}; (wos || []).forEach((w) => { woById[w.id] = w })
  const partById = {}; (parts || []).forEach((p) => { partById[p.id] = p })
  const matLotByJob = groupBy(jmats, 'job_id')

  const out = jobs.map((j) => {
    const partId = j.component_id || j.part_id
    return {
      job_id: j.id,
      job_number: j.job_number,
      work_order_id: j.work_order_id,
      wo_number: woById[j.work_order_id]?.wo_number || null,
      component_id: partId,
      part_number: partById[partId]?.part_number || null,
      part_description: partById[partId]?.description || null,
      production_lot_number: j.production_lot_number,
      finishing_lot_number: j.finishing_lot_number,
      materialLots: uniq((matLotByJob[j.id] || []).map((m) => m.lot_number)),
      matched_on: matchInfo[j.id]?.matched_on || null,
      matched_lot: matchInfo[j.id]?.matched_lot || null,
    }
  })
  // exact matched_lot first
  out.sort((a, b) => (b.matched_lot === raw) - (a.matched_lot === raw))
  return out
}

// Link a job (from any WO) into this WO's cert package. Idempotent via the UNIQUE
// (work_order_id, job_id) pair. Signature keeps (workOrderId, jobId, notes); the
// trailing profileId stamps linked_by.
export async function linkJobToWorkOrder(workOrderId, jobId, notes, profileId) {
  const { data, error } = await supabase
    .from('work_order_component_jobs')
    .insert({
      work_order_id: workOrderId,
      job_id: jobId,
      linked_by: profileId || null,
      notes: notes || null,
    })
    .select('id')
    .single()
  return { data, error }
}

// Remove a cross-WO job link by its work_order_component_jobs row id.
export async function unlinkJobFromWorkOrder(id) {
  const { error } = await supabase
    .from('work_order_component_jobs')
    .delete()
    .eq('id', id)
  return { error }
}

// Upload a document to a lot. S3 path: component-lots/{lotId}. Reuses
// uploadDocument from s3.js. documentType ∈ packing_slip|coc|material_cert|
// test_report|invoice|other.
export async function uploadLotDocument(componentLotId, file, documentType, profileId) {
  const { fileName, filePath, fileSize, mimeType } = await uploadDocument(file, `component-lots/${componentLotId}`)
  const { data, error } = await supabase
    .from('component_lot_documents')
    .insert({
      component_lot_id: componentLotId,
      document_type: documentType || 'other',
      file_name: file.name || fileName,
      file_path: filePath,
      file_size: fileSize,
      mime_type: mimeType,
      uploaded_by: profileId || null,
    })
    .select('*')
    .single()
  return { data, error }
}

// Delete a lot document: remove the S3 object (best-effort) then the row.
export async function deleteLotDocument(documentId, filePath) {
  if (filePath) {
    try { await deleteDocument(filePath) } catch (e) { console.error('Lot doc S3 delete failed (continuing):', e) }
  }
  const { error } = await supabase
    .from('component_lot_documents')
    .delete()
    .eq('id', documentId)
  return { error }
}
