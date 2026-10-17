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
import {
  decideMemberContextAction,
  installMemberContextWatchdog,
  resolveMemberContextBudget,
} from '../lib/member-context.js'

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
