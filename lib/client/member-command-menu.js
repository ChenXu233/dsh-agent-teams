import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { ensureMembership, membershipOf } from "./member-membership.js";
const COMMANDS_URL = '/plugins/dsh-agent-teams/member/commands';
const RELAY_URL = '/plugins/dsh-agent-teams/member/relay';
const pill = {
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
};
/**
 * One compact slash-command launcher for a member conversation.
 *
 * Renders nothing for a session the membership probe has not proven to be a
 * member, so ordinary conversations never see it.
 */
export function MemberCommandMenu({ sessionId }) {
    const [membership, setMembership] = useState(() => membershipOf(sessionId));
    const [commands, setCommands] = useState([]);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState(undefined);
    useEffect(() => {
        let cancelled = false;
        setMembership(membershipOf(sessionId));
        void ensureMembership(sessionId).then(() => {
            if (!cancelled)
                setMembership(membershipOf(sessionId));
        });
        void (async () => {
            try {
                const response = await fetch(`${COMMANDS_URL}?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
                if (!response.ok)
                    return;
                const payload = await response.json();
                const rows = (payload.commands ?? []).flatMap((command) => {
                    const name = typeof command.name === 'string' ? command.name : '';
                    if (name === '')
                        return [];
                    return [{
                            key: name,
                            label: `/${name}`,
                            ...(typeof command.description === 'string' && command.description !== '' ? { description: command.description } : {}),
                        }];
                });
                if (!cancelled)
                    setCommands(rows);
            }
            catch {
                // No catalog: leave the control disabled instead of guessing.
            }
        })();
        return () => { cancelled = true; };
    }, [sessionId]);
    const items = useMemo(() => commands.map((command) => ({ id: command.key, label: command.label })), [commands]);
    const run = useCallback((key) => {
        if (busy)
            return;
        setBusy(true);
        void (async () => {
            try {
                const response = await fetch(RELAY_URL, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ memberSessionId: sessionId, line: `/${key}`, mode: 'queue' }),
                });
                const payload = await response.json().catch(() => undefined);
                setFeedback(response.ok ? `已发送 /${key}` : payload?.error ?? `失败（HTTP ${response.status}）`);
            }
            catch (error) {
                setFeedback(`失败：${String(error)}`);
            }
            finally {
                setBusy(false);
            }
        })();
    }, [busy, sessionId]);
    if (membership !== 'member')
        return null;
    return (_jsxs("span", { style: { display: 'inline-flex', alignItems: 'center', gap: 4 }, "data-agent-teams-member-command-menu": sessionId, children: [_jsx(Menu, { open: open, portal: true, align: "end", compact: true, items: items, onSelect: (id) => { setOpen(false); run(id); }, onClose: () => setOpen(false), anchor: (_jsx("button", { type: "button", style: pill, disabled: busy || items.length === 0, "aria-haspopup": "menu", "aria-expanded": open, "aria-label": "\u6210\u5458\u547D\u4EE4", title: "\u6210\u5458\u547D\u4EE4", onClick: () => setOpen((value) => !value), children: "/" })) }), feedback === undefined ? null : _jsx("span", { style: { fontSize: 12, opacity: 0.7 }, children: feedback })] }));
}
