import { jsx as _jsx } from "react/jsx-runtime";
import { ActivitySurface, WorkspaceActivity, createWorkspaceBridge, TEAM_TAB_ID, TEAM_TAB_KIND } from "./WorkspaceActivity.js";
import { TeamChatEntry, TeamTurnCard } from "./TeamChatEntry.js";
import { createWorkspaceState } from "./workspace-state.js";
import { AgentTeamsCard } from "./AgentTeamsCard.js";
import { agentTeamsCardDefinition } from "./agent-teams-card-definition.js";
import { AGENT_TEAMS_LOCALE_NAMESPACE, en, zh, } from "./locales.js";
import { openAgentTeamMember } from "./session-navigation.js";
import { MemberDock } from "./MemberDock.js";
import { refreshMemberRoster } from "./member-membership.js";
import { applyMemberSelection, fetchMemberSelection, installMemberSeat } from "./member-seat.js";
import { installMemberCommands } from "./member-commands.js";
/**
 * Required services: conversation nodes, slots, sessions navigation, locale
 * and the per-session model directories the member composer reads.
 */
export const inject = [
    'uiConversation', 'slots', 'sessions', 'locale', 'modelDirectories', 'layout',
];
const useLegacyPanelInfo = select => select({ activePanelId: null });
/** The replayed user message is the canonical transcript entry. */
function HiddenAgentTeamsCommand() {
    return null;
}
/**
 * Register the activity monitor in the shell's additive overlay and the
 * in-conversation team card. The card's activity button re-opens a folded
 * monitor via a window event — the recovery path for an old session.
 */
export function apply(ctx) {
    const bridge = createWorkspaceBridge();
    const state = createWorkspaceState();
    ctx.effect(() => ctx.locale.register(AGENT_TEAMS_LOCALE_NAMESPACE, { zh, en }), 'agent-teams: dictionaries');
    const openMember = (parentId, childId) => {
        void openAgentTeamMember(ctx.sessions, parentId, childId, ctx.layout, ctx.get('uiWorkspace')).catch((error) => {
            console.warn(`agent-teams: failed to open member transcript ${childId}: ${String(error)}`);
        });
    };
    const Panel = ({ t, usePanelInfo }) => {
        // A host's standard hook set is fixed for this mounted plugin instance.
        const usePanel = usePanelInfo ?? useLegacyPanelInfo;
        const conversationVisible = usePanel(panel => panel.activePanelId === null);
        return (_jsx(ActivitySurface, { bridge: bridge, state: state, conversationVisible: conversationVisible, sessionsList: ctx.sessions.list, modelDirectories: ctx.modelDirectories, openMember: openMember, t: t }));
    };
    // Optional service scope keeps legacy hosts working and removes every native
    // contribution when the host provider disappears (including HMR).
    //
    // Plan 10 (revised): the HOST composer keeps the conversation — its input,
    // keyboard, styling and steering already work for continuable subagents.
    // Member-specific controls ride the host's own additive dock slot, and the
    // member's command catalog is registered into the host's `commandUi` registry
    // so the `/` menu is rendered by the host rather than reimplemented.
    //
    // Plan 10 (task 9): the member model seat is the HOST's own pill. The
    // membership roster is prefetched so the seat can answer synchronously, and
    // every patched host surface is restored when this plugin unloads.
    void refreshMemberRoster();
    // The seat is an optional enhancement: a host that changed these internals
    // must degrade to the dock's own control, never break the plugin boot.
    let memberSeat = { active: false };
    try {
        memberSeat = installMemberSeat(ctx, {
            readSelection: fetchMemberSelection,
            writeSelection: applyMemberSelection,
        });
    }
    catch (error) {
        console.warn(`agent-teams: member model seat unavailable: ${error instanceof Error ? error.stack : String(error)}`);
    }
    if (!memberSeat.active) {
        console.warn(`agent-teams: member model seat inactive (${memberSeat.reason ?? 'unknown reason'}); the dock keeps its own model control`);
    }
    // Plan 10 (task 9): the host's own `/` menu, driven by the member catalog.
    // Without this patch the menu has to be faked with commandUi contributions,
    // and the host renders those as completions: picking a row duplicates the
    // typed token (/compact/compact) instead of executing it.
    let memberCommands = { active: false };
    try {
        memberCommands = installMemberCommands(ctx);
    }
    catch (error) {
        console.warn(`agent-teams: member command catalog unavailable: ${String(error)}`);
    }
    const commandUi = {};
    ctx.inject(['commandUi'], (scope) => {
        const registry = scope.get('commandUi');
        if (registry !== undefined)
            commandUi.current = registry;
    });
    ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'agent-teams-member',
        order: 20,
        locale: AGENT_TEAMS_LOCALE_NAMESPACE,
        inject: (sessionId) => ({
            sessionId,
            modelDirectories: ctx.modelDirectories,
            // The native catalog owns the menu when it is installed; the commandUi
            // contributions are the fallback for a host we could not patch.
            commandUi: memberCommands.active ? undefined : commandUi,
            modelSeatActive: memberSeat.active,
        }),
    }, MemberDock));
    ctx.inject(['sidebarRight', 'sidebarRightTabs'], (native) => {
        const t = native.locale.bind(AGENT_TEAMS_LOCALE_NAMESPACE);
        native.effect(() => native.sidebarRightTabs.register({
            id: TEAM_TAB_ID, kind: TEAM_TAB_KIND,
            title: () => t('workspace.title'),
        }));
        native.slots.inject('conversation.session.header.actions', () => native.slots.register({
            name: 'conversation.session.header.actions', id: 'agent-teams-entry', order: 50,
            locale: AGENT_TEAMS_LOCALE_NAMESPACE,
        }, TeamChatEntry));
        native.slots.inject('conversation.chat.turnTail', () => native.slots.register({
            name: 'conversation.chat.turnTail', id: 'agent-teams-summary', order: 50,
            locale: AGENT_TEAMS_LOCALE_NAMESPACE,
            inject: () => ({ openMember }),
        }, TeamTurnCard));
        native.slots.inject('sidebar.right.pane.tab', () => {
            const dispose = native.slots.register({
                name: 'sidebar.right.pane.tab', key: TEAM_TAB_ID,
                locale: AGENT_TEAMS_LOCALE_NAMESPACE,
                inject: () => ({ state, modelDirectories: native.modelDirectories, openMember }),
            }, WorkspaceActivity);
            bridge.set(native.sidebarRight);
            return () => { bridge.set(undefined); dispose(); };
        });
    });
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'agent-teams-activity',
        order: 80,
        label: 'AgentTeams activity',
        locale: AGENT_TEAMS_LOCALE_NAMESPACE,
    }, Panel));
    // The host command is only the slash-menu/admission surface. Its input is
    // replayed as the visible user message, so the generic result row would be
    // a duplicate placed before that message by command lifecycle ordering.
    ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
        name: 'conversation.chat.commandview',
        key: 'agent-teams',
    }, HiddenAgentTeamsCommand));
    ctx.uiConversation.events.register(agentTeamsCardDefinition);
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'agent-teams',
        locale: AGENT_TEAMS_LOCALE_NAMESPACE,
        inject: () => ({
            openMember, workspaceBridge: bridge,
        }),
    }, AgentTeamsCard));
}
