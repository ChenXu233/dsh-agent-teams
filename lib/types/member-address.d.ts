/**
 * Durable member addressing (plan 10).
 *
 * The plugin's Remote surface addresses one member by its captain and child
 * session ids — the same parent + child shape the host uses for subagent
 * addresses. Resolution is a pure state lookup: it never resumes an Agent and
 * never writes team state.
 * @module dsh-agent-teams/member-address
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { TeamMember, TeamState } from './types.ts';
/** Durable address of one member: its captain plus its own child session. */
export interface MemberAddress {
    readonly captainSessionId: string;
    readonly memberSessionId: string;
}
/** One resolved member and everything the command surface needs around it. */
export interface ResolvedMember {
    readonly team: TeamState;
    readonly member: TeamMember;
    readonly captain: Agent;
}
/** Stable failure codes of address resolution. */
export type MemberAddressErrorCode = 'member/not-found' | 'captain/offline';
/** Address resolution failure carrying the wire code the Remote surface returns. */
export declare class MemberAddressError extends Error {
    readonly code: MemberAddressErrorCode;
    constructor(code: MemberAddressErrorCode, message: string);
}
/**
 * Resolve one durable member address without resuming anything.
 * @param ctx - plugin context carrying the live Agent registry.
 * @param address - captain + member session ids.
 * @param stateDir - configured state directory name.
 * @returns the team record, the roster member, and the live captain.
 * @throws MemberAddressError `captain/offline` or `member/not-found`.
 */
export declare function resolveMemberAddress(ctx: Context, address: MemberAddress, stateDir: string): Promise<ResolvedMember>;
/**
 * Reverse lookup used by the legacy HTTP routes: find the team that owns one
 * member session, starting from that session's own workspace.
 * @param ctx - plugin context carrying the attached-session registry.
 * @param memberSessionId - the member's child session id.
 * @param stateDir - configured state directory name.
 * @returns the owning team and roster member, or undefined when it is not a member.
 */
export declare function findTeamByMemberSession(ctx: Context, memberSessionId: string, stateDir: string): Promise<{
    team: TeamState;
    member: TeamMember;
} | undefined>;
