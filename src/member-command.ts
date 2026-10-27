/**
 * One command execution path for member sessions (plan 10).
 *
 * The host's client-facing command API refuses every subagent-owned session, so
 * the plugin runs the member's own commands on the in-process bus instead. Both
 * the captain tool and the plugin's Remote surface call this function; the HTTP
 * routes keep their own status mapping but never re-implement the deny rules.
 *
 * Grammar is deliberately the host's, not stricter: a line the host would treat
 * as an ordinary prompt (uppercase, a space after the slash) reaches the bus and
 * comes back unclaimed, exactly as before.
 * @module dsh-agent-teams/member-command
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Canonical command name of one line; case-insensitive so deny cannot be dodged. */
export const MEMBER_COMMAND_NAME = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u

/** Longest accepted command line. */
export const MEMBER_COMMAND_MAX_LENGTH = 512

/** Stable failure codes of the command path. */
export type MemberCommandErrorCode = 'command/denied' | 'command/unknown'

/** A command line the member surface refuses before it reaches the bus. */
export class MemberCommandError extends Error {
  readonly code: MemberCommandErrorCode
  /** Canonical command name when the line named one. */
  readonly commandName?: string

  constructor(code: MemberCommandErrorCode, message: string, commandName?: string) {
    super(message)
    this.name = 'MemberCommandError'
    this.code = code
    if (commandName !== undefined) this.commandName = commandName
  }
}

/** The host command service as the plugin consumes it. */
export interface MemberCommandPort {
  execute(
    agent: Agent,
    line: string,
    attachments: readonly ContentBlock[],
    signal: AbortSignal,
  ): Promise<undefined | { commandId: string; result: { kind: 'success' | 'error'; text?: string } }>
}

/** Normalized outcome of one executed command line. */
export interface MemberCommandResult {
  readonly ok: boolean
  readonly kind: 'success' | 'error'
  readonly text?: string
  readonly commandId?: string
}

/**
 * Whether one canonical command name is denied for members, including the whole
 * `<name>-*` alias family.
 * @param name - canonical (lowercase) command name.
 * @param deny - normalized deny entries.
 */
export function isDeniedMemberCommand(name: string, deny: readonly string[]): boolean {
  return deny.some((denied) => name === denied || name.startsWith(`${denied}-`))
}

/**
 * Read one line's canonical command name and enforce the deny list.
 *
 * A line the host grammar does not recognize returns undefined instead of
 * failing: the bus is the authority on whether anything claims it.
 * @param line - raw line from the composer or the tool argument.
 * @param deny - normalized deny entries.
 * @returns the lowercase command name, or undefined when the grammar has none.
 * @throws MemberCommandError `command/denied` or `command/unknown` (length only).
 */
export function assertMemberCommandLine(line: string, deny: readonly string[]): string | undefined {
  const trimmed = line.trim()
  if (trimmed.length > MEMBER_COMMAND_MAX_LENGTH) {
    throw new MemberCommandError('command/unknown', `line is too long (${trimmed.length} > ${MEMBER_COMMAND_MAX_LENGTH} characters)`)
  }
  const name = MEMBER_COMMAND_NAME.exec(trimmed)?.[1]
  if (name !== undefined && isDeniedMemberCommand(name, deny)) {
    throw new MemberCommandError('command/denied', `command "${name}" is denied for members`, name)
  }
  return name
}

/**
 * Execute one member command line on the in-process bus.
 * @param input - command port, live member agent, line, attachments, signal, deny list, subject.
 * @returns the normalized outcome; an unclaimed line is an `ok: false` result.
 * @throws MemberCommandError `command/denied` or `command/unknown` (length only).
 */
export async function executeMemberCommand(input: {
  readonly commands: MemberCommandPort
  readonly agent: Agent
  readonly line: string
  readonly attachments?: readonly ContentBlock[]
  readonly signal: AbortSignal
  readonly deny?: readonly string[]
  /** Member display name used in the unclaimed-line text. */
  readonly subject?: string
}): Promise<MemberCommandResult> {
  assertMemberCommandLine(input.line, input.deny ?? [])
  const line = input.line.trim()
  const outcome = await input.commands.execute(input.agent, line, input.attachments ?? [], input.signal)
  if (outcome === undefined) {
    const where = input.subject === undefined ? '' : ` in member "${input.subject}"`
    return { ok: false, kind: 'error', text: `no registered command handled "${line}"${where}` }
  }
  return {
    ok: outcome.result.kind === 'success',
    kind: outcome.result.kind,
    ...(outcome.result.text === undefined ? {} : { text: outcome.result.text }),
    ...(outcome.commandId === undefined ? {} : { commandId: outcome.commandId }),
  }
}
