/**
 * AgentTeams for DeepSeek Harness.
 *
 * A host-plane plugin that registers the `agent_teams_*` tools and one usage
 * agent-scoped usage section. Each session keeps a stable tool set and core
 * instructions. Existing business tools cover the complete team lifecycle.
 * After installation any session can
 * run multi-agent teamwork through natural language (e.g. "use AgentTeams to research X"):
 * the model creates a team (it becomes the captain), spawns members as
 * durable continuable subagents, breaks the goal into tasks with
 * dependencies, wakes members with messages, relays reports, and collects
 * results.
 *
 * Installation (bundle): `dsh plugin --profile <name> add @chenxu233/dsh-agent-teams`
 * (or a local path). The bundle patch mounts this plugin row into the host
 * composition; the tools register into the shared `tools` registry and the
 * usage section into the global system prompt, so the plugin needs no realm.
 *
 * @module dsh-agent-teams
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Declaration merges make ctx.subagents and ctx.systemPrompt visible.
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import {
  haltTeamWork,
  stagedPlanApprovedContext,
  registerAgentTeamsTools,
  normalizeMemberCommandDeny,
  type StagedPlanMutation,
  type ToolsConfig,
} from './tools.ts'
import { installAgentTeamsGestureBoundary, registerAgentTeamsCommand } from './command.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectArchivedTeamsActivity, collectTeamsActivity } from './snapshot.ts'
import { findTeamByCaptain } from './state.ts'
import { findTeamByMemberSession, listMemberSessions, sessionStoreOf } from './member-address.ts'
import { MemberCommandError, executeMemberCommand } from './member-command.ts'
import { MemberRemoteService, memberArchived, memberViewOf } from './member-remote.ts'
import { isParked, parkMember, parkedMessageId, unparkMember } from './member-residency.ts'
import { applyMemberRoute } from './member-route-registry.ts'
import { leadIdentityOfAsync } from './lineage.ts'
import { formatProfilesForPrompt, type TeamProfileConfig } from './profiles.ts'
import { parseToolPolicies, type MemberToolPolicy } from './tool-policies.ts'
import { deliverToMember, interruptMember, liveMemberAgent, resolveMemberAgent } from './members.ts'
import { installTeamCapabilities } from './capabilities.ts'
import { agentTeamsSource, observedSessionFormatVersion } from './harness-compat.ts'
import { TEAM_TOOL_NAMES } from './tool-names.ts'
import { parseMemberContextConfig, type MemberContextConfig } from './member-context.ts'

import { authenticatedWebRoutes, readJsonRequest, RequestBodyError, type BrowserRequestGate, type WebRouteHost } from './web-routes.ts'

/** One command descriptor as the member composer's menu needs it. */
interface CommandDescriptorView {
  readonly name: string
  readonly description?: string
  readonly input?: { readonly hint?: string; readonly attachments?: boolean }
}

/**
 * Last live command catalog per member session.
 *
 * `commands.list()` takes an Agent, and a settled member page is rendered from
 * the durable log with no Agent attached. Remembering the live answer keeps the
 * `/` menu populated on a cold page instead of silently empty.
 */
const memberCommandCatalog = new Map<string, readonly CommandDescriptorView[]>()

/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const
/** Workspace registry service key candidates, newest first. */
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'] as const

export const name = 'agent-teams'
// Required services only — exactly what upstream v0.1.25 required.
//
// The optional per-member context budget (plan 02) reads `tokenMeter` and
// `compaction` STRUCTURALLY at the watchdog boundary (see
// `optionalMemberTokenMeter` / `optionalMemberCompaction` in members.ts). Never
// list them here: a real deployment may keep them out of this plugin's scope.
// The desktop profile disables the top-level `compaction-basic` and composes a
// compaction engine INSIDE each agent preset, so requiring `compaction` left the
// plugin `pending (waiting for service: compaction)` forever — no tools, no
// routes, no panel (observed 2026-10-22 on the installed build). An unconfigured
// `memberContext` keeps zero new behavior, which is the intended fallback.
export const inject = ['tools', 'llm', 'subagents', 'systemPrompt', 'agents']

