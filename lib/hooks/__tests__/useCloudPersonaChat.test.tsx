// useCloudPersonaChat.test.tsx — renderHook tests for lib/hooks/useCloudPersonaChat.ts

const mockCloudChatStream = jest.fn();

jest.mock('../../llm/cloudComplete', () => ({
  cloudChatStream: (...args: unknown[]) => mockCloudChatStream(...args),
}));

jest.mock('../../llm/constants', () => ({
  BIG_MODEL: 'test-big-model',
  CHAT_MAX_OUTPUT_TOKENS: 1024,
}));

// agent-device-port reaches fact-service -> lib/database/index, which builds a
// real SQLiteAdapter at module scope and kills the suite at load with
// `initializeJSI`. Mock the SERVICE MODULE at the boundary, not the adapter.
const mockRunAgentLoopDeps = jest.fn();
jest.mock('../../chat-tools/agent-device-port', () => ({
  isPersonaAgent: (id: string) => id.startsWith('persona-'),
  buildAgentPersona: jest.fn(async () => ({ facts: [], surface: 'CONFIG' })),
  makeAgentDeps: (...a: unknown[]) => mockRunAgentLoopDeps(...(a as [])),
  callModelViaCloud: jest.fn(),
  makeAgentToolPort: jest.fn(),
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
import { useChatPhaseStore, type ChatPhaseView } from '../../llm/chat-phase-store';
import type { IAgent, ToolExecutionResult } from '../../llm/types';
import type { SseEvent } from '../../llm/cloudComplete';
import { MERA_EXPLAINER_SECTIONS } from '../../chat-tools/mera-explainer-content';
import { MAX_FORMAT_RETRIES } from '../../mera-harness/core/core';

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
  // Every view the wait line was actually put through, in order. A test that
  // reads only the FINAL state cannot tell "went straight to thinking" from
  // "walked back to securing and then forward again", which is the whole
  // property the monotonic mark exists to give.
  let phaseViews: ChatPhaseView[] = [];
  let unsubscribePhase: (() => void) | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the cloud chat store before each test
    useCloudChatStore.getState().reset();
    useChatPhaseStore.getState().reset();
    phaseViews = [];
    unsubscribePhase = useChatPhaseStore.subscribe((st) => phaseViews.push(st.view));
  });

  afterEach(() => {
    unsubscribePhase?.();
    unsubscribePhase = null;
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
    it('publishes the opening phase SYNCHRONOUSLY on send, before any async work', async () => {
      // The gap this line exists to close is the first few hundred ms, which
      // are spent on buildSystemPrompt, getToolDefinitions and buildContext (a
      // DB read) before a single byte goes to the gateway. Publishing from
      // inside the async IIFE would leave exactly that window unnarrated.
      mockCloudChatStream.mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Hi' },
          { type: 'finish', reason: 'stop' },
        ]),
      );
      const agent = makeAgent({ getToolDefinitions: jest.fn().mockReturnValue([]) });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('Hi there');
      });

      // No await between the send and this read.
      expect(useChatPhaseStore.getState().view).toEqual({ kind: 'phase', id: 'preparing' });

      await waitFor(() => expect(result.current.status).toBe('idle'), { timeout: 3000 });
    });

    it('forwards a stream phase into the store, and never walks backwards', async () => {
      // FIRST CALL ONLY. A turn can legitimately make several calls (the
      // continuation pass, the forced pass, an agent leg) and each one is
      // SUPPOSED to re-walk its phases from `reset`, so a count taken across
      // the whole turn would be asserting the opposite of the design. The
      // monotonic guarantee is per call, so the test is too.
      let call = 0;
      mockCloudChatStream.mockImplementation((req: { onPhase?: (s: unknown) => void }) => {
        if (call++ === 0) {
          req.onPhase?.('reset');
          req.onPhase?.('securing');
          req.onPhase?.('thinking');
          // A late, lower-ranked signal. The mark must refuse it rather than
          // walk the reader back to "encrypting".
          req.onPhase?.('securing');
        }
        return makeSseStream([{ type: 'finish', reason: 'stop' }]);
      });
      const agent = makeAgent({ getToolDefinitions: jest.fn().mockReturnValue([]) });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('Hi there');
      });
      await waitFor(
        () => expect(useChatPhaseStore.getState().view).toEqual({ kind: 'released' }),
        { timeout: 3000 },
      );
      expect(phaseViews).toContainEqual({ kind: 'phase', id: 'thinking' });
      // `securing` was published twice and seen once: the second was refused.
      expect(phaseViews.filter((v) => v.kind === 'phase' && v.id === 'securing')).toHaveLength(1);
      // and it never reappeared after `thinking`.
      const lastSecuring = phaseViews.map((v) => (v.kind === 'phase' ? v.id : null)).lastIndexOf('securing');
      const firstThinking = phaseViews.map((v) => (v.kind === 'phase' ? v.id : null)).indexOf('thinking');
      expect(lastSecuring).toBeLessThan(firstThinking);
    });

    it('hands the line over when the first text is RENDERED, and leaves it released', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const seen: string[] = [];
      mockCloudChatStream.mockImplementation(async function* () {
        yield { type: 'reasoning' } as SseEvent;
        await gate;
        seen.push(useChatPhaseStore.getState().view.kind);
        yield { type: 'text-delta', delta: 'Hello' } as SseEvent;
        seen.push(useChatPhaseStore.getState().view.kind);
        yield { type: 'finish', reason: 'stop' } as SseEvent;
      });

      const agent = makeAgent({ getToolDefinitions: jest.fn().mockReturnValue([]) });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('Hi there');
      });
      await waitFor(
        () => expect(useChatPhaseStore.getState().view).toEqual({ kind: 'phase', id: 'preparing' }),
        { timeout: 3000 },
      );
      release();

      await waitFor(
        () => {
          const asst = result.current.messages.find((m) => m.role === 'assistant');
          expect(asst?.content).toBe('Hello');
        },
        { timeout: 3000 },
      );
      // A phase while the wait ran, and STILL a phase right after the delta
      // arrives: the handover waits for the render that shows the text, so the
      // wait row never empties a frame before the reply takes its slot
      // (ux1 C2). The generator runs a SECOND time for the hidden
      // forced-extraction pass, which must never re-narrate: every later
      // sample is released.
      expect(seen.slice(0, 2)).toEqual(['phase', 'phase']);
      expect(seen.slice(2).every((v) => v === 'released')).toBe(true);
      await waitFor(() => expect(result.current.status).toBe('idle'), { timeout: 3000 });
      expect(useChatPhaseStore.getState().view).toEqual({ kind: 'released' });
    });

    it('releases the line when the turn throws, so nothing reassures under the error banner', async () => {
      // The 429 shape. `RateLimitedError` is flattened to a string long before
      // the UI sees it, so the banner is generic and the ONLY thing that can
      // stop the line is this release running on the throw path.
      mockCloudChatStream.mockImplementation(() => {
        throw new Error('E2EE chat failed: 429');
      });
      const agent = makeAgent({ getToolDefinitions: jest.fn().mockReturnValue([]) });
      const { result } = renderHook(() => useCloudPersonaChat(agent));

      act(() => {
        result.current.sendMessage('Hi there');
      });
      await waitFor(() => expect(result.current.status).toBe('idle'), { timeout: 3000 });
      expect(useCloudChatStore.getState().error).toContain('429');
      expect(useChatPhaseStore.getState().view).toEqual({ kind: 'released' });
    });

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
      // Dash-cleaned once the stream is whole: the single-shot path shipped
      // model em dashes to users before ux1.
      expect(result.current.latestAssistantContent).toBe('Got it, anything else?');
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

