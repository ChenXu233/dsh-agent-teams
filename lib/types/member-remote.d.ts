/**
 * Plugin-owned Remote namespace for member sessions (plan 10).
 *
 * The host's Session Remote refuses every subagent-owned session, and its
 * subagent namespace exposes only `prompt` and `interruptByParent`. This service
 * is the missing surface: it addresses one member by captain + child session,
 * runs the member's own commands on the in-process bus, and never resumes a
 * cold member. The Typert Gateway discovers it through the `typertRemote`
 * binding at runtime (source mode), so no host codegen is involved.
 * @module dsh-agent-teams/member-remote
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { type MemberAddress } from './member-address.ts';
/** Wire namespace of the member surface. */
export declare const MEMBER_REMOTE_NAMESPACE = "agentTeams";
/** Stable failure codes this service adds to the host map. */
export type MemberRemoteErrorCode = 'member/not-found' | 'member/cold' | 'member/busy' | 'captain/offline' | 'command/denied' | 'command/unknown';
declare module '@deepseek-ai/dsh-typert-protocol/types' {
    interface RemoteErrorDetailsMap {
        'member/not-found': {
            readonly memberSessionId: string;
        };
        'member/cold': {
            readonly memberSessionId: string;
        };
        'member/busy': {
            readonly memberSessionId: string;
        };
        'captain/offline': {
            readonly captainSessionId: string;
        };
        'command/denied': {
            readonly command: string;
        };
        'command/unknown': {
            readonly line: string;
        };
    }
}
/** One member as the composer needs to see it. */
export interface MemberView {
    readonly member: string;
    readonly teamId: string;
    readonly live: boolean;
    readonly running: boolean;
    /** Halted teams keep their transcript readable but refuse new work. */
    readonly archived: boolean;
    readonly model: {
        readonly provider: string;
        readonly model: string;
    } | null;
    readonly queued: number;
}
/** One command descriptor offered by the member's own session. */
export interface MemberCommandView {
    readonly name: string;
    readonly description?: string;
    readonly hint?: string;
    readonly attachments?: boolean;
}
/** Normalized command outcome; an unclaimed line is `ok: false`. */
export interface MemberCommandOutcome {
    readonly ok: boolean;
    readonly kind: 'success' | 'error';
    readonly text?: string;
    readonly commandId?: string;
}
/** Delivery acknowledgement of one plain-text prompt. */
export interface MemberPromptOutcome {
    readonly delivered: boolean;
}
/** Pending input of one member. */
export interface MemberQueueView {
    readonly running: boolean;
    readonly items: readonly {
        readonly id: string;
        readonly preview: string;
    }[];
}
/** Interrupt acknowledgement. */
export interface MemberInterruptOutcome {
    readonly accepted: boolean;
}
/** Installed model selection. */
export interface MemberModelOutcome {
    readonly provider: string;
    readonly model: string;
}
/** Construction options carried from the plugin config. */
export interface MemberRemoteOptions {
    readonly stateDir: string;
    readonly deny: readonly string[];
}
/** Build the membership view from one resolved address and its live Agent. */
export declare function memberViewOf(resolved: {
    member: {
        name: string;
    };
    team: {
        id: string;
        halted?: boolean;
    };
}, agent: Agent | undefined): MemberView;
/** Build the pending-input view from one live Agent. */
export declare function queueViewOf(agent: Agent | undefined): MemberQueueView;
/** Translate one address failure into the wire failure the client expects. */
export declare function remoteAddressError(error: unknown, address: MemberAddress): unknown;
/**
 * Member command and control surface.
 *
 * Every method resolves the address first and then delegates; no method resumes
 * an Agent, and a command that needs a live idle member reports `member/cold`
 * instead of waking one.
 */
export declare class MemberRemoteService extends TypertRemoteService {
    #private;
    constructor(ctx: Context, options: MemberRemoteOptions);
    /** Membership signal, live state and pending work of one member. */
    resolveMember(captainSessionId: string, memberSessionId: string): Promise<MemberView>;
    /** Commands this member's own session offers, minus the deny list. */
    listCommands(captainSessionId: string, memberSessionId: string): Promise<readonly MemberCommandView[]>;
    /** Run one command line inside the member's own session. */
    execute(captainSessionId: string, memberSessionId: string, line: string, requestId?: string): Promise<MemberCommandOutcome>;
    /** Deliver one plain-text prompt through the captain's channel. */
    prompt(captainSessionId: string, memberSessionId: string, text: string, mode?: 'queue' | 'steer', requestId?: string): Promise<MemberPromptOutcome>;
    /** Install a new model selection on a resident member. */
    selectModel(captainSessionId: string, memberSessionId: string, provider: string, model: string, reasoningEffort?: string): Promise<MemberModelOutcome>;
    /** Interrupt the member's current turn. */
    interrupt(captainSessionId: string, memberSessionId: string): Promise<MemberInterruptOutcome>;
    /** Pending input of one member. */
    queue(captainSessionId: string, memberSessionId: string): Promise<MemberQueueView>;
}
