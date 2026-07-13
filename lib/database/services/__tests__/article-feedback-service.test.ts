// article-feedback-service unit tests — focuses on idempotency & hasLiked.
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
import { recordArticleFeedback, hasLiked } from '../article-feedback-service';

const db = database as any;

const NOW = 1700000000000;

function makeFeedbackRecord(overrides: Record<string, unknown> = {}) {
  return makeRecord({
    id: `feedback_${Math.random().toString(36).slice(2)}`,
    articleId: 'article-1',
    suggestionId: 'sugg-1',
    sentiment: 'like',
    title: 'Test Article',
    createdAt: new Date(NOW),
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('article_feedback', []);
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// recordArticleFeedback
// ---------------------------------------------------------------------------

describe('recordArticleFeedback', () => {
  it('does nothing when articleId is empty/whitespace', async () => {
    await recordArticleFeedback({
      articleId: '',
      sentiment: 'like',
      title: 'Title',
    });
    await recordArticleFeedback({
      articleId: '   ',
      sentiment: 'like',
      title: 'Title',
    });
    expect(database.write).not.toHaveBeenCalled();
  });

  it('creates a new row when no existing match for (articleId, sentiment)', async () => {
    db._setRows('article_feedback', []);
    await recordArticleFeedback({
      articleId: 'a1',
      suggestionId: 's1',
      sentiment: 'like',
      title: 'Test',
    });
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(db._collections['article_feedback'].create).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — skips creating a duplicate row for the same (articleId, sentiment)', async () => {
    const existing = makeFeedbackRecord({ articleId: 'a1', sentiment: 'like' });
    db._setRows('article_feedback', [existing]);

    await recordArticleFeedback({
      articleId: 'a1',
      sentiment: 'like',
      title: 'Test',
    });

    expect(database.write).not.toHaveBeenCalled();
    expect(db._collections['article_feedback'].create).not.toHaveBeenCalled();
  });

  it('allows recording different sentiments for the same article', async () => {
    // The fake query() ignores Q.where predicates and returns whatever rows
    // are configured, so simulate a filtered lookup (no 'dislike' rows yet)
    // via a one-off mock return, matching the publication-visit-service
    // test pattern for predicate-sensitive assertions.
    const col = db._collections['article_feedback'];
    col.query.mockReturnValueOnce({
      fetch: jest.fn(async () => []),
      fetchCount: jest.fn(async () => 0),
    });

    await recordArticleFeedback({
      articleId: 'a1',
      sentiment: 'dislike',
      title: 'Test',
    });

    expect(database.write).toHaveBeenCalledTimes(1);
    expect(col.create).toHaveBeenCalledTimes(1);
  });

  it('stores the suggestionId, title, and sentiment on the created row', async () => {
    db._setRows('article_feedback', []);
    const capturedRecord: Record<string, unknown> = {};
    db._collections['article_feedback'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        const rec = makeRecord();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    await recordArticleFeedback({
      articleId: 'a1',
      suggestionId: 'sugg-42',
      sentiment: 'improve',
      title: 'Great Article',
    });

    expect(capturedRecord.articleId).toBe('a1');
    expect(capturedRecord.suggestionId).toBe('sugg-42');
    expect(capturedRecord.sentiment).toBe('improve');
    expect(capturedRecord.title).toBe('Great Article');
    expect(capturedRecord.createdAt).toBeInstanceOf(Date);
  });

  it('defaults suggestionId to null when not provided', async () => {
    db._setRows('article_feedback', []);
    const capturedRecord: Record<string, unknown> = {};
    db._collections['article_feedback'].create.mockImplementationOnce(
      async (fn: (r: any) => void) => {
        const rec = makeRecord();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    await recordArticleFeedback({
      articleId: 'a1',
      sentiment: 'like',
      title: 'Test',
    });

    expect(capturedRecord.suggestionId).toBeNull();
  });

  it('captures and swallows exceptions', async () => {
    db._collections['article_feedback'].query.mockImplementationOnce(() => {
      throw new Error('DB exploded');
    });
    await expect(
      recordArticleFeedback({ articleId: 'a1', sentiment: 'like', title: 'Test' }),
    ).resolves.toBeUndefined();
    expect(logger.captureException).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// hasLiked
// ---------------------------------------------------------------------------

describe('hasLiked', () => {
  it('returns false for empty/whitespace articleId', async () => {
    expect(await hasLiked('')).toBe(false);
    expect(await hasLiked('   ')).toBe(false);
  });

  it('returns false when no like row exists for the article', async () => {
    db._setRows('article_feedback', []);
    expect(await hasLiked('a1')).toBe(false);
  });

  it('returns true when a like row exists for the article', async () => {
    const existing = makeFeedbackRecord({ articleId: 'a1', sentiment: 'like' });
    db._setRows('article_feedback', [existing]);
    expect(await hasLiked('a1')).toBe(true);
  });

  it('returns false when only non-like sentiments exist for the article', async () => {
    // The fake query() ignores Q.where predicates, so simulate the filtered
    // 'like' lookup finding nothing via a one-off mock return (matching the
    // publication-visit-service test pattern for predicate-sensitive checks).
    const col = db._collections['article_feedback'];
    col.query.mockReturnValueOnce({
      fetch: jest.fn(async () => []),
      fetchCount: jest.fn(async () => 0),
    });
    expect(await hasLiked('a1')).toBe(false);
  });

  it('returns false and captures exception on error', async () => {
    db._collections['article_feedback'].query.mockImplementationOnce(() => {
      throw new Error('query error');
    });
    const result = await hasLiked('a1');
    expect(result).toBe(false);
    expect(logger.captureException).toHaveBeenCalledTimes(1);
  });
});
