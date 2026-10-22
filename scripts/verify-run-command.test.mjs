/**
 * Independent verification for the 01c host command surface:
 *   - agent_teams_run_command tool (list / run / deny / guards / undefined bus / cold member)
 *   - resolveMemberAgent (typert first, agents fallback, both-miss)
 *   - POST /plugins/dsh-agent-teams/member/prompt route (200 / 400 / 404 / 409 / 405)
 *
 * Everything runs against fake ctx objects; no Harness runtime needed.
 * Imports the BUILT bundle (../lib/**.js) - run `pnpm build` first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { normalizeMemberCommandDeny, registerAgentTeamsTools } from '../lib/tools.js'
import { Config, apply, inject } from '../lib/index.js'
import { createTeamDir } from '../lib/state.js'
import { TEAM_TOOL_NAMES, MEMBER_TOOL_NAMES, CAPTAIN_TOOL_NAMES } from '../lib/tool-names.js'
import { AGENT_TEAMS_COMMAND } from '../lib/command.js'
import { resolveMemberAgent } from '../lib/members.js'

const MEMBER_ID = 'child-session-0001'

function fakeAgent(id) {
  return { id, session: { header: { cwd: '/tmp' } } }
}

/** Request-like object readJsonRequest can consume. */
function jsonRequest(payload) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/'
  req.off = (event, handler) => req.removeListener(event, handler)
  req.once = (event, handler) => EventEmitter.prototype.once.call(req, event, handler)
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(payload)))
    req.emit('end')
  })
  return req
}

function makeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {} },
    end(payload) { this.body = payload ?? '' },
  }
}


/** Fake plugin ctx: records tool/route registrations and exposes configurable services. */
function makeFakeCtx(options = {}) {
  const registeredTools = new Map()
  const registeredRoutes = []
  const base = {
    logger: options.logger ?? { info() {}, warn() {}, error() {} },
    agents: { get: (id) => (options.agents?.[id] ?? undefined) },
    commands: {
      list: (agent) => (options.commandList ? options.commandList(agent) : []),
      execute: (agent, line, attachments, signal) => (options.commandExecute ? options.commandExecute(agent, line, attachments, signal) : undefined),
    },
    subagents: options.subagents ?? {
      async followup(parent, childId, content) { return 'msg-stub' },
      registerContinuableSetup() { return () => undefined },
    },
    llm: { listProviders: () => [], listModels: async () => [], resolveCallConfig: async (config) => config },
    systemPrompt: { section: () => () => undefined, getSectionOrder: () => 100 },
    effect(factory) { const result = factory(); return typeof result === 'function' ? result : () => undefined },
    on() { return () => undefined },
  }
  base.get = (name) => {
    // `commands` is deliberately NOT on the root inject (index.ts mounts it in a
    // child scope), so the tool must reach it through this registry read — the
    // fake ctx has to model that or it hides the real cordis guard.
    if (name === 'commands') return base.commands
    if (name === 'typert') return options.typert
    if (name === 'webServer') return { register: (route) => registeredRoutes.push(route) }
    if (name === 'workspaceRegistry') return { list: () => [] }
    if (name === 'connection') return { requestRejection: () => undefined }
    return undefined
  }
  base.tools = { register: (definition) => registeredTools.set(definition.name, definition) }
  return { ctx: base, registeredTools, registeredRoutes }
}


const MEMBERS = [
  { id: 'child-0001', name: 'writer', role: 'w', joinedAt: 1, status: 'idle' },
  { id: 'child-cold', name: 'cold', role: 'c', joinedAt: 2, status: 'idle' },
  { id: '', name: 'ghost', role: 'g', joinedAt: 3, status: 'idle' },
  { id: 'child-stopping', name: 'drained', role: 'd', joinedAt: 4, status: 'idle', stopping: true },
  { id: 'child-removed', name: 'gone', role: 'x', joinedAt: 5, status: 'removed' },
]

