//
// Catalog export (D-PRICE-52 B) — the whole book in effect as one internal XLSX.
//
// Internal: no letterhead, no terms, no customer — that is what a price list is for
// (D-PRICE-29). This is the sheet a rep keeps open beside the phone.
//
// Prices come from the CLIENT engine: the caller passes `price(item, colKey)`, which
// in the portal is columnPrice() closed over the book's meta and a part_key resolver.
// Injecting it keeps this module free of the Supabase import, so every rule below is
// unit-testable from Node — and it keeps the export off pricing_customer_sheet, whose
// `all` mode prices 4,800 rows one at a time (D-PRICE-50).
//
// A component_sum is all-or-nothing: if its Each does not resolve, the kit is SKIPPED,
// never exported at a partial or zero price (D-PRICE-48's $0.00 trap, D-PRICE-50).
//
import * as XLSX from 'xlsx'

const round2 = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round((Number(v) + Number.EPSILON) * 100) / 100)

// Ladder labels are bare breaks ("100") in most ladders but already decorated in a few
// ("2–4", "5+"), so only a plain number gets the "+".
function qtyLabel(label) {
  const s = String(label)
  return /^\d+$/.test(s) ? `${s}+` : s
}

// Column labels come from the book's own ladders, so a book that adds a column gets it
// in the picker with no code change. Order: Each, quantity columns by break ascending,
// tier columns, Premier last — the reading order of the printed book.
const TIER_ORDER = ['tier1', 'tier2', 'tier3']
export function catalogColumns(meta) {
  const qty = new Map(), tier = new Map()
  for (const l of Object.values(meta?.ladders || {})) {
    for (const c of l?.columns || []) {
      if (c.kind === 'qty') {
        if (!qty.has(c.key)) qty.set(c.key, { key: c.key, kind: 'qty', label: qtyLabel(c.label ?? c.key), min: Number(c.min) || 0 })
      } else if (!tier.has(c.key)) tier.set(c.key, { key: c.key, kind: 'tier', label: c.label || c.key })
    }
  }
  const qtyCols = [...qty.values()].sort((a, b) => a.min - b.min || a.key.localeCompare(b.key)).map(({ key, kind, label }) => ({ key, kind, label }))
  const tierCols = [...tier.values()].sort((a, b) => {
    const ia = TIER_ORDER.indexOf(a.key), ib = TIER_ORDER.indexOf(b.key)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.key.localeCompare(b.key)
  })
  return [{ key: 'each', kind: 'each', label: 'Each' }, ...qtyCols, ...tierCols, { key: 'premier', kind: 'tier', label: 'Premier' }]
}

// Rows for the sheet, in book order (section sort, then item sort).
//  items    — whole-book price_items, component_sum rows carrying `_components`
//  sections — meta.sections
//  columns  — the picked subset of catalogColumns()
//  price    — (item, colKey) => number | null
// Returns { rows, stats }. stats.skipped counts kits left out for an unpriced component.
export function catalogRows({ items, sections, columns, price }) {
  const secById = new Map((sections || []).map(s => [s.id, s]))
  const stats = { priced: 0, sums: 0, skipped: 0, no_price: 0 }
  const out = []
  for (const it of items || []) {
    if (it.status === 'no_price') { stats.no_price++; continue }
    if (it.status === 'component_sum') {
      // Resolution is judged on Each, never on the picked columns, so unticking Each
      // cannot turn an unresolved kit into an exported one.
      if (price(it, 'each') === null) { stats.skipped++; continue }
      stats.sums++
    } else if (it.list_price === null || it.list_price === undefined) {
      stats.no_price++; continue
    } else {
      stats.priced++
    }
    const sec = secById.get(it.section_id)
    out.push({
      sort: [sec?.sort ?? 9999, it.sort ?? 0],
      cells: [sec?.name || '', it.part_number, it.description || '', ...(columns || []).map(c => round2(price(it, c.key)))],
    })
  }
  out.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1])
  return { rows: out.map(r => r.cells), stats }
}

export function catalogFilename(book, iso) {
  const rev = String(book?.rev_label || 'book').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
  return `Skybolt_Catalog_${rev}_${iso}.xlsx`
}

// Excel sheet names: 31 chars, none of : \ / ? * [ ].
function sheetName(book) {
  const n = String(book?.rev_label || 'Catalog').replace(/[:\\/?*[\]]/g, '-').slice(0, 31)
  return n || 'Catalog'
}

