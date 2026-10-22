/**
 * Browser-side command surface for one member session (plan 01a).
 *
 * The generated remote client (`@deepseek-ai/dsh-commands/remote`) answers
 * with an envelope: `{ ok: true, value }` or
 * `{ ok: false, error: { code, message } }`. `commands/list` returns the
 * descriptors registered for that member's own session, and
 * `commands/execute` returns `undefined` when no command claimed the line.
 *
 * Every mapping below is a pure function over that wire shape, so offline
 * tests drive it without React or a DOM. The panel never hard-codes a command
 * catalog: each member row lists its own session, and the compact shortcut
 * executes the ordinary `/compact` line through the same path.
 * @module dsh-agent-teams/client/command-client
 */
/** Host route that queues plain text into one member's inbox. */
export declare const MEMBER_PROMPT_URL = "/plugins/dsh-agent-teams/member/prompt";
/** One command descriptor as `commands/list` reports it. */
export interface MemberCommand {
    /** Lowercase command name without the leading slash. */
    readonly name: string;
    /** Human-readable summary shown next to the name. */
    readonly description: string;
    /** Optional free-form input hint advertised by the command. */
    readonly hint?: string;
}
/** Normalized outcome of one executed command line. */
export type MemberCommandResult = {
    readonly kind: 'success';
    readonly text?: string;
} | {
    readonly kind: 'error';
    readonly text: string;
};
/**
 * Why a dispatch produced no settled command result. The text is never a
 * hard-coded English sentence: the panel renders these through locale
 * templates.
 */
export type MemberCommandFailure = {
    readonly kind: 'empty';
} | {
    readonly kind: 'unclaimed';
    readonly line: string;
} | {
    readonly kind: 'remote';
    readonly code: string;
    readonly message: string;
} | {
    readonly kind: 'transport';
    readonly detail: string;
};
/** One dispatch attempt: a settled result or a failure to report. */
export type MemberCommandDispatch = {
    readonly kind: 'result';
    readonly result: MemberCommandResult;
} | {
    readonly kind: 'failure';
    readonly failure: MemberCommandFailure;
};
/** Outcome of reading the member's own command catalog. */
export type MemberCommandListOutcome = {
    readonly kind: 'commands';
    readonly commands: readonly MemberCommand[];
} | {
    readonly kind: 'failure';
    readonly failure: MemberCommandFailure;
};
/** Outcome of queueing plain text through the member prompt route. */
export type MemberPromptOutcome = {
    readonly kind: 'delivered';
} | {
    readonly kind: 'failure';
    readonly failure: MemberCommandFailure;
};
/**
 * The member session's own remote command face. Declared structurally so this
 * module stays independent of the host bundle: the plugin hands in whatever
 * `ctx.get('remote.commands')` resolved to and the shape is verified here.
 */
export interface MemberCommandsPort {
    list(sessionId: string): Promise<unknown>;
    execute(sessionId: string, line: string, attachments: readonly unknown[]): Promise<unknown>;
}
/** Everything the command bar needs to address exactly one member session. */
export interface MemberCommandTarget {
    /** Captain session id: the /state and /member/prompt routes resolve by it. */
    readonly sessionId: string;
    readonly teamId: string;
    /** Roster member name/key accepted by the prompt route. */
    readonly member: string;
    /** Member (child) session id the command face is addressed by. */
    readonly memberSessionId: string;
}
/** Minimal response shape the prompt route must satisfy (injectable for tests). */
export interface MemberPromptResponse {
    readonly ok: boolean;
    readonly status: number;
    json?(): Promise<unknown>;
}
/** Injectable fetch used by the prompt path; defaults to the global fetch. */
export type MemberCommandFetch = (url: string, init: {
    readonly method: 'POST';
    readonly cache: 'no-store';
    readonly headers: Record<string, string>;
    readonly body: string;
}) => Promise<MemberPromptResponse>;
/** Per-member command facade consumed by the panel. */
export interface MemberCommandClient {
    /** Read this member session's own catalog. */
    list(): Promise<MemberCommandListOutcome>;
    /** Execute one command line on this member session. */
    run(line: string): Promise<MemberCommandDispatch>;
    /** Queue plain text for this member through the host route. */
    send(text: string): Promise<MemberPromptOutcome>;
}
/**
 * Structural check for the generated remote face. The value crosses an
 * untyped service boundary, so a host without `remote.commands` must be
 * rejected here instead of failing at the first click.
 */
export declare function isMemberCommandsPort(value: unknown): value is MemberCommandsPort;
/** Publish the plugin's remote command face (called once from the client plugin). */
export declare function provideMemberCommands(value: unknown): void;
/** The currently published remote command face, or undefined when unavailable. */
export declare function activeMemberCommands(): MemberCommandsPort | undefined;
/** `code`/`message` of a refused envelope, with stable fallbacks. */
export declare function envelopeFailure(envelope: unknown, fallbackCode?: string): {
    code: string;
    message: string;
};
/** Read `value` from a successful envelope; anything else is a failure. */
export declare function envelopeValue(envelope: unknown): {
    ok: true;
    value: unknown;
} | {
    ok: false;
    failure: MemberCommandFailure;
};
/** Parse the `commands/list` payload into panel rows; malformed entries drop. */
export declare function parseCommandList(value: unknown): readonly MemberCommand[];
/**
 * Map one `commands/execute` payload. `value === undefined` is the host's
 * "no command claimed this line" answer, kept distinct from a settled error so
 * the panel can say exactly that.
 */
export declare function parseCommandExecution(line: string, value: unknown): MemberCommandDispatch;
/**
 * Normalize a typed line for the command face. A bare word matching one of the
 * member's own command names gains its leading slash; anything else is passed
 * through verbatim so the host decides admission.
 */
export declare function commandLineFor(input: string, commands: readonly MemberCommand[]): string;
/** Draft text after picking a command from the member's own catalog. */
export declare function commandDraftFor(name: string): string;
/** Trimmed plain text for the prompt route, or undefined when empty. */
export declare function promptTextFor(input: string): string | undefined;
/** Stable, locale-neutral token describing a thrown transport error. */
export declare function transportDetail(error: unknown): string;
/**
 * Build the per-member command facade. All three calls address only
 * `target.memberSessionId`/`target.member`; there is no shared cache, so two
 * members can never see each other's catalog.
 */
export declare function createMemberCommandClient(port: MemberCommandsPort, target: MemberCommandTarget, fetchImpl?: MemberCommandFetch): MemberCommandClient;
/** Route the panel bar and the member composer execute through. */
export declare const MEMBER_COMMAND_URL = "/plugins/dsh-agent-teams/member/command";
/**
 * A command face backed by this plugin's own route.
 *
 * The host's client-facing command API refuses every subagent-owned session
 * (`session/agent-busy: owned by subagent routing`), so a member session can
 * never be driven through `remote.commands`. Our route resolves the same Agent
 * in-process and calls `ctx.commands.execute`, which is the bus the member
 * itself uses. Results are re-wrapped into the envelope this module already
 * parses, so the panel component stays unchanged.
 */
export declare function createRouteCommandPort(target: MemberCommandTarget, fetchImpl?: MemberCommandFetch): MemberCommandsPort;
