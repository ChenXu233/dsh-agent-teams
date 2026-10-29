/**
 * Verification for the native member model seat (plan 10, task 9).
 *
 * Imports the BUILT client bundle pieces directly from lib/client/*.js.
 * Run `pnpm build` first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MODEL_SLOT, applyMemberSelection, fetchMemberSelection, installMemberSeat,
} from '../lib/client/member-seat.js'
import { membershipOf, noteMembership, refreshMemberRoster, resetMembership } from '../lib/client/member-membership.js'

/** A directory shaped like the host's ModelDirectory. */
function makeDirectory(sessionId, realNext) {
  const listeners = new Set()
  const snapshot = {
    current: null, routable: null, groups: [], failures: [], status: 'ready', pending: null, error: null,
  }
  const store = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    set: (next) => { Object.assign(snapshot, next); for (const fn of [...listeners]) fn() },
  }
  const projected = {
    getSnapshot: () => (realNext === undefined ? {} : { next: realNext }),
    subscribe: () => () => {},
  }
  const calls = { select: [], selectModel: [] }
  const directory = {
    sessionId,
    available: () => false,
    projected,
    store,
    syncInputs: () => { store.set({ current: directory.projected.getSnapshot()?.next ?? null }) },
    load: async () => store.getSnapshot(),
    sessions: {
      selectModel: async (params) => { calls.selectModel.push(params); return { ok: true, value: undefined } },
    },
    select: async (selection) => {
      calls.select.push(selection)
      const result = await directory.sessions.selectModel({
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      })
      if (!result.ok) {
        store.set({ status: 'error', error: result.error.message })
        return result
      }
      directory.syncInputs()
      return { ok: true, value: undefined }
    },
  }
  return { directory, store, snapshot, calls }
}

