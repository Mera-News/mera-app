// NO PLAINTEXT TOOL DATA LEAVES THE PHONE, checked with REAL crypto.
//
// cloudComplete.test mocks the envelope as `enc(...)`, which can show where a
// field went but not that it was sealed. Here the request is encrypted with the
// app's own primitives toward a test "model" key, so the outbound bytes can be
// searched for every sentinel, and the model side can decrypt them to prove the
// sentinels were carried rather than dropped (the positive control).

const mockFetch = jest.fn<Promise<Response>, unknown[]>();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('@/lib/auth-client', () => ({
  getJwtToken: jest.fn(() => Promise.resolve('test-jwt')),
  invalidateJwtCache: jest.fn(),
}));
jest.mock('@/lib/e2ee/e2ee-cache', () => ({
  invalidateCachedAttestation: jest.fn(),
  getCachedAttestation: jest.fn(() => ({ signing_public_key: 'cached' })),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));
jest.mock('@/lib/config/endpoints', () => ({ INFERENCE_ENDPOINT: 'https://inference.example.test' }));
jest.mock('../gateway-rate-limiter', () => ({
  acquire: jest.fn().mockResolvedValue(undefined),
  pauseFor: jest.fn(),
  INTERACTIVE_MAX_PAUSE_MS: 2000,
  interactiveWaitMs: () => 0,
}));

// The model's keypair, and the app's real envelope toward it. Built inside the
// factory (it is hoisted above every const) and exposed as `__model`.
jest.mock('@/lib/e2ee/e2ee-service', () => {
  const crypto = jest.requireActual('@/lib/e2ee/e2ee-crypto');
  const { ed25519 } = jest.requireActual('@noble/curves/ed25519.js');
  const modelPriv = ed25519.utils.randomSecretKey();
  const mockModel = { priv: modelPriv, pubHex: Buffer.from(ed25519.getPublicKey(modelPriv)).toString('hex') };
  const clientPriv = ed25519.utils.randomSecretKey();
  const clientPubHex = Buffer.from(ed25519.getPublicKey(clientPriv)).toString('hex');
  const ctx = {
    modelPubKeyHex: mockModel.pubHex,
    privateKey: clientPriv,
    clientPubKeyHex: clientPubHex,
    algo: 'ed25519',
    headers: crypto.buildE2EEHeaders('ed25519', clientPubHex, mockModel.pubHex),
  };
  return {
    __model: mockModel,
    encryptContent: (s: string) => crypto.encryptContent(s, ctx),
    decryptContent: crypto.decryptContent,
    prepareE2EEContext: async () => ctx,
    encryptMessages: async (messages: { content: string }[]) => {
      for (const m of messages) if (m.content.length > 0) m.content = crypto.encryptContent(m.content, ctx);
      return ctx;
    },
  };
});

import { decryptContent } from '@/lib/e2ee/e2ee-crypto';
import { cloudChatStream } from '../cloudComplete';

const FACT = 'SENTINEL_FACT_7f3a';
const PLACE = 'SENTINEL_PLACE_91bc';
const TOOL_NAME = 'sentinelToolName_42';

function jsonResponse(): Response {
  return {
    status: 200,
    statusText: '200',
    ok: true,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
    text: () => Promise.resolve(''),
  } as unknown as Response;
}

it('the outbound request carries no tool data in clear, and the model can read all of it', async () => {
  mockFetch.mockResolvedValueOnce(jsonResponse());
  const events = cloudChatStream({
    messages: [
      { role: 'system', content: 'You are Mera.' },
      { role: 'user', content: `I live in ${PLACE}` },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: TOOL_NAME, arguments: JSON.stringify({ statement: FACT }) } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ saved: FACT }) },
    ],
    tools: [
      {
        type: 'function',
        function: { name: TOOL_NAME, description: 'Save a fact.', parameters: { type: 'object', properties: { statement: { type: 'string' } } } },
      },
    ],
    toolChoice: 'required',
  });
  for await (const _ of events) {
    // drain
  }

  const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
  const wire = `${url}\n${JSON.stringify(init.headers)}\n${init.body as string}`;
  for (const s of [FACT, PLACE, TOOL_NAME, 'call_1', '"tools"', '"tool_choice"', '"tool_calls"', '"tool_call_id"', 'tool_call', 'required']) {
    expect(wire).not.toContain(s);
  }

  // Positive control: what the model decrypts holds every sentinel.
  const body = JSON.parse(init.body as string) as { messages: { role: string; content: string }[] };
  const model = jest.requireMock('@/lib/e2ee/e2ee-service').__model as { priv: Uint8Array };
  const seen = body.messages.map((m) => decryptContent(m.content, model.priv, 'ed25519')).join('\n');
  for (const s of [FACT, PLACE, TOOL_NAME, '<tool_call>', 'must contain at least one <tool_call>']) {
    expect(seen).toContain(s);
  }
});
