//
// Cert Package — Phase 2 data + generation layer (SKY64/SKY67 Phase 2).
// See Decisions.md D-CERTPKG-01..05.
//
// Responsibilities:
//   • part_cert_profiles  — per-part STATIC cover data, reused across every
//     package for that part (get/save).
//   • cert_signatures     — per-user signature + stamp images and title. Users
//     may only write their OWN row (RLS). The final PDF bears ONLY the approver's
//     stored signature, applied at Approve & Sign under their login.
//   • cert_packages       — the permanent package log. Drafts carry form_data;
//     Approve & Sign freezes a snapshot, generates the merged PDF, uploads it,
//     and flips the row to 'approved' (immutable via DB trigger).
//
// The cover-page dataset is a three-way split (D-CERTPKG-02):
//   auto     — pulled live from getWorkOrderTraceability (WO / job / lots)
//   profile  — part_cert_profiles (static, reused)
//   form     — cert_packages.form_data (per-package entry: test/QC blocks, qty,
//              emailed-to, editable overrides)
//
import { supabase } from './supabase'
import { uploadDocument, getDocumentUrl } from './s3'
import { getWorkOrderTraceability } from './certRepository'
import { generateCertPackagePdf } from './certPackagePdf'
import { fetchTravelerData, buildTravelerModel } from './traveler'

const uniq = (arr) => [...new Set((arr || []).filter((v) => v != null && v !== ''))]

