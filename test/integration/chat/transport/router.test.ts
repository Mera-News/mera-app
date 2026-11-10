// The router at the transport seam (lib/llm/router, lib/llm/routed-send): a model-class failure
// moves the call to the lane's next profile at once, with no backoff; a lane whose whole chain
// failed is ONE error event and an outage; 401, 429 and an offline device never switch. Real stack
// against the gateway mock; the mock serves NEAR only, so a RedPill leg is seen at its key fetch.
import { http, HttpResponse } from 'msw';
import { BIG_MODEL, SMALL_MODEL } from '@/lib/llm/constants';
import { cloudChatStream, cloudComplete } from '@/lib/llm/cloudComplete';
import { MIN_INTERACTIVE_INTERVAL_MS } from '@/lib/llm/gateway-rate-limiter';
import { PROFILES } from '@/lib/llm/profiles';
import { attestProfile } from '@/lib/llm/provider-e2ee';
import {
  applyRoutingTable,
  LANES,
  LaneExhaustedError,
  noteRoutingVersion,
  profilesToPreattest,
  refreshRouting,
  routeLane,
  routingSnapshot,
  routingVersion,
  type RoutingTable,
} from '@/lib/llm/router';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { gatewayCalls, mockGateway, server } from '@/test/helpers';
import { useStrictClock } from '@/test/integration/chat/_helpers';
import {
  advanceUntil,
  collect,
  drive,
  installChatHooks,
  loggerSpies,
  MESSAGES,
  textOf,
} from '@/test/integration/chat/streaming/support';

installChatHooks();

const REDPILL_MODEL = PROFILES['redpill/qwen3.8-27b'].model;
const DOWN = { status: 503, body: { error: { code: 'model_unavailable', message: 'down' } } };
const chat = () => collect(cloudChatStream({ messages: MESSAGES, route: 'chat-tools' }));
const fail = (p: Promise<unknown>) => p.then(() => null, (e: Error & { statusCode?: number }) => e);
const exhaustedEvents = () =>
  loggerSpies().captureException.mock.calls.filter(([e]) => (e as Error).name === 'LaneExhaustedError');

/** The provider each attestation request named, in order (`near` when the header is absent). */
function watchAttestations(): { model: string; provider: string }[] {
  const seen: { model: string; provider: string }[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/api/attestation/report')) {
      seen.push({ model: url.searchParams.get('model') ?? '', provider: request.headers.get('x-mera-provider') ?? 'near' });
    }
  });
  return seen;
}

/** RedPill's key fetch answers 503 (the mock speaks NEAR only): a model-class failure. */
function redpillAttestationDown(): void {
  server.use(
    http.get('*/api/attestation/report', ({ request }) =>
      request.headers.get('x-mera-provider') === 'redpill' ? new HttpResponse('down', { status: 503 }) : undefined,
    ),
  );
}

afterEach(() => {
  useNetworkStore.setState({ isConnected: true });
  useForYouStore.getState().setLaneOutage('chat-tools', null);
});

