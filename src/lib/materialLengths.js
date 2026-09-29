// D-INV-07 - how a lot's receipts read on the shelf.
//
// A lot of bar stock can sit on the rack as full bars (12 ft, 144") and as 4 ft (48")
// pieces, each on its own material_receiving row. Since D-INV-07 a usage row charges
// its receipt in that receipt's own bar length (a 48" piece cut from a 144" bar is
// 1/3 of a bar), so a full-bar balance can carry a fraction. The fraction is stock that
// has been cut but not loaded yet: on the rack it is 4 ft pieces. These helpers turn a
// lot's receipts into the two numbers a person counts - whole 12 ft bars and 4 ft
// pieces - plus the value of what is on hand at the lot's weighted-average cost.
//
// Pure functions, no I/O. Used by the Armory inventory tab, the cycle-count screen and
// the count sheet (Armory.jsx), and the machine kiosk's availability banner (Kiosk.jsx).
// Tested by src/lib/materialLengths.test.mjs (run: node src/lib/materialLengths.test.mjs).

export const PIECE_LENGTH_IN = 48 // the 4 ft piece the Mazaks run
export const FULL_BAR_IN = 144 // the 12 ft bar
const EPS = 1e-6

// A receipt is a 4 ft piece receipt when its bar length is 48" (within an inch, so a
// keyed 47.75 reads the same). Everything else is a full bar, as on the count screen.
export const isPieceLength = (len) => Math.abs(Number(len) - PIECE_LENGTH_IN) <= 1

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// Display a bar or piece count: whole numbers as-is, anything else to one decimal.
export function fmtCount(n) {
  const v = num(n)
  if (Math.abs(v - Math.round(v)) < 0.05) return String(Math.round(v))
  return v.toFixed(1)
}

// shelfSplit(receipts) -> what the lot's receipts add up to on the rack.
//   receipts: [{ bar_length_inches, available_bars }]
// Returns:
//   hasFull / hasPieces   the lot has a full-bar / a 4 ft receipt
//   fullLen               the full-bar length (the longest non-48" length), or null
//   full                  whole full bars; negative when the full-bar shelf is short
//   pieces                4 ft pieces: 48" receipts plus pieces already cut from bars
//   cutPieces, cutInches  the cut stock derived from the full-bar fraction; cutInches
//                         is what is left over after whole 48" pieces (an offcut)
//   fullNegative / piecesNegative / negative
//   totalInches           everything on the shelf, in inches
export function shelfSplit(receipts) {
  let fullInches = 0
  let pieceInches = 0
  let pieceBal = 0
  let fullLen = null
  let hasFull = false
  let hasPieces = false
  for (const r of receipts || []) {
    const len = num(r.bar_length_inches)
    const bal = num(r.available_bars)
    if (isPieceLength(len)) {
      hasPieces = true
      pieceBal += bal
      pieceInches += bal * len
    } else {
      hasFull = true
      fullInches += bal * len
      if (len > 0) fullLen = Math.max(fullLen ?? 0, len)
    }
  }
  // Full-bar balance in bars of the full length (bar-equivalents if a lot ever mixes,
  // say, 142" and 144" receipts).
  const fullBars = fullLen ? fullInches / fullLen : 0
  let full = 0
  let cutPieces = 0
  let cutInches = 0
  if (fullBars > EPS) {
    full = Math.floor(fullBars + EPS)
    const fracIn = (fullBars - full) * fullLen
    cutPieces = Math.floor(fracIn / PIECE_LENGTH_IN + EPS)
    cutInches = Math.round(fracIn - cutPieces * PIECE_LENGTH_IN)
    if (cutInches < 1) cutInches = 0
  } else if (fullBars < -0.001) {
    full = Math.round(fullBars * 10) / 10
  }
  const fullNegative = fullBars < -0.001
  const piecesNegative = pieceBal < -0.001
  return {
    hasFull,
    hasPieces,
    fullLen: fullLen || null,
    full,
    pieces: Math.round((pieceBal + cutPieces) * 10) / 10,
    cutPieces,
    cutInches,
    fullNegative,
    piecesNegative,
    negative: fullNegative || piecesNegative,
    totalInches: fullInches + pieceInches,
  }
}

