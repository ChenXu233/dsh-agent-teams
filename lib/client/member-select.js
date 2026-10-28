/**
 * Pure composer-seat decision for member conversations (plan 10, §5.1).
 *
 * Kept free of React and of the slot API so the three-way outcome can be tested
 * without a browser.
 * @module dsh-agent-teams/client/member-select
 */
/**
 * Decide whether this plugin owns the composer for one conversation.
 * @param owner - slot owner carrying the viewed session.
 * @param membership - cached membership answer for that session.
 * @returns `write` for a live member, `readonly` for an archived one, null otherwise.
 */
export function decideComposerOwner(owner, membership) {
    const subagent = owner.session?.subagent;
    if (subagent === undefined || subagent === null)
        return null;
    // Cold transcripts expose the durable descriptor's `mode`; live children add
    // an address. Accept either, and never claim a one-shot child.
    const mode = subagent.address?.mode ?? subagent.mode;
    if (mode !== 'continuable')
        return null;
    if (membership === 'member')
        return 'write';
    if (membership === 'member-archived')
        return 'readonly';
    return null;
}
/** Session id used as the membership cache key, when the owner exposes one. */
export function ownerSessionId(owner) {
    const id = owner.sessionId;
    return typeof id === 'string' && id !== '' ? id : undefined;
}
