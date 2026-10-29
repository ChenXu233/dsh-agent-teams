/**
 * Native slash-command catalog for member conversations (plan 10, task 9).
 *
 * The host's client command surface refuses every addressed subagent session:
 * `ui-commands` returns an empty catalog for them and its execute path calls
 * `remote.commands.execute`, which the Host fences with
 * `ApiSessionSubagentOwnership`. The member composer therefore had to fake the
 * menu with `commandUi` contributions, which the host renders as completions
 * instead of commands — picking a row inserted the label on top of the typed
 * token (`/compact/compact`) and Enter replayed that broken line as a user
 * message.
 *
 * This module keeps the host's own menu and patches only the two remote calls
 * that answer for a member session:
 *
 * - `commands.list(sessionId)` returns the member's catalog from the plugin's
 *   `/member/commands` route (the in-process catalog, which the Host's
 *   session-scoped Remote refuses);
 * - `commands.execute(sessionId, line, attachments)` relays the line to
 *   `/member/relay`, which runs it on the in-process command bus against the
 *   member's Agent and returns the same `{ commandId, result }` shape.
 *
 * Everything else — the `/` menu, the insertion semantics, the replayed user
 * message, the lifecycle node — is the host's own.
 * @module dsh-agent-teams/client/member-commands
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** One command descriptor as the host's Remote client expects it. */
export interface MemberCommandDescriptor {
    readonly name: string;
    readonly description?: string;
    readonly input?: {
        readonly hint?: string;
        readonly attachments?: boolean;
    };
}
/** Result of one installation attempt. */
export interface MemberCommands {
    readonly active: boolean;
    readonly reason?: string;
    dispose(): void;
}
/** Transport used by the patch (injectable for tests). */
export interface MemberCommandDeps {
    readonly fetcher?: typeof fetch;
}
/** Map the plugin's flat catalog onto the host's descriptor shape. */
export declare function descriptorsOf(payload: unknown): MemberCommandDescriptor[];
/**
 * Install the member command patch on this client context.
 * @param ctx - the plugin's client context.
 * @param deps - transport override for tests.
 * @returns the installation result; `dispose` restores both remote calls.
 */
export declare function installMemberCommands(ctx: ClientContext, deps?: MemberCommandDeps): MemberCommands;
