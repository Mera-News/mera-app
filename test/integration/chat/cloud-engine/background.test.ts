// A whole chat turn across the app leaving: the engine, the session, the store and the row.
import { attachChatSession, canRetryChatTurn, resetChatSession, retryChatTurn } from '@/lib/chat-session/chat-session';
import { refusedOnRetry } from '@/lib/chat-session/cloud-engine-helpers';
import { __startNewProcessForTests, recoverInterruptedTurn } from '@/lib/chat-session/turn-inflight';
import {
  appendMessage,
  createConversation,
  fetchMessagesForConversation,
} from '@/lib/database/services/conversation-service';
import { getSetting } from '@/lib/database/services/setting-service';
import { isFallbackEngaged } from '@/lib/llm/model-fallback';
import type { StagedProposal } from '@/lib/llm/types';
import { BIG_MODEL } from '@/lib/llm/constants';
import logger from '@/lib/logger';
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
  type GatewayCall,
  type GatewayReply,
} from '@/test/helpers';
import { hasToolResult, isRouteLeg, reply, resetChatModules, toolCall, useStrictClock } from '@/test/integration/chat/_helpers';
import { articleAgent, attachCloud, cloud, idle } from './kit';

jest.setTimeout(60_000);

const IDLE_WINDOW = 31_000;
const BUFFERED_WINDOW = 31_000;
const HELD: GatewayReply = { chunks: ['late'], headerDelayMs: 600_000 };
const row = () => getSetting('chat_turn_inflight');
const answer = () => cloud().messages.filter((m) => m.role === 'assistant' && m.content.trim()).map((m) => m.content);

