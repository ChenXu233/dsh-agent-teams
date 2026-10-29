/**
 * Member controls docked above the host composer (plan 10, revised).
 *
 * The host composer keeps the conversation: it is the native input, keyboard
 * and styling, and the host already supports steering continuable subagents.
 * What it cannot do for a member is switch the model, show the member queue or
 * stop the member — those are member-specific and go into the host's additive
 * `conversation.input.dock` slot, the same slot the host uses for its queue and
 * todo docks.
 *
 * The member's command catalog is registered into the host's `commandUi`
 * registry instead of being reimplemented: the host renders the `/` menu, we
 * only say which entries exist for this member session and what they run.
 * @module dsh-agent-teams/client/MemberDock
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelDirectoryResolver } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { MenuCommand } from './member-menu.ts'
import {
  modelLabel,
  modelOptionKey,
  modelOptions,
  queuedLabel,
  stopEnabled,
  withCurrentOption,
  type MemberControlView,
  type MemberModelGroup,
} from './member-controls.ts'

const STATE_URL = '/plugins/dsh-agent-teams/member/state'
const COMMANDS_URL = '/plugins/dsh-agent-teams/member/commands'
const MODEL_URL = '/plugins/dsh-agent-teams/member/model'
const STOP_URL = '/plugins/dsh-agent-teams/member/stop'
const RELAY_URL = '/plugins/dsh-agent-teams/member/relay'

/** Structural view of the host's client command registry. */
export interface CommandUiHandle {
  register(definition: {
    readonly name: string
    readonly label: () => string
    readonly available: (session: { readonly sessionId: string }) => boolean
    readonly ui: { readonly kind: 'action'; readonly run: (session: { readonly sessionId: string }) => void }
  }): () => void
}

export interface MemberDockProps {
  readonly sessionId: string
  readonly modelDirectories?: ModelDirectoryResolver
  readonly commandUi?: { readonly current?: CommandUiHandle }
  /**
   * The host's own model seat already renders for this session (plan 10, task
   * 9). The dock then keeps only what the host has no seat for: the member
   * queue badge and the stop control.
   */
  readonly modelSeatActive?: boolean
}

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'nowrap',
  fontSize: 12,
  color: 'var(--dsw-alias-label-caption, inherit)',
}
/** Same pill language as the host's own composer controls (313:14108). */
const pill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  height: 28,
  padding: '0 10px',
  borderRadius: 999,
  border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.3))',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, inherit)',
  font: 'inherit',
  fontSize: 12,
  lineHeight: 1,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
const control: CSSProperties = { ...pill }
const hint: CSSProperties = { opacity: 0.7 }

/** Relay one line to this member; commands execute on the member's session. */
async function relay(sessionId: string, line: string): Promise<void> {
  await fetch(RELAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, line, mode: 'queue' }),
  })
}

/**
 * One compact control row for a member conversation, plus the member's command
 * catalog in the host's `/` menu. Renders nothing for a non-member session.
 */
