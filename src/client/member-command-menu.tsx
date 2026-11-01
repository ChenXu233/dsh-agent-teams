/**
 * Member slash-command menu as a pure slot contribution (spike, 2026-11-01).
 *
 * The host's `/api/commands/list` does answer for an addressed subagent session,
 * so the `/` menu lists the member's catalog — but submitting one there performs
 * no execution for a member page (no `/api/commands/execute` call, the editor
 * silently clears). This control is the working path: it reads the same catalog
 * from the plugin route and relays the chosen line through `/member/relay`,
 * which executes on the member's own command bus.
 *
 * @module dsh-agent-teams/client/member-command-menu
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { ensureMembership, membershipOf, type MemberMembership } from './member-membership.ts'

const COMMANDS_URL = '/plugins/dsh-agent-teams/member/commands'
const RELAY_URL = '/plugins/dsh-agent-teams/member/relay'

/** Props injected by the slot registration. */
export interface MemberCommandMenuProps {
  readonly sessionId: string
}

interface CommandRow {
  readonly key: string
  readonly label: string
  readonly description?: string
}

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

/**
 * One compact slash-command launcher for a member conversation.
 *
 * Renders nothing for a session the membership probe has not proven to be a
 * member, so ordinary conversations never see it.
 */
export function MemberCommandMenu({ sessionId }: MemberCommandMenuProps) {
  const [membership, setMembership] = useState<MemberMembership>(() => membershipOf(sessionId))
  const [commands, setCommands] = useState<readonly CommandRow[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setMembership(membershipOf(sessionId))
    void ensureMembership(sessionId).then(() => {
      if (!cancelled) setMembership(membershipOf(sessionId))
    })
    void (async () => {
      try {
        const response = await fetch(`${COMMANDS_URL}?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
        if (!response.ok) return
        const payload = await response.json() as { commands?: readonly { name?: unknown; description?: unknown }[] }
        const rows = (payload.commands ?? []).flatMap((command) => {
          const name = typeof command.name === 'string' ? command.name : ''
          if (name === '') return []
          return [{
            key: name,
            label: `/${name}`,
            ...(typeof command.description === 'string' && command.description !== '' ? { description: command.description } : {}),
          }]
        })
        if (!cancelled) setCommands(rows)
      } catch {
        // No catalog: leave the control disabled instead of guessing.
      }
    })()
    return () => { cancelled = true }
  }, [sessionId])

  const items: MenuEntry[] = useMemo(
    () => commands.map((command) => ({ id: command.key, label: command.label })),
    [commands],
  )

  const run = useCallback((key: string): void => {
    if (busy) return
    setBusy(true)
    void (async () => {
      try {
        const response = await fetch(RELAY_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ memberSessionId: sessionId, line: `/${key}`, mode: 'queue' }),
        })
        const payload = await response.json().catch(() => undefined) as { error?: string } | undefined
        setFeedback(response.ok ? `已发送 /${key}` : payload?.error ?? `失败（HTTP ${response.status}）`)
      } catch (error: unknown) {
        setFeedback(`失败：${String(error)}`)
      } finally {
        setBusy(false)
      }
    })()
  }, [busy, sessionId])

  if (membership !== 'member') return null

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} data-agent-teams-member-command-menu={sessionId}>
      <Menu
        open={open}
        portal
        align="end"
        compact
        items={items}
        onSelect={(id: string) => { setOpen(false); run(id) }}
        onClose={() => setOpen(false)}
        anchor={(
          <button
            type="button"
            style={pill}
            disabled={busy || items.length === 0}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="成员命令"
            title="成员命令"
            onClick={() => setOpen((value) => !value)}
          >
            /
          </button>
        )}
      />
      {feedback === undefined ? null : <span style={{ fontSize: 12, opacity: 0.7 }}>{feedback}</span>}
    </span>
  )
}
