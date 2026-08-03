// useCloudPersonaChat.test.tsx — renderHook tests for lib/hooks/useCloudPersonaChat.ts

const mockCloudChatStream = jest.fn();

jest.mock('../../llm/cloudComplete', () => ({
  cloudChatStream: (...args: unknown[]) => mockCloudChatStream(...args),
}));

jest.mock('../../llm/constants', () => ({
  BIG_MODEL: 'test-big-model',
  CHAT_MAX_OUTPUT_TOKENS: 1024,
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

const SAVE_FACTS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'saveExtractedFacts',
    description: 'Save facts',
    parameters: { type: 'object', properties: {} },
  },
};

function makeAgent(overrides: Partial<IAgent> = {}): IAgent {
  return {
    id: 'test-cloud-agent',
    buildSystemPrompt: jest.fn().mockResolvedValue('You are an assistant.'),
    buildContext: jest.fn().mockResolvedValue('Context: some facts'),
    executeTool: jest.fn().mockResolvedValue({ result: { ok: true } }),
    getToolDefinitions: jest.fn().mockReturnValue([SAVE_FACTS_TOOL]),
    // Models PersonaUpdateAgent: the forced-extraction pass is OPT-IN and runs
    // only over tools whose empty-argument call is a harmless no-op. An agent
    // that omits this (e.g. ArticleFeedbackAgent) gets no forced pass at all.
    getForcedExtractionTools: jest.fn().mockReturnValue([SAVE_FACTS_TOOL]),
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

    it("first pass uses toolChoice 'auto'; a text-only reply triggers a background forced-extraction pass", async () => {
      // The first pass runs 'auto' for a fast single-round-trip reply. When the
      // model returns text with ZERO tool calls it skipped its mandatory
      // saveExtractedFacts call, so a background pass with toolChoice:'required'
      // fires to guarantee extraction (facts + topics are never silently dropped).
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Hi! How can I help?' },
          { type: 'finish', reason: 'stop' },
        ]),
      );

      const agent = makeAgent();
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('hello');
      });

      await waitFor(
        () => expect(mockCloudChatStream).toHaveBeenCalledTimes(2),
        { timeout: 3000 },
      );

      const [firstArg] = mockCloudChatStream.mock.calls[0] as [{ toolChoice?: string }];
      const [secondArg] = mockCloudChatStream.mock.calls[1] as [{ toolChoice?: string }];
      expect(firstArg.toolChoice).toBe('auto');
      expect(secondArg.toolChoice).toBe('required');
    });
  });

  describe('malformed tool arguments (P3)', () => {
    function streamMalformed() {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Removing that now.' },
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'tc-bad',
            name: 'deleteUserFacts',
            argumentsDelta: '{"fact_ids": ["location: resi', // truncated
          },
          { type: 'finish', reason: 'tool_calls' },
        ]),
      );
    }

    it('never executes a call whose arguments did not parse', async () => {
      streamMalformed();
      const agent = makeAgent({
        getForcedExtractionTools: jest.fn().mockReturnValue([]),
      });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('remove my location');
      });

      await waitFor(() => expect(result.current.status).toBe('idle'), { timeout: 3000 });
      // Previously this ran with `{}` — a destructive tool invoked with
      // arguments the model never actually sent.
      expect(agent.executeTool).not.toHaveBeenCalled();
    });

    it('surfaces it to the user as an errored tool call', async () => {
      streamMalformed();
      const agent = makeAgent({
        getForcedExtractionTools: jest.fn().mockReturnValue([]),
      });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('remove my location');
      });

      await waitFor(() => expect(result.current.status).toBe('idle'), { timeout: 3000 });
      const records = result.current.messages
        .flatMap((m) => m.toolCalls ?? [])
        .filter((tc) => tc.name === 'deleteUserFacts');
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe('error');
    });

    it('keeps it off the wire entirely, so no tool reply is owed', async () => {
      streamMalformed();
      const agent = makeAgent({
        getForcedExtractionTools: jest.fn().mockReturnValue([]),
      });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('remove my location');
      });

      await waitFor(() => expect(result.current.status).toBe('idle'), { timeout: 3000 });
      const wire = useCloudChatStore.getState().wireMessages;
      // Recording it would put `arguments: "{}"` on the wire — the same fiction
      // removed from execution. And with no tool_call there is no `tool` reply
      // owed, so the next request stays valid.
      expect(wire.some((m) => m.role === 'tool')).toBe(false);
      const assistant = wire.find((m) => m.role === 'assistant');
      expect(assistant && 'tool_calls' in assistant ? assistant.tool_calls : undefined)
        .toBeUndefined();
    });

    it('repairs a misspelled tool name against the live tool list', async () => {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Saved.' },
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'tc-typo',
            name: 'save_extracted_facts',
            argumentsDelta: JSON.stringify({
              extracted_user_information: [{ statement: 'Follows F1' }],
            }),
          },
          { type: 'finish', reason: 'tool_calls' },
        ]),
      );
      const agent = makeAgent();
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('I follow F1');
      });

      await waitFor(() => expect(agent.executeTool).toHaveBeenCalled(), { timeout: 3000 });
      expect(agent.executeTool).toHaveBeenCalledWith(
        'saveExtractedFacts',
        expect.anything(),
      );
    });
  });

  describe('history window (P1)', () => {
    /** Drives N complete text-only turns, then returns the messages array sent
     *  on the LAST cloudChatStream call. */
    async function wireSentAfterTurns(texts: string[]) {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'ok' },
          {
            type: 'tool-call-delta',
            index: 0,
            id: `tc-${Math.random()}`,
            name: 'saveExtractedFacts',
            argumentsDelta: JSON.stringify({
              extracted_user_information: [{ statement: 's' }],
            }),
          },
          { type: 'finish', reason: 'tool_calls' },
        ]),
      );
      const agent = makeAgent();
      const { result } = renderHook(() => useCloudPersonaChat(agent));
      for (const text of texts) {
        act(() => {
          result.current.sendMessage(text);
        });
        await waitFor(() => expect(result.current.status).toBe('idle'), { timeout: 3000 });
      }
      const calls = mockCloudChatStream.mock.calls;
      const [lastArg] = calls[calls.length - 1] as [
        { messages: { role: string; content?: string }[] },
      ];
      return lastArg.messages;
    }

    it('carries PRIOR turns, not just the current one', async () => {
      // The reported bug: [invitation, question, "Yes"] arrived as bare "Yes".
      const sent = await wireSentAfterTurns([
        'Recalibrate to close the gap.',
        'Yes',
      ]);
      const joined = sent.map((m) => m.content ?? '').join('\n');
      expect(joined).toContain('Recalibrate to close the gap.');
      expect(joined).toContain('Yes');
      // system + more than a lone user turn
      expect(sent.length).toBeGreaterThan(2);
    });

    it('still begins with system then a user turn', async () => {
      const sent = await wireSentAfterTurns(['one', 'two', 'three']);
      expect(sent[0].role).toBe('system');
      expect(sent[1].role).toBe('user');
    });

    it('caps the window at MAX_HISTORY_USER_TURNS user turns', async () => {
      const sent = await wireSentAfterTurns([
        't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8',
      ]);
      const userTurns = sent.filter((m) => m.role === 'user');
      expect(userTurns.length).toBeLessThanOrEqual(6);
      // The oldest turns fell out of the window; the newest is always present.
      const joined = userTurns.map((m) => m.content ?? '').join('\n');
      expect(joined).toContain('t8');
      expect(joined).not.toContain('t1');
    });

    it('injects <context> onto the LAST user message only', async () => {
      const sent = await wireSentAfterTurns(['first', 'second']);
      const withContext = sent.filter((m) =>
        (m.content ?? '').includes('Context: some facts'),
      );
      // Exactly one copy — a wider window must not accumulate N facts blocks.
      expect(withContext).toHaveLength(1);
      expect(withContext[0].content).toContain('second');
    });
  });

  describe('forced-extraction gate (P0)', () => {
    // The forced pass runs with tool_choice:'required', which OBLIGES the model
    // to emit >=1 call from whatever payload it is given — and the hook then
    // really executes it. These tests pin the gate that keeps that from
    // fabricating user consent.

    it('does NOT run for an agent that supplies no forced-extraction tools', async () => {
      // ArticleFeedbackAgent's shape: every tool it has stages or applies a
      // change, so a forced call would invent a proposal the user never asked
      // for. It returns [] and the pass must be skipped entirely.
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Here is why I suggested that.' },
          { type: 'finish', reason: 'stop' },
        ]),
      );

      const agent = makeAgent({
        getForcedExtractionTools: jest.fn().mockReturnValue([]),
      });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('why this article?');
      });

      await waitFor(() => expect(result.current.status).toBe('idle'), { timeout: 3000 });
      expect(mockCloudChatStream).toHaveBeenCalledTimes(1);
      expect(agent.executeTool).not.toHaveBeenCalled();
    });

    it('does NOT run for an agent that does not implement the method at all', async () => {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Sure thing.' },
          { type: 'finish', reason: 'stop' },
        ]),
      );

      const agent = makeAgent();
      delete (agent as Partial<IAgent>).getForcedExtractionTools;
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('thanks!');
      });

      await waitFor(() => expect(result.current.status).toBe('idle'), { timeout: 3000 });
      expect(mockCloudChatStream).toHaveBeenCalledTimes(1);
    });

    it('sends ONLY the forced-extraction tools on the required pass', async () => {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Noted!' },
          { type: 'finish', reason: 'stop' },
        ]),
      );

      const extraTool = {
        type: 'function' as const,
        function: {
          name: 'runCalibration',
          description: 'Recalibrate',
          parameters: { type: 'object', properties: {} },
        },
      };
      const agent = makeAgent({
        getToolDefinitions: jest.fn().mockReturnValue([SAVE_FACTS_TOOL, extraTool]),
        getForcedExtractionTools: jest.fn().mockReturnValue([SAVE_FACTS_TOOL]),
      });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('hello');
      });

      await waitFor(
        () => expect(mockCloudChatStream).toHaveBeenCalledTimes(2),
        { timeout: 3000 },
      );

      const [firstArg] = mockCloudChatStream.mock.calls[0] as [{ tools?: { function: { name: string } }[] }];
      const [secondArg] = mockCloudChatStream.mock.calls[1] as [{ tools?: { function: { name: string } }[] }];
      // First pass carries the full payload; the forced pass carries only the
      // safe subset — runCalibration takes no arguments, which makes it the
      // cheapest way for a model to satisfy 'required'.
      expect(firstArg.tools?.map((t) => t.function.name)).toEqual([
        'saveExtractedFacts',
        'runCalibration',
      ]);
      expect(secondArg.tools?.map((t) => t.function.name)).toEqual(['saveExtractedFacts']);
    });

    it('does not overwrite the visible reply with the forced pass\'s own text', async () => {
      // The forced pass targets the VISIBLE bubble so its tool calls render and
      // persist. Without text suppression its prose would replace, mid-turn,
      // the reply the user is already reading.
      let call = 0;
      mockCloudChatStream.mockImplementation(() => {
        call += 1;
        return call === 1
          ? makeSseStream([
              { type: 'text-delta', delta: 'Got it — anything else?' },
              { type: 'finish', reason: 'stop' },
            ])
          : makeSseStream([
              { type: 'text-delta', delta: 'THIS MUST NEVER BE SHOWN' },
              {
                type: 'tool-call-delta',
                index: 0,
                id: 'tc-forced',
                name: 'saveExtractedFacts',
                argumentsDelta: JSON.stringify({
                  extracted_user_information: [{ statement: 'Follows F1' }],
                }),
              },
              { type: 'finish', reason: 'tool_calls' },
            ]);
      });

      const agent = makeAgent();
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('I follow Formula 1');
      });

      await waitFor(
        () => expect(mockCloudChatStream).toHaveBeenCalledTimes(2),
        { timeout: 3000 },
      );
      await waitFor(() => expect(agent.executeTool).toHaveBeenCalled(), { timeout: 3000 });

      const assistant = result.current.messages.filter((m) => m.role === 'assistant');
      expect(assistant.every((m) => !m.content.includes('THIS MUST NEVER BE SHOWN'))).toBe(true);
      expect(result.current.latestAssistantContent).toBe('Got it — anything else?');
    });

    it('pushes nothing from the forced pass onto the wire', async () => {
      let call = 0;
      mockCloudChatStream.mockImplementation(() => {
        call += 1;
        return call === 1
          ? makeSseStream([
              { type: 'text-delta', delta: 'Noted.' },
              { type: 'finish', reason: 'stop' },
            ])
          : makeSseStream([
              { type: 'text-delta', delta: 'hidden prose' },
              { type: 'finish', reason: 'stop' },
            ]);
      });

      const agent = makeAgent();
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('hello');
      });

      await waitFor(
        () => expect(mockCloudChatStream).toHaveBeenCalledTimes(2),
        { timeout: 3000 },
      );

      // user + the single VISIBLE assistant turn. The forced pass contributes
      // nothing: its text was never shown, so putting it on the wire would make
      // history diverge from what the user actually read.
      const wire = useCloudChatStore.getState().wireMessages;
      expect(wire).toHaveLength(2);
      expect(wire[0].role).toBe('user');
      expect(wire[1]).toMatchObject({ role: 'assistant', content: 'Noted.' });
    });
  });

  describe('tool call handling', () => {
    it('an EMPTY saveExtractedFacts call still triggers the forced-extraction pass', async () => {
      // Regression, observed in production 2026-08-03 (a session running the
      // hedged fallback model): the model replies conversationally AND calls
      // saveExtractedFacts with an empty list. The call is well-formed, so the
      // zero-call check passed, executeTool saved nothing, and the user's fact
      // was silently dropped. An empty extraction must count as "extracted
      // nothing" and route to the same 'required' pass.
      const empty = JSON.stringify({ extracted_user_information: [] });
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Got it — noted!' },
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'tc-empty',
            name: 'saveExtractedFacts',
            argumentsDelta: empty,
          },
          { type: 'finish', reason: 'tool_calls' },
        ]),
      );

      const agent = makeAgent();
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('I follow Formula 1');
      });

      await waitFor(
        () => expect(mockCloudChatStream).toHaveBeenCalledTimes(2),
        { timeout: 3000 },
      );
      const [secondArg] = mockCloudChatStream.mock.calls[1] as [{ toolChoice?: string }];
      expect(secondArg.toolChoice).toBe('required');
    });

    it('a NON-empty saveExtractedFacts call does NOT trigger a second pass', async () => {
      const filled = JSON.stringify({
        extracted_user_information: [{ statement: 'Follows Formula 1' }],
      });
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Noted!' },
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'tc-real',
            name: 'saveExtractedFacts',
            argumentsDelta: filled,
          },
          { type: 'finish', reason: 'tool_calls' },
        ]),
      );

      const executeTool = jest.fn().mockResolvedValue({ result: { saved: 1 } });
      const agent = makeAgent({ executeTool });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('I follow Formula 1');
      });

      await waitFor(() => expect(executeTool).toHaveBeenCalled(), { timeout: 3000 });
      // Give a stray forced pass a chance to appear before asserting absence.
      await new Promise((r) => setTimeout(r, 50));
      expect(mockCloudChatStream).toHaveBeenCalledTimes(1);
    });

    it('a non-extraction tool call is substantive — no forced pass', async () => {
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Tracking that.' },
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'tc-track',
            name: 'proposeTrack',
            argumentsDelta: JSON.stringify({ topic: 'F1' }),
          },
          { type: 'finish', reason: 'tool_calls' },
        ]),
      );

      const executeTool = jest.fn().mockResolvedValue({ result: { ok: true } });
      const agent = makeAgent({ executeTool });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('track F1 for me');
      });

      await waitFor(() => expect(executeTool).toHaveBeenCalled(), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 50));
      expect(mockCloudChatStream).toHaveBeenCalledTimes(1);
    });


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

      // CHANGED (P3): a call whose arguments could not be parsed is no longer
      // executed with a substituted `{}`. Doing so made a dropped call look
      // like a successful no-op, and answered a SERIALIZATION failure with a
      // validation error about arguments the model never sent. It is now
      // surfaced as an errored tool call instead.
      expect(executeTool).not.toHaveBeenCalled();
      // With no text in the reply the continuation pass also runs — it is the
      // retry, and this mock returns the same malformed output — so there may
      // be more than one record. Every one of them must be an unexecuted error.
      const records = result.current.messages
        .flatMap((m) => m.toolCalls ?? [])
        .filter((tc) => tc.name === 'saveExtractedFacts');
      expect(records.length).toBeGreaterThanOrEqual(1);
      expect(records.every((tc) => tc.status === 'error')).toBe(true);
    });
  });

  describe('error handling', () => {
    // The cap was hardcoded at 300, which silently truncated Mera's narration
    // mid-sentence on any turn that also carried a tool call — the tool args fit,
    // the prose did not. Nothing surfaced it: the client collapses a `length`
    // finish_reason into `stop`, so a cut turn is indistinguishable from a
    // complete one. Pin the budget so a regression is loud.
    it('requests the shared chat output budget, not a smaller hardcoded cap', async () => {
      mockCloudChatStream.mockReturnValue(makeSseStream([
        { type: 'text-delta', delta: 'hi' },
        { type: 'finish' },
      ] as SseEvent[]));
      const agent = makeAgent();
      const { result } = renderHook(() => useCloudPersonaChat(agent));
      await act(async () => {
        await result.current.sendMessage('hello');
      });
      const call = mockCloudChatStream.mock.calls[0][0] as { maxTokens?: number };
      expect(call.maxTokens).toBe(1024);
    });

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
