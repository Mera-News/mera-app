// A client that cancels a slow SSE reply mid-way (Stop, a hedge loser) must leave nothing behind:
// the mock used to enqueue into an already-closed stream after a chunkDelayMs wait, which surfaced
// as "Invalid state: ReadableStream is already closed" in whichever test ran next. Timing-dependent:
// these two did not reproduce it locally (chat's stop+hedge suites did, 1 run in 4, and 0 in 6 after
// the fix), so they pin the cancelled-stream contract rather than prove the race.

import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { invalidateJwtCache } from '@/lib/auth-client';
import { SMALL_MODEL } from '@/lib/llm/constants';
import { cloudChatStream, type SseEvent } from '@/lib/llm/cloudComplete';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import { __resetForTests as resetModelFallback } from '@/lib/llm/model-fallback';
import { advanceUntilDone, gatewayCalls, mockGateway, server, signInFixtureAccount, useFakeClock } from '@/test/helpers';

const MESSAGES = [
  { role: 'system' as const, content: 'test system' },
  { role: 'user' as const, content: 'test user' },
];

beforeEach(async () => {
  resetLimiter();
  resetModelFallback();
  clearAttestationCache();
  invalidateJwtCache();
  await signInFixtureAccount();
});

it('cancelling a chunkDelayMs stream mid-way, 20 times, leaks no stream error', async () => {
  server.use(...mockGateway(() => ({ chunks: ['one ', 'two ', 'three ', 'four'], chunkDelayMs: 30 })));
  for (let i = 0; i < 20; i++) {
    resetLimiter(); // the interactive lane spaces calls 1 s apart; this test is about the stream
    const stop = new AbortController();
    const seen: string[] = [];
    const outcome = await (async () => {
      for await (const e of cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, signal: stop.signal }) as AsyncGenerator<SseEvent>) {
        if (e.type === 'text-delta') {
          seen.push(e.delta);
          stop.abort();
        }
      }
      return 'finished';
    })().catch((err: Error) => err.name);
    expect(seen).toEqual(['one ']);
    expect(outcome).toBe('CallerAbortError');
  }
  // Let any late frame of the last cancelled streams land: a leak would fail the test here.
  await new Promise((r) => setTimeout(r, 200));
  expect(gatewayCalls('chat').filter((c) => c.aborted).length).toBeGreaterThan(0);
}, 60_000);

it('cancelling during a long fake-clock chunk gap, then jumping past it, leaks no stream error', async () => {
  useFakeClock('2026-10-09T00:00:00Z');
  server.use(...mockGateway(() => ({ chunks: ['one ', 'two ', 'three '], chunkDelayMs: 20_000 })));
  for (let i = 0; i < 20; i++) {
    resetLimiter();
    const stop = new AbortController();
    const run = (async () => {
      for await (const e of cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, signal: stop.signal }) as AsyncGenerator<SseEvent>) {
        if (e.type === 'text-delta') stop.abort();
      }
    })().catch((err: Error) => err.name);
    expect(await advanceUntilDone(run)).toBe('CallerAbortError');
    await jest.advanceTimersByTimeAsync(60_000); // the pending chunk gap elapses after the cancel
  }
  await jest.advanceTimersByTimeAsync(60_000);
}, 60_000);
