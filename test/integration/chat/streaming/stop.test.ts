// The caller's stop (the Stop button): an AbortSignal that reaches the limiter wait, BOTH hedge legs and
// the SSE body, and re-types the cut as CallerAbortError (never a model verdict, never a retry).
// Already held by harness/gateway.test.ts > chat: abort > "a caller abort mid-stream marks the recorded
// call aborted": CallerAbortError, aborted flag, one call. This file adds what that test leaves out.
import { MODEL_FALLBACKS, SMALL_MODEL } from '@/lib/llm/constants';
import { CallerAbortError, cloudChatStream } from '@/lib/llm/cloudComplete';
import { isFallbackEngaged } from '@/lib/llm/model-fallback';
import { attestationRequests, gatewayCalls, mockGateway, server, useFakeClock } from '@/test/helpers';
import { advanceUntil, captureChatBodies, collect, installChatHooks, loggerSpies, MESSAGES, respond, until } from './support';

installChatHooks();

const FALLBACK = MODEL_FALLBACKS[SMALL_MODEL];
const SLOW = 60_000;
const settle = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe('stop before anything is sent', () => {
  it('an already-aborted signal throws CallerAbortError with ZERO requests of any kind', async () => {
    let requests = 0;
    server.events.on('request:start', () => (requests += 1));
    const stop = new AbortController();
    stop.abort();
    const err = await settle(collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, signal: stop.signal })));

    expect(err).toBeInstanceOf(CallerAbortError);
    expect(requests).toBe(0);
    expect(gatewayCalls()).toEqual([]);
    expect(attestationRequests()).toBe(0);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });
});

describe('stop while the hedge race is pending', () => {
  beforeEach(() => useFakeClock('2026-10-09T00:00:00Z'));

  it('before the hedge fires: the primary is aborted and the hedge is never started', async () => {
    server.use(...mockGateway(respond({ chunks: ['slow'], headerDelayMs: SLOW })));
    const stop = new AbortController();
    const outcome = settle(collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, signal: stop.signal })));
    await advanceUntil(() => gatewayCalls('chat').length === 1);
    stop.abort();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(await outcome).toBeInstanceOf(CallerAbortError);
    expect(gatewayCalls('chat').map((c) => c.aborted)).toEqual([true]);
    expect(attestationRequests(FALLBACK)).toBe(0);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });

  it('after the hedge fired: BOTH legs are aborted, and a stop says nothing about the model', async () => {
    server.use(...mockGateway(respond({ chunks: ['slow'], headerDelayMs: SLOW })));
    const stop = new AbortController();
    const outcome = settle(collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, signal: stop.signal })));
    await advanceUntil(() => gatewayCalls('chat').length === 2);
    expect(gatewayCalls('chat').map((c) => [c.model, c.aborted])).toEqual([
      [SMALL_MODEL, false],
      [FALLBACK, false],
    ]);

    stop.abort();
    await jest.advanceTimersByTimeAsync(1000);

    expect(await outcome).toBeInstanceOf(CallerAbortError);
    expect(gatewayCalls('chat').map((c) => c.aborted)).toEqual([true, true]);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(loggerSpies().captureMessage).not.toHaveBeenCalled();
  });
});

describe('stop mid-stream', () => {
  it('after some text: CallerAbortError, the text already yielded stays, no retry, no model verdict', async () => {
    const bodies = captureChatBodies();
    server.use(...mockGateway(respond({ chunks: ['one ', 'two'], stallAfter: 1 })));
    const stop = new AbortController();
    const seen: string[] = [];
    const err = await settle(
      (async () => {
        for await (const e of cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, signal: stop.signal })) {
          if (e.type === 'text-delta') {
            seen.push(e.delta);
            stop.abort();
          }
        }
      })(),
    );

    expect(err).toBeInstanceOf(CallerAbortError);
    expect(seen).toEqual(['one ']);
    await until(() => gatewayCalls('chat')[0]?.aborted === true);
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(loggerSpies().captureMessage).not.toHaveBeenCalled();
    for (const b of bodies) expect(b).not.toContain('SENTINEL');
  });

  it('before any text, with the stream open and silent: still CallerAbortError and NOT the fresh-request retry', async () => {
    // A stream that dies before any text is normally retried once; a stop must not be.
    server.use(...mockGateway(respond({ chunks: ['never'], stallAfter: 0 })));
    const stop = new AbortController();
    const outcome = settle(collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, signal: stop.signal })));
    await until(() => gatewayCalls('chat').length === 1);
    await new Promise((r) => setTimeout(r, 200));
    stop.abort();

    expect(await outcome).toBeInstanceOf(CallerAbortError);
    await until(() => gatewayCalls('chat')[0].aborted);
    await new Promise((r) => setTimeout(r, 1500));
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });
});
