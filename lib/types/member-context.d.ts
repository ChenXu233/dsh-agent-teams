/**
 * Per-member context budgets (plan 02 — #190/#162, plugin-level).
 *
 * Harness auto-compaction runs inside a turn (`agent/pre-step`), while
 * `CompactionEngine.compactNow` requires a fully idle agent with no queued
 * waking work and rejects every other state with `ManualCompactionError('busy')`.
 * The two are mutually exclusive, so a plugin-side per-member budget can only
 * act on `agent/status` transitions into `idle` — never inside a turn and
 * never from `agent/pre-step`.
 *
 * The watchdog is wired through injected dependencies
 * ({@link installMemberContextWatchdog}) so tests can drive fake
 * `agent/status` events, a fake token meter, and a fake compaction without a
 * Harness; the real wiring adapts `childCtx.on('agent/status', …)` in
 * `src/members.ts`. Hosts without a resolvable budget install nothing, so an
 * unconfigured `memberContext` keeps the previous behavior byte-for-byte.
 * @module dsh-agent-teams/member-context
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
/** What happens when a member reaches its context budget. */
export type MemberContextMode = 'compact' | 'notify' | 'off';
/** Plugin-level `memberContext` configuration; member-level overrides win. */
export interface MemberContextConfig {
    /** Absolute trigger threshold in tokens; combined with `maxRatio` by taking the smaller budget. */
    maxTokens?: number;
    /** Trigger threshold as a ratio of the member model's context window. */
    maxRatio?: number;
    /** Minimum delay between two compactions of the same member (default 60000). */
    cooldownMs?: number;
    /**
     * Minimum number of entered turns between two compactions (default 1).
     * `turnsSinceCompact` counts `agent/status → running` transitions since the
     * last successful compaction, so `1` requires a full turn between runs.
     */
    minTurnGap?: number;
    /** Action on reaching the budget (default `compact`). */
    onLimit?: MemberContextMode;
}
/** The resolved token budget for one member, and where it came from. */
export interface MemberContextBudget {
    /** Trigger threshold in tokens. */
    tokens: number;
    /** `member`: the member's own `context_max_tokens`; `plugin`: the plugin default. */
    source: 'member' | 'plugin';
}
/** Durable bookkeeping events the watchdog emits; the host decides storage. */
export type MemberContextWatchdogEvent = {
    kind: 'measured';
    tokens: number;
} | {
    kind: 'compacted';
    shadowedTokens?: number;
} | {
    kind: 'notified';
    tokens: number;
} | {
    kind: 'skipped';
    reason?: string;
} | {
    kind: 'failed';
    reason?: string;
};
/**
 * Read the routed context window of one live agent, or `undefined` when the
 * route or its adapter-owned capacity is unknown. The window is never guessed:
 * `resolveMemberContextBudget` disables a ratio-only budget instead of
 * inventing a capacity.
 *
 * Errors degrade to `undefined` — an adapter that cannot answer must not turn
 * a monitoring decision into a member crash. The result is read per install;
 * callers that cache it own any staleness.
 */
export declare function resolveMemberContextWindow(agent: Pick<Agent, 'session' | 'options' | 'ctx'>, signal?: AbortSignal): Promise<number | undefined>;
/**
 * Resolve one member's context budget.
 *
 * Priority: the member's own `context_max_tokens` (the durable roster value,
 * `source: 'member'`) beats the plugin-level `memberContext` default
 * (`source: 'plugin'`). When several thresholds apply, the smaller budget
 * wins — a budget is an upper bound the member may reach, so the strictest
 * configured bound is the effective one. A `maxRatio` without a knowable
 * context window contributes nothing (and alone yields `undefined`: the
 * watchdog stays disabled instead of guessing a window size). No thresholds at
 * all also yields `undefined`.
 */
export declare function resolveMemberContextBudget(input: {
    memberContextMaxTokens?: number | undefined;
    config: MemberContextConfig | undefined;
    contextWindow?: number | undefined;
}): MemberContextBudget | undefined;
/**
 * The pure idle-watchdog decision, evaluated per `agent/status → idle`.
 *
 * `skip` keeps the member untouched: budget not reached, `onLimit: 'off'`,
 * inside the cooldown window, or before `minTurnGap` turns have passed.
 * `notify` records and surfaces the over-budget state without compacting;
 * `compact` runs one idle compaction. The caller supplies its own clock and
 * counters, so cooldown and turn-gap semantics are testable without a Harness.
 */
export declare function decideMemberContextAction(input: {
    usedTokens: number;
    budgetTokens: number;
    now: number;
    lastCompactAt: number;
    turnsSinceCompact: number;
    cooldownMs: number;
    minTurnGap: number;
    mode: MemberContextMode;
}): 'compact' | 'notify' | 'skip';
/** Host-provided capabilities of {@link installMemberContextWatchdog}. */
export interface MemberContextWatchdogDeps {
    /**
     * Subscribe to `agent/status` for the watched member's context; returns the
     * unsubscribe function. Handlers may receive events for other agents and
     * other statuses — the watchdog re-filters by `memberAgentId` and
     * `status === 'idle'`.
     */
    onStatus(handler: (payload: {
        agentId: string;
        status: string;
    }) => void): () => void;
    /** Current durable context size of the watched member, or `undefined` when unavailable. */
    measureTokens(): number | undefined;
    /**
     * One idle compaction attempt. Return `null` for "no compactable range" and
     * for the expected `ManualCompactionError('busy')` race (queued waking work
     * arrived between the idle event and the call); reject only for real
     * failures, which become `failed` records and a warn log. Never retried
     * eagerly: the next `idle` event re-evaluates from scratch.
     */
    compact(): Promise<{
        shadowedTokenCount?: number;
    } | null>;
    /** Durable bookkeeping and steering hooks; may be sync or throw. */
    record(event: MemberContextWatchdogEvent): void;
    /** Bounded diagnostics channel. */
    log(level: 'info' | 'warn', message: string): void;
    /** Clock override for tests (default `Date.now`). */
    now?: () => number;
}
/**
 * Install the idle context watchdog for one member and return its disposer.
 *
 * Only `agent/status → idle` for exactly `options.memberAgentId` triggers
 * evaluation; the installer owns single-flight (one compaction at a time), the
 * `decideMemberContextAction` gating, and the `measured` bookkeeping that
 * keeps usage visible even below budget. `turnsSinceCompact` is maintained
 * here: every `status → running` event for the watched member widens the gap,
 * and a successful compaction resets it to 0, so `minTurnGap: 1` requires a
 * full turn between two compactions.
 */
export declare function installMemberContextWatchdog(deps: MemberContextWatchdogDeps, options: {
    memberAgentId: string;
    budgetTokens: number;
    config: MemberContextConfig;
}): () => void;
/**
 * Validate the plugin-level `memberContext` block once at mount, so a
 * malformed owner configuration fails loudly instead of at the first idle
 * member. `undefined` passes through: an unconfigured block must register
 * nothing and change no behavior (plan-02 acceptance).
 * @returns the validated config, or `undefined` when unconfigured.
 */
export declare function parseMemberContextConfig(config: MemberContextConfig | undefined): MemberContextConfig | undefined;
