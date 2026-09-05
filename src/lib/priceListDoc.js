//
// Customer price list documents (S11 C1, D-PRICE-21). PDF via pdf-lib, XLSX via
// SheetJS — both client-side, both from the saved price_lists / price_list_lines
// rows so a reissue is byte-for-byte what the customer received.
//
import { PDFDocument, StandardFonts } from 'pdf-lib'
import * as XLSX from 'xlsx'
import { money, TIER_LABELS } from './pricing'
import { BRAND, safe, drawLetterhead } from './pdfText'

const LETTER = [612, 792]
const MARGIN = 40
const INK = BRAND.ink, GREY = BRAND.grey, LINE = BRAND.line, ACCENT = BRAND.red, BAND = BRAND.band
const TERMS = 'Prices are in US dollars, per piece, FOB Origin, and are subject to change without notice after the effective date shown. Quantity breaks do not apply to tiered pricing. DFAR = DFARS 252.225-7014 compliant material available on request. Returns must be within 30 days after prior approval from Skybolt; customer is responsible for freight and a 30% restocking fee; all returns must have a Return Authorization Number and be in the original packaging.'

function wrap(text, font, size, width) {
  const words = safe(text).split(/\s+/); const lines = []; let cur = ''
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w
    if (font.widthOfTextAtSize(t, size) <= width) cur = t
    else { if (cur) lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  return lines
}

export function priceListFilename(list, ext) {
  const cust = String(list.customer_name || 'customer').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)
  return `Skybolt_Price_List_${list.list_number}_${cust}.${ext}`
}

