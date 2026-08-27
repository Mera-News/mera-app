// saved-article-suggestion-service unit tests.
// All WatermelonDB I/O is intercepted via makeDatabaseMock().

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

// The service reads fact_checks only through this one function — mock it so
// each test states whether the article is still referenced by a check.
jest.mock('../fact-check-record-service', () => ({
  listFactChecksForArticle: jest.fn(async () => []),
}));

// The service reads followed-story membership only through these — mock them so
// each test states whether a story still holds the article. This is the OTHER
// retention reason; the two must not destroy each other's rows.
jest.mock('../tracked-story-service', () => ({
  isTrackedStoryMember: jest.fn(async () => false),
  listTrackedMemberArticleIds: jest.fn(async () => new Set<string>()),
}));

// Mocked so retention tests can assert it is NEVER published for a keep — a
// retention row must not flip any bookmark.
jest.mock('@/lib/saved-state', () => ({
  publishSavedState: jest.fn(),
}));

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { listFactChecksForArticle } from '../fact-check-record-service';
import {
  isTrackedStoryMember,
  listTrackedMemberArticleIds,
} from '../tracked-story-service';
import {
  saveSuggestion,
  saveStandaloneArticle,
  isSuggestionSaved,
  getSavedSuggestionByServerId,
  loadSavedSuggestions,
  loadSavedItems,
  deleteSavedSuggestion,
  keepArticleForFactCheck,
  keepArticleForTrackedStory,
  releaseFactCheckRetention,
  releaseTrackedStoryRetention,
  deleteOrphanedRetention,
  getSavedSuggestionWithKind,
} from '../saved-article-suggestion-service';
import type { NewsArticle } from '@/lib/generated/graphql-types';

const mockListFactChecks = listFactChecksForArticle as jest.Mock;
const mockIsTrackedMember = isTrackedStoryMember as jest.Mock;
const mockTrackedMemberIds = listTrackedMemberArticleIds as jest.Mock;

const db = database as any;
const TABLE = 'saved_article_suggestions';
const NOW = 1700000000000;

function makeSuggestion(overrides: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
  return {
    _id: 'sugg-1',
    articleId: 'art-1',
    clusters: [{ clusterId: 'c1', confidence: 0.9 }],
    relevance: 0.7,
    reason: 'Because you follow Berlin',
    status: ArticleSuggestionStatus.Complete,
    country_code: 'DE',
    language_code: 'de',
    publication_name: 'Der Spiegel',
    title_en: 'A headline',
    title_original: 'Eine Überschrift',
    description_en: 'A description',
    article_url: 'https://example.com/a',
    image_url: 'https://example.com/a.jpg',
    userTopicIds: ['berlin'],
    createdAt: new Date(NOW).toISOString(),
    firstPubDate: new Date(NOW - 1000).toISOString(),
    rawScore: null,
    eventType: null,
    headlineScope: null,
    matchedTopics: [],
    ...overrides,
  };
}

/** A saved-table row mirroring what toForYouSuggestion reads. */
function makeSavedRecord(overrides: Record<string, unknown> = {}) {
  return makeRecord({
    id: 'sugg-1',
    articleId: 'art-1',
    clusterMembershipsJson: '[{"clusterId":"c1","confidence":0.9}]',
    relevance: 0.7,
    reason: 'Because you follow Berlin',
    relevanceGenerationCompleted: true,
    reasonGenerationCompleted: true,
    countryCode: 'DE',
    languageCode: 'de',
    publicationName: 'Der Spiegel',
    titleEn: 'A headline',
    titleOriginal: 'Eine Überschrift',
    descriptionEn: 'A description',
    articleUrl: 'https://example.com/a',
    imageUrl: 'https://example.com/a.jpg',
    matchedTopicTextsJson: '["berlin"]',
    createdAt: new Date(NOW),
    firstPubDate: new Date(NOW - 1000),
    savedAt: new Date(NOW),
    ...overrides,
  });
}

function makeArticle(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    _id: 'art-9',
    article_url: 'https://example.com/standalone',
    source_uri: 'https://example.com/standalone',
    title: 'Standalone Überschrift',
    title_en_internal_only: 'Standalone headline',
    description: 'desc',
    description_en: 'desc en',
    image_url: 'https://example.com/s.jpg',
    original_language_code: 'de',
    pubDate: new Date(NOW - 5000).toISOString(),
    publicationSource: {
      _id: 'pub-1',
      publication_name: 'Die Zeit',
      country_code: 'DE',
    },
    ...overrides,
  } as NewsArticle;
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows(TABLE, []);
  mockListFactChecks.mockResolvedValue([]);
  mockIsTrackedMember.mockResolvedValue(false);
  mockTrackedMemberIds.mockResolvedValue(new Set<string>());
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// saveSuggestion
// ---------------------------------------------------------------------------