/** Plugin configuration. */
export interface Config {
  /**
   * State directory name under the captain's workspace; team state lives at
   * `<workspace>/<stateDir>/<teamId>/` (default `.agent-teams`).
   */
  stateDir?: string
  /** `ctx.subagents` provider used to spawn members; must support continuable children and personas (default `spawn`). */
  memberProvider?: string
  /**
   * Optional model override applied to every member. The id is used verbatim.
   * When the captain's provider does not advertise it, the provider that does
   * is resolved from the live catalogs (only if exactly one advertises it);
   * set `memberLlmProvider` to name the owner explicitly instead.
   */
  memberModel?: string
  /**
   * LLM provider route that owns `memberModel`. Set this when the member model
   * is served by a different provider than the captain's session; without it
   * the captain's provider is only used if it actually advertises the model,
   * and an ambiguous or unowned model fails with the provider catalogs instead
   * of being silently paired with the captain's route (issue #189).
   * Distinct from `memberProvider`, which is the subagent runtime backend.
   */
  memberLlmProvider?: string
  /** Prompt injected into member personas and automatic task assignments. */
  executionPrompt?: string
  /** Plugin-wide fallback route for unavailable member models. */
  fallback?: import('./profiles.ts').TeamModelFallbackConfig
  /** Member delegation depth cap (default `0`; `0` forbids delegation entirely). */
  memberMaxDepth?: number
  /** Team size cap in members (default `8`). */
  maxMembers?: number
  /** Named multi-role team profiles. */
  profiles?: Record<string, TeamProfileConfig>
  /**
   * Reusable per-member tool policies declared by the deployment owner (#59),
   * keyed by policy id. A member selects one by id (`tool_policy` on
   * `agent_teams_add_member`, a plan member, or a profile member row); the
   * Captain model can select an existing policy but never submit raw lists.
   * `allow` keeps only the named global tools (the four coordination tools are
   * always added); `deny` removes the named global tools. Captain-only tools
   * stay denied either way.
   */
  toolPolicies?: Record<string, MemberToolPolicy>
  /**
   * Plugin-level per-member context budget. A member's own
   * `context_max_tokens` (profile row, `agent_teams_add_member`, plan member,
   * or `edit_plan` update) beats this default; when both a ratio and an
   * absolute value resolve, the smaller budget wins. When the whole object is
   * absent nothing is registered: no watchdog, no fields, no behavior change.
   */
  memberContext?: MemberContextConfig
  /**
   * Command names `agent_teams_run_command` may never issue into a member
   * session. Default `["agent-teams"]`: this plugin's own activation surface.
   *
   * Write names WITHOUT the leading slash; entries are normalized (surrounding
   * whitespace, any number of leading slashes and case are ignored), so
   * `"compact"`, `"/compact"`, `"Compact"` and `" /COMPACT "` are the same
   * switch. Every entry also blocks its whole `<entry>-*` family, so
   * `"review"` denies `/review-tools` as well. An explicit `[]` denies
   * NOTHING — the built-in `agent-teams` protection included — because the
   * array is a literal replacement, not an addition. An entry that carries no
   * usable command name fails the plugin load (see `parseMemberCommandDeny`)
   * instead of silently denying nothing.
   */
  memberCommandDeny?: string[]
  /** Prompt-section order for the usage policy (default `117`, after delegation policy). */
  promptSectionOrder?: number
  /**
   * Register the deterministic `/agent-teams` activation surfaces (the
   * closed-namespace slash command and the plain-text gesture boundary).
   * Disable to keep the natural-language trigger as the only entry point.
   */
  slashCommand?: boolean
}

// `z.object()` has an implicit `{}` default in Schemastery.  Fallback routes
// are optional, so model absence explicitly; otherwise a missing route is
// validated as an empty object and fails on the required provider/model keys.
const fallbackRouteConfig = z.union([
  z.object({ provider: z.string().required(), model: z.string().required() }),
  z.const(undefined),
])

// Same Schemastery defaulting trap for a tool policy: an `allow`-only policy
// would materialize `deny: []` and fail a `.min(1)` on an absent list. Model
// each accepted combination explicitly, so a policy that declares only one
// side stays valid while an empty side is still rejected.
const toolPolicyConfig = z.union([
  z.object({ allow: z.array(z.string()).min(1).required(), deny: z.const(undefined) }),
  z.object({ allow: z.const(undefined), deny: z.array(z.string()).min(1).required() }),
  z.object({ allow: z.array(z.string()).min(1).required(), deny: z.array(z.string()).min(1).required() }),
])

// Plan-02 budget thresholds. `maxTokens` and `maxRatio` are alternatives; the
// resolved budget takes the smaller of whichever are set, and a ratio without
// a knowable model context window disables the watchdog instead of guessing.
// Same Schemastery trap as the fallback route: a bare `z.object()` for an
// optional block materializes `{}` when the key is absent, and the parser then
// rejects a block that the deployment never wrote. Model absence explicitly so
// an unconfigured `memberContext` stays `undefined` (feature off, zero new
// behavior) while a written block still needs a threshold.
const memberContextConfig = z.union([
  z.object({
    maxTokens: z.natural(),
    maxRatio: z.number(),
    cooldownMs: z.natural().default(60_000),
    minTurnGap: z.natural().default(1),
    onLimit: z.union([z.const('compact'), z.const('notify'), z.const('off')]).default('compact'),
  }),
  z.const(undefined),
])

export const Config: z<Config> = z.object({
  stateDir: z.string().default('.agent-teams'),
  memberProvider: z.string().default('spawn'),
  memberModel: z.string(),
  memberLlmProvider: z.string(),
  executionPrompt: z.string(),
  fallback: fallbackRouteConfig,
  profiles: z.dict(z.object({
    description: z.string(),
    protocol: z.string(),
    executionPrompt: z.string(),
    fallback: fallbackRouteConfig,
    members: z.array(z.object({
      name: z.string().required(),
      role: z.string(),
      provider: z.string(),
      model: z.string(),
      reasoning_effort: z.string(),
      executionPrompt: z.string(),
      fallback: fallbackRouteConfig,
      // Owner-declared tool-policy id this profile member selects (#59).
      tool_policy: z.string(),
    })).min(1).required(),
    taskPlanning: z.union([z.const('captain'), z.const('seed')]),
    reviewPolicy: z.object({
      requirementsMinRounds: z.natural().min(1),
      requirementsMaxRounds: z.natural().min(1),
      codeMaxRounds: z.natural().min(1),
      maxRepairAttempts: z.natural().min(1),
      requiredReviewers: z.array(z.string()),
    }),
    tasks: z.array(z.object({
      id: z.string().required(),
      subject: z.string().required(),
      description: z.string(),
      assignee: z.string(),
      dependencies: z.array(z.string()),
    })),
  })).default({}),
  toolPolicies: z.dict(toolPolicyConfig).default({}),
  memberContext: memberContextConfig,
  memberCommandDeny: z.array(z.string()),
  memberMaxDepth: z.natural().default(0),
  maxMembers: z.natural().min(1).default(8),
  promptSectionOrder: z.natural().default(117),
  slashCommand: z.boolean().default(true),
})