// list: price_lists row; lines: price_list_lines rows (sorted). Returns Uint8Array.
export async function buildPriceListPdf(list, lines) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const mono = await pdf.embedFont(StandardFonts.Courier)
  const [W, H] = LETTER
  const colX = { part: MARGIN, desc: MARGIN + 118, dfar: W - MARGIN - 190, each: W - MARGIN - 150, price: W - MARGIN - 70 }
  const descW = colX.dfar - colX.desc - 8
  let page, y

  const header = async (pageNo) => {
    page = pdf.addPage(LETTER)
    y = H - MARGIN
    const afterLogo = await drawLetterhead(pdf, page, { x: MARGIN, top: y, logoWidth: 190 })
    page.drawText('Skybolt Aeromotive Corp · 9000 Airport Boulevard, Leesburg, FL 34788 · (352) 326-0001', { x: MARGIN, y: afterLogo - 8, size: 8, font, color: GREY })
    page.drawText('CUSTOMER PRICE LIST', { x: W - MARGIN - bold.widthOfTextAtSize('CUSTOMER PRICE LIST', 14), y: y - 14, size: 14, font: bold, color: ACCENT })
    page.drawText(safe(list.list_number), { x: W - MARGIN - mono.widthOfTextAtSize(safe(list.list_number), 10), y: y - 28, size: 10, font: mono, color: GREY })
    y = afterLogo - 20
    page.drawLine({ start: { x: MARGIN, y }, end: { x: W - MARGIN, y }, thickness: 1.2, color: ACCENT })
    y -= 14
    if (pageNo === 1) {
      const left = [['Customer', `${list.customer_name}${list.customer_number ? `  (#${list.customer_number})` : ''}`], ['Pricing level', TIER_LABELS[list.tier] || 'List / quantity breaks'], ['Prepared by', list.created_by_name || '']]
      const right = [['Effective', String(list.as_of)], ['Price book', list.rev_label || ''], ['Issued', String(list.created_at || '').slice(0, 10)]]
      const rowH = 13
      left.forEach(([k, v], i) => { page.drawText(k.toUpperCase(), { x: MARGIN, y: y - i * rowH, size: 7, font: bold, color: GREY }); page.drawText(safe(v), { x: MARGIN + 70, y: y - i * rowH, size: 9, font, color: INK }) })
      right.forEach(([k, v], i) => { page.drawText(k.toUpperCase(), { x: W / 2 + 20, y: y - i * rowH, size: 7, font: bold, color: GREY }); page.drawText(safe(v), { x: W / 2 + 90, y: y - i * rowH, size: 9, font, color: INK }) })
      y -= rowH * 3 + 6
      if (list.notes) { for (const ln of wrap(list.notes, font, 8, W - 2 * MARGIN)) { page.drawText(ln, { x: MARGIN, y, size: 8, font, color: INK }); y -= 10 } y -= 4 }
    }
    // table head
    page.drawRectangle({ x: MARGIN, y: y - 14, width: W - 2 * MARGIN, height: 16, color: BAND })
    const th = (t, x, right) => page.drawText(t, { x: right ? x - bold.widthOfTextAtSize(t, 7) : x, y: y - 10, size: 7, font: bold, color: GREY })
    th('PART NUMBER', colX.part); th('DESCRIPTION', colX.desc); th('DFAR', colX.dfar); th('LIST (EACH)', colX.each + 40, true); th('YOUR PRICE', W - MARGIN, true)
    y -= 22
    page.drawText(`Page ${pageNo}`, { x: W - MARGIN - font.widthOfTextAtSize(`Page ${pageNo}`, 7), y: MARGIN - 14, size: 7, font, color: GREY })
  }
  let pageNo = 1; await header(pageNo)
  for (const l of lines) {
    const descLines = wrap(l.description || '', font, 8, descW)
    const rowH = Math.max(1, descLines.length) * 10 + 4
    if (y - rowH < MARGIN + 70) { pageNo += 1; await header(pageNo) }
    page.drawText(safe(l.part_number), { x: colX.part, y: y - 8, size: 8, font: mono, color: INK })
    descLines.forEach((ln, i) => page.drawText(ln, { x: colX.desc, y: y - 8 - i * 10, size: 8, font, color: INK }))
    if (l.dfar) page.drawText('Y', { x: colX.dfar + 8, y: y - 8, size: 8, font, color: INK })
    const each = l.each_price !== null && l.each_price !== undefined ? money(l.each_price) : ''
    const yours = money(l.customer_price)
    page.drawText(each, { x: colX.each + 40 - mono.widthOfTextAtSize(each, 8), y: y - 8, size: 8, font: mono, color: GREY })
    page.drawText(yours, { x: W - MARGIN - mono.widthOfTextAtSize(yours, 8), y: y - 8, size: 8, font: bold, color: INK })
    y -= rowH
    page.drawLine({ start: { x: MARGIN, y: y + 2 }, end: { x: W - MARGIN, y: y + 2 }, thickness: 0.4, color: LINE })
  }
  // terms on the last page
  if (y < MARGIN + 80) { pageNo += 1; await header(pageNo) }
  y -= 10
  for (const ln of wrap(TERMS, font, 7, W - 2 * MARGIN)) { page.drawText(ln, { x: MARGIN, y, size: 7, font, color: GREY }); y -= 9 }
  pdf.setTitle(`Skybolt Price List ${list.list_number}`); pdf.setAuthor('Skybolt Aeromotive Corp')
  return pdf.save()
}

export function buildPriceListXlsx(list, lines) {
  const rows = [
    ['Skybolt Aeromotive Corp — Customer Price List', list.list_number],
    ['Customer', list.customer_name, 'Effective', String(list.as_of)],
    ['Pricing level', TIER_LABELS[list.tier] || 'List / quantity breaks', 'Price book', list.rev_label || ''],
    [],
    ['Part Number', 'Description', 'DFAR', 'List (Each)', 'Your Price'],
    ...lines.map(l => [l.part_number, l.description || '', l.dfar ? 'Y' : 'N', l.each_price === null ? '' : Number(l.each_price), Number(l.customer_price)]),
    [], [TERMS],
  ]
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = [{ wch: 20 }, { wch: 60 }, { wch: 6 }, { wch: 12 }, { wch: 12 }]
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, list.list_number)
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
}

export function downloadBytes(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
