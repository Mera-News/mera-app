// publication-visit-service at its seam: the real service over the in-memory DB, the clock faked.
// Replaces lib/database/services/__tests__/publication-visit-service.test.ts. The legacy suite ran
// on a database mock that IGNORED every Q.where, so it could only pin the JS dedupe. Here the
// WHERE clauses, the 30-day window and the grouping key are real.
//
// TABLE_ROW_CAPS is applied by the backup exporter, not by this service, so no cap is tested here.
import {
  clearAllVisits,
  getAllVisitedArticles,
  getTopVisitedPublications,
  getVisitCountForPublication,
  getVisitedArticleById,
  getVisitsForPublication,
  pruneStaleVisits,
  recordPublicationVisit,
  type RecordPublicationVisitInput,
} from '@/lib/database/services/publication-visit-service';
import { useStrictClock } from '@/test/helpers';
import { countRows, countWrites, DAY_MS, failNextQuery, quietLogger, restoreFaults, T0 } from './support';

const WINDOW = 30 * DAY_MS;

let log: ReturnType<typeof quietLogger>;
beforeEach(() => {
  useStrictClock(T0);
  log = quietLogger();
});
afterEach(restoreFaults);

const at = (ms: number) => jest.setSystemTime(ms);

/** Records a visit as if it happened at `ms`, then puts the clock back at `T0`. */
async function visitAt(ms: number, input: RecordPublicationVisitInput): Promise<void> {
  at(ms);
  await recordPublicationVisit(input);
  at(T0);
}

const times = (over: Partial<RecordPublicationVisitInput> = {}): RecordPublicationVisitInput => ({
  publicationName: 'The Times',
  countryCode: 'GB',
  articleId: 'a1',
  ...over,
});

const expectCaptured = (method: string) =>
  expect(log.captureException).toHaveBeenCalledWith(
    expect.any(Error),
    expect.objectContaining({ tags: { service: 'publication-visit', method } }),
  );

