//
// Quotation PDF (S11 C2, D-PRICE-23). pdf-lib, client-side, from the saved quotes /
// quote_lines rows. Layout follows the Fishbowl SO Acknowledgement Skybolt already
// sends: header block, Quote # / Date / Valid until box, Bill To, rep / terms strip,
// line table (Number, Description, Unit, Qty, Total), subtotal, returns terms.
//
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { money, num, TIER_LABELS } from './pricing'
import { BRAND, safe, drawLetterhead } from './pdfText'

const LETTER = [612, 792]
const M = 40
const INK = BRAND.ink, GREY = BRAND.grey, LINE = BRAND.line, ACCENT = BRAND.red, BAND = BRAND.band
export const QUOTE_TERMS = 'Prices are in US dollars, per piece, FOB Origin, valid through the date shown; orders received after that date are re-priced from the current price book. Lead time quoted at time of order. RETURNS MUST BE WITHIN 30 DAYS AFTER PRIOR APPROVAL FROM SKYBOLT. CUSTOMER IS RESPONSIBLE FOR FREIGHT & 30% RESTOCKING FEE. ALL RETURNS MUST HAVE A RETURN AUTHORIZATION NUMBER AND MUST BE IN THE ORIGINAL PACKAGING.'

function wrap(text, font, size, width) {
  const words = safe(text).split(/\s+/); const lines = []; let cur = ''
  for (const w of words) { const t = cur ? cur + ' ' + w : w; if (font.widthOfTextAtSize(t, size) <= width) cur = t; else { if (cur) lines.push(cur); cur = w } }
  if (cur) lines.push(cur)
  return lines
}
export function quoteFilename(q) {
  const cust = String(q.customer_name || 'customer').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)
  return `Skybolt_Quote_${q.quote_number}_${cust}.pdf`
}

