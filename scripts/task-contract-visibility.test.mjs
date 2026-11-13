#!/usr/bin/env node
/**
 * Regression tests for two gaps in the quality loop's information channel:
 *
 * 1. `agent_teams_status` used to expose only a task row (id/status/owner/
 *    output), never the contract a completion gate will read. A captain could
 *    not tell whether acceptance/verify/inScope were complete without opening
 *    `.agent-teams/<team>/team.json` — and the recorded incident (t28) shows
 *    what happens when a contract is wrong but invisible.
 * 2. `amend_task` persisted the new contract and emitted an event, but never
 *    told the member already executing the task. The member finished against
 *    the dispatched snapshot, so the amendment arrived one round too late.
 *
 * The fix is a read-only `status({ task_id })` detail view (contract, findings,
 * amendment ledger, evidence; never consumes the inbox) and a durable
 * contract-change notice bound to the executing attempt after every amendment.
 *
 * Run: node --test scripts/task-contract-visibility.test.mjs
 * Imports the BUILT bundle (../lib/**.js) - run `pnpm build` first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAgentTeamsTools } from '../lib/tools.js'
import { appendMailbox, createMessage, createTeamDir, readUnreadMailbox } from '../lib/state.js'

const MEMBER = { id: 'child-impl', name: 'impl', role: 'implementer', joinedAt: 1, status: 'idle' }

function implTask(extra = {}) {
  return {
    id: 't1', subject: 'write the thing', status: 'in_progress', dependencies: [],
    createdAt: 0, updatedAt: 0, attempt: 1, attemptId: 'att-1',
    kind: 'implementation', assignee: 'impl',
    objective: 'Write the thing',
    inScope: ['src/'], outOfScope: ['docs/'],
    acceptance: ['the file says ok', 'the test passes'],
    verify: ['node --test scripts/example.test.mjs'],
    findings: [{
      id: 'SEC-1', severity: 'high', file: 'src/a.ts', line: 7,
      problem: 'the token is logged', requiredFix: 'stop logging the token', resolved: false,
    }],
    revisions: [{
      at: 1000, by: 'captain', reason: 'the first scope was wrong',
      fields: ['inScope'], previous: { inScope: ['docs/'] },
    }],
    ...extra,
  }
}

/** Fake plugin ctx: records tool registrations, exposes no live services. */
function makeFakeCtx() {
  const registered = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    agents: { get: () => undefined },
    subagents: {
      async followup() { return 'msg-stub' },
      registerContinuableSetup() { return () => undefined },
    },
    commands: { list: () => [], execute: () => undefined },
    llm: { listProviders: () => [], listModels: async () => [], resolveCallConfig: async (config) => config },
    systemPrompt: { section: () => () => undefined, getSectionOrder: () => 100 },
    tools: { register: (definition) => registered.set(definition.name, definition) },
    get: () => undefined,
    effect(factory) { const result = factory(); return typeof result === 'function' ? result : () => undefined },
    on() { return () => undefined },
  }
  return { ctx, registered }
}

async function setup(tasks) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-contract-view-'))
  const stateRoot = join(workspace, '.agent-teams')
  await mkdir(stateRoot, { recursive: true })
  await createTeamDir(stateRoot, {
    name: 'demo', id: 'demo', captainSessionId: 'captain-1', createdAt: 1, taskSeq: 9,
    members: [{ ...MEMBER }], tasks,
  })
  const { ctx, registered } = makeFakeCtx()
  registerAgentTeamsTools(ctx, {
    stateDir: '.agent-teams', memberProvider: 'spawn', maxMembers: 8,
    toolPolicies: {}, profiles: {},
  })
  const exec = {
    agent: { id: 'captain-1', session: { id: 'captain-1', header: { cwd: workspace } } },
    signal: new AbortController().signal,
  }
  return {
    workspace, stateRoot, registered, exec,
    async cleanup() { await rm(workspace, { recursive: true, force: true }) },
  }
}

function tool(registered, name) {
  const definition = registered.get(name)
  assert.ok(definition, `tool ${name} was not registered`)
  return definition
}

