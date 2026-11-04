// Unit test for src/lib/fishbowlHealth.js — S17 A2, D-FB-63.
// Run: node --test src/lib/fishbowlHealth.test.mjs
//
// Fixture shaped like TEST's fb_sync_state after the bridge 1.11 PC run of 2026-11-03.

import test from 'node:test'
import assert from 'node:assert/strict'
import { familyHealth, bannerFamilies, formatFamilyAge, FAMILY_STAMPS } from './fishbowlHealth.js'

const NOW = Date.parse('2026-11-03T21:32:10Z')
const STATE = {
  last_rev_at: '2026-11-03T21:31:58Z',
  last_picks_at: '2026-11-03T21:31:58Z',
  last_shipments_at: '2026-11-03T21:31:59Z',
  last_mos_at: '2026-11-03T21:31:58Z',
  last_boms_at: '2026-11-03T15:30:00Z',
  last_tags_at: '2026-11-03T21:29:10Z',
  last_postings_at: '2026-11-03T21:30:10Z',
  last_inventory_at: '2026-11-03T21:30:00Z',
  last_users_at: '2026-11-03T21:31:39Z',
  last_purchasing_at: '2026-11-03T21:25:00Z',
  last_rules_at: '2026-11-03T07:10:00Z',
  last_valuation_at: '2026-11-03T07:09:00Z',
  family_errors: {},
}
const byFamily = (h) => Object.fromEntries(h.map((x) => [x.family, x]))

test('every mapped family gets its stamp and age; no errors means none shown', () => {
  const h = byFamily(familyHealth(STATE, NOW))
  assert.deepEqual(Object.keys(FAMILY_STAMPS).filter((f) => !h[f]), [])
  assert.equal(h.so.ageMs, 12000)
  assert.equal(h.tags.lastAt, '2026-11-03T21:29:10Z')
  assert.equal(h.boms.ageMs, 6 * 3600000 + 2 * 60000 + 10000)
  assert.ok(Object.values(h).every((x) => x.error === null))
})

test('an error newer than the family stamp is shown; an older one is hidden', () => {
  const newer = byFamily(familyHealth({ ...STATE, family_errors: { tags: { at: '2026-11-03T21:31:00Z', message: 'verify test' } } }, NOW))
  assert.deepEqual(newer.tags.error, { at: '2026-11-03T21:31:00Z', message: 'verify test' })
  const older = byFamily(familyHealth({ ...STATE, family_errors: { tags: { at: '2026-11-03T21:00:00Z', message: 'old failure' } } }, NOW))
  assert.equal(older.tags.error, null)
  const neverRan = byFamily(familyHealth({ ...STATE, last_tags_at: null, family_errors: { tags: { at: '2026-11-03T21:00:00Z', message: 'first run failed' } } }, NOW))
  assert.equal(neverRan.tags.error.message, 'first run failed')
})

test('a family without a stamp mapping is shown as-is and joins the banner row', () => {
  const h = familyHealth({ ...STATE, family_errors: { shipments: { at: '2026-11-03T20:00:00Z', message: 'lot read failed' } } }, NOW)
  const s = byFamily(h).shipments
  assert.deepEqual([s.lastAt, s.ageMs, s.error.message], [null, null, 'lot read failed'])
  assert.deepEqual(bannerFamilies(h).map((x) => x.family), ['so', 'picks', 'ships', 'mos', 'tags', 'postings', 'boms', 'shipments'])
})

test('hidden families appear on the banner only while in error', () => {
  assert.deepEqual(bannerFamilies(familyHealth(STATE, NOW)).map((x) => x.label), ['SO', 'Picks', 'Ships', 'MOs', 'Tags', 'Postings', 'BOMs'])
  const withInv = bannerFamilies(familyHealth({ ...STATE, family_errors: { inventory: { at: '2026-11-03T21:31:00Z', message: 'x' } } }, NOW))
  assert.equal(withInv.at(-1).family, 'inventory')
})

test('no sync row at all: every family unknown, nothing in error', () => {
  const h = familyHealth(null, NOW)
  assert.ok(h.every((x) => x.lastAt === null && x.ageMs === null && x.error === null))
})

test('ages read 12 s · 3 m · 6 h · 2 d', () => {
  assert.deepEqual([12000, 180000, 6 * 3600000, 2 * 86400000, null].map(formatFamilyAge), ['12 s', '3 m', '6 h', '2 d', '—'])
})
