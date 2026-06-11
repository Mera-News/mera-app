// publication-visit-service unit tests — focuses on dedupe & aggregation logic.
// All WatermelonDB I/O is intercepted via makeDatabaseMock().

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn() },
}));

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import logger from '@/lib/logger';
import {
  recordPublicationVisit,
  getVisitCountForPublication,
  getVisitsForPublication,
  pruneStaleVisits,
  clearAllVisits,
  getTopVisitedPublications,
} from '../publication-visit-service';

const db = database as any;

const NOW = 1700000000000;

function makeVisitRecord(overrides: Record<string, unknown> = {}) {
  return makeRecord({
    id: `visit_${Math.random().toString(36).slice(2)}`,
    publicationName: 'The Times',
    countryCode: 'GB',
    articleId: 'article-1',
    articleSuggestionId: 'sugg-1',
    articleUrl: 'https://example.com/1',
    titleEn: 'Test Article',
    titleOriginal: 'Test Article Original',
    languageCode: 'en',
    imageUrl: null,
    pubDate: null,
    visitedAt: new Date(NOW),
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('publication_visits', []);
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// recordPublicationVisit
// ---------------------------------------------------------------------------

describe('recordPublicationVisit', () => {
  it('does nothing when publicationName is empty/null', async () => {
    await recordPublicationVisit({ publicationName: null, countryCode: 'US' });
    await recordPublicationVisit({ publicationName: '   ', countryCode: 'US' });
    expect(database.write).not.toHaveBeenCalled();
  });

  it('does nothing when publicationName is whitespace only', async () => {
    await recordPublicationVisit({ publicationName: '  ', countryCode: 'US' });
    expect(database.write).not.toHaveBeenCalled();
  });

  it('creates a new visit row when no existing match', async () => {
    db._setRows('publication_visits', []);
    await recordPublicationVisit({
      publicationName: 'The Times',
      countryCode: 'GB',
      articleId: 'a1',
    });
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(db._collections['publication_visits'].create).toHaveBeenCalledTimes(1);
  });

  it('updates existing row when article already visited', async () => {
    const existing = makeVisitRecord({ articleId: 'a1' });
    db._setRows('publication_visits', [existing]);

    await recordPublicationVisit({
      publicationName: 'The Times',
      countryCode: 'GB',
      articleId: 'a1',
      titleEn: 'Updated Title',
    });

    expect(existing.update).toHaveBeenCalledTimes(1);
    expect(db._collections['publication_visits'].create).not.toHaveBeenCalled();
  });

  it('refreshes visitedAt and snapshot fields on update', async () => {
    const existing = makeVisitRecord({ articleId: 'a1', titleEn: 'Old Title' });
    db._setRows('publication_visits', [existing]);

    const updatedAt = NOW + 5000;
    jest.spyOn(Date, 'now').mockReturnValue(updatedAt);

    await recordPublicationVisit({
      publicationName: 'The Times',
      countryCode: 'GB',
      articleId: 'a1',
      titleEn: 'New Title',
      articleUrl: 'https://new-url.com',
    });

    // update callback ran; check mutated fields
    expect(existing.titleEn).toBe('New Title');
    expect(existing.articleUrl).toBe('https://new-url.com');
  });

  it('does not overwrite existing snapshot fields with null on update', async () => {
    const existing = makeVisitRecord({
      articleId: 'a1',
      titleEn: 'Existing Title',
      imageUrl: 'https://img.com/pic.jpg',
    });
    db._setRows('publication_visits', [existing]);

    await recordPublicationVisit({
      publicationName: 'The Times',
      countryCode: 'GB',
      articleId: 'a1',
      titleEn: null, // null should not overwrite
      imageUrl: null,
    });

    // The update callback should not have clobbered existing non-null values
    expect(existing.titleEn).toBe('Existing Title');
    expect(existing.imageUrl).toBe('https://img.com/pic.jpg');
  });

  it('updates all optional snapshot fields when present on an existing record', async () => {
    const existing = makeVisitRecord({ articleId: 'a1' });
    db._setRows('publication_visits', [existing]);

    await recordPublicationVisit({
      publicationName: 'The Times',
      countryCode: 'GB',
      articleId: 'a1',
      articleSuggestionId: 'sugg-new',
      titleEn: 'New EN Title',
      titleOriginal: 'New Original',
      languageCode: 'de',
      imageUrl: 'https://new-img.com/1.jpg',
      pubDate: new Date('2024-05-01'),
    });

    expect(existing.articleSuggestionId).toBe('sugg-new');
    expect(existing.titleEn).toBe('New EN Title');
    expect(existing.titleOriginal).toBe('New Original');
    expect(existing.languageCode).toBe('de');
    expect(existing.imageUrl).toBe('https://new-img.com/1.jpg');
    expect(existing.pubDate).toBeInstanceOf(Date);
  });

  it('handles Invalid Date objects in pubDate by returning null', async () => {
    db._setRows('publication_visits', []);
    const capturedRecord: Record<string, unknown> = {};
    db._collections['publication_visits'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        const rec = makeRecord();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    const invalidDate = new Date('invalid-date');
    await recordPublicationVisit({
      publicationName: 'BBC',
      countryCode: 'GB',
      articleId: 'a1',
      pubDate: invalidDate,
    });
    expect(capturedRecord.pubDate).toBeNull();
  });

  it('always inserts a fresh row when no articleId provided', async () => {
    db._setRows('publication_visits', []);
    await recordPublicationVisit({
      publicationName: 'BBC',
      countryCode: 'GB',
      articleId: null,
    });
    await recordPublicationVisit({
      publicationName: 'BBC',
      countryCode: 'GB',
      articleId: null,
    });
    expect(db._collections['publication_visits'].create).toHaveBeenCalledTimes(2);
  });

  it('captures and swallows exceptions', async () => {
    db._collections['publication_visits'].query.mockImplementationOnce(() => {
      throw new Error('DB exploded');
    });
    await expect(
      recordPublicationVisit({ publicationName: 'BBC', countryCode: 'GB', articleId: 'a1' }),
    ).resolves.toBeUndefined();
    expect(logger.captureException).toHaveBeenCalledTimes(1);
  });

  it('parses pubDate from string', async () => {
    db._setRows('publication_visits', []);
    const capturedRecord: Record<string, unknown> = {};
    db._collections['publication_visits'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        const rec = makeRecord();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    await recordPublicationVisit({
      publicationName: 'BBC',
      countryCode: 'GB',
      articleId: 'a1',
      pubDate: '2024-03-15T10:00:00Z',
    });
    expect(capturedRecord.pubDate).toBeInstanceOf(Date);
  });

  it('sets pubDate to null for invalid date strings', async () => {
    db._setRows('publication_visits', []);
    const capturedRecord: Record<string, unknown> = {};
    db._collections['publication_visits'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        const rec = makeRecord();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    await recordPublicationVisit({
      publicationName: 'BBC',
      countryCode: 'GB',
      articleId: 'a1',
      pubDate: 'not-a-valid-date',
    });
    expect(capturedRecord.pubDate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getVisitCountForPublication
// ---------------------------------------------------------------------------

describe('getVisitCountForPublication', () => {
  it('returns 0 for empty publication name', async () => {
    const col = db.get('publication_visits');
    const qBefore = col.query.mock.calls.length;
    const result = await getVisitCountForPublication('', null);
    expect(result).toBe(0);
    // query should not be called for empty name
    expect(col.query.mock.calls.length).toBe(qBefore);
  });

  it('returns 0 for whitespace publication name', async () => {
    const result = await getVisitCountForPublication('   ', null);
    expect(result).toBe(0);
  });

  it('returns the count from fetchCount', async () => {
    const col = db._collections['publication_visits'] ?? db.get('publication_visits');
    col.query.mockReturnValueOnce({
      fetch: jest.fn(async () => []),
      fetchCount: jest.fn(async () => 3),
    });
    const result = await getVisitCountForPublication('The Times', 'GB');
    expect(result).toBe(3);
  });

  it('accepts null countryCode', async () => {
    const col = db._collections['publication_visits'] ?? db.get('publication_visits');
    col.query.mockReturnValueOnce({
      fetch: jest.fn(async () => []),
      fetchCount: jest.fn(async () => 2),
    });
    const result = await getVisitCountForPublication('The Times', null);
    expect(result).toBe(2);
  });

  it('returns 0 and captures exception on error', async () => {
    const col = db._collections['publication_visits'] ?? db.get('publication_visits');
    col.query.mockReturnValueOnce({
      fetch: jest.fn(async () => []),
      fetchCount: jest.fn().mockRejectedValueOnce(new Error('query error')),
    });
    const result = await getVisitCountForPublication('The Times', 'GB');
    expect(result).toBe(0);
    expect(logger.captureException).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getVisitsForPublication — dedupe & aggregation logic
// ---------------------------------------------------------------------------

describe('getVisitsForPublication', () => {
  it('returns empty array for empty publication name', async () => {
    const result = await getVisitsForPublication('', null);
    expect(result).toEqual([]);
  });

  it('returns empty array when no visits exist', async () => {
    db._setRows('publication_visits', []);
    const result = await getVisitsForPublication('The Times', 'GB');
    expect(result).toEqual([]);
  });

  it('returns a single VisitedArticle for a single visit row', async () => {
    const visit = makeVisitRecord({
      articleId: 'a1',
      visitedAt: new Date(NOW),
    });
    db._setRows('publication_visits', [visit]);
    const result = await getVisitsForPublication('The Times', 'GB');
    expect(result).toHaveLength(1);
    expect(result[0].articleId).toBe('a1');
    expect(result[0].visitCount).toBe(1);
    expect(result[0].visitedAt).toBe(NOW);
  });

  it('deduplicates by articleId — groups multiple rows into one with visitCount', async () => {
    const v1 = makeVisitRecord({ articleId: 'a1', visitedAt: new Date(NOW - 2000) });
    const v2 = makeVisitRecord({ articleId: 'a1', visitedAt: new Date(NOW) });
    db._setRows('publication_visits', [v1, v2]);

    const result = await getVisitsForPublication('The Times', 'GB');
    expect(result).toHaveLength(1);
    expect(result[0].visitCount).toBe(2);
    expect(result[0].visitedAt).toBe(NOW); // most recent
  });

  it('deduplicates by articleUrl when articleId is null', async () => {
    const v1 = makeVisitRecord({
      articleId: null,
      articleUrl: 'https://example.com/a',
      visitedAt: new Date(NOW - 1000),
    });
    const v2 = makeVisitRecord({
      articleId: null,
      articleUrl: 'https://example.com/a',
      visitedAt: new Date(NOW),
    });
    db._setRows('publication_visits', [v1, v2]);

    const result = await getVisitsForPublication('The Times', 'GB');
    expect(result).toHaveLength(1);
    expect(result[0].visitCount).toBe(2);
  });

  it('keeps rows separate when both articleId and articleUrl are null', async () => {
    const v1 = makeVisitRecord({ articleId: null, articleUrl: null });
    const v2 = makeVisitRecord({ articleId: null, articleUrl: null });
    db._setRows('publication_visits', [v1, v2]);

    const result = await getVisitsForPublication('The Times', 'GB');
    expect(result).toHaveLength(2);
  });

  it('updates snapshot fields to freshest non-null values when deduplicating', async () => {
    const older = makeVisitRecord({
      articleId: 'a1',
      visitedAt: new Date(NOW - 5000),
      titleEn: 'Old Title',
      imageUrl: null,
    });
    const newer = makeVisitRecord({
      articleId: 'a1',
      visitedAt: new Date(NOW),
      titleEn: 'New Title',
      imageUrl: 'https://img.com/new.jpg',
    });
    db._setRows('publication_visits', [older, newer]);

    const result = await getVisitsForPublication('The Times', 'GB');
    expect(result[0].titleEn).toBe('New Title');
    expect(result[0].imageUrl).toBe('https://img.com/new.jpg');
  });

  it('preserves existing snapshot when newer visit has null fields', async () => {
    const older = makeVisitRecord({
      articleId: 'a1',
      visitedAt: new Date(NOW - 5000),
      titleEn: 'Preserved Title',
    });
    const newer = makeVisitRecord({
      articleId: 'a1',
      visitedAt: new Date(NOW),
      titleEn: null,
    });
    db._setRows('publication_visits', [older, newer]);

    const result = await getVisitsForPublication('The Times', 'GB');
    expect(result[0].titleEn).toBe('Preserved Title');
  });

  it('sorts results by most recent visitedAt descending', async () => {
    const old = makeVisitRecord({ articleId: 'a1', visitedAt: new Date(NOW - 10000) });
    const recent = makeVisitRecord({ articleId: 'a2', visitedAt: new Date(NOW) });
    const middle = makeVisitRecord({ articleId: 'a3', visitedAt: new Date(NOW - 5000) });
    db._setRows('publication_visits', [old, recent, middle]);

    const result = await getVisitsForPublication('The Times', 'GB');
    expect(result[0].articleId).toBe('a2');
    expect(result[1].articleId).toBe('a3');
    expect(result[2].articleId).toBe('a1');
  });

  it('handles visitedAt as a number (not a Date)', async () => {
    const visit = makeVisitRecord({ visitedAt: NOW }); // number, not Date
    db._setRows('publication_visits', [visit]);
    const result = await getVisitsForPublication('The Times', 'GB');
    expect(result[0].visitedAt).toBe(NOW);
  });

  it('handles pubDate as a number (not a Date)', async () => {
    const visit = makeVisitRecord({ pubDate: NOW }); // number, not Date
    db._setRows('publication_visits', [visit]);
    const result = await getVisitsForPublication('The Times', 'GB');
    expect(result[0].pubDate).toBe(NOW);
  });

  it('sets pubDate to null when row pubDate is null', async () => {
    const visit = makeVisitRecord({ pubDate: null });
    db._setRows('publication_visits', [visit]);
    const result = await getVisitsForPublication('The Times', 'GB');
    expect(result[0].pubDate).toBeNull();
  });

  it('dedup keeps articleSuggestionId from the first occurrence when newer row lacks it', async () => {
    const v1 = makeVisitRecord({
      articleId: 'a1',
      articleSuggestionId: 'sugg-first',
      visitedAt: new Date(NOW - 1000),
    });
    const v2 = makeVisitRecord({
      articleId: 'a1',
      articleSuggestionId: null,
      visitedAt: new Date(NOW),
    });
    db._setRows('publication_visits', [v1, v2]);
    const result = await getVisitsForPublication('The Times', 'GB');
    // The first row's articleSuggestionId is set on the grouped entry
    expect(result[0].articleSuggestionId).toBe('sugg-first');
  });

  it('includes pubDate as Date.getTime() when pubDate is a Date', async () => {
    const pubDate = new Date('2024-03-01T10:00:00Z');
    const visit = makeVisitRecord({ pubDate });
    db._setRows('publication_visits', [visit]);
    const result = await getVisitsForPublication('The Times', 'GB');
    expect(result[0].pubDate).toBe(pubDate.getTime());
  });

  it('dedup: updates pubDate from newer row when it has a non-null value', async () => {
    const oldPub = new Date('2024-01-01');
    const newPub = new Date('2024-06-01');
    const v1 = makeVisitRecord({
      articleId: 'a1',
      visitedAt: new Date(NOW - 2000),
      pubDate: oldPub,
    });
    const v2 = makeVisitRecord({
      articleId: 'a1',
      visitedAt: new Date(NOW),
      pubDate: newPub,
    });
    db._setRows('publication_visits', [v1, v2]);
    const result = await getVisitsForPublication('The Times', 'GB');
    expect(result[0].pubDate).toBe(newPub.getTime());
  });

  it('returns empty array and captures exception on error', async () => {
    const col = db._collections['publication_visits'] ?? db.get('publication_visits');
    col.query.mockReturnValueOnce({
      fetch: jest.fn().mockRejectedValueOnce(new Error('fetch fail')),
      fetchCount: jest.fn(async () => 0),
    });
    const result = await getVisitsForPublication('The Times', 'GB');
    expect(result).toEqual([]);
    expect(logger.captureException).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// pruneStaleVisits
// ---------------------------------------------------------------------------

describe('pruneStaleVisits', () => {
  it('does nothing when there are no stale visits', async () => {
    db._setRows('publication_visits', []);
    await pruneStaleVisits();
    expect(database.write).not.toHaveBeenCalled();
  });

  it('destroys stale visit rows', async () => {
    const staleVisit = makeVisitRecord({ visitedAt: new Date(NOW - 1) });
    db._setRows('publication_visits', [staleVisit]);
    await pruneStaleVisits();
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(staleVisit.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
  });

  it('calls database.batch with spread destroy ops', async () => {
    const v1 = makeVisitRecord({ id: 'v1' });
    const v2 = makeVisitRecord({ id: 'v2' });
    db._setRows('publication_visits', [v1, v2]);
    await pruneStaleVisits();
    expect(database.batch).toHaveBeenCalledTimes(1);
  });

  it('captures and swallows exceptions', async () => {
    // The service captured the collection at import time — mock on that same instance
    const col = db._collections['publication_visits'] ?? db.get('publication_visits');
    col.query.mockReturnValueOnce({
      fetch: jest.fn().mockRejectedValueOnce(new Error('prune error')),
      fetchCount: jest.fn(async () => 0),
    });
    await expect(pruneStaleVisits()).resolves.toBeUndefined();
    expect(logger.captureException).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// clearAllVisits
// ---------------------------------------------------------------------------

describe('clearAllVisits', () => {
  it('does nothing when there are no visits', async () => {
    db._setRows('publication_visits', []);
    await clearAllVisits();
    expect(database.write).not.toHaveBeenCalled();
  });

  it('destroys all visit rows in a single write+batch', async () => {
    const v1 = makeVisitRecord({ id: 'v1' });
    const v2 = makeVisitRecord({ id: 'v2' });
    db._setRows('publication_visits', [v1, v2]);
    await clearAllVisits();
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(database.batch).toHaveBeenCalledTimes(1);
    expect(v1.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
    expect(v2.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
  });

  it('rethrows exceptions', async () => {
    const col = db._collections['publication_visits'] ?? db.get('publication_visits');
    col.query.mockReturnValueOnce({
      fetch: jest.fn().mockRejectedValueOnce(new Error('clear error')),
      fetchCount: jest.fn(async () => 0),
    });
    await expect(clearAllVisits()).rejects.toThrow('clear error');
    expect(logger.captureException).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getTopVisitedPublications — aggregation logic
// ---------------------------------------------------------------------------

describe('getTopVisitedPublications', () => {
  it('returns empty array when no visits exist', async () => {
    db._setRows('publication_visits', []);
    const result = await getTopVisitedPublications();
    expect(result).toEqual([]);
  });

  it('groups visits by (publicationName, countryCode) and counts them', async () => {
    const v1 = makeVisitRecord({ publicationName: 'BBC', countryCode: 'GB', visitedAt: new Date(NOW) });
    const v2 = makeVisitRecord({ publicationName: 'BBC', countryCode: 'GB', visitedAt: new Date(NOW - 1000) });
    const v3 = makeVisitRecord({ publicationName: 'CNN', countryCode: 'US', visitedAt: new Date(NOW) });
    db._setRows('publication_visits', [v1, v2, v3]);

    const result = await getTopVisitedPublications();
    expect(result).toHaveLength(2);
    const bbc = result.find((p) => p.publicationName === 'BBC');
    expect(bbc?.visitCount).toBe(2);
    const cnn = result.find((p) => p.publicationName === 'CNN');
    expect(cnn?.visitCount).toBe(1);
  });

  it('sorts by visitCount descending', async () => {
    const v1 = makeVisitRecord({ publicationName: 'A', visitedAt: new Date(NOW) });
    const v2 = makeVisitRecord({ publicationName: 'B', visitedAt: new Date(NOW) });
    const v3 = makeVisitRecord({ publicationName: 'B', visitedAt: new Date(NOW) });
    db._setRows('publication_visits', [v1, v2, v3]);

    const result = await getTopVisitedPublications();
    expect(result[0].publicationName).toBe('B');
    expect(result[1].publicationName).toBe('A');
  });

  it('breaks visitCount ties by lastVisitedAt descending', async () => {
    const v1 = makeVisitRecord({ publicationName: 'Old', visitedAt: new Date(NOW - 5000) });
    const v2 = makeVisitRecord({ publicationName: 'New', visitedAt: new Date(NOW) });
    db._setRows('publication_visits', [v1, v2]);

    const result = await getTopVisitedPublications();
    expect(result[0].publicationName).toBe('New');
  });

  it('tracks lastVisitedAt as the most recent visit time', async () => {
    const older = makeVisitRecord({ publicationName: 'BBC', countryCode: 'GB', visitedAt: new Date(NOW - 2000) });
    const newer = makeVisitRecord({ publicationName: 'BBC', countryCode: 'GB', visitedAt: new Date(NOW) });
    db._setRows('publication_visits', [older, newer]);

    const result = await getTopVisitedPublications();
    expect(result[0].lastVisitedAt).toBe(NOW);
  });

  it('respects limit option', async () => {
    for (let i = 0; i < 5; i++) {
      db._setRows('publication_visits', [
        makeVisitRecord({ publicationName: `Pub${i}`, visitedAt: new Date(NOW - i * 1000) }),
      ]);
    }
    // 5 different publications — reset then set all at once
    const visits = Array.from({ length: 5 }, (_, i) =>
      makeVisitRecord({ publicationName: `Pub${i}`, visitedAt: new Date(NOW - i * 1000) }),
    );
    db._setRows('publication_visits', visits);
    const result = await getTopVisitedPublications({ limit: 3 });
    expect(result).toHaveLength(3);
  });

  it('handles visitedAt as a number (not a Date)', async () => {
    const visit = makeVisitRecord({ visitedAt: NOW }); // number
    db._setRows('publication_visits', [visit]);
    const result = await getTopVisitedPublications();
    expect(result[0].lastVisitedAt).toBe(NOW);
  });

  it('handles null countryCode', async () => {
    const v1 = makeVisitRecord({ publicationName: 'BBC', countryCode: null, visitedAt: new Date(NOW) });
    const v2 = makeVisitRecord({ publicationName: 'BBC', countryCode: null, visitedAt: new Date(NOW - 1000) });
    db._setRows('publication_visits', [v1, v2]);

    const result = await getTopVisitedPublications();
    expect(result).toHaveLength(1);
    expect(result[0].countryCode).toBeNull();
    expect(result[0].visitCount).toBe(2);
  });

  it('returns empty array and captures exception on error', async () => {
    const col = db._collections['publication_visits'] ?? db.get('publication_visits');
    col.query.mockReturnValueOnce({
      fetch: jest.fn().mockRejectedValueOnce(new Error('aggregation error')),
      fetchCount: jest.fn(async () => 0),
    });
    const result = await getTopVisitedPublications();
    expect(result).toEqual([]);
    expect(logger.captureException).toHaveBeenCalledTimes(1);
  });
});
