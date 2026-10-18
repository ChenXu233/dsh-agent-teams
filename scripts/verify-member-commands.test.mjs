import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MEMBER_PROMPT_URL,
  activeMemberCommands,
  commandDraftFor,
  commandLineFor,
  createMemberCommandClient,
  envelopeFailure,
  envelopeValue,
  isMemberCommandsPort,
  parseCommandExecution,
  parseCommandList,
  promptTextFor,
  provideMemberCommands,
  transportDetail,
} from '../lib/client/command-client.js'

/** Member A's catalog, as the host's commands/list answers for its own session. */
const CATALOG_A = [
  { name: 'compact', description: 'Compact the context', input: { hint: 'optional instructions' } },
  { name: 'help', description: 'Show available commands' },
]
/** Member B's catalog: deliberately different, so a shared cache would fail. */
const CATALOG_B = [{ name: 'status', description: 'Report status' }]

function fakePort(overrides = {}) {
  const calls = { list: [], execute: [] }
  return {
    calls,
    list: async (sessionId) => {
      calls.list.push(sessionId)
      return { ok: true, value: sessionId === 'member-a' ? CATALOG_A : CATALOG_B }
    },
    execute: async (sessionId, line, attachments) => {
      calls.execute.push({ sessionId, line, attachments })
      return { ok: true, value: { commandId: 'c1', result: { kind: 'success', text: 'ok' } } }
    },
    ...overrides,
  }
}

const target = (memberSessionId, member = memberSessionId) => ({
  sessionId: 'captain-1', teamId: 'team-1', member, memberSessionId,
})

test('list refusal keeps the host code and message', async () => {
  assert.deepEqual(envelopeFailure({ ok: false, error: { code: 'unauthorized', message: 'not allowed' } }), {
    code: 'unauthorized', message: 'not allowed',
  })
  // A refused envelope without a message falls back to its code, never to prose.
  assert.deepEqual(envelopeFailure({ ok: false, error: { code: 'offline' } }), { code: 'offline', message: 'offline' })
  assert.deepEqual(envelopeFailure({ ok: false }), { code: 'remote-error', message: 'remote-error' })
  const read = envelopeValue({ ok: false, error: { code: 'busy', message: 'busy right now' } })
  assert.equal(read.ok, false)
  assert.deepEqual(read.failure, { kind: 'remote', code: 'busy', message: 'busy right now' })
  const malformed = envelopeValue('nope')
  assert.equal(malformed.ok, false)
  assert.deepEqual(malformed.failure, { kind: 'transport', detail: 'malformed-envelope' })
})

test('list parses descriptors and drops malformed rows', async () => {
  const commands = parseCommandList([
    ...CATALOG_A,
    { name: '  ', description: 'blank' },
    { description: 'no name' },
    null,
    'nope',
    { name: 'plain' },
  ])
  assert.deepEqual(commands.map(command => command.name), ['compact', 'help', 'plain'])
  assert.equal(commands[0].description, 'Compact the context')
  assert.equal(commands[0].hint, 'optional instructions')
  assert.equal(commands[2].description, '')
  assert.equal(parseCommandList(undefined).length, 0)
})

test('execute value undefined means no command claimed the line', () => {
  const dispatch = parseCommandExecution('/nope', undefined)
  assert.equal(dispatch.kind, 'failure')
  assert.deepEqual(dispatch.failure, { kind: 'unclaimed', line: '/nope' })
})

test('execute result text is kept verbatim, including the busy compaction error', () => {
  const busy = parseCommandExecution('/compact', {
    commandId: 'c9',
    result: { kind: 'error', text: 'ManualCompactionError: the agent is busy' },
  })
  assert.deepEqual(busy, {
    kind: 'result',
    result: { kind: 'error', text: 'ManualCompactionError: the agent is busy' },
  })
  const success = parseCommandExecution('/compact', {
    commandId: 'c1', result: { kind: 'success', text: 'Compacted 143210 tokens.' },
  })
  assert.deepEqual(success, { kind: 'result', result: { kind: 'success', text: 'Compacted 143210 tokens.' } })
})

test('each member client lists its own session and shares no cache', async () => {
  const port = fakePort()
  const a = createMemberCommandClient(port, target('member-a'))
  const b = createMemberCommandClient(port, target('member-b'))
  const listA = await a.list()
  const listB = await b.list()
  assert.deepEqual(listA.commands.map(command => command.name), ['compact', 'help'])
  assert.deepEqual(listB.commands.map(command => command.name), ['status'])
  assert.deepEqual(port.calls.list, ['member-a', 'member-b'])
})

test('run dispatches the exact line with empty attachments on the member session', async () => {
  const port = fakePort()
  const client = createMemberCommandClient(port, target('member-a'))
  await client.run('  /compact now  ')
  assert.deepEqual(port.calls.execute, [{ sessionId: 'member-a', line: '/compact now', attachments: [] }])
})

