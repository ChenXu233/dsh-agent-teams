/**
 * Verification for the member Remote surface (plan 10).
 *
 * The service class itself needs a live Cordis Context, so the testable core is
 * the pure view builders plus the address-failure translation; the class only
 * composes them.
 *
 * Imports the BUILT bundle (../lib/**.js) - run `pnpm build` first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { memberViewOf, queueViewOf, remoteAddressError } from '../lib/member-remote.js'
import { MemberAddressError } from '../lib/member-address.js'

function liveAgent(overrides = {}) {
  return {
    id: 'child-1',
    status: 'idle',
    options: { provider: 'deepseek', model: 'deepseek-v4' },
    inbox: { nextTurn: [], nextStep: [] },
    ...overrides,
  }
}

test('memberViewOf reports a live idle member with its model and queue depth', () => {
  const agent = liveAgent({ inbox: { nextTurn: [{ id: 'a' }], nextStep: [{ id: 'b' }, { id: 'c' }] } })
  const view = memberViewOf({ member: { name: 'alpha' }, team: { id: 'demo' } }, agent)
  assert.deepEqual(view, {
    member: 'alpha', teamId: 'demo', live: true, running: false, archived: false,
    model: { provider: 'deepseek', model: 'deepseek-v4' }, queued: 3,
  })
})

test('memberViewOf reports a cold member and a halted team without inventing state', () => {
  const view = memberViewOf({ member: { name: 'alpha' }, team: { id: 'demo', halted: true } }, undefined)
  assert.equal(view.live, false)
  assert.equal(view.running, false)
  assert.equal(view.archived, true)
  assert.equal(view.model, null)
  assert.equal(view.queued, 0)
})

test('queueViewOf renders both inbox lists with a bounded preview', () => {
  const long = 'x'.repeat(200)
  const agent = liveAgent({
    status: 'running',
    inbox: {
      nextTurn: [{ id: 't1', content: [{ type: 'text', text: 'first turn' }] }],
      nextStep: [{ id: 's1', content: [{ type: 'text', text: long }] }],
    },
  })
  const view = queueViewOf(agent)
  assert.equal(view.running, true)
  assert.deepEqual(view.items.map((item) => item.id), ['t1', 's1'])
  assert.equal(view.items[0].preview, 'first turn')
  assert.equal(view.items[1].preview.length, 80)
  assert.deepEqual(queueViewOf(undefined), { running: false, items: [] })
})

test('remoteAddressError keeps the domain code and its address detail', () => {
  const cold = remoteAddressError(
    new MemberAddressError('captain/offline', 'captain is gone'),
    { captainSessionId: 'captain-1', memberSessionId: 'child-1' },
  )
  assert.equal(cold.code, 'captain/offline')
  assert.deepEqual(cold.details, { captainSessionId: 'captain-1' })

  const missing = remoteAddressError(
    new MemberAddressError('member/not-found', 'no such member'),
    { captainSessionId: 'captain-1', memberSessionId: 'child-1' },
  )
  assert.equal(missing.code, 'member/not-found')
  assert.deepEqual(missing.details, { memberSessionId: 'child-1' })

  const passthrough = new Error('boom')
  assert.equal(remoteAddressError(passthrough, { captainSessionId: 'c', memberSessionId: 'm' }), passthrough)
})
