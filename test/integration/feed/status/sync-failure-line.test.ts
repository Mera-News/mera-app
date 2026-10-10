// OWNER-F2 (R76): a failed foreground refresh should lead the counts card with the line naming what
// worked, from the machine's failedAtState and errorCode. Today the card stays silent and the counts
// sentence leads. Each `test.failing` expects the new line; its "today:" sibling pins the current
// outcome (zeroText is null). Driven at useStatsCardLead over the real stores, with the failure
// published through data's contract (feed-sync-status), plus one pair through the real FeedSyncMachine.
import { act, renderHook } from '@testing-library/react-native';
import { limitUnlockTime } from '@/components/custom/for-you/FeedStatusDetails';
import { useStatsCardLead } from '@/components/custom/for-you/use-stats-card-lead';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { addFact } from '@/lib/database/services/fact-service';
import { resetFeedCountsMemoForTest } from '@/lib/hooks/use-feed-counts';
import i18n from '@/lib/i18n';
import { publishSyncError, publishSyncStatus } from '@/lib/scheduler/feed-sync/feed-sync-status';
import type { FeedSyncState, SyncErrorCode } from '@/lib/scheduler/feed-sync/feed-sync-types';
import { useForYouStore, type ForYouSuggestion } from '@/lib/stores/for-you-store';
import { advanceUntilDone, graphql, HttpResponse, initI18nEn, server, signInFixtureAccount } from '@/test/helpers';
import {
  cleanupFeedSync,
  ids,
  makeCtx,
  resetFeedSyncMemory,
  resetScoringWorld,
} from '../../data/feed-sync/steps/support';
import { backgroundHooks, serveNew, settleMachine, startMachine, watchScoring } from '../../data/feed-sync/machine/support';

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
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

jest.setTimeout(60_000);

const HOUR = 3_600_000;
const goodRow = (id: string) => ({
  articleId: id,
  status: ArticleSuggestionStatus.Complete,
  relevance: 0.9,
  firstPubDate: new Date(Date.now() - HOUR).toISOString(),
});

/** Three relevant rows, so the counts sentence has numbers and no zero state speaks. */
function seedCounts() {
  resetFeedCountsMemoForTest();
  useForYouStore.setState({
    articleCount: 42,
    suggestions: ['a', 'b', 'c'].map(goodRow) as unknown as ForYouSuggestion[],
  });
}

/** The hook once the fact observer has reported (a fact exists, so the no-facts card does not own the Feed). */
async function renderLead() {
  const view = renderHook(() => useStatsCardLead());
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  });
  return view;
}

const t = i18n.t.bind(i18n) as unknown as (key: string, options?: object) => string;

describe('the counts card lead after a failed refresh', () => {
  beforeEach(async () => {
    await initI18nEn();
    resetFeedSyncMemory();
    await resetScoringWorld();
    watchScoring();
    await addFact('I follow racing');
    seedCounts();
  });
  afterEach(async () => {
    await settleMachine();
    cleanupFeedSync();
  });

  const failed = (at: FeedSyncState, code: SyncErrorCode) => publishSyncError(code, undefined, at);

  type Row = [at: FeedSyncState, code: SyncErrorCode, key: string];
  const cases: Row[] = [
    ['idle', 'unknown', 'feed.syncFailed.start'],
    ['fetching-topic-ids', 'server-unreachable', 'feed.syncFailed.fetch'],
    ['diffing', 'unknown', 'feed.syncFailed.check'],
    ['hydrating', 'server-unreachable', 'feed.syncFailed.download'],
    ['scoring', 'scoring-unavailable', 'feed.syncFailed.score'],
    ['hydrating', 'storage-error', 'feed.syncFailed.storage'],
    ['fetching-topic-ids', 'storage-error', 'feed.syncFailed.fetch'], // the storage line only from hydrating on
    ['diffing', 'auth-expired', 'feed.syncFailed.session'],
    ['hydrating', 'offline', 'common.offlineBannerOffline'],
  ];

  test.failing.each(cases)(
    'a failed refresh at %s (%s) leads with the line naming what worked',
    async (at, code, key) => {
      failed(at, code);
      const { result } = await renderLead();
      expect(result.current.zeroText).toBe(t(key));
    },
  );

  test.each(cases)('today: a failed refresh at %s (%s) leaves the counts line in place', async (at, code) => {
    failed(at, code);
    const { result } = await renderLead();
    expect(result.current.zeroText).toBeNull();
  });

  test.failing('a refresh paused offline leads with the offline line', async () => {
    publishSyncStatus('paused-offline', { pausedAtState: 'hydrating' });
    const { result } = await renderLead();
    expect(result.current.zeroText).toBe(t('common.offlineBannerOffline'));
  });

  test('today: a refresh paused offline leaves the counts line in place', async () => {
    publishSyncStatus('paused-offline', { pausedAtState: 'hydrating' });
    const { result } = await renderLead();
    expect(result.current.zeroText).toBeNull();
  });

  test('the daily limit still leads when a failure message is also published', async () => {
    const resetAt = Date.now() + 2 * HOUR;
    useForYouStore.setState({ dailyLimitResetAt: resetAt });
    failed('fetching-topic-ids', 'server-unreachable');
    const { result } = await renderLead();
    expect(result.current.state).toBe('limited');
    expect(result.current.zeroText).toBe(t('feed.dailyLimit.bodyWithTime', { time: limitUnlockTime(resetAt) }));
  });

  describe('through the real FeedSyncMachine', () => {
    const problem = (opts: { background: boolean }) =>
      startMachine(makeCtx(), opts.background ? { background: backgroundHooks().hooks } : {});

    test.failing('a foreground refresh that cannot look for articles says so on the counts card', async () => {
      await signInFixtureAccount();
      await serveNew(ids(3));
      server.use(graphql.query('GetArticleIdsForPersona', () => HttpResponse.error()));
      await expect(advanceUntilDone(problem({ background: false }))).rejects.toBeDefined();
      seedCounts();

      const { result } = await renderLead();

      expect(result.current.zeroText).toBe(t('feed.syncFailed.fetch'));
    });

    test('today: a foreground refresh that cannot look for articles leaves the counts line in place', async () => {
      await signInFixtureAccount();
      await serveNew(ids(3));
      server.use(graphql.query('GetArticleIdsForPersona', () => HttpResponse.error()));
      await expect(advanceUntilDone(problem({ background: false }))).rejects.toBeDefined();
      expect(useForYouStore.getState().syncStatusMessage).toEqual(
        expect.objectContaining({ state: 'failed', failedAtState: 'fetching-topic-ids' }),
      );
      seedCounts();

      const { result } = await renderLead();

      expect(result.current.zeroText).toBeNull();
    });

    test('a background run that fails leaves the counts line in place', async () => {
      await serveNew(ids(3));
      server.use(graphql.query('GetArticleIdsForPersona', () => HttpResponse.error()));
      await expect(advanceUntilDone(problem({ background: true }))).rejects.toBeDefined();
      expect(useForYouStore.getState().syncStatusMessage).toBeNull();
      seedCounts();

      const { result } = await renderLead();

      expect(result.current.zeroText).toBeNull();
    });
  });
});
