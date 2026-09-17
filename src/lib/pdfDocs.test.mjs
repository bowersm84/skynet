// Unit test for the customer PDFs (D-PRICE-52 addendum): US dates, no FOB.
// Run: node src/lib/pdfDocs.test.mjs
//
// Renders the REAL builders and reads the text back out of the rendered pages, because the
// thing under test is what the customer sees on paper, not what a helper returns. quoteDoc
// and priceListDoc both import pricing.js, which constructs the Supabase client from
// import.meta.env and cannot load outside Vite, so all three modules are copied to temp
// siblings with that one import stubbed and the extensionless imports given a .js (Vite
// resolves those, Node does not). Nothing else is rewritten.
//
// The logo is fetched from '/skybolt_logo.jpg', which has no origin under Node; drawLetterhead
// swallows that and falls back to the text letterhead (D-PRICE-33), so the render still runs.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const shims = []
function shim(name) {
  const out = path.join(dir, `_${name}.undertest.mjs`)
  const src = fs.readFileSync(path.join(dir, `${name}.js`), 'utf8')
    .replace("import { supabase } from './supabase'", 'const supabase = { from: () => { throw new Error("no I/O in this test") } }')
    .replace(/from '\.\/pricing'/g, "from './_pricing.undertest.mjs'")
    .replace(/from '\.\/pricingView'/g, "from './pricingView.js'")
    .replace(/from '\.\/pdfText'/g, "from './pdfText.js'")
  fs.writeFileSync(out, src)
  shims.push(out)
  return pathToFileURL(out).href
}

let n = 0
const ok = (cond, msg) => { assert.ok(cond, msg); n++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++ }

// Every string pdf-lib drew, in page order. Content streams are plain in an uncompressed
// save and Flate-compressed otherwise, so both are tried; PDF string escapes are undone.
function pdfText(bytes) {
  const raw = Buffer.from(bytes)
  const chunks = [raw.toString('latin1')]
  const re = /stream\r?\n/g
  let m
  while ((m = re.exec(chunks[0])) !== null) {
    const start = m.index + m[0].length
    const end = chunks[0].indexOf('endstream', start)
    if (end < 0) continue
    try { chunks.push(zlib.inflateSync(raw.subarray(start, end)).toString('latin1')) } catch { /* not deflate */ }
  }
  const out = []
  for (const c of chunks) {
    // pdf-lib shows text as either a literal string or, for a standard (WinAnsi) font, a hex
    // string of one byte per character. Both end in Tj.
    for (const s of c.matchAll(/(?:\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]*)>)\s*Tj/g)) {
      if (s[1] !== undefined) {
        out.push(s[1].replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\([()\\])/g, '$1'))
      } else {
        const hex = s[2].replace(/\s+/g, '')
        let t = ''
        for (let i = 0; i + 1 < hex.length; i += 2) t += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
        out.push(t)
      }
    }
  }
  return out.join('\n')
}

