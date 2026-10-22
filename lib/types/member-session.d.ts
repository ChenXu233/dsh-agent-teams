/**
 * First-class member sessions (plan 09, phase A).
 *
 * A member is a *teammate*: it lives for the whole team, receives mail, owns
 * tasks across many turns, and must stay drivable after a host restart. The
 * subagent primitive it used to be created with is a call frame: the host
 * records `header.origin === 'subagent'`, and every generic session API then
 * refuses the identity with `session/agent-busy: owned by subagent routing`.
 * That single guard is why a member view is read-only, why `/compact` needs our
 * own route, and why an idle member is not resolvable after a restart.
 *
 * This module creates a member as an ordinary session instead — the same
 * primitive a new conversation uses. Ordinary sessions answer to the generic
 * controller, so the official composer, `remote.commands` and a cold resume all
 * work on them. The member identity stays in `team.json`; nothing here writes
 * `header.origin`.
 *
 * The switch is opt-in (`memberSessions: 'session'`). The legacy subagent path
 * stays the default, and this module is never consulted for it.
 * @module dsh-agent-teams/member-session
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent';
import type { MemberToolFilter } from './tool-policies.ts';
/** How a member's conversation is carried: legacy subagent frame or ordinary session. */
export type MemberSessionKind = 'subagent' | 'session';
/** One queued prompt as the host session controller defines it. */
export interface MemberSessionPrompt {
    /** Target ordinary session. */
    sessionId: string;
    /** Text content; members never receive attachments through this path. */
    content: {
        type: 'text';
        text: string;
    }[];
    /** `queue` starts the next turn, `steer` folds into the running one. */
    mode?: 'queue' | 'steer';
    /** Idempotency identity recorded on the accepted message source. */
    requestId?: string;
}
/**
 * Structural view of the host session controller.
 *
 * Only the three calls this module needs: create an ordinary session, prompt
 * one, cancel one. The controller is an optional sibling service, so it is read
 * through `ctx.get` (property access throws without a root `inject` entry).
 */
export interface MemberSessionController {
    create?: (request: {
        cwd?: string;
        workspaceId?: string;
        agentPreset?: string;
        sessionId?: string;
    }) => Promise<{
        sessionId?: string;
    }>;
    prompt?: (request: MemberSessionPrompt, source: unknown) => Promise<{
        accepted?: boolean;
    }>;
    cancel?: (request: {
        sessionId: string;
    }) => {
        accepted?: boolean;
    };
}
/** Structural view of the workspace registry used to group a member beside its captain. */
export interface MemberSessionRegistry {
    create?: (path: string, title?: string) => Promise<{
        id?: string;
    }>;
}
/** Optional services the session-mode member path needs. */
export interface MemberSessionServices {
    controller?: MemberSessionController;
    registry?: MemberSessionRegistry;
}
/**
 * Read the optional services a session-mode member needs.
 *
 * A composition without them still works in the legacy mode; the caller turns
 * the reason into an actionable error instead of crashing at mount time.
 * @param ctx - the plugin context.
 * @returns whichever services this composition exposes.
 */
export declare function readMemberSessionServices(ctx: Context): MemberSessionServices;
/**
 * Why this composition cannot carry a member as an ordinary session.
 * @param services - services read from the running composition.
 * @returns the actionable reason, or undefined when both calls exist.
 */
export declare function memberSessionUnavailableReason(services: MemberSessionServices): string | undefined;
/** How one session-mode member is created. */
export interface CreateMemberSessionRequest {
    /** Workspace directory the captain runs in; the member joins the same one. */
    cwd: string;
    /** Persona prefix installed on the member session before its first turn. */
    persona: string;
    /** Effective tool filter; undefined keeps the host default tool set. */
    toolFilter?: MemberToolFilter;
    /** Member model route; undefined runs the composition default. */
    selection?: ModelSelection;
    /** First turn text (the welcome message). */
    prompt: string;
}
/** Created member session identity. */
export interface CreatedMemberSession {
    /** Durable ordinary session id; stored as `TeamMember.id`. */
    childId: string;
    /** The live Agent, already configured and prompted. */
    agent: Agent;
}
/**
 * Create one member as an ordinary session and open its first turn.
 *
 * The session is attached to the captain's workspace when the registry can
 * resolve it, so the member shows up beside the captain instead of in an
 * unattached list. A setup failure throws: a member that runs without its
 * persona or tool filter is worse than a failed spawn the team can report.
 * @param ctx - the plugin context (injects `agents`).
 * @param services - services resolved once by the caller.
 * @param request - persona, filter, route and first turn.
 * @returns the created member session.
 */
export declare function createMemberSession(ctx: Context, services: MemberSessionServices, request: CreateMemberSessionRequest): Promise<CreatedMemberSession>;
/**
 * Queue one prompt on an ordinary member session.
 *
 * Delivery goes through the host controller's prompt call, which admits the
 * message and then either starts the next turn (`queue`) or folds it into the
 * running one (`steer`) — the same primitive the official composer uses. A
 * cold session is resumed by that call, which is exactly what the subagent
 * owner guard refuses to do for legacy members.
 * @param ctx - the plugin context.
 * @param services - services resolved once by the caller.
 * @param sessionId - the member's ordinary session id.
 * @param text - message content.
 * @param mode - queue for the next turn (default) or steer the running one.
 * @returns whether the host accepted the prompt.
 */
export declare function promptMemberSession(ctx: Context, services: MemberSessionServices, sessionId: string, text: string, mode?: 'queue' | 'steer'): Promise<boolean>;
/**
 * Cancel one member session's running turn, best effort.
 *
 * The ordinary-session equivalent of the legacy targeted drain: the session and
 * its queued work survive, only the active turn is aborted.
 * @param ctx - the plugin context.
 * @param services - services resolved once by the caller.
 * @param sessionId - the member's ordinary session id.
 */
export declare function cancelMemberSession(ctx: Context, services: MemberSessionServices, sessionId: string): void;