describe('recordPublicationVisit', () => {
  it('writes nothing for a missing or blank publication name', async () => {
    await recordPublicationVisit({ publicationName: null, countryCode: 'US' });
    await recordPublicationVisit({ publicationName: undefined, countryCode: 'US' });
    await recordPublicationVisit({ publicationName: '   ', countryCode: 'US' });
    expect(await countRows('publication_visits')).toBe(0);
  });

  it('stores the trimmed name and every snapshot field of the first visit', async () => {
    await recordPublicationVisit({
      publicationName: '  The Times ',
      countryCode: 'GB',
      articleId: 'a1',
      articleSuggestionId: 'sugg-1',
      articleUrl: 'https://example.com/1',
      titleEn: 'Title',
      titleOriginal: 'Titre',
      languageCode: 'fr',
      imageUrl: 'https://img.example.com/1.jpg',
      pubDate: new Date('2026-10-01T08:00:00Z'),
    });

    expect(await getVisitedArticleById('a1')).toEqual({
      articleId: 'a1',
      articleSuggestionId: 'sugg-1',
      articleUrl: 'https://example.com/1',
      publicationName: 'The Times',
      countryCode: 'GB',
      titleEn: 'Title',
      titleOriginal: 'Titre',
      languageCode: 'fr',
      imageUrl: 'https://img.example.com/1.jpg',
      pubDate: Date.parse('2026-10-01T08:00:00Z'),
      visitedAt: T0,
      visitCount: 1,
    });
  });

  it('a repeat visit to the same article updates one row in place: visitedAt moves, snapshot fields refresh', async () => {
    await recordPublicationVisit(times({ titleEn: 'Old Title', articleUrl: 'https://old.example.com' }));
    await visitAt(T0 + 5000, times({ titleEn: 'New Title', articleUrl: 'https://new.example.com' }));

    expect(await countRows('publication_visits')).toBe(1);
    const row = await getVisitedArticleById('a1');
    expect(row).toMatchObject({
      titleEn: 'New Title',
      articleUrl: 'https://new.example.com',
      visitedAt: T0 + 5000,
      visitCount: 1,
    });
  });

  it('a repeat visit fills every snapshot field it can supply', async () => {
    await recordPublicationVisit(times());
    await visitAt(
      T0 + 1000,
      times({
        articleSuggestionId: 'sugg-new',
        titleEn: 'New EN Title',
        titleOriginal: 'New Original',
        languageCode: 'de',
        imageUrl: 'https://new-img.example.com/1.jpg',
        pubDate: new Date('2024-05-01T00:00:00Z'),
      }),
    );

    expect(await getVisitedArticleById('a1')).toMatchObject({
      articleSuggestionId: 'sugg-new',
      titleEn: 'New EN Title',
      titleOriginal: 'New Original',
      languageCode: 'de',
      imageUrl: 'https://new-img.example.com/1.jpg',
      pubDate: Date.parse('2024-05-01T00:00:00Z'),
    });
  });

  it('a repeat visit never blanks a snapshot field it cannot supply', async () => {
    await recordPublicationVisit(
      times({ titleEn: 'Existing Title', imageUrl: 'https://img.example.com/pic.jpg', pubDate: new Date('2026-10-02T00:00:00Z') }),
    );
    await visitAt(T0 + 1000, times({ titleEn: null, imageUrl: null, pubDate: null }));

    expect(await getVisitedArticleById('a1')).toMatchObject({
      titleEn: 'Existing Title',
      imageUrl: 'https://img.example.com/pic.jpg',
      pubDate: Date.parse('2026-10-02T00:00:00Z'),
    });
  });

  it('identity is (name, country, article): the same article under another country or name is its own row', async () => {
    await recordPublicationVisit(times());
    await recordPublicationVisit(times({ countryCode: 'US' }));
    await recordPublicationVisit(times({ publicationName: 'The Times Online' }));
    await recordPublicationVisit(times({ countryCode: null }));
    expect(await countRows('publication_visits')).toBe(4);
  });

  it('a null country repeats in place too', async () => {
    await recordPublicationVisit(times({ countryCode: null }));
    await visitAt(T0 + 1000, times({ countryCode: null }));
    expect(await countRows('publication_visits')).toBe(1);
  });

  it('a visit without an article id always inserts a fresh row', async () => {
    await recordPublicationVisit({ publicationName: 'BBC', countryCode: 'GB', articleId: null });
    await recordPublicationVisit({ publicationName: 'BBC', countryCode: 'GB', articleId: null });
    expect(await countRows('publication_visits')).toBe(2);
  });

  it.each([
    ['a valid Date', new Date('2024-03-15T10:00:00Z'), Date.parse('2024-03-15T10:00:00Z')],
    ['an ISO string', '2024-03-15T10:00:00Z', Date.parse('2024-03-15T10:00:00Z')],
    ['epoch milliseconds', Date.parse('2024-03-15T10:00:00Z'), Date.parse('2024-03-15T10:00:00Z')],
    ['an Invalid Date', new Date('invalid-date'), null],
    ['an unparseable string', 'not-a-valid-date', null],
  ])('pubDate given as %s is stored as %s ms', async (_label, pubDate, expected) => {
    await recordPublicationVisit(times({ pubDate }));
    expect((await getVisitedArticleById('a1'))?.pubDate).toBe(expected);
  });

  it('captures and swallows a failure', async () => {
    failNextQuery('publication_visits');
    await expect(recordPublicationVisit(times())).resolves.toBeUndefined();
    expectCaptured('record');
    expect(await countRows('publication_visits')).toBe(0);
  });
});

