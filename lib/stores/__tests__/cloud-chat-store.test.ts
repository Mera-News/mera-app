// cloud-chat-store has no external DB dependencies — no mocks needed beyond
// what jest.setup.js already provides.

import { useCloudChatStore } from '../cloud-chat-store';
import type { ConversationMessage } from '@/lib/llm/types';
import type { WireMessage } from '@/lib/llm/cloudComplete';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
    return {
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        ...overrides,
    };
}

function makeWireMessage(overrides: Partial<WireMessage> = {}): WireMessage {
    return {
        role: 'user',
        content: 'wire msg',
        ...overrides,
    } as WireMessage;
}

const initialState = {
    messages: [] as ConversationMessage[],
    status: 'idle' as const,
    isBlocked: false,
    blockedReason: null as string | null,
    error: null as string | null,
    wireMessages: [] as WireMessage[],
};

describe('useCloudChatStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        useCloudChatStore.getState().reset();
    });

    // ── initial state ────────────────────────────────────────────────────────

    it('starts with empty messages and idle status', () => {
        const state = useCloudChatStore.getState();
        expect(state.messages).toEqual([]);
        expect(state.status).toBe('idle');
        expect(state.isBlocked).toBe(false);
        expect(state.blockedReason).toBeNull();
        expect(state.error).toBeNull();
        expect(state.wireMessages).toEqual([]);
    });

    // ── setMessages ───────────────────────────────────────────────────────────

    it('setMessages with array replaces messages', () => {
        const m1 = makeMessage({ id: 'm1' });
        const m2 = makeMessage({ id: 'm2' });
        useCloudChatStore.getState().setMessages([m1, m2]);

        expect(useCloudChatStore.getState().messages).toEqual([m1, m2]);
    });

    it('setMessages with updater function receives previous messages', () => {
        const m1 = makeMessage({ id: 'm1' });
        useCloudChatStore.setState({ messages: [m1] });

        const m2 = makeMessage({ id: 'm2' });
        useCloudChatStore.getState().setMessages((prev) => [...prev, m2]);

        expect(useCloudChatStore.getState().messages).toEqual([m1, m2]);
    });

    it('setMessages with updater can filter messages', () => {
        const m1 = makeMessage({ id: 'm1', role: 'user' });
        const m2 = makeMessage({ id: 'm2', role: 'assistant' });
        useCloudChatStore.setState({ messages: [m1, m2] });

        useCloudChatStore.getState().setMessages((prev) => prev.filter((m) => m.role === 'user'));

        expect(useCloudChatStore.getState().messages).toEqual([m1]);
    });

    it('setMessages overwrites all previous messages', () => {
        useCloudChatStore.setState({ messages: [makeMessage({ id: 'old' })] });
        const newMsg = makeMessage({ id: 'new' });
        useCloudChatStore.getState().setMessages([newMsg]);
        expect(useCloudChatStore.getState().messages).toEqual([newMsg]);
    });

    it('setMessages with empty array clears messages', () => {
        useCloudChatStore.setState({ messages: [makeMessage()] });
        useCloudChatStore.getState().setMessages([]);
        expect(useCloudChatStore.getState().messages).toEqual([]);
    });

    // ── setStatus ─────────────────────────────────────────────────────────────

    it('setStatus updates to streaming', () => {
        useCloudChatStore.getState().setStatus('streaming');
        expect(useCloudChatStore.getState().status).toBe('streaming');
    });

    it('setStatus updates back to idle', () => {
        useCloudChatStore.setState({ status: 'streaming' });
        useCloudChatStore.getState().setStatus('idle');
        expect(useCloudChatStore.getState().status).toBe('idle');
    });

    // ── setIsBlocked ──────────────────────────────────────────────────────────

    it('setIsBlocked true sets isBlocked flag', () => {
        useCloudChatStore.getState().setIsBlocked(true);
        expect(useCloudChatStore.getState().isBlocked).toBe(true);
    });

    it('setIsBlocked false clears isBlocked flag', () => {
        useCloudChatStore.setState({ isBlocked: true });
        useCloudChatStore.getState().setIsBlocked(false);
        expect(useCloudChatStore.getState().isBlocked).toBe(false);
    });

    // ── setBlockedReason ──────────────────────────────────────────────────────

    it('setBlockedReason stores the reason string', () => {
        useCloudChatStore.getState().setBlockedReason('violation of policy');
        expect(useCloudChatStore.getState().blockedReason).toBe('violation of policy');
    });

    it('setBlockedReason accepts null to clear reason', () => {
        useCloudChatStore.setState({ blockedReason: 'reason' });
        useCloudChatStore.getState().setBlockedReason(null);
        expect(useCloudChatStore.getState().blockedReason).toBeNull();
    });

    // ── setError ──────────────────────────────────────────────────────────────

    it('setError stores the error string', () => {
        useCloudChatStore.getState().setError('connection failed');
        expect(useCloudChatStore.getState().error).toBe('connection failed');
    });

    it('setError accepts null to clear error', () => {
        useCloudChatStore.setState({ error: 'some error' });
        useCloudChatStore.getState().setError(null);
        expect(useCloudChatStore.getState().error).toBeNull();
    });

    // ── pushWireMessage ───────────────────────────────────────────────────────

    it('pushWireMessage appends to wireMessages list', () => {
        const w1 = makeWireMessage({ role: 'user', content: 'msg 1' } as Partial<WireMessage>);
        const w2 = makeWireMessage({ role: 'assistant', content: 'msg 2' } as Partial<WireMessage>);

        useCloudChatStore.getState().pushWireMessage(w1);
        useCloudChatStore.getState().pushWireMessage(w2);

        const state = useCloudChatStore.getState();
        expect(state.wireMessages).toHaveLength(2);
        expect(state.wireMessages[0]).toEqual(w1);
        expect(state.wireMessages[1]).toEqual(w2);
    });

    it('pushWireMessage does not mutate previous list (immutable update)', () => {
        const original = [] as WireMessage[];
        useCloudChatStore.setState({ wireMessages: original });

        const w1 = makeWireMessage();
        useCloudChatStore.getState().pushWireMessage(w1);

        // Original array reference should not be mutated
        expect(original).toHaveLength(0);
        expect(useCloudChatStore.getState().wireMessages).toHaveLength(1);
    });

    // ── getWireMessages ───────────────────────────────────────────────────────

    it('getWireMessages returns current wireMessages array', () => {
        const w1 = makeWireMessage({ content: 'foo' } as Partial<WireMessage>);
        useCloudChatStore.setState({ wireMessages: [w1] });

        const result = useCloudChatStore.getState().getWireMessages();
        expect(result).toEqual([w1]);
    });

    it('getWireMessages returns empty array when no wire messages', () => {
        expect(useCloudChatStore.getState().getWireMessages()).toEqual([]);
    });

    // ── reset ─────────────────────────────────────────────────────────────────

    it('reset clears all state to initial values', () => {
        useCloudChatStore.setState({
            messages: [makeMessage()],
            status: 'streaming',
            isBlocked: true,
            blockedReason: 'spam',
            error: 'failed',
            wireMessages: [makeWireMessage()],
        });

        useCloudChatStore.getState().reset();

        const state = useCloudChatStore.getState();
        expect(state.messages).toEqual([]);
        expect(state.status).toBe('idle');
        expect(state.isBlocked).toBe(false);
        expect(state.blockedReason).toBeNull();
        expect(state.error).toBeNull();
        expect(state.wireMessages).toEqual([]);
    });

    it('reset is idempotent (multiple calls do not throw)', () => {
        useCloudChatStore.getState().reset();
        useCloudChatStore.getState().reset();
        expect(useCloudChatStore.getState().status).toBe('idle');
    });

    // ── combined flows ────────────────────────────────────────────────────────

    it('full chat flow: streaming in progress then reset', () => {
        useCloudChatStore.getState().setStatus('streaming');
        useCloudChatStore.getState().setMessages([makeMessage({ content: 'thinking...' })]);
        useCloudChatStore.getState().pushWireMessage(makeWireMessage());

        expect(useCloudChatStore.getState().status).toBe('streaming');
        expect(useCloudChatStore.getState().messages).toHaveLength(1);

        useCloudChatStore.getState().setStatus('idle');
        useCloudChatStore.getState().reset();

        expect(useCloudChatStore.getState().messages).toEqual([]);
        expect(useCloudChatStore.getState().wireMessages).toEqual([]);
    });

    it('blocked flow: setIsBlocked + setBlockedReason', () => {
        useCloudChatStore.getState().setIsBlocked(true);
        useCloudChatStore.getState().setBlockedReason('offensive content');

        const state = useCloudChatStore.getState();
        expect(state.isBlocked).toBe(true);
        expect(state.blockedReason).toBe('offensive content');
    });
});