// ---------------------------------------------------------------------------
// Knowledge tools (explainMera)
//
// A knowledge tool returns REFERENCE TEXT that only matters if the model reads
// it back. Three turn-loop rules exist for it, and without them the tool
// silently does nothing:
//
//  (i)   a turn that called one must run the continuation pass EVEN THOUGH it
//        produced text — otherwise the result is pushed to the wire and never
//        read, and the model answers from memory;
//  (ii)  calling one is NOT extraction, so it must not flip `extractedSomething`
//        and disable the forced-extraction safety net for that turn;
//  (iii) (i) and (ii) can now both be owed by one turn. They must be EXCLUSIVE
//        AND ORDERED — two streams in flight would interleave pushWireMessage /
//        pushAssistantToWire against the same store.
// ---------------------------------------------------------------------------

describe('useCloudPersonaChat — knowledge tools', () => {
  const EXPLAIN_TOOL = {
    type: 'function' as const,
    function: {
      name: 'explainMera',
      description: 'Return Mera reference documentation',
      parameters: { type: 'object', properties: {} },
    },
  };

  /** Agent carrying BOTH tools — explainMera must be in getToolDefinitions() so
   *  detection goes through normalizeToolName against the live list, exactly as
   *  production does, rather than through the raw-name fallback. */
  function makeKnowledgeAgent(overrides: Partial<IAgent> = {}): IAgent {
    return makeAgent({
      getToolDefinitions: jest.fn().mockReturnValue([SAVE_FACTS_TOOL, EXPLAIN_TOOL]),
      getForcedExtractionTools: jest.fn().mockReturnValue([SAVE_FACTS_TOOL]),
      ...overrides,
    });
  }

  function knowledgeCallStream(text: string, name = 'explainMera'): SseEvent[] {
    return [
      ...(text ? [{ type: 'text-delta' as const, delta: text }] : []),
      {
        type: 'tool-call-delta' as const,
        index: 0,
        id: 'tc-explain',
        name,
        argumentsDelta: JSON.stringify({ topics: ['privacy_what_leaves_device'] }),
      },
      { type: 'finish' as const, reason: 'tool_calls' as const },
    ];
  }

  beforeEach(() => {
    jest.clearAllMocks();
    useCloudChatStore.getState().reset();
  });

  it('runs EXACTLY ONE continuation and NO concurrent forced pass', async () => {
    // The race case: knowledge call + text + nothing extracted satisfies both
    // branches. Exactly two streams may run, in order — the continuation, then
    // nothing else, because the continuation extracted for us.
    mockCloudChatStream
      .mockImplementationOnce(() =>
        makeSseStream(knowledgeCallStream('One moment.')),
      )
      .mockImplementationOnce(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Your facts never leave the device.' },
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'tc-save',
            name: 'saveExtractedFacts',
            argumentsDelta: JSON.stringify({
              extracted_user_information: [{ statement: 'Cares about privacy' }],
            }),
          },
          { type: 'finish', reason: 'tool_calls' },
        ]),
      )
      .mockImplementation(() => makeSseStream([{ type: 'finish', reason: 'stop' }]));

    const agent = makeKnowledgeAgent();
    const { result } = renderHook(() => useCloudPersonaChat(agent));

    act(() => {
      result.current.sendMessage('how do you handle my data?');
    });

    await waitFor(() => expect(result.current.status).toBe('idle'), { timeout: 3000 });
    // Let any stray un-awaited pass appear before asserting absence.
    await new Promise((r) => setTimeout(r, 80));

    expect(mockCloudChatStream).toHaveBeenCalledTimes(2);
    // Both passes were 'auto'. A concurrent forced pass would show as 'required'.
    const choices = mockCloudChatStream.mock.calls.map(
      (c) => (c[0] as { toolChoice?: string }).toolChoice,
    );
    expect(choices).toEqual(['auto', 'auto']);
  });

  it('reads the tool result back: the continuation carries a role:"tool" message', async () => {
    mockCloudChatStream
      .mockImplementationOnce(() => makeSseStream(knowledgeCallStream('Let me check.')))
      .mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Here is the sourced answer.' },
          { type: 'finish', reason: 'stop' },
        ]),
      );

    const executeTool = jest
      .fn()
      .mockResolvedValue({ result: { sections: [{ topic: 'privacy_what_leaves_device', text: 'x' }] } });
    const agent = makeKnowledgeAgent({ executeTool });
    const { result } = renderHook(() => useCloudPersonaChat(agent));

    act(() => {
      result.current.sendMessage('how do you handle my data?');
    });

    await waitFor(
      () => expect(mockCloudChatStream.mock.calls.length).toBeGreaterThanOrEqual(2),
      { timeout: 3000 },
    );

    const [secondArg] = mockCloudChatStream.mock.calls[1] as [
      { messages: { role: string; content?: string }[] },
    ];
    const toolMsg = secondArg.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.content).toContain('privacy_what_leaves_device');
    // The answer lands in a SECOND bubble, after the holding line.
    const bubbles = result.current.messages.filter((m) => m.role === 'assistant');
    expect(bubbles.map((b) => b.content)).toEqual([
      'Let me check.',
      'Here is the sourced answer.',
    ]);
  });

  it('detects a knowledge call through a misspelled name', async () => {
    mockCloudChatStream
      .mockImplementationOnce(() => makeSseStream(knowledgeCallStream('Sure.', 'explain_mera')))
      .mockImplementation(() =>
        makeSseStream([{ type: 'text-delta', delta: 'Answer.' }, { type: 'finish', reason: 'stop' }]),
      );

    const agent = makeKnowledgeAgent();
    const { result } = renderHook(() => useCloudPersonaChat(agent));

    act(() => {
      result.current.sendMessage('how does that work?');
    });

    await waitFor(
      () => expect(mockCloudChatStream.mock.calls.length).toBeGreaterThanOrEqual(2),
      { timeout: 3000 },
    );
    // Repaired against the live tool list before dispatch — a raw-name fallback
    // would have executed (and reported) `explain_mera`.
    expect(agent.executeTool).toHaveBeenCalledWith('explainMera', expect.anything());
  });

  it('does NOT let a bare knowledge call disable the forced-extraction net', async () => {
    // (ii): the continuation extracts nothing either, so the safety net must
    // still fire — AFTER the continuation, never alongside it.
    mockCloudChatStream
      .mockImplementationOnce(() => makeSseStream(knowledgeCallStream('One sec.')))
      .mockImplementationOnce(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Sourced answer, no facts extracted.' },
          { type: 'finish', reason: 'stop' },
        ]),
      )
      .mockImplementation(() =>
        makeSseStream([
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'tc-forced',
            name: 'saveExtractedFacts',
            argumentsDelta: JSON.stringify({
              extracted_user_information: [{ statement: 'Lives in Porto' }],
            }),
          },
          { type: 'finish', reason: 'tool_calls' },
        ]),
      );

    const agent = makeKnowledgeAgent();
    const { result } = renderHook(() => useCloudPersonaChat(agent));

    act(() => {
      result.current.sendMessage('I live in Porto — how do you handle my data?');
    });

    await waitFor(() => expect(mockCloudChatStream).toHaveBeenCalledTimes(3), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 80));

    const choices = mockCloudChatStream.mock.calls.map(
      (c) => (c[0] as { toolChoice?: string }).toolChoice,
    );
    // Ordered: first pass, continuation, THEN the forced pass. Never 3 before 2.
    expect(choices).toEqual(['auto', 'auto', 'required']);
    expect(mockCloudChatStream).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Knowledge tools — the two edges that only bite in production
