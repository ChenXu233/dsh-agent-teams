/**
 * Verification for the live member route registry (plan 10, §4.6).
 *
 * Imports the BUILT bundle (../lib/**.js) - run `pnpm build` first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyMemberRoute,
  dropMemberRoute,
  hasMemberRoute,
  registerMemberRoute,
} from '../lib/member-route-registry.js'

test('a registered setter receives the route and reports success', () => {
  const seen = []
  registerMemberRoute('child-1', (route) => seen.push(route))
  assert.equal(hasMemberRoute('child-1'), true)
  assert.equal(applyMemberRoute('child-1', { provider: 'p', model: 'm', reasoningEffort: 'high' }), true)
  assert.deepEqual(seen, [{ provider: 'p', model: 'm', reasoningEffort: 'high' }])
  dropMemberRoute('child-1')
})

test('a cold member has no setter and apply reports false', () => {
  assert.equal(hasMemberRoute('child-cold'), false)
  assert.equal(applyMemberRoute('child-cold', { provider: 'p', model: 'm' }), false)
})

test('registering again replaces the previous setter', () => {
  const first = []
  const second = []
  registerMemberRoute('child-2', (route) => first.push(route))
  registerMemberRoute('child-2', (route) => second.push(route))
  applyMemberRoute('child-2', { provider: 'p', model: 'm' })
  assert.equal(first.length, 0)
  assert.equal(second.length, 1)
  dropMemberRoute('child-2')
})
