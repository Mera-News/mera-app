// The thinking gear a single-shot agent's chat call carries, read off the request the gateway
// received. Every single-shot agent runs thinking OFF: follow a story since 2026-10-14, article chat and
// the cloudChatStream default since 2026-10-22 (run-singleshot-corpus: same pass rate, far faster turns).
import { FollowStoryAgent } from '@/lib/llm/agents/FollowStoryAgent';
import { CHAT_MAX_OUTPUT_TOKENS } from '@/lib/llm/constants';
import { FIXTURE_ACCOUNT, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';
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
  it('follow a story sends thinking off and the answer budget with no reasoning headroom', async () => {
    const body = await firstChatBody(new FollowStoryAgent(FIXTURE_ACCOUNT.userId), 'the dutch cabinet formation talks');
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.max_tokens).toBe(CHAT_MAX_OUTPUT_TOKENS);
  });

  it('article chat sends thinking off and the answer budget with no reasoning headroom', async () => {
    const body = await firstChatBody(articleAgent(), 'Why was this shown to me?');
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.max_tokens).toBe(CHAT_MAX_OUTPUT_TOKENS);
  });
});
