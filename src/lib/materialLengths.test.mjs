// Unit test for src/lib/materialLengths.js - D-INV-07.
// Run: node src/lib/materialLengths.test.mjs
//
// Fixtures are shaped like material_availability rows and taken from PROD lot 2587
// (41L40 Steel 0.375 dia): PO 2895 144" x53 @ $16.4077, PO 2895 48" x8 @ $5.4692,
// PO P3726 144" x110 @ $16.45. "Today" is the state after the 2026-09-29 traceability
// cleanup (D-INV-06); "charged right" is the same shelf with the 26 post-count 4 ft
// pieces charged a third of a bar each and the old 4 ft pieces used first.

import assert from 'node:assert/strict'
import {
  PIECE_LENGTH_IN, FULL_BAR_IN, isPieceLength, fmtCount, shelfSplit, costPerInch, shelfValue,
  lengthRows, barEquivalents, countSystem, aggregateLotStock, piecesAvailableAt,
} from './materialLengths.js'

let n = 0
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++ }
const near = (a, b, msg, tol = 1e-6) => { assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`); n++ }

const po2895_144 = { bar_length_inches: 144, received_bars: 53, price_per_bar: 16.4077 }
const po2895_48 = { bar_length_inches: 48, received_bars: 8, price_per_bar: 5.4692 }
const p3726_144 = { bar_length_inches: 144, received_bars: 110, price_per_bar: 16.45 }

// --- constants and small helpers
eq(PIECE_LENGTH_IN, 48, 'piece length')
eq(FULL_BAR_IN, 144, 'full bar length')
eq(isPieceLength(48), true, '48 is a piece')
eq(isPieceLength(47.75), true, 'keyed 47.75 reads as a piece')
eq(isPieceLength(144), false, '144 is a full bar')
eq(isPieceLength(96), false, '96 is a full bar (nylon)')
eq(fmtCount(13), '13', 'whole count')
eq(fmtCount(-3), '-3', 'negative whole count')
eq(fmtCount(6.666667), '6.7', 'fraction to one decimal')
eq(fmtCount(5.999999), '6', 'rounding noise reads whole')
eq(fmtCount(null), '0', 'null reads 0')

// --- lot 2587 today: 144" line -3 (PO 2895 +12, P3726 -15), 48" line 13
const today = [
  { ...po2895_144, available_bars: 12, charged_bars: 43, adjustment_delta: 2 },
  { ...p3726_144, available_bars: -15, charged_bars: 122, adjustment_delta: -3 },
  { ...po2895_48, available_bars: 13, charged_bars: 9, adjustment_delta: 14 },
]
const s1 = shelfSplit(today)
eq(s1.hasFull, true, 'today: has full bars')
eq(s1.hasPieces, true, 'today: has pieces')
eq(s1.fullLen, 144, 'today: full length')
eq(s1.full, -3, 'today: 12 ft reads -3')
eq(s1.pieces, 13, 'today: 4 ft reads 13')
eq(s1.fullNegative, true, 'today: 12 ft is short')
eq(s1.piecesNegative, false, 'today: 4 ft is not short')
eq(s1.negative, true, 'today: the line is flagged')
near(s1.totalInches, 192, 'today: -432" + 624" on the shelf')
eq(s1.cutPieces, 0, 'today: no cut stock on a short shelf')

// Weighted-average cost: (53 x 16.4077 + 8 x 5.4692 + 110 x 16.45) / (53x144 + 8x48 + 110x144)
near(costPerInch(today), 2722.8617 / 23856, 'today: weighted cost per inch', 1e-9)
const v1 = shelfValue(today)
near(v1.value, 192 * (2722.8617 / 23856), 'today: value = net inches x weighted cost', 1e-6)
near(Math.round(v1.value * 100) / 100, 21.91, 'today: $21.91', 1e-9)
eq(v1.noPrice, false, 'today: priced')

// --- lot 2587 charged right: 144" bucket 39 at count - 28 full - 13 pieces/3 = 6.666667
const right = [
  { ...po2895_144, available_bars: 0 },
  { ...p3726_144, available_bars: 6.666667 },
  { ...po2895_48, available_bars: 0 },
]
const s2 = shelfSplit(right)
eq(s2.full, 6, 'charged right: 6 whole 12 ft bars')
eq(s2.cutPieces, 2, 'charged right: the .67 is two cut 4 ft pieces')
eq(s2.cutInches, 0, 'charged right: no offcut')
eq(s2.pieces, 2, 'charged right: 4 ft reads 2 (0 receipt + 2 cut)')
eq(s2.negative, false, 'charged right: nothing short')
near(s2.totalInches, 960, 'charged right: 960" on the shelf', 1e-3)

// 72" cuts (Ganesh): 5.5 bars = 5 whole + one 48" piece + a 24" offcut
const s3 = shelfSplit([{ bar_length_inches: 144, available_bars: 5.5 }])
eq([s3.full, s3.cutPieces, s3.cutInches, s3.pieces], [5, 1, 24, 1], '72" cuts leave a 24" offcut')

// A short full-bar shelf with a fraction reads to one decimal
eq(shelfSplit([{ bar_length_inches: 144, available_bars: -2.666667 }]).full, -2.7, 'negative fraction')

// Pieces-only lot and a 96" nylon lot
eq(shelfSplit([{ bar_length_inches: 48, available_bars: 5 }]).hasFull, false, 'pieces-only lot has no full bars')
const nylon = shelfSplit([{ bar_length_inches: 96, available_bars: 8 }])
eq([nylon.full, nylon.fullLen, nylon.pieces], [8, 96, 0], '96" lot reads 8 full bars at 96"')

// No price anywhere: value null, flagged when stock is on hand
const unpriced = [{ bar_length_inches: 144, received_bars: 10, price_per_bar: null, available_bars: 4 }]
eq(shelfValue(unpriced).value, null, 'unpriced: no value')
eq(shelfValue(unpriced).noPrice, true, 'unpriced with stock: flagged')
eq(shelfValue([{ bar_length_inches: 144, received_bars: 10, price_per_bar: null, available_bars: 0 }]).noPrice, false, 'unpriced and empty: not flagged')

// A count-created receipt (received 0) carries no weight in the average
near(costPerInch([...today, { bar_length_inches: 48, received_bars: 0, price_per_bar: 99, available_bars: 2 }]),
  2722.8617 / 23856, 'stub price ignored in the average', 1e-9)

// --- expander arithmetic
eq(lengthRows(today).map(r => [r.len, r.receipts, r.received, r.used, r.adj, r.onHand]),
  [[144, 2, 163, 165, -1, -3], [48, 1, 8, 9, 14, 13]], 'per-length rows, longest first')

// --- min-stock bar-equivalents
near(barEquivalents(13, 48), 13 / 3, '13 x 4 ft = 4.33 bars')
near(barEquivalents(6, 144), 6, 'full bars count as bars')
near(barEquivalents(3, null), 3, 'unknown length counts as a full bar')

// --- count system figures
eq(countSystem([today[2]], [today[0], today[1]]), { sys12: -3, sys4: 13, cutPieces: 0, cutInches: 0, fullNegative: true, piecesNegative: false }, 'count: today')
eq(countSystem([right[2]], [right[0], right[1]]).sys12, 6, 'count: charged right 12 ft')
eq(countSystem([right[2]], [right[0], right[1]]).sys4, 2, 'count: charged right 4 ft includes cut pieces')
eq(countSystem([], [{ bar_length_inches: 144, available_bars: 6.666667 }]).sys4, 2, 'count: cut pieces show even with no 48" receipt')

// --- kiosk stock: one entry per lot, pieces available by length
const viewRows = [
  { material_type: '41L40 Steel', bar_size: '0.375 dia', lot_number: '2587', bar_length_inches: 144, available_bars: 0, available_inches: 0 },
  { material_type: '41L40 Steel', bar_size: '0.375 dia', lot_number: '2587', bar_length_inches: 144, available_bars: 6.666667, available_inches: 960.00005 },
  { material_type: '41L40 Steel', bar_size: '0.375 dia', lot_number: '2587', bar_length_inches: 48, available_bars: 0, available_inches: 0 },
  { material_type: '303 Stainless Steel', bar_size: '0.500 dia', lot_number: '2605', bar_length_inches: 144, available_bars: 3, available_inches: 432 },
]
const stock = aggregateLotStock(viewRows)
eq(stock.length, 2, 'kiosk: one entry per lot')
const s2587 = stock.find(s => s.lot_number === '2587')
eq(s2587.lengths.length, 3, 'kiosk: lengths kept')
eq(piecesAvailableAt(s2587, 48), 20, 'kiosk: 960" = 20 pieces at 48"')
eq(piecesAvailableAt(s2587, 47.75), 20, 'kiosk: 47.75 draws from the same stock')
eq(piecesAvailableAt(s2587, 144), 6, 'kiosk: 6 full bars at 144"')
eq(piecesAvailableAt(s2587, 0), 6, 'kiosk: no length falls back to the bar count')
eq(piecesAvailableAt({ lengths: [{ len: 48, bars: 5 }] }, 144), 0, 'kiosk: 4 ft pieces cannot make a 12 ft bar')
eq(piecesAvailableAt({ lengths: [{ len: 144, bars: -2 }] }, 48), -6, 'kiosk: a short shelf reads negative')

console.log(`materialLengths: ${n} checks passed`)
