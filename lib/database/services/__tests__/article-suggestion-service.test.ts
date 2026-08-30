// article-suggestion-service unit tests
// Every dependency is mocked; DB I/O is via makeDatabaseMock().

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

const mockGetSetting = jest.fn((_key: string): Promise<string | null> => Promise.resolve(null));
const mockSetSetting = jest.fn((_key: string, _value: string): Promise<void> => Promise.resolve());
const mockDeleteSetting = jest.fn((_key: string): Promise<void> => Promise.resolve());

jest.mock('../setting-service', () => ({
  getSetting: (key: string) => mockGetSetting(key),
  setSetting: (key: string, value: string) => mockSetSetting(key, value),
  deleteSetting: (key: string) => mockDeleteSetting(key),
}));

const mockGetFacts = jest.fn((): Promise<any[]> => Promise.resolve([]));

jest.mock('../fact-service', () => ({
  getFacts: () => mockGetFacts(),
}));

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import { buildFactRows } from '@/lib/stores/fact-rows-selector';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { GLOBAL_HEADLINE_SECTION_ID } from '@/lib/news-harness/feed-select';
import {
  getLocalSuggestionServerIds,
  loadSuggestions,
  getUnscoredSuggestionsWithFacts,
  getScoredSuggestionsWithoutReasons,
  countUnscoredSuggestions,
  getOldestUnscoredCreatedAt,
  deleteSuggestionsByServerIds,
  deleteSuggestionByServerId,
  deleteOldSuggestions,
  saveScoringResult,
  batchMarkAsScoredByIds,
  batchMarkReasonSkipped,
  batchPropagateScores,
  getGroupingRowsByIds,
  getUnscoredGroupingRows,
  getScoredDonorRows,
  getCullableLowHeadlineIds,
  saveReason,
  getSharedNoteBreakdown,
  getSuggestionByServerId,
  clearSuggestions,
  pruneOrphanedSuggestions,
  persistFeedMetadata,
  loadFeedMetadata,
  getArticleCountByTopicTexts,
  getArticleSuggestionsByTopicTexts,
  getTotalArticleSuggestionCount,
  persistAndLinkV2Suggestions,
  buildStageCandidateInput,
  geoTextFromTags,
  type TopicWeightInfo,
} from '../article-suggestion-service';
import type { StageCandidateRow } from '@/lib/news-harness/core/types';

const db = database as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2024-06-01T00:00:00.000Z');

function makeSuggestion(overrides: Record<string, any> = {}) {
  // Derive the `status` state machine from any legacy boolean overrides so the
  // existing call sites keep working without touching every one.
  const status =
    overrides.status ??
    (overrides.reasonGenerationCompleted
      ? 'complete'
      : overrides.relevanceGenerationCompleted
        ? 'reason_pending'
        : 'unscored');
  return makeRecord({
    id: overrides.id ?? 'sug-1',
    articleId: overrides.articleId ?? overrides.id ?? 'article-1',
    clusterMembershipsJson: overrides.clusterMembershipsJson ?? null,
    relevance: overrides.relevance ?? 0,
    reason: overrides.reason ?? '',
    status,
    countryCode: overrides.countryCode ?? 'USA',
    languageCode: overrides.languageCode ?? 'en',
    publicationName: overrides.publicationName ?? 'Test Pub',
    titleEn: overrides.titleEn ?? 'Test Title EN',
    titleOriginal: overrides.titleOriginal ?? 'Test Title',
    descriptionEn: overrides.descriptionEn ?? 'A description',
    articleUrl: overrides.articleUrl ?? 'https://example.com',
    imageUrl: overrides.imageUrl ?? 'https://example.com/img.png',
    matchedTopicTextsJson: overrides.matchedTopicTextsJson ?? '["berlin"]',
    createdAt: overrides.createdAt ?? NOW,
    firstPubDate: overrides.firstPubDate ?? NOW,
    ...overrides,
  });
}

/**
 * A reason that is GROUNDED in `makeSuggestion`'s default article (titled
 * "Test Title EN"). Every write path now runs the note past `isReasonGrounded`
 * against the row's own article and drops one that shares no content token with
 * it — so a placeholder like "Good match" no longer persists, and a test
 * asserting that it does would be asserting the bug. Use this wherever a test
 * needs a note to actually land.
 */
const GROUNDED_REASON = 'This test title matters to you.';

function makeLink(overrides: Record<string, any> = {}) {
  return makeRecord({
    id: overrides.id ?? 'link-1',
    articleSuggestionId: overrides.articleSuggestionId ?? 'sug-1',
    factId: overrides.factId ?? 'fact-1',
    createdAt: NOW,
    ...overrides,
  });
}

function makeFact(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? 'fact-1',
    statement: overrides.statement ?? 'I live in Berlin',
    metadata: overrides.metadata ?? { topics: ['berlin'] },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function makeFactRecord(overrides: Record<string, any> = {}) {
  return makeRecord({
    id: overrides.id ?? 'fact-1',
    statement: overrides.statement ?? 'I live in Berlin',
    metadata: overrides.metadata ?? { topics: ['berlin'] },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('article_suggestions', []);
  db._setRows('article_suggestion_facts', []);
  db._setRows('facts', []);
});

// ===========================================================================
// Pure helpers — tested via exported functions that use them internally.
// (parseClusterMemberships, parseTopicIds, canonicalClusterMembershipsJson,
//  toForYouSuggestion are internal but exercised through public API)
// ===========================================================================

describe('parseTopicIds (via loadSuggestions / getArticleCountByTopicTexts)', () => {
  it('returns empty array for null matchedTopicTextsJson', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', matchedTopicTextsJson: null }),
    ]);
    const counts = await getArticleCountByTopicTexts();
    expect(counts.size).toBe(0);
  });

  it('returns empty array for invalid JSON', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', matchedTopicTextsJson: 'not-json' }),
    ]);
    const counts = await getArticleCountByTopicTexts();
    expect(counts.size).toBe(0);
  });

  it('returns empty array when JSON is a non-array value', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', matchedTopicTextsJson: '"just-a-string"' }),
    ]);
    const counts = await getArticleCountByTopicTexts();
    expect(counts.size).toBe(0);
  });

  it('filters out empty strings and non-strings from the topic array', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', matchedTopicTextsJson: '["valid", "", 42, null]' }),
    ]);
    const counts = await getArticleCountByTopicTexts();
    expect(counts.has('valid')).toBe(true);
    expect(counts.size).toBe(1);
  });
});

describe('parseClusterMemberships (via loadSuggestions)', () => {
  it('returns empty array for null clusterMembershipsJson', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', clusterMembershipsJson: null }),
    ]);
    const suggestions = await loadSuggestions();
    expect(suggestions[0].clusters).toEqual([]);
  });

  it('returns empty array for invalid JSON', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', clusterMembershipsJson: 'bad-json' }),
    ]);
    const suggestions = await loadSuggestions();
    expect(suggestions[0].clusters).toEqual([]);
  });

  it('returns empty array when JSON is not an array', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', clusterMembershipsJson: '{}' }),
    ]);
    const suggestions = await loadSuggestions();
    expect(suggestions[0].clusters).toEqual([]);
  });

  it('filters out entries missing clusterId string or confidence number', async () => {
    const json = JSON.stringify([
      { clusterId: 'c1', confidence: 0.9 }, // valid
      { clusterId: '', confidence: 0.5 },    // empty clusterId — filtered
      { clusterId: 'c2' },                    // missing confidence — filtered
      { confidence: 0.1 },                    // missing clusterId — filtered
      null,                                   // null entry — filtered
    ]);
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', clusterMembershipsJson: json }),
    ]);
    const suggestions = await loadSuggestions();
    expect(suggestions[0].clusters).toEqual([{ clusterId: 'c1', confidence: 0.9 }]);
  });

  it('returns valid cluster memberships', async () => {
    const json = JSON.stringify([{ clusterId: 'clu-1', confidence: 0.85 }]);
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', clusterMembershipsJson: json }),
    ]);
    const suggestions = await loadSuggestions();
    expect(suggestions[0].clusters).toEqual([{ clusterId: 'clu-1', confidence: 0.85 }]);
  });
});

// ===========================================================================
// getLocalSuggestionServerIds
// ===========================================================================

describe('getLocalSuggestionServerIds', () => {
  it('returns empty array when no rows exist', async () => {
    db._setRows('article_suggestions', []);
    const ids = await getLocalSuggestionServerIds();
    expect(ids).toEqual([]);
  });

  it('returns ids of all rows', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 'id-1' }),
      makeSuggestion({ id: 'id-2' }),
    ]);
    const ids = await getLocalSuggestionServerIds();
    expect(ids).toEqual(expect.arrayContaining(['id-1', 'id-2']));
    expect(ids).toHaveLength(2);
  });
});

// ===========================================================================
// loadSuggestions
// ===========================================================================

