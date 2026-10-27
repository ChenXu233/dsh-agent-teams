/**
 * Verification for the composer-seat decision and the membership cache.
 *
 * Imports the BUILT client bundle pieces directly from lib/client/*.js.
 * Run `pnpm build` first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { decideComposerOwner, ownerSessionId } from '../lib/client/member-select.js'
import { ensureMembership, membershipOf, noteMembership, resetMembership } from '../lib/client/member-membership.js'

const member = { sessionId: 'child-1', session: { subagent: { address: { mode: 'continuable' } } } }

test('a continuable subagent is only claimed once membership is proven', () => {
  assert.equal(decideComposerOwner(member, 'unknown'), null)
  assert.equal(decideComposerOwner(member, 'not-member'), null)
  assert.equal(decideComposerOwner(member, 'member'), 'write')
  assert.equal(decideComposerOwner(member, 'member-archived'), 'readonly')
})

test('non-subagent and non-continuable sessions are never claimed', () => {
  assert.equal(decideComposerOwner({ session: null }, 'member'), null)
  assert.equal(decideComposerOwner({ session: {} }, 'member'), null)
  assert.equal(decideComposerOwner({ session: { subagent: { address: { mode: 'one-shot' } } } }, 'member'), null)
})

test('ownerSessionId only accepts a non-empty string', () => {
  assert.equal(ownerSessionId(member), 'child-1')
  assert.equal(ownerSessionId({}), undefined)
  assert.equal(ownerSessionId({ sessionId: '' }), undefined)
})

test('ensureMembership caches member, archived and 404 answers', async () => {
  resetMembership()
  const calls = []
  const ok = async (payload) => ({ status: 200, ok: true, json: async () => payload })
  await ensureMembership('child-1', async (url) => { calls.push(url); return ok({ archived: false }) })
  assert.equal(membershipOf('child-1'), 'member')
  await ensureMembership('child-1', async () => { throw new Error('must not refetch') })
  assert.equal(calls.length, 1)

  await ensureMembership('child-2', async () => ok({ archived: true }))
  assert.equal(membershipOf('child-2'), 'member-archived')

  await ensureMembership('child-3', async () => ({ status: 404, ok: false }))
  assert.equal(membershipOf('child-3'), 'not-member')

  await ensureMembership('child-4', async () => { throw new Error('offline') })
  assert.equal(membershipOf('child-4'), 'unknown', 'a transport failure stays retryable')

  noteMembership('child-5', 'member')
  assert.equal(membershipOf('child-5'), 'member')
  resetMembership()
})