describe('getVisitCountForPublication', () => {
  it('is 0 for a blank name', async () => {
    await recordPublicationVisit(times());
    expect(await getVisitCountForPublication('', 'GB')).toBe(0);
    expect(await getVisitCountForPublication('   ', 'GB')).toBe(0);
  });

  it('counts only the visits of that (name, country)', async () => {
    await recordPublicationVisit({ publicationName: 'BBC', countryCode: 'GB', articleId: 'a1' });
    await recordPublicationVisit({ publicationName: 'BBC', countryCode: 'GB', articleId: 'a2' });
    await recordPublicationVisit({ publicationName: 'BBC', countryCode: 'US', articleId: 'a3' });
    await recordPublicationVisit({ publicationName: 'CNN', countryCode: 'GB', articleId: 'a4' });
    await recordPublicationVisit({ publicationName: 'BBC', countryCode: null, articleId: 'a5' });

    expect(await getVisitCountForPublication('BBC', 'GB')).toBe(2);
    expect(await getVisitCountForPublication(' BBC ', 'US')).toBe(1);
    expect(await getVisitCountForPublication('BBC', null)).toBe(1);
    expect(await getVisitCountForPublication('BBC', 'FR')).toBe(0);
  });

  it('counts inside the window: the cutoff itself is in, a millisecond before it is out; windowMs widens it', async () => {
    await visitAt(T0 - WINDOW, times({ articleId: 'edge' }));
    await visitAt(T0 - WINDOW - 1, times({ articleId: 'late' }));
    await visitAt(T0 - 1000, times({ articleId: 'fresh' }));

    expect(await getVisitCountForPublication('The Times', 'GB')).toBe(2);
    expect(await getVisitCountForPublication('The Times', 'GB', 60 * DAY_MS)).toBe(3);
    expect(await getVisitCountForPublication('The Times', 'GB', 500)).toBe(0);
  });

  it('is 0 and captured when the query fails', async () => {
    failNextQuery('publication_visits');
    expect(await getVisitCountForPublication('The Times', 'GB')).toBe(0);
    expectCaptured('getCount');
  });
});

