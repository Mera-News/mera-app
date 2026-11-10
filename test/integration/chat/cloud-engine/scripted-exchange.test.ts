// The onboarding questionnaire's fixed lines and its one forced turn, through the chat session: a
// scripted exchange costs no model call and starts no turn, its rows are read by the next real turn,
// and forcedSkill rides one send. Real engine, real agents, real persistence, scripted gateway.
import { renderHook } from '@testing-library/react-native';
import {
  canRetryChatTurn,
  retryChatTurn,
  scriptedExchange,
} from '@/lib/chat-session/chat-session';
import { isOnboardingMenuRow } from '@/lib/chat-session/engine';
import { useChatSession } from '@/lib/chat-session/use-chat-session';
import { createConversation, fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import { __resetRouterForTests as resetFallback } from '@/lib/llm/router';
import { FOLLOW_STORY_SKILL } from '@/lib/mera-harness/core/core';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { gatewayCalls, mockGateway, server, signInFixtureAccount } from '@/test/helpers';
import { isRouteLeg, personMessage, reply, resetChatModules, systemOf, toolCall } from '@/test/integration/chat/_helpers';
import { attachCloud, busy, cloud, personaAgent, settle, turnDone } from './kit';

jest.setTimeout(60_000);
afterEach(settle);

beforeEach(async () => {
  resetChatModules();
  resetFallback();
  await signInFixtureAccount();
  useFloatingChatStore.setState({ isExpanded: true, proposal: null, resolvedProposals: {}, toolCallResults: {} });
});

const PROFILE = { user: 'Create my profile', assistant: 'This builds your Feed.\n\nWhat do you do for work?' };
const FOLLOW = { user: 'Follow a story', assistant: 'You will find them in Stories.\n\nWhat story do you want to follow?' };
const OPTIONS = [{ label: 'Ukraine War', search: 'ukraine war' }, { label: 'Ukraine Peace Talks', search: 'ukraine peace talks' }];

/** Routes to `conversation/question` and answers; the follow skill stages a card. */
const gateway = () =>
  mockGateway((c) => {
    if (isRouteLeg(c)) return reply('One moment.', toolCall('load_skill', { id: 'conversation/question' }));
    if (!systemOf(c).includes('wants to follow a news story')) return 'Noted.';
    return c.messages.some((m) => m.content.includes('proposeTrack:'))
      ? 'Pick the stories to follow below.'
      : reply('Pick the stories to follow below.', toolCall('proposeTrack', { options: OPTIONS }));
  });

describe('a scripted exchange', () => {
  it('adds the reader row and Mera row with no model call and no turn', async () => {
    server.use(...gateway());
    await attachCloud(personaAgent());
    await expect(scriptedExchange(PROFILE)).resolves.toBe(true);
    expect(gatewayCalls()).toHaveLength(0);
    expect(cloud().messages.map((m) => [m.role, m.content])).toEqual([['user', PROFILE.user], ['assistant', PROFILE.assistant]]);
    expect(busy()).toBe(false);
    expect(cloud().status).toBe('idle');
    expect(cloud().agentTurnState?.turnNumber).toBe(0);
  });

  it('the reader row is optional', async () => {
    server.use(...gateway());
    await attachCloud(personaAgent());
    await scriptedExchange({ assistant: FOLLOW.assistant });
    expect(cloud().messages.map((m) => m.role)).toEqual(['assistant']);
  });

  it('the next real turn reads the rows: its legs carry the question and the exchange', async () => {
    server.use(...gateway());
    const { engine } = await attachCloud(personaAgent());
    await scriptedExchange(PROFILE);
    engine.send('a nurse');
    await turnDone();
    const route = gatewayCalls('chat')[0];
    const sent = route.messages.map((m) => m.content).join('\n');
    expect(sent).toContain('Your last turn asked: "What do you do for work?"');
    expect(sent).toContain('They said: Create my profile');
    expect(personMessage(route)).toBe('a nurse');
  });

  it('marks the menu row, which survives persistence, in thread order, and other rows stay unmarked', async () => {
    server.use(...gateway());
    const { conversationId } = await attachCloud(personaAgent());
    await scriptedExchange(PROFILE);
    await scriptedExchange({ assistant: 'What would you like to do next?', menu: true });
    const [reader, line, menu] = cloud().messages;
    expect([reader, line, menu].map((m) => isOnboardingMenuRow(m.id))).toEqual([false, false, true]);
    await settle();
    const rows = await fetchMessagesForConversation(conversationId);
    expect(rows.map((r) => r.content)).toEqual([PROFILE.user, PROFILE.assistant, 'What would you like to do next?']);
    expect(rows.map((r) => isOnboardingMenuRow(r.id))).toEqual([false, false, true]);
  });

  it('keeps a real turn on the same thread, and two in a row stay in order', async () => {
    server.use(...gateway());
    const { engine, conversationId } = await attachCloud(personaAgent());
    await scriptedExchange(PROFILE);
    engine.send('a nurse');
    await turnDone();
    await scriptedExchange(FOLLOW);
    await settle();
    const rows = await fetchMessagesForConversation(conversationId);
    expect(rows.filter((r) => r.role === 'user').map((r) => r.content)).toEqual([PROFILE.user, 'a nurse', FOLLOW.user]);
    expect(rows[rows.length - 1].content).toBe(FOLLOW.assistant);
  });

  it('refuses while a turn runs, and adds nothing', async () => {
    server.use(...gateway());
    const { engine } = await attachCloud(personaAgent());
    engine.send('hello there');
    await expect(scriptedExchange(PROFILE)).resolves.toBe(false);
    expect(cloud().messages.map((m) => m.content)).not.toContain(PROFILE.assistant);
    await turnDone();
  });

  it('answers the failure banner like a send: Retry goes and cannot remove the rows', async () => {
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'nope' } })));
    const { engine } = await attachCloud(personaAgent());
    engine.send('hello there');
    await turnDone();
    expect(canRetryChatTurn()).toBe(true);
    await scriptedExchange(PROFILE);
    expect(cloud().error).toBeNull();
    expect(canRetryChatTurn()).toBe(false);
    expect(cloud().messages.at(-1)?.content).toBe(PROFILE.assistant);
  });

  it('with no chat attached it reports that nothing landed', async () => {
    await expect(scriptedExchange(PROFILE)).resolves.toBe(false);
  });
});

