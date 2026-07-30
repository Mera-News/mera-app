// getReasonedSuggestionIdForArticle — the tap-time articleId → suggestion-id
// gate behind the Explore/drill-down "open the reason, not the bare article"
// routing. Covers the states where a suggestion row EXISTS but landing on
// suggestion-detail would show the reader nothing.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

jest.mock('../setting-service', () => ({
  getSetting: jest.fn(async () => null),
  setSetting: jest.fn(async () => {}),
  deleteSetting: jest.fn(async () => {}),
}));

jest.mock('../fact-service', () => ({
  getFacts: jest.fn(async () => []),
  getFactsForTopicTexts: jest.fn(async () => []),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { getReasonedSuggestionIdForArticle } from '../article-suggestion-service';

const db = database as any;

function row(overrides: Record<string, any> = {}) {
  return makeRecord({
    id: 'sugg-1',
    articleId: 'art-1',
    relevance: 0.8,
    reason: 'Matches your interest in EU energy policy.',
    status: ArticleSuggestionStatus.Complete,
    createdAt: new Date('2024-06-01T00:00:00.000Z'),
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('article_suggestions', []);
});

describe('getReasonedSuggestionIdForArticle', () => {
  // The test double IGNORES Q predicates, so every behavioural test below is
  // really exercising the JS mirror. Without this assertion a typo'd column
  // ('articleId' for 'article_id') or a dropped sortBy would keep the whole
  // suite green while throwing on device — where the caller's degrade-to-
  // article catch would swallow it and the feature would just never fire.
  it('issues an indexed, non-excluded, newest-first query', async () => {
    db._setRows('article_suggestions', [row()]);
    await getReasonedSuggestionIdForArticle('art-1');
    expect(db._collections.article_suggestions.query).toHaveBeenCalledWith(
      Q.where('article_id', 'art-1'),
      Q.where('status', Q.notEq(ArticleSuggestionStatus.Excluded)),
      Q.sortBy('created_at', Q.desc),
    );
  });

  it('returns the suggestion SERVER id (row.id), not the article id', async () => {
    db._setRows('article_suggestions', [row()]);
    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBe('sugg-1');
  });

  it('returns null when no row exists for the article', async () => {
    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBeNull();
  });

  it('returns null for a row belonging to a different article', async () => {
    db._setRows('article_suggestions', [row({ articleId: 'other' })]);
    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBeNull();
  });

  it('returns null for an empty articleId without touching the DB', async () => {
    db._setRows('article_suggestions', [row()]);
    await expect(getReasonedSuggestionIdForArticle('')).resolves.toBeNull();
    expect(db._collections.article_suggestions.query).not.toHaveBeenCalled();
  });

  // --- rows that exist but have nothing readable to show -------------------

  it('returns null for an EXCLUDED row (relevance 0, never scored)', async () => {
    db._setRows('article_suggestions', [
      row({ status: ArticleSuggestionStatus.Excluded, relevance: 0, reason: '' }),
    ]);
    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBeNull();
  });

  it('returns null for an excluded row even if it somehow carries reason text', async () => {
    db._setRows('article_suggestions', [
      row({ status: ArticleSuggestionStatus.Excluded, reason: 'stale reason' }),
    ]);
    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBeNull();
  });

  it('returns null for REASON_PENDING with an empty reason (would render a spinner)', async () => {
    db._setRows('article_suggestions', [
      row({ status: ArticleSuggestionStatus.ReasonPending, reason: '' }),
    ]);
    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBeNull();
  });

  it('returns null for COMPLETE with a blank reason (reason deliberately skipped)', async () => {
    db._setRows('article_suggestions', [row({ reason: '   ' })]);
    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBeNull();
  });

  it('returns null for UNSCORED', async () => {
    db._setRows('article_suggestions', [
      row({ status: ArticleSuggestionStatus.Unscored, reason: '' }),
    ]);
    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBeNull();
  });

  it('still routes a relevance-0 row that HAS reason text', async () => {
    db._setRows('article_suggestions', [row({ relevance: 0 })]);
    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBe('sugg-1');
  });

  it('skips a reason-less duplicate in favour of a reasoned sibling', async () => {
    // Query orders created_at DESC, so the newest (reason-less) row comes first.
    db._setRows('article_suggestions', [
      row({ id: 'sugg-new', reason: '', status: ArticleSuggestionStatus.ReasonPending }),
      row({ id: 'sugg-old' }),
    ]);
    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBe('sugg-old');
  });
});
