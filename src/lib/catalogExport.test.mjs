// Unit test for the Catalog export (D-PRICE-52 B).
// Run: node src/lib/catalogExport.test.mjs
// Pure module + SheetJS only — no Supabase import, so it runs straight from Node.

import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { catalogColumns, catalogRows, catalogFilename, buildCatalogXlsx, freezeTopRow } from './catalogExport.js'

let n = 0
const ok = (cond, msg) => { assert.ok(cond, msg); n++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++ }

// ── the book's ladders, as Rev 81/82 actually carry them ──────────────────────────
const meta = {
  ladders: {
    standard: { columns: [
      { key: 'q100', kind: 'qty', min: 100, label: '100' }, { key: 'q300', kind: 'qty', min: 300, label: '300' },
      { key: 'q500', kind: 'qty', min: 500, label: '500' }, { key: 'tier1', kind: 'tier', label: 'Tier 1' },
      { key: 'tier2', kind: 'tier', label: 'Tier 2' }, { key: 'tier3', kind: 'tier', label: 'Tier 3' }] },
    kit_2_5: { columns: [{ key: 'q2', kind: 'qty', min: 2, label: '2–4' }, { key: 'q5', kind: 'qty', min: 5, label: '5+' }] },
    q10_q50_q300: { columns: [{ key: 'q10', kind: 'qty', min: 10, label: '10' }, { key: 'q50', kind: 'qty', min: 50, label: '50' }, { key: 'q300', kind: 'qty', min: 300, label: '300' }] },
    none: { columns: [] },
  },
  sections: [{ id: 's1', name: 'CLoc 2600 Series', sort: 1 }, { id: 's2', name: 'Skybolt Kits — Cowling', sort: 2 }],
}

// ── columns come from the ladders, in break order, Premier last ───────────────────
const cols = catalogColumns(meta)
eq(cols.map(c => c.key), ['each', 'q2', 'q5', 'q10', 'q50', 'q100', 'q300', 'q500', 'tier1', 'tier2', 'tier3', 'premier'], 'every ladder column appears once, quantity breaks ascending, Premier last')
eq(cols.map(c => c.label), ['Each', '2–4', '5+', '10+', '50+', '100+', '300+', '500+', 'Tier 1', 'Tier 2', 'Tier 3', 'Premier'], 'bare breaks get a +, decorated labels are left alone')
eq(catalogColumns({ ladders: { none: { columns: [] } } }).map(c => c.key), ['each', 'premier'], 'a book with no ladder columns still offers Each and Premier')
eq(catalogColumns(null).map(c => c.key), ['each', 'premier'], 'no meta does not throw')

// ── rows: no_price out, unresolved sums out, book order in ────────────────────────
const items = [
  { id: 'i1', section_id: 's1', part_number: 'SK2600-1', description: 'stud', status: 'priced', list_price: 10, sort: 2 },
  { id: 'i2', section_id: 's1', part_number: 'SK2600-X', description: 'discontinued', status: 'no_price', list_price: null, sort: 1 },
  { id: 'i3', section_id: 's2', part_number: 'AC500-C1', description: 'cowling kit', status: 'component_sum', sort: 1, _components: [{ component_key: 'SK2600-1', qty: 2 }] },
  { id: 'i4', section_id: 's2', part_number: 'RV1014J-C1P', description: 'blocked kit', status: 'component_sum', sort: 2, _components: [{ component_key: 'MS21059L3', qty: 1 }] },
  { id: 'i5', section_id: 's1', part_number: 'SK2600-0', description: 'priced but null', status: 'priced', list_price: null, sort: 0 },
]
// Stand-in engine: kits resolve unless they need MS21059L3; Premier only on nothing here.
const price = (it, key) => {
  if (it.status === 'component_sum') {
    if (it._components.some(c => c.component_key === 'MS21059L3')) return null
    return key === 'each' ? 20 : key === 'premier' ? null : 18
  }
  if (it.list_price === null) return null
  if (key === 'each') return Number(it.list_price)
  if (key === 'premier') return null
  return Number(it.list_price) * 0.9
}
const all = catalogRows({ items, sections: meta.sections, columns: cols, price })
eq(all.stats, { priced: 1, sums: 1, skipped: 1, no_price: 2 }, 'one priced row, one resolved kit, one kit skipped, two without a price')
eq(all.rows.length, 2, 'only the two exportable rows reach the sheet')
eq(all.rows[0].slice(0, 3), ['CLoc 2600 Series', 'SK2600-1', 'stud'], 'section sort leads the order')
eq(all.rows[1].slice(0, 3), ['Skybolt Kits — Cowling', 'AC500-C1', 'cowling kit'], 'the resolved kit follows')
ok(!all.rows.some(r => r[1] === 'RV1014J-C1P'), 'an unresolved kit is never exported, at any price')
eq(all.rows[0][3], 10, 'Each is the list price')
eq(all.rows[0][all.rows[0].length - 1], null, 'a column the item does not carry is blank, not zero')

