import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Member composer (plan 10): the input box inside an AgentTeams member's own
 * conversation.
 *
 * The host composer cannot run commands there (its client-facing command API
 * refuses every subagent-owned session), so this component talks to the
 * plugin's own routes: `/member/relay` runs a line (commands execute on the
 * in-process bus, plain text queues through the parent's delivery channel),
 * `/member/commands` lists the member's own commands, and `/member/state`
 * reports the live state the controls render from.
 *
 * Controls mirror the host composer: model selector, queue badge and stop. An
 * archived member keeps the seat but renders read-only — history stays visible,
 * input is refused.
 * @module dsh-agent-teams/client/MemberComposer
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { filterCommands, menuQuery, moveSelection } from "./member-menu.js";
import { deliveryHint, deliveryMode, modelLabel, modelOptionKey, modelOptions, queuedLabel, stopEnabled, withCurrentOption, } from "./member-controls.js";
const RELAY_URL = '/plugins/dsh-agent-teams/member/relay';
const COMMANDS_URL = '/plugins/dsh-agent-teams/member/commands';
const STATE_URL = '/plugins/dsh-agent-teams/member/state';
const MODEL_URL = '/plugins/dsh-agent-teams/member/model';
const STOP_URL = '/plugins/dsh-agent-teams/member/stop';
const box = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '10px 12px',
    borderTop: '1px solid rgba(127,127,127,0.25)',
    width: '100%',
    boxSizing: 'border-box',
};
const toolbar = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 };
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
const smallButton = {
    padding: '2px 8px',
    borderRadius: 6,
    border: '1px solid rgba(127,127,127,0.35)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
};
const select = {
    maxWidth: 260,
    padding: '2px 6px',
    borderRadius: 6,
    border: '1px solid rgba(127,127,127,0.35)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
};
const hint = { fontSize: 12, opacity: 0.65 };
const menu = {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    maxHeight: 220,
    overflowY: 'auto',
    border: '1px solid rgba(127,127,127,0.3)',
    borderRadius: 8,
    padding: 4,
};
const menuRow = {
    display: 'flex',
    gap: 8,
    alignItems: 'baseline',
    padding: '4px 8px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
};
const menuName = { fontWeight: 600 };
const menuText = { opacity: 0.7, fontSize: 12 };
/** One line relayed to this member session. */
export function MemberComposer({ sessionId, reason, modelDirectories }) {
    const [view, setView] = useState({});
    const readOnly = reason === 'agent-teams-member-archived' || view.archived === true;
    const [draft, setDraft] = useState('');
    const [commands, setCommands] = useState([]);
    const [groups, setGroups] = useState([]);
    const [selected, setSelected] = useState(-1);
    const [busy, setBusy] = useState(false);
    const [modelBusy, setModelBusy] = useState(false);
    const [feedback, setFeedback] = useState(undefined);
    const [failed, setFailed] = useState(false);
    const inputRef = useRef(null);
    // The catalog is per member session: fetched once, kept across drafts.
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
                // Keep the menu empty; a typed line still works.
            }
        })();
        return () => { cancelled = true; };
    }, [sessionId]);
    // Live state drives the controls. It is read on mount, after every send and
    // whenever the window regains focus; there is no polling timer, so an idle
    // member page costs nothing.
    const refresh = useCallback(async () => {
        try {
            const response = await fetch(`${STATE_URL}?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
            if (!response.ok)
                return;
            const payload = await response.json();
            if (payload.view !== undefined)
                setView(payload.view);
        }
        catch {
            // Keep the last known state; the controls stay usable.
        }
    }, [sessionId]);
    useEffect(() => {
        void refresh();
        const onFocus = () => { void refresh(); };
        window.addEventListener('focus', onFocus);
        return () => { window.removeEventListener('focus', onFocus); };
    }, [refresh]);
    // The model catalog is host-wide; the directory is per session. A session
    // without a resolvable directory simply keeps the selector on the current
    // route instead of failing the whole composer.
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
        }).catch(() => {
            // Keep the current route selectable; the picker just has no catalog.
        });
        return () => { cancelled = true; };
    }, [directory]);
    const options = useMemo(() => withCurrentOption(modelOptions(groups), view), [groups, view]);
    const currentKey = view.model === null || view.model === undefined
        ? ''
        : modelOptionKey(view.model.provider, view.model.model);
    const queue = queuedLabel(view.queued);
    const running = stopEnabled(view);
    const query = menuQuery(draft);
    const rows = filterCommands(commands, query);
    const open = !readOnly && rows.length > 0;
    const switchModel = useCallback((key) => {
        const option = options.find(candidate => candidate.key === key);
        if (option === undefined || modelBusy)
            return;
        setModelBusy(true);
        setFeedback(undefined);
        void (async () => {
            try {
                const response = await fetch(MODEL_URL, {
                    method: 'POST',
                    cache: 'no-store',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ sessionId, provider: option.provider, model: option.model }),
                });
                const payload = await response.json().catch(() => undefined);
                if (!response.ok) {
                    setFailed(true);
                    setFeedback(payload?.error ?? `切换失败（HTTP ${response.status}）`);
                    return;
                }
                setFailed(false);
                setFeedback(`已切换到 ${option.label}`);
                setView(current => ({ ...current, model: { provider: option.provider, model: option.model } }));
            }
            catch (error) {
                setFailed(true);
                setFeedback(`切换失败：${String(error)}`);
            }
            finally {
                setModelBusy(false);
            }
        })();
    }, [modelBusy, options, sessionId]);
    const stop = useCallback(() => {
        void (async () => {
            try {
                const response = await fetch(STOP_URL, {
                    method: 'POST',
                    cache: 'no-store',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ sessionId }),
                });
                const payload = await response.json().catch(() => undefined);
                setFailed(!response.ok);
                setFeedback(response.ok ? '已请求停止当前回合' : payload?.error ?? `停止失败（HTTP ${response.status}）`);
                await refresh();
            }
            catch (error) {
                setFailed(true);
                setFeedback(`停止失败：${String(error)}`);
            }
        })();
    }, [refresh, sessionId]);
    const submit = useCallback((line) => {
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
                    body: JSON.stringify({ memberSessionId: sessionId, line, mode: deliveryMode(view) }),
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
                setSelected(-1);
                await refresh();
            }
            catch (error) {
                setFailed(true);
                setFeedback(`发送失败：${String(error)}`);
            }
            finally {
                setBusy(false);
            }
        })();
    }, [busy, refresh, sessionId, view]);
    const onKeyDown = (event) => {
        if (readOnly)
            return;
        if (open && event.key === 'ArrowDown') {
            event.preventDefault();
            setSelected((index) => moveSelection(index, 1, rows.length));
            return;
        }
        if (open && event.key === 'ArrowUp') {
            event.preventDefault();
            setSelected((index) => moveSelection(index, -1, rows.length));
            return;
        }
        if (open && event.key === 'Escape') {
            event.preventDefault();
            setDraft('');
            setSelected(-1);
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            const picked = open && selected >= 0 ? rows[selected] : undefined;
            submit(picked === undefined ? draft.trim() : `/${picked.name}`);
            return;
        }
    };
    return (_jsxs("div", { style: box, "data-agent-teams-member-composer": "", "data-readonly": readOnly ? 'true' : undefined, children: [_jsxs("div", { style: toolbar, children: [_jsxs("select", { style: select, "aria-label": "\u6A21\u578B", title: readOnly ? '已归档：不能切换模型' : '切换该成员使用的模型', value: currentKey, disabled: readOnly || modelBusy || options.length === 0, onChange: (event) => { switchModel(event.currentTarget.value); }, children: [currentKey === '' ? _jsx("option", { value: "", children: modelLabel(view) }) : null, options.map((option) => _jsx("option", { value: option.key, children: option.label }, option.key))] }), queue === undefined ? null : _jsx("span", { style: hint, "data-agent-teams-queue": "", children: queue }), running ? (_jsx("button", { style: smallButton, type: "button", onClick: stop, children: "\u505C\u6B62" })) : null] }), open ? (_jsx("div", { style: menu, role: "listbox", "aria-label": "\u547D\u4EE4", children: rows.map((command, index) => (_jsxs("div", { role: "option", "aria-selected": index === selected, style: { ...menuRow, background: index === selected ? 'rgba(127,127,127,0.18)' : undefined }, onMouseDown: (event) => { event.preventDefault(); submit(`/${command.name}`); }, children: [_jsxs("span", { style: menuName, children: ["/", command.name] }), command.description === undefined ? null : _jsx("span", { style: menuText, children: command.description })] }, command.name))) })) : null, _jsxs("div", { style: row, children: [_jsx("textarea", { ref: inputRef, style: { ...input, opacity: readOnly ? 0.6 : 1 }, value: draft, rows: 2, readOnly: readOnly, disabled: readOnly, placeholder: readOnly ? '该成员已归档，只读' : '输入消息，或输入 / 选择命令', onChange: (event) => { setDraft(event.currentTarget.value); setSelected(-1); }, onKeyDown: onKeyDown }), _jsx("button", { style: button, disabled: readOnly || busy || draft.trim() === '', onClick: () => submit(draft.trim()), type: "button", children: busy ? '发送中…' : '发送' })] }), _jsx("div", { style: { ...hint, color: failed ? '#d9534f' : undefined }, children: feedback ?? (readOnly ? deliveryHint(view) : `${deliveryHint(view)} 以 / 开头的行按命令执行。`) })] }));
}
