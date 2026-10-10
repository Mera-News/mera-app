// harness-local's gateway lane against the gateway mock: the runner's E2EE path is the app's,
// and nothing about tools ever reaches the wire in clear. Tools travel as text inside the
// encrypted messages (lib/llm/text-tool-protocol), never as a request field.
import {
  fetchModelKey,
  postGatewayCompletion,
  prepareContext,
} from '@/harness-local/adapters/gateway-e2ee-llm';
import { BIG_MODEL } from '@/lib/llm/constants';
import { gatewayCalls, mockGateway, server, takeGatewayViolations } from '@/test/helpers';

const cfg = { inferenceEndpoint: 'https://inference.test', jwt: 'harness-jwt' };

afterEach(() => {
  takeGatewayViolations();
});

it('sends no cleartext tools field even when a caller hands it tools', async () => {
  server.use(...mockGateway(() => 'OK'));
  const ctx = prepareContext(await fetchModelKey(cfg, BIG_MODEL));
  // A plain-JS runner can still pass these; the lane must drop them, not forward them.
  const req = {
    model: BIG_MODEL,
    messages: [{ role: 'user', content: 'Store SENTINEL-TOOLS-7c1 with the tool.' }],
    enableThinking: false,
    tools: [{ type: 'function', function: { name: 'store', parameters: {} } }],
    toolChoice: 'auto' as const,
  };

  const result = await postGatewayCompletion(cfg, ctx, req);

  expect(takeGatewayViolations()).toEqual([]);
  expect(result).toMatchObject({ error: null, content: 'OK', toolCalls: [] });
  expect(gatewayCalls('chat')[0].messages[0].content).toContain('SENTINEL-TOOLS-7c1');
});
