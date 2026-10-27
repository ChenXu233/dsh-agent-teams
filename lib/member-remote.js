/**
 * Plugin-owned Remote namespace for member sessions (plan 10).
 *
 * The host's Session Remote refuses every subagent-owned session, and its
 * subagent namespace exposes only `prompt` and `interruptByParent`. This service
 * is the missing surface: it addresses one member by captain + child session,
 * runs the member's own commands on the in-process bus, and never resumes a
 * cold member. The Typert Gateway discovers it through the `typertRemote`
 * binding at runtime (source mode), so no host codegen is involved.
 * @module dsh-agent-teams/member-remote
 */
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { MemberAddressError, resolveMemberAddress } from "./member-address.js";
import { MemberCommandError, executeMemberCommand, isDeniedMemberCommand } from "./member-command.js";
import { deliverToMember, interruptMember } from "./members.js";
import { applyMemberRoute } from "./member-route-registry.js";
/** Wire namespace of the member surface. */
export const MEMBER_REMOTE_NAMESPACE = 'agentTeams';
/** Bounded idempotency window for request ids. */
const REQUEST_WINDOW = 128;
/** Build the membership view from one resolved address and its live Agent. */
export function memberViewOf(resolved, agent) {
    const model = agent?.options.provider !== undefined && agent.options.model !== undefined
        ? { provider: agent.options.provider, model: agent.options.model }
        : null;
    return {
        member: resolved.member.name,
        teamId: resolved.team.id,
        live: agent !== undefined,
        running: agent?.status === 'running',
        archived: resolved.team.halted === true,
        model,
        queued: agent === undefined ? 0 : agent.inbox.nextTurn.length + agent.inbox.nextStep.length,
    };
}
/** Build the pending-input view from one live Agent. */
export function queueViewOf(agent) {
    if (agent === undefined)
        return { running: false, items: [] };
    const items = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].map((message) => ({
        id: message.id,
        preview: message.content
            .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
            .join(' ')
            .slice(0, 80),
    }));
    return { running: agent.status === 'running', items };
}
/** Translate one address failure into the wire failure the client expects. */
export function remoteAddressError(error, address) {
    if (error instanceof MemberAddressError) {
        if (error.code === 'captain/offline') {
            return new RemoteError('captain/offline', error.message, { captainSessionId: address.captainSessionId });
        }
        return new RemoteError('member/not-found', error.message, { memberSessionId: address.memberSessionId });
    }
    return error;
}
/**
 * Member command and control surface.
 *
 * Every method resolves the address first and then delegates; no method resumes
 * an Agent, and a command that needs a live idle member reports `member/cold`
 * instead of waking one.
 */
