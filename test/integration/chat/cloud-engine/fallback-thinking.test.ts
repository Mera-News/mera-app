// The BIG fallback truncates persona turns with thinking on (12 of 19), so the agent adapter forces it
// off while the session fallback is engaged, whatever the request asked for.
import { makeAgentDeps } from '@/lib/chat-tools/agent-device-port';
import { BIG_MODEL } from '@/lib/llm/constants';
import { __resetForTests, isFallbackEngaged, reportModelFailure } from '@/lib/llm/model-fallback';
import { mockGateway, server, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import { captureChatBodies } from '@/test/integration/chat/streaming/support';

jest.setTimeout(30_000);

beforeEach(async () => {
  resetChatModules();
  __resetForTests();
  await signInFixtureAccount();
  server.use(...mockGateway(() => 'ok'));
});
afterEach(() => __resetForTests());

const req = { role: 'tool' as const, model: 'BIG', systemPrompt: 's', messages: [{ role: 'user' as const, content: 'm' }], enableThinking: true };

describe('thinking while the session fallback is engaged', () => {
  it('honours the request on the primary and forces thinking off once the fallback is engaged', async () => {
    const bodies = captureChatBodies();
    const deps = makeAgentDeps('msg', jest.fn());

    await deps.callModel(req);
    expect(JSON.parse(bodies[0]).chat_template_kwargs).toEqual({ enable_thinking: true });

    reportModelFailure(BIG_MODEL);
    expect(isFallbackEngaged(BIG_MODEL)).toBe(true);
    await deps.callModel(req);
    expect(JSON.parse(bodies[1]).chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});
