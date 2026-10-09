// Tools travel as TEXT inside the encrypted content, in both directions. Real crypto: the outbound
// bytes are searched for every sentinel and the model side (the mock) decrypts them as the positive
// control. The mock also records a violation, which fails the test in afterEach, if any of the six
// cleartext tool keys ever reaches the wire.
//
// Covers lib/llm/__tests__/cloudChatStream-sealed.test.ts and the tools-as-text cases of
// lib/llm/__tests__/cloudComplete.test.ts > cloudChatStream.
import { SMALL_MODEL } from '@/lib/llm/constants';
import { cloudChatStream, type SseEvent } from '@/lib/llm/cloudComplete';
import { FORBIDDEN_TOOL_KEYS } from '@/lib/llm/text-tool-protocol';
import { gatewayCalls, mockGateway, server } from '@/test/helpers';
import {
  captureChatBodies,
  collect,
  installChatHooks,
  loggerSpies,
  MESSAGES,
  respond,
  textOf,
} from './support';

installChatHooks();

const FACT = 'SENTINEL_FACT_7f3a';
const PLACE = 'SENTINEL_PLACE_91bc';
const TOOL_NAME = 'sentinelToolName_42';

const tool = (name: string, properties: Record<string, unknown> = { statement: { type: 'string' } }) => ({
  type: 'function' as const,
  function: { name, description: 'Save a fact.', parameters: { type: 'object' as const, properties } },
});
const callXml = (name: string, params: Record<string, string>) =>
  `<tool_call>\n<function=${name}>\n${Object.entries(params)
    .map(([k, v]) => `<parameter=${k}>\n${v}\n</parameter>\n`)
    .join('')}</function>\n</tool_call>`;
const toolCalls = (events: SseEvent[]) => events.filter((e) => e.type === 'tool-call-delta');
const last = (events: SseEvent[]) => events[events.length - 1];

describe('the outbound request', () => {
  it.each(['ed25519', 'ecdsa'] as const)(
    '%s: schema, choice and replayed calls ride inside the encrypted content, and the model can read all of it',
    async (curve) => {
      const bodies = captureChatBodies();
      server.use(...mockGateway(respond('ok'), { curve: { [SMALL_MODEL]: curve } }));
      await collect(
        cloudChatStream({
          model: SMALL_MODEL,
          messages: [
            { role: 'system', content: 'You are Mera.' },
            { role: 'user', content: `I live in ${PLACE}` },
            {
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: TOOL_NAME, arguments: JSON.stringify({ statement: FACT }) } },
              ],
            },
            { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ saved: FACT }) },
          ],
          tools: [tool(TOOL_NAME)],
          toolChoice: 'required',
        }),
      );

      const [call] = gatewayCalls('chat');
      expect(gatewayCalls('chat')).toHaveLength(1);
      expect(bodies).toHaveLength(1);
      // Negative: nothing the schema, the call or the result said is on the wire, in body or headers.
      const wire = `${bodies[0]}\n${JSON.stringify(call.headers)}`;
      for (const s of [FACT, PLACE, TOOL_NAME, 'call_1', 'tool_call', 'required', 'You are Mera']) {
        expect(wire).not.toContain(s);
      }
      const body = JSON.parse(bodies[0]) as { messages: object[] };
      for (const key of FORBIDDEN_TOOL_KEYS) expect(JSON.stringify(body)).not.toContain(`"${key}"`);
      for (const m of body.messages) expect(Object.keys(m).sort()).toEqual(['content', 'role']);
      // Positive control: the model side opened it and found everything, as text.
      expect(call.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
      expect(call.messages[0].content).toContain('You are Mera.');
      expect(call.messages[0].content).toContain(`<name>${TOOL_NAME}</name>`);
      expect(call.messages[0].content).toContain('This reply must contain at least one <tool_call>.');
      expect(call.messages[1].content).toContain(PLACE);
      expect(call.messages[2].content).toContain(`<function=${TOOL_NAME}>`);
      expect(call.messages[2].content).toContain(FACT);
      expect(call.messages[3].content).toContain('<tool_response>');
      expect(call.messages[3].content).toContain(FACT);
    },
  );

  it('an empty tools array adds no tools block and no tool key', async () => {
    server.use(...mockGateway(respond('ok')));
    await collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, tools: [] }));
    expect(gatewayCalls('chat')[0].messages).toEqual(MESSAGES);
  });

  it('no tools and no tool choice leaves the system prompt exactly as given', async () => {
    server.use(...mockGateway(respond('ok')));
    await collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, toolChoice: 'required' }));
    expect(gatewayCalls('chat')[0].messages).toEqual(MESSAGES);
  });
});

