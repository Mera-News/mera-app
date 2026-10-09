// The hedged race: after HEDGE_DELAY_MS of silence the same request is fired at the model's fallback
// and the two race; the first usable answer wins and the loser is aborted. Fake clock throughout, real
// stack underneath (limiter, attestation, E2EE both ways, the gateway mock).
// Already held by harness/gateway.test.ts > chat: hedge > "a primary silent past HEDGE_DELAY_MS loses to
// the fallback leg, which aborts it": the loser's `aborted` flag, the winner's model, two attestations.
// "ctx follows the winner" is proven below with a different curve per model: a reply decrypted under
// the other leg's key is garbage.
import { MODEL_FALLBACKS, SMALL_MODEL } from '@/lib/llm/constants';
import {
  BUFFERED_HEDGE_DELAY_MS,
  cloudChatStream,
  cloudComplete,
  HEDGE_DELAY_MS,
} from '@/lib/llm/cloudComplete';
import { isFallbackEngaged } from '@/lib/llm/model-fallback';
import { attestationRequests, gatewayCalls, mockGateway, server, useFakeClock } from '@/test/helpers';
import { advanceUntil, captureChatBodies, collect, drive, installChatHooks, loggerSpies, MESSAGES, textOf } from './support';

installChatHooks();

const FALLBACK = MODEL_FALLBACKS[SMALL_MODEL];
const SLOW = 60_000;
const run = (extra: object = {}) => collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, ...extra }));
const fail = (p: Promise<unknown>) => p.then(() => null, (e: Error & { responseBody?: string }) => e);
/** A raw status reply held back for `ms` (the responder's `headerDelayMs` works on any reply). */
const lateStatus = (status: number, body: string, ms: number) => ({ status, body, headerDelayMs: ms });
const lateText = (text: string, ms: number) => ({ chunks: [text], headerDelayMs: ms });
const complete = () =>
  cloudComplete({ systemPrompt: 'sys', prompt: 'p' }, { hedgeAfterMs: HEDGE_DELAY_MS, maxTimeoutAttempts: 1 });

beforeEach(() => useFakeClock('2026-10-09T00:00:00Z'));

