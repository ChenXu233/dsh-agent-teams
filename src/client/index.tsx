/** Browser plugin for the AgentTeams activity floater and conversation card. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the official browser locale service into ClientContext.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Conversation folding is target-neutral; keyed Chat rendering is owned by
// ui-chat, whose declaration is loaded above.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// The frame-level overlay is declared by ui-layout. This import is type-only;
// ctx.slots.inject below owns the runtime wait for the declaration.
import type { UsePanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
// Official model catalog/directory service. The staged roster reads its
// provider/model/effort metadata without mutating the captain's own selection.
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Type-only: declares the generated remote command face on the client context.
// ui-commands (host) resolves the same service, and the value import below is
// erased at build time, so the bundle keeps its platform-only externals.
import type {} from '@deepseek-ai/dsh-commands/remote'
import { ActivitySurface, WorkspaceActivity, createWorkspaceBridge, TEAM_TAB_ID, TEAM_TAB_KIND } from './WorkspaceActivity.tsx'
import { TeamChatEntry, TeamTurnCard } from './TeamChatEntry.tsx'
import { createWorkspaceState } from './workspace-state.ts'
import { AgentTeamsCard, type AgentTeamsCardInjected } from './AgentTeamsCard.tsx'
import { agentTeamsCardDefinition } from './agent-teams-card-definition.ts'
import {
  AGENT_TEAMS_LOCALE_NAMESPACE, en, zh, type AgentTeamsLocaleKey,
} from './locales.ts'
import { openAgentTeamMember, type AgentTeamsLayoutNavigator, type AgentTeamsWorkspaceNavigator } from './session-navigation.ts'
import { MemberDock, type CommandUiHandle } from './MemberDock.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** AgentTeams conversation card and activity monitor copy. */
    agentTeams: AgentTeamsLocaleKey
  }
}

/**
 * Required services: conversation nodes, slots, sessions navigation, locale
 * and the per-session model directories the member composer reads.
 */
export const inject = [
  'uiConversation', 'slots', 'sessions', 'locale', 'modelDirectories', 'layout',
]

/** The host supplies this hook for the lifetime of a 0.1.5 root slot. */
interface PanelNavigationProps {
  usePanelInfo?: UsePanelInfo
}
const useLegacyPanelInfo: UsePanelInfo = select => select({ activePanelId: null })

/** The replayed user message is the canonical transcript entry. */
function HiddenAgentTeamsCommand(): null {
  return null
}

/**
 * Register the activity monitor in the shell's additive overlay and the
 * in-conversation team card. The card's activity button re-opens a folded
 * monitor via a window event — the recovery path for an old session.
 */
export function apply(ctx: ClientContext): void {
  const bridge = createWorkspaceBridge()
  const state = createWorkspaceState()
  ctx.effect(
    () => ctx.locale.register(AGENT_TEAMS_LOCALE_NAMESPACE, { zh, en }),
    'agent-teams: dictionaries',
  )
  const openMember = (parentId: SessionId, childId: SessionId): void => {
    void openAgentTeamMember(ctx.sessions, parentId, childId, ctx.layout as AgentTeamsLayoutNavigator, ctx.get('uiWorkspace') as AgentTeamsWorkspaceNavigator | undefined).catch((error: unknown) => {
      console.warn(`agent-teams: failed to open member transcript ${childId}: ${String(error)}`)
    })
  }
  const Panel = ({ t, usePanelInfo }: PropsLocale<'agentTeams'> & PanelNavigationProps) => {
    // A host's standard hook set is fixed for this mounted plugin instance.
    const usePanel = usePanelInfo ?? useLegacyPanelInfo
    const conversationVisible = usePanel(panel => panel.activePanelId === null)
    return (
    <ActivitySurface
      bridge={bridge}
      state={state}
      conversationVisible={conversationVisible}
      sessionsList={ctx.sessions.list}
      modelDirectories={ctx.modelDirectories}
      openMember={openMember}
      t={t}
    />
    )
  }
  // Optional service scope keeps legacy hosts working and removes every native
  // contribution when the host provider disappears (including HMR).
  //
  // Plan 10 (revised): the HOST composer keeps the conversation — its input,
  // keyboard, styling and steering already work for continuable subagents.
  // Member-specific controls ride the host's own additive dock slot, and the
  // member's command catalog is registered into the host's `commandUi` registry
  // so the `/` menu is rendered by the host rather than reimplemented.
  const commandUi: { current?: CommandUiHandle } = {}
  ctx.inject(['commandUi'], (scope) => {
    const registry = scope.get('commandUi') as CommandUiHandle | undefined
    if (registry !== undefined) commandUi.current = registry
  })
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'agent-teams-member',
    order: 10,
    locale: AGENT_TEAMS_LOCALE_NAMESPACE,
    inject: (sessionId: string) => ({ sessionId, modelDirectories: ctx.modelDirectories, commandUi }),
  }, MemberDock))
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (native) => {
    const t = native.locale.bind(AGENT_TEAMS_LOCALE_NAMESPACE)
    native.effect(() => native.sidebarRightTabs.register({
      id: TEAM_TAB_ID, kind: TEAM_TAB_KIND,
      title: () => t('workspace.title'),
    }))
    native.slots.inject('conversation.session.header.actions', () => native.slots.register({
      name: 'conversation.session.header.actions', id: 'agent-teams-entry', order: 50,
      locale: AGENT_TEAMS_LOCALE_NAMESPACE,
    }, TeamChatEntry))
    native.slots.inject('conversation.chat.turnTail', () => native.slots.register({
      name: 'conversation.chat.turnTail', id: 'agent-teams-summary', order: 50,
      locale: AGENT_TEAMS_LOCALE_NAMESPACE,
      inject: () => ({ openMember }),
    }, TeamTurnCard))
    native.slots.inject('sidebar.right.pane.tab', () => {
      const dispose = native.slots.register({
        name: 'sidebar.right.pane.tab', key: TEAM_TAB_ID,
        locale: AGENT_TEAMS_LOCALE_NAMESPACE,
        inject: () => ({ state, modelDirectories: native.modelDirectories, openMember }),
      }, WorkspaceActivity)
      bridge.set(native.sidebarRight)
      return () => { bridge.set(undefined); dispose() }
    })
  })

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'agent-teams-activity',
    order: 80,
    label: 'AgentTeams activity',
    locale: AGENT_TEAMS_LOCALE_NAMESPACE,
  }, Panel))

  // The host command is only the slash-menu/admission surface. Its input is
  // replayed as the visible user message, so the generic result row would be
  // a duplicate placed before that message by command lifecycle ordering.
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview',
    key: 'agent-teams',
  }, HiddenAgentTeamsCommand))

  ctx.uiConversation.events.register(agentTeamsCardDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'agent-teams',
    locale: AGENT_TEAMS_LOCALE_NAMESPACE,
    inject: (): AgentTeamsCardInjected => ({
      openMember, workspaceBridge: bridge,
    }),
  }, AgentTeamsCard))
}
