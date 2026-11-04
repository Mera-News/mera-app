// One tap Retry on a failed cloud chat turn, through the chat session: the failed text is sent again
// with no second bubble, a wire that holds the user's message once, and one persisted user row.
import {
  canRetryChatTurn,
  resetChatSession,
  retryChatTurn,
  stopChatTurn,
} from '@/lib/chat-session/chat-session';
import { fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import { __resetForTests as resetFallback } from '@/lib/llm/model-fallback';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { gatewayCalls, mockGateway, server, signInFixtureAccount, type GatewayResponder } from '@/test/helpers';
import { resetChatModules, reply, toolCall, until, isRouteLeg, hasToolResult } from '@/test/integration/chat/_helpers';
import { articleAgent, attachCloud, busy, cloud, idle, settle, turnDone } from './kit';

jest.setTimeout(60_000);

afterEach(settle);

beforeEach(async () => {
  resetChatModules();
  resetFallback();
  await signInFixtureAccount();
  useFloatingChatStore.setState({ isExpanded: true, proposal: null, resolvedProposals: {} });
});

const FAIL = { status: 400, body: { error: 'nope' } };

/** Chat calls fail until `heal()`, then answer. Fails fast: a 400 is not retried by the transport. */
function failUntilHealed(): { heal: () => void; respond: GatewayResponder } {
  let healed = false;
  return {
    heal: () => {
      healed = true;
    },
    respond: (call) => (call.route === 'chat' && !healed ? FAIL : call.route === 'chat' ? 'All good now.' : ''),
  };
}

const users = () => cloud().messages.filter((m) => m.role === 'user');

describe('retry on a single-shot agent', () => {
  it('sends the same text with no second bubble, one wire user turn and one persisted user row', async () => {
    const gw = failUntilHealed();
    server.use(...mockGateway(gw.respond));
    const { engine, conversationId } = await attachCloud(articleAgent());
    engine.send('Explain this article');
    await turnDone();

    expect(cloud().error).toMatch(/^Cloud chat failed:/);
    expect(canRetryChatTurn()).toBe(true);
    const failedCalls = gatewayCalls('chat').length;

    gw.heal();
    retryChatTurn();
    expect(canRetryChatTurn()).toBe(false);
    await turnDone();

    expect(cloud().error).toBeNull();
    expect(gatewayCalls('chat').length).toBe(failedCalls + 1);
    expect(users().map((m) => m.content)).toEqual(['Explain this article']);
    expect(cloud().wireMessages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(cloud().messages.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['All good now.']);
    await settle();
    const rows = await fetchMessagesForConversation(conversationId);
    expect(rows.filter((r) => r.role === 'user')).toHaveLength(1);
  });

  it('a retry that fails again can be retried, and the wire still holds one user turn', async () => {
    const gw = failUntilHealed();
    server.use(...mockGateway(gw.respond));
    const { engine } = await attachCloud(articleAgent());
    engine.send('Explain this article');
    await turnDone();
    retryChatTurn();
    await turnDone();

    expect(canRetryChatTurn()).toBe(true);
    gw.heal();
    retryChatTurn();
    await turnDone();

    expect(cloud().error).toBeNull();
    expect(users()).toHaveLength(1);
    expect(cloud().wireMessages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('a new send clears it, and a stop never offers it', async () => {
    const gw = failUntilHealed();
    server.use(...mockGateway(gw.respond));
    const { engine } = await attachCloud(articleAgent());
    engine.send('First');
    await turnDone();
    expect(canRetryChatTurn()).toBe(true);

    gw.heal();
    engine.send('Second');
    expect(canRetryChatTurn()).toBe(false);
    await turnDone();
    retryChatTurn();
    await settle();
    expect(busy()).toBe(false);
    expect(users().map((m) => m.content)).toEqual(['First', 'Second']);

    server.use(...mockGateway(() => ({ chunks: ['Too late.'], headerDelayMs: 3000 })));
    engine.send('Third');
    await until(() => busy(), 2000, 'turn runs');
    stopChatTurn();
    await until(idle, 5000, 'stopped');
    expect(canRetryChatTurn()).toBe(false);
    await new Promise((r) => setTimeout(r, 3500));
  });

  it('is refused while another turn runs, and queues nothing', async () => {
    const gw = failUntilHealed();
    server.use(...mockGateway(gw.respond));
    const { engine } = await attachCloud(articleAgent());
    engine.send('First');
    await turnDone();
    server.use(...mockGateway(() => ({ chunks: ['Slow.'], headerDelayMs: 1500 })));

    retryChatTurn();
    expect(busy()).toBe(true);
    const calls = gatewayCalls('chat').length;
    retryChatTurn();
    expect(canRetryChatTurn()).toBe(false);
    await turnDone();
    await settle();
    expect(gatewayCalls('chat').length).toBe(calls + 1);
  });

  it('is refused on a blocked account', async () => {
    const gw = failUntilHealed();
    server.use(...mockGateway(gw.respond));
    const { engine } = await attachCloud(articleAgent());
    engine.send('First');
    await turnDone();
    useCloudChatStore.getState().setIsBlocked(true);

    expect(canRetryChatTurn()).toBe(false);
    const calls = gatewayCalls('chat').length;
    retryChatTurn();
    await settle();
    expect(gatewayCalls('chat').length).toBe(calls);
    useCloudChatStore.getState().setIsBlocked(false);
  });

  it('a New chat drops it', async () => {
    const gw = failUntilHealed();
    server.use(...mockGateway(gw.respond));
    const { engine } = await attachCloud(articleAgent());
    engine.send('First');
    await turnDone();
    resetChatSession();
    expect(canRetryChatTurn()).toBe(false);
  });
});

describe('retry on the persona loop', () => {
  const route = reply('One moment.', toolCall('load_skill', { id: 'conversation/feed-tuning' }));
  const STAGE = toolCall('proposeChanges', {
    explanation: 'Hides gossip stories.',
    expected_effects: 'Fewer gossip stories.',
    actions: [{ type: 'add_suppression', suppressionPattern: 'celebrity gossip', suppressionStrength: 0.9 }],
  });

  it('removes the empty failed rows, keeps one bubble and answers', async () => {
    const gw = failUntilHealed();
    server.use(...mockGateway(gw.respond));
    const { engine } = await attachCloud();
    engine.send('hello there');
    await turnDone();
    expect(canRetryChatTurn()).toBe(true);

    gw.heal();
    retryChatTurn();
    await turnDone();

    expect(users().map((m) => m.content)).toEqual(['hello there']);
    expect(cloud().messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
  });

  it('keeps a failed turn\'s tool rows and still offers Retry', async () => {
    let healed = false;
    server.use(
      ...mockGateway((call) => {
        if (call.route !== 'chat') return '';
        if (healed) return 'All good now.';
        return isRouteLeg(call) ? route : FAIL;
      }),
    );
    const { engine } = await attachCloud();
    engine.send('hide gossip');
    await turnDone();

    expect(cloud().error).toMatch(/^Cloud chat failed:/);
    const withTools = cloud().messages.filter((m) => (m.toolCalls ?? []).length > 0).map((m) => m.id);
    expect(withTools).toHaveLength(1);
    expect(canRetryChatTurn()).toBe(true);

    healed = true;
    retryChatTurn();
    await turnDone();
    expect(cloud().messages.some((m) => m.id === withTools[0])).toBe(true);
    expect(users()).toHaveLength(1);
  });

  it('is not offered once a mutating tool ran', async () => {
    let turn = 1;
    server.use(
      ...mockGateway((call) => {
        if (call.route !== 'chat') return '';
        if (turn === 1) {
          if (isRouteLeg(call)) return route;
          return hasToolResult(call, 'proposeChanges') ? 'Tap the card.' : reply('Tap the card.', STAGE);
        }
        if (isRouteLeg(call)) return route;
        return hasToolResult(call, 'applyProposal') ? FAIL : toolCall('applyProposal');
      }),
    );
    const { engine } = await attachCloud();
    engine.send('stop showing me celebrity gossip');
    await turnDone();
    turn = 2;
    engine.send('yes');
    await turnDone();

    expect(cloud().error).toMatch(/^Cloud chat failed:/);
    expect(canRetryChatTurn()).toBe(false);
  });
});