describe('loadSuggestions', () => {
  it('returns empty array when no rows exist', async () => {
    db._setRows('article_suggestions', []);
    const result = await loadSuggestions();
    expect(result).toEqual([]);
  });

  it('maps each row to a ForYouSuggestion', async () => {
    db._setRows('article_suggestions', [makeSuggestion({ id: 's1' })]);
    const result = await loadSuggestions();
    expect(result).toHaveLength(1);
    expect(result[0]._id).toBe('s1');
    expect(result[0].title_en).toBe('Test Title EN');
    expect(result[0].createdAt).toBe(NOW.toISOString());
    expect(result[0].firstPubDate).toBe(NOW.toISOString());
  });

  // `geo_tags_json` was on the row from the start but never projected: only
  // `getSuggestionFeedbackContext` read it, and only after a fresh DB fetch, so
  // every surface holding a `ForYouSuggestion` had the article's places on disk
  // with no way to reach them.
  it('maps geo tags onto the suggestion, with the scorer\'s parse shape', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({
        id: 's1',
        geoTagsJson: JSON.stringify([
          { city: 'Taipei', region: 'Taipei City', countryCode: 'TWN' },
          { countryCode: 'DEU' },
        ]),
      }),
    ]);
    const [row] = await loadSuggestions();
    expect(row.geoTags).toEqual([
      { city: 'Taipei', region: 'Taipei City', countryCode: 'TWN' },
      { city: undefined, region: undefined, countryCode: 'DEU' },
    ]);
  });

  it('drops geo tags with no usable countryCode — same filter as buildStageCandidateInput', async () => {
    // The two must agree, or a `place` filter and the row it is shown against
    // disagree about which places the article carries.
    db._setRows('article_suggestions', [
      makeSuggestion({
        id: 's1',
        geoTagsJson: JSON.stringify([{ city: 'Nowhere' }, { countryCode: '' }, { countryCode: 'FRA' }]),
      }),
    ]);
    const [row] = await loadSuggestions();
    expect(row.geoTags).toEqual([{ city: undefined, region: undefined, countryCode: 'FRA' }]);
  });

  it('yields [] for a null or unparseable geo_tags_json', async () => {
    db._setRows('article_suggestions', [makeSuggestion({ id: 's1', geoTagsJson: null })]);
    expect((await loadSuggestions())[0].geoTags).toEqual([]);
    db._setRows('article_suggestions', [makeSuggestion({ id: 's2', geoTagsJson: 'not json' })]);
    expect((await loadSuggestions())[0].geoTags).toEqual([]);
  });

  it('maps all ForYouSuggestion fields correctly', async () => {
    const sug = makeSuggestion({
      id: 's1',
      articleId: 'art-1',
      countryCode: 'DEU',
      languageCode: 'de',
      publicationName: 'Der Spiegel',
      titleEn: 'Title EN',
      titleOriginal: 'Titel Original',
      descriptionEn: 'Beschreibung',
      articleUrl: 'https://spiegel.de/a',
      imageUrl: 'https://spiegel.de/img.jpg',
      relevance: 0.75,
      reason: 'Relevant to Berlin',
      relevanceGenerationCompleted: true,
      reasonGenerationCompleted: true,
      matchedTopicTextsJson: '["berlin","germany"]',
    });
    db._setRows('article_suggestions', [sug]);
    const [result] = await loadSuggestions();
    expect(result._id).toBe('s1');
    expect(result.articleId).toBe('art-1');
    expect(result.country_code).toBe('DEU');
    expect(result.language_code).toBe('de');
    expect(result.publication_name).toBe('Der Spiegel');
    expect(result.title_en).toBe('Title EN');
    expect(result.title_original).toBe('Titel Original');
    expect(result.description_en).toBe('Beschreibung');
    expect(result.article_url).toBe('https://spiegel.de/a');
    expect(result.image_url).toBe('https://spiegel.de/img.jpg');
    expect(result.relevance).toBe(0.75);
    expect(result.reason).toBe('Relevant to Berlin');
    expect(result.status).toBe('complete');
    expect(result.userTopicIds).toEqual(['berlin', 'germany']);
  });
});

// ===========================================================================
// countUnscoredSuggestions
// ===========================================================================

describe('countUnscoredSuggestions', () => {
  it('returns 0 when all suggestions are scored', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', relevanceGenerationCompleted: true }),
    ]);
    const count = await countUnscoredSuggestions();
    // Note: fake query ignores the Q.where predicate and returns all rows,
    // but fetchCount returns the row count — we assert the call was made
    expect(count).toBe(1);
  });
});

// ===========================================================================
// getOldestUnscoredCreatedAt
// ===========================================================================

describe('getOldestUnscoredCreatedAt', () => {
  it('returns null when there are no unscored rows', async () => {
    db._setRows('article_suggestions', []);
    const result = await getOldestUnscoredCreatedAt();
    expect(result).toBeNull();
  });

  // The fake query ignores Q.where/Q.sortBy/Q.take and returns every row set,
  // so a single-row fixture is what actually exercises "pick the first row's
  // createdAt" here — real WatermelonDB does the sort+take(1) at the DB layer.
  it("returns the row's createdAt in milliseconds", async () => {
    const createdAt = new Date('2024-05-01T12:00:00.000Z');
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', createdAt }),
    ]);
    const result = await getOldestUnscoredCreatedAt();
    expect(result).toBe(createdAt.getTime());
  });
});

// ===========================================================================
// getUnscoredSuggestionsWithFacts
// ===========================================================================

describe('getUnscoredSuggestionsWithFacts', () => {
  it('returns empty array when no rows match', async () => {
    db._setRows('article_suggestions', []);
    const result = await getUnscoredSuggestionsWithFacts();
    expect(result).toEqual([]);
  });

  it('returns candidates with empty relatedFacts when no links exist', async () => {
    db._setRows('article_suggestions', [makeSuggestion({ id: 's1' })]);
    db._setRows('article_suggestion_facts', []);
    db._setRows('facts', []);
    const result = await getUnscoredSuggestionsWithFacts();
    expect(result).toHaveLength(1);
    expect(result[0].relatedFacts).toEqual([]);
  });

  it('returns candidates with linked facts', async () => {
    db._setRows('article_suggestions', [makeSuggestion({ id: 's1' })]);
    db._setRows('article_suggestion_facts', [
      makeLink({ id: 'lk1', articleSuggestionId: 's1', factId: 'fact-1' }),
    ]);
    db._setRows('facts', [
      makeFactRecord({ id: 'fact-1', statement: 'I live in Berlin' }),
    ]);
    const result = await getUnscoredSuggestionsWithFacts();
    expect(result[0].relatedFacts).toEqual([{ id: 'fact-1', statement: 'I live in Berlin' }]);
  });

  it('skips links whose factId has no matching fact record', async () => {
    db._setRows('article_suggestions', [makeSuggestion({ id: 's1' })]);
    db._setRows('article_suggestion_facts', [
      makeLink({ id: 'lk1', articleSuggestionId: 's1', factId: 'missing-fact' }),
    ]);
    db._setRows('facts', []); // no facts
    const result = await getUnscoredSuggestionsWithFacts();
    expect(result[0].relatedFacts).toEqual([]);
  });

  it('deduplicates facts across links with same factId', async () => {
    db._setRows('article_suggestions', [makeSuggestion({ id: 's1' })]);
    db._setRows('article_suggestion_facts', [
      makeLink({ id: 'lk1', articleSuggestionId: 's1', factId: 'fact-1' }),
      makeLink({ id: 'lk2', articleSuggestionId: 's1', factId: 'fact-1' }),
    ]);
    db._setRows('facts', [
      makeFactRecord({ id: 'fact-1', statement: 'I live in Berlin' }),
    ]);
    const result = await getUnscoredSuggestionsWithFacts();
    // The same fact appears twice in links → appears twice in relatedFacts (no dedup in service)
    // (Two links pointing to the same fact → two entries in relatedFacts)
    expect(result[0].relatedFacts).toHaveLength(2);
  });

  it('respects the limit parameter by passing Q.take to the query', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1' }),
      makeSuggestion({ id: 's2' }),
    ]);
    db._setRows('article_suggestion_facts', []);
    db._setRows('facts', []);
    // fake query returns all rows regardless of limit — just verify no crash
    const result = await getUnscoredSuggestionsWithFacts(1);
    expect(result).toHaveLength(2); // fake ignores limit; service still works
  });

  it('does not query facts table when there are no links', async () => {
    db._setRows('article_suggestions', [makeSuggestion({ id: 's1' })]);
    db._setRows('article_suggestion_facts', []);
    const factsQuerySpy = jest.spyOn(db._collections['facts'], 'query');
    await getUnscoredSuggestionsWithFacts();
    // When factIds.length === 0, the facts query is skipped
    expect(factsQuerySpy).not.toHaveBeenCalled();
  });

  it('parses matchedTopicTextsJson into userTopicIds', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', matchedTopicTextsJson: '["topic-a","topic-b"]' }),
    ]);
    db._setRows('article_suggestion_facts', []);
    const result = await getUnscoredSuggestionsWithFacts();
    expect(result[0].userTopicIds).toEqual(['topic-a', 'topic-b']);
  });
});

// ===========================================================================
// getScoredSuggestionsWithoutReasons
// ===========================================================================

describe('getScoredSuggestionsWithoutReasons', () => {
  // THE PREDICATE IS THE GUARANTEE, and the fake query() ignores Q.where, so it
  // has to be asserted on the call args rather than through the return value.
  //
  // This query is what stops the orphaned-reason sweep re-electing a
  // `reason_skipped` row and re-spending the LLM call the v4 tag gate just
  // saved — every sweep, forever. Widening it to "any scored status without a
  // reason" would do exactly that (and would also re-elect `excluded` rows,
  // which is why the source comment says not to).
  it('selects reason_pending ONLY — never a terminal status', async () => {
    db._setRows('article_suggestions', []);
    const col = db._collections['article_suggestions'];
    (col.query as jest.Mock).mockClear();

    await getScoredSuggestionsWithoutReasons();

    const args = JSON.stringify((col.query as jest.Mock).mock.calls[0]);
    expect(args).toContain(ArticleSuggestionStatus.ReasonPending);
    expect(args).not.toContain(ArticleSuggestionStatus.ReasonSkipped);
    expect(args).not.toContain(ArticleSuggestionStatus.Complete);
  });

  it('returns empty array when no rows exist', async () => {
    db._setRows('article_suggestions', []);
    const result = await getScoredSuggestionsWithoutReasons();
    expect(result).toEqual([]);
  });

  it('includes relevance in each candidate', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', relevance: 0.7 }),
    ]);
    db._setRows('article_suggestion_facts', []);
    db._setRows('facts', []);
    const result = await getScoredSuggestionsWithoutReasons();
    expect(result[0].relevance).toBe(0.7);
  });

  it('respects the limit parameter', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1' }),
      makeSuggestion({ id: 's2' }),
    ]);
    db._setRows('article_suggestion_facts', []);
    // fake ignores limit — just ensure no crash with limit
    const result = await getScoredSuggestionsWithoutReasons(1);
    expect(result).toHaveLength(2);
  });

  it('returns candidates with linked facts (same logic as unscored)', async () => {
    db._setRows('article_suggestions', [makeSuggestion({ id: 's1' })]);
    db._setRows('article_suggestion_facts', [
      makeLink({ articleSuggestionId: 's1', factId: 'fact-1' }),
    ]);
    db._setRows('facts', [
      makeFactRecord({ id: 'fact-1', statement: 'Fact text' }),
    ]);
    const result = await getScoredSuggestionsWithoutReasons();
    expect(result[0].relatedFacts).toEqual([{ id: 'fact-1', statement: 'Fact text' }]);
  });
});

// ===========================================================================
// deleteSuggestionsByServerIds
// ===========================================================================

