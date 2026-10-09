// The real app clients against the gateway mock: E2EE both ways through
// lib/e2ee/e2ee-crypto, SSE with one envelope per chunk, async jobs, fault injection.

import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { BIG_MODEL, SMALL_MODEL } from '@/lib/llm/constants';
import { invalidateJwtCache } from '@/lib/auth-client';
import { prepareE2EEContext } from '@/lib/e2ee/e2ee-service';
import {
  CallerAbortError,
  cloudBatchComplete,
  cloudChatStream,
  cloudComplete,
  RateLimitedError,
  STREAM_IDLE_TIMEOUT_MS,
  type SseEvent,
} from '@/lib/llm/cloudComplete';
import { sendInferenceRequest } from '@/lib/llm/submitInferenceJob';
import { fetchResults, toBatchResult } from '@/lib/services/inference-results';
import { searchWeb, searchWebBatch } from '@/lib/web-search/web-search-client';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import { __resetForTests as resetModelFallback } from '@/lib/llm/model-fallback';
import { LOAD_SKILL_TOOL } from '@/lib/mera-harness/core/tool-contracts';
import { parseBatchRelevanceResponse } from '@/lib/news-harness/article-pipeline/scoring';
import type { ServerResults } from '@/lib/services/inference-results';
import {
  advanceUntilDone,
  assertNoGatewayViolations,
  attestationRequests,
  gatewayCalls,
  gatewayViolations,
  http,
  HttpResponse,
  mockGateway,
  server,
  signInFixtureAccount,
  takeGatewayViolations,
  useFakeClock,
  type GatewayResponder,
} from '@/test/helpers';
import { TEST_MODEL_KEYS } from '@/test/mock-backend/gateway/keys';

const ORIGIN = 'http://127.0.0.1:8790';
const SECRET_SYSTEM = 'SENTINEL-SYSTEM-7f3a you are the test model';
const SECRET_USER = 'SENTINEL-USER-91bc what is the news';
const MESSAGES = [
  { role: 'system' as const, content: SECRET_SYSTEM },
  { role: 'user' as const, content: SECRET_USER },
];

async function collect(gen: AsyncGenerator<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}
const text = (events: SseEvent[]) =>
  events.flatMap((e) => (e.type === 'text-delta' ? [e.delta] : [])).join('');
const respond = (r: ReturnType<GatewayResponder>): GatewayResponder => () => r;

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  for (let t = 0; t < ms && !cond(); t += 10) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error('until: condition not met');
}

beforeEach(async () => {
  resetLimiter();
  resetModelFallback();
  clearAttestationCache();
  invalidateJwtCache();
  await signInFixtureAccount();
});

afterEach(() => {
  server.events.removeAllListeners();
  assertNoGatewayViolations();
});

