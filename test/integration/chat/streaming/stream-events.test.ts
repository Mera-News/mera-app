// cloudChatStream: what the stream yields (text, think tags, reasoning, bad frames, buffered replies,
// a provider tool call in clear) and what the request body carries. Real E2EE both ways against the
// gateway mock. Cases the harness test already holds, by name:
//   harness/gateway.test.ts > chat: streamed > "%s: sealed both ways, one attestation" (text, finish, curve rules)
//   harness/gateway.test.ts > chat: streamed > "reasoning_content is signalled once and never shown"
//   harness/gateway.test.ts > chat: streamed > "a body the upstream buffers (ignoreStream) is still decrypted"
import { BIG_MODEL, CHAT_REASONING_HEADROOM_TOKENS, SMALL_MODEL } from '@/lib/llm/constants';
import { cloudChatStream, type SseEvent } from '@/lib/llm/cloudComplete';
import { gatewayCalls, mockGateway, server } from '@/test/helpers';
import {
  captureChatBodies,
  collect,
  delta,
  DONE,
  frame,
  installChatHooks,
  loggerSpies,
  MESSAGES,
  rawChat,
  rawJson,
  respond,
  SECRET_SYSTEM,
  SECRET_USER,
  textOf,
} from './support';

installChatHooks();

const run = (extra: object = {}) => collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, ...extra }));
const textDeltas = (events: SseEvent[]) => events.flatMap((e) => (e.type === 'text-delta' ? [e.delta] : []));

