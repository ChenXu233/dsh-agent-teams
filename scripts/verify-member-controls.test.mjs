/**
 * Verification for the member composer controls (plan 10, task 8).
 *
 * Part A pins the pure control decisions. Part B mounts the REAL plugin on a
 * fake host and drives the three routes the controls use, so a wrong path, a
 * wrong status or a route that ignores the registry fails here instead of in a
 * browser nobody can open yet.
 *
 * Imports the BUILT bundle (../lib/**.js) - run `pnpm build` first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { createTeamDir } from '../lib/state.js'
import { parkMember, parkedMessageId } from '../lib/member-residency.js'
import { dropMemberRoute, registerMemberRoute } from '../lib/member-route-registry.js'
import {
  MODEL_PLACEHOLDER,
  canAttach,
  deliveryHint,
  deliveryMode,
  modelLabel,
  modelOptionKey,
  modelOptions,
  queuedLabel,
  stopEnabled,
  withCurrentOption,
} from '../lib/client/member-controls.js'

// ---------------------------------------------------------------------------
// A. Pure control decisions
// ---------------------------------------------------------------------------

test('A1. a running member is steered; an idle one is queued', () => {
  assert.equal(deliveryMode({ running: true }), 'steer')
  assert.equal(deliveryMode({ running: false }), 'queue')
  assert.equal(deliveryMode({}), 'queue')
  // An archived team accepts neither, so it must not claim the steer path.
  assert.equal(deliveryMode({ running: true, archived: true }), 'queue')
})

test('A2. stop only applies to a running, non-archived member', () => {
  assert.equal(stopEnabled({ running: true }), true)
  assert.equal(stopEnabled({ running: false }), false)
  assert.equal(stopEnabled({ running: true, archived: true }), false)
  assert.equal(stopEnabled({}), false)
})

test('A3. attachments need a live idle member', () => {
  assert.equal(canAttach({ live: true, running: false }), true)
  assert.equal(canAttach({ live: true, running: true }), false)
  assert.equal(canAttach({ live: true, running: false, archived: true }), false)
  assert.equal(canAttach({ live: false, running: false }), false)
  assert.equal(canAttach({}), false)
})

test('A4. model label falls back to a placeholder, never to an empty string', () => {
  assert.equal(modelLabel({ model: { provider: 'deepseek', model: 'deepseek-v4' } }), 'deepseek / deepseek-v4')
  assert.equal(modelLabel({ model: null }), MODEL_PLACEHOLDER)
  assert.equal(modelLabel({}), MODEL_PLACEHOLDER)
  assert.ok(MODEL_PLACEHOLDER.length > 0)
})

test('A5. queue badge disappears at zero', () => {
  assert.equal(queuedLabel(0), undefined)
  assert.equal(queuedLabel(undefined), undefined)
  assert.equal(queuedLabel(-1), undefined)
  assert.equal(queuedLabel(3), '3 条待处理')
})

test('A6. delivery hint follows the same mode the transport uses', () => {
  assert.match(deliveryHint({ running: true }), /当前回合/u)
  assert.match(deliveryHint({ running: false }), /下一回合/u)
  assert.match(deliveryHint({ running: true, archived: true }), /归档/u)
  assert.match(deliveryHint({}), /下一回合/u)
})

test('A7. model options flatten the catalog and drop duplicate routes', () => {
  const groups = [
    { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'v4', name: 'V4' }, { id: 'v4', name: 'V4 again' }] },
    { id: 'other', name: 'Other', models: [{ id: 'pro', name: 'Pro' }] },
  ]
  const options = modelOptions(groups)
  assert.deepEqual(options.map(option => option.key), [
    modelOptionKey('deepseek', 'v4'),
    modelOptionKey('other', 'pro'),
  ])
  assert.equal(options[0].label, 'DeepSeek / V4')
  assert.deepEqual(modelOptions(undefined), [])
  // A provider and a model id may both contain "/", so the key must not join
  // them with the same separator a reader would use.
  assert.notEqual(modelOptionKey('a/b', 'c'), modelOptionKey('a', 'b/c'))
})

test('A8. the current route stays selectable even when the catalog lost it', () => {
  const options = modelOptions([{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'v4', name: 'V4' }] }])
  const present = withCurrentOption(options, { model: { provider: 'deepseek', model: 'v4' } })
  assert.deepEqual(present.map(option => option.key), options.map(option => option.key))

  const missing = withCurrentOption(options, { model: { provider: 'gone', model: 'old' } })
  assert.equal(missing.length, 2)
  assert.equal(missing[0].key, modelOptionKey('gone', 'old'))
  assert.equal(missing[0].label, 'gone / old')

  assert.deepEqual(withCurrentOption(options, {}), options)
  assert.deepEqual(withCurrentOption(options, { model: null }), options)
})

// ---------------------------------------------------------------------------
// B. Routes behind the controls, on a mounted plugin
// ---------------------------------------------------------------------------

const STATE_DIR = '.agent-teams'
const CAPTAIN = 'captain-1'
const MEMBER = 'child-1'

function makeAgent(id, workspace, overrides = {}) {
  const nextTurn = []
  const nextStep = []
  const agent = {
    id,
    status: 'idle',
    options: { provider: 'fake', model: 'fake-model' },
    session: {
      header: { cwd: workspace, version: 4 },
      append() {},
      requestHeader() { return { config: { provider: 'fake', model: 'fake-model' } } },
      ownEvents() { return [] },
    },
    inbox: {
      get nextTurn() { return nextTurn },
      get nextStep() { return nextStep },
      get hasPending() { return nextTurn.length > 0 || nextStep.length > 0 },
      append(target, message) { (target === 'next-turn' ? nextTurn : nextStep).push(message) },
      remove(id) {
        for (const list of [nextTurn, nextStep]) {
          const index = list.findIndex(message => message.id === id)
          if (index >= 0) { list.splice(index, 1); return true }
        }
        return false
      },
    },
    // Capability hydration walks every live Agent at mount and keeps a scoped
    // effect per Agent.
    ctx: { effect(setup) { return setup() }, tools: { restrict() { return () => undefined } } },
    steers: [],
    followups: [],
    inject(message) { agent.inbox.append('next-step', message) },
    followup(message) { agent.followups.push(message); agent.inbox.append('next-turn', message) },
    steer(message) { agent.steers.push(message); agent.inbox.append('next-step', message) },
    cancel() {},
    whenIdle() { return Promise.resolve() },
    ...overrides,
  }
  return agent
}

async function mountHarness(options = {}) {
  const scratchRoot = join(fileURLToPath(new URL('../node_modules', import.meta.url)), '.scratch')
  await mkdir(scratchRoot, { recursive: true })
  const workspace = await mkdtemp(join(scratchRoot, 'controls-harness-'))
  const stateRoot = join(workspace, STATE_DIR)
  await mkdir(stateRoot, { recursive: true })
  await createTeamDir(stateRoot, {
    name: 'demo', id: 'demo', captainSessionId: CAPTAIN, createdAt: 1, taskSeq: 0,
    members: [{ id: MEMBER, name: 'alpha', role: 'a', joinedAt: 1, status: 'idle' }],
    tasks: [],
    ...(options.halted === true ? { halted: true } : {}),
  })

  const routes = new Map()
  const webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const captain = makeAgent(CAPTAIN, workspace)
  const member = makeAgent(MEMBER, workspace)
  const liveAgents = new Map([[CAPTAIN, captain], [MEMBER, member]])
  const sessions = new Map([[CAPTAIN, captain.session], [MEMBER, member.session]])
  const deliveries = []
  const interruptions = []
  const definitions = new Map()
  const ctx = {
    effect(setup) { return setup() },
    on() { return () => undefined },
    get(key) {
      if (key === 'webServer' || key === 'httpServer') return webServer
      if (key === 'workspaceRegistry' || key === 'workspace') return { list() { return [] } }
      if (key === 'connection') return { requestRejection() { return undefined } }
      if (key === 'commands') return { list() { return [] }, async execute() { return undefined } }
      return undefined
    },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    agents: { get(id) { return liveAgents.get(id) }, list() { return [...liveAgents.values()] } },
    sessions: { get(id) { return sessions.get(id) } },
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
      async followup(_parent, childId, content) { deliveries.push({ childId, content }); return 'message-1' },
      interrupt(id, reason) { interruptions.push({ id, reason }) },
      async drainContinuableChildren() {},
    },
    systemPrompt: { section() {} },
    logger: { debug() {}, info() {}, warn() {} },
  }
  apply(ctx, { stateDir: STATE_DIR, memberProvider: 'spawn', slashCommand: false })

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const route = routes.get(path)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(route.handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`

  const call = async (path, init) => {
    const response = await fetch(base + path, init)
    const text = await response.text()
    let body
    try { body = text === '' ? undefined : JSON.parse(text) } catch { body = text }
    return { status: response.status, body }
  }
  const post = (path, payload) => call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  return {
    workspace, routes, captain, member, deliveries, interruptions,
    get: path => call(path),
    post,
    state: () => call(`/plugins/dsh-agent-teams/member/state?sessionId=${encodeURIComponent(MEMBER)}`),
    async close() {
      await new Promise(resolve => server.close(resolve))
      dropMemberRoute(MEMBER)
      await rm(workspace, { recursive: true, force: true })
    },
  }
}

test('B1. the state route reports the live member without its residency placeholder', async (t) => {
  const harness = await mountHarness()
  t.after(() => harness.close())
  assert.ok(harness.routes.has('/plugins/dsh-agent-teams/member/state'), 'state route must register')

  const before = await harness.state()
  assert.equal(before.status, 200)
  assert.deepEqual(before.body.view, {
    member: 'alpha', teamId: 'demo', live: true, running: false, archived: false,
    model: { provider: 'fake', model: 'fake-model' }, queued: 0,
  })

  // Parking is the keep-alive, not queued work: it must never inflate the badge.
  parkMember(harness.member)
  const parked = await harness.state()
  assert.equal(parked.body.view.queued, 0)
  assert.equal(parked.body.view.live, true)

  // A real queued message does count.
  harness.member.followup({ id: 'real-1', content: [{ type: 'text', text: 'later' }] })
  const queued = await harness.state()
  assert.equal(queued.body.view.queued, 1)
})

test('B2. the state route refuses a session that is not a member', async (t) => {
  const harness = await mountHarness()
  t.after(() => harness.close())
  const missing = await harness.get('/plugins/dsh-agent-teams/member/state?sessionId=child-9')
  assert.equal(missing.status, 404)
  const noParam = await harness.get('/plugins/dsh-agent-teams/member/state')
  assert.equal(noParam.status, 400)
})

test('B3. the model route switches the live selection and the view follows it', async (t) => {
  const harness = await mountHarness()
  t.after(() => harness.close())
  assert.ok(harness.routes.has('/plugins/dsh-agent-teams/member/model'), 'model route must register')

  const applied = []
  registerMemberRoute(MEMBER, route => { applied.push(route) })

  const switched = await harness.post('/plugins/dsh-agent-teams/member/model', {
    sessionId: MEMBER, provider: 'other', model: 'pro', reasoningEffort: 'high',
  })
  assert.equal(switched.status, 200)
  assert.deepEqual(switched.body, { ok: true, provider: 'other', model: 'pro' })
  assert.deepEqual(applied, [{ provider: 'other', model: 'pro', reasoningEffort: 'high' }])

  // The spawn route is immutable, so the view must read the applied switch.
  const state = await harness.state()
  assert.deepEqual(state.body.view.model, { provider: 'other', model: 'pro' })

  const badRequest = await harness.post('/plugins/dsh-agent-teams/member/model', { sessionId: MEMBER, provider: 'other' })
  assert.equal(badRequest.status, 400)

  // A member with no live selection (cold, or a legacy team) is refused.
  dropMemberRoute(MEMBER)
  const cold = await harness.post('/plugins/dsh-agent-teams/member/model', {
    sessionId: MEMBER, provider: 'other', model: 'pro',
  })
  assert.equal(cold.status, 409)
  assert.match(cold.body.error, /no live model selection/u)
})

test('B4. the model route refuses an archived team', async (t) => {
  const harness = await mountHarness({ halted: true })
  t.after(() => harness.close())
  registerMemberRoute(MEMBER, () => {})
  const refused = await harness.post('/plugins/dsh-agent-teams/member/model', {
    sessionId: MEMBER, provider: 'other', model: 'pro',
  })
  assert.equal(refused.status, 409)
  assert.match(refused.body.error, /halted/u)
  // The seat itself stays readable.
  const state = await harness.state()
  assert.equal(state.status, 200)
  assert.equal(state.body.view.archived, true)
})

test('B5. the stop route interrupts through the live captain', async (t) => {
  const harness = await mountHarness()
  t.after(() => harness.close())
  assert.ok(harness.routes.has('/plugins/dsh-agent-teams/member/stop'), 'stop route must register')

  const stopped = await harness.post('/plugins/dsh-agent-teams/member/stop', { sessionId: MEMBER })
  assert.equal(stopped.status, 200)
  assert.deepEqual(stopped.body, { ok: true, accepted: true })
  assert.equal(harness.interruptions.length, 1)
  assert.equal(harness.interruptions[0].id, MEMBER)
  assert.equal(harness.interruptions[0].reason.kind, 'ancestor')
  assert.equal(harness.interruptions[0].reason.agent, harness.captain)

  const missing = await harness.post('/plugins/dsh-agent-teams/member/stop', { sessionId: 'child-9' })
  assert.equal(missing.status, 404)
})

test('B6. the relay honours the delivery mode the composer sends', async (t) => {
  const harness = await mountHarness()
  t.after(() => harness.close())

  // Parked member + steer: one synchronous block appends the line and drops the
  // placeholder, so the member never sees the marker and never goes cold.
  parkMember(harness.member)
  const steered = await harness.post('/plugins/dsh-agent-teams/member/relay', {
    memberSessionId: MEMBER, line: 'hello', mode: 'steer',
  })
  assert.equal(steered.status, 200)
  assert.equal(harness.member.steers.length, 1)
  assert.equal(harness.member.followups.length, 0)
  assert.equal(parkedMessageId(harness.member), undefined)

  // Unparked + default mode: the line queues through the host FIFO.
  const queued = await harness.post('/plugins/dsh-agent-teams/member/relay', {
    memberSessionId: MEMBER, line: 'later',
  })
  assert.equal(queued.status, 200)
  assert.equal(harness.deliveries.length, 1)
  assert.equal(harness.deliveries[0].childId, MEMBER)
})

test('B7. the relay refuses bad input and sessions outside the team', async (t) => {
  const harness = await mountHarness()
  t.after(() => harness.close())

  const wrongMethod = await harness.get('/plugins/dsh-agent-teams/member/relay')
  assert.equal(wrongMethod.status, 405)
  const incomplete = await harness.post('/plugins/dsh-agent-teams/member/relay', { memberSessionId: MEMBER })
  assert.equal(incomplete.status, 400)
  // Unknown session: never attached, so it cannot be a member of any team.
  const foreign = await harness.post('/plugins/dsh-agent-teams/member/relay', { memberSessionId: 'child-9', line: 'hi' })
  assert.equal(foreign.status, 404)
  assert.equal(harness.deliveries.length, 0)
})
