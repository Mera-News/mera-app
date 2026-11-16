// The hourly cluster-membership refresh a foreground sync runs right after its diff (D8, D13, D21):
// which rows it asks about, how often, what it writes, and that it can never fail the sync. The
// ML job clusters only the last 48h and deletes older generations, so a row published more than
// 44h ago is never asked about: the answer would clear the memberships that group its story.
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

import { __resetClusterMembershipsSupport } from '@/lib/article-service';
import database from '@/lib/database';
import type ArticleSuggestionModel from '@/lib/database/models/ArticleSuggestion';
import { persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-persist';
import { saveScoringResult } from '@/lib/database/services/article-suggestion-scoring-writes';
import { deleteSetting, getSetting } from '@/lib/database/services/setting-service';
import type { ArticleClusterMemberships } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { CLUSTER_MEMBERSHIP_REFRESH_KEY } from '@/lib/scheduler/feed-sync/feed-sync-steps';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { advanceUntilDone, graphql, HttpResponse, mockGqlError, server } from '@/test/helpers';
import {
  art,
  cleanupFeedSync,
  makeCtx,
  resetFeedSyncMemory,
  resetScoringWorld,
  seedInterest,
  servePersona,
  serveHydrate,
} from '../steps/support';
import { backgroundHooks, settleMachine, startMachine } from './support';

jest.setTimeout(60_000);

const HOUR = 3_600_000;
const OP = 'ClusterMembershipsForArticles';
const bhopal = [{ __typename: 'ClusterMembership' as const, clusterId: 'c-bhopal', confidence: 0.82, stableClusterId: 's-bhopal' }];

describe('the cluster membership refresh in a feed sync', () => {
  let asked: string[][];

  beforeEach(async () => {
    resetFeedSyncMemory();
    await resetScoringWorld();
    __resetClusterMembershipsSupport();
    await deleteSetting(CLUSTER_MEMBERSHIP_REFRESH_KEY); // the shared reset marks it as already run
    asked = [];
  });
  afterEach(async () => {
    await settleMachine();
    cleanupFeedSync();
  });

  /** The server answers every asked id with the shared Bhopal story. */
  const serveMemberships = () =>
    graphql.query(OP, ({ variables }) => {
      const ids = variables.articleIds as string[];
      asked.push(ids);
      const rows: ArticleClusterMemberships[] = ids.map((articleId) => ({
        __typename: 'ArticleClusterMemberships',
        articleId,
        clusters: bhopal,
      }));
      return HttpResponse.json({ data: { clusterMembershipsForArticles: rows } });
    });

  /** Scored rows already on the device, published `ageH` hours ago; the server lists them all again, so the diff is empty. */
  async function seedRows(rows: { id: string; ageH: number; relevance: number }[]) {
    await seedInterest('I follow racing', ['formula 1']);
    await persistAndLinkV2Suggestions(
      rows.map((r) => art(r.id, { pubDate: new Date(Date.now() - r.ageH * HOUR).toISOString() })),
      new Map(),
    );
    for (const r of rows) await saveScoringResult(r.id, { relevance: r.relevance, reason: '', reasonSkipped: true });
    await useForYouStore.getState().hydrateSuggestionsFromDb();
    server.use(servePersona({ topics: { 'formula 1': rows.map((r) => r.id) } }), ...serveHydrate().handlers, serveMemberships());
  }

  const membershipsOf = async (id: string) =>
    JSON.parse((await database.get<ArticleSuggestionModel>('article_suggestions').find(id)).clusterMembershipsJson ?? 'null');
  const run = (t = makeCtx()) => advanceUntilDone(startMachine(t));

  it('asks once about every row inside 44h whatever its score, newest first, when one clears the render gate', async () => {
    await seedRows([
      { id: 'older', ageH: 20, relevance: 0.65 },
      { id: 'newer', ageH: 2, relevance: 0.85 },
      { id: 'low', ageH: 1, relevance: 0.2 },
      { id: 'edge', ageH: 45, relevance: 0.9 },
    ]);

    await run();

    expect(asked).toEqual([['low', 'newer', 'older']]);
    expect(await membershipsOf('newer')).toEqual([{ clusterId: 'c-bhopal', confidence: 0.82, stableClusterId: 's-bhopal' }]);
    const inStore = useForYouStore.getState().suggestions.find((s) => s._id === 'older');
    expect(inStore?.clusters).toEqual([{ clusterId: 'c-bhopal', confidence: 0.82, stableClusterId: 's-bhopal' }]);
  });

  it('never sends a 3-day-old kept High row, and its memberships survive the refresh', async () => {
    await seedRows([
      { id: 'kept', ageH: 72, relevance: 0.9 },
      { id: 'fresh', ageH: 3, relevance: 0.9 },
    ]);
    const before = await membershipsOf('kept');

    await run();

    expect(asked).toEqual([['fresh']]);
    expect(await membershipsOf('kept')).toEqual(before);
    expect(before).toEqual([{ clusterId: 'c-kept', confidence: 0.9, stableClusterId: 'member-kept' }]);
  });

  it('runs at most once an hour, counted from the attempt', async () => {
    await seedRows([{ id: 'fresh', ageH: 1, relevance: 0.9 }]);

    await run();
    jest.setSystemTime(Date.now() + 59 * 60_000);
    await run();
    expect(asked).toHaveLength(1);
    expect(Number(await getSetting(CLUSTER_MEMBERSHIP_REFRESH_KEY))).toBeGreaterThan(0);

    jest.setSystemTime(Date.now() + 2 * 60_000);
    await run();
    expect(asked).toHaveLength(2);
  });

  it('sends nothing and stamps nothing when no row qualifies', async () => {
    await seedRows([{ id: 'low', ageH: 1, relevance: 0.1 }]);

    await run();

    expect(asked).toEqual([]);
    expect(await getSetting(CLUSTER_MEMBERSHIP_REFRESH_KEY)).toBeNull();
  });

  it('is skipped by a background run', async () => {
    await seedRows([{ id: 'fresh', ageH: 1, relevance: 0.9 }]);

    await advanceUntilDone(startMachine(makeCtx(), { background: backgroundHooks({ submit: false }).hooks }));

    expect(asked).toEqual([]);
  });

  it('latches off for the session on a server without the query, and reports nothing', async () => {
    await seedRows([{ id: 'fresh', ageH: 1, relevance: 0.9 }]);
    let rejected = 0;
    server.use(
      graphql.query(OP, () => {
        rejected += 1;
        return undefined; // fall through to the rejection below
      }),
      mockGqlError(OP, 'GRAPHQL_VALIDATION_FAILED', {
        httpStatus: 400,
        headers: { 'Content-Type': 'application/graphql-response+json' },
      }),
    );

    await run();
    jest.setSystemTime(Date.now() + 2 * HOUR);
    await run();

    expect(rejected).toBe(1);
    expect(logger.captureException).not.toHaveBeenCalled();
    expect(useForYouStore.getState().lastSyncAt).not.toBeNull();
  });

  it('never fails the sync when the refresh fails', async () => {
    await seedRows([{ id: 'fresh', ageH: 1, relevance: 0.9 }]);
    server.use(mockGqlError(OP, 'INTERNAL_SERVER_ERROR'));
    const before = await membershipsOf('fresh');

    await expect(run()).resolves.toBeUndefined();

    expect(useForYouStore.getState().lastSyncAt).not.toBeNull();
    expect(await membershipsOf('fresh')).toEqual(before);
    expect((logger.warn as jest.Mock).mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining([expect.stringContaining('cluster membership refresh')]),
    );
  });
});
