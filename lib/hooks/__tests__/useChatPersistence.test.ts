// useChatPersistence.test.ts — renderHook tests for lib/hooks/useChatPersistence.ts

const mockAppendMessage = jest.fn();

jest.mock('../../database/services/conversation-service', () => ({
  appendMessage: (...args: unknown[]) => mockAppendMessage(...args),
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    captureMessage: jest.fn(), captureException: jest.fn(),
  },
}));

import { renderHook } from '@testing-library/react-native';
import { useChatPersistence } from '../useChatPersistence';
import type { ConversationMessage, ToolCallRecord } from '../../llm/types';

type Status = 'idle' | 'streaming';

interface HookProps {
  messages: ConversationMessage[];
  status: Status;
  conversationId: string | null;
  seedPersistedIds?: readonly string[];
}

function renderPersistence(initial: HookProps) {
  return renderHook(
    ({ messages, status, conversationId, seedPersistedIds }: HookProps) =>
      useChatPersistence(messages, status, conversationId, seedPersistedIds),
    { initialProps: initial },
  );
}

const userMsg = (id: string, content = 'hello'): ConversationMessage => ({
  id,
  role: 'user',
  content,
});

const assistantMsg = (
  id: string,
  content = 'hi there',
  toolCalls?: ToolCallRecord[],
): ConversationMessage => ({
  id,
  role: 'assistant',
  content,
  ...(toolCalls ? { toolCalls } : {}),
});

