// THE FAIL-CLOSED GUARD, wired inside cloudChatStream's request builder (item 1).
//
// The public request type cannot carry a tool field (the builder turns tools into text), so the
// only way to put a forbidden key on the body is to corrupt the builder's own intermediate
// output: a spy that wraps the REAL toTextToolMessages and adds the key to one message (R23, not a
// module mock). For each of the six keys the request must be refused before any byte is sent.
// Without the guard the gateway mock would answer the call AND record an E2EE violation.
import * as textToolProtocol from '@/lib/llm/text-tool-protocol';
import { cloudChatStream } from '@/lib/llm/cloudComplete';
import { SMALL_MODEL } from '@/lib/llm/constants';
import { CleartextToolDataError, FORBIDDEN_TOOL_KEYS } from '@/lib/llm/text-tool-protocol';
import { gatewayCalls, gatewayViolations, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import { collect } from './kit';

jest.setTimeout(30_000);

const real = textToolProtocol.toTextToolMessages;
let spy: jest.SpyInstance;

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
});
afterEach(() => spy?.mockRestore());

const MESSAGES = [
  { role: 'system' as const, content: 'You are Mera.' },
  { role: 'user' as const, content: 'I live in Porto.' },
];

describe('the six forbidden keys never leave the device', () => {
  it('covers exactly the six keys the protocol lists', () => {
    expect([...FORBIDDEN_TOOL_KEYS]).toEqual(['tools', 'tool_choice', 'tool_calls', 'tool_call_id', 'functions', 'function_call']);
  });

  it.each([...FORBIDDEN_TOOL_KEYS])('%s on a message: cloudChatStream refuses, and nothing is sent', async (key) => {
    spy = jest.spyOn(textToolProtocol, 'toTextToolMessages').mockImplementation((...args) =>
      real(...args).map((m, i, all) => (i === all.length - 1 ? ({ ...m, [key]: [] } as typeof m) : m)),
    );

    const err = await collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL })).then(
      () => null,
      (e: unknown) => e,
    );

    // The spy reached the builder's import binding (otherwise the guard was never exercised).
    expect(spy).toHaveBeenCalled();
    expect(err).toBeInstanceOf(CleartextToolDataError);
    expect((err as CleartextToolDataError).key).toBe(key);
    // Refused before the send: the chat route saw nothing, and the mock recorded no violation.
    expect(gatewayCalls('chat')).toEqual([]);
    expect(gatewayViolations()).toEqual([]);
  });

  it('control: the same request without the injected key is sent and answered', async () => {
    spy = jest.spyOn(textToolProtocol, 'toTextToolMessages');

    const events = await collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL }));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'stop' });
  });
});
