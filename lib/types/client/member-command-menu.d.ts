/** Props injected by the slot registration. */
export interface MemberCommandMenuProps {
    readonly sessionId: string;
}
/**
 * One compact slash-command launcher for a member conversation.
 *
 * Renders nothing for a session the membership probe has not proven to be a
 * member, so ordinary conversations never see it.
 */
export declare function MemberCommandMenu({ sessionId }: MemberCommandMenuProps): import("react").JSX.Element | null;