// Weighted-average cost per inch across the lot's priced receipts, weighted by what
// each receipt brought in (received bars x bar length). Count-created receipts
// (received 0) carry no weight. Null when no receipt has a price.
export function costPerInch(receipts) {
  let cost = 0
  let inches = 0
  for (const r of receipts || []) {
    const q = num(r.received_bars)
    const len = num(r.bar_length_inches)
    if (r.price_per_bar == null || q <= 0 || len <= 0) continue
    cost += q * num(r.price_per_bar)
    inches += q * len
  }
  return inches > 0 ? cost / inches : null
}

// Value of what is on hand: net inches on the shelf x the weighted-average cost.
//   value    dollars, 0 when nothing is on hand, null when the lot has no price
//   noPrice  stock is on hand but no receipt carries a price
export function shelfValue(receipts) {
  const cpi = costPerInch(receipts)
  const { totalInches } = shelfSplit(receipts)
  if (cpi == null) return { value: null, noPrice: totalInches > EPS, costPerInch: null }
  return { value: totalInches > EPS ? totalInches * cpi : 0, noPrice: false, costPerInch: cpi }
}

// Per-length arithmetic for the expander: received, used (charged), adjustments and
// what is on hand at each bar length, longest first.
//   receipts: [{ bar_length_inches, received_bars, charged_bars, adjustment_delta, available_bars }]
export function lengthRows(receipts) {
  const m = new Map()
  for (const r of receipts || []) {
    const len = num(r.bar_length_inches)
    const e = m.get(len) || { len, receipts: 0, received: 0, used: 0, adj: 0, onHand: 0 }
    e.receipts += 1
    e.received += num(r.received_bars)
    e.used += num(r.charged_bars)
    e.adj += num(r.adjustment_delta)
    e.onHand += num(r.available_bars)
    m.set(len, e)
  }
  return [...m.values()].sort((a, b) => b.len - a.len)
}

// Bars of the full 12 ft length the stock is worth (used for min-stock rules, which are
// set in bars): a 48" piece is a third of a bar.
export const barEquivalents = (availableBars, barLengthIn) =>
  num(availableBars) * (num(barLengthIn) || FULL_BAR_IN) / FULL_BAR_IN

// Cycle-count "system" figures for one lot: the 12 ft count a person should find
// (whole bars) and the 4 ft count (48" receipts plus pieces already cut from bars).
export function countSystem(pieceReceipts, fullReceipts) {
  const s = shelfSplit([...(pieceReceipts || []), ...(fullReceipts || [])])
  return {
    sys12: s.hasFull ? s.full : 0,
    sys4: s.pieces,
    cutPieces: s.cutPieces,
    cutInches: s.cutInches,
    fullNegative: s.fullNegative,
    piecesNegative: s.piecesNegative,
  }
}

// Machine kiosk: one entry per (material, size, lot) with the balance at each length,
// from material_availability rows (one per receipt).
export function aggregateLotStock(rows) {
  const m = new Map()
  for (const r of rows || []) {
    const key = `${r.material_type}|||${r.bar_size}|||${r.lot_number}`
    let e = m.get(key)
    if (!e) {
      e = { material_type: r.material_type, bar_size: r.bar_size, lot_number: r.lot_number, available_bars: 0, available_inches: 0, lengths: [] }
      m.set(key, e)
    }
    const len = num(r.bar_length_inches)
    const bars = num(r.available_bars)
    e.available_bars += bars
    e.available_inches += r.available_inches != null ? num(r.available_inches) : bars * len
    e.lengths.push({ len, bars })
  }
  return [...m.values()]
}

// How many pieces of pieceLen the lot can supply: its stock at that length or longer,
// in inches, divided by the piece length. Without a length, the bar count.
export function piecesAvailableAt(stock, pieceLen) {
  const L = num(pieceLen)
  if (!(L > 0)) return Math.floor(num(stock?.available_bars) + EPS)
  let inches = 0
  for (const { len, bars } of stock?.lengths || []) {
    if (len >= L - 1) inches += bars * len
  }
  return Math.floor(inches / L + EPS)
}
