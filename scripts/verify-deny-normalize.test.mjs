/**
 * N1 INDEPENDENT verification — memberCommandDeny normalization (verifier-authored).
 * Goal: prove no spelling can silently disable the deny switch, run and list can
 * never disagree, and illegal entries are loud (mount throw / warn), never swallowed.
 * Host grammar cross-check: asar 0.2.1-rc.2 dsh-commands parseCommand uses the SAME
 * /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u — so a line the plugin cannot name-parse
 * cannot execute on the real bus either (unclaimed, not a bypass).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { readTeam, writeTeam } from '../lib/state.js'
import { registerAgentTeamsTools } from '../lib/tools.js'

async function mount(matrixConfig) {
  const scratchRoot = join(fileURLToPath(new URL('../node_modules', import.meta.url)), '.scratch')
  await mkdir(scratchRoot, { recursive: true })
  const workspace = await mkdtemp(join(scratchRoot, 'deny-matrix-'))
  const definitions = new Map()
  const liveAgents = new Map()
  const routes = new Map()
  const executeCalls = []
  const warnings = []
  const webServer = {
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
  }
  const sessionOf = () => ({
    header: { cwd: workspace },
    append() {},
    requestHeader() { return { config: { provider: 'fake', model: 'fake-model' } } },
    ownEvents() { return [] },
  })
  const makeAgent = (id) => ({
    id, status: 'idle', options: { provider: 'fake', model: 'fake-model' }, session: sessionOf(),
    ctx: { effect(setup) { return setup() } },
    followups: [], steers: [], injections: [],
    followup(m) { this.followups.push(m) }, steer(m) { this.steers.push(m) }, inject(m) { this.injections.push(m) },
    cancel() {}, whenIdle() { return Promise.resolve() },
  })
  const captain = makeAgent('captain-session')
  const member = makeAgent('sess-m')
  liveAgents.set(captain.id, captain)
  liveAgents.set(member.id, member)
  const catalogs = new Map([
    [captain, [{ name: 'captain-secret', description: 'captain only' }]],
    [member, [
      { name: 'alpha', description: 'A' },
      { name: 'beta', description: 'B' },
      { name: 'shared', description: 'S' },
      { name: 'compact', description: 'compact context' },
      { name: 'review-tools', description: 'prefixed alias' },
      { name: 'agent-teams', description: 'the plugin surface' },
    ]],
  ])
  const HOST_COMMAND_NAME = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u
  const knownNames = new Set([...catalogs.values()].flat().map((d) => d.name))
  const commandsFace = {
    list(agent) { return catalogs.get(agent) ?? [] },
    async execute(agent, line, attachments, signal) {
      const name = HOST_COMMAND_NAME.exec(line)?.[1]
      if (name === undefined || !knownNames.has(name)) return undefined
      executeCalls.push(line)
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
      if (key === 'typert') return { lookups: { get: () => undefined } }
      return undefined
    },
    on() { return () => undefined },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    agents: { get(id) { return liveAgents.get(id) }, list() { return [...liveAgents.values()] } },
    llm: {
      async resolveCallConfig(config) { return config },
      async listModels(provider) { return [{ provider, id: 'fake-model', name: 'fake-model' }] },
    },
    subagents: {
      registerContinuableSetup() { return () => undefined },
      getProvider(name) { return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined },
      list() { return ['spawn'] },
      async startContinuable() { throw new Error('no spawn') },
      async listChildren() { return [] },
      async listDescendants() { return [] },
      async followup() { return 'm1' },
      interrupt() {},
      async drainContinuableChildren() {},
    },
    systemPrompt: { section() {} },
    logger: { debug() {}, info() {}, warn(msg) { warnings.push(String(msg)) } },
  }
  ctx.commands = commandsFace
  const config = {
    stateDir: '.agent-teams', memberProvider: 'spawn', slashCommand: false,
    profiles: { 'deny-demo': { description: 'x', members: [{ name: 'm', role: 'R', model: 'fake-model' }], tasks: [] } },
  }
  if (matrixConfig !== 'OMIT') config.memberCommandDeny = matrixConfig
  try {
    apply(ctx, config)
  } catch (error) {
    await rm(workspace, { recursive: true, force: true })
    throw error
  }
  const tool = definitions.get('agent_teams_run_command')
  await definitions.get('agent_teams_create').execute(
    { name: 'Deny Demo', description: 'x', profile: 'deny-demo', approval: 'required' },
    { agent: captain, signal: new AbortController().signal },
  )
  const stateRoot = join(workspace, '.agent-teams')
  const seed = await readTeam(stateRoot, 'deny-demo')
  seed.members[0].id = 'sess-m'
  await writeTeam(stateRoot, seed)
  const call = (args) => tool.execute(args, { agent: captain, signal: new AbortController().signal })
  const run = (line) => call({ member: 'm', action: 'run', line })
  const list = () => call({ member: 'm', action: 'list' })
  return { workspace, executeCalls, warnings, run, list, call, cleanup: () => rm(workspace, { recursive: true, force: true }) }
}

// Row runner: mounts one config and probes /agent-teams + /compact.
async function probeRow(t, matrixConfig, expectations) {
  const h = await mount(matrixConfig)
  t.after(h.cleanup)
  const agentTeams = await h.run('/agent-teams hi').then(() => 'EXECUTED', (e) => `REJECTED: ${e.message}`)
  const compact = await h.run('/compact').then(() => 'EXECUTED', (e) => `REJECTED: ${e.message}`)
  assert.equal(agentTeams, expectations.agentTeams, `/agent-teams row ${JSON.stringify(matrixConfig)}`)
  assert.equal(compact, expectations.compact, `/compact row ${JSON.stringify(matrixConfig)}`)
  return h
}

// ---------------------------------------------------------------------------
// M1. The spelling matrix: every documented write-style of a deny entry.
//     EXECUTED means the line reached ctx.commands.execute (must be 0 for denied).
// ---------------------------------------------------------------------------

test('M1a. default / explicit / slash-prefixed / case / padded spellings all deny agent-teams', async (t) => {
  const denied = 'REJECTED: command "agent-teams" is denied for members (memberCommandDeny)'
  const rows = [
    ['OMIT', denied],                        // config absent -> plugin default
    [['agent-teams'], denied],
    [['/agent-teams'], denied],
    [['Agent-Teams'], denied],
    [[' agent-teams '], denied],
    [['//agent-teams'], denied],             // multiple leading slashes
  ]
  for (const [config, expected] of rows) {
    const h = await probeRow(t, config === 'OMIT' ? 'OMIT' : config, {
      agentTeams: expected,
      compact: 'EXECUTED',
    })
    assert.equal(h.executeCalls.filter((line) => line.startsWith('/agent-teams')).length, 0,
      `denied /agent-teams must never reach the bus (config ${JSON.stringify(config)})`)
  }
})

test('M1b. denying compact under every spelling blocks exactly compact, not agent-teams', async (t) => {
  const denied = 'REJECTED: command "compact" is denied for members (memberCommandDeny)'
  const rows = [
    [['compact'], denied],
    [['/compact'], denied],
    [['Compact'], denied],
    [[' /COMPACT '], denied],
  ]
  for (const [config, expected] of rows) {
    const h = await probeRow(t, config, {
      agentTeams: 'EXECUTED',
      compact: expected,
    })
    assert.equal(h.executeCalls.filter((line) => line === '/compact').length, 0)
  }
})

test('M1c. explicit empty array denies nothing (deliberate N3 literal replacement)', async (t) => {
  const h = await mount([])
  t.after(h.cleanup)
  const at = await h.run('/agent-teams hi')
  assert.equal(at.ok, true, '/agent-teams EXECUTED with an explicit empty deny list')
  const cp = await h.run('/compact')
  assert.equal(cp.ok, true, '/compact EXECUTED too')
})

test('M1d. unusable entries fail the MOUNT with a readable error (never a silent deny-nothing)', async () => {
  const rows = [
    [[''], /memberCommandDeny contains an entry with no usable command name \(""\)/],
    [['/'], /memberCommandDeny contains an entry with no usable command name \("\/"\)/],
    [['/ Compact'], /no usable command name \("\/ Compact"\)/],
    [['!!!'], /no usable command name \("!!!"\)/],
    [[42], /no usable command name \(42\)/],
    [['compact', ''], /no usable command name \(""\)/],
  ]
  for (const [config, pattern] of rows) {
    await assert.rejects(mount(config), pattern, `config ${JSON.stringify(config)}`)
  }
})

test('M1e. line-side evasions agree with the host grammar (unclaimed, not a bypass)', async (t) => {
  const h = await mount(['compact'])
  t.after(h.cleanup)
  const settle = (p) => p.then((v) => ({ thrown: false, v }), (e) => ({ thrown: true, message: e.message }))
  const upper = await settle(h.run('/COMPACT'))
  assert.equal(upper.thrown, false)
  assert.equal(upper.v.ok, false)
  assert.match(upper.v.text, /no registered command handled "\/COMPACT"/)
  const spaced = await settle(h.run('/ compact'))
  assert.equal(spaced.thrown, false)
  assert.equal(spaced.v.ok, false)
  assert.match(spaced.v.text, /no registered command handled/)
  const crlf = await settle(h.run('/compact\n/agent-teams'))
  assert.equal(crlf.thrown, true)
  assert.match(crlf.message, /CR and LF are not allowed/)
  assert.equal(h.executeCalls.length, 0, 'none of the evasive lines reached the bus')
})

test('M1f. prefix over-breadth is deliberate: denying "review" also denies "review-tools"', async (t) => {
  const h = await mount(['review'])
  t.after(h.cleanup)
  const alias = await h.run('/review-tools').then(() => 'EXECUTED', (e) => `REJECTED: ${e.message}`)
  assert.match(alias, /command "review-tools" is denied/)
  assert.equal(h.executeCalls.length, 0)
})

test('M1g. dedup: repeated spellings of one name collapse to a single switch', async (t) => {
  const h = await mount(['compact', '/compact', 'Compact ', 'compact'])
  t.after(h.cleanup)
  const cp = await h.run('/compact').then(() => 'EXECUTED', (e) => `REJECTED: ${e.message}`)
  assert.match(cp, /command "compact" is denied/)
  const alpha = await h.run('/alpha')
  assert.equal(alpha.ok, true, 'unrelated commands unaffected')
})

// ---------------------------------------------------------------------------
// M2. run/list complementarity: one shared normalization, no seam.
// ---------------------------------------------------------------------------

test('M2. list output and run rejection are exact complements over the same catalog', async (t) => {
  const h = await mount(['alpha', 'shared'])
  t.after(h.cleanup)
  const catalog = ['alpha', 'beta', 'shared', 'shared-x', 'compact', 'review-tools', 'agent-teams']
  const listed = (await h.list()).commands.map((c) => c.name)
  // explicit list replaces the default: agent-teams is NOT denied here
  assert.deepEqual(listed, ['beta', 'compact', 'review-tools', 'agent-teams'])
  for (const name of catalog) {
    const inList = listed.includes(name)
    const rejected = await h.run(`/${name}`).then(() => false, (e) => /is denied for members/.test(e.message))
    assert.notEqual(inList, rejected, `${name}: listed XOR rejected — no gap, no overlap`)
  }
  assert.equal(h.executeCalls.length, listed.length, 'exactly the listed (allowed) commands reached the bus')
})

// ---------------------------------------------------------------------------
// M3. Direct callers that bypass the mount parser get a loud warning and a
//     partially-effective switch (never a silent total fail-open).
// ---------------------------------------------------------------------------

test('M3. registerAgentTeamsTools direct path: dropped entries warn and keep valid entries', async (t) => {
  const scratchRoot = join(fileURLToPath(new URL('../node_modules', import.meta.url)), '.scratch')
  await mkdir(scratchRoot, { recursive: true })
  const workspace = await mkdtemp(join(scratchRoot, 'deny-direct-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const definitions = new Map()
  const executeCalls = []
  const warnings = []
  const liveAgents = new Map()
  const sessionOf = () => ({
    header: { cwd: workspace }, append() {},
    requestHeader() { return { config: { provider: 'fake', model: 'fake-model' } } },
    ownEvents() { return [] },
  })
  const makeAgent = (id) => ({
    id, status: 'idle', options: { provider: 'fake', model: 'fake-model' }, session: sessionOf(),
    ctx: { effect(setup) { return setup() } },
    followups: [], steers: [], injections: [],
    followup(m) { this.followups.push(m) }, steer(m) { this.steers.push(m) }, inject(m) { this.injections.push(m) },
    cancel() {}, whenIdle() { return Promise.resolve() },
  })
  const captain = makeAgent('captain-session')
  const member = makeAgent('sess-m')
  liveAgents.set(captain.id, captain)
  liveAgents.set(member.id, member)
  const commandsFace = {
    list(agent) { return agent === member ? [{ name: 'compact' }, { name: 'agent-teams' }] : [] },
    async execute(agent, line) { executeCalls.push(line); return { result: { kind: 'success', text: 'ok' }, commandId: 'c' } },
  }
  const ctx = {
    effect(setup) { return setup() },
    get(key) {
      if (key === 'commands') return commandsFace
      if (key === 'typert') return { lookups: { get: () => undefined } }
      return undefined
    },
    on() { return () => undefined },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    agents: { get(id) { return liveAgents.get(id) }, list() { return [...liveAgents.values()] } },
    llm: {
      async resolveCallConfig(config) { return config },
      async listModels(provider) { return [{ provider, id: 'fake-model', name: 'fake-model' }] },
    },
    subagents: {
      registerContinuableSetup() { return () => undefined },
      getProvider(name) { return name === 'spawn' ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined },
      list() { return ['spawn'] },
      async startContinuable() { throw new Error('no spawn') },
      async listChildren() { return [] },
      async listDescendants() { return [] },
      async followup() { return 'm1' },
      interrupt() {},
      async drainContinuableChildren() {},
    },
    systemPrompt: { section() {} },
    logger: { debug() {}, info() {}, warn(msg) { warnings.push(String(msg)) } },
  }
  ctx.commands = commandsFace
  registerAgentTeamsTools(ctx, {
    stateDir: '.agent-teams',
    memberProvider: 'spawn',
    memberCommandDeny: ['bogus!', 'compact'],
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /memberCommandDeny ignores an entry with no usable command name \("bogus!"\); write names without the leading slash, e\.g\. "compact"/)
  await definitions.get('agent_teams_create').execute(
    { name: 'Direct Deny', description: 'x' },
    { agent: captain, signal: new AbortController().signal },
  )
  const stateRoot = join(workspace, '.agent-teams')
  const seed = await readTeam(stateRoot, 'direct-deny')
  seed.members.push({ id: 'sess-m', name: 'm', role: 'R', provider: 'fake', model: 'fake-model', joinedAt: Date.now(), status: 'idle' })
  await writeTeam(stateRoot, seed)
  const tool = definitions.get('agent_teams_run_command')
  const call = (args) => tool.execute(args, { agent: captain, signal: new AbortController().signal })
  const listed = (await call({ member: 'm', action: 'list' })).commands.map((c) => c.name)
  assert.deepEqual(listed, ['agent-teams'], 'valid deny entry stays effective; only the bogus entry is dropped')
  await assert.rejects(call({ member: 'm', action: 'run', line: '/compact' }), /command "compact" is denied/)
  assert.equal(executeCalls.length, 0)
})