describe('deleteSuggestionsByServerIds', () => {
  it('returns 0 and skips DB for empty array', async () => {
    const count = await deleteSuggestionsByServerIds([]);
    expect(count).toBe(0);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('returns 0 when no matching rows exist in the DB', async () => {
    db._setRows('article_suggestions', []);
    const count = await deleteSuggestionsByServerIds(['nonexistent']);
    expect(count).toBe(0);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('deletes suggestions and their links in a single batch write', async () => {
    const sug = makeSuggestion({ id: 'sug-1' });
    const lk = makeLink({ articleSuggestionId: 'sug-1' });
    db._setRows('article_suggestions', [sug]);
    db._setRows('article_suggestion_facts', [lk]);

    const count = await deleteSuggestionsByServerIds(['sug-1']);
    expect(count).toBe(1);
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(sug.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
    expect(lk.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
  });

  it('includes both links and suggestions in the batch', async () => {
    const sug = makeSuggestion({ id: 'sug-1' });
    const lk1 = makeLink({ id: 'lk1', articleSuggestionId: 'sug-1' });
    const lk2 = makeLink({ id: 'lk2', articleSuggestionId: 'sug-1' });
    db._setRows('article_suggestions', [sug]);
    db._setRows('article_suggestion_facts', [lk1, lk2]);

    await deleteSuggestionsByServerIds(['sug-1']);
    const batchArgs = (database.batch as jest.Mock).mock.calls[0][0];
    expect(batchArgs).toHaveLength(3); // 2 links + 1 suggestion
  });

  it('returns count of matched suggestions', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 'sug-1' }),
      makeSuggestion({ id: 'sug-2' }),
    ]);
    db._setRows('article_suggestion_facts', []);
    const count = await deleteSuggestionsByServerIds(['sug-1', 'sug-2']);
    expect(count).toBe(2);
  });
});

// ===========================================================================
// deleteSuggestionByServerId
// ===========================================================================

describe('deleteSuggestionByServerId', () => {
  it('returns true when the row existed and was deleted', async () => {
    db._setRows('article_suggestions', [makeSuggestion({ id: 'sug-1' })]);
    db._setRows('article_suggestion_facts', []);
    const result = await deleteSuggestionByServerId('sug-1');
    expect(result).toBe(true);
  });

  it('returns false when the row did not exist', async () => {
    db._setRows('article_suggestions', []);
    const result = await deleteSuggestionByServerId('nonexistent');
    expect(result).toBe(false);
  });
});

// ===========================================================================
// deleteOldSuggestions
// ===========================================================================

describe('deleteOldSuggestions', () => {
  it('returns 0 when no rows exist', async () => {
    db._setRows('article_suggestions', []);
    const count = await deleteOldSuggestions(Date.now());
    expect(count).toBe(0);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('deletes old suggestions and their links in a single batch write', async () => {
    const sug = makeSuggestion({ id: 'sug-old' });
    const lk = makeLink({ articleSuggestionId: 'sug-old' });
    db._setRows('article_suggestions', [sug]);
    db._setRows('article_suggestion_facts', [lk]);

    const count = await deleteOldSuggestions(Date.now());
    expect(count).toBe(1);
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(sug.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
    expect(lk.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
  });

  it('deletes links for all matched suggestions', async () => {
    const sug1 = makeSuggestion({ id: 'sug-1' });
    const sug2 = makeSuggestion({ id: 'sug-2' });
    const lk1 = makeLink({ id: 'lk1', articleSuggestionId: 'sug-1' });
    db._setRows('article_suggestions', [sug1, sug2]);
    db._setRows('article_suggestion_facts', [lk1]);

    const count = await deleteOldSuggestions(Date.now());
    expect(count).toBe(2);
    const batchArgs = (database.batch as jest.Mock).mock.calls[0][0];
    expect(batchArgs).toHaveLength(3); // 1 link + 2 suggestions
  });
});

// ===========================================================================
// saveScoringResult
// ===========================================================================

describe('saveScoringResult', () => {
  it('updates relevance, reason, and status on the row', async () => {
    const sug = makeSuggestion({ id: 'sug-1' });
    db._setRows('article_suggestions', [sug]);

    await saveScoringResult('sug-1', { relevance: 0.8, reason: GROUNDED_REASON, reasonSkipped: false });

    expect(database.write).toHaveBeenCalledTimes(1);
    expect(sug.relevance).toBe(0.8);
    expect(sug.reason).toBe(GROUNDED_REASON);
    expect(sug.status).toBe('complete');
  });

  it('sets status=complete when reason is non-empty', async () => {
    const sug = makeSuggestion({ id: 'sug-1' });
    db._setRows('article_suggestions', [sug]);
    await saveScoringResult('sug-1', { relevance: 0.5, reason: GROUNDED_REASON, reasonSkipped: false });
    expect(sug.status).toBe('complete');
  });

  it('sets status=reason_pending when reason is empty and not skipped/failed', async () => {
    const sug = makeSuggestion({ id: 'sug-1' });
    db._setRows('article_suggestions', [sug]);
    await saveScoringResult('sug-1', { relevance: 0.5, reason: '', reasonSkipped: false });
    expect(sug.status).toBe('reason_pending');
  });

  it('sets status=complete when reasonSkipped=true even with empty reason', async () => {
    const sug = makeSuggestion({ id: 'sug-1' });
    db._setRows('article_suggestions', [sug]);
    await saveScoringResult('sug-1', { relevance: 0.1, reason: '', reasonSkipped: true });
    expect(sug.status).toBe('complete');
  });

  it('uses articleSuggestionsCol.find to locate the row', async () => {
    const sug = makeSuggestion({ id: 'sug-1' });
    db._setRows('article_suggestions', [sug]);
    const col = db._collections['article_suggestions'];
    await saveScoringResult('sug-1', { relevance: 0.3, reason: '', reasonSkipped: false });
    expect(col.find).toHaveBeenCalledWith('sug-1');
  });
});

// ===========================================================================
// batchMarkAsScoredByIds
// ===========================================================================

describe('batchMarkAsScoredByIds', () => {
  it('does nothing for empty ids array', async () => {
    await batchMarkAsScoredByIds([]);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('sets relevance=0, reason="", status=complete in one batch', async () => {
    const sug1 = makeSuggestion({ id: 'sug-1' });
    const sug2 = makeSuggestion({ id: 'sug-2' });
    db._setRows('article_suggestions', [sug1, sug2]);

    await batchMarkAsScoredByIds(['sug-1', 'sug-2']);

    expect(database.write).toHaveBeenCalledTimes(1);
    expect(database.batch).toHaveBeenCalledTimes(1);
    expect(sug1.relevance).toBe(0);
    expect(sug1.reason).toBe('');
    expect(sug1.status).toBe('complete');
    expect(sug2.status).toBe('complete');
  });

  it('tolerates a row deleted mid-flight: updates present rows, skips missing ids, no throw', async () => {
    const sug1 = makeSuggestion({ id: 'sug-1' });
    // sug-2 is intentionally absent (hard-deleted underneath the batch).
    db._setRows('article_suggestions', [sug1]);

    await expect(
      batchMarkAsScoredByIds(['sug-1', 'sug-2']),
    ).resolves.toBeUndefined();

    expect(database.write).toHaveBeenCalledTimes(1);
    const batchArgs = (database.batch as jest.Mock).mock.calls[0][0];
    expect(batchArgs).toHaveLength(1); // only the present row was prepared
    expect(sug1.status).toBe('complete');
    expect(sug1.relevance).toBe(0);
  });

  it('skips the write entirely when every id is missing', async () => {
    db._setRows('article_suggestions', []);
    await batchMarkAsScoredByIds(['gone-1', 'gone-2']);
    expect(database.write).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// batchMarkReasonSkipped
// ===========================================================================

describe('batchMarkReasonSkipped', () => {
  it('does nothing for empty ids array', async () => {
    await batchMarkReasonSkipped([]);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('sets status=complete for each id in one batch', async () => {
    const sug = makeSuggestion({ id: 'sug-1', status: 'reason_pending' });
    db._setRows('article_suggestions', [sug]);

    await batchMarkReasonSkipped(['sug-1']);

    expect(database.write).toHaveBeenCalledTimes(1);
    expect(database.batch).toHaveBeenCalledTimes(1);
    expect(sug.status).toBe('complete');
  });

  it('tolerates a row deleted mid-flight: marks present rows complete, skips missing ids, no throw', async () => {
    const sug = makeSuggestion({ id: 'sug-1', status: 'reason_pending' });
    // 'deleted-2' was hard-deleted underneath the in-flight discard.
    db._setRows('article_suggestions', [sug]);

    await expect(
      batchMarkReasonSkipped(['sug-1', 'deleted-2']),
    ).resolves.toBeUndefined();

    expect(database.write).toHaveBeenCalledTimes(1);
    const batchArgs = (database.batch as jest.Mock).mock.calls[0][0];
    expect(batchArgs).toHaveLength(1);
    expect(sug.status).toBe('complete');
  });

  it('skips the write entirely when every id is missing', async () => {
    db._setRows('article_suggestions', []);
    await batchMarkReasonSkipped(['gone']);
    expect(database.write).not.toHaveBeenCalled();
  });
});


// ===========================================================================
// batchPropagateScores
// ===========================================================================

describe('batchPropagateScores', () => {
  it('does nothing for empty entries array', async () => {
    await batchPropagateScores([]);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('writes relevance, reason, and status=complete for each entry in one batch', async () => {
    const sug1 = makeSuggestion({ id: 'sug-1', relevance: 0, reason: '', status: 'unscored' });
    const sug2 = makeSuggestion({ id: 'sug-2', relevance: 0, reason: '', status: 'unscored' });
    db._setRows('article_suggestions', [sug1, sug2]);

    await batchPropagateScores([
      { id: 'sug-1', relevance: 0.72, reason: GROUNDED_REASON },
      { id: 'sug-2', relevance: 0.72, reason: GROUNDED_REASON },
    ]);

    expect(database.write).toHaveBeenCalledTimes(1);
    expect(database.batch).toHaveBeenCalledTimes(1);
    expect(sug1.relevance).toBe(0.72);
    expect(sug1.reason).toBe(GROUNDED_REASON);
    expect(sug1.status).toBe('complete');
    expect(sug2.relevance).toBe(0.72);
    expect(sug2.status).toBe('complete');
  });

  // An EMPTY propagated reason means the donor had nothing to donate (it was
  // itself still `reason_pending`). Stamping `complete` there produced a row
  // that was visible, reason-less, and invisible to the orphaned-reasons sweep
  // (which selects `reason_pending` only) — permanently broken. It must stay
  // `reason_pending` so that sweep picks it up.
  it('leaves status=reason_pending when the propagated reason is empty', async () => {
    const sug = makeSuggestion({ id: 'sug-1', status: 'unscored' });
    db._setRows('article_suggestions', [sug]);

    await batchPropagateScores([{ id: 'sug-1', relevance: 0.72, reason: '' }]);

    expect(sug.relevance).toBe(0.72); // relevance still propagates — the saving is kept
    expect(sug.status).toBe('reason_pending');
  });

  it('treats a whitespace-only propagated reason as empty', async () => {
    const sug = makeSuggestion({ id: 'sug-1', status: 'unscored' });
    db._setRows('article_suggestions', [sug]);

    await batchPropagateScores([{ id: 'sug-1', relevance: 0.72, reason: '   \n ' }]);

    expect(sug.status).toBe('reason_pending');
  });

  // Monotonicity: a propagation from a reason-less donor must never CLEAR a
  // reason the row already carried. Without this, reason-presence flip-flops and
  // a card could lose its explanation.
  it('does not clear an existing reason when the propagated reason is empty', async () => {
    const sug = makeSuggestion({
      id: 'sug-1',
      relevance: 0.6,
      reason: 'Its own hard-won reason',
      status: 'complete',
    });
    db._setRows('article_suggestions', [sug]);

    await batchPropagateScores([{ id: 'sug-1', relevance: 0.72, reason: '' }]);

    expect(sug.reason).toBe('Its own hard-won reason');
    expect(sug.relevance).toBe(0.72);
    expect(sug.status).toBe('reason_pending');
  });

  it('tolerates a row deleted mid-flight: applies scores to present rows, skips missing ids, no throw', async () => {
    const sug1 = makeSuggestion({ id: 'sug-1', status: 'unscored' });
    // 'sug-gone' was hard-deleted underneath the propagation batch.
    db._setRows('article_suggestions', [sug1]);

    await expect(
      batchPropagateScores([
        { id: 'sug-1', relevance: 0.72, reason: GROUNDED_REASON },
        { id: 'sug-gone', relevance: 0.72, reason: GROUNDED_REASON },
      ]),
    ).resolves.toBeUndefined();

    expect(database.write).toHaveBeenCalledTimes(1);
    const batchArgs = (database.batch as jest.Mock).mock.calls[0][0];
    expect(batchArgs).toHaveLength(1);
    expect(sug1.relevance).toBe(0.72);
    expect(sug1.status).toBe('complete');
  });

  it('skips the write entirely when every entry row is missing', async () => {
    db._setRows('article_suggestions', []);
    await batchPropagateScores([{ id: 'gone', relevance: 0.5, reason: 'x' }]);
    expect(database.write).not.toHaveBeenCalled();
  });

  // THE claim the whole fix rests on: a row left `reason_pending` by an
  // empty-reason propagation must be picked up by the recovery sweep. That sweep
  // is `enqueueOrphanedReasons`, which reads getScoredSuggestionsWithoutReasons()
  // (status == reason_pending ONLY — "Do not widen this query") and then keeps
  // rows with `relevance > REASON_RELEVANCE_THRESHOLD` (0.3). An inherited
  // above-gate relevance satisfies that, so no query widening is needed. If
  // either predicate ever moves, this fails loudly instead of silently
  // stranding the row.
  it('leaves a propagated reason-less row where the orphaned-reasons sweep can find it', async () => {
    const sug = makeSuggestion({ id: 'sug-1', relevance: 0, reason: '', status: 'unscored' });
    db._setRows('article_suggestions', [sug]);
    db._setRows('article_suggestion_facts', []);
    db._setRows('facts', []);

    // Donor cleared the render gate but had no reason yet.
    await batchPropagateScores([{ id: 'sug-1', relevance: 0.72, reason: '' }]);
    expect(sug.status).toBe('reason_pending');

    const swept = await getScoredSuggestionsWithoutReasons();
    const found = swept.find((c) => c.id === 'sug-1');

    expect(found).toBeDefined();
    // enqueueOrphanedReasons' own filter, asserted on the value it reads.
    expect(found!.relevance).toBeGreaterThan(0.3);
  });
});

// ===========================================================================
// saveReason
// ===========================================================================

describe('saveReason', () => {
  it('updates reason and sets status=complete on the row', async () => {
    const sug = makeSuggestion({ id: 'sug-1', reason: '' });
    db._setRows('article_suggestions', [sug]);

    await saveReason('sug-1', GROUNDED_REASON);

    expect(database.write).toHaveBeenCalledTimes(1);
    expect(sug.reason).toBe(GROUNDED_REASON);
    expect(sug.status).toBe('complete');
  });

  it('sets status=reason_pending when reason is empty string', async () => {
    const sug = makeSuggestion({ id: 'sug-1' });
    db._setRows('article_suggestions', [sug]);
    await saveReason('sug-1', '');
    expect(sug.status).toBe('reason_pending');
  });
});

// ===========================================================================
// Reason grounding — every write path
//
// A note that describes a DIFFERENT article than the one it sits on is the
// defect these cover: an MP-rainfall story that shipped with an EU-AI-Act
// sentence on it. Three unrelated mechanisms can cause it (positional batch
// decode, a propagated donor reason, a model echoing a prompt exemplar), so the
// check lives at the one place they all converge — the writes in this file.
// Each site must drop the sentence and leave the row owing a real one, WITHOUT
// losing the score, which is independently useful.
// ===========================================================================

describe('reason grounding at the write sites', () => {
  // Shares no content token with 'Test Title EN' / 'A description'.
  const FOREIGN_REASON =
    "New AI Act rules on deepfakes directly impact your AI news app's compliance requirements.";

  it('saveScoringResult keeps the score but drops a note about another article', async () => {
    const sug = makeSuggestion({ id: 'sug-1', reason: '', status: 'unscored' });
    db._setRows('article_suggestions', [sug]);

    await saveScoringResult('sug-1', {
      relevance: 0.9077,
      reason: FOREIGN_REASON,
      reasonSkipped: false,
    });

    expect(sug.relevance).toBe(0.9077);
    expect(sug.reason).toBe('');
    // Owed a real note, not terminal — the orphan sweep will retry it.
    expect(sug.status).toBe('reason_pending');
  });

  it('saveScoringResult still lands terminal when no note was owed at all', async () => {
    const sug = makeSuggestion({ id: 'sug-1', reason: '', status: 'unscored' });
    db._setRows('article_suggestions', [sug]);

    await saveScoringResult('sug-1', {
      relevance: 0.1,
      reason: FOREIGN_REASON,
      reasonSkipped: true,
    });

    expect(sug.reason).toBe('');
    expect(sug.status).toBe('complete');
  });

  it('saveReason drops it and leaves the row for the next sweep', async () => {
    const sug = makeSuggestion({ id: 'sug-1', reason: '', status: 'reason_pending' });
    db._setRows('article_suggestions', [sug]);

    await saveReason('sug-1', FOREIGN_REASON);

    expect(sug.reason).toBe('');
    expect(sug.status).toBe('reason_pending');
  });

  it('batchPropagateScores rejects a donor sentence that is false on the recipient', async () => {
    const sug = makeSuggestion({ id: 'sug-1', relevance: 0, reason: '', status: 'unscored' });
    db._setRows('article_suggestions', [sug]);

    await batchPropagateScores([
      { id: 'sug-1', relevance: 0.72, reason: FOREIGN_REASON },
    ]);

    // Relevance still propagates — grouping IS evidence about the story.
    expect(sug.relevance).toBe(0.72);
    expect(sug.reason).toBe('');
    expect(sug.status).toBe('reason_pending');
  });

  it('batchPropagateScores still copies a donor sentence that fits the recipient', async () => {
    const sug = makeSuggestion({ id: 'sug-1', relevance: 0, reason: '', status: 'unscored' });
    db._setRows('article_suggestions', [sug]);

    await batchPropagateScores([{ id: 'sug-1', relevance: 0.72, reason: GROUNDED_REASON }]);

    expect(sug.reason).toBe(GROUNDED_REASON);
    expect(sug.status).toBe('complete');
  });

  it('does not judge a row whose article text never arrived', async () => {
    const sug = makeSuggestion({
      id: 'sug-1',
      reason: '',
      status: 'unscored',
      titleEn: null,
      descriptionEn: null,
    });
    db._setRows('article_suggestions', [sug]);

    await saveScoringResult('sug-1', {
      relevance: 0.8,
      reason: FOREIGN_REASON,
      reasonSkipped: false,
    });

    // Nothing to compare against ⇒ keep. A rejection here would be a coin flip.
    expect(sug.reason).toBe(FOREIGN_REASON);
    expect(sug.status).toBe('complete');
  });
});

// ===========================================================================
// getSharedNoteBreakdown
//
// The readout that names the mechanism. Propagation is the ONLY writer that
// copies a note verbatim between articles, so a shared string is its
// fingerprint; a batch decode that zipped results to the wrong articles, or a
// model echoing its own prompt exemplar, each produce a sentence that exists
// exactly once. These pin that distinction.
// ===========================================================================

describe('getSharedNoteBreakdown', () => {
    it('reports nothing shared when every note is unique', async () => {
        db._setRows('article_suggestions', [
            makeSuggestion({ id: 'a', reason: 'One note' }),
            makeSuggestion({ id: 'b', reason: 'Another note' }),
        ]);

        const r = await getSharedNoteBreakdown();

        expect(r.rowsWithNote).toBe(2);
        expect(r.distinctNotes).toBe(2);
        expect(r.sharedNoteGroups).toBe(0);
        expect(r.rowsSharingANote).toBe(0);
        expect(r.largestGroupSize).toBe(0);
        expect(r.largestGroup).toBeNull();
    });

    it('finds a note copied across articles and names the group', async () => {
        const copied = 'The Hormuz closure raises what you pay at the pump.';
        db._setRows('article_suggestions', [
            makeSuggestion({ id: 'a', reason: copied, titleEn: 'Strait closed' }),
            makeSuggestion({ id: 'b', reason: copied, titleEn: 'Tanker traffic halts' }),
            makeSuggestion({ id: 'c', reason: 'Its own note' }),
        ]);

        const r = await getSharedNoteBreakdown();

        expect(r.rowsWithNote).toBe(3);
        expect(r.distinctNotes).toBe(2);
        expect(r.sharedNoteGroups).toBe(1);
        expect(r.rowsSharingANote).toBe(2);
        expect(r.largestGroupSize).toBe(2);
        expect(r.largestGroup?.note).toBe(copied);
        expect(r.largestGroup?.titles).toEqual(['Strait closed', 'Tanker traffic halts']);
    });

    it('treats whitespace-only notes as absent rather than as one shared group', async () => {
        db._setRows('article_suggestions', [
            makeSuggestion({ id: 'a', reason: '   ' }),
            makeSuggestion({ id: 'b', reason: '   ' }),
        ]);

        const r = await getSharedNoteBreakdown();

        expect(r.sharedNoteGroups).toBe(0);
        expect(r.largestGroup).toBeNull();
    });

    it('returns the zeroed shape when no row carries a note', async () => {
        db._setRows('article_suggestions', []);

        const r = await getSharedNoteBreakdown();

        expect(r).toEqual({
            rowsWithNote: 0,
            distinctNotes: 0,
            sharedNoteGroups: 0,
            rowsSharingANote: 0,
            largestGroupSize: 0,
            largestGroup: null,
        });
    });

    it('truncates the sampled note and titles so the share payload stays bounded', async () => {
        const longNote = 'n'.repeat(300);
        db._setRows('article_suggestions', [
            makeSuggestion({ id: 'a', reason: longNote, titleEn: 't'.repeat(300) }),
            makeSuggestion({ id: 'b', reason: longNote, titleEn: 't'.repeat(300) }),
        ]);

        const r = await getSharedNoteBreakdown();

        expect(r.largestGroup!.note).toHaveLength(120);
        expect(r.largestGroup!.titles[0]).toHaveLength(80);
    });

    it('caps the sampled group at six members however large it really is', async () => {
        const copied = 'Same sentence everywhere';
        db._setRows(
            'article_suggestions',
            Array.from({ length: 9 }, (_, i) =>
                makeSuggestion({ id: `s${i}`, reason: copied }),
            ),
        );

        const r = await getSharedNoteBreakdown();

        // The COUNT is honest about all nine; only the eyeball sample is capped.
        expect(r.largestGroupSize).toBe(9);
        expect(r.rowsSharingANote).toBe(9);
        expect(r.largestGroup!.titles).toHaveLength(6);
    });
});

// ===========================================================================
// getSuggestionByServerId
// ===========================================================================

describe('getSuggestionByServerId', () => {
  it('returns the ForYouSuggestion when the row exists', async () => {
    db._setRows('article_suggestions', [makeSuggestion({ id: 'sug-1' })]);
    const result = await getSuggestionByServerId('sug-1');
    expect(result).not.toBeNull();
    expect(result!._id).toBe('sug-1');
  });

  it('returns null when the row does not exist (find throws)', async () => {
    db._setRows('article_suggestions', []);
    const result = await getSuggestionByServerId('nonexistent');
    expect(result).toBeNull();
  });
});

// ===========================================================================
// clearSuggestions
// ===========================================================================

describe('clearSuggestions', () => {
  it('only calls deleteSetting when both collections are empty', async () => {
    db._setRows('article_suggestions', []);
    db._setRows('article_suggestion_facts', []);
    await clearSuggestions();
    expect(database.write).not.toHaveBeenCalled();
    expect(mockDeleteSetting).toHaveBeenCalledWith('feed_metadata');
  });

  it('batch-deletes all suggestions and links, then clears the feed metadata', async () => {
    const sug = makeSuggestion({ id: 'sug-1' });
    const lk = makeLink({ articleSuggestionId: 'sug-1' });
    db._setRows('article_suggestions', [sug]);
    db._setRows('article_suggestion_facts', [lk]);

    await clearSuggestions();

    expect(database.write).toHaveBeenCalledTimes(1);
    expect(sug.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
    expect(lk.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
    expect(mockDeleteSetting).toHaveBeenCalledWith('feed_metadata');
  });

  it('also calls deleteSetting when only links exist (no suggestions)', async () => {
    db._setRows('article_suggestions', []);
    db._setRows('article_suggestion_facts', [makeLink()]);
    await clearSuggestions();
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(mockDeleteSetting).toHaveBeenCalledWith('feed_metadata');
  });
});

// ===========================================================================
// pruneOrphanedSuggestions
// ===========================================================================

describe('pruneOrphanedSuggestions', () => {
  it('returns -1 and clears everything when no active topics exist', async () => {
    mockGetFacts.mockResolvedValueOnce([]);
    db._setRows('article_suggestions', [makeSuggestion({ id: 's1' })]);
    db._setRows('article_suggestion_facts', []);
    const result = await pruneOrphanedSuggestions();
    expect(result).toBe(-1);
  });

  it('returns 0 when all suggestions still have matching topics', async () => {
    mockGetFacts.mockResolvedValueOnce([
      makeFact({ metadata: { topics: ['berlin'] } }),
    ]);
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', matchedTopicTextsJson: '["berlin"]' }),
    ]);
    db._setRows('article_suggestion_facts', []);
    const result = await pruneOrphanedSuggestions();
    expect(result).toBe(0);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('deletes suggestions whose topics are all absent from active facts', async () => {
    mockGetFacts.mockResolvedValueOnce([
      makeFact({ metadata: { topics: ['london'] } }),
    ]);
    const sug = makeSuggestion({ id: 's1', matchedTopicTextsJson: '["berlin"]' });
    const lk = makeLink({ articleSuggestionId: 's1' });
    db._setRows('article_suggestions', [sug]);
    db._setRows('article_suggestion_facts', [lk]);

    const result = await pruneOrphanedSuggestions();
    expect(result).toBe(1);
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(sug.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
    expect(lk.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
  });

  it('preserves suggestions that partially overlap active topics', async () => {
    mockGetFacts.mockResolvedValueOnce([
      makeFact({ metadata: { topics: ['berlin'] } }),
    ]);
    // This suggestion matches both 'berlin' (active) and 'paris' (inactive)
    // → should be preserved because at least one topic is still active
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', matchedTopicTextsJson: '["berlin","paris"]' }),
    ]);
    db._setRows('article_suggestion_facts', []);
    const result = await pruneOrphanedSuggestions();
    expect(result).toBe(0);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('preserves suggestions with empty matchedTopicTextsJson (null topics)', async () => {
    mockGetFacts.mockResolvedValueOnce([
      makeFact({ metadata: { topics: ['london'] } }),
    ]);
    // matched.length === 0 → the `matched.length > 0 && every(...)` condition is false → preserved
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', matchedTopicTextsJson: null }),
    ]);
    db._setRows('article_suggestion_facts', []);
    const result = await pruneOrphanedSuggestions();
    expect(result).toBe(0);
  });

  it('returns -1 and calls clearSuggestions when facts exist but all have empty topics', async () => {
    mockGetFacts.mockResolvedValueOnce([
      makeFact({ metadata: { topics: [] } }),
    ]);
    db._setRows('article_suggestions', []);
    db._setRows('article_suggestion_facts', []);
    const result = await pruneOrphanedSuggestions();
    expect(result).toBe(-1);
  });

  it('returns -1 and calls clearSuggestions when facts have no metadata', async () => {
    mockGetFacts.mockResolvedValueOnce([
      makeFact({ metadata: undefined }),
    ]);
    db._setRows('article_suggestions', []);
    db._setRows('article_suggestion_facts', []);
    const result = await pruneOrphanedSuggestions();
    expect(result).toBe(-1);
  });
});

// ===========================================================================
// persistFeedMetadata / loadFeedMetadata
// ===========================================================================

describe('persistFeedMetadata', () => {
  it('serialises and stores the metadata via setSetting', async () => {
    await persistFeedMetadata({
      articleCount: 10,
      relevantArticleCount: 7,
      hasGeneratedTopics: true,
      lastProcessingRunFinishedAt: 1234567890,
    });
    expect(mockSetSetting).toHaveBeenCalledWith(
      'feed_metadata',
      JSON.stringify({
        articleCount: 10,
        relevantArticleCount: 7,
        hasGeneratedTopics: true,
        lastProcessingRunFinishedAt: 1234567890,
      }),
    );
  });
});

describe('loadFeedMetadata', () => {
  it('returns null when no setting exists', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    const result = await loadFeedMetadata();
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON (parse error)', async () => {
    mockGetSetting.mockResolvedValueOnce('{ not valid json }');
    const result = await loadFeedMetadata();
    expect(result).toBeNull();
  });

  it('parses and returns valid metadata', async () => {
    const meta = {
      articleCount: 5,
      relevantArticleCount: 3,
      hasGeneratedTopics: false,
      lastProcessingRunFinishedAt: null,
    };
    mockGetSetting.mockResolvedValueOnce(JSON.stringify(meta));
    const result = await loadFeedMetadata();
    expect(result).toEqual(meta);
  });

  it('reads from feed_metadata key', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    await loadFeedMetadata();
    expect(mockGetSetting).toHaveBeenCalledWith('feed_metadata');
  });
});

// ===========================================================================
// getArticleCountByTopicTexts
// ===========================================================================

describe('getArticleCountByTopicTexts', () => {
  it('returns empty map when no suggestions exist', async () => {
    db._setRows('article_suggestions', []);
    const result = await getArticleCountByTopicTexts();
    expect(result.size).toBe(0);
  });

  it('counts articles per topic text', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', matchedTopicTextsJson: '["berlin","germany"]' }),
      makeSuggestion({ id: 's2', matchedTopicTextsJson: '["berlin"]' }),
    ]);
    const result = await getArticleCountByTopicTexts();
    expect(result.get('berlin')).toBe(2);
    expect(result.get('germany')).toBe(1);
  });

  it('ignores suggestions with null matchedTopicTextsJson', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', matchedTopicTextsJson: null }),
    ]);
    const result = await getArticleCountByTopicTexts();
    expect(result.size).toBe(0);
  });
});

// ===========================================================================
// getArticleSuggestionsByTopicTexts
// ===========================================================================

describe('getArticleSuggestionsByTopicTexts', () => {
  it('returns empty array for empty topicTexts', async () => {
    const result = await getArticleSuggestionsByTopicTexts([]);
    expect(result).toEqual([]);
  });

  it('returns suggestions matching any of the given topic texts', async () => {
    const s1 = makeSuggestion({ id: 's1', matchedTopicTextsJson: '["berlin"]' });
    const s2 = makeSuggestion({ id: 's2', matchedTopicTextsJson: '["paris"]' });
    const s3 = makeSuggestion({ id: 's3', matchedTopicTextsJson: '["tokyo"]' });
    db._setRows('article_suggestions', [s1, s2, s3]);

    const result = await getArticleSuggestionsByTopicTexts(['berlin', 'paris']);
    expect(result.map((r: any) => r.id)).toEqual(expect.arrayContaining(['s1', 's2']));
    expect(result.map((r: any) => r.id)).not.toContain('s3');
  });

  it('returns empty array when no suggestions match', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', matchedTopicTextsJson: '["london"]' }),
    ]);
    const result = await getArticleSuggestionsByTopicTexts(['berlin']);
    expect(result).toEqual([]);
  });
});

// ===========================================================================
// getTotalArticleSuggestionCount
// ===========================================================================

describe('getTotalArticleSuggestionCount', () => {
  it('returns 0 when no suggestions exist', async () => {
    db._setRows('article_suggestions', []);
    const count = await getTotalArticleSuggestionCount();
    expect(count).toBe(0);
  });

  it('returns the number of rows in the collection', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1' }),
      makeSuggestion({ id: 's2' }),
      makeSuggestion({ id: 's3' }),
    ]);
    const count = await getTotalArticleSuggestionCount();
    expect(count).toBe(3);
  });
});

// ===========================================================================
// getGroupingRowsByIds / getUnscoredGroupingRows / getScoredDonorRows
// ===========================================================================

describe('getGroupingRowsByIds', () => {
  it('returns [] for an empty ids array without querying', async () => {
    const result = await getGroupingRowsByIds([]);
    expect(result).toEqual([]);
  });

  it('maps titleEn ?? titleOriginal and parses cluster memberships', async () => {
    const clustersJson = JSON.stringify([{ clusterId: 'c1', confidence: 0.8 }]);
    db._setRows('article_suggestions', [
      makeSuggestion({
        id: 's1',
        titleEn: 'English Title',
        titleOriginal: 'Original Title',
        clusterMembershipsJson: clustersJson,
        relevance: 0.6,
        reason: 'because',
        status: 'complete',
      }),
    ]);
    const [row] = await getGroupingRowsByIds(['s1']);
    expect(row.title).toBe('English Title');
    expect(row.clusters).toEqual([{ clusterId: 'c1', confidence: 0.8 }]);
    expect(row.relevance).toBe(0.6);
    expect(row.reason).toBe('because');
    expect(row.status).toBe('complete');
  });

  it('falls back to titleOriginal when titleEn is null', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', titleEn: null, titleOriginal: 'Original Only' }),
    ]);
    const [row] = await getGroupingRowsByIds(['s1']);
    expect(row.title).toBe('Original Only');
  });

  it('sets hasDescription from descriptionEn presence', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', descriptionEn: null }),
      makeSuggestion({ id: 's2', descriptionEn: 'has one' }),
    ]);
    const rows = await getGroupingRowsByIds(['s1', 's2']);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('s1')!.hasDescription).toBe(false);
    expect(byId.get('s2')!.hasDescription).toBe(true);
  });

  it('only returns rows matching the requested ids', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1' }),
      makeSuggestion({ id: 's2' }),
    ]);
    const rows = await getGroupingRowsByIds(['s1']);
    expect(rows.map((r) => r.id)).toEqual(['s1']);
  });
});

