import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { StagedProposal } from '../llm/types';
import type { QuickFactCheckAnswer } from '../chat-tools/quick-fact-check-handler';
import type { TrackFeedbackSubject } from '../news-harness/core/types';
import {
    MAX_TOPIC_PLAN_NOTES,
    type TopicPlanNote,
} from '../news-harness/persona-management/topic-plan-notes';

/** Terminal resolution of a save-time fact conflict (U-B1). */
export type ConflictResolution = 'kept-both' | 'replaced' | 'merged' | 'dismissed';

/**
 * One fact check the user started by tapping a pill on the claim card.
 *
 * IN-MEMORY AND EPHEMERAL, deliberately. A quick answer is a web summary that
 * was true when it was fetched; it is not a stored verdict, it is never written
 * to the `fact_checks` table, and it dies with the thread. Persisting it here
 * would be a second, weaker source of "what has been checked" competing with the
 * Dashboard, which shows only server-checked rows.
 *
 * `mode: 'article'` is the always-last pill — the SERVER-side check of the whole
 * article. Its entry never carries an answer; the Dashboard carries that.
 */
export interface QuickFactCheckEntry {
    id: string;
    mode: 'claim' | 'article';
    /** The pill text the user tapped (display only). */
    label: string;
    /** The searched sentence. Empty for `mode: 'article'`. */
    claim: string;
    status: 'running' | 'done';
    createdAt: number;
    /** Present once a `mode: 'claim'` check settles. */
    answer?: QuickFactCheckAnswer;
    /** Present once a `mode: 'article'` request settles: whether the server
     *  accepted it. False must never render as "it's in the Dashboard". */
    articleRequested?: boolean;
}

/**
 * The page the Mera button was tapped on, as a chat-pool key (World and every
 * country share `world`; Saved, Visited and Stats share `library`). Drives the
 * client-side intro and starters only: it never reaches the model.
 */
export type MeraPageKey =
    | 'feed'
    | 'interests'
    | 'interest'
    | 'stories'
    | 'world'
    | 'checks'
    | 'library'
    | 'profile'
    | 'facts'
    | 'sources';

export type ChatContext =
    // `origin: 'profile'` marks a fact-editing chat (the Mera button on Profile,
    // All facts, Sources, Interests and One interest). Only that chat is an
    // editing session whose close may owe a combination pass (ux2 F2).
    // `subject` is the fact statement on One interest, for its starters.
    | { kind: 'persona'; origin?: 'profile'; page?: MeraPageKey; subject?: string }
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
    // `page: 'stories'` when the Mera button opened it: the thread then shows
    // the page starters instead of waiting for an auto-sent seed.
    | { kind: 'follow-story'; page?: 'stories' }
    | { kind: 'generic'; route: string };

