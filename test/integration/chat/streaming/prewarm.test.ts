// lib/llm/prewarm.ts against the gateway mock: what a launch really sends. Real attestation fetches,
// real JWT, real limiter, real cloudComplete. A chat open (`ping`) sends the readiness ping every time
// and drives the header badge's status; app launch (no `ping`) warms attestation and the JWT only.
// Every test runs on its own fake date, three hours after the last, so no client cache carries over.
import { getJwtToken, invalidateJwtCache } from '@/lib/auth-client';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { BIG_MODEL, SMALL_MODEL } from '@/lib/llm/constants';
import { cloudChatStream } from '@/lib/llm/cloudComplete';
import { prewarmCloudChat, useChatReadiness } from '@/lib/llm/prewarm';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
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
import { seedFacts, useStrictClock } from '@/test/integration/chat/_helpers';
import {
  advanceUntil,
  captureChatBodies,
  collect,
  drive,
  installChatHooks,
  loggerSpies,
  MESSAGES,
  respond,
} from './support';

installChatHooks();

let clock = Date.UTC(2026, 9, 9);
beforeEach(() => {
  clock += 3 * 3600_000;
  useStrictClock(clock);
  useChatReadiness.setState({ status: 'idle' });
});
afterEach(() => {
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud, chatInCloud: false });
  useCloudChatStore.getState().reset();
  useUserStore.setState({ userPersona: null });
});

const status = () => useChatReadiness.getState().status;

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
  it('attests BIG and SMALL once each and sends BIG the one fixed ping: nothing else', async () => {
    const bodies = captureChatBodies();
    server.use(...mockGateway(respond('ready')));

    expect(prewarmCloudChat({ ping: true })).toBeUndefined();
    await settled();

    // Exactly the two primaries, which since 2026-09-16 are also each other's fallback.
    expect(attestationRequests(BIG_MODEL)).toBe(1);
    expect(attestationRequests(SMALL_MODEL)).toBe(1);
    expect(attestationRequests()).toBe(2);
    expect(gatewayCalls().map((c) => c.route)).toEqual(['chat']);
    const [call] = gatewayCalls('chat');
    expect(call).toMatchObject({ model: BIG_MODEL, stream: false });
    expect(call.messages).toEqual([
      { role: 'system', content: 'Reply with the single word "ready" and nothing else.' },
      { role: 'user', content: 'ping' },
    ]);
    const body = JSON.parse(bodies[0]);
    expect(body).toMatchObject({
      model: BIG_MODEL,
      max_tokens: 8,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    });
    // Sealed: the prompt is not on the wire in clear.
    expect(bodies[0]).not.toContain('ping');
    expect(bodies[0]).not.toContain('single word');
    expect(status()).toBe('ready');
  });

  it('carries no user data: facts on file stay out, the request is the two constants', async () => {
    await drive(seedFacts(['Lives in Porto', 'Works as a nurse']));
    server.use(...mockGateway(respond('ready')));
    prewarmCloudChat({ ping: true });
    await settled();
    const [call] = gatewayCalls('chat');
    expect(JSON.stringify(call.messages)).not.toMatch(/Porto|nurse|e2e-fixture|English/);
    expect(call.messages).toHaveLength(2);
  });

  it('says warming while the ping is in flight, then ready on any non-empty reply', async () => {
    server.use(...mockGateway(() => ({ chunks: ['Ready!'], headerDelayMs: 5_000 })));
    prewarmCloudChat({ ping: true });
    expect(status()).toBe('warming');
    await advanceUntil(() => gatewayCalls('chat').length === 1, 60_000);
    expect(status()).toBe('warming');
    await advanceUntil(() => status() !== 'warming', 60_000);
    expect(status()).toBe('ready');
  });

  it('an empty reply is an error', async () => {
    server.use(...mockGateway(respond('')));
    prewarmCloudChat({ ping: true });
    await settled();
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(status()).toBe('error');
  });

  it('pings on every open, and concurrent opens fire once', async () => {
    server.use(...mockGateway(respond('ready')));
    prewarmCloudChat({ ping: true });
    prewarmCloudChat({ ping: true });
    await settled();
    expect(gatewayCalls('chat')).toHaveLength(1);

    // A later open, even right after a chat turn, pings again.
    await drive(collect(cloudChatStream({ messages: MESSAGES, model: BIG_MODEL })));
    prewarmCloudChat({ ping: true });
    await advanceUntil(() => gatewayCalls('chat').length === 3, 60_000);
    expect(gatewayCalls('chat')[2].messages[1]).toEqual({ role: 'user', content: 'ping' });
    expect(attestationRequests(BIG_MODEL)).toBe(1);
  });

  it('app launch (no ping) attests and mints a JWT but sends no model call', async () => {
    server.use(...mockGateway(respond('ok')));
    prewarmCloudChat();
    await quiet();
    expect(gatewayCalls('chat')).toHaveLength(0);
    expect(attestationRequests(BIG_MODEL)).toBe(1);
    expect(status()).toBe('idle');
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
    expect(() => prewarmCloudChat({ ping: true })).not.toThrow();
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
      expect(() => prewarmCloudChat({ ping: true })).not.toThrow();
      await quiet();
      jest.useRealTimers();
      await new Promise((r) => setTimeout(r, 20));
      expect(gatewayCalls()).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a failing completion is an error, and silent: nothing throws, no Sentry event', async () => {
    server.use(...mockGateway(respond({ status: 400, body: 'inference down' })));
    expect(() => prewarmCloudChat({ ping: true })).not.toThrow();
    await settled();
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(status()).toBe('error');
    // Silent: a failed warm-up is no Sentry event.
    expect(loggerSpies().captureException).not.toHaveBeenCalled();
    expect(loggerSpies().captureMessage).not.toHaveBeenCalled();
  });
});

