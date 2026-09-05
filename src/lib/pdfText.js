//
// Shared helpers for the pricing PDFs (quote, price list): Skybolt brand colours,
// the logo, and WinAnsi-safe text. pdf-lib's standard fonts throw on characters
// outside WinAnsi (non-breaking hyphen, CJK, emoji…); rep-typed fields can carry
// them from Word/Outlook, so every string goes through safe() before drawText.
//
import { rgb } from 'pdf-lib'

// Served from /public (public/skybolt_logo.jpg, 1091×257) — the same place the app's other logos live.
const logoUrl = '/skybolt_logo.jpg'

export const BRAND = {
  red: rgb(184 / 255, 34 / 255, 46 / 255),      // logo red  #B8222E
  grey: rgb(109 / 255, 110 / 255, 112 / 255),   // logo grey #6D6E70
  ink: rgb(0.10, 0.11, 0.13),
  line: rgb(0.80, 0.81, 0.83),
  band: rgb(0.945, 0.945, 0.95),
}

export function safe(s) {
  return String(s ?? '')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '*')
    .replace(/\u00A0/g, ' ')
    // Tab / LF / CR are matched on purpose \u2014 they are the control characters we keep.
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '?')
}

let _logoBytes = null
export async function logoBytes() {
  if (_logoBytes) return _logoBytes
  const res = await fetch(logoUrl)
  _logoBytes = new Uint8Array(await res.arrayBuffer())
  return _logoBytes
}

// Draws the letterhead: logo top-left (w pt wide, aspect kept) + address lines under it.
// Returns the y where content may continue.
export async function drawLetterhead(pdf, page, { x, top, logoWidth = 190 }) {
  let y = top
  try {
    const img = await pdf.embedJpg(await logoBytes())
    const h = logoWidth * (img.height / img.width)
    page.drawImage(img, { x, y: top - h, width: logoWidth, height: h })
    y = top - h - 6
  } catch { /* no logo available: fall through to text only */ }
  return y
}
