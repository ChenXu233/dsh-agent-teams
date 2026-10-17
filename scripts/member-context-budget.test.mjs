/**
 * Plan 02 — per-member context budget: independent unit tests for the pure
 * watchdog layer (src/member-context.ts, built to lib/member-context.js).
 *
 * These tests are written by the verifier (not the implementer) and drive the
 * watchdog through injected fakes only: fake agent/status events, a fake token
 * meter, and a fake compaction engine — no Harness required.
 *
 * Contract coverage (task 02c):
 *   a. under budget → skip, compact never called
 *   b. over budget + guards satisfied → mode compact calls compact; mode notify records only
 *   c. cooldownMs not elapsed → skip; minTurnGap not elapsed → skip
 *   d. mode "off" → no action; disposer stops evaluation
 *   e. ManualCompactionError('busy') → swallowed silently, exactly one attempt, no retry
 *   f. other errors → warn + failed record, never thrown; compact() → null is not a failure
 *   g. resolveMemberContextBudget priority / smallest-wins / unknown-window rules
 *   h. decideMemberContextAction decision table
 *
 * Semantic anchors (must match the 02a implementation, so a correct
 * implementation is not judged red):
 *   - lastCompactAt === 0 means "never compacted": the FIRST over-budget idle
 *     acts immediately, unaffected by cooldownMs / minTurnGap.
 *   - deps.compact() returning null or rejecting with the busy race is normal,
 *     never a failure, and never retried eagerly.
 *   - Busy absorption exists in two layers (src/members.ts adapter + the
 *     watchdog inner layer); these tests target only lib/member-context.js.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { register } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import {
  decideMemberContextAction,
  installMemberContextWatchdog,
  resolveMemberContextBudget,
} from '../lib/member-context.js'
import { apply, usageSectionText } from '../lib/index.js'
import { readTeam } from '../lib/state.js'

const MEMBER = 'member-agent-1'

/** A manually drivable fake of MemberContextWatchdogDeps. */
function createHarness({ tokens = 0, now = 1_000_000 } = {}) {
  let statusHandler
  let measureImpl = () => tokens
  let compactImpl = async () => ({ shadowedTokenCount: 0 })
  let nowMs = now
  let measureCalls = 0
  const compactCalls = []
  const records = []
  const logs = []
  const deps = {
    onStatus: (handler) => {
      statusHandler = handler
      return () => { statusHandler = undefined }
    },
    measureTokens: () => { measureCalls += 1; return measureImpl() },
    compact: () => { compactCalls.push({ at: nowMs }); return compactImpl() },
    record: (event) => records.push(event),
    log: (level, message) => logs.push({ level, message }),
    now: () => nowMs,
  }
  const emit = (status, agentId = MEMBER) => statusHandler?.({ agentId, status })
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)) }
  return {
    deps, emit, flush, records, logs, compactCalls,
    get measureCalls() { return measureCalls },
    setTokens: (value) => { measureImpl = () => value },
    setCompact: (fn) => { compactImpl = fn },
    advance: (ms) => { nowMs += ms },
    get nowMs() { return nowMs },
  }
}

function busyError() {
  const error = new Error('busy')
  error.name = 'ManualCompactionError'
  error.code = 'busy'
  return error
}

// ---------------------------------------------------------------------------
// h. decideMemberContextAction — the pure decision table
// ---------------------------------------------------------------------------

