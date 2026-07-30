//
// Cert Package PDF generation (pdf-lib). See Decisions.md D-CERTPKG-01..05.
//
// generateCertPackagePdf(snapshot, { fetchBytes }) returns { bytes, conversionManifest }.
//   • Renders the Skybolt QMS-10.4 Rev 003 Certificate of Conformance cover page
//     from the frozen snapshot (auto + profile + form data + approver signature).
//   • Merges every traceability document IN ORDER (cover, then per component in
//     BOM order: job docs → material certs → outbound certs → lot docs):
//       - PDF  → pages copied via pdf-lib
//       - JPG/PNG → one image per page, scaled to fit letter with margin
//       - XLS/XLSX → parsed with SheetJS, each sheet re-rendered as a text table
//                    (data fidelity, not visual fidelity)
//       - anything else → skipped, recorded in the conversion manifest, and listed
//                         on a final "Separate Attachments" page
//   • fetchBytes(filePath) resolves an S3 key to a Uint8Array (signed-URL fetch).
//
// The four Certificate of Conformance paragraphs (CERT_PARAGRAPHS) and the DFARs
// line were transcribed from the controlled QMS-10.4 Rev 003 form. Treat them as
// controlled text: re-verify against the form on any revision bump, and change
// them only to match it.
//
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import * as XLSX from 'xlsx'

const PAGE_W = 612
const PAGE_H = 792
const MARGIN = 36

const BLACK = rgb(0, 0, 0)
const GRAY = rgb(0.45, 0.45, 0.45)
const HEADER_FILL = rgb(0.9, 0.9, 0.9)
const LABEL_FILL = rgb(0.95, 0.95, 0.95)

const CAGE_CODE = '435Z0'

// Verbatim QMS-10.4 Rev 003 Certificate of Conformance paragraphs (P1–P4).
const CERT_PARAGRAPHS = [
  'Skybolt Aeromotive Corporation certifies that the above noted part number was manufactured and inspected in accordance with the applicable purchase order, drawing specifications, and any other requirements invoked thereon.',
  'The materials and/or parts furnished under the above purchase order were produced either from materials furnished by the Buyer for the production of such parts, or from materials for which the Seller has available for examination, chemicals and/or physical test reports or other evidence of conformance.',
  'The SK Part Number, Revision Letter and/or Lot Number listed on this certification may not reflect the part number, revision letter and/or lot number listed on the Processing Certification(s) and /or other paperwork attached to this Certification.  The identification listed on this certification is the identification of the SK Sales drawing at the time of manufacture and may not coincide with the manufacturing drawing(s) and/or revision letter(s) used to manufacture and process the part(s).  Traceability to the identification listed on this certification is maintained and guaranteed.',
  "When applicable, the parts contained in this shipment have been manufactured and inspected in accordance with TSO-C148.  The conditions and tests required for TSO approval of this article are minimum performance standards set in the manufacturer's design.  Aircraft fasteners approved under this TSO are not necessarily interchangeable with other aircraft fasteners approved under this TSO.  Fasteners of similar dimensional properties may have widely varying performance and metallurgical properties.  Substitution of parts may only be done if acceptable to or approved by the Administrator.",
]

// pdf-lib's StandardFont uses WinAnsi encoding and throws on unencodable code
// points (CJK, emoji, math). Map the common "smart" punctuation to ASCII and
// replace anything outside Latin-1 so arbitrary filenames / spreadsheet cells
// never break generation.
function safe(s) {
  return String(s ?? '')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/•/g, '*')
    .replace(/[-]/g, '?')
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '?')
}

const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : v ? String(v) : '-')
const val = (v) => (v == null || v === '' ? '-' : String(v))

function extOf(name) {
  const m = /\.([a-z0-9]+)\s*$/i.exec(name || '')
  return m ? m[1].toLowerCase() : ''
}