// ---------------------------------------------------------------------------
// Document types excluded from cert packages BY DEFAULT
// ---------------------------------------------------------------------------
// The blank production log is an internal shop-floor artifact — the filled copy
// is what belongs in a customer package. Documents of these types are unchecked
// by default in the Arrange Documents step, but they stay visible so compliance
// can force-include one per package. This is a default, not a ban: the choice is
// stored per package in form_data.doc_arrangement.inclusion.
//
// 'production_log_blank' is document_types.code for the "Production Log (Blank)"
// type (same code BOMUpload.jsx / Armory.jsx seed into part_document_requirements).
// getExcludedDocumentTypeIds() resolves it by code and also name-matches, so an
// environment whose code drifted still excludes the right type.
export const EXCLUDED_DOC_TYPE_CODES = ['production_log_blank']
const EXCLUDED_DOC_TYPE_NAME_RE = /production\s*log\s*\(?\s*blank/i

let _excludedDocTypeIds = null
async function getExcludedDocumentTypeIds() {
  if (_excludedDocTypeIds) return _excludedDocTypeIds
  const { data, error } = await supabase.from('document_types').select('id, code, name')
  if (error) return new Set()
  const ids = new Set(
    (data || [])
      .filter((t) => EXCLUDED_DOC_TYPE_CODES.includes(t.code) || EXCLUDED_DOC_TYPE_NAME_RE.test(t.name || ''))
      .map((t) => t.id)
  )
  _excludedDocTypeIds = ids
  return ids
}

// Column types on part_cert_profiles (deployed schema, verified). Kept in one
// place so the form, save path, and cover renderer agree. tso_c148 is TEXT
// (holds 'NA' or a TSO designation), NOT a boolean.
export const PROFILE_BOOLEAN_FIELDS = [
  'conflict_minerals', 'rohs_compliant', 'dfars_compliant',
  'nadcap_plating', 'nadcap_heat_treat',
]
export const PROFILE_TEXT_FIELDS = [
  'tso_c148', 'camloc_equivalent', 'monadnock_equivalent', 'primer',
  'assy_country_of_origin', 'notes',
]

// ---------------------------------------------------------------------------
// part_cert_profiles
// ---------------------------------------------------------------------------

// Fetch the profile for a part, or a blank template (not persisted) when none
// exists yet. component_origins is a { part_number: country } map.
export async function getOrCreatePartCertProfile(partId) {
  if (!partId) return null
  const { data } = await supabase
    .from('part_cert_profiles')
    .select('*')
    .eq('part_id', partId)
    .maybeSingle()
  if (data) return data
  const blank = { part_id: partId, component_origins: {}, notes: null }
  PROFILE_BOOLEAN_FIELDS.forEach((f) => { blank[f] = false })
  PROFILE_TEXT_FIELDS.forEach((f) => { if (!(f in blank)) blank[f] = null })
  return blank
}

// Upsert the static cover data for a part (applies to all future packages for
// this part). Whitelists the known columns so stray keys never reach the DB.
export async function savePartCertProfile(partId, fields, profileId) {
  if (!partId) return { error: new Error('part_id required') }
  const row = { part_id: partId }
  PROFILE_BOOLEAN_FIELDS.forEach((f) => { row[f] = !!fields[f] })
  PROFILE_TEXT_FIELDS.forEach((f) => { row[f] = fields[f] ?? null })
  row.component_origins = fields.component_origins || {}
  // part_cert_profiles carries updated_by/updated_at — stamp both on every save.
  if (profileId) row.updated_by = profileId
  row.updated_at = new Date().toISOString()
  const { data, error } = await supabase
    .from('part_cert_profiles')
    .upsert(row, { onConflict: 'part_id' })
    .select('*')
    .maybeSingle()
  return { data, error }
}

// ---------------------------------------------------------------------------
// cert_signatures (per-user; RLS restricts writes to the caller's own row)
// ---------------------------------------------------------------------------

export async function getMySignature(userId) {
  if (!userId) return null
  const { data } = await supabase
    .from('cert_signatures')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  return data || null
}

// Upload a signature and/or stamp PNG to signatures/{userId}/ and upsert the row.
// Existing image paths are preserved when a new file isn't supplied. `title` is
// the typed line rendered under the signature on the cover.
export async function saveMySignature(userId, { signatureFile, stampFile, title }) {
  if (!userId) return { error: new Error('user required') }
  const existing = await getMySignature(userId)

  let signature_image_path = existing?.signature_image_path || null
  let stamp_image_path = existing?.stamp_image_path || null

  if (signatureFile) {
    const up = await uploadDocument(signatureFile, `signatures/${userId}`)
    signature_image_path = up.filePath
  }
  if (stampFile) {
    const up = await uploadDocument(stampFile, `signatures/${userId}`)
    stamp_image_path = up.filePath
  }

  const { data, error } = await supabase
    .from('cert_signatures')
    .upsert(
      {
        user_id: userId,
        signature_image_path,
        stamp_image_path,
        title: title ?? existing?.title ?? null,
      },
      { onConflict: 'user_id' }
    )
    .select('*')
    .maybeSingle()
  return { data, error }
}

// ---------------------------------------------------------------------------
// Dataset assembly (auto / profile / form split)
// ---------------------------------------------------------------------------

// Locate the selected job's source anywhere in the traceability payload and the
// component it belongs to. Jobs may be native to this WO or linked in.
function findJobSource(trace, jobId) {
  for (const c of trace?.components || []) {
    for (const s of c.sources || []) {
      if (s.kind === 'job' && s.job_id === jobId) return { source: s, component: c }
    }
  }
  return { source: null, component: null }
}

// One cover-table row per traceability component, lots aggregated across all its
// sources, origin resolved from the part profile's component_origins map.
function componentRows(trace, componentOrigins) {
  return (trace?.components || []).map((c) => {
    const jobs = c.sources.filter((s) => s.kind === 'job')
    const lots = c.sources.filter((s) => s.kind === 'lot')
    const finalLots = uniq([
      ...jobs.flatMap((s) => s.fln || []),
      ...lots.map((s) => s.lot_number),
    ])
    const productionLots = uniq(jobs.flatMap((s) => s.pln || []))
    const materialLots = uniq([
      ...jobs.flatMap((s) => s.materialLots || []),
      ...lots.map((s) => s.lot_number),
    ])
    return {
      part_id: c.part_id,
      part_number: c.part_number,
      description: c.description,
      part_type: c.part_type,
      component_origin: componentOrigins?.[c.part_number] || '',
      final_lots: finalLots,
      production_lots: productionLots,
      material_lots: materialLots,
    }
  })
}

// Resolve, per component part number, the DISTINCT material_receiving rows its
// jobs consumed — { part_number: [{ receiving_id, lot_number, heat_number }] }.
// Walks the traceability chain (component → job sources → material_usage →
// material_receiving), so the heat number is keyed by receiving ID, never by a
// lot-number string match. A component with exactly one receiving row is the
// only case the write-back will act on.
async function receivingRowsByComponent(trace) {
  const jobIdsByPart = {}
  const allJobIds = []
  for (const c of trace?.components || []) {
    const list = []
    for (const s of c.sources || []) {
      if (s.kind === 'job' && s.job_id) { list.push(s.job_id); allJobIds.push(s.job_id) }
    }
    jobIdsByPart[c.part_number] = list
  }
  if (allJobIds.length === 0) return {}

  const { data: usage } = await supabase
    .from('material_usage')
    .select('job_id, material_receiving_id')
    .in('job_id', uniq(allJobIds))
  const receivingIds = uniq((usage || []).map((u) => u.material_receiving_id))
  if (receivingIds.length === 0) return {}

  // material_receiving.heat_number is the newly deployed column. If a stale
  // environment is missing it the select errors — degrade to no prefill and no
  // write-back rather than failing the whole package build.
  const { data: recs, error } = await supabase
    .from('material_receiving')
    .select('id, lot_number, heat_number')
    .in('id', receivingIds)
  if (error) return {}
  const recById = {}
  ;(recs || []).forEach((r) => { recById[r.id] = r })

  const receivingIdsByJob = {}
  for (const u of usage || []) {
    if (!u.material_receiving_id) continue
    if (!receivingIdsByJob[u.job_id]) receivingIdsByJob[u.job_id] = []
    if (!receivingIdsByJob[u.job_id].includes(u.material_receiving_id)) {
      receivingIdsByJob[u.job_id].push(u.material_receiving_id)
    }
  }

  const out = {}
  for (const [partNumber, jobIds] of Object.entries(jobIdsByPart)) {
    const ids = uniq(jobIds.flatMap((jid) => receivingIdsByJob[jid] || []))
    out[partNumber] = ids
      .map((id) => recById[id])
      .filter(Boolean)
      .map((r) => ({ receiving_id: r.id, lot_number: r.lot_number, heat_number: r.heat_number ?? null }))
  }
  return out
}

// Build the { autoFields, profileFields, entryDefaults } dataset for one job on a
// WO. Reuses getWorkOrderTraceability; narrows to the selected job for the
// per-package entry defaults while keeping every component in the cover table.
// `includeTraveler` is off for the draft form / build fan-out (the traveler is
// four extra queries and nothing on the form displays it) and on at approval,
// which is the only moment the dataset has to be complete enough to freeze.
export async function buildPackageDataset(workOrderId, jobId, { includeTraveler = false } = {}) {
  const trace = await getWorkOrderTraceability(workOrderId)
  if (!trace) return null

  const { source: job, component: jobComp } = findJobSource(trace, jobId)
  // Part being certified = the part the selected job produced.
  const certifiedPartId = job?.component_id || jobComp?.part_id || trace.header?.part?.id || null

  // Drawing rev / spec aren't on the traceability payload except for the primary
  // part — fetch the certified part directly.
  let certPart = null
  if (certifiedPartId) {
    const { data } = await supabase
      .from('parts')
      .select('id, part_number, description, drawing_revision, specification')
      .eq('id', certifiedPartId)
      .maybeSingle()
    certPart = data || null
  }

  const profile = await getOrCreatePartCertProfile(certifiedPartId)
  const componentOrigins = profile?.component_origins || {}

  const finishingLotNumber = uniq(job?.fln || [])[0] || null
  const productionLotNumber = uniq(job?.pln || [])[0] || null
  const goodQty = job?.qty ?? null

  const rows = componentRows(trace, componentOrigins)

  // Per-component material-lot overrides, prefilled from the traceability lots.
  const materialLotOverrides = {}
  rows.forEach((r) => { materialLotOverrides[r.part_number] = (r.material_lots || []).join(', ') })

  // Heat numbers, prefilled from material_receiving.heat_number when the
  // component resolves to receiving rows that already carry one (D-CERTPKG-09).
  const receivingByComponent = await receivingRowsByComponent(trace)
  const heatNumberOverrides = {}
  rows.forEach((r) => {
    const heats = uniq((receivingByComponent[r.part_number] || []).map((x) => x.heat_number))
    heatNumberOverrides[r.part_number] = heats.join(', ')
  })

  // Assembly Lot Number — prefilled from work_order_assemblies for this WO when
  // the assembly module has stamped one, manually entered otherwise. When the
  // assembly module comes online and starts writing assembly_lot_number, this
  // prefill populates automatically and the manual entry becomes the override.
  const assemblyLotNumber = uniq((trace.header?.assemblies || []).map((x) => x.assembly_lot_number)).join(', ')

  const autoFields = {
    wo_number: trace.header?.wo_number || null,
    customer: trace.header?.customer || null,
    po_number: trace.header?.po_number || null,
    assy_part_number: certPart?.part_number || trace.header?.part?.part_number || null,
    part_number: certPart?.part_number || null,
    part_description: certPart?.description || jobComp?.description || null,
    drawing_revision: certPart?.drawing_revision || trace.header?.part?.drawing_revision || null,
    specification: certPart?.specification || trace.header?.part?.specification || null,
    good_qty: goodQty,
    finishing_lot_number: finishingLotNumber,
    production_lot_number: productionLotNumber,
    job_number: job?.job_number || null,
    machine_code: job?.machine_code || null,
    assemblies: (trace.header?.assemblies || []).map((a) => ({
      part_number: a.part_number,
      assembly_lot_number: a.assembly_lot_number,
      assembly_completed_at: a.assembly_completed_at,
      assembly_completed_by_name: a.assembly_completed_by_name,
    })),
    components: rows,
  }

  const mergeList = await buildMergeList(trace)

  // The SkyNet-generated traveler for this job, frozen alongside everything else
  // at approval so the approved PDF and the snapshot agree forever (D-CERTPKG-11).
  const travelerRaw = includeTraveler ? await fetchTravelerData(supabase, jobId) : null
  const traveler = travelerRaw
    ? {
        ...buildTravelerModel(travelerRaw),
        // Header extras the traveler model can't know about — they come from the
        // package's own data (heat/lot entry + the part's cert profile).
        tso_rev: profile?.tso_c148 || null,
      }
    : null

  const entryDefaults = {
    quantity_shipped: goodQty ?? '',
    lot_number: finishingLotNumber || '',
    assembly_lot_number: assemblyLotNumber,
    emailed_to: '',
    material_lot_overrides: materialLotOverrides,
    heat_number_overrides: heatNumberOverrides,
    // Lot Assembly Test block
    test_date: '',
    test_performance: '',
    test_inspector: '',
    test_calibration_due: '',
    // Quality Control Release block
    qc_date: '',
    qc_quantity: goodQty ?? '',
    qc_inspector: '',
    // Document arrangement (order + inclusion) — see buildDocumentGroups.
    doc_arrangement: defaultArrangement(mergeList),
  }

  return {
    workOrderId,
    jobId,
    partId: certifiedPartId,
    finishingLotNumber,
    productionLotNumber,
    autoFields,
    profileFields: profile,
    entryDefaults,
    receivingByComponent,
    traveler,
    // Ordered document merge list (traceability order: per component in BOM order,
    // job docs → material certs → outbound certs → lot docs). The compliance
    // arrangement (order + inclusion) is applied on top of it at approval.
    mergeList,
  }
}

// Flatten the traceability doc chain into an ordered merge list for the PDF.
// Every entry carries a stable `item_id` so the per-package arrangement (order +
// inclusion) can reference it across reloads, and `default_excluded` for the
// document types that are unchecked by default (EXCLUDED_DOC_TYPE_CODES).
async function buildMergeList(trace) {
  const out = []
  for (const c of trace?.components || []) {
    const cp = c.part_number
    for (const s of c.sources || []) {
      if (s.kind === 'job') {
        for (const d of s.docs?.jobDocs || []) out.push({ component_part_number: cp, group: 'Job Document', file_name: d.file_name, file_path: d.file_path, doc_id: d.id })
        for (const d of s.docs?.materialCertDocs || []) out.push({ component_part_number: cp, group: 'Material Cert', file_name: d.file_name, file_path: d.file_path, doc_id: d.id })
        for (const d of s.docs?.outboundCerts || []) out.push({ component_part_number: cp, group: 'Outbound Cert', file_name: d.file_name, file_path: d.file_path })
      } else if (s.kind === 'lot') {
        for (const d of s.documents || []) out.push({ component_part_number: cp, group: 'Lot Document', file_name: d.file_name, file_path: d.file_path, doc_id: d.id })
      }
    }
  }
  const list = out.filter((d) => d.file_path)

  // Which of the job documents are of a default-excluded type?
  const excludedTypeIds = await getExcludedDocumentTypeIds()
  let defaultExcludedDocIds = new Set()
  const jobDocIds = uniq(list.filter((d) => d.group === 'Job Document').map((d) => d.doc_id))
  if (excludedTypeIds.size && jobDocIds.length) {
    const { data } = await supabase
      .from('job_documents')
      .select('id, document_type_id')
      .in('id', jobDocIds)
    defaultExcludedDocIds = new Set(
      (data || []).filter((d) => excludedTypeIds.has(d.document_type_id)).map((d) => d.id)
    )
  }

  return list.map((d) => ({
    ...d,
    item_id: `${d.group}|${d.file_path}`,
    default_excluded: !!(d.doc_id && defaultExcludedDocIds.has(d.doc_id)),
  }))
}

// ---------------------------------------------------------------------------
// Document arrangement (order + inclusion), persisted in form_data
// ---------------------------------------------------------------------------
// The package's documents are shown as ordered GROUPS: the cover page (fixed
// first, never movable, never excludable), the generated Job Traveler (always
// included, position movable), then one group per component in BOM order. Both
// group order and within-group order are drag/move-able, and every document has
// an include/exclude checkbox. The result lives in
// form_data.doc_arrangement = { groupOrder, itemOrder, inclusion } and drives the
// merge order in approveAndGenerate → certPackagePdf exactly as shown.
export const COVER_GROUP_ID = '__cover__'
export const TRAVELER_GROUP_ID = '__traveler__'

const componentGroupId = (partNumber) => `comp:${partNumber || '—'}`

// The arrangement a brand-new draft starts from: natural traceability order,
// traveler in position 2, default-excluded types unchecked.
function defaultArrangement(mergeList) {
  const groupOrder = [COVER_GROUP_ID, TRAVELER_GROUP_ID]
  const itemOrder = {}
  const inclusion = {}
  for (const d of mergeList || []) {
    const gid = componentGroupId(d.component_part_number)
    if (!groupOrder.includes(gid)) groupOrder.push(gid)
    if (!itemOrder[gid]) itemOrder[gid] = []
    itemOrder[gid].push(d.item_id)
    inclusion[d.item_id] = !d.default_excluded
  }
  return { groupOrder, itemOrder, inclusion }
}

// Rebuild the arrangement view from the LIVE merge list + whatever the package
// has saved. Saved order/inclusion wins for items it knows; anything new (a
// document uploaded since the draft was saved) is appended in traceability order
// and takes its type default. Cover is always first; traveler is always present
// and always included.
export function buildDocumentGroups(dataset, formData) {
  const saved = formData?.doc_arrangement || {}
  const savedGroupOrder = saved.groupOrder || []
  const savedItemOrder = saved.itemOrder || {}
  const inclusion = saved.inclusion || {}

  const groups = []
  const byId = new Map()
  const ensure = (id, label, extra = {}) => {
    if (byId.has(id)) return byId.get(id)
    const g = { id, label, items: [], ...extra }
    groups.push(g)
    byId.set(id, g)
    return g
  }

  ensure(COVER_GROUP_ID, 'Cover Page', { pinned: true, always: true, note: 'QMS-10.4 Certificate of Conformance' })
  ensure(TRAVELER_GROUP_ID, 'Job Traveler', { always: true, note: 'Generated from SkyNet at approval' })

  for (const d of dataset?.mergeList || []) {
    const g = ensure(componentGroupId(d.component_part_number), d.component_part_number || 'Unassigned')
    g.items.push({
      ...d,
      id: d.item_id,
      included: typeof inclusion[d.item_id] === 'boolean' ? inclusion[d.item_id] : !d.default_excluded,
    })
  }

  const rank = (list, id) => {
    const i = list.indexOf(id)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  const movable = groups.filter((g) => !g.pinned)
  movable.sort((a, b) => rank(savedGroupOrder, a.id) - rank(savedGroupOrder, b.id))
  for (const g of movable) {
    const order = savedItemOrder[g.id] || []
    g.items.sort((a, b) => rank(order, a.id) - rank(order, b.id))
  }
  return [groups.find((g) => g.pinned), ...movable].filter(Boolean)
}

// Serialize the groups back into the form_data shape.
export function arrangementFromGroups(groups) {
  const groupOrder = groups.map((g) => g.id)
  const itemOrder = {}
  const inclusion = {}
  for (const g of groups) {
    if (g.id === COVER_GROUP_ID || g.id === TRAVELER_GROUP_ID) continue
    itemOrder[g.id] = g.items.map((i) => i.id)
    g.items.forEach((i) => { inclusion[i.id] = !!i.included })
  }
  return { groupOrder, itemOrder, inclusion }
}

// The final ordered merge list handed to the PDF generator: the arrangement,
// flattened, excluded documents dropped, with the traveler as its own entry.
// The cover is not in this list — the generator always draws it first.
export function buildArrangedMergeList(dataset, formData) {
  const out = []
  for (const g of buildDocumentGroups(dataset, formData)) {
    if (g.id === COVER_GROUP_ID) continue
    if (g.id === TRAVELER_GROUP_ID) { out.push({ kind: 'traveler' }); continue }
    for (const item of g.items) {
      if (!item.included) continue
      out.push({
        kind: 'document',
        component_part_number: item.component_part_number,
        group: item.group,
        file_name: item.file_name,
        file_path: item.file_path,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Heat-number write-back
// ---------------------------------------------------------------------------
// Fires on Save Draft and on Approve. A heat number typed against a component
// fills material_receiving.heat_number ONLY when that component resolves to
// exactly one receiving row AND that row's heat_number is still NULL. It never
// overwrites a value someone already recorded, and it skips silently (no error
// surfaced, package save unaffected) when the receiving row is ambiguous,
// absent, or the update is refused by RLS.
export async function writeBackHeatNumbers(dataset, formData) {
  const entered = formData?.heat_number_overrides || {}
  const written = []
  for (const [partNumber, raw] of Object.entries(entered)) {
    const heat = String(raw ?? '').trim()
    if (!heat) continue
    const candidates = dataset?.receivingByComponent?.[partNumber] || []
    if (candidates.length !== 1) continue          // ambiguous or unknown → skip
    const row = candidates[0]
    if (row.heat_number) continue                  // never overwrite
    const { error } = await supabase
      .from('material_receiving')
      .update({ heat_number: heat })
      .eq('id', row.receiving_id)
      .is('heat_number', null)                     // DB-level guard against a race
    if (error) {
      console.warn('Heat number write-back skipped for', partNumber, error.message)
      continue
    }
    row.heat_number = heat
    written.push({ part_number: partNumber, receiving_id: row.receiving_id, heat_number: heat })
  }
  return written
}

// ---------------------------------------------------------------------------
// cert_packages CRUD
// ---------------------------------------------------------------------------

// Package number = `${FLN}-CP${n}`, n = (# existing packages for this job) + 1.
async function nextPackageNumber(jobId, finishingLotNumber) {
  const { count } = await supabase
    .from('cert_packages')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', jobId)
  const n = (count || 0) + 1
  const base = finishingLotNumber || 'NOFLN'
  return `${base}-CP${n}`
}

// Create a draft package for one job. `formData` holds the per-package entries.
export async function createDraftPackage({ workOrderId, jobId, partId, finishingLotNumber, formData }, profileId) {
  const package_number = await nextPackageNumber(jobId, finishingLotNumber)
  const { data, error } = await supabase
    .from('cert_packages')
    .insert({
      work_order_id: workOrderId,
      job_id: jobId,
      part_id: partId || null,
      finishing_lot_number: finishingLotNumber || null,
      package_number,
      status: 'draft',
      form_data: formData || {},
      created_by: profileId || null,
    })
    .select('*')
    .single()
  return { data, error }
}

// Update a draft's form_data ONLY. Guarded to status='draft' so approved rows are
// never touched (the DB trigger is the hard stop; this is the soft one).
export async function updateDraftPackage(packageId, formData) {
  const { data, error } = await supabase
    .from('cert_packages')
    .update({ form_data: formData || {} })
    .eq('id', packageId)
    .eq('status', 'draft')
    .select('*')
    .maybeSingle()
  return { data, error }
}

export async function deleteDraftPackage(packageId) {
  const { error } = await supabase
    .from('cert_packages')
    .delete()
    .eq('id', packageId)
    .eq('status', 'draft')
  return { error }
}

// Newest-first package log for a WO, with created/approved profile names attached.
export async function listPackages(workOrderId) {
  if (!workOrderId) return []
  const { data } = await supabase
    .from('cert_packages')
    .select('*')
    .eq('work_order_id', workOrderId)
    .order('created_at', { ascending: false })
  const rows = data || []
  const ids = uniq([...rows.map((r) => r.created_by), ...rows.map((r) => r.approved_by)])
  let names = {}
  if (ids.length) {
    const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', ids)
    ;(profs || []).forEach((p) => { names[p.id] = p.full_name })
  }
  return rows.map((r) => ({
    ...r,
    created_by_name: names[r.created_by] || null,
    approved_by_name: names[r.approved_by] || null,
  }))
}

// ---------------------------------------------------------------------------
// Approve & Sign — freeze snapshot, generate PDF, upload, flip to approved
// ---------------------------------------------------------------------------

// Order matters: the row flips to 'approved' ONLY after the PDF exists in S3.
// The signature applied is the CURRENT USER'S own stored signature — builders
// and signers may differ (D-CERTPKG-03).
export async function approveAndGenerate(packageId, profile) {
  const userId = profile?.id
  // (i) require the approver's own active signature
  const sig = await getMySignature(userId)
  if (!sig || !sig.signature_image_path) {
    return { error: new Error('You must add your signature before approving. Open "My Signature" to upload one.') }
  }

  // Load the draft
  const { data: pkg, error: pkgErr } = await supabase
    .from('cert_packages')
    .select('*')
    .eq('id', packageId)
    .maybeSingle()
  if (pkgErr || !pkg) return { error: pkgErr || new Error('Package not found.') }
  if (pkg.status === 'approved') return { error: new Error('This package is already approved and cannot be regenerated. Use Regenerate to start a new package.') }

  // (ii) freeze snapshot — live dataset + the form values at approval
  const dataset = await buildPackageDataset(pkg.work_order_id, pkg.job_id, { includeTraveler: true })
  if (!dataset) return { error: new Error('Could not assemble package data.') }

  const approvedAt = new Date().toISOString()
  const signing = {
    approver_name: profile?.full_name || null,
    title: sig.title || null,
    approved_date: approvedAt,
    signature_image_path: sig.signature_image_path,
    stamp_image_path: sig.stamp_image_path || null,
  }

  const formData = pkg.form_data || {}

  // Heat numbers entered on this package fill material_receiving where it is
  // still NULL. Failures never block approval (see writeBackHeatNumbers).
  await writeBackHeatNumbers(dataset, formData)

  const snapshot = {
    autoFields: dataset.autoFields,
    profileFields: dataset.profileFields,
    formData,
    // The compliance-arranged order + inclusion, resolved to a flat list. The
    // traveler dataset is frozen here too, so the approved PDF and the snapshot
    // still agree years later even as the live job data moves on.
    mergeList: buildArrangedMergeList(dataset, formData),
    traveler: dataset.traveler,
    arrangement: formData.doc_arrangement || null,
    signing,
    package_number: pkg.package_number,
    frozen_at: approvedAt,
  }

  // (iii) generate the merged PDF
  let pdfBytes, conversion_manifest
  try {
    const res = await generateCertPackagePdf(snapshot, {
      fetchBytes: async (filePath) => {
        const url = await getDocumentUrl(filePath)
        if (!url) return null
        const resp = await fetch(url)
        if (!resp.ok) return null
        return new Uint8Array(await resp.arrayBuffer())
      },
    })
    pdfBytes = res.bytes
    conversion_manifest = res.conversionManifest
  } catch (err) {
    return { error: new Error('PDF generation failed: ' + (err.message || err)) }
  }

  // (iv) upload the final PDF to S3 (cert-packages/{id}.pdf). uploadDocument adds
  // a timestamp prefix; the actual key is stored in file_path.
  let filePath
  try {
    const file = new File([pdfBytes], `${packageId}.pdf`, { type: 'application/pdf' })
    const up = await uploadDocument(file, 'cert-packages')
    filePath = up.filePath
  } catch (err) {
    return { error: new Error('PDF upload failed: ' + (err.message || err)) }
  }

  // (v) single UPDATE flipping to approved — only now that the file exists
  const { data, error } = await supabase
    .from('cert_packages')
    .update({
      status: 'approved',
      snapshot,
      file_path: filePath,
      conversion_manifest,
      approved_by: userId || null,
      approved_at: approvedAt,
    })
    .eq('id', packageId)
    .eq('status', 'draft')
    .select('*')
    .maybeSingle()
  if (error) {
    // DB trigger makes approved rows immutable; surface any failure gracefully.
    return { error: new Error('Approval write failed (the PDF was generated): ' + error.message) }
  }
  return { data }
}
