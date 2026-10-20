// The cloud chat engine driven through the chat session: the real createCloudEngine, the real
// persona loop and single-shot path, the gateway mock (real E2EE both ways), the in-memory DB and
// the real stores. Replaces lib/chat-session/__tests__/chat-session.test.ts (cloud half) and
// proves what its mocked engines could not: that a real turn produces the busy window, the hold
// and the rows the session promises.
import { attachChatSession, resetChatSession } from '@/lib/chat-session/chat-session';
import { appendMessage, createConversation, fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import { getFacts } from '@/lib/database/services/fact-service';
import { useChatPhaseStore } from '@/lib/llm/chat-phase-store';
import { PersonaOnDeviceAgent } from '@/lib/llm/agents/on-device/PersonaOnDeviceAgent';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { gatewayCalls, mockGateway, server, signInFixtureAccount } from '@/test/helpers';
import { isRouteLeg, resetChatModules, systemOf, until } from '@/test/integration/chat/_helpers';
import {
  articleAgent,
  assistantTexts,
  attachCloud,
  busy,
  cloud,
  personaAgent,
  sampleSession,
  settle,
  streamHolds,
  turnDone,
} from './kit';

jest.setTimeout(60_000);

afterEach(settle);

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
});

const rowsOf = (id: string) => fetchMessagesForConversation(id);

describe('attach', () => {
  it('the same conversation and kind reuses the engine and swaps its agent (the swapped agent answers)', async () => {
    const { conversationId, engine } = await attachCloud(personaAgent());
    const again = attachChatSession({ conversationId, kind: 'cloud', agent: articleAgent(), persistedIds: [] });
    expect(again).toBe(engine);

    again.send('Why was this shown to me?');
    await turnDone();

    // The article agent is single-shot: one chat call, and no persona skill index in its prompt.
    const calls = gatewayCalls('chat');
    expect(calls).toHaveLength(1);
    expect(isRouteLeg(calls[0])).toBe(false);
    expect(systemOf(calls[0])).not.toContain('## Skill index');
    expect(assistantTexts().map(([, text]) => text)).toEqual(['E2E fixture answer.']);
  });

  it('a new conversation or a new kind disposes the old engine: it no longer accepts a send', async () => {
    const first = await attachCloud();
    const secondId = await createConversation('CONFIG' as never);
    const second = attachChatSession({ conversationId: secondId, kind: 'cloud', agent: personaAgent(), persistedIds: [] });
    expect(second).not.toBe(first.engine);

    first.engine.send('into the void');
    first.engine.sendHidden('into the void, hidden');
    expect(cloud().messages).toEqual([]);
    expect(busy()).toBe(false);

    // Same conversation, other kind: the cloud engine is disposed too.
    const third = attachChatSession({
      conversationId: secondId,
      kind: 'local',
      agent: new PersonaOnDeviceAgent('u1', 'CONFIG'),
      persistedIds: [],
    });
    expect(third).not.toBe(second);
    second.send('into the void again');
    expect(cloud().messages).toEqual([]);
    expect(gatewayCalls()).toHaveLength(0);
  });
});