describe('prewarmCloudChat, the cases where it stays quiet', () => {
  it('sends nothing at all under on-device processing', async () => {
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
    const requests = requestCounter();
    expect(prewarmCloudChat({ ping: true })).toBeUndefined();
    await quiet();
    expect(requests()).toBe(0);
    expect(gatewayCalls()).toEqual([]);
    expect(attestationRequests()).toBe(0);
    expect(status()).toBe('idle');
  });

  it('pings on device while cloud chat is on: the ping is a chat call', async () => {
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice, chatInCloud: true });
    server.use(...mockGateway(respond('ready')));

    prewarmCloudChat({ ping: true });
    await settled();

    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(status()).toBe('ready');
  });

  it('a restricted account is never pinged and shows no badge', async () => {
    useCloudChatStore.setState({ isBlocked: true });
    prewarmCloudChat({ ping: true });
    await quiet();
    expect(gatewayCalls('chat')).toEqual([]);
    expect(status()).toBe('idle');

    useCloudChatStore.setState({ isBlocked: false });
    useUserStore.setState({ userPersona: { blockedByLlm: true } as never });
    prewarmCloudChat({ ping: true });
    await quiet();
    expect(gatewayCalls('chat')).toEqual([]);
    expect(status()).toBe('idle');
  });

  it('signed out: no gateway request, no throw, no badge, and a ping after sign-in', async () => {
    resetAuthState();
    invalidateJwtCache();
    expect(() => prewarmCloudChat({ ping: true })).not.toThrow();
    await quiet();
    expect(gatewayCalls()).toEqual([]);
    expect(attestationRequests()).toBe(0);
    expect(status()).toBe('idle');

    // Auth now available: the released claim lets the next call warm.
    await drive(signInFixtureAccount());
    invalidateJwtCache();
    prewarmCloudChat({ ping: true });
    await settled();
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([BIG_MODEL]);
  });

  it('a token endpoint that errors reads as no credential: nothing is sent, nothing throws', async () => {
    invalidateJwtCache();
    server.use(http.get('*/api/auth/token', () => new HttpResponse('boom', { status: 500 })));
    await expect(drive(getJwtToken())).resolves.toBeNull();
    expect(() => prewarmCloudChat({ ping: true })).not.toThrow();
    await quiet();
    expect(gatewayCalls()).toEqual([]);
    expect(attestationRequests()).toBe(0);
  });
});