// ---------------------------------------------------------------------------

describe('useCloudPersonaChat — knowledge tools, hard cases', () => {
  const EXPLAIN_TOOL = {
    type: 'function' as const,
    function: {
      name: 'explainMera',
      description: 'Return Mera reference documentation',
      parameters: { type: 'object', properties: {} },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    useCloudChatStore.getState().reset();
  });

  it('a MALFORMED knowledge call still leaves the forced-extraction net armed', async () => {
    // The other door onto the same silent fact loss: a truncated explainMera
    // call is not extraction, so `extractedSomething` must stay false — while
    // the continuation must NOT run, because a malformed call never reached the
    // wire and there is no result to read back.
    mockCloudChatStream
      .mockImplementationOnce(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'One moment.' },
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'tc-broken',
            name: 'explainMera',
            argumentsDelta: '{"topics": ["privacy_wha',
          },
          { type: 'finish', reason: 'tool_calls' },
        ]),
      )
      .mockImplementation(() => makeSseStream([{ type: 'finish', reason: 'stop' }]));

    const agent = makeAgent({
      getToolDefinitions: jest.fn().mockReturnValue([SAVE_FACTS_TOOL, EXPLAIN_TOOL]),
      getForcedExtractionTools: jest.fn().mockReturnValue([SAVE_FACTS_TOOL]),
    });
    const { result } = renderHook(() => useCloudPersonaChat(agent));

    act(() => {
      result.current.sendMessage('I live in Porto — how do you handle my data?');
    });

    await waitFor(() => expect(mockCloudChatStream).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 80));

    const choices = mockCloudChatStream.mock.calls.map(
      (c) => (c[0] as { toolChoice?: string }).toolChoice,
    );
    // Exactly two passes: the first, then the FORCED one. No continuation.
    expect(choices).toEqual(['auto', 'required']);
  });

  it('keeps the assistant(tool_calls)/tool pair adjacent at REALISTIC result size', async () => {
    // The stub-sized result in the tests above cannot exercise this: a real
    // 3-section answer is the single largest entry the CLOUD history budget
    // ever carries. selectHistoryWindow must still start the window on a `user`
    // turn and never split the assistant(tool_calls) → tool pair — a split pair
    // is a hard 400 from the gateway and a dead chat.
    const bigResult = {
      sections: (
        ['what_is_mera', 'privacy_what_we_store', 'known_gaps'] as const
      ).map((topic) => ({ topic, text: MERA_EXPLAINER_SECTIONS[topic] })),
    };

    mockCloudChatStream
      .mockImplementationOnce(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Let me pull that up.' },
          {
            type: 'tool-call-delta',
            index: 0,
            id: 'tc-explain-big',
            name: 'explainMera',
            argumentsDelta: JSON.stringify({
              topics: ['what_is_mera', 'privacy_what_we_store', 'known_gaps'],
            }),
          },
          { type: 'finish', reason: 'tool_calls' },
        ]),
      )
      .mockImplementation(() =>
        makeSseStream([
          { type: 'text-delta', delta: 'Full sourced answer.' },
          { type: 'finish', reason: 'stop' },
        ]),
      );

    const agent = makeAgent({
      getToolDefinitions: jest.fn().mockReturnValue([SAVE_FACTS_TOOL, EXPLAIN_TOOL]),
      getForcedExtractionTools: jest.fn().mockReturnValue([SAVE_FACTS_TOOL]),
      executeTool: jest.fn().mockResolvedValue({ result: bigResult }),
    });
    const { result } = renderHook(() => useCloudPersonaChat(agent));

    act(() => {
      result.current.sendMessage('how do you handle my data?');
    });

    await waitFor(
      () => expect(mockCloudChatStream.mock.calls.length).toBeGreaterThanOrEqual(2),
      { timeout: 3000 },
    );

    const [secondArg] = mockCloudChatStream.mock.calls[1] as [
      { messages: { role: string; tool_calls?: unknown }[] },
    ];
    const roles = secondArg.messages.map((m) => m.role);
    expect(roles[0]).toBe('system');
    // Invariant 1: the window opens on a user turn.
    expect(roles[1]).toBe('user');
    // Invariant 2: the pair is intact and adjacent.
    const toolIdx = roles.lastIndexOf('tool');
    expect(toolIdx).toBeGreaterThan(0);
    expect(roles[toolIdx - 1]).toBe('assistant');
    expect(secondArg.messages[toolIdx - 1].tool_calls).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Per-promise tool-result write-back (pagent P1)