async function setupSuite(options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-run-command-'))
  const stateRoot = join(workspace, '.agent-teams')
  await mkdir(stateRoot, { recursive: true })
  await createTeamDir(stateRoot, {
    name: 'demo', id: 'demo', captainSessionId: 'captain-1', createdAt: 1, taskSeq: 0,
    members: MEMBERS.map((member) => ({ ...member })), tasks: [],
  })
  const config = {
    stateDir: '.agent-teams', memberProvider: 'spawn', maxMembers: 8,
    toolPolicies: {}, profiles: {},
    ...(options.memberCommandDeny === undefined ? {} : { memberCommandDeny: options.memberCommandDeny }),
  }
  const { ctx, registeredTools, registeredRoutes } = makeFakeCtx(options)
  registerAgentTeamsTools(ctx, config)
  const tool = registeredTools.get('agent_teams_run_command')
  const exec = { agent: { id: 'captain-1', session: { header: { cwd: workspace } } }, signal: new AbortController().signal }
  return { workspace, ctx, config, tool, exec, registeredRoutes }
}

async function cleanup(workspace) { await rm(workspace, { recursive: true, force: true }) }


test('team tool vocabulary: run_command is captain-only', () => {
  assert.ok(TEAM_TOOL_NAMES.includes('agent_teams_run_command'))
  assert.ok(!MEMBER_TOOL_NAMES.includes('agent_teams_run_command'))
  assert.ok(CAPTAIN_TOOL_NAMES.includes('agent_teams_run_command'))
})

test('list returns the member-scoped descriptor set with hint/attachments, denying the plugin surface', async () => {
  const seen = []
  const { tool, workspace } = await setupSuite({
    agents: { 'child-0001': fakeAgent('child-0001') },
    commandList: (agent) => {
      seen.push(agent.id)
      return [
        { name: 'compact', description: 'Compact the conversation', input: { hint: 'no args', attachments: false } },
        { name: AGENT_TEAMS_COMMAND, description: 'activation', input: { hint: 'goal' } },
        { name: 'review', description: 'Review something' },
      ]
    },
  })
  try {
    const value = await tool.execute({ member: 'writer', action: 'list' }, { agent: { id: 'captain-1', session: { header: { cwd: workspace } } }, signal: new AbortController().signal })
    assert.deepEqual(seen, ['child-0001'], 'commands listed on the MEMBER agent, not the captain')
    assert.equal(value.member, 'writer')
    assert.deepEqual(value.commands.map((command) => command.name), ['compact', 'review'])
    assert.equal(value.commands[0].hint, 'no args')
    assert.equal(value.commands[0].attachments, false)
    assert.equal(value.commands[1].hint, undefined)
    assert.equal(value.commands[1].attachments, undefined)
  } finally { await cleanup(workspace) }
})

test('list accepts a member child session id instead of a display name', async () => {
  const { tool, workspace } = await setupSuite({
    agents: { 'child-0001': fakeAgent('child-0001') },
    commandList: () => [{ name: 'compact', description: 'x' }],
  })
  try {
    const value = await tool.execute({ member: 'child-0001', action: 'list' }, { agent: { id: 'captain-1', session: { header: { cwd: workspace } } }, signal: new AbortController().signal })
    assert.equal(value.member, 'writer')
    assert.equal(value.commands.length, 1)
  } finally { await cleanup(workspace) }
})

test('run success: ok mirrors result.kind; attachments empty; commandId returned', async () => {
  const calls = []
  const { tool, workspace } = await setupSuite({
    agents: { 'child-0001': fakeAgent('child-0001') },
    commandExecute: async (agent, line, attachments, signal) => {
      calls.push({ agentId: agent.id, line, attachments, hasSignal: signal instanceof AbortSignal })
      return { commandId: 'cmd-9', result: { kind: 'success', text: 'Compacted 12 history items (~45k tokens).' } }
    },
  })
  try {
    const value = await tool.execute({ member: 'writer', action: 'run', line: '/compact' }, { agent: { id: 'captain-1', session: { header: { cwd: workspace } } }, signal: new AbortController().signal })
    assert.equal(value.member, 'writer')
    assert.equal(value.line, '/compact')
    assert.equal(value.ok, true)
    assert.equal(value.kind, 'success')
    assert.equal(value.text, 'Compacted 12 history items (~45k tokens).')
    assert.equal(value.command_id, 'cmd-9')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].agentId, 'child-0001')
    assert.deepEqual(calls[0].attachments, [])
    assert.equal(calls[0].hasSignal, true)
  } finally { await cleanup(workspace) }
})