interface FloatingChatState {
    // State
    isExpanded: boolean;
    context: ChatContext;
    // Where ChatPopover morphs from: the Mera button publishes its centre.
    bubbleCenter: { x: number; y: number };
    // When the popover last closed. A reopen within KEEP_THREAD_MS keeps the
    // thread even from another page (navx amendment).
    closedAt: number | null;
    // Text a starter put in the composer. Level-triggered: ChatThread consumes
    // it once the composer exists, so a fresh conversation cannot swallow it.
    pendingDraft: string | null;
    /** A chat turn is busy, the WHOLE turn on either engine. Written only by
     *  the chat session (lib/chat-session). */
    isGenerating: boolean;
    /** A turn finished while the chat was closed and nobody has opened it
     *  since: the Mera button's ring. Memory only, never persisted, never
     *  counted (invariant 9). */
    answerUnread: boolean;
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
    // How many FACT-CHOICE cards in the mounted thread are still unanswered.
    // Same job as unresolvedTopicPlanCount, for the card that now precedes it:
    // published by ChatSessionView and read by the onboarding wizard.
    unresolvedFactChoiceCount: number;
    // Tool RESULTS rewritten after the fact, keyed `${messageId}::${toolCallIndex}`.
    //
    // A fact-choice card commits from the UI, long after the model's tool call
    // returned `staged: true`. Everything downstream — the "Saved to your
    // persona" card, conflict cards, topic-plan cards, the composer gate — reads
    // `savedFacts` off the PERSISTED tool result, so rather than teach each of
    // them a second source, the commit rewrites the result and they all keep
    // working unchanged.
    //
    // Keyed by message id + call INDEX, never by `tc.id`: local ids are
    // `local-tc-${counter}` and collide across messages.
    //
    // DELIBERATELY NOT CLEARED on a context switch, unlike `proposal` and
    // `quickFactChecks` below. This is a record of writes that already happened,
    // not in-flight consent — dropping it would revert committed cards to
    // unresolved and re-block the composer against facts that are live in the
    // database.
    toolCallResults: Record<string, Record<string, unknown>>;
    // What the user did with topic-plan cards this APP SESSION, oldest-first.
    //
    // NEVER DRAINED when a turn fires. Cloud's wireMessages survive a remount
    // but the local engine keeps its messages in component state and loses them
    // when the popover closes — draining would give cloud a durable record and
    // local nothing, which is exactly the cross-engine divergence this channel
    // exists to avoid. Redundancy on cloud costs ~40 tokens.
    topicPlanNotes: TopicPlanNote[];
    // Monotonic nonce: a DISCARD asks for a model turn. Edge-triggered, and
    // cleared aggressively — a nonce that outlives its thread would fire a
    // "you rejected my topics" reply into a brand-new conversation.
    topicPlanTurnRequest: number | null;
    // True from the moment that turn is dispatched until it settles. Read by
    // useCloudPersonaChat's forcedExtractionTools(): a forced
    // `tool_choice:'required'` would oblige saveExtractedFacts on the very turn
    // whose note says to save nothing.
    topicPlanTurnInFlight: boolean;
    // Quick fact checks started in THIS thread, oldest-first. See
    // QuickFactCheckEntry: in-memory only, never persisted, cleared whenever the
    // thread is (a stale answer about another article would be worse than none).
    quickFactChecks: QuickFactCheckEntry[];
    // Conversation identity for the whole APP SESSION (not per popover open).
    // In-memory only (no persist middleware) so it naturally dies on app kill,
    // giving fresh-conversation-per-launch for free. Closing/reopening the
    // popover reuses this id, so messages resume. `null` is the single
    // level-triggered "a fresh conversation is needed" signal MeraChatSession
    // watches — unlike an edge-triggered nonce it can't be swallowed by mount
    // order (the session unmounts while the popover is closed).
    conversationId: string | null;

    // Actions
    expand: (context?: ChatContext, opts?: { draft?: string }) => void;
    consumePendingDraft: () => string | null;
    openArticleFeedback: (context: ChatContext, initialMessage: string) => void;
    openOptimisationPlan: () => void;
    consumePendingInitialMessage: () => string | null;
    setProposal: (p: StagedProposal | null) => void;
    resolveProposal: (status: 'applied' | 'cancelled') => void;
    setTopicPlanSettled: (factId: string) => void;
    setTopicPlanDiscarded: (factId: string) => void;
    setUnresolvedTopicPlanCount: (count: number) => void;
    setUnresolvedFactChoiceCount: (count: number) => void;
    setToolCallResult: (key: string, result: Record<string, unknown>) => void;
    addTopicPlanNote: (note: TopicPlanNote) => void;
    requestTopicPlanTurn: () => void;
    clearTopicPlanTurnRequest: () => void;
    setTopicPlanTurnInFlight: (value: boolean) => void;
    beginQuickFactCheck: (entry: QuickFactCheckEntry) => void;
    settleQuickFactCheck: (
        id: string,
        outcome: { answer?: QuickFactCheckAnswer; articleRequested?: boolean },
    ) => void;
    resolveConflict: (conflictKey: string, resolution: ConflictResolution) => void;
    collapse: () => void;
    toggle: () => void;
    setBubbleCenter: (c: { x: number; y: number }) => void;
    setGenerating: (v: boolean) => void;
    setSuppressed: (v: boolean) => void;
    notifyFactMutation: () => void;
    setConversationId: (id: string | null) => void;
    requestNewChat: () => void;
    reset: () => void;
}

const DEFAULT_CONTEXT: ChatContext = { kind: 'persona' };

/** A reopen this soon after a close keeps the thread across a page change. */
export const KEEP_THREAD_MS = 10 * 60 * 1000;