describe('chat: streamed', () => {
  it.each(['ed25519', 'ecdsa'] as const)('%s: sealed both ways, one attestation', async (curve) => {
    const rawBodies: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/v1/chat/completions')) void request.clone().text().then((t) => rawBodies.push(t));
    });
    server.use(...mockGateway(respond({ chunks: ['Hello ', 'there, ', 'world.'] }), { curve: { [SMALL_MODEL]: curve } }));

    const events = await collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, enableThinking: false }));

    expect(text(events)).toBe('Hello there, world.');
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'stop' });
    const [call] = gatewayCalls('chat');
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(call).toMatchObject({ model: SMALL_MODEL, stream: true, algo: curve, aborted: false });
    expect(call.messages.map((m) => m.content)).toEqual([SECRET_SYSTEM, SECRET_USER]);
    expect(rawBodies).toHaveLength(1);
    expect(rawBodies[0]).not.toContain('SENTINEL');
    expect(attestationRequests(SMALL_MODEL)).toBe(1);
    // The curve rules the mock enforced: version header iff ed25519, 65-byte point for ecdsa.
    if (curve === 'ecdsa') {
      expect(call.headers).not.toHaveProperty('x-encryption-version');
      expect(call.headers['x-client-pub-key']).toMatch(/^04[0-9a-f]{128}$/);
    } else {
      expect(call.headers['x-encryption-version']).toBe('2');
      expect(call.headers['x-client-pub-key']).toHaveLength(64);
    }
    expect(call.headers['x-model-pub-key']).toBe(TEST_MODEL_KEYS[curve].publicKeyHex);
    expect(gatewayViolations()).toEqual([]);
  });

  it('the default responder answers the persona route leg with the load_skill XML', async () => {
    const events = await collect(
      cloudChatStream({
        messages: [
          { role: 'system', content: 'You are Mera.\n## Skill index\n- conversation/question' },
          { role: 'user', content: 'hi' },
        ],
        tools: [LOAD_SKILL_TOOL],
        model: SMALL_MODEL,
        enableThinking: false,
      }),
    );
    const calls = events.filter((e) => e.type === 'tool-call-delta');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'load_skill', argumentsDelta: '{"id":"conversation/question"}' });
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it('reasoning_content is signalled once and never shown', async () => {
    server.use(...mockGateway(respond({ chunks: ['Answer.'], reasoning: true })));
    const events = await collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL }));
    expect(events.filter((e) => e.type === 'reasoning')).toHaveLength(1);
    expect(text(events)).toBe('Answer.');
  });

  it('a body the upstream buffers (ignoreStream) is still decrypted', async () => {
    server.use(...mockGateway(respond({ chunks: ['Buffered ', 'answer.'], ignoreStream: true })));
    const events = await collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL }));
    expect(text(events)).toBe('Buffered answer.');
  });
});

describe('chat: buffered', () => {
  it('cloudComplete returns the decrypted completion', async () => {
    server.use(...mockGateway(respond('Buffered reply.')));
    await expect(cloudComplete({ systemPrompt: SECRET_SYSTEM, prompt: SECRET_USER, model: SMALL_MODEL })).resolves.toBe(
      'Buffered reply.',
    );
    expect(gatewayCalls('chat')[0]).toMatchObject({ stream: false });
    expect(gatewayCalls('chat')[0].messages.map((m) => m.content)).toEqual([SECRET_SYSTEM, SECRET_USER]);
  });

  it('cloudBatchComplete seals every item', async () => {
    server.use(...mockGateway((c) => `echo:${c.messages[1].content}`));
    const out = await cloudBatchComplete(
      [
        { id: 'a', system: 'sys', prompt: 'one' },
        { id: 'b', system: 'sys', prompt: 'two' },
      ],
      SMALL_MODEL,
    );
    expect(out).toEqual([
      { id: 'a', output: 'echo:one' },
      { id: 'b', output: 'echo:two' },
    ]);
    expect(gatewayCalls('batch').map((c) => c.messages[1].content)).toEqual(['one', 'two']);
  });

  it('a perItem status fails only that batch item', async () => {
    server.use(
      ...mockGateway((c) =>
        c.messages[1].content === 'two'
          ? { status: 502, body: { error: 'upstream timed out' }, perItem: true }
          : `echo:${c.messages[1].content}`,
      ),
    );
    const out = await cloudBatchComplete(
      [
        { id: 'a', system: 'sys', prompt: 'one' },
        { id: 'b', system: 'sys', prompt: 'two' },
        { id: 'c', system: 'sys', prompt: 'three' },
      ],
      SMALL_MODEL,
    );
    expect(out).toEqual([
      { id: 'a', output: 'echo:one' },
      { id: 'b', output: '', error: 'upstream timed out' },
      { id: 'c', output: 'echo:three' },
    ]);
  });
});