describe('saveSuggestion', () => {
  it('creates a new row (with _raw.id) when not already saved', async () => {
    db._setRows(TABLE, []);
    const col = db._collections[TABLE] ?? db.get(TABLE);
    let captured: any = null;
    col.create.mockImplementationOnce(async (fn: (r: any) => void) => {
      const rec = makeRecord({ _raw: { id: undefined } });
      fn(rec);
      captured = rec;
      return rec;
    });

    await saveSuggestion(makeSuggestion());

    expect(database.write).toHaveBeenCalledTimes(1);
    expect(col.create).toHaveBeenCalledTimes(1);
    expect(captured._raw.id).toBe('sugg-1');
    expect(captured.articleId).toBe('art-1');
    expect(captured.clusterMembershipsJson).toBe('[{"clusterId":"c1","confidence":0.9}]');
    expect(captured.matchedTopicTextsJson).toBe('["berlin"]');
    expect(captured.titleEn).toBe('A headline');
    expect(captured.savedAt).toBeInstanceOf(Date);
  });

  it('updates the existing row and bumps savedAt when re-saving', async () => {
    const existing = makeSavedRecord({ savedAt: new Date(NOW - 99999) });
    db._setRows(TABLE, [existing]);
    const col = db._collections[TABLE] ?? db.get(TABLE);

    await saveSuggestion(makeSuggestion({ relevance: 0.95, title_en: 'Updated' }));

    expect(existing.update).toHaveBeenCalledTimes(1);
    expect(col.create).not.toHaveBeenCalled();
    expect(existing.relevance).toBe(0.95);
    expect(existing.titleEn).toBe('Updated');
    // savedAt is bumped to a fresh `new Date()` (not the stale NOW-99999).
    expect(existing.savedAt).toBeInstanceOf(Date);
    expect(existing.savedAt.getTime()).toBeGreaterThan(NOW - 99999);
  });

  it('serialises empty clusters / topics safely', async () => {
    db._setRows(TABLE, []);
    const col = db._collections[TABLE] ?? db.get(TABLE);
    let captured: any = null;
    col.create.mockImplementationOnce(async (fn: (r: any) => void) => {
      const rec = makeRecord({ _raw: { id: undefined } });
      fn(rec);
      captured = rec;
      return rec;
    });

    await saveSuggestion(
      makeSuggestion({ clusters: undefined as any, userTopicIds: undefined as any }),
    );

    expect(captured.clusterMembershipsJson).toBe('[]');
    expect(captured.matchedTopicTextsJson).toBe('[]');
  });
});

describe('saveStandaloneArticle', () => {
  it('creates a row (with _raw.id = article._id) and stamps origin=article', async () => {
    db._setRows(TABLE, []);
    const col = db._collections[TABLE] ?? db.get(TABLE);
    let captured: any = null;
    col.create.mockImplementationOnce(async (fn: (r: any) => void) => {
      const rec = makeRecord({ _raw: { id: undefined } });
      fn(rec);
      captured = rec;
      return rec;
    });

    await saveStandaloneArticle(makeArticle(), { surface: 'explore' });

    expect(database.write).toHaveBeenCalledTimes(1);
    expect(col.create).toHaveBeenCalledTimes(1);
    expect(captured._raw.id).toBe('art-9');
    expect(captured.articleId).toBe('art-9');
    expect(captured.origin).toBe('article');
    expect(captured.titleEn).toBe('Standalone headline');
    expect(captured.titleOriginal).toBe('Standalone Überschrift');
    expect(captured.publicationName).toBe('Die Zeit');
    expect(captured.countryCode).toBe('DE');
    expect(captured.articleUrl).toBe('https://example.com/standalone');
    // No personalization on a standalone article.
    expect(captured.relevance).toBe(0);
    expect(captured.relevanceGenerationCompleted).toBe(false);
    expect(captured.clusterMembershipsJson).toBe('[]');
    expect(captured.savedAt).toBeInstanceOf(Date);
  });

  it('does nothing when the article has no _id', async () => {
    db._setRows(TABLE, []);
    await saveStandaloneArticle(makeArticle({ _id: '' }));
    expect(database.write).not.toHaveBeenCalled();
  });

  it('updates the existing row (does not create) when re-saving', async () => {
    const existing = makeSavedRecord({ id: 'art-9', origin: 'article' });
    db._setRows(TABLE, [existing]);
    const col = db._collections[TABLE] ?? db.get(TABLE);

    await saveStandaloneArticle(makeArticle());

    expect(existing.update).toHaveBeenCalledTimes(1);
    expect(col.create).not.toHaveBeenCalled();
    expect(existing.origin).toBe('article');
  });
});