test('h. decideMemberContextAction decision table', () => {
  const base = {
    usedTokens: 150_000,
    budgetTokens: 150_000,
    now: 100_000,
    lastCompactAt: 0,
    turnsSinceCompact: 0,
    cooldownMs: 60_000,
    minTurnGap: 1,
    mode: 'compact',
  }
  // mode off always skips, even far over budget.
  assert.equal(decideMemberContextAction({ ...base, mode: 'off' }), 'skip')
  // under budget skips in every mode.
  assert.equal(decideMemberContextAction({ ...base, usedTokens: 149_999 }), 'skip')
  assert.equal(decideMemberContextAction({ ...base, usedTokens: 149_999, mode: 'notify' }), 'skip')
  // exact boundary counts as "reached" (>= semantics).
  assert.equal(decideMemberContextAction({ ...base }), 'compact')
  assert.equal(decideMemberContextAction({ ...base, mode: 'notify' }), 'notify')
  // ANCHOR: lastCompactAt === 0 → the first over-budget instant acts
  // immediately, even inside the cooldown window with zero turns elapsed.
  assert.equal(decideMemberContextAction({ ...base, now: 1, turnsSinceCompact: 0 }), 'compact')
  assert.equal(decideMemberContextAction({ ...base, now: 1, turnsSinceCompact: 0, mode: 'notify' }), 'notify')
  // repeat guard: inside the cooldown window → skip (even when turn gap met).
  assert.equal(decideMemberContextAction({ ...base, lastCompactAt: 100_000, now: 100_000 + 59_999, turnsSinceCompact: 5 }), 'skip')
  // cooldown boundary is inclusive: elapsed == cooldownMs is enough.
  assert.equal(decideMemberContextAction({ ...base, lastCompactAt: 100_000, now: 100_000 + 60_000, turnsSinceCompact: 1 }), 'compact')
  // cooldown passed but the turn gap is not → skip.
  assert.equal(decideMemberContextAction({ ...base, lastCompactAt: 100_000, now: 100_000 + 60_000, turnsSinceCompact: 0 }), 'skip')
  assert.equal(decideMemberContextAction({ ...base, lastCompactAt: 100_000, now: 100_000 + 120_000, turnsSinceCompact: 0, mode: 'notify' }), 'skip')
  // both guards satisfied → act.
  assert.equal(decideMemberContextAction({ ...base, lastCompactAt: 100_000, now: 100_000 + 120_000, turnsSinceCompact: 1 }), 'compact')
  assert.equal(decideMemberContextAction({ ...base, lastCompactAt: 100_000, now: 100_000 + 120_000, turnsSinceCompact: 3, mode: 'notify' }), 'notify')
  // minTurnGap > 1 requires that many entered turns.
  assert.equal(decideMemberContextAction({ ...base, lastCompactAt: 100_000, now: 100_000 + 120_000, turnsSinceCompact: 2, minTurnGap: 3 }), 'skip')
  assert.equal(decideMemberContextAction({ ...base, lastCompactAt: 100_000, now: 100_000 + 120_000, turnsSinceCompact: 3, minTurnGap: 3 }), 'compact')
})

// ---------------------------------------------------------------------------
// g. resolveMemberContextBudget — priority, smallest-wins, unknown window
// ---------------------------------------------------------------------------

test('g. resolveMemberContextBudget priority and smallest-wins', () => {
  // nothing configured → disabled.
  assert.equal(resolveMemberContextBudget({ config: undefined }), undefined)
  assert.equal(resolveMemberContextBudget({ config: {} }), undefined)
  assert.equal(resolveMemberContextBudget({ config: { maxTokens: 0 } }), undefined)
  assert.equal(resolveMemberContextBudget({ config: { maxTokens: Number.NaN } }), undefined)
  assert.equal(resolveMemberContextBudget({ config: { maxTokens: -5 } }), undefined)
  // member override is the strictest bound → member value wins.
  assert.deepEqual(
    resolveMemberContextBudget({ memberContextMaxTokens: 100_000, config: { maxTokens: 150_000 } }),
    { tokens: 100_000, source: 'member' },
  )
  // the member's own override is ignored when it is not a positive finite number.
  assert.deepEqual(
    resolveMemberContextBudget({ memberContextMaxTokens: -1, config: { maxTokens: 150_000 } }),
    { tokens: 150_000, source: 'plugin' },
  )
  // maxTokens vs maxRatio: the smaller derived budget wins.
  assert.deepEqual(
    resolveMemberContextBudget({ config: { maxTokens: 150_000, maxRatio: 0.1 }, contextWindow: 1_000_000 }),
    { tokens: 100_000, source: 'plugin' },
  )
  assert.deepEqual(
    resolveMemberContextBudget({ config: { maxTokens: 100_000, maxRatio: 0.2 }, contextWindow: 1_000_000 }),
    { tokens: 100_000, source: 'plugin' },
  )
  // ratio only, window known → floor(window * ratio).
  assert.deepEqual(
    resolveMemberContextBudget({ config: { maxRatio: 0.15 }, contextWindow: 1_000_000 }),
    { tokens: 150_000, source: 'plugin' },
  )
  assert.deepEqual(
    resolveMemberContextBudget({ config: { maxRatio: 0.15 }, contextWindow: 999_999 }),
    { tokens: 149_999, source: 'plugin' },
  )
  // ratio only, window unknown → disabled, never a guessed window.
  assert.equal(resolveMemberContextBudget({ config: { maxRatio: 0.15 } }), undefined)
  assert.equal(resolveMemberContextBudget({ config: { maxRatio: 0.15 }, contextWindow: Number.NaN }), undefined)
  // unknown window drops ONLY the ratio candidate: explicit token budgets stay authoritative.
  assert.deepEqual(
    resolveMemberContextBudget({ memberContextMaxTokens: 100_000, config: { maxRatio: 0.15 } }),
    { tokens: 100_000, source: 'member' },
  )
  assert.deepEqual(
    resolveMemberContextBudget({ config: { maxTokens: 120_000, maxRatio: 0.15 } }),
    { tokens: 120_000, source: 'plugin' },
  )
  // member override + ratio + known window: smallest of all candidates.
  assert.deepEqual(
    resolveMemberContextBudget({ memberContextMaxTokens: 80_000, config: { maxTokens: 100_000, maxRatio: 0.15 }, contextWindow: 1_000_000 }),
    { tokens: 80_000, source: 'member' },
  )
})

