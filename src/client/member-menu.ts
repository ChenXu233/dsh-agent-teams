/**
 * Pure `/` menu helpers for the member composer (plan 10, §5.2).
 *
 * Kept outside React so prefix filtering, the row cap and keyboard wrap-around
 * are testable without a DOM.
 * @module dsh-agent-teams/client/member-menu
 */

/** One command row offered to the composer. */
export interface MenuCommand {
  readonly name: string
  readonly description?: string
  readonly hint?: string
}

/** Most rows shown at once. */
export const MENU_LIMIT = 8

/**
 * The command-name fragment being typed, or undefined when the draft is not a
 * bare `/name` fragment.
 * @param draft - current composer text.
 */
export function menuQuery(draft: string): string | undefined {
  const match = /^\/([a-z0-9_-]*)$/iu.exec(draft)
  return match?.[1]?.toLowerCase()
}

/**
 * Rows matching one fragment, in catalog order, capped at {@link MENU_LIMIT}.
 * @param commands - catalog for this member.
 * @param query - fragment from {@link menuQuery}.
 */
export function filterCommands(commands: readonly MenuCommand[], query: string | undefined): readonly MenuCommand[] {
  if (query === undefined) return []
  return commands.filter((command) => command.name.toLowerCase().startsWith(query)).slice(0, MENU_LIMIT)
}

/**
 * Wrap one selection move across the visible rows.
 * @param index - current index, -1 when nothing is selected.
 * @param delta - +1 down, -1 up.
 * @param length - visible row count.
 */
export function moveSelection(index: number, delta: number, length: number): number {
  if (length === 0) return -1
  if (index < 0) return delta > 0 ? 0 : length - 1
  return (index + delta + length) % length
}