// ---------------------------------------------------------------------------
// A top-down page flow that appends pages to the shared PDFDocument.
// ---------------------------------------------------------------------------
function newFlow(pdf, font, bold) {
  const left = MARGIN
  const right = PAGE_W - MARGIN
  const width = right - left
  let page = pdf.addPage([PAGE_W, PAGE_H])
  let y = PAGE_H - MARGIN

  const api = {
    get page() { return page },
    left, right, width, font, bold,

    addPage() { page = pdf.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; return page },
    ensure(space) { if (y - space < MARGIN + 24) api.addPage() },
    get y() { return y },
    set y(v) { y = v },
    gap(h) { y -= h },

    wrap(text, size, f, maxW) {
      const words = safe(text).split(/\s+/).filter(Boolean)
      if (words.length === 0) return ['']
      const lines = []
      let cur = ''
      for (const w of words) {
        const trial = cur ? cur + ' ' + w : w
        if ((f || font).widthOfTextAtSize(trial, size) > maxW && cur) {
          lines.push(cur); cur = w
        } else cur = trial
      }
      if (cur) lines.push(cur)
      return lines
    },

    // Wrapped paragraph/heading text; advances y.
    text(str, { size = 9, f = font, color = BLACK, x = left, maxW = width, gapAfter = 4, lineGap = 2, align = 'left' } = {}) {
      const lines = api.wrap(str, size, f, maxW)
      for (const ln of lines) {
        api.ensure(size + lineGap)
        let dx = x
        if (align === 'center') dx = x + (maxW - f.widthOfTextAtSize(ln, size)) / 2
        page.drawText(ln, { x: dx, y: y - size, size, font: f, color })
        y -= size + lineGap
      }
      y -= gapAfter
    },

    hline(color = BLACK, thickness = 1) {
      page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness, color })
    },

    // Bordered table. columns: [{ title?, w (fraction of width) }]. rows: string[][].
    table(columns, rows, { size = 8, headerFill = HEADER_FILL, cellPad = 3, headerBold = true } = {}) {
      const totalW = columns.reduce((n, c) => n + c.w, 0)
      const colX = []
      let cx = left
      for (const c of columns) { colX.push(cx); cx += (c.w / totalW) * width }
      colX.push(right)
      const lineH = size + 2

      const drawRow = (cells, { fill = null, bold: isBold = false } = {}) => {
        const f = isBold ? bold : font
        // wrap each cell, compute row height
        const wrapped = cells.map((txt, i) => {
          const w = colX[i + 1] - colX[i] - cellPad * 2
          return api.wrap(txt, size, f, w)
        })
        const rowH = Math.max(1, ...wrapped.map((l) => l.length)) * lineH + cellPad
        api.ensure(rowH)
        const top = y
        if (fill) page.drawRectangle({ x: left, y: top - rowH, width, height: rowH, color: fill })
        // cell borders + text
        for (let i = 0; i < columns.length; i++) {
          page.drawRectangle({
            x: colX[i], y: top - rowH, width: colX[i + 1] - colX[i], height: rowH,
            borderColor: BLACK, borderWidth: 0.5,
          })
          let ty = top - size
          for (const ln of wrapped[i]) {
            page.drawText(ln, { x: colX[i] + cellPad, y: ty - 1, size, font: f, color: BLACK })
            ty -= lineH
          }
        }
        y -= rowH
      }

      if (columns.some((c) => c.title)) {
        drawRow(columns.map((c) => c.title || ''), { fill: headerFill, bold: headerBold })
      }
      for (const r of rows) drawRow(r)
    },

    // Two-pairs-per-row label/value grid.
    fieldGrid(pairsRows, { size = 8, labelW = 0.18, valueW = 0.32 } = {}) {
      const cols = [
        { w: labelW }, { w: valueW }, { w: labelW }, { w: valueW },
      ]
      const rows = pairsRows.map(([lL, lV, rL, rV]) => [lL, lV, rL ?? '', rV ?? ''])
      // shade label columns via a custom draw
      const totalW = cols.reduce((n, c) => n + c.w, 0)
      const colX = []
      let cx = left
      for (const c of cols) { colX.push(cx); cx += (c.w / totalW) * width }
      colX.push(right)
      const lineH = size + 2
      for (const r of rows) {
        const wrapped = r.map((txt, i) => api.wrap(txt, size, i % 2 === 0 ? bold : font, colX[i + 1] - colX[i] - 6))
        const rowH = Math.max(1, ...wrapped.map((l) => l.length)) * lineH + 3
        api.ensure(rowH)
        const top = y
        for (let i = 0; i < cols.length; i++) {
          if (i % 2 === 0) page.drawRectangle({ x: colX[i], y: top - rowH, width: colX[i + 1] - colX[i], height: rowH, color: LABEL_FILL })
          page.drawRectangle({ x: colX[i], y: top - rowH, width: colX[i + 1] - colX[i], height: rowH, borderColor: BLACK, borderWidth: 0.5 })
          let ty = top - size
          for (const ln of wrapped[i]) {
            page.drawText(ln, { x: colX[i] + 3, y: ty - 1, size, font: i % 2 === 0 ? bold : font, color: BLACK })
            ty -= lineH
          }
        }
        y -= rowH
      }
    },
  }
  return api
}

