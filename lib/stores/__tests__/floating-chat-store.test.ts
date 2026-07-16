import { renderHook } from '@testing-library/react-native';
import {
    useFloatingChatStore,
    useFloatingChatIsExpanded,
    useFloatingChatFactMutationVersion,
    useFloatingChatIsGenerating,
    useFloatingChatSuppressed,
} from '../floating-chat-store';

describe('useFloatingChatStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        useFloatingChatStore.getState().reset();
    });

    // ── initial state ──────────────────────────────────────────────────────
    it('starts with sane defaults', () => {
        const state = useFloatingChatStore.getState();
        expect(state.isExpanded).toBe(false);
        expect(state.context).toEqual({ kind: 'persona' });
        expect(state.bubbleSnapSide).toBe('right');
        expect(typeof state.bubbleY).toBe('number');
        expect(state.bubbleY).toBeGreaterThan(0);
        expect(state.bubbleCenter).toEqual({ x: 0, y: 0 });
        expect(state.isGenerating).toBe(false);
        expect(state.suppressed).toBe(false);
        expect(state.factMutationVersion).toBe(0);
    });

    // ── expand ────────────────────────────────────────────────────────────
    it('expand sets isExpanded to true and keeps context when none given', () => {
        useFloatingChatStore.getState().expand();
        expect(useFloatingChatStore.getState().isExpanded).toBe(true);
        expect(useFloatingChatStore.getState().context).toEqual({ kind: 'persona' });
    });

    it('expand sets the provided context', () => {
        useFloatingChatStore
            .getState()
            .expand({ kind: 'article-suggestion', suggestionId: 'sugg-1' });
        expect(useFloatingChatStore.getState().isExpanded).toBe(true);
        expect(useFloatingChatStore.getState().context).toEqual({
            kind: 'article-suggestion',
            suggestionId: 'sugg-1',
        });
    });

    it('expand is idempotent', () => {
        useFloatingChatStore.getState().expand();
        useFloatingChatStore.getState().expand();
        expect(useFloatingChatStore.getState().isExpanded).toBe(true);
    });

    // ── collapse ──────────────────────────────────────────────────────────
    it('collapse sets isExpanded to false', () => {
        useFloatingChatStore.getState().expand();
        useFloatingChatStore.getState().collapse();
        expect(useFloatingChatStore.getState().isExpanded).toBe(false);
    });

    it('collapse is idempotent when already collapsed', () => {
        useFloatingChatStore.getState().collapse();
        expect(useFloatingChatStore.getState().isExpanded).toBe(false);
    });

    // ── toggle ────────────────────────────────────────────────────────────
    it('toggle flips isExpanded', () => {
        expect(useFloatingChatStore.getState().isExpanded).toBe(false);
        useFloatingChatStore.getState().toggle();
        expect(useFloatingChatStore.getState().isExpanded).toBe(true);
        useFloatingChatStore.getState().toggle();
        expect(useFloatingChatStore.getState().isExpanded).toBe(false);
    });

    // ── bubble position ───────────────────────────────────────────────────
    it('setBubblePosition updates side and y', () => {
        useFloatingChatStore.getState().setBubblePosition('left', 123);
        expect(useFloatingChatStore.getState().bubbleSnapSide).toBe('left');
        expect(useFloatingChatStore.getState().bubbleY).toBe(123);
    });

    it('setBubbleCenter updates the center coordinates', () => {
        useFloatingChatStore.getState().setBubbleCenter({ x: 10, y: 20 });
        expect(useFloatingChatStore.getState().bubbleCenter).toEqual({ x: 10, y: 20 });
    });

    // ── generating / suppressed ───────────────────────────────────────────
    it('setGenerating toggles isGenerating', () => {
        useFloatingChatStore.getState().setGenerating(true);
        expect(useFloatingChatStore.getState().isGenerating).toBe(true);
        useFloatingChatStore.getState().setGenerating(false);
        expect(useFloatingChatStore.getState().isGenerating).toBe(false);
    });

    it('setSuppressed toggles suppressed', () => {
        useFloatingChatStore.getState().setSuppressed(true);
        expect(useFloatingChatStore.getState().suppressed).toBe(true);
        useFloatingChatStore.getState().setSuppressed(false);
        expect(useFloatingChatStore.getState().suppressed).toBe(false);
    });

    // ── conversationId as the fresh-conversation signal ───────────────────
    it('expand with a different article-suggestion context nulls conversationId and clears pendingInitialMessage + proposal', () => {
        // Seed an existing conversation on article 1 with a pending message and
        // a staged proposal.
        useFloatingChatStore
            .getState()
            .expand({ kind: 'article-suggestion', suggestionId: 'sugg-1' });
        useFloatingChatStore.getState().setConversationId('c1');
        useFloatingChatStore.getState().setProposal({ id: 'p1' } as never);
        useFloatingChatStore.setState({ pendingInitialMessage: 'stale msg' });

        // Switch to article 2.
        useFloatingChatStore
            .getState()
            .expand({ kind: 'article-suggestion', suggestionId: 'sugg-2' });

        const state = useFloatingChatStore.getState();
        expect(state.conversationId).toBeNull();
        expect(state.pendingInitialMessage).toBeNull();
        expect(state.proposal).toBeNull();
        expect(state.context).toEqual({ kind: 'article-suggestion', suggestionId: 'sugg-2' });
    });

    it('expand with the same context preserves conversationId', () => {
        useFloatingChatStore
            .getState()
            .expand({ kind: 'article-suggestion', suggestionId: 'sugg-1' });
        useFloatingChatStore.getState().setConversationId('c1');

        useFloatingChatStore
            .getState()
            .expand({ kind: 'article-suggestion', suggestionId: 'sugg-1' });

        expect(useFloatingChatStore.getState().conversationId).toBe('c1');
    });

    it('expand with undefined context preserves conversationId', () => {
        useFloatingChatStore.getState().setConversationId('c1');
        useFloatingChatStore.getState().expand();
        expect(useFloatingChatStore.getState().conversationId).toBe('c1');
    });

    it('openArticleFeedback always nulls conversationId and sets pendingInitialMessage', () => {
        useFloatingChatStore.getState().setConversationId('c1');
        useFloatingChatStore
            .getState()
            .openArticleFeedback(
                { kind: 'article-suggestion', suggestionId: 'sugg-1' },
                'I like this',
            );

        const state = useFloatingChatStore.getState();
        expect(state.conversationId).toBeNull();
        expect(state.pendingInitialMessage).toBe('I like this');
        expect(state.isExpanded).toBe(true);
        expect(state.proposal).toBeNull();
        expect(state.context).toEqual({ kind: 'article-suggestion', suggestionId: 'sugg-1' });
    });

    it('requestNewChat nulls conversationId', () => {
        useFloatingChatStore.getState().setConversationId('c1');
        useFloatingChatStore.getState().requestNewChat();
        expect(useFloatingChatStore.getState().conversationId).toBeNull();
    });

    // ── notifyFactMutation ────────────────────────────────────────────────
    it('notifyFactMutation increments factMutationVersion by 1 each call', () => {
        useFloatingChatStore.getState().notifyFactMutation();
        expect(useFloatingChatStore.getState().factMutationVersion).toBe(1);
        useFloatingChatStore.getState().notifyFactMutation();
        expect(useFloatingChatStore.getState().factMutationVersion).toBe(2);
    });

    it('notifyFactMutation does not affect other state', () => {
        useFloatingChatStore.getState().expand();
        useFloatingChatStore.getState().setGenerating(true);
        useFloatingChatStore.getState().notifyFactMutation();
        expect(useFloatingChatStore.getState().isExpanded).toBe(true);
        expect(useFloatingChatStore.getState().isGenerating).toBe(true);
    });

    // ── reset ─────────────────────────────────────────────────────────────
    it('reset restores all defaults', () => {
        useFloatingChatStore.getState().expand({ kind: 'generic', route: '/foo' });
        useFloatingChatStore.getState().setBubblePosition('left', 999);
        useFloatingChatStore.getState().setBubbleCenter({ x: 5, y: 5 });
        useFloatingChatStore.getState().setGenerating(true);
        useFloatingChatStore.getState().setSuppressed(true);
        useFloatingChatStore.getState().notifyFactMutation();
        useFloatingChatStore.getState().notifyFactMutation();
        useFloatingChatStore.getState().reset();

        const state = useFloatingChatStore.getState();
        expect(state.isExpanded).toBe(false);
        expect(state.context).toEqual({ kind: 'persona' });
        expect(state.bubbleSnapSide).toBe('right');
        expect(state.bubbleCenter).toEqual({ x: 0, y: 0 });
        expect(state.isGenerating).toBe(false);
        expect(state.suppressed).toBe(false);
        expect(state.factMutationVersion).toBe(0);
    });

    // ── selector hooks (exported) ──────────────────────────────────────────
    it('useFloatingChatIsExpanded returns isExpanded', () => {
        const { result } = renderHook(() => useFloatingChatIsExpanded());
        expect(result.current).toBe(false);
    });

    it('useFloatingChatFactMutationVersion returns factMutationVersion', () => {
        const { result } = renderHook(() => useFloatingChatFactMutationVersion());
        expect(result.current).toBe(0);
    });

    it('useFloatingChatIsGenerating returns isGenerating', () => {
        const { result } = renderHook(() => useFloatingChatIsGenerating());
        expect(result.current).toBe(false);
    });

    it('useFloatingChatSuppressed returns suppressed', () => {
        const { result } = renderHook(() => useFloatingChatSuppressed());
        expect(result.current).toBe(false);
    });
});
