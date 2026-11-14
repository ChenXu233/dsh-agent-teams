/**
 * Route this plugin's member sessions through the shipped model seat.
 *
 * The host's `conversation.input.model` entry is fenced for addressed subagent
 * sessions: its inject face answers `available: false`, so the shipped picker
 * renders nothing, and `load()` / `select()` throw out of the fenced directory.
 * That is why this plugin ships its own pill for members.
 *
 * Proton owns that seat. This module only answers its routing question: for a
 * session this plugin has PROVEN to be one of its own members, hand the seat the
 * three members that decide where a selection goes. Every other session gets
 * `undefined`, which leaves the shipped routing exactly as the host configured
 * it — including whatever other plugin won the seat's own priority contest.
 *
 * The seat, the kit assembly and the official slot key all live in
 * `dsh-proton-adapter-dsh`; nothing here re-implements them.
 *
 * @module dsh-agent-teams/client/member-model-router
 */
import type { ModelSeatResult, ModelSeatRouter, ModelSeatRouting, ModelSeatSelection } from 'dsh-proton-adapter-dsh/model-seat';
/** Client route that applies a route to a resident member. */
export declare const MEMBER_MODEL_URL = "/plugins/dsh-agent-teams/member/model";
/**
 * Apply one route to a resident member.
 *
 * The host's `session.selectModel` Remote refuses every subagent-owned session,
 * so this is the only surface that can move a member's live selection. A cold
 * member is refused by the host route (switching a model is not a reason to
 * spend a model turn) and surfaces as a toast, not a silent no-op.
 * @param sessionId - member child session id.
 * @param selection - provider/model/effort the picker submitted.
 * @returns the shape the shipped pickers read.
 */
export declare function selectMemberModel(sessionId: string, selection: ModelSeatSelection): Promise<ModelSeatResult>;
/**
 * The routing a member session gets instead of the shipped one.
 *
 * `available` has to be set: the shipped face answers `false` for every
 * addressed subagent session, and that alone makes the picker render `null`.
 * `load` has to be replaced too, for two different reasons on the two shipped
 * entries — the official face captured the old `available` and would spin
 * forever, while the thinking-effort face calls the fenced directory directly
 * and throws out of its click handler. An empty body is the whole behaviour:
 * the model catalog is loaded once for the client and every directory store is
 * already synced from it.
 *
 * `directory` is deliberately left alone. It already carries the model groups
 * (with the reasoning metadata the effort menu needs) and the session's own
 * selection projection; re-deriving either would be a copy that drifts with
 * every host release.
 * @param sessionId - member child session id.
 * @returns the routing for that member.
 */
export declare function memberSeatRouting(sessionId: string): ModelSeatRouting;
/** Whether the shipped seat already routes this session through the member face. */
export declare function memberSeatRouted(sessionId: string): boolean;
/** Subscribe to changes of {@link memberSeatRouted}. */
export declare function subscribeMemberSeat(listener: () => void): () => void;
/**
 * Build the router this plugin registers with the shipped model seat.
 *
 * Membership is answered from the roster cache, so the router never awaits: the
 * seat asks during kit assembly and needs a synchronous answer. A session that
 * has not been proven a member keeps the shipped routing; claiming it on a guess
 * would put a picker that cannot work on every other plugin's subagent page.
 * @returns the router.
 */
export declare function createMemberModelRouter(): ModelSeatRouter;