// Sniff PNG vs JPG and embed.
async function embedImage(pdf, bytes) {
  if (!bytes || bytes.length < 4) return null
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  try {
    return isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes)
  } catch {
    // last resort: try the other decoder
    try { return isPng ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes) } catch { return null }
  }
}

// ---------------------------------------------------------------------------
// Cover page
// ---------------------------------------------------------------------------
async function drawCover(pdf, font, bold, snapshot, fetchBytes) {
  const a = snapshot.autoFields || {}
  const p = snapshot.profileFields || {}
  const fd = snapshot.formData || {}
  const sign = snapshot.signing || {}
  const flow = newFlow(pdf, font, bold)

  // --- Header block ---
  flow.text('SKYBOLT AEROMOTIVE CORPORATION', { size: 16, f: bold, align: 'center', gapAfter: 2 })
  flow.text('Certification Package', { size: 12, f: bold, align: 'center', gapAfter: 3 })
  flow.text('Skybolt quality records retained for 10-years', { size: 8, color: GRAY, align: 'center', gapAfter: 1 })
  flow.text('AS9100D  ISO9001:2015,  FAA-PMA', { size: 8, color: GRAY, align: 'center', gapAfter: 1 })
  flow.text('9000 Airport Blvd  Leesburg, Florida 34788  352-326-0001', { size: 8, color: GRAY, align: 'center', gapAfter: 6 })
  flow.hline(BLACK, 1.5)
  flow.gap(8)

  // --- Two-column info grid ---
  flow.fieldGrid([
    ['Customer', val(a.customer), 'Assy Part Number', val(a.assy_part_number)],
    ['PO Number', val(a.po_number), 'Drawing Rev', val(a.drawing_revision)],
    ['Part # Ordered', val(a.part_number), 'TSO-C148', val(p.tso_c148)],
    ['Qty Shipped', val(fd.quantity_shipped ?? a.good_qty), 'Conflict Minerals', yesNo(p.conflict_minerals)],
    ['Lot Number', val(fd.lot_number ?? a.finishing_lot_number), 'RoHS', yesNo(p.rohs_compliant)],
    ['Assy Country', val(p.assy_country_of_origin), 'Cert Pkg Emailed To', val(fd.emailed_to)],
  ])
  flow.gap(6)

  // --- TSO equivalents row ---
  flow.fieldGrid([
    ['Camloc Equivalent', val(p.camloc_equivalent), 'Monadnock Equivalent', val(p.monadnock_equivalent)],
  ])
  flow.gap(6)

  // --- Assembly Lot / Plating / NADCAP / Primer block ---
  // Assembly Lot Number(s) is a form_data entry (manually entered until the
  // assembly module writes work_order_assemblies.assembly_lot_number, which is
  // what prefills it). The live assembly lots remain the fallback.
  const assemblyLots = (a.assemblies || []).map((x) => x.assembly_lot_number).filter(Boolean).join(', ')
  flow.fieldGrid([
    ['Assembly Lot Number (s)', val(fd.assembly_lot_number || assemblyLots), 'Primer', val(p.primer)],
    ['NADCAP Plating', yesNo(p.nadcap_plating), 'NADCAP Heat Treat', yesNo(p.nadcap_heat_treat)],
  ])
  flow.gap(8)

  // --- Component table ---
  flow.text('Component Traceability', { size: 9, f: bold, gapAfter: 3 })
  const compCols = [
    { title: 'Description', w: 0.30 },
    { title: 'Component Origin', w: 0.16 },
    { title: 'Final Lot #', w: 0.18 },
    { title: 'Production Lot #', w: 0.18 },
    { title: 'Material Lot # / Heat', w: 0.18 },
  ]
  const overrides = fd.material_lot_overrides || {}
  const heats = fd.heat_number_overrides || {}
  // Paper QMS-10.4 prints the material lot alone ('79015990') when no heat is
  // recorded, and 'lot / heat' when there is one.
  const lotHeat = (c) => {
    const lot = String(overrides[c.part_number] ?? (c.material_lots || []).join(', ') ?? '').trim()
    const heat = String(heats[c.part_number] ?? '').trim()
    if (lot && heat) return `${lot} / ${heat}`
    return lot || heat
  }
  const compRows = (a.components || []).map((c) => [
    `${c.part_number}${c.description ? ' — ' + c.description : ''}`,
    val(c.component_origin),
    (c.final_lots || []).join(', ') || '—',
    (c.production_lots || []).join(', ') || '—',
    val(lotHeat(c)),
  ])
  if (compRows.length === 0) compRows.push(['—', '—', '—', '—', '—'])
  flow.table(compCols, compRows)
  flow.gap(8)

  // --- Lot Assembly Test row ---
  flow.text('Lot Assembly Test', { size: 9, f: bold, gapAfter: 3 })
  flow.fieldGrid([
    ['Date', val(fd.test_date), 'Performance', val(fd.test_performance)],
    ['Inspector', val(fd.test_inspector), 'Calibration Due', val(fd.test_calibration_due)],
  ])
  flow.gap(6)

  // --- Quality Control Release row ---
  flow.text('Quality Control Release', { size: 9, f: bold, gapAfter: 3 })
  flow.fieldGrid([
    ['Date', val(fd.qc_date), 'Quantity', val(fd.qc_quantity ?? a.good_qty)],
    ['Inspector', val(fd.qc_inspector), '', ''],
  ])
  flow.gap(10)

  // --- Certificate of Conformance paragraphs (verbatim QMS-10.4 Rev 003) ---
  flow.text('CERTIFICATE OF CONFORMANCE', { size: 10, f: bold, gapAfter: 4 })
  for (const para of CERT_PARAGRAPHS) {
    flow.text(para, { size: 8, gapAfter: 5, lineGap: 2 })
  }

  // --- DFARs compliance line (left) + Cage Code (right), same line ---
  flow.ensure(16)
  flow.gap(2)
  const dfarsTxt = safe(`DFARs Compliance:  48CFR ${'§'} 252.225-7009   ${p.dfars_compliant ? 'YES' : 'NO'}`)
  const cageTxt = safe(`Cage Code ${CAGE_CODE}`)
  flow.page.drawText(dfarsTxt, { x: flow.left, y: flow.y - 8, size: 8, font: bold, color: BLACK })
  flow.page.drawText(cageTxt, { x: flow.right - bold.widthOfTextAtSize(cageTxt, 8), y: flow.y - 8, size: 8, font: bold, color: BLACK })
  flow.gap(14)

  // --- Approved Signatory block ---
  flow.ensure(80)
  flow.hline(GRAY, 0.5)
  flow.gap(6)
  flow.text('Approved Signatory:', { size: 9, f: bold, gapAfter: 2 })
  const sigTop = flow.y
  // signature image
  if (sign.signature_image_path && fetchBytes) {
    try {
      const bytes = await fetchBytes(sign.signature_image_path)
      const img = await embedImage(pdf, bytes)
      if (img) {
        const w = 150, h = Math.min(44, (img.height / img.width) * w)
        flow.page.drawImage(img, { x: flow.left, y: sigTop - h, width: w, height: h })
      }
    } catch { /* fall through to typed name only */ }
  }
  // stamp image (to the right of the signature)
  if (sign.stamp_image_path && fetchBytes) {
    try {
      const bytes = await fetchBytes(sign.stamp_image_path)
      const img = await embedImage(pdf, bytes)
      if (img) {
        const sw = 70, sh = Math.min(56, (img.height / img.width) * sw)
        flow.page.drawImage(img, { x: flow.right - sw, y: sigTop - sh, width: sw, height: sh })
      }
    } catch { /* stamp optional */ }
  }
  flow.y = sigTop - 48
  flow.page.drawLine({ start: { x: flow.left, y: flow.y }, end: { x: flow.left + 220, y: flow.y }, thickness: 0.5, color: BLACK })
  flow.gap(2)
  flow.text(sign.approver_name || '', { size: 9, f: bold, gapAfter: 1 })
  flow.text(sign.title || 'Quality Engineer', { size: 8, color: GRAY, gapAfter: 1 })
  flow.text(`Date: ${sign.approved_date ? new Date(sign.approved_date).toLocaleDateString() : '-'}`, { size: 8, color: GRAY, gapAfter: 2 })

  // --- Footer ---
  const genDate = sign.approved_date ? new Date(sign.approved_date).toLocaleString() : ''
  flow.page.drawText('QMS-10.4  Rev 003', { x: flow.left, y: MARGIN - 6, size: 7, font, color: GRAY })
  const rightTxt = safe(`Package ${snapshot.package_number || ''}  ${'·'}  Generated ${genDate}`)
  flow.page.drawText(rightTxt, { x: flow.right - font.widthOfTextAtSize(rightTxt, 7), y: MARGIN - 6, size: 7, font, color: GRAY })
}

