import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
import { useCallback, useState } from 'react';
const RELAY_URL = '/plugins/dsh-agent-teams/member/relay';
const box = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '10px 12px',
    borderTop: '1px solid rgba(127,127,127,0.25)',
    width: '100%',
    boxSizing: 'border-box',
};
const row = { display: 'flex', gap: 8, alignItems: 'flex-end' };
const input = {
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
};
const button = {
    padding: '8px 14px',
    borderRadius: 8,
    border: '1px solid rgba(127,127,127,0.35)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
};
const hint = { fontSize: 12, opacity: 0.65 };
/** One line relayed to this member session. */
export function MemberComposer({ sessionId }) {
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState(undefined);
    const [failed, setFailed] = useState(false);
    const submit = useCallback(() => {
        const line = draft.trim();
        if (line === '' || busy)
            return;
        setBusy(true);
        setFeedback(undefined);
        void (async () => {
            try {
                const response = await fetch(RELAY_URL, {
                    method: 'POST',
                    cache: 'no-store',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ memberSessionId: sessionId, line }),
                });
                const payload = await response.json().catch(() => undefined);
                if (!response.ok) {
                    setFailed(true);
                    setFeedback(payload?.error ?? `请求失败（HTTP ${response.status}）`);
                    return;
                }
                if (payload?.ok === false) {
                    setFailed(true);
                    setFeedback(payload.text ?? payload.error ?? '执行失败');
                    return;
                }
                setFailed(false);
                setFeedback(payload?.text ?? (payload?.kind === 'delivered' ? '已投递给成员' : '已完成'));
                setDraft('');
            }
            catch (error) {
                setFailed(true);
                setFeedback(`发送失败：${String(error)}`);
            }
            finally {
                setBusy(false);
            }
        })();
    }, [draft, busy, sessionId]);
    return (_jsxs("div", { style: box, "data-agent-teams-member-composer": "", children: [_jsxs("div", { style: row, children: [_jsx("textarea", { style: input, value: draft, rows: 2, placeholder: "\u8F93\u5165\u6D88\u606F\uFF0C\u6216\u8F93\u5165 /compact \u4E4B\u7C7B\u7684\u547D\u4EE4\u540E\u56DE\u8F66", onChange: (event) => { setDraft(event.currentTarget.value); }, onKeyDown: (event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                submit();
                            }
                        } }), _jsx("button", { style: button, disabled: busy || draft.trim() === '', onClick: submit, type: "button", children: busy ? '发送中…' : '发送' })] }), _jsx("div", { style: { ...hint, color: failed ? '#d9534f' : undefined }, children: feedback ?? '以 / 开头的行按命令执行（不新开回合）；其他内容会作为消息排给该成员。' })] }));
}
