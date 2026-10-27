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

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { MemberAddressError, resolveMemberAddress, type MemberAddress } from './member-address.ts'
import { MemberCommandError, executeMemberCommand, isDeniedMemberCommand } from './member-command.ts'
import { deliverToMember, interruptMember } from './members.ts'
import { applyMemberRoute } from './member-route-registry.ts'

/** Wire namespace of the member surface. */
export const MEMBER_REMOTE_NAMESPACE = 'agentTeams'

/** Stable failure codes this service adds to the host map. */
export type MemberRemoteErrorCode =
  | 'member/not-found'
  | 'member/cold'
  | 'member/busy'
  | 'captain/offline'
  | 'command/denied'
  | 'command/unknown'

declare module '@deepseek-ai/dsh-typert-protocol/types' {
  interface RemoteErrorDetailsMap {
    'member/not-found': { readonly memberSessionId: string }
    'member/cold': { readonly memberSessionId: string }
    'member/busy': { readonly memberSessionId: string }
    'captain/offline': { readonly captainSessionId: string }
    'command/denied': { readonly command: string }
    'command/unknown': { readonly line: string }
  }
}

/** One member as the composer needs to see it. */
export interface MemberView {
  readonly member: string
  readonly teamId: string
  readonly live: boolean
  readonly running: boolean
  /** Halted teams keep their transcript readable but refuse new work. */
  readonly archived: boolean
  readonly model: { readonly provider: string; readonly model: string } | null
  readonly queued: number
}

/** One command descriptor offered by the member's own session. */
export interface MemberCommandView {
  readonly name: string
  readonly description?: string
  readonly hint?: string
  readonly attachments?: boolean
}

/** Normalized command outcome; an unclaimed line is `ok: false`. */
export interface MemberCommandOutcome {
  readonly ok: boolean
  readonly kind: 'success' | 'error'
  readonly text?: string
  readonly commandId?: string
}

/** Delivery acknowledgement of one plain-text prompt. */
export interface MemberPromptOutcome {
  readonly delivered: boolean
}

/** Pending input of one member. */
export interface MemberQueueView {
  readonly running: boolean
  readonly items: readonly { readonly id: string; readonly preview: string }[]
}

/** Interrupt acknowledgement. */
export interface MemberInterruptOutcome {
  readonly accepted: boolean
}

/** Installed model selection. */
export interface MemberModelOutcome {
  readonly provider: string
  readonly model: string
}

/** Construction options carried from the plugin config. */
export interface MemberRemoteOptions {
  readonly stateDir: string
  readonly deny: readonly string[]
}

/** Host command service as this module consumes it. */
interface HostCommands {
  list(agent: Agent): readonly { name: string; description?: string; input?: { hint?: string; attachments?: boolean } }[]
  execute(
    agent: Agent,
    line: string,
    attachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<undefined | { commandId: string; result: { kind: 'success' | 'error'; text?: string } }>
}

/** Bounded idempotency window for request ids. */
const REQUEST_WINDOW = 128

/** Build the membership view from one resolved address and its live Agent. */
export function memberViewOf(resolved: { member: { name: string }; team: { id: string; halted?: boolean } }, agent: Agent | undefined): MemberView {
  const model = agent?.options.provider !== undefined && agent.options.model !== undefined
    ? { provider: agent.options.provider, model: agent.options.model }
    : null
  return {
    member: resolved.member.name,
    teamId: resolved.team.id,
    live: agent !== undefined,
    running: agent?.status === 'running',
    archived: resolved.team.halted === true,
    model,
    queued: agent === undefined ? 0 : agent.inbox.nextTurn.length + agent.inbox.nextStep.length,
  }
}

/** Build the pending-input view from one live Agent. */
export function queueViewOf(agent: Agent | undefined): MemberQueueView {
  if (agent === undefined) return { running: false, items: [] }
  const items = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].map((message) => ({
    id: message.id,
    preview: message.content
      .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
      .join(' ')
      .slice(0, 80),
  }))
  return { running: agent.status === 'running', items }
}

/** Translate one address failure into the wire failure the client expects. */
export function remoteAddressError(error: unknown, address: MemberAddress): unknown {
  if (error instanceof MemberAddressError) {
    if (error.code === 'captain/offline') {
      return new RemoteError('captain/offline', error.message, { captainSessionId: address.captainSessionId })
    }
    return new RemoteError('member/not-found', error.message, { memberSessionId: address.memberSessionId })
  }
  return error
}

/**
 * Member command and control surface.
 *
 * Every method resolves the address first and then delegates; no method resumes
 * an Agent, and a command that needs a live idle member reports `member/cold`
 * instead of waking one.
 */
export class MemberRemoteService extends TypertRemoteService {
  readonly #options: MemberRemoteOptions
  readonly #requests = new Map<string, unknown>()

  constructor(ctx: Context, options: MemberRemoteOptions) {
    super(ctx, 'memberRemote', { namespace: MEMBER_REMOTE_NAMESPACE })
    this.#options = options
  }

  /** Resolve one address or translate the domain failure into a Remote failure. */
  async #resolve(captainSessionId: string, memberSessionId: string) {
    try {
      return await resolveMemberAddress(this.ctx, { captainSessionId, memberSessionId }, this.#options.stateDir)
    } catch (error: unknown) {
      throw remoteAddressError(error, { captainSessionId, memberSessionId })
    }
  }

