/**
 * Plan 09 phase A: members created as ordinary sessions.
 *
 * These are contract tests over the creation seam, not parity tests with the
 * subagent path. They pin four properties the rollout switch depends on:
 * creation reads only optional services, the per-member setup (persona, tool
 * filter, model route) is installed before the first turn, the first turn is
 * actually queued, and session mode never consults the subagent runtime.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../lib/index.js'
import { spawnMember } from '../lib/members.js'
import { stopTeamMemberActivations } from '../lib/tools.js'
import {
  cancelMemberSession,
  createMemberSession,
  memberSessionUnavailableReason,
  promptMemberSession,
  readMemberSessionServices,
} from '../lib/member-session.js'

function fakeAgent(id) {
  const sections = []
  const filters = []
  const listeners = []
  return {
    id,
    status: 'idle',
    sections,
    filters,
    listeners,
    session: { header: { cwd: 'C:/ws' } },
    ctx: {
      on(event, listener) { listeners.push([event, listener]); return () => undefined },
      effect(setup) { return setup() },
      tools: { restrict(filter) { filters.push(filter); return () => undefined } },
      systemPrompt: {
        section(spec) { sections.push(spec); return () => undefined },
        getSectionOrder() { return 10 },
      },
    },
  }
}

function fakeCtx({ controller, registry, agents = new Map() } = {}) {
  const warnings = []
  return {
    warnings,
    logger: { warn(message) { warnings.push(message) }, info() {}, debug() {} },
    agents: {
      get(id) { return agents.get(id) },
      list() { return [...agents.values()] },
    },
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'workspaceRegistry') return registry
      return undefined
    },
  }
}

const REQUEST = {
  cwd: 'C:/ws',
  persona: 'PERSONA',
  toolFilter: { deny: ['agent_teams_add_member'] },
  selection: { provider: 'prov', model: 'mod' },
  prompt: 'WELCOME',
}

test('services are optional reads: missing ctx.get, a throwing lookup, and a bare deployment all stay undefined', () => {
  for (const ctx of [
    {},
    { get() { throw new Error('cannot get property "sessionController" without inject') } },
    { get() { return undefined } },
  ]) {
    const services = readMemberSessionServices(ctx)
    assert.equal(services.controller, undefined)
    assert.equal(services.registry, undefined)
  }
  assert.equal(memberSessionUnavailableReason(readMemberSessionServices({})).length > 0, true)
})

test('the unavailable reason names the missing call and the way back', () => {
  assert.match(memberSessionUnavailableReason({}), /no session controller/)
  assert.match(memberSessionUnavailableReason({}), /memberSessions to "subagent"/)
  assert.match(
    memberSessionUnavailableReason({ controller: { create() {} } }),
    /never woken/,
  )
  assert.equal(memberSessionUnavailableReason({ controller: { create() {}, prompt() {} } }), undefined)
})

test('creation attaches to a workspace, installs the member setup, then opens the first turn', async () => {
  const created = []
  const prompted = []
  const controller = {
    async create(request) { created.push(request); return { sessionId: 'sess-m1' } },
    async prompt(request, source) { prompted.push({ request, source }); return { accepted: true } },
  }
  const registry = { async create(path, title) { return { id: 'ws-1', path, title } } }
  const agent = fakeAgent('sess-m1')
  const ctx = fakeCtx({ controller, registry, agents: new Map([['sess-m1', agent]]) })

  const result = await createMemberSession(ctx, readMemberSessionServices(ctx), REQUEST)

  assert.equal(result.childId, 'sess-m1')
  assert.equal(result.agent, agent)
  assert.deepEqual(created, [{ workspaceId: 'ws-1' }])
  assert.deepEqual(agent.filters, [REQUEST.toolFilter])
  assert.equal(agent.sections.length, 1)
  assert.equal(agent.sections[0].name, 'deployment:persona-prefix')
  assert.equal(agent.sections[0].text, 'PERSONA')
  // The model route is installed as two scoped listeners before the first turn.
  assert.ok(agent.listeners.some(([event]) => event === 'agent/request'))
  assert.equal(prompted.length, 1)
  assert.equal(prompted[0].request.sessionId, 'sess-m1')
  assert.equal(prompted[0].request.mode, 'queue')
  assert.deepEqual(prompted[0].request.content, [{ type: 'text', text: 'WELCOME' }])
  assert.match(String(prompted[0].request.requestId), /^[0-9a-f-]{36}$/)
  assert.match(String(prompted[0].source.kind), /^(agent-teams|plugin)$/)
})

test('creation still works from an explicit cwd when the workspace registry fails', async () => {
  const created = []
  const controller = {
    async create(request) { created.push(request); return { sessionId: 'sess-m1' } },
    async prompt() { return { accepted: true } },
  }
  const registry = { async create() { throw new Error('registry exploded') } }
  const ctx = fakeCtx({ controller, registry, agents: new Map([['sess-m1', fakeAgent('sess-m1')]]) })

  await createMemberSession(ctx, readMemberSessionServices(ctx), REQUEST)

  assert.deepEqual(created, [{ cwd: 'C:/ws' }])
  assert.match(ctx.warnings.join('\n'), /could not resolve a workspace/)
})

test('a member without a route or filter installs neither, and still opens its turn', async () => {
  const controller = {
    async create() { return { sessionId: 'sess-m1' } },
    async prompt() { return { accepted: true } },
  }
  const agent = fakeAgent('sess-m1')
  const ctx = fakeCtx({ controller, agents: new Map([['sess-m1', agent]]) })

  await createMemberSession(ctx, readMemberSessionServices(ctx), { cwd: 'C:/ws', persona: 'P', prompt: 'W' })

  assert.deepEqual(agent.filters, [])
  assert.equal(agent.listeners.some(([event]) => event === 'agent/request'), false)
  assert.equal(agent.sections.length, 1)
})

test('creation fails loud instead of leaving a silent member', async () => {
  await assert.rejects(
    () => createMemberSession(fakeCtx(), {}, REQUEST),
    /no session controller/,
  )
  await assert.rejects(
    () => createMemberSession(fakeCtx({ controller: { create() {} } }), readMemberSessionServices(fakeCtx({ controller: { create() {} } })), REQUEST),
    /never woken/,
  )
  const noId = fakeCtx({ controller: { async create() { return {} }, async prompt() { return { accepted: true } } } })
  await assert.rejects(() => createMemberSession(noId, readMemberSessionServices(noId), REQUEST), /without a member session id/)
  const detached = fakeCtx({ controller: { async create() { return { sessionId: 'sess-x' } }, async prompt() { return { accepted: true } } } })
  await assert.rejects(() => createMemberSession(detached, readMemberSessionServices(detached), REQUEST), /created but is not attached/)
  const silent = fakeCtx({
    controller: { async create() { return { sessionId: 'sess-m1' } }, async prompt() { return { accepted: false } } },
    agents: new Map([['sess-m1', fakeAgent('sess-m1')]]),
  })
  await assert.rejects(() => createMemberSession(silent, readMemberSessionServices(silent), REQUEST), /first turn was not accepted/)
})

test('prompt delivery carries the mode, mints a request id, and never throws', async () => {
  const calls = []
  const controller = {
    async prompt(request, source) { calls.push({ request, source }); return { accepted: true } },
  }
  const ctx = fakeCtx({ controller })
  const services = readMemberSessionServices(ctx)

  assert.equal(await promptMemberSession(ctx, services, 'sess-m1', 'hello', 'steer'), true)
  assert.equal(calls[0].request.mode, 'steer')
  assert.equal(calls[0].request.sessionId, 'sess-m1')
  assert.equal(await promptMemberSession(ctx, services, 'sess-m1', 'hello'), true)
  assert.equal(calls[1].request.mode, 'queue')
  assert.notEqual(calls[0].request.requestId, calls[1].request.requestId)

  const refusing = fakeCtx({ controller: { async prompt() { return { accepted: false } } } })
  assert.equal(await promptMemberSession(refusing, readMemberSessionServices(refusing), 'sess-m1', 'x'), false)

  const broken = fakeCtx({ controller: { async prompt() { throw new Error('owned by subagent routing') } } })
  assert.equal(await promptMemberSession(broken, readMemberSessionServices(broken), 'sess-m1', 'x'), false)
  assert.match(broken.warnings.join('\n'), /prompt delivery to member session sess-m1 failed/)

  assert.equal(await promptMemberSession(fakeCtx(), {}, 'sess-m1', 'x'), false)
})

test('cancel is best effort and never throws into a halt path', () => {
  const cancelled = []
  const ok = fakeCtx({ controller: { cancel(request) { cancelled.push(request); return { accepted: true } } } })
  cancelMemberSession(ok, readMemberSessionServices(ok), 'sess-m1')
  assert.deepEqual(cancelled, [{ sessionId: 'sess-m1' }])

  const broken = fakeCtx({ controller: { cancel() { throw new Error('not attached') } } })
  cancelMemberSession(broken, readMemberSessionServices(broken), 'sess-m1')
  assert.match(broken.warnings.join('\n'), /cancel of member session sess-m1 failed/)
})

test('spawnMember in session mode never reads the subagent runtime', async () => {
  const agent = fakeAgent('sess-m2')
  const controller = {
    async create() { return { sessionId: 'sess-m2' } },
    async prompt() { return { accepted: true } },
  }
  const ctx = fakeCtx({
    controller,
    registry: { async create() { return { id: 'ws-1' } } },
    agents: new Map([['sess-m2', agent]]),
  })
  // Any touch of the subagent boundary fails the test.
  ctx.subagents = new Proxy({}, { get() { throw new Error('session mode must not read ctx.subagents') } })
  const member = { id: '', name: 'smoke', joinedAt: 0, status: 'idle' }
  const team = { id: 't1', name: 'team', description: 'goal', members: [member], tasks: [] }
  const captain = { id: 'captain', session: { header: { cwd: 'C:/ws' } } }

  await spawnMember(
    ctx,
    { provider: 'spawn', memberSessions: 'session', maxDepth: 0 },
    {},
    { provider: 'prov', model: 'mod' },
    captain,
    team,
    member,
    '.agent-teams',
    new AbortController().signal,
  )

  assert.equal(member.id, 'sess-m2')
  assert.equal(member.sessionKind, 'session')
  assert.equal(agent.sections.length, 1)
})

test('the legacy default still fails loud without a subagent provider', async () => {
  const ctx = fakeCtx({})
  ctx.subagents = { getProvider() { return undefined }, list() { return [] } }
  const member = { id: '', name: 'smoke', joinedAt: 0, status: 'idle' }
  const team = { id: 't1', name: 'team', members: [member], tasks: [] }
  const captain = { id: 'captain', session: { header: { cwd: 'C:/ws' } } }

  await assert.rejects(
    () => spawnMember(
      ctx,
      { provider: 'spawn' },
      {},
      { provider: 'prov', model: 'mod' },
      captain,
      team,
      member,
      '.agent-teams',
      new AbortController().signal,
    ),
    /no subagent provider/,
  )
})

test('stopping a team cancels session-mode members and drains only legacy children', async () => {
  const cancelled = []
  const drained = []
  const ctx = fakeCtx({ controller: { cancel(request) { cancelled.push(request) } } })
  ctx.subagents = {
    async drainChildren(parent, ids) { drained.push([...ids]) },
    get drainContinuableChildren() { throw new Error('exact drain must win over the continuable fallback') },
  }

  await stopTeamMemberActivations(ctx, { id: 'captain' }, [
    { id: 'sess-a', name: 'a', sessionKind: 'session', joinedAt: 0, status: 'idle' },
    { id: 'child-b', name: 'b', joinedAt: 0, status: 'idle' },
    { id: '', name: 'never-started', joinedAt: 0, status: 'idle' },
  ], new AbortController().signal)

  assert.deepEqual(cancelled, [{ sessionId: 'sess-a' }])
  assert.deepEqual(drained, [['child-b']])
})

test('stopping only session-mode members never reads the subagent runtime', async () => {
  const cancelled = []
  const ctx = fakeCtx({ controller: { cancel(request) { cancelled.push(request) } } })
  ctx.subagents = new Proxy({}, { get() { throw new Error('session-mode stop must not drain subagent children') } })

  await stopTeamMemberActivations(ctx, {}, [
    { id: 'sess-a', name: 'a', sessionKind: 'session', joinedAt: 0, status: 'idle' },
  ], new AbortController().signal)

  assert.deepEqual(cancelled, [{ sessionId: 'sess-a' }])
})

test('the rollout switch defaults to the legacy path', () => {
  assert.equal(Config({}).memberSessions, 'subagent')
  assert.equal(Config({ memberSessions: 'session' }).memberSessions, 'session')
  assert.throws(() => Config({ memberSessions: 'ordinary' }))
})