describe('getVisitsForPublication (dedupe by article id, else URL, else row)', () => {
  it('is empty for a blank name and for a publication never visited', async () => {
    expect(await getVisitsForPublication('', null)).toEqual([]);
    expect(await getVisitsForPublication('The Times', 'GB')).toEqual([]);
  });

  it('returns only the rows of that (name, country)', async () => {
    await recordPublicationVisit(times({ articleId: 'mine' }));
    await recordPublicationVisit(times({ articleId: 'other-country', countryCode: 'US' }));
    await recordPublicationVisit(times({ articleId: 'other-pub', publicationName: 'CNN' }));

    const result = await getVisitsForPublication('The Times', 'GB');
    expect(result.map((r) => r.articleId)).toEqual(['mine']);
    expect(result[0]).toMatchObject({ visitCount: 1, visitedAt: T0, publicationName: 'The Times', countryCode: 'GB' });
  });

  it('collapses rows with the same article URL (no article id) into one with a visit count and the latest tap', async () => {
    await visitAt(T0 - 2000, { publicationName: 'The Times', countryCode: 'GB', articleUrl: 'https://example.com/a' });
    await visitAt(T0, { publicationName: 'The Times', countryCode: 'GB', articleUrl: 'https://example.com/a' });

    const result = await getVisitsForPublication('The Times', 'GB');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ visitCount: 2, visitedAt: T0, articleId: null });
  });

  it('keeps rows separate when neither article id nor URL is known', async () => {
    await recordPublicationVisit({ publicationName: 'The Times', countryCode: 'GB' });
    await recordPublicationVisit({ publicationName: 'The Times', countryCode: 'GB' });
    expect(await getVisitsForPublication('The Times', 'GB')).toHaveLength(2);
  });

  it('a collapsed entry takes the freshest non-null snapshot fields', async () => {
    const url = 'https://example.com/a';
    await visitAt(T0 - 5000, { publicationName: 'The Times', countryCode: 'GB', articleUrl: url, titleEn: 'Old Title', imageUrl: null });
    await visitAt(T0, {
      publicationName: 'The Times',
      countryCode: 'GB',
      articleUrl: url,
      titleEn: 'New Title',
      imageUrl: 'https://img.example.com/new.jpg',
    });

    const [entry] = await getVisitsForPublication('The Times', 'GB');
    expect(entry.titleEn).toBe('New Title');
    expect(entry.imageUrl).toBe('https://img.example.com/new.jpg');
  });

  // DATA-U10b-4 / DA23. dedupeVisitRows builds an entry from the FIRST row it meets and only merges a
  // later row's snapshot fields when that row is newer; the queries have no sort. So the merged result
  // depends on row order: a newest row that lacks a title, suggestion id or pubDate hides the older
  // rows' values when it arrives first. The correct result (freshest non-null field wins) must not
  // depend on insertion order, so the test builds the same two visits in BOTH orders.
  // Loki returns the rows of a filtered query newest-inserted first (an unfiltered query oldest first);
  // SQLite's order for the same query is not verified here.
  describe('a newest visit that lacks fields (DATA-U10b-4, DA23)', () => {
    const url = 'https://example.com/a';
    const pubDate = new Date('2024-06-01T00:00:00Z');
    const olderVisit = (): [number, RecordPublicationVisitInput] => [
      T0 - 5000,
      { publicationName: 'The Times', countryCode: 'GB', articleUrl: url, titleEn: 'Preserved Title', articleSuggestionId: 'sugg-first', pubDate },
    ];
    const newestVisit = (): [number, RecordPublicationVisitInput] => [
      T0,
      { publicationName: 'The Times', countryCode: 'GB', articleUrl: url, titleEn: null, articleSuggestionId: null, pubDate: null },
    ];
    const merged = async () => {
      const [entry] = await getVisitsForPublication('The Times', 'GB');
      return { titleEn: entry.titleEn, articleSuggestionId: entry.articleSuggestionId, pubDate: entry.pubDate, visitedAt: entry.visitedAt };
    };

    test.failing('the freshest non-null title, suggestion id and pubDate win, whichever order the visits were inserted in', async () => {
      const expected = { titleEn: 'Preserved Title', articleSuggestionId: 'sugg-first', pubDate: pubDate.getTime(), visitedAt: T0 };
      for (const order of [[olderVisit, newestVisit], [newestVisit, olderVisit]]) {
        await clearAllVisits();
        for (const visit of order) await visitAt(...visit());
        expect(await merged()).toEqual(expected);
      }
    });

    it('DA23 today (Loki row order): with the newest visit inserted last, the older title, suggestion id and pubDate are lost', async () => {
      await visitAt(...olderVisit());
      await visitAt(...newestVisit());

      expect(await merged()).toEqual({ titleEn: null, articleSuggestionId: null, pubDate: null, visitedAt: T0 });
    });
  });

  it('takes pubDate from the newest visit when it has one', async () => {
    const url = 'https://example.com/a';
    const first = new Date('2024-01-01T00:00:00Z');
    const second = new Date('2024-06-01T00:00:00Z');
    await visitAt(T0 - 3000, { publicationName: 'The Times', countryCode: 'GB', articleUrl: url, pubDate: first });
    await visitAt(T0 - 2000, { publicationName: 'The Times', countryCode: 'GB', articleUrl: url, pubDate: second });
    expect((await getVisitsForPublication('The Times', 'GB'))[0].pubDate).toBe(second.getTime());
  });

  it('preserves a null pubDate', async () => {
    await recordPublicationVisit(times());
    expect((await getVisitsForPublication('The Times', 'GB'))[0].pubDate).toBeNull();
  });

  it('sorts by the latest tap, newest first', async () => {
    await visitAt(T0 - 10_000, times({ articleId: 'old' }));
    await visitAt(T0, times({ articleId: 'recent' }));
    await visitAt(T0 - 5000, times({ articleId: 'middle' }));

    expect((await getVisitsForPublication('The Times', 'GB')).map((r) => r.articleId)).toEqual(['recent', 'middle', 'old']);
  });

  it('lists only the last 30 days by default (the cutoff is in), and windowMs widens it', async () => {
    await visitAt(T0 - WINDOW - 1, times({ articleId: 'late' }));
    await visitAt(T0 - WINDOW, times({ articleId: 'edge' }));
    await visitAt(T0 - DAY_MS, times({ articleId: 'fresh' }));

    expect((await getVisitsForPublication('The Times', 'GB')).map((r) => r.articleId)).toEqual(['fresh', 'edge']);
    expect(await getVisitsForPublication('The Times', 'GB', 60 * DAY_MS)).toHaveLength(3);
  });

  it('is empty and captured when the query fails', async () => {
    failNextQuery('publication_visits');
    expect(await getVisitsForPublication('The Times', 'GB')).toEqual([]);
    expectCaptured('getVisitsForPublication');
  });
});

