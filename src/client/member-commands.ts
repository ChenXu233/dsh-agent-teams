/**
 * Native slash-command catalog for member conversations (plan 10, task 9).
 *
 * The host's client command surface refuses every addressed subagent session:
 * `ui-commands` returns an empty catalog for them and its execute path calls
 * `remote.commands.execute`, which the Host fences with
 * `ApiSessionSubagentOwnership`. The member composer therefore had to fake the
 * menu with `commandUi` contributions, which the host renders as completions
 * instead of commands — picking a row inserted the label on top of the typed
 * token (`/compact/compact`) and Enter replayed that broken line as a user
 * message.
 *
 * This module keeps the host's own menu and patches only the two remote calls
 * that answer for a member session:
 *
 * - `commands.list(sessionId)` returns the member's catalog from the plugin's
 *   `/member/commands` route (the in-process catalog, which the Host's
 *   session-scoped Remote refuses);
 * - `commands.execute(sessionId, line, attachments)` relays the line to
 *   `/member/relay`, which runs it on the in-process command bus against the
 *   member's Agent and returns the same `{ commandId, result }` shape.
 *
 * Everything else — the `/` menu, the insertion semantics, the replayed user
 * message, the lifecycle node — is the host's own.
 * @module dsh-agent-teams/client/member-commands
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ensureMembership, membershipOf } from './member-membership.ts'

const COMMANDS_URL = '/plugins/dsh-agent-teams/member/commands'
const RELAY_URL = '/plugins/dsh-agent-teams/member/relay'

/** One command descriptor as the host's Remote client expects it. */
export interface MemberCommandDescriptor {
  readonly name: string
  readonly description?: string
  readonly input?: { readonly hint?: string; readonly attachments?: boolean }
}

/** The host's Remote envelope. */
type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

interface CommandsFace {
  list?: (sessionId: string) => Promise<RemoteResult<readonly MemberCommandDescriptor[]>>
  execute?: (
    sessionId: string,
    line: string,
    attachments?: readonly unknown[],
  ) => Promise<RemoteResult<{ readonly commandId: string; readonly result: { readonly kind: 'success' | 'error'; readonly text?: string } } | undefined>>
}

/** Result of one installation attempt. */
export interface MemberCommands {
  readonly active: boolean
  readonly reason?: string
  dispose(): void
}

