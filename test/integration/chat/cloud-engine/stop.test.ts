// Stop on the cloud engine, through the chat session's stopChatTurn() (the Send button while a turn
// runs). Replaces lib/hooks/__tests__/cloud-engine-stop.test.ts, which mocked cloudChatStream and
// the agent-device port: here the abort travels the real path (limiter, hedge, SSE reader) and the
// gateway mock records that the call was cut.
import { stopChatTurn } from '@/lib/chat-session/chat-session';
import { useChatPhaseStore } from '@/lib/llm/chat-phase-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { defaultResponder, gatewayCalls, mockGateway, server, signInFixtureAccount, type GatewayResponder } from '@/test/helpers';
import { resetChatModules, toolCall, until } from '@/test/integration/chat/_helpers';
import { articleAgent, attachCloud, busy, cloud, idle, settle, streamHolds, turnDone } from './kit';

jest.setTimeout(60_000);

afterEach(settle);

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
  // The Stop button lives in the open chat.
  useFloatingChatStore.setState({ isExpanded: true });
});

/** The first chat call is scripted; every later one is the default responder. */
const firstCallThen = (first: ReturnType<GatewayResponder>): GatewayResponder => (call) =>
  call.route === 'chat' && call.index === 0 ? first : defaultResponder(call);

const ackOf = () => cloud().messages.find((m) => m.id.endsWith('-ack'));
const answerOf = () => cloud().messages.find((m) => m.role === 'assistant' && !m.id.endsWith('-ack'));

describe('stop on the persona loop', () => {
  it('mid-stream: the partial text stays as stopped, no error, busy clears, the call is cut and no further leg is sent', async () => {
    server.use(
      ...mockGateway(
        firstCallThen({
          chunks: ['One moment ', 'while I look ', toolCall('load_skill', { id: 'conversation/question' })],
          // Two chunks arrive, then the stream goes silent until the client gives up (the Stop).
          stallAfter: 2,
        }),
      ),
    );
    const { engine } = await attachCloud();
    engine.send('What is new today?');
    await until(() => (ackOf()?.content ?? '').includes('One moment'), 10_000, 'partial text');

    stopChatTurn();
    await until(idle, 5000, 'busy clears after stop');

    expect(cloud().error).toBeNull();
    expect(ackOf()).toMatchObject({ stopped: true });
    expect(ackOf()?.content).toContain('One moment');
    expect(answerOf()?.content).toBe('');
    expect(cloud().messages.every((m) => m.toolCalls === undefined)).toBe(true);
    await until(() => gatewayCalls('chat')[0].aborted, 5000, 'the call is recorded as aborted');
    expect(streamHolds()).toBe(0);
    expect(useFloatingChatStore.getState().isGenerating).toBe(false);
    expect(useFloatingChatStore.getState().answerUnread).toBe(false);
    expect(useChatPhaseStore.getState().view.kind).not.toBe('phase');

    // No further leg, even after a beat.
    await new Promise((r) => setTimeout(r, 1500));
    expect(gatewayCalls('chat')).toHaveLength(1);

    // The reader can send again at once, and the new turn is a normal one.
    engine.send('What is new today?');
    expect(busy()).toBe(true);
    await turnDone();
    expect(cloud().error).toBeNull();
    expect(answerOf()?.content).toBe('');
    expect(cloud().messages.filter((m) => m.role === 'assistant' && m.content === 'E2E fixture answer.')).toHaveLength(1);
  });

  it('between legs: the stopped turn keeps its text, drops its tool calls and sends no further leg', async () => {
    // Leg 0 (route) answers at once with a skill load; leg 1 never answers in time.
    server.use(
      ...mockGateway((call) =>
        call.route === 'chat' && call.index === 1 ? { chunks: ['Late answer.'], headerDelayMs: 2000 } : defaultResponder(call),
      ),
    );
    const { engine } = await attachCloud();
    engine.send('What is new today?');
    await until(() => (answerOf()?.toolCalls ?? []).some((c) => c.name === 'load_skill'), 10_000, 'the skill load is on screen');
    await until(() => gatewayCalls('chat').length === 2, 10_000, 'leg 1 is in flight');

    stopChatTurn();
    await until(idle, 5000, 'busy clears after stop');

    expect(cloud().error).toBeNull();
    expect(cloud().messages.every((m) => m.toolCalls === undefined)).toBe(true);
    expect(ackOf()).toMatchObject({ stopped: true });
    expect(ackOf()?.content.trim()).toBe('One moment.');
    await until(() => gatewayCalls('chat')[1].aborted, 5000, 'leg 1 is recorded as aborted');
    // Past the mock's header delay, so nothing of this call is left running into the next test.
    await new Promise((r) => setTimeout(r, 2500));
    expect(gatewayCalls('chat')).toHaveLength(2);
  });
});

describe('stop on a single-shot agent', () => {
  it('keeps the partial, and what the reader saw is history for the next turn', async () => {
    server.use(
      ...mockGateway(firstCallThen({ chunks: ['The AI Act sorts ', 'systems by risk, ', 'and then it goes on.'], stallAfter: 2 })),
    );
    const { engine } = await attachCloud(articleAgent());
    engine.send('Explain the EU AI Act');
    await until(() => (answerOf()?.content ?? '').includes('sorts'), 10_000, 'partial text');

    stopChatTurn();
    await until(idle, 5000, 'busy clears after stop');
    expect(cloud().error).toBeNull();
    expect(answerOf()).toMatchObject({ stopped: true });
    const seen = answerOf()!.content.trim();
    expect(seen).toContain('sorts');
    expect(seen).toContain('systems by risk');
    expect(seen).not.toContain('goes on');
    expect(answerOf()?.toolCalls).toBeUndefined();
    await until(() => gatewayCalls('chat')[0].aborted, 5000, 'the call is recorded as aborted');
    expect(gatewayCalls('chat')).toHaveLength(1);

    engine.send('And the fines?');
    await turnDone();
    const second = gatewayCalls('chat')[1];
    const roles = second.messages.filter((m) => m.role !== 'system').map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user']);
    expect(second.messages.find((m) => m.role === 'assistant')?.content).toBe(seen);
  });
});

describe('stop with a hidden turn queued', () => {
  it('cancels the queued turn', async () => {
    server.use(...mockGateway(firstCallThen({ chunks: ['Slow ', 'answer ', 'text.'], stallAfter: 2 })));
    const { engine } = await attachCloud(articleAgent());
    engine.send('Tell me');
    await until(() => (answerOf()?.content ?? '').length > 0, 10_000, 'streaming');
    engine.sendHidden('Follow-up note');

    stopChatTurn();
    await until(idle, 5000, 'busy clears after stop');
    await new Promise((r) => setTimeout(r, 1500));
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(busy()).toBe(false);
  });

  it('does nothing when no turn is running', async () => {
    await attachCloud(articleAgent());
    stopChatTurn();
    expect(gatewayCalls()).toHaveLength(0);
    expect(cloud().messages).toEqual([]);
  });
});