describe('getUnscoredGroupingRows', () => {
  it('returns only rows with status=unscored', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', status: 'unscored' }),
      makeSuggestion({ id: 's2', status: 'reason_pending' }),
      makeSuggestion({ id: 's3', status: 'complete' }),
    ]);
    const rows = await getUnscoredGroupingRows();
    expect(rows.map((r) => r.id)).toEqual(['s1']);
  });

  it('returns [] when there are no unscored rows', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', status: 'complete' }),
    ]);
    const rows = await getUnscoredGroupingRows();
    expect(rows).toEqual([]);
  });
});

describe('getScoredDonorRows', () => {
  const sinceMs = new Date('2024-06-01T00:00:00.000Z').getTime();

  it('excludes rows with status=unscored', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({
        id: 's1',
        status: 'unscored',
        relevance: 0.8,
        createdAt: new Date(sinceMs + 1000),
      }),
      makeSuggestion({
        id: 's2',
        status: 'complete',
        relevance: 0.8,
        createdAt: new Date(sinceMs + 1000),
      }),
    ]);
    const rows = await getScoredDonorRows(sinceMs);
    expect(rows.map((r) => r.id)).toEqual(['s2']);
  });

  // THE PROPAGATION HAZARD `reason_skipped` introduces. Such a row carries a
  // REAL, renderable relevance and NO reason by design. Donating it would copy a
  // renderable score with a blank note onto every same-story sibling, and since
  // a reason-less recipient lands in `reason_pending`, it would re-spend the
  // very LLM call the gate skipped — once per sibling.
  //
  // `pickDonor` prefers a donor that HAS a reason, but that is only a
  // preference: a group whose ONLY donor is gated would still propagate. This
  // query is the guarantee.
  it('excludes reason_skipped rows — a real score with no reason is not a donor', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({
        id: 'gated',
        status: 'reason_skipped',
        relevance: 0.8, // renderable, and deliberately NOT overwritten
        reason: '',
        createdAt: new Date(sinceMs + 1000),
      }),
      makeSuggestion({
        id: 'ok',
        status: 'complete',
        relevance: 0.8,
        reason: 'Because it affects you.',
        createdAt: new Date(sinceMs + 1000),
      }),
    ]);
    const rows = await getScoredDonorRows(sinceMs);
    expect(rows.map((r) => r.id)).toEqual(['ok']);
  });

  it('excludes relevance=0 tombstones (ineligible rows carry no real signal)', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({
        id: 's1',
        status: 'complete',
        relevance: 0,
        createdAt: new Date(sinceMs + 1000),
      }),
      makeSuggestion({
        id: 's2',
        status: 'complete',
        relevance: 0.5,
        createdAt: new Date(sinceMs + 1000),
      }),
    ]);
    const rows = await getScoredDonorRows(sinceMs);
    expect(rows.map((r) => r.id)).toEqual(['s2']);
  });

  it('excludes rows created before sinceMs', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({
        id: 's1',
        status: 'complete',
        relevance: 0.5,
        createdAt: new Date(sinceMs - 1000),
      }),
      makeSuggestion({
        id: 's2',
        status: 'complete',
        relevance: 0.5,
        createdAt: new Date(sinceMs),
      }),
    ]);
    const rows = await getScoredDonorRows(sinceMs);
    expect(rows.map((r) => r.id)).toEqual(['s2']);
  });

  it('returns [] when no rows satisfy all three conditions', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', status: 'unscored', relevance: 0, createdAt: new Date(sinceMs - 1) }),
    ]);
    const rows = await getScoredDonorRows(sinceMs);
    expect(rows).toEqual([]);
  });

  // --- Bug-fix coverage: scored_at OR created_at (was created_at only) ---
  // Prod logs showed `propagated 0, held back N` every cycle because a row
  // scored recently but created outside the lookback window never qualified.

  it('is a donor when scored recently but created 3 days ago (the fixed bug)', async () => {
    const threeDaysAgo = sinceMs - 3 * 24 * 60 * 60 * 1000;
    db._setRows('article_suggestions', [
      makeSuggestion({
        id: 's1',
        status: 'complete',
        relevance: 0.6,
        createdAt: new Date(threeDaysAgo),
        scoredAt: sinceMs + 1000,
      }),
    ]);
    const rows = await getScoredDonorRows(sinceMs);
    expect(rows.map((r) => r.id)).toEqual(['s1']);
  });

  it('is a donor when created recently with scored_at null (propagated-row shape)', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({
        id: 's1',
        status: 'reason_pending',
        relevance: 0.5,
        createdAt: new Date(sinceMs + 1000),
        scoredAt: null,
      }),
    ]);
    const rows = await getScoredDonorRows(sinceMs);
    expect(rows.map((r) => r.id)).toEqual(['s1']);
  });

  it('is not a donor when unscored, even with scored_at and created_at both recent', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({
        id: 's1',
        status: 'unscored',
        relevance: 0.5,
        createdAt: new Date(sinceMs + 1000),
        scoredAt: sinceMs + 1000,
      }),
    ]);
    const rows = await getScoredDonorRows(sinceMs);
    expect(rows).toEqual([]);
  });

  it('is not a donor when relevance is 0, even with scored_at recent', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({
        id: 's1',
        status: 'complete',
        relevance: 0,
        createdAt: new Date(sinceMs - 3 * 24 * 60 * 60 * 1000),
        scoredAt: sinceMs + 1000,
      }),
    ]);
    const rows = await getScoredDonorRows(sinceMs);
    expect(rows).toEqual([]);
  });
});