describe('useChatPersistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAppendMessage.mockResolvedValue('row-id');
  });

  it('persists a user message immediately on appearance, even mid-stream', () => {
    renderPersistence({
      messages: [userMsg('u1', 'hello')],
      status: 'streaming',
      conversationId: 'conv-1',
    });

    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    expect(mockAppendMessage).toHaveBeenCalledWith(
      'conv-1',
      { role: 'user', content: 'hello' },
      'u1',
    );
  });

  it('does NOT persist an in-flight assistant message while streaming', () => {
    renderPersistence({
      messages: [userMsg('u1'), assistantMsg('a1', 'partial…')],
      status: 'streaming',
      conversationId: 'conv-1',
    });

    // Only the user message is persisted.
    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    expect(mockAppendMessage).toHaveBeenCalledWith(
      'conv-1',
      { role: 'user', content: 'hello' },
      'u1',
    );
  });

  it('persists the assistant message once status returns to idle', () => {
    const { rerender } = renderPersistence({
      messages: [userMsg('u1'), assistantMsg('a1', 'final answer')],
      status: 'streaming',
      conversationId: 'conv-1',
    });

    rerender({
      messages: [userMsg('u1'), assistantMsg('a1', 'final answer')],
      status: 'idle',
      conversationId: 'conv-1',
    });

    expect(mockAppendMessage).toHaveBeenCalledTimes(2);
    expect(mockAppendMessage).toHaveBeenLastCalledWith(
      'conv-1',
      { role: 'assistant', content: 'final answer', toolCalls: undefined },
      'a1',
    );
  });

  it('persists an assistant message when a newer message appears after it (still streaming)', () => {
    // Cloud continuation pass: first assistant turn is superseded by a
    // follow-up placeholder while status is still 'streaming'.
    renderPersistence({
      messages: [
        userMsg('u1'),
        assistantMsg('a1', 'first turn'),
        assistantMsg('a2', ''), // newer in-flight placeholder
      ],
      status: 'streaming',
      conversationId: 'conv-1',
    });

    const assistantCalls = mockAppendMessage.mock.calls.filter(
      ([, msg]) => (msg as { role: string }).role === 'assistant',
    );
    expect(assistantCalls).toHaveLength(1);
    expect(assistantCalls[0][1]).toEqual({
      role: 'assistant',
      content: 'first turn',
      toolCalls: undefined,
    });
  });

  it('never double-persists across re-renders (idempotent via ref Set)', () => {
    const messages = [userMsg('u1'), assistantMsg('a1', 'answer')];
    const { rerender } = renderPersistence({
      messages,
      status: 'idle',
      conversationId: 'conv-1',
    });

    // Same content re-rendered multiple times with fresh array identities.
    rerender({ messages: [...messages], status: 'idle', conversationId: 'conv-1' });
    rerender({ messages: [...messages], status: 'idle', conversationId: 'conv-1' });

    expect(mockAppendMessage).toHaveBeenCalledTimes(2); // one user + one assistant
  });

  it('serializes tool calls onto the persisted assistant message', () => {
    const toolCalls: ToolCallRecord[] = [
      {
        id: 'tc-1',
        name: 'saveExtractedFacts',
        input: { extracted_user_information: ['Lives in Berlin'] },
        result: { success: true, factsSaved: 1 },
        status: 'done',
      },
    ];

    renderPersistence({
      messages: [userMsg('u1'), assistantMsg('a1', 'Saved!', toolCalls)],
      status: 'idle',
      conversationId: 'conv-1',
    });

    expect(mockAppendMessage).toHaveBeenLastCalledWith(
      'conv-1',
      { role: 'assistant', content: 'Saved!', toolCalls },
      'a1',
    );
  });

  it('holds back an assistant message while any tool call is still pending, then persists with results', () => {
    const pending: ToolCallRecord[] = [
      { id: 'tc-1', name: 'saveExtractedFacts', input: {}, status: 'pending' },
    ];
    const { rerender } = renderPersistence({
      messages: [userMsg('u1'), assistantMsg('a1', 'Working…', pending)],
      status: 'idle',
      conversationId: 'conv-1',
    });

    expect(
      mockAppendMessage.mock.calls.filter(
        ([, msg]) => (msg as { role: string }).role === 'assistant',
      ),
    ).toHaveLength(0);

    const done: ToolCallRecord[] = [
      {
        id: 'tc-1',
        name: 'saveExtractedFacts',
        input: {},
        result: { success: true },
        status: 'done',
      },
    ];
    rerender({
      messages: [userMsg('u1'), assistantMsg('a1', 'Working…', done)],
      status: 'idle',
      conversationId: 'conv-1',
    });

    expect(mockAppendMessage).toHaveBeenLastCalledWith(
      'conv-1',
      { role: 'assistant', content: 'Working…', toolCalls: done },
      'a1',
    );
  });

  it('skips assistant messages with empty content and no tool calls', () => {
    const { rerender } = renderPersistence({
      messages: [userMsg('u1'), assistantMsg('a1', '   ')],
      status: 'idle',
      conversationId: 'conv-1',
    });

    // Re-render to prove the skip is permanent (id was claimed).
    rerender({
      messages: [userMsg('u1'), assistantMsg('a1', '   ')],
      status: 'idle',
      conversationId: 'conv-1',
    });

    const assistantCalls = mockAppendMessage.mock.calls.filter(
      ([, msg]) => (msg as { role: string }).role === 'assistant',
    );
    expect(assistantCalls).toHaveLength(0);
  });

  it('persists an empty-content assistant message that DID produce tool calls', () => {
    const toolCalls: ToolCallRecord[] = [
      {
        id: 'tc-1',
        name: 'updateUserConfig',
        input: { language: 'de' },
        result: { success: true },
        status: 'done',
      },
    ];
    renderPersistence({
      messages: [userMsg('u1'), assistantMsg('a1', '', toolCalls)],
      status: 'idle',
      conversationId: 'conv-1',
    });

    expect(mockAppendMessage).toHaveBeenLastCalledWith(
      'conv-1',
      { role: 'assistant', content: '', toolCalls },
      'a1',
    );
  });

  it('does nothing while conversationId is null, then persists once it arrives', () => {
    const { rerender } = renderPersistence({
      messages: [userMsg('u1')],
      status: 'idle',
      conversationId: null,
    });

    expect(mockAppendMessage).not.toHaveBeenCalled();

    rerender({ messages: [userMsg('u1')], status: 'idle', conversationId: 'conv-1' });

    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    expect(mockAppendMessage).toHaveBeenCalledWith(
      'conv-1',
      { role: 'user', content: 'hello' },
      'u1',
    );
  });

  it('does NOT re-persist ids seeded from a resumed conversation', () => {
    // Simulates a cloud-path popover reopen: the retained store messages are
    // already in the DB (their ids are in seedPersistedIds), so nothing should
    // be written again. A genuinely new message still persists.
    const { rerender } = renderPersistence({
      messages: [userMsg('u1'), assistantMsg('a1', 'answer')],
      status: 'idle',
      conversationId: 'conv-1',
      seedPersistedIds: ['u1', 'a1'],
    });

    expect(mockAppendMessage).not.toHaveBeenCalled();

    rerender({
      messages: [userMsg('u1'), assistantMsg('a1', 'answer'), userMsg('u2', 'new one')],
      status: 'idle',
      conversationId: 'conv-1',
      seedPersistedIds: ['u1', 'a1'],
    });

    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    expect(mockAppendMessage).toHaveBeenCalledWith(
      'conv-1',
      { role: 'user', content: 'new one' },
      'u2',
    );
  });

  it('logs and swallows persistence failures (fire-and-forget)', async () => {
    mockAppendMessage.mockRejectedValueOnce(new Error('db locked'));

    renderPersistence({
      messages: [userMsg('u1')],
      status: 'idle',
      conversationId: 'conv-1',
    });

    // Flush the rejected promise; nothing should throw.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const logger = jest.requireMock('../../logger').default;
    expect(logger.error).toHaveBeenCalled();
  });
});