export async function buildQuotePdf(q, lines) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold), mono = await pdf.embedFont(StandardFonts.Courier)
  const [W, H] = LETTER
  const col = { num: M, desc: M + 118, unit: W - M - 200, qty: W - M - 120, total: W - M }
  const descW = col.unit - col.desc - 60
  let page, y, pageNo = 0
  const rightAt = (t, x, yy, size, f, color) => { const s = safe(t); page.drawText(s, { x: x - f.widthOfTextAtSize(s, size), y: yy, size, font: f, color }) }
  const right = (t, x, size, f, color) => rightAt(t, x, y, size, f, color)
  const header = async () => {
    pageNo += 1; page = pdf.addPage(LETTER); y = H - M
    const afterLogo = await drawLetterhead(pdf, page, { x: M, top: y, logoWidth: 190 })
    ;['Skybolt Aeromotive Corp', '9000 Airport Boulevard, Leesburg, FL 34788', '(352) 326-0001 · skybolt.com'].forEach((t, i) => page.drawText(t, { x: M, y: afterLogo - 8 - i * 10, size: 8, font: i === 0 ? bold : font, color: i === 0 ? INK : GREY }))
    page.drawText('QUOTATION', { x: W - M - bold.widthOfTextAtSize('QUOTATION', 18), y: y - 16, size: 18, font: bold, color: ACCENT })
    // Quote # / Date / Valid box
    const bx = W - M - 230, by = y - 60, bw = 230
    page.drawRectangle({ x: bx, y: by, width: bw, height: 34, borderColor: LINE, borderWidth: 0.8 })
    page.drawRectangle({ x: bx, y: by + 17, width: bw, height: 17, color: BAND })
    const cells = [['Quote #', q.quote_number], ['Date', String(q.issued_on)], ['Valid until', String(q.valid_until)]]
    cells.forEach(([k, v], i) => {
      const cx = bx + i * (bw / 3), cw = bw / 3
      page.drawText(k, { x: cx + (cw - bold.widthOfTextAtSize(k, 8)) / 2, y: by + 22, size: 8, font: bold, color: INK })
      page.drawText(safe(v), { x: cx + (cw - mono.widthOfTextAtSize(safe(v), 8)) / 2, y: by + 5, size: 8, font: mono, color: INK })
    })
    y = Math.min(y - 78, afterLogo - 44)
    if (pageNo === 1) {
      // Bill to
      page.drawRectangle({ x: M, y: y - 52, width: (W - 2 * M) / 2 - 8, height: 60, borderColor: LINE, borderWidth: 0.8 })
      page.drawRectangle({ x: M, y: y - 6, width: (W - 2 * M) / 2 - 8, height: 14, color: BAND })
      page.drawText('Quote To:', { x: M + 4, y: y - 3, size: 8, font: bold, color: INK })
      const who = [q.customer_name + (q.customer_number ? `  (#${q.customer_number})` : ''), q.contact_name || '', q.contact_email || ''].filter(Boolean)
      who.forEach((t, i) => page.drawText(safe(t), { x: M + 4, y: y - 20 - i * 11, size: 9, font, color: INK }))
      // pricing level / PO on the right
      const rx = M + (W - 2 * M) / 2 + 8
      page.drawRectangle({ x: rx, y: y - 52, width: (W - 2 * M) / 2 - 8, height: 60, borderColor: LINE, borderWidth: 0.8 })
      page.drawRectangle({ x: rx, y: y - 6, width: (W - 2 * M) / 2 - 8, height: 14, color: BAND })
      page.drawText('Reference:', { x: rx + 4, y: y - 3, size: 8, font: bold, color: INK })
      const ref = [`Pricing level: ${TIER_LABELS[q.tier] || 'List / quantity breaks'}`, q.customer_po ? `Customer PO / RFQ: ${q.customer_po}` : '', `Price book: ${q.rev_label || ''} (as of ${q.as_of})`].filter(Boolean)
      ref.forEach((t, i) => page.drawText(safe(t), { x: rx + 4, y: y - 20 - i * 11, size: 9, font, color: INK }))
      y -= 64
      // strip: Sales rep | Payment terms | FOB | Prepared
      const strip = [['Sales Rep', q.created_by_name || ''], ['Payment Terms', q.payment_terms || 'Per account terms'], ['FOB Point', 'Origin'], ['Prepared', String(q.created_at || '').slice(0, 10)]]
      const sw = (W - 2 * M) / strip.length
      page.drawRectangle({ x: M, y: y - 26, width: W - 2 * M, height: 28, borderColor: LINE, borderWidth: 0.8 })
      page.drawRectangle({ x: M, y: y - 12, width: W - 2 * M, height: 14, color: BAND })
      strip.forEach(([k, v], i) => {
        const sv = safe(v)
        page.drawText(k, { x: M + i * sw + (sw - bold.widthOfTextAtSize(k, 8)) / 2, y: y - 9, size: 8, font: bold, color: INK })
        page.drawText(sv, { x: M + i * sw + (sw - font.widthOfTextAtSize(sv, 8)) / 2, y: y - 22, size: 8, font, color: INK })
      })
      y -= 40
      if (q.notes) { for (const ln of wrap(q.notes, font, 8, W - 2 * M)) { page.drawText(ln, { x: M, y, size: 8, font, color: INK }); y -= 10 } y -= 4 }
    }
    // table head
    page.drawRectangle({ x: M, y: y - 14, width: W - 2 * M, height: 16, color: BAND })
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 1.2, color: ACCENT })
    page.drawText('Number', { x: col.num, y: y - 10, size: 8, font: bold, color: INK })
    page.drawText('Description', { x: col.desc, y: y - 10, size: 8, font: bold, color: INK })
    rightAt('Unit Price', col.unit, y - 10, 8, bold, INK); rightAt('Qty', col.qty, y - 10, 8, bold, INK); rightAt('Total', col.total, y - 10, 8, bold, INK)
    y -= 22
    page.drawText(`Page ${pageNo}`, { x: W - M - font.widthOfTextAtSize(`Page ${pageNo}`, 7), y: M - 14, size: 7, font, color: GREY })
  }
  await header()
  for (const l of lines) {
    const dl = wrap(l.description || '', font, 8, descW)
    const rowH = Math.max(1, dl.length) * 10 + 5
    if (y - rowH < M + 110) await header()
    page.drawText(safe(l.part_number), { x: col.num, y: y - 8, size: 8, font: mono, color: INK })
    dl.forEach((ln, i) => page.drawText(ln, { x: col.desc, y: y - 8 - i * 10, size: 8, font, color: INK }))
    const yy = y; y = yy - 8
    right(money(l.unit_price, Number(l.unit_price) < 1 ? 4 : 2), col.unit, 8, mono, INK)
    right(`${num(l.qty)} ea`, col.qty, 8, mono, INK)
    right(money(l.extended), col.total, 8, mono, INK)
    y = yy - rowH
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 0.4, color: LINE })
  }
  if (y < M + 110) await header()
  y -= 8
  const tot = [['Subtotal:', money(q.subtotal)], ['Sales Tax:', '$0.00'], ['Total:', money(q.subtotal)]]
  tot.forEach(([k, v], i) => {
    const yy = y - i * 14
    if (i === 2) page.drawRectangle({ x: W - M - 200, y: yy - 4, width: 200, height: 14, color: BAND })
    const sk = safe(k), sv = safe(v)
    page.drawText(sk, { x: W - M - 110 - bold.widthOfTextAtSize(sk, 9), y: yy, size: 9, font: bold, color: INK })
    page.drawText(sv, { x: W - M - 6 - (i === 2 ? bold : mono).widthOfTextAtSize(sv, 9), y: yy, size: 9, font: i === 2 ? bold : mono, color: INK })
  })
  y -= 14 * 3 + 16
  for (const ln of wrap(QUOTE_TERMS, font, 7, W - 2 * M)) { page.drawText(ln, { x: M, y, size: 7, font, color: GREY }); y -= 9 }
  pdf.setTitle(`Skybolt Quotation ${q.quote_number}`); pdf.setAuthor('Skybolt Aeromotive Corp')
  return pdf.save()
}
