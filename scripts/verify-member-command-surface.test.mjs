/**
 * 01-verify — INDEPENDENT verification of the member command surface (plan 01a + 01c).
 * Written by the verifier; does not reuse the implementers' harnesses.
 *
 * Covers the five suspected bypass directions:
 *   1. captain-side command catalog impersonating a member catalog;
 *   2. remote envelope mistaken for a bare array / undefined;
 *   3. automatic retry of a busy /compact;
 *   4. command execution against a session outside the captain's team (backdoor);
 *   5. an unclaimed line reported as success.
 * Host-contract facts verified against the real 0.2.1-rc.2 runtime in app.asar:
 *   - dsh-commands exports "./remote" and "./typert";
 *   - Commands.execute(agent, line, attachments, signal) returns undefined when
 *     syntax or name does not resolve (unclaimed), per asar lib/index.js;
 *   - this.view(agent) scopes the catalog per agent session.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { register } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply } from '../lib/index.js'
import { readTeam, writeTeam } from '../lib/state.js'
import {
  activeMemberCommands,
  createMemberCommandClient,
  commandDraftFor,
  commandLineFor,
  envelopeValue,
  isMemberCommandsPort,
  MEMBER_PROMPT_URL,
  parseCommandExecution,
  parseCommandList,
  promptTextFor,
  provideMemberCommands,
} from '../lib/client/command-client.js'

// ---------------------------------------------------------------------------
// A. Envelope + payload semantics (pure functions over the 0.2.1-rc.2 wire)
// ---------------------------------------------------------------------------

test('A1. refused envelope becomes a readable remote failure, never a success', () => {
  const read = envelopeValue({ ok: false, error: { code: 'execution-denied', message: 'member is busy' } })
  assert.equal(read.ok, false)
  assert.equal(read.failure.kind, 'remote')
  assert.equal(read.failure.code, 'execution-denied')
  assert.equal(read.failure.message, 'member is busy')
})

test('A2. ok:false without error body falls back to a stable code (no crash, no success)', () => {
  const read = envelopeValue({ ok: false })
  assert.equal(read.ok, false)
  assert.equal(read.failure.kind, 'remote')
  assert.equal(read.failure.code, 'remote-error')
})

test('A3. malformed envelope (null / number) is a transport failure', () => {
  for (const bad of [null, 42, 'x']) {
    const read = envelopeValue(bad)
    assert.equal(read.ok, false)
    assert.equal(read.failure.kind, 'transport')
  }
})

test('A4. value === undefined maps to unclaimed, NOT success', () => {
  const dispatch = parseCommandExecution('/zzz', undefined)
  assert.equal(dispatch.kind, 'failure')
  assert.equal(dispatch.failure.kind, 'unclaimed')
  assert.equal(dispatch.failure.line, '/zzz')
})

test('A5. busy error text passes through untouched (a retry would mutate or repeat the call)', () => {
  const busy = 'ManualCompactionError: busy — the agent owns queued waking work'
  const dispatch = parseCommandExecution('/compact', { result: { kind: 'error', text: busy }, commandId: 'c1' })
  assert.equal(dispatch.kind, 'result')
  assert.equal(dispatch.result.kind, 'error')
  assert.equal(dispatch.result.text, busy)
})

test('A6. success result round-trips; unknown result kind is a transport failure', () => {
  const okDispatch = parseCommandExecution('/compact', { result: { kind: 'success', text: 'compacted' } })
  assert.equal(okDispatch.result.kind, 'success')
  assert.equal(okDispatch.result.text, 'compacted')
  const weird = parseCommandExecution('/compact', { result: { kind: 'mystery' } })
  assert.equal(weird.kind, 'failure')
  assert.equal(weird.failure.kind, 'transport')
})

test('A7. parseCommandList drops malformed entries and keeps hints', () => {
  const commands = parseCommandList([
    { name: 'alpha', description: 'A', input: { hint: '<goal>' } },
    null,
    { description: 'no name' },
    { name: '   ' },
    42,
  ])
  assert.deepEqual(commands, [{ name: 'alpha', description: 'A', hint: '<goal>' }])
  assert.deepEqual(parseCommandList({ not: 'array' }), [])
})

test('A8. commandLineFor only slashed-bare names that exist in the member catalog', () => {
  const catalog = [{ name: 'compact', description: '' }]
  assert.equal(commandLineFor('compact now', catalog), '/compact now')
  assert.equal(commandLineFor('nope now', catalog), 'nope now')
  assert.equal(commandLineFor('/already', catalog), '/already')
  assert.equal(commandLineFor('   ', catalog), '')
  assert.equal(commandDraftFor('compact'), '/compact ')
  assert.equal(promptTextFor('   '), undefined)
  assert.equal(promptTextFor('  hello  '), 'hello')
})

test('A9. port registration rejects non-ports (host without remote.commands degrades, never crashes)', () => {
  assert.equal(isMemberCommandsPort({ list() {}, execute() {} }), true)
  assert.equal(isMemberCommandsPort({ list() {} }), false)
  assert.equal(isMemberCommandsPort(null), false)
  provideMemberCommands({ list: 1, execute: 2 })
  assert.equal(activeMemberCommands(), undefined)
  provideMemberCommands(undefined)
  assert.equal(activeMemberCommands(), undefined)
})

// ---------------------------------------------------------------------------
// B. Per-member isolation: two members with different catalogs never mix
// ---------------------------------------------------------------------------

function countingPort(catalogs) {
  const calls = { list: [], execute: [] }
  return {
    calls,
    port: {
      async list(sessionId) {
        calls.list.push(sessionId)
        if (!(sessionId in catalogs)) return { ok: false, error: { code: 'no-session', message: 'unknown session' } }
        return { ok: true, value: catalogs[sessionId] }
      },
      async execute(sessionId, line, attachments) {
        calls.execute.push({ sessionId, line, attachments })
        if (line === '/unstable') return { ok: false, error: { code: 'busy', message: 'compaction busy' } }
        return { ok: true, value: { result: { kind: 'success', text: `ran ${line} on ${sessionId}` }, commandId: 'c1' } }
      },
    },
  }
}

test('B1. each member client sees only its own catalog and addresses it by memberSessionId', async () => {
  const { port, calls } = countingPort({
    'sess-a': [{ name: 'alpha', description: 'A' }, { name: 'shared', description: 'S' }],
    'sess-b': [{ name: 'beta', description: 'B' }],
  })
  const clientA = createMemberCommandClient(port, { sessionId: 'captain-1', teamId: 'team-1', member: 'member-a', memberSessionId: 'sess-a' })
  const clientB = createMemberCommandClient(port, { sessionId: 'captain-1', teamId: 'team-1', member: 'member-b', memberSessionId: 'sess-b' })
  const listA = await clientA.list()
  assert.equal(listA.kind, 'commands')
  assert.deepEqual(listA.commands.map(c => c.name), ['alpha', 'shared'])
  const listB = await clientB.list()
  assert.deepEqual(listB.commands.map(c => c.name), ['beta'])
  assert.deepEqual(calls.list, ['sess-a', 'sess-b'], 'list addressed by each member session id')
})

test('B2. the client has no catalog cache: a second list re-hits the port', async () => {
  const { port, calls } = countingPort({ 'sess-a': [{ name: 'alpha', description: '' }] })
  const client = createMemberCommandClient(port, { sessionId: 'c', teamId: 't', member: 'm', memberSessionId: 'sess-a' })
  await client.list()
  await client.list()
  assert.deepEqual(calls.list, ['sess-a', 'sess-a'])
})

test('B3. run(): empty line rejected locally without a port call; envelope refusal surfaces as readable failure', async () => {
  const { port, calls } = countingPort({ 'sess-a': [] })
  const client = createMemberCommandClient(port, { sessionId: 'c', teamId: 't', member: 'm', memberSessionId: 'sess-a' })
  const empty = await client.run('   ')
  assert.equal(empty.failure.kind, 'empty')
  assert.equal(calls.execute.length, 0, 'empty line must not hit the port')
  const refused = await client.run('/unstable')
  assert.equal(refused.kind, 'failure')
  assert.equal(refused.failure.kind, 'remote')
  assert.equal(refused.failure.message, 'compaction busy')
})

test('B4. send(): posts to the member prompt route with the captain-scoped payload', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) })
    if (url !== MEMBER_PROMPT_URL) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  const client = createMemberCommandClient(
    { async list() { throw new Error('unused') }, async execute() { throw new Error('unused') } },
    { sessionId: 'captain-1', teamId: 'team-1', member: 'member-a', memberSessionId: 'sess-a' },
    fetchImpl,
  )
  const sent = await client.send('  hello member  ')
  assert.equal(sent.kind, 'delivered')
  assert.deepEqual(requests, [{
    url: '/plugins/dsh-agent-teams/member/prompt',
    body: { sessionId: 'captain-1', teamId: 'team-1', member: 'member-a', text: 'hello member' },
  }])
  const failing = createMemberCommandClient(
    { async list() { throw new Error('unused') }, async execute() { throw new Error('unused') } },
    { sessionId: 'captain-1', teamId: 'team-1', member: 'member-a', memberSessionId: 'sess-a' },
    async () => ({ ok: false, status: 409, json: async () => ({ error: 'member is being stopped' }) }),
  )
  const rejected = await failing.send('x')
  assert.equal(rejected.kind, 'failure')
  assert.equal(rejected.failure.kind, 'remote')
  assert.equal(rejected.failure.code, 'http-409')
  assert.equal(rejected.failure.message, 'member is being stopped')
})

// ---------------------------------------------------------------------------
// C. Host surface: agent_teams_run_command (tool) + /member/prompt (route).
//    Real registerAgentTeamsTools/apply code; stub host services. The command
//    registry is keyed BY AGENT OBJECT — two members expose two catalogs.
// ---------------------------------------------------------------------------

async function mountCommandHarness(options = {}) {
  const scratchRoot = join(fileURLToPath(new URL('../node_modules', import.meta.url)), '.scratch')
  await mkdir(scratchRoot, { recursive: true })
  const workspace = await mkdtemp(join(scratchRoot, 'cmd-harness-'))
  const definitions = new Map()
  const liveAgents = new Map()
  const routes = new Map()
  const deliveries = []
  const listCalls = []
  const executeCalls = []
  const webServer = {
    register(route) {
      assert(!routes.has(route.path), `duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const sessionOf = (cwd) => ({
    header: { cwd },
    append() {},
    requestHeader() { return { config: { provider: 'fake', model: 'fake-model' } } },
    ownEvents() { return [] },
  })
  const makeAgent = (id) => ({
    id,
    status: 'idle',
    options: { provider: 'fake', model: 'fake-model' },
    session: sessionOf(workspace),
    ctx: { effect(setup) { return setup() } },
    followups: [],
    steers: [],
    injections: [],
    followup(m) { this.followups.push(m) },
    steer(m) { this.steers.push(m) },
    inject(m) { this.injections.push(m) },
    cancel() {},
    whenIdle() { return Promise.resolve() },
  })
  const captain = makeAgent('captain-session')
  const agentA = makeAgent('sess-a')
  const agentB = makeAgent('sess-b')
  const agentS = makeAgent('sess-s')
  const agentFail = makeAgent('sess-fail')
  for (const agent of [captain, agentA, agentB, agentS, agentFail]) liveAgents.set(agent.id, agent)
  const catalogs = new Map([
    [captain, [
      { name: 'agent-teams', description: 'team surface', input: { hint: '<goal>' } },
      { name: 'captain-secret', description: 'captain only' },
    ]],
    [agentA, [
      { name: 'alpha', description: 'A' },
      { name: 'shared', description: 'S', input: { hint: '<x>', attachments: true } },
      { name: 'agent-teams', description: 'must be denied for members' },
    ]],
    [agentB, [
      { name: 'beta', description: 'B' },
    ]],
    [agentS, []],
    [agentFail, [
      { name: 'compact', description: 'compaction' },
    ]],
  ])
  let typertMode = 'miss'
  const commandsFace = {
    list(agent) {
      listCalls.push(agent)
      return catalogs.get(agent) ?? []
    },
    async execute(agent, line, attachments, signal) {
      executeCalls.push({ agent, line })
      if (line === '/unstable') return undefined
      if (line === '/boom') return { result: { kind: 'error', text: 'ManualCompactionError: busy - agent owns queued waking work' }, commandId: 'c1' }
      return { result: { kind: 'success', text: `ran ${line}` }, commandId: 'c1' }
    },
  }
  const ctx = {
    effect(setup) { return setup() },
    get(key) {
      if (key === 'webServer' || key === 'httpServer') return webServer
      if (key === 'workspaceRegistry' || key === 'workspace') return { list() { return [] } }
      if (key === 'connection') return { requestRejection() { return undefined } }
      if (key === 'commands') return commandsFace
      if (key === 'typert') {
        return {
          lookups: {
            get: (kind) => kind === 'agent'
              ? {
                  resolve: async (id) => {
                    if (typertMode === 'throw') throw new Error('typert exploded')
                    if (typertMode === 'hit') return liveAgents.get(id)
                    return undefined
                  },
                }
              : undefined,
          },
        }
      }
      return undefined
    },
    on() { return () => undefined },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    agents: {
      get(id) { return liveAgents.get(id) },
      list() { return [...liveAgents.values()] },
    },
    llm: {
      async resolveCallConfig(config) { return config },
      async listModels(provider) { return [{ provider, id: 'fake-model', name: 'fake-model' }] },
    },
    subagents: {
      registerContinuableSetup() { return () => undefined },
      getProvider(name) { return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined },
      list() { return ['spawn'] },
      async startContinuable() { throw new Error('no spawn in this harness') },
      async listChildren() { return [] },
      async listDescendants() { return [] },
      async followup(_parent, childId, content) {
        if (childId === 'sess-fail') throw new Error('delivery transport exploded')
        deliveries.push({ childId, content })
        return 'message-1'
      },
      interrupt() {},
      async drainContinuableChildren() {},
    },
    systemPrompt: { section() {} },
    logger: { debug() {}, info() {}, warn() {} },
  }
  ctx.commands = commandsFace
  const config = {
    stateDir: '.agent-teams',
    memberProvider: 'spawn',
    slashCommand: false,
    profiles: {
      'cmd-demo': {
        description: 'command surface harness',
        members: [
          { name: 'active-a', role: 'A', model: 'fake-model' },
          { name: 'active-b', role: 'B', model: 'fake-model' },
          { name: 'removed-one', role: 'R', model: 'fake-model' },
          { name: 'stopping-one', role: 'S', model: 'fake-model' },
          { name: 'fresh-one', role: 'F', model: 'fake-model' },
          { name: 'failer', role: 'X', model: 'fake-model' },
          { name: 'ghost-live', role: 'G', model: 'fake-model' },
        ],
        tasks: [],
      },
    },
  }
  if (options.memberCommandDeny !== undefined) config.memberCommandDeny = options.memberCommandDeny
  apply(ctx, config)
  const tool = definitions.get('agent_teams_run_command')
  assert(tool, 'agent_teams_run_command must register')
  await definitions.get('agent_teams_create').execute(
    { name: 'Command Demo', description: 'x', profile: 'cmd-demo', approval: 'required' },
    { agent: captain, signal: new AbortController().signal },
  )
  const stateRoot = join(workspace, '.agent-teams')
  const seed = await readTeam(stateRoot, 'command-demo')
  for (const member of seed.members) {
    if (member.name === 'active-a') member.id = 'sess-a'
    if (member.name === 'active-b') member.id = 'sess-b'
    if (member.name === 'removed-one') { member.id = 'sess-r'; member.status = 'removed' }
    if (member.name === 'stopping-one') { member.id = 'sess-s'; member.stopping = true }
    if (member.name === 'failer') member.id = 'sess-fail'
    if (member.name === 'fresh-one') member.id = ''
    if (member.name === 'ghost-live') member.id = 'sess-ghost'
  }
  await writeTeam(stateRoot, seed)
  const route = routes.get('/plugins/dsh-agent-teams/member/prompt')
  assert(route, 'member prompt route must register')
  const server = createServer((req, res) => {
    Promise.resolve(route.handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    workspace, stateRoot, base, captain, agentA, agentB, deliveries, listCalls, executeCalls,
    setTypert(mode) { typertMode = mode },
    call(args) { return tool.execute(args, { agent: captain, signal: new AbortController().signal }) },
    async post(payload, method = 'POST') {
      const init = { method }
      if (method === 'POST') {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify({ sessionId: 'captain-session', teamId: 'command-demo', ...payload })
      }
      const response = await fetch(base + '/plugins/dsh-agent-teams/member/prompt', init)
      let body = null
      try { body = await response.json() } catch { body = null }
      return { status: response.status, body }
    },
    team: () => readTeam(stateRoot, 'command-demo'),
    async cleanup() {
      server.close()
      await rm(workspace, { recursive: true, force: true })
    },
  }
}

test('C1. list returns the MEMBER\'s own scope (not the captain\'s), deny-filtered, no tool-side cache', async (t) => {
  const h = await mountCommandHarness()
  t.after(h.cleanup)
  const listA = await h.call({ member: 'active-a', action: 'list' })
  assert.deepEqual(listA.commands.map((c) => c.name), ['alpha', 'shared'], 'agent-teams denied even though the member registry carries it')
  assert.equal(listA.commands[1].hint, '<x>')
  assert.equal(listA.commands[1].attachments, true)
  const listB = await h.call({ member: 'active-b', action: 'list' })
  assert.deepEqual(listB.commands.map((c) => c.name), ['beta'], 'member B sees a different catalog than member A')
  assert.ok(h.listCalls.every((agent) => agent !== h.captain), 'captain scope never listed')
  assert.equal(h.listCalls[0], h.agentA)
  assert.equal(h.listCalls[1], h.agentB)
  await h.call({ member: 'active-a', action: 'list' })
  assert.equal(h.listCalls.length, 3, 'no captain-side caching: every list re-reads the member registry')
})

test('C2. memberCommandDeny override actually widens the surface', async (t) => {
  const h = await mountCommandHarness({ memberCommandDeny: [] })
  t.after(h.cleanup)
  const list = await h.call({ member: 'active-a', action: 'list' })
  assert.deepEqual(list.commands.map((c) => c.name), ['alpha', 'shared', 'agent-teams'])
  const ran = await h.call({ member: 'active-a', action: 'run', line: '/agent-teams hello' })
  assert.equal(ran.ok, true, 'with an empty deny list the member surface is executable')
})

test('C3. run: success passthrough, busy error passthrough without retry, undefined becomes a readable unclaimed error', async (t) => {
  const h = await mountCommandHarness()
  t.after(h.cleanup)
  const okRun = await h.call({ member: 'active-a', action: 'run', line: '/compact' })
  assert.equal(okRun.ok, true)
  assert.equal(okRun.text, 'ran /compact')
  const before = h.executeCalls.length
  const busy = await h.call({ member: 'active-a', action: 'run', line: '/boom' })
  assert.equal(busy.ok, false)
  assert.match(busy.text, /ManualCompactionError: busy/)
  assert.equal(h.executeCalls.length, before + 1, 'busy result must not be retried')
  const unclaimed = await h.call({ member: 'active-a', action: 'run', line: '/unstable' })
  assert.equal(unclaimed.ok, false)
  assert.equal(unclaimed.kind, 'error')
  assert.match(unclaimed.text, /\/unstable/, 'unclaimed error names the line; never a silent undefined')
})

test('C4. guard matrix: every invalid input is rejected with a readable error, not a silent undefined', async (t) => {
  const h = await mountCommandHarness()
  t.after(h.cleanup)
  const longLine = `/${'x'.repeat(512)}`
  const cases = [
    [{ member: 'ghost', action: 'list' }, /no active member named "ghost"/],
    [{ member: 'removed-one', action: 'list' }, /no active member named "removed-one"/],
    [{ member: 'stopping-one', action: 'list' }, /being stopped/],
    [{ member: 'fresh-one', action: 'list' }, /no session yet/],
    [{ member: 'active-a', action: 'run' }, /run requires `line`/],
    [{ member: 'active-a', action: 'run', line: 'compact' }, /start with "\/"/],
    [{ member: 'active-a', action: 'run', line: longLine }, /too long \(513 > 512 characters\)/],
    [{ member: 'active-a', action: 'run', line: '/agent-teams hi' }, /denied for members/],
  ]
  for (const [args, pattern] of cases) {
    await assert.rejects(h.call(args), pattern, JSON.stringify(args))
  }
})

test('C5. cold-member resolution: typert hit, typert throw falls back to the registry, both miss is a readable error', async (t) => {
  const h = await mountCommandHarness()
  t.after(h.cleanup)
  h.setTypert('hit')
  const viaTypert = await h.call({ member: 'active-a', action: 'list' })
  assert.deepEqual(viaTypert.commands.map((c) => c.name), ['alpha', 'shared'])
  h.setTypert('throw')
  const viaFallback = await h.call({ member: 'active-a', action: 'list' })
  assert.deepEqual(viaFallback.commands.map((c) => c.name), ['alpha', 'shared'], 'typert failure falls back to the local registry')
  h.setTypert('miss')
  await assert.rejects(h.call({ member: 'ghost-live', action: 'run', line: '/compact' }), /not resolvable: sess-ghost/, 'both resolution paths miss -> readable error naming the child id')
})

test('C6. /member/prompt route: full guard matrix plus delivery lands on the right child, not a stranger', async (t) => {
  const h = await mountCommandHarness()
  t.after(h.cleanup)
  assert.equal((await h.post({}, 'GET')).status, 405)
  assert.equal((await h.post({ member: 'active-a' })).status, 400)
  assert.equal((await h.post({ member: 'active-a', text: 'hi', teamId: 'other-team' })).status, 404, 'a teamId the captain does not own is rejected')
  assert.equal((await h.post({ member: 'intruder', text: 'hi' })).status, 404, 'a member outside this team is rejected (no cross-team backdoor)')
  assert.equal((await h.post({ member: 'stopping-one', text: 'hi' })).status, 409)
  assert.equal((await h.post({ member: 'fresh-one', text: 'hi' })).status, 409)
  assert.equal((await h.post({ member: 'failer', text: 'hi' })).status, 500, 'delivery failure surfaces as 500, not a silent success')
  const ok = await h.post({ member: 'active-b', text: 'hello B' })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { ok: true, member: 'sess-b', delivered: true })
  assert.equal(h.deliveries.length, 1)
  assert.equal(h.deliveries[0].childId, 'sess-b')
  assert.equal(h.deliveries[0].content[0].text, 'hello B')
})

test('C7. a forged sessionId (stranger session) cannot address the team at all', async (t) => {
  const h = await mountCommandHarness()
  t.after(h.cleanup)
  const response = await fetch(h.base + '/plugins/dsh-agent-teams/member/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'stranger-session', teamId: 'command-demo', member: 'active-a', text: 'hi' }),
  })
  assert.equal(response.status, 409, 'unknown captain session -> not attached')
  assert.deepEqual(await response.json(), { error: 'captain session is not attached' })
})

// ---------------------------------------------------------------------------
// D. Lazy catalog: rendering the panel must not wake a cold member, and the
//    bar degrades gracefully without a port. (SSR of the REAL built panel.)
// ---------------------------------------------------------------------------

test('D1. SSR of the real panel: bar renders, list() NOT called; disabled without a port', async (t) => {
  const shimDir = join(fileURLToPath(new URL('../node_modules', import.meta.url)), `.mcb-shims-surface-${process.pid}`)
  await rm(shimDir, { recursive: true, force: true })
  await mkdir(shimDir, { recursive: true })
  await writeFile(join(shimDir, 'react-open.mjs'), [
    "import * as real from 'react'",
    "export * from 'react'",
    'export function useState(initial) { return real.useState(initial === false ? true : initial) }',
    'export function useSyncExternalStore(_s, getSnapshot, getServerSnapshot) { return (getServerSnapshot ?? getSnapshot)() }',
    '',
  ].join('\n'))
  await writeFile(join(shimDir, 'css-proxy.mjs'), 'export default new Proxy({}, { get: (_t, key) => String(key) })\n')
  await writeFile(join(shimDir, 'primitives-stub.mjs'), 'export function Menu() { return null }\nexport function Modal() { return null }\n')
  await writeFile(join(shimDir, 'loader.mjs'), [
    'export async function resolve(specifier, context, nextResolve) {',
    "  if (specifier.endsWith('.module.css')) return { url: new URL('./css-proxy.mjs', import.meta.url).href, shortCircuit: true }",
    "  const parent = context.parentURL ?? ''",
    "  if (parent.includes('ActivityPanel.js') || parent.includes('StagingPlanEditor.js')) {",
    "    if (specifier === 'react') return { url: new URL('./react-open.mjs', import.meta.url).href, shortCircuit: true }",
    "    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { url: new URL('./primitives-stub.mjs', import.meta.url).href, shortCircuit: true }",
    '  }',
    '  return nextResolve(specifier, context)',
    '}',
  ].join('\n'))
  register(pathToFileURL(join(shimDir, 'loader.mjs')))
  t.after(async () => {
    provideMemberCommands(undefined)
    await rm(shimDir, { recursive: true, force: true })
  })
  const [{ renderToStaticMarkup }, panelModule, locales, React] = await Promise.all([
    import('react-dom/server'),
    import('../lib/client/ActivityPanel.js'),
    import('../lib/client/locales.js'),
    import('react'),
  ])
  const translate = (dict) => (key, params) => {
    let value = dict[key] ?? key
    if (typeof value !== 'string') value = key
    for (const [name, replacement] of Object.entries(params ?? {})) {
      value = value.replaceAll(`{${name}}`, String(replacement))
    }
    return value
  }
  const listCalls = []
  provideMemberCommands({
    async list(sessionId) {
      listCalls.push(sessionId)
      return { ok: true, value: [{ name: 'alpha', description: 'A' }] }
    },
    async execute() { throw new Error('unused in this test') },
  })
  const team = {
    workspace: '/ws',
    teamId: 'command-demo',
    name: 'Command Demo',
    description: '',
    captainSessionId: 'captain-session',
    phase: 'running',
    members: [{
      id: 'sess-a',
      name: 'active-a',
      role: 'A',
      provider: 'fake',
      model: 'fake-model',
      reasoningEffort: '',
      executionPrompt: '',
      activity: 'idle',
      progress: 0,
      done: 0,
      total: 0,
      currentTask: '',
      unread: 0,
    }],
    tasks: [],
    messageCount: 0,
    captainInbox: [],
  }
  const modelDirectory = {
    store: {
      subscribe() { return () => undefined },
      getSnapshot() { return { status: 'idle', groups: [], failures: [] } },
      getServerSnapshot() { return { status: 'idle', groups: [], failures: [] } },
    },
    load: async () => undefined,
  }
  const props = {
    team,
    modelDirectory,
    onContinuePlanning() {},
    onDiscarded() {},
    onNavigate() {},
    t: translate(locales.zh),
  }
  const html = renderToStaticMarkup(React.createElement(panelModule.TeamSection, props))
  assert.match(html, /data-member-commands/, 'the command bar is present and discoverable')
  assert.match(html, /data-member="active-a"/, 'the bar belongs to the member row')
  assert.deepEqual(listCalls, [], 'rendering the panel alone must NOT call remote.commands.list — no cold-member wake')

  provideMemberCommands(undefined)
  const htmlNoPort = renderToStaticMarkup(React.createElement(panelModule.TeamSection, props))
  assert.match(htmlNoPort, /data-member-commands/, 'bar still renders without a port')
  assert.match(htmlNoPort, /<select[^>]*disabled/, 'without a port the select is disabled (graceful degradation)')
  assert.deepEqual(listCalls, [])
})