// One sheet, frozen header, every price as 0.00. Returns a Uint8Array.
export function buildCatalogXlsx({ book, columns, rows }) {
  const header = ['Section', 'Part Number', 'Description', ...(columns || []).map(c => c.label)]
  const aoa = [header, ...rows]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const range = XLSX.utils.decode_range(ws['!ref'])
  for (let R = 1; R <= range.e.r; R++) {
    for (let C = 3; C <= range.e.c; C++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })]
      if (cell && cell.t === 'n') cell.z = '0.00'
    }
  }
  ws['!cols'] = [{ wch: 42 }, { wch: 20 }, { wch: 60 }, ...(columns || []).map(() => ({ wch: 12 }))]
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: header.length - 1 } }) }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName(book))
  return freezeTopRow(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })))
}

// ── Frozen header ───────────────────────────────────────────────────────────────
// SheetJS (community) writes a fixed <sheetViews> with no pane element and offers no
// hook for one, so the freeze is patched into the finished workbook: its zip entries
// are STORED (compression defaults to false), which means the sheet XML is sitting in
// the output as plain text and the file can be rebuilt without inflate or deflate.
// Anything unexpected — a compressed entry, no <sheetViews> — returns the bytes
// untouched, so the worst case is an export without the freeze, never a broken file.
const PANE = '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
const SHEET_VIEWS_RE = /<sheetViews>[\s\S]*?<\/sheetViews>/
const SHEET1 = 'xl/worksheets/sheet1.xml'
export function freezeTopRow(bytes) {
  try {
    const entries = readStoredZip(bytes)
    if (!entries) return bytes
    const sheet = entries.find(e => e.name === SHEET1)
    if (!sheet) return bytes
    const xml = new TextDecoder().decode(sheet.data)
    if (!SHEET_VIEWS_RE.test(xml)) return bytes
    sheet.data = new TextEncoder().encode(xml.replace(SHEET_VIEWS_RE, PANE))
    return writeStoredZip(entries)
  } catch { return bytes }
}

const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0
const u16 = (b, p) => b[p] | (b[p + 1] << 8)

// Sequential local file headers only — which is exactly what SheetJS emits (flags 0,
// method 0 STORE, no data descriptor, no extra field). Returns null for anything else.
function readStoredZip(b) {
  const out = []
  let p = 0
  while (p + 30 <= b.length && u32(b, p) === 0x04034b50) {
    const flags = u16(b, p + 6), method = u16(b, p + 8)
    const mtime = u32(b, p + 10)
    const csz = u32(b, p + 18), usz = u32(b, p + 22)
    const nlen = u16(b, p + 26), xlen = u16(b, p + 28)
    if (flags !== 0 || method !== 0 || csz !== usz) return null
    const name = new TextDecoder().decode(b.subarray(p + 30, p + 30 + nlen))
    const start = p + 30 + nlen + xlen
    out.push({ name, mtime, data: b.slice(start, start + csz) })
    p = start + csz
  }
  return out.length ? out : null
}

function writeStoredZip(entries) {
  const enc = new TextEncoder()
  const locals = [], centrals = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.name)
    const crc = crc32(e.data)
    const lh = new Uint8Array(30 + name.length)
    const dv = new DataView(lh.buffer)
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true); dv.setUint16(8, 0, true)
    dv.setUint32(10, e.mtime >>> 0, true)
    dv.setUint32(14, crc, true); dv.setUint32(18, e.data.length, true); dv.setUint32(22, e.data.length, true)
    dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true)
    lh.set(name, 30)
    const ch = new Uint8Array(46 + name.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true)
    cv.setUint16(8, 0, true); cv.setUint16(10, 0, true)
    cv.setUint32(12, e.mtime >>> 0, true)
    cv.setUint32(16, crc, true); cv.setUint32(20, e.data.length, true); cv.setUint32(24, e.data.length, true)
    cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true)
    cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true)
    cv.setUint32(42, offset, true)
    ch.set(name, 46)
    locals.push(lh, e.data); centrals.push(ch)
    offset += lh.length + e.data.length
  }
  const cdSize = centrals.reduce((a, c) => a + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true)
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true)
  const out = new Uint8Array(offset + cdSize + 22)
  let p = 0
  for (const part of [...locals, ...centrals, eocd]) { out.set(part, p); p += part.length }
  return out
}

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c >>> 0
    }
  }
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
