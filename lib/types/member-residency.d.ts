/**
 * Member residency (plan 10, appendix A).
 *
 * A settled continuable child is disposed by the host: \`settlementState()\`
 * returns "ready" once the activation has no owned children and no pending
 * inbox item. A pending \`next-step\` item keeps the activation resident, and
 * unlike \`next-turn\` it never starts a turn by itself — so an idle member can
 * stay alive without running anything.
 *
 * The placeholder is removed synchronously at delivery time, before the member
 * loop claims the next turn, so it never reaches the model's context.
 * @module dsh-agent-teams/member-residency
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
/** Text of the parked placeholder; never delivered to a member in practice. */
export declare const MEMBER_RESIDENCY_MARKER = "[agent-teams] residency";
/**
 * Keep one live member resident by parking a next-step placeholder.
 *
 * Idempotent: a second call while the placeholder is still pending returns the
 * same id without appending another item.
 * @param agent - live member Agent.
 * @returns the placeholder message id, or undefined when the inbox refused it.
 */
export declare function parkMember(agent: Agent): string | undefined;
/**
 * Remove the parked placeholder, letting the activation settle normally.
 * @param agent - live member Agent.
 * @param messageId - exact placeholder id; defaults to the recorded one.
 * @returns whether the placeholder was still pending and is now gone.
 */
export declare function unparkMember(agent: Agent, messageId?: string): boolean;
/** Whether this agent currently holds our residency placeholder. */
export declare function isParked(agent: Agent): boolean;
/**
 * The placeholder id still pending for this agent, if any.
 * @param agent - live member Agent.
 */
export declare function parkedMessageId(agent: Agent): string | undefined;