describe('chat: faults', () => {
  it('400 Decryption failed once: the client re-attests and recovers', async () => {
    server.use(
      ...mockGateway((c) =>
        c.index === 0
          ? { status: 400, body: { error: `Provider failed for model '${c.model}': Decryption failed` } }
          : 'recovered',
      ),
    );
    const events = await collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL }));
    expect(text(events)).toBe('recovered');
    expect(gatewayCalls('chat')).toHaveLength(2);
    expect(attestationRequests(SMALL_MODEL)).toBe(2);
  });

  it('429 with Retry-After 1s on the interactive lane: one retry, then RateLimitedError', async () => {
    server.use(...mockGateway(respond({ status: 429, headers: { 'Retry-After': '1' } })));
    const err = await collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL })).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err).toMatchObject({ statusCode: 429, retryAfterMs: 1000 });
    expect(gatewayCalls('chat')).toHaveLength(2);
  });

  it('429 with a long Retry-After is not waited out', async () => {
    server.use(...mockGateway(respond({ status: 429, headers: { 'Retry-After': '30' } })));
    const err = await collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL })).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(gatewayCalls('chat')).toHaveLength(1);
  });

  it('the stream closes after one chunk: text arrived, so the error surfaces', async () => {
    server.use(...mockGateway(respond({ chunks: ['partial ', 'never'], closeAfter: 1 })));
    const seen: string[] = [];
    const run = async () => {
      for await (const e of cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL })) {
        if (e.type === 'text-delta') seen.push(e.delta);
      }
    };
    await expect(run()).rejects.toThrow();
    expect(seen).toEqual(['partial ']);
    expect(gatewayCalls('chat')).toHaveLength(1);
  });

  it('finish_reason length is reported by the client as a plain stop', async () => {
    server.use(...mockGateway(respond({ chunks: ['cut off mid-sen'], finishReason: 'length' })));
    const events = await collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL }));
    expect(text(events)).toBe('cut off mid-sen');
    // The client collapses everything but tool_calls to 'stop'; truncation is not signalled.
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('502 surfaces as E2EE chat failed with the body on responseBody only', async () => {
    server.use(...mockGateway(respond({ status: 502, body: { error: 'upstream gone' } })));
    const err = await collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL })).catch((e) => e);
    expect(err.message).toBe('E2EE chat failed: 502');
    expect(err.responseBody).toContain('upstream gone');
  });
});

describe('chat: fake clock', () => {
  async function runWithGap(gapMs: number) {
    server.use(...mockGateway(respond({ chunks: ['first ', 'second'], chunkDelayMs: gapMs })));
    const seen: string[] = [];
    const outcome = (async () => {
      for await (const e of cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL })) {
        if (e.type === 'text-delta') seen.push(e.delta);
      }
    })().then(
      () => 'finished',
      (e: Error) => e.message,
    );
    await advanceUntilDone(outcome);
    return { result: await outcome, seen };
  }

  it('a gap above STREAM_IDLE_TIMEOUT_MS after the first chunk ends the stream, without hanging', async () => {
    useFakeClock('2026-10-09T00:00:00Z');
    const { result, seen } = await runWithGap(STREAM_IDLE_TIMEOUT_MS + 1000);
    expect(result).toBe('[CloudLLM] chat stream went idle');
    expect(seen).toEqual(['first ']);
  });

  it('a gap just under it is waited out', async () => {
    useFakeClock('2026-10-09T00:00:00Z');
    const { result, seen } = await runWithGap(STREAM_IDLE_TIMEOUT_MS - 1000);
    expect(result).toBe('finished');
    expect(seen).toEqual(['first ', 'second']);
  });
});

describe('chat: hedge', () => {
  it('a primary silent past HEDGE_DELAY_MS loses to the fallback leg, which aborts it', async () => {
    server.use(
      ...mockGateway((c) => (c.model === SMALL_MODEL ? { chunks: ['slow'], headerDelayMs: 60_000 } : 'fast')),
    );
    useFakeClock('2026-10-09T00:00:00Z');
    const seen: string[] = [];
    const outcome = (async () => {
      for await (const e of cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL })) {
        if (e.type === 'text-delta') seen.push(e.delta);
      }
    })();
    await advanceUntilDone(outcome);
    await outcome;
    expect(seen).toEqual(['fast']);
    const [primary, hedge] = gatewayCalls('chat');
    expect(primary).toMatchObject({ model: SMALL_MODEL, aborted: true });
    expect(hedge).toMatchObject({ model: expect.not.stringMatching(SMALL_MODEL), aborted: false });
    expect(attestationRequests()).toBe(2);
  });
});

