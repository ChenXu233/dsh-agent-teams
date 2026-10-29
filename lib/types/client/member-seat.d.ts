/**
 * Native model seat for member conversations (plan 10, task 9).
 *
 * The host composer already owns the model pill, its catalog menu, the effort
 * submenu and the error surface — but ui-model-selection hides all of it for
 * any session `sessions.subagentAddress()` answers for, and its `selectModel`
 * Remote refuses subagent-owned sessions. Team members are continuable
 * subagents, so their page lost the seat entirely.
 *
 * This module keeps the host's own pill and patches only the three places that
 * answer for a member session:
 *
 * - `modelDirectories.directoryFor` marks the directory selectable and points
 *   its projection at the member's durable route instead of a history face the
 *   member page never writes;
 * - the `conversation.input.model` slot registration flips `available` and
 *   re-points `load`/`select` at that directory (patched on the stored entry,
 *   so registration order does not matter);
 * - the remote session face's `selectModel` relays the choice to the plugin's
 *   `/member/model` route instead of the fenced Session Remote.
 *
 * Every patch is structural and optional: a host that renamed or removed one of
 * these surfaces leaves `active === false` and the caller keeps its own
 * fallback control.
 * @module dsh-agent-teams/client/member-seat
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** One provider/model/effort route as the host menu expresses it. */
export interface MemberSeatSelection {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
/** Server transport the seat relays through. */
export interface MemberSeatDeps {
    /** The member's current durable route, or undefined when it has none. */
    readonly readSelection: (sessionId: string) => Promise<MemberSeatSelection | undefined>;
    /** Apply one route to the member; resolves with the plugin's answer. */
    readonly writeSelection: (sessionId: string, selection: MemberSeatSelection) => Promise<{
        readonly ok: true;
    } | {
        readonly ok: false;
        readonly message: string;
    }>;
}
/** Result of one installation attempt. */
export interface MemberSeat {
    /** Whether the host surfaces were found and patched. */
    readonly active: boolean;
    /** Why the seat stayed inactive, for the caller's fallback. */
    readonly reason?: string;
    dispose(): void;
}
/** Slot key the host renders the model pill in. */
export declare const MODEL_SLOT = "conversation.input.model";
/**
 * Install the member model seat on this client context.
 * @param ctx - the plugin's client context.
 * @param deps - server transport for reading and writing the member route.
 * @returns the installation result; `dispose` restores every patched surface.
 */
export declare function installMemberSeat(ctx: ClientContext, deps: MemberSeatDeps): MemberSeat;
/**
 * Read the member's durable route through the plugin's own route.
 * @param sessionId - member child session.
 * @param fetcher - fetch override for tests.
 * @returns the route, or undefined when the session is not a member.
 */
export declare function fetchMemberSelection(sessionId: string, fetcher?: typeof fetch): Promise<MemberSeatSelection | undefined>;
/**
 * Apply one route to the member through the plugin's own route.
 * @param sessionId - member child session.
 * @param selection - provider, model and optional pinned effort.
 * @param fetcher - fetch override for tests.
 * @returns the plugin's answer, normalized for the host menu.
 */
export declare function applyMemberSelection(sessionId: string, selection: MemberSeatSelection, fetcher?: typeof fetch): Promise<{
    readonly ok: true;
} | {
    readonly ok: false;
    readonly message: string;
}>;