//
// Three properties, each of which FAILED on the previous implementation
// (`await Promise.all(...)` -> in-place mutation -> one setMessages):
//   (a) a slower sibling does not hide a finished call: the staggered
//       "1 done, 1 pending" state must be observable;
//   (b) a settled record is a NEW object, so a row memoized on its own
//       `toolCall` prop sees its own status change;
//   (c) the result lands at the CALL's index, never completion order --
//       card identity is keyed `${messageId}::${toolCallIndex}`.
// ---------------------------------------------------------------------------
describe('per-promise tool-result write-back', () => {
  // This describe is a SIBLING of the main one, so it does NOT inherit its
  // beforeEach. Without this the wire accumulated across tests and the
  // per-index assertions below read another test's messages.
  beforeEach(() => {
    jest.clearAllMocks();
    useCloudChatStore.getState().reset();
  });

  const TWO_CALL_STREAM: SseEvent[] = [
    { type: 'tool-call-delta', index: 0, id: 'tc-a', name: 'toolA', argumentsDelta: '{}' },
    { type: 'tool-call-delta', index: 1, id: 'tc-b', name: 'toolB', argumentsDelta: '{}' },
    { type: 'text-delta', delta: 'working on it' },
  ];

  const TWO_TOOLS = ['toolA', 'toolB'].map((name) => ({
    type: 'function' as const,
    function: { name, description: name, parameters: { type: 'object' as const, properties: {} } },
  }));

  /** Resolvers keyed by tool name, so a test controls the settle ORDER. */
  function makeDeferredAgent() {
    const resolvers: Record<string, (r: ToolExecutionResult) => void> = {};
    const agent = makeAgent({
      getToolDefinitions: jest.fn().mockReturnValue(TWO_TOOLS),
      getForcedExtractionTools: jest.fn().mockReturnValue([]),
      executeTool: jest.fn(
        (name: string) =>
          new Promise<ToolExecutionResult>((resolve) => {
            resolvers[name] = resolve;
          }),
      ),
    });
    return { agent, resolvers };
  }

  function currentToolCalls() {
    const msgs = useCloudChatStore.getState().messages;
    const withCalls = [...msgs].reverse().find((m) => m.toolCalls && m.toolCalls.length > 0);
    return withCalls?.toolCalls ?? [];
  }

  it('(a) shows a staggered done/pending state instead of flipping both at once', async () => {
    mockCloudChatStream.mockReturnValue(makeSseStream(TWO_CALL_STREAM));
    const { agent, resolvers } = makeDeferredAgent();
    const { result } = renderHook(() => useCloudPersonaChat(agent));

    act(() => { result.current.sendMessage('hello'); });
    await waitFor(() => expect(Object.keys(resolvers)).toHaveLength(2), { timeout: 3000 });

    // Settle ONLY the first call. The second is still in flight.
    await act(async () => { resolvers.toolA({ result: { ok: 'a' } }); });

    await waitFor(() => expect(currentToolCalls()[0]?.status).toBe('done'), { timeout: 3000 });
    const mid = currentToolCalls();
    expect(mid.map((r) => r.status)).toEqual(['done', 'pending']);

    await act(async () => { resolvers.toolB({ result: { ok: 'b' } }); });
    await waitFor(
      () => expect(currentToolCalls().map((r) => r.status)).toEqual(['done', 'done']),
      { timeout: 3000 },
    );
  });

  it('(b) replaces the settled record with a NEW object, leaving siblings identical', async () => {
    mockCloudChatStream.mockReturnValue(makeSseStream(TWO_CALL_STREAM));
    const { agent, resolvers } = makeDeferredAgent();
    const { result } = renderHook(() => useCloudPersonaChat(agent));

    act(() => { result.current.sendMessage('hello'); });
    await waitFor(() => expect(Object.keys(resolvers)).toHaveLength(2), { timeout: 3000 });

    const before = currentToolCalls();
    expect(before).toHaveLength(2);

    await act(async () => { resolvers.toolA({ result: { ok: 'a' } }); });
    await waitFor(() => expect(currentToolCalls()[0]?.status).toBe('done'), { timeout: 3000 });
    const after = currentToolCalls();

    // The settled slot is a different object -- this is what an in-place
    // mutation would break while every status assertion still passed.
    expect(after[0]).not.toBe(before[0]);
    // ...and the untouched sibling keeps its identity, so it does not re-render.
    expect(after[1]).toBe(before[1]);

    await act(async () => { resolvers.toolB({ result: { ok: 'b' } }); });
  });

  it('(c) writes a result at the CALL index even when the second call settles first', async () => {
    mockCloudChatStream.mockReturnValue(makeSseStream(TWO_CALL_STREAM));
    const { agent, resolvers } = makeDeferredAgent();
    const { result } = renderHook(() => useCloudPersonaChat(agent));

    act(() => { result.current.sendMessage('hello'); });
    await waitFor(() => expect(Object.keys(resolvers)).toHaveLength(2), { timeout: 3000 });

    // Reverse order: toolB (index 1) finishes FIRST.
    await act(async () => { resolvers.toolB({ result: { who: 'b' } }); });
    await waitFor(() => expect(currentToolCalls()[1]?.status).toBe('done'), { timeout: 3000 });

    // Completion order would have put b's result at index 0.
    expect(currentToolCalls()[0]?.status).toBe('pending');
    expect(currentToolCalls()[1]?.result).toEqual({ who: 'b' });

    await act(async () => { resolvers.toolA({ result: { who: 'a' } }); });
    await waitFor(() => expect(currentToolCalls()[0]?.status).toBe('done'), { timeout: 3000 });

    const final = currentToolCalls();
    expect(final[0].name).toBe('toolA');
    expect(final[0].result).toEqual({ who: 'a' });
    expect(final[1].name).toBe('toolB');
    expect(final[1].result).toEqual({ who: 'b' });
  });

  it('pushes each tool result onto the wire at its own index, after all settle', async () => {
    mockCloudChatStream.mockReturnValue(makeSseStream(TWO_CALL_STREAM));
    const { agent, resolvers } = makeDeferredAgent();
    const { result } = renderHook(() => useCloudPersonaChat(agent));

    act(() => { result.current.sendMessage('hello'); });
    await waitFor(() => expect(Object.keys(resolvers)).toHaveLength(2), { timeout: 3000 });

    await act(async () => { resolvers.toolB({ result: { who: 'b' } }); });
    await act(async () => { resolvers.toolA({ result: { who: 'a' } }); });

    await waitFor(() => {
      const toolMsgs = useCloudChatStore
        .getState()
        .wireMessages.filter((m) => m.role === 'tool');
      expect(toolMsgs).toHaveLength(2);
    }, { timeout: 3000 });

    const toolMsgs = useCloudChatStore
      .getState()
      .wireMessages.filter((m) => m.role === 'tool') as { tool_call_id: string; content: string }[];
    // Wire order follows CALL order, not settle order, and each id carries its
    // own result.
    expect(toolMsgs[0].tool_call_id).toBe('tc-a');
    expect(JSON.parse(toolMsgs[0].content)).toEqual({ who: 'a' });
    expect(toolMsgs[1].tool_call_id).toBe('tc-b');
    expect(JSON.parse(toolMsgs[1].content)).toEqual({ who: 'b' });
  });
});