test('run error result surfaces verbatim (busy member / ManualCompactionError text), never retried', async () => {
  let calls = 0
  const { tool, workspace } = await setupSuite({
    agents: { 'child-0001': fakeAgent('child-0001') },
    commandExecute: async () => { calls += 1; return { commandId: 'cmd-1', result: { kind: 'error', text: 'the member is busy; try again when its turn ends' } } },
  })
  try {
    const value = await tool.execute({ member: 'writer', action: 'run', line: '/compact' }, { agent: { id: 'captain-1', session: { header: { cwd: workspace } } }, signal: new AbortController().signal })
    assert.equal(value.ok, false)
    assert.equal(value.kind, 'error')
    assert.equal(value.text, 'the member is busy; try again when its turn ends')
    assert.equal(calls, 1, 'exactly one bus call: no retry')
  } finally { await cleanup(workspace) }
})

test('undefined from the bus becomes a readable error, not silence', async () => {
  const { tool, workspace } = await setupSuite({
    agents: { 'child-0001': fakeAgent('child-0001') },
    commandExecute: async () => undefined,
  })
  try {
    const value = await tool.execute({ member: 'writer', action: 'run', line: '/nope' }, { agent: { id: 'captain-1', session: { header: { cwd: workspace } } }, signal: new AbortController().signal })
    assert.equal(value.ok, false)
    assert.match(value.text, /no registered command handled "\/nope"/)
  } finally { await cleanup(workspace) }
})

test('deny list: the plugin surface is refused by default and overridable', async () => {
  const defaultSuite = await setupSuite({ agents: { 'child-0001': fakeAgent('child-0001') }, commandList: () => [] })
  try {
    await assert.rejects(
      () => defaultSuite.tool.execute({ member: 'writer', action: 'run', line: '/' + AGENT_TEAMS_COMMAND }, defaultSuite.exec),
      /memberCommandDeny/,
    )
    await assert.rejects(
      () => defaultSuite.tool.execute({ member: 'writer', action: 'run', line: '/' + AGENT_TEAMS_COMMAND + ' some goal' }, defaultSuite.exec),
      /memberCommandDeny/,
    )
  } finally { await cleanup(defaultSuite.workspace) }
  const permissive = await setupSuite({ memberCommandDeny: [], agents: { 'child-0001': fakeAgent('child-0001') }, commandList: () => [] })
  try {
    const listed = await permissive.tool.execute({ member: 'writer', action: 'list' }, permissive.exec)
    assert.deepEqual(listed.commands, [])
  } finally { await cleanup(permissive.workspace) }
  const custom = await setupSuite({ memberCommandDeny: ['compact'], agents: { 'child-0001': fakeAgent('child-0001') }, commandList: () => [] })
  try {
    await assert.rejects(
      () => custom.tool.execute({ member: 'writer', action: 'run', line: '/compact' }, custom.exec),
      /denied/,
    )
  } finally { await cleanup(custom.workspace) }
})

test('member guards: unknown, removed, stopping, unstarted', async () => {
  const suite = await setupSuite({ agents: {} })
  try {
    await assert.rejects(() => suite.tool.execute({ member: 'nobody', action: 'list' }, suite.exec), /no active member named "nobody"/)
    await assert.rejects(() => suite.tool.execute({ member: 'gone', action: 'list' }, suite.exec), /no active member named "gone"/)
    await assert.rejects(() => suite.tool.execute({ member: 'drained', action: 'list' }, suite.exec), /is being stopped/)
    await assert.rejects(() => suite.tool.execute({ member: 'ghost', action: 'run', line: '/compact' }, suite.exec), /has no session yet/)
  } finally { await cleanup(suite.workspace) }
})

test('line guards: required, slash prefix, 512-character cap', async () => {
  const suite = await setupSuite({ agents: { 'child-0001': fakeAgent('child-0001') }, commandExecute: async () => undefined })
  try {
    await assert.rejects(() => suite.tool.execute({ member: 'writer', action: 'run' }, suite.exec), /run requires/)
    await assert.rejects(() => suite.tool.execute({ member: 'writer', action: 'run', line: 'compact' }, suite.exec), /must start with/)
    await assert.rejects(() => suite.tool.execute({ member: 'writer', action: 'run', line: '/' + 'a'.repeat(512) }, suite.exec), /too long/)
    const value = await suite.tool.execute({ member: 'writer', action: 'run', line: '/' + 'a'.repeat(511) }, suite.exec)
    assert.equal(value.ok, false, '511 chars passes the guard; the fake bus then reports nothing handled it')
  } finally { await cleanup(suite.workspace) }
})

