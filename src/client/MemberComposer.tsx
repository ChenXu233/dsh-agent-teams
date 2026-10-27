/**
 * Member composer (plan 10): the input box inside an AgentTeams member's own
 * conversation.
 *
 * The host composer cannot run commands there (its client-facing command API
 * refuses every subagent-owned session), so this component talks to the
 * plugin's own `/member/relay` route: `/`-prefixed lines execute on the
 * in-process bus, everything else queues through the parent's delivery channel.
 * The command catalog comes from `/member/commands`, which reads the member's
 * own session.
 *
 * An archived member keeps the seat but renders read-only: history stays
 * visible, input is refused.
 * @module dsh-agent-teams/client/MemberComposer
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { filterCommands, menuQuery, moveSelection, type MenuCommand } from './member-menu.ts'

const RELAY_URL = '/plugins/dsh-agent-teams/member/relay'
const COMMANDS_URL = '/plugins/dsh-agent-teams/member/commands'

const box: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '10px 12px',
  borderTop: '1px solid rgba(127,127,127,0.25)',
  width: '100%',
  boxSizing: 'border-box',
}
const row: CSSProperties = { display: 'flex', gap: 8, alignItems: 'flex-end' }
const input: CSSProperties = {
  flex: 1,
  minHeight: 38,
  maxHeight: 160,
  resize: 'vertical',
  font: 'inherit',
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid rgba(127,127,127,0.35)',
  background: 'transparent',
  color: 'inherit',
}
const button: CSSProperties = {
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid rgba(127,127,127,0.35)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
}
const hint: CSSProperties = { fontSize: 12, opacity: 0.65 }
const menu: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  maxHeight: 220,
  overflowY: 'auto',
  border: '1px solid rgba(127,127,127,0.3)',
  borderRadius: 8,
  padding: 4,
}
const menuRow: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'baseline',
  padding: '4px 8px',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
}
const menuName: CSSProperties = { fontWeight: 600 }
const menuText: CSSProperties = { opacity: 0.7, fontSize: 12 }

/** One line relayed to this member session. */
export function MemberComposer({ sessionId, reason }: { readonly sessionId: string; readonly reason?: string }) {
  const readOnly = reason === 'agent-teams-member-archived'
  const [draft, setDraft] = useState('')
  const [commands, setCommands] = useState<readonly MenuCommand[]>([])
  const [selected, setSelected] = useState(-1)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // The catalog is per member session: fetched once, kept across drafts.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`${COMMANDS_URL}?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
        if (!response.ok) return
        const payload = await response.json() as { commands?: MenuCommand[] }
        if (!cancelled && Array.isArray(payload.commands)) setCommands(payload.commands)
      } catch {
        // Keep the menu empty; a typed line still works.
      }
    })()
    return () => { cancelled = true }
  }, [sessionId])

  const query = menuQuery(draft)
  const rows = filterCommands(commands, query)
  const open = !readOnly && rows.length > 0

  const submit = useCallback((line: string) => {
    if (line === '' || busy) return
    setBusy(true)
    setFeedback(undefined)
    void (async () => {
      try {
        const response = await fetch(RELAY_URL, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ memberSessionId: sessionId, line }),
        })
        const payload = await response.json().catch(() => undefined) as
          | { ok?: boolean; kind?: string; text?: string; error?: string }
          | undefined
        if (!response.ok) {
          setFailed(true)
          setFeedback(payload?.error ?? `请求失败（HTTP ${response.status}）`)
          return
        }
        if (payload?.ok === false) {
          setFailed(true)
          setFeedback(payload.text ?? payload.error ?? '执行失败')
          return
        }
        setFailed(false)
        setFeedback(payload?.text ?? (payload?.kind === 'delivered' ? '已投递给成员' : '已完成'))
        setDraft('')
        setSelected(-1)
      } catch (error: unknown) {
        setFailed(true)
        setFeedback(`发送失败：${String(error)}`)
      } finally {
        setBusy(false)
      }
    })()
  }, [busy, sessionId])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (readOnly) return
    if (open && event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((index) => moveSelection(index, 1, rows.length))
      return
    }
    if (open && event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((index) => moveSelection(index, -1, rows.length))
      return
    }
    if (open && event.key === 'Escape') {
      event.preventDefault()
      setDraft('')
      setSelected(-1)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      const picked = open && selected >= 0 ? rows[selected] : undefined
      submit(picked === undefined ? draft.trim() : `/${picked.name}`)
      return
    }
  }

  return (
    <div style={box} data-agent-teams-member-composer="" data-readonly={readOnly ? 'true' : undefined}>
      {open ? (
        <div style={menu} role="listbox" aria-label="命令">
          {rows.map((command, index) => (
            <div
              key={command.name}
              role="option"
              aria-selected={index === selected}
              style={{ ...menuRow, background: index === selected ? 'rgba(127,127,127,0.18)' : undefined }}
              onMouseDown={(event) => { event.preventDefault(); submit(`/${command.name}`) }}
            >
              <span style={menuName}>/{command.name}</span>
              {command.description === undefined ? null : <span style={menuText}>{command.description}</span>}
            </div>
          ))}
        </div>
      ) : null}
      <div style={row}>
        <textarea
          ref={inputRef}
          style={{ ...input, opacity: readOnly ? 0.6 : 1 }}
          value={draft}
          rows={2}
          readOnly={readOnly}
          disabled={readOnly}
          placeholder={readOnly ? '该成员已归档，只读' : '输入消息，或输入 / 选择命令'}
          onChange={(event) => { setDraft(event.currentTarget.value); setSelected(-1) }}
          onKeyDown={onKeyDown}
        />
        <button style={button} disabled={readOnly || busy || draft.trim() === ''} onClick={() => submit(draft.trim())} type="button">
          {busy ? '发送中…' : '发送'}
        </button>
      </div>
      <div style={{ ...hint, color: failed ? '#d9534f' : undefined }}>
        {feedback ?? (readOnly
          ? '已归档：历史可查看，输入已禁用。'
          : '以 / 开头的行按命令执行（不新开回合）；其他内容会作为消息排给该成员。')}
      </div>
    </div>
  )
}