async function awayFor(ms: number): Promise<void> {
  setAppState('background');
  // iOS: JS stops, the wall clock goes on, and timers come due late.
  jest.setSystemTime(Date.now() + ms);
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

  it('an HTTP verdict during a departure stays a service error, with its report', async () => {
    const report = jest.spyOn(logger, 'error');
    server.use(...mockGateway(() => ({ status: 400, body: 'nope', headerDelayMs: 2000 })));
    const { engine } = await advanceUntilDone(attachCloud(articleAgent()));
    engine.send('Why this story?');
    await advanceUntil(() => gatewayCalls('chat').length === 1);
    setAppState('background');
    setAppState('active');
    await advanceUntil(idle);

    expect(cloud().error).not.toBeNull();
    expect(cloud().interrupted).toBe(false);
    expect(report).toHaveBeenCalled();
    report.mockRestore();
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
      messageId: expect.any(String),
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

describe('Retry', () => {
  const failOnce = (c: GatewayCall): GatewayReply | null => (c.index === 0 ? { status: 400, body: 'nope' } : null);
  const userBubbles = () => cloud().messages.filter((m) => m.role === 'user');

  it('after a failed turn shows the message once, on screen, on the wire and in the table', async () => {
    server.use(...mockGateway((c) => failOnce(c) ?? 'Whole answer'));
    const { conversationId, engine } = await advanceUntilDone(attachCloud(articleAgent()));
    engine.send('Why this story?');
    await advanceUntil(idle);

    expect(retryChatTurn()).toBe(true);
    await advanceUntil(() => idle() && answer().includes('Whole answer'));

    expect(cloud().error).toBeNull();
    expect(userBubbles().map((m) => m.content)).toEqual(['Why this story?']);
    expect(cloud().wireMessages.filter((m) => m.role === 'user')).toHaveLength(1);
    const rows = await advanceUntilDone(fetchMessagesForConversation(conversationId));
    expect(rows.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('a typed send of the same words is still a new message', async () => {
    server.use(...mockGateway(() => 'Answer'));
    const { engine } = await advanceUntilDone(attachCloud(articleAgent()));
    engine.send('Why this story?');
    await advanceUntil(idle);
    engine.send('Why this story?');
    await advanceUntil(idle);
    expect(userBubbles()).toHaveLength(2);
  });

  /** A killed turn's row in an earlier conversation, and its notice. */
  async function killedTurn() {
    const old = await advanceUntilDone(createConversation('CONFIG' as never));
    const messageId = 'user-killed';
    await advanceUntilDone(appendMessage(old, { role: 'user', content: 'Why this story?' }, messageId));
    useFloatingChatStore.setState({ interruptedTurn: { text: 'Why this story?', contextKind: 'persona', messageId } });
    return { old, messageId };
  }
  const notice = () => useFloatingChatStore.getState().interruptedTurn;

  it('after a kill the message moves to the new chat: history holds one copy', async () => {
    server.use(...mockGateway(() => 'Whole answer'));
    const { old } = await killedTurn();
    await advanceUntilDone(attachCloud(articleAgent()));

    expect(retryChatTurn()).toBe(true);
    await advanceUntil(() => idle() && answer().includes('Whole answer'));

    expect(userBubbles()).toHaveLength(1);
    const rows = await advanceUntilDone(fetchMessagesForConversation(old));
    expect(rows.filter((m) => m.role === 'user')).toHaveLength(0);
  });

  it('in a reopened old chat the question stays, once, and its reply lands under it', async () => {
    server.use(...mockGateway(() => 'Whole answer'));
    const { old, messageId } = await killedTurn();
    attachChatSession({ conversationId: old, kind: 'cloud', agent: articleAgent(), persistedIds: [messageId] });

    expect(retryChatTurn()).toBe(true);
    await advanceUntil(() => idle() && answer().includes('Whole answer'));

    expect(userBubbles()).toHaveLength(0);
    const rows = await advanceUntilDone(fetchMessagesForConversation(old));
    expect(rows.filter((m) => m.role === 'user').map((m) => m.id)).toEqual([messageId]);
    expect(gatewayCalls('chat')[0].messages.at(-1)?.content).toContain('Why this story?');
  });

  it('a retry that cannot start deletes nothing and keeps the notice', async () => {
    server.use(...mockGateway(() => HELD));
    const { old } = await killedTurn();
    const { engine } = await advanceUntilDone(attachCloud(articleAgent()));
    const more = engine.moreOptions!({ proposalId: 'p', shown: [], room: 1, subject: {} as never });
    await advanceUntil(() => gatewayCalls('chat').length === 1);

    expect(retryChatTurn()).toBe(false);
    await jest.advanceTimersByTimeAsync(100);

    expect(notice()?.text).toBe('Why this story?');
    const rows = await advanceUntilDone(fetchMessagesForConversation(old));
    expect(rows.filter((m) => m.role === 'user')).toHaveLength(1);
    engine.stop();
    await advanceUntilDone(more);
  });

  const warningTool = () => {
    const agent = articleAgent();
    agent.getToolDefinitions = () => [
      { type: 'function', function: { name: 'issueWarning', description: 'Warn.', parameters: { type: 'object', properties: {} } } },
    ];
    return { agent, run: jest.spyOn(agent, 'executeTool').mockResolvedValue({ result: { blocked: false } }) };
  };

  it('a live turn that ran a warning is not offered again', async () => {
    server.use(
      ...mockGateway((c) => (c.index === 0 ? toolCall('issueWarning', { reason: 'abuse' }) : { status: 400, body: 'nope' })),
    );
    const { agent, run } = warningTool();
    const { engine } = await advanceUntilDone(attachCloud(agent));
    engine.send('Something bad');
    await advanceUntil(() => idle() && cloud().error !== null);

    expect(run).toHaveBeenCalledTimes(1);
    expect(canRetryChatTurn()).toBe(false);
    expect(retryChatTurn()).toBe(false);
  });

  it('a killed turn cannot tell how far it got: its Retry never counts a warning, and only that turn is spared', async () => {
    const warn = toolCall('issueWarning', { reason: 'abuse' });
    server.use(...mockGateway((c) => (c.index === 0 || c.index === 2 ? warn : 'Done.')));
    await killedTurn();
    const { agent, run } = warningTool();
    const { engine } = await advanceUntilDone(attachCloud(agent));

    expect(retryChatTurn()).toBe(true);
    await advanceUntil(() => idle() && gatewayCalls('chat').length >= 2);
    expect(run).not.toHaveBeenCalled();

    engine.send('Something else bad');
    await advanceUntil(() => idle() && gatewayCalls('chat').length >= 4);
    expect(run).toHaveBeenCalledTimes(1);
  });

  describe('a card waiting on a calibration tap', () => {
    const CARD = {
      id: 'p1',
      actions: [
        { type: 'add_suppression', suppressionPattern: 'celebrity gossip', suppressionStrength: 0.9 },
        { type: 'run_calibration' },
      ],
    } as unknown as StagedProposal;
    // The loop never applies this card (HARNESS_TAP_ONLY): the single-shot article chat is the risk.
    const yesAgain = () =>
      mockGateway((c) => (hasToolResult(c, 'applyProposal') ? 'Tap the card to finish.' : reply('Applying it.', toolCall('applyProposal'))));
    const applied = (spy: jest.SpyInstance) => spy.mock.calls.filter(([name]) => name === 'applyProposal').length;

    it('Retry does not apply its actions again, and the card stays', async () => {
      server.use(...yesAgain());
      useFloatingChatStore.setState({ proposal: CARD });
      const agent = articleAgent();
      const execute = jest.spyOn(agent, 'executeTool').mockResolvedValue({ result: { applied: 1 } });
      await advanceUntilDone(attachCloud(agent));
      useFloatingChatStore.setState({ interruptedTurn: { text: 'yes', contextKind: 'persona' } });
      expect(retryChatTurn()).toBe(true);
      await advanceUntil(() => idle() && gatewayCalls('chat').length >= 1);

      expect(gatewayCalls('chat')).not.toHaveLength(0);
      expect(applied(execute)).toBe(0);
      expect(useFloatingChatStore.getState().proposal?.id).toBe('p1');
    });

    it('an ordinary turn still applies it', async () => {
      server.use(...yesAgain());
      useFloatingChatStore.setState({ proposal: CARD });
      const agent = articleAgent();
      const execute = jest.spyOn(agent, 'executeTool').mockResolvedValue({ result: { applied: 1 } });
      const { engine } = await advanceUntilDone(attachCloud(agent));
      engine.send('yes');
      await advanceUntil(() => idle() && gatewayCalls('chat').length >= 1);

      expect(applied(execute)).toBe(1);
    });
  });

  it('a plain card is safe to apply on Retry: applying it consumes it', async () => {
    useFloatingChatStore.setState({
      proposal: { id: 'p2', actions: [{ type: 'add_suppression', suppressionPattern: 'gossip', suppressionStrength: 0.9 }] } as unknown as StagedProposal,
    });
    expect(refusedOnRetry('applyProposal')).toBeNull();
  });
});
