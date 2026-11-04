// A whole chat turn across the app leaving: the engine, the session, the store and the row.
import { resetChatSession } from '@/lib/chat-session/chat-session';
import { __startNewProcessForTests, recoverInterruptedTurn } from '@/lib/chat-session/turn-inflight';
import { fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import { getSetting } from '@/lib/database/services/setting-service';
import { isFallbackEngaged } from '@/lib/llm/model-fallback';
import { BIG_MODEL } from '@/lib/llm/constants';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import {
  advanceUntil,
  advanceUntilDone,
  gatewayCalls,
  mockGateway,
  mockGql,
  server,
  setAppState,
  signInFixtureAccount,
  type GatewayReply,
} from '@/test/helpers';
import { isRouteLeg, reply, resetChatModules, toolCall, useStrictClock } from '@/test/integration/chat/_helpers';
import { articleAgent, attachCloud, cloud, idle } from './kit';

jest.setTimeout(60_000);

const IDLE_WINDOW = 31_000;
const BUFFERED_WINDOW = 31_000;
const HELD: GatewayReply = { chunks: ['late'], headerDelayMs: 600_000 };
const row = () => getSetting('chat_turn_inflight');
const answer = () => cloud().messages.filter((m) => m.role === 'assistant' && m.content.trim()).map((m) => m.content);

async function awayFor(ms: number): Promise<void> {
  setAppState('background');
  await jest.advanceTimersByTimeAsync(ms);
  setAppState('active');
}

beforeEach(async () => {
  resetChatModules();
  useStrictClock('2026-11-04T00:00:00Z');
  setAppState('active');
  await advanceUntilDone(signInFixtureAccount());
  useFloatingChatStore.setState({ isExpanded: true, proposal: null, resolvedProposals: {} });
});
afterEach(() => setAppState('active'));

describe('tools', () => {
  it('away between tool legs: the leg goes out again, and the lookup that ran is not repeated', async () => {
    let lookups = 0;
    server.use(
      mockGql('PlaceSearch', () => {
        lookups += 1;
        return { placeSearch: [] };
      }),
      ...mockGateway((c) => {
        if (c.index === 0) return reply('One moment.', toolCall('load_skill', { id: 'facts/residence' }));
        if (c.index === 1) return reply('', toolCall('lookup_place', { query: 'Porto' }));
        return c.index === 2 ? HELD : 'Which part of Porto?';
      }),
    );
    const { engine } = await advanceUntilDone(attachCloud());
    engine.send('I live in Porto');
    await advanceUntil(() => gatewayCalls('chat').length === 3);
    const before = lookups;
    expect(before).toBeGreaterThan(0);

    await awayFor(BUFFERED_WINDOW);
    await advanceUntil(idle);

    expect(lookups).toBe(before);
    const [, , cut, again] = gatewayCalls('chat');
    expect(cut.aborted).toBe(true);
    expect(again.messages).toEqual(cut.messages);
    expect(cloud().error).toBeNull();
    expect(answer()).toEqual(['Which part of Porto?']);
    expect(isFallbackEngaged(BIG_MODEL)).toBe(false);
  });
});

describe('the reply', () => {
  it('single-shot, mid-stream: the partial leaves the bubble and the wire stays whole', async () => {
    server.use(
      ...mockGateway((c) => (c.index === 0 ? { chunks: ['Par', 'tial'], stallAfter: 1 } : 'Whole answer')),
    );
    const { engine } = await advanceUntilDone(attachCloud(articleAgent()));
    engine.send('Why this story?');
    await advanceUntil(() => answer().join('') === 'Par');

    await awayFor(IDLE_WINDOW);
    await advanceUntil(idle);

    expect(answer()).toEqual(['Whole answer']);
    expect(cloud().wireMessages.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['Whole answer']);
    expect(gatewayCalls('chat')).toHaveLength(2);
  });

  it('the persona loop, mid-stream: the acknowledgement restarts too', async () => {
    server.use(
      ...mockGateway((c) => {
        if (!isRouteLeg(c)) return 'Fine.';
        return c.index === 0
          ? { chunks: ['Half an ack', 'nowledgement'], stallAfter: 1 }
          : reply('The whole acknowledgement.', toolCall('load_skill', { id: 'conversation/question' }));
      }),
    );
    const { engine } = await advanceUntilDone(attachCloud());
    engine.send('What is new?');
    await advanceUntil(() => answer().join('') === 'Half an ack');

    await awayFor(IDLE_WINDOW);
    await advanceUntil(idle);

    expect(answer().join(' ')).not.toContain('Half an ack');
    expect(cloud().error).toBeNull();
  });

  it('when the re-send fails too: Retry copy, the partial marked failed in the store and the table', async () => {
    server.use(...mockGateway(() => ({ chunks: ['Par', 'tial'], stallAfter: 1 })));
    const { conversationId, engine } = await advanceUntilDone(attachCloud(articleAgent()));
    engine.send('Why this story?');
    await advanceUntil(() => answer().join('') === 'Par');
    await awayFor(IDLE_WINDOW);
    await advanceUntil(() => gatewayCalls('chat').length === 2);
    await advanceUntil(() => answer().join('') === 'Par');
    await awayFor(IDLE_WINDOW);
    await advanceUntil(idle);

    expect(cloud().error).not.toBeNull();
    expect(cloud().interrupted).toBe(true);
    expect(cloud().messages.find((m) => m.role === 'assistant')).toMatchObject({ content: 'Par', failed: true });
    const rows = await advanceUntilDone(fetchMessagesForConversation(conversationId));
    expect(rows.find((m) => m.role === 'assistant')).toMatchObject({ content: 'Par', failed: true });
  });

  it('a failure with the app in front stays a service error', async () => {
    server.use(...mockGateway(() => ({ status: 400, body: 'nope' })));
    const { engine } = await advanceUntilDone(attachCloud(articleAgent()));
    engine.send('Why this story?');
    await advanceUntil(idle);
    expect(cloud().error).not.toBeNull();
    expect(cloud().interrupted).toBe(false);
  });
});

describe('a kill', () => {
  it('the row lives exactly as long as the turn, and a recovery run in that process leaves it', async () => {
    server.use(...mockGateway(() => ({ chunks: ['late'], headerDelayMs: 5000 })));
    const { engine } = await advanceUntilDone(attachCloud(articleAgent()));
    engine.send('Why this story?');
    await advanceUntil(() => gatewayCalls('chat').length === 1);

    expect(await advanceUntilDone(row())).not.toBeNull();
    await advanceUntilDone(recoverInterruptedTurn());
    expect(await advanceUntilDone(row())).not.toBeNull();
    expect(useFloatingChatStore.getState().interruptedTurn).toBeNull();

    await advanceUntil(idle);
    await advanceUntil(() => useFloatingChatStore.getState().interruptedTurn === null);
    expect(await advanceUntilDone(row())).toBeNull();
  });

  it('after a kill the keys are gone: the next process offers Retry and reads no turn', async () => {
    server.use(...mockGateway(() => HELD));
    useFloatingChatStore.setState({ context: { kind: 'article-suggestion', articleId: 'a', suggestionId: 's' } });
    const { engine } = await advanceUntilDone(attachCloud(articleAgent()));
    engine.send('Why this story?');
    await advanceUntil(() => gatewayCalls('chat').length === 1);
    await advanceUntilDone(row());

    // A new JS context: same database, no memory.
    __startNewProcessForTests();
    resetChatSession();
    const posts = gatewayCalls('chat').length;
    await advanceUntilDone(recoverInterruptedTurn());

    expect(useFloatingChatStore.getState().interruptedTurn).toEqual({
      text: 'Why this story?',
      contextKind: 'article-suggestion',
    });
    expect(await advanceUntilDone(row())).toBeNull();
    expect(gatewayCalls('chat')).toHaveLength(posts);
  });

  it('a hidden turn leaves no row', async () => {
    server.use(...mockGateway(() => ({ chunks: ['late'], headerDelayMs: 5000 })));
    const { engine } = await advanceUntilDone(attachCloud(articleAgent()));
    engine.sendHidden('The reader discarded the plan');
    await advanceUntil(() => gatewayCalls('chat').length === 1);
    expect(await advanceUntilDone(row())).toBeNull();
  });
});

