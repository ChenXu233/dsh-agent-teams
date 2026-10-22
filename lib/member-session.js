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
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { agentTeamsSource, observedSessionFormatVersion } from "./harness-compat.js";
/**
 * Read the optional services a session-mode member needs.
 *
 * A composition without them still works in the legacy mode; the caller turns
 * the reason into an actionable error instead of crashing at mount time.
 * @param ctx - the plugin context.
 * @returns whichever services this composition exposes.
 */
export function readMemberSessionServices(ctx) {
    const get = ctx.get;
    if (typeof get !== 'function')
        return {};
    const read = (name) => {
        try {
            return get.call(ctx, name);
        }
        catch {
            return undefined;
        }
    };
    return {
        controller: read('sessionController'),
        registry: read('workspaceRegistry'),
    };
}
/**
 * Why this composition cannot carry a member as an ordinary session.
 * @param services - services read from the running composition.
 * @returns the actionable reason, or undefined when both calls exist.
 */
export function memberSessionUnavailableReason(services) {
    if (typeof services.controller?.create !== 'function') {
        return 'this composition exposes no session controller, so members cannot be created as ordinary sessions; '
            + 'mount the session-controller service or set memberSessions to "subagent"';
    }
    if (typeof services.controller.prompt !== 'function') {
        return 'this composition exposes no session prompt API, so a session-mode member could be created but never woken; '
            + 'set memberSessions to "subagent"';
    }
    return undefined;
}
/**
 * Install the per-member setup an ordinary session does not inherit.
 *
 * A subagent receives `persona` and `toolFilter` in its creation request. An
 * ordinary session has no such request, so the same three pieces are installed
 * on the live Agent context before its first turn: model route, tool filter and
 * the persona prompt prefix. They live as long as the Agent's scope.
 * @param agent - the freshly created member Agent.
 * @param request - persona, filter and route to install.
 */
function installMemberSessionSetup(agent, request) {
    if (request.selection !== undefined) {
        installModelSelection(agent.ctx, { current: request.selection, assembled: undefined });
    }
    if (request.toolFilter !== undefined)
        agent.ctx.tools.restrict(request.toolFilter);
    agent.ctx.systemPrompt.section({
        name: 'deployment:persona-prefix',
        order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: request.persona,
    });
}
/**
 * Resolve the workspace a member session belongs to, without inventing one.
 *
 * A member must appear beside its captain, and a team must never litter the
 * sidebar with a workspace per spawn. In order:
 *
 * 1. the workspace that already holds the captain session — `list()` is a
 *    read, and this is the only answer that guarantees "beside the captain"
 *    even when the captain's directory spelling differs from ours;
 * 2. `resolveByPath` — an existing workspace for this directory, still a read;
 * 3. `create` — create-or-reuse: it returns the existing entity for an already
 *    registered canonical path and only writes a record for an unowned
 *    directory, titled after the directory rather than the full path.
 *
 * Every step degrades to the next, and `undefined` simply means the session is
 * created from `cwd` without workspace grouping.
 * @param ctx - the plugin context (logging only).
 * @param registry - the optional workspace registry.
 * @param request - cwd and optional captain session id.
 * @returns the workspace id to attach to, when one can be resolved.
 */
