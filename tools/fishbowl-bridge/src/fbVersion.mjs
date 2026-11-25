// fbVersion.mjs — bridge 1.13 (S17 D2a, D-ASM-61): the Fishbowl server version, read from the database and compared
// the same way SkyNet compares it (_fb_version_at_least). Automatic posting runs only on a version proven by the
// probes (26.11, D-ASM-59 / D-ASM-60); live Fishbowl is 25.9.
import { q } from './queries.mjs'

// The first major.minor in the text, with the year cut to two digits: 'Fishbowl v2026.11' -> '26.11',
// '2025.9' -> '25.9', '26.11' -> '26.11'. No match -> null. Same rule as the sandbox probe's fence 3.
export function parseFishbowlVersion(text) {
  const m = String(text ?? '').match(/(\d{2,4})\.(\d+)/)
  if (!m) return null
  const major = m[1].length === 4 ? m[1].slice(2) : m[1]
  return `${major}.${m[2]}`
}

// major then minor, as whole numbers, so 26.9 is below 26.11. Null or unreadable on either side -> false.
// Mirrors SkyNet's _fb_version_at_least: both read '^(\d+)\.(\d+)' from the start of the string.
export function versionAtLeast(version, min) {
  const a = String(version ?? '').match(/^(\d+)\.(\d+)/)
  const m = String(min ?? '').match(/^(\d+)\.(\d+)/)
  if (!a || !m) return false
  const [aMaj, aMin, mMaj, mMin] = [a[1], a[2], m[1], m[2]].map(Number)
  return aMaj > mMaj || (aMaj === mMaj && aMin >= mMin)
}

// One read-only query: the newest databaseversion row. Returns { raw, version } (version null when unreadable).
export async function readFishbowlVersion(fb) {
  const rows = await fb.query(q.fishbowlVersion)
  const raw = rows[0]?.alterCommand ?? null
  return { raw, version: parseFishbowlVersion(raw) }
}
