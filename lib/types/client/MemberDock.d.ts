import type { ModelDirectoryResolver } from '@deepseek-ai/dsh-client-ui-model-selection/client';
/** Structural view of the host's client command registry. */
export interface CommandUiHandle {
    register(definition: {
        readonly name: string;
        readonly label: () => string;
        readonly available: (session: {
            readonly sessionId: string;
        }) => boolean;
        readonly ui: {
            readonly kind: 'action';
            readonly run: (session: {
                readonly sessionId: string;
            }) => void;
        };
    }): () => void;
}
export interface MemberDockProps {
    readonly sessionId: string;
    readonly modelDirectories?: ModelDirectoryResolver;
    readonly commandUi?: {
        readonly current?: CommandUiHandle;
    };
    /**
     * The host's own model seat already renders for this session (plan 10, task
     * 9). The dock then keeps only what the host has no seat for: the member
     * queue badge and the stop control.
     */
    readonly modelSeatActive?: boolean;
}
/**
 * One compact control row for a member conversation, plus the member's command
 * catalog in the host's `/` menu. Renders nothing for a non-member session.
 */
export declare function MemberDock({ sessionId, modelDirectories, commandUi, modelSeatActive }: MemberDockProps): import("react").JSX.Element | null;
