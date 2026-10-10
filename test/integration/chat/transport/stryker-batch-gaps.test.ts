// lib/llm/cloudComplete.ts and lib/llm/on-device-gate.ts: the arms only legacy suites reached.
//  - a gateway call with no JWT available (getAuthHeaders refuses before any request),
//  - a hedged race whose primary failed WITH a response and then has nothing left to race
//    (surfacePrimaryFailure returns that response),
//  - a chat reply with no content-type header at all (treated as buffered, not SSE),
//  - the on-device gate when the protocol store cannot even be loaded.
// Real auth, E2EE both ways, limiter, model fallback and logger; only the network and the
// WatermelonDB native adapter (a native edge) are faked.
import { invalidateJwtCache } from '@/lib/auth-client';
import { SMALL_MODEL } from '@/lib/llm/constants';
import { cloudChatStream, cloudComplete, HEDGE_DELAY_MS } from '@/lib/llm/cloudComplete';
import { prepareE2EEContext } from '@/lib/e2ee/e2ee-service';
import { isFallbackEngaged } from '@/lib/llm/model-fallback';
import {
  attestationRequests,
  gatewayCalls,
  http,
  HttpResponse,
  mockGateway,
  resetAuthState,
  server,
} from '@/test/helpers';
import { sealForClient } from '@/test/mock-backend/gateway/crypto';
import { CHAT_PATH, errorOf, fakeClock, resetTransport, run, watchRequests } from './transport-kit';

const REQUEST = { systemPrompt: 'sys', prompt: 'p' };

beforeEach(async () => {
  await resetTransport();
  fakeClock();
});

afterEach(() => {
  server.events.removeAllListeners();
});

describe('a gateway call with no JWT to send', () => {
  it('refuses before the request is built: cloudComplete throws a clear cause and nothing reaches the chat route', async () => {
    // The attestation is already cached (a warm session), so the credential check inside the key
    // fetch is skipped and the missing JWT is first noticed when the headers are built.
    await run(prepareE2EEContext(SMALL_MODEL));
    expect(attestationRequests(SMALL_MODEL)).toBe(1);
    resetAuthState();
    invalidateJwtCache();
    const chat = watchRequests(CHAT_PATH);

    const err = await errorOf(run(cloudComplete(REQUEST)));

    expect(err?.message).toBe('cloudComplete: no JWT token available');
    expect(chat.count()).toBe(0);
    expect(gatewayCalls('chat')).toEqual([]);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });
});

describe('a hedged race whose primary failed with a response', () => {
  const hedged = () => cloudComplete(REQUEST, { hedgeAfterMs: HEDGE_DELAY_MS, maxTimeoutAttempts: 1 });
  const late = (status: number, body: string, headerDelayMs: number) => ({ status, body, headerDelayMs });

  it('the hedge already failed: the primary 502 is what surfaces', async () => {
    server.use(
      ...mockGateway((c) => (c.model === SMALL_MODEL ? late(502, 'primary timed out', 12_000) : { status: 400, body: 'hedge said no' })),
    );

    const err = await errorOf(run(hedged()));

    expect(err?.message).toContain('502');
    expect(gatewayCalls('chat')).toHaveLength(2);
    // A 502 is timeout-class: the primary still counts as failing even though the hedge had given up.
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
  });

  it('the hedge fails after the primary 502: the primary 502 is what surfaces, not the hedge 400', async () => {
    server.use(
      ...mockGateway((c) => (c.model === SMALL_MODEL ? late(502, 'primary timed out', 12_000) : late(400, 'hedge said no', 14_000))),
    );

    const err = await errorOf(run(hedged()));

    expect(err?.message).toContain('502');
    expect(err?.message).not.toContain('400');
    expect(gatewayCalls('chat')).toHaveLength(2);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
  });
});

describe('a chat reply with no content-type header', () => {
  it('is read as a buffered reply, not an SSE stream', async () => {
    server.use(
      http.post(`*${CHAT_PATH}`, ({ request }) => {
        const pub = request.headers.get('x-client-pub-key') ?? '';
        const algo = request.headers.get('x-signing-algo') === 'ecdsa' ? 'ecdsa' : 'ed25519';
        const body = { choices: [{ message: { content: sealForClient('no header, still sealed', pub, algo) }, finish_reason: 'stop' }] };
        // A byte body gets no default content-type from the platform Response.
        return new HttpResponse(new TextEncoder().encode(JSON.stringify(body)));
      }),
    );

    const events: unknown[] = [];
    const drain = (async () => {
      for await (const e of cloudChatStream({ messages: [{ role: 'user', content: 'hi' }], model: SMALL_MODEL })) events.push(e);
    })();
    await run(drain);

    expect(events).toEqual([
      { type: 'text-delta', delta: 'no header, still sealed' },
      { type: 'finish', reason: 'stop' },
    ]);
  });
});

describe('the on-device gate when the protocol store cannot load', () => {
  // Last in the file: it resets the module registry, which later tests here would not expect.
  it('reads as not on-device (the cloud stays allowed) instead of throwing', async () => {
    // The documented production failure: a module that builds a WatermelonDB collection at load
    // dies with initializeJSI when the native adapter is absent. The gate requires the store lazily
    // and must survive that. The native adapter is the faked edge; the registry is reset so the
    // store and the database load again under it.
    const adapterId = '@nozbe/watermelondb/adapters/sqlite';
    const original = jest.requireMock(adapterId);
    jest.doMock(adapterId, () => ({
      __esModule: true,
      default: class {
        constructor() {
          throw new TypeError("Cannot read properties of undefined (reading 'initializeJSI')");
        }
      },
    }));
    jest.resetModules();
    try {
      const gate = require('@/lib/llm/on-device-gate') as typeof import('@/lib/llm/on-device-gate');
      // Without the guard the store's load error would reject here.
      await expect(gate.isOnDeviceMode()).resolves.toBe(false);
      await expect(gate.assertCloudAllowed()).resolves.toBeUndefined();
    } finally {
      jest.doMock(adapterId, () => original);
      jest.resetModules();
    }
  });
});
