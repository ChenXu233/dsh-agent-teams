/** Archived-team deletion shared by the floater and the workspace tab. */
import { type ActivityTeam } from './activity-monitor.ts';
import type { AgentTeamsTranslate } from './locales.ts';
/**
 * Delete one archived team through the host route and drop it from the shared
 * snapshot so every surface loses the row without waiting for a poll.
 * @param team - the archived snapshot being removed.
 * @param t - translator for the fallback error text.
 */
export declare function deleteArchivedTeam(team: ActivityTeam, t: AgentTeamsTranslate): Promise<void>;