// ---------------------------------------------------------------------------
// Job Traveler pages (Skybolt Form 10-100 equivalent)
// ---------------------------------------------------------------------------
// Generated directly into the package PDF from the frozen traveler dataset
// (src/lib/traveler.js buildTravelerModel) — never a screenshot or a raster of
// the React print page. The dataset is captured in the snapshot at approval, so
// these pages stay identical forever even as the live job data moves on.
// `extra` carries the package's own header values (heat/lot #, TSO rev).
export function renderTravelerPages(pdf, font, bold, traveler, extra = {}) {
  if (!traveler) return
  const flow = newFlow(pdf, font, bold)
  const dateOnly = (d) => (d ? new Date(d).toLocaleDateString() : '')

  // --- Skybolt header ---
  flow.text('SKYBOLT AEROMOTIVE CORPORATION', { size: 14, f: bold, align: 'center', gapAfter: 2 })
  flow.text('JOB TRAVELER', { size: 12, f: bold, align: 'center', gapAfter: 3 })
  flow.text('9000 Airport Blvd  Leesburg, Florida 34788  352-326-0001', { size: 8, color: GRAY, align: 'center', gapAfter: 6 })
  flow.hline(BLACK, 1.5)
  flow.gap(8)

  // --- Header fields (Form 10-100) ---
  flow.fieldGrid([
    ['Part Number', val(traveler.part_number), 'Job Number', val(traveler.job_number)],
    ['Part Name', val(traveler.description), 'Order / WO #', val(traveler.wo_number)],
    ['Final Process', val(traveler.final_process), 'PO Number', val(traveler.po_number)],
    ['Manufacturing # (PLN)', val(traveler.production_lot_number), 'Customer', val(traveler.customer)],
    ['Heat / Lot #', val(extra.heat_lot ?? traveler.finishing_lot_number), 'Quantity', val(traveler.quantity_display)],
    ['Material', val(traveler.material), 'Due Date', val(dateOnly(traveler.due_date))],
    ['Drawing Rev', val(traveler.drawing_revision), 'TSO Rev', val(extra.tso_rev ?? traveler.tso_rev)],
  ])
  flow.gap(8)

  // --- Process / operations table ---
  flow.text('Process', { size: 9, f: bold, gapAfter: 3 })
  const cols = [
    { title: 'Step', w: 0.05 },
    { title: 'Process', w: 0.24 },
    { title: 'Station / Vendor', w: 0.17 },
    { title: 'Type', w: 0.05 },
    { title: 'New Lot #', w: 0.23 },
    { title: 'Qty', w: 0.06 },
    { title: 'Date', w: 0.10 },
    { title: 'Oper.', w: 0.10 },
  ]
  const rows = (traveler.rows || []).map((r) => [
    String(r.step_order ?? ''),
    `${r.step_name || ''}${r.is_added_step ? ' *' : ''}${r.batch_label ? ' ' + r.batch_label : ''}`,
    r.station || '',
    r.type || '',
    r.lot || '',
    r.qty || '',
    r.date || '',
    r.operator || '',
  ])
  if (rows.length === 0) rows.push(['', 'No routing steps recorded.', '', '', '', '', '', ''])
  flow.table(cols, rows)
  flow.gap(10)

  // --- Notes ---
  flow.text('Notes', { size: 9, f: bold, gapAfter: 3 })
  flow.ensure(46)
  flow.page.drawRectangle({
    x: flow.left, y: flow.y - 44, width: flow.width, height: 44,
    borderColor: BLACK, borderWidth: 0.5,
  })
  flow.gap(48)

  // --- Footer: form reference + generation date ---
  flow.page.drawText('Form 10-100  Job Traveler', { x: flow.left, y: MARGIN - 6, size: 7, font, color: GRAY })
  const genTxt = safe(`Generated from SkyNet MES  ${extra.generated_at ? new Date(extra.generated_at).toLocaleString() : ''}`)
  flow.page.drawText(genTxt, { x: flow.right - font.widthOfTextAtSize(genTxt, 7), y: MARGIN - 6, size: 7, font, color: GRAY })
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------
async function mergePdf(pdf, bytes) {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const pages = await pdf.copyPages(src, src.getPageIndices())
  for (const pg of pages) pdf.addPage(pg)
}

async function mergeImagePage(pdf, bytes) {
  const img = await embedImage(pdf, bytes)
  if (!img) throw new Error('image decode failed')
  const page = pdf.addPage([PAGE_W, PAGE_H])
  const maxW = PAGE_W - MARGIN * 2
  const maxH = PAGE_H - MARGIN * 2
  const scale = Math.min(maxW / img.width, maxH / img.height, 1)
  const w = img.width * scale
  const h = img.height * scale
  page.drawImage(img, { x: (PAGE_W - w) / 2, y: (PAGE_H - h) / 2, width: w, height: h })
}

async function mergeSpreadsheet(pdf, font, bold, bytes, doc) {
  const wb = XLSX.read(bytes, { type: 'array' })
  const flow = newFlow(pdf, font, bold)
  flow.text(`Spreadsheet: ${doc.file_name || 'workbook'}`, { size: 11, f: bold, gapAfter: 4 })
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' })
    flow.gap(4)
    flow.text(`Sheet: ${name}`, { size: 9, f: bold, gapAfter: 3 })
    if (!grid.length) { flow.text('(empty)', { size: 8, color: GRAY }); continue }
    const maxCols = Math.min(8, Math.max(...grid.map((r) => r.length)))
    const cols = Array.from({ length: maxCols }, () => ({ w: 1 }))
    const rows = grid.map((r) => {
      const cells = []
      for (let i = 0; i < maxCols; i++) {
        // fold any overflow columns into the last cell
        if (i === maxCols - 1 && r.length > maxCols) {
          cells.push(r.slice(i).map((c) => String(c ?? '')).join(' | '))
        } else {
          cells.push(String(r[i] ?? ''))
        }
      }
      return cells
    })
    flow.table(cols, rows, { size: 7 })
  }
}

