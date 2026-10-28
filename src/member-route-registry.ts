/**
 * Live member route registry (plan 10, §4.6).
 *
 * `installModelSelection` needs the child's own Context, which only exists
 * inside the continuable setup closure. The setup registers a setter for the
 * member's mutable model selection; the Remote surface calls it, and the entry
 * disappears when the activation is torn down.
 * @module dsh-agent-teams/member-route-registry
 */

/** One concrete model route a member can be switched to. */
export interface MemberRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Setter installed by the member setup closure. */
export type MemberRouteSetter = (route: MemberRoute) => void

const setters = new Map<string, MemberRouteSetter>()

/**
 * Last route applied through the registry. `agent.options` keeps the SPAWN
 * route (the selection only feeds the request waterfall), so this is the only
 * handle on "what model will the next turn use".
 */
const applied = new Map<string, MemberRoute>()

/**
 * Register the setter for one live member; a second registration replaces the
 * first, which is what a cold resume does. A fresh activation starts from its
 * spawn route, so any remembered switch is dropped.
 * @param childId - member child session id.
 * @param setter - applies a route to that member's live selection.
 */
export function registerMemberRoute(childId: string, setter: MemberRouteSetter): void {
  setters.set(childId, setter)
  applied.delete(childId)
}

/**
 * Apply one route to a live member.
 * @param childId - member child session id.
 * @param route - provider/model/reasoning route.
 * @returns false when the member has no live setter (cold or torn down).
 */
export function applyMemberRoute(childId: string, route: MemberRoute): boolean {
  const setter = setters.get(childId)
  if (setter === undefined) return false
  setter(route)
  applied.set(childId, route)
  return true
}

/**
 * The route a live member was last switched to.
 * @param childId - member child session id.
 * @returns undefined before the first switch (or after teardown), meaning the
 * member still runs its spawn route.
 */
export function memberRoute(childId: string): MemberRoute | undefined {
  return applied.get(childId)
}

/** Drop one member's setter when its activation ends. */
export function dropMemberRoute(childId: string): void {
  setters.delete(childId)
  applied.delete(childId)
}

/** Whether a live setter is registered for this member. */
export function hasMemberRoute(childId: string): boolean {
  return setters.has(childId)
}
