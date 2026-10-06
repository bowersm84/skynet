// Unit test for src/lib/fbStockExport.js — S13 D-FBINV-04.
// Run: node src/lib/fbStockExport.test.mjs
//
// Builds both workbooks from rows shaped like the registry views (PROD, 2026-10-06), reads
// them back with SheetJS and checks: sheet order (data first, so the freeze lands on it),
// header, numbers stored as numbers with formats, the About sheet's formulas, the frozen
// header, and that a file with no rows is still a valid workbook.

// The module imports its siblings extensionless (Vite style), which plain Node cannot
// resolve, so the three modules are copied to _*.undertest.mjs siblings with only those
// import paths rewritten — the code under test is otherwise the shipped code, byte for
// byte — and the copies are removed when the test ends (pdfDocs.test.mjs does the same).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as XLSX from 'xlsx'

const dir = path.dirname(fileURLToPath(import.meta.url))
const copies = []
const undertest = (name, rewrites = {}) => {
  let src = fs.readFileSync(path.join(dir, `${name}.js`), 'utf8')
  for (const [from, to] of Object.entries(rewrites)) {
    assert.ok(src.includes(`from '${from}'`), `${name}.js imports ${from}`)
    src = src.split(`from '${from}'`).join(`from '${to}'`)
  }
  const out = path.join(dir, `_${name}.undertest.mjs`)
  fs.writeFileSync(out, src)
  copies.push(out)
  return out
}
undertest('fbStock')
undertest('catalogExport')
const mod = undertest('fbStockExport', { './catalogExport': './_catalogExport.undertest.mjs', './fbStock': './_fbStock.undertest.mjs' })
let api
try {
  api = await import(pathToFileURL(mod).href)
} finally {
  for (const f of copies) fs.rmSync(f, { force: true })
}
const {
  XLSX_MIME, stamp, todayIso, stockXlsxFilename, reorderXlsxFilename, STOCK_HEADER, REORDER_HEADER,
  stockSheetRows, reorderSheetRows, buildStockXlsx, buildReorderXlsx,
} = api

let n = 0
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++ }
const ok = (c, msg) => { assert.ok(c, msg); n++ }

const T = '2026-10-06T20:08:08Z'
const stock = [
  { part_number: 'SK4000CGP81', description: '4000 Series Pin', category: 'Pins', on_hand: 1094617, allocated: 164, available: 1094453, on_order: 400000, avg_cost: 0.063397293, est_value: 69395.75, min_qty: 200000, reorder_status: 'ok', flags: 'count_first', inventory_as_of: T, cost_as_of: T },
  { part_number: 'SK2600CGP174', description: 'SK2600 SERIES PIN 17-4', category: 'Pins', on_hand: '126985', allocated: '1370', available: '125615', on_order: '100000', avg_cost: '0.050460958', est_value: '6407.78', min_qty: '150000', reorder_status: 'below', flags: 'count_first', inventory_as_of: T, cost_as_of: T },
  { part_number: 'SK4CWING3', description: '4000 SERIES WING - STAINLESS', category: 'Wings', on_hand: 23552, allocated: 1, available: 23551, on_order: 0, avg_cost: 0, est_value: 0, min_qty: 5000, reorder_status: 'ok', flags: 'zero_cost', inventory_as_of: T, cost_as_of: T },
  { part_number: 'SK244C16C  (Formed Insert)', description: 'Floating Receptacle', category: null, on_hand: 689, allocated: 1904, available: -1215, on_order: 1700, avg_cost: null, est_value: 0, min_qty: null, reorder_status: null, flags: 'zero_cost inactive', inventory_as_of: null, cost_as_of: T },
]
const sync = { last_inventory_at: T, last_valuation_at: '2026-10-06T06:10:00Z' }

// --- small helpers
eq(XLSX_MIME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'mime')
eq(todayIso(new Date(2026, 9, 6, 23, 59)), '2026-10-06', 'local date, not UTC')
eq(stockXlsxFilename('2026-10-06'), 'Skybolt_Fishbowl_Stock_Levels_2026-10-06.xlsx', 'stock filename')
eq(reorderXlsxFilename('2026-10-06'), 'Skybolt_Reorder_Points_2026-10-06.xlsx', 'reorder filename')
eq(stamp(new Date(2026, 9, 6, 16, 8)), '2026-10-06 4:08 PM', 'afternoon stamp')
eq(stamp(new Date(2026, 9, 6, 0, 5)), '2026-10-06 12:05 AM', 'midnight hour is 12 AM')
eq(stamp(null), '', 'no timestamp, empty cell')

// --- rows
const rows = stockSheetRows(stock)
eq(rows[0].slice(0, 10), ['SK4000CGP81', '4000 Series Pin', 'Pins', 1094617, 164, 1094453, 400000, 0.063397293, 69395.75, 200000], 'numbers stay numbers')
eq(rows[1].slice(3, 10), [126985, 1370, 125615, 100000, 0.050460958, 6407.78, 150000], 'PostgREST numeric strings become numbers')
eq([rows[1][10], rows[2][11], rows[3][11]], ['Below min', '$0 cost', '$0 cost, Inactive in Fishbowl'], 'labels for status and flags')
eq([rows[3][2], rows[3][7], rows[3][9], rows[3][10], rows[3][12]], ['', null, null, '', ''], 'missing values are blank cells, not zeros')

