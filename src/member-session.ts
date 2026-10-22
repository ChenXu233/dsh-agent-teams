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

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { agentTeamsSource, observedSessionFormatVersion } from './harness-compat.ts'
import type { MemberToolFilter } from './tool-policies.ts'

/** How a member's conversation is carried: legacy subagent frame or ordinary session. */
export type MemberSessionKind = 'subagent' | 'session'

/** One queued prompt as the host session controller defines it. */
export interface MemberSessionPrompt {
  /** Target ordinary session. */
  sessionId: string
  /** Text content; members never receive attachments through this path. */
  content: { type: 'text'; text: string }[]
  /** `queue` starts the next turn, `steer` folds into the running one. */
  mode?: 'queue' | 'steer'
  /** Idempotency identity recorded on the accepted message source. */
  requestId?: string
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
    cwd?: string
    workspaceId?: string
    agentPreset?: string
    sessionId?: string
  }) => Promise<{ sessionId?: string }>
  prompt?: (request: MemberSessionPrompt, source: unknown) => Promise<{ accepted?: boolean }>
  cancel?: (request: { sessionId: string }) => { accepted?: boolean }
}

/** Structural view of the workspace registry used to group a member beside its captain. */
export interface MemberSessionRegistry {
  create?: (path: string, title?: string) => Promise<{ id?: string }>
}

/** Optional services the session-mode member path needs. */
export interface MemberSessionServices {
  controller?: MemberSessionController
  registry?: MemberSessionRegistry
}

/**
 * Read the optional services a session-mode member needs.
 *
 * A composition without them still works in the legacy mode; the caller turns
 * the reason into an actionable error instead of crashing at mount time.
 * @param ctx - the plugin context.
 * @returns whichever services this composition exposes.
 */
export function readMemberSessionServices(ctx: Context): MemberSessionServices {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return {}
  const read = (name: string): unknown => {
    try { return get.call(ctx, name) } catch { return undefined }
  }
  return {
    controller: read('sessionController') as MemberSessionController | undefined,
    registry: read('workspaceRegistry') as MemberSessionRegistry | undefined,
  }
}

/**
 * Why this composition cannot carry a member as an ordinary session.
 * @param services - services read from the running composition.
 * @returns the actionable reason, or undefined when both calls exist.
 */
export function memberSessionUnavailableReason(services: MemberSessionServices): string | undefined {
  if (typeof services.controller?.create !== 'function') {
    return 'this composition exposes no session controller, so members cannot be created as ordinary sessions; '
      + 'mount the session-controller service or set memberSessions to "subagent"'
  }
  if (typeof services.controller.prompt !== 'function') {
    return 'this composition exposes no session prompt API, so a session-mode member could be created but never woken; '
      + 'set memberSessions to "subagent"'
  }
  return undefined
}

/** How one session-mode member is created. */
export interface CreateMemberSessionRequest {
  /** Workspace directory the captain runs in; the member joins the same one. */
  cwd: string
  /** Persona prefix installed on the member session before its first turn. */
  persona: string
  /** Effective tool filter; undefined keeps the host default tool set. */
  toolFilter?: MemberToolFilter
  /** Member model route; undefined runs the composition default. */
  selection?: ModelSelection
  /** First turn text (the welcome message). */
  prompt: string
}

/** Created member session identity. */
export interface CreatedMemberSession {
  /** Durable ordinary session id; stored as `TeamMember.id`. */
  childId: string
  /** The live Agent, already configured and prompted. */
  agent: Agent
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
function installMemberSessionSetup(agent: Agent, request: CreateMemberSessionRequest): void {
  if (request.selection !== undefined) {
    installModelSelection(agent.ctx, { current: request.selection, assembled: undefined })
  }
  if (request.toolFilter !== undefined) agent.ctx.tools.restrict(request.toolFilter)
  agent.ctx.systemPrompt.section({
    name: 'deployment:persona-prefix',
    order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: request.persona,
  })
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
export async function createMemberSession(
  ctx: Context,
  services: MemberSessionServices,
  request: CreateMemberSessionRequest,
): Promise<CreatedMemberSession> {
  const unavailable = memberSessionUnavailableReason(services)
  if (unavailable !== undefined) throw new Error(`agent-teams: ${unavailable}`)
  const controller = services.controller as MemberSessionController & { create: NonNullable<MemberSessionController['create']> }
  let workspaceId: string | undefined
  if (typeof services.registry?.create === 'function') {
    try {
      workspaceId = (await services.registry.create(request.cwd, request.cwd)).id
    } catch (error: unknown) {
      // The workspace only groups the session in the UI; creation still works
      // from an explicit cwd.
      ctx.logger.warn(`agent-teams: could not resolve a workspace for member creation in ${request.cwd}: ${String(error)}`)
    }
  }
  const created = workspaceId === undefined
    ? await controller.create({ cwd: request.cwd })
    : await controller.create({ workspaceId })
  const sessionId = created.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('agent-teams: the session controller reported success without a member session id')
  }
  const agent = ctx.agents.get(sessionId as SessionId)
  if (agent === undefined) {
    throw new Error(`agent-teams: member session ${sessionId} was created but is not attached; it cannot receive its first turn`)
  }
  installMemberSessionSetup(agent, request)
  const accepted = await promptMemberSession(ctx, services, sessionId, request.prompt, 'queue')
  if (!accepted) {
    throw new Error(`agent-teams: member session ${sessionId} was created but its first turn was not accepted; the member would stay silent`)
  }
  return { childId: sessionId, agent }
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
function memberSessionFormatVersion(ctx: Context, sessionId: string): number | undefined {
  const live = ctx.agents.get(sessionId as SessionId)
  if (live !== undefined) return observedSessionFormatVersion(live)
  const attached: { header?: { version?: unknown } } | undefined = (ctx as unknown as {
    sessions?: { get?: (id: SessionId) => { header?: { version?: unknown } } | undefined }
  }).sessions?.get?.(sessionId as SessionId)
  return attached === undefined ? undefined : observedSessionFormatVersion({ session: attached })
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
export async function promptMemberSession(
  ctx: Context,
  services: MemberSessionServices,
  sessionId: string,
  text: string,
  mode: 'queue' | 'steer' = 'queue',
): Promise<boolean> {
  const controller = services.controller
  if (typeof controller?.prompt !== 'function') return false
  try {
    const accepted = await controller.prompt.call(controller, {
      sessionId,
      content: [{ type: 'text', text }],
      mode,
      requestId: randomUUID(),
    }, agentTeamsSource({ kind: 'agent-teams' }, memberSessionFormatVersion(ctx, sessionId)))
    return accepted?.accepted !== false
  } catch (error: unknown) {
    ctx.logger.warn(`agent-teams: prompt delivery to member session ${sessionId} failed: ${String(error)}`)
    return false
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
export function cancelMemberSession(ctx: Context, services: MemberSessionServices, sessionId: string): void {
  const controller = services.controller
  if (typeof controller?.cancel !== 'function') return
  try {
    controller.cancel.call(controller, { sessionId })
  } catch (error: unknown) {
    ctx.logger.warn(`agent-teams: cancel of member session ${sessionId} failed: ${String(error)}`)
  }
}
