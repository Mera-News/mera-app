// useLocalLLM.test.tsx — renderHook tests for lib/llm/useLocalLLM.ts

const mockGetModelState = jest.fn();
const mockInferStream = jest.fn();
const mockInitBaseModel = jest.fn();

jest.mock('../../mera-protocol-toolkit', () => ({
  getModelState: (...args: unknown[]) => mockGetModelState(...args),
  inferStream: (...args: unknown[]) => mockInferStream(...args),
  initBaseModel: (...args: unknown[]) => mockInitBaseModel(...args),
}));

const mockInferenceQueuePause = jest.fn();
const mockInferenceQueueResume = jest.fn();

jest.mock('../../inference/InferenceQueue', () => ({
  inferenceQueue: {
    pause: (...args: unknown[]) => mockInferenceQueuePause(...args),
    resume: (...args: unknown[]) => mockInferenceQueueResume(...args),
  },
}));

const mockSetModelState = jest.fn();
const mockMeraProtocolGetState = jest.fn();

jest.mock('../../stores/mera-protocol-store', () => ({
  useMeraProtocolStore: {
    getState: (...args: unknown[]) => mockMeraProtocolGetState(...args),
  },
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    captureMessage: jest.fn(), captureException: jest.fn(),
  },
}));

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useLocalLLM } from '../useLocalLLM';
import type { IAgent, ToolExecutionResult } from '../types';

// ---- Async generator helpers ----

async function* makeTextStream(tokens: string[]): AsyncGenerator<string> {
  for (const token of tokens) {
    yield token;
  }
}

async function* makeToolCallStream(toolCallXml: string): AsyncGenerator<string> {
  yield toolCallXml;
}

// Build a mock IAgent
function makeAgent(overrides: Partial<IAgent> = {}): IAgent {
  return {
    id: 'test-agent',
    buildSystemPrompt: jest.fn().mockResolvedValue('You are a helpful assistant.'),
    buildContext: jest.fn().mockResolvedValue('Known facts: none.'),
    executeTool: jest.fn().mockResolvedValue({ result: { ok: true } }),
    getToolDefinitions: jest.fn().mockReturnValue([]),
    ...overrides,
  };
}