/**
 * Normalize the Web plan route's optional `context_max_tokens` payload field.
 *
 * Three states matter and must not collapse: a field that is not provided
 * leaves the member's current budget untouched (no key), an explicit `null`
 * clears it back to the plugin default (`null`), and a real budget must be a
 * positive safe integer (passed through). Anything else — `0`, negatives,
 * strings, other types — fails the request instead of being silently dropped.
 */
function contextMaxTokensFromPlanPayload(value: unknown): { contextMaxTokens: number | null } | {} {
  if (value === undefined) return {}
  if (value === null) return { contextMaxTokens: null }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return { contextMaxTokens: value }
  throw new Error('context_max_tokens must be a positive integer or null')
}

/** The model-facing usage policy: when and how to drive AgentTeams. */
export function usageSectionText(toolNames: string, profilesText = ''): string {
  return `AgentTeams captain protocol:
1. Inspect current team state when needed, using agent_teams_status. Continue existing work without duplicating its roster/tasks. Create only when no current team exists, with the user's goal as description and approval="required"; automatic approval requires an explicit request to run immediately. Staged plans never spawn or schedule work.
2. Add each needed role once; members inherit your model route unless another is requested/needed. A requested profile goes to create({profile}); it supplies its roster. Seed profiles also supply tasks; captain-planning profiles require your DAG. Do not duplicate either. A member may also select one owner-declared tool policy by id (tool_policy on add_member, a plan member, or a profile member): it is the only way to change which global tools that member sees and may invoke, and you can never pass raw allow/deny lists. A member may also carry its own context budget (context_max_tokens on a plan member row, agent_teams_add_member, or a staged edit_plan update_member; a positive integer, or null to clear back to the plugin default): give a member you expect to run long tasks a tighter budget than the plugin default so it is auto-compacted at idle before its context balloons. The member-level value and the plugin default resolve to the smaller one — it can only tighten, never loosen; when the deployment configures no memberContext default, the member-level value alone applies.
3. Build the complete smallest useful DAG while staged. For an ordinary research/audit plan, pass the roster and dependency graph together in create({plan:{members,tasks}}) to avoid repeated setup rounds. Every task needs a subject; pass kind and assignee explicitly when the plan specifies them. Titles, descriptions and member roles do not set these fields. Dependencies represent prerequisites. Give every required contributor a task or explicit message. Present the plan and end your turn for review; never approve in that planning turn. Approve only after a later explicit user approval or the Web action.
4. Respect Web approve/return/discard control messages. On return, ask what to change before editing; after the answer, use one atomic agent_teams_edit_plan batch (edit downstream references before removals), summarize and await review again. Never inspect or edit .agent-teams state files or plugin source code to revise plans. Discard does not authorize a replacement.
5. The scheduler dispatches ready tasks after approval. Delegate; do not duplicate slow work or send messages merely to start a stage. Handle reports/user work, then yield when waiting is all that remains: reports wake you automatically. Use status after a delivery or user request, never busy-poll or wait for unassigned members.
6. Tasks carry attempt_id capabilities. Use the current attempt_id; stale means ownership changed. Pause members only on explicit request; later guidance via send_message continues that same attempt. Retry, transfer or take over through reassign_task first; it revokes the old attempt and waits for quiescence. Prefer a member. Captain implementation/review takeover requires a user request. Every takeover is one ready task at a time, finished in this turn; never yield with captain-owned work open.
7. In a running team, correct never-started pending tasks with edit_plan update_task; preserve dependency and ownership contracts instead of cancelling and recreating the graph. A captain can cancel a never-started pending task directly. Active attempts still require reassign_task. Quality kinds (requirements, implementation, verification, review, repair, integration) require objective + acceptance; implementation/repair also require inScope + verify. Derive paths/commands from the workspace/profile, never assume src/ or pnpm test. Review/requirements complete only with verdict=pass; needs_revision/reject fail with findings. Never approve your own implementation or ask for a deliberate failure. When a quality contract itself is wrong (a verify command that cannot pass, an inScope that forbids the file the objective requires), fix it with agent_teams_amend_task — captain-only, non-terminal tasks only, frozen after a passing review, and every amendment is recorded in the task's revisions ledger — instead of letting the worker dead-lock or game the gate.
8. When full quality mode is requested: requirements → implementation → verification → review → integration. Plan the entire DAG while staged, including implementation before requirements finishes and integration depending on review round 1. Failed review automatically adds repair + next review and rewires pending downstream gates. Do not recreate this loop, omit integration or depend on a failed task. Review acceptance judges the latest implementation. Do not put smoke-test scripts into task instructions.
9. Halted means the user stopped work (including the captain turn). Resume only on a later explicit user request with a reason, via agent_teams_resume or create_task({resume:true,resumeReason}); creating tasks alone never resumes. Escalated means the review loop hit its limit, not a halt. Deployment requires explicit user confirmation.
10. Wait for all required tasks to be terminal and members idle/ready, present results, then delete/archive unless the user wants to continue. Never discard unfinished work without authorization.
Tools: ${toolNames}${profilesText === '' ? '' : `\n\n${profilesText}`}`
}