describe('a model down mid-turn', () => {
  it('completes on the next profile at once: no backoff, no second try on the dead model', async () => {
    useStrictClock('2026-11-10T00:00:00Z');
    // Both keys already held, so the only wait between the legs is the limiter's spacing.
    await drive(Promise.all([attestProfile(PROFILES['near/qwen3.8-27b']), attestProfile(PROFILES['near/qwen3.6-35b-a3b'])]));
    const sentAt: number[] = [];
    server.use(...mockGateway((c) => {
      sentAt.push(Date.now());
      return c.model === BIG_MODEL ? DOWN : 'hello';
    }));

    const events = chat();
    await drive(events);

    expect(textOf(await events)).toBe('hello');
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([BIG_MODEL, SMALL_MODEL]);
    expect(gatewayCalls('chat').map((c) => c.headers['x-mera-provider'])).toEqual(['near', 'near']);
    expect(sentAt[1] - sentAt[0]).toBeLessThanOrEqual(MIN_INTERACTIVE_INTERVAL_MS + 100);
    // Absorbed: a breadcrumb, never an event.
    expect(loggerSpies().captureException).not.toHaveBeenCalled();
    expect(loggerSpies().addBreadcrumb).toHaveBeenCalledWith(
      'model profile failed, next profile', 'router',
      expect.objectContaining({ lane: 'chat-tools', profile: 'near/qwen3.8-27b', failure_class: 'model_unavailable' }),
      'warning',
    );
    // The next call starts on the healthy profile.
    expect(routeLane('chat-tools')[0].id).toBe('near/qwen3.6-35b-a3b');
  });

  it('leaves a model that sends no first token after the 30s chat deadline, not 130s', async () => {
    useStrictClock('2026-11-10T00:00:00Z');
    server.use(...mockGateway((c) => (c.model === BIG_MODEL ? { chunks: ['late'], headerDelayMs: 200_000 } : 'hello')));
    const events = chat();
    await advanceUntil(() => gatewayCalls('chat').length === 1);
    const openedAt = Date.now();
    await advanceUntil(() => gatewayCalls('chat').length === 2, 60_000);
    const waited = Date.now() - openedAt;
    expect(waited).toBeGreaterThanOrEqual(30_000);
    expect(waited).toBeLessThan(35_000);
    await drive(events);
    expect(textOf(await events)).toBe('hello');
  });

  it('moves a buffered call on from an empty 2xx', async () => {
    server.use(...mockGateway((c) => (c.model === SMALL_MODEL ? { status: 200, body: '' } : 'ok')));
    const out = await cloudComplete({ systemPrompt: 's', prompt: 'p', route: 'background' });
    expect(out).toBe('ok');
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([SMALL_MODEL, BIG_MODEL]);
  });

  it('reaches RedPill third, with its own provider on the key fetch', async () => {
    useStrictClock('2026-11-10T00:00:00Z');
    const attests = watchAttestations();
    server.use(...mockGateway(() => ({ status: 502, body: { error: 'upstream gone' } })));
    const outcome = fail(chat());
    await drive(outcome);
    expect(attests.at(-1)).toEqual({ model: REDPILL_MODEL, provider: 'redpill' });
  });
});

describe('a lane whose whole chain failed', () => {
  it('surfaces the last failure as before, files exactly one error event, and marks the lane out', async () => {
    useStrictClock('2026-11-10T00:00:00Z');
    server.use(...mockGateway(() => ({ status: 502, body: { error: 'upstream gone' } })));
    redpillAttestationDown();
    const outcome = fail(chat());
    await drive(outcome);
    const err = await outcome;

    // The head's failure, as callers have always seen it; the event names where the chain ended.
    expect(err?.message).toBe('E2EE chat failed: 502');
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([BIG_MODEL, SMALL_MODEL]);
    expect(exhaustedEvents()).toHaveLength(1);
    expect(exhaustedEvents()[0][1]).toEqual(expect.objectContaining({
      level: 'error',
      tags: { lane: 'chat-tools', profile: 'redpill/qwen3.8-27b', failure_class: 'attestation', routing_version: '0' },
    }));
    expect(useForYouStore.getState().laneOutage['chat-tools']).toEqual({ since: expect.any(Number) });
  });

  it('a later success ends the outage', async () => {
    useForYouStore.getState().setLaneOutage('chat-tools', { since: 1 });
    server.use(...mockGateway(() => 'back'));
    expect(textOf(await chat())).toBe('back');
    expect(useForYouStore.getState().laneOutage['chat-tools']).toBeUndefined();
  });
});

describe('failures that are not the model never switch', () => {
  it('401: one re-mint on the same model, then the error', async () => {
    server.use(...mockGateway(() => ({ status: 401, body: 'Unauthorized' })));
    const err = await fail(chat());
    expect(err).toMatchObject({ statusCode: 401 });
    expect(new Set(gatewayCalls('chat').map((c) => c.model))).toEqual(new Set([BIG_MODEL]));
    expect(gatewayCalls('chat')).toHaveLength(2);
    expect(exhaustedEvents()).toHaveLength(0);
  });

  it('429 with a long Retry-After: the throttle surfaces on the same model', async () => {
    server.use(...mockGateway(() => ({ status: 429, body: 'slow down', headers: { 'Retry-After': '30' } })));
    const err = await fail(chat());
    expect(err?.name).toBe('RateLimitedError');
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([BIG_MODEL]);
    expect(routeLane('chat-tools')[0].id).toBe('near/qwen3.8-27b');
  });

  it('offline: a deadline proves nothing, so nothing is marked and nothing switches', async () => {
    useStrictClock('2026-11-10T00:00:00Z');
    useNetworkStore.setState({ isConnected: false });
    server.use(...mockGateway(() => ({ chunks: ['late'], headerDelayMs: 200_000 })));
    const outcome = fail(chat());
    await drive(outcome, 60_000);
    expect(await outcome).not.toBeNull();
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([BIG_MODEL]);
    expect(routeLane('chat-tools')[0].id).toBe('near/qwen3.8-27b');
  });
});

