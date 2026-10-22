// lib/llm/prewarm.ts against the gateway mock: what a launch really sends. Real attestation fetches,
// real JWT, real limiter, real cloudComplete. prewarm keeps a 30-minute dedupe in module state, so
// every test runs on its own fake date, three hours after the last (a later date than any earlier
// test's, or the previous test's warm-up would still be inside its window).
import { getJwtToken, invalidateJwtCache } from '@/lib/auth-client';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { BIG_MODEL, SMALL_MODEL } from '@/lib/llm/constants';
import { prewarmCloudChat } from '@/lib/llm/prewarm';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import {
  attestationRequests,
  gatewayCalls,
  http,
  HttpResponse,
  mockGateway,
  resetAuthState,
  server,
  signInFixtureAccount,
} from '@/test/helpers';
import { useStrictClock } from '@/test/integration/chat/_helpers';
import { advanceUntil, captureChatBodies, drive, installChatHooks, loggerSpies, respond } from './support';

installChatHooks();

let clock = Date.UTC(2026, 9, 9);
beforeEach(() => {
  clock += 3 * 3600_000;
  useStrictClock(clock);
});
afterEach(() => {
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
});

/** Let everything prewarm started finish, then long enough for anything it should NOT send to show up. */
async function settled(): Promise<void> {
  await advanceUntil(() => gatewayCalls('chat').length >= 1, 60_000);
  await jest.advanceTimersByTimeAsync(20_000);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}
async function quiet(ms = 20_000): Promise<void> {
  for (let t = 0; t < ms; t += 500) {
    await jest.advanceTimersByTimeAsync(500);
    await new Promise((r) => setImmediate(r));
  }
}
const requestCounter = () => {
  let n = 0;
  server.events.on('request:start', () => (n += 1));
  return () => n;
};

describe('prewarmCloudChat, cloud mode, signed in', () => {
  it('attests BIG and SMALL once each and sends one tiny throwaway completion to BIG: nothing else', async () => {
    const bodies = captureChatBodies();
    server.use(...mockGateway(respond('ok')));

    expect(prewarmCloudChat()).toBeUndefined();
    await settled();

    // Exactly the two primaries, which since 2026-09-16 are also each other's fallback.
    expect(attestationRequests(BIG_MODEL)).toBe(1);
    expect(attestationRequests(SMALL_MODEL)).toBe(1);
    expect(attestationRequests()).toBe(2);
    expect(gatewayCalls().map((c) => c.route)).toEqual(['chat']);
    const [call] = gatewayCalls('chat');
    expect(call).toMatchObject({ model: BIG_MODEL, stream: false });
    expect(call.messages).toEqual([
      { role: 'system', content: '' },
      { role: 'user', content: 'hi' },
    ]);
    const body = JSON.parse(bodies[0]);
    expect(body).toMatchObject({ model: BIG_MODEL, max_tokens: 1, temperature: 0 });
    // Sealed: the prompt is not on the wire in clear.
    expect(body.messages.map((m: { content: string }) => m.content)).not.toContain('hi');
  });

  it('dedupes the model warm-up inside the 30-minute window, and warms again after it', async () => {
    server.use(...mockGateway(respond('ok')));
    prewarmCloudChat();
    await settled();
    prewarmCloudChat();
    await quiet();
    // Attestation is cached, the completion is deduped to the same window.
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(attestationRequests()).toBe(2);

    await jest.advanceTimersByTimeAsync(31 * 60_000);
    prewarmCloudChat();
    await advanceUntil(() => gatewayCalls('chat').length === 2, 60_000);
    await quiet();
    expect(gatewayCalls('chat')).toHaveLength(2);
    expect(attestationRequests(BIG_MODEL)).toBe(2);
    expect(attestationRequests(SMALL_MODEL)).toBe(2);
  });

  it('swallows a failing secondary attestation: the primary is still warmed', async () => {
    server.use(
      http.get('*/api/attestation/report', ({ request }) =>
        new URL(request.url).searchParams.get('model') === SMALL_MODEL
          ? new HttpResponse('nope', { status: 403 })
          : undefined,
      ),
      ...mockGateway(respond('ok')),
    );
    expect(() => prewarmCloudChat()).not.toThrow();
    await settled();
    expect(attestationRequests(BIG_MODEL)).toBe(1);
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([BIG_MODEL]);
  });

  it('swallows every attestation failing: nothing throws and no completion is sent', async () => {
    server.use(http.get('*/api/attestation/report', () => new HttpResponse('nope', { status: 403 })));
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      expect(() => prewarmCloudChat()).not.toThrow();
      await quiet();
      jest.useRealTimers();
      await new Promise((r) => setTimeout(r, 20));
      expect(gatewayCalls()).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('swallows a failing completion: nothing throws, and the window stays claimed', async () => {
    server.use(...mockGateway(respond({ status: 400, body: 'inference down' })));
    expect(() => prewarmCloudChat()).not.toThrow();
    await settled();
    expect(gatewayCalls('chat')).toHaveLength(1);
    // Silent: a failed warm-up is no Sentry event.
    expect(loggerSpies().captureException).not.toHaveBeenCalled();
    expect(loggerSpies().captureMessage).not.toHaveBeenCalled();
  });
});

describe('prewarmCloudChat, the cases where it stays quiet', () => {
  it('sends nothing at all under on-device processing', async () => {
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
    const requests = requestCounter();
    expect(prewarmCloudChat()).toBeUndefined();
    await quiet();
    expect(requests()).toBe(0);
    expect(gatewayCalls()).toEqual([]);
    expect(attestationRequests()).toBe(0);
  });

  it('signed out: no gateway request, no throw, and the window is released for after sign-in', async () => {
    resetAuthState();
    invalidateJwtCache();
    expect(() => prewarmCloudChat()).not.toThrow();
    await quiet();
    expect(gatewayCalls()).toEqual([]);
    expect(attestationRequests()).toBe(0);

    // Auth now available: the released claim lets the next call warm.
    await drive(signInFixtureAccount());
    invalidateJwtCache();
    prewarmCloudChat();
    await settled();
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([BIG_MODEL]);
  });

  it('a token endpoint that errors reads as no credential: nothing is sent, nothing throws', async () => {
    invalidateJwtCache();
    server.use(http.get('*/api/auth/token', () => new HttpResponse('boom', { status: 500 })));
    await expect(drive(getJwtToken())).resolves.toBeNull();
    expect(() => prewarmCloudChat()).not.toThrow();
    await quiet();
    expect(gatewayCalls()).toEqual([]);
    expect(attestationRequests()).toBe(0);
  });
});
