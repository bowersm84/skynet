// fbStockExport.js — S13 D-FBINV-04. Excel extracts for Armory › Fishbowl Inventory
// (Stock Levels and Reorder Points). SheetJS, already a dependency (catalogExport.js).
//
// What is exported is what is on screen: the current filter, search and sort, every row
// (not just the first 250 the table draws). Sheet 1 is the data with a frozen header and
// an autofilter; sheet 2 ("About") says when the numbers were read, which view and search
// produced them, and how to read them — so a file forwarded a week later still explains
// itself. Numbers are real numbers with formats, never text. No imports beyond SheetJS
// and the freeze helper, so fbStockExport.test.mjs runs it under plain `node`.
import * as XLSX from 'xlsx'
import { freezeTopRow } from './catalogExport'
import { parseFlags, reorderView } from './fbStock'

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const FMT_QTY = '#,##0'
const FMT_COST = '$#,##0.0000'
const FMT_MONEY = '$#,##0.00'

const FLAG_LABEL = { zero_cost: '$0 cost', inactive: 'Inactive in Fishbowl', count_first: 'Count first', nightly_qty: 'Nightly qty' }
const STOCK_REORDER_LABEL = { ok: 'OK', below: 'Below min', no_min: 'No min set', no_row: 'Not in Fishbowl', 'inactive rule': 'Inactive rule' }

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