// ── the picker only changes the columns, never which rows qualify ─────────────────
const picked = cols.filter(c => ['q100', 'tier3'].includes(c.key))
const two = catalogRows({ items, sections: meta.sections, columns: picked, price })
eq(two.rows[0].length, 5, 'Section + Part + Description + the two picked columns')
eq(two.stats, all.stats, 'unticking Each does not change what is skipped')
const noEach = catalogRows({ items, sections: meta.sections, columns: cols.filter(c => c.key !== 'each'), price })
ok(!noEach.rows.some(r => r[1] === 'RV1014J-C1P'), 'resolution is judged on Each even when Each is unticked')

// ── filename ──────────────────────────────────────────────────────────────────────
eq(catalogFilename({ rev_label: 'Rev 82 — Oct 2026' }, '2026-09-16'), 'Skybolt_Catalog_Rev_82_Oct_2026_2026-09-16.xlsx', 'filename carries the revision and the date')

// ── the workbook: header set, number format, frozen top row ───────────────────────
const bytes = buildCatalogXlsx({ book: { rev_label: 'Rev 82 — Oct 2026' }, columns: picked, rows: two.rows })
ok(bytes instanceof Uint8Array && bytes.length > 0, 'a workbook comes back as bytes')
const wb = XLSX.read(bytes, { type: 'array', cellNF: true })
const ws = wb.Sheets[wb.SheetNames[0]]
const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 })
eq(aoa[0], ['Section', 'Part Number', 'Description', '100+', 'Tier 3'], 'the header is exactly the picked column set')
eq(aoa[1], ['CLoc 2600 Series', 'SK2600-1', 'stud', 9, 9], 'values land under their columns')
eq(ws.D2.z, '0.00', 'prices carry the 0.00 number format')
ok(ws.A2.z !== '0.00', 'text cells do not carry the price format')
const xml = Buffer.from(bytes).toString('latin1')
ok(xml.includes('state="frozen"') && xml.includes('ySplit="1"'), 'the header row is frozen')
ok(xml.includes('<autoFilter'), 'the header row filters')

// ── the freeze patch never breaks the file it is handed ───────────────────────────
const junk = new Uint8Array([0x50, 0x4b, 0x99, 0x99, 1, 2, 3])
ok(freezeTopRow(junk) === junk, 'bytes that are not a stored zip come back untouched')
const tiny = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(tiny, XLSX.utils.aoa_to_sheet([['a']]), 'S')
const plain = new Uint8Array(XLSX.write(tiny, { type: 'array', bookType: 'xlsx' }))
ok(XLSX.read(freezeTopRow(plain), { type: 'array' }).Sheets.S.A1.v === 'a', 'a rebuilt workbook still reads back')

console.log(`catalogExport: ${n} assertions passed`)