// ---------------------------------------------------------------------------
// a. under budget → never compact
// ---------------------------------------------------------------------------

test('a. under-budget idle samples usage but never compacts', async () => {
  const h = createHarness({ tokens: 149_999 })
  installMemberContextWatchdog(h.deps, { memberAgentId: MEMBER, budgetTokens: 150_000, config: {} })
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 0)
  assert.deepEqual(h.records, [{ kind: 'measured', tokens: 149_999 }])
  // a second idle is still inert.
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 0)
})

test('a. idle events for other agents and non-idle statuses are ignored', async () => {
  const h = createHarness({ tokens: 500_000 })
  installMemberContextWatchdog(h.deps, { memberAgentId: MEMBER, budgetTokens: 150_000, config: {} })
  h.emit('idle', 'someone-else')
  h.emit('ready')
  await h.flush()
  assert.equal(h.measureCalls, 0)
  assert.equal(h.compactCalls.length, 0)
})

// ---------------------------------------------------------------------------
// b. over budget → compact (mode compact) / record only (mode notify)
// ---------------------------------------------------------------------------

test('b. first over-budget idle compacts immediately (cooldown/turn-gap anchor)', async () => {
  const h = createHarness({ tokens: 150_000 })
  h.setCompact(async () => ({ shadowedTokenCount: 42_000 }))
  installMemberContextWatchdog(h.deps, { memberAgentId: MEMBER, budgetTokens: 150_000, config: {} })
  // lastCompactAt === 0: acts at once even though turnsSinceCompact (0) < minTurnGap (1).
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 1)
  assert.deepEqual(h.records, [
    { kind: 'measured', tokens: 150_000 },
    { kind: 'compacted', shadowedTokens: 42_000 },
  ])
  assert.ok(h.logs.some(entry => entry.level === 'info' && /idle compaction finished/.test(entry.message)))
  // a follow-up idle inside the cooldown window must not compact again.
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 1)
})

test('b. notify mode records and logs without compacting', async () => {
  const h = createHarness({ tokens: 200_000 })
  installMemberContextWatchdog(h.deps, {
    memberAgentId: MEMBER,
    budgetTokens: 150_000,
    config: { onLimit: 'notify' },
  })
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 0)
  assert.deepEqual(h.records, [
    { kind: 'measured', tokens: 200_000 },
    { kind: 'notified', tokens: 200_000 },
  ])
  assert.ok(h.logs.some(entry => entry.level === 'info' && /reached its budget/.test(entry.message)))
})

// ---------------------------------------------------------------------------
// c. cooldownMs and minTurnGap guard repeats
// ---------------------------------------------------------------------------

test('c. minTurnGap blocks a repeat until a full turn is entered', async () => {
  const h = createHarness({ tokens: 500_000 })
  installMemberContextWatchdog(h.deps, { memberAgentId: MEMBER, budgetTokens: 150_000, config: {} })
  h.emit('idle') // first compaction at t0
  await h.flush()
  assert.equal(h.compactCalls.length, 1)
  // Cooldown has fully elapsed, but no turn was entered since the compaction.
  h.advance(60_000)
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 1)
  // Enter a turn (status → running), then idle again: the gap is satisfied.
  h.emit('running')
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 2)
})

test('c. cooldownMs blocks a repeat inside the window even across turns', async () => {
  const h = createHarness({ tokens: 500_000 })
  installMemberContextWatchdog(h.deps, { memberAgentId: MEMBER, budgetTokens: 150_000, config: {} })
  h.emit('idle') // first compaction at t0
  await h.flush()
  assert.equal(h.compactCalls.length, 1)
  h.advance(59_999)
  h.emit('running')
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 1)
  h.advance(1) // window boundary reached
  h.emit('running')
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 2)
})

// ---------------------------------------------------------------------------
// d. mode off → no action; disposer is effective
// ---------------------------------------------------------------------------

test('d. off mode never acts and the disposer stops evaluation', async () => {
  const h = createHarness({ tokens: 900_000 })
  const dispose = installMemberContextWatchdog(h.deps, {
    memberAgentId: MEMBER,
    budgetTokens: 150_000,
    config: { onLimit: 'off' },
  })
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 0)
  assert.deepEqual(h.records, [{ kind: 'measured', tokens: 900_000 }])
  // The pure layer still registers for 'off' (the host layer in
  // src/members.ts short-circuits BEFORE installing); what matters here is
  // that the returned disposer really unsubscribes.
  dispose()
  const measuredBefore = h.measureCalls
  h.emit('idle')
  await h.flush()
  assert.equal(h.measureCalls, measuredBefore)
  assert.equal(h.compactCalls.length, 0)
})

// ---------------------------------------------------------------------------
// e. busy race → absorbed silently, exactly one attempt, no retry storm
// ---------------------------------------------------------------------------

