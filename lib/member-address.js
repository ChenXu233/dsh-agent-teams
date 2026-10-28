/**
 * Durable member addressing (plan 10).
 *
 * The plugin's Remote surface addresses one member by its captain and child
 * session ids — the same parent + child shape the host uses for subagent
 * addresses. Resolution is a pure state lookup: it never resumes an Agent and
 * never writes team state.
 * @module dsh-agent-teams/member-address
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readTeam } from "./state.js";
/** Address resolution failure carrying the wire code the Remote surface returns. */
export class MemberAddressError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'MemberAddressError';
        this.code = code;
    }
}
/** Read the host session store without requiring it in `inject`. */
export function sessionStoreOf(ctx) {
    const get = ctx.get;
    if (typeof get !== 'function')
        return undefined;
    try {
        const store = get.call(ctx, 'sessions');
        return store !== undefined && typeof store.get === 'function' ? store : undefined;
    }
    catch {
        return undefined;
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
export function liveSessionIds(store, limit = 20) {
    if (store?.list === undefined)
        return [];
    try {
        return store.list().slice(0, limit).map((session) => String(session.id));
    }
    catch {
        return [];
    }
}
/** Every team id under one resolved state root; an absent root reads as empty. */
async function teamIdsOf(stateRoot) {
    return readdir(stateRoot).catch(() => []);
}
/**
 * Workspace roots the host knows about.
 *
 * A cold subagent transcript is displayed from its durable log without
 * attaching the session, so `sessions.get()` has no cwd to offer. The workspace
 * registry is the host's own answer to "which directories exist", and the team
 * state under each root names its members by child session id.
 */
function workspaceRootsOf(ctx) {
    const get = ctx.get;
    if (typeof get !== 'function')
        return [];
    try {
        const registry = (get.call(ctx, 'workspaceRegistry') ?? get.call(ctx, 'workspace'));
        if (registry?.list === undefined)
            return [];
        return registry.list()
            .map((workspace) => workspace.path)
            .filter((path) => typeof path === 'string' && path !== '');
    }
    catch {
        return [];
    }
}
/** Scan one state root for the team that owns a member session id. */
async function scanForMember(stateRoot, memberSessionId) {
    for (const teamId of await teamIdsOf(stateRoot)) {
        const team = await readTeam(stateRoot, teamId);
        const member = team?.members.find((candidate) => candidate.id === memberSessionId);
        if (team !== undefined && member !== undefined)
            return { team, member };
    }
    return undefined;
}
/**
 * Resolve one durable member address without resuming anything.
 * @param ctx - plugin context carrying the live Agent registry.
 * @param address - captain + member session ids.
 * @param stateDir - configured state directory name.
 * @returns the team record, the roster member, and the live captain.
 * @throws MemberAddressError `captain/offline` or `member/not-found`.
 */
export async function resolveMemberAddress(ctx, address, stateDir) {
    const captain = ctx.agents.get(address.captainSessionId);
    if (captain === undefined) {
        throw new MemberAddressError('captain/offline', `captain session "${address.captainSessionId}" is not attached`);
    }
    const root = captain.session.header.cwd;
    if (root === undefined) {
        throw new MemberAddressError('member/not-found', `captain session "${address.captainSessionId}" has no workspace`);
    }
    const stateRoot = join(root, stateDir);
    for (const teamId of await teamIdsOf(stateRoot)) {
        const team = await readTeam(stateRoot, teamId);
        if (team === undefined || team.captainSessionId !== address.captainSessionId)
            continue;
        const member = team.members.find((candidate) => candidate.id === address.memberSessionId && candidate.status !== 'removed');
        if (member !== undefined)
            return { team, member, captain };
    }
    throw new MemberAddressError('member/not-found', `session "${address.memberSessionId}" is not an active member of captain "${address.captainSessionId}"`);
}
/**
 * Reverse lookup used by the legacy HTTP routes: find the team that owns one
 * member session, starting from that session's own workspace.
 * @param ctx - plugin context carrying the attached-session registry.
 * @param memberSessionId - the member's child session id.
 * @param stateDir - configured state directory name.
 * @returns the owning team and roster member, or undefined when it is not a member.
 */
export async function findTeamByMemberSession(ctx, memberSessionId, stateDir) {
    const session = sessionStoreOf(ctx)?.get(memberSessionId);
    const root = session?.header.cwd;
    if (root !== undefined) {
        const live = await scanForMember(join(root, stateDir), memberSessionId);
        if (live !== undefined)
            return live;
    }
    // The member page is usually opened on a cold transcript: the host renders
    // the durable log without attaching the session, so the registry is the only
    // workspace source. Without this fallback every cold member answers "not a
    // member session" and its composer never takes over.
    for (const workspace of workspaceRootsOf(ctx)) {
        const found = await scanForMember(join(workspace, stateDir), memberSessionId);
        if (found !== undefined)
            return found;
    }
    return undefined;
}
