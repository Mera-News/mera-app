import { renderHook } from '@testing-library/react-native';
import {
    useChatPopupStore,
    useChatPopupIsExpanded,
    useChatPopupConversationId,
    useChatPopupFactMutationVersion,
} from '../chat-popup-store';

describe('useChatPopupStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        useChatPopupStore.getState().reset();
    });

    // ── initial state ──────────────────────────────────────────────────────
    it('starts collapsed with no conversationId and zero factMutationVersion', () => {
        const state = useChatPopupStore.getState();
        expect(state.isExpanded).toBe(false);
        expect(state.conversationId).toBeNull();
        expect(state.factMutationVersion).toBe(0);
    });

    // ── expand ────────────────────────────────────────────────────────────
    it('expand sets isExpanded to true', () => {
        useChatPopupStore.getState().expand();
        expect(useChatPopupStore.getState().isExpanded).toBe(true);
    });

    it('expand is idempotent', () => {
        useChatPopupStore.getState().expand();
        useChatPopupStore.getState().expand();
        expect(useChatPopupStore.getState().isExpanded).toBe(true);
    });

    // ── collapse ──────────────────────────────────────────────────────────
    it('collapse sets isExpanded to false', () => {
        useChatPopupStore.getState().expand();
        useChatPopupStore.getState().collapse();
        expect(useChatPopupStore.getState().isExpanded).toBe(false);
    });

    it('collapse is idempotent when already collapsed', () => {
        useChatPopupStore.getState().collapse();
        expect(useChatPopupStore.getState().isExpanded).toBe(false);
    });

    // ── setConversationId ─────────────────────────────────────────────────
    it('setConversationId stores the given id', () => {
        useChatPopupStore.getState().setConversationId('conv-123');
        expect(useChatPopupStore.getState().conversationId).toBe('conv-123');
    });

    it('setConversationId can be updated multiple times', () => {
        useChatPopupStore.getState().setConversationId('conv-1');
        useChatPopupStore.getState().setConversationId('conv-2');
        expect(useChatPopupStore.getState().conversationId).toBe('conv-2');
    });

    // ── notifyFactMutation ────────────────────────────────────────────────
    it('notifyFactMutation increments factMutationVersion by 1 each call', () => {
        useChatPopupStore.getState().notifyFactMutation();
        expect(useChatPopupStore.getState().factMutationVersion).toBe(1);
        useChatPopupStore.getState().notifyFactMutation();
        expect(useChatPopupStore.getState().factMutationVersion).toBe(2);
    });

    it('notifyFactMutation does not affect other state', () => {
        useChatPopupStore.getState().expand();
        useChatPopupStore.getState().setConversationId('c1');
        useChatPopupStore.getState().notifyFactMutation();
        expect(useChatPopupStore.getState().isExpanded).toBe(true);
        expect(useChatPopupStore.getState().conversationId).toBe('c1');
    });

    // ── reset ─────────────────────────────────────────────────────────────
    it('reset restores all defaults', () => {
        useChatPopupStore.getState().expand();
        useChatPopupStore.getState().setConversationId('conv-xyz');
        useChatPopupStore.getState().notifyFactMutation();
        useChatPopupStore.getState().notifyFactMutation();
        useChatPopupStore.getState().reset();

        const state = useChatPopupStore.getState();
        expect(state.isExpanded).toBe(false);
        expect(state.conversationId).toBeNull();
        expect(state.factMutationVersion).toBe(0);
    });

    // ── selector hooks (exported) ──────────────────────────────────────────
    it('useChatPopupIsExpanded returns isExpanded', () => {
        const { result } = renderHook(() => useChatPopupIsExpanded());
        expect(result.current).toBe(false);
    });

    it('useChatPopupConversationId returns conversationId', () => {
        const { result } = renderHook(() => useChatPopupConversationId());
        expect(result.current).toBeNull();
    });

    it('useChatPopupFactMutationVersion returns factMutationVersion', () => {
        const { result } = renderHook(() => useChatPopupFactMutationVersion());
        expect(result.current).toBe(0);
    });
});