describe('forcedSkill on a send', () => {
  it('reaches the follow card with text that fails the word test, then the next send routes', async () => {
    server.use(...gateway());
    const { engine } = await attachCloud(personaAgent());
    await scriptedExchange(FOLLOW);
    engine.send('Ukraine war', { forcedSkill: FOLLOW_STORY_SKILL });
    await turnDone();
    const calls = gatewayCalls('chat');
    expect(calls.some(isRouteLeg)).toBe(false);
    expect(useFloatingChatStore.getState().proposal?.actions.map((a) => (a as { label: string }).label)).toContain('Ukraine War');

    const before = calls.length;
    engine.send('thanks for that');
    await turnDone();
    expect(isRouteLeg(gatewayCalls('chat')[before])).toBe(true);
  });

  it('an ordinary send still routes', async () => {
    server.use(...gateway());
    const { engine } = await attachCloud(personaAgent());
    engine.send('Ukraine war');
    await turnDone();
    expect(isRouteLeg(gatewayCalls('chat')[0])).toBe(true);
  });

  it('a retry of the failed turn is the same turn, so it stays forced', async () => {
    let healed = false;
    server.use(
      ...mockGateway((c) => {
        if (!healed) return { status: 400, body: { error: 'nope' } };
        if (isRouteLeg(c)) return reply('One moment.', toolCall('load_skill', { id: 'conversation/question' }));
        return c.messages.some((m) => m.content.includes('proposeTrack:'))
          ? 'Pick below.'
          : reply('Pick below.', toolCall('proposeTrack', { options: OPTIONS }));
      }),
    );
    const { engine } = await attachCloud(personaAgent());
    engine.send('Ukraine war', { forcedSkill: FOLLOW_STORY_SKILL });
    await turnDone();
    expect(canRetryChatTurn()).toBe(true);
    healed = true;
    const before = gatewayCalls('chat').length;
    expect(retryChatTurn()).toBe(true);
    await turnDone();
    expect(isRouteLeg(gatewayCalls('chat')[before])).toBe(false);
    expect(useFloatingChatStore.getState().proposal).not.toBeNull();
  });

  it('rides the view\'s send', async () => {
    server.use(...gateway());
    const agent = personaAgent();
    const conversationId = await createConversation('CONFIG' as never);
    const { result } = await renderHook(() => useChatSession('cloud', agent, conversationId, undefined));
    result.current.send('Ukraine war', { forcedSkill: FOLLOW_STORY_SKILL });
    await turnDone();
    expect(gatewayCalls('chat').some(isRouteLeg)).toBe(false);
  });
});
