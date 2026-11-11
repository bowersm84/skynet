// Unit test for src/lib/assemblyKioskMath.js — S17 Batch C, D-ASM-40.
// Run: node --test src/lib/assemblyKioskMath.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sortBuilds, splitBoard, waveLabel, sortLots, togglePick, coverage, lotsPayload,
  pendingSignoffs, inspectorStep, isNewLotSet, newLotSetText, formatMinutes, isAssemblyOperator, appendKey,
  tvColumns, pulledLotsByComponent, signerRule,
} from './assemblyKioskMath.js'

test('TV: every build in exactly one column; running wins over late; done only today', () => {
  const now = new Date(2026, 10, 10, 14, 0)
  const rows = [
    { build_number: 'R1', status: 'in_progress', open_sessions: 1, late: true, assigned_name: 'B' },
    { build_number: 'R2', status: 'in_progress', open_sessions: 2, late: false, assigned_name: 'A' },
    { build_number: 'P1', status: 'in_progress', open_sessions: 0, late: false, earliest_due: '2026-11-20' },
    { build_number: 'L1', status: 'paused', open_sessions: 0, late: true, earliest_due: '2026-11-05' },
    { build_number: 'L2', status: 'assigned', open_sessions: 0, late: true, earliest_due: '2026-11-01' },
    { build_number: 'W1', status: 'requested', open_sessions: 0, late: false, earliest_due: null },
    { build_number: 'W2', status: 'assigned', open_sessions: 0, late: false, earliest_due: '2026-11-12' },
    { build_number: 'D1', status: 'complete', completed_at: new Date(2026, 10, 10, 9, 0).toISOString() },
    { build_number: 'D2', status: 'released', completed_at: new Date(2026, 10, 9, 16, 0).toISOString() },
  ]
  const c = tvColumns(rows, now)
  assert.deepEqual(c.running.map((r) => r.build_number), ['R2', 'R1'])
  assert.deepEqual(c.late.map((r) => r.build_number), ['L2', 'L1'])
  assert.deepEqual(c.waiting.map((r) => r.build_number), ['W2', 'P1', 'W1'])
  assert.deepEqual(c.doneToday.map((r) => r.build_number), ['D1'])
})

test('board: most urgent first, mine vs open, nobody else\'s', () => {
  const builds = [
    { build_number: 'AB-3', priority: 'normal', earliest_due: '2026-12-31', assigned_to: 'me' },
    { build_number: 'AB-1', priority: 'normal', earliest_due: null, assigned_to: 'me' },
    { build_number: 'AB-2', priority: 'critical', earliest_due: null, assigned_to: null },
    { build_number: 'AB-4', priority: 'high', earliest_due: '2026-11-20', assigned_to: 'someone-else' },
    { build_number: 'AB-5', priority: 'normal', earliest_due: '2026-11-15', assigned_to: 'me' },
  ]
  assert.deepEqual(sortBuilds(builds).map((b) => b.build_number), ['AB-2', 'AB-4', 'AB-5', 'AB-3', 'AB-1'])
  const { mine, open } = splitBoard(builds, 'me')
  assert.deepEqual(mine.map((b) => b.build_number), ['AB-5', 'AB-3', 'AB-1'])
  assert.deepEqual(open.map((b) => b.build_number), ['AB-2'])
})

test('wave labels only for program builds', () => {
  assert.equal(waveLabel({ build_kind: 'program', wave_current: 1 }), 'Wave 1 of 2 — insert nylon')
  assert.equal(waveLabel({ build_kind: 'program', wave_current: 2 }), 'Wave 2 of 2 — final assembly')
  assert.equal(waveLabel({ build_kind: 'order', wave_current: 1 }), null)
})

test('lots: oldest received first, undated last', () => {
  const lots = [{ lot: 'C', received: null }, { lot: 'B', received: '2026-10-02' }, { lot: 'A', received: '2026-09-01' }]
  assert.deepEqual(sortLots(lots).map((l) => l.lot), ['A', 'B', 'C'])
})

test('a tap takes the smaller of what is still needed and what the tile holds; a second tap puts it back', () => {
  const comp = { component_part_number: 'SPRING', qty_needed: 450 }
  let picks = {}
  picks = togglePick(picks, 'SPRING', { tag_id: 1, lot: 'L1', qty: 349 }, 450)
  assert.deepEqual(coverage(picks, comp), { picked: 349, needed: 450, short: 101 })
  picks = togglePick(picks, 'SPRING', { tag_id: 2, lot: 'L2', qty: 500 }, 450)
  assert.deepEqual(picks.SPRING.map((p) => p.qty), [349, 101])
  assert.equal(coverage(picks, comp).short, 0)
  // covered: a third tile is ignored
  const same = togglePick(picks, 'SPRING', { tag_id: 3, lot: 'L3', qty: 50 }, 450)
  assert.equal(same, picks)
  // untap the first: it goes back, the second keeps its 101
  picks = togglePick(picks, 'SPRING', { tag_id: 1, lot: 'L1', qty: 349 }, 450)
  assert.deepEqual(picks.SPRING, [{ tag_id: 2, lot: 'L2', qty: 101 }])
})