const initialState = {
    isExpanded: false,
    context: DEFAULT_CONTEXT,
    bubbleCenter: { x: 0, y: 0 },
    closedAt: null as number | null,
    pendingDraft: null as string | null,
    isGenerating: false,
    answerUnread: false,
    suppressed: false,
    factMutationVersion: 0,
    pendingInitialMessage: null as string | null,
    proposal: null as StagedProposal | null,
    resolvedProposals: {} as Record<string, 'applied' | 'cancelled'>,
    settledTopicPlans: {} as Record<string, boolean>,
    discardedTopicPlans: {} as Record<string, boolean>,
    resolvedConflicts: {} as Record<string, ConflictResolution>,
    unresolvedTopicPlanCount: 0,
    unresolvedFactChoiceCount: 0,
    toolCallResults: {} as Record<string, Record<string, unknown>>,
    topicPlanNotes: [] as TopicPlanNote[],
    topicPlanTurnRequest: null as number | null,
    topicPlanTurnInFlight: false,
    quickFactChecks: [] as QuickFactCheckEntry[],
    conversationId: null as string | null,
};

/** The open must keep the current thread: a turn is busy or its answer is
 *  unread. */
function threadHeld(state: { isGenerating: boolean; answerUnread: boolean }): boolean {
    return state.isGenerating || state.answerUnread;
}

/** Unread is set when a turn ends while the chat is closed, and kept until
 *  the chat opens. */
export function nextAnswerUnread(
    state: { isGenerating: boolean; isExpanded: boolean; answerUnread: boolean },
    generating: boolean,
): boolean {
    if (state.isGenerating && !generating && !state.isExpanded) return true;
    return state.answerUnread && !state.isExpanded;
}

