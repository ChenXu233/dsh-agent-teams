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
}
/**
 * One compact control row for a member conversation, plus the member's command
 * catalog in the host's `/` menu. Renders nothing for a non-member session.
 */
export declare function MemberDock({ sessionId, modelDirectories, commandUi }: MemberDockProps): import("react").JSX.Element | null;