test('e. ManualCompactionError busy is swallowed, counted once, never retried eagerly', async () => {
  const h = createHarness({ tokens: 500_000 })
  h.setCompact(async () => { throw busyError() })
  installMemberContextWatchdog(h.deps, { memberAgentId: MEMBER, budgetTokens: 150_000, config: {} })
  h.emit('idle')
  await h.flush()
  // one idle evaluation → exactly one attempt: the rejection never loops in place.
  assert.equal(h.compactCalls.length, 1)
  await h.flush()
  assert.equal(h.compactCalls.length, 1)
  // absorbed: no failure record, no warn, info only.
  assert.equal(h.records.filter(entry => entry.kind === 'failed').length, 0)
  assert.equal(h.logs.filter(entry => entry.level === 'warn').length, 0)
  assert.ok(h.logs.some(entry => entry.level === 'info' && /busy/.test(entry.message)))
  // plan-02 acceptance "下一轮空闲自动补上": a later idle round re-evaluates
  // from scratch (lastCompactAt stays 0 because nothing was compacted, so the
  // never-compacted anchor still applies — this is intended, not a retry storm:
  // at most one attempt per idle event).
  h.emit('running')
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 2)
  await h.flush()
  assert.equal(h.compactCalls.length, 2)
  assert.equal(h.records.filter(entry => entry.kind === 'failed').length, 0)
  assert.equal(h.logs.filter(entry => entry.level === 'warn').length, 0)
})

// ---------------------------------------------------------------------------
// f. real failures → warn + failed record, never thrown; null is not a failure
// ---------------------------------------------------------------------------

test('f. unexpected compaction errors warn and are recorded without throwing', async () => {
  const h = createHarness({ tokens: 500_000 })
  h.setCompact(async () => { throw new Error('session store exploded') })
  installMemberContextWatchdog(h.deps, { memberAgentId: MEMBER, budgetTokens: 150_000, config: {} })
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 1)
  const failed = h.records.filter(entry => entry.kind === 'failed')
  assert.equal(failed.length, 1)
  assert.match(failed[0].reason, /session store exploded/)
  assert.ok(h.logs.some(entry => entry.level === 'warn' && /context compaction failed/.test(entry.message)))
})

test('f. compact() resolving null is a normal no-op, not a failure, and stays eligible', async () => {
  const h = createHarness({ tokens: 500_000 })
  h.setCompact(async () => null)
  installMemberContextWatchdog(h.deps, { memberAgentId: MEMBER, budgetTokens: 150_000, config: {} })
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 1)
  assert.deepEqual(h.records, [{ kind: 'measured', tokens: 500_000 }])
  assert.equal(h.logs.filter(entry => entry.level === 'warn').length, 0)
  // lastCompactAt was NOT advanced: as soon as the guards pass, compaction is
  // attempted again from the next idle (no eager in-place retry).
  h.advance(60_000)
  h.emit('running')
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 2)
  assert.equal(h.records.filter(entry => entry.kind === 'failed').length, 0)
})

// ---------------------------------------------------------------------------
// supporting behavior: unmeasurable meter, single-flight, record() failures
// ---------------------------------------------------------------------------

test('meter unavailable → warn once, skip the budget check, keep sampling cheap', async () => {
  const h = createHarness({ tokens: Number.NaN })
  installMemberContextWatchdog(h.deps, { memberAgentId: MEMBER, budgetTokens: 150_000, config: {} })
  h.emit('idle')
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 0)
  assert.deepEqual(h.records, [])
  const warns = h.logs.filter(entry => entry.level === 'warn' && /no token measurement/.test(entry.message))
  assert.equal(warns.length, 1)
})

test('single-flight: a second idle during an in-flight compaction is ignored', async () => {
  const h = createHarness({ tokens: 500_000 })
  let resolveCompact
  h.setCompact(() => new Promise(resolve => { resolveCompact = resolve }))
  installMemberContextWatchdog(h.deps, { memberAgentId: MEMBER, budgetTokens: 150_000, config: {} })
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 1)
  const measuredDuringFlight = h.measureCalls
  h.emit('idle') // must be dropped while the first compaction is pending
  assert.equal(h.compactCalls.length, 1)
  assert.equal(h.measureCalls, measuredDuringFlight)
  resolveCompact({ shadowedTokenCount: 1 })
  await h.flush()
  assert.ok(h.records.some(entry => entry.kind === 'compacted'))
})

test('a throwing record() is contained and only logged', async () => {
  const h = createHarness({ tokens: 500_000 })
  h.deps.record = () => { throw new Error('team.json locked') }
  const thrown = []
  process.on('uncaughtException', err => thrown.push(err))
  installMemberContextWatchdog(h.deps, { memberAgentId: MEMBER, budgetTokens: 150_000, config: {} })
  h.emit('idle')
  await h.flush()
  assert.equal(h.compactCalls.length, 1)
  assert.ok(h.logs.some(entry => entry.level === 'warn' && /bookkeeping failed/.test(entry.message)))
  process.removeAllListeners('uncaughtException')
  assert.deepEqual(thrown, [])
})