export function MemberDock({ sessionId, modelDirectories, commandUi, modelSeatActive = false }: MemberDockProps) {
  const [view, setView] = useState<MemberControlView | undefined>(undefined)
  const [groups, setGroups] = useState<readonly MemberModelGroup[]>([])
  const [commands, setCommands] = useState<readonly MenuCommand[]>([])
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState<string | undefined>(undefined)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${STATE_URL}?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
      if (!response.ok) {
        if (alive.current) setView(undefined)
        return
      }
      const payload = await response.json() as { view?: MemberControlView }
      if (alive.current) setView(payload.view ?? {})
    } catch {
      // Keep the last known state; the controls stay usable.
    }
  }, [sessionId])

  useEffect(() => {
    alive.current = true
    void refresh()
    const onFocus = (): void => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { alive.current = false; window.removeEventListener('focus', onFocus) }
  }, [refresh])

  // Command catalog for this member: fetched once, registered into the host's
  // menu so `/` is rendered by the host itself.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`${COMMANDS_URL}?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
        if (!response.ok) return
        const payload = await response.json() as { commands?: MenuCommand[] }
        if (!cancelled && Array.isArray(payload.commands)) setCommands(payload.commands)
      } catch {
        // No catalog: the host menu keeps whatever it already has.
      }
    })()
    return () => { cancelled = true }
  }, [sessionId])

  useEffect(() => {
    const registry = commandUi?.current
    if (registry === undefined || commands.length === 0) return
    const disposers = commands.map((command) => registry.register({
      name: command.name,
      label: () => `/${command.name}`,
      available: (session) => session.sessionId === sessionId,
      ui: { kind: 'action', run: () => { void relay(sessionId, `/${command.name}`) } },
    }))
    return () => { for (const dispose of disposers) dispose() }
  }, [commands, commandUi, sessionId])

  const directory = useMemo(() => {
    try {
      return modelDirectories?.directoryFor(sessionId as never)
    } catch {
      return undefined
    }
  }, [modelDirectories, sessionId])

  useEffect(() => {
    if (directory === undefined) return
    let cancelled = false
    void directory.load().then((state) => {
      if (!cancelled) setGroups(state.groups)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [directory])

  const options = useMemo(() => withCurrentOption(modelOptions(groups), view ?? {}), [groups, view])
  const currentKey = view?.model === null || view?.model === undefined
    ? ''
    : modelOptionKey(view.model.provider, view.model.model)
  const queued = queuedLabel(view?.queued)
  const canStop = view !== undefined && stopEnabled(view)
  const archived = view?.archived === true

  const switchModel = useCallback((key: string) => {
    const option = options.find((candidate) => candidate.key === key)
    if (option === undefined || busy) return
    setBusy(true)
    void (async () => {
      try {
        const response = await fetch(MODEL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, provider: option.provider, model: option.model }),
        })
        const payload = await response.json().catch(() => undefined) as { error?: string } | undefined
        setFeedback(response.ok ? `已切换到 ${option.label}` : payload?.error ?? `切换失败（HTTP ${response.status}）`)
        if (response.ok) await refresh()
      } catch (error: unknown) {
        setFeedback(`切换失败：${String(error)}`)
      } finally {
        setBusy(false)
      }
    })()
  }, [busy, options, refresh, sessionId])

  const stop = useCallback(() => {
    if (busy) return
    setBusy(true)
    void (async () => {
      try {
        const response = await fetch(STOP_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        const payload = await response.json().catch(() => undefined) as { error?: string } | undefined
        setFeedback(response.ok ? '已请求停止' : payload?.error ?? `停止失败（HTTP ${response.status}）`)
        await refresh()
      } catch (error: unknown) {
        setFeedback(`停止失败：${String(error)}`)
      } finally {
        setBusy(false)
      }
    })()
  }, [busy, refresh, sessionId])

  if (view === undefined) return null
  // Rendered inside the host composer's own standardControls cluster, next to
  // where the host draws its model seat, so it uses the same pill language.
  const modelItems: MenuEntry[] = options.map((option) => ({ id: option.key, label: option.label }))
  // Prefer the catalog's display name; a cold member may have no directory, so
  // fall back to the durable model id plus its pinned effort.
  const shownLabel = options.find((option) => option.key === currentKey)?.short
    ?? (view.model === null || view.model === undefined
      ? modelLabel(view)
      : `${view.model.model}${view.reasoningEffort === undefined ? '' : ` · ${view.reasoningEffort}`}`)
  return (
    <div style={row} data-agent-teams-member-dock={sessionId}>
      {archived
        ? <span style={hint}>已归档 · 只读</span>
        : (
          <>
            {modelSeatActive ? null : <Menu
              open={open}
              portal
              align="end"
              compact
              items={modelItems}
              selectedId={currentKey}
              onSelect={(id: string) => { setOpen(false); switchModel(id) }}
              onClose={() => setOpen(false)}
              anchor={(
                <button
                  type="button"
                  style={pill}
                  disabled={busy || options.length === 0}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  aria-label={modelLabel(view)}
                  title={modelLabel(view)}
                  onClick={() => setOpen((value) => !value)}
                >
                  {shownLabel}
                  <span aria-hidden>▾</span>
                </button>
              )}
            />}
            {queued === undefined ? null : <span style={hint}>{queued}</span>}
            {canStop
              ? <button type="button" style={pill} disabled={busy} onClick={stop} title="停止该成员">停止</button>
              : null}
          </>
        )}
      {feedback === undefined ? null : <span style={hint}>{feedback}</span>}
    </div>
  )
}
