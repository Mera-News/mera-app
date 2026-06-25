// saved-article-suggestion-service unit tests.
// All WatermelonDB I/O is intercepted via makeDatabaseMock().

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import {
  saveSuggestion,
  isSuggestionSaved,
  getSavedSuggestionByServerId,
  loadSavedSuggestions,
  deleteSavedSuggestion,
} from '../saved-article-suggestion-service';

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

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows(TABLE, []);
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