  /** Live member Agent or a `member/cold` failure. */
  #live(memberSessionId: string): Agent {
    const agent = this.ctx.agents.get(memberSessionId as never)
    if (agent === undefined) {
      throw new RemoteError('member/cold', `member agent "${memberSessionId}" is not resident`, { memberSessionId })
    }
    return agent
  }

  /** The host command service, or an actionable failure. */
  #commands(): HostCommands {
    const commands = (this.ctx as unknown as { get?: (name: string) => unknown }).get?.('commands') as HostCommands | undefined
    if (commands === undefined) throw new RemoteError('gateway/internal', 'the host command service is not composed', {})
    return commands
  }

  /** Remember one request outcome so a retried request id returns the same value. */
  #remember<T>(requestId: string | undefined, value: T): T {
    if (requestId === undefined) return value
    this.#requests.set(requestId, value)
    while (this.#requests.size > REQUEST_WINDOW) {
      const oldest = this.#requests.keys().next().value
      if (oldest === undefined) break
      this.#requests.delete(oldest)
    }
    return value
  }

  /** Membership signal, live state and pending work of one member. */
  @Remote('resolveMember')
  async resolveMember(captainSessionId: string, memberSessionId: string): Promise<MemberView> {
    const resolved = await this.#resolve(captainSessionId, memberSessionId)
    return memberViewOf(resolved, this.ctx.agents.get(memberSessionId as never))
  }

  /** Commands this member's own session offers, minus the deny list. */
  @Remote('listCommands')
  async listCommands(captainSessionId: string, memberSessionId: string): Promise<readonly MemberCommandView[]> {
    await this.#resolve(captainSessionId, memberSessionId)
    const agent = this.#live(memberSessionId)
    return this.#commands().list(agent)
      .filter((descriptor) => !isDeniedMemberCommand(descriptor.name, this.#options.deny))
      .map((descriptor) => ({
        name: descriptor.name,
        ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
        ...(descriptor.input?.hint === undefined ? {} : { hint: descriptor.input.hint }),
        ...(descriptor.input?.attachments === undefined ? {} : { attachments: descriptor.input.attachments }),
      }))
  }

  /** Run one command line inside the member's own session. */
  @Remote('execute')
  async execute(
    captainSessionId: string,
    memberSessionId: string,
    line: string,
    requestId?: string,
  ): Promise<MemberCommandOutcome> {
    const cached = requestId === undefined ? undefined : this.#requests.get(requestId)
    if (cached !== undefined) return cached as MemberCommandOutcome
    await this.#resolve(captainSessionId, memberSessionId)
    const agent = this.#live(memberSessionId)
    try {
      const outcome = await executeMemberCommand({
        commands: this.#commands(),
        agent,
        line,
        signal: new AbortController().signal,
        deny: this.#options.deny,
      })
      return this.#remember(requestId, outcome)
    } catch (error: unknown) {
      if (error instanceof MemberCommandError) {
        if (error.code === 'command/denied') throw new RemoteError('command/denied', error.message, { command: error.commandName ?? '' })
        throw new RemoteError('command/unknown', error.message, { line })
      }
      throw error
    }
  }

  /** Deliver one plain-text prompt through the captain's channel. */
  @Remote('prompt')
  async prompt(
    captainSessionId: string,
    memberSessionId: string,
    text: string,
    mode: 'queue' | 'steer' = 'queue',
    requestId?: string,
  ): Promise<MemberPromptOutcome> {
    const cached = requestId === undefined ? undefined : this.#requests.get(requestId)
    if (cached !== undefined) return cached as MemberPromptOutcome
    const resolved = await this.#resolve(captainSessionId, memberSessionId)
    if (resolved.team.halted === true) {
      throw new RemoteError('member/busy', `team "${resolved.team.name}" is halted`, { memberSessionId })
    }
    const delivered = await deliverToMember(
      this.ctx,
      resolved.captain,
      memberSessionId,
      text,
      new AbortController().signal,
      mode,
    )
    return this.#remember(requestId, { delivered })
  }

  /** Install a new model selection on a resident member. */
  @Remote('selectModel')
  async selectModel(
    captainSessionId: string,
    memberSessionId: string,
    provider: string,
    model: string,
    reasoningEffort?: string,
  ): Promise<MemberModelOutcome> {
    await this.#resolve(captainSessionId, memberSessionId)
    this.#live(memberSessionId)
    const applied = applyMemberRoute(memberSessionId, {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })
    if (!applied) {
      throw new RemoteError('member/cold', `member "${memberSessionId}" has no live model selection`, { memberSessionId })
    }
    return { provider, model }
  }

  /** Interrupt the member's current turn. */
  @Remote('interrupt')
  async interrupt(captainSessionId: string, memberSessionId: string): Promise<MemberInterruptOutcome> {
    const resolved = await this.#resolve(captainSessionId, memberSessionId)
    interruptMember(this.ctx, resolved.captain, memberSessionId)
    return { accepted: true }
  }

  /** Pending input of one member. */
  @Remote('queue')
  async queue(captainSessionId: string, memberSessionId: string): Promise<MemberQueueView> {
    await this.#resolve(captainSessionId, memberSessionId)
    return queueViewOf(this.ctx.agents.get(memberSessionId as never))
  }
}
