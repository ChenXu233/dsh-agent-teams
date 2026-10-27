/**
 * Pure `/` menu helpers for the member composer (plan 10, §5.2).
 *
 * Kept outside React so prefix filtering, the row cap and keyboard wrap-around
 * are testable without a DOM.
 * @module dsh-agent-teams/client/member-menu
 */
/** One command row offered to the composer. */
export interface MenuCommand {
    readonly name: string;
    readonly description?: string;
    readonly hint?: string;
}
/** Most rows shown at once. */
export declare const MENU_LIMIT = 8;
/**
 * The command-name fragment being typed, or undefined when the draft is not a
 * bare `/name` fragment.
 * @param draft - current composer text.
 */
export declare function menuQuery(draft: string): string | undefined;
/**
 * Rows matching one fragment, in catalog order, capped at {@link MENU_LIMIT}.
 * @param commands - catalog for this member.
 * @param query - fragment from {@link menuQuery}.
 */
export declare function filterCommands(commands: readonly MenuCommand[], query: string | undefined): readonly MenuCommand[];
/**
 * Wrap one selection move across the visible rows.
 * @param index - current index, -1 when nothing is selected.
 * @param delta - +1 down, -1 up.
 * @param length - visible row count.
 */
export declare function moveSelection(index: number, delta: number, length: number): number;
