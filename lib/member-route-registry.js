/**
 * Live member route registry (plan 10, §4.6).
 *
 * `installModelSelection` needs the child's own Context, which only exists
 * inside the continuable setup closure. The setup registers a setter for the
 * member's mutable model selection; the Remote surface calls it, and the entry
 * disappears when the activation is torn down.
 * @module dsh-agent-teams/member-route-registry
 */
const setters = new Map();
/**
 * Register the setter for one live member; a second registration replaces the
 * first, which is what a cold resume does.
 * @param childId - member child session id.
 * @param setter - applies a route to that member's live selection.
 */
export function registerMemberRoute(childId, setter) {
    setters.set(childId, setter);
}
/**
 * Apply one route to a live member.
 * @param childId - member child session id.
 * @param route - provider/model/reasoning route.
 * @returns false when the member has no live setter (cold or torn down).
 */
export function applyMemberRoute(childId, route) {
    const setter = setters.get(childId);
    if (setter === undefined)
        return false;
    setter(route);
    return true;
}
/** Drop one member's setter when its activation ends. */
export function dropMemberRoute(childId) {
    setters.delete(childId);
}
/** Whether a live setter is registered for this member. */
export function hasMemberRoute(childId) {
    return setters.has(childId);
}
