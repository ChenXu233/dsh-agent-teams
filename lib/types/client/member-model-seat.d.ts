/** Props injected by the slot registration. */
export interface MemberModelSeatProps {
    readonly sessionId: string;
}
/**
 * The composer's model seat for one member conversation.
 *
 * Renders nothing until the membership probe proves this session is a member,
 * and nothing forever for a normal conversation.
 */
export declare function MemberModelSeat({ sessionId }: MemberModelSeatProps): import("react").JSX.Element | null;
