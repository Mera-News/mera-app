// The thinking gear a chat call carries (a single-shot agent, or a follow-story harness leg), read off the request the gateway
// received. Every single-shot agent runs thinking OFF: follow a story since 2026-10-14, article chat and
// the cloudChatStream default since 2026-10-22 (run-singleshot-corpus: same pass rate, far faster turns).
import { FollowStoryAgent } from '@/lib/llm/agents/FollowStoryAgent';
import { CHAT_MAX_OUTPUT_TOKENS } from '@/lib/llm/constants';
import { FIXTURE_ACCOUNT, mockGateway, server, signInFixtureAccount } from '@/test/helpers';
import { isRouteLeg, reply, resetChatModules, toolCall } from '@/test/integration/chat/_helpers';
import { captureChatBodies } from '@/test/integration/chat/streaming/support';
import { articleAgent, attachCloud, settle, turnDone } from './kit';

jest.setTimeout(60_000);

afterEach(settle);

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
});

async function firstChatBody(agent: Parameters<typeof attachCloud>[0], text: string) {
  const bodies = captureChatBodies();
  const { engine } = await attachCloud(agent);
  engine.send(text);
  await turnDone();
  return JSON.parse(bodies[0]);
}

describe('thinking gear per single-shot agent', () => {
  it('follow a story runs the harness loop: the route leg and the skill leg both send thinking off', async () => {
    server.use(...mockGateway((c) => (isRouteLeg(c) ? reply('One moment.', toolCall('load_skill', { id: 'conversation/follow-story' })) : 'Which story?')));
    const bodies = captureChatBodies();
    const { engine } = await attachCloud(new FollowStoryAgent(FIXTURE_ACCOUNT.userId));
    engine.send('I want to follow a story');
    await turnDone();
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const raw of bodies) {
      const body = JSON.parse(raw);
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(body.max_tokens).toBe(CHAT_MAX_OUTPUT_TOKENS);
    }
  });

  it('article chat sends thinking off and the answer budget with no reasoning headroom', async () => {
    const body = await firstChatBody(articleAgent(), 'Why was this shown to me?');
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.max_tokens).toBe(CHAT_MAX_OUTPUT_TOKENS);
  });
});