describe('a persona turn', () => {
  it('streams only the route leg, holds the restart for exactly the turn, and leaves one answer bubble', async () => {
    const { engine } = await attachCloud();
    const watch = sampleSession();

    engine.send('What is new today?');
    // Synchronously busy: the hold is taken and the busy flag mirrored before any await.
    expect(busy()).toBe(true);
    expect(useFloatingChatStore.getState().isGenerating).toBe(true);
    expect(streamHolds()).toBe(1);

    await turnDone();
    watch.stop();

    // The persona loop is reached (route leg carries the skill index) and only leg 0 streams.
    const calls = gatewayCalls('chat');
    expect(isRouteLeg(calls[0])).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.map((c) => c.stream)).toEqual([true, ...calls.slice(1).map(() => false)]);

    // Two bubbles during the turn (the acknowledgement streamed in), one at the end.
    const ack = cloud().messages.find((m) => m.id.endsWith('-ack'));
    const answer = cloud().messages.find((m) => m.role === 'assistant' && !m.id.endsWith('-ack'));
    expect(ack).toBeDefined();
    expect(answer?.id).toBe(ack?.id.replace(/-ack$/, ''));
    expect(answer?.content).toBe('E2E fixture answer.');
    expect(ack?.content).toBe('');
    expect(watch.samples.some((s) => s.ack.length > 0)).toBe(true);

    // The mirror is exact on every change, the hold is one acquire and one release.
    expect(watch.samples.length).toBeGreaterThan(0);
    for (const s of watch.samples) expect(s.generating).toBe(s.busy || s.streaming);
    expect(Math.max(...watch.samples.map((s) => s.held))).toBe(1);
    expect(streamHolds()).toBe(0);
    expect(useFloatingChatStore.getState().isGenerating).toBe(false);
    expect(useChatPhaseStore.getState().view.kind).not.toBe('phase');
  });

  it('a fact turn stages the fact on the answer message and writes nothing to the facts table', async () => {
    const { engine } = await attachCloud();
    engine.send('I follow Formula 1 racing');
    await turnDone();

    const answer = cloud().messages.find((m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.name === 'saveExtractedFacts'));
    expect(answer).toBeDefined();
    const save = answer!.toolCalls!.find((c) => c.name === 'saveExtractedFacts')!;
    const result = save.result as { pendingFacts?: { options?: unknown }[]; factsSaved?: number };
    expect(JSON.stringify(result.pendingFacts)).toContain('Follows Formula 1 racing');
    expect(result.factsSaved).toBe(0);
    // Propose-then-save: nothing is committed until a tap on the card.
    expect(await getFacts()).toEqual([]);
  });

  it('a turn that ends with the chat closed marks the answer unread; with the chat open it does not', async () => {
    const closed = await attachCloud();
    expect(useFloatingChatStore.getState().isExpanded).toBe(false);
    closed.engine.send('What is new today?');
    await turnDone();
    expect(useFloatingChatStore.getState().answerUnread).toBe(true);

    resetChatModules();
    useFloatingChatStore.setState({ isExpanded: true });
    const open = await attachCloud();
    open.engine.send('What is new today?');
    await turnDone();
    expect(useFloatingChatStore.getState().answerUnread).toBe(false);
  });
});

describe('New chat mid-turn', () => {
  it('releases the restart hold and the busy mirror at once', async () => {
    server.use(...mockGateway(() => ({ chunks: ['Slow ', 'answer ', 'text.'], chunkDelayMs: 300 })));
    const { engine } = await attachCloud(articleAgent());
    engine.send('Tell me');
    await until(() => (cloud().messages.find((m) => m.role === 'assistant')?.content ?? '').length > 0, 10_000, 'streaming');
    expect(streamHolds()).toBe(1);

    resetChatSession();

    expect(streamHolds()).toBe(0);
    expect(useFloatingChatStore.getState().isGenerating).toBe(false);
    expect(cloud().messages).toEqual([]);
    // Let the abandoned call run out on the wire so it does not bleed into the next test.
    await new Promise((r) => setTimeout(r, 1500));
  });
});

