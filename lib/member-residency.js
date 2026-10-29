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
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { agentTeamsSource, observedSessionFormatVersion } from "./harness-compat.js";
/** Text of the parked placeholder; never delivered to a member in practice. */
export const MEMBER_RESIDENCY_MARKER = '[agent-teams] residency';
/** Placeholder id per live Agent, so delivery can remove exactly that item. */
const parked = new WeakMap();
/** Whether one message is still pending in the agent's next-step list. */
function pendingStep(agent, id) {
    return agent.inbox.nextStep.some(message => message.id === id);
}
/**
 * Keep one live member resident by parking a next-step placeholder.
 *
 * Idempotent: a second call while the placeholder is still pending returns the
 * same id without appending another item.
 * @param agent - live member Agent.
 * @returns the placeholder message id, or undefined when the inbox refused it.
 */
export function parkMember(agent) {
    const existing = parked.get(agent);
    if (existing !== undefined && pendingStep(agent, existing))
        return existing;
    const message = createUserMessage({
        content: [{ type: 'text', text: MEMBER_RESIDENCY_MARKER }],
        source: agentTeamsSource({ kind: 'agent-teams' }, observedSessionFormatVersion(agent)),
    });
    agent.inject(message);
    if (!pendingStep(agent, message.id))
        return undefined;
    parked.set(agent, message.id);
    return message.id;
}
/**
 * Remove the parked placeholder, letting the activation settle normally.
 * @param agent - live member Agent.
 * @param messageId - exact placeholder id; defaults to the recorded one.
 * @returns whether the placeholder was still pending and is now gone.
 */
export function unparkMember(agent, messageId) {
    const id = messageId ?? parked.get(agent);
    if (id === undefined)
        return false;
    const removed = agent.inbox.remove(id);
    if (removed)
        parked.delete(agent);
    return removed;
}
/** Whether this agent currently holds our residency placeholder. */
export function isParked(agent) {
    const id = parked.get(agent);
    return id !== undefined && pendingStep(agent, id);
}
/**
 * The placeholder id still pending for this agent, if any.
 * @param agent - live member Agent.
 */
export function parkedMessageId(agent) {
    const id = parked.get(agent);
    return id !== undefined && pendingStep(agent, id) ? id : undefined;
}
/**
 * Keep one member resident across its own idle edges.
 *
 * A settled continuable child is disposed by the host, and a disposed child is
 * a cold transcript: its page loses the live Agent, so host commands
 * (`/compact`, `/export`, …) and model switches have nothing to run against.
 * Parking on every idle edge keeps the activation resident, which is what makes
 * a member page behave like a normal conversation after its turn ends.
 *
 * This is installed for every member, independently of the context watchdog:
 * residency is a lifecycle property, not a budget feature.
 * @param childCtx - the member's own context (listener lifetime).
 * @param agent - the live member Agent.
 * @returns disposer removing the listener.
 */
export function installMemberResidency(childCtx, agent) {
    const park = () => {
        try {
            parkMember(agent);
        }
        catch {
            // The inbox refused the placeholder: the host settles the activation.
        }
    };
    const stop = childCtx.on('agent/status', (payload) => {
        if (payload.agent.id === agent.id && payload.status === 'idle')
            park();
    });
    if (agent.status === 'idle')
        park();
    return stop;
}
