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
export const MEMBER_PROMPT_URL = '/plugins/dsh-agent-teams/member/prompt';
let providedPort;
/**
 * Structural check for the generated remote face. The value crosses an
 * untyped service boundary, so a host without `remote.commands` must be
 * rejected here instead of failing at the first click.
 */
export function isMemberCommandsPort(value) {
    const candidate = value;
    return typeof candidate?.list === 'function' && typeof candidate?.execute === 'function';
}
/** Publish the plugin's remote command face (called once from the client plugin). */
export function provideMemberCommands(value) {
    providedPort = isMemberCommandsPort(value) ? value : undefined;
}
/** The currently published remote command face, or undefined when unavailable. */
export function activeMemberCommands() {
    return providedPort;
}
/** `code`/`message` of a refused envelope, with stable fallbacks. */
export function envelopeFailure(envelope, fallbackCode = 'remote-error') {
    const error = envelope?.error;
    const record = typeof error === 'object' && error !== null ? error : undefined;
    const code = typeof record?.code === 'string' && record.code.trim() !== '' ? record.code : fallbackCode;
    const message = typeof record?.message === 'string' && record.message.trim() !== '' ? record.message : code;
    return { code, message };
}
/** Read `value` from a successful envelope; anything else is a failure. */
export function envelopeValue(envelope) {
    if (typeof envelope !== 'object' || envelope === null) {
        return { ok: false, failure: { kind: 'transport', detail: 'malformed-envelope' } };
    }
    if (envelope.ok !== true) {
        const { code, message } = envelopeFailure(envelope);
        return { ok: false, failure: { kind: 'remote', code, message } };
    }
    return { ok: true, value: envelope.value };
}
/** Parse the `commands/list` payload into panel rows; malformed entries drop. */
export function parseCommandList(value) {
    if (!Array.isArray(value))
        return [];
    const commands = [];
    for (const entry of value) {
        if (typeof entry !== 'object' || entry === null)
            continue;
        const record = entry;
        if (typeof record.name !== 'string' || record.name.trim() === '')
            continue;
        const input = typeof record.input === 'object' && record.input !== null
            ? record.input
            : undefined;
        commands.push({
            name: record.name.trim(),
            description: typeof record.description === 'string' ? record.description : '',
            hint: typeof input?.hint === 'string' && input.hint !== '' ? input.hint : undefined,
        });
    }
    return commands;
}
/**
 * Map one `commands/execute` payload. `value === undefined` is the host's
 * "no command claimed this line" answer, kept distinct from a settled error so
 * the panel can say exactly that.
 */
export function parseCommandExecution(line, value) {
    if (value === undefined)
        return { kind: 'failure', failure: { kind: 'unclaimed', line } };
    if (typeof value !== 'object' || value === null) {
        return { kind: 'failure', failure: { kind: 'transport', detail: 'malformed-result' } };
    }
    const result = value.result;
    if (typeof result !== 'object' || result === null) {
        return { kind: 'failure', failure: { kind: 'transport', detail: 'malformed-result' } };
    }
    const record = result;
    const text = typeof record.text === 'string' ? record.text : '';
    if (record.kind === 'error')
        return { kind: 'result', result: { kind: 'error', text } };
    if (record.kind === 'success')
        return { kind: 'result', result: { kind: 'success', text } };
    return { kind: 'failure', failure: { kind: 'transport', detail: 'malformed-result' } };
}
/**
 * Normalize a typed line for the command face. A bare word matching one of the
 * member's own command names gains its leading slash; anything else is passed
 * through verbatim so the host decides admission.
 */
export function commandLineFor(input, commands) {
    const trimmed = input.trim();
    if (trimmed === '' || trimmed.startsWith('/'))
        return trimmed;
    const head = trimmed.split(/\s/u)[0] ?? '';
    return commands.some((command) => command.name === head) ? `/${trimmed}` : trimmed;
}
/** Draft text after picking a command from the member's own catalog. */
export function commandDraftFor(name) {
    return `/${name} `;
}
/** Trimmed plain text for the prompt route, or undefined when empty. */
export function promptTextFor(input) {
    const text = input.trim();
    return text === '' ? undefined : text;
}
/** Stable, locale-neutral token describing a thrown transport error. */
export function transportDetail(error) {
    if (error instanceof Error && error.name === 'AbortError')
        return 'aborted';
    return 'network-error';
}
/** Host error text from a non-ok prompt response, when the body carries one. */
async function responseErrorText(response) {
    if (typeof response.json !== 'function')
        return '';
    try {
        const body = await response.json();
        const error = body?.error;
        return typeof error === 'string' ? error : '';
    }
    catch {
        return '';
    }
}
/**
 * Build the per-member command facade. All three calls address only
 * `target.memberSessionId`/`target.member`; there is no shared cache, so two
 * members can never see each other's catalog.
 */
export function createMemberCommandClient(port, target, fetchImpl = (url, init) => fetch(url, init)) {
    return {
        async list() {
            try {
                const envelope = await port.list(target.memberSessionId);
                const read = envelopeValue(envelope);
                if (!read.ok)
                    return { kind: 'failure', failure: read.failure };
                return { kind: 'commands', commands: parseCommandList(read.value) };
            }
            catch (error) {
                return { kind: 'failure', failure: { kind: 'transport', detail: transportDetail(error) } };
            }
        },
        async run(line) {
            const normalized = line.trim();
            if (normalized === '')
                return { kind: 'failure', failure: { kind: 'empty' } };
            try {
                const envelope = await port.execute(target.memberSessionId, normalized, []);
                const read = envelopeValue(envelope);
                if (!read.ok)
                    return { kind: 'failure', failure: read.failure };
                return parseCommandExecution(normalized, read.value);
            }
            catch (error) {
                return { kind: 'failure', failure: { kind: 'transport', detail: transportDetail(error) } };
            }
        },
        async send(text) {
            const trimmed = promptTextFor(text);
            if (trimmed === undefined)
                return { kind: 'failure', failure: { kind: 'empty' } };
            try {
                const response = await fetchImpl(MEMBER_PROMPT_URL, {
                    method: 'POST',
                    cache: 'no-store',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: target.sessionId,
                        teamId: target.teamId,
                        member: target.member,
                        text: trimmed,
                    }),
                });
                if (response.ok)
                    return { kind: 'delivered' };
                const message = await responseErrorText(response);
                return { kind: 'failure', failure: { kind: 'remote', code: `http-${response.status}`, message } };
            }
            catch (error) {
                return { kind: 'failure', failure: { kind: 'transport', detail: transportDetail(error) } };
            }
        },
    };
}
