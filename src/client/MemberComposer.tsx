/**
 * Member composer (plan 01b): the input box inside an AgentTeams member's own
 * conversation.
 *
 * The official composer is a read-only placeholder there (ui-subagent elects
 * it at priority -10 whenever the parent is offline), and even a live official
 * composer cannot run commands: the host's client-facing command API refuses
 * every subagent-owned session with `session/agent-busy`. So this component
 * talks to the plugin's own `/member/relay` route, which resolves the owning
 * team from this session id and then either executes a command on the
 * in-process bus (`/compact`) or queues plain text through the parent's
 * delivery channel. Results are shown verbatim and never retried.
 */
import { useCallback, useState, type CSSProperties } from 'react'

const RELAY_URL = '/plugins/dsh-agent-teams/member/relay'

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

/** One line relayed to this member session. */
export function MemberComposer({ sessionId }: { readonly sessionId: string }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const submit = useCallback(() => {
    const line = draft.trim()
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
      } catch (error: unknown) {
        setFailed(true)
        setFeedback(`发送失败：${String(error)}`)
      } finally {
        setBusy(false)
      }
    })()
  }, [draft, busy, sessionId])
  return (
    <div style={box} data-agent-teams-member-composer="">
      <div style={row}>
        <textarea
          style={input}
          value={draft}
          rows={2}
          placeholder="输入消息，或输入 /compact 之类的命令后回车"
          onChange={(event) => { setDraft(event.currentTarget.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <button style={button} disabled={busy || draft.trim() === ''} onClick={submit} type="button">
          {busy ? '发送中…' : '发送'}
        </button>
      </div>
      <div style={{ ...hint, color: failed ? '#d9534f' : undefined }}>
        {feedback ?? '以 / 开头的行按命令执行（不新开回合）；其他内容会作为消息排给该成员。'}
      </div>
    </div>
  )
}