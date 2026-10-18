/**
 * Browser-side command surface for one member session (plan 01a).
 *
 * The generated remote client (`@deepseek-ai/dsh-commands/remote`) answers
 * with an envelope: `{ ok: true, value }` or
 * `{ ok: false, error: { code, message } }`. `commands/list` returns the
 * descriptors registered for that member's own session, and
 * `commands/execute` returns `undefined` when no command claimed the line.
 *
 * Every mapping below is a pure function over that wire shape, so offline
 * tests drive it without React or a DOM. The panel never hard-codes a command
 * catalog: each member row lists its own session, and the compact shortcut
 * executes the ordinary `/compact` line through the same path.
 * @module dsh-agent-teams/client/command-client
 */

/** Host route that queues plain text into one member's inbox. */
export const MEMBER_PROMPT_URL = '/plugins/dsh-agent-teams/member/prompt'

/** One command descriptor as `commands/list` reports it. */
export interface MemberCommand {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Human-readable summary shown next to the name. */
  readonly description: string
  /** Optional free-form input hint advertised by the command. */
  readonly hint?: string
}

/** Normalized outcome of one executed command line. */
export type MemberCommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/**
 * Why a dispatch produced no settled command result. The text is never a
 * hard-coded English sentence: the panel renders these through locale
 * templates.
 */
export type MemberCommandFailure =
  | { readonly kind: 'empty' }
  | { readonly kind: 'unclaimed'; readonly line: string }
  | { readonly kind: 'remote'; readonly code: string; readonly message: string }
  | { readonly kind: 'transport'; readonly detail: string }

/** One dispatch attempt: a settled result or a failure to report. */
export type MemberCommandDispatch =
  | { readonly kind: 'result'; readonly result: MemberCommandResult }
  | { readonly kind: 'failure'; readonly failure: MemberCommandFailure }

/** Outcome of reading the member's own command catalog. */
export type MemberCommandListOutcome =
  | { readonly kind: 'commands'; readonly commands: readonly MemberCommand[] }
  | { readonly kind: 'failure'; readonly failure: MemberCommandFailure }

/** Outcome of queueing plain text through the member prompt route. */
export type MemberPromptOutcome =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'failure'; readonly failure: MemberCommandFailure }

/**
 * The member session's own remote command face. Declared structurally so this
 * module stays independent of the host bundle: the plugin hands in whatever
 * `ctx.get('remote.commands')` resolved to and the shape is verified here.
 */
export interface MemberCommandsPort {
  list(sessionId: string): Promise<unknown>
  execute(sessionId: string, line: string, attachments: readonly unknown[]): Promise<unknown>
}

/** Everything the command bar needs to address exactly one member session. */
export interface MemberCommandTarget {
  /** Captain session id: the /state and /member/prompt routes resolve by it. */
  readonly sessionId: string
  readonly teamId: string
  /** Roster member name/key accepted by the prompt route. */
  readonly member: string
  /** Member (child) session id the command face is addressed by. */
  readonly memberSessionId: string
}

/** Minimal response shape the prompt route must satisfy (injectable for tests). */
export interface MemberPromptResponse {
  readonly ok: boolean
  readonly status: number
  json?(): Promise<unknown>
}

/** Injectable fetch used by the prompt path; defaults to the global fetch. */
export type MemberCommandFetch = (
  url: string,
  init: {
    readonly method: 'POST'
    readonly cache: 'no-store'
    readonly headers: Record<string, string>
    readonly body: string
  },
) => Promise<MemberPromptResponse>

/** Per-member command facade consumed by the panel. */
export interface MemberCommandClient {
  /** Read this member session's own catalog. */
  list(): Promise<MemberCommandListOutcome>
  /** Execute one command line on this member session. */
  run(line: string): Promise<MemberCommandDispatch>
  /** Queue plain text for this member through the host route. */
  send(text: string): Promise<MemberPromptOutcome>
}

let providedPort: MemberCommandsPort | undefined

/**
 * Structural check for the generated remote face. The value crosses an
 * untyped service boundary, so a host without `remote.commands` must be
 * rejected here instead of failing at the first click.
 */
export function isMemberCommandsPort(value: unknown): value is MemberCommandsPort {
  const candidate = value as { list?: unknown; execute?: unknown } | null | undefined
  return typeof candidate?.list === 'function' && typeof candidate?.execute === 'function'
}

/** Publish the plugin's remote command face (called once from the client plugin). */
export function provideMemberCommands(value: unknown): void {
  providedPort = isMemberCommandsPort(value) ? value : undefined
}

/** The currently published remote command face, or undefined when unavailable. */
export function activeMemberCommands(): MemberCommandsPort | undefined {
  return providedPort
}

/** `code`/`message` of a refused envelope, with stable fallbacks. */
export function envelopeFailure(envelope: unknown, fallbackCode = 'remote-error'): { code: string; message: string } {
  const error = (envelope as { error?: unknown } | null | undefined)?.error
  const record = typeof error === 'object' && error !== null ? error as { code?: unknown; message?: unknown } : undefined
  const code = typeof record?.code === 'string' && record.code.trim() !== '' ? record.code : fallbackCode
  const message = typeof record?.message === 'string' && record.message.trim() !== '' ? record.message : code
  return { code, message }
}

