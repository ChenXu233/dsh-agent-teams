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
function positiveFinite(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
/** The routed provider/model of one live agent, or undefined when unset. */
function currentRouteOf(agent) {
    const session = agent.session;
    const configured = typeof session.requestHeader === 'function' ? session.requestHeader()?.config : undefined;
    const provider = configured?.provider ?? agent.options.provider;
    const model = configured?.model ?? agent.options.model;
    return provider === undefined || model === undefined || provider === '' || model === ''
        ? undefined
        : { provider, model };
}
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
export async function resolveMemberContextWindow(agent, signal) {
    const route = currentRouteOf(agent);
    if (route === undefined)
        return undefined;
    const llm = agent.ctx.llm;
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function')
        return undefined;
    try {
        const info = await llm.resolveModelInfo(route.provider, route.model, signal);
        return positiveFinite(info.context?.contextWindow);
    }
    catch {
        return undefined;
    }
}
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
export function resolveMemberContextBudget(input) {
    const config = input.config;
    if (config === undefined)
        return undefined;
    const candidates = [];
    const memberTokens = positiveFinite(input.memberContextMaxTokens);
    if (memberTokens !== undefined)
        candidates.push({ tokens: memberTokens, source: 'member' });
    const pluginTokens = positiveFinite(config.maxTokens);
    if (pluginTokens !== undefined)
        candidates.push({ tokens: pluginTokens, source: 'plugin' });
    const ratio = positiveFinite(config.maxRatio);
    if (ratio !== undefined) {
        const contextWindow = positiveFinite(input.contextWindow);
        // Unknown window: only the ratio-derived candidate is dropped; an explicit
        // member or plugin token budget stays authoritative.
        if (contextWindow !== undefined)
            candidates.push({ tokens: Math.floor(contextWindow * ratio), source: 'plugin' });
    }
    if (candidates.length === 0)
        return undefined;
    return candidates.reduce((smallest, candidate) => (candidate.tokens < smallest.tokens ? candidate : smallest));
}
/**
 * The pure idle-watchdog decision, evaluated per `agent/status → idle`.
 *
 * `skip` keeps the member untouched: budget not reached, `onLimit: 'off'`,
 * inside the cooldown window, or before `minTurnGap` turns have passed.
 * `notify` records and surfaces the over-budget state without compacting;
 * `compact` runs one idle compaction. The caller supplies its own clock and
 * counters, so cooldown and turn-gap semantics are testable without a Harness.
 */
export function decideMemberContextAction(input) {
    if (input.mode === 'off')
        return 'skip';
    if (!(input.usedTokens >= input.budgetTokens))
        return 'skip';
    // `lastCompactAt === 0` means never-compacted: cooldown and turn gap guard
    // only *repeat* compactions, so the first over-budget idle instant acts
    // immediately instead of waiting out a synthetic window.
    if (input.lastCompactAt > 0 && input.now - input.lastCompactAt < input.cooldownMs)
        return 'skip';
    if (input.lastCompactAt > 0 && input.turnsSinceCompact < input.minTurnGap)
        return 'skip';
    return input.mode === 'notify' ? 'notify' : 'compact';
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
export function installMemberContextWatchdog(deps, options) {
    const nowOf = typeof deps.now === 'function' ? deps.now : Date.now;
    const mode = options.config.onLimit ?? 'compact';
    const cooldownMs = options.config.cooldownMs ?? 60_000;
    const minTurnGap = options.config.minTurnGap ?? 1;
    let lastCompactAt = 0;
    let turnsSinceCompact = 0;
    let inFlight = false;
    let warnedMissingMeter = false;
    const emitUsage = (event) => {
        try {
            deps.record(event);
        }
        catch (error) {
            deps.log('warn', `member ${options.memberAgentId} context bookkeeping failed: ${String(error)}`);
        }
    };
    const handleIdle = () => {
        if (inFlight)
            return;
        // Sample on every idle instant, budget or not: this measurement is what
        // keeps member usage visible (status/snapshot) without waking cold agents.
        const used = deps.measureTokens();
        if (used === undefined || !Number.isFinite(used)) {
            if (!warnedMissingMeter) {
                warnedMissingMeter = true;
                deps.log('warn', `member ${options.memberAgentId} context watchdog has no token measurement; budget check skipped`);
            }
            return;
        }
        emitUsage({ kind: 'measured', tokens: used });
        const action = decideMemberContextAction({
            usedTokens: used,
            budgetTokens: options.budgetTokens,
            now: nowOf(),
            lastCompactAt,
            turnsSinceCompact,
            cooldownMs,
            minTurnGap,
            mode,
        });
        if (action === 'skip')
            return;
        if (action === 'notify') {
            emitUsage({ kind: 'notified', tokens: used });
            deps.log('info', `member ${options.memberAgentId} context usage ${used} reached its budget ${options.budgetTokens}`);
            return;
        }
        inFlight = true;
        void deps.compact()
            .then((result) => {
            if (result !== null) {
                lastCompactAt = nowOf();
                turnsSinceCompact = 0;
                emitUsage({ kind: 'compacted', shadowedTokens: result?.shadowedTokenCount });
                deps.log('info', `member ${options.memberAgentId} idle compaction finished (was ${used} tokens, budget ${options.budgetTokens})`);
            }
            // null: nothing compactable, or a busy race the host already absorbed.
        })
            .catch((error) => {
            // Defense in depth: the host adapter normally returns null for the
            // expected busy race, but absorb that class here too so queued waking
            // work can never surface as a failure. Never retried in place — the
            // next idle event re-evaluates from scratch.
            if (isBusyCompactionError(error)) {
                deps.log('info', `member ${options.memberAgentId} idle compaction skipped: another activity owns the agent (busy)`);
                return;
            }
            emitUsage({ kind: 'failed', reason: String(error) });
            deps.log('warn', `member ${options.memberAgentId} context compaction failed: ${String(error)}`);
        })
            .finally(() => {
            inFlight = false;
        });
    };
    return deps.onStatus((payload) => {
        if (payload.agentId !== options.memberAgentId)
            return;
        if (payload.status === 'running') {
            // Each entered turn widens the gap the next compaction must respect
            // (plan-02 semantics: turnsSinceCompact counts status → running entries).
            turnsSinceCompact += 1;
            return;
        }
        // The only compaction entry point: the idle transition. Never agent/pre-step,
        // never mid-turn — compactNow and Harness auto-compaction are mutually exclusive.
        if (payload.status !== 'idle')
            return;
        handleIdle();
    });
}
/** Whether an error is the expected busy rejection of an idle compaction. */
function isBusyCompactionError(error) {
    return error instanceof Error && error.name === 'ManualCompactionError'
        && error.code === 'busy';
}
/**
 * Validate the plugin-level `memberContext` block once at mount, so a
 * malformed owner configuration fails loudly instead of at the first idle
 * member. `undefined` passes through: an unconfigured block must register
 * nothing and change no behavior (plan-02 acceptance).
 * @returns the validated config, or `undefined` when unconfigured.
 */
export function parseMemberContextConfig(config) {
    if (config === undefined)
        return undefined;
    const maxTokens = positiveFinite(config.maxTokens);
    const maxRatio = positiveFinite(config.maxRatio);
    if (maxTokens === undefined && maxRatio === undefined) {
        throw new Error('memberContext requires a positive maxTokens or maxRatio threshold');
    }
    if (maxRatio !== undefined && maxRatio <= 0) {
        throw new Error('memberContext.maxRatio must be greater than 0');
    }
    const cooldownMs = config.cooldownMs ?? 60_000;
    const minTurnGap = config.minTurnGap ?? 1;
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0) {
        throw new Error('memberContext.cooldownMs must be a non-negative integer');
    }
    if (!Number.isSafeInteger(minTurnGap) || minTurnGap < 0) {
        throw new Error('memberContext.minTurnGap must be a non-negative integer');
    }
    const onLimit = config.onLimit ?? 'compact';
    return {
        ...maxTokens === undefined ? {} : { maxTokens },
        ...maxRatio === undefined ? {} : { maxRatio },
        cooldownMs,
        minTurnGap,
        onLimit,
    };
}