// ---------------------------------------------------------------------------
// loadSavedItems (origin-discriminated)
// ---------------------------------------------------------------------------

describe('loadSavedItems', () => {
  it('maps a suggestion-origin row to { origin: suggestion }', async () => {
    db._setRows(TABLE, [makeSavedRecord({ origin: 'suggestion' })]);
    const items = await loadSavedItems();
    expect(items).toHaveLength(1);
    expect(items[0].origin).toBe('suggestion');
    if (items[0].origin === 'suggestion') {
      expect(items[0].suggestion._id).toBe('sugg-1');
    }
  });

  it('maps a null-origin (pre-v38) row as a suggestion', async () => {
    db._setRows(TABLE, [makeSavedRecord({ origin: null })]);
    const items = await loadSavedItems();
    expect(items[0].origin).toBe('suggestion');
  });

  it('maps an article-origin row to { origin: article } with a NewsArticle', async () => {
    db._setRows(TABLE, [
      makeSavedRecord({
        id: 'art-9',
        origin: 'article',
        articleId: 'art-9',
        titleEn: 'Standalone headline',
        titleOriginal: 'Standalone Überschrift',
        publicationName: 'Die Zeit',
        countryCode: 'DE',
        articleUrl: 'https://example.com/standalone',
      }),
    ]);
    const items = await loadSavedItems();
    expect(items).toHaveLength(1);
    expect(items[0].origin).toBe('article');
    if (items[0].origin === 'article') {
      expect(items[0].savedId).toBe('art-9');
      expect(items[0].article._id).toBe('art-9');
      expect(items[0].article.title).toBe('Standalone Überschrift');
      expect(items[0].article.publicationSource?.publication_name).toBe('Die Zeit');
    }
  });
});

// ---------------------------------------------------------------------------
// isSuggestionSaved
// ---------------------------------------------------------------------------