describe('chat: abort', () => {
  it('a caller abort mid-stream marks the recorded call aborted', async () => {
    server.use(...mockGateway(respond({ chunks: ['one ', 'two'], stallAfter: 1 })));
    const stop = new AbortController();
    const run = (async () => {
      for await (const e of cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, signal: stop.signal })) {
        if (e.type === 'text-delta') stop.abort();
      }
    })();
    await expect(run).rejects.toBeInstanceOf(CallerAbortError);
    await until(() => gatewayCalls('chat')[0]?.aborted === true);
    expect(gatewayCalls('chat')).toHaveLength(1);
  });
});

describe('async jobs', () => {
  const article = (n: number) => `<<ARTICLE ${String(n).padStart(12, 'a')}>>\nbody ${n}\n<</ARTICLE ${String(n).padStart(12, 'a')}>>`;

  it('submit, poll (pending first), decode: every relevance call decodes to 0.9s', async () => {
    server.use(...mockGateway((c) => (c.callId?.startsWith('score:') ? '[0.9,0.9]' : ''), { pendingPolls: 1 }));
    // The default responder is covered below; this one pins the text so the decode is exact.
    const ctx = await prepareE2EEContext(SMALL_MODEL);
    const calls = [
      { id: 'score:0', system: 'shared relevance system', prompt: `${article(1)}\n${article(2)}` },
      { id: 'score:1', system: 'shared relevance system', prompt: `${article(3)}\n${article(4)}` },
    ];
    const sent = await sendInferenceRequest({
      bundle: { calls } as never,
      ctx,
      token: null,
      model: SMALL_MODEL,
      context: 'foreground',
      idempotencyKey: 'key-1',
    });
    if (sent.status !== 'ok') throw new Error(`submit ${sent.status}`);
    expect(gatewayCalls('job').map((c) => c.callId)).toEqual(['score:0', 'score:1']);
    // sharedSystem was hoisted and decrypted back into each call.
    expect(gatewayCalls('job')[0].messages[0]).toEqual({ role: 'system', content: 'shared relevance system' });

    expect(await fetchResults(sent.requestId, 'foreground', sent.capabilityToken)).toBe('pending');
    const results = (await fetchResults(sent.requestId, 'foreground', sent.capabilityToken)) as ServerResults;
    for (const row of results.results) {
      const { output } = toBatchResult(row, ctx.privateKey, ctx.algo);
      expect(parseBatchRelevanceResponse(output, 2, row.id)).toEqual([0.9, 0.9]);
    }

    // A replay of the same Idempotency-Key is the same job.
    const again = await sendInferenceRequest({
      bundle: { calls } as never, ctx, token: null, model: SMALL_MODEL, context: 'foreground', idempotencyKey: 'key-1',
    });
    expect(again).toMatchObject({ status: 'ok', requestId: sent.requestId });
    expect(gatewayCalls('job')).toHaveLength(2);
  });

  it('the default responder counts the article fences', async () => {
    const ctx = await prepareE2EEContext(SMALL_MODEL);
    const sent = await sendInferenceRequest({
      bundle: { calls: [{ id: 'score:0', system: 's', prompt: [1, 2, 3].map(article).join('\n') }] } as never,
      ctx, token: null, model: SMALL_MODEL, context: 'foreground',
    });
    if (sent.status !== 'ok') throw new Error(`submit ${sent.status}`);
    const results = (await fetchResults(sent.requestId, 'foreground', sent.capabilityToken)) as ServerResults;
    const { output } = toBatchResult(results.results[0], ctx.privateKey, ctx.algo);
    expect(parseBatchRelevanceResponse(output, 3, 'score:0')).toEqual([0.9, 0.9, 0.9]);
  });

  it('unknown id is not-found; a capability token for another job is unauthorized', async () => {
    expect(await fetchResults('0'.repeat(24), 'foreground')).toBe('not-found');
    const ctx = await prepareE2EEContext(SMALL_MODEL);
    const sent = await sendInferenceRequest({
      bundle: { calls: [{ id: 'reason:x', system: 's', prompt: 'p' }] } as never,
      ctx, token: null, model: SMALL_MODEL, context: 'background', capabilityToken: 'cap.someone-else',
    });
    // background submit authenticates with the capability token alone, which the mock accepts for any bearer.
    expect(sent.status).toBe('ok');
    if (sent.status !== 'ok') return;
    expect(await fetchResults(sent.requestId, 'background', 'cap.000000000000000000000099')).toBe('unauthorized');
  });
});