/** True if two contexts differ in kind, target id or (persona) page. */
function contextDiffers(a: ChatContext, b: ChatContext): boolean {
    if (a.kind !== b.kind) return true;
    if (a.kind === 'persona' && b.kind === 'persona') return a.page !== b.page;
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

    expand: (context, opts) => {
        // Mera News Free USED to no-op here, so a locked user's tap did
        // nothing at all. It now OPENS: the popup is how the free tier is
        // explained, in Mera's own voice, on the surface the user actually
        // touched. Everything that made opening unsafe is gated deeper —
        // ChatSessionView refuses to dispatch a turn and mounts no engine — so
        // there is nothing left for this chokepoint to protect.
        set((state) => {
            // A turn still running, or an answer nobody has read: the open
            // shows THAT thread, whatever the page, kind or elapsed time. A
            // new context here would start a new conversation under a turn
            // still writing to this one, and the ring would point at nothing.
            if (threadHeld(state)) {
                return { isExpanded: true, answerUnread: false, pendingDraft: opts?.draft ?? null };
            }
            // Switching to a different context must start a fresh thread so a
            // stale persona chat never bleeds into an article-feedback session.
            // Nulling conversationId is the level-triggered "create a
            // conversation" signal MeraChatSession watches; unlike a nonce it
            // can't be swallowed by mount order. Also drop any pending auto-send
            // (a prior thumbs-down message must not leak into the new thread)
            // and any staged proposal (must not leak across articles).
            //
            // A PAGE change between two persona chats keeps the thread when the
            // chat closed less than KEEP_THREAD_MS ago or a proposal card is
            // still waiting (navx amendment); the new page's starters show
            // under it. A change of kind or target always starts fresh.
            const keepsThread =
                context !== undefined &&
                context.kind === 'persona' &&
                state.context.kind === 'persona' &&
                (state.proposal !== null ||
                    (state.closedAt !== null && Date.now() - state.closedAt < KEEP_THREAD_MS));
            const switching =
                context !== undefined && contextDiffers(context, state.context) && !keepsThread;
            return {
                isExpanded: true,
                answerUnread: false,
                context: context ?? state.context,
                pendingDraft: opts?.draft ?? null,
                ...(switching
                    ? {
                          conversationId: null,
                          pendingInitialMessage: null,
                          proposal: null,
                          quickFactChecks: [],
                          topicPlanNotes: [],
                          topicPlanTurnRequest: null,
                      }
                    : {}),
            };
        });
    },

    openArticleFeedback: (context, initialMessage) => {
        // A held thread opens as it is and the seed is dropped (see `expand`).
        if (threadHeld(get())) {
            set({ isExpanded: true, answerUnread: false });
            return;
        }
        set(() => ({
            context,
            pendingInitialMessage: initialMessage,
            isExpanded: true,
            proposal: null,
            quickFactChecks: [],
            topicPlanNotes: [],
            topicPlanTurnRequest: null,
            // Null id = "create a fresh conversation" (fresh thread per thumbs
            // tap). The zustand set is atomic, so the null id and the pending
            // message land in one commit — the old thread unmounts before its
            // auto-send effect could consume the message into the OLD
            // conversation.
            conversationId: null,
        }));
    },

    openOptimisationPlan: () => {
        if (threadHeld(get())) {
            set({ isExpanded: true, answerUnread: false });
            return;
        }
        // Opens on the free tier too (see `expand`); the plan card itself
        // loads nothing for a locked user and the opener explains why.
        set(() => ({
            // Fresh thread showing only the plan card (no auto-send). Null id is
            // the "create a fresh conversation" signal MeraChatSession watches.
            context: { kind: 'optimisation-plan' } as ChatContext,
            isExpanded: true,
            pendingInitialMessage: null,
            proposal: null,
            quickFactChecks: [],
            topicPlanNotes: [],
            topicPlanTurnRequest: null,
            conversationId: null,
        }));
    },

    consumePendingDraft: () => {
        const draft = get().pendingDraft;
        if (draft !== null) set({ pendingDraft: null });
        return draft;
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

    setUnresolvedFactChoiceCount: (count) =>
        set((state) =>
            state.unresolvedFactChoiceCount === count ? {} : { unresolvedFactChoiceCount: count },
        ),

    setToolCallResult: (key, result) =>
        set((state) => ({ toolCallResults: { ...state.toolCallResults, [key]: result } })),

    addTopicPlanNote: (note) =>
        set((state) => ({
            topicPlanNotes: [...state.topicPlanNotes, note].slice(-MAX_TOPIC_PLAN_NOTES),
        })),

    // Date.now() is fine as a nonce here: it only has to DIFFER from the last
    // one the view fired, and two discards cannot land in the same millisecond
    // through a sequential await loop.
    requestTopicPlanTurn: () => set({ topicPlanTurnRequest: Date.now() }),

    clearTopicPlanTurnRequest: () => set({ topicPlanTurnRequest: null }),

    setTopicPlanTurnInFlight: (value) =>
        set((state) => (state.topicPlanTurnInFlight === value ? {} : { topicPlanTurnInFlight: value })),

    beginQuickFactCheck: (entry) =>
        set((state) => ({ quickFactChecks: [...state.quickFactChecks, entry] })),

    settleQuickFactCheck: (id, outcome) =>
        set((state) => ({
            quickFactChecks: state.quickFactChecks.map((e) =>
                e.id === id ? { ...e, ...outcome, status: 'done' as const } : e,
            ),
        })),

    resolveConflict: (conflictKey, resolution) =>
        set((state) => ({
            resolvedConflicts: { ...state.resolvedConflicts, [conflictKey]: resolution },
        })),

    collapse: () =>
        set((state) => (state.isExpanded ? { isExpanded: false, closedAt: Date.now() } : {})),

    toggle: () =>
        set((state) =>
            state.isExpanded
                ? { isExpanded: false, closedAt: Date.now() }
                : { isExpanded: true, answerUnread: false },
        ),

    setBubbleCenter: (c) => set({ bubbleCenter: c }),

    setGenerating: (v) =>
        set((state) => ({
            isGenerating: v,
            answerUnread: nextAnswerUnread(state, v),
        })),

    setSuppressed: (v) => set({ suppressed: v }),

    notifyFactMutation: () => set((state) => ({ factMutationVersion: state.factMutationVersion + 1 })),

    setConversationId: (id) => set({ conversationId: id }),

    // The nonce MUST die here. A discard parked behind an unresolved sibling
    // card would otherwise fire its "you rejected my topics" reply into the
    // brand-new conversation this call is creating.
    requestNewChat: () =>
        set({
            conversationId: null,
            quickFactChecks: [],
            topicPlanNotes: [],
            topicPlanTurnRequest: null,
        }),

    reset: () => set({ ...initialState }),
}));

// Selector hooks for optimized subscriptions
export const useFloatingChatIsExpanded = () => useFloatingChatStore((state) => state.isExpanded);
export const useFloatingChatFactMutationVersion = () =>
    useFloatingChatStore((state) => state.factMutationVersion);