describe('getAllVisitedArticles (the 30-day export)', () => {
  it('is empty with no visits', async () => {
    expect(await getAllVisitedArticles()).toEqual([]);
  });

  it('spans every publication', async () => {
    await recordPublicationVisit({ publicationName: 'BBC', countryCode: 'GB', articleId: 'a1' });
    await recordPublicationVisit({ publicationName: 'CNN', countryCode: 'US', articleId: 'a2' });

    const result = await getAllVisitedArticles();
    expect(result.map((r) => r.publicationName).sort()).toEqual(['BBC', 'CNN']);
  });

  it('dedupes by article id across publications and counts the taps', async () => {
    await visitAt(T0 - 1000, { publicationName: 'BBC', countryCode: 'GB', articleId: 'a1' });
    await visitAt(T0, { publicationName: 'BBC World', countryCode: 'GB', articleId: 'a1' });

    const result = await getAllVisitedArticles();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ articleId: 'a1', visitCount: 2, visitedAt: T0 });
  });

  it('sorts newest first', async () => {
    await visitAt(T0 - 10_000, times({ articleId: 'old' }));
    await visitAt(T0, times({ articleId: 'recent' }));
    expect((await getAllVisitedArticles()).map((r) => r.articleId)).toEqual(['recent', 'old']);
  });

  it('is capped at 30 days: the cutoff itself is in, a millisecond before it is out, and nothing widens it', async () => {
    await visitAt(T0 - WINDOW - 1, times({ articleId: 'late' }));
    await visitAt(T0 - WINDOW, times({ articleId: 'edge' }));
    await visitAt(T0 - DAY_MS, times({ articleId: 'fresh' }));

    expect((await getAllVisitedArticles()).map((r) => r.articleId)).toEqual(['fresh', 'edge']);
  });

  it('preserves a null pubDate', async () => {
    await recordPublicationVisit(times());
    expect((await getAllVisitedArticles())[0].pubDate).toBeNull();
  });

  it('is empty and captured when the query fails', async () => {
    failNextQuery('publication_visits');
    expect(await getAllVisitedArticles()).toEqual([]);
    expectCaptured('getAllVisitedArticles');
  });
});

describe('getVisitedArticleById (the article-detail fallback once the server row has gone)', () => {
  it('returns the snapshot of a visited article', async () => {
    await recordPublicationVisit(
      times({
        articleId: 'article-7',
        articleUrl: 'https://example.com/1',
        titleEn: 'Test Article',
        titleOriginal: 'Test Article Original',
        languageCode: 'en',
      }),
    );
    expect(await getVisitedArticleById('article-7')).toMatchObject({
      articleId: 'article-7',
      articleUrl: 'https://example.com/1',
      titleEn: 'Test Article',
      titleOriginal: 'Test Article Original',
      languageCode: 'en',
      publicationName: 'The Times',
      countryCode: 'GB',
    });
  });

  it('trims the id it is given', async () => {
    await recordPublicationVisit(times({ articleId: 'article-7' }));
    expect((await getVisitedArticleById('  article-7 '))?.articleId).toBe('article-7');
  });

  it('is null for an article never visited and for a blank id', async () => {
    await recordPublicationVisit(times({ articleId: 'other' }));
    expect(await getVisitedArticleById('article-7')).toBeNull();
    expect(await getVisitedArticleById('   ')).toBeNull();
  });

  it('prefers the freshest visit and counts every row', async () => {
    await visitAt(T0 - 10_000, { publicationName: 'The Times', countryCode: 'GB', articleId: 'article-7', titleEn: null, languageCode: null });
    await visitAt(T0, { publicationName: 'The Times Online', countryCode: 'GB', articleId: 'article-7', titleEn: 'Fresh title', languageCode: 'de' });

    const result = await getVisitedArticleById('article-7');
    expect(result).toMatchObject({ titleEn: 'Fresh title', languageCode: 'de', publicationName: 'The Times Online', visitCount: 2, visitedAt: T0 });
  });

  it('is null and captured, with the article id, when the query fails', async () => {
    failNextQuery('publication_visits');
    expect(await getVisitedArticleById('article-7')).toBeNull();
    expect(log.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { service: 'publication-visit', method: 'getVisitedArticleById' }, extra: { articleId: 'article-7' } }),
    );
  });
});

