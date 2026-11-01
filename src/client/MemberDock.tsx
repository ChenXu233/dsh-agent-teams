/**
 * Member controls docked in the host composer (slot-only, 2026-11-01).
 *
 * The composer stays the host's: input, keyboard, styling and steering already
 * work for continuable subagents. This dock adds only what the host has no
 * surface for on a member page — the queued-message badge and the stop control.
 *
 * The model seat and the slash-command launcher are separate slot
 * contributions (`member-model-seat.tsx`, `member-command-menu.tsx`) because
 * the host's own model seat renders `null` for addressed subagent sessions and
 * its command menu executes nothing there. Nothing here patches the host.
 * @module dsh-agent-teams/client/MemberDock
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { queuedLabel, stopEnabled, type MemberControlView } from './member-controls.ts'

const STATE_URL = '/plugins/dsh-agent-teams/member/state'
const STOP_URL = '/plugins/dsh-agent-teams/member/stop'

/** Structural view of one member, as `/member/state` reports it. */
export interface MemberDockProps {
  readonly sessionId: string
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
const hint: CSSProperties = { opacity: 0.7 }

/**
 * Queue badge and stop control for one member conversation.
 *
 * Renders nothing until `/member/state` proves this session is a member, so an
 * ordinary conversation never sees it.
 */
export function MemberDock({ sessionId }: MemberDockProps) {
  const [view, setView] = useState<MemberControlView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | undefined>(undefined)
  const alive = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
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

  const stop = useCallback((): void => {
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
  const queued = queuedLabel(view.queued)
  const canStop = stopEnabled(view)
  const archived = view.archived === true

  return (
    <div style={row} data-agent-teams-member-dock={sessionId}>
      {archived
        ? <span style={hint}>已归档 · 只读</span>
        : (
          <>
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
