// Arms of the feed-sync steps and the tracked-story reconcile that only the G19 legacy suites
// reached: sparse server shapes (no matchMeta, no stable cluster ids, no clusters, no titles), a
// topic whose fact is gone, a scoring step started after an abort, and a followed-story member
// whose suggestion row carries no publication, language or original title. Real services,
// in-memory DB, real Apollo on MSW; the persona response is hand-written because `servePersona`
// always sends a full matchMeta and a stable id per article.
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

import { persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-persist';
import { recordOpen } from '@/lib/database/services/story-impression-service';
import { createTopics } from '@/lib/database/services/topic-service';
import {
  getTrackedStoryById,
  observeActive,
  type TrackedStoryMemberSnapshot,
} from '@/lib/database/services/tracked-story-service';
import { stepFetchTopicIds, stepScore } from '@/lib/scheduler/feed-sync/feed-sync-steps';
import { reconcileTrackedStories } from '@/lib/scheduler/feed-sync/tracked-story-reconcile';
import { trackStoryWithProposal } from '@/lib/tracking/track-actions';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { firstValueFrom } from 'rxjs';
import { graphql, HttpResponse, server } from '@/test/helpers';
import {
  art,
  cleanupFeedSync,
  fetchAndDiff,
  hydrate,
  makeCtx,
  recordOps,
  resetFeedSyncMemory,
  rowsById,
  seedInterest,
  serveHydrate,
  stageRowsById,
} from './support';

beforeEach(resetFeedSyncMemory);
afterEach(cleanupFeedSync);

/** A persona answer from a server that sends no per-article match metadata and no stable ids. */
function servePersonaWithoutMeta(topicText: string, topicIds: string[], headlineIds: string[]) {
  return graphql.query('GetArticleIdsForPersona', () =>
    HttpResponse.json({
      data: {
        articleIdsForPersona: {
          __typename: 'PersonaQueryResult',
          topicResults: [
            {
              __typename: 'PersonaTopicResult',
              topicText,
              articleIds: topicIds,
              matchMeta: [], // legacy shape: results listed, nothing said about them
              nextCursor: null,
              hasNextPage: false,
            },
          ],
          headlineResults: [
            {
              __typename: 'HeadlineScopeResult',
              scope: 'GLOBAL',
              countryCode: null,
              articleIds: headlineIds,
              clusterSizes: headlineIds.map(() => 1),
              stableClusterIds: null, // legacy shape: the parallel array is absent
            },
          ],
        },
      },
    }),
  );
}

describe('a persona answer and hydrated articles with no match metadata, no stable ids, no clusters and no titles', () => {
  // The read index is only consulted when the reader has opened something, so open one unrelated story.
  it('stores them all with null stable ids, none mistaken for a read story', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    await recordOpen({ articleId: 'opened-elsewhere', titleNorm: 'completely unrelated words', surface: 'feed' });
    const served = serveHydrate({
      article: (id) => {
        // clusters absent altogether (not an empty list); `sparse-title` keeps only the original-language title
        if (id === 'head-1') return art(id, { clusters: null as never });
        const bare = art(id, { clusters: null as never, title_en: null as never });
        if (id === 'sparse-none') return { ...bare, title: null as never };
        return bare;
      },
    });
    server.use(servePersonaWithoutMeta('formula 1', ['sparse-title', 'sparse-none'], ['head-1']), ...served.handlers);
    const t = makeCtx();
    const { fetched, diff } = await fetchAndDiff(t);

    const { result } = await hydrate(diff, t);

    expect(result.insertedCount).toBe(3);
    expect(t.log).not.toHaveBeenCalledWith(expect.stringContaining('already-read'));
    const rows = await stageRowsById(['sparse-title', 'sparse-none', 'head-1']);
    expect([...rows.keys()].sort()).toEqual(['head-1', 'sparse-none', 'sparse-title']);
    for (const row of rows.values()) expect(row.stableClusterId).toBeNull();
    // what the fetch step hands the persist step: no score and no stable id, for a topic hit and a headline hit
    const meta = fetched.personaMeta!.matchedTopics;
    expect(meta.get('sparse-title')).toEqual([
      { topicId: expect.any(String), text: 'formula 1', vectorScore: null, stableClusterId: null },
    ]);
    expect(meta.get('head-1')).toEqual([
      { topicId: null, text: 'top headline · global', vectorScore: null, stableClusterId: null },
    ]);
    // the title-less rows cannot be scored, so they are written terminal; the titled headline is not
    const all = await rowsById();
    expect(all.get('sparse-title')!.status).toBe('complete');
    expect(all.get('sparse-none')!.status).toBe('complete');
    expect(all.get('head-1')!.status).toBe('unscored');
  });
});

describe('a topic whose fact is gone', () => {
  it('is still requested, at the weight it carries on its own', async () => {
    // A bare topic row: the fact it names was deleted (no fact row under that id), which
    // `createTopics` accepts. The owning fact's weight multiplier then defaults to 1.
    await seedInterest('I follow racing', ['alpha']);
    await createTopics([
      { factId: 'ghost-fact', text: 'beta', weight: 1, status: 'active', provenance: 'llm', highPriority: false },
    ]);
    const sent = recordOps();

    await stepFetchTopicIds('', makeCtx().ctx);

    const [request] = await sent.named('GetArticleIdsForPersona');
    const topics = request.variables.query.topics as { text: string; limit: number }[];
    const alpha = topics.find((x) => x.text === 'alpha')!;
    const beta = topics.find((x) => x.text === 'beta')!;
    expect(beta).toBeDefined();
    expect(beta.limit).toBe(alpha.limit);
  });
});

describe('stepScore', () => {
  it('refuses to start once the run was aborted, as a cancellation', async () => {
    const t = makeCtx();
    t.abort();

    await expect(stepScore(t.ctx)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('the tracked-story reconcile with a bare suggestion row', () => {
  const subject = (articleId: string): FeedbackSubject => ({
    origin: 'suggestion',
    surface: 'for_you',
    articleId,
    title: `Seed ${articleId}`,
    pubDate: new Date('2026-10-09T06:00:00.000Z').toISOString(),
    publicationName: 'Seed Pub',
  });

  it('snapshots a member that has no publication, language or original title without those fields', async () => {
    await trackStoryWithProposal(subject('seed'), { label: 'Label gaza', searchText: 'gaza ceasefire' });
    const story = (await firstValueFrom(observeActive())).find((s) => s.topicText === 'gaza ceasefire')!;
    const topicId = story.topicId as string;
    // Bare row: a suggestion from a server that sent no publisher, no language and an empty original title.
    await persistAndLinkV2Suggestions(
      [art('bare1', { publication_name: null as never, language_code: null as never, title: '' })],
      new Map(),
      { matchedTopics: new Map([['bare1', [{ topicId, text: topicId }]]]) },
    );

    await reconcileTrackedStories();

    const snapshots: TrackedStoryMemberSnapshot[] = (await getTrackedStoryById(story.id))!.memberSnapshots ?? [];
    const snap = snapshots.find((s) => s.articleId === 'bare1')!;
    expect(snap).toBeDefined();
    expect(snap.title).toBe('Story bare1 sagabare1');
    expect(snap.titleOriginal).toBeUndefined();
    expect(snap.publicationName).toBeUndefined();
    expect(snap.languageCode).toBeUndefined();
  });
});