test('start payload: one entry per part and lot, tags of the same lot summed', () => {
  const picks = {
    SPRING: [{ tag_id: 7, lot: 'L1', qty: 200 }, { tag_id: 8, lot: 'L1', qty: 100 }],
    BODY: [{ tag_id: 9, lot: 'B5', qty: 300 }],
  }
  assert.deepEqual(lotsPayload(picks), [
    { part: 'SPRING', lot: 'L1', tag_id: 7, qty: 300 },
    { part: 'BODY', lot: 'B5', tag_id: 9, qty: 300 },
  ])
})

test('sign-offs: release is Jody\'s; the inspector PIN at closeout only for a one-PIN inspect step not yet passed', () => {
  const steps = [
    { step_id: 'a', type: 'pull', pins: 0 },
    { step_id: 'b', type: 'pull_check', pins: 2, signed: true, result: 'pass' },
    { step_id: 'c', type: 'pressure_test', pins: 2, signed: true, result: 'fail' },
    { step_id: 'd', type: 'inspect', pins: 1, signed: false },
    { step_id: 'e', type: 'release', pins: 1, signed: false },
  ]
  assert.deepEqual(pendingSignoffs(steps).map((s) => s.step_id), ['c', 'd'])
  assert.equal(inspectorStep(steps).step_id, 'd')
  assert.equal(inspectorStep([{ type: 'inspect', pins: 2, signed: false }]), null)
  assert.equal(inspectorStep([{ type: 'inspect', pins: 1, signed: true, result: 'pass' }]), null)
})

test('NEW_LOT_SET is recognised and its sentence kept', () => {
  const msg = 'NEW_LOT_SET: this combination of lots is new for SK2003-42A — a second person must check the pull'
  assert.equal(isNewLotSet(msg), true)
  assert.equal(newLotSetText(msg), 'this combination of lots is new for SK2003-42A — a second person must check the pull')
  assert.equal(isNewLotSet('Lot 123 of X has 5 on hand, 10 pulled'), false)
})

test('minutes, operator gate, number pad', () => {
  assert.equal(formatMinutes(0), '0 min')
  assert.equal(formatMinutes(75.4), '1 h 15 min')
  assert.equal(formatMinutes(120), '2 h')
  assert.equal(isAssemblyOperator({ role: 'machinist', roles: ['assembly'] }), true)
  assert.equal(isAssemblyOperator({ role: 'admin', roles: [] }), true)
  assert.equal(isAssemblyOperator({ role: 'finishing', roles: [] }), false)
  assert.equal(appendKey('', '0'), '0')
  assert.equal(appendKey('0', '5'), '5')
  assert.equal(appendKey('12', '.', { decimal: true }), '12.')
  assert.equal(appendKey('12.', '.', { decimal: true }), '12.')
  assert.equal(appendKey('12', '.'), '12')
  assert.equal(appendKey('', '.', { decimal: true }), '0.')
  assert.equal(appendKey('1234567', '8'), '1234567')
})

test('D-ASM-58: pulled lots grouped by component in BOM order, lots merged and sorted', () => {
  const components = [
    { component_part_number: 'SKYTEST-STUD', part_description: 'Stud' },
    { component_part_number: 'SKYTEST-SPRING', part_description: 'Spring' },
    { component_part_number: 'SKYTEST-CUP', part_description: 'Cup' },
  ]
  const rows = [
    { part: 'SKYTEST-CUP', lot: '100583', qty: 4 },
    { part: 'SKYTEST-STUD', lot: '100452', qty: 4 },
    { part: 'SKYTEST-STUD', lot: '100236', qty: 5 },
    { part: 'SKYTEST-STUD', lot: '100236', qty: 1 },
    { part: 'OFF-BOM', lot: '1', qty: 2 },
  ]
  assert.deepEqual(pulledLotsByComponent(rows, components), [
    { part: 'SKYTEST-STUD', description: 'Stud', lots: [{ lot: '100236', qty: 6 }, { lot: '100452', qty: 4 }], total: 10 },
    { part: 'SKYTEST-CUP', description: 'Cup', lots: [{ lot: '100583', qty: 4 }], total: 4 },
    { part: 'OFF-BOM', description: '', lots: [{ lot: '1', qty: 2 }], total: 2 },
  ])
  assert.deepEqual(pulledLotsByComponent(null, components), [])
})

test('D-ASM-58: signer wording for one and two PINs, with and without a not-the-assembler rule', () => {
  assert.equal(signerRule(1, 'puller'), 'Checked by someone other than the assembler')
  assert.equal(signerRule(2, 'puller'), 'Two different people · the first is not the assembler')
  assert.equal(signerRule(2, null), 'Two different people')
  assert.equal(signerRule(1, null), null)
})