try {
  const pricingUrl = shim('pricing')
  const { fmtUsDate } = await import(pricingUrl)
  const { buildQuotePdf, QUOTE_TERMS } = await import(shim('quoteDoc'))
  const { buildPriceListPdf, buildPriceListXlsx } = await import(shim('priceListDoc'))

  // ── the formatter ───────────────────────────────────────────────────────────────
  eq(fmtUsDate('2026-09-16'), '09/16/2026', 'an ISO date prints US style')
  eq(fmtUsDate('2026-01-02'), '01/02/2026', 'January 2nd is 01/02, not 1/2')
  eq(fmtUsDate('2026-09-16T14:22:31.123Z'), '09/16/2026', 'a timestamp is cut at its date')
  eq(fmtUsDate('2026-01-01T03:00:00.000Z'), '01/01/2026', 'and is read as text, so an early-hours UTC timestamp does not print as the day before')
  eq(fmtUsDate(''), '', 'an empty date stays empty rather than becoming a fake one')
  eq(fmtUsDate(null), '', 'and so does a missing one')
  eq(fmtUsDate(undefined), '', 'undefined too')
  eq(fmtUsDate('Per account terms'), 'Per account terms', 'anything that is not a date is returned untouched')
  eq(fmtUsDate('09/16/2026'), '09/16/2026', 'an already-formatted date is left alone')

  // ── the quote ───────────────────────────────────────────────────────────────────
  const quote = {
    quote_number: 'Q-2609-0001', customer_name: 'Irwin Aerospace', customer_number: '10842', tier: 'tier3',
    contact_name: 'Dana Reyes', contact_email: 'dana@example.com', customer_po: 'PO-55120',
    rev_label: 'Rev 81 — Jun 2026', as_of: '2026-09-16', issued_on: '2026-09-16', valid_until: '2026-09-30',
    payment_terms: 'Net 30', notes: 'Lead time quoted at time of order.', subtotal: 431.9,
    created_by_name: 'April Braun', created_at: '2026-09-16T14:22:31.123Z',
  }
  const quoteLines = [
    { id: 1, part_number: 'SK2600-1SFW', description: 'Skybolt CLoc 2600 stud, flush head', qty: 40, unit_price: 9.53, extended: 381.2 },
    { id: 2, part_number: 'SK213-2', description: 'Receptacle', qty: 6, unit_price: 8.45, extended: 50.7 },
  ]
  const qText = pdfText(await buildQuotePdf(quote, quoteLines))
  ok(qText.includes('Q-2609-0001') && qText.includes('Irwin Aerospace'), 'the quote rendered and carries its number and customer')

  const usDate = /^\d{2}\/\d{2}\/\d{4}$/
  ok(usDate.test('09/16/2026'), 'the date pattern under test is MM/DD/YYYY')
  ok(qText.includes('09/16/2026'), 'Date and Prepared print 09/16/2026')
  ok(qText.includes('09/30/2026'), 'Valid until prints 09/30/2026')
  ok(qText.includes('(as of 09/16/2026)'), 'the price-book as-of date is US style too')
  const qIso = qText.match(/\d{4}-\d{2}-\d{2}/g)
  eq(qIso, null, `no ISO date is left anywhere on the quote (found ${qIso && qIso.join(', ')})`)
  // Each date the header box and the strip draw is its own Tj string, so they can be counted.
  const qDates = pdfText(await buildQuotePdf(quote, quoteLines)).split('\n').filter(s => usDate.test(s))
  eq(qDates.length, 3, 'exactly three dates are drawn as standalone cells: Date, Valid until, Prepared')
  ok(qDates.every(d => usDate.test(d)), 'and every one of them is MM/DD/YYYY')

  ok(!/FOB/i.test(qText), 'FOB appears nowhere on the rendered quote')
  ok(!/FOB/i.test(QUOTE_TERMS), 'and nowhere in the terms sentence')
  ok(QUOTE_TERMS.startsWith('Prices are in US dollars, per piece, valid through the date shown;'), 'the terms read cleanly without it')
  ok(qText.includes('Sales Rep') && qText.includes('Payment Terms') && qText.includes('Prepared'), 'the three remaining strip columns are still drawn')
  ok(qText.includes('April Braun') && qText.includes('Net 30'), 'with their values')

  // ── the price list ──────────────────────────────────────────────────────────────
  const list = {
    list_number: 'PL-2609-0007', customer_name: 'Irwin Aerospace', customer_number: '10842', tier: 'tier3',
    as_of: '2026-10-01', rev_label: 'Rev 82 — Oct 2026', created_by_name: 'April Braun',
    created_at: '2026-09-16T14:22:31.123Z', notes: 'Prices effective with the October book.',
  }
  const listLines = [
    { part_number: 'SK2600-1SFW', description: 'Skybolt CLoc 2600 stud, flush head', each_price: 11.853, customer_price: 7.11 },
    { part_number: 'SK213-2', description: 'Receptacle', each_price: 8.77, customer_price: 5.26 },
  ]
  const lText = pdfText(await buildPriceListPdf(list, listLines))
  ok(lText.includes('PL-2609-0007') && lText.includes('Irwin Aerospace'), 'the price list rendered')
  ok(lText.includes('10/01/2026'), 'Effective prints 10/01/2026')
  ok(lText.includes('09/16/2026'), 'Issued prints 09/16/2026')
  const lIso = lText.match(/\d{4}-\d{2}-\d{2}/g)
  eq(lIso, null, `no ISO date is left anywhere on the price list (found ${lIso && lIso.join(', ')})`)
  const lDates = lText.split('\n').filter(s => usDate.test(s))
  eq(lDates.length, 2, 'exactly two dates are drawn as cells: Effective and Issued')
  ok(!/FOB/i.test(lText), 'FOB appears nowhere on the rendered price list')

  // ── the builders still work ─────────────────────────────────────────────────────
  ok(lText.includes('SK2600-1SFW') && lText.includes('SK213-2'), 'every line still prints')
  ok(qText.includes('SK2600-1SFW') && qText.includes('SK213-2'), 'on both documents')
  ok(buildPriceListXlsx(list, listLines).byteLength > 0, 'the price-list XLSX still builds (untouched by this change: its header keeps the ISO date)')

  console.log(`pdfDocs: ${n} assertions passed`)
} finally {
  for (const f of shims) fs.rmSync(f, { force: true })
}
