import { create } from 'zustand';
import type { StagedProposal } from '../llm/types';

export type ChatContext =
    | { kind: 'persona' }
    // At least one of articleId / suggestionId must be set; the agent resolves
    // the other (and the suggestion row) from whichever id is provided.
    | { kind: 'article-suggestion'; articleId?: string; suggestionId?: string; articleTitle?: string }
    | { kind: 'generic'; route: string };

interface FloatingChatState {
    // State
    isExpanded: boolean;
    context: ChatContext;
    bubbleSnapSide: 'left' | 'right';
    bubbleY: number; // top-referenced px
    bubbleCenter: { x: number; y: number };
    isGenerating: boolean;
    suppressed: boolean;
    factMutationVersion: number;
    // Article-feedback flow. `pendingInitialMessage` is auto-sent once by
    // ChatSessionView after the thread mounts; `proposal` is the single
    // in-flight staged proposal; `resolvedProposals` records the terminal
    // status of proposals by id so their cards render applied/cancelled.
    pendingInitialMessage: string | null;
    proposal: StagedProposal | null;
    resolvedProposals: Record<string, 'applied' | 'cancelled'>;
    // Conversation identity for the whole APP SESSION (not per popover open).
    // In-memory only (no persist middleware) so it naturally dies on app kill,
    // giving fresh-conversation-per-launch for free. Closing/reopening the
    // popover reuses this id, so messages resume.
    conversationId: string | null;
    // Bumped by the header "New chat" button; MeraChatSession watches it to spin
    // up a fresh conversation and remount the thread.
    newChatNonce: number;

    // Actions
    expand: (context?: ChatContext) => void;
    openArticleFeedback: (context: ChatContext, initialMessage: string) => void;
    consumePendingInitialMessage: () => string | null;
    setProposal: (p: StagedProposal | null) => void;
    resolveProposal: (status: 'applied' | 'cancelled') => void;
    collapse: () => void;
    toggle: () => void;
    setBubblePosition: (side: 'left' | 'right', y: number) => void;
    setBubbleCenter: (c: { x: number; y: number }) => void;
    setGenerating: (v: boolean) => void;
    setSuppressed: (v: boolean) => void;
    notifyFactMutation: () => void;
    setConversationId: (id: string | null) => void;
    requestNewChat: () => void;
    reset: () => void;
}

const DEFAULT_CONTEXT: ChatContext = { kind: 'persona' };
// Sane bottom-ish default (top-referenced px); refined at runtime once the
// bubble measures the actual screen height via setBubblePosition.
const DEFAULT_BUBBLE_Y = 560;

const initialState = {
    isExpanded: false,
    context: DEFAULT_CONTEXT,
    bubbleSnapSide: 'right' as const,
    bubbleY: DEFAULT_BUBBLE_Y,
    bubbleCenter: { x: 0, y: 0 },
    isGenerating: false,
    suppressed: false,
    factMutationVersion: 0,
    pendingInitialMessage: null as string | null,
    proposal: null as StagedProposal | null,
    resolvedProposals: {} as Record<string, 'applied' | 'cancelled'>,
    conversationId: null as string | null,
    newChatNonce: 0,
};

/** True if two article-suggestion/persona contexts differ in kind or target id. */
function contextDiffers(a: ChatContext, b: ChatContext): boolean {
    if (a.kind !== b.kind) return true;
    if (a.kind === 'article-suggestion' && b.kind === 'article-suggestion') {
        return a.articleId !== b.articleId || a.suggestionId !== b.suggestionId;
    }
    return false;
}

export const useFloatingChatStore = create<FloatingChatState>((set, get) => ({
    ...initialState,

    expand: (context) =>
        set((state) => {
            // Switching to a different context while a conversation already
            // exists must start a fresh thread so a stale persona chat never
            // bleeds into an article-feedback session (children remount via
            // key={conversationId} on the nonce bump).
            const shouldBump =
                context !== undefined &&
                state.conversationId !== null &&
                contextDiffers(context, state.context);
            return {
                isExpanded: true,
                context: context ?? state.context,
                newChatNonce: shouldBump ? state.newChatNonce + 1 : state.newChatNonce,
            };
        }),

    openArticleFeedback: (context, initialMessage) =>
        set((state) => ({
            context,
            pendingInitialMessage: initialMessage,
            isExpanded: true,
            proposal: null,
            // Bump the nonce ONLY when a conversation already exists: pre-mount
            // bumps are swallowed by MeraChatSession.tsx:158's prevNonceRef init,
            // and when conversationId is null the init path creates the first
            // conversation anyway (fresh thread per thumbs tap either way).
            newChatNonce:
                state.conversationId !== null ? state.newChatNonce + 1 : state.newChatNonce,
        })),

    consumePendingInitialMessage: () => {
        const msg = get().pendingInitialMessage;
        if (msg !== null) set({ pendingInitialMessage: null });
        return msg;
    },

    setProposal: (p) => set({ proposal: p }),

    resolveProposal: (status) =>
        set((state) => {
            if (!state.proposal) return {};
            return {
                proposal: null,
                resolvedProposals: {
                    ...state.resolvedProposals,
                    [state.proposal.id]: status,
                },
            };
        }),

    collapse: () => set({ isExpanded: false }),

    toggle: () => set((state) => ({ isExpanded: !state.isExpanded })),

    setBubblePosition: (side, y) => set({ bubbleSnapSide: side, bubbleY: y }),

    setBubbleCenter: (c) => set({ bubbleCenter: c }),

    setGenerating: (v) => set({ isGenerating: v }),

    setSuppressed: (v) => set({ suppressed: v }),

    notifyFactMutation: () => set((state) => ({ factMutationVersion: state.factMutationVersion + 1 })),

    setConversationId: (id) => set({ conversationId: id }),

    requestNewChat: () => set((state) => ({ newChatNonce: state.newChatNonce + 1 })),

    reset: () => set({ ...initialState }),
}));

// Selector hooks for optimized subscriptions
export const useFloatingChatIsExpanded = () => useFloatingChatStore((state) => state.isExpanded);
export const useFloatingChatFactMutationVersion = () =>
    useFloatingChatStore((state) => state.factMutationVersion);
export const useFloatingChatIsGenerating = () => useFloatingChatStore((state) => state.isGenerating);
export const useFloatingChatSuppressed = () => useFloatingChatStore((state) => state.suppressed);
export const useFloatingChatConversationId = () => useFloatingChatStore((state) => state.conversationId);
export const useFloatingChatNewChatNonce = () => useFloatingChatStore((state) => state.newChatNonce);
export const useFloatingChatProposal = () => useFloatingChatStore((state) => state.proposal);
export const useFloatingChatResolvedProposals = () =>
    useFloatingChatStore((state) => state.resolvedProposals);