test('cold member: typert lookup resolves what the registry cannot', async (t) => {
  const { resolveMemberAgent } = await import('../lib/members.js')
  let typertResolved = 0
  const ctxWithTypert = {
    logger: { warn() {} },
    agents: { get: () => undefined },
    get(name) {
      if (name !== 'typert') return undefined
      return { lookups: { get: (key) => (key === 'agent' ? { resolve: async (id) => { typertResolved += 1; return fakeAgent(id) } } : undefined) } }
    },
  }
  const cold = await resolveMemberAgent(ctxWithTypert, 'child-cold')
  assert.equal(cold.id, 'child-cold')
  assert.equal(typertResolved, 1)

  let registryHit = 0
  const ctxFallback = {
    logger: { warn() {} },
    agents: { get: (id) => { registryHit += 1; return id === 'child-0001' ? fakeAgent(id) : undefined } },
    get() { return undefined },
  }
  const fallback = await resolveMemberAgent(ctxFallback, 'child-0001')
  assert.equal(fallback.id, 'child-0001')
  assert.equal(registryHit, 1)

  const ctxMiss = { logger: { warn() {} }, agents: { get: () => undefined }, get() { return undefined } }
  assert.equal(await resolveMemberAgent(ctxMiss, 'nobody'), undefined)
  t.diagnostic('both-miss branch returns undefined; the tool then raises member agent is not resolvable')

  const suite = await setupSuite({ agents: {} })
  try {
    await assert.rejects(() => suite.tool.execute({ member: 'writer', action: 'list' }, suite.exec), /member agent is not resolvable/)
  } finally { await cleanup(suite.workspace) }
})

test('typert resolve throwing degrades to the registry instead of crashing', async () => {
  const { resolveMemberAgent } = await import('../lib/members.js')
  const ctx = {
    logger: { warn() {} },
    agents: { get: (id) => (id === 'child-0001' ? fakeAgent(id) : undefined) },
    get() { return { lookups: { get: (key) => (key === 'agent' ? { resolve: async () => { throw new Error('boom') } } : undefined) } } },
  }
  const agent = await resolveMemberAgent(ctx, 'child-0001')
  assert.equal(agent.id, 'child-0001')
})

test('run against a cold member resolves through typert and executes', async () => {
  const { tool, workspace } = await setupSuite({
    typert: { lookups: { get: (key) => (key === 'agent' ? { resolve: async (id) => fakeAgent(id) } : undefined) } },
    agents: {},
    commandExecute: async (agent) => ({ commandId: 'cold-1', result: { kind: 'success', text: 'ok' } }),
  })
  try {
    const value = await tool.execute({ member: 'cold', action: 'run', line: '/compact' }, { agent: { id: 'captain-1', session: { header: { cwd: workspace } } }, signal: new AbortController().signal })
    assert.equal(value.ok, true)
    assert.equal(value.command_id, 'cold-1')
  } finally { await cleanup(workspace) }
})

// ---- POST /plugins/dsh-agent-teams/member/prompt ----

/** Mount the real plugin surface (index.apply) against the fake ctx and return the prompt route. */
async function setupRoute(deliveries) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-run-command-route-'))
  const stateRoot = join(workspace, '.agent-teams')
  await mkdir(stateRoot, { recursive: true })
  await createTeamDir(stateRoot, {
    name: 'demo', id: 'demo', captainSessionId: 'captain-1', createdAt: 1, taskSeq: 0,
    members: MEMBERS.map((member) => ({ ...member })), tasks: [],
  })
  const subagents = {
    registerContinuableSetup() { return () => undefined },
    async followup(parent, childId, content) {
      deliveries.push({ childId, text: content.map((block) => block.text).join('') })
      return 'msg-1'
    },
  }
  const { ctx, registeredRoutes } = makeFakeCtx({ subagents })
  // The route reads the captain from the live registry.
  const captain = { id: 'captain-1', session: { header: { cwd: workspace } } }
  ctx.agents = { get: (id) => (id === 'captain-1' ? captain : undefined), list: () => [] }
  apply(ctx, {
    stateDir: '.agent-teams',
    memberProvider: 'spawn',
    maxMembers: 8,
    toolPolicies: {},
    profiles: {},
    slashCommand: false,
  })
  const route = registeredRoutes.find((entry) => entry.path === '/plugins/dsh-agent-teams/member/prompt')
  assert.ok(route, 'member/prompt route registered')
  return { workspace, ctx, deliveries, route }
}

