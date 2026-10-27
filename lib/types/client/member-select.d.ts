/**
 * Pure composer-seat decision for member conversations (plan 10, §5.1).
 *
 * Kept free of React and of the slot API so the three-way outcome can be tested
 * without a browser.
 * @module dsh-agent-teams/client/member-select
 */
import type { MemberMembership } from './member-membership.ts';
/** The owner shape the conversation composer slot hands to `select`. */
export interface ComposerOwnerView {
    readonly sessionId?: string;
    readonly session?: {
        readonly subagent?: {
            readonly address?: {
                readonly mode?: string;
            };
        } | null;
    } | null;
}
/** What our contribution renders for this owner. */
export type ComposerSeat = 'write' | 'readonly' | null;
/**
 * Decide whether this plugin owns the composer for one conversation.
 * @param owner - slot owner carrying the viewed session.
 * @param membership - cached membership answer for that session.
 * @returns `write` for a live member, `readonly` for an archived one, null otherwise.
 */
export declare function decideComposerOwner(owner: ComposerOwnerView, membership: MemberMembership): ComposerSeat;
/** Session id used as the membership cache key, when the owner exposes one. */
export declare function ownerSessionId(owner: ComposerOwnerView): string | undefined;