function drawSeparateAttachmentsPage(pdf, font, bold, skipped) {
  const flow = newFlow(pdf, font, bold)
  flow.text('Separate Attachments', { size: 14, f: bold, gapAfter: 4 })
  flow.text('The following source files could not be embedded in this package and are provided separately. They remain on file in the Cert Repository.', { size: 9, gapAfter: 8 })
  const cols = [
    { title: 'Component', w: 0.3 },
    { title: 'File', w: 0.5 },
    { title: 'Reason', w: 0.2 },
  ]
  flow.table(cols, skipped.map((s) => [s.component_part_number || '—', s.file_name || s.file_path || '—', s.reason || 'unsupported type']))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export async function generateCertPackagePdf(snapshot, { fetchBytes } = {}) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)

  const merged = []
  const skipped = []

  // 1. cover (always first — not part of the arrangement)
  await drawCover(pdf, font, bold, snapshot, fetchBytes)

  // Heat / Lot # for the traveler header: the certified part's own entry.
  const fd = snapshot.formData || {}
  const certPart = snapshot.autoFields?.part_number
  const travelerExtra = {
    heat_lot: (() => {
      const lot = String(fd.material_lot_overrides?.[certPart] ?? '').trim()
      const heat = String(fd.heat_number_overrides?.[certPart] ?? '').trim()
      if (lot && heat) return `${lot} / ${heat}`
      return lot || heat || null
    })(),
    tso_rev: snapshot.profileFields?.tso_c148 || null,
    generated_at: snapshot.signing?.approved_date || snapshot.frozen_at || null,
  }

  // 2. merge in the compliance-arranged order (traveler + included documents)
  for (const doc of snapshot.mergeList || []) {
    if (doc.kind === 'traveler') {
      if (!snapshot.traveler) {
        skipped.push({ file_name: 'Job Traveler (generated)', reason: 'traveler data unavailable' })
        continue
      }
      try {
        renderTravelerPages(pdf, font, bold, snapshot.traveler, travelerExtra)
        merged.push({ file_name: 'Job Traveler (generated)', component_part_number: null, as: 'traveler' })
      } catch (err) {
        skipped.push({ file_name: 'Job Traveler (generated)', reason: 'traveler render failed: ' + (err.message || 'error') })
      }
      continue
    }
    const ext = extOf(doc.file_name || doc.file_path)
    let bytes = null
    try {
      bytes = fetchBytes ? await fetchBytes(doc.file_path) : null
    } catch { bytes = null }
    if (!bytes) { skipped.push({ ...doc, reason: 'unreadable' }); continue }

    try {
      if (ext === 'pdf') {
        await mergePdf(pdf, bytes)
        merged.push({ ...doc, as: 'pdf' })
      } else if (['jpg', 'jpeg', 'png'].includes(ext)) {
        await mergeImagePage(pdf, bytes)
        merged.push({ ...doc, as: 'image' })
      } else if (['xls', 'xlsx', 'xlsm'].includes(ext)) {
        await mergeSpreadsheet(pdf, font, bold, bytes, doc)
        merged.push({ ...doc, as: 'spreadsheet' })
      } else {
        skipped.push({ ...doc, reason: `unsupported type (.${ext || 'unknown'})` })
      }
    } catch (err) {
      skipped.push({ ...doc, reason: 'conversion failed: ' + (err.message || 'error') })
    }
  }

  // 3. separate attachments page
  if (skipped.length) drawSeparateAttachmentsPage(pdf, font, bold, skipped)

  const bytes = await pdf.save()
  const conversionManifest = {
    generated_at: snapshot.signing?.approved_date || null,
    merged: merged.map((m) => ({ file_name: m.file_name, component: m.component_part_number, as: m.as })),
    skipped: skipped.map((s) => ({ file_name: s.file_name, component: s.component_part_number, reason: s.reason })),
  }
  return { bytes, conversionManifest }
}
