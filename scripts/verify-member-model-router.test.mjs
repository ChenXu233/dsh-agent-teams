/**
 * Verification for the member model router.
 *
 * This plugin no longer owns the model seat: `dsh-proton-adapter-dsh` does, and
 * it asks this router one question per session. What is worth pinning here is
 * the ANSWER — a session that is not a proven member must keep the shipped
 * routing (a picker that cannot work belongs on no one else's subagent page),
 * and a member must get exactly the three members that decide where a selection
 * goes, with the shipped directory left alone.
 *
 * Imports the BUILT bundle (../lib/**.js) - run `pnpm build` first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MEMBER_MODEL_URL,
  createMemberModelRouter,
  memberSeatRouting,
  memberSeatRouted,
  selectMemberModel,
  subscribeMemberSeat,
} from '../lib/client/member-model-router.js'
import { noteMembership, resetMembership } from '../lib/client/member-membership.js'

/** Route-selecting fetch stub. */
function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** A Response-ish object good enough for the success path. */
function okResponse() {
  return { ok: true, status: 200, statusText: 'OK', text: async () => '' }
}

// ---------------------------------------------------------------------------
// A. What the seat is told
// ---------------------------------------------------------------------------

test('A1. a session that is not a member keeps the shipped routing', () => {
  resetMembership()
  const route = createMemberModelRouter()
  assert.equal(route('parent-1'), undefined)
  assert.equal(route('parent-1'), undefined)
  noteMembership('parent-1', 'not-member')
  assert.equal(route('parent-1'), undefined)
})

test('A2. an archived member keeps the shipped routing too', () => {
  resetMembership()
  noteMembership('child-archived', 'member-archived')
  assert.equal(createMemberModelRouter()('child-archived'), undefined)
})

test('A3. no session id means no opinion', () => {
  resetMembership()
  assert.equal(createMemberModelRouter()(undefined), undefined)
})

test('A4. a proven member gets the three routing members and nothing else', () => {
  resetMembership()
  noteMembership('child-1', 'member')
  const routing = createMemberModelRouter()('child-1')
  assert.deepEqual(Object.keys(routing).sort(), ['available', 'load', 'select'])
  // The shipped directory already carries the model groups (with the reasoning
  // metadata the effort menu needs) and the member's own selection projection.
  assert.equal('directory' in routing, false)
  // Without this the shipped picker renders null for every addressed subagent.
  assert.equal(routing.available, true)
  // Both shipped entries call load() on open; the fenced one throws, so the
  // replacement must be a callable no-op rather than an absent member.
  assert.equal(typeof routing.load, 'function')
  assert.equal(routing.load(), undefined)
})

test('A5. a member selection reaches the member route as submitted', async () => {
  const stub = stubFetch(() => okResponse())
  try {
    const result = await memberSeatRouting('child-1').select({ provider: 'deepseek', model: 'v4', reasoningEffort: 'high' })
    assert.deepEqual(result, { ok: true })
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].url, MEMBER_MODEL_URL)
    assert.equal(stub.calls[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(stub.calls[0].init.body), {
      sessionId: 'child-1', provider: 'deepseek', model: 'v4', reasoningEffort: 'high',
    })
  } finally {
    stub.restore()
  }
})

test('A6. an absent effort stays absent instead of becoming an empty string', async () => {
  const stub = stubFetch(() => okResponse())
  try {
    await memberSeatRouting('child-1').select({ provider: 'deepseek', model: 'v4' })
    assert.equal('reasoningEffort' in JSON.parse(stub.calls[0].init.body), false)
  } finally {
    stub.restore()
  }
})

test('A7. a refusal answers in the shape the shipped picker toasts', async () => {
  const stub = stubFetch(() => ({ ok: false, status: 409, statusText: 'Conflict', text: async () => 'member agent is not resident' }))
  try {
    const result = await memberSeatRouting('child-1').select({ provider: 'deepseek', model: 'v4' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'member/model-409')
    assert.match(result.error.message, /not resident/u)
  } finally {
    stub.restore()
  }
})

test('A8. a transport failure resolves instead of rejecting', async () => {
  const stub = stubFetch(() => { throw new Error('offline') })
  try {
    const result = await selectMemberModel('child-1', { provider: 'deepseek', model: 'v4' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'member/model-unreachable')
    assert.match(result.error.message, /offline/u)
  } finally {
    stub.restore()
  }
})

// ---------------------------------------------------------------------------
// B. What it reports back
// ---------------------------------------------------------------------------

test('B1. routing a member is recorded once and announced once', async () => {
  // A session id no earlier case has routed: the record is process-wide on
  // purpose (the seat asks once per session), so a shared id would hide the
  // first transition this case exists to check.
  const sessionId = 'child-b1'
  resetMembership()
  noteMembership(sessionId, 'member')
  const route = createMemberModelRouter()
  const seen = []
  const unsubscribe = subscribeMemberSeat(() => seen.push('changed'))

  assert.equal(memberSeatRouted(sessionId), false)
  assert.notEqual(route(sessionId), undefined)
  assert.equal(memberSeatRouted(sessionId), true)
  // A second assembly for the same session must not re-announce: the fallback
  // pill subscribes to this and a notify-per-render would thrash it.
  assert.notEqual(route(sessionId), undefined)
  await new Promise(resolve => queueMicrotask(resolve))
  assert.deepEqual(seen, ['changed'])

  unsubscribe()
})

test('B2. a session that only passed through is never marked routed', async () => {
  resetMembership()
  const seen = []
  const unsubscribe = subscribeMemberSeat(() => seen.push('changed'))
  const route = createMemberModelRouter()
  assert.equal(route('parent-1'), undefined)
  noteMembership('parent-1', 'not-member')
  assert.equal(route('parent-1'), undefined)
  await new Promise(resolve => queueMicrotask(resolve))
  assert.deepEqual(seen, [])
  assert.equal(memberSeatRouted('parent-1'), false)
  unsubscribe()
})