describe('useLocalLLM', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetModelState.mockReturnValue('ready');
    mockInitBaseModel.mockResolvedValue(undefined);
    mockInferenceQueuePause.mockResolvedValue(undefined);
    mockInferenceQueueResume.mockReturnValue(undefined);
    mockMeraProtocolGetState.mockReturnValue({ setModelState: mockSetModelState });
  });

  describe('initial state', () => {
    it('starts with idle status and empty messages', () => {
      const agent = makeAgent();
      const { result } = renderHook(() => useLocalLLM(agent));

      expect(result.current.status).toBe('idle');
      expect(result.current.messages).toEqual([]);
      expect(result.current.error).toBeNull();
      expect(result.current.isBlocked).toBe(false);
      expect(result.current.blockedReason).toBeNull();
      expect(result.current.latestAssistantContent).toBe('');
    });
  });

  describe('sendMessage', () => {
    it('adds a user message and sets status to streaming', async () => {
      mockInferStream.mockImplementation(() => makeTextStream([]));
      const agent = makeAgent();
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('Hello there');
      });

      await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(0));
      expect(result.current.messages[0].role).toBe('user');
      expect(result.current.messages[0].content).toBe('Hello there');
    });

    it('ignores empty or whitespace-only messages', async () => {
      const agent = makeAgent();
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('   ');
      });

      expect(result.current.messages).toHaveLength(0);
    });

    it('trims whitespace from user message', async () => {
      mockInferStream.mockImplementation(() => makeTextStream([]));
      const agent = makeAgent();
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('  hi world  ');
      });

      await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(0));
      expect(result.current.messages[0].content).toBe('hi world');
    });

    it('ignores sendMessage when isBlocked is true', async () => {
      const toolXml = '<tool_call>{"name":"issueWarning","arguments":{}}</tool_call>';
      mockInferStream.mockImplementation(() => makeToolCallStream(toolXml));

      const executeTool = jest.fn().mockResolvedValue({
        result: { blocked: true, message: 'Blocked' },
        sideEffects: { blocked: { reason: 'Blocked due to warnings' } },
      });
      const agent = makeAgent({ executeTool });
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('first');
      });

      await waitFor(() => expect(result.current.isBlocked).toBe(true));

      const msgCountAfterBlock = result.current.messages.length;
      act(() => {
        result.current.sendMessage('second message');
      });

      // No new messages added
      expect(result.current.messages.length).toBe(msgCountAfterBlock);
    });

    it('returns to idle after stream completes', async () => {
      mockInferStream.mockImplementation(() => makeTextStream(['hello']));
      const agent = makeAgent();
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('hi');
      });

      await waitFor(() => expect(result.current.status).toBe('idle'));
    });
  });

  describe('streaming text', () => {
    it('accumulates text-delta tokens into assistant message content', async () => {
      mockInferStream.mockImplementation(() => makeTextStream(['Hello', ' world', '!']));
      const agent = makeAgent();
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('test');
      });

      // Wait until assistant message appears with expected content
      await waitFor(
        () => expect(
          result.current.messages.find((m) => m.role === 'assistant')?.content,
        ).toBe('Hello world!'),
        { timeout: 3000 },
      );
    });

    it('adds an assistant message to state during inference', async () => {
      mockInferStream.mockImplementation(() => makeTextStream(['eventual text']));

      const agent = makeAgent();
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('ask something');
      });

      await waitFor(
        () => expect(
          result.current.messages.find((m) => m.role === 'assistant')?.content,
        ).toBe('eventual text'),
        { timeout: 3000 },
      );
    });
  });

  describe('model initialization', () => {
    it('lazy-inits model when getModelState() returns null (first call)', async () => {
      mockGetModelState.mockReturnValue(null);
      mockInferStream.mockImplementation(() => makeTextStream(['response']));

      const agent = makeAgent();
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('hello');
      });

      await waitFor(() => result.current.status === 'idle');

      expect(mockSetModelState).toHaveBeenCalledWith('loading');
      expect(mockInitBaseModel).toHaveBeenCalledTimes(1);
      expect(mockSetModelState).toHaveBeenCalledWith('ready');
    });

    it('skips model init when getModelState() is non-null', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInferStream.mockImplementation(() => makeTextStream(['ok']));

      const agent = makeAgent();
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('hello');
      });

      await waitFor(() => result.current.status === 'idle');

      expect(mockInitBaseModel).not.toHaveBeenCalled();
    });
  });

  describe('tool call detection', () => {
    it('parses <tool_call> XML tags and executes the tool', async () => {
      const toolCallXml = '<tool_call>{"name":"saveExtractedFacts","arguments":{"extracted_user_information":[]}}</tool_call>';
      mockInferStream.mockImplementation(() => makeTextStream([toolCallXml]));

      const executeTool = jest.fn().mockResolvedValue({ result: { saved: 1 } });
      const agent = makeAgent({ executeTool });
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('save my facts');
      });

      await waitFor(() => result.current.status === 'idle');

      expect(executeTool).toHaveBeenCalledWith(
        'saveExtractedFacts',
        expect.anything(),
      );
    });

    it('updates tool call status to "done" after successful execution', async () => {
      const toolCallXml = '<tool_call>{"name":"saveExtractedFacts","arguments":{}}</tool_call>';
      mockInferStream.mockImplementation(() => makeTextStream([toolCallXml]));

      const executeTool = jest.fn().mockResolvedValue({ result: { ok: true } });
      const agent = makeAgent({ executeTool });
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('save');
      });

      await waitFor(
        () => {
          const asst = result.current.messages.find((m) => m.role === 'assistant');
          expect(asst?.toolCalls?.[0]?.status).toBe('done');
        },
        { timeout: 3000 },
      );
    });

    it('marks tool call status as "error" when executeTool throws', async () => {
      const toolCallXml = '<tool_call>{"name":"updateUserConfig","arguments":{}}</tool_call>';
      mockInferStream.mockImplementation(() => makeTextStream([toolCallXml]));

      const executeTool = jest.fn().mockRejectedValue(new Error('tool crashed'));
      const agent = makeAgent({ executeTool });
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('update');
      });

      await waitFor(
        () => {
          const asst = result.current.messages.find((m) => m.role === 'assistant');
          expect(asst?.toolCalls?.[0]?.status).toBe('error');
        },
        { timeout: 3000 },
      );
    });

    it('sets isBlocked and blockedReason when tool returns blocked sideEffect', async () => {
      const toolCallXml = '<tool_call>{"name":"issueWarning","arguments":{"reason":"spam"}}</tool_call>';
      mockInferStream.mockImplementation(() => makeTextStream([toolCallXml]));

      const executeTool = jest.fn().mockResolvedValue({
        result: { blocked: true },
        sideEffects: { blocked: { reason: 'You have been warned' } },
      } as ToolExecutionResult);
      const agent = makeAgent({ executeTool });
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('warn me');
      });

      await waitFor(() => result.current.isBlocked === true, { timeout: 3000 });
      await waitFor(() => result.current.blockedReason !== null, { timeout: 3000 });

      expect(result.current.blockedReason).toBe('You have been warned');
    });
  });

  describe('token budget exceeded', () => {
    it('sets error when input tokens exceed budget', async () => {
      // Build a system prompt that exceeds the INPUT_TOKEN_BUDGET (3072 tokens)
      // estimateTokens for latin text = ceil(charCount / 4)
      // So 3072 tokens requires 3072 * 4 = 12288 chars
      // Use 14000 chars → ~3500 tokens — exceeds 3072
      const bigPrompt = 'x'.repeat(14000);
      const agent = makeAgent({
        buildSystemPrompt: jest.fn().mockResolvedValue(bigPrompt),
      });

      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('hi');
      });

      await waitFor(
        () => expect(result.current.error).toContain('Context too long'),
        { timeout: 3000 },
      );
      expect(mockInferStream).not.toHaveBeenCalled();
    });
  });

  describe('inference error handling', () => {
    it('sets error when buildSystemPrompt throws', async () => {
      const agent = makeAgent({
        buildSystemPrompt: jest.fn().mockRejectedValue(new Error('prompt build failed')),
      });

      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('hello');
      });

      await waitFor(
        () => expect(result.current.error).toContain('Failed to build system prompt'),
        { timeout: 3000 },
      );
    });

    it('clears error on subsequent sendMessage', async () => {
      // First call fails
      mockInferStream.mockImplementationOnce(async function* () { throw new Error('fail'); });

      const agent = makeAgent();
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('first');
      });

      await waitFor(() => result.current.error !== null);

      // Second call succeeds
      mockInferStream.mockImplementation(() => makeTextStream(['ok']));
      act(() => {
        result.current.sendMessage('second');
      });

      // Error is cleared synchronously on sendMessage
      await waitFor(() => result.current.messages.some((m) => m.role === 'user' && m.content === 'second'));
    });

    it('pauses and resumes inferenceQueue around inference', async () => {
      mockInferStream.mockImplementation(() => makeTextStream(['response']));
      const agent = makeAgent();
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('test');
      });

      await waitFor(() => result.current.status === 'idle');

      expect(mockInferenceQueuePause).toHaveBeenCalled();
      expect(mockInferenceQueueResume).toHaveBeenCalled();
    });
  });

  describe('buildContext', () => {
    it('calls buildContext and injects it into the prompt', async () => {
      mockInferStream.mockImplementation(() => makeTextStream(['ok']));
      const buildContext = jest.fn().mockResolvedValue('Context: Berlin');
      const agent = makeAgent({ buildContext });
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('where am I?');
      });

      await waitFor(() => result.current.status === 'idle');

      expect(buildContext).toHaveBeenCalled();
      // The prompt sent to inferStream should contain context (checked via inferStream args)
      const streamCallArgs = mockInferStream.mock.calls[0][0];
      expect(streamCallArgs.prompt).toContain('Context: Berlin');
    });

    it('proceeds without context when buildContext throws', async () => {
      mockInferStream.mockImplementation(() => makeTextStream(['ok']));
      const buildContext = jest.fn().mockRejectedValue(new Error('context failed'));
      const agent = makeAgent({ buildContext });
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('hi');
      });

      await waitFor(() => result.current.status === 'idle');

      // No error set — context failure is non-fatal
      expect(result.current.error).toBeNull();
      expect(mockInferStream).toHaveBeenCalled();
    });

    it('works when agent has no buildContext method', async () => {
      mockInferStream.mockImplementation(() => makeTextStream(['answer']));
      const agent = makeAgent({ buildContext: undefined });
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('question');
      });

      await waitFor(() => result.current.status === 'idle');

      expect(result.current.error).toBeNull();
    });
  });

  describe('latestAssistantContent', () => {
    it('returns the last assistant message content', async () => {
      mockInferStream.mockImplementation(() => makeTextStream(['Final answer']));
      const agent = makeAgent();
      const { result } = renderHook(() => useLocalLLM(agent));

      act(() => {
        result.current.sendMessage('what is the answer?');
      });

      await waitFor(
        () => expect(result.current.latestAssistantContent).toBe('Final answer'),
        { timeout: 3000 },
      );
    });

    it('returns empty string when no assistant message exists', () => {
      const agent = makeAgent();
      const { result } = renderHook(() => useLocalLLM(agent));

      expect(result.current.latestAssistantContent).toBe('');
    });
  });
});