export const useFloatingChatIsGenerating = () => useFloatingChatStore((state) => state.isGenerating);
export const useFloatingChatAnswerUnread = () => useFloatingChatStore((state) => state.answerUnread);
export const useFloatingChatSuppressed = () => useFloatingChatStore((state) => state.suppressed);
export const useFloatingChatConversationId = () => useFloatingChatStore((state) => state.conversationId);
export const useFloatingChatProposal = () => useFloatingChatStore((state) => state.proposal);
export const useFloatingChatResolvedProposals = () =>
    useFloatingChatStore((state) => state.resolvedProposals);
export const useFloatingChatSettledTopicPlans = () =>
    useFloatingChatStore((state) => state.settledTopicPlans);
export const useFloatingChatDiscardedTopicPlans = () =>
    useFloatingChatStore((state) => state.discardedTopicPlans);
/** Boolean (not the count) so subscribers only re-render when the gate flips.
 *  Covers BOTH card kinds: a fact choice and a topic plan block the same
 *  surfaces for the same reason, and the onboarding wizard needs one signal. */
export const useFloatingChatHasUnresolvedTopicPlans = () =>
    useFloatingChatStore(
        (state) => state.unresolvedTopicPlanCount > 0 || state.unresolvedFactChoiceCount > 0,
    );
/** The two counts separately, for a caller that must say WHICH card is pending
 *  (the onboarding toast picks its wording from this). */
export const useFloatingChatUnresolvedCounts = () =>
    useFloatingChatStore(
        useShallow((state) => ({
            topicPlans: state.unresolvedTopicPlanCount,
            factChoices: state.unresolvedFactChoiceCount,
        })),
    );
export const useFloatingChatTopicPlanTurnRequest = () =>
    useFloatingChatStore((state) => state.topicPlanTurnRequest);
export const useFloatingChatToolCallResults = () =>
    useFloatingChatStore((state) => state.toolCallResults);
export const useFloatingChatResolvedConflicts = () =>
    useFloatingChatStore((state) => state.resolvedConflicts);
export const useFloatingChatPendingDraft = () =>
    useFloatingChatStore((state) => state.pendingDraft);
export const useFloatingChatQuickFactChecks = () =>
    useFloatingChatStore((state) => state.quickFactChecks);

// ---------------------------------------------------------------------------
// THE PROFILE CHAT'S FACTS DRAFT (ux2 F2)
// ---------------------------------------------------------------------------
// Every close path (the X, the backdrop, the swipe, a toggle) ends in
// `isExpanded` going false, so the transition is watched here rather than at
// each call site. Opening from Profile fingerprints the facts; any close
// settles that fingerprint and starts the combination pass when facts changed.
// The Profile origin is dropped on close, or a later bubble open (which keeps
// the previous context) would count as a Profile chat.
/** A draft opened in THIS JS context. A draft a kill left open is settled at
 *  the next launch by inference-recover instead, so a plain close never has to
 *  load the service (and WatermelonDB) for a chat that opened none. */
let profileDraftOpen = false;
useFloatingChatStore.subscribe((state, prev) => {
    if (state.isExpanded === prev.isExpanded) return;
    const opening =
        state.isExpanded && state.context.kind === 'persona' && state.context.origin === 'profile';
    if (!opening && !(profileDraftOpen && !state.isExpanded)) return;
    // LAZY: the service reaches WatermelonDB, which must stay out of every
    // suite that imports this store. The module exists, so Metro bundles it.
    const draft =
        require('@/lib/services/facts-draft-service') as typeof import('@/lib/services/facts-draft-service');
    const report = (err: unknown) =>
        (require('@/lib/logger') as typeof import('@/lib/logger')).default.captureException(err, {
            tags: { area: 'facts-draft' },
        });
    if (opening) {
        profileDraftOpen = true;
        void draft.openFactsDraft().catch(report);
        return;
    }
    profileDraftOpen = false;
    // A failed settle leaves the open marker, which the next launch recovers.
    void draft.settleProfileChatClose().catch(report);
    if (state.context.kind === 'persona' && state.context.origin) {
        // Keep the page: dropping it would read as a page change on reopen.
        const context = { ...state.context };
        delete context.origin;
        useFloatingChatStore.setState({ context });
    }
});