test('status({ task_id }) returns the full contract, findings, amendments and evidence', async () => {
  const suite = await setup([implTask()])
  try {
    const value = await tool(suite.registered, 'agent_teams_status').execute({ task_id: 't1' }, suite.exec)
    assert.equal(value.team_name, 'demo')
    assert.equal(value.task.id, 't1')
    assert.equal(value.task.kind, 'implementation')
    assert.equal(value.task.attempt_id, 'att-1')
    assert.equal(value.task.objective, 'Write the thing')
    assert.deepEqual(value.task.acceptance, ['the file says ok', 'the test passes'])
    assert.deepEqual(value.task.verify, ['node --test scripts/example.test.mjs'])
    assert.deepEqual(value.task.in_scope, ['src/'])
    assert.deepEqual(value.task.out_of_scope, ['docs/'])
    assert.equal(value.task.findings.length, 1)
    assert.equal(value.task.findings[0].required_fix, 'stop logging the token')
    assert.equal(value.task.findings_open, 1)
    assert.equal(value.task.revisions.length, 1)
    assert.equal(value.task.revisions[0].by, 'captain')
    assert.deepEqual(JSON.parse(value.task.revisions[0].previous), { inScope: ['docs/'] })
    assert.deepEqual(value.task.changed_paths, [])
  } finally { await suite.cleanup() }
})

test('status({ task_id }) is a read: it does not acknowledge unread mail', async () => {
  const suite = await setup([implTask()])
  try {
    await appendMailbox(suite.stateRoot, 'demo', 'captain', createMessage('impl', 'captain', 'still working'))
    const value = await tool(suite.registered, 'agent_teams_status').execute({ task_id: 't1' }, suite.exec)
    assert.equal(value.task.id, 't1')
    const unread = await readUnreadMailbox(suite.stateRoot, 'demo', 'captain')
    assert.equal(unread.length, 1, 'the detail view must not consume the inbox the caller has not read')
    assert.equal(unread[0].content, 'still working')
  } finally { await suite.cleanup() }
})

test('the compact status snapshot stays compact and still lists tasks', async () => {
  const suite = await setup([implTask()])
  try {
    const value = await tool(suite.registered, 'agent_teams_status').execute({}, suite.exec)
    assert.equal(value.task, undefined, 'the detail object is opt-in only')
    assert.equal(value.tasks.length, 1)
    assert.equal(value.tasks[0].id, 't1')
    assert.equal(value.tasks[0].objective, undefined, 'the compact task row does not carry the contract')
  } finally { await suite.cleanup() }
})

test('an unknown task id fails loudly instead of returning an empty detail', async () => {
  const suite = await setup([implTask()])
  try {
    await assert.rejects(
      tool(suite.registered, 'agent_teams_status').execute({ task_id: 'nope' }, suite.exec),
      /no task "nope" in team "demo"/,
    )
  } finally { await suite.cleanup() }
})

test('amending an executing task queues a contract-change notice bound to its attempt', async () => {
  const suite = await setup([implTask()])
  try {
    const value = await tool(suite.registered, 'agent_teams_amend_task').execute({
      task_id: 't1', objective: 'Write the thing, minus the token log', reason: 'the objective hid the security fix',
    }, suite.exec)
    assert.equal(value.task_id, 't1')
    assert.match(value.contract, /minus the token log/)
    assert.equal(value.relay, 'mailbox', 'no live lead is available in this fixture, so the notice stays durable')

    const unread = await readUnreadMailbox(suite.stateRoot, 'demo', 'impl')
    assert.equal(unread.length, 1)
    const notice = unread[0]
    assert.equal(notice.from, 'captain')
    assert.equal(notice.to, 'impl')
    assert.equal(notice.taskId, 't1')
    assert.equal(notice.attemptId, 'att-1')
    assert.match(notice.content, /contract you were dispatched with has changed/)
    assert.match(notice.content, /the objective hid the security fix/)
    assert.match(notice.content, /agent_teams_status\(\{ task_id: "t1" \}\)/)

    const detail = await tool(suite.registered, 'agent_teams_status').execute({ task_id: 't1' }, suite.exec)
    assert.equal(detail.task.revisions.length, 2)
    assert.equal(detail.task.objective, 'Write the thing, minus the token log')
  } finally { await suite.cleanup() }
})

test('amending a task nobody has claimed sends no notice (dispatch will read the new contract)', async () => {
  const suite = await setup([implTask({ status: 'pending', assignee: 'impl', attempt: 0, attemptId: undefined })])
  try {
    const value = await tool(suite.registered, 'agent_teams_amend_task').execute({
      task_id: 't1', acceptance: ['the new criterion'], reason: 'the old criterion was untestable',
    }, suite.exec)
    assert.equal(value.relay, 'skipped')
    const unread = await readUnreadMailbox(suite.stateRoot, 'demo', 'impl')
    assert.equal(unread.length, 0)
  } finally { await suite.cleanup() }
})
