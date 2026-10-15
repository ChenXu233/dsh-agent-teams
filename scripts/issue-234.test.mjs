// Issue #234 regression: a gateway-materialized empty `plan` shell must count
// as "not provided".
//
// Some model gateways materialize optional object parameters instead of
// omitting them, so a call that only passed `profile: "dev-team"` arrives
// carrying `plan: { members: [], tasks: [] }`, or one placeholder member whose
// every field is blank — both shapes were observed on one installation with
// such a gateway. `agent_teams_create` used to treat that shell as an inline
// plan, so every profile-only call died on `choose either a configured profile
// or an inline plan`.
//
// These cases drive the REAL tool execution path: a real Cordis Context +
// `ToolRuntime` dispatch the registered `agent_teams_create`, so the declared
// parameter schema validates every call exactly like production, while the
// surrounding host services (llm routing, subagent runtime) stay minimal fakes.
// Positive cases assert the staged `team.json` really landed with the profile
// roster; the mutual-exclusion guard and the inline-plan branch are pinned too,
// so the normalization cannot silently widen the "not provided" bucket.
//
// Semantic choice (deliberate): this mirrors issue #99's "a materialized blank
// equals not provided" invariant. A blank profile plus an empty shell therefore
// falls into the existing plain empty-team branch instead of gaining a new
// error message.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { registerAgentTeamsTools } from '../lib/tools.js'
import { sanitizeKey } from '../lib/state.js'

const requireTools = createRequire(import.meta.resolve('@deepseek-ai/dsh-tools'))
const { createScope } = await import(pathToFileURL(requireTools.resolve('@deepseek-ai/dsh-scope')).href)

const PROFILE = 'issue-234-team'
const PROFILES = {
  [PROFILE]: {
    members: [{ name: 'fixer', role: 'engineer' }],
    tasks: [{ id: 'seed-1', subject: 'apply the fix', assignee: 'fixer' }],
  },
}

/** The two shells real gateways produced, plus a genuine inline plan. */
const EMPTY_ARRAY_SHELL = { members: [], tasks: [] }
const PLACEHOLDER_MEMBER_SHELL = {
  members: [{ name: '', role: '', provider: '', model: '', reasoning_effort: '' }],
  tasks: [],
}
const REAL_PLAN = {
  members: [{ name: 'scout', role: 'analyst' }],
  tasks: [{ id: 't1', subject: 'survey the roster', assignee: 'scout' }],
}

/**
 * Mount the real tool runtime over the shipped `agent_teams_create`.
 * @returns the dispatch helper plus real on-disk team readers.
 */
async function mount() {
  const workspace = await mkdtemp(join(tmpdir(), 'agentteams-234-'))
  const host = new Context()
  const prompt = host.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await prompt.await()
  const runtime = host.plugin(ToolRuntime, { mode: 'native' })
  await runtime.await()
  const definitions = []
  const agents = []
  const noop = () => {}
  registerAgentTeamsTools({
    on: () => noop,
    effect: setup => setup(),
    logger: { warn: noop, debug: noop },
    tools: { register: definition => definitions.push(definition) },
    agents: { get: id => agents.find(agent => agent.id === id) },
    llm: { async resolveCallConfig(config) { return config }, async listModels() { return [] } },
    subagents: { followup: async () => {}, registerContinuableSetup: () => noop },
  }, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 1, maxMembers: 8, profiles: PROFILES })
  let owned
  const business = host.plugin({
    inject: ['tools'],
    apply(ctx) {
      owned = ctx
      for (const definition of definitions) ctx.tools.register(definition)
      ctx.provide('agents', { list: () => agents })
    },
  })
  await business.await()
  let seq = 0
  const createCaptain = id => {
    const events = []
    const agent = {
      id,
      status: 'idle',
      options: { provider: 'fake', model: 'fake-model' },
      session: {
        id,
        header: { cwd: workspace, seedLength: 0 },
        events,
        inheritedEventCount: 0,
        get seq() { return events.length },
        snapshotEvents: () => events.slice(),
        eventAt: index => events[index],
        requestHeader: () => ({ config: { provider: 'fake', model: 'fake-model' } }),
        append(type, data) { const event = { seq: events.length, type, data }; events.push(event); return event },
      },
    }
    const scope = createScope(owned, agent)
    agent.ctx = scope.ctx
    agents.push(agent)
    return agent
  }
  const execute = (agent, args) => host.tools.execute({
    name: 'agent_teams_create',
    arguments: args,
    callId: `issue-234-${++seq}`,
    agent,
    signal: new AbortController().signal,
  })
  const teamPath = teamId => join(workspace, '.agent-teams', teamId, 'team.json')
  const readCreated = async teamId => JSON.parse(await readFile(teamPath(teamId), 'utf8'))
  const exists = async teamId => {
    try {
      await readFile(teamPath(teamId), 'utf8')
      return true
    } catch {
      return false
    }
  }
  return { createCaptain, execute, readCreated, exists, dispose: () => rm(workspace, { recursive: true, force: true }) }
}

