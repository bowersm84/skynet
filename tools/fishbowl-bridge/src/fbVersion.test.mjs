// fbVersion.test.mjs — the Fishbowl version parse and compare (D-ASM-61). Run: node --test src/fbVersion.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFishbowlVersion, versionAtLeast, readFishbowlVersion } from './fbVersion.mjs'

test('parse: the first major.minor, year cut to two digits; nothing readable -> null', () => {
  assert.equal(parseFishbowlVersion('Fishbowl v2026.11'), '26.11')
  assert.equal(parseFishbowlVersion('2025.9'), '25.9')
  assert.equal(parseFishbowlVersion('26.11'), '26.11')
  assert.equal(parseFishbowlVersion('Fishbowl Advanced 2025.9.1'), '25.9')
  assert.equal(parseFishbowlVersion('no version here'), null)
  assert.equal(parseFishbowlVersion(''), null)
  assert.equal(parseFishbowlVersion(null), null)
  assert.equal(parseFishbowlVersion(undefined), null)
})

test('compare: major then minor as whole numbers, as SkyNet _fb_version_at_least does', () => {
  assert.equal(versionAtLeast('26.11', '26.11'), true)
  assert.equal(versionAtLeast('26.12', '26.11'), true)
  assert.equal(versionAtLeast('27.1', '26.11'), true)
  assert.equal(versionAtLeast('26.9', '26.11'), false) // 9 < 11, not "26.9" > "26.11" as text
  assert.equal(versionAtLeast('26.9.1', '26.11'), false)
  assert.equal(versionAtLeast('25.9', '26.11'), false)
  assert.equal(versionAtLeast(null, '26.11'), false)
  assert.equal(versionAtLeast('26.11', null), false)
  assert.equal(versionAtLeast('v26.11', '26.11'), false) // unreadable from the start, as in SQL
  assert.equal(versionAtLeast('', ''), false)
})

test('read: one databaseversion query, alterCommand parsed', async () => {
  const sent = []
  const fb = { query: async (sql) => { sent.push(sql); return [{ version: 1234, alterCommand: 'Fishbowl v2026.11' }] } }
  assert.deepEqual(await readFishbowlVersion(fb), { raw: 'Fishbowl v2026.11', version: '26.11' })
  assert.deepEqual(sent, ['SELECT version, alterCommand FROM databaseversion ORDER BY version DESC LIMIT 1'])
  const empty = { query: async () => [] }
  assert.deepEqual(await readFishbowlVersion(empty), { raw: null, version: null })
})