describe('search routes', () => {
  it('searchWeb and searchWebBatch get 2 default results per query', async () => {
    const one = await searchWeb('mera news');
    expect(one).toMatchObject({ ok: true });
    if (one.ok) expect(one.results).toHaveLength(2);
    const many = await searchWebBatch(['first query', 'second query']);
    expect(many.ok && many.searches.map((s) => s.results?.length)).toEqual([2, 2]);
    expect(gatewayCalls('web-search').map((c) => c.messages[0].content)).toEqual([
      'mera news',
      'first query',
      'second query',
    ]);
  });

  it('503 search-unavailable passes through and is not an empty result', async () => {
    server.use(...mockGateway(respond({ status: 503, body: { code: 'search-unavailable' } })));
    expect(await searchWeb('mera news')).toMatchObject({ ok: false, status: 503, code: 'search-unavailable' });
  });

  it('fact-check-claims answers claimReviews', async () => {
    const res = await fetch(`${ORIGIN}/v1/fact-check-claims`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'the moon is cheese' }),
    });
    const body = (await res.json()) as { claimReviews: { claim: string }[] };
    expect(body.claimReviews[0].claim).toBe('the moon is cheese');
    expect(gatewayCalls('fact-check-claims')).toHaveLength(1);
  });
});

describe('attestation', () => {
  it('rejects an unauthenticated request and serves the captured report when a nonce is sent', async () => {
    expect((await fetch(`${ORIGIN}/api/attestation/report?model=m&signing_algo=ed25519`)).status).toBe(401);
    const res = await fetch(`${ORIGIN}/api/attestation/report?model=m&nonce=ab`, { headers: { Authorization: 'Bearer t' } });
    const body = (await res.json()) as { model_attestations: { signing_public_key: string }[] };
    expect(body.model_attestations[0].signing_public_key).toMatch(/^aba45f0b/);
    expect(attestationRequests()).toBe(0);
  });

  it('a per-test override replaces the route', async () => {
    server.use(http.get('*/api/attestation/report', () => HttpResponse.text('nope', { status: 403 })));
    await expect(prepareE2EEContext(BIG_MODEL)).rejects.toThrow(/403/);
  });
});

describe('violation detector (positive controls)', () => {
  const validHeaders = {
    Authorization: 'Bearer t',
    'Content-Type': 'application/json',
    'X-Signing-Algo': 'ed25519',
    'X-Client-Pub-Key': 'aa'.repeat(32),
    'X-Model-Pub-Key': TEST_MODEL_KEYS.ed25519.publicKeyHex,
    'X-Encryption-Version': '2',
  };
  const post = (headers: Record<string, string>, body: unknown) =>
    fetch(`${ORIGIN}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });

  it('a cleartext tool field is refused and recorded', async () => {
    const res = await post(validHeaders, { model: SMALL_MODEL, messages: [], tools: [{ type: 'function' }] });
    expect(res.status).toBe(500);
    expect(takeGatewayViolations()).toEqual([
      { route: 'chat', rule: 'cleartext tool field "tools" in the request body' },
    ]);
  });

  it('plaintext message content is refused like NEAR does and recorded', async () => {
    const res = await post(validHeaders, { model: SMALL_MODEL, messages: [{ role: 'user', content: 'hello in the clear' }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `Provider failed for model '${SMALL_MODEL}': Decryption failed` });
    expect(takeGatewayViolations()).toHaveLength(1);
  });

  it('a version header on an ecdsa request is refused', async () => {
    server.use(...mockGateway(respond('x'), { curve: { [SMALL_MODEL]: 'ecdsa' } }));
    const res = await post(
      { ...validHeaders, 'X-Signing-Algo': 'ecdsa', 'X-Model-Pub-Key': TEST_MODEL_KEYS.ecdsa.publicKeyHex },
      { model: SMALL_MODEL, messages: [] },
    );
    expect(res.status).toBe(500);
    expect(takeGatewayViolations()[0].rule).toMatch(/X-Encryption-Version/);
  });
});