for (const [label, plan] of [['an empty-array shell', EMPTY_ARRAY_SHELL], ['a placeholder-member shell', PLACEHOLDER_MEMBER_SHELL]]) {
  await test(`a profile with ${label} creates the configured profile team (issue #234)`, async () => {
    const fixture = await mount()
    try {
      const captain = fixture.createCaptain(`captain-shell-${sanitizeKey(label)}`)
      const result = await fixture.execute(captain, {
        name: `Shell ${sanitizeKey(label)}`,
        description: 'gateway materialized an optional plan parameter',
        approval: 'required',
        profile: PROFILE,
        plan,
      })
      assert.equal(result.isError, false, JSON.stringify(result))
      assert.doesNotMatch(JSON.stringify(result), /choose either a configured profile or an inline plan/)
      assert.equal(result.value.profile, PROFILE)
      // The profile branch really ran: the configured roster is on disk, staged.
      const team = await fixture.readCreated(result.value.team_id)
      assert.equal(team.phase, 'staged')
      assert.equal(team.profile.name, PROFILE)
      assert.deepEqual(team.members.map(member => member.name), ['fixer'])
      assert.deepEqual(team.tasks.map(task => task.profileSeedId), ['seed-1'])
    } finally {
      await fixture.dispose()
    }
  })
}

await test('a profile with a real inline plan still trips the mutual-exclusion guard (issue #234)', async () => {
  const fixture = await mount()
  try {
    const captain = fixture.createCaptain('captain-real-plan-with-profile')
    const result = await fixture.execute(captain, {
      name: 'Real Plan With Profile',
      approval: 'required',
      profile: PROFILE,
      plan: REAL_PLAN,
    })
    assert.equal(result.isError, true, JSON.stringify(result))
    assert.match(JSON.stringify(result), /choose either a configured profile or an inline plan/)
    assert.equal(await fixture.exists(sanitizeKey('Real Plan With Profile')), false)
  } finally {
    await fixture.dispose()
  }
})

await test('a substantive member plus empty tasks is a real plan, not a shell (issue #234)', async () => {
  const fixture = await mount()
  try {
    const captain = fixture.createCaptain('captain-member-with-empty-tasks')
    const result = await fixture.execute(captain, {
      name: 'Member Without Tasks',
      approval: 'required',
      profile: PROFILE,
      plan: { members: REAL_PLAN.members, tasks: [] },
    })
    assert.equal(result.isError, true, JSON.stringify(result))
    assert.match(JSON.stringify(result), /choose either a configured profile or an inline plan/)
  } finally {
    await fixture.dispose()
  }
})

await test('a real inline plan without a profile still builds the inline roster (issue #234)', async () => {
  const fixture = await mount()
  try {
    const captain = fixture.createCaptain('captain-inline-plan')
    const result = await fixture.execute(captain, {
      name: 'Inline Plan',
      approval: 'required',
      plan: REAL_PLAN,
    })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.profile, undefined)
    const team = await fixture.readCreated(result.value.team_id)
    assert.equal(team.profile, undefined)
    assert.deepEqual(team.members.map(member => member.name), ['scout'])
    assert.deepEqual(team.tasks.map(task => task.profileSeedId), ['t1'])
  } finally {
    await fixture.dispose()
  }
})

await test('a blank profile plus an empty shell equals "neither provided" (issue #234)', async () => {
  const fixture = await mount()
  try {
    const captain = fixture.createCaptain('captain-blank-profile-shell')
    const result = await fixture.execute(captain, {
      name: 'Blank Profile Shell',
      approval: 'required',
      profile: '',
      plan: EMPTY_ARRAY_SHELL,
    })
    // Same invariant as issue #99: the materialized blank counts as omitted, so
    // the existing plain empty-team branch handles it — no new error text.
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.doesNotMatch(JSON.stringify(result), /choose either a configured profile or an inline plan/)
    const team = await fixture.readCreated(result.value.team_id)
    assert.equal(team.profile, undefined)
    assert.deepEqual(team.members, [])
    assert.deepEqual(team.tasks, [])
  } finally {
    await fixture.dispose()
  }
})
