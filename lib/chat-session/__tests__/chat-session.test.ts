// The chat session owns a turn's lifecycle with no component mounted: one
// engine per conversation, the restart hold for exactly the busy window, the
// busy flag mirrored to the floating-chat store, and finished messages
// written once.

const mockHolds: { released: boolean }[] = [];
jest.mock('@/lib/app-restart', () => ({
  holdRestart: () => {
    const h = { released: false };
    mockHolds.push(h);
    return () => {
      h.released = true;
    };
  },
}));
const mockAppend = jest.fn((..._a: unknown[]) => Promise.resolve());
jest.mock('@/lib/database/services/conversation-service', () => ({
  appendMessage: (...a: unknown[]) => mockAppend(...a),
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));
const mockMade: { kind: string; agent: unknown; dispose: jest.Mock; setAgent: jest.Mock; stop: jest.Mock }[] = [];
function mockEngine(kind: string) {
  return (agent: unknown) => {
    const e = { kind, agent, dispose: jest.fn(), setAgent: jest.fn(), send: jest.fn(), sendHidden: jest.fn(), stop: jest.fn() };
    mockMade.push(e);
    return e;
  };
}
jest.mock('@/lib/hooks/useCloudPersonaChat', () => ({ createCloudEngine: mockEngine('cloud') }));
jest.mock('@/lib/llm/useLocalLLM', () => ({ createLocalEngine: mockEngine('local') }));

import type { ConversationMessage, IAgent } from '@/lib/llm/types';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { attachChatSession, resetChatSession, stopChatTurn } from '../chat-session';
import { useLocalChatStore } from '../local-chat-store';

const agentA = { id: 'persona-a' } as unknown as IAgent;
const agentB = { id: 'persona-b' } as unknown as IAgent;
const cloud = () => useCloudChatStore.getState();
const held = () => mockHolds.filter((h) => !h.released).length;

const msg = (id: string, role: 'user' | 'assistant', content = 'x', extra: Partial<ConversationMessage> = {}) =>
  ({ id, role, content, createdAt: 0, ...extra }) as ConversationMessage;

beforeEach(() => {
  resetChatSession();
  useFloatingChatStore.getState().reset();
  mockHolds.length = 0;
  mockMade.length = 0;
  mockAppend.mockClear();
});

describe('attach', () => {
  it('reuses the engine for the same conversation and swaps its agent', () => {
    const first = attachChatSession({ conversationId: 'c1', kind: 'cloud', agent: agentA, persistedIds: [] });
    const again = attachChatSession({ conversationId: 'c1', kind: 'cloud', agent: agentB, persistedIds: [] });
    expect(again).toBe(first);
    expect(mockMade).toHaveLength(1);
    expect(mockMade[0].setAgent).toHaveBeenCalledWith(agentB);
  });

  it('a new conversation or engine kind replaces the engine and disposes the old one', () => {
    attachChatSession({ conversationId: 'c1', kind: 'cloud', agent: agentA, persistedIds: [] });
    attachChatSession({ conversationId: 'c2', kind: 'cloud', agent: agentA, persistedIds: [] });
    attachChatSession({ conversationId: 'c2', kind: 'local', agent: agentA, persistedIds: [] });
    expect(mockMade.map((e) => e.kind)).toEqual(['cloud', 'cloud', 'local']);
    expect(mockMade[0].dispose).toHaveBeenCalled();
    expect(mockMade[1].dispose).toHaveBeenCalled();
    expect(mockMade[2].dispose).not.toHaveBeenCalled();
  });
});

describe('busy: the whole turn on either engine', () => {
  beforeEach(() => {
    attachChatSession({ conversationId: 'c1', kind: 'cloud', agent: agentA, persistedIds: [] });
  });

  it('holds a restart from the first busy signal to the last, released exactly once', () => {
    cloud().setStatus('streaming');
    cloud().setAgentTurnState({ turnActive: true } as never);
    expect(held()).toBe(1);
    // Text stopped, the forced pass is still writing: still held.
    cloud().setStatus('idle');
    expect(held()).toBe(1);
    expect(useFloatingChatStore.getState().isGenerating).toBe(true);
    cloud().setAgentTurnState({ turnActive: false } as never);
    expect(held()).toBe(0);
    expect(mockHolds).toHaveLength(1);
    expect(useFloatingChatStore.getState().isGenerating).toBe(false);
  });

  it('on-device tool execution after the text stops is still busy', () => {
    useLocalChatStore.setState({ status: 'streaming', turnBusy: true });
    useLocalChatStore.setState({ status: 'idle' });
    expect(held()).toBe(1);
    useLocalChatStore.setState({ turnBusy: false });
    expect(held()).toBe(0);
  });

  it('a turn that ends with the chat closed marks the answer unread', () => {
    cloud().setStatus('streaming');
    cloud().setStatus('idle');
    expect(useFloatingChatStore.getState().answerUnread).toBe(true);
  });

  it('a reset mid-turn releases the hold', () => {
    cloud().setStatus('streaming');
    resetChatSession();
    expect(held()).toBe(0);
  });
});

describe('persistence', () => {
  it('writes a user message at once and an assistant reply only once the turn is idle', () => {
    attachChatSession({ conversationId: 'c1', kind: 'cloud', agent: agentA, persistedIds: [] });
    cloud().setStatus('streaming');
    cloud().setMessages([msg('u1', 'user'), msg('a1', 'assistant', 'hal')]);
    expect(mockAppend.mock.calls.map((c) => c[2])).toEqual(['u1']);
    cloud().setMessages((p) => p.map((m) => (m.id === 'a1' ? { ...m, content: 'hallo' } : m)));
    cloud().setStatus('idle');
    expect(mockAppend.mock.calls.map((c) => c[2])).toEqual(['u1', 'a1']);
    cloud().setError(null);
    expect(mockAppend).toHaveBeenCalledTimes(2);
  });

  it('never re-writes the resumed rows', () => {
    cloud().setMessages([msg('u1', 'user'), msg('a1', 'assistant')]);
    attachChatSession({ conversationId: 'c1', kind: 'cloud', agent: agentA, persistedIds: ['u1', 'a1'] });
    cloud().setError(null);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('writes the on-device thread for an on-device engine', () => {
    attachChatSession({ conversationId: 'c9', kind: 'local', agent: agentA, persistedIds: [] });
    useLocalChatStore.setState({ messages: [msg('u1', 'user')] });
    expect(mockAppend.mock.calls[0][0]).toBe('c9');
  });

  it('merges a tool-result override recorded before the row existed', () => {
    attachChatSession({ conversationId: 'c1', kind: 'cloud', agent: agentA, persistedIds: [] });
    useFloatingChatStore.getState().setToolCallResult('a1::0', { tapped: true });
    cloud().setMessages([
      msg('a1', 'assistant', '', {
        toolCalls: [{ id: 't', name: 'saveExtractedFacts', input: {}, status: 'done', result: {} }],
      } as Partial<ConversationMessage>),
    ]);
    const written = mockAppend.mock.calls[0][1] as { toolCalls: { result: unknown }[] };
    expect(written.toolCalls[0].result).toEqual({ tapped: true });
  });
});

describe('stopChatTurn', () => {
  it('does nothing when no turn is running', () => {
    attachChatSession({ conversationId: 'c1', kind: 'cloud', agent: agentA, persistedIds: [] });
    stopChatTurn();
    expect(mockMade[0].stop).not.toHaveBeenCalled();
  });

  it('stops the live engine mid-turn; once the engine settles, busy clears and nothing stays held', () => {
    attachChatSession({ conversationId: 'c1', kind: 'cloud', agent: agentA, persistedIds: [] });
    // The fake engine behaves like the real one: stop ends the turn.
    mockMade[0].stop.mockImplementation(() => {
      cloud().setStatus('idle');
      cloud().setAgentTurnState({ turnActive: false } as never);
    });
    // The Stop button lives in the open chat.
    useFloatingChatStore.setState({ isExpanded: true });
    cloud().setStatus('streaming');
    cloud().setAgentTurnState({ turnActive: true } as never);
    expect(useFloatingChatStore.getState().isGenerating).toBe(true);

    stopChatTurn();

    expect(mockMade[0].stop).toHaveBeenCalledTimes(1);
    expect(useFloatingChatStore.getState().isGenerating).toBe(false);
    expect(held()).toBe(0);
    // No "answer ready" ring for a turn the reader stopped.
    expect(useFloatingChatStore.getState().answerUnread).toBe(false);
  });

  it('stops the on-device engine too', () => {
    attachChatSession({ conversationId: 'c2', kind: 'local', agent: agentA, persistedIds: [] });
    useLocalChatStore.setState({ turnBusy: true });
    stopChatTurn();
    expect(mockMade[0].stop).toHaveBeenCalledTimes(1);
  });
});
