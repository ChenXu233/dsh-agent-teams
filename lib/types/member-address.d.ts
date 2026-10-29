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
import type { SessionId } from '@deepseek-ai/dsh-session';
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
    get(id: SessionId): {
        readonly header: {
            readonly cwd?: string;
        };
    } | undefined;
    list?(): readonly {
        readonly id: string;
    }[];
}
/** Read the host session store without requiring it in `inject`. */
export declare function sessionStoreOf(ctx: Context): SessionStoreView | undefined;
/**
 * Live session ids the store currently holds, for the membership diagnostic.
 *
 * The store only carries sessions this process has attached: a member that
 * settled before a restart is durable but absent here, which is why a cold
 * member answers "not a member session" until its conversation is opened.
 * @param store - the store read through {@link sessionStoreOf}.
 * @param limit - maximum ids to report.
 */
export declare function liveSessionIds(store: SessionStoreView | undefined, limit?: number): readonly string[];
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
/** One member session discovered across the workspaces this host knows. */
export interface MemberSessionEntry {
    readonly sessionId: string;
    readonly teamId: string;
    readonly captainSessionId: string;
    readonly member: string;
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
export declare function listMemberSessions(ctx: Context, stateDir: string): Promise<readonly MemberSessionEntry[]>;
export {};