describe('when the hedge fires', () => {
  it('a primary that answers before the delay wins, and the fallback is never even attested', async () => {
    server.use(...mockGateway((c) => lateText('primary', c.model === SMALL_MODEL ? 5000 : 1)));
    const events = await drive(run());
    await jest.advanceTimersByTimeAsync(3 * HEDGE_DELAY_MS);

    expect(textOf(events)).toBe('primary');
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(attestationRequests(FALLBACK)).toBe(0);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(loggerSpies().captureMessage).not.toHaveBeenCalled();
  });

  it('a silent primary is raced at HEDGE_DELAY_MS, not before: the fallback leg builds only behind its timer', async () => {
    server.use(...mockGateway((c) => (c.model === SMALL_MODEL ? lateText('slow', SLOW) : 'fast')));
    const outcome = run();
    await advanceUntil(() => gatewayCalls('chat').length === 1);
    await jest.advanceTimersByTimeAsync(HEDGE_DELAY_MS - 2000 - Date.now() % 1000);
    expect(attestationRequests(FALLBACK)).toBe(0);
    await advanceUntil(() => attestationRequests(FALLBACK) === 1, 5000);
    expect(textOf(await drive(outcome))).toBe('fast');
  });

  it('the fallback wins on its own curve, the loser is aborted, the session fallback engages once, and the NEXT call goes straight to it', async () => {
    server.use(
      ...mockGateway((c) => (c.model === SMALL_MODEL ? lateText('slow', SLOW) : 'fast'), {
        curve: { [SMALL_MODEL]: 'ed25519', [FALLBACK]: 'ecdsa' },
      }),
    );
    const bodies = captureChatBodies();
    const events = await drive(run());

    // 'fast' opened under the hedge leg's own ecdsa key; the primary's ed25519 key would give garbage.
    expect(textOf(events)).toBe('fast');
    const [primary, hedge] = gatewayCalls('chat');
    expect(primary).toMatchObject({ model: SMALL_MODEL, algo: 'ed25519', aborted: true });
    expect(hedge).toMatchObject({ model: FALLBACK, algo: 'ecdsa', aborted: false });
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
    const { captureMessage } = loggerSpies();
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      'NEAR primary model slow — hedged fallback won, session fallback engaged',
      {
        level: 'warning',
        tags: { model: SMALL_MODEL, fallback: FALLBACK },
        fingerprint: ['near-model-fallback', 'hedge', SMALL_MODEL],
      },
    );

    // Engaged: nothing left to race against, so no timer and no second request.
    const next = await drive(run());
    await jest.advanceTimersByTimeAsync(3 * HEDGE_DELAY_MS);
    expect(textOf(next)).toBe('fast');
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([SMALL_MODEL, FALLBACK, FALLBACK]);
    for (const b of bodies) expect(b).not.toContain('SENTINEL');
  });

  it('a primary that answers after the hedge fired still wins: the hedge is aborted and nothing engages', async () => {
    server.use(...mockGateway((c) => lateText(c.model === SMALL_MODEL ? 'from primary' : 'from hedge', c.model === SMALL_MODEL ? 14_000 : SLOW)));
    const events = await drive(run());

    expect(textOf(events)).toBe('from primary');
    expect(gatewayCalls('chat').map((c) => [c.model, c.aborted])).toEqual([
      [SMALL_MODEL, false],
      [FALLBACK, true],
    ]);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(loggerSpies().captureMessage).not.toHaveBeenCalled();
  });

  it('aborting the loser reports no model failure and leaks no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      server.use(...mockGateway((c) => (c.model === SMALL_MODEL ? lateText('slow', SLOW) : 'fast')));
      await drive(run());
      jest.useRealTimers();
      await new Promise((r) => setTimeout(r, 20));

      expect(unhandled).toEqual([]);
      // Exactly the hedge-win warning: the loser's own abort was never classified as the model failing.
      expect(loggerSpies().captureMessage).toHaveBeenCalledTimes(1);
      expect(loggerSpies().captureMessage.mock.calls[0][1].level).toBe('warning');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a buffered call (stream false) hedges at BUFFERED_HEDGE_DELAY_MS, not at 10s', async () => {
    server.use(...mockGateway((c) => (c.model === SMALL_MODEL ? lateText('slow', 2 * BUFFERED_HEDGE_DELAY_MS) : 'fast')));
    const outcome = run({ stream: false });
    await advanceUntil(() => gatewayCalls('chat').length === 1);
    await jest.advanceTimersByTimeAsync(HEDGE_DELAY_MS + 5000);
    // Well past the streamed hedge delay and the fallback has not even been attested.
    expect(attestationRequests(FALLBACK)).toBe(0);
    expect(gatewayCalls('chat')).toHaveLength(1);

    await advanceUntil(() => attestationRequests(FALLBACK) === 1, BUFFERED_HEDGE_DELAY_MS);
    const events = await drive(outcome);
    expect(textOf(events)).toBe('fast');
    expect(gatewayCalls('chat').map((c) => [c.model, c.stream])).toEqual([
      [SMALL_MODEL, false],
      [FALLBACK, false],
    ]);
  });
});

