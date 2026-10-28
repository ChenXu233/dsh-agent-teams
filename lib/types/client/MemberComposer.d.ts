import type { ModelDirectoryResolver } from '@deepseek-ai/dsh-client-ui-model-selection/client';
/** Props the conversation slot supplies to this seat. */
export interface MemberComposerProps {
    readonly sessionId: string;
    /** Seat reason from `select`: archived members get a read-only seat. */
    readonly reason?: string;
    /** Host model catalog, injected by the slot registration. */
    readonly modelDirectories?: ModelDirectoryResolver;
}
/** One line relayed to this member session. */
export declare function MemberComposer({ sessionId, reason, modelDirectories }: MemberComposerProps): import("react").JSX.Element;
