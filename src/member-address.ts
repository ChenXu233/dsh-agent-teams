/**
 * Durable member addressing (plan 10).
 *
 * The plugin's Remote surface addresses one member by its captain and child
 * session ids — the same parent + child shape the host uses for subagent
 * addresses. Resolution is a pure state lookup: it never resumes an Agent and
 * never writes team state.
 * @module dsh-agent-teams/member-address
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { readTeam } from './state.ts'
import type { TeamMember, TeamState } from './types.ts'

/** Durable address of one member: its captain plus its own child session. */
export interface MemberAddress {
  readonly captainSessionId: string
  readonly memberSessionId: string
}

/** One resolved member and everything the command surface needs around it. */
export interface ResolvedMember {
  readonly team: TeamState
  readonly member: TeamMember
  readonly captain: Agent
}

/** Stable failure codes of address resolution. */
export type MemberAddressErrorCode = 'member/not-found' | 'captain/offline'

/** Address resolution failure carrying the wire code the Remote surface returns. */
export class MemberAddressError extends Error {
  readonly code: MemberAddressErrorCode

  constructor(code: MemberAddressErrorCode, message: string) {
    super(message)
    this.name = 'MemberAddressError'
    this.code = code
  }
}

/**
 * Structural view of the host session store.
 *
 * `ctx.sessions` is a host service, but this plugin never injects it: cordis
 * throws on an undeclared service property (`cannot get property "sessions"
 * without inject`), and every member route that resolved a workspace through it
 * answered 400 on a real host while the fake contexts of the test suite happily
 * provided the property. `ctx.get(name)` is the unguarded registry read this
 * plugin already uses for the web server, the command bus and the token meter;
 * a composition that has no session store degrades to "not a member session"
 * instead of failing the request.
 */
interface SessionStoreView {
  get(id: SessionId): { readonly header: { readonly cwd?: string } } | undefined
  list?(): readonly { readonly id: string }[]
}

/** Read the host session store without requiring it in `inject`. */
export function sessionStoreOf(ctx: Context): SessionStoreView | undefined {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return undefined
  try {
    const store = get.call(ctx, 'sessions') as SessionStoreView | undefined
    return store !== undefined && typeof store.get === 'function' ? store : undefined
  } catch {
    return undefined
  }
}

/**
 * Live session ids the store currently holds, for the membership diagnostic.
 *
 * The store only carries sessions this process has attached: a member that
 * settled before a restart is durable but absent here, which is why a cold
 * member answers "not a member session" until its conversation is opened.
 * @param store - the store read through {@link sessionStoreOf}.
 * @param limit - maximum ids to report.
 */
export function liveSessionIds(store: SessionStoreView | undefined, limit = 20): readonly string[] {
  if (store?.list === undefined) return []
  try {
    return store.list().slice(0, limit).map((session) => String(session.id))
  } catch {
    return []
  }
}

/** Every team DIRECTORY under one resolved state root; an absent root reads as empty. */
async function teamIdsOf(stateRoot: string): Promise<readonly string[]> {
  // Only directories are teams: a stray file (or a lock file named like a team)
  // must not make the whole lookup throw, which surfaced as an empty HTTP 400.
  const entries = await readdir(stateRoot, { withFileTypes: true }).catch(() => [])
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
}

