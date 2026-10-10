// FeedMetadata: the cold-start counters persisted in the `feed_metadata` settings row, through the
// service and through the for-you store that owns every writer. Every store setter must write the
// WHOLE object (`metaFromState(get())`): a hand-built object erases whatever field it omits, and
// `lastProcessingRunFinishedAt` is what flips both feed surfaces off "preparing". Replaces the
// persistFeedMetadata / loadFeedMetadata blocks of
// lib/database/services/__tests__/article-suggestion-service.test.ts.
import database from '@/lib/database';
import {
  loadFeedMetadata,
  persistFeedMetadata,
  type FeedMetadata,
} from '@/lib/database/services/article-suggestion-lifecycle';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { advanceUntilDone } from '@/test/helpers';
import { HOUR, T0, article, freezeClock, seed, toComplete } from './support';

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

const resetStore = () =>
  useForYouStore.setState(useForYouStore.getInitialState(), true);

beforeEach(() => {
  freezeClock();
  resetStore();
});

/** The setters persist without awaiting. The database serialises writes, so an empty write queued
 *  after them resolves once theirs have landed. A queued write starts from a timer, so the strict clock
 *  has to be driven until it is done. */
const drain = () => advanceUntilDone(database.write(async () => undefined));

describe('persistFeedMetadata / loadFeedMetadata', () => {
  const meta: FeedMetadata = {
    articleCount: 10,
    relevantArticleCount: 7,
    hasGeneratedTopics: true,
    lastProcessingRunFinishedAt: 1_234_567_890,
    lastNewArticlesAt: 1_234_567_999,
  };

  it('round-trips through the feed_metadata row', async () => {
    await persistFeedMetadata(meta);

    expect(await loadFeedMetadata()).toEqual(meta);
    expect(JSON.parse((await getSetting('feed_metadata'))!)).toEqual(meta);
  });

  it('overwrites the previous value instead of adding a second row', async () => {
    await persistFeedMetadata(meta);
    await persistFeedMetadata({ ...meta, articleCount: 11 });

    expect((await loadFeedMetadata())?.articleCount).toBe(11);
  });

  it('is null when nothing was stored', async () => {
    expect(await loadFeedMetadata()).toBeNull();
  });

  it('is null for a blob it cannot parse', async () => {
    await setSetting('feed_metadata', '{ not valid json }');

    expect(await loadFeedMetadata()).toBeNull();
  });

  it('reads a blob written before the newer fields existed', async () => {
    const old = { articleCount: 5, relevantArticleCount: 3, hasGeneratedTopics: false };
    await setSetting('feed_metadata', JSON.stringify(old));

    expect(await loadFeedMetadata()).toEqual(old);
  });
});

describe('through the for-you store', () => {
  it('every setter keeps every other persisted field', async () => {
    const { getState } = useForYouStore;

    getState().setCounts(10, 7);
    getState().markProcessingRunFinished();
    getState().setHasGeneratedTopics(false);
    getState().markNewArticlesArrived(T0 + HOUR);
    await drain();

    // the last writer ran after all the others and must not have erased any of them
    expect(await loadFeedMetadata()).toEqual({
      articleCount: 10,
      relevantArticleCount: 7,
      hasGeneratedTopics: false,
      lastProcessingRunFinishedAt: T0,
      lastNewArticlesAt: T0 + HOUR,
    });
  });

  it('removeSuggestion persists the lowered relevant count and keeps the rest', async () => {
    await seed([article('a1'), article('a2')]);
    await toComplete('a1', 0.8);
    await toComplete('a2', 0.8);
    const { getState } = useForYouStore;
    await getState().hydrateSuggestionsFromDb();
    getState().setCounts(2, 2);
    getState().markNewArticlesArrived(T0);

    getState().removeSuggestion('a1');
    await drain();

    expect(await loadFeedMetadata()).toMatchObject({ articleCount: 2, relevantArticleCount: 1, lastNewArticlesAt: T0 });
  });

  describe('hydrateMetadataFromDb', () => {
    it('restores the counters and both timestamps', async () => {
      await persistFeedMetadata({
        articleCount: 42,
        relevantArticleCount: 9,
        hasGeneratedTopics: false,
        lastProcessingRunFinishedAt: T0 - HOUR,
        lastNewArticlesAt: T0 - 2 * HOUR,
      });

      await useForYouStore.getState().hydrateMetadataFromDb();

      expect(useForYouStore.getState()).toMatchObject({
        articleCount: 42,
        relevantArticleCount: 9,
        hasGeneratedTopics: false,
        lastProcessingRunFinishedAt: T0 - HOUR,
        lastNewArticlesAt: T0 - 2 * HOUR,
        asyncJobPhase: 'idle',
      });
    });

    it('leaves the timestamps null for a blob written before they existed', async () => {
      await setSetting('feed_metadata', JSON.stringify({ articleCount: 5, relevantArticleCount: 3, hasGeneratedTopics: true }));

      await useForYouStore.getState().hydrateMetadataFromDb();

      expect(useForYouStore.getState()).toMatchObject({
        articleCount: 5,
        lastProcessingRunFinishedAt: null,
        lastNewArticlesAt: null,
      });
    });

    it('falls back to the rows on the device when nothing was persisted', async () => {
      await seed([article('a1'), article('a2')]);
      await toComplete('a1', 0.8);
      await useForYouStore.getState().hydrateSuggestionsFromDb();

      await useForYouStore.getState().hydrateMetadataFromDb();

      expect(useForYouStore.getState()).toMatchObject({
        articleCount: 2,
        relevantArticleCount: 1,
        hasGeneratedTopics: true,
        lastProcessingRunFinishedAt: null,
      });
    });

    it('a setter written after the restore keeps the restored timestamps', async () => {
      await persistFeedMetadata({
        articleCount: 42,
        relevantArticleCount: 9,
        hasGeneratedTopics: true,
        lastProcessingRunFinishedAt: T0 - HOUR,
        lastNewArticlesAt: T0 - 2 * HOUR,
      });
      await useForYouStore.getState().hydrateMetadataFromDb();

      useForYouStore.getState().setHasGeneratedTopics(false);
      await drain();

      expect(await loadFeedMetadata()).toEqual({
        articleCount: 42,
        relevantArticleCount: 9,
        hasGeneratedTopics: false,
        lastProcessingRunFinishedAt: T0 - HOUR,
        lastNewArticlesAt: T0 - 2 * HOUR,
      });
    });
  });
});
