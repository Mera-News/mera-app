// useCloudPersonaChat.test.tsx — renderHook tests for lib/hooks/useCloudPersonaChat.ts

const mockCloudChatStream = jest.fn();

jest.mock('../../llm/cloudComplete', () => ({
  cloudChatStream: (...args: unknown[]) => mockCloudChatStream(...args),
}));

jest.mock('../../llm/constants', () => ({
  BIG_MODEL: 'test-big-model',
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    captureMessage: jest.fn(), captureException: jest.fn(),
  },
}));

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useCloudPersonaChat } from '../../hooks/useCloudPersonaChat';
import { useCloudChatStore } from '../../stores/cloud-chat-store';
import type { IAgent, ToolExecutionResult } from '../../llm/types';
import type { SseEvent } from '../../llm/cloudComplete';

// ---- Helpers ----

async function* makeSseStream(events: SseEvent[]): AsyncGenerator<SseEvent> {
  for (const event of events) {
    yield event;
  }
}

function makeAgent(overrides: Partial<IAgent> = {}): IAgent {
  return {
    id: 'test-cloud-agent',
    buildSystemPrompt: jest.fn().mockResolvedValue('You are an assistant.'),
    buildContext: jest.fn().mockResolvedValue('Context: some facts'),
    executeTool: jest.fn().mockResolvedValue({ result: { ok: true } }),
    getToolDefinitions: jest.fn().mockReturnValue([
      {
        type: 'function',
        function: {
          name: 'saveFacts',
          description: 'Save facts',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]),
    ...overrides,
  };
}

describe('useCloudPersonaChat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the cloud chat store before each test
    useCloudChatStore.getState().reset();
  });

  describe('initial state', () => {
    it('starts with idle status and empty messages', () => {
      const agent = makeAgent();
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      expect(result.current.status).toBe('idle');
      expect(result.current.messages).toEqual([]);
      expect(result.current.error).toBeNull();
      expect(result.current.isBlocked).toBe(false);
      expect(result.current.blockedReason).toBeNull();
      expect(result.current.latestAssistantContent).toBe('');
    });
  });

  describe('sendMessage', () => {
    it('ignores empty and whitespace-only messages', () => {
      const agent = makeAgent();
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('   ');
      });

      expect(result.current.messages).toHaveLength(0);
    });

    it('adds a user message to the store', async () => {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([{ type: 'finish', reason: 'stop' }]),
      );

      const agent = makeAgent();
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('Hello cloud!');
      });

      await waitFor(
        () => expect(result.current.messages.some((m) => m.role === 'user')).toBe(true),
        { timeout: 3000 },
      );

      const userMsg = result.current.messages.find((m) => m.role === 'user');
      expect(userMsg?.content).toBe('Hello cloud!');
    });

    it('ignores sendMessage when isBlocked is true', async () => {
      // First: put the store in blocked state
      useCloudChatStore.getState().setIsBlocked(true);

      const agent = makeAgent();
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('try to send');
      });

      expect(result.current.messages).toHaveLength(0);
      expect(mockCloudChatStream).not.toHaveBeenCalled();
    });

    it('trims whitespace from user message', async () => {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([{ type: 'finish', reason: 'stop' }]),
      );

      const agent = makeAgent();
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('  hello world  ');
      });

      await waitFor(
        () => expect(result.current.messages.some((m) => m.role === 'user')).toBe(true),
        { timeout: 3000 },
      );

      const userMsg = result.current.messages.find((m) => m.role === 'user');
      expect(userMsg?.content).toBe('hello world');
    });
  });

  describe('streaming text', () => {
    it('accumulates text-delta events into assistant message content', async () => {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Hello' },
          { type: 'text-delta', delta: ' world' },
          { type: 'finish', reason: 'stop' },
        ]),
      );

      const agent = makeAgent({ getToolDefinitions: jest.fn().mockReturnValue([]) });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('Hi there');
      });

      await waitFor(
        () => {
          const asst = result.current.messages.find((m) => m.role === 'assistant');
          expect(asst?.content).toBe('Hello world');
        },
        { timeout: 3000 },
      );
    });

    it('strips Options:[...] prefix from latestAssistantContent', async () => {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Real text\nOptions: [A, B, C]\n' },
          { type: 'finish', reason: 'stop' },
        ]),
      );

      const agent = makeAgent({ getToolDefinitions: jest.fn().mockReturnValue([]) });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('show options');
      });

      await waitFor(
        () => expect(result.current.latestAssistantContent).toBeTruthy(),
        { timeout: 3000 },
      );

      // latestAssistantContent should strip the Options block
      expect(result.current.latestAssistantContent).not.toContain('Options:');
    });

    it('returns idle status after stream completes', async () => {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'response' },
          { type: 'finish', reason: 'stop' },
        ]),
      );

      const agent = makeAgent({ getToolDefinitions: jest.fn().mockReturnValue([]) });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('test');
      });

      await waitFor(
        () => expect(result.current.status).toBe('idle'),
        { timeout: 3000 },
      );
    });
  });

  describe('tool call handling', () => {
    it('accumulates tool-call-delta events and calls executeTool', async () => {
      const argsJson = JSON.stringify({ extracted_user_information: [] });
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'tc-1',
            name: 'saveExtractedFacts',
            argumentsDelta: argsJson,
          },
          { type: 'finish', reason: 'tool_calls' },
        ]),
      );

      const executeTool = jest.fn().mockResolvedValue({ result: { saved: 1 } });
      const agent = makeAgent({ executeTool });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('save my facts');
      });

      await waitFor(
        () => expect(executeTool).toHaveBeenCalled(),
        { timeout: 3000 },
      );

      expect(executeTool).toHaveBeenCalledWith('saveExtractedFacts', expect.anything());
    });

    it('sets isBlocked and blockedReason when tool returns blocked sideEffect', async () => {
      const argsJson = JSON.stringify({ reason: 'spam' });
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'tc-2',
            name: 'issueWarning',
            argumentsDelta: argsJson,
          },
          { type: 'finish', reason: 'tool_calls' },
        ]),
      );

      const executeTool = jest.fn().mockResolvedValue({
        result: { blocked: true },
        sideEffects: { blocked: { reason: 'You are blocked' } },
      } as ToolExecutionResult);
      const agent = makeAgent({ executeTool });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('warn me');
      });

      await waitFor(
        () => expect(result.current.isBlocked).toBe(true),
        { timeout: 3000 },
      );
      await waitFor(
        () => expect(result.current.blockedReason).toBe('You are blocked'),
        { timeout: 3000 },
      );
    });

    it('handles tool execution errors gracefully', async () => {
      const argsJson = '{}';
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'tc-3',
            name: 'updateUserConfig',
            argumentsDelta: argsJson,
          },
          { type: 'finish', reason: 'tool_calls' },
        ]),
      );

      const executeTool = jest.fn().mockRejectedValue(new Error('tool failed'));
      const agent = makeAgent({ executeTool });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('update config');
      });

      await waitFor(
        () => expect(result.current.status).toBe('idle'),
        { timeout: 3000 },
      );

      // Error from tool execution should NOT propagate to the hook's error state
      // (the tool error is logged but the chat continues)
      expect(result.current.error).toBeNull();
    });

    it('sends continuation turn when first response has tool calls but no text', async () => {
      let callCount = 0;
      mockCloudChatStream.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return makeSseStream([
            {
              type: 'tool-call-delta',
              index: 0,
              id: 'tc-4',
              name: 'saveExtractedFacts',
              argumentsDelta: '{}',
            },
            { type: 'finish', reason: 'tool_calls' },
          ]);
        }
        // Second call: text response
        return makeSseStream([
          { type: 'text-delta', delta: 'Done! I saved your facts.' },
          { type: 'finish', reason: 'stop' },
        ]);
      });

      const agent = makeAgent();
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('save facts');
      });

      await waitFor(
        () => {
          const msgs = result.current.messages.filter((m) => m.role === 'assistant');
          return msgs.some((m) => m.content === 'Done! I saved your facts.');
        },
        { timeout: 3000 },
      );

      // cloudChatStream was called twice (initial + continuation)
      expect(mockCloudChatStream).toHaveBeenCalledTimes(2);
    });

    it('handles malformed tool call arguments gracefully (invalid JSON)', async () => {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'tc-5',
            name: 'saveExtractedFacts',
            argumentsDelta: 'not-valid-json',
          },
          { type: 'finish', reason: 'tool_calls' },
        ]),
      );

      const executeTool = jest.fn().mockResolvedValue({ result: { ok: true } });
      const agent = makeAgent({ executeTool });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('save');
      });

      await waitFor(
        () => expect(result.current.status).toBe('idle'),
        { timeout: 3000 },
      );

      // executeTool is called even with empty input when args can't be parsed
      expect(executeTool).toHaveBeenCalledWith('saveExtractedFacts', {});
    });
  });

  describe('error handling', () => {
    it('sets error when cloudChatStream throws', async () => {
      mockCloudChatStream.mockImplementation(async function* () {
        throw new Error('SSE connection failed');
        yield { type: 'finish', reason: 'stop' } as SseEvent; // unreachable
      });

      const agent = makeAgent({ getToolDefinitions: jest.fn().mockReturnValue([]) });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('hello');
      });

      await waitFor(
        () => expect(result.current.error).toContain('Cloud chat failed'),
        { timeout: 3000 },
      );
    });

    it('sets error when stream emits error event', async () => {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'error', message: 'upstream inference error' },
        ]),
      );

      const agent = makeAgent({ getToolDefinitions: jest.fn().mockReturnValue([]) });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('hello');
      });

      await waitFor(
        () => expect(result.current.error).toContain('Cloud chat failed'),
        { timeout: 3000 },
      );
    });

    it('sets error when buildSystemPrompt throws', async () => {
      const agent = makeAgent({
        buildSystemPrompt: jest.fn().mockRejectedValue(new Error('prompt failed')),
      });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('hello');
      });

      await waitFor(
        () => expect(result.current.error).toContain('Cloud chat failed'),
        { timeout: 3000 },
      );
    });

    it('proceeds with empty context when buildContext throws', async () => {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'reply' },
          { type: 'finish', reason: 'stop' },
        ]),
      );

      const agent = makeAgent({
        buildContext: jest.fn().mockRejectedValue(new Error('context failed')),
        getToolDefinitions: jest.fn().mockReturnValue([]),
      });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('hello');
      });

      await waitFor(
        () => expect(result.current.status).toBe('idle'),
        { timeout: 3000 },
      );

      expect(result.current.error).toBeNull();
    });
  });

  describe('latestAssistantContent', () => {
    it('returns empty string when no assistant has non-empty content', () => {
      const agent = makeAgent();
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      expect(result.current.latestAssistantContent).toBe('');
    });

    it('skips empty assistant placeholders from tool-call rounds', async () => {
      // Simulate: first turn has empty text + tool call, second turn has real text
      let callCount = 0;
      mockCloudChatStream.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // No text, just tool call
          return makeSseStream([
            {
              type: 'tool-call-delta',
              index: 0,
              id: 'tc-6',
              name: 'saveExtractedFacts',
              argumentsDelta: '{}',
            },
            { type: 'finish', reason: 'tool_calls' },
          ]);
        }
        return makeSseStream([
          { type: 'text-delta', delta: 'Your fact was saved!' },
          { type: 'finish', reason: 'stop' },
        ]);
      });

      const agent = makeAgent();
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('save my fact');
      });

      await waitFor(
        () => expect(result.current.latestAssistantContent).toBe('Your fact was saved!'),
        { timeout: 3000 },
      );
    });
  });

  describe('buildContext injection', () => {
    it('calls buildContext and agent has getToolDefinitions when defined', async () => {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'answer' },
          { type: 'finish', reason: 'stop' },
        ]),
      );

      const buildContext = jest.fn().mockResolvedValue('my context');
      const getToolDefinitions = jest.fn().mockReturnValue([]);
      const agent = makeAgent({ buildContext, getToolDefinitions });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('question');
      });

      await waitFor(
        () => expect(result.current.status).toBe('idle'),
        { timeout: 3000 },
      );

      expect(buildContext).toHaveBeenCalled();
      expect(getToolDefinitions).toHaveBeenCalled();
    });

    it('works when agent has no buildContext method', async () => {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'no context answer' },
          { type: 'finish', reason: 'stop' },
        ]),
      );

      const agent = makeAgent({
        buildContext: undefined,
        getToolDefinitions: jest.fn().mockReturnValue([]),
      });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('hello');
      });

      await waitFor(
        () => expect(result.current.status).toBe('idle'),
        { timeout: 3000 },
      );

      expect(result.current.error).toBeNull();
    });

    it('works when agent has no getToolDefinitions method', async () => {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'answer without tools' },
          { type: 'finish', reason: 'stop' },
        ]),
      );

      const agent = makeAgent({ getToolDefinitions: undefined });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('hello');
      });

      await waitFor(
        () => expect(result.current.status).toBe('idle'),
        { timeout: 3000 },
      );

      expect(result.current.error).toBeNull();
    });
  });
});
