// stepHydratePersistEnqueue with the foreground enqueue switched ON: the step hands its rows to the
// real scoring pipeline, which submits to the gateway mock (async jobs, real E2EE both ways). This
// is the one place in the feed-sync step tests where scoring runs; every other file suppresses it.
// The pipeline is reset through its own _resetForTests; its limiter, model-fallback and
// attestation caches through theirs.
// Replaces the enqueue, tail-flush, on-device and gate blocks of
// lib/scheduler/feed-sync/__tests__/feed-sync-steps.test.ts.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

import { invalidateJwtCache } from '@/lib/auth-client';
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import { __resetForTests as resetModelFallback } from '@/lib/llm/model-fallback';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import * as pipeline from '@/lib/services/scoring-pipeline';
import { __resetSuggestionsRefreshThrottleForTests } from '@/lib/services/SuggestionSyncService';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import {
  advanceUntilDone,
  assertNoGatewayViolations,
  attestationRequests,
  gatewayCalls,
  server,
  setAppState,
  signInFixtureAccount,
  useFakeClock,
} from '@/test/helpers';
import {
  art,
  cleanupFeedSync,
  fetchAndDiff,
  hydrate,
  ids,
  makeCtx,
  resetFeedSyncMemory,
  rowsById,
  seedInterest,
  seedLocation,
  servePersona,
  serveHydrate,
  type TestCtx,
} from './support';

const NOW = new Date('2026-10-09T10:00:00.000Z').getTime();
const TITLE = /News Title: Story (\S+)/g;

beforeEach(async () => {
  resetFeedSyncMemory();
  resetLimiter();
  resetModelFallback();
  clearAttestationCache();
  invalidateJwtCache();
  __resetSuggestionsRefreshThrottleForTests();
  setAppState('inactive'); // no foreground poller: this test is the only driver of the run
  useUserStore.setState({ userPersona: { expoPushToken: 'ExponentPushToken[test]' } as never });
  await signInFixtureAccount();
  useFakeClock(NOW);
});
afterEach(() => {
  cleanupFeedSync();
  assertNoGatewayViolations();
});

/** Article ids the gateway was asked to score, from the decrypted relevance prompts. */
function scoredIds(): string[] {
  return gatewayCalls('job')
    .filter((c) => c.callId?.startsWith('score:'))
    .flatMap((c) => [...(c.messages.find((m) => m.role === 'user')?.content ?? '').matchAll(TITLE)].map((m) => m[1]));
}

/** One limiter spacing later, one poll and one drain: what the foreground poller does. */
async function tick(): Promise<void> {
  jest.setSystemTime(Date.now() + 1_100);
  await advanceUntilDone(pipeline.pollTick('foreground'));
  await advanceUntilDone(pipeline.recover());
}

async function tickUntilScored(count: number): Promise<void> {
  for (let i = 0; i < 20 && new Set(scoredIds()).size < count; i++) await tick();
}

async function prepare(topicIds: string[]) {
  await seedInterest('I follow racing', ['formula 1']);
  server.use(servePersona({ topics: { 'formula 1': topicIds } }), ...serveHydrate().handlers);
  const t = makeCtx();
  const { diff } = await advanceUntilDone(fetchAndDiff(t));
  return { t, diff };
}

const foreground = (t: TestCtx, diff: Parameters<typeof hydrate>[0], over = {}) =>
  advanceUntilDone(hydrate(diff, t, { suppressEnqueue: false, background: false, ...over }));

describe('the foreground enqueue', () => {
  it('hands exactly the persisted, eligible articles to the scoring pipeline, which submits them to the gateway', async () => {
    const all = ids(12);
    const { t, diff } = await prepare(all);

    const { result } = await foreground(t, diff);
    await tickUntilScored(all.length);

    expect(result.enqueuedCount).toBe(12);
    expect([...result.eligibleIds].sort()).toEqual(all);
    expect(scoredIds().sort()).toEqual(all);
    expect(new Set(gatewayCalls('job').map((c) => c.headers['idempotency-key'])).size).toBeGreaterThan(0);
  });

  it('flushes the trailing partial the gate held back once the whole lot is hydrated', async () => {
    // 7 ids: one batch of 5 goes at once, the 2 left over are under the dispatch floor and wait
    const all = ids(pipeline.MIN_DISPATCH + 2);
    const { t, diff } = await prepare(all);

    await foreground(t, diff);
    await tickUntilScored(all.length);

    expect(scoredIds().sort()).toEqual(all);
  });

  it('never submits a row with no English text: it is tombstoned at hydrate', async () => {
    const all = ids(6);
    const served = serveHydrate({
      article: (id) => (id === 'a002' ? art(id, { description_en: undefined, title_en: undefined }) : art(id)),
    });
    await seedInterest('I follow racing', ['formula 1']);
    server.use(servePersona({ topics: { 'formula 1': all } }), ...served.handlers);
    const t = makeCtx();
    const { diff } = await advanceUntilDone(fetchAndDiff(t));

    await foreground(t, diff);
    await tickUntilScored(5);

    expect(scoredIds().sort()).toEqual(all.filter((id) => id !== 'a002'));
  });
});

