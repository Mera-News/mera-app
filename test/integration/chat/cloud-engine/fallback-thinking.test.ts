// Qwen3.6-35B truncates persona turns with thinking on (12 of 19), so its harness says
// `thinking: false` and the transport forces it off on that profile, whatever the request asked.
import { makeAgentDeps } from '@/lib/chat-tools/agent-device-port';
import { BIG_MODEL, SMALL_MODEL } from '@/lib/llm/constants';
import { PROFILES } from '@/lib/llm/profiles';
import { __resetRouterForTests, reportProfileFailure } from '@/lib/llm/router';
import { mockGateway, server, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import { captureChatBodies } from '@/test/integration/chat/streaming/support';

jest.setTimeout(30_000);

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
  server.use(...mockGateway(() => 'ok'));
});
afterEach(() => __resetRouterForTests());

const req = { role: 'tool' as const, model: 'BIG', systemPrompt: 's', messages: [{ role: 'user' as const, content: 'm' }], enableThinking: true };

describe('thinking per harness', () => {
  it('honours the request on Qwen3.8 and forces thinking off once the router moved to Qwen3.6', async () => {
    const bodies = captureChatBodies();
    const deps = makeAgentDeps('msg', jest.fn());

    await deps.callModel(req);
    expect(JSON.parse(bodies[0])).toMatchObject({ model: BIG_MODEL, chat_template_kwargs: { enable_thinking: true } });

    reportProfileFailure(PROFILES['near/qwen3.8-27b'], 'chat-tools', 'deadline');
    await deps.callModel(req);
    expect(JSON.parse(bodies[1])).toMatchObject({ model: SMALL_MODEL, chat_template_kwargs: { enable_thinking: false } });
  });
});
