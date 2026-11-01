/** Structural view of one member, as `/member/state` reports it. */
export interface MemberDockProps {
    readonly sessionId: string;
}
/**
 * Queue badge and stop control for one member conversation.
 *
 * Renders nothing until `/member/state` proves this session is a member, so an
 * ordinary conversation never sees it.
 */
export declare function MemberDock({ sessionId }: MemberDockProps): import("react").JSX.Element | null;