test('member/prompt route is registered', async () => {
  const deliveries = []
  const { workspace, route } = await setupRoute(deliveries)
  await rm(workspace, { recursive: true, force: true })
  assert.notEqual(route, undefined)
})

test('member/prompt: 405 for non-POST', async () => {
  const deliveries = []
  const { workspace, route } = await setupRoute(deliveries)
  const res = makeRes()
  try {
    await route.handler({ method: 'GET', url: '/' }, res)
    assert.equal(res.statusCode, 405)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('member/prompt: 400 when required fields are missing', async () => {
  const deliveries = []
  const { workspace, route } = await setupRoute(deliveries)
  const res = makeRes()
  try {
    await route.handler(jsonRequest({}), res)
    assert.equal(res.statusCode, 400)
    assert.match(JSON.parse(res.body).error, /required/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('member/prompt: 409 when the captain session is not attached', async () => {
  const deliveries = []
  const { workspace, ctx, route } = await setupRoute(deliveries)
  ctx.agents.get = () => undefined
  const res = makeRes()
  try {
    await route.handler(jsonRequest({ sessionId: 'ghost-captain', teamId: 'demo', member: 'writer', text: 'hello' }), res)
    assert.equal(res.statusCode, 409)
    assert.match(JSON.parse(res.body).error, /not attached/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('member/prompt: 404 when the team does not belong to this captain', async () => {
  const deliveries = []
  const { workspace, route } = await setupRoute(deliveries)
  const res = makeRes()
  try {
    await route.handler(jsonRequest({ sessionId: 'captain-1', teamId: 'other-team', member: 'writer', text: 'hello' }), res)
    assert.equal(res.statusCode, 404)
    assert.match(JSON.parse(res.body).error, /team not found/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('member/prompt: 404 for an unknown or removed member', async () => {
  const deliveries = []
  const { workspace, route } = await setupRoute(deliveries)
  try {
    const unknown = makeRes()
    await route.handler(jsonRequest({ sessionId: 'captain-1', teamId: 'demo', member: 'nobody', text: 'hi' }), unknown)
    assert.equal(unknown.statusCode, 404)
    const removed = makeRes()
    await route.handler(jsonRequest({ sessionId: 'captain-1', teamId: 'demo', member: 'gone', text: 'hi' }), removed)
    assert.equal(removed.statusCode, 404)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('member/prompt: 409 for stopping or never-started members', async () => {
  const deliveries = []
  const { workspace, route } = await setupRoute(deliveries)
  try {
    const stopping = makeRes()
    await route.handler(jsonRequest({ sessionId: 'captain-1', teamId: 'demo', member: 'drained', text: 'hi' }), stopping)
    assert.equal(stopping.statusCode, 409)
    const unstarted = makeRes()
    await route.handler(jsonRequest({ sessionId: 'captain-1', teamId: 'demo', member: 'ghost', text: 'hi' }), unstarted)
    assert.equal(unstarted.statusCode, 409)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('member/prompt: 200 delivers plain text through the captain -> member queue', async () => {
  const deliveries = []
  const { workspace, route } = await setupRoute(deliveries)
  const res = makeRes()
  try {
    await route.handler(jsonRequest({ sessionId: 'captain-1', teamId: 'demo', member: 'writer', text: 'please run /compact next' }), res)
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.member, 'child-0001')
    assert.equal(body.delivered, true)
    assert.equal(deliveries.length, 1)
    assert.equal(deliveries[0].childId, 'child-0001')
    assert.match(deliveries[0].text, /please run \/compact next/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('member/prompt: 500 when the delivery path fails', async () => {
  const deliveries = []
  const { workspace, ctx, route } = await setupRoute(deliveries)
  // break the queue: the subagent facade throws on followup
  ctx.subagents.followup = async () => { throw new Error('bus down') }
  const res = makeRes()
  try {
    await route.handler(jsonRequest({ sessionId: 'captain-1', teamId: 'demo', member: 'writer', text: 'hi' }), res)
    assert.equal(res.statusCode, 500)
    assert.match(JSON.parse(res.body).error, /failed to deliver/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

// ---- t28 repair (F1): the deny predicate must parse the host command name ----
// The host parses a line with /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u, so a
// hand-written `line === '/name' || line.startsWith('/name ')` check misses the
// TAB/LF/CR separators and the profile alias family (agent-teams-<profile>).

test('deny parses the host command name: TAB/LF/CR separators and profile aliases never reach the bus', async () => {
  const calls = []
  const { tool, exec, workspace } = await setupSuite({
    agents: { 'child-0001': fakeAgent('child-0001') },
    commandExecute: async (agent, line, attachments) => {
      calls.push({ line, attachments })
      return { commandId: 'c', result: { kind: 'success', text: 'ok' } }
    },
  })
  try {
    // The host name ends at any of [\t\n\r ]; a space-only predicate misses TAB.
    await assert.rejects(() => tool.execute({ member: 'writer', action: 'run', line: '/agent-teams\tdo it' }, exec), /memberCommandDeny/)
    await assert.rejects(() => tool.execute({ member: 'writer', action: 'run', line: '/agent-teams\ndo it' }, exec), /single command line/)
    await assert.rejects(() => tool.execute({ member: 'writer', action: 'run', line: '/agent-teams\rdo it' }, exec), /single command line/)
    // This plugin registers profile aliases as agent-teams-<profile>.
    await assert.rejects(() => tool.execute({ member: 'writer', action: 'run', line: '/agent-teams-solo goal' }, exec), /memberCommandDeny/)
    // Hardening: any CR/LF line is refused before the bus, even for a normal command.
    await assert.rejects(() => tool.execute({ member: 'writer', action: 'run', line: '/compact\nrm -rf /' }, exec), /single command line/)
    assert.equal(calls.length, 0, 'none of the refused lines reached ctx.commands.execute')
    // Fairness: the denied word inside arguments is not a deny hit.
    const allowed = await tool.execute({ member: 'writer', action: 'run', line: '/compact agent-teams' }, exec)
    assert.equal(allowed.ok, true)
    assert.deepEqual(calls, [{ line: '/compact agent-teams', attachments: [] }])
  } finally { await cleanup(workspace) }
})

test('list hides the whole denied alias family, and a custom deny is prefix-aware', async () => {
  const { tool, exec, workspace } = await setupSuite({
    agents: { 'child-0001': fakeAgent('child-0001') },
    commandList: () => [
      { name: 'compact', description: 'x' },
      { name: AGENT_TEAMS_COMMAND, description: 'activation' },
      { name: 'agent-teams-solo', description: 'profile alias' },
      { name: 'agent-teams-review', description: 'profile alias' },
      { name: 'report', description: 'kept' },
    ],
  })
  try {
    const value = await tool.execute({ member: 'writer', action: 'list' }, exec)
    assert.deepEqual(value.commands.map((command) => command.name), ['compact', 'report'])
  } finally { await cleanup(workspace) }

  const custom = await setupSuite({
    memberCommandDeny: ['dev'],
    agents: { 'child-0001': fakeAgent('child-0001') },
    commandList: () => [
      { name: 'dev', description: 'x' },
      { name: 'dev-tools', description: 'alias' },
      { name: 'dev_x', description: 'underscore is a different command name' },
    ],
  })
  try {
    const value = await custom.tool.execute({ member: 'writer', action: 'list' }, custom.exec)
    assert.deepEqual(value.commands.map((command) => command.name), ['dev_x'])
    await assert.rejects(() => custom.tool.execute({ member: 'writer', action: 'run', line: '/dev-tools now' }, custom.exec), /memberCommandDeny/)
    await assert.rejects(() => custom.tool.execute({ member: 'writer', action: 'run', line: '/dev now' }, custom.exec), /memberCommandDeny/)
  } finally { await cleanup(custom.workspace) }
})

// ---- t30 (N1): memberCommandDeny entries are normalized, never fail-open ----
// '/compact', 'Compact' and ' compact ' are the same switch as 'compact'; an
// unusable entry fails the mount (host path) or warns once (direct callers).

test('memberCommandDeny spellings are equivalent: /compact, Compact, " compact " and compact all deny /compact', async () => {
  for (const spelling of [['/compact'], ['Compact'], [' compact '], ['compact']]) {
    const calls = []
    const suite = await setupSuite({
      memberCommandDeny: spelling,
      agents: { 'child-0001': fakeAgent('child-0001') },
      commandExecute: async (agent, line) => {
        calls.push(line)
        return { commandId: 'c', result: { kind: 'success', text: 'ok' } }
      },
    })
    try {
      await assert.rejects(
        () => suite.tool.execute({ member: 'writer', action: 'run', line: '/compact' }, suite.exec),
        /command "compact" is denied for members \(memberCommandDeny\)/,
        'spelling ' + JSON.stringify(spelling) + ' must deny /compact',
      )
      assert.equal(calls.length, 0, 'a denied line never reaches ctx.commands.execute')
    } finally { await cleanup(suite.workspace) }
  }
})

test('normalized deny entries filter list through the same predicate', async () => {
  const suite = await setupSuite({
    memberCommandDeny: [' /COMPACT '],
    agents: { 'child-0001': fakeAgent('child-0001') },
    commandList: () => [
      { name: 'compact', description: 'x' },
      { name: 'report', description: 'y' },
    ],
  })
  try {
    const value = await suite.tool.execute({ member: 'writer', action: 'list' }, suite.exec)
    assert.deepEqual(value.commands.map((command) => command.name), ['report'])
  } finally { await cleanup(suite.workspace) }
})

test('unusable memberCommandDeny entries warn once and never disable the valid ones', async () => {
  const warnings = []
  const calls = []
  const suite = await setupSuite({
    logger: { info() {}, warn(message) { warnings.push(message) }, error() {} },
    memberCommandDeny: ['/compact', '', '/', '   ', 42, { name: 'x' }],
    agents: { 'child-0001': fakeAgent('child-0001') },
    commandExecute: async (agent, line) => {
      calls.push(line)
      return { commandId: 'c', result: { kind: 'success', text: 'ok' } }
    },
  })
  try {
    assert.equal(warnings.length, 1, 'exactly one warning at registration')
    assert.match(warnings[0], /memberCommandDeny/)
    assert.match(warnings[0], /no usable command name/)
    await assert.rejects(
      () => suite.tool.execute({ member: 'writer', action: 'run', line: '/compact' }, suite.exec),
      /is denied for members/,
    )
    assert.equal(calls.length, 0)
  } finally { await cleanup(suite.workspace) }
})

test('mount rejects unusable memberCommandDeny entries instead of silently denying nothing', () => {
  const { ctx } = makeFakeCtx()
  assert.throws(
    () => apply(ctx, { memberCommandDeny: ['/compact', ''] }),
    /memberCommandDeny contains an entry with no usable command name/,
  )
  assert.throws(() => apply(ctx, { memberCommandDeny: ['   '] }), /no usable command name/)
  assert.throws(() => apply(ctx, { memberCommandDeny: [42] }), /no usable command name/)
  // The shared normalizer both paths use: empty list denies nothing (literal
  // replacement, N3), absent list keeps the plugin's own surface as default.
  assert.deepEqual(normalizeMemberCommandDeny([]).names, [])
  assert.deepEqual(normalizeMemberCommandDeny(undefined).names, [AGENT_TEAMS_COMMAND])
  const mixed = normalizeMemberCommandDeny(['/Compact', '', 'review'])
  assert.deepEqual(mixed.names, ['compact', 'review'])
  assert.deepEqual(mixed.dropped, [''])
})

/**
 * The plugin must require exactly the upstream service list.
 *
 * Regression guard for the 2026-10-22 field failure: plan 02 added `tokenMeter`
 * and `compaction` to `inject`, but the desktop profile disables the top-level
 * `compaction-basic` and composes compaction INSIDE each agent preset. Cordis
 * then parks the whole plugin as `pending (waiting for service: compaction)`,
 * so no tool and no route is ever registered. Everything the budget needs is
 * read structurally and may be absent; requiring it here IS the bug.
 */
test('inject requires only the upstream services', () => {
  assert.deepEqual([...inject], ['tools', 'llm', 'subagents', 'systemPrompt', 'agents'])
})

/**
 * An absent `memberContext` must stay absent after schema validation.
 *
 * Regression guard for the 2026-10-22 field failure: a bare `z.object()` for
 * the optional block materialized `{}` (Schemastery's implicit object default),
 * `parseMemberContextConfig` then rejected a block the deployment never wrote,
 * and the whole plugin failed to mount with
 * `memberContext requires a positive maxTokens or maxRatio threshold`.
 */
test('an absent memberContext stays undefined', () => {
  const config = Config({ stateDir: '.agent-teams', memberProvider: 'spawn' })
  assert.equal(config.memberContext, undefined)
  const configured = Config({ memberContext: { maxTokens: 1000 } })
  assert.equal(configured.memberContext.maxTokens, 1000)
})


