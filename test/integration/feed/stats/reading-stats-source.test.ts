// loadReadingStats over the real tables: visits, saved items and followed stories are
// written through their own services and read back the way the Stats card reads them.
import database from '@/lib/database';
import { recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import {
  keepArticleForFactCheck,
  keepArticleForTrackedStory,
  saveStandaloneArticle,
  saveSuggestion,
} from '@/lib/database/services/saved-article-suggestion-service';
import { trackStory } from '@/lib/database/services/tracked-story-service';
import { loadReadingStats } from '@/lib/stats/reading-stats-source';
import { useFakeClock } from '@/test/helpers';
import { newsArticle, seedSuggestion } from '../detail/seed';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
  },
}));
import logger from '@/lib/logger';
const mockCaptureException = logger.captureException as jest.Mock;

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

/** One tap on "Read Article", stamped one hour before NOW (the service stamps visitedAt from the clock). */
async function visit(over: Partial<Parameters<typeof recordPublicationVisit>[0]> = {}, at = NOW - HOUR) {
  useFakeClock(at);
  await recordPublicationVisit({
    articleId: 'a1',
    publicationName: 'Le Monde',
    countryCode: 'FR',
    languageCode: 'fr',
    pubDate: NOW - 3 * HOUR,
    ...over,
  });
  useFakeClock(NOW);
}

afterEach(() => jest.restoreAllMocks());

describe('loadReadingStats', () => {
  it('maps rows into the pure core and returns its result', async () => {
    await visit();

    const stats = await loadReadingStats({ nowMs: NOW });

    expect(stats.publicationCount).toBe(1);
    expect(stats.countryCount).toBe(1);
    expect(stats.openedAtSourceCount).toBe(1);
    // visitedAt NOW-1h minus pubDate NOW-3h = 2 hours of publish-to-read latency.
    expect(stats.publishToRead.averageHours).toBe(2);
    expect(stats.publishToRead.sampledArticles).toBe(1);
    expect(stats.publishToRead.totalArticles).toBe(1);
  });

  it('passes the top-publication limit through', async () => {
    await visit({ articleId: 'a1', publicationName: 'A' });
    await visit({ articleId: 'a2', publicationName: 'B' });

    const stats = await loadReadingStats({ nowMs: NOW, topPublicationLimit: 1 });

    expect(stats.topPublications).toHaveLength(1);
  });

  it('defaults nowMs to the clock when the caller does not inject one', async () => {
    await visit();
    useFakeClock(NOW);

    const stats = await loadReadingStats();

    expect(stats.publicationCount).toBe(1);
  });

  it('returns the empty shape and reports when a read throws', async () => {
    await visit();
    // The visit read swallows its own errors, so the failure that reaches this catch is the
    // saved-items read. One catch covers all reads: a card with real countries beside a
    // silently-zero saved count would be half true.
    const saved = database.get('saved_article_suggestions');
    jest.spyOn(saved, 'query').mockImplementationOnce(() => {
      throw new Error('db gone');
    });

    const stats = await loadReadingStats({ nowMs: NOW });

    expect(stats.publicationCount).toBe(0);
    expect(stats.publishToRead.averageHours).toBeNull();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { service: 'reading-stats', method: 'loadReadingStats' } }),
    );
  });

  it('a failing visit read is swallowed by its own service: no visits, saved and followed still count', async () => {
    await visit();
    await trackStory({ articleId: 'f1', title: 'A followed story', originSurface: 'feed' });
    const visits = database.get('publication_visits');
    jest.spyOn(visits, 'query').mockImplementationOnce(() => {
      throw new Error('visits gone');
    });

    const stats = await loadReadingStats({ nowMs: NOW });

    expect(stats.publicationCount).toBe(0);
    expect(stats.keptNow).toEqual({ savedArticles: 0, followedStories: 1 });
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { service: 'publication-visit', method: 'getAllVisitedArticles' } }),
    );
  });
});

describe('aggregation across rows', () => {
  it('sums taps from several rows into one publication, one country and one language', async () => {
    // Two articles with no article id are deduped by URL; each is tapped twice, so each row has
    // visitCount 2 and the key `Le Monde FR` is built from two rows, four taps.
    for (const url of ['https://lemonde.fr/1', 'https://lemonde.fr/2']) {
      await visit({ articleId: null, articleUrl: url });
      await visit({ articleId: null, articleUrl: url });
    }
    await visit({ articleId: 'b1', publicationName: 'Der Spiegel', countryCode: 'DE', languageCode: 'de' });

    const stats = await loadReadingStats({ nowMs: NOW });

    expect(stats.publicationCount).toBe(2);
    expect(stats.topPublications).toEqual([
      { publicationName: 'Le Monde', countryCode: 'FR', visitCount: 4 },
      { publicationName: 'Der Spiegel', countryCode: 'DE', visitCount: 1 },
    ]);
    expect(stats.countries).toEqual([
      { countryCode: 'FR', visitCount: 4 },
      { countryCode: 'DE', visitCount: 1 },
    ]);
    expect(stats.languages).toEqual([
      { languageCode: 'fr', visitCount: 4 },
      { languageCode: 'de', visitCount: 1 },
    ]);
  });
});

describe('the present-tense figures', () => {
  it('counts saved items and active followed stories', async () => {
    await saveSuggestion(await seedSuggestion({ _id: 's-suggestion' }));
    await saveStandaloneArticle(newsArticle('s-article'));
    // Retention rows keep an article openable; nobody saved them, so they must not count.
    await keepArticleForFactCheck({ articleId: 'fc-1', title: 'Checked', articleUrl: 'https://x.test/fc' });
    await keepArticleForTrackedStory({ articleId: 'ts-1', title: 'Followed', articleUrl: 'https://x.test/ts' });
    for (const id of ['s1', 's2', 's3']) {
      await trackStory({ articleId: id, title: `Story ${id}`, originSurface: 'feed' });
    }

    const stats = await loadReadingStats({ nowMs: NOW });

    expect(stats.keptNow).toEqual({ savedArticles: 2, followedStories: 3 });
  });

  it('takes the first emission without waiting for a second', async () => {
    // A WatermelonDB observable never completes, so anything that waits for completion hangs
    // here rather than failing.
    await trackStory({ articleId: 'only', title: 'Only story', originSurface: 'feed' });

    const stats = await loadReadingStats({ nowMs: NOW });

    expect(stats.keptNow.followedStories).toBe(1);
  });

  it('gives an empty card rather than a half-true one when a read fails', async () => {
    await visit();
    const saved = database.get('saved_article_suggestions');
    jest.spyOn(saved, 'query').mockImplementationOnce(() => {
      throw new Error('saved table unavailable');
    });

    const stats = await loadReadingStats({ nowMs: NOW });

    expect(stats.publicationCount).toBe(0);
    expect(stats.keptNow).toEqual({ savedArticles: 0, followedStories: 0 });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