describe('isSuggestionSaved', () => {
  it('returns true when the row exists', async () => {
    db._setRows(TABLE, [makeSavedRecord({ id: 'sugg-1' })]);
    expect(await isSuggestionSaved('sugg-1')).toBe(true);
  });

  it('returns false when the row is absent', async () => {
    db._setRows(TABLE, []);
    expect(await isSuggestionSaved('missing')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getSavedSuggestionByServerId
// ---------------------------------------------------------------------------

describe('getSavedSuggestionByServerId', () => {
  it('returns null when not found', async () => {
    db._setRows(TABLE, []);
    expect(await getSavedSuggestionByServerId('missing')).toBeNull();
  });

  it('maps a row back to a ForYouSuggestion', async () => {
    db._setRows(TABLE, [makeSavedRecord()]);
    const result = await getSavedSuggestionByServerId('sugg-1');
    expect(result).not.toBeNull();
    expect(result!._id).toBe('sugg-1');
    expect(result!.articleId).toBe('art-1');
    expect(result!.clusters).toEqual([{ clusterId: 'c1', confidence: 0.9 }]);
    expect(result!.userTopicIds).toEqual(['berlin']);
    expect(result!.title_en).toBe('A headline');
    expect(result!.createdAt).toBe(new Date(NOW).toISOString());
    expect(result!.firstPubDate).toBe(new Date(NOW - 1000).toISOString());
  });

  it('tolerates malformed / null JSON columns', async () => {
    db._setRows(TABLE, [
      makeSavedRecord({
        clusterMembershipsJson: 'not-json',
        matchedTopicTextsJson: null,
      }),
    ]);
    const result = await getSavedSuggestionByServerId('sugg-1');
    expect(result!.clusters).toEqual([]);
    expect(result!.userTopicIds).toEqual([]);
  });

  it('drops malformed cluster entries and non-string topics', async () => {
    db._setRows(TABLE, [
      makeSavedRecord({
        clusterMembershipsJson:
          '[{"clusterId":"c1","confidence":0.9},{"clusterId":"","confidence":1},{"confidence":1},"x"]',
        matchedTopicTextsJson: '["berlin", 5, "", "munich"]',
      }),
    ]);
    const result = await getSavedSuggestionByServerId('sugg-1');
    expect(result!.clusters).toEqual([{ clusterId: 'c1', confidence: 0.9 }]);
    expect(result!.userTopicIds).toEqual(['berlin', 'munich']);
  });

  it('ignores cluster JSON that is not an array', async () => {
    db._setRows(TABLE, [
      makeSavedRecord({
        clusterMembershipsJson: '{"clusterId":"c1"}',
        matchedTopicTextsJson: '{"a":1}',
      }),
    ]);
    const result = await getSavedSuggestionByServerId('sugg-1');
    expect(result!.clusters).toEqual([]);
    expect(result!.userTopicIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadSavedSuggestions
// ---------------------------------------------------------------------------

describe('loadSavedSuggestions', () => {
  it('returns an empty array when nothing is saved', async () => {
    db._setRows(TABLE, []);
    expect(await loadSavedSuggestions()).toEqual([]);
  });

  it('maps every row to a ForYouSuggestion', async () => {
    db._setRows(TABLE, [
      makeSavedRecord({ id: 'a' }),
      makeSavedRecord({ id: 'b' }),
    ]);
    const result = await loadSavedSuggestions();
    expect(result).toHaveLength(2);
    expect(result.map((r) => r._id)).toEqual(['a', 'b']);
  });

  it('queries sorted by saved_at descending', async () => {
    db._setRows(TABLE, [makeSavedRecord()]);
    const col = db._collections[TABLE] ?? db.get(TABLE);
    await loadSavedSuggestions();
    expect(col.query).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deleteSavedSuggestion
// ---------------------------------------------------------------------------

describe('deleteSavedSuggestion', () => {
  it('destroys the row and returns true when found', async () => {
    const row = makeSavedRecord({ id: 'sugg-1' });
    db._setRows(TABLE, [row]);
    const result = await deleteSavedSuggestion('sugg-1');
    expect(result).toBe(true);
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(row.destroyPermanently).toHaveBeenCalledTimes(1);
  });

  it('returns false and does not write when absent', async () => {
    db._setRows(TABLE, []);
    const result = await deleteSavedSuggestion('missing');
    expect(result).toBe(false);
    expect(database.write).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// parseDate coverage via the createdAt/firstPubDate snapshot on save
// ---------------------------------------------------------------------------

describe('date parsing on save', () => {
  it('falls back to now() for unparseable createdAt / firstPubDate', async () => {
    db._setRows(TABLE, []);
    const col = db._collections[TABLE] ?? db.get(TABLE);
    let captured: any = null;
    col.create.mockImplementationOnce(async (fn: (r: any) => void) => {
      const rec = makeRecord({ _raw: { id: undefined } });
      fn(rec);
      captured = rec;
      return rec;
    });

    await saveSuggestion(
      makeSuggestion({
        createdAt: 'not-a-date' as any,
        firstPubDate: 'also-bad' as any,
      }),
    );

    // Unparseable inputs fall back to a fresh `new Date()`.
    expect(captured.createdAt).toBeInstanceOf(Date);
    expect(Number.isNaN(captured.createdAt.getTime())).toBe(false);
    expect(captured.firstPubDate).toBeInstanceOf(Date);
    expect(Number.isNaN(captured.firstPubDate.getTime())).toBe(false);
  });

  it('accepts numeric epoch timestamps for createdAt', async () => {
    db._setRows(TABLE, []);
    const col = db._collections[TABLE] ?? db.get(TABLE);
    let captured: any = null;
    col.create.mockImplementationOnce(async (fn: (r: any) => void) => {
      const rec = makeRecord({ _raw: { id: undefined } });
      fn(rec);
      captured = rec;
      return rec;
    });

    await saveSuggestion(makeSuggestion({ createdAt: NOW as any }));
    expect(captured.createdAt).toEqual(new Date(NOW));
  });
});

// ---------------------------------------------------------------------------
// Fact-check retention
// ---------------------------------------------------------------------------

const { publishSavedState } = require('@/lib/saved-state');

/** Hook col.create to capture the record the writer builds. */
function captureCreate(col: any) {
  const captured: { rec: any } = { rec: null };
  col.create.mockImplementationOnce(async (fn: (r: any) => void) => {
    const rec = makeRecord({ _raw: { id: undefined } });
    fn(rec);
    captured.rec = rec;
    return rec;
  });
  return captured;
}

describe('keepArticleForFactCheck', () => {
  it('creates an article-keyed fact_check row from a full article, without publishing saved state', async () => {
    db._setRows(TABLE, []);
    const col = db._collections[TABLE] ?? db.get(TABLE);
    const captured = captureCreate(col);

    await keepArticleForFactCheck({ articleId: 'art-9', article: makeArticle() });

    expect(col.create).toHaveBeenCalledTimes(1);
    expect(captured.rec._raw.id).toBe('art-9');
    expect(captured.rec.articleId).toBe('art-9');
    expect(captured.rec.origin).toBe('fact_check');
    expect(captured.rec.titleEn).toBe('Standalone headline');
    expect(captured.rec.publicationName).toBe('Die Zeit');
    expect(captured.rec.savedAt).toBeInstanceOf(Date);
    expect(publishSavedState).not.toHaveBeenCalled();
  });

  it('creates a fact_check row from a full suggestion, keyed by the ARTICLE id', async () => {
    db._setRows(TABLE, []);
    const col = db._collections[TABLE] ?? db.get(TABLE);
    const captured = captureCreate(col);

    await keepArticleForFactCheck({
      articleId: 'art-1',
      suggestion: makeSuggestion(),
    });

    // Keyed by article id, NOT the suggestion _id — the article-detail
    // fallback looks rows up by article id.
    expect(captured.rec._raw.id).toBe('art-1');
    expect(captured.rec.articleId).toBe('art-1');
    expect(captured.rec.origin).toBe('fact_check');
    expect(captured.rec.titleEn).toBe('A headline');
  });

  it('creates a degraded row from server-row fields when no full shape is in hand', async () => {
    db._setRows(TABLE, []);
    const col = db._collections[TABLE] ?? db.get(TABLE);
    const captured = captureCreate(col);

    await keepArticleForFactCheck({
      articleId: 'art-7',
      title: 'Server title',
      articleUrl: 'https://example.com/srv',
      publicationName: 'Server Pub',
    });

    expect(captured.rec._raw.id).toBe('art-7');
    expect(captured.rec.origin).toBe('fact_check');
    expect(captured.rec.titleEn).toBe('Server title');
    expect(captured.rec.titleOriginal).toBe('Server title');
    expect(captured.rec.articleUrl).toBe('https://example.com/srv');
    expect(captured.rec.publicationName).toBe('Server Pub');
    expect(captured.rec.relevance).toBe(0);
  });

  it('leaves a user-saved row alone', async () => {
    const existing = makeSavedRecord({ id: 'art-9', articleId: 'art-9', origin: 'article' });
    db._setRows(TABLE, [existing]);
    const col = db._collections[TABLE] ?? db.get(TABLE);

    await keepArticleForFactCheck({ articleId: 'art-9', article: makeArticle() });

    expect(existing.update).not.toHaveBeenCalled();
    expect(col.create).not.toHaveBeenCalled();
    expect(existing.origin).toBe('article');
  });

  it('never lets a degraded input overwrite an existing snapshot', async () => {
    const existing = makeSavedRecord({
      id: 'art-9',
      articleId: 'art-9',
      origin: 'fact_check',
      titleEn: 'Rich snapshot title',
    });
    db._setRows(TABLE, [existing]);

    await keepArticleForFactCheck({ articleId: 'art-9', title: 'Poorer title' });

    expect(existing.update).not.toHaveBeenCalled();
    expect(existing.titleEn).toBe('Rich snapshot title');
  });

  it('refreshes an existing fact_check row from a full shape without bumping savedAt', async () => {
    const staleSavedAt = new Date(NOW - 99999);
    const existing = makeSavedRecord({
      id: 'art-9',
      articleId: 'art-9',
      origin: 'fact_check',
      titleEn: 'Old title',
      savedAt: staleSavedAt,
    });
    db._setRows(TABLE, [existing]);

    await keepArticleForFactCheck({ articleId: 'art-9', article: makeArticle() });

    expect(existing.update).toHaveBeenCalledTimes(1);
    expect(existing.titleEn).toBe('Standalone headline');
    expect(existing.origin).toBe('fact_check');
    expect(existing.savedAt).toBe(staleSavedAt);
  });

  it('does nothing for a blank articleId', async () => {
    await keepArticleForFactCheck({ articleId: '  ', title: 'x' });
    expect(database.write).not.toHaveBeenCalled();
  });
});

describe('isSuggestionSaved with retention rows', () => {
  it('does NOT count a fact_check retention row as saved', async () => {
    db._setRows(TABLE, [
      makeSavedRecord({ id: 'art-9', articleId: 'art-9', origin: 'fact_check' }),
    ]);
    expect(await isSuggestionSaved('art-9')).toBe(false);
  });

  it('still counts null-origin (pre-v38) rows as saved', async () => {
    db._setRows(TABLE, [makeSavedRecord({ id: 'sugg-1', origin: null })]);
    expect(await isSuggestionSaved('sugg-1')).toBe(true);
  });
});

describe('Saved-screen reads exclude retention rows', () => {
  it('loadSavedItems drops fact_check rows and keeps the rest', async () => {
    db._setRows(TABLE, [
      makeSavedRecord({ id: 'sugg-1', origin: 'suggestion' }),
      makeSavedRecord({ id: 'art-9', articleId: 'art-9', origin: 'fact_check' }),
      makeSavedRecord({ id: 'art-5', articleId: 'art-5', origin: 'article' }),
    ]);
    const items = await loadSavedItems();
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.origin)).toEqual(['suggestion', 'article']);
  });

  it('loadSavedSuggestions drops fact_check rows', async () => {
    db._setRows(TABLE, [
      makeSavedRecord({ id: 'sugg-1' }),
      makeSavedRecord({ id: 'art-9', articleId: 'art-9', origin: 'fact_check' }),
    ]);
    const result = await loadSavedSuggestions();
    expect(result.map((r) => r._id)).toEqual(['sugg-1']);
  });

  it('getSavedSuggestionByServerId still RETURNS a fact_check row (the open path depends on it)', async () => {
    db._setRows(TABLE, [
      makeSavedRecord({ id: 'art-9', articleId: 'art-9', origin: 'fact_check' }),
    ]);
    const result = await getSavedSuggestionByServerId('art-9');
    expect(result).not.toBeNull();
    expect(result!.articleId).toBe('art-9');
  });
});

describe('deleteSavedSuggestion with live fact checks', () => {
  it('downgrades an article-keyed row to fact_check instead of destroying it', async () => {
    mockListFactChecks.mockResolvedValue([{ id: 'fc-1' }]);
    const row = makeSavedRecord({ id: 'art-9', articleId: 'art-9', origin: 'article' });
    db._setRows(TABLE, [row]);

    const result = await deleteSavedSuggestion('art-9');

    expect(result).toBe(true);
    expect(row.destroyPermanently).not.toHaveBeenCalled();
    expect(row.origin).toBe('fact_check');
    expect(publishSavedState).toHaveBeenCalledWith('art-9', false);
  });

  it('transfers a suggestion-keyed row to an article-keyed retention row', async () => {
    mockListFactChecks.mockResolvedValue([{ id: 'fc-1' }]);
    const row = makeSavedRecord({ id: 'sugg-1', articleId: 'art-1' });
    db._setRows(TABLE, [row]);
    const col = db._collections[TABLE] ?? db.get(TABLE);
    const captured = captureCreate(col);

    const result = await deleteSavedSuggestion('sugg-1');

    expect(result).toBe(true);
    expect(captured.rec._raw.id).toBe('art-1');
    expect(captured.rec.articleId).toBe('art-1');
    expect(captured.rec.origin).toBe('fact_check');
    expect(captured.rec.titleEn).toBe('A headline');
    expect(row.destroyPermanently).toHaveBeenCalledTimes(1);
  });

  it('skips the transfer when an article-keyed row already exists', async () => {
    mockListFactChecks.mockResolvedValue([{ id: 'fc-1' }]);
    const row = makeSavedRecord({ id: 'sugg-1', articleId: 'art-1' });
    const retention = makeSavedRecord({ id: 'art-1', articleId: 'art-1', origin: 'fact_check' });
    db._setRows(TABLE, [row, retention]);
    const col = db._collections[TABLE] ?? db.get(TABLE);

    await deleteSavedSuggestion('sugg-1');

    expect(col.create).not.toHaveBeenCalled();
    expect(row.destroyPermanently).toHaveBeenCalledTimes(1);
    expect(retention.destroyPermanently).not.toHaveBeenCalled();
  });

  it('destroys outright when no fact check references the article', async () => {
    mockListFactChecks.mockResolvedValue([]);
    const row = makeSavedRecord({ id: 'art-9', articleId: 'art-9', origin: 'article' });
    db._setRows(TABLE, [row]);

    await deleteSavedSuggestion('art-9');

    expect(row.destroyPermanently).toHaveBeenCalledTimes(1);
    expect(row.origin).toBe('article');
  });
});

describe('releaseFactCheckRetention', () => {
  it('destroys the retention row when the last fact check is gone', async () => {
    mockListFactChecks.mockResolvedValue([]);
    const row = makeSavedRecord({ id: 'art-9', articleId: 'art-9', origin: 'fact_check' });
    db._setRows(TABLE, [row]);

    expect(await releaseFactCheckRetention('art-9')).toBe(true);
    expect(row.destroyPermanently).toHaveBeenCalledTimes(1);
  });

  it('keeps the row while other claim rows still reference the article', async () => {
    mockListFactChecks.mockResolvedValue([{ id: 'fc-2' }]);
    const row = makeSavedRecord({ id: 'art-9', articleId: 'art-9', origin: 'fact_check' });
    db._setRows(TABLE, [row]);

    expect(await releaseFactCheckRetention('art-9')).toBe(false);
    expect(row.destroyPermanently).not.toHaveBeenCalled();
  });

  it('never destroys a user-saved row', async () => {
    mockListFactChecks.mockResolvedValue([]);
    const row = makeSavedRecord({ id: 'art-9', articleId: 'art-9', origin: 'article' });
    db._setRows(TABLE, [row]);

    expect(await releaseFactCheckRetention('art-9')).toBe(false);
    expect(row.destroyPermanently).not.toHaveBeenCalled();
  });

  it('returns false for a blank articleId', async () => {
    expect(await releaseFactCheckRetention('')).toBe(false);
  });
});

describe('deleteOrphanedRetention', () => {
  it('destroys only the unreferenced fact_check rows', async () => {
    const orphan = makeSavedRecord({ id: 'art-1', articleId: 'art-1', origin: 'fact_check' });
    const referenced = makeSavedRecord({ id: 'art-2', articleId: 'art-2', origin: 'fact_check' });
    // The fake query ignores predicates, so ONLY seed fact_check rows here —
    // the production query filters on origin.
    db._setRows(TABLE, [orphan, referenced]);
    mockListFactChecks.mockImplementation(async (articleId: string) =>
      articleId === 'art-2' ? [{ id: 'fc-1' }] : [],
    );

    const count = await deleteOrphanedRetention();

    expect(count).toBe(1);
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(orphan.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
    expect(referenced.prepareDestroyPermanently).not.toHaveBeenCalled();
  });

  it('returns 0 and writes nothing when every row is still referenced', async () => {
    const referenced = makeSavedRecord({ id: 'art-2', articleId: 'art-2', origin: 'fact_check' });
    db._setRows(TABLE, [referenced]);
    mockListFactChecks.mockResolvedValue([{ id: 'fc-1' }]);

    expect(await deleteOrphanedRetention()).toBe(0);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('returns 0 on an empty table', async () => {
    db._setRows(TABLE, []);
    expect(await deleteOrphanedRetention()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Two retention reasons, one `origin` scalar
//
// `origin` records ONE reason, so it cannot answer "is anything still holding
// this row". Without the cross-reason check the two reasons destroy each other's
// rows and the article becomes unopenable — the exact bug retention exists to
// prevent, reached through a different door.
// ---------------------------------------------------------------------------

/** Current rows in the saved table, via the fake collection. */
function rows(): any[] {
  const col = db._collections[TABLE] ?? db.get(TABLE);
  return col._rows;
}

describe('retention across two reasons', () => {
  it('records a tracked-story keep on a row a fact check already holds', async () => {
    db._setRows(TABLE, [makeSavedRecord({ id: 'art-1', articleId: 'art-1', origin: 'fact_check' })]);

    await keepArticleForTrackedStory({
      articleId: 'art-1',
      suggestion: makeSuggestion({ description_en: 'Richer copy' }),
    });

    const row = rows()[0];
    // Upgraded in place, not skipped. Bailing here (the pre-tracked_story
    // guard) would leave the story with no retention of its own.
    expect(row.descriptionEn).toBe('Richer copy');
    // Origin is not churned: it only decides which sweep classifies the row,
    // and both sweeps check both reasons.
    expect(row.origin).toBe('fact_check');
  });

  it('KEEPS the row when the fact check goes but the story still follows it', async () => {
    db._setRows(TABLE, [makeSavedRecord({ id: 'art-1', articleId: 'art-1', origin: 'fact_check' })]);
    mockListFactChecks.mockResolvedValue([]);
    mockIsTrackedMember.mockResolvedValue(true);

    const destroyed = await releaseFactCheckRetention('art-1');

    expect(destroyed).toBe(false);
    expect(rows()).toHaveLength(1);
    // Re-stamped to the surviving reason, so the row no longer names the reason
    // that just let go and the sweep classifies it correctly.
    expect(rows()[0].origin).toBe('tracked_story');
  });

  it('KEEPS the row when the story unfollows but a fact check still holds it', async () => {
    db._setRows(TABLE, [makeSavedRecord({ id: 'art-1', articleId: 'art-1', origin: 'tracked_story' })]);
    mockIsTrackedMember.mockResolvedValue(false);
    mockListFactChecks.mockResolvedValue([{ id: 'fc-1' }]);

    const destroyed = await releaseTrackedStoryRetention('art-1');

    expect(destroyed).toBe(false);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].origin).toBe('fact_check');
  });

  it('destroys the row only once BOTH reasons have let go', async () => {
    const row = makeSavedRecord({ id: 'art-1', articleId: 'art-1', origin: 'tracked_story' });
    db._setRows(TABLE, [row]);
    mockIsTrackedMember.mockResolvedValue(false);
    mockListFactChecks.mockResolvedValue([]);

    const destroyed = await releaseTrackedStoryRetention('art-1');

    expect(destroyed).toBe(true);
    expect(row.destroyPermanently).toHaveBeenCalledTimes(1);
  });

  it('never destroys a user save when a retention reason lets go', async () => {
    db._setRows(TABLE, [makeSavedRecord({ id: 'art-1', articleId: 'art-1', origin: 'article' })]);
    mockIsTrackedMember.mockResolvedValue(false);

    expect(await releaseTrackedStoryRetention('art-1')).toBe(false);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].origin).toBe('article');
  });

  it('spares a tracked-story row the sweep would otherwise call orphaned', async () => {
    const tracked = makeSavedRecord({ id: 'art-1', articleId: 'art-1', origin: 'tracked_story' });
    const orphan = makeSavedRecord({ id: 'art-2', articleId: 'art-2', origin: 'fact_check' });
    db._setRows(TABLE, [tracked, orphan]);
    // Nothing fact-checks either, but a story still holds art-1. The sweep must
    // check BOTH reasons per row regardless of the row's own origin.
    mockListFactChecks.mockResolvedValue([]);
    mockTrackedMemberIds.mockResolvedValue(new Set(['art-1']));

    const n = await deleteOrphanedRetention();

    expect(n).toBe(1);
    expect(tracked.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(orphan.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
  });

  it('hides a tracked_story row from every Saved-screen read', async () => {
    db._setRows(TABLE, [makeSavedRecord({ id: 'art-1', articleId: 'art-1', origin: 'tracked_story' })]);

    expect(await isSuggestionSaved('art-1')).toBe(false);
    expect(await loadSavedSuggestions()).toEqual([]);
    expect(await loadSavedItems()).toEqual([]);
  });

  it('still RESOLVES a tracked_story row on the open path, flagged as retained', async () => {
    db._setRows(TABLE, [makeSavedRecord({ id: 'art-1', articleId: 'art-1', origin: 'tracked_story' })]);

    // The whole point of retention: the detail screen's fallback must find it.
    expect(await getSavedSuggestionByServerId('art-1')).not.toBeNull();
    const kind = await getSavedSuggestionWithKind('art-1');
    // `retained` keeps the offline "showing cached content" banner off a row
    // reached ONLINE past the server's 48h TTL.
    expect(kind?.retained).toBe(true);
  });

  it('reports a user save as NOT retained, so the banner still fires offline', async () => {
    db._setRows(TABLE, [makeSavedRecord({ id: 'art-1', articleId: 'art-1', origin: 'article' })]);
    expect((await getSavedSuggestionWithKind('art-1'))?.retained).toBe(false);
  });

  it('degraded keep never overwrites a rich snapshot', async () => {
    db._setRows(TABLE, [makeSavedRecord({ id: 'art-1', articleId: 'art-1', origin: 'tracked_story' })]);

    await keepArticleForTrackedStory({ articleId: 'art-1', title: 'Bare' });

    expect(rows()[0].titleEn).toBe('A headline');
  });
});