// ===========================================================================
// 02j — follow-up patch batch: prompt text, /plan route forwarding, client
// wiring. Route cases drive the REAL built route handler end to end (HTTP
// body in, team.json on disk out); client cases SSR-render the REAL built
// StagingPlanEditor with a loader that only (a) stubs CSS imports, (b) stubs
// the UI primitives Menu, and (c) flips boolean useState initials so the
// member card body renders during SSR.
// ===========================================================================

test('02j-a. captain prompt names the budget knob with exact wording and no plan tag', async () => {
  const text = usageSectionText('agent_teams_create, agent_teams_status')
  assert.match(text, /A member may also carry its own context budget/)
  assert.match(text, /context_max_tokens on a plan member row, agent_teams_add_member, or a staged edit_plan update_member/)
  assert.match(text, /null to clear back to the plugin default/)
  assert.match(text, /resolve to the smaller one — it can only tighten, never loosen/)
  assert.match(text, /when the deployment configures no memberContext default, the member-level value alone applies/)
  assert.ok(!text.includes('(plan 02)'), 'usageSectionText must not leak the private plan tag')
  // The shipped model-visible artifacts stay clean too (prompt text ships in
  // lib/index.js, the three tool descriptions in lib/tools.js).
  for (const file of ['../lib/index.js', '../lib/tools.js']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8')
    assert.ok(!source.includes('(plan 02)'), `${file} still mentions (plan 02)`)
  }
})