describe('calls parsed out of the encrypted reply', () => {
  it('a call split across deltas yields one whole call, keeps the call out of the visible text, and the finish is rewritten to tool_calls', async () => {
    const reply = `Noted.\n${callXml('saveExtractedFacts', { statement: 'Lives in Porto' })}`;
    server.use(...mockGateway(respond({ chunks: reply.match(/.{1,5}/gs) as string[], finishReason: 'stop' })));
    const events = await collect(
      cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, tools: [tool('saveExtractedFacts')] }),
    );
    expect(textOf(events)).toBe('Noted.\n');
    expect(toolCalls(events)).toEqual([
      expect.objectContaining({ index: 0, name: 'saveExtractedFacts', argumentsDelta: '{"statement":"Lives in Porto"}' }),
    ]);
    // The provider said `stop`: it never saw a call. The app reports tool_calls.
    expect(last(events)).toEqual({ type: 'finish', reason: 'tool_calls' });
    expect(loggerSpies().captureMessage).not.toHaveBeenCalled();
  });

  it('several calls yield one whole call each, indexed 0..n with distinct ids', async () => {
    const reply = `On it.\n${callXml('one', { a: 'x' })}\n${callXml('two', { b: 'y' })}\n${callXml('three', { c: 'z' })}`;
    server.use(...mockGateway(respond({ chunks: [reply.slice(0, 40), reply.slice(40)] })));
    const events = await collect(
      cloudChatStream({
        messages: MESSAGES,
        model: SMALL_MODEL,
        tools: [tool('one', { a: { type: 'string' } }), tool('two', { b: { type: 'string' } }), tool('three', { c: { type: 'string' } })],
      }),
    );
    const calls = toolCalls(events) as { index: number; id: string; name: string; argumentsDelta: string }[];
    expect(calls.map((c) => [c.index, c.name, c.argumentsDelta])).toEqual([
      [0, 'one', '{"a":"x"}'],
      [1, 'two', '{"b":"y"}'],
      [2, 'three', '{"c":"z"}'],
    ]);
    expect(new Set(calls.map((c) => c.id)).size).toBe(3);
    // Only whitespace is left between the calls.
    expect(textOf(events).trim()).toBe('On it.');
    expect(last(events)).toEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it('a call written inside a think block never yields', async () => {
    const reply = `<think>maybe ${callXml('saveExtractedFacts', { statement: 'ghost' })}</think>Nothing to save.`;
    server.use(...mockGateway(respond({ chunks: reply.match(/.{1,7}/gs) as string[] })));
    const events = await collect(
      cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, tools: [tool('saveExtractedFacts')] }),
    );
    expect(toolCalls(events)).toEqual([]);
    expect(textOf(events)).toBe('Nothing to save.');
    expect(last(events)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('stream false is honoured, and a call in the one buffered envelope parses the same way', async () => {
    server.use(...mockGateway(respond(`Ok.${callXml('f', { x: '1' })}`)));
    const events = await collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, stream: false }));
    expect(gatewayCalls('chat')[0].stream).toBe(false);
    expect(events).toEqual([
      { type: 'text-delta', delta: 'Ok.' },
      expect.objectContaining({ type: 'tool-call-delta', index: 0, name: 'f', argumentsDelta: '{"x":1}' }),
      { type: 'finish', reason: 'tool_calls' },
    ]);
  });

  it('a buffered reply from an upstream that ignores stream true parses calls too', async () => {
    server.use(...mockGateway(respond({ chunks: ['Ok.', callXml('f', { x: 'v' })], ignoreStream: true })));
    const events = await collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL }));
    expect(gatewayCalls('chat')[0].stream).toBe(true);
    expect(textOf(events)).toBe('Ok.');
    expect(toolCalls(events)).toEqual([expect.objectContaining({ index: 0, name: 'f', argumentsDelta: '{"x":"v"}' })]);
    expect(last(events)).toEqual({ type: 'finish', reason: 'tool_calls' });
  });
});
