import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { modelLabel, modelOptionKey, modelOptions, queuedLabel, stopEnabled, withCurrentOption, } from "./member-controls.js";
const STATE_URL = '/plugins/dsh-agent-teams/member/state';
const COMMANDS_URL = '/plugins/dsh-agent-teams/member/commands';
const MODEL_URL = '/plugins/dsh-agent-teams/member/model';
const STOP_URL = '/plugins/dsh-agent-teams/member/stop';
const RELAY_URL = '/plugins/dsh-agent-teams/member/relay';
const row = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    padding: '2px 2px 6px',
    fontSize: 12,
    color: 'var(--dsw-alias-label-secondary, inherit)',
};
const control = {
    padding: '2px 8px',
    borderRadius: 6,
    border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.35))',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
};
const hint = { opacity: 0.7 };
/** Relay one line to this member; commands execute on the member's session. */
async function relay(sessionId, line) {
    await fetch(RELAY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, line, mode: 'queue' }),
    });
}
/**
 * One compact control row for a member conversation, plus the member's command
 * catalog in the host's `/` menu. Renders nothing for a non-member session.
 */
export function MemberDock({ sessionId, modelDirectories, commandUi }) {
    const [view, setView] = useState(undefined);
    const [groups, setGroups] = useState([]);
    const [commands, setCommands] = useState([]);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState(undefined);
    const alive = useRef(true);
    const refresh = useCallback(async () => {
        try {
            const response = await fetch(`${STATE_URL}?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
            if (!response.ok) {
                if (alive.current)
                    setView(undefined);
                return;
            }
            const payload = await response.json();
            if (alive.current)
                setView(payload.view ?? {});
        }
        catch {
            // Keep the last known state; the controls stay usable.
        }
    }, [sessionId]);
    useEffect(() => {
        alive.current = true;
        void refresh();
        const onFocus = () => { void refresh(); };
        window.addEventListener('focus', onFocus);
        return () => { alive.current = false; window.removeEventListener('focus', onFocus); };
    }, [refresh]);
    // Command catalog for this member: fetched once, registered into the host's
    // menu so `/` is rendered by the host itself.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const response = await fetch(`${COMMANDS_URL}?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
                if (!response.ok)
                    return;
                const payload = await response.json();
                if (!cancelled && Array.isArray(payload.commands))
                    setCommands(payload.commands);
            }
            catch {
                // No catalog: the host menu keeps whatever it already has.
            }
        })();
        return () => { cancelled = true; };
    }, [sessionId]);
    useEffect(() => {
        const registry = commandUi?.current;
        if (registry === undefined || commands.length === 0)
            return;
        const disposers = commands.map((command) => registry.register({
            name: command.name,
            label: () => `/${command.name}`,
            available: (session) => session.sessionId === sessionId,
            ui: { kind: 'action', run: () => { void relay(sessionId, `/${command.name}`); } },
        }));
        return () => { for (const dispose of disposers)
            dispose(); };
    }, [commands, commandUi, sessionId]);
    const directory = useMemo(() => {
        try {
            return modelDirectories?.directoryFor(sessionId);
        }
        catch {
            return undefined;
        }
    }, [modelDirectories, sessionId]);
    useEffect(() => {
        if (directory === undefined)
            return;
        let cancelled = false;
        void directory.load().then((state) => {
            if (!cancelled)
                setGroups(state.groups);
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [directory]);
    const options = useMemo(() => withCurrentOption(modelOptions(groups), view ?? {}), [groups, view]);
    const currentKey = view?.model === null || view?.model === undefined
        ? ''
        : modelOptionKey(view.model.provider, view.model.model);
    const queued = queuedLabel(view?.queued);
    const canStop = view !== undefined && stopEnabled(view);
    const archived = view?.archived === true;
    const switchModel = useCallback((key) => {
        const option = options.find((candidate) => candidate.key === key);
        if (option === undefined || busy)
            return;
        setBusy(true);
        void (async () => {
            try {
                const response = await fetch(MODEL_URL, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ sessionId, provider: option.provider, model: option.model }),
                });
                const payload = await response.json().catch(() => undefined);
                setFeedback(response.ok ? `已切换到 ${option.label}` : payload?.error ?? `切换失败（HTTP ${response.status}）`);
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
    }, [busy, options, refresh, sessionId]);
    const stop = useCallback(() => {
        if (busy)
            return;
        setBusy(true);
        void (async () => {
            try {
                const response = await fetch(STOP_URL, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ sessionId }),
                });
                const payload = await response.json().catch(() => undefined);
                setFeedback(response.ok ? '已请求停止' : payload?.error ?? `停止失败（HTTP ${response.status}）`);
                await refresh();
            }
            catch (error) {
                setFeedback(`停止失败：${String(error)}`);
            }
            finally {
                setBusy(false);
            }
        })();
    }, [busy, refresh, sessionId]);
    if (view === undefined)
        return null;
    return (_jsxs("div", { style: row, "data-agent-teams-member-dock": sessionId, children: [archived
                ? _jsx("span", { style: hint, children: "\u8BE5\u6210\u5458\u5DF2\u5F52\u6863\uFF0C\u53EA\u8BFB" })
                : (_jsxs(_Fragment, { children: [_jsxs("label", { style: hint, children: ["\u6A21\u578B", _jsxs("select", { style: { ...control, marginLeft: 6, maxWidth: 220 }, value: currentKey, disabled: busy || options.length === 0, onChange: (event) => { switchModel(event.target.value); }, "aria-label": modelLabel(view), children: [options.length === 0 ? _jsx("option", { value: currentKey, children: modelLabel(view) }) : null, options.map((option) => _jsx("option", { value: option.key, children: option.label }, option.key))] })] }), queued === undefined ? null : _jsx("span", { style: hint, children: queued }), _jsx("button", { type: "button", style: control, disabled: !canStop || busy, onClick: stop, children: "\u505C\u6B62" })] })), feedback === undefined ? null : _jsx("span", { style: hint, children: feedback })] }));
}
