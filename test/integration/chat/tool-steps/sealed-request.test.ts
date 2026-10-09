// NO PLAINTEXT TOOL DATA LEAVES THE PHONE, checked with REAL crypto (item 5). Successor of
// lib/llm/__tests__/cloudChatStream-sealed.test.ts, which this replaces.
//
// The request is captured as the network saw it (URL, every header, the body text) while the
// gateway mock, standing in for the model, decrypts it with the real primitives: that decryption
// is the positive control, proving the sentinels were carried inside the envelope rather than
// dropped. Both curves, streamed and buffered.
import { INFERENCE_ENDPOINT } from '@/lib/config/endpoints';
import { cloudChatStream } from '@/lib/llm/cloudComplete';
import { SMALL_MODEL } from '@/lib/llm/constants';
import { FORBIDDEN_TOOL_KEYS } from '@/lib/llm/text-tool-protocol';
import { gatewayCalls, mockGateway, server, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import { collect } from './kit';

jest.setTimeout(30_000);

// Long and distinctive on purpose: a short value ("1", "x") turns up in ciphertext by chance.
const TOOL_NAME = 'sentinelToolName_42f1c9';
const PARAM_A = 'sentinelParamStatement_7a1b';
const PARAM_B = 'sentinelParamPlace_3c9d';
const ARG_A = 'SENTINEL_FACT_7f3a91bc';
const ARG_B = 'SENTINEL_PLACE_91bc7f3a';
const CALL_ID = 'call_sentinel_id_b84e20';
const RESULT = 'SENTINEL_RESULT_5d2e8a41';
const PLACE_TEXT = 'SENTINEL_USER_TEXT_e60b13d7';

const CHAT_PATH = '/v1/chat/completions';

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Promise<string>;
}

/** Every request the network saw on a /v1/chat route, with its body read off a clone. */
function captureChat(): Seen[] {
  const seen: Seen[] = [];
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname.startsWith('/v1/chat')) {
      seen.push({ url: request.url, headers: Object.fromEntries(request.headers.entries()), body: request.clone().text() });
    }
  });
  return seen;
}

/** Every object key anywhere in a parsed JSON value. */
const keysOf = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.flatMap(keysOf)
    : v !== null && typeof v === 'object'
      ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)])
      : [];

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
});
afterEach(() => server.events.removeAllListeners());

describe.each([
  ['ed25519', true],
  ['ed25519', false],
  ['ecdsa', true],
  ['ecdsa', false],
] as const)('%s, stream %s', (curve, stream) => {
  it('the URL, every header and the body hold no tool data; the model side can read all of it', async () => {
    const seen = captureChat();
    server.use(...mockGateway(() => 'ok', { curve: { [SMALL_MODEL]: curve } }));

    await collect(
      cloudChatStream({
        model: SMALL_MODEL,
        stream,
        messages: [
          { role: 'system', content: 'You are Mera.' },
          { role: 'user', content: `I live in ${PLACE_TEXT}` },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: CALL_ID,
                type: 'function',
                function: { name: TOOL_NAME, arguments: JSON.stringify({ [PARAM_A]: ARG_A, [PARAM_B]: ARG_B }) },
              },
            ],
          },
          { role: 'tool', tool_call_id: CALL_ID, content: JSON.stringify({ saved: RESULT }) },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: TOOL_NAME,
              description: 'Save a fact.',
              parameters: { type: 'object', properties: { [PARAM_A]: { type: 'string' }, [PARAM_B]: { type: 'string' } } },
            },
          },
        ],
        toolChoice: 'required',
      }),
    );

    // Exactly one request left the device, to exactly the chat route: no query string, no fragment.
    expect(seen).toHaveLength(1);
    const [req] = seen;
    expect(req.url).toBe(`${INFERENCE_ENDPOINT}${CHAT_PATH}`);
    const parsedUrl = new URL(req.url);
    expect(parsedUrl.search).toBe('');
    expect(parsedUrl.hash).toBe('');

    const bodyText = await req.body;
    const body = JSON.parse(bodyText) as { messages: object[]; stream: boolean };
    // The body is what the mock saw for this leg, and it carries the stream flag asked for.
    expect(body.stream).toBe(stream);
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(gatewayCalls('chat')[0].stream).toBe(stream);
    expect(gatewayCalls('chat')[0].algo).toBe(curve);

    // Negative: not in the URL, not in any header name or value, not in the body.
    const wire = `${req.url}\n${JSON.stringify(req.headers)}\n${bodyText}`;
    for (const s of [
      TOOL_NAME, PARAM_A, PARAM_B, ARG_A, ARG_B, CALL_ID, RESULT, PLACE_TEXT, 'You are Mera',
      'tool_call', '<function=', '<parameter=', '<tool_response>', 'required',
    ]) {
      expect(wire).not.toContain(s);
    }
    // None of the six keys, as a JSON key anywhere in the body, nor quoted in the wire text.
    const keys = keysOf(body);
    for (const key of FORBIDDEN_TOOL_KEYS) {
      expect(keys).not.toContain(key);
      expect(bodyText).not.toContain(`"${key}"`);
    }
    // Messages are role + sealed content only.
    for (const m of body.messages) expect(Object.keys(m).sort()).toEqual(['content', 'role']);

    // Positive control: the model side opened it and found everything, as text. The renderer does
    // not replay the call id at all, so the id is absent on both sides (nothing to carry).
    const [call] = gatewayCalls('chat');
    expect(call.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    for (const m of call.messages) expect(Object.keys(m).sort()).toEqual(['content', 'role']);
    const system = call.messages[0].content;
    expect(system).toContain('You are Mera.');
    expect(system).toContain(`<name>${TOOL_NAME}</name>`);
    expect(system).toContain(`<name>${PARAM_A}</name>`);
    expect(system).toContain(`<name>${PARAM_B}</name>`);
    expect(system).toContain('This reply must contain at least one <tool_call>.');
    expect(call.messages[1].content).toContain(PLACE_TEXT);
    expect(call.messages[2].content).toContain(`<function=${TOOL_NAME}>`);
    expect(call.messages[2].content).toContain(`<parameter=${PARAM_A}>`);
    expect(call.messages[2].content).toContain(ARG_A);
    expect(call.messages[2].content).toContain(ARG_B);
    expect(call.messages[3].content).toContain('<tool_response>');
    expect(call.messages[3].content).toContain(RESULT);
    expect(call.messages.map((m) => m.content).join('\n')).not.toContain(CALL_ID);
  });
});