/** Transport used by the patch (injectable for tests). */
export interface MemberCommandDeps {
  readonly fetcher?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Map the plugin's flat catalog onto the host's descriptor shape. */
export function descriptorsOf(payload: unknown): MemberCommandDescriptor[] {
  if (!isRecord(payload) || !Array.isArray(payload['commands'])) return []
  const out: MemberCommandDescriptor[] = []
  for (const entry of payload['commands']) {
    if (!isRecord(entry)) continue
    const name = entry['name']
    if (typeof name !== 'string' || name === '') continue
    const description = entry['description']
    const hint = entry['hint']
    const attachments = entry['attachments']
    out.push({
      name,
      ...(typeof description === 'string' && description !== '' ? { description } : {}),
      ...(typeof hint === 'string' || typeof attachments === 'boolean'
        ? {
          input: {
            ...(typeof hint === 'string' && hint !== '' ? { hint } : {}),
            ...(typeof attachments === 'boolean' ? { attachments } : {}),
          },
        }
        : {}),
    })
  }
  return out
}

/**
 * Install the member command patch on this client context.
 * @param ctx - the plugin's client context.
 * @param deps - transport override for tests.
 * @returns the installation result; `dispose` restores both remote calls.
 */
export function installMemberCommands(ctx: ClientContext, deps: MemberCommandDeps = {}): MemberCommands {
  const fetcher = deps.fetcher ?? fetch
  const read = (name: string): unknown => {
    const getter = (ctx as unknown as { get?: (name: string) => unknown }).get
    if (typeof getter !== 'function') return undefined
    try {
      return getter.call(ctx, name)
    } catch {
      return undefined
    }
  }
  const sessions = read('sessions') as { subagentAddress?: (sessionId: string) => unknown } | undefined
  // ui-commands answers `[]` for every addressed subagent before it ever calls
  // the Remote, so the Remote patch alone never reaches the menu. The catalog
  // loader is the one field that gate lives behind; replacing it for member
  // sessions keeps every other subagent-aware surface (navigation, skills,
  // plans) on the host's own answer.
  const commandUi = read('commandUi')
  const directory = ((): { fetchCommands?: (sessionId: string) => Promise<readonly MemberCommandDescriptor[]> } | undefined => {
    if (!isRecord(commandUi)) return undefined
    const candidate = commandUi['directory']
    return isRecord(candidate) && typeof candidate['fetchCommands'] === 'function'
      ? candidate as { fetchCommands: (sessionId: string) => Promise<readonly MemberCommandDescriptor[]> }
      : undefined
  })()
  // `CommandUiRuntime.execute` is the client-side funnel every catalog command
  // goes through (`runDetached`, popup submits and enter adjudication). The
  // Remote face behind it is rebuilt per access, so patching that face never
  // reaches the host's call — the runtime method is the shared surface.
  const runtime = isRecord(commandUi) && typeof commandUi['execute'] === 'function'
    ? commandUi as {
      execute: (session: { readonly sessionId: string }, line: string, attachments?: readonly unknown[]) => Promise<{ readonly kind: 'success' | 'error'; readonly text?: string }>
    }
    : undefined
  const face = ((): CommandsFace | undefined => {
    const direct = read('remote.commands')
    if (isRecord(direct)) return direct as CommandsFace
    try {
      const remote = read('remote')
      if (!isRecord(remote)) return undefined
      const commands = remote['commands']
      return isRecord(commands) ? commands as CommandsFace : undefined
    } catch {
      return undefined
    }
  })()
  if (face === undefined || typeof face.list !== 'function' || typeof face.execute !== 'function') {
    return { active: false, reason: 'the remote commands service is unavailable', dispose() {} }
  }

  const isSubagent = (sessionId: string): boolean => {
    if (typeof sessions?.subagentAddress !== 'function') return false
    try {
      return sessions.subagentAddress(sessionId) !== undefined
    } catch {
      return false
    }
  }
  const eligible = (sessionId: string): boolean => {
    const verdict = membershipOf(sessionId)
    if (verdict === 'not-member') return false
    if (verdict === 'member' || verdict === 'member-archived') return true
    void ensureMembership(sessionId)
    return isSubagent(sessionId)
  }

  const originalList = face.list
  const originalExecute = face.execute

  const catalogOf = async (sessionId: string): Promise<readonly MemberCommandDescriptor[]> => {
    const response = await fetcher(`${COMMANDS_URL}?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`member catalog failed (HTTP ${response.status})`)
    return descriptorsOf(await response.json())
  }

  const relayLine = async (sessionId: string, line: string): Promise<{ readonly kind: 'success' | 'error'; readonly text?: string }> => {
    try {
      const response = await fetcher(RELAY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ memberSessionId: sessionId, line, mode: 'queue' }),
      })
      const payload = await response.json().catch(() => undefined) as unknown
      if (!response.ok) {
        const message = isRecord(payload) && typeof payload['error'] === 'string'
          ? payload['error']
          : `member command failed (HTTP ${response.status})`
        return { kind: 'error', text: message }
      }
      const result = isRecord(payload) && isRecord(payload['result']) ? payload['result'] : undefined
      return isRecord(result) && result['kind'] === 'error'
        ? { kind: 'error', ...(typeof result['text'] === 'string' ? { text: result['text'] } : {}) }
        : { kind: 'success' }
    } catch (error: unknown) {
      return { kind: 'error', text: String(error) }
    }
  }

  const originalExecuteRuntime = runtime?.execute
  if (runtime !== undefined && typeof originalExecuteRuntime === 'function') {
    runtime.execute = async (session, line, attachments) => {
      const sessionId = typeof session?.sessionId === 'string' ? session.sessionId : ''
      if (sessionId === '' || !eligible(sessionId)) return originalExecuteRuntime.call(runtime, session, line, attachments)
      return relayLine(sessionId, line)
    }
  }

  const originalFetchCommands = directory?.fetchCommands
  if (directory !== undefined && typeof originalFetchCommands === 'function') {
    directory.fetchCommands = async (sessionId: string) => {
      if (typeof sessionId !== 'string' || sessionId === '' || !eligible(sessionId)) {
        return originalFetchCommands.call(directory, sessionId)
      }
      return catalogOf(sessionId)
    }
  }

  face.list = async (sessionId: string) => {
    if (typeof sessionId !== 'string' || sessionId === '' || !eligible(sessionId)) {
      return originalList.call(face, sessionId)
    }
    try {
      return { ok: true, value: await catalogOf(sessionId) }
    } catch (error: unknown) {
      return { ok: false, error: { code: 'agent-teams/member-commands', message: String(error) } }
    }
  }

  face.execute = async (sessionId: string, line: string, attachments?: readonly unknown[]) => {
    if (typeof sessionId !== 'string' || sessionId === '' || !eligible(sessionId)) {
      return originalExecute.call(face, sessionId, line, attachments)
    }
    try {
      const response = await fetcher(RELAY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ memberSessionId: sessionId, line, mode: 'queue' }),
      })
      const payload = await response.json().catch(() => undefined) as unknown
      if (!response.ok) {
        const message = isRecord(payload) && typeof payload['error'] === 'string'
          ? payload['error']
          : `member command failed (HTTP ${response.status})`
        return { ok: false, error: { code: 'agent-teams/member-command', message } }
      }
      if (!isRecord(payload)) {
        return { ok: false, error: { code: 'agent-teams/member-command', message: 'the member command route returned no result' } }
      }
      return { ok: true, value: payload as never }
    } catch (error: unknown) {
      return { ok: false, error: { code: 'agent-teams/member-command', message: String(error) } }
    }
  }

  return {
    active: true,
    dispose: () => {
      face.list = originalList
      face.execute = originalExecute
      if (directory !== undefined && originalFetchCommands !== undefined) directory.fetchCommands = originalFetchCommands
      if (runtime !== undefined && originalExecuteRuntime !== undefined) runtime.execute = originalExecuteRuntime
    },
  }
}