describe('text deltas', () => {
  it('arrive in order, then exactly one finish: the trailing usage chunk adds nothing', async () => {
    server.use(...mockGateway(respond({ chunks: ['One ', 'two ', 'three.'] })));
    expect(await run()).toEqual([
      { type: 'text-delta', delta: 'One ' },
      { type: 'text-delta', delta: 'two ' },
      { type: 'text-delta', delta: 'three.' },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('a think block split across chunks is removed whole and the answer survives', async () => {
    server.use(
      ...mockGateway(
        respond({ chunks: ['<thi', 'nk>trace</think>Your parents', ' live in Bhopal. </th', 'ink>'] }),
      ),
    );
    const events = await run();
    const deltas = textDeltas(events);
    expect(deltas.join('')).toBe('Your parents live in Bhopal. ');
    expect(deltas.every((d) => d.length > 0)).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('a stray closing tag goes alone and keeps the text around it', async () => {
    server.use(...mockGateway(respond({ chunks: ['Bhopal. </think>'] })));
    expect(textOf(await run())).toBe('Bhopal. ');
  });

  it('an opener that is never closed is dropped as a tag and its text is released at the end', async () => {
    server.use(...mockGateway(respond({ chunks: ['<think>an answer nobody closed'] })));
    expect(textOf(await run())).toBe('an answer nobody closed');
  });

  it('a chunk that is all reasoning yields no delta at all, not an empty one', async () => {
    server.use(...mockGateway(respond({ chunks: ['<think>', 'only thinking', '</think>', 'Answer.'] })));
    const events = await run();
    expect(events).toEqual([
      { type: 'text-delta', delta: 'Answer.' },
      { type: 'finish', reason: 'stop' },
    ]);
  });
});

describe('reasoning_content on the wire', () => {
  it('is signalled once, before the first visible delta, never decrypted, and a trace resuming mid-answer does not re-signal', async () => {
    // The reasoning payloads are NOT envelopes: decrypting any of them would throw.
    const { handler } = rawChat((seal) => [
      delta({ content: null, reasoning_content: 'not-an-envelope-1' }),
      delta({ content: null, reasoning_content: 'not-an-envelope-2' }),
      delta({ content: seal('hexA ') }),
      delta({ content: null, reasoning_content: 'not-an-envelope-3' }),
      delta({ content: seal('hexB') }, 'stop'),
      DONE,
    ]);
    server.use(handler);
    expect(await run()).toEqual([
      { type: 'reasoning' },
      { type: 'text-delta', delta: 'hexA ' },
      { type: 'text-delta', delta: 'hexB' },
      { type: 'finish', reason: 'stop' },
    ]);
  });
});

describe('frames the client must survive', () => {
  it('skips an unparseable payload and a keep-alive comment, then carries on', async () => {
    const { handler } = rawChat((seal) => [
      'data: {not json\n\n',
      ': keep-alive comment\n\n',
      delta({ content: seal('hexA') }, 'stop'),
      DONE,
    ]);
    server.use(handler);
    expect(await run()).toEqual([
      { type: 'text-delta', delta: 'hexA' },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('reassembles a frame split across network chunks', async () => {
    const { handler } = rawChat((seal) => {
      const whole = delta({ content: seal('hexAll') }, 'stop');
      return [whole.slice(0, 20), whole.slice(20), DONE];
    });
    server.use(handler);
    expect(await run()).toEqual([
      { type: 'text-delta', delta: 'hexAll' },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('an empty-content preamble and a usage trailer with no choices are tolerated', async () => {
    const { handler } = rawChat((seal) => [
      delta({ content: '', reasoning_content: null, role: 'assistant' }),
      delta({ content: seal('hexA') }),
      delta({}, 'stop'),
      frame({ choices: [], usage: { total_tokens: 9 } }),
      DONE,
    ]);
    server.use(handler);
    expect(await run()).toEqual([
      { type: 'text-delta', delta: 'hexA' },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('a stream that ends without [DONE] still finishes', async () => {
    const { handler } = rawChat((seal) => [delta({ content: seal('no done marker') }, 'stop')]);
    server.use(handler);
    expect(await run()).toEqual([
      { type: 'text-delta', delta: 'no done marker' },
      { type: 'finish', reason: 'stop' },
    ]);
  });
});

describe('buffered replies with nothing to say', () => {
  it('empty content yields only a finish', async () => {
    server.use(...mockGateway(respond({ chunks: [''], ignoreStream: true })));
    expect(await run()).toEqual([{ type: 'finish', reason: 'stop' }]);
  });

  it.each([
    ['empty', { choices: [] }],
    ['absent', {}],
  ])('choices %s yields only a finish', async (_name, body) => {
    server.use(rawJson(() => body).handler);
    expect(await run()).toEqual([{ type: 'finish', reason: 'stop' }]);
  });
});

describe('a provider tool call in CLEAR (never expected, never silently dropped)', () => {
  it('streamed: forwarded on the offset slot, reported once, no content in the report', async () => {
    const { handler } = rawChat(() => [
      delta({ tool_calls: [{ index: 0, id: 'tc-1', function: { name: 'proposeTrack', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }),
      delta({}, 'tool_calls'),
      DONE,
    ]);
    server.use(handler);
    const events = await run();
    const tools = events.filter((e) => e.type === 'tool-call-delta');
    // The offset keeps fragments together and out of any slot a parsed call would take.
    expect(tools).toHaveLength(3);
    expect(tools[0]).toMatchObject({ index: 1000, id: 'tc-1', name: 'proposeTrack', argumentsDelta: '' });
    expect(tools[1]).toMatchObject({ index: 1000, argumentsDelta: '{"a":' });
    expect(tools[2]).toMatchObject({ index: 1000, argumentsDelta: '1}' });
    const { captureMessage } = loggerSpies();
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage.mock.calls[0][1]).toMatchObject({ fingerprint: ['e2ee-cleartext-tool-call'] });
    expect(JSON.stringify(captureMessage.mock.calls)).not.toContain('{"a":');
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it('buffered: each call on its own offset slot', async () => {
    const call = (id: string, name: string, args: string) => ({ id, type: 'function', function: { name, arguments: args } });
    server.use(
      rawJson(() => ({
        choices: [
          {
            message: { content: '', tool_calls: [call('tc-1', 'update_persona', '{"key":"val"}'), call('tc-2', 'another_tool', '{"x":1}')] },
            finish_reason: 'tool_calls',
          },
        ],
      })).handler,
    );
    const events = await run();
    expect(events.filter((e) => e.type === 'tool-call-delta')).toEqual([
      { type: 'tool-call-delta', index: 1000, id: 'tc-1', name: 'update_persona', argumentsDelta: '{"key":"val"}' },
      { type: 'tool-call-delta', index: 1001, id: 'tc-2', name: 'another_tool', argumentsDelta: '{"x":1}' },
    ]);
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it('buffered text and a provider call together yield both', async () => {
    server.use(
      rawJson((seal) => ({
        choices: [
          {
            message: {
              content: seal('Doing it.'),
              tool_calls: [{ id: 'tc', type: 'function', function: { name: 'f', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })).handler,
    );
    const events = await run();
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'tool-call-delta', 'finish']);
    expect(textOf(events)).toBe('Doing it.');
  });
});

describe('the request body', () => {
  it('carries stream true and thinking on by default, on SMALL_MODEL, with none of the optional fields', async () => {
    const bodies = captureChatBodies();
    server.use(...mockGateway(respond('ok')));
    await run({ model: undefined });
    const body = JSON.parse(bodies[0]);
    expect(body.stream).toBe(true);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(body.model).toBe(SMALL_MODEL);
    for (const k of ['temperature', 'max_tokens', 'max_completion_tokens', 'top_p', 'n', 'presence_penalty', 'frequency_penalty']) {
      expect(body).not.toHaveProperty(k);
    }
    expect(gatewayCalls('chat')[0]).toMatchObject({ model: SMALL_MODEL, stream: true });
  });

  it('forwards the optional numeric fields, adding the reasoning headroom to the answer budget', async () => {
    const bodies = captureChatBodies();
    server.use(...mockGateway(respond('ok')));
    await run({ temperature: 0.9, maxTokens: 256, topP: 0.95, presencePenalty: 0.1, frequencyPenalty: 0.2, n: 2 });
    const body = JSON.parse(bodies[0]);
    expect(body).toMatchObject({ temperature: 0.9, top_p: 0.95, presence_penalty: 0.1, frequency_penalty: 0.2, n: 2 });
    expect(body.max_tokens).toBe(256 + CHAT_REASONING_HEADROOM_TOKENS);
  });

  it('forwards maxCompletionTokens untouched, and enableThinking false', async () => {
    const bodies = captureChatBodies();
    server.use(...mockGateway(respond('ok')));
    await run({ maxCompletionTokens: 512, enableThinking: false });
    const body = JSON.parse(bodies[0]);
    expect(body.max_completion_tokens).toBe(512);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('sends the model the caller names', async () => {
    server.use(...mockGateway(respond('ok')));
    await run({ model: BIG_MODEL });
    expect(gatewayCalls('chat')[0].model).toBe(BIG_MODEL);
  });

  it('seals every message and leaves the caller\'s array untouched', async () => {
    const bodies = captureChatBodies();
    server.use(...mockGateway(respond('ok')));
    const mine = [
      { role: 'system' as const, content: SECRET_SYSTEM },
      { role: 'user' as const, content: SECRET_USER },
    ];
    await collect(cloudChatStream({ messages: mine, model: SMALL_MODEL }));
    expect(mine).toEqual(MESSAGES);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('SENTINEL');
    expect(gatewayCalls('chat')[0].messages.map((m) => m.content)).toEqual([SECRET_SYSTEM, SECRET_USER]);
  });
});
