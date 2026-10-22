/**
 * The `agent_teams_*` model-facing tools.
 *
 * The captain (the agent that created the team) orchestrates: members are
 * continuable subagents it spawns and wakes. Members share the same tools and
 * drive their own task state, mirroring the Claude Code AgentTeams flow:
 * create team → add members → create tasks with dependencies → claim/assign →
 * work → report → status → delete.
 * @module dsh-agent-teams/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type MemberToolPolicy } from './tool-policies.ts';
import type { MemberContextConfig } from './member-context.ts';
import type { ArtifactSnapshot } from './types.ts';
import { type TeamMember, type TeamState, type TeamTask } from './types.ts';
export { steerCaptainReport } from './members.ts';
/** Resolved plugin config consumed by the tools. */
export interface ToolsConfig {
    /** State directory name under the captain's workspace. */
    stateDir: string;
    /** Member subagent provider name. */
    memberProvider: string;
    /** Optional member model override. */
    memberModel?: string;
    /** Optional member LLM provider, paired with `memberModel` (issue #189). */
    memberLlmProvider?: string;
    /** Prompt injected into member personas and assignments. */
    executionPrompt?: string;
    /** Plugin fallback route. */
    fallback?: import('./profiles.ts').TeamModelFallbackConfig;
    /** Member delegation depth cap. */
    memberMaxDepth?: number;
    /** How a member's conversation is carried (plan 09); default `subagent`. */
    memberSessions?: 'subagent' | 'session';
    /** Team size cap (members). */
    maxMembers: number;
    /** Named team profiles from the active DSH profile. */
    profiles: Record<string, import('./profiles.ts').TeamProfileConfig>;
    /** Owner-declared reusable member tool policies, keyed by policy id (#59). */
    toolPolicies: Record<string, MemberToolPolicy>;
    /**
     * Plugin-level per-member context budget; `undefined` when the
     * `memberContext` block is unconfigured, which disables the watchdog and all
     * accounting.
     */
    memberContext?: MemberContextConfig;
    /**
     * Command names (without the leading slash) `agent_teams_run_command` may
     * never issue into a member session. Default: this plugin's own
     * agent-teams surface, so the captain cannot re-enter the activation
     * command through a member.
     *
     * Entries are normalized (whitespace, any leading slashes and case are
     * ignored) and each one also blocks its `<entry>-*` family; an explicit `[]`
     * denies nothing at all, the built-in default included (literal
     * replacement). Callers that bypass the mount must never silence an
     * unusable entry.
     */
    memberCommandDeny?: string[];
}
/** Effective deny names plus the entries that carried no usable name. */
export interface MemberCommandDenyResolution {
    /** Normalized, de-duplicated names in configuration order. */
    readonly names: readonly string[];
    /** Entries that were unusable; callers must never ignore them silently. */
    readonly dropped: readonly unknown[];
}
/**
 * Resolve `memberCommandDeny` once, so `run` and `list` can never disagree
 * about what is denied. `undefined` keeps the plugin's own agent-teams surface
 * as the safe default; an explicitly empty array denies nothing — a deliberate
 * literal replacement. Unusable entries are reported through `dropped` for the
 * caller to surface (the host fails loudly at mount; direct callers warn).
 */
export declare function normalizeMemberCommandDeny(entries: readonly unknown[] | undefined): MemberCommandDenyResolution;
/** Browser/UI mutations allowed while a plan is waiting for approval. */
export type StagedPlanMutation = {
    action: 'update_member';
    memberName: string;
    role?: string | null;
    provider: string;
    model: string;
    reasoningEffort?: string | null;
    executionPrompt?: string | null;
    /** Selected tool-policy id; an empty string clears it back to no policy. */
    toolPolicy?: string;
    /** Per-member context budget in tokens; a new number sets it, null clears it. */
    contextMaxTokens?: number | null;
} | {
    action: 'update_task';
    taskId: string;
    subject: string;
    description?: string | null;
    assignee?: string | null;
    dependencies: string[];
} | {
    action: 'add_task';
    subject: string;
    description?: string | null;
    assignee?: string | null;
    dependencies: string[];
} | {
    action: 'remove_task';
    taskId: string;
} | {
    action: 'remove_member';
    memberName: string;
};
/** Runtime bridge shared by model-facing tools and the Web staging surface. */
export interface AgentTeamsRuntime {
    isPendingMember(agent: Agent): boolean;
    updateStagedPlan(captain: Agent, teamId: string, mutation: StagedPlanMutation, signal?: AbortSignal): Promise<TeamState>;
    updateStagedPlanBatch(captain: Agent, teamId: string, mutations: readonly StagedPlanMutation[], signal?: AbortSignal): Promise<TeamState>;
    approveStagedTeam(captain: Agent, teamId: string, signal?: AbortSignal): Promise<{
        teamId: string;
        members: number;
        tasks: number;
    }>;
    continueStagedPlanning(captain: Agent, teamId: string): Promise<{
        teamId: string;
        alreadyWaiting: boolean;
    }>;
    discardStagedTeam(captain: Agent, teamId: string): Promise<{
        teamId: string;
    }>;
}
export declare function stopTeamMemberActivations(ctx: Context, captain: Agent, members: readonly TeamMember[], signal?: AbortSignal): Promise<void>;
export declare function haltTeamWork(input: {
    ctx: Context;
    stateRoot: string;
    teamId: string;
    captain: Agent;
    signal?: AbortSignal;
}): Promise<{
    teamName: string;
    captainSessionId: string;
    cancelledTasks: number;
    alreadyHalted: boolean;
}>;
/** Web approval has no tool result in the captain's conversation. */
export declare function stagedPlanApprovedContext(teamName: string): string;
/** Context queued after the human rejects a staged plan. */
export declare function stagedPlanDiscardContext(teamName: string): string;
/** Model-facing continuation that turns the review UI back into a conversation. */
export declare function stagedPlanFeedbackContext(teamName: string): string;
/**
 * Register every `agent_teams_*` tool into the shared tools registry.
 * @param ctx - the plugin context (injects `tools`).
 * @param config - resolved tool config.
 */
export declare function registerAgentTeamsTools(ctx: Context, config: ToolsConfig): AgentTeamsRuntime;
export declare function applyQualityFollowUp(team: TeamState, closed: TeamTask, snapshotPaths?: (paths: readonly string[]) => ArtifactSnapshot, pathExists?: (path: string) => boolean): {
    created: TeamTask[];
    escalated: boolean;
    reason?: string;
    excludedFindings?: string[];
};