// ---------------------------------------------------------------------------
// turnActive (pagent P1)
//
// Must be true across every leg AND every gap between them -- tool execution,
// and the fire-and-forget forced pass -- and false only at turn end or
// transport failure. That is turnBusyRef's lifetime, and NOT `status`'s:
// startForcedExtraction dispatches with `void`, so the forced pass outlives
// startTurn's finally and `status` reads idle while real work is in flight.
// The UI keys its interruption state on this, so a flag that goes false early
// renders a live turn as interrupted.
// ---------------------------------------------------------------------------
describe('turnActive', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useCloudChatStore.getState().reset();
  });

  const turnActive = () => useCloudChatStore.getState().agentTurnState?.turnActive ?? false;

  /** Every TRANSITION the flag makes, in order.
   *
   *  Seeded with the current value, because `subscribe` fires on every store
   *  write and the first unrelated one would otherwise record the starting
   *  `false` as a transition. */
  function trackTurnActive(): boolean[] {
    let last = turnActive();
    const seen: boolean[] = [];
    useCloudChatStore.subscribe((s) => {
      const v = s.agentTurnState?.turnActive ?? false;
      if (v !== last) {
        last = v;
        seen.push(v);
      }
    });
    return seen;
  }

  it('toggles exactly ONCE per plain turn and ends false', async () => {
    mockCloudChatStream.mockReturnValue(makeSseStream([{ type: 'text-delta', delta: 'hello' }]));
    const agent = makeAgent({
      getToolDefinitions: jest.fn().mockReturnValue([]),
      getForcedExtractionTools: jest.fn().mockReturnValue([]),
    });
    const { result } = renderHook(() => useCloudPersonaChat(agent));
    const seen = trackTurnActive();

    await act(async () => { result.current.sendMessage('hi'); });
    await waitFor(() => expect(turnActive()).toBe(false), { timeout: 3000 });

    // ONE rise and ONE fall, no flicker in between.
    expect(seen).toEqual([true, false]);
  });

  it('STAYS true across the fire-and-forget forced pass, after status goes idle', async () => {
    // The turn returns prose and no tool call, so the forced pass fires. This
    // is the case where `status` is already 'idle' while work continues.
    let releaseTool: (() => void) | null = null;
    mockCloudChatStream
      .mockReturnValueOnce(makeSseStream([{ type: 'text-delta', delta: 'I live in Alkmaar' }]))
      .mockReturnValueOnce(
        makeSseStream([
          { type: 'tool-call-delta', index: 0, id: 'tc-1', name: 'saveExtractedFacts', argumentsDelta: '{}' },
        ]),
      );
    const agent = makeAgent({
      executeTool: jest.fn(
        () => new Promise((resolve) => { releaseTool = () => resolve({ result: { ok: true } }); }),
      ),
    });
    const { result } = renderHook(() => useCloudPersonaChat(agent));
    const seen = trackTurnActive();

    await act(async () => { result.current.sendMessage('I live in Alkmaar'); });
    await waitFor(() => expect(releaseTool).not.toBeNull(), { timeout: 3000 });

    // status has settled, the forced pass has NOT.
    expect(useCloudChatStore.getState().status).toBe('idle');
    expect(turnActive()).toBe(true);

    await act(async () => { releaseTool!(); });
    await waitFor(() => expect(turnActive()).toBe(false), { timeout: 3000 });

    // Still exactly one rise and one fall across the whole turn.
    expect(seen).toEqual([true, false]);
  });

  it('goes false on a TRANSPORT FAILURE rather than staying armed', async () => {
    mockCloudChatStream.mockImplementation(() => {
      throw new Error('E2EE chat failed: 502');
    });
    const agent = makeAgent({ getToolDefinitions: jest.fn().mockReturnValue([]) });
    const { result } = renderHook(() => useCloudPersonaChat(agent));

    await act(async () => { result.current.sendMessage('hi'); });
    await waitFor(() => expect(useCloudChatStore.getState().error).toBeTruthy(), { timeout: 3000 });
    expect(turnActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE SHIPPED PATH runs the agent loop (pagent P1)
//
// This is the test whose absence let the device pass find the OLD single-shot
// prompt still live: runAgentTurn existed, was fully unit-tested, and had zero
// callers outside lib/mera-harness. Every other test in this file uses a
// non-persona agent id, so none of them touch the loop.
// ---------------------------------------------------------------------------
describe('the shipped cloud path drives the agent loop', () => {
  const personaAgent = () => makeAgent({ id: 'persona-u1-CONFIG' });

  beforeEach(() => {
    jest.clearAllMocks();
    useCloudChatStore.getState().reset();
    mockRunAgentLoopDeps.mockReturnValue({
      callModel: jest.fn(),
      tools: {},
      loadSkill: () => null,
      skillIds: () => [],
    });
  });

  it('a `persona-*` agent goes through runAgentTurn, NOT runSingleShot', async () => {
    const { result } = renderHook(() => useCloudPersonaChat(personaAgent()));
    await act(async () => { result.current.sendMessage('I moved to Alkmaar'); });

    // The loop builds its own deps; the single-shot path never would.
    await waitFor(() => expect(mockRunAgentLoopDeps).toHaveBeenCalled(), { timeout: 3000 });
    // ...and the old path's stream is never opened by the loop itself.
    expect(mockCloudChatStream).not.toHaveBeenCalled();
  });

  it('passes the USER MESSAGE to the port, which is what keeps it off the wire', async () => {
    // find_similar_facts takes no statement argument precisely so the user's
    // words stay out of a cleartext tool argument; the device supplies them.
    const { result } = renderHook(() => useCloudPersonaChat(personaAgent()));
    await act(async () => { result.current.sendMessage('I moved to Alkmaar'); });
    await waitFor(() => expect(mockRunAgentLoopDeps).toHaveBeenCalled(), { timeout: 3000 });
    expect(mockRunAgentLoopDeps.mock.calls[0][0]).toBe('I moved to Alkmaar');
  });

  it('a NON-persona agent still takes the single-shot path, unchanged', async () => {
    mockCloudChatStream.mockReturnValue(makeSseStream([{ type: 'text-delta', delta: 'hi' }]));
    const { result } = renderHook(() =>
      useCloudPersonaChat(makeAgent({ id: 'article-feedback-1', getToolDefinitions: jest.fn().mockReturnValue([]) })),
    );
    await act(async () => { result.current.sendMessage('hi'); });
    await waitFor(() => expect(mockCloudChatStream).toHaveBeenCalled(), { timeout: 3000 });
    expect(mockRunAgentLoopDeps).not.toHaveBeenCalled();
  });

  // THE REPLY GATE, THROUGH THE SHIPPED PATH. The core's own tests prove the
  // gate works; they proved nothing about the app reaching it, which is exactly
  // how the old prompt stayed live and how `legCapped` stayed hardcoded false.
  it('a final reply claiming a save is corrected before it reaches the store', async () => {
    const model = jest.fn();
    const res = (content: string) => ({
      content, toolCalls: [], finishReason: 'stop', truncated: false,
      usage: null, modelSent: 'fake', latencyMs: 1, error: null,
    });
    // Leg 0 must actually ROUTE, or the route enforcement fires first and this
    // test measures that instead of the reply gate.
    model
      .mockResolvedValueOnce({
        ...res('Porto, one moment.'),
        toolCalls: [{ name: 'load_skill', argumentsRaw: JSON.stringify({ id: 'facts/residence' }) }],
      })
      .mockResolvedValueOnce(res("Got it, I've noted that."))
      .mockResolvedValue(res('Got it, Porto. What do you do for work?'));
    mockRunAgentLoopDeps.mockReturnValue({
      callModel: model,
      tools: {},
      loadSkill: (id: string) => (id === 'facts/residence' ? 'RESIDENCE BODY' : null),
      skillIds: () => ['facts/residence'],
    });

    const { result } = renderHook(() => useCloudPersonaChat(personaAgent()));
    await act(async () => { result.current.sendMessage('I moved to Porto'); });
    await waitFor(
      () => expect(useCloudChatStore.getState().agentTurnState?.turnActive).toBe(false),
      { timeout: 3000 },
    );

    // route leg + claiming reply + the one correction the gate bought.
    expect(model).toHaveBeenCalledTimes(3);
    // ...and the claim never reached the bubble.
    const assistant = useCloudChatStore.getState().messages.filter((m) => m.role === 'assistant');
    const text = assistant.map((m) => m.content).join(' ');
    expect(text).toContain('What do you do for work?');
    expect(text).not.toContain("I've noted that");
  });

  // ONE BUBBLE PER TURN (owner ruling ux2 D12, option a). The acknowledgement
  // streams, and at turn end an answer with text takes its slot; a card-only
  // turn keeps the acknowledgement. Leg text never streams (audit F4).
  it('ends a turn with an answer as ONE bubble holding the answer', async () => {
    const model = jest.fn();
    const res = (content: string, over: Record<string, unknown> = {}) => ({
      content, toolCalls: [], finishReason: 'stop', truncated: false,
      usage: null, modelSent: 'fake', latencyMs: 1, error: null, ...over,
    });
    model
      .mockImplementationOnce(async (req: { onDelta?: (d: { content?: string }) => void }) => {
        req.onDelta?.({ content: 'Porto, one moment.' });
        return res('Porto, one moment.', {
          toolCalls: [{ name: 'load_skill', argumentsRaw: JSON.stringify({ id: 'facts/residence' }) }],
        });
      })
      .mockImplementation(async (req: { onDelta?: (d: { content?: string }) => void }) => {
        req.onDelta?.({ content: 'LEG TEXT MUST NOT STREAM' });
        return res('Got it, Porto. What do you do for work?');
      });
    mockRunAgentLoopDeps.mockReturnValue({
      callModel: model,
      tools: {},
      loadSkill: (id: string) => (id === 'facts/residence' ? 'RESIDENCE BODY' : null),
      skillIds: () => ['facts/residence'],
    });

    const { result } = renderHook(() => useCloudPersonaChat(personaAgent()));
    await act(async () => { result.current.sendMessage('I moved to Porto'); });
    await waitFor(
      () => expect(useCloudChatStore.getState().agentTurnState?.turnActive).toBe(false),
      { timeout: 3000 },
    );

    const assistant = useCloudChatStore
      .getState()
      .messages.filter((m) => m.role === 'assistant' && m.content.trim().length > 0);
    expect(assistant.map((m) => m.content)).toEqual(['Got it, Porto. What do you do for work?']);
  });

  it('ends a card-only turn as ONE bubble holding the acknowledgement', async () => {
    const model = jest.fn();
    const res = (content: string, over: Record<string, unknown> = {}) => ({
      content, toolCalls: [], finishReason: 'stop', truncated: false,
      usage: null, modelSent: 'fake', latencyMs: 1, error: null, ...over,
    });
    model
      .mockImplementationOnce(async (req: { onDelta?: (d: { content?: string }) => void }) => {
        req.onDelta?.({ content: 'Porto, one moment.' });
        return res('Porto, one moment.', {
          toolCalls: [{ name: 'load_skill', argumentsRaw: JSON.stringify({ id: 'facts/interest' }) }],
        });
      })
      .mockImplementationOnce(async () =>
        res('', {
          toolCalls: [{
            name: 'saveExtractedFacts',
            argumentsRaw: JSON.stringify({ extracted_user_information: [{ statement: 'Follows FC Porto' }] }),
          }],
        }))
      .mockImplementation(async () => res(''));
    mockRunAgentLoopDeps.mockReturnValue({
      callModel: model,
      tools: { saveExtractedFacts: async () => ({ staged: true }) },
      loadSkill: (id: string) => (id === 'facts/interest' ? 'INTEREST BODY' : null),
      skillIds: () => ['facts/interest'],
    });

    const { result } = renderHook(() => useCloudPersonaChat(personaAgent()));
    await act(async () => { result.current.sendMessage('I follow FC Porto'); });
    await waitFor(
      () => expect(useCloudChatStore.getState().agentTurnState?.turnActive).toBe(false),
      { timeout: 3000 },
    );

    const assistant = useCloudChatStore
      .getState()
      .messages.filter((m) => m.role === 'assistant' && m.content.trim().length > 0);
    expect(assistant.map((m) => m.content)).toEqual(['Porto, one moment.']);
  });

  // THE TOOL RECORD'S `input` IS THE ARGUMENTS, NOT THE RESULT.
  // It carried the result, so every card the thread derives from arguments was
  // dropped: ask_choice looks for `input.options` and got `{awaiting:'user'}`,
  // which is fewer than two options, so the chips vanished. On device a correct
  // three-leg turn ending `awaiting-user` showed the user nothing at all.
  it('writes the tool ARGUMENTS into input and the result into result', async () => {
    // facts/origin, not facts/residence: a residence turn refuses a place
    // question asked before any lookup, and this fixture has no lookup tool.
    // The test is about what the hook stores, not about which skill asks.
    const model = jest.fn();
    const res = (over: Record<string, unknown> = {}) => ({
      content: '', toolCalls: [], finishReason: 'stop', truncated: false,
      usage: null, modelSent: 'fake', latencyMs: 1, error: null, ...over,
    });
    model
      .mockResolvedValueOnce(res({
        content: 'Nieuw-West, one moment.',
        toolCalls: [{ name: 'load_skill', argumentsRaw: JSON.stringify({ id: 'facts/origin' }) }],
      }))
      .mockResolvedValue(res({
        toolCalls: [{
          name: 'ask_choice',
          argumentsRaw: JSON.stringify({
            question: 'Which Nieuw-West did you mean?',
            options: ['Amsterdam', 'Amsterdam-Zuidoost'],
          }),
        }],
      }));
    mockRunAgentLoopDeps.mockReturnValue({
      callModel: model,
      tools: {},
      loadSkill: (id: string) => (id === 'facts/origin' ? 'ORIGIN BODY' : null),
      skillIds: () => ['facts/origin'],
    });

    const { result } = renderHook(() => useCloudPersonaChat(personaAgent()));
    await act(async () => { result.current.sendMessage('I live in Nieuw-West Amsterdam'); });
    await waitFor(
      () => expect(useCloudChatStore.getState().agentTurnState?.turnActive).toBe(false),
      { timeout: 3000 },
    );

    const calls = useCloudChatStore
      .getState()
      .messages.flatMap((m) => m.toolCalls ?? []);
    const ask = calls.find((c) => c.name === 'ask_choice');
    expect(ask).toBeDefined();
    // The thread reads exactly this to build the chips.
    expect((ask?.input as { options?: string[] })?.options).toEqual([
      'Amsterdam',
      'Amsterdam-Zuidoost',
    ]);
    // ...and the result is kept, in its own field, with the loop's "Save as I
    // wrote it" entry for the user's own sentence (ux2 D9).
    expect(ask?.result).toEqual({
      awaiting: 'user',
      saveAsWritten: { statement: 'Lives in Nieuw-West Amsterdam' },
    });
  });

  it('releases the turn when the loop finishes, so the composer unblocks', async () => {
    const { result } = renderHook(() => useCloudPersonaChat(personaAgent()));
    await act(async () => { result.current.sendMessage('hi'); });
    await waitFor(
      () => expect(useCloudChatStore.getState().agentTurnState?.turnActive).toBe(false),
      { timeout: 3000 },
    );
    expect(useCloudChatStore.getState().status).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// A FAILED agent turn must not wedge the composer (pagent P1)
// ---------------------------------------------------------------------------
describe('agent loop failure recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useCloudChatStore.getState().reset();
  });

  it('a throwing callModel leaves turnActive FALSE and the status idle', async () => {
    // The device symptom: NEAR 503 on the first send, then "Please try again in
    // a moment" forever -- only New chat recovered.
    mockRunAgentLoopDeps.mockReturnValue({
      callModel: jest.fn(async () => { throw new Error("Provider error: Model 'BIG' not found"); }),
      tools: {}, loadSkill: () => null, skillIds: () => [],
    });
    const { result } = renderHook(() => useCloudPersonaChat(makeAgent({ id: 'persona-u1-CONFIG' })));

    await act(async () => { result.current.sendMessage('hi'); });
    await waitFor(() => expect(useCloudChatStore.getState().error).toBeTruthy(), { timeout: 3000 });

    expect(useCloudChatStore.getState().status).toBe('idle');
    expect(useCloudChatStore.getState().agentTurnState?.turnActive).toBe(false);
  });

  it('a SECOND send still works after a failed turn', async () => {
    let calls = 0;
    mockRunAgentLoopDeps.mockReturnValue({
      callModel: jest.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('503');
        return { content: 'ok now', toolCalls: [], finishReason: 'stop', truncated: false,
          usage: null, modelSent: 'm', latencyMs: 1, error: null };
      }),
      tools: {}, loadSkill: () => null, skillIds: () => [],
    });
    const { result } = renderHook(() => useCloudPersonaChat(makeAgent({ id: 'persona-u1-CONFIG' })));

    await act(async () => { result.current.sendMessage('first'); });
    await waitFor(() => expect(useCloudChatStore.getState().error).toBeTruthy(), { timeout: 3000 });

    await act(async () => { result.current.sendMessage('second'); });
    // 1 failed call, then the second send: its route leg returns prose and this
    // fixture's loadSkill knows no ids, so the loop re-asks MAX_FORMAT_RETRIES
    // times before ending on no-route rather than accepting the prose. Exact
    // rather than "> 1", so a change to the retry budget shows up here.
    await waitFor(() => expect(calls).toBe(2 + MAX_FORMAT_RETRIES), { timeout: 3000 });
    expect(useCloudChatStore.getState().agentTurnState?.turnActive).toBe(false);
  });
});

describe('a new conversation drops stale turn state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useCloudChatStore.getState().reset();
    mockRunAgentLoopDeps.mockReturnValue({
      callModel: jest.fn(async () => ({
        content: 'ok', toolCalls: [], finishReason: 'stop', truncated: false,
        usage: null, modelSent: 'm', latencyMs: 1, error: null,
      })),
      tools: {}, loadSkill: () => null, skillIds: () => [],
    });
  });

  it('a reset between turns means the next turn starts with NO pendingChoice', async () => {
    // The device failure: a fresh "Yes" in a NEW chat was matched to a stale
    // choice about a wife's hospital in Alkmaar.
    const { result } = renderHook(() => useCloudPersonaChat(makeAgent({ id: 'persona-u1-CONFIG' })));
    await act(async () => { result.current.sendMessage('first'); });
    await waitFor(
      () => expect(useCloudChatStore.getState().agentTurnState).not.toBeNull(),
      { timeout: 3000 },
    );

    // What New chat does.
    act(() => { useCloudChatStore.getState().reset(); });
    expect(useCloudChatStore.getState().agentTurnState).toBeNull();

    await act(async () => { result.current.sendMessage('Yes'); });
    await waitFor(
      () => expect(useCloudChatStore.getState().agentTurnState).not.toBeNull(),
      { timeout: 3000 },
    );
    expect(useCloudChatStore.getState().agentTurnState?.pendingChoice).toBeNull();
    expect(useCloudChatStore.getState().agentTurnState?.resolvedChoice).toBeNull();
  });
});