describe('the routing table', () => {
  const table = (version: number, chatTools: string[]): RoutingTable => ({
    version,
    updatedAt: '2026-11-10T00:00:00Z',
    lanes: { 'chat-tools': { state: 'degraded', profiles: chatTools } },
  });

  it('a reply naming a new version refetches the table, and its order wins', async () => {
    server.use(http.get('*/v1/routing', () => HttpResponse.json(table(7, ['near/qwen3.6-35b-a3b', 'redpill/qwen3.8-27b']))));
    noteRoutingVersion('7');
    await refreshRouting();
    expect(routingVersion()).toBe(7);
    expect(routeLane('chat-tools').map((p) => p.id)).toEqual(['near/qwen3.6-35b-a3b', 'redpill/qwen3.8-27b']);
    expect(routingSnapshot().lanes['chat-tools']).toEqual({
      state: 'degraded',
      active: { id: 'near/qwen3.6-35b-a3b', provider: 'near', providerName: 'NEAR AI', providerUrl: 'https://near.ai', modelLabel: 'Qwen3.6 35B' },
    });
  });

  it('a fast-fail 503 carries the table, which the app takes at once', async () => {
    server.use(...mockGateway((c) => (c.model === BIG_MODEL
      ? { status: 503, body: { ...DOWN.body, routing: table(9, ['near/qwen3.6-35b-a3b', 'redpill/qwen3.8-27b']) } }
      : 'ok')));
    expect(textOf(await chat())).toBe('ok');
    expect(routingVersion()).toBe(9);
  });

  it('an unreachable /v1/routing keeps the built-in table', async () => {
    server.use(http.get('*/v1/routing', () => new HttpResponse('nope', { status: 500 })));
    await refreshRouting();
    expect(routingVersion()).toBe(0);
    expect(routeLane('scoring').map((p) => p.id)).toEqual(['near/qwen3.6-35b-a3b', 'near/qwen3.8-27b', 'redpill/qwen3.8-27b']);
  });
});

describe('a table that lists every chat profile down', () => {
  const allDown: RoutingTable = {
    version: 11,
    updatedAt: '2026-11-10T00:00:00Z',
    lanes: Object.fromEntries(LANES.map((l) => [l, { state: 'down', profiles: [] }])),
  };

  it('routes nothing, pre-attests nothing and fails chat fast with no network call', async () => {
    applyRoutingTable(allDown);
    const seen = watchAttestations();
    expect(routeLane('chat-tools')).toEqual([]);
    expect(profilesToPreattest()).toEqual([]);
    const err = await fail(chat());
    expect(err).toBeInstanceOf(LaneExhaustedError);
    expect(seen).toEqual([]);
    expect(gatewayCalls('chat')).toEqual([]);
  });
});

describe('mode and call shape', () => {
  afterEach(() => useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud, chatInCloud: false }));

  it('on this phone routes no cloud lane, except chat while chat is in the cloud', () => {
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice, chatInCloud: false });
    expect(routeLane('chat-tools')).toEqual([]);
    expect(routeLane('scoring')).toEqual([]);
    expect(routingSnapshot().lanes.scoring.active).toBeNull();
    useMeraProtocolStore.setState({ chatInCloud: true });
    expect(routeLane('chat-single').length).toBe(3);
    expect(routeLane('fact-check').length).toBe(3);
    expect(routeLane('topics')).toEqual([]);
  });

  it('a batch or an async job never routes to RedPill', () => {
    expect(routeLane('scoring', { batch: true }).map((p) => p.provider)).toEqual(['near', 'near']);
  });

  it('every gateway request names its provider', async () => {
    server.use(...mockGateway(() => 'ok'));
    await cloudComplete({ systemPrompt: 's', prompt: 'p', route: 'background' });
    expect(gatewayCalls('chat')[0].headers['x-mera-provider']).toBe('near');
  });
});