let MemberRemoteService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _resolveMember_decorators;
    let _listCommands_decorators;
    let _execute_decorators;
    let _prompt_decorators;
    let _selectModel_decorators;
    let _interrupt_decorators;
    let _queue_decorators;
    return class MemberRemoteService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _resolveMember_decorators = [Remote('resolveMember')];
            _listCommands_decorators = [Remote('listCommands')];
            _execute_decorators = [Remote('execute')];
            _prompt_decorators = [Remote('prompt')];
            _selectModel_decorators = [Remote('selectModel')];
            _interrupt_decorators = [Remote('interrupt')];
            _queue_decorators = [Remote('queue')];
            __esDecorate(this, null, _resolveMember_decorators, { kind: "method", name: "resolveMember", static: false, private: false, access: { has: obj => "resolveMember" in obj, get: obj => obj.resolveMember }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listCommands_decorators, { kind: "method", name: "listCommands", static: false, private: false, access: { has: obj => "listCommands" in obj, get: obj => obj.listCommands }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _execute_decorators, { kind: "method", name: "execute", static: false, private: false, access: { has: obj => "execute" in obj, get: obj => obj.execute }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _prompt_decorators, { kind: "method", name: "prompt", static: false, private: false, access: { has: obj => "prompt" in obj, get: obj => obj.prompt }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _selectModel_decorators, { kind: "method", name: "selectModel", static: false, private: false, access: { has: obj => "selectModel" in obj, get: obj => obj.selectModel }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _interrupt_decorators, { kind: "method", name: "interrupt", static: false, private: false, access: { has: obj => "interrupt" in obj, get: obj => obj.interrupt }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _queue_decorators, { kind: "method", name: "queue", static: false, private: false, access: { has: obj => "queue" in obj, get: obj => obj.queue }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        #options = __runInitializers(this, _instanceExtraInitializers);
        #requests = new Map();
        constructor(ctx, options) {
            super(ctx, 'memberRemote', { namespace: MEMBER_REMOTE_NAMESPACE });
            this.#options = options;
        }
        /** Resolve one address or translate the domain failure into a Remote failure. */
        async #resolve(captainSessionId, memberSessionId) {
            try {
                return await resolveMemberAddress(this.ctx, { captainSessionId, memberSessionId }, this.#options.stateDir);
            }
            catch (error) {
                throw remoteAddressError(error, { captainSessionId, memberSessionId });
            }
        }
        /** Live member Agent or a `member/cold` failure. */
        #live(memberSessionId) {
            const agent = this.ctx.agents.get(memberSessionId);
            if (agent === undefined) {
                throw new RemoteError('member/cold', `member agent "${memberSessionId}" is not resident`, { memberSessionId });
            }
            return agent;
        }
        /** The host command service, or an actionable failure. */
        #commands() {
            const commands = this.ctx.get?.('commands');
            if (commands === undefined)
                throw new RemoteError('gateway/internal', 'the host command service is not composed', {});
            return commands;
        }
        /** Remember one request outcome so a retried request id returns the same value. */
        #remember(requestId, value) {
            if (requestId === undefined)
                return value;
            this.#requests.set(requestId, value);
            while (this.#requests.size > REQUEST_WINDOW) {
                const oldest = this.#requests.keys().next().value;
                if (oldest === undefined)
                    break;
                this.#requests.delete(oldest);
            }
            return value;
        }
        /** Membership signal, live state and pending work of one member. */
        async resolveMember(captainSessionId, memberSessionId) {
            const resolved = await this.#resolve(captainSessionId, memberSessionId);
            return memberViewOf(resolved, this.ctx.agents.get(memberSessionId));
        }
        /** Commands this member's own session offers, minus the deny list. */
        async listCommands(captainSessionId, memberSessionId) {
            await this.#resolve(captainSessionId, memberSessionId);
            const agent = this.#live(memberSessionId);
            return this.#commands().list(agent)
                .filter((descriptor) => !isDeniedMemberCommand(descriptor.name, this.#options.deny))
                .map((descriptor) => ({
                name: descriptor.name,
                ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
                ...(descriptor.input?.hint === undefined ? {} : { hint: descriptor.input.hint }),
                ...(descriptor.input?.attachments === undefined ? {} : { attachments: descriptor.input.attachments }),
            }));
        }
        /** Run one command line inside the member's own session. */
        async execute(captainSessionId, memberSessionId, line, requestId) {
            const cached = requestId === undefined ? undefined : this.#requests.get(requestId);
            if (cached !== undefined)
                return cached;
            await this.#resolve(captainSessionId, memberSessionId);
            const agent = this.#live(memberSessionId);
            try {
                const outcome = await executeMemberCommand({
                    commands: this.#commands(),
                    agent,
                    line,
                    signal: new AbortController().signal,
                    deny: this.#options.deny,
                });
                return this.#remember(requestId, outcome);
            }
            catch (error) {
                if (error instanceof MemberCommandError) {
                    if (error.code === 'command/denied')
                        throw new RemoteError('command/denied', error.message, { command: error.commandName ?? '' });
                    throw new RemoteError('command/unknown', error.message, { line });
                }
                throw error;
            }
        }
        /** Deliver one plain-text prompt through the captain's channel. */
        async prompt(captainSessionId, memberSessionId, text, mode = 'queue', requestId) {
            const cached = requestId === undefined ? undefined : this.#requests.get(requestId);
            if (cached !== undefined)
                return cached;
            const resolved = await this.#resolve(captainSessionId, memberSessionId);
            if (resolved.team.halted === true) {
                throw new RemoteError('member/busy', `team "${resolved.team.name}" is halted`, { memberSessionId });
            }
            const delivered = await deliverToMember(this.ctx, resolved.captain, memberSessionId, text, new AbortController().signal, mode);
            return this.#remember(requestId, { delivered });
        }
        /** Install a new model selection on a resident member. */
        async selectModel(captainSessionId, memberSessionId, provider, model, reasoningEffort) {
            await this.#resolve(captainSessionId, memberSessionId);
            this.#live(memberSessionId);
            const applied = applyMemberRoute(memberSessionId, {
                provider,
                model,
                ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            });
            if (!applied) {
                throw new RemoteError('member/cold', `member "${memberSessionId}" has no live model selection`, { memberSessionId });
            }
            return { provider, model };
        }
        /** Interrupt the member's current turn. */
        async interrupt(captainSessionId, memberSessionId) {
            const resolved = await this.#resolve(captainSessionId, memberSessionId);
            interruptMember(this.ctx, resolved.captain, memberSessionId);
            return { accepted: true };
        }
        /** Pending input of one member. */
        async queue(captainSessionId, memberSessionId) {
            await this.#resolve(captainSessionId, memberSessionId);
            return queueViewOf(this.ctx.agents.get(memberSessionId));
        }
    };
})();
export { MemberRemoteService };