/** Mount the real plugin (apply) against stub host services; return the plan route over real HTTP. */
async function mountPlanRouteHarness() {
  const workspace = await mkdtemp(join(tmpdir(), 'mcb-plan-route-'))
  const definitions = new Map()
  const liveAgents = new Map()
  const listeners = new Map()
  const routes = new Map()
  const webServer = {
    register(route) {
      assert(!routes.has(route.path), `duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const captain = {
    id: 'captain-session',
    status: 'idle',
    options: { provider: 'fake', model: 'fake-model' },
    session: {
      header: { cwd: workspace },
      append() {},
      requestHeader() { return { config: { provider: 'fake', model: 'fake-model' } } },
      ownEvents() { return [] },
    },
    ctx: { effect(setup) { return setup() } },
    followups: [],
    steers: [],
    injections: [],
    followup(message) { this.followups.push(message) },
    steer(message) { this.steers.push(message) },
    inject(message) { this.injections.push(message) },
    cancel() {},
    whenIdle() { return Promise.resolve() },
  }
  liveAgents.set(captain.id, captain)
  const ctx = {
    effect(setup) { return setup() },
    get(key) {
      if (key === 'webServer' || key === 'httpServer') return webServer
      if (key === 'workspaceRegistry' || key === 'workspace') return { list() { return [] } }
      // Auth gate stub: this harness proves the handler body, not the browser
      // cookie exchange (covered by scripts/web-routes-verify.mjs).
      if (key === 'connection') return { requestRejection() { return undefined } }
      return undefined
    },
    on(name, listener) {
      const current = listeners.get(name) ?? []
      current.push(listener)
      listeners.set(name, current)
      return () => listeners.set(name, current.filter(candidate => candidate !== listener))
    },
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
      async startContinuable() { throw new Error('staged plans never spawn in this harness') },
      async listChildren() { return [] },
      async listDescendants() { return [] },
      async followup() { return 'message-1' },
      interrupt() {},
      async drainContinuableChildren() {},
    },
    systemPrompt: { section() {} },
    logger: { debug() {}, info() {}, warn() {} },
  }
  apply(ctx, {
    stateDir: '.agent-teams',
    memberProvider: 'spawn',
    slashCommand: false,
    profiles: {
      'budget-demo': {
        description: 'route verification profile',
        members: [
          { name: 'analyst', role: 'analysis', model: 'fake-model' },
          { name: 'writer', role: 'writing', model: 'fake-model', context_max_tokens: 77777 },
        ],
        tasks: [],
      },
    },
  })
  const route = routes.get('/plugins/dsh-agent-teams/plan')
  assert(route, 'plan route must register when the web server is available')
  const server = createServer((req, res) => {
    Promise.resolve(route.handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (name, args) => {
    const definition = definitions.get(name)
    if (definition === undefined) throw new Error(`missing tool ${name}`)
    return definition.execute(args, { agent: captain, signal: new AbortController().signal })
  }
  const postPlan = async (payload) => {
    const response = await fetch(base + '/plugins/dsh-agent-teams/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: captain.id, teamId: 'route-demo', ...payload }),
    })
    return { status: response.status, body: await response.json() }
  }
  return {
    workspace,
    ctx,
    stateRoot: join(workspace, '.agent-teams'),
    call, postPlan,
    team: () => readTeam(join(workspace, '.agent-teams'), 'route-demo'),
    async cleanup() {
      server.close()
      await rm(workspace, { recursive: true, force: true })
    },
  }
}

test('02j-b. /plan update_member routes context_max_tokens onto the durable member record', async (t) => {
  const harness = await mountPlanRouteHarness()
  t.after(harness.cleanup)
  const created = await harness.call('agent_teams_create', {
    name: 'Route Demo',
    description: 'verify the budget route',
    profile: 'budget-demo',
    approval: 'required',
  })
  assert(created, 'staged team creation must succeed')

  // Fixture sanity: the profile-row budget landed on the durable record.
  const initial = await harness.team()
  assert(initial?.phase === 'staged')
  assert.equal(initial.members.find(member => member.name === 'writer')?.contextMaxTokens, 77777)
  assert.equal('contextMaxTokens' in (initial.members.find(member => member.name === 'analyst') ?? {}), false)

  // 12345 → durable record holds 12345 (overwrites the profile preset).
  const set = await harness.postPlan({
    action: 'update_member', memberName: 'writer', provider: 'fake', model: 'fake-model',
    context_max_tokens: 12345,
  })
  assert.equal(set.status, 200, JSON.stringify(set.body))
  assert.equal((await harness.team()).members.find(member => member.name === 'writer')?.contextMaxTokens, 12345)

  // null → cleared back to default (the key disappears from team.json).
  const cleared = await harness.postPlan({
    action: 'update_member', memberName: 'writer', provider: 'fake', model: 'fake-model',
    context_max_tokens: null,
  })
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body))
  const afterClear = await harness.team()
  assert.equal('contextMaxTokens' in (afterClear.members.find(member => member.name === 'writer') ?? {}), false)

  // Invalid values fail the request AND leave the durable record untouched.
  for (const bad of [0, -5, 12.5, '12345']) {
    const rejected = await harness.postPlan({
      action: 'update_member', memberName: 'writer', provider: 'fake', model: 'fake-model',
      context_max_tokens: bad,
    })
    assert.equal(rejected.status, 409, `value ${JSON.stringify(bad)} must be rejected`)
    assert.match(rejected.body.error, /context_max_tokens must be a positive integer or null/)
    const current = await harness.team()
    assert.equal('contextMaxTokens' in (current.members.find(member => member.name === 'writer') ?? {}), false,
      `value ${JSON.stringify(bad)} must not mutate team.json`)
  }

  // A payload WITHOUT the key never touches the current value.
  const first = await harness.postPlan({
    action: 'update_member', memberName: 'analyst', provider: 'fake', model: 'fake-model',
    context_max_tokens: 54321,
  })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal((await harness.team()).members.find(member => member.name === 'analyst')?.contextMaxTokens, 54321)
  const second = await harness.postPlan({
    action: 'update_member', memberName: 'analyst', provider: 'fake', model: 'fake-model',
    role: 'lead analysis',
  })
  assert.equal(second.status, 200, JSON.stringify(second.body))
  const analyst = (await harness.team()).members.find(member => member.name === 'analyst')
  assert.equal(analyst?.contextMaxTokens, 54321, 'omitting the key must keep the stored budget')
  assert.equal(analyst?.role, 'lead analysis', 'sibling fields still apply')
})

test('02j-c/d. staged editor renders the real budget input; shipped payload mapping keeps the three branches', async (t) => {
  // --- client rendering: SSR the real built StagingPlanEditor ---------------
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const shimDir = join(repoRoot, 'node_modules', `.mcb-shims-${process.pid}`)
  await rm(shimDir, { recursive: true, force: true })
  await mkdir(shimDir, { recursive: true })
  await writeFile(join(shimDir, 'react-open.mjs'), [
    `import * as real from 'react'`,
    `export * from 'react'`,
    `export function useState(initial) { return real.useState(initial === false ? true : initial) }`,
    `export function useSyncExternalStore(_subscribe, getSnapshot, getServerSnapshot) { return (getServerSnapshot ?? getSnapshot)() }`,
    '',
  ].join('\n'))
  await writeFile(join(shimDir, 'css-proxy.mjs'), `export default new Proxy({}, { get: (_target, key) => String(key) })\n`)
  await writeFile(join(shimDir, 'primitives-stub.mjs'), `export function Menu() { return null }\nexport function Modal() { return null }\n`)
  const toUrl = (name) => pathToFileURL(join(shimDir, name)).href
  await writeFile(join(shimDir, 'loader.mjs'), `
const REACT = '${toUrl('react-open.mjs')}'
const CSS = '${toUrl('css-proxy.mjs')}'
const PRIMITIVES = '${toUrl('primitives-stub.mjs')}'
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.module.css')) return { url: CSS, shortCircuit: true }
  const parent = context.parentURL ?? ''
  if (parent.includes('StagingPlanEditor.js') || parent.includes('ActivityPanel.js')) {
    if (specifier === 'react') return { url: REACT, shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { url: PRIMITIVES, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
`)
  register(pathToFileURL(join(shimDir, 'loader.mjs')))
  t.after(async () => { await rm(shimDir, { recursive: true, force: true }) })

  const [{ renderToStaticMarkup }, editorModule, locales, React] = await Promise.all([
    import('react-dom/server'),
    import('../lib/client/StagingPlanEditor.js'),
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
  const memberBase = {
    id: '', role: 'analysis', provider: 'fake', model: 'fake-model', reasoningEffort: '',
    executionPrompt: '', activity: 'idle', progress: 0, done: 0, total: 0, currentTask: '', unread: 0,
  }
  const team = {
    workspace: '/ws', teamId: 'route-demo', name: 'Route Demo', description: '',
    captainSessionId: 'captain-session', phase: 'staged', planReviewState: 'awaiting_review',
    members: [
      // Post-02l wire shape: the DECLARED budget arrives as contextBudget; the
      // runtime usage sample (context) never feeds the editor prefill.
      { ...memberBase, name: 'analyst', context: { tokens: 90000, limit: 150000, ratio: 0.6, compactions: 2, measuredAt: 1729000000000 }, contextBudget: 150000 },
      { ...memberBase, name: 'writer', role: 'writing' },
    ],
    tasks: [], messageCount: 0, captainInbox: [],
  }
  const modelDirectory = {
    store: {
      subscribe() { return () => undefined },
      getSnapshot() { return { status: 'idle', groups: [], failures: [] } },
      getServerSnapshot() { return { status: 'idle', groups: [], failures: [] } },
    },
    load: async () => undefined,
  }
  const render = (t) => renderToStaticMarkup(React.createElement(editorModule.StagingPlanEditor, {
    team, modelDirectory, onContinuePlanning() {}, onDiscarded() {}, t,
  }))

  const zhHtml = render(translate(locales.zh))
  assert.match(zhHtml, /name="contextMaxTokens"/, 'budget input renders')
  assert.match(zhHtml, /type="number"/)
  assert.match(zhHtml, /min="1"/)
  assert.match(zhHtml, /上下文预算/)
  assert.match(zhHtml, /留空继承插件默认/)
  const analystCard = zhHtml.split('data-plan-member="analyst"')[1] ?? ''
  const writerCard = zhHtml.split('data-plan-member="writer"')[1] ?? ''
  assert.match(analystCard, /value="150000"/, 'declared budget seeds the input (member with budget)')
  assert.match(writerCard, /value=""/, 'blank input for a member without a budget')
  assert.doesNotMatch(zhHtml, /data-budget-invalid=/, 'no invalid marker before any edit')

  const enHtml = render(translate(locales.en))
  assert.match(enHtml, /Context budget/)
  assert.match(enHtml, /name="contextMaxTokens"/)

  // --- payload shape: the shipped artifact carries the three branches -------
  // blank -> explicit null (clear semantics: omitting would silently keep an
  // old budget after the user clears the field), valid -> the number, invalid
  // -> the key is omitted and the form errors out before submitting.
  const built = await readFile(new URL('../lib/client/StagingPlanEditor.js', import.meta.url), 'utf8')
  assert.match(built, /context_max_tokens: null/, 'blank input clears (explicit null)')
  assert.match(built, /context_max_tokens: parsed/, 'valid integer is sent')
  assert.match(built, /if \(!Number\.isSafeInteger\(parsed\) \|\| parsed <= 0\)\s+return \{\}/, 'invalid values are not sent')
  assert.match(built, /...budgetPayload()/, 'update_member payload spreads the budget field')
  assert.ok(built.includes('/plugins/dsh-agent-teams/plan'), 'mutations post to the plan route')
})


// ===========================================================================
// 02m — re-verify the 02l prefill fix: the editor must prefill from the
// DECLARED budget (host projection contextBudget), never from the runtime
// usage sample, so a model-only save on a staged member no longer clears an
// already-declared budget. Fixture shape is the real staged shape: the
// member record carries contextMaxTokens but no contextUsage/context sample.
// ===========================================================================

test('02m. staged prefill uses the declared budget (real staged shape); badges stay measurement-only', async (t) => {
  const [{ renderToStaticMarkup }, editorModule, panelModule, locales, React] = await Promise.all([
    import('react-dom/server'),
    import('../lib/client/StagingPlanEditor.js'),
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
  const memberBase = {
    id: '', role: 'analysis', provider: 'fake', model: 'fake-model', reasoningEffort: '',
    executionPrompt: '', activity: 'idle', progress: 0, done: 0, total: 0, currentTask: '', unread: 0,
  }
  const modelDirectory = {
    store: {
      subscribe() { return () => undefined },
      getSnapshot() { return { status: 'idle', groups: [], failures: [] } },
      getServerSnapshot() { return { status: 'idle', groups: [], failures: [] } },
    },
    load: async () => undefined,
  }

  // -- matrix rows 1 & 4a: prefill from the declared budget ---------------
  // Real staged shape: contextBudget present, NO context/contextUsage field.
  const stagedTeam = {
    workspace: '/ws', teamId: 'staged-demo', name: 'Staged Demo', description: '',
    captainSessionId: 'captain-session', phase: 'staged', planReviewState: 'awaiting_review',
    members: [
      { ...memberBase, name: 'writer', role: 'writing', contextBudget: 12345 },
      { ...memberBase, name: 'analyst' },
    ],
    tasks: [], messageCount: 0, captainInbox: [],
  }
  const editorHtml = renderToStaticMarkup(React.createElement(editorModule.StagingPlanEditor, {
    team: stagedTeam, modelDirectory, onContinuePlanning() {}, onDiscarded() {}, t: translate(locales.zh),
  }))
  const writerCard = editorHtml.split('data-plan-member="writer"')[1] ?? ''
  const analystCard = editorHtml.split('data-plan-member="analyst"')[1] ?? ''
  assert.match(writerCard, /value="12345"/, 'declared budget prefills the input (staged shape: no usage sample)')
  assert.match(analystCard, /value=""/, 'member without a declared budget starts blank')

  // -- matrix rows 2 & 3: the submit path keeps the prefilled value -------
  // Two-link evidence (no DOM in Node): the SSR above proves the REAL artifact
  // seeds budgetInput with "12345"; the shipped payload builder below proves a
  // non-blank valid input rides along every update_member save (model-only
  // included) and a blanked input sends the explicit null clear.
  const builtEditor = await readFile(new URL('../lib/client/StagingPlanEditor.js', import.meta.url), 'utf8')
  assert.match(builtEditor, /context_max_tokens: parsed/, 'non-blank valid budget rides a model-only save')
  assert.match(builtEditor, /context_max_tokens: null/, 'blanking the input sends the explicit clear')
  assert.match(builtEditor, /provider: selection.provider[\s\S]{0,300}?\.\.\.budgetPayload\(\)/,
    'update_member spreads the budget alongside the model selection')

  // -- matrix row 4b: null on a never-configured member is a harmless no-op
  const harness = await mountPlanRouteHarness()
  t.after(harness.cleanup)
  await harness.call('agent_teams_create', {
    name: 'Route Demo', description: 'verify null on keyless member', profile: 'budget-demo', approval: 'required',
  })
  const nulled = await harness.postPlan({
    action: 'update_member', memberName: 'analyst', provider: 'fake', model: 'fake-model',
    context_max_tokens: null,
  })
  assert.equal(nulled.status, 200, JSON.stringify(nulled.body))
  assert.equal('contextMaxTokens' in ((await harness.team()).members.find(member => member.name === 'analyst') ?? {}), false,
    'explicit null on a keyless member stays a no-op')

  // -- host projection evidence: contextBudget comes from the DECLARED field
  const { collectTeamsActivity } = await import('../lib/snapshot.js')
  const roots = [{ workspace: 'Route Demo', workspacePath: undefined, stateRoot: harness.stateRoot }]
  const snapshots = await collectTeamsActivity(harness.ctx, roots)
  const projected = snapshots[0].members.find(member => member.name === 'writer')
  assert.equal(projected.contextBudget, 77777, 'host projects the declared budget for a staged member')
  assert.equal('context' in projected, false, 'a member without a usage sample gets no fake context block')

  // -- runtime badges unchanged; declared-only budget never renders badges
  const runningTeam = {
    workspace: '/ws', teamId: 'running-demo', name: 'Running Demo', description: '',
    captainSessionId: 'captain-session', phase: 'running',
    members: [
      { ...memberBase, name: 'live', context: { tokens: 90000, limit: 150000, ratio: 0.6, compactions: 2, measuredAt: 1729000000000 } },
      { ...memberBase, name: 'stagedish', role: 'writing', contextBudget: 12345 },
    ],
    tasks: [], messageCount: 0, captainInbox: [],
  }
  const panelHtml = renderToStaticMarkup(React.createElement(panelModule.TeamSection, {
    team: runningTeam, modelDirectory, onContinuePlanning() {}, onDiscarded() {}, onNavigate() {},
    t: translate(locales.zh),
  }))
  assert.match(panelHtml, /data-member-context="90k \/ 150k"/, 'usage badge still renders from the sample')
  assert.match(panelHtml, /data-member-compactions="2"/, 'compaction badge still renders from the sample')
  assert.equal((panelHtml.match(/data-member-context=/g) ?? []).length, 1, 'declared-only budget must not mint a usage badge')
  assert.equal((panelHtml.match(/data-member-compactions=/g) ?? []).length, 1, 'declared-only budget must not mint a compaction badge')
})
