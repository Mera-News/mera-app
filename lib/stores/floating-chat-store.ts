import { create } from 'zustand';
import { getAiAccess } from './subscription-store';
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
    // Round-4 C5: open the popover showing the pending daily optimisation plan.
    // No target ids — the OptimisationPlanCard loads the plan from the service.
    | { kind: 'optimisation-plan' }
    // "Follow a story" started from the Followed-stories screen's track FAB.
    // Deliberately id-less: there is no article here, only what the user types —
    // the FollowStoryAgent scopes the story from free text and stages the same
    // proposeTrack scope pills the article surface stages.
    | { kind: 'follow-story' }
    // "Fact-check this" started from an article's fact-check tick. Carries the
    // article snapshot the FactCheckAgent decomposes into checkable claims —
    // headline + summary ONLY, deliberately: reading the article body is out of
    // scope, and `url` travels for the eventual citation, never to be fetched.
    | {
          kind: 'fact-check';
          articleId: string;
          title: string;
          description?: string;
          url?: string;
          publicationName?: string;
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
    // TopicPlanCard's Save); `resolvedConflicts` by `${newFactId}:${existingFactId}`.
    //
    // r14: these two maps are the SESSION-LOCAL half of a topic plan's
    // resolution. They are deliberately NOT the gate's source of truth — the
    // chat input and the onboarding Next button are blocked while a plan is
    // unresolved, and gating on an in-memory map would re-block the user after
    // every relaunch against cards whose topics are already saved. The DURABLE
    // marker is `metadata.topicsReviewedAt` on the fact (Save) and the absence
    // of the fact row entirely (Discard deletes it). See
    // components/custom/floating-chat/topic-plan-resolution.ts, which combines
    // both halves; these maps only make the card react instantly.
    settledTopicPlans: Record<string, boolean>;
    discardedTopicPlans: Record<string, boolean>;
    resolvedConflicts: Record<string, ConflictResolution>;
    // How many topic-plan cards in the CURRENTLY MOUNTED thread are unresolved.
    // Published by ChatSessionView (the one component that sees both the thread
    // items and the durable markers) so surfaces OUTSIDE the chat — namely the
    // onboarding wizard's Next button — can gate on the same signal without
    // re-deriving it. Reset to 0 when the session unmounts: a block that
    // outlived its cards would be unclearable.
    unresolvedTopicPlanCount: number;
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
    openOptimisationPlan: () => void;
    consumePendingInitialMessage: () => string | null;
    setProposal: (p: StagedProposal | null) => void;
    resolveProposal: (status: 'applied' | 'cancelled') => void;
    setTopicPlanSettled: (factId: string) => void;
    setTopicPlanDiscarded: (factId: string) => void;
    setUnresolvedTopicPlanCount: (count: number) => void;
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
    discardedTopicPlans: {} as Record<string, boolean>,
    resolvedConflicts: {} as Record<string, ConflictResolution>,
    unresolvedTopicPlanCount: 0,
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
    // Two fact-check chats on DIFFERENT articles are same-kind, so without this
    // `expand()` would keep the previous article's thread and its staged claim
    // card — exactly the leak the comment in `expand` exists to prevent. The
    // tick's own entry point (openArticleFeedback) resets unconditionally, so
    // this covers the `expand(context)` path only; it is cheap and it removes
    // the trap rather than relying on one caller being the only caller.
    if (a.kind === 'fact-check' && b.kind === 'fact-check') {
        return a.articleId !== b.articleId;
    }
    return false;
}

export const useFloatingChatStore = create<FloatingChatState>((set, get) => ({
    ...initialState,

    expand: (context) => {
        // Mera News Free: chat must not open anywhere in the app. This is the
        // single chokepoint every call site (article actions, track button,
        // notifications, ...) funnels through, so gating here covers all of
        // them without touching each call site. A silent no-op is correct —
        // callers are fire-and-forget and never await/branch on this call.
        if (getAiAccess() === 'locked') return;
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
        });
    },

    openArticleFeedback: (context, initialMessage) => {
        // Same free-tier chokepoint as `expand` above.
        if (getAiAccess() === 'locked') return;
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
        }));
    },

    openOptimisationPlan: () => {
        // Same chokepoint: this opens the same chat popover as expand/
        // openArticleFeedback (just pre-staged on the plan-card context), so a
        // free-tier user must not be able to reach it either.
        if (getAiAccess() === 'locked') return;
        set(() => ({
            // Fresh thread showing only the plan card (no auto-send). Null id is
            // the "create a fresh conversation" signal MeraChatSession watches.
            context: { kind: 'optimisation-plan' } as ChatContext,
            isExpanded: true,
            pendingInitialMessage: null,
            proposal: null,
            conversationId: null,
        }));
    },

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

    setTopicPlanDiscarded: (factId) =>
        set((state) => ({
            discardedTopicPlans: { ...state.discardedTopicPlans, [factId]: true },
        })),

    setUnresolvedTopicPlanCount: (count) =>
        set((state) =>
            // Guarded so the publishing effect can run on every render without
            // notifying subscribers (and re-rendering the onboarding wizard)
            // when nothing changed.
            state.unresolvedTopicPlanCount === count ? {} : { unresolvedTopicPlanCount: count },
        ),

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
export const useFloatingChatDiscardedTopicPlans = () =>
    useFloatingChatStore((state) => state.discardedTopicPlans);
/** Boolean (not the count) so subscribers only re-render when the gate flips. */
export const useFloatingChatHasUnresolvedTopicPlans = () =>
    useFloatingChatStore((state) => state.unresolvedTopicPlanCount > 0);
export const useFloatingChatResolvedConflicts = () =>
    useFloatingChatStore((state) => state.resolvedConflicts);