test('the compact shortcut uses the ordinary execute path', async () => {
  const port = fakePort()
  const client = createMemberCommandClient(port, target('member-a'))
  const outcome = await client.run('/compact')
  assert.equal(port.calls.execute.length, 1)
  assert.equal(port.calls.execute[0].line, '/compact')
  assert.deepEqual(outcome, { kind: 'result', result: { kind: 'success', text: 'ok' } })
})

test('a refused execute envelope becomes a readable remote failure', async () => {
  const port = fakePort({
    execute: async () => ({ ok: false, error: { code: 'unavailable', message: 'no agent' } }),
  })
  const client = createMemberCommandClient(port, target('member-a'))
  assert.deepEqual(await client.run('/compact'), {
    kind: 'failure', failure: { kind: 'remote', code: 'unavailable', message: 'no agent' },
  })
})

test('no retry: one execute call for unclaimed, refused, and error results', async () => {
  const unclaimed = fakePort({ execute: async () => ({ ok: true, value: undefined }) })
  const refused = fakePort({ execute: async () => ({ ok: false, error: { code: 'busy', message: 'busy' } }) })
  const failed = fakePort({ execute: async () => ({ ok: true, value: { commandId: 'c', result: { kind: 'error', text: 'boom' } } }) })
  let calls = 0
  const counting = (port) => ({ ...port, execute: (...args) => { calls += 1; return port.execute(...args) } })
  await createMemberCommandClient(counting(unclaimed), target('member-a')).run('/compact')
  await createMemberCommandClient(counting(refused), target('member-a')).run('/compact')
  await createMemberCommandClient(counting(failed), target('member-a')).run('/compact')
  assert.equal(calls, 3)
})

test('an empty draft never reaches the remote face', async () => {
  const port = fakePort()
  const client = createMemberCommandClient(port, target('member-a'))
  assert.deepEqual(await client.run('   '), { kind: 'failure', failure: { kind: 'empty' } })
  assert.deepEqual(await client.send('   '), { kind: 'failure', failure: { kind: 'empty' } })
  assert.deepEqual(port.calls.execute, [])
})

test('a bare command name gains its slash only when the member advertises it', () => {
  assert.equal(commandLineFor('compact', CATALOG_A), '/compact')
  assert.equal(commandLineFor('compact --verbose', CATALOG_A), '/compact --verbose')
  assert.equal(commandLineFor('/compact', CATALOG_A), '/compact')
  assert.equal(commandLineFor('unknown-word', CATALOG_A), 'unknown-word')
  assert.equal(commandLineFor('   ', CATALOG_A), '')
  assert.equal(commandDraftFor('compact'), '/compact ')
  assert.equal(promptTextFor('  hello member  '), 'hello member')
  assert.equal(promptTextFor('   '), undefined)
})

test('send posts the documented body to the member prompt route', async () => {
  const requests = []
  const client = createMemberCommandClient(fakePort(), target('member-a', 'impl-client'), async (url, init) => {
    requests.push({ url, init })
    return { ok: true, status: 200 }
  })
  const outcome = await client.send('  please review task 3  ')
  assert.deepEqual(outcome, { kind: 'delivered' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, MEMBER_PROMPT_URL)
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.cache, 'no-store')
  assert.equal(requests[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    sessionId: 'captain-1', teamId: 'team-1', member: 'impl-client', text: 'please review task 3',
  })
})

test('send surfaces the route error text and its status code', async () => {
  const client = createMemberCommandClient(fakePort(), target('member-a'), async () => ({
    ok: false, status: 404, json: async () => ({ error: 'no active member "ghost" in team "demo"' }),
  }))
  assert.deepEqual(await client.send('hello'), {
    kind: 'failure',
    failure: { kind: 'remote', code: 'http-404', message: 'no active member "ghost" in team "demo"' },
  })
})

test('transport failures stay locale-neutral tokens', async () => {
  assert.equal(transportDetail(new Error('Failed to fetch')), 'network-error')
  const aborted = new Error('aborted')
  aborted.name = 'AbortError'
  assert.equal(transportDetail(aborted), 'aborted')
  const client = createMemberCommandClient(fakePort(), target('member-a'), async () => { throw new Error('Failed to fetch') })
  assert.deepEqual(await client.send('hello'), { kind: 'failure', failure: { kind: 'transport', detail: 'network-error' } })
  const offline = createMemberCommandClient(fakePort({ list: async () => { throw new Error('socket closed') } }), target('member-a'))
  assert.deepEqual(await offline.list(), { kind: 'failure', failure: { kind: 'transport', detail: 'network-error' } })
})

test('the published port is validated, and a host without it disables the bars', () => {
  provideMemberCommands(undefined)
  assert.equal(activeMemberCommands(), undefined)
  provideMemberCommands({ list: () => {} })
  assert.equal(activeMemberCommands(), undefined)
  assert.equal(isMemberCommandsPort({ list: () => {}, execute: () => {} }), true)
  const port = fakePort()
  provideMemberCommands(port)
  assert.equal(activeMemberCommands(), port)
  provideMemberCommands(undefined)
  assert.equal(activeMemberCommands(), undefined)
})