describe('pruneStaleVisits', () => {
  const names = async () => (await getTopVisitedPublications({ windowMs: 365 * DAY_MS })).map((p) => p.publicationName).sort();

  it('removes only the rows past the window: the cutoff itself stays', async () => {
    await visitAt(T0 - WINDOW - DAY_MS, { publicationName: 'Stale', countryCode: 'GB', articleId: 's' });
    await visitAt(T0 - WINDOW - 1, { publicationName: 'JustStale', countryCode: 'GB', articleId: 'j' });
    await visitAt(T0 - WINDOW, { publicationName: 'Edge', countryCode: 'GB', articleId: 'e' });
    await visitAt(T0 - DAY_MS, { publicationName: 'Fresh', countryCode: 'GB', articleId: 'f' });

    await pruneStaleVisits();

    expect(await names()).toEqual(['Edge', 'Fresh']);
  });

  it('takes a custom window', async () => {
    await visitAt(T0 - 10 * DAY_MS, { publicationName: 'TenDays', countryCode: 'GB', articleId: 't' });
    await visitAt(T0 - DAY_MS, { publicationName: 'OneDay', countryCode: 'GB', articleId: 'o' });

    await pruneStaleVisits(7 * DAY_MS);

    expect(await names()).toEqual(['OneDay']);
  });

  it('opens no write when nothing is stale', async () => {
    await recordPublicationVisit(times());
    const writes = countWrites();
    await pruneStaleVisits();
    expect(writes).not.toHaveBeenCalled();
    expect(await countRows('publication_visits')).toBe(1);
  });

  it('swallows a failing fetch, captures it, and leaves the rows', async () => {
    await visitAt(T0 - WINDOW - DAY_MS, times({ articleId: 'stale' }));
    failNextQuery('publication_visits', new Error('prune error'));

    await expect(pruneStaleVisits()).resolves.toBeUndefined();

    expectCaptured('prune');
    expect(await countRows('publication_visits')).toBe(1);
  });
});

describe('clearAllVisits', () => {
  it('opens no write when there are no visits', async () => {
    const writes = countWrites();
    await clearAllVisits();
    expect(writes).not.toHaveBeenCalled();
  });

  it('destroys every row in a single write', async () => {
    await recordPublicationVisit(times({ articleId: 'a1' }));
    await recordPublicationVisit(times({ articleId: 'a2' }));
    await recordPublicationVisit({ publicationName: 'CNN', countryCode: 'US', articleId: 'a3' });
    const writes = countWrites();

    await clearAllVisits();

    expect(writes).toHaveBeenCalledTimes(1);
    expect(await countRows('publication_visits')).toBe(0);
    expect(await getAllVisitedArticles()).toEqual([]);
  });

  it('captures a failure and rethrows it, leaving the rows', async () => {
    await recordPublicationVisit(times());
    failNextQuery('publication_visits', new Error('clear error'));

    await expect(clearAllVisits()).rejects.toThrow('clear error');

    expectCaptured('clearAll');
    expect(await countRows('publication_visits')).toBe(1);
  });
});