/** Read `value` from a successful envelope; anything else is a failure. */
export function envelopeValue(envelope: unknown): { ok: true; value: unknown } | { ok: false; failure: MemberCommandFailure } {
  if (typeof envelope !== 'object' || envelope === null) {
    return { ok: false, failure: { kind: 'transport', detail: 'malformed-envelope' } }
  }
  if ((envelope as { ok?: unknown }).ok !== true) {
    const { code, message } = envelopeFailure(envelope)
    return { ok: false, failure: { kind: 'remote', code, message } }
  }
  return { ok: true, value: (envelope as { value?: unknown }).value }
}

/** Parse the `commands/list` payload into panel rows; malformed entries drop. */
export function parseCommandList(value: unknown): readonly MemberCommand[] {
  if (!Array.isArray(value)) return []
  const commands: MemberCommand[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { name?: unknown; description?: unknown; input?: unknown }
    if (typeof record.name !== 'string' || record.name.trim() === '') continue
    const input = typeof record.input === 'object' && record.input !== null
      ? record.input as { hint?: unknown }
      : undefined
    commands.push({
      name: record.name.trim(),
      description: typeof record.description === 'string' ? record.description : '',
      hint: typeof input?.hint === 'string' && input.hint !== '' ? input.hint : undefined,
    })
  }
  return commands
}

/**
 * Map one `commands/execute` payload. `value === undefined` is the host's
 * "no command claimed this line" answer, kept distinct from a settled error so
 * the panel can say exactly that.
 */
export function parseCommandExecution(line: string, value: unknown): MemberCommandDispatch {
  if (value === undefined) return { kind: 'failure', failure: { kind: 'unclaimed', line } }
  if (typeof value !== 'object' || value === null) {
    return { kind: 'failure', failure: { kind: 'transport', detail: 'malformed-result' } }
  }
  const result = (value as { result?: unknown }).result
  if (typeof result !== 'object' || result === null) {
    return { kind: 'failure', failure: { kind: 'transport', detail: 'malformed-result' } }
  }
  const record = result as { kind?: unknown; text?: unknown }
  const text = typeof record.text === 'string' ? record.text : ''
  if (record.kind === 'error') return { kind: 'result', result: { kind: 'error', text } }
  if (record.kind === 'success') return { kind: 'result', result: { kind: 'success', text } }
  return { kind: 'failure', failure: { kind: 'transport', detail: 'malformed-result' } }
}

/**
 * Normalize a typed line for the command face. A bare word matching one of the
 * member's own command names gains its leading slash; anything else is passed
 * through verbatim so the host decides admission.
 */
export function commandLineFor(input: string, commands: readonly MemberCommand[]): string {
  const trimmed = input.trim()
  if (trimmed === '' || trimmed.startsWith('/')) return trimmed
  const head = trimmed.split(/\s/u)[0] ?? ''
  return commands.some((command) => command.name === head) ? `/${trimmed}` : trimmed
}

/** Draft text after picking a command from the member's own catalog. */
export function commandDraftFor(name: string): string {
  return `/${name} `
}

/** Trimmed plain text for the prompt route, or undefined when empty. */
export function promptTextFor(input: string): string | undefined {
  const text = input.trim()
  return text === '' ? undefined : text
}

/** Stable, locale-neutral token describing a thrown transport error. */
export function transportDetail(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'aborted'
  return 'network-error'
}

/** Host error text from a non-ok prompt response, when the body carries one. */
async function responseErrorText(response: MemberPromptResponse): Promise<string> {
  if (typeof response.json !== 'function') return ''
  try {
    const body = await response.json()
    const error = (body as { error?: unknown } | null)?.error
    return typeof error === 'string' ? error : ''
  } catch {
    return ''
  }
}

/**
 * Build the per-member command facade. All three calls address only
 * `target.memberSessionId`/`target.member`; there is no shared cache, so two
 * members can never see each other's catalog.
 */
export function createMemberCommandClient(
  port: MemberCommandsPort,
  target: MemberCommandTarget,
  fetchImpl: MemberCommandFetch = (url, init) => fetch(url, init),
): MemberCommandClient {
  return {
    async list(): Promise<MemberCommandListOutcome> {
      try {
        const envelope = await port.list(target.memberSessionId)
        const read = envelopeValue(envelope)
        if (!read.ok) return { kind: 'failure', failure: read.failure }
        return { kind: 'commands', commands: parseCommandList(read.value) }
      } catch (error: unknown) {
        return { kind: 'failure', failure: { kind: 'transport', detail: transportDetail(error) } }
      }
    },
    async run(line: string): Promise<MemberCommandDispatch> {
      const normalized = line.trim()
      if (normalized === '') return { kind: 'failure', failure: { kind: 'empty' } }
      try {
        const envelope = await port.execute(target.memberSessionId, normalized, [])
        const read = envelopeValue(envelope)
        if (!read.ok) return { kind: 'failure', failure: read.failure }
        return parseCommandExecution(normalized, read.value)
      } catch (error: unknown) {
        return { kind: 'failure', failure: { kind: 'transport', detail: transportDetail(error) } }
      }
    },
    async send(text: string): Promise<MemberPromptOutcome> {
      const trimmed = promptTextFor(text)
      if (trimmed === undefined) return { kind: 'failure', failure: { kind: 'empty' } }
      try {
        const response = await fetchImpl(MEMBER_PROMPT_URL, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: target.sessionId,
            teamId: target.teamId,
            member: target.member,
            text: trimmed,
          }),
        })
        if (response.ok) return { kind: 'delivered' }
        const message = await responseErrorText(response)
        return { kind: 'failure', failure: { kind: 'remote', code: `http-${response.status}`, message } }
      } catch (error: unknown) {
        return { kind: 'failure', failure: { kind: 'transport', detail: transportDetail(error) } }
      }
    },
  }
}
