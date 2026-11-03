/** Archived-team deletion shared by the floater and the workspace tab. */
import { ACTIVITY_ARCHIVE_DELETE_URL, getActivitySnapshotsSnapshot, updateActivitySnapshots, } from "./activity-monitor.js";
/**
 * Delete one archived team through the host route and drop it from the shared
 * snapshot so every surface loses the row without waiting for a poll.
 * @param team - the archived snapshot being removed.
 * @param t - translator for the fallback error text.
 */
export async function deleteArchivedTeam(team, t) {
    const workspacePath = team.workspacePath;
    if (workspacePath === undefined || workspacePath === '') {
        throw new Error(t('team.deleteRequestFailed'));
    }
    const response = await fetch(ACTIVITY_ARCHIVE_DELETE_URL, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspacePath, teamId: team.teamId }),
    });
    if (!response.ok) {
        let message = t('team.deleteRequestFailed');
        try {
            const body = await response.json();
            if (typeof body.error === 'string' && body.error.trim() !== '')
                message = body.error;
        }
        catch { }
        throw new Error(message);
    }
    updateActivitySnapshots({
        archivedTeams: getActivitySnapshotsSnapshot().archivedTeams.filter((candidate) => !(candidate.teamId === team.teamId && candidate.captainSessionId === team.captainSessionId)),
    });
}
