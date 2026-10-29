/**
 * Verification for the native member command catalog (plan 10, task 9).
 *
 * Imports the BUILT client bundle pieces directly from lib/client/*.js.
 * Run `pnpm build` first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { descriptorsOf, installMemberCommands } from '../lib/client/member-commands.js'
import { noteMembership, resetMembership } from '../lib/client/member-membership.js'

function makeContext(face, subagentIds = ['sub-1']) {
  return {
    get: (name) => {
      if (name === 'remote.commands') return face
      if (name === 'sessions') {
        return { subagentAddress: (id) => (subagentIds.includes(id) ? { parentSessionId: 'captain', childSessionId: id, mode: 'continuable' } : undefined) }
      }
      return undefined
    },
  }
}

function makeFace() {
  const calls = { list: [], execute: [] }
  return {
    calls,
    list: async (sessionId) => { calls.list.push(sessionId); return { ok: true, value: [{ name: 'host-command' }] } },
    execute: async (sessionId, line) => { calls.execute.push({ sessionId, line }); return { ok: true, value: undefined } },
  }
}

function fetcherFor(routes) {
  return async (url, init) => {
    const key = init?.method === 'POST' ? 'POST ' + url : 'GET ' + url
    const handler = routes[key] ?? routes[url]
    if (handler === undefined) throw new Error('unexpected request ' + key)
    return handler(init)
  }
}

test('descriptorsOf maps the plugin catalog onto the host shape', () => {
  assert.deepEqual(descriptorsOf({
    commands: [
      { name: 'compact', description: 'Compact the context' },
      { name: 'export', hint: 'path', attachments: true },
      { name: '' },
      {},
    ],
  }), [
    { name: 'compact', description: 'Compact the context' },
    { name: 'export', input: { hint: 'path', attachments: true } },
  ])
  assert.deepEqual(descriptorsOf(undefined), [])
})

test('a member session lists the plugin catalog instead of the fenced Remote', async () => {
  resetMembership()
  const face = makeFace()
  const seen = []
  const seat = installMemberCommands(makeContext(face), {
    fetcher: fetcherFor({
      'GET /plugins/dsh-agent-teams/member/commands?sessionId=sub-1': async () => ({
        ok: true,
        status: 200,
        json: async () => ({ live: false, commands: [{ name: 'compact' }, { name: 'export' }] }),
      }),
    }),
  })
  assert.equal(seat.active, true)
  noteMembership('sub-1', 'member')
  const result = await face.list('sub-1')
  assert.deepEqual(result, { ok: true, value: [{ name: 'compact' }, { name: 'export' }] })
  assert.equal(face.calls.list.length, 0, 'the fenced list call is never made')
  seat.dispose()
  await face.list('sub-1')
  assert.equal(face.calls.list.length, 1, 'disposal restores the host path')
})

test('a non-member session keeps the host list and execute', async () => {
  resetMembership()
  const face = makeFace()
  const seat = installMemberCommands(makeContext(face), { fetcher: async () => { throw new Error('must not fetch') } })
  noteMembership('sub-2', 'not-member')
  assert.deepEqual(await face.list('sub-2'), { ok: true, value: [{ name: 'host-command' }] })
  await face.execute('sub-2', '/compact')
  assert.equal(face.calls.execute.length, 1)
  seat.dispose()
})

test('execute relays the line and returns the host result shape', async () => {
  resetMembership()
  const face = makeFace()
  const posted = []
  const seat = installMemberCommands(makeContext(face), {
    fetcher: fetcherFor({
      'POST /plugins/dsh-agent-teams/member/relay': async (init) => {
        posted.push(JSON.parse(init.body))
        return { ok: true, status: 200, json: async () => ({ commandId: 'c-1', result: { kind: 'success' } }) }
      },
    }),
  })
  noteMembership('sub-1', 'member')
  const result = await face.execute('sub-1', '/compact', [])
  assert.deepEqual(result, { ok: true, value: { commandId: 'c-1', result: { kind: 'success' } } })
  assert.deepEqual(posted[0], { memberSessionId: 'sub-1', line: '/compact', mode: 'queue' })
  assert.equal(face.calls.execute.length, 0)
  seat.dispose()
})

test('a refused relay surfaces the plugin error to the composer', async () => {
  resetMembership()
  const face = makeFace()
  const seat = installMemberCommands(makeContext(face), {
    fetcher: fetcherFor({
      'POST /plugins/dsh-agent-teams/member/relay': async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: 'member agent is not resolvable: sub-1' }),
      }),
    }),
  })
  noteMembership('sub-1', 'member')
  const result = await face.execute('sub-1', '/compact', [])
  assert.equal(result.ok, false)
  assert.match(result.error.message, /not resolvable/)
  assert.equal(result.error.code, 'agent-teams/member-command')
  seat.dispose()
})

test('an unclassified subagent is eligible so a cold page keeps its menu', async () => {
  resetMembership()
  const face = makeFace()
  const seat = installMemberCommands(makeContext(face, ['sub-1', 'sub-9']), {
    fetcher: fetcherFor({
      'GET /plugins/dsh-agent-teams/member/commands?sessionId=sub-9': async () => ({
        ok: true,
        status: 200,
        json: async () => ({ commands: [{ name: 'compact' }] }),
      }),
    }),
  })
  const result = await face.list('sub-9')
  assert.deepEqual(result, { ok: true, value: [{ name: 'compact' }] })
  seat.dispose()
})

test('a missing remote commands face leaves the patch inactive', () => {
  const seat = installMemberCommands({ get: () => undefined })
  assert.equal(seat.active, false)
  assert.match(seat.reason, /commands/)
})
test('the catalog loader is replaced for members and restored on dispose', async () => {
  resetMembership()
  const face = makeFace()
  const calls = []
  const directory = {
    fetchCommands: async (sessionId) => { calls.push(sessionId); return [{ name: 'host-command' }] },
  }
  const ctx = {
    get: (name) => {
      if (name === 'remote.commands') return face
      if (name === 'commandUi') return { directory }
      if (name === 'sessions') return { subagentAddress: (id) => (['sub-1', 'sub-2'].includes(id) ? { parentSessionId: 'captain', childSessionId: id, mode: 'continuable' } : undefined) }
      return undefined
    },
  }
  const seat = installMemberCommands(ctx, {
    fetcher: fetcherFor({
      'GET /plugins/dsh-agent-teams/member/commands?sessionId=sub-1': async () => ({
        ok: true,
        status: 200,
        json: async () => ({ commands: [{ name: 'compact' }] }),
      }),
    }),
  })
  noteMembership('sub-1', 'member')
  noteMembership('sub-2', 'not-member')
  assert.deepEqual(await directory.fetchCommands('sub-1'), [{ name: 'compact' }])
  assert.equal(calls.length, 0, 'the fenced loader gate is bypassed for a member')
  assert.deepEqual(await directory.fetchCommands('sub-2'), [{ name: 'host-command' }])
  assert.deepEqual(calls, ['sub-2'], 'a non-member keeps the host loader')
  seat.dispose()
  assert.deepEqual(await directory.fetchCommands('sub-1'), [{ name: 'host-command' }])
  assert.deepEqual(calls, ['sub-2', 'sub-1'])
})
test('the command runtime execute funnels member lines to the relay', async () => {
  resetMembership()
  const face = makeFace()
  const ran = []
  const runtime = { execute: async (session, line) => { ran.push({ session, line }); return { kind: 'success' } } }
  const posted = []
  const ctx = {
    get: (name) => {
      if (name === 'remote.commands') return face
      if (name === 'commandUi') return runtime
      if (name === 'sessions') return { subagentAddress: (id) => (['sub-1', 'sub-2'].includes(id) ? { parentSessionId: 'captain', childSessionId: id, mode: 'continuable' } : undefined) }
      return undefined
    },
  }
  const seat = installMemberCommands(ctx, {
    fetcher: fetcherFor({
      'POST /plugins/dsh-agent-teams/member/relay': async (init) => {
        posted.push(JSON.parse(init.body))
        return { ok: true, status: 200, json: async () => ({ commandId: 'c-1', result: { kind: 'success' } }) }
      },
    }),
  })
  noteMembership('sub-1', 'member')
  noteMembership('sub-2', 'not-member')
  assert.deepEqual(await runtime.execute({ sessionId: 'sub-1' }, '/compact'), { kind: 'success' })
  assert.deepEqual(posted[0], { memberSessionId: 'sub-1', line: '/compact', mode: 'queue' })
  assert.equal(ran.length, 0, 'the host path is bypassed for a member')
  await runtime.execute({ sessionId: 'sub-2' }, '/compact')
  assert.equal(ran.length, 1, 'a non-member keeps the host path')
  seat.dispose()
  await runtime.execute({ sessionId: 'sub-1' }, '/compact')
  assert.equal(ran.length, 2, 'disposal restores the host path')
})

test('a refused relay becomes an error outcome the composer can show', async () => {
  resetMembership()
  const face = makeFace()
  const runtime = { execute: async () => ({ kind: 'success' }) }
  const ctx = {
    get: (name) => {
      if (name === 'remote.commands') return face
      if (name === 'commandUi') return runtime
      if (name === 'sessions') return { subagentAddress: () => ({ parentSessionId: 'captain', childSessionId: 'sub-1', mode: 'continuable' }) }
      return undefined
    },
  }
  installMemberCommands(ctx, {
    fetcher: fetcherFor({
      'POST /plugins/dsh-agent-teams/member/relay': async () => ({ ok: false, status: 409, json: async () => ({ error: 'member agent is not resolvable: sub-1' }) }),
    }),
  })
  noteMembership('sub-1', 'member')
  const outcome = await runtime.execute({ sessionId: 'sub-1' }, '/compact')
  assert.equal(outcome.kind, 'error')
  assert.match(outcome.text, /not resolvable/)
})