// --- stock workbook read back
const wbBytes = buildStockXlsx({ rows: stock, viewLabel: 'In stock', search: 'SK', sync, generatedAt: new Date(2026, 9, 6, 17, 0) })
ok(wbBytes instanceof Uint8Array && wbBytes.length > 1000, 'bytes out')
const wb = XLSX.read(wbBytes, { type: 'array', cellFormula: true, cellNF: true })
eq(wb.SheetNames, ['Stock Levels', 'About'], 'data sheet first, About second')
const ws = wb.Sheets['Stock Levels']
const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null })
eq(aoa[0], STOCK_HEADER, 'header row')
eq(aoa.length, 5, 'one row per part plus the header')
eq(ws.D2.t, 'n', 'on hand is a number cell')
eq(ws.D2.z, '#,##0', 'quantity format')
eq(ws.H2.z, '$#,##0.0000', 'avg cost format')
eq(ws.I2.z, '$#,##0.00', 'est value format')
eq(ws.F5.v, -1215, 'negative available survives')
ok(ws['!autofilter']?.ref?.startsWith('A1:N'), 'autofilter across the header')
const about = wb.Sheets.About
eq(about.B6.v, 'In stock', 'view recorded')
eq(about.B7.v, 'SK', 'search recorded')
eq(about.B8.f, "COUNTA('Stock Levels'!A2:A5)", 'parts count is a formula')
eq(about.B9.f, "SUM('Stock Levels'!I2:I5)", 'est value is a formula')
eq(about.B9.v, 75803.53, 'with its cached value')
eq(about.B10.v, 2, 'parts at $0 cost')
const xml = new TextDecoder().decode(wbBytes)
ok(xml.includes('state="frozen"'), 'header row frozen')

// --- empty stock workbook
const empty = XLSX.read(buildStockXlsx({ rows: [], sync }), { type: 'array', cellFormula: true, cellNF: true })
eq(empty.SheetNames, ['Stock Levels', 'About'], 'empty export still has both sheets')
eq(XLSX.utils.sheet_to_json(empty.Sheets['Stock Levels'], { header: 1 })[0], STOCK_HEADER, 'empty export keeps the header')
eq([empty.Sheets.About.B8.v, empty.Sheets.About.B8.f], [0, undefined], 'no formula over an empty range')

// --- reorder rows and workbook
const rules = [
  { part_num: 'SK2600CGP174', category: 'Pins', min_qty: 150000, alert_state: 'below', vendor: 'GROOV-PIN', notes: 'seed', is_active: true, alert_changed_at: '2026-10-06T19:26:44Z', status: { description: 'SK2600 SERIES PIN 17-4', on_hand: 126985, available: 125615, on_order: 100000, inventory_as_of: T } },
  { part_num: 'SK35-SPRING', category: 'Springs', min_qty: 25000, alert_state: 'below', vendor: null, notes: null, is_active: true, status: { description: 'Spring - Stainless', on_hand: 2967, available: 2967, on_order: 0, inventory_as_of: T } },
  { part_num: 'SK2FW2SE', category: 'Wings', min_qty: null, alert_state: 'no_min', vendor: 'Maxtrust Industries', is_active: true, status: { description: 'Wing Enhanced', on_hand: 9625, available: 9624, on_order: 0 } },
  { part_num: 'SK4FW2SE', category: 'Wings', min_qty: 10, alert_state: 'below', is_active: false, status: null },
]
const rr = reorderSheetRows(rules)
eq(rr[0].slice(0, 10), ['Pins', 'SK2600CGP174', 'SK2600 SERIES PIN 17-4', 150000, 126985, 125615, 100000, 'Below min', 23015, 'Yes'], 'below, covered by what is on order')
eq(rr[1].slice(7, 10), ['Below min', 22033, 'No'], 'below, nothing on order')
eq(rr[2].slice(3, 10), [null, 9625, 9624, 0, 'No min set', null, ''], 'parked rule')
eq([rr[3][7], rr[3][8], rr[3][12]], ['Inactive', null, 'No'], 'inactive rule shows no shortfall')
const rwb = XLSX.read(buildReorderXlsx({ rules, viewLabel: 'All', sync }), { type: 'array', cellNF: true })
eq(rwb.SheetNames, ['Reorder Points', 'About'], 'reorder sheets')
eq(XLSX.utils.sheet_to_json(rwb.Sheets['Reorder Points'], { header: 1 })[0], REORDER_HEADER, 'reorder header')
eq(rwb.Sheets['Reorder Points'].I2.z, '#,##0', 'shortfall format')
eq([rwb.Sheets.About.B7.v, rwb.Sheets.About.B8.v], [4, 2], 'rules and below counts (inactive is not below)')

console.log(`fbStockExport: ${n} assertions passed`)