/** Every archived team id under one state root (`archive/<teamId>/team.json`). */
async function archivedTeamIdsOf(stateRoot: string): Promise<readonly string[]> {
  const entries = await readdir(join(stateRoot, 'archive'), { withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
}

/** Read one team, treating an unreadable team.json as "not this team". */
async function readTeamSafe(stateRoot: string, teamId: string): Promise<TeamState | undefined> {
  try {
    return await readTeam(stateRoot, teamId)
  } catch {
    return undefined
  }
}

/**
 * Workspace roots the host knows about.
 *
 * A cold subagent transcript is displayed from its durable log without
 * attaching the session, so `sessions.get()` has no cwd to offer. The workspace
 * registry is the host's own answer to "which directories exist", and the team
 * state under each root names its members by child session id.
 */
function workspaceRootsOf(ctx: Context): readonly string[] {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return []
  try {
    const registry = (get.call(ctx, 'workspaceRegistry') ?? get.call(ctx, 'workspace')) as
      | { list?: () => readonly { readonly path?: string }[] }
      | undefined
    if (registry?.list === undefined) return []
    return registry.list()
      .map((workspace) => workspace.path)
      .filter((path): path is string => typeof path === 'string' && path !== '')
  } catch {
    return []
  }
}

/** Scan one state root for the team that owns a member session id. */
async function scanForMember(
  stateRoot: string,
  memberSessionId: string,
): Promise<{ team: TeamState; member: TeamMember } | undefined> {
  for (const teamId of await teamIdsOf(stateRoot)) {
    const team = await readTeamSafe(stateRoot, teamId)
    const member = team?.members.find((candidate) => candidate.id === memberSessionId)
    if (team !== undefined && member !== undefined) return { team, member }
  }
  // An archived team still owns its member conversations: the pages stay
  // readable (and keep their model seat / dock), they are just refused new work.
  for (const teamId of await archivedTeamIdsOf(stateRoot)) {
    const team = await readTeamSafe(join(stateRoot, 'archive'), teamId)
    const member = team?.members.find((candidate) => candidate.id === memberSessionId)
    if (team !== undefined && member !== undefined) return { team, member }
  }
  return undefined
}

/**
 * Resolve one durable member address without resuming anything.
 * @param ctx - plugin context carrying the live Agent registry.
 * @param address - captain + member session ids.
 * @param stateDir - configured state directory name.
 * @returns the team record, the roster member, and the live captain.
 * @throws MemberAddressError `captain/offline` or `member/not-found`.
 */
export async function resolveMemberAddress(
  ctx: Context,
  address: MemberAddress,
  stateDir: string,
): Promise<ResolvedMember> {
  const captain = ctx.agents.get(address.captainSessionId as SessionId)
  if (captain === undefined) {
    throw new MemberAddressError('captain/offline', `captain session "${address.captainSessionId}" is not attached`)
  }
  const root = captain.session.header.cwd
  if (root === undefined) {
    throw new MemberAddressError('member/not-found', `captain session "${address.captainSessionId}" has no workspace`)
  }
  const stateRoot = join(root, stateDir)
  for (const teamId of await teamIdsOf(stateRoot)) {
    const team = await readTeam(stateRoot, teamId)
    if (team === undefined || team.captainSessionId !== address.captainSessionId) continue
    const member = team.members.find((candidate) => candidate.id === address.memberSessionId && candidate.status !== 'removed')
    if (member !== undefined) return { team, member, captain }
  }
  throw new MemberAddressError('member/not-found', `session "${address.memberSessionId}" is not an active member of captain "${address.captainSessionId}"`)
}

/**
 * Reverse lookup used by the legacy HTTP routes: find the team that owns one
 * member session, starting from that session's own workspace.
 * @param ctx - plugin context carrying the attached-session registry.
 * @param memberSessionId - the member's child session id.
 * @param stateDir - configured state directory name.
 * @returns the owning team and roster member, or undefined when it is not a member.
 */
export async function findTeamByMemberSession(
  ctx: Context,
  memberSessionId: string,
  stateDir: string,
): Promise<{ team: TeamState; member: TeamMember } | undefined> {
  const session = sessionStoreOf(ctx)?.get(memberSessionId as SessionId)
  const root = session?.header.cwd
  if (root !== undefined) {
    const live = await scanForMember(join(root, stateDir), memberSessionId)
    if (live !== undefined) return live
  }
  // The member page is usually opened on a cold transcript: the host renders
  // the durable log without attaching the session, so the registry is the only
  // workspace source. Without this fallback every cold member answers "not a
  // member session" and its composer never takes over.
  for (const workspace of workspaceRootsOf(ctx)) {
    const found = await scanForMember(join(workspace, stateDir), memberSessionId)
    if (found !== undefined) return found
  }
  return undefined
}

/** One member session discovered across the workspaces this host knows. */
export interface MemberSessionEntry {
  readonly sessionId: string
  readonly teamId: string
  readonly captainSessionId: string
  readonly member: string
}

/**
 * Every member session the host can see, for the client's model seat.
 *
 * The client cannot read team state, and the seat has to answer "is this
 * session a member?" synchronously while the composer renders, so the answer
 * is prefetched once per page instead of probed per session.
 * @param ctx - plugin context carrying the attached-session and workspace registries.
 * @param stateDir - configured state directory name.
 * @returns one entry per active (non-removed) member, deduplicated by session id.
 */
export async function listMemberSessions(ctx: Context, stateDir: string): Promise<readonly MemberSessionEntry[]> {
  const roots = new Set<string>()
  const store = sessionStoreOf(ctx)
  if (store?.list !== undefined) {
    try {
      for (const session of store.list()) {
        const cwd = store.get(session.id as SessionId)?.header.cwd
        if (cwd !== undefined && cwd !== '') roots.add(cwd)
      }
    } catch {
      // An unreadable store still leaves the workspace registry below.
    }
  }
  for (const root of workspaceRootsOf(ctx)) roots.add(root)
  // The host's own working directory is where a session without a registered
  // workspace defaults; without it a cold, archived team is invisible to the
  // client's roster prefetch even though its member pages resolve.
  roots.add(process.cwd())
  const members: MemberSessionEntry[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    const stateRoot = join(root, stateDir)
    const scan = async (base: string, teamIds: readonly string[]): Promise<void> => {
      for (const teamId of teamIds) {
        const team = await readTeamSafe(base, teamId)
        if (team === undefined) continue
        for (const member of team.members) {
          if (member.status === 'removed' || member.id === '' || seen.has(member.id)) continue
          seen.add(member.id)
          members.push({
            sessionId: member.id,
            teamId: team.id,
            captainSessionId: team.captainSessionId,
            member: member.name,
          })
        }
      }
    }
    await scan(stateRoot, await teamIdsOf(stateRoot))
    await scan(join(stateRoot, 'archive'), await archivedTeamIdsOf(stateRoot))
  }
  return members
}
