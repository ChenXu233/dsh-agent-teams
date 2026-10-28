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

/** Every team id under one resolved state root; an absent root reads as empty. */
async function teamIdsOf(stateRoot: string): Promise<readonly string[]> {
  return readdir(stateRoot).catch(() => [] as string[])
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
  if (session === undefined || root === undefined) return undefined
  const stateRoot = join(root, stateDir)
  for (const teamId of await teamIdsOf(stateRoot)) {
    const team = await readTeam(stateRoot, teamId)
    const member = team?.members.find((candidate) => candidate.id === memberSessionId)
    if (team !== undefined && member !== undefined) return { team, member }
  }
  return undefined
}
