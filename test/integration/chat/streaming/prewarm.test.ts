// lib/llm/prewarm.ts against the gateway mock: what a launch really sends. Real attestation fetches,
// real JWT, real limiter, real cloudComplete. The warm-up runs only after 10 minutes without a
// BIG_MODEL call, kept in module state, so every test runs on its own fake date, three hours after
// the last (a later date than any earlier test's, or the previous test's calls would still count).
import { getJwtToken, invalidateJwtCache } from '@/lib/auth-client';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { BIG_MODEL, SMALL_MODEL } from '@/lib/llm/constants';
import { cloudChatStream } from '@/lib/llm/cloudComplete';
import { dismissMeraGreeting, prewarmCloudChat, useMeraGreeting } from '@/lib/llm/prewarm';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
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
  useMeraGreeting.setState({ text: null });
});
afterEach(() => {
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
  useAppLanguageStore.setState({ appLanguage: 'en' });
});

const greeting = () => useMeraGreeting.getState().text;
/** The device's local part of day, the only clock fact the request may carry. */
const partOfDay = () => {
  const h = new Date().getHours();
  return h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 18 ? 'afternoon' : 'evening';
};

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
  it('attests BIG and SMALL once each and asks BIG for one greeting line: nothing else', async () => {
    const bodies = captureChatBodies();
    server.use(...mockGateway(respond('Good evening! Mera is ready for you.')));

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
      { role: 'system', content: expect.stringContaining(`greeting for the ${partOfDay()}, in English,`) },
      { role: 'user', content: 'Greet me.' },
    ]);
    const body = JSON.parse(bodies[0]);
    expect(body).toMatchObject({
      model: BIG_MODEL,
      max_tokens: 64,
      temperature: 0.7,
      chat_template_kwargs: { enable_thinking: false },
    });
    // Sealed: the prompt is not on the wire in clear.
    expect(bodies[0]).not.toContain('Greet me');
    expect(bodies[0]).not.toContain('greeting');
    expect(greeting()).toBe('Good evening! Mera is ready for you.');
    // A logger.warn is a Sentry breadcrumb: the line never rides one.
    expect(JSON.stringify(loggerSpies().addBreadcrumb.mock.calls)).not.toContain('Mera is ready');
  });

  it('carries no user data: facts on file stay out, the app language comes in by name', async () => {
    await drive(seedFacts(['Lives in Porto', 'Works as a nurse']));
    useAppLanguageStore.setState({ appLanguage: 'hi' });
    server.use(...mockGateway(respond('नमस्ते! मीरा आपके लिए तैयार है।')));
    prewarmCloudChat();
    await settled();
    const [call] = gatewayCalls('chat');
    const sent = JSON.stringify(call.messages);
    expect(sent).toContain('in Hindi,');
    // The app's own Hindi name, asked for in the prompt and enforced on the line.
    expect(sent).toContain('मेरा ऐप');
    expect(greeting()).toBe('नमस्ते! मेरा ऐप आपके लिए तैयार है।');
    expect(sent).not.toMatch(/Porto|nurse|e2e-fixture/);
    expect(call.messages).toHaveLength(2);
  });

  it('cleans the line before showing it: think tags, clause dashes, one line', async () => {
    server.use(...mockGateway(respond('<think>plan it</think>Good evening — Mera is\n ready for you.  ')));
    prewarmCloudChat();
    await settled();
    expect(greeting()).toBe('Good evening, Mera is ready for you.');
  });

  it.each([
    ['a reply cut mid-sentence', 'Good evening! Mera is ready to help you catch up on', null],
    ['a reply over 120 characters', `${Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')}.`, null],
    ['a line that ends in an emoji', 'Good evening, Mera is ready 👋', 'Good evening, Mera is ready 👋'],
  ])('%s: shown only when whole', async (_, reply, shown) => {
    server.use(...mockGateway(respond(reply)));
    prewarmCloudChat();
    await settled();
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(greeting()).toBe(shown);
  });

  it('shows nothing for a reply that is only a think block', async () => {
    server.use(...mockGateway(respond('<think>only a trace</think>')));
    prewarmCloudChat();
    await settled();
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(greeting()).toBeNull();
  });

  it('drops a greeting that lands after the user already sent a message', async () => {
    server.use(...mockGateway(() => ({ chunks: ['Good morning! Mera is ready.'], headerDelayMs: 5_000 })));
    prewarmCloudChat();
    await advanceUntil(() => gatewayCalls('chat').length === 1, 60_000);
    dismissMeraGreeting();
    await quiet();
    expect(greeting()).toBeNull();
  });

  it('warms only after 10 minutes without a BIG call, and concurrent callers fire once', async () => {
    server.use(...mockGateway(respond('ok')));
    prewarmCloudChat();
    prewarmCloudChat();
    await settled();
    prewarmCloudChat();
    await quiet();
    // Attestation is cached, and the warm-up itself was the last BIG call.
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(attestationRequests()).toBe(2);

    await jest.advanceTimersByTimeAsync(11 * 60_000);
    prewarmCloudChat();
    await advanceUntil(() => gatewayCalls('chat').length === 2, 60_000);
    await quiet();
    expect(gatewayCalls('chat')).toHaveLength(2);
    expect(attestationRequests(BIG_MODEL)).toBe(1);
  });

  it('a real chat turn on BIG counts as the last call: no warm-up within 10 minutes of it', async () => {
    server.use(...mockGateway(respond('ok')));
    await drive(collect(cloudChatStream({ messages: MESSAGES, model: BIG_MODEL })));
    await jest.advanceTimersByTimeAsync(9 * 60_000);
    prewarmCloudChat();
    await quiet();
    expect(gatewayCalls('chat')).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(2 * 60_000);
    prewarmCloudChat();
    await advanceUntil(() => gatewayCalls('chat').length === 2, 60_000);
    expect(gatewayCalls('chat')[1].messages[1]).toEqual({ role: 'user', content: 'Greet me.' });
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
    expect(greeting()).toBeNull();
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
    expect(greeting()).toBeNull();
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
