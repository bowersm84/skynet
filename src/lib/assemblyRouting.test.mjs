// Unit test for src/lib/assemblyRouting.js — S17 B.1, D-ASM-30 (the D-NEST-13 deferred fix).
// Run: node --test src/lib/assemblyRouting.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { componentNextStatus, feedsLiveAssembly } from './assemblyRouting.js'

test('flag off: every component job goes to pending_tco, whatever it feeds (PROD today)', () => {
  assert.equal(componentNextStatus({ assemblyModule: false, woa: { status: 'pending' } }), 'pending_tco')
  assert.equal(componentNextStatus({ assemblyModule: false, woa: null }), 'pending_tco')
})

test('flag on + component of a live WOA: ready_for_assembly', () => {
  assert.equal(componentNextStatus({ assemblyModule: true, woa: { status: 'pending' } }), 'ready_for_assembly')
  assert.equal(componentNextStatus({ assemblyModule: true, woa: { status: 'in_progress' } }), 'ready_for_assembly')
  assert.equal(componentNextStatus({ assemblyModule: true, woa: { status: null } }), 'ready_for_assembly') // pre-status rows
  // an open build on the WOA keeps it live even if the WOA row already reads complete
  assert.equal(componentNextStatus({ assemblyModule: true, woa: { status: 'complete' }, build: { status: 'in_progress' } }), 'ready_for_assembly')
})

test('flag on + not a component of anything live: pending_tco', () => {
  assert.equal(componentNextStatus({ assemblyModule: true, woa: null }), 'pending_tco')               // standalone component job
  assert.equal(componentNextStatus({ assemblyModule: true, woa: { status: 'complete' } }), 'pending_tco')
  assert.equal(componentNextStatus({ assemblyModule: true, woa: { status: 'complete' }, build: { status: 'released' } }), 'pending_tco')
  assert.equal(componentNextStatus({ assemblyModule: true, woa: null, build: { status: 'cancelled' } }), 'pending_tco')
})

test('finished-good sub-assembly parent chain: a finished-good job feeding a live sub-WOA goes to assembly', () => {
  // SK2003-10A is a finished good with its own BOM inside SK2003-42A (D-NEST-13 note 2). Its job is linked to the
  // finished-good sub-WOA, which is pending under the in-progress SK2003-42A WOA. Under the old part-type rule this
  // job went straight to pending_tco and the sub-WOA, and so the parent, could never complete.
  const subWoa = { status: 'pending', part_type: 'finished_good', parent: { status: 'in_progress', part_type: 'assembly' } }
  assert.equal(feedsLiveAssembly({ woa: subWoa }), true)
  assert.equal(componentNextStatus({ assemblyModule: true, woa: subWoa }), 'ready_for_assembly')
})
