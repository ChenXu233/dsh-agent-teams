/** Browser plugin for the AgentTeams activity floater and conversation card. */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import { type AgentTeamsLocaleKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** AgentTeams conversation card and activity monitor copy. */
        agentTeams: AgentTeamsLocaleKey;
    }
}
/**
 * Required services: conversation nodes, slots, sessions navigation, locale,
 * and the browser remote face whose \`commands\` namespace runs a member's own
 * registered commands (plan 01a). ui-commands declares the same service pair.
 */
export declare const inject: string[];
/**
 * Register the activity monitor in the shell's additive overlay and the
 * in-conversation team card. The card's activity button re-opens a folded
 * monitor via a window event — the recovery path for an old session.
 */
export declare function apply(ctx: ClientContext): void;
