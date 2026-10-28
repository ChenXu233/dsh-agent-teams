/**
 * Verification for durable member addressing (plan 10).
 *
 * Builds real team.json fixtures in a temp workspace and drives both the
 * forward address resolver and the legacy reverse lookup with fake contexts.
 *
 * Imports the BUILT bundle (../lib/**.js) - run `pnpm build` first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTeamDir } from '../lib/state.js'
import { findTeamByMemberSession, MemberAddressError, resolveMemberAddress } from '../lib/member-address.js'

const STATE_DIR = '.agent-teams'
const CAPTAIN = 'captain-1'
const MEMBER = 'child-1'

async function fixture(members = [{ id: MEMBER, name: 'alpha', role: 'a', joinedAt: 1, status: 'idle' }]) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-teams-address-'))
  const stateRoot = join(workspace, STATE_DIR)
  await mkdir(stateRoot, { recursive: true })
  await createTeamDir(stateRoot, {
    name: 'demo', id: 'demo', captainSessionId: CAPTAIN, createdAt: 1, taskSeq: 0,
    members: members.map((member) => ({ ...member })), tasks: [],
  })
  return { workspace, stateRoot }
}

/**
 * The host context shape this plugin actually runs against: `agents` is an
 * injected service, while the session store is reached through the unguarded
 * registry read. It deliberately has NO `sessions` property — cordis throws on
 * an undeclared service property, which is exactly how every member route
 * answered 400 on a real host while a property-providing fake passed.
 */
function ctxFor(workspace, captains = { [CAPTAIN]: { id: CAPTAIN, session: { header: { cwd: workspace } } } }) {
  const store = { get: (id) => (id === MEMBER ? { header: { cwd: workspace } } : undefined) }
  return {
    agents: { get: (id) => captains[id] },
    get: (name) => (name === 'sessions' ? store : undefined),
  }
}

test('resolveMemberAddress returns team, member and live captain', async () => {
  const { workspace } = await fixture()
  const resolved = await resolveMemberAddress(ctxFor(workspace), { captainSessionId: CAPTAIN, memberSessionId: MEMBER }, STATE_DIR)
  assert.equal(resolved.team.id, 'demo')
  assert.equal(resolved.member.name, 'alpha')
  assert.equal(resolved.captain.id, CAPTAIN)
  await rm(workspace, { recursive: true, force: true })
})

test('resolveMemberAddress reports captain/offline when the captain is not attached', async () => {
  const { workspace } = await fixture()
  await assert.rejects(
    () => resolveMemberAddress(ctxFor(workspace, {}), { captainSessionId: CAPTAIN, memberSessionId: MEMBER }, STATE_DIR),
    (error) => error instanceof MemberAddressError && error.code === 'captain/offline',
  )
  await rm(workspace, { recursive: true, force: true })
})

test('resolveMemberAddress reports member/not-found for a removed or foreign member', async () => {
  const { workspace } = await fixture([{ id: MEMBER, name: 'alpha', role: 'a', joinedAt: 1, status: 'removed' }])
  await assert.rejects(
    () => resolveMemberAddress(ctxFor(workspace), { captainSessionId: CAPTAIN, memberSessionId: MEMBER }, STATE_DIR),
    (error) => error instanceof MemberAddressError && error.code === 'member/not-found',
  )
  await assert.rejects(
    () => resolveMemberAddress(ctxFor(workspace), { captainSessionId: CAPTAIN, memberSessionId: 'child-9' }, STATE_DIR),
    (error) => error instanceof MemberAddressError && error.code === 'member/not-found',
  )
  await rm(workspace, { recursive: true, force: true })
})

test('findTeamByMemberSession resolves from the member session workspace', async () => {
  const { workspace } = await fixture()
  const found = await findTeamByMemberSession(ctxFor(workspace), MEMBER, STATE_DIR)
  assert.equal(found?.team.id, 'demo')
  assert.equal(found?.member.name, 'alpha')
  assert.equal(await findTeamByMemberSession(ctxFor(workspace), 'child-9', STATE_DIR), undefined)
  await rm(workspace, { recursive: true, force: true })
})

test('findTeamByMemberSession degrades without a session store instead of throwing', async () => {
  const { workspace } = await fixture()
  // No registry read at all: a composition without the service must answer
  // "not a member session", never fail the request.
  assert.equal(await findTeamByMemberSession({ agents: { get: () => undefined } }, MEMBER, STATE_DIR), undefined)
  // A throwing accessor (the cordis inject guard) is also tolerated.
  assert.equal(await findTeamByMemberSession({
    agents: { get: () => undefined },
    get: () => { throw new Error('cannot get property "sessions" without inject') },
  }, MEMBER, STATE_DIR), undefined)
  await rm(workspace, { recursive: true, force: true })
})