/** A slots service with one model-slot entry already registered. */
function makeSlots(initial) {
  const entries = new Map([[MODEL_SLOT, [...initial]]])
  const listeners = new Set()
  const registered = []
  return {
    entries: (key) => entries.get(key) ?? [],
    entriesOfSlot: (key) => entries.get(key) ?? [],
    subscribe: (key, fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    register(options, component) {
      registered.push({ options, component })
      const entry = { inject: options.inject }
      entries.set(MODEL_SLOT, [...(entries.get(MODEL_SLOT) ?? []), entry])
      for (const fn of [...listeners]) fn()
      return () => undefined
    },
    _entries: entries,
    _registered: registered,
  }
}

function makeContext(services) {
  return { get: (name) => services[name] }
}

/** Host inject face for a session the host does not treat as selectable. */
function hostInject(sessions) {
  return (sessionId) => ({
    available: sessions.subagentAddress(sessionId) === undefined,
    directory: undefined,
    load: () => {},
    select: () => Promise.resolve(undefined),
  })
}

function makeHarness({ entries = [], realNext } = {}) {
  resetMembership()
  const sessions = {
    subagentAddress: (id) => (id.startsWith('sub-') ? { parentSessionId: 'captain', childSessionId: id, mode: 'continuable' } : undefined),
  }
  const { directory, store, calls } = makeDirectory('sub-1', realNext)
  const directories = new Map([['sub-1', directory]])
  const models = {
    directoryFor: (sessionId) => {
      const found = directories.get(sessionId)
      if (found !== undefined) return found
      const created = makeDirectory(sessionId, realNext)
      directories.set(sessionId, created.directory)
      return created.directory
    },
  }
  const slots = makeSlots(entries)
  const writes = []
  const seat = installMemberSeat(makeContext({
    modelDirectories: models,
    slots,
    sessions,
    remote: { session: { selectModel: async () => ({ ok: true, value: undefined }) } },
  }), {
    readSelection: async (sessionId) => (sessionId === 'sub-1' ? { provider: 'p', model: 'm', reasoningEffort: 'high' } : undefined),
    writeSelection: async (sessionId, selection) => {
      writes.push({ sessionId, selection })
      return { ok: true }
    },
  })
  return { seat, models, slots, sessions, directory, store, calls, writes }
}

test('the seat installs on the host surfaces it needs', () => {
  const harness = makeHarness()
  assert.equal(harness.seat.active, true)
  harness.seat.dispose()
})

test('a missing modelDirectories service leaves the seat inactive', () => {
  const seat = installMemberSeat(makeContext({ slots: makeSlots([]) }), {
    readSelection: async () => undefined,
    writeSelection: async () => ({ ok: true }),
  })
  assert.equal(seat.active, false)
  assert.match(seat.reason, /modelDirectories/)
})

test('an entry registered BEFORE the seat is patched for members only', () => {
  const entry = { inject: null }
  const harness = makeHarness({ entries: [entry] })
  const sessions = harness.sessions
  entry.inject = hostInject(sessions)
  // Re-install so the already-registered entry is the one patched.
  harness.seat.dispose()
  const { directory } = makeDirectory('sub-1')
  const models = { directoryFor: () => directory }
  const slots = makeSlots([entry])
  const seat = installMemberSeat(makeContext({ modelDirectories: models, slots, sessions }), {
    readSelection: async () => ({ provider: 'p', model: 'm' }),
    writeSelection: async () => ({ ok: true }),
  })
  noteMembership('sub-1', 'member')
  noteMembership('sub-2', 'not-member')
  assert.equal(entry.inject('sub-1').available, true, 'a member session gets the host pill')
  assert.equal(entry.inject('sub-2').available, false, 'a non-member subagent keeps the host refusal')
  assert.equal(entry.inject('plain').available, true, 'a normal session is untouched')
  seat.dispose()
  assert.equal(entry.inject('sub-1').available, false, 'disposal restores the host inject')
})

test('an unclassified subagent is eligible so a cold page keeps its seat', () => {
  const entry = { inject: null }
  const harness = makeHarness({ entries: [entry] })
  const sessions = harness.sessions
  entry.inject = hostInject(sessions)
  harness.seat.dispose()
  const models = { directoryFor: () => makeDirectory('sub-9').directory }
  const slots = makeSlots([entry])
  const seat = installMemberSeat(makeContext({ modelDirectories: models, slots, sessions }), {
    readSelection: async () => undefined,
    writeSelection: async () => ({ ok: true }),
  })
  assert.equal(membershipOf('sub-9'), 'unknown')
  assert.equal(entry.inject('sub-9').available, true)
  seat.dispose()
})

test('the seat directory reports the member route instead of history', async () => {
  const harness = makeHarness()
  harness.models.directoryFor('sub-1')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(harness.directory.available(), true)
  assert.deepEqual(harness.directory.projected.getSnapshot(), {
    next: { provider: 'p', model: 'm', reasoningEffort: 'high' },
  })
  harness.directory.syncInputs()
  assert.deepEqual(harness.store.getSnapshot().current, { provider: 'p', model: 'm', reasoningEffort: 'high' })
  harness.seat.dispose()
})

test('the host select path relays to /member/model and updates the pill', async () => {
  const harness = makeHarness()
  const directory = harness.models.directoryFor('sub-1')
  const result = await directory.select({ provider: 'q', model: 'n', reasoningEffort: 'max' })
  assert.equal(result.ok, true)
  assert.equal(harness.writes.length, 1)
  assert.deepEqual(harness.writes[0], {
    sessionId: 'sub-1',
    selection: { provider: 'q', model: 'n', reasoningEffort: 'max' },
  })
  assert.equal(harness.calls.selectModel.length, 0, 'the fenced Session Remote is never called')
  assert.deepEqual(harness.directory.projected.getSnapshot().next, { provider: 'q', model: 'n', reasoningEffort: 'max' })
  harness.directory.syncInputs()
  assert.deepEqual(harness.store.getSnapshot().current, { provider: 'q', model: 'n', reasoningEffort: 'max' })
  harness.seat.dispose()
})

test('a refused switch surfaces the plugin error on the host pill', async () => {
  resetMembership()
  const { directory } = makeDirectory('sub-3')
  const models = { directoryFor: () => directory }
  const slots = makeSlots([])
  const sessions = { subagentAddress: () => ({ parentSessionId: 'c', childSessionId: 'sub-3', mode: 'continuable' }) }
  const seat = installMemberSeat(makeContext({ modelDirectories: models, slots, sessions }), {
    readSelection: async () => ({ provider: 'p', model: 'm' }),
    writeSelection: async () => ({ ok: false, message: 'member agent is not resident' }),
  })
  noteMembership('sub-3', 'member')
  models.directoryFor('sub-3')
  const result = await directory.select({ provider: 'q', model: 'n' })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /not resident/)
  assert.match(directory.store.getSnapshot().error, /not resident/)
  seat.dispose()
})

test('fetchMemberSelection reads the plugin state view', async () => {
  const fetcher = async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ view: { model: { provider: 'p', model: 'm' }, reasoningEffort: 'high' } }),
  })
  assert.deepEqual(await fetchMemberSelection('sub-1', fetcher), { provider: 'p', model: 'm', reasoningEffort: 'high' })
  const cold = async () => ({ ok: false, status: 404, json: async () => ({}) })
  assert.equal(await fetchMemberSelection('sub-1', cold), undefined)
})

test('applyMemberSelection posts the route and normalizes failures', async () => {
  const seen = []
  const ok = async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true }) } }
  assert.deepEqual(await applyMemberSelection('sub-1', { provider: 'p', model: 'm' }, ok), { ok: true })
  assert.deepEqual(seen[0].body, { sessionId: 'sub-1', provider: 'p', model: 'm' })
  const refused = async () => ({ ok: false, status: 409, json: async () => ({ error: 'archived member' }) })
  assert.deepEqual(await applyMemberSelection('sub-1', { provider: 'p', model: 'm' }, refused), { ok: false, message: 'archived member' })
  const broken = async () => { throw new Error('offline') }
  assert.equal((await applyMemberSelection('sub-1', { provider: 'p', model: 'm' }, broken)).ok, false)
})

test('the roster prefetch fills membership for every listed member', async () => {
  resetMembership()
  const fetcher = async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ sessions: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: '' }, {}] }),
  })
  await refreshMemberRoster(fetcher)
  assert.equal(membershipOf('a'), 'member')
  assert.equal(membershipOf('b'), 'member')
  assert.equal(membershipOf('missing'), 'unknown')
})