// Local "2026-10-06 4:08 PM" — the reader's clock, like the screen. Text, not an Excel date,
// so it never shifts with the time zone of whoever opens the file.
export function stamp(ts) {
  if (!ts) return ''
  const d = ts instanceof Date ? ts : new Date(ts)
  if (Number.isNaN(d.getTime())) return String(ts)
  const pad = (n) => String(n).padStart(2, '0')
  let h = d.getHours()
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${h}:${pad(d.getMinutes())} ${ampm}`
}

export function todayIso(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const stockXlsxFilename = (iso) => `Skybolt_Fishbowl_Stock_Levels_${iso}.xlsx`
export const reorderXlsxFilename = (iso) => `Skybolt_Reorder_Points_${iso}.xlsx`

// ── Stock Levels ─────────────────────────────────────────────────────────────
export const STOCK_HEADER = ['Part #', 'Description', 'Category', 'On Hand', 'Allocated', 'Available', 'On Order', 'Avg Cost', 'Est. Value', 'Min', 'Reorder', 'Flags', 'Inventory As Of', 'Cost As Of']
const STOCK_FORMATS = [null, null, null, FMT_QTY, FMT_QTY, FMT_QTY, FMT_QTY, FMT_COST, FMT_MONEY, FMT_QTY, null, null, null, null]
const STOCK_WIDTHS = [26, 48, 11, 12, 11, 12, 11, 11, 13, 10, 14, 26, 19, 19]

export function stockSheetRows(rows) {
  return (rows || []).map(r => [
    r.part_number ?? '',
    r.description ?? '',
    r.category ?? '',
    num(r.on_hand),
    num(r.allocated),
    num(r.available),
    num(r.on_order),
    num(r.avg_cost),
    num(r.est_value),
    num(r.min_qty),
    r.reorder_status ? (STOCK_REORDER_LABEL[r.reorder_status] || r.reorder_status) : '',
    parseFlags(r.flags).map(f => FLAG_LABEL[f] || f).join(', '),
    stamp(r.inventory_as_of),
    stamp(r.cost_as_of),
  ])
}

export function buildStockXlsx({ rows, viewLabel = '', search = '', sync = null, generatedAt = new Date() }) {
  const body = stockSheetRows(rows)
  const ws = dataSheet(STOCK_HEADER, body, STOCK_FORMATS, STOCK_WIDTHS)
  const n = body.length
  const value = Math.round(body.reduce((s, r) => s + (r[8] || 0), 0) * 100) / 100
  const zeroCost = (rows || []).filter(r => parseFlags(r.flags).includes('zero_cost')).length
  const about = aboutSheet([
    ['Skybolt — Fishbowl Stock Levels'],
    [],
    ['Generated', stamp(generatedAt)],
    ['Fishbowl inventory as of', stamp(sync?.last_inventory_at)],
    ['Average cost as of', stamp(sync?.last_valuation_at)],
    ['View', viewLabel || 'All'],
    ['Search', search ? search : '(none)'],
    ['Parts', n ? { t: 'n', f: `COUNTA('Stock Levels'!A2:A${n + 1})`, v: n } : 0],
    ['Est. value', n ? { t: 'n', f: `SUM('Stock Levels'!I2:I${n + 1})`, v: value, z: FMT_MONEY } : { t: 'n', v: 0, z: FMT_MONEY }],
    ['Parts at $0 cost', zeroCost],
    [],
    ['How to read it'],
    ['Every Fishbowl part classed "Product". On Hand, Allocated, Available and On Order come from SkyNet\u2019s 5-minute Fishbowl mirror; Avg Cost is Fishbowl\u2019s average cost, read nightly.'],
    ['Est. Value = On Hand \u00d7 Avg Cost. It is an estimate for the screen, not the month-end valuation, which is frozen separately.'],
    ['$0 cost: Fishbowl holds the part at a $0.00 average cost, so its value is understated. Count first: 100,000 pieces or more.'],
    ['Reorder: the part\u2019s SkyNet reorder rule (Armory \u203a Fishbowl Inventory \u203a Reorder Points), compared with On Hand.'],
  ])
  return finish([['Stock Levels', ws], ['About', about]])
}

// ── Reorder Points ───────────────────────────────────────────────────────────
export const REORDER_HEADER = ['Category', 'Part #', 'Description', 'Min', 'On Hand', 'Available', 'On Order', 'Status', 'Shortfall', 'On Order Covers', 'Vendor', 'Notes', 'Active', 'Status Changed', 'Inventory As Of']
const REORDER_FORMATS = [null, null, null, FMT_QTY, FMT_QTY, FMT_QTY, FMT_QTY, null, FMT_QTY, null, null, null, null, null, null]
const REORDER_WIDTHS = [11, 22, 44, 10, 12, 12, 11, 14, 11, 15, 28, 40, 8, 19, 19]

// `rules` are fb_reorder_points rows carrying `status` (their v_report_fb_reorder_status row),
// in the order the screen shows them.
export function reorderSheetRows(rules) {
  return (rules || []).map(rule => {
    const s = rule.status || {}
    const v = reorderView(rule, s)
    return [
      rule.category ?? '',
      rule.part_num ?? '',
      s.description ?? '',
      num(rule.min_qty),
      num(s.on_hand),
      num(s.available),
      num(s.on_order),
      v.label,
      v.shortfall > 0 ? v.shortfall : null,
      v.shortfall > 0 ? (v.onOrderCovers ? 'Yes' : 'No') : '',
      rule.vendor ?? '',
      rule.notes ?? '',
      rule.is_active === false ? 'No' : 'Yes',
      stamp(rule.alert_changed_at),
      stamp(s.inventory_as_of),
    ]
  })
}

export function buildReorderXlsx({ rules, viewLabel = '', search = '', sync = null, generatedAt = new Date() }) {
  const body = reorderSheetRows(rules)
  const ws = dataSheet(REORDER_HEADER, body, REORDER_FORMATS, REORDER_WIDTHS)
  const below = body.filter(r => r[7] === 'Below min').length
  const about = aboutSheet([
    ['Skybolt — Reorder Points'],
    [],
    ['Generated', stamp(generatedAt)],
    ['Fishbowl inventory as of', stamp(sync?.last_inventory_at)],
    ['View', viewLabel || 'All'],
    ['Search', search ? search : '(none)'],
    ['Rules', body.length],
    ['Below minimum', below],
    [],
    ['How to read it'],
    ['Min is the minimum ON HAND, counted across every Fishbowl location. A rule with no minimum stays on the list and never alerts.'],
    ['Status is set by SkyNet after every 5-minute Fishbowl refresh. Purchasers and admins get a bell the first time a part drops below its minimum.'],
    ['Shortfall = Min \u2212 On Hand. On Order Covers = Yes when the quantity already on order closes the gap.'],
  ])
  return finish([['Reorder Points', ws], ['About', about]])
}

// ── shared ───────────────────────────────────────────────────────────────────
function dataSheet(header, body, formats, widths) {
  const ws = XLSX.utils.aoa_to_sheet([header, ...body])
  for (let R = 1; R <= body.length; R++) {
    for (let C = 0; C < header.length; C++) {
      const z = formats[C]
      if (!z) continue
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })]
      if (cell && cell.t === 'n') cell.z = z
    }
  }
  ws['!cols'] = widths.map(wch => ({ wch }))
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(body.length, 1), c: header.length - 1 } }) }
  return ws
}

function aboutSheet(lines) {
  const ws = XLSX.utils.aoa_to_sheet(lines.map(l => l.map(c => (c && typeof c === 'object' ? null : c))))
  lines.forEach((l, R) => l.forEach((c, C) => {
    if (c && typeof c === 'object') ws[XLSX.utils.encode_cell({ r: R, c: C })] = c
  }))
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lines.length - 1, c: 1 } })
  ws['!cols'] = [{ wch: 26 }, { wch: 60 }]
  return ws
}

// The data sheet must be first: freezeTopRow patches xl/worksheets/sheet1.xml.
function finish(sheets) {
  const wb = XLSX.utils.book_new()
  for (const [name, ws] of sheets) XLSX.utils.book_append_sheet(wb, ws, name)
  return freezeTopRow(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })))
}