// Owner ruling ux1, F7: the loop must know which readings are still waiting on
// a card, so a typed reply cannot produce a second card for the same thing.
describe('pendingCardStatements', () => {
  const { pendingCardStatements } = require('../../hooks/useCloudPersonaChat');
  const { useFloatingChatStore } = require('../../stores/floating-chat-store');
  const staged = {
    staged: true,
    groupResolutions: {},
    pendingFacts: [
      { index: 0, options: ['Lives in Berlin, Germany, EU'] },
      { index: 1, options: ['Product manager'] },
    ],
  };
  const msg = { id: 'm1', role: 'assistant', content: '', toolCalls: [{ id: 't', name: 'saveExtractedFacts', input: {}, status: 'done', result: staged }] };

  afterEach(() => useFloatingChatStore.setState({ toolCallResults: {} }));

  it('lists every reading on a card nobody has answered', () => {
    expect(pendingCardStatements([msg])).toEqual(['Lives in Berlin, Germany, EU', 'Product manager']);
  });

  it('drops a card the user answered, reading the override a tap wrote', () => {
    const { factChoiceGroupId } = require('../../chat-tools/fact-choice-resolution');
    const answered = {
      ...staged,
      groupResolutions: { [factChoiceGroupId(1, ['Product manager'])]: { status: 'dismissed', options: ['Product manager'], questionnaireAttribute: null } },
    };
    useFloatingChatStore.setState({ toolCallResults: { 'm1::0': answered } });
    expect(pendingCardStatements([msg])).toEqual(['Lives in Berlin, Germany, EU']);
  });
});

// ux1 C2: the dash cleanup used to land after the stream and re-wrap a
// finished bubble. The bubble is now clean on every render.
describe('single-shot dash cleanup while streaming', () => {
  it('never shows a clause dash, even before the stream ends', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    mockCloudChatStream.mockImplementation(async function* () {
      yield { type: 'text-delta', delta: 'It covers oversight — safety news' };
      await gate;
      yield { type: 'text-delta', delta: ' is in that lane.' };
      yield { type: 'finish', reason: 'stop' };
    });
    const agent = makeAgent({ id: 'article-feedback-1', getToolDefinitions: jest.fn().mockReturnValue([]) });
    const { result } = renderHook(() => useCloudPersonaChat(agent));
    act(() => { result.current.sendMessage('why?'); });
    await waitFor(
      () => expect(result.current.messages.some((m) => m.role === 'assistant' && m.content.includes('oversight'))).toBe(true),
      { timeout: 3000 },
    );
    const mid = result.current.messages.filter((m) => m.role === 'assistant').map((m) => m.content).join(' ');
    expect(mid).not.toMatch(/[—–]/);
    await act(async () => { release(); });
  });
});