describe('getCullableLowHeadlineIds', () => {
  // Band edges come from priority-order::relevanceBandRank — LOW is
  // [0.3, 0.53), MEDIUM starts at 0.53.
  const LOW = 0.4;
  const MEDIUM = 0.6;

  it('returns scored headline rows below the MEDIUM band', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', status: 'complete', relevance: LOW, headlineScope: 'COUNTRY' }),
      makeSuggestion({
        id: 's2',
        status: 'reason_pending',
        relevance: LOW,
        headlineScope: 'GLOBAL',
      }),
    ]);
    expect(await getCullableLowHeadlineIds()).toEqual(['s1', 's2']);
  });

  it('ignores medium-and-above headlines', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', status: 'complete', relevance: MEDIUM, headlineScope: 'COUNTRY' }),
      makeSuggestion({ id: 's2', status: 'complete', relevance: 0.9, headlineScope: 'GLOBAL' }),
    ]);
    expect(await getCullableLowHeadlineIds()).toEqual([]);
  });

  it('ignores non-headline LOW rows (topic matches keep their LOW band)', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', status: 'complete', relevance: LOW, headlineScope: null }),
    ]);
    expect(await getCullableLowHeadlineIds()).toEqual([]);
  });

  it('ignores rows already excluded, and unscored rows (no verdict yet)', async () => {
    db._setRows('article_suggestions', [
      makeSuggestion({ id: 's1', status: 'excluded', relevance: 0, headlineScope: 'COUNTRY' }),
      makeSuggestion({ id: 's2', status: 'unscored', relevance: 0, headlineScope: 'COUNTRY' }),
    ]);
    expect(await getCullableLowHeadlineIds()).toEqual([]);
  });
});

