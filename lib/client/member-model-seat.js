import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Member model seat as a pure slot contribution (spike, 2026-11-01).
 *
 * The host's own `conversation.input.model` entry renders `null` for every
 * session `sessions.subagentAddress()` answers for, so the native model seat is
 * EMPTY on a member page. This contribution fills that hole for member sessions
 * only: a non-member session renders nothing and keeps the host's own pill.
 *
 * Every value comes from this plugin's own routes. The host's per-session model
 * directory stays untouched (it is fenced for addressed subagent sessions).
 *
 * @module dsh-agent-teams/client/member-model-seat
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { ensureMembership, membershipOf } from "./member-membership.js";
const STATE_URL = '/plugins/dsh-agent-teams/member/state';
const MODELS_URL = '/plugins/dsh-agent-teams/member/models';
const MODEL_URL = '/plugins/dsh-agent-teams/member/model';
/** Same language as the host's composer pills (313:14108). */
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
let groupsCache;
let groupsInflight;
/** Read the advisory catalog once per page load. */
function loadGroups() {
    if (groupsCache !== undefined)
        return Promise.resolve(groupsCache);
    if (groupsInflight !== undefined)
        return groupsInflight;
    const pending = (async () => {
        try {
            const response = await fetch(MODELS_URL, { cache: 'no-store' });
            if (!response.ok)
                return [];
            const payload = await response.json();
            const groups = (payload.groups ?? []).flatMap((group) => {
                const provider = typeof group.provider === 'string' ? group.provider : '';
                if (provider === '')
                    return [];
                const rows = (group.models ?? []).flatMap((model) => {
                    const id = typeof model.id === 'string' ? model.id : '';
                    if (id === '')
                        return [];
                    return [{
                            key: `${provider}\u0000${id}`,
                            label: typeof model.name === 'string' && model.name !== '' ? model.name : id,
                            provider,
                            model: id,
                        }];
                });
                if (rows.length === 0)
                    return [];
                return [{
                        name: typeof group.name === 'string' && group.name !== '' ? group.name : provider,
                        rows,
                    }];
            });
            groupsCache = groups;
            return groups;
        }
        catch {
            return [];
        }
        finally {
            groupsInflight = undefined;
        }
    })();
    groupsInflight = pending;
    return pending;
}
/**
 * The composer's model seat for one member conversation.
 *
 * Renders nothing until the membership probe proves this session is a member,
 * and nothing forever for a normal conversation.
 */
export function MemberModelSeat({ sessionId }) {
    const [membership, setMembership] = useState(() => membershipOf(sessionId));
    const [view, setView] = useState(undefined);
    const [groups, setGroups] = useState([]);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState(undefined);
    const refresh = useCallback(async () => {
        try {
            const response = await fetch(`${STATE_URL}?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
            if (!response.ok)
                return;
            const payload = await response.json();
            setView(payload.view);
        }
        catch {
            // Keep the last known state; the control stays usable.
        }
    }, [sessionId]);
    useEffect(() => {
        let cancelled = false;
        setMembership(membershipOf(sessionId));
        setOpen(false);
        void ensureMembership(sessionId).then(() => {
            if (!cancelled)
                setMembership(membershipOf(sessionId));
        });
        void loadGroups().then((value) => {
            if (!cancelled)
                setGroups(value);
        });
        void refresh();
        return () => { cancelled = true; };
    }, [refresh, sessionId]);
    const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
    const currentKey = view?.model === null || view?.model === undefined
        ? ''
        : `${view.model.provider}\u0000${view.model.model}`;
    const shown = rows.find((row) => row.key === currentKey)?.label ?? view?.model?.model ?? '选择模型';
    const label = view?.reasoningEffort === undefined ? shown : `${shown} · ${view.reasoningEffort}`;
    const archived = membership === 'member-archived' || view?.archived === true;
    const items = useMemo(() => rows.map((row) => ({ id: row.key, label: rows.filter((candidate) => candidate.provider === row.provider).length > 1 && groups.length > 1 ? `${row.label}` : row.label })), [groups.length, rows]);
    const switchModel = useCallback((key) => {
        const row = rows.find((candidate) => candidate.key === key);
        if (row === undefined || busy)
            return;
        setBusy(true);
        void (async () => {
            try {
                const response = await fetch(MODEL_URL, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ sessionId, provider: row.provider, model: row.model }),
                });
                const payload = await response.json().catch(() => undefined);
                setFeedback(response.ok ? undefined : payload?.error ?? `切换失败（HTTP ${response.status}）`);
                if (response.ok)
                    await refresh();
            }
            catch (error) {
                setFeedback(`切换失败：${String(error)}`);
            }
            finally {
                setBusy(false);
            }
        })();
    }, [busy, refresh, rows, sessionId]);
    if (membership !== 'member' && membership !== 'member-archived')
        return null;
    if (archived) {
        return _jsx("span", { style: { ...pill, cursor: 'default', opacity: 0.7 }, "data-agent-teams-member-model-seat": sessionId, children: "\u5DF2\u5F52\u6863" });
    }
    return (_jsxs("span", { style: { display: 'inline-flex', alignItems: 'center', gap: 4 }, "data-agent-teams-member-model-seat": sessionId, children: [_jsx(Menu, { open: open, portal: true, align: "end", compact: true, items: items, selectedId: currentKey, onSelect: (id) => { setOpen(false); switchModel(id); }, onClose: () => setOpen(false), anchor: (_jsxs("button", { type: "button", style: pill, disabled: busy || items.length === 0, "aria-haspopup": "menu", "aria-expanded": open, "aria-label": label, title: label, onClick: () => setOpen((value) => !value), children: [label, _jsx("span", { "aria-hidden": true, children: "\u25BE" })] })) }), feedback === undefined ? null : _jsx("span", { style: { fontSize: 12, opacity: 0.7 }, children: feedback })] }));
}