/**
 * Resolve `memberCommandDeny` once, at mount, and fail loudly when an entry
 * carries no usable command name. Entries are normalized (surrounding
 * whitespace, leading slashes and case are ignored), so `'/Compact'` cannot
 * silently disable the switch. An explicitly empty array still denies nothing:
 * that literal replacement is deliberate (N3).
 */
function parseMemberCommandDeny(entries: readonly string[] | undefined): string[] {
  const { names, dropped } = normalizeMemberCommandDeny(entries)
  if (dropped.length > 0) {
    // The first sentence must read as a plugin LOAD failure: the mount never
    // completes, so nothing is registered and no command can be issued at all.
    throw new Error(`AgentTeams plugin failed to load: memberCommandDeny is invalid (an unusable entry fails the mount instead of silently denying nothing). memberCommandDeny contains ${dropped.length === 1 ? 'an entry' : 'entries'} with no usable command name (${dropped.map((entry) => JSON.stringify(entry)).join(', ')}); write names without the leading slash, e.g. "compact"`)
  }
  return [...names]
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ToolsConfig = {
    stateDir: config.stateDir ?? '.agent-teams',
    memberProvider: config.memberProvider ?? 'spawn',
    memberModel: config.memberModel,
    memberLlmProvider: config.memberLlmProvider,
    executionPrompt: config.executionPrompt,
    fallback: config.fallback,
    memberMaxDepth: config.memberMaxDepth ?? 0,
    maxMembers: config.maxMembers ?? 8,
    profiles: config.profiles ?? {},
    // Owner configuration is validated once, at mount: an empty or malformed
    // policy must never reach a member creation path.
    toolPolicies: parseToolPolicies(config.toolPolicies),
    // Validated once at mount; `undefined` when the whole `memberContext` block
    // is absent, which keeps every downstream path on the previous behavior
    // (no watchdog, no accounting, no extra fields).
    memberContext: parseMemberContextConfig(config.memberContext),
    // Command deny list for agent_teams_run_command, normalized once here so
    // '/compact', 'Compact' and ' compact ' are the same switch and an unusable
    // entry fails the mount instead of silently denying nothing. The plugin's
    // own agent-teams surface stays the safe default.
    memberCommandDeny: parseMemberCommandDeny(config.memberCommandDeny),
  }

  // Provider registration is a sibling plugin's effect (`subagent-spawn` /
  // `subagent-fork` rows), which can land after this mount under the Loader's
  // concurrent activation — so capability validation happens at the first
  // member spawn (`spawnMember`), the earliest point the provider list is
  // settled, rather than here.

  const agentTeamsRuntime = registerAgentTeamsTools(ctx, resolved)
  // Plugin-owned Remote namespace (plan 10): the host Session Remote refuses
  // every subagent-owned session, so the member composer talks to this service
  // instead. The Gateway discovers it through the `typertRemote` binding.
  // A Remote service registers through the Cordis service registry; fake
  // contexts used by the plugin's own tests have no reflector, so the surface
  // is mounted only on a real Host context.
  const cordis = ctx as unknown as { reflect?: unknown; root?: unknown }
  if (cordis.reflect !== undefined && cordis.root !== undefined) {
    ctx.effect(() => {
      new MemberRemoteService(ctx, { stateDir: resolved.stateDir, deny: resolved.memberCommandDeny ?? [] })
      return () => undefined
    }, 'agent-teams: member remote namespace')
  }
  installTeamCapabilities(ctx, {
    stateDir: resolved.stateDir,
    isPendingMember: agentTeamsRuntime.isPendingMember,
    order: config.promptSectionOrder,
    // Keep the bounded profile directory available without extra tool calls.
    // installTeamCapabilities snapshots this once; no business state rewrites it.
    captainPrompt: () => usageSectionText(TEAM_TOOL_NAMES.join(', '), formatProfilesForPrompt(config.profiles)),
  })

  // Deterministic activation surfaces: the closed-namespace `/agent-teams`
  // host command (surfaces in the Web GUI slash menu via the Harness
  // ui-commands client) and the plain-text gesture boundary for surfaces
  // without command adjudication (headless CLI). Both default on; a profile
  // can disable them to keep the natural-language trigger exclusive.
  //
  // `commands` is registered lazily (not a required inject): it ships in the
  // base bundle of every standard profile, but a minimal composition that
  // omits the command registry keeps the plugin fully functional — the fiber
  // never pends on it and simply never gains the slash command.
  if (config.slashCommand ?? true) {
    ctx.inject(['commands'], (commandCtx) => {
      registerAgentTeamsCommand(commandCtx, () => config.profiles ?? {})
    })
    installAgentTeamsGestureBoundary(ctx, () => config.profiles ?? {})
  }

  // The activity panel data/artwork routes need the Web server and the
  // workspace registry, which headless profiles do not mount; under
  // concurrent activation they may also bind after this plugin. Register the
  // routes lazily: try now, then on each service binding event. In a webless
  // profile the plugin stays tool-only and never blocks boot.
  let webRegistered = false
  const registerWebSurface = (): void => {
    if (webRegistered) return
    const rawWebServer = (ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1])) as WebRouteHost | undefined
    const workspaceRegistry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1])) as WorkspaceRegistry | undefined
    if (rawWebServer === undefined || workspaceRegistry === undefined) return
    const webServer = authenticatedWebRoutes(rawWebServer, () => ctx.get('connection') as BrowserRequestGate | undefined)
    webRegistered = true

    // Activity panel data route: the browser floater polls this for team
    // snapshots (disk truth + live subagent activity). Mirrors the Claude
    // Code desktop watcher's server-side snapshot pattern.
    ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-agent-teams/state',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const roots = workspaceRegistry.list().map((workspace) => ({
        workspace: workspace.title,
        // The panel audits the same current bytes as agent_teams_status, so it
        // cannot advertise a passing gate over a changed revision (#161).
        workspacePath: workspace.path,
        stateRoot: join(workspace.path, resolved.stateDir),
      }))
      // ?archived=1 serves teams moved to archive/ (post-delete review).
      const snapshots = url.searchParams.get('archived') === '1'
        ? await collectArchivedTeamsActivity(ctx, roots)
        : await collectTeamsActivity(ctx, roots)
      const body = JSON.stringify({ teams: snapshots })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(body)
    },
  }), 'agent-teams: activity route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-teams/halt',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
          res.end()
          return
        }
        let payload: Record<string, unknown>
        try {
          payload = await readJsonRequest(req)
        } catch (error: unknown) {
          res.writeHead(error instanceof RequestBodyError ? error.status : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'invalid request body' }))
          return
        }
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
        const teamId = typeof payload.teamId === 'string' ? payload.teamId.trim() : ''
        if (sessionId === '' || teamId === '') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'sessionId and teamId are required' }))
          return
        }
        const captain = ctx.agents.get(sessionId as import('@deepseek-ai/dsh-session').SessionId)
        if (captain === undefined) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'captain session is not attached' }))
          return
        }
        const workspace = captain.session.header.cwd ?? process.cwd()
        const stateRoot = join(workspace, resolved.stateDir)
        const team = await findTeamByCaptain(stateRoot, captain.id, await leadIdentityOfAsync(ctx, captain.session))
        if (team === undefined || team.id !== teamId) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'team not found for this captain' }))
          return
        }
        try {
          const result = await haltTeamWork({
            ctx,
            stateRoot,
            teamId,
            captain,
          })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(result))
        } catch (error: unknown) {
          ctx.logger.warn(`agent-teams: halt failed for ${teamId}: ${String(error)}`)
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'failed to stop the team' }))
        }
      },
    }), 'agent-teams: halt route')

    // Member relay route: the member-facing composer knows only its own session
    // id, so this route resolves the owning team from that id. A line starting
    // with "/" runs on the in-process command bus (the host's client-facing
    // command API refuses subagent-owned sessions); anything else is queued
    // through the parent's delivery channel, which is the only legal way to
    // open a turn on a child session.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-teams/member/relay',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
          res.end()
          return
        }
        let payload: Record<string, unknown>
        try {
          payload = await readJsonRequest(req)
        } catch (error: unknown) {
          res.writeHead(error instanceof RequestBodyError ? error.status : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'invalid request body' }))
          return
        }
        const memberSessionId = typeof payload['memberSessionId'] === 'string' ? payload['memberSessionId'].trim() : ''
        const line = typeof payload['line'] === 'string' ? payload['line'].trim() : ''
        // A running member can be steered into its current step; an idle one
        // queues the line as its next turn. The client picks the mode from the
        // live state it just read, and an unknown value stays the safe default.
        const mode = payload['mode'] === 'steer' ? 'steer' as const : 'queue' as const
        if (memberSessionId === '' || line === '') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'memberSessionId and line are required' }))
          return
        }
        // No attached-session requirement: a member page is normally rendered
        // from the durable log, and both paths below can serve that. A command
        // resolves the member through the typert agent lookup, which resumes a
        // cold member (the documented way to issue that member's own command);
        // plain text still needs the live captain, checked below.
        const located = await findTeamByMemberSession(ctx, memberSessionId, resolved.stateDir)
        const found = located === undefined
          ? undefined
          : { teamId: located.team.id, captainId: located.team.captainSessionId, memberName: located.member.name }
        if (found === undefined) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'this session is not a member of any team in this workspace' }))
          return
        }
        try {
          if (line.startsWith('/')) {
            const commands = (ctx as unknown as { get?: (name: string) => unknown }).get?.('commands') as undefined | {
              execute: (agent: unknown, line: string, attachments: readonly unknown[], signal: AbortSignal) => Promise<undefined | { commandId: string; result: { kind: 'success' | 'error'; text?: string } }>
            }
            if (commands === undefined) {
              res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ error: 'the host command service is not composed in this deployment' }))
              return
            }
            const agent = await resolveMemberAgent(ctx, memberSessionId)
            if (agent === undefined) {
              // Compaction (and every other host command) runs against a live
              // Agent, and a member page is normally a cold transcript: the host
              // renders the durable log without attaching the child. Say what to
              // do instead of naming an internal lookup.
              res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({
                error: `成员「${found.memberName}」当前未激活（冷会话），命令需要它先跑起来：先给这个成员发一条消息，等它开始运行后再执行 /命令。`,
              }))
              return
            }
            // The residency placeholder is "waking queued work" to the host's
            // maintenance admission, so `/compact` would refuse with "agent is
            // not idle" while the member is parked. Drop it for the command and
            // park again once the command settled.
            const placeholder = parkedMessageId(agent)
            if (placeholder !== undefined) unparkMember(agent, placeholder)
            try {
              // Human-driven: the deny list protects the model-facing tool, not a
              // person typing in the member's own conversation.
              const result = await executeMemberCommand({ commands, agent, line, signal: new AbortController().signal })
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify(result))
              return
            } catch (error: unknown) {
              if (error instanceof MemberCommandError) {
                res.writeHead(error.code === 'command/denied' ? 403 : 422, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                res.end(JSON.stringify({ error: error.message }))
                return
              }
              throw error
            } finally {
              // Park again once the command settled, so the member stays live
              // for the next command instead of going cold.
              const after = liveMemberAgent(ctx, memberSessionId)
              if (after !== undefined && after.status === 'idle' && !isParked(after)) parkMember(after)
            }
          }
          const captain = ctx.agents.get(found.captainId as import('@deepseek-ai/dsh-session').SessionId)
          if (captain === undefined) {
            res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ error: 'the captain session is not attached; plain text needs the parent to be online' }))
            return
          }
          const delivered = await deliverToMember(ctx, captain, memberSessionId, line, new AbortController().signal, mode)
          if (!delivered) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ error: 'failed to deliver the prompt to the member' }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, kind: 'delivered' }))
        } catch (error: unknown) {
          ctx.logger.warn(`agent-teams: member relay failed for ${found.memberName}: ${String(error)}`)
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'failed to relay the line to the member session' }))
        }
      },
    }), 'agent-teams: member relay route')

    // Membership probe for the member composer seat (plan 10, §4.4): the client
    // cannot read team state, so it asks which subagent conversations belong to
    // an AgentTeams team before claiming the composer.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-teams/member/membership',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
          res.end()
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')?.trim() ?? ''
        if (sessionId === '') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'sessionId is required' }))
          return
        }
        const store = sessionStoreOf(ctx)
        // A composition without a readable session store is not the same answer
        // as "this session is not a member": say so instead of letting the
        // client cache a wrong verdict forever.
        if (store === undefined) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'the host session store is not readable' }))
          return
        }
        const located = await findTeamByMemberSession(ctx, sessionId, resolved.stateDir)
        if (located === undefined) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'not a member session' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({
          member: located.member.name,
          teamId: located.team.id,
          archived: memberArchived(located),
        }))
      },
    }), 'agent-teams: member membership route')

    // Roster of member sessions for the client's model seat (plan 10, task 9).
    // The seat decides "is this session a member?" synchronously while the
    // composer renders, so the page prefetches the whole roster once instead of
    // probing per session and racing the first paint.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-teams/member/sessions',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
          res.end()
          return
        }
        if (sessionStoreOf(ctx) === undefined) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'the host session store is not readable' }))
          return
        }
        const members = await listMemberSessions(ctx, resolved.stateDir)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ sessions: members }))
      },
    }), 'agent-teams: member sessions route')

    // Command catalog for the member composer's `/` menu (plan 10, §5.2). The
    // host's `commands/list` refuses subagent sessions, so the plugin reads the
    // member's own session on the in-process bus. Human-driven: the deny list
    // protects the model-facing tool, not a person typing in the conversation.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-teams/member/commands',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
          res.end()
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')?.trim() ?? ''
        if (sessionId === '') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'sessionId is required' }))
          return
        }
        const located = await findTeamByMemberSession(ctx, sessionId, resolved.stateDir)
        if (located === undefined) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'not a member session' }))
          return
        }
        const commands = (ctx as unknown as { get?: (name: string) => unknown }).get?.('commands') as
          | undefined
          | { list: (agent: unknown) => readonly CommandDescriptorView[] }
        if (commands === undefined) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'the host command service is not composed' }))
          return
        }
        // The member page is normally opened on a COLD transcript: the host
        // renders the durable log without attaching the child Agent, so
        // `commands.list(agent)` has no agent to read. The catalog is still
        // knowable — remember the live answer, and fall back to the captain's
        // (the global layer is the same one a member would see) so the `/` menu
        // is never silently empty.
        const agent = liveMemberAgent(ctx, sessionId)
        const cached = memberCommandCatalog.get(sessionId)
        const catalog = agent !== undefined
          ? commands.list(agent)
          : cached ?? (() => {
            const captain = ctx.agents.get(located.team.captainSessionId as import('@deepseek-ai/dsh-session').SessionId)
            return captain === undefined ? undefined : commands.list(captain)
          })()
        if (catalog === undefined) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'member agent is not resident and the captain is offline' }))
          return
        }
        if (agent !== undefined) memberCommandCatalog.set(sessionId, catalog)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({
          live: agent !== undefined,
          commands: catalog.map((descriptor) => ({
            name: descriptor.name,
            ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
            ...(descriptor.input?.hint === undefined ? {} : { hint: descriptor.input.hint }),
            ...(descriptor.input?.attachments === undefined ? {} : { attachments: descriptor.input.attachments }),
          })),
        }))
      },
    }), 'agent-teams: member commands route')

    // Live state of one member, for that member's own composer (plan 10, task
    // 8). The member page cannot read team state, so this is how the model
    // label, the stop control and the queue badge learn what to render. It
    // reports the residency placeholder as absent: that item is the keep-alive,
    // not queued work.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-teams/member/state',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
          res.end()
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')?.trim() ?? ''
        if (sessionId === '') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'sessionId is required' }))
          return
        }
        const located = await findTeamByMemberSession(ctx, sessionId, resolved.stateDir)
        if (located === undefined) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'not a member session' }))
          return
        }
        const view = memberViewOf(located, liveMemberAgent(ctx, sessionId))
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, view }))
      },
    }), 'agent-teams: member state route')

    // Model switch for a resident member (plan 10, task 8). The host's
    // `session.selectModel` Remote refuses subagent-owned sessions, so this
    // applies the route to the live selection the member setup owns. A cold
    // member is refused instead of resumed: switching a model is not a reason
    // to spend a model turn.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-teams/member/model',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
          res.end()
          return
        }
        let payload: Record<string, unknown>
        try {
          payload = await readJsonRequest(req)
        } catch (error: unknown) {
          res.writeHead(error instanceof RequestBodyError ? error.status : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'invalid request body' }))
          return
        }
        const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'].trim() : ''
        const provider = typeof payload['provider'] === 'string' ? payload['provider'].trim() : ''
        const model = typeof payload['model'] === 'string' ? payload['model'].trim() : ''
        const reasoningEffort = typeof payload['reasoningEffort'] === 'string' ? payload['reasoningEffort'].trim() : ''
        if (sessionId === '' || provider === '' || model === '') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'sessionId, provider, and model are required' }))
          return
        }
        const located = await findTeamByMemberSession(ctx, sessionId, resolved.stateDir)
        if (located === undefined) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'not a member session' }))
          return
        }
        if (memberArchived(located)) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'this member is archived (halted team or removed member); it cannot take a new model' }))
          return
        }
        if (liveMemberAgent(ctx, sessionId) === undefined) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'member agent is not resident' }))
          return
        }
        const applied = applyMemberRoute(sessionId, {
          provider,
          model,
          ...(reasoningEffort === '' ? {} : { reasoningEffort }),
        })
        if (!applied) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'this member has no live model selection to switch' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, provider, model }))
      },
    }), 'agent-teams: member model route')

    // Stop the member's current turn (plan 10, task 8). Interrupting needs the
    // live captain: it is the member's direct parent, and the host's subagent
    // manager authorizes the interruption through it.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-teams/member/stop',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
          res.end()
          return
        }
        let payload: Record<string, unknown>
        try {
          payload = await readJsonRequest(req)
        } catch (error: unknown) {
          res.writeHead(error instanceof RequestBodyError ? error.status : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'invalid request body' }))
          return
        }
        const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'].trim() : ''
        if (sessionId === '') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'sessionId is required' }))
          return
        }
        const located = await findTeamByMemberSession(ctx, sessionId, resolved.stateDir)
        if (located === undefined) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'not a member session' }))
          return
        }
        const captain = ctx.agents.get(located.team.captainSessionId as import('@deepseek-ai/dsh-session').SessionId)
        if (captain === undefined) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'the captain session is not attached' }))
          return
        }
        interruptMember(ctx, captain, sessionId)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, accepted: true }))
      },
    }), 'agent-teams: member stop route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-agent-teams/plan',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
          res.end()
          return
        }
        let payload: Record<string, unknown>
        try {
          payload = await readJsonRequest(req)
        } catch (error: unknown) {
          res.writeHead(error instanceof RequestBodyError ? error.status : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'invalid request body' }))
          return
        }
        const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'].trim() : ''
        const teamId = typeof payload['teamId'] === 'string' ? payload['teamId'].trim() : ''
        const action = typeof payload['action'] === 'string' ? payload['action'] : ''
        if (sessionId === '' || teamId === '' || action === '') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'sessionId, teamId, and action are required' }))
          return
        }
        const captain = ctx.agents.get(sessionId as import('@deepseek-ai/dsh-session').SessionId)
        if (captain === undefined) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'captain session is not attached' }))
          return
        }
        const workspace = captain.session.header.cwd ?? process.cwd()
        const stateRoot = join(workspace, resolved.stateDir)
        const team = await findTeamByCaptain(stateRoot, captain.id, await leadIdentityOfAsync(ctx, captain.session))
        if (team === undefined || team.id !== teamId) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'team not found for this captain' }))
          return
        }
        try {
          if (action === 'approve') {
            const approved = await agentTeamsRuntime.approveStagedTeam(captain, teamId)
            // The browser receives the HTTP result, so the model needs its own
            // control message. steer wakes an idle captain or joins its next
            // step; the tool approve path already returns to the model itself.
            try {
              captain.steer(createUserMessage({
                content: [{ type: 'text', text: stagedPlanApprovedContext(team.name) }],
                source: agentTeamsSource({ kind: 'agent-teams' }, observedSessionFormatVersion(captain)),
              }))
            } catch (error) {
              // Approval is already committed. Do not report a failed approval
              // and invite a retry that could duplicate the user's action.
              ctx.logger.warn(`agent-teams: approval notification failed for ${teamId}: ${String(error)}`)
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, phase: 'running', ...approved }))
            return
          }
          if (action === 'continue') {
            const continued = await agentTeamsRuntime.continueStagedPlanning(captain, teamId)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, phase: 'staged', review: 'awaiting_feedback', ...continued }))
            return
          }
          if (action === 'discard') {
            const discarded = await agentTeamsRuntime.discardStagedTeam(captain, teamId)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, phase: 'archived', ...discarded }))
            return
          }
          const dependencies = Array.isArray(payload['dependencies'])
            ? payload['dependencies'].filter((item): item is string => typeof item === 'string')
            : []
          let mutation: StagedPlanMutation
          if (action === 'update_member') {
            if (typeof payload['memberName'] !== 'string'
              || typeof payload['provider'] !== 'string'
              || typeof payload['model'] !== 'string') throw new Error('memberName, provider, and model are required')
            mutation = {
              action,
              memberName: payload['memberName'],
              provider: payload['provider'],
              model: payload['model'],
              ...typeof payload['role'] === 'string' || payload['role'] === null ? { role: payload['role'] as string | null } : {},
              ...typeof payload['reasoningEffort'] === 'string' || payload['reasoningEffort'] === null
                ? { reasoningEffort: payload['reasoningEffort'] as string | null }
                : {},
              ...typeof payload['executionPrompt'] === 'string' || payload['executionPrompt'] === null
                ? { executionPrompt: payload['executionPrompt'] as string | null }
                : {},
              ...typeof payload['tool_policy'] === 'string' ? { toolPolicy: payload['tool_policy'] } : {},
              // Member context budget (browser plan editor): absent = keep the
              // current value, explicit null = clear back to the plugin default,
              // anything else must be a positive integer. An invalid value fails
              // the request instead of being silently dropped.
              ...contextMaxTokensFromPlanPayload(payload['context_max_tokens']),
            }
          } else if (action === 'update_task') {
            if (typeof payload['taskId'] !== 'string' || typeof payload['subject'] !== 'string') {
              throw new Error('taskId and subject are required')
            }
            mutation = {
              action,
              taskId: payload['taskId'],
              subject: payload['subject'],
              dependencies,
              ...typeof payload['description'] === 'string' || payload['description'] === null
                ? { description: payload['description'] as string | null }
                : {},
              ...typeof payload['assignee'] === 'string' || payload['assignee'] === null
                ? { assignee: payload['assignee'] as string | null }
                : {},
            }
          } else if (action === 'add_task') {
            if (typeof payload['subject'] !== 'string') throw new Error('subject is required')
            mutation = {
              action,
              subject: payload['subject'],
              dependencies,
              ...typeof payload['description'] === 'string' || payload['description'] === null
                ? { description: payload['description'] as string | null }
                : {},
              ...typeof payload['assignee'] === 'string' || payload['assignee'] === null
                ? { assignee: payload['assignee'] as string | null }
                : {},
            }
          } else if (action === 'remove_task') {
            if (typeof payload['taskId'] !== 'string') throw new Error('taskId is required')
            mutation = { action, taskId: payload['taskId'] }
          } else {
            throw new Error(`unknown plan action "${action}"`)
          }
          const updated = await agentTeamsRuntime.updateStagedPlan(captain, teamId, mutation)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, phase: updated.phase, members: updated.members.length, tasks: updated.tasks.length }))
        } catch (error: unknown) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'plan operation failed' }))
        }
      },
    }), 'agent-teams: plan route')

  // Whale mascot artwork: serve the packaged V2 role/action images to the
  // activity panel. An explicit allowlist guards the route (no path
  // traversal); the images ship with the bundle (files: assets/).
  const artDir = fileURLToPath(new URL('../assets/agent-teams/', import.meta.url))
  const ART_ALLOWLIST = new Set([
    'team-lead-v2.png',
    'member-researcher-v2.png', 'member-engineer-v2.png',
    'member-qa-v2.png', 'member-designer-v2.png',
    'member-security-v2.png', 'member-docs-v2.png',
    'member-data-v2.png', 'member-operator-v2.png',
    'action-working-v2.png', 'action-thinking-v2.png',
    'action-reporting-v2.png', 'action-celebrating-v2.png',
    'action-sleeping-v2.png', 'action-sending-v2.png',
  ])
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/plugins/dsh-agent-teams/assets',
    handler: async (req, res) => {
      let name: string
      try {
        name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '')
      } catch {
        // Malformed percent-encoding: treat as an unknown asset, not a 400.
        res.writeHead(404)
        res.end()
        return
      }
      if (!ART_ALLOWLIST.has(name)) {
        res.writeHead(404)
        res.end()
        return
      }
      try {
        const data = await readFile(join(artDir, name))
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=86400',
        })
        res.end(data)
      } catch (error: unknown) {
        ctx.logger.warn(`agent-teams: artwork read failed for ${name}: ${String(error)}`)
        res.writeHead(404)
        res.end()
      }
      },
    }), 'agent-teams: artwork route')
  }

  registerWebSurface()
  ctx.on('internal/service', (name) => {
    if (WEB_SERVER_KEYS.includes(name as (typeof WEB_SERVER_KEYS)[number])
      || WORKSPACE_KEYS.includes(name as (typeof WORKSPACE_KEYS)[number])) {
      registerWebSurface()
    }
  })
}
