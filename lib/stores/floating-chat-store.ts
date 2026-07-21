import { create } from 'zustand';
import type { StagedProposal } from '../llm/types';
import type { TrackFeedbackSubject } from '../news-harness/core/types';

/** Terminal resolution of a save-time fact conflict (U-B1). */
export type ConflictResolution = 'kept-both' | 'replaced' | 'merged' | 'dismissed';

export type ChatContext =
    | { kind: 'persona' }
    // At least one of articleId / suggestionId must be set; the agent resolves
    // the other (and the suggestion row) from whichever id is provided.
    | {
          kind: 'article-suggestion';
          articleId?: string;
          suggestionId?: string;
          articleTitle?: string;
          // Present when the chat was opened from a "Track" tap — the origin
          // snapshot the agent's proposeTrack tool follows against.
          trackSubject?: TrackFeedbackSubject;
          // Feed-verdict handoff (Round-4 P4): the like/dislike the user gave on
          // the Feed tab, and the human-readable breadcrumb LABELS of the inline
          // feedback-tree options they tapped. Both feed the agent's <context>
          // ("USER VERDICT" / "TAPPED OPTIONS") so its proposals are grounded,
          // and gate `markFeedbackProcessedFor` when a proposal applies. The
          // store stays dumb — the caller (swipe-feedback.ts) resolves ids→labels
          // and prebuilds the auto-sent message.
          verdict?: 'like' | 'dislike';
          treePath?: string[];
      }
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
    // Wave 11 in-chat card settlement (mirrors resolvedProposals — in-memory
    // only, so a settled card re-opens "fresh" on app restart, which is
    // harmless: topic rows are already active and conflicts re-derive from the
    // persisted tool result). `settledTopicPlans` is keyed by factId (the
    // TopicPlanCard's Accept-all); `resolvedConflicts` by `${newFactId}:${existingFactId}`.
    settledTopicPlans: Record<string, boolean>;
    resolvedConflicts: Record<string, ConflictResolution>;
    // Conversation identity for the whole APP SESSION (not per popover open).
    // In-memory only (no persist middleware) so it naturally dies on app kill,
    // giving fresh-conversation-per-launch for free. Closing/reopening the
    // popover reuses this id, so messages resume. `null` is the single
    // level-triggered "a fresh conversation is needed" signal MeraChatSession
    // watches — unlike an edge-triggered nonce it can't be swallowed by mount
    // order (the session unmounts while the popover is closed).
    conversationId: string | null;

    // Actions
    expand: (context?: ChatContext) => void;
    openArticleFeedback: (context: ChatContext, initialMessage: string) => void;
    consumePendingInitialMessage: () => string | null;
    setProposal: (p: StagedProposal | null) => void;
    resolveProposal: (status: 'applied' | 'cancelled') => void;
    setTopicPlanSettled: (factId: string) => void;
    resolveConflict: (conflictKey: string, resolution: ConflictResolution) => void;
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
    settledTopicPlans: {} as Record<string, boolean>,
    resolvedConflicts: {} as Record<string, ConflictResolution>,
    conversationId: null as string | null,
};

/** True if two article-suggestion/persona contexts differ in kind or target id. */
function contextDiffers(a: ChatContext, b: ChatContext): boolean {
    if (a.kind !== b.kind) return true;
    if (a.kind === 'article-suggestion' && b.kind === 'article-suggestion') {
        return (
            a.articleId !== b.articleId ||
            a.suggestionId !== b.suggestionId ||
            a.verdict !== b.verdict ||
            (a.treePath ?? []).join('') !== (b.treePath ?? []).join('')
        );
    }
    return false;
}

export const useFloatingChatStore = create<FloatingChatState>((set, get) => ({
    ...initialState,

    expand: (context) =>
        set((state) => {
            // Switching to a different context must start a fresh thread so a
            // stale persona chat never bleeds into an article-feedback session.
            // Nulling conversationId is the level-triggered "create a
            // conversation" signal MeraChatSession watches; unlike a nonce it
            // can't be swallowed by mount order. Also drop any pending auto-send
            // (a prior thumbs-down message must not leak into the new thread)
            // and any staged proposal (must not leak across articles).
            const switching =
                context !== undefined && contextDiffers(context, state.context);
            return {
                isExpanded: true,
                context: context ?? state.context,
                ...(switching
                    ? { conversationId: null, pendingInitialMessage: null, proposal: null }
                    : {}),
            };
        }),

    openArticleFeedback: (context, initialMessage) =>
        set(() => ({
            context,
            pendingInitialMessage: initialMessage,
            isExpanded: true,
            proposal: null,
            // Null id = "create a fresh conversation" (fresh thread per thumbs
            // tap). The zustand set is atomic, so the null id and the pending
            // message land in one commit — the old thread unmounts before its
            // auto-send effect could consume the message into the OLD
            // conversation.
            conversationId: null,
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

    setTopicPlanSettled: (factId) =>
        set((state) => ({
            settledTopicPlans: { ...state.settledTopicPlans, [factId]: true },
        })),

    resolveConflict: (conflictKey, resolution) =>
        set((state) => ({
            resolvedConflicts: { ...state.resolvedConflicts, [conflictKey]: resolution },
        })),

    collapse: () => set({ isExpanded: false }),

    toggle: () => set((state) => ({ isExpanded: !state.isExpanded })),

    setBubblePosition: (side, y) => set({ bubbleSnapSide: side, bubbleY: y }),

    setBubbleCenter: (c) => set({ bubbleCenter: c }),

    setGenerating: (v) => set({ isGenerating: v }),

    setSuppressed: (v) => set({ suppressed: v }),

    notifyFactMutation: () => set((state) => ({ factMutationVersion: state.factMutationVersion + 1 })),

    setConversationId: (id) => set({ conversationId: id }),

    requestNewChat: () => set({ conversationId: null }),

    reset: () => set({ ...initialState }),
}));

// Selector hooks for optimized subscriptions
export const useFloatingChatIsExpanded = () => useFloatingChatStore((state) => state.isExpanded);
export const useFloatingChatFactMutationVersion = () =>
    useFloatingChatStore((state) => state.factMutationVersion);
export const useFloatingChatIsGenerating = () => useFloatingChatStore((state) => state.isGenerating);
export const useFloatingChatSuppressed = () => useFloatingChatStore((state) => state.suppressed);
export const useFloatingChatConversationId = () => useFloatingChatStore((state) => state.conversationId);
export const useFloatingChatProposal = () => useFloatingChatStore((state) => state.proposal);
export const useFloatingChatResolvedProposals = () =>
    useFloatingChatStore((state) => state.resolvedProposals);
export const useFloatingChatSettledTopicPlans = () =>
    useFloatingChatStore((state) => state.settledTopicPlans);
export const useFloatingChatResolvedConflicts = () =>
    useFloatingChatStore((state) => state.resolvedConflicts);