describe('getTopVisitedPublications (grouped by (publicationName, countryCode))', () => {
  it('is empty with no visits', async () => {
    expect(await getTopVisitedPublications()).toEqual([]);
  });

  it('groups and counts per (name, country), the same name in two countries staying apart', async () => {
    await visitAt(T0, { publicationName: 'BBC', countryCode: 'GB', articleId: 'a1' });
    await visitAt(T0 - 1000, { publicationName: 'BBC', countryCode: 'GB', articleId: 'a2' });
    await visitAt(T0 - 2000, { publicationName: 'BBC', countryCode: 'US', articleId: 'a3' });
    await visitAt(T0 - 3000, { publicationName: 'CNN', countryCode: 'US', articleId: 'a4' });

    const result = await getTopVisitedPublications();
    expect(result.map((p) => [p.publicationName, p.countryCode, p.visitCount])).toEqual([
      ['BBC', 'GB', 2],
      ['BBC', 'US', 1],
      ['CNN', 'US', 1],
    ]);
  });

  it('keeps ("A", "B C") apart from ("A B", "C"): the group key separator is not a space', async () => {
    await recordPublicationVisit({ publicationName: 'A', countryCode: 'B C', articleId: 'a1' });
    await recordPublicationVisit({ publicationName: 'A B', countryCode: 'C', articleId: 'a2' });
    await recordPublicationVisit({ publicationName: 'A B', countryCode: 'C', articleId: 'a3' });

    const result = await getTopVisitedPublications();
    expect(result.map((p) => [p.publicationName, p.countryCode, p.visitCount])).toEqual([
      ['A B', 'C', 2],
      ['A', 'B C', 1],
    ]);
  });

  it('sorts by visit count, then by the latest tap, newest first', async () => {
    await visitAt(T0, { publicationName: 'Single', countryCode: 'GB', articleId: 's1' });
    await visitAt(T0 - 5000, { publicationName: 'SingleOlder', countryCode: 'GB', articleId: 'o1' });
    await visitAt(T0 - 9000, { publicationName: 'Double', countryCode: 'GB', articleId: 'd1' });
    await visitAt(T0 - 8000, { publicationName: 'Double', countryCode: 'GB', articleId: 'd2' });

    expect((await getTopVisitedPublications()).map((p) => p.publicationName)).toEqual(['Double', 'Single', 'SingleOlder']);
  });

  it('reports the most recent tap as lastVisitedAt', async () => {
    await visitAt(T0 - 2000, { publicationName: 'BBC', countryCode: 'GB', articleId: 'a1' });
    await visitAt(T0, { publicationName: 'BBC', countryCode: 'GB', articleId: 'a2' });
    expect((await getTopVisitedPublications())[0].lastVisitedAt).toBe(T0);
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) await visitAt(T0 - i * 1000, { publicationName: `Pub${i}`, countryCode: 'GB', articleId: `a${i}` });
    const result = await getTopVisitedPublications({ limit: 3 });
    expect(result.map((p) => p.publicationName)).toEqual(['Pub0', 'Pub1', 'Pub2']);
  });

  it('groups a null country as its own group and reports it as null', async () => {
    await visitAt(T0, { publicationName: 'BBC', countryCode: null, articleId: 'a1' });
    await visitAt(T0 - 1000, { publicationName: 'BBC', countryCode: null, articleId: 'a2' });

    const result = await getTopVisitedPublications();
    expect(result).toEqual([{ publicationName: 'BBC', countryCode: null, visitCount: 2, lastVisitedAt: T0 }]);
  });

  it('counts the last 30 days by default (the cutoff is in) and takes a windowMs', async () => {
    await visitAt(T0 - WINDOW - 1, { publicationName: 'Late', countryCode: 'GB', articleId: 'l' });
    await visitAt(T0 - WINDOW, { publicationName: 'Edge', countryCode: 'GB', articleId: 'e' });
    await visitAt(T0 - 2 * DAY_MS, { publicationName: 'Recent', countryCode: 'GB', articleId: 'r' });

    expect((await getTopVisitedPublications()).map((p) => p.publicationName).sort()).toEqual(['Edge', 'Recent']);
    expect((await getTopVisitedPublications({ windowMs: DAY_MS })).map((p) => p.publicationName)).toEqual([]);
    expect(await getTopVisitedPublications({ windowMs: 60 * DAY_MS })).toHaveLength(3);
  });

  it('is empty and captured when the query fails', async () => {
    failNextQuery('publication_visits');
    expect(await getTopVisitedPublications()).toEqual([]);
    expectCaptured('getTop');
  });
});
