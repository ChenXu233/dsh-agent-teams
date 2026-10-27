/**
 * Verification for member residency (plan 10, appendix A).
 *
 * Drives a fake Agent whose inbox mirrors the host's ReactLoopInbox contract:
 * next-step parking keeps the activation resident and never starts a turn;
 * delivery removes the placeholder in the same synchronous block.
 *
 * Imports the BUILT bundle (../lib/**.js) - run \`pnpm build\` first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MEMBER_RESIDENCY_MARKER,
  parkMember,
  unparkMember,
  isParked,
  parkedMessageId,
} from '../lib/member-residency.js'
import { deliverToMember } from '../lib/members.js'

function fakeAgent() {
  const nextTurn = []
  const nextStep = []
  const agent = {
    id: 'child-session-0001',
    session: { header: { cwd: '/tmp', version: 4 } },
    inbox: {
      get nextTurn() { return nextTurn },
      get nextStep() { return nextStep },
      get hasPending() { return nextTurn.length > 0 || nextStep.length > 0 },
      append(target, message) {
        ;(target === 'next-turn' ? nextTurn : nextStep).push(message)
      },
      remove(id) {
        for (const list of [nextTurn, nextStep]) {
          const index = list.findIndex(message => message.id === id)
          if (index >= 0) {
            list.splice(index, 1)
            return true
          }
        }
        return false
      },
    },
    inject(message) { agent.inbox.append('next-step', message) },
    followup(message) { agent.inbox.append('next-turn', message) },
  }
  return agent
}

test('parkMember appends one next-step placeholder and returns its id', () => {
  const agent = fakeAgent()
  const id = parkMember(agent)
  assert.equal(typeof id, 'string')
  assert.equal(agent.inbox.nextStep.length, 1)
  assert.equal(agent.inbox.nextTurn.length, 0, 'parking must not queue a turn')
  assert.equal(agent.inbox.nextStep[0].id, id)
  assert.equal(agent.inbox.nextStep[0].content[0].text, MEMBER_RESIDENCY_MARKER)
})

test('parkMember is idempotent while the placeholder is pending', () => {
  const agent = fakeAgent()
  const first = parkMember(agent)
  const second = parkMember(agent)
  assert.equal(second, first)
  assert.equal(agent.inbox.nextStep.length, 1)
})

test('unparkMember removes exactly that message', () => {
  const agent = fakeAgent()
  const id = parkMember(agent)
  assert.equal(unparkMember(agent, id), true)
  assert.equal(agent.inbox.nextStep.length, 0)
  assert.equal(unparkMember(agent, id), false, 'second removal reports the item is gone')
})

test('isParked and parkedMessageId follow the placeholder', () => {
  const agent = fakeAgent()
  assert.equal(isParked(agent), false)
  assert.equal(parkedMessageId(agent), undefined)
  const id = parkMember(agent)
  assert.equal(isParked(agent), true)
  assert.equal(parkedMessageId(agent), id)
  unparkMember(agent)
  assert.equal(isParked(agent), false)
  assert.equal(parkedMessageId(agent), undefined)
})

test('deliverToMember wakes a parked member and drops the marker in one step', async () => {
  const agent = fakeAgent()
  parkMember(agent)
  const ctx = {
    agents: { get: () => agent },
    subagents: {},
    logger: { warn() {} },
  }
  const delivered = await deliverToMember(ctx, { id: 'captain-session' }, agent.id, 'do the thing', new AbortController().signal)
  assert.equal(delivered, true)
  assert.equal(agent.inbox.nextTurn.length, 1)
  assert.equal(agent.inbox.nextTurn[0].content[0].text, 'do the thing')
  assert.equal(agent.inbox.nextStep.length, 0, 'marker must be gone before the loop claims the turn')
  assert.equal(isParked(agent), false)
})

test('a pending turn still reports parked: residency does not disturb delivery', () => {
  const agent = fakeAgent()
  parkMember(agent)
  agent.followup({ id: 'real-turn', content: [] })
  assert.equal(agent.inbox.nextTurn.length, 1)
  assert.equal(agent.inbox.nextStep.length, 1)
  assert.equal(isParked(agent), true)
})