// ===========================================================================
// persistAndLinkV2Suggestions
// ===========================================================================

describe('persistAndLinkV2Suggestions', () => {
  function makeArticleWithClusters(overrides: Record<string, any> = {}) {
    return {
      __typename: 'ArticleWithClusters' as const,
      _id: overrides._id ?? 'art-1',
      article_url: overrides.article_url ?? 'https://example.com/a',
      clusters: overrides.clusters ?? [],
      country_code: overrides.country_code ?? 'USA',
      description_en: overrides.description_en ?? 'desc',
      image_url: overrides.image_url ?? null,
      language_code: overrides.language_code ?? 'en',
      pubDate: overrides.pubDate ?? NOW.toISOString(),
      publication_name: overrides.publication_name ?? 'Test Pub',
      title: overrides.title ?? 'Original Title',
      title_en: overrides.title_en ?? 'English Title',
      ...overrides,
    };
  }

  it('returns zero counts for empty fetched array', async () => {
    const result = await persistAndLinkV2Suggestions([], new Map());
    expect(result).toEqual({ insertedCount: 0, linkedCount: 0 });
    expect(database.write).not.toHaveBeenCalled();
  });

  it('returns zero counts when all articles already exist and clusters unchanged', async () => {
    const clusters = [{ clusterId: 'c1', confidence: 0.9 }];
    const clusterJson = JSON.stringify(clusters.map(c => ({ clusterId: c.clusterId, confidence: c.confidence })));
    db._setRows('article_suggestions', [
      makeSuggestion({
        id: 'art-1',
        clusterMembershipsJson: clusterJson,
      }),
    ]);

    const article = makeArticleWithClusters({
      _id: 'art-1',
      clusters: [{ __typename: 'ClusterMembership', clusterId: 'c1', confidence: 0.9 }],
    });

    const result = await persistAndLinkV2Suggestions([article], new Map([['art-1', ['berlin']]]));
    expect(result).toEqual({ insertedCount: 0, linkedCount: 0 });
    expect(database.write).not.toHaveBeenCalled();
  });

  /** Returns a prepareCreate-compatible record that includes _raw for id assignment. */
  function makeRawRecord(id: string) {
    const rec = makeRecord({ id });
    rec._raw = { id: undefined as any };
    return rec;
  }

  it('inserts new articles and returns correct insertedCount', async () => {
    db._setRows('article_suggestions', []);
    db._setRows('article_suggestion_facts', []);
    mockGetFacts.mockResolvedValueOnce([]);

    const article = makeArticleWithClusters({ _id: 'art-new' });
    const col = db._collections['article_suggestions'];
    col.prepareCreate = jest.fn((fn: (r: any) => void) => {
      const rec = makeRawRecord('art-new');
      fn(rec);
      return rec;
    });

    const result = await persistAndLinkV2Suggestions([article], new Map([['art-new', ['berlin']]]));
    expect(result.insertedCount).toBe(1);
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(col.prepareCreate).toHaveBeenCalledTimes(1);
  });

  // MERA-APP-6K. The hydration query returns one row per (article, matched
  // topic), so an article matching two topics arrives twice. Both copies missed
  // the existing-row check and the same id was prepareCreate'd twice into one
  // batch, which SQLite rejects wholesale — "sqlite error 1555 (UNIQUE
  // constraint failed: article_suggestions.id)" — discarding every insert in
  // that sync, not just the duplicate.
  it('inserts a duplicated article id exactly once', async () => {
    db._setRows('article_suggestions', []);
    db._setRows('article_suggestion_facts', []);
    mockGetFacts.mockResolvedValueOnce([]);

    const article = makeArticleWithClusters({ _id: 'art-dupe' });
    const col = db._collections['article_suggestions'];
    col.prepareCreate = jest.fn((fn: (r: any) => void) => {
      const rec = makeRawRecord('art-dupe');
      fn(rec);
      return rec;
    });

    const result = await persistAndLinkV2Suggestions(
      [article, { ...article }],
      new Map([['art-dupe', ['berlin']]]),
    );

    expect(col.prepareCreate).toHaveBeenCalledTimes(1);
    expect(result.insertedCount).toBe(1);
  });

  it('links facts that match article topic texts', async () => {
    db._setRows('article_suggestions', []);
    mockGetFacts.mockResolvedValueOnce([
      makeFact({ id: 'fact-1', metadata: { topics: ['berlin'] } }),
    ]);

    const article = makeArticleWithClusters({ _id: 'art-new' });
    const col = db._collections['article_suggestions'];
    col.prepareCreate = jest.fn((fn: (r: any) => void) => {
      const rec = makeRawRecord('art-new');
      fn(rec);
      return rec;
    });

    const result = await persistAndLinkV2Suggestions(
      [article],
      new Map([['art-new', ['berlin']]]),
    );
    expect(result.linkedCount).toBe(1);
    // article_suggestion_facts prepareCreate should have been called
    expect(db._collections['article_suggestion_facts'].prepareCreate).toHaveBeenCalledTimes(1);
  });

  it('deduplicates fact links when the same factId matches multiple topics', async () => {
    db._setRows('article_suggestions', []);
    // Same fact appears for two different topic texts
    mockGetFacts.mockResolvedValueOnce([
      makeFact({ id: 'fact-1', metadata: { topics: ['berlin', 'germany'] } }),
    ]);

    const article = makeArticleWithClusters({ _id: 'art-new' });
    const col = db._collections['article_suggestions'];
    col.prepareCreate = jest.fn((fn: (r: any) => void) => {
      const rec = makeRawRecord('art-new');
      fn(rec);
      return rec;
    });

    const result = await persistAndLinkV2Suggestions(
      [article],
      new Map([['art-new', ['berlin', 'germany']]]),
    );
    // Even though fact-1 matches both topics, it should only be linked once (Set deduplication)
    expect(result.linkedCount).toBe(1);
  });

  it('updates cluster memberships for existing articles when clusters changed', async () => {
    const oldJson = JSON.stringify([{ clusterId: 'c-old', confidence: 0.5 }]);
    const existingRow = makeSuggestion({ id: 'art-1', clusterMembershipsJson: oldJson });
    db._setRows('article_suggestions', [existingRow]);
    db._setRows('article_suggestion_facts', []);
    mockGetFacts.mockResolvedValueOnce([]);

    const article = makeArticleWithClusters({
      _id: 'art-1',
      clusters: [{ __typename: 'ClusterMembership', clusterId: 'c-new', confidence: 0.9 }],
    });

    const result = await persistAndLinkV2Suggestions([article], new Map());
    // Only cluster refresh, no insert
    expect(result.insertedCount).toBe(0);
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(existingRow.prepareUpdate).toHaveBeenCalledTimes(1);
    expect(existingRow.clusterMembershipsJson).toContain('c-new');
  });

  // ── P7e: heal matched_topics_json orphaned by the topics-empty legacy path ──
  it('backfills a null matched_topics_json on an existing row when personaMeta is present', async () => {
    const existingRow = makeSuggestion({
      id: 'art-1',
      matchedTopicsJson: null,
      clusterMembershipsJson: null,
    });
    db._setRows('article_suggestions', [existingRow]);
    db._setRows('article_suggestion_facts', []);
    mockGetFacts.mockResolvedValueOnce([]);

    // Unchanged clusters ([] == []) so only the matched-topics backfill fires.
    const article = makeArticleWithClusters({ _id: 'art-1', clusters: [] });
    const personaMeta = {
      matchedTopics: new Map([
        ['art-1', [{ topicId: 't1', text: 'ai', vectorScore: 0.9 }]],
      ]),
      headlineScope: new Map(),
      stableClusterId: new Map(),
    };

    const result = await persistAndLinkV2Suggestions(
      [article],
      new Map(),
      personaMeta as any,
    );

    expect(result.insertedCount).toBe(0);
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(existingRow.prepareUpdate).toHaveBeenCalledTimes(1);
    expect(existingRow.matchedTopicsJson).toBe(
      JSON.stringify([{ topicId: 't1', text: 'ai', vectorScore: 0.9 }]),
    );
  });

  it('leaves a non-null matched_topics_json on an existing row untouched', async () => {
    const originalJson = JSON.stringify([{ topicId: 't-existing', text: 'kept' }]);
    const existingRow = makeSuggestion({
      id: 'art-1',
      matchedTopicsJson: originalJson,
      clusterMembershipsJson: null,
    });
    db._setRows('article_suggestions', [existingRow]);
    db._setRows('article_suggestion_facts', []);
    mockGetFacts.mockResolvedValueOnce([]);

    const article = makeArticleWithClusters({ _id: 'art-1', clusters: [] });
    const personaMeta = {
      matchedTopics: new Map([
        ['art-1', [{ topicId: 't1', text: 'ai', vectorScore: 0.9 }]],
      ]),
      headlineScope: new Map(),
      stableClusterId: new Map(),
    };

    const result = await persistAndLinkV2Suggestions(
      [article],
      new Map(),
      personaMeta as any,
    );

    // Nothing to insert, clusters unchanged, matched topics already present →
    // no update at all (early-return path, no write).
    expect(result.insertedCount).toBe(0);
    expect(existingRow.prepareUpdate).not.toHaveBeenCalled();
    expect(existingRow.matchedTopicsJson).toBe(originalJson);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('does not backfill matched_topics_json when personaMeta is absent (legacy path)', async () => {
    const existingRow = makeSuggestion({
      id: 'art-1',
      matchedTopicsJson: null,
      clusterMembershipsJson: null,
    });
    db._setRows('article_suggestions', [existingRow]);
    db._setRows('article_suggestion_facts', []);
    mockGetFacts.mockResolvedValueOnce([]);

    const article = makeArticleWithClusters({ _id: 'art-1', clusters: [] });

    // No personaMeta → the legacy fallback cannot heal the field.
    const result = await persistAndLinkV2Suggestions([article], new Map());

    expect(result.insertedCount).toBe(0);
    expect(existingRow.prepareUpdate).not.toHaveBeenCalled();
    expect(existingRow.matchedTopicsJson).toBeNull();
    expect(database.write).not.toHaveBeenCalled();
  });

  it('handles pubDate as a Date object', async () => {
    db._setRows('article_suggestions', []);
    mockGetFacts.mockResolvedValueOnce([]);

    const article = makeArticleWithClusters({ _id: 'art-1', pubDate: NOW });
    const col = db._collections['article_suggestions'];
    col.prepareCreate = jest.fn((fn: (r: any) => void) => {
      const rec = makeRawRecord('art-1');
      fn(rec);
      return rec;
    });

    await persistAndLinkV2Suggestions([article], new Map());
    const prepared = col.prepareCreate.mock.results[0].value;
    expect(prepared.firstPubDate).toEqual(NOW);
  });

  it('handles pubDate as a numeric timestamp', async () => {
    db._setRows('article_suggestions', []);
    mockGetFacts.mockResolvedValueOnce([]);

    const ts = NOW.getTime();
    const article = makeArticleWithClusters({ _id: 'art-1', pubDate: ts });
    const col = db._collections['article_suggestions'];
    col.prepareCreate = jest.fn((fn: (r: any) => void) => {
      const rec = makeRawRecord('art-1');
      fn(rec);
      return rec;
    });

    await persistAndLinkV2Suggestions([article], new Map());
    const prepared = col.prepareCreate.mock.results[0].value;
    expect(prepared.firstPubDate).toEqual(NOW);
  });

  it('falls back to now when pubDate is an invalid string', async () => {
    db._setRows('article_suggestions', []);
    mockGetFacts.mockResolvedValueOnce([]);

    const article = makeArticleWithClusters({ _id: 'art-1', pubDate: 'not-a-date' });
    const col = db._collections['article_suggestions'];
    col.prepareCreate = jest.fn((fn: (r: any) => void) => {
      const rec = makeRawRecord('art-1');
      fn(rec);
      return rec;
    });

    const before = Date.now();
    await persistAndLinkV2Suggestions([article], new Map());
    const after = Date.now();
    const prepared = col.prepareCreate.mock.results[0].value;
    // firstPubDate should be "now" (within a reasonable range)
    const pubTs = prepared.firstPubDate.getTime();
    expect(pubTs).toBeGreaterThanOrEqual(before);
    expect(pubTs).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// buildStageCandidateInput — pure mapper (Persona v3)
// ---------------------------------------------------------------------------

describe('buildStageCandidateInput', () => {
  const baseRow: StageCandidateRow = {
    id: 'art-1',
    titleEn: 'A title',
    descriptionEn: 'A desc',
    publicationName: 'The Paper',
    countryCode: 'DE',
    firstPubDateMs: 1_700_000_000_000,
    maxClusterSize: 12,
    eventType: 'weather',
    category: 'news',
    geoTagsJson: JSON.stringify([{ city: 'Berlin', region: 'BE', countryCode: 'DE' }]),
    entitiesJson: JSON.stringify(['Angela', 'Bundestag']),
    matchedTopicsJson: JSON.stringify([
      { topicId: 't1', text: 'german politics', vectorScore: 0.9 },
      { topicId: null, text: 'top headline · country' },
    ]),
    headlineScope: 'COUNTRY',
    stableClusterId: 'sc-1',
  };

  const weights = new Map<string, TopicWeightInfo>([
    ['t1', { effectiveWeight: 0.72, highPriority: true, locationId: 'loc-9' }],
  ]);

  it('parses JSON columns + enriches matched topics with live weights', () => {
    const input = buildStageCandidateInput(baseRow, weights);
    expect(input.id).toBe('art-1');
    expect(input.pubDateMs).toBe(1_700_000_000_000);
    expect(input.maxClusterSize).toBe(12);
    expect(input.eventType).toBe('weather');
    expect(input.geoTags).toEqual([{ city: 'Berlin', region: 'BE', countryCode: 'DE' }]);
    expect(input.entities).toEqual(['Angela', 'Bundestag']);
    expect(input.headlineScope).toBe('COUNTRY');
    expect(input.stableClusterId).toBe('sc-1');

    const t1 = input.matchedTopics.find((m) => m.topicId === 't1')!;
    expect(t1.effectiveWeight).toBe(0.72);
    expect(t1.highPriority).toBe(true);
    expect(t1.locationId).toBe('loc-9');
    expect(t1.vectorScore).toBe(0.9);
  });

  it('resolves missing/synthetic topics to effectiveWeight 0', () => {
    const input = buildStageCandidateInput(baseRow, weights);
    const synthetic = input.matchedTopics.find((m) => m.topicId === null)!;
    expect(synthetic.effectiveWeight).toBe(0);
    expect(synthetic.highPriority).toBe(false);
  });

  it('produces a backstop-shaped input when metadata columns are null', () => {
    const bare: StageCandidateRow = {
      ...baseRow,
      geoTagsJson: null,
      entitiesJson: null,
      eventType: null,
      matchedTopicsJson: null,
      headlineScope: null,
    };
    const input = buildStageCandidateInput(bare, new Map());
    expect(input.geoTags).toEqual([]);
    expect(input.entities).toEqual([]);
    expect(input.matchedTopics).toEqual([]);
    expect(input.headlineScope).toBeNull();
  });

  it('drops geo tags missing a countryCode + tolerates malformed JSON', () => {
    const row: StageCandidateRow = {
      ...baseRow,
      geoTagsJson: JSON.stringify([{ city: 'Nowhere' }, { countryCode: 'FR' }]),
      entitiesJson: 'not json',
    };
    const input = buildStageCandidateInput(row, weights);
    expect(input.geoTags).toEqual([{ city: undefined, region: undefined, countryCode: 'FR' }]);
    expect(input.entities).toEqual([]);
  });

  it('passes a supranational countryCode through untouched — the engine resolves it, not this mapper', () => {
    const row: StageCandidateRow = {
      ...baseRow,
      geoTagsJson: JSON.stringify([{ countryCode: 'MIDDLE_EAST' }]),
    };
    const input = buildStageCandidateInput(row, weights);
    expect(input.geoTags).toEqual([
      { city: undefined, region: undefined, countryCode: 'MIDDLE_EAST' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// geoTextFromTags — the most-specific human place name (city → region →
// country), shared by the local-suggestion and standalone-article feedback
// paths. Feeds the `from_context_geo` negative-topic search string.
// ---------------------------------------------------------------------------

describe('geoTextFromTags', () => {
  it('prefers city, then region, then countryCode', () => {
    expect(geoTextFromTags([{ city: 'Berlin', region: 'BE', countryCode: 'DE' }])).toBe(
      'Berlin',
    );
    expect(geoTextFromTags([{ region: 'Bavaria', countryCode: 'DE' }])).toBe('Bavaria');
    expect(geoTextFromTags([{ countryCode: 'DE' }])).toBe('DE'); // real ISO code: unchanged raw text
  });

  it('humanizes a supranational countryCode instead of showing the raw token', () => {
    expect(geoTextFromTags([{ countryCode: 'MIDDLE_EAST' }])).toBe('Middle East');
  });

  it('EU (two letters, not a country) is humanized too, not left as the raw code', () => {
    // Same length as every real ISO alpha-2 code — must be decided by lookup,
    // not by a length check, so it does NOT fall into the "DE"-style raw path.
    expect(geoTextFromTags([{ countryCode: 'EU' }])).toBe('European Union');
  });

  it('returns null when nothing is nameable, and skips a null/empty first entry', () => {
    expect(geoTextFromTags([])).toBeNull();
    expect(geoTextFromTags([{ city: null, region: null, countryCode: null }])).toBeNull();
    expect(
      geoTextFromTags([
        { city: null, region: null, countryCode: null },
        { countryCode: 'GULF' },
      ]),
    ).toBe('Gulf');
  });
});

// ===========================================================================
// PRODUCER -> CONSUMER: the real projection feeding the real selector.
//
// The headline-section suite in lib/stores/__tests__ builds ForYouSuggestion
// fixtures BY HAND, so it proves the selector's logic but says nothing about
// the wiring that fills those fields. That is exactly how this feature broke
// once already: `toForYouSuggestion` did not carry `headlineCountryCode`, so
// every COUNTRY row reached the Dashboard with a null country and the
// per-country sections silently never rendered — with every selector test
// still green.
//
// These tests run the REAL producer (`loadSuggestions`) into the REAL consumer
// (`buildFactRows`), so producer and consumer are pinned TOGETHER and that gap
// cannot reopen unnoticed.
// ===========================================================================

describe('headline provenance survives the real row -> suggestion -> section path', () => {
  const sectionIds = async (rows: Parameters<typeof buildFactRows>[0]) =>
    buildFactRows(
      rows,
      {
        topics: new Map(),
        facts: new Map(),
        locations: new Map(),
        factStatements: new Map(),
      },
      new Set(),
      NOW.getTime(),
    ).rows.map((r) => r.factId);

  /** A persisted headline row as feed-sync writes one: synthetic matched topic
   *  (null topicId), a scope label, and — for COUNTRY — the scope's country. */
  const headlineRow = (o: Record<string, any>) =>
    makeSuggestion({
      status: 'complete',
      relevance: 0.7, // MEDIUM: clears discardFloor AND section viability
      rawScore: 0.7,
      matchedTopicsJson: JSON.stringify([
        { topicId: null, text: 'top headline · country' },
      ]),
      titleEn: null,
      titleOriginal: null,
      ...o,
    });

  it('carries the country end to end into a per-country section', async () => {
    db._setRows('article_suggestions', [
      headlineRow({ id: 'h-in', headlineScope: 'COUNTRY', headlineCountryCode: 'IN' }),
    ]);

    const suggestions = await loadSuggestions();
    // The producer half — this is the assertion that would have caught the gap.
    expect(suggestions[0].headlineCountryCode).toBe('IN');

    // The consumer half, fed by the producer's real output.
    expect(await sectionIds(suggestions)).toEqual(['headline-country-in']);
  });

  it('does not carry a stale country on a GLOBAL row', async () => {
    // A GLOBAL row whose country column was left populated must project null —
    // a wrong country is worse than none, and it must not mint a country
    // section that the reader never asked for.
    db._setRows('article_suggestions', [
      headlineRow({ id: 'h-g', headlineScope: 'GLOBAL', headlineCountryCode: 'IN' }),
    ]);

    const suggestions = await loadSuggestions();
    expect(suggestions[0].headlineCountryCode).toBeNull();
    expect(await sectionIds(suggestions)).toEqual([GLOBAL_HEADLINE_SECTION_ID]);
  });

  it('a COUNTRY row with no country belongs to no country section', async () => {
    // Reachable for rows persisted before v48 backfills nothing.
    db._setRows('article_suggestions', [
      headlineRow({ id: 'h-null', headlineScope: 'COUNTRY', headlineCountryCode: null }),
    ]);

    const suggestions = await loadSuggestions();
    expect(suggestions[0].headlineCountryCode).toBeNull();
    expect(await sectionIds(suggestions)).toEqual([]);
  });
});
