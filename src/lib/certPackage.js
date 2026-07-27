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

const uniq = (arr) => [...new Set((arr || []).filter((v) => v != null && v !== ''))]

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

// Build the { autoFields, profileFields, entryDefaults } dataset for one job on a
// WO. Reuses getWorkOrderTraceability; narrows to the selected job for the
// per-package entry defaults while keeping every component in the cover table.
export async function buildPackageDataset(workOrderId, jobId) {
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

  const entryDefaults = {
    quantity_shipped: goodQty ?? '',
    lot_number: finishingLotNumber || '',
    emailed_to: '',
    material_lot_overrides: materialLotOverrides,
    // Lot Assembly Test block
    test_date: '',
    test_performance: '',
    test_inspector: '',
    test_calibration_due: '',
    // Quality Control Release block
    qc_date: '',
    qc_quantity: goodQty ?? '',
    qc_inspector: '',
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
    // Ordered document merge list (traceability order: per component in BOM order,
    // job docs → material certs → outbound certs → lot docs). Consumed by the PDF
    // generator; frozen into the snapshot at approval.
    mergeList: buildMergeList(trace),
  }
}

// Flatten the traceability doc chain into an ordered merge list for the PDF.
function buildMergeList(trace) {
  const out = []
  for (const c of trace?.components || []) {
    const cp = c.part_number
    for (const s of c.sources || []) {
      if (s.kind === 'job') {
        for (const d of s.docs?.jobDocs || []) out.push({ component_part_number: cp, group: 'Job Document', file_name: d.file_name, file_path: d.file_path })
        for (const d of s.docs?.materialCertDocs || []) out.push({ component_part_number: cp, group: 'Material Cert', file_name: d.file_name, file_path: d.file_path })
        for (const d of s.docs?.outboundCerts || []) out.push({ component_part_number: cp, group: 'Outbound Cert', file_name: d.file_name, file_path: d.file_path })
      } else if (s.kind === 'lot') {
        for (const d of s.documents || []) out.push({ component_part_number: cp, group: 'Lot Document', file_name: d.file_name, file_path: d.file_path })
      }
    }
  }
  return out.filter((d) => d.file_path)
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
  const dataset = await buildPackageDataset(pkg.work_order_id, pkg.job_id)
  if (!dataset) return { error: new Error('Could not assemble package data.') }

  const approvedAt = new Date().toISOString()
  const signing = {
    approver_name: profile?.full_name || null,
    title: sig.title || null,
    approved_date: approvedAt,
    signature_image_path: sig.signature_image_path,
    stamp_image_path: sig.stamp_image_path || null,
  }

  const snapshot = {
    autoFields: dataset.autoFields,
    profileFields: dataset.profileFields,
    formData: pkg.form_data || {},
    mergeList: dataset.mergeList,
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