describe('persistence', () => {
  it('writes the user row at once, the assistant row only when idle, never the -ack placeholder, and merges an early tool-result override', async () => {
    const { conversationId, engine } = await attachCloud();
    engine.send('I follow Formula 1 racing');

    await until(() => cloud().messages.some((m) => m.role === 'assistant' && !m.id.endsWith('-ack')), 10_000, 'answer bubble');
    const answerId = cloud().messages.find((m) => m.role === 'assistant' && !m.id.endsWith('-ack'))!.id;
    // A tap on a card before the row exists: the override is merged in when the row is written.
    useFloatingChatStore.getState().setToolCallResult(`${answerId}::0`, { tapped: true });

    await until(() => cloud().messages[0]?.role === 'user', 1000);
    let rows = await rowsOf(conversationId);
    while (rows.length === 0) {
      await new Promise((r) => setTimeout(r, 10));
      rows = await rowsOf(conversationId);
    }
    // The user row is there while the turn is still running; the assistant row is not.
    expect(busy()).toBe(true);
    expect(rows.map((r) => r.role)).toEqual(['user']);

    await turnDone();
    await until(() => cloud().messages.length > 0, 1000);
    for (let i = 0; i < 200 && (await rowsOf(conversationId)).length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    rows = await rowsOf(conversationId);
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(rows.some((r) => r.id.endsWith('-ack'))).toBe(false);
    expect(rows[1].id).toBe(answerId);
    expect(rows[1].toolCalls?.[0]).toMatchObject({ name: 'load_skill', status: 'done', result: { tapped: true } });
  });

  it('never re-writes the ids passed at attach', async () => {
    const conversationId = await createConversation('CONFIG' as never);
    await appendMessage(conversationId, { role: 'user', content: 'old question' }, 'old-u');
    await appendMessage(conversationId, { role: 'assistant', content: 'old answer' }, 'old-a');
    // The thread a resumed view loads into the store.
    cloud().setMessages([
      { id: 'old-u', role: 'user', content: 'old question', createdAt: 1 },
      { id: 'old-a', role: 'assistant', content: 'CHANGED IN MEMORY' },
    ]);
    attachChatSession({ conversationId, kind: 'cloud', agent: personaAgent(), persistedIds: ['old-u', 'old-a'] });
    cloud().setError('poke');
    cloud().setError(null);
    await new Promise((r) => setTimeout(r, 50));
    const rows = await rowsOf(conversationId);
    expect(rows.map((r) => [r.id, r.content]).sort()).toEqual([
      ['old-a', 'old answer'],
      ['old-u', 'old question'],
    ]);
  });

  it('a hidden turn adds no user row; its reply is the only thing written', async () => {
    const { conversationId, engine } = await attachCloud(articleAgent());
    engine.sendHidden('You rejected my topics, ask what to change.');
    await turnDone();
    for (let i = 0; i < 200 && (await rowsOf(conversationId)).length < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(cloud().messages.map((m) => m.role)).toEqual(['assistant']);
    const rows = await rowsOf(conversationId);
    expect(rows.map((r) => [r.role, r.content])).toEqual([['assistant', 'E2E fixture answer.']]);
  });
});

describe('a transport error', () => {
  it('sets the error, releases the wait line, clears busy and releases the restart hold', async () => {
    server.use(...mockGateway(() => ({ status: 502 })));
    const { engine } = await attachCloud(articleAgent());
    engine.send('hello');
    await turnDone(50_000);

    expect(cloud().error).toMatch(/^Cloud chat failed:/);
    expect(useChatPhaseStore.getState().view.kind).not.toBe('phase');
    expect(busy()).toBe(false);
    expect(cloud().status).toBe('idle');
    expect(streamHolds()).toBe(0);
    expect(useFloatingChatStore.getState().isGenerating).toBe(false);
  });
});

describe('a hidden turn queued behind a running one', () => {
  const slow = () => ({ chunks: ['First ', 'answer ', 'text.'], chunkDelayMs: 300 });

  it('fires after the running turn settles (one extra chat call)', async () => {
    server.use(...mockGateway(slow));
    const { engine } = await attachCloud(articleAgent());
    engine.send('Tell me');
    await until(() => gatewayCalls('chat').length === 1, 10_000, 'first call');
    engine.sendHidden('Follow-up note');
    expect(gatewayCalls('chat')).toHaveLength(1);

    await until(() => gatewayCalls('chat').length === 2, 20_000, 'hidden turn fired');
    await until(() => !busy() && cloud().status === 'idle', 20_000, 'both turns over');
    expect(gatewayCalls('chat')).toHaveLength(2);
    // The hidden note rides the wire as a user turn but never the thread.
    expect(cloud().messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(JSON.stringify(gatewayCalls('chat')[1].messages)).toContain('Follow-up note');
  });
});
