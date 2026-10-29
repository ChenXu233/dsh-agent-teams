/**
 * Native model seat for member conversations (plan 10, task 9).
 *
 * The host composer already owns the model pill, its catalog menu, the effort
 * submenu and the error surface — but ui-model-selection hides all of it for
 * any session `sessions.subagentAddress()` answers for, and its `selectModel`
 * Remote refuses subagent-owned sessions. Team members are continuable
 * subagents, so their page lost the seat entirely.
 *
 * This module keeps the host's own pill and patches only the three places that
 * answer for a member session:
 *
 * - `modelDirectories.directoryFor` marks the directory selectable and points
 *   its projection at the member's durable route instead of a history face the
 *   member page never writes;
 * - the `conversation.input.model` slot registration flips `available` and
 *   re-points `load`/`select` at that directory (patched on the stored entry,
 *   so registration order does not matter);
 * - the remote session face's `selectModel` relays the choice to the plugin's
 *   `/member/model` route instead of the fenced Session Remote.
 *
 * Every patch is structural and optional: a host that renamed or removed one of
 * these surfaces leaves `active === false` and the caller keeps its own
 * fallback control.
 * @module dsh-agent-teams/client/member-seat
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ensureMembership, membershipOf } from './member-membership.ts'

/** One provider/model/effort route as the host menu expresses it. */
export interface MemberSeatSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Server transport the seat relays through. */
export interface MemberSeatDeps {
  /** The member's current durable route, or undefined when it has none. */
  readonly readSelection: (sessionId: string) => Promise<MemberSeatSelection | undefined>
  /** Apply one route to the member; resolves with the plugin's answer. */
  readonly writeSelection: (
    sessionId: string,
    selection: MemberSeatSelection,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>
}

/** Result of one installation attempt. */
export interface MemberSeat {
  /** Whether the host surfaces were found and patched. */
  readonly active: boolean
  /** Why the seat stayed inactive, for the caller's fallback. */
  readonly reason?: string
  dispose(): void
}

/** Slot key the host renders the model pill in. */
export const MODEL_SLOT = 'conversation.input.model'

interface SeatFace {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

interface SeatDirectory {
  available?: () => boolean
  projected?: SeatFace
  sessions?: { selectModel?: (params: SelectModelParams) => Promise<unknown> }
  store: SeatFace
  syncInputs?: () => void
  load?: () => Promise<unknown>
  select?: (selection: unknown) => Promise<unknown>
}

interface SelectModelParams {
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

interface SlotEntry {
  inject?: ((...args: never[]) => Record<string, unknown>) | undefined
}

interface SlotsService {
  register?: (options: unknown, component: unknown) => () => void
  entries?: (key: string) => readonly SlotEntry[]
  entriesOfSlot?: (key: string) => readonly SlotEntry[]
  subscribe?: (key: string, listener: () => void) => () => void
}

interface ModelDirectoriesService {
  directoryFor(sessionId: string): SeatDirectory
}

interface SeatRecord {
  readonly directory: SeatDirectory
  readonly real: SeatFace | undefined
  readonly listeners: Set<() => void>
  override?: MemberSeatSelection
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFace(value: unknown): value is SeatFace {
  return isRecord(value) && typeof value['getSnapshot'] === 'function' && typeof value['subscribe'] === 'function'
}

/** Read a selection out of a projection snapshot, when it carries one. */
function selectionOf(value: unknown): MemberSeatSelection | undefined {
  if (!isRecord(value)) return undefined
  const provider = value['provider']
  const model = value['model']
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  const effort = value['reasoningEffort']
  return {
    provider,
    model,
    ...(typeof effort === 'string' && effort !== '' ? { reasoningEffort: effort } : {}),
  }
}

function sameSelection(left: MemberSeatSelection | undefined, right: MemberSeatSelection | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.provider === right.provider
    && left.model === right.model
    && (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')
}

/**
 * Install the member model seat on this client context.
 * @param ctx - the plugin's client context.
 * @param deps - server transport for reading and writing the member route.
 * @returns the installation result; `dispose` restores every patched surface.
 */
export function installMemberSeat(ctx: ClientContext, deps: MemberSeatDeps): MemberSeat {
  const read = (name: string): unknown => {
    const getter = (ctx as unknown as { get?: (name: string) => unknown }).get
    if (typeof getter !== 'function') return undefined
    try {
      return getter.call(ctx, name)
    } catch {
      return undefined
    }
  }
  const models = read('modelDirectories') as ModelDirectoriesService | undefined
  const slots = read('slots') as SlotsService | undefined
  const sessions = read('sessions') as { subagentAddress?: (sessionId: string) => unknown } | undefined
  // `remote.session` is a cordis service property: reading it off the `remote`
  // service throws unless this context injected it. The registry read of the
  // dotted name is the unguarded path.
  const remoteSession = ((): { selectModel?: (params: SelectModelParams) => Promise<unknown> } | undefined => {
    const direct = read('remote.session')
    if (isRecord(direct)) return direct as { selectModel?: (params: SelectModelParams) => Promise<unknown> }
    try {
      const remote = read('remote')
      if (!isRecord(remote)) return undefined
      const face = remote['session']
      return isRecord(face) ? face as { selectModel?: (params: SelectModelParams) => Promise<unknown> } : undefined
    } catch {
      return undefined
    }
  })()

  if (models === undefined || typeof models.directoryFor !== 'function') {
    return { active: false, reason: 'the modelDirectories service is unavailable', dispose() {} }
  }
  if (slots === undefined) {
    return { active: false, reason: 'the slots service is unavailable', dispose() {} }
  }

  const restores: (() => void)[] = []
  const seats = new Map<string, SeatRecord>()
  const patchedFaces = new WeakSet<object>()

  const isSubagent = (sessionId: string): boolean => {
    if (typeof sessions?.subagentAddress !== 'function') return false
    try {
      return sessions.subagentAddress(sessionId) !== undefined
    } catch {
      return false
    }
  }

  /** Member, archived member, or an unclassified subagent child. */
  const eligible = (sessionId: string): boolean => {
    const verdict = membershipOf(sessionId)
    if (verdict === 'not-member') return false
    if (verdict === 'member' || verdict === 'member-archived') return true
    void ensureMembership(sessionId)
    return isSubagent(sessionId)
  }

  const applyOverride = (record: SeatRecord, selection: MemberSeatSelection): void => {
    record.override = selection
    record.directory.syncInputs?.()
    for (const listener of [...record.listeners]) {
      try {
        listener()
      } catch {
        // A failing subscriber must not break the switch.
      }
    }
  }

  /** The projection the host pill reads: the member's route, else its history. */
  const seatFor = (sessionId: string, directory: SeatDirectory): SeatRecord => {
    const existing = seats.get(sessionId)
    if (existing !== undefined && existing.directory === directory) return existing
    const real = isFace(directory.projected) ? directory.projected : undefined
    const record: SeatRecord = { directory, real, listeners: new Set() }
    const face: SeatFace = {
      getSnapshot: () => {
        const snapshot = real?.getSnapshot()
        const next = isRecord(snapshot) ? selectionOf(snapshot['next']) : undefined
        if (record.override !== undefined && sameSelection(next, record.override)) record.override = undefined
        if (record.override === undefined) return snapshot ?? {}
        return { ...(isRecord(snapshot) ? snapshot : {}), next: record.override }
      },
      subscribe: (listener) => {
        record.listeners.add(listener)
        const off = real?.subscribe(listener)
        return () => {
          record.listeners.delete(listener)
          off?.()
        }
      },
    }
    directory.projected = face
    directory.available = () => true
    seats.set(sessionId, record)
    // The host reads its route from history; a member page never writes that
    // history, so the durable roster is the only source for a cold member.
    void deps.readSelection(sessionId).then((selection) => {
      if (selection !== undefined) applyOverride(record, selection)
    }).catch(() => undefined)
    // The host's own directory captured the remote session face; `select` calls
    // `this.sessions.selectModel`, so the instance field is replaced with a
    // relay. The face itself is a remote proxy whose methods are accessors:
    // assigning onto it throws, which is why the field swap is the reliable
    // patch (the host's own bookkeeping — pending/error/tracking — is kept).
    const captured = directory.sessions
    if (isRecord(captured) && typeof captured.selectModel === 'function') {
      try {
        directory.sessions = { selectModel: (params: SelectModelParams) => relaySelect(sessionId, params) }
      } catch {
        patchSelectModel(captured)
      }
    }
    return record
  }

  const relaySelect = async (sessionId: string, params: SelectModelParams): Promise<unknown> => {
    const selection: MemberSeatSelection = {
      provider: params.provider,
      model: params.model,
      ...(typeof params.reasoningEffort === 'string' && params.reasoningEffort !== ''
        ? { reasoningEffort: params.reasoningEffort }
        : {}),
    }
    const result = await deps.writeSelection(sessionId, selection)
    if (!result.ok) {
      return { ok: false, error: { code: 'agent-teams/member-model', message: result.message } }
    }
    const record = seats.get(sessionId)
    if (record !== undefined) applyOverride(record, selection)
    return { ok: true, value: { selected: selection } }
  }

  const patchSelectModel = (face: { selectModel?: (params: SelectModelParams) => Promise<unknown> }): void => {
    if (patchedFaces.has(face)) return
    const original = face.selectModel
    if (typeof original !== 'function') return
    try {
      face.selectModel = function patchedSelectModel(this: unknown, params: SelectModelParams) {
        const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : ''
        if (sessionId === '' || !eligible(sessionId)) return original.call(this, params)
        return relaySelect(sessionId, params)
      }
      patchedFaces.add(face)
      restores.push(() => { face.selectModel = original })
    } catch {
      // A frozen face keeps the host path; the caller's fallback still applies.
    }
  }

  // Directory resolution is the first host call for a session, so the
  // projection and the remote face are patched before the pill ever reads them.
  const originalDirectoryFor = models.directoryFor
  try {
    models.directoryFor = function patchedDirectoryFor(this: ModelDirectoriesService, sessionId: string) {
      const directory = originalDirectoryFor.call(this, sessionId)
      if (typeof sessionId !== 'string' || sessionId === '' || !isRecord(directory)) return directory
      if (!eligible(sessionId)) return directory
      return seatFor(sessionId, directory).directory
    }
    restores.push(() => { models.directoryFor = originalDirectoryFor })
  } catch {
    return { active: false, reason: 'the modelDirectories service is not patchable', dispose() {} }
  }

  const wrapInject = (original: (...args: never[]) => Record<string, unknown>) =>
    function patchedInject(this: unknown, ...args: never[]): Record<string, unknown> {
      const view = original.apply(this, args)
      const sessionId = typeof args[0] === 'string' ? args[0] as string : ''
      if (!isRecord(view) || sessionId === '') return view
      if (view['available'] !== false) return view
      if (!eligible(sessionId)) return view
      const directory = models.directoryFor(sessionId)
      return {
        ...view,
        available: true,
        directory: directory.store,
        load: () => { void directory.load?.().catch(() => undefined) },
        select: (selection: unknown) => directory.select?.(selection) ?? Promise.resolve(undefined),
      }
    }

  const patchedEntries = new WeakSet<object>()
  const patchEntry = (entry: SlotEntry): void => {
    if (!isRecord(entry) || patchedEntries.has(entry)) return
    const original = entry.inject as ((...args: never[]) => Record<string, unknown>) | undefined
    if (typeof original !== 'function') return
    try {
      entry.inject = wrapInject(original) as never
      patchedEntries.add(entry)
      restores.push(() => { entry.inject = original })
    } catch {
      // Frozen entry: the host keeps its own inject.
    }
  }
  const patchRegistered = (): void => {
    try {
      for (const entry of slots.entries?.(MODEL_SLOT) ?? []) patchEntry(entry)
    } catch {
      // Older hosts expose only entriesOfSlot.
    }
    try {
      for (const entry of slots.entriesOfSlot?.(MODEL_SLOT) ?? []) patchEntry(entry)
    } catch {
      // No such surface: registrations that arrive later are patched below.
    }
  }

  patchRegistered()
  if (typeof slots.subscribe === 'function') {
    try {
      const off = slots.subscribe(MODEL_SLOT, patchRegistered)
      restores.push(() => { off() })
    } catch {
      // The slot is declared later in boot: the register wrapper below still
      // sees the host registration when it arrives.
    }
  }
  const originalRegister = slots.register
  if (typeof originalRegister === 'function') {
    try {
      slots.register = function patchedRegister(this: SlotsService, options: unknown, component: unknown) {
        const dispose = originalRegister.call(this, options, component)
        patchRegistered()
        return dispose
      }
      restores.push(() => { slots.register = originalRegister })
    } catch {
      // Registration-order fallback only; existing entries are already patched.
    }
  }

  // Belt and braces: hosts that hand the resolver a face we never saw through a
  // directory still relay through the service's own session face.
  if (isRecord(remoteSession)) patchSelectModel(remoteSession)

  return {
    active: true,
    dispose: () => {
      for (const restore of restores.reverse()) {
        try {
          restore()
        } catch {
          // Best effort: a disposed host surface is already gone.
        }
      }
      restores.length = 0
      seats.clear()
    },
  }
}
const STATE_URL = '/plugins/dsh-agent-teams/member/state'
const MODEL_URL = '/plugins/dsh-agent-teams/member/model'

/**
 * Read the member's durable route through the plugin's own route.
 * @param sessionId - member child session.
 * @param fetcher - fetch override for tests.
 * @returns the route, or undefined when the session is not a member.
 */
export async function fetchMemberSelection(
  sessionId: string,
  fetcher: typeof fetch = fetch,
): Promise<MemberSeatSelection | undefined> {
  const response = await fetcher(`${STATE_URL}?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
  if (!response.ok) return undefined
  const payload = await response.json() as { view?: { model?: { provider?: unknown; model?: unknown } | null; reasoningEffort?: unknown } }
  const model = payload.view?.model
  if (model === null || model === undefined) return undefined
  const provider = typeof model.provider === 'string' ? model.provider : ''
  const id = typeof model.model === 'string' ? model.model : ''
  if (provider === '' || id === '') return undefined
  const effort = payload.view?.reasoningEffort
  return {
    provider,
    model: id,
    ...(typeof effort === 'string' && effort !== '' ? { reasoningEffort: effort } : {}),
  }
}

/**
 * Apply one route to the member through the plugin's own route.
 * @param sessionId - member child session.
 * @param selection - provider, model and optional pinned effort.
 * @param fetcher - fetch override for tests.
 * @returns the plugin's answer, normalized for the host menu.
 */
export async function applyMemberSelection(
  sessionId: string,
  selection: MemberSeatSelection,
  fetcher: typeof fetch = fetch,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  try {
    const response = await fetcher(MODEL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      }),
    })
    if (response.ok) return { ok: true }
    const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined
    const message = typeof payload?.error === 'string' ? payload.error : `model switch failed (HTTP ${response.status})`
    return { ok: false, message }
  } catch (error: unknown) {
    return { ok: false, message: `model switch failed: ${String(error)}` }
  }
}
