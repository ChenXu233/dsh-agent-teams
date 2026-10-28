/**
 * Client-side membership cache for the member composer (plan 10, §4.4).
 *
 * The composer seat elects synchronously, so membership is read from a cache
 * that a background fetch fills. `unknown` never claims the seat: a session we
 * have not proven to be a member keeps the host composer.
 * @module dsh-agent-teams/client/member-membership
 */
/** Host route that answers membership for one session id. */
export const MEMBERSHIP_URL = '/plugins/dsh-agent-teams/member/membership';
const known = new Map();
const inflight = new Set();
/** Cached membership; `unknown` until a fetch settles. */
export function membershipOf(sessionId) {
    return known.get(sessionId) ?? 'unknown';
}
/** Record one membership answer (also used by tests and by the panel). */
export function noteMembership(sessionId, value) {
    known.set(sessionId, value);
}
/** Drop every cached answer (host reload). */
export function resetMembership() {
    known.clear();
    inflight.clear();
}
/**
 * Ask the plugin once per session and cache the answer.
 *
 * A transport failure leaves the entry `unknown` so a later render retries; a
 * 404 records `not-member` and is never asked again.
 * @param sessionId - child session id of the viewed conversation.
 * @param fetchImpl - fetch override for tests.
 */
export async function ensureMembership(sessionId, fetchImpl = fetch) {
    if (known.has(sessionId) || inflight.has(sessionId))
        return;
    inflight.add(sessionId);
    try {
        const response = await fetchImpl(`${MEMBERSHIP_URL}?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
        if (response.status === 404) {
            known.set(sessionId, 'not-member');
            return;
        }
        if (!response.ok)
            return;
        const payload = await response.json?.();
        known.set(sessionId, payload?.archived === true ? 'member-archived' : 'member');
    }
    catch {
        // Leave unknown: the next render retries.
    }
    finally {
        inflight.delete(sessionId);
    }
}
