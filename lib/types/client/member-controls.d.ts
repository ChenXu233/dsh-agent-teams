/**
 * Control decisions for the member composer (plan 10, task 8).
 *
 * Every function here is pure so the behaviour can be pinned by tests without a
 * browser: the component only renders what these decide, and the transport is
 * the plugin's own `/member/*` routes.
 * @module dsh-agent-teams/client/member-controls
 */
/** The subset of the `/member/state` view the controls read. */
export interface MemberControlView {
    readonly live?: boolean;
    readonly running?: boolean;
    readonly archived?: boolean;
    readonly model?: {
        readonly provider: string;
        readonly model: string;
    } | null;
    /** Pinned reasoning effort of that route, when the member has one. */
    readonly reasoningEffort?: string;
    readonly queued?: number;
}
/** How one submitted line reaches a member. */
export type MemberDeliveryMode = 'queue' | 'steer';
/** Caption used when the member has no resolved model route. */
export declare const MODEL_PLACEHOLDER = "\u9ED8\u8BA4\u6A21\u578B";
/**
 * A running member can take the line inside its current step; an idle one gets
 * it as its next turn. An archived team takes neither, so it stays on the safe
 * value the transport defaults to.
 * @param view - live member state.
 */
export declare function deliveryMode(view: MemberControlView): MemberDeliveryMode;
/** Whether the stop control applies to the current state. */
export declare function stopEnabled(view: MemberControlView): boolean;
/**
 * Whether an attachment could be added. Archived members refuse input, and a
 * running member would receive the image in the middle of a step, so only a
 * live idle member accepts one.
 */
export declare function canAttach(view: MemberControlView): boolean;
/** Short model caption for the composer's selector trigger. */
export declare function modelLabel(view: MemberControlView): string;
/** Queue badge text, or undefined when nothing is waiting. */
export declare function queuedLabel(queued: number | undefined): string | undefined;
/** Delivery hint shown under the input. */
export declare function deliveryHint(view: MemberControlView): string;
/** One provider group as the host catalog reports it. */
export interface MemberModelGroup {
    readonly id: string;
    readonly name: string;
    readonly models: readonly {
        readonly id: string;
        readonly name: string;
    }[];
}
/** One selectable model route. */
export interface MemberModelOption {
    /** Stable select value; provider and model may both contain `/`. */
    readonly key: string;
    readonly provider: string;
    readonly model: string;
    /** Provider-qualified caption for the menu row. */
    readonly label: string;
    /** Model name alone, for the composer pill (the host shows the name there). */
    readonly short: string;
}
/** Build the select value of one route. */
export declare function modelOptionKey(provider: string, model: string): string;
/**
 * Flatten the host catalog into select options, dropping duplicate routes.
 * @param groups - provider groups from the model directory.
 */
export declare function modelOptions(groups: readonly MemberModelGroup[] | undefined): MemberModelOption[];
/**
 * Keep the member's current route selectable even when the catalog no longer
 * lists it, so the selector never silently shows a different model.
 * @param options - catalog options.
 * @param view - live member state.
 */
export declare function withCurrentOption(options: readonly MemberModelOption[], view: MemberControlView): MemberModelOption[];