describe('when a leg fails', () => {
  it('a primary 4xx after the hedge fired surfaces the 4xx, and the fallback never masks it', async () => {
    server.use(...mockGateway((c) => (c.model === SMALL_MODEL ? lateStatus(400, 'bad request', 14_000) : lateText('masking', SLOW))));
    const outcome = fail(run());
    await drive(outcome);
    const err = await outcome;

    expect(err).toMatchObject({ message: 'E2EE chat failed: 400', responseBody: 'bad request' });
    expect(gatewayCalls('chat').map((c) => [c.model, c.aborted])).toEqual([
      [SMALL_MODEL, false],
      [FALLBACK, true],
    ]);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });

  it('a hedge failure is swallowed: the primary keeps going and nothing engages', async () => {
    server.use(...mockGateway((c) => (c.model === SMALL_MODEL ? lateText('primary anyway', 14_000) : { status: 400, body: 'hedge said no' })));
    const events = await drive(run());

    expect(textOf(events)).toBe('primary anyway');
    expect(gatewayCalls('chat')).toHaveLength(2);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
    expect(loggerSpies().captureMessage).not.toHaveBeenCalled();
  });

  it('when both legs fail the PRIMARY failure is what surfaces, once', async () => {
    server.use(...mockGateway((c) => (c.model === SMALL_MODEL ? lateStatus(400, 'primary said no', 14_000) : { status: 400, body: 'hedge said no' })));
    const outcome = fail(run());
    await drive(outcome);
    const err = await outcome;

    expect(err).toMatchObject({ message: 'E2EE chat failed: 400', responseBody: 'primary said no' });
    expect(gatewayCalls('chat')).toHaveLength(2);
  });

  it('a timeout-class primary failure after the hedge fired engages, but fires NO third request', async () => {
    server.use(...mockGateway((c) => (c.model === SMALL_MODEL ? lateStatus(502, 'gateway timeout', 12_000) : lateText('rescued', 8000))));
    const outcome = complete();
    await drive(outcome);

    // The in-flight hedge IS the retry: the sequential tail must not run.
    expect(await outcome).toBe('rescued');
    expect(gatewayCalls('chat')).toHaveLength(2);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
    expect(loggerSpies().captureMessage).toHaveBeenCalledTimes(1);
    expect(loggerSpies().captureMessage).toHaveBeenCalledWith(
      'NEAR primary model failing — session fallback engaged',
      expect.objectContaining({ level: 'error', fingerprint: ['near-model-fallback', 'timeout', SMALL_MODEL] }),
    );
  });

  it('a fast 502 exhaustion before the hedge fires is identical to the sequential path', async () => {
    server.use(...mockGateway((c) => (c.index < 2 ? { status: 502 } : 'recovered')));
    const outcome = cloudComplete({ systemPrompt: 'sys', prompt: 'p' }, { hedgeAfterMs: HEDGE_DELAY_MS });
    await drive(outcome);

    expect(await outcome).toBe('recovered');
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([SMALL_MODEL, SMALL_MODEL, FALLBACK]);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
  });
});

describe('when there is nothing to race', () => {
  it('a caller that does not ask for a hedge never gets one', async () => {
    server.use(...mockGateway(() => lateText('late', 3 * HEDGE_DELAY_MS)));
    const outcome = cloudComplete({ systemPrompt: 'sys', prompt: 'p' }, { maxTimeoutAttempts: 1 });
    await drive(outcome);

    expect(await outcome).toBe('late');
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(attestationRequests(FALLBACK)).toBe(0);
  });

  it('a model with no configured fallback is never hedged', async () => {
    server.use(...mockGateway(() => lateText('late', 3 * HEDGE_DELAY_MS)));
    const outcome = cloudComplete(
      { systemPrompt: 'sys', prompt: 'p', model: 'some/model-with-no-fallback' },
      { hedgeAfterMs: HEDGE_DELAY_MS, maxTimeoutAttempts: 1 },
    );
    await drive(outcome);

    expect(await outcome).toBe('late');
    expect(gatewayCalls('chat')).toHaveLength(1);
  });

  it('once the session fallback is engaged there is nothing left to race against', async () => {
    server.use(...mockGateway((c) => (c.model === SMALL_MODEL ? lateText('slow', SLOW) : lateText('steady', 3 * HEDGE_DELAY_MS))));
    await drive(complete().catch(() => null));
    // (the first call above hedged and engaged; this one must run alone on the fallback)
    const before = gatewayCalls('chat').length;
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
    const second = complete();
    await drive(second);
    expect(await second).toBe('steady');
    expect(gatewayCalls('chat').slice(before).map((c) => c.model)).toEqual([FALLBACK]);
  });
});