async function resolveMemberWorkspaceId(ctx, registry, request) {
    if (registry === undefined)
        return undefined;
    const captainSessionId = request.captainSessionId;
    if (captainSessionId !== undefined && typeof registry.list === 'function') {
        try {
            const owned = registry.list().find((workspace) => workspace.sessionIds?.includes(captainSessionId) === true);
            if (typeof owned?.id === 'string' && owned.id !== '')
                return owned.id;
        }
        catch (error) {
            ctx.logger.warn(`agent-teams: could not list workspaces for member creation: ${String(error)}`);
        }
    }
    if (typeof registry.resolveByPath === 'function') {
        try {
            const existing = await registry.resolveByPath(request.cwd);
            if (typeof existing?.id === 'string' && existing.id !== '')
                return existing.id;
        }
        catch (error) {
            ctx.logger.warn(`agent-teams: could not resolve the workspace for ${request.cwd}: ${String(error)}`);
        }
    }
    if (typeof registry.create === 'function') {
        try {
            const created = await registry.create(request.cwd, basename(request.cwd));
            if (typeof created.id === 'string' && created.id !== '')
                return created.id;
        }
        catch (error) {
            // The workspace only groups the session in the UI; creation still works
            // from an explicit cwd.
            ctx.logger.warn(`agent-teams: could not create a workspace for member creation in ${request.cwd}: ${String(error)}`);
        }
    }
    return undefined;
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
export async function createMemberSession(ctx, services, request) {
    const unavailable = memberSessionUnavailableReason(services);
    if (unavailable !== undefined)
        throw new Error(`agent-teams: ${unavailable}`);
    const controller = services.controller;
    const workspaceId = await resolveMemberWorkspaceId(ctx, services.registry, request);
    const created = workspaceId === undefined
        ? await controller.create({ cwd: request.cwd })
        : await controller.create({ workspaceId });
    const sessionId = created.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error('agent-teams: the session controller reported success without a member session id');
    }
    const agent = ctx.agents.get(sessionId);
    if (agent === undefined) {
        throw new Error(`agent-teams: member session ${sessionId} was created but is not attached; it cannot receive its first turn`);
    }
    installMemberSessionSetup(agent, request);
    const accepted = await promptMemberSession(ctx, services, sessionId, request.prompt, 'queue');
    if (!accepted) {
        throw new Error(`agent-teams: member session ${sessionId} was created but its first turn was not accepted; the member would stay silent`);
    }
    return { childId: sessionId, agent };
}
/**
 * Stored session format generation of the session this prompt lands in.
 *
 * Upstream #236: the resolved `@deepseek-ai/dsh-session` copy can belong to a
 * different host generation than the process that persists the message, and a
 * wrong generation selects the retired `plugin` wrapper that the host's own
 * admission check rejects. The live session header is authoritative, so prefer
 * it and fall back to the module constant only when nothing is attached.
 * @param ctx - the plugin context.
 * @param sessionId - the member's ordinary session id.
 * @returns the observed generation, or undefined when only the module says.
 */
function memberSessionFormatVersion(ctx, sessionId) {
    const live = ctx.agents.get(sessionId);
    if (live !== undefined)
        return observedSessionFormatVersion(live);
    const attached = ctx.sessions?.get?.(sessionId);
    return attached === undefined ? undefined : observedSessionFormatVersion({ session: attached });
}
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
export async function promptMemberSession(ctx, services, sessionId, text, mode = 'queue') {
    const controller = services.controller;
    if (typeof controller?.prompt !== 'function')
        return false;
    try {
        const accepted = await controller.prompt.call(controller, {
            sessionId,
            content: [{ type: 'text', text }],
            mode,
            requestId: randomUUID(),
        }, agentTeamsSource({ kind: 'agent-teams' }, memberSessionFormatVersion(ctx, sessionId)));
        return accepted?.accepted !== false;
    }
    catch (error) {
        ctx.logger.warn(`agent-teams: prompt delivery to member session ${sessionId} failed: ${String(error)}`);
        return false;
    }
}
/**
 * Cancel one member session's running turn, best effort.
 *
 * The ordinary-session equivalent of the legacy targeted drain: the session and
 * its queued work survive, only the active turn is aborted.
 * @param ctx - the plugin context.
 * @param services - services resolved once by the caller.
 * @param sessionId - the member's ordinary session id.
 */
export function cancelMemberSession(ctx, services, sessionId) {
    const controller = services.controller;
    if (typeof controller?.cancel !== 'function')
        return;
    try {
        controller.cancel.call(controller, { sessionId });
    }
    catch (error) {
        ctx.logger.warn(`agent-teams: cancel of member session ${sessionId} failed: ${String(error)}`);
    }
}