describe('suppressed enqueue', () => {
  it('hands the rows over in the tail flush when the pipeline is idle', async () => {
    const all = ids(pipeline.MIN_DISPATCH + 2);
    const { t, diff } = await prepare(all);

    const { result } = await foreground(t, diff, { suppressEnqueue: true });
    await tickUntilScored(all.length);

    expect(result.enqueuedCount).toBe(0);
    expect(scoredIds().sort()).toEqual(all);
  });

  it('leaves the rows to the running pipeline when a scoring run is already in flight', async () => {
    const first = ids(12);
    const one = await prepare(first);
    await foreground(one.t, one.diff);
    await tickUntilScored(first.length);
    expect(await pipeline.getPipelineStatus()).toBe('running');
    const before = scoredIds().length;

    const later = ids(6, 'z');
    server.use(servePersona({ topics: { 'formula 1': later } }));
    const { diff } = await advanceUntilDone(fetchAndDiff(one.t));
    const { result } = await foreground(one.t, diff, { suppressEnqueue: true });
    await tick();

    expect(result.eligibleIds.sort()).toEqual(later);
    expect(scoredIds()).toHaveLength(before);
    expect((await rowsById()).get('z000')!.status).toBe('unscored');
  });
});

describe('on-device scoring', () => {
  it('hydrates and persists but enqueues nothing to the cloud pipeline and flushes no tail', async () => {
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
    const all = ids(7);
    const { t, diff } = await prepare(all);

    const { result } = await foreground(t, diff);
    await tick();

    expect(result.enqueuedCount).toBe(0);
    expect([...result.eligibleIds].sort()).toEqual(all);
    expect((await rowsById()).size).toBe(7);
    expect(gatewayCalls()).toEqual([]);
    expect(attestationRequests()).toBe(0);
    expect(await pipeline.getPipelineStatus()).toBe('idle');
  });
});

describe('which sibling of a duplicate pair is scored', () => {
  const STORY = 'harbour bridge repairs begin in fixtureville after months of planning delays';
  const twin = (id: string, country: string) =>
    art(id, { title_en: `Story ${id} ${STORY}`, title: `Story ${id} ${STORY}`, country_code: country });

  async function syncPair(homeCountry: string) {
    await seedInterest('I follow racing', ['formula 1']);
    await seedLocation(homeCountry, 0.9, 'home');
    const served = serveHydrate({ article: (id) => twin(id, id.startsWith('nl') ? 'NLD' : 'USA') });
    server.use(
      servePersona({
        headlines: [{ scope: 'GLOBAL', ids: ['nl1', 'us1'] }],
        stable: { nl1: 'one-story', us1: 'one-story' },
      }),
      ...served.handlers,
    );
    const t = makeCtx();
    const { diff } = await advanceUntilDone(fetchAndDiff(t));
    await foreground(t, diff);
    await tickUntilScored(1);
    await tick();
  }

  it('scores the copy from the reader home country and holds the other back', async () => {
    await syncPair('NL');

    // only the elected copy was ever sent; the other inherited its verdict
    expect(scoredIds()).toEqual(['nl1']);
    const rows = await rowsById();
    expect(rows.get('us1')!.status).not.toBe('unscored');
    expect(rows.get('us1')!.relevance).toBe(rows.get('nl1')!.relevance);
    expect(rows.get('nl1')!.relevance).toBeGreaterThan(0);
  });

  it('scores the other copy when the reader lives in the other country', async () => {
    await syncPair('US');

    expect(scoredIds()).toEqual(['us1']);
  });
});
